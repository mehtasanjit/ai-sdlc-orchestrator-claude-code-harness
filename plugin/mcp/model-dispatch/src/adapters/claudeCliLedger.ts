/**
 * The token ledger of one `claude -p` worker call, priced from the dated list.
 *
 * Why: ClaudeCliAdapter used to copy the result's `total_cost_usd` into the
 * cost verbatim. That number is Claude Code's own multiplication with its own
 * price table, which has been stale (2026-08-24: Opus billed at exactly 0.6x
 * the list for hundreds of runs). The worker's cost is now its tokens times
 * the same list every other dispatch uses, and the CLI figure is only a check.
 *
 * Where each input comes from:
 * - Tokens per model: the result's `modelUsage`, which covers every model the
 *   CLI billed, including helper sessions and side calls that are never
 *   written to a transcript (a Haiku call, for instance). The top-level
 *   `usage` holds the session model only, so it is used only when an older
 *   CLI prints no `modelUsage`, and then as the requested model.
 * - Web searches: `modelUsage[*].webSearchRequests`, billed at the list's
 *   per-search price ($10 per 1,000 for Claude) on top of that model's
 *   tokens; a model with no per-search price lists them unpriced.
 * - Model identity: resolveModel, so `claude-opus-5[1m]` is Opus 5 and
 *   `claude-haiku-4-5-20251001` is Haiku 4.5. An unresolvable name is
 *   unpriced, never matched to a similar model.
 * - 5-minute vs 1-hour cache writes: the worker session's own transcript
 *   (`<projects>/<project>/<session_id>.jsonl` plus its `subagents/`), when it
 *   explains every token the result says that model wrote. Otherwise
 *   `approximate`: the result's top-level `usage.cache_creation` split goes to
 *   the ONE model whose four counts equal that `usage` (Claude Code writes the
 *   session model's main loop there), and any other model takes the 1-hour
 *   writes its own transcript lines record and prices the rest at the
 *   5-minute rate, written into that entry's `assumed`. The usage's 1-hour
 *   count is given out once in total. (Every model used to take min(its
 *   writes, that 1-hour count), which counted the session's 1-hour writes
 *   once per model: review finding M2.)
 * - speed / service_tier / inference_geo: the model's transcript messages,
 *   each message's value merged from ALL of its lines (Claude Code writes
 *   `speed` only on a later streamed or terminal line), when every message
 *   prices the same and no message's lines disagree; the top-level `usage`
 *   for the requested model; the API defaults for a receipt-only side call.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { computeCostUsd, estimateTokens, round6 } from "../pricing.js";
import { resolveModel, type PriceModifiers } from "../prices.js";
import { effectivePrice, sameModel } from "../effectivePrice.js";
import type { ModelConfig, ModelPricing, PriceBasis, TtlSplit, UnpricedModel, WorkerModelCost } from "../types.js";

/** The CLI figure differs from the ledger when it is further than this fraction away (and more than $0.000001). */
export const CLI_COST_TOLERANCE = 0.005;

