/**
 * Telemetry — append-only JSONL writer + rollup builder for manifest.json.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelPricing, PriceBasis, TelemetryEvent } from "./types.js";
import type { AppliedModifiers, PeriodRef } from "./prices.js";

export function appendEvent(jsonlPath: string, ev: TelemetryEvent): void {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, JSON.stringify(ev) + "\n", "utf-8");
}

/**
 * Normalize an event handed to us by a model rather than measured by this
 * server (the direct tier — orchestrator phases that never pass through
 * `execute_with_model`). A model has no clock, so its `ts` and `latency_ms`
 * are invented. Stamp arrival time server-side and record latency as null
 * (the honest value — this server never saw the call). `buildManifest` sorts
 * by `ts` to derive run duration, so placeholder timestamps would corrupt it.
 */
export function normalizeDirectTierEvent(
  ev: TelemetryEvent,
  now: Date = new Date(),
): TelemetryEvent {
  return {
    ...ev,
    ts: now.toISOString(),
    latency_ms: null,
    // Direct-tier events are char-count estimates by construction (vendor-
    // measured numbers only ever come from execute_with_model, which never
    // routes through here). A model that forgets the stamp must not cause
    // the report to disown the event as "unknown"; an explicit stamp is
    // passed through untouched.
    provenance: ev.provenance ?? "estimated",
  };
}

export function readEvents(jsonlPath: string): TelemetryEvent[] {
  if (!existsSync(jsonlPath)) return [];
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as TelemetryEvent);
}

/** Token buckets of one orchestrator per_model / unpriced entry; the two cache-write buckets are disjoint. */
export interface OrchestratorTokens {
  input: number;
  input_cached: number;
  input_cache_write_5m: number;
  input_cache_write_1h: number;
  output: number;
}

/**
 * One price collect-orchestrator-usage.mjs billed transcript messages at:
 * messages of one model and role at the same period, rates and modifiers.
 */
export interface OrchestratorModelCost {
  /** Price-list id; the name as written for a custom-priced model the list does not carry. */
  model: string;
  /** `session`: a top-level session file. `helper`: a file under `subagents/`. */
  role: "session" | "helper";
  /** The names the transcript used for this model. */
  reported_as: string[];
  price_basis: PriceBasis;
  /** The list period that priced it; null for a custom price. */
  price_period: PeriodRef | null;
  /** The modifiers the list applied; `defaulted` names any absent on some message. Null for a custom price. */
  applied_modifiers: AppliedModifiers | null;
  /** USD per 1M tokens, as billed. */
  rates: ModelPricing;
  messages: number;
  tokens: OrchestratorTokens;
  /** Web search requests these messages made (`usage.server_tool_use.web_search_requests`, once per message). Absent when none. */
  web_search_requests?: number;
  /** Their fee at the list's per-search price, inside cost_usd. Absent when no search was made. */
  web_search_cost_usd?: number;
  /** Tokens at `rates`, plus web_search_cost_usd. */
  cost_usd: number;
}

/**
 * Transcript tokens the collector could not price (unknown model, no period for the day, unpriced modifier value),
 * or web search requests with no per-search price (`tokens` all zero, `web_search_requests` set).
 */
export interface OrchestratorUnpriced {
  model: string;
  role: "session" | "helper";
  reason: string;
  messages: number;
  tokens: OrchestratorTokens;
  web_search_requests?: number;
}

/**
 * A receipt's per-model token buckets. Cache writes are one bucket: a receipt
 * carries no 5-minute / 1-hour split per model.
 */
export interface ReceiptTokens {
  input: number;
  input_cached: number;
  input_cache_write: number;
  output: number;
}

/**
 * One model's receipt tokens that no transcript message recorded (receipt minus
 * log, per bucket), as collect-orchestrator-usage.mjs priced them when it booked
 * a receipt: calls Claude Code bills but never logs, or a helper whose
 * transcript file is missing (`attribution_complete` tells the two apart).
 */