/** Claude Code's transcript root: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

/** The directory name Claude Code uses for a working directory: every non-alphanumeric character becomes `-`. */
export function projectDirName(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

// A session id is joined into a path, so only a plain token is accepted.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The worker session's transcript files: its `<session_id>.jsonl` plus every
 * `.jsonl` under `<session_id>/subagents/`. Looked for first under the
 * directory for `cwd` (the spawned `claude` inherits this process's working
 * directory), then under every project directory, because the session id is
 * unique and the directory-naming rule is Claude Code's, not ours. Null when
 * the session id is not a plain id or no transcript exists.
 */
export function findWorkerTranscripts(projectsDir: string, sessionId: unknown, cwd: string = process.cwd()): string[] | null {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (!existsSync(projectsDir)) return null;
  const candidates = [join(projectsDir, projectDirName(cwd))];
  try {
    for (const e of readdirSync(projectsDir, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(join(projectsDir, e.name));
    }
  } catch {
    // Unreadable root: the cwd-derived directory alone.
  }
  for (const dir of candidates) {
    const main = join(dir, `${sessionId}.jsonl`);
    if (!existsSync(main)) continue;
    const helpers: string[] = [];
    walkJsonl(join(dir, sessionId, "subagents"), helpers, 1);
    return [main, ...helpers.sort()];
  }
  return null;
}

function walkJsonl(dir: string, out: string[], depth: number): void {
  if (depth > 8 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    else if (e.isDirectory()) walkJsonl(p, out, depth + 1);
  }
}

/** One model's cache writes and request modifiers, as the worker's transcript recorded them. */
export interface TranscriptModelWrites {
  write_5m: number;
  write_1h: number;
  /** False when some line wrote cache without a `cache_creation` TTL split. */
  split_known: boolean;
  /** Distinct `[speed, service_tier, inference_geo]` triples, one per message, JSON-encoded. */
  modifiers: Set<string>;
  /**
   * Modifier names (`speed`, `service_tier`, `inference_geo`) that two lines of
   * one message of this model record with different values. Non-empty means
   * no single price is provable for that message, so the model is unpriced.
   */
  modifier_conflicts: string[];
  /**
   * The model's other logged tokens, by the collector's rules: input and cache
   * reads from each message's first line, output from its terminal
   * (stop_reason) line, else the largest value any line recorded. With the
   * writes above, this is what a collector scan of this transcript counts.
   */
  logged: { input: number; input_cached: number; output: number; web_search_requests: number };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const modelKey = (name: string): string => resolveModel(name)?.id ?? name;

const MODIFIER_KEYS = ["speed", "service_tier", "inference_geo"] as const;
type ModifierKey = (typeof MODIFIER_KEYS)[number];

/** One transcript message: its model, the request modifiers merged from all of its lines, and its logged tokens. */
interface MessageRecord {
  key: string;
  values: Record<ModifierKey, unknown>;
  conflicts: Set<ModifierKey>;
  input: number;
  input_cached: number;
  output: number;
  /** Whether `output` came from the terminal (stop_reason) line. */
  terminal: boolean;
  /** `usage.server_tool_use.web_search_requests`: the largest any line records, once per message (a count never falls). */
  searches: number;
}

/**
 * Merges one line's modifiers into its message, by the same rule as the
 * collector's noteModifiers (collect-orchestrator-usage.mjs): an absent value
 * leaves the message's value alone, a value fills an empty slot, and a
 * different value is a conflict.
 */
function noteModifiers(rec: MessageRecord, usage: Record<string, unknown>): void {
  for (const k of MODIFIER_KEYS) {
    const v = usage[k];
    if (v == null) continue;
    if (rec.values[k] == null) rec.values[k] = v;
    else if (rec.values[k] !== v) rec.conflicts.add(k);
  }
}

/**
 * Per model (list id, or the raw name when unlisted): cache writes by TTL and
 * the modifiers used. Assistant lines only, `<synthetic>` skipped, lines of
 * another session skipped. Cache writes are counted once per message id (its
 * first line carries the complete cache fields); request modifiers are read
 * from EVERY line of the message and merged (noteModifiers), and each message
 * adds its merged triple once all files are read. Null when no file could be read.
 *
 * Why every line (review findings M1 / R1): Claude Code writes `speed` only on
 * a later streamed or terminal line of most messages. Reading the first line
 * alone priced a fast-mode worker at standard rates, half the fast price, while
 * the collector, which merges every line, priced the same tokens at fast rates,
 * so the in-session subtraction removed a different figure from the one its
 * scan added.
 */
export function readWorkerTranscript(files: string[], sessionId: string): Map<string, TranscriptModelWrites> | null {
  const byModel = new Map<string, TranscriptModelWrites>();
  const byId = new Map<string, MessageRecord>();
  const messages: MessageRecord[] = [];
  let readAny = false;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
      readAny = true;
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== "assistant") continue;
      const msg = obj.message;
      const usage = msg?.usage;
      if (!usage || msg.model === "<synthetic>") continue;
      if (typeof obj.sessionId === "string" && obj.sessionId !== sessionId) continue;
      const id = typeof msg.id === "string" ? msg.id : null;
      const counted = id !== null ? byId.get(id) : undefined;
      if (counted) {
        // A repeat line of a message already counted: its cache fields repeat
        // the first line's, but it may be the only line that records `speed`.
        noteModifiers(counted, usage);
        // Output is a streaming snapshot: the terminal line's value wins, else
        // the largest seen, exactly as the collector books it.
        const out = num(usage.output_tokens);
        const terminal = msg.stop_reason != null;
        if (!counted.terminal && (terminal || out > counted.output)) {
          counted.output = out;
          counted.terminal = terminal;
        }
        counted.searches = Math.max(counted.searches, num(usage.server_tool_use?.web_search_requests));
        continue;
      }
      const key = modelKey(String(msg.model ?? "(unlabeled)"));
      const entry = byModel.get(key) ?? {
        write_5m: 0,
        write_1h: 0,
        split_known: true,
        modifiers: new Set<string>(),
        modifier_conflicts: [],
        logged: { input: 0, input_cached: 0, output: 0, web_search_requests: 0 },
      };
      const written = num(usage.cache_creation_input_tokens);
      const split = usage.cache_creation;
      if (written > 0 && (!split || typeof split !== "object")) entry.split_known = false;
      const oneHour = Math.min(written, num(split?.ephemeral_1h_input_tokens));
      entry.write_1h += oneHour;
      entry.write_5m += written - oneHour;
      byModel.set(key, entry);
      // A line with no string id is a message of its own.
      const rec: MessageRecord = {
        key,
        values: { speed: null, service_tier: null, inference_geo: null },
        conflicts: new Set(),
        input: num(usage.input_tokens),
        input_cached: num(usage.cache_read_input_tokens),
        output: num(usage.output_tokens),
        terminal: msg.stop_reason != null,
        searches: num(usage.server_tool_use?.web_search_requests),
      };
      noteModifiers(rec, usage);
      messages.push(rec);
      if (id !== null) byId.set(id, rec);
    }
  }
  // Every line has been read, so each message's modifiers are final.
  for (const rec of messages) {
    const entry = byModel.get(rec.key) as TranscriptModelWrites;
    entry.modifiers.add(JSON.stringify([rec.values.speed ?? null, rec.values.service_tier ?? null, rec.values.inference_geo ?? null]));
    for (const k of rec.conflicts) if (!entry.modifier_conflicts.includes(k)) entry.modifier_conflicts.push(k);
    entry.logged.input += rec.input;
    entry.logged.input_cached += rec.input_cached;
    entry.logged.output += rec.output;
    entry.logged.web_search_requests += rec.searches;
  }
  return readAny ? byModel : null;
}

/** The fields of a `claude -p --output-format json` result this ledger reads. */
export interface ClaudeCliResultLike {
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
    service_tier?: string;
    speed?: string;
    inference_geo?: string;
    server_tool_use?: { web_search_requests?: number };
  };
  modelUsage?: Record<string, any>;
}

export interface CliCostMismatch {
  cli_usd: number;
  list_usd: number;
  /**
   * (cli - list) / list, as a percentage with two decimals. One decimal
   * printed the real 2026-09-10 difference of -0.534% as "-0.5", which reads
   * as inside the 0.5% tolerance the warning exists to flag.
   */
  delta_pct: string;
  /** Models whose own CLI figure differs; empty when only the total was compared. */
  models: string[];
}

export interface WorkerLedger {
  /** Every billed model's tokens, priced or not. `input_cache_write` is the 5-minute share, disjoint from `input_cache_write_1h`. */
  tokens: { input: number; input_cached: number; input_cache_write: number; input_cache_write_1h: number; output: number };
  /** The priced models' cost. */
  cost_usd: number;
  per_model: WorkerModelCost[];
  unpriced_models: UnpricedModel[];
  ttl_split: TtlSplit;
  /** `custom` when any model was custom-priced; absent when nothing was priced. */
  price_basis?: PriceBasis;
  cli_reported_cost_usd?: number;
  /**
   * Present when a worker transcript was read: the dollars of `cost_usd` for
   * the tokens that transcript explains (each priced model's logged tokens,
   * writes at their recorded TTL, at that model's price; never more than the
   * model's billed tokens, never more than cost_usd). The rest of cost_usd is
   * what the result billed that no transcript line logged: receipt-only side
   * calls and unlogged tokens. A collector scan of the worker's transcript
   * counts exactly this share, so it is the share the collector subtracts
   * (review finding M4).
   */
  transcript_logged_cost_usd?: number;
  cli_mismatch: CliCostMismatch | null;
  /** Policy-block warnings from effectivePrice, for the caller to log. */
  warnings: string[];
}