export interface OrchestratorUnloggedModel {
  /** Price-list id. */
  model: string;
  /** The names the receipt used for this model. */
  reported_as: string[];
  /** True when no transcript message in the window ran on this model. */
  receipt_only: boolean;
  tokens: ReceiptTokens;
  /**
   * USD per 1M tokens the gap was priced at: per bucket, the model's logged
   * messages' token-weighted rates; else the list at API-default modifiers.
   * Null where no rate exists for a bucket with no tokens.
   */
  rates: { input: number | null; input_cached: number | null; input_cache_write: number | null; output: number | null };
  /** Where the cache-write rate came from: "logged mix", "receipt usage", "5-minute (assumed)" or "none". */
  ttl_split: string;
  /** Every assumption the price needed, in words; empty when the logged mix priced every non-zero bucket. */
  assumed: string[];
  /** Web searches the receipt bills beyond the logged ones. Absent when none. */
  web_search_requests?: number;
  /** Their fee at the list's per-search price, inside cost_usd. Absent when none. */
  web_search_cost_usd?: number;
  cost_usd: number;
}

/** Receipt tokens the list could not price (unknown period, two prices across the window). They are in no cost. */
export interface OrchestratorUnloggedUnpriced {
  model: string;
  reported_as: string[];
  reason: string;
  tokens: ReceiptTokens;
  /** Web searches the receipt bills beyond the logged ones that have no per-search price. Absent when none. */
  web_search_requests?: number;
}

/** What a booked receipt billed beyond the transcript, in total and per model. */
export interface OrchestratorUnloggedBilled {
  per_model: OrchestratorUnloggedModel[];
  unpriced: OrchestratorUnloggedUnpriced[];
  cost_usd: number;
  /**
   * cost_usd as a percentage of the booked receipt's figure, to 2 decimals: the
   * whole overhead, or, for a resumed window booked for its last invocation
   * (v0.7.3 Q1), that invocation's booked figure, which excludes the earlier
   * transcript-priced invocations.
   */
  pct_of_booked: number;
}