interface Row {
  key: string;
  names: string[];
  input: number;
  input_cached: number;
  writes: number;
  output: number;
  /** Web search requests billed per search on top of tokens (review finding M3). */
  searches: number;
  cli: number;
  cliKnown: boolean;
}

const RATE_KEYS = ["input", "input_cached", "output", "input_cache_write", "input_cache_write_1h"] as const;

/** Two rate cards are the same price when every rate is identical. */
function samePricing(a: ModelPricing, b: ModelPricing): boolean {
  return RATE_KEYS.every((k) => a[k] === b[k]);
}

function cliDiffers(cli: number, ledger: number): boolean {
  return Math.abs(cli - ledger) > Math.max(CLI_COST_TOLERANCE * ledger, 0.000001);
}

export function priceClaudeCliResult(
  response: ClaudeCliResultLike,
  opts: { config: ModelConfig; date: Date; transcript: Map<string, TranscriptModelWrites> | null },
): WorkerLedger {
  const usage = response.usage ?? {};
  const rows = new Map<string, Row>();
  const reported = response.modelUsage && typeof response.modelUsage === "object" ? Object.entries(response.modelUsage) : [];

  if (reported.length > 0) {
    // Names that resolve to one list id are one model (e.g. `claude-opus-5`
    // and `claude-opus-5[1m]`): their tokens and CLI dollars add up.
    for (const [name, v] of reported) {
      const key = modelKey(name);
      const row = rows.get(key) ?? { key, names: [], input: 0, input_cached: 0, writes: 0, output: 0, searches: 0, cli: 0, cliKnown: true };
      row.names.push(name);
      row.input += num(v?.inputTokens ?? v?.input_tokens);
      row.input_cached += num(v?.cacheReadInputTokens ?? v?.cache_read_input_tokens);
      row.writes += num(v?.cacheCreationInputTokens ?? v?.cache_creation_input_tokens);
      row.output += num(v?.outputTokens ?? v?.output_tokens);
      row.searches += num(v?.webSearchRequests ?? v?.web_search_requests);
      const c = v?.costUSD ?? v?.cost_usd;
      if (typeof c === "number" && Number.isFinite(c)) row.cli += c;
      else row.cliKnown = false;
      rows.set(key, row);
    }
  } else {
    // An older CLI with no modelUsage: the top-level usage, as the model the
    // adapter asked for with --model. Helper tokens are then invisible, which
    // the CLI-total check below surfaces as a mismatch.
    const name = opts.config.model_name;
    rows.set(modelKey(name), {
      key: modelKey(name),
      names: [name],
      input: num(usage.input_tokens),
      input_cached: num(usage.cache_read_input_tokens),
      writes: num(usage.cache_creation_input_tokens),
      output: typeof usage.output_tokens === "number" ? usage.output_tokens : estimateTokens(response.result ?? ""),
      searches: num(usage.server_tool_use?.web_search_requests),
      cli: 0,
      cliKnown: false,
    });
  }

  // The result's top-level `usage` is ONE model's usage: Claude Code writes the
  // session model's main loop there (both real results kept, CLI 2.1.245 and
  // 2.1.270, show it), so its cache_creation split belongs to that model only.
  // It goes to the one row whose four counts equal the usage's, and only when
  // the split adds up to the usage's writes: the collector's bookReceiptTokens
  // rule. Review finding M2: every row used to take min(its writes, the usage's
  // 1-hour count), which counted the session's 1-hour writes once per model (on
  // the real 2026-09-10 result, 40,658 1-hour writes against the 20,329 billed).
  const u5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const u1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const usageOwner = (() => {
    const counts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.output_tokens];
    if (!counts.every((n) => typeof n === "number") || typeof u5m !== "number" || typeof u1h !== "number") return null;
    if (u5m + u1h !== usage.cache_creation_input_tokens) return null;
    const owners = [...rows.values()].filter(
      (r) =>
        r.input === usage.input_tokens &&
        r.input_cached === usage.cache_read_input_tokens &&
        r.writes === usage.cache_creation_input_tokens &&
        r.output === usage.output_tokens,
    );
    return owners.length === 1 ? owners[0].key : null;
  })();
  // The usage's 1-hour writes are given out once in total, whatever the rows.
  let usageOneHourLeft = typeof u1h === "number" && u1h > 0 ? u1h : 0;
  const perModel: WorkerModelCost[] = [];
  const unpriced: UnpricedModel[] = [];
  const warnings: string[] = [];
  const tokens = { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 0 };
  let cost = 0;
  let loggedCost = 0;

  for (const row of rows.values()) {
    const fromTranscript = opts.transcript?.get(row.key);
    let write5m = 0;
    let write1h = 0;
    let split: TtlSplit;
    const assumed: string[] = [];
    if (row.writes === 0) {
      split = "no_cache_writes";
    } else if (fromTranscript && fromTranscript.split_known && fromTranscript.write_5m + fromTranscript.write_1h === row.writes) {
      write5m = fromTranscript.write_5m;
      write1h = fromTranscript.write_1h;
      split = "transcript";
    } else if (row.key === usageOwner) {
      // The usage's four counts are this model's, so its split is too.
      write1h = Math.min(row.writes, usageOneHourLeft);
      usageOneHourLeft -= write1h;
      write5m = row.writes - write1h;
      split = "approximate";
    } else {
      // Any other model: the 1-hour writes its own transcript lines record
      // (never more than the result says it wrote), and every other write at
      // the 5-minute rate, with the assumption written down.
      write1h = Math.min(row.writes, fromTranscript?.write_1h ?? 0);
      write5m = row.writes - write1h;
      split = "approximate";
      const explained = fromTranscript ? Math.min(row.writes, fromTranscript.write_5m + fromTranscript.write_1h) : 0;
      if (row.writes > explained) {
        assumed.push(`${row.writes - explained} cache-write token(s) no worker transcript line explains: the 5-minute rate`);
      }
      if (fromTranscript && !fromTranscript.split_known) {
        assumed.push("a worker transcript line wrote cache without a TTL split: its writes at the 5-minute rate");
      }
    }
    const rowTokens = { input: row.input, input_cached: row.input_cached, input_cache_write: write5m, input_cache_write_1h: write1h, output: row.output };
    tokens.input += rowTokens.input;
    tokens.input_cached += rowTokens.input_cached;
    tokens.input_cache_write += write5m;
    tokens.input_cache_write_1h += write1h;
    tokens.output += rowTokens.output;

    const ownModel = row.names.some((n) => sameModel(n, opts.config.model_name));
    const custom = ownModel && opts.config.pricing_override === true && !!opts.config.pricing;
    let modifiers: PriceModifiers = {};
    let problem: string | null = null;
    if (custom) {
      // A custom price is one flat card: request modifiers do not apply.
    } else if (fromTranscript && fromTranscript.modifier_conflicts.length > 0) {
      // Two lines of one message record different values (fast on one, standard
      // on another): no single price is provable for it, and the result's
      // per-model totals cannot be split, so the model is unpriced. The collector
      // leaves the same message unpriced by the same rule.
      problem =
        `the lines of one ${row.key} message in the worker transcript disagree on ` +
        `${fromTranscript.modifier_conflicts.join(", ")}, so no single price applies`;
    } else if (fromTranscript && fromTranscript.modifiers.size > 0) {
      // Every distinct [speed, service_tier, inference_geo] the transcript saw
      // for this model, compared by the PRICE each one looks up to, not by
      // spelling. An absent `speed` on some lines and "standard" on others is
      // one price (the absent value is the API default), and so are "global"
      // and "not_available". Found on the real 2026-09-10 headless run, where
      // comparing spellings marked $13.70 of Opus 4.8 unpriced. Only
      // combinations that price differently (fast beside standard) or not at
      // all leave the model unpriced, because the result's per-model totals
      // cannot be split between them.
      const combos = [...fromTranscript.modifiers].map((c) => {
        const [speed, service_tier, inference_geo] = JSON.parse(c);
        return { speed, service_tier, inference_geo } as PriceModifiers;
      });
      const prices = combos.map((m) => effectivePrice(opts.config, opts.date, m, row.names[0]));
      const failed = prices.find((p) => p.unpriced);
      if (failed && failed.unpriced) {
        problem = `the worker transcript records a ${row.key} request the list cannot price: ${failed.reason}`;
      } else if (prices.some((p) => !p.unpriced && !prices[0].unpriced && !samePricing(p.pricing, prices[0].pricing))) {
        problem =
          `the worker transcript records ${row.key} requests at more than one price ` +
          `(speed/service_tier/inference_geo ${[...fromTranscript.modifiers].join(" ")}), and the result's ` +
          `per-model totals cannot be split between them`;
      } else {
        modifiers = combos[0];
      }
    } else if (ownModel) {
      modifiers = { speed: usage.speed, service_tier: usage.service_tier, inference_geo: usage.inference_geo };
    }
    // Otherwise a receipt-only side call: the API defaults, listed by the
    // lookup as defaulted rather than hidden.

    const price = problem ? null : effectivePrice(opts.config, opts.date, modifiers, row.names[0]);
    if (price) warnings.push(...price.warnings);
    const cliCost = row.cliKnown ? row.cli : null;
    if (!price || price.unpriced) {
      const reason = problem ?? (price as { reason: string }).reason;
      unpriced.push({ model: row.names.join(", "), reason });
      perModel.push({
        model: row.key,
        reported_as: row.names,
        tokens: rowTokens,
        price_basis: null,
        cost_usd: null,
        cli_cost_usd: cliCost,
        ttl_split: split,
        unpriced_reason: reason,
        ...(assumed.length > 0 ? { assumed } : {}),
        ...(row.searches > 0 ? { web_search_requests: row.searches, web_search_cost_usd: null } : {}),
      });
      continue;
    }
    // Review finding M3: web searches bill per request on top of tokens, at the
    // list's per-search price for the model's day. Only token counts were read,
    // so a worker that searched booked less than it cost. With no per-search
    // price the searches are listed unpriced and the tokens stay priced.
    const fee = price.web_search_per_request;
    const searchCost = row.searches > 0 && fee !== null ? round6(row.searches * fee) : 0;
    if (row.searches > 0 && fee === null) {
      unpriced.push({
        model: row.names.join(", "),
        reason: `${row.searches} web search request(s) have no per-search price for ${row.key} on the price list, so their fee is not in cost_usd`,
      });
    }
    const rowCost = round6(computeCostUsd(rowTokens, price.pricing) + searchCost);
    cost += rowCost;
    if (fromTranscript) {
      // The tokens this model's transcript explains, priced at the same card,
      // with writes at the TTL each line recorded (as the collector prices
      // them), each bucket capped at what the result billed.
      const logged1h = Math.min(row.writes, fromTranscript.write_1h);
      loggedCost += computeCostUsd(
        {
          input: Math.min(row.input, fromTranscript.logged.input),
          input_cached: Math.min(row.input_cached, fromTranscript.logged.input_cached),
          input_cache_write: Math.min(row.writes - logged1h, fromTranscript.write_5m),
          input_cache_write_1h: logged1h,
          output: Math.min(row.output, fromTranscript.logged.output),
        },
        price.pricing,
      );
      if (fee !== null) loggedCost += Math.min(row.searches, fromTranscript.logged.web_search_requests) * fee;
    }
    perModel.push({
      model: row.key,
      reported_as: row.names,
      tokens: rowTokens,
      price_basis: price.basis,
      cost_usd: rowCost,
      cli_cost_usd: cliCost,
      ttl_split: split,
      ...(assumed.length > 0 ? { assumed } : {}),
      ...(row.searches > 0 ? { web_search_requests: row.searches, web_search_cost_usd: fee === null ? null : searchCost } : {}),
    });
  }

  const splits = perModel.map((m) => m.ttl_split);
  const ttl_split: TtlSplit = splits.every((s) => s === "no_cache_writes")
    ? "no_cache_writes"
    : splits.includes("approximate")
      ? "approximate"
      : "transcript";
  const price_basis: PriceBasis | undefined = perModel.some((m) => m.price_basis === "custom")
    ? "custom"
    : perModel.some((m) => m.price_basis === "list")
      ? "list"
      : undefined;

  // The CLI check. Only list-priced models are compared (a custom price is
  // deliberate, an unpriced one has nothing to compare), model by model where
  // the CLI reported per-model dollars; the total only when every model was
  // list-priced, so an unknown model's dollars cannot fake a mismatch.
  const ledger = round6(cost);
  const cliTotal = typeof response.total_cost_usd === "number" && Number.isFinite(response.total_cost_usd) ? response.total_cost_usd : undefined;
  const differing = perModel.filter((m) => m.price_basis === "list" && m.cli_cost_usd !== null && m.cost_usd !== null && cliDiffers(m.cli_cost_usd, m.cost_usd));
  const allList = perModel.length > 0 && perModel.every((m) => m.price_basis === "list");
  const totalDiffers = allList && cliTotal !== undefined && cliDiffers(cliTotal, ledger);
  let cli_mismatch: CliCostMismatch | null = null;
  if (totalDiffers || differing.length > 0) {
    const cliUsd = totalDiffers ? (cliTotal as number) : differing.reduce((s, m) => s + (m.cli_cost_usd as number), 0);
    const listUsd = totalDiffers ? ledger : differing.reduce((s, m) => s + (m.cost_usd as number), 0);
    cli_mismatch = {
      cli_usd: round6(cliUsd),
      list_usd: round6(listUsd),
      delta_pct: listUsd === 0 ? "inf" : (((cliUsd - listUsd) / listUsd) * 100).toFixed(2),
      models: differing.map((m) => m.model),
    };
  }

  return {
    tokens,
    cost_usd: ledger,
    per_model: perModel,
    unpriced_models: unpriced,
    ttl_split,
    ...(price_basis ? { price_basis } : {}),
    ...(cliTotal !== undefined ? { cli_reported_cost_usd: cliTotal } : {}),
    ...(opts.transcript ? { transcript_logged_cost_usd: round6(Math.min(loggedCost, cost)) } : {}),
    cli_mismatch,
    warnings,
  };
}