export interface Manifest {
  pass: string;
  policy_name: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  /**
   * DISPATCHED-WORK cost only — the calls this server (or log_telemetry)
   * saw. The orchestrator's own loop never passes through the MCP server,
   * so its cost is NOT here; it lives in `orchestrator_overhead` when the
   * post-run collector has run, and `true_total_cost_usd` is the sum. Kept
   * dispatched-only (rather than silently growing) so every consumer that
   * ever read this field keeps meaning the same thing.
   */
  total_cost_usd: number;
  total_input_tokens: number;
  total_input_tokens_cached: number;
  /** Dispatched-work cache-write tokens. Absent on manifests built before the bucket existed. */
  total_input_tokens_cache_write?: number;
  total_output_tokens: number;
  /**
   * The run's own overhead — reasoning, file reads, growing-conversation
   * re-sends — reconstructed from session transcripts by
   * collect-orchestrator-usage.mjs. Present only after the collector runs;
   * derived from `tier: "orchestrator"` events, which buildManifest
   * PARTITIONS OUT of every dispatched sum above so the two spends are
   * never blended silently.
   */
  orchestrator_overhead?: {
    cost_usd: number;
    input_tokens: number;
    input_tokens_cached: number;
    input_tokens_cache_write: number;
    /** 1-hour-TTL share of input_tokens_cache_write (2x input); absent before the tier split. */
    input_tokens_cache_write_1h?: number;
    output_tokens: number;
    events: number;
    provenance: "transcript";
    /**
     * How the overhead was priced, in words: each message from the dated price
     * list (naming any pricing_override models), or the receipt when no
     * transcript message was readable. Before per-message pricing: which one
     * model's rate priced every token.
     */
    pricing_basis?: string;
    /**
     * How cost_usd was arrived at, in words; the report matches on the prefix.
     * "receipt (Anthropic token counts priced at the price list); N% billed but
     * not logged" — no transcript bucket is above the receipt, and either every
     * bucket equals it or the window is provably its invocation, so the
     * receipt's token counts are booked at the list and N% of the figure is
     * receipt tokens no transcript message recorded (`unlogged_billed`);
     * "receipt-only (Anthropic token counts priced at the price list)";
     * "receipt for the last invocation (Anthropic token counts priced at the
     * price list); N% of it billed but not logged; K earlier invocation(s)
     * transcript-priced, unverified" — a resumed window (v0.7.3 Q1): the last
     * invocation's receipt is booked by the same rule, and the earlier
     * invocations are added transcript-priced; before Q1 that window was
     * "transcript (receipt covers only the last invocation, verified ±x%; N
     * earlier invocation(s) unverified)"; "transcript (receipt pending;
     * provisional)"; "transcript (no receipt; unverified)". Collected before
     * v0.7.3: "receipt (transcript agrees, ±x%)" booked Claude Code's own
     * dollars, and "receipt-only" alone did the same. A "; custom policy price
     * for …" part names pricing_override models. A "; approximate window"
     * suffix marks a transcript figure anchored without the run's own command
     * turn; "; INCOMPLETE — unpriced tokens excluded" marks a figure that
     * leaves `unpriced` (or `unlogged_billed.unpriced`) tokens out.
     */
    cost_source?: string;
    /** The transcript-priced figure, kept beside cost_usd when a receipt supplied or verified it. */
    transcript_cost_usd?: number | null;
    /** Claude Code's own end-of-session total for the driver session, when a receipt was found. */
    receipt_cost_usd?: number | null;
    receipt_path?: string | null;
    /** The same Claude Code total, named for what it is since v0.7.3: a check against the booked figure, never booked. */
    receipt_cli_usd?: number | null;
    /** v0.7.3 review fix: the booked part at the price list (the whole receipt, or a resumed window's last invocation), which receipt_cli_usd is checked against; null unless a receipt was booked. */
    booked_cost_usd?: number | null;
    /**
     * When a receipt is booked: the receipt's tokens no transcript message
     * recorded, per model, priced from the list. cost_usd = transcript_cost_usd
     * + unlogged_billed.cost_usd. Null when no receipt is booked.
     */
    unlogged_billed?: OrchestratorUnloggedBilled | null;
    /**
     * Whether every helper named by an Agent/Task result in the pinned session
     * has its `subagents/agent-<id>.jsonl`, and every such file is named. Null
     * when the scan is not pinned to a session file.
     */
    attribution_complete?: boolean | null;
    // v0.7.3 Q1: for a resumed window whose receipt is booked for its last
    // invocation only, attribution_complete, missing_helper_ids and
    // unreferenced_helper_files cover that invocation's helpers only (the
    // helper files that start inside it, and the Agent/Task results it wrote),
    // because only its helpers' tokens can land in unlogged_billed.
    /** Helper ids named by an Agent/Task result with no transcript file. */
    missing_helper_ids?: string[];
    /** Helper transcript files (relative to the transcript directory) no Agent/Task result names. */
    unreferenced_helper_files?: string[];
    /** Transcript cost per model, role and price; transcript_cost_usd is the sum of their cost_usd. */
    per_model?: OrchestratorModelCost[];
    /** Transcript tokens with no price on the list; they are in no cost. */
    unpriced?: OrchestratorUnpriced[];
    /** False when `unpriced` (or, for a booked receipt, `unlogged_billed.unpriced`) is non-empty. */
    pricing_complete?: boolean;
    /** The verification date of the price list the figure was priced with. */
    price_list_verified?: string;
    /**
     * The window the collector measured: ISO bounds (end null = the end of the
     * session file), the anchor each bound came from, whether both were exact,
     * whether it opens at the first dispatch (a lower bound), the session file
     * the scan was pinned to (null = every file scanned) and which file the
     * anchors were read from ("manifest" or "telemetry-rebuild").
     */
    window?: { start: string; end: string | null; start_anchor: string; end_anchor: string; exact: boolean; lower_bound?: boolean; session_id: string | null; source?: string };
    /** Dispatched dollars that ran inside the session and were subtracted once from true_total_cost_usd. */
    dispatched_in_session_cost_usd?: number;
    dispatched_in_session_events?: number;
  };
  /**
   * total_cost_usd − orchestrator_overhead.dispatched_in_session_cost_usd +
   * orchestrator_overhead.cost_usd. Present only alongside the block. Before
   * the in-session field existed it was the plain sum.
   */
  true_total_cost_usd?: number;
  model_breakdown: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  /** Older manifests without token fields still load; dashboard falls back. */
  phase_breakdown: Record<string, {
    calls: number;
    cost_usd: number;
    models: string[];
    input_tokens?: number;
    input_tokens_cached?: number;
    output_tokens?: number;
    by_model?: Record<string, {
      calls: number;
      cost_usd: number;
      input_tokens: number;
      input_tokens_cached: number;
      output_tokens: number;
    }>;
  }>;
  module_breakdown: Record<string, { calls: number; cost_usd: number }>;
  task_type_breakdown: Record<string, { calls: number; cost_usd: number }>;
  artifacts?: { files: number; loc: number; tests: number; test_pass_rate: number };
  quality_scores?: Record<string, number>;
}

/**
 * An attempt's cache-write tokens as a telemetry event stores them.
 *
 * Attempts keep the 5-minute (`input_cache_write`) and 1-hour
 * (`input_cache_write_1h`) writes disjoint, because that is what
 * computeCostUsd prices. An event keeps `input_tokens_cache_write` as the
 * TOTAL written, which is what buildManifest, tools/report.mjs and every
 * earlier event read, and adds the 1-hour SHARE beside it, the same
 * convention the collector's orchestrator event uses. An attempt with no
 * cache-write field (Gemini) yields no event field, so its events are
 * unchanged.
 */
export function cacheWriteBuckets(tokens: { input_cache_write?: number; input_cache_write_1h?: number }): {
  input_tokens_cache_write?: number;
  input_tokens_cache_write_1h?: number;
} {
  const fiveMinute = tokens.input_cache_write;
  const oneHour = tokens.input_cache_write_1h;
  if (fiveMinute === undefined && oneHour === undefined) return {};
  return {
    input_tokens_cache_write: (fiveMinute ?? 0) + (oneHour ?? 0),
    ...(oneHour !== undefined ? { input_tokens_cache_write_1h: oneHour } : {}),
  };
}

export function buildManifest(allEvents: TelemetryEvent[], opts: {
  pass: string;
  policy_name: string;
  artifacts?: Manifest["artifacts"];
}): Manifest {
  if (allEvents.length === 0) {
    const now = new Date().toISOString();
    return emptyManifest(opts.pass, opts.policy_name, now);
  }
  // Partition FIRST: orchestrator-overhead events (post-run transcript
  // reconstruction, tier: "orchestrator") never enter the dispatched sums
  // or breakdowns below. This is the structural guarantee that re-deriving
  // a manifest from collector-touched telemetry can't blend the two spends.
  const events = allEvents.filter((ev) => ev.tier !== "orchestrator");
  const orchEvents = allEvents.filter((ev) => ev.tier === "orchestrator");
  // Run window comes from dispatched events (the collector's event is
  // stamped at collection time, after the run); overhead-only input is a
  // degenerate case where the overhead event is the only clock we have.
  const windowSource = events.length > 0 ? events : orchEvents;
  const sorted = windowSource.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0].ts;
  const ended_at = sorted[sorted.length - 1].ts;
  const duration_sec = Math.max(
    1,
    Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000)
  );

  const model_breakdown: Manifest["model_breakdown"] = {};
  const phase_breakdown: Manifest["phase_breakdown"] = {};
  const module_breakdown: Manifest["module_breakdown"] = {};
  const task_type_breakdown: Manifest["task_type_breakdown"] = {};
  let total_cost_usd = 0,
    total_input_tokens = 0,
    total_input_tokens_cached = 0,
    total_input_tokens_cache_write = 0,
    total_output_tokens = 0;

  for (const ev of events) {
    total_cost_usd += ev.cost_usd;
    total_input_tokens += ev.input_tokens;
    total_input_tokens_cached += ev.input_tokens_cached;
    total_input_tokens_cache_write += ev.input_tokens_cache_write ?? 0;
    total_output_tokens += ev.output_tokens;

    const mb = (model_breakdown[ev.model] ??= {
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
    mb.calls++;
    mb.cost_usd += ev.cost_usd;
    mb.input_tokens += ev.input_tokens;
    mb.output_tokens += ev.output_tokens;

    const pb = (phase_breakdown[ev.phase] ??= {
      calls: 0, cost_usd: 0, models: [],
      input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
      by_model: {},
    });
    pb.calls++;
    pb.cost_usd += ev.cost_usd;
    pb.input_tokens = (pb.input_tokens ?? 0) + ev.input_tokens;
    pb.input_tokens_cached = (pb.input_tokens_cached ?? 0) + ev.input_tokens_cached;
    pb.output_tokens = (pb.output_tokens ?? 0) + ev.output_tokens;
    if (!pb.models.includes(ev.model)) pb.models.push(ev.model);
    const pbm = ((pb.by_model ??= {})[ev.model] ??= {
      calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
    });
    pbm.calls++;
    pbm.cost_usd += ev.cost_usd;
    pbm.input_tokens += ev.input_tokens;
    pbm.input_tokens_cached += ev.input_tokens_cached;
    pbm.output_tokens += ev.output_tokens;

    const modb = (module_breakdown[ev.module] ??= { calls: 0, cost_usd: 0 });
    modb.calls++;
    modb.cost_usd += ev.cost_usd;

    const tb = (task_type_breakdown[ev.task_type] ??= { calls: 0, cost_usd: 0 });
    tb.calls++;
    tb.cost_usd += ev.cost_usd;
  }

  const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  total_cost_usd = r6(total_cost_usd);
  for (const k of Object.keys(model_breakdown))
    model_breakdown[k].cost_usd = r6(model_breakdown[k].cost_usd);
  for (const k of Object.keys(phase_breakdown)) {
    phase_breakdown[k].cost_usd = r6(phase_breakdown[k].cost_usd);
    const bm = phase_breakdown[k].by_model;
    if (bm) for (const mk of Object.keys(bm)) bm[mk].cost_usd = r6(bm[mk].cost_usd);
  }
  for (const k of Object.keys(module_breakdown))
    module_breakdown[k].cost_usd = r6(module_breakdown[k].cost_usd);
  for (const k of Object.keys(task_type_breakdown))
    task_type_breakdown[k].cost_usd = r6(task_type_breakdown[k].cost_usd);

  // The overhead block + true total exist ONLY when overhead events exist —
  // a manifest rebuilt from untouched telemetry is byte-compatible with one
  // built before this field existed.
  let orchestrator_overhead: Manifest["orchestrator_overhead"];
  let true_total_cost_usd: number | undefined;
  if (orchEvents.length > 0) {
    orchestrator_overhead = {
      cost_usd: r6(orchEvents.reduce((s, ev) => s + ev.cost_usd, 0)),
      input_tokens: orchEvents.reduce((s, ev) => s + ev.input_tokens, 0),
      input_tokens_cached: orchEvents.reduce((s, ev) => s + ev.input_tokens_cached, 0),
      input_tokens_cache_write: orchEvents.reduce((s, ev) => s + (ev.input_tokens_cache_write ?? 0), 0),
      output_tokens: orchEvents.reduce((s, ev) => s + ev.output_tokens, 0),
      events: orchEvents.length,
      provenance: "transcript",
    };
    true_total_cost_usd = r6(total_cost_usd + orchestrator_overhead.cost_usd);
  }

  return {
    pass: opts.pass,
    policy_name: opts.policy_name,
    started_at,
    ended_at,
    duration_sec,
    total_cost_usd,
    total_input_tokens,
    total_input_tokens_cached,
    total_input_tokens_cache_write,
    total_output_tokens,
    orchestrator_overhead,
    true_total_cost_usd,
    model_breakdown,
    phase_breakdown,
    module_breakdown,
    task_type_breakdown,
    artifacts: opts.artifacts,
  };
}

function emptyManifest(pass: string, policy_name: string, ts: string): Manifest {
  return {
    pass,
    policy_name,
    started_at: ts,
    ended_at: ts,
    duration_sec: 0,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_input_tokens_cached: 0,
    total_output_tokens: 0,
    model_breakdown: {},
    phase_breakdown: {},
    module_breakdown: {},
    task_type_breakdown: {},
  };
}

export function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}
