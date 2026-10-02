/**
 * The three typists the executor can hand a job to. Each takes the same brief
 * (the shared block + the framed job block, see brief.ts) and returns the same
 * answer shape — {path, content} when writing a file, exact edits or the
 * whole file when fixing one — with its own receipt's tokens and dollars. The
 * policy decides which one types a job; nothing else differs.
 *
 *  - lean-opus — `claude -p` with no tools, no MCP servers, safe mode, low
 *    effort, the shared block as the system-prompt tail (cached), the job on
 *    stdin.
 *  - flash-completion — Gemini through the completion door (GeminiFlashAdapter),
 *    the shared block first as its inline header, a response schema, low
 *    thinking.
 *  - agy — Gemini through the Antigravity SDK, configured as a typist
 *    (worker/typist_worker.py: FINISH-only, custom short system prompt + the
 *    shared block, no sub-agents, a model-call budget, low thinking).
 *
 * Effort is LOW for every typist: the lowest effort whose first-try passes
 * equal the highest effort's. Higher effort costs more for no extra pass, and
 * high thinking can run Flash out of the policy's 8,192-token output ceiling.
 *
 * Each typist's request is pinned by a test (test/typists.test.mjs), and each
 * child process gets an environment built from an allowlist, so no variable
 * of the launching session can change what a typist does; only the login,
 * provider and network settings that decide who pays and where the call goes
 * are passed on. Each call's scratch folder is removed when the call returns.
 *
 * A failure is classified from the vendor's structured fields, never from its
 * wording: a vendor or network failure ("not now") waits and is not an
 * attempt; anything else, including anything unknown, is an attempt.
 */
import { execFileSync, spawn } from "node:child_process";
import { claudeCommand } from "../claudeCommand.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptRecord, ModelConfig, TaskPacket } from "../types.js";
import { GeminiFlashAdapter } from "../adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../adapters/AntigravityWorkerAdapter.js";
import { priceClaudeCliResult } from "../adapters/claudeCliLedger.js";
import { computeCostUsd } from "../pricing.js";
import { mapSidecarTokens } from "../delegation/workerProcess.js";
// The Python workers' folder, from the package root: in the single-file bundle this module is not two folders
// below it (paths.ts).
import { WORKER_DIR } from "../paths.js";

export type Door = "lean-opus" | "flash-completion" | "agy";
/** Which answer the job asks for: a whole file, or a fix to one. */
export type Contract = "file" | "edit";

export interface Edit { search: string; replace: string }
/** A typist's answer: `content` when writing (or rewriting) a file, `edits` when fixing one. */
export interface Answer { path: string; content?: string; edits?: Edit[] }

/** The contract in words, for the reason an answer was refused. */
export function contractShape(contract: Contract): string {
  return contract === "file" ? "{path, content}" : "{path, edits} or {path, content}";
}

export interface TypistTokens {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning?: number;
  input_cache_write?: number;
  input_cache_write_1h?: number;
}

export interface TypistResult {
  /** A well-formed answer came back (whether it passes the checks is the executor's call). */
  answer: Answer | null;
  /** Why there is no answer. */
  error?: string;
  /** The failure was the vendor's or the network's ("not now"), read from structured fields; not an attempt. */
  transport: boolean;
  /**
   * The answer stopped at this typist's output limit (the vendor's own stop reason: Gemini
   * finishReason MAX_TOKENS, Anthropic stop_reason max_tokens). The executor then sends the file to a
   * typist with a larger limit instead of retrying this one.
   */
  cut_off?: boolean;
  /** A retry delay the vendor asked for, when it gave one. */
  retry_after_ms?: number;
  /** The vendor's HTTP status for a refused call, when it reported one (the executor stops a stage on 401/403). */
  error_status?: number;
  tokens: TypistTokens;
  cost_usd: number;
  price_basis?: string;
  latency_ms: number;
}

export interface TypeRequest {
  /** The job's own id and path (a spec unit's, or a fix's). */
  unit: { id: string; path: string };
  /** The job as a packet: instruction, inputs, answer schema. The completion door sends it as is. */
  packet: TaskPacket;
  /** The same packet framed exactly as the completion door frames it (lean-opus and agy send this text). */
  framed: string;
  /** The shared block, and a file holding it (lean-opus and agy read it from disk). */
  shared: string;
  sharedFile: string;
  contract: Contract;
  passId: string;
  /**
   * Stops the call when it fires (zero-touch hand-offs: the person pressed Stop): a typist that runs a program kills
   * its process group. Optional, and never set by the executor, so a workflow's typing is not affected.
   */
  signal?: AbortSignal;
}

export interface Typist {
  door: Door;
  modelId: string;
  modelName: string;
  type(req: TypeRequest): Promise<TypistResult>;
}

const ZERO: TypistTokens = { input: 0, input_cached: 0, output: 0 };

// ─── failures, from structured fields ───────────────────────────────────

/**
 * HTTP statuses that mean "not now" rather than "wrong": 408 Request Timeout,
 * 429 Too Many Requests and the 5xx server errors of HTTP semantics (RFC 9110),
 * plus 529, Anthropic's documented "overloaded" status.
 */
export const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Node and undici error codes of a connection that failed in transit. */
export const TRANSIENT_NET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export function isTransient(status?: number | null, code?: string): boolean {
  return (typeof status === "number" && TRANSIENT_HTTP.has(status)) || (typeof code === "string" && TRANSIENT_NET.has(code));
}

/** A `claude -p` result that reports an error: its api_error_status decides; no status (a turn limit, a refusal) is an attempt. */
export function leanOpusOutcome(o: { is_error?: boolean; subtype?: string; api_error_status?: number | null; stop_reason?: string | null }): { transport: boolean; cut_off: boolean } {
  return { transport: !!o.is_error && isTransient(o.api_error_status), cut_off: o.stop_reason === "max_tokens" };
}

/** The completion door's last attempt: the status, network code and requested delay the adapter recorded. */
export function flashOutcome(a: (Pick<AttemptRecord, "error_status" | "error_code" | "retry_after_ms"> & { stop_reason?: string | null }) | undefined): { transport: boolean; retry_after_ms?: number; cut_off: boolean } {
  return { transport: isTransient(a?.error_status, a?.error_code), retry_after_ms: a?.retry_after_ms, cut_off: a?.stop_reason === "MAX_TOKENS" };
}

/**
 * The agent door: the SDK retries transient API errors itself, with the
 * executor's retry count and first wait (its ModelAPIRetryConfig, set in
 * agyWorkerArgs: 6 retries, 2 s doubling to 64 s, no jitter — the SDK does not
 * document its jitter setting's units, so none is guessed), and
 * the errors it raises carry no HTTP status, so an error that reaches the
 * receipt — after those waits — is an attempt: fail closed.
 */
export function agyOutcome(_receipt: { error?: string; error_type?: string }): { transport: boolean } {
  return { transport: false };
}

/**
 * The answer contract, read strictly: the whole reply is one JSON object. For
 * a file, string `path` and `content`. For a fix, string `path` and exactly one
 * of a non-empty `edits` list (each a non-empty `search` and a string
 * `replace`) or the whole file as `content`. No fence stripping, no repair.
 */
export function parseAnswer(raw: unknown, contract: Contract): Answer | null {
  let o: any = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (!o || typeof o !== "object" || typeof o.path !== "string") return null;
  if (contract === "file") {
    return typeof o.content === "string" && o.edits === undefined ? { path: o.path, content: o.content } : null;
  }
  const hasContent = typeof o.content === "string";
  const hasEdits = o.edits !== undefined;
  if (hasContent === hasEdits) return null;
  if (hasContent) return { path: o.path, content: o.content };
  if (!Array.isArray(o.edits) || !o.edits.length) return null;
  const edits: Edit[] = [];
  for (const e of o.edits) {
    if (!e || typeof e.search !== "string" || !e.search || typeof e.replace !== "string") return null;
    edits.push({ search: e.search, replace: e.replace });
  }
  return { path: o.path, edits };
}

// ─── child environments, from allowlists ────────────────────────────────

/** Who is logged in and the process basics, plus TMPDIR (the per-user temp directory on macOS) and the locale. */
const CHILD_BASE = ["HOME", "PATH", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];
/** Network routing only: proxies and extra CA certificates. They change where bytes go, never what a model does. */
const CHILD_NETWORK = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
/**
 * What decides which login and which provider a `claude -p` call is billed
 * to, as the session that launched the run has it: the OAuth token of a
 * headless login, a gateway (base URL, bearer token, headers, client
 * certificate), and Claude on Bedrock, Vertex AI or Foundry with their
 * credentials, project and region. A typist bills the same login and
 * provider as the rest of the run, so none of them is dropped.
 */
const CLAUDE_ROUTING = [
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL", "CLOUD_ML_REGION", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
];
/** Families of the same settings: AWS credentials and region, per-model Vertex regions, the Foundry resource and key. */
const CLAUDE_ROUTING_PREFIXES = ["AWS_", "VERTEX_REGION_", "ANTHROPIC_FOUNDRY_"];
/** The lean Opus child: plus CLAUDE_CONFIG_DIR, which says where the Claude login lives when it is not under HOME. */
export const LEAN_OPUS_ENV_ALLOW = [...CHILD_BASE, ...CHILD_NETWORK, "CLAUDE_CONFIG_DIR", ...CLAUDE_ROUTING];
/**
 * The agent child: plus Google's credential locations, the quota project, the
 * Python TLS roots, and the macOS library path the worker's Python may need
 * for pyexpat (the same reason the agent door passes it), and where Python
 * finds its modules and native libraries: a worker Python that reaches the
 * SDK through PYTHONPATH, a virtual or conda environment, or LD_LIBRARY_PATH
 * works here exactly as it does through the agent door.
 */
export const AGY_ENV_ALLOW = [...CHILD_BASE, ...CHILD_NETWORK, "CLOUDSDK_CONFIG", "REQUESTS_CA_BUNDLE", "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONNOUSERSITE", "VIRTUAL_ENV", "CONDA_PREFIX"];
/**
 * Google's own settings (credentials, quota project, universe domain) and the
 * metadata server's, which the agent door passes too. GOOGLE_API_KEY is
 * never passed: the SDK is Vertex-only here, and a key could route it to
 * another project's wallet.
 */
const AGY_ENV_PREFIXES = ["GOOGLE_", "GCE_"];
const AGY_ENV_NEVER = ["GOOGLE_API_KEY"];

function pick(base: Record<string, string | undefined>, names: string[], prefixes: string[] = [], never: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || never.includes(k)) continue;
    if (names.includes(k) || prefixes.some((p) => k.startsWith(p))) env[k] = v;
  }
  return env;
}

/**
 * The lean Opus typist's environment. Under --auth=estimated the run is on the
 * Claude subscription, so ANTHROPIC_API_KEY is left out: a `claude -p` that
 * sees the key uses it and bills the API. Under --auth=vendor the run bills
 * the API on purpose, with the key the policy names (`keyEnv`: the leaf's
 * auth.env, else ANTHROPIC_API_KEY), passed as ANTHROPIC_API_KEY — never
 * another key that happens to be set. The login and provider settings
 * (CLAUDE_ROUTING) pass in both modes. The five-minute cache lifetime
 * is set explicitly: a stage's typist calls run back to back, so the shared
 * block is re-read within five minutes, and a five-minute write costs 1.25×
 * input where a one-hour write costs 2×. Auto-update is off so every typist
 * call of a run uses one CLI version.
 */
export function leanOpusEnv(base: Record<string, string | undefined>, authMode: "estimated" | "vendor", keyEnv = "ANTHROPIC_API_KEY"): Record<string, string> {
  const env = pick(base, LEAN_OPUS_ENV_ALLOW, CLAUDE_ROUTING_PREFIXES);
  if (authMode === "vendor" && base[keyEnv] !== undefined) env.ANTHROPIC_API_KEY = base[keyEnv]!;
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = "5m";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/**
 * The agent typist's environment: the allowlist, the Vertex project and region
 * pinned (the SDK is Vertex-only here, so no API key is passed that could route
 * it elsewhere), and unbuffered output so a killed worker's last line survives.
 */
export function agyEnv(base: Record<string, string | undefined>, project: string, location: string): Record<string, string> {
  return { ...pick(base, AGY_ENV_ALLOW, AGY_ENV_PREFIXES, AGY_ENV_NEVER), GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, PYTHONUNBUFFERED: "1" };
}

// ─── lean-opus ──────────────────────────────────────────────────────────

/** The flags the lean route cannot run without. */
const LEAN_OPUS_NEEDS = ["--tools", "--append-system-prompt-file", "--effort"];

/**
 * The typist's command line. Fails closed when the installed CLI lacks a flag
 * the lean route depends on (no tools, the system-prompt file, effort); the
 * isolation flags are added whenever the CLI lists them.
 */
export function leanOpusArgs(model: string, effort: string, sharedFile: string, helpText: string): string[] {
  const lists = (flag: string) => cliLists(helpText, flag);
  for (const needed of LEAN_OPUS_NEEDS) {
    if (!lists(needed)) throw new Error(`this claude CLI lists no ${needed} flag, so the lean Opus typist cannot run; nothing was sent`);
  }
  const args = ["-p", "--model", model, "--output-format", "json", "--tools", ""];
  // --no-session-persistence: the typist's receipt (the JSON result) carries its
  // usage, so no transcript is needed; writing none keeps a transcript folder
  // per call off disk and keeps typist sessions out of anything that scans
  // ~/.claude/projects (the collector reads only the project's own folder).
  for (const f of ["--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) if (lists(f)) args.push(f);
  args.push("--effort", effort, "--append-system-prompt-file", sharedFile);
  return args;
}

/**
 * Whether the CLI's help text offers `flag`: as its own option, or folded into
 * a sibling's as `--name[-file]` — Claude Code 2.1.280 lists
 * --append-system-prompt-file only that way (inside --bare's description),
 * and the flag works.
 */
export function cliLists(helpText: string, flag: string): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  if (new RegExp(`(^|\\s)${esc(flag)}(\\s|,|$)`, "m").test(helpText)) return true;
  const m = flag.match(/^(--.+)-file$/);
  return !!m && helpText.includes(`${m[1]}[-file]`);
}

let cliHelp: string | undefined;
/**
 * `claude --help`, read once per server process. `fresh` reads it again and
 * keeps the new text: pre-flight does, so a CLI updated after a halt is seen
 * by the check and by every typist after it.
 */
export function claudeHelp(fresh = false): string {
  if (fresh || cliHelp === undefined) cliHelp = execFileSync(claudeCommand(), ["--help"], { encoding: "utf8", timeout: 30_000 });
  return cliHelp;
}

/**
 * Why this machine's claude CLI cannot run a lean Opus typist at typing
 * effort, with what to do about it, or null when it can. Every missing flag is
 * named at once, so one update fixes them all.
 */
export function leanOpusCliProblem(readHelp: () => string = () => claudeHelp(true)): string | null {
  let help: string;
  try { help = readHelp(); } catch (e: any) {
    if (e?.code === "ENOENT") return "there is no `claude` command on this server's PATH: install Claude Code, or start Claude Code from a shell whose PATH has `claude`";
    return `\`claude --help\` failed (${String(e?.message ?? e).slice(0, 200)})`;
  }
  const needs = LEAN_OPUS_NEEDS;
  const missing = needs.filter((f) => !cliLists(help, f));
  if (!missing.length) return null;
  return `this machine's claude CLI lists no ${missing.join(", ")} flag${missing.length > 1 ? "s" : ""}: update Claude Code (\`claude update\`) until \`claude --help\` lists ${needs.join(", ")}`;
}

/** Removes a call's scratch folder; a folder that cannot be removed never turns a finished call into a failed one. */
function removeScratch(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ }
}

/** Runs a child in its own process group and kills the whole group on timeout, so nothing is left billing. */
function runChild(cmd: string, args: string[], opts: { env: Record<string, string>; cwd: string; input: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "", err = "", timedOut = false;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    // A stop asked for while the program runs (TypeRequest.signal) ends its whole process group at once.
    const onAbort = () => { err += "stopped: the call was cancelled"; kill(); };
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { err += String(e); });
    // A child that exits before reading all of its input (a brief over the
    // pipe's 64 KB buffer) makes the write fail with EPIPE; without a
    // listener that error would take the whole MCP server down. It is part of
    // this child's failure, which the caller reports as a failed attempt.
    child.stdin.on("error", (e) => { err += String(e); });
    child.on("close", (code) => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); done({ code, out, err, timedOut }); });
    child.stdin.end(opts.input);
  });
}

export class LeanOpusTypist implements Typist {
  readonly door = "lean-opus" as const;
  readonly modelId: string;
  readonly modelName: string;
  constructor(private readonly leaf: ModelConfig, private readonly opts: { authMode: "estimated" | "vendor"; effort: string; timeoutMs: number; env?: Record<string, string | undefined>; help?: string }) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    // Fail at construction, before any job is sent, when this CLI cannot run the lean route.
    leanOpusArgs(leaf.model_name, opts.effort, "/dev/null", opts.help ?? claudeHelp());
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    const started = Date.now();
    const args = leanOpusArgs(this.leaf.model_name, this.opts.effort, req.sharedFile, this.opts.help ?? claudeHelp());
    // A scratch working directory: the typist has no tools, and safe mode keeps
    // any project CLAUDE.md out, but an empty cwd makes that independent of flags.
    const cwd = mkdtempSync(join(tmpdir(), "mmo-typist-"));
    let r: Awaited<ReturnType<typeof runChild>>;
    try {
      // The program is looked up on the PATH the child runs with, as spawn itself does, then in the Claude app
      // (claudeCommand.ts): never on another PATH than the one this typist was given.
      const env = leanOpusEnv(this.opts.env ?? process.env, this.opts.authMode, this.leaf.auth?.env);
      r = await runChild(claudeCommand(env), args, { env, cwd, input: req.framed, timeoutMs: this.opts.timeoutMs, signal: req.signal });
    } finally {
      removeScratch(cwd);
    }
    const latency = Date.now() - started;
    let o: any;
    try { o = JSON.parse(r.out); } catch {
      // No receipt: a killed or crashed child. Its tokens are unknown (the CLI
      // writes its receipt only at the end), so the call is billed $0 and says
      // so; it is an attempt, never a wait — a timeout is not proof the vendor
      // is busy, and retrying it for free could repeat a long call many times.
      const why = r.timedOut
        ? `the lean Opus typist did not answer within ${Math.round(this.opts.timeoutMs / 1000)} s (killed; its usage is unknown)`
        : `no JSON receipt from claude -p (usage unknown): ${(r.err || r.out).slice(0, 300)}`;
      return { answer: null, error: why, transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    const ledger = priceClaudeCliResult(o, { config: this.leaf, date: new Date(started), transcript: null });
    const tokens: TypistTokens = { input: ledger.tokens.input, input_cached: ledger.tokens.input_cached, output: ledger.tokens.output, input_cache_write: ledger.tokens.input_cache_write, input_cache_write_1h: ledger.tokens.input_cache_write_1h, output_reasoning: o.usage?.output_tokens_details?.thinking_tokens };
    if (o.is_error) {
      const text = `${o.subtype ?? "error"}${o.api_error_status ? ` (HTTP ${o.api_error_status})` : ""}: ${String(o.result ?? r.err)}`;
      return { answer: null, error: text.slice(0, 300), transport: leanOpusOutcome(o).transport, ...(leanOpusOutcome(o).cut_off ? { cut_off: true } : {}), ...(typeof o.api_error_status === "number" ? { error_status: o.api_error_status } : {}), tokens, cost_usd: ledger.cost_usd, price_basis: ledger.price_basis, latency_ms: latency };
    }
    const answer = parseAnswer(o.result, req.contract);
    return { answer, error: answer ? undefined : `the reply was not one JSON object in the ${contractShape(req.contract)} contract`, transport: false, ...(!answer && leanOpusOutcome(o).cut_off ? { cut_off: true } : {}), tokens, cost_usd: ledger.cost_usd, price_basis: ledger.price_basis, latency_ms: latency };
  }
}

// ─── flash-completion ───────────────────────────────────────────────────

export class FlashCompletionTypist implements Typist {
  readonly door = "flash-completion" as const;
  readonly modelId: string;
  readonly modelName: string;
  private readonly adapter: GeminiFlashAdapter;
  private headerSet = "";
  /** The time limit on each request (the SDK's own httpOptions.timeout); a request past it fails and is an attempt. */
  readonly requestTimeoutMs?: number;
  constructor(private readonly leaf: ModelConfig, effort: string, requestTimeoutMs?: number) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    this.requestTimeoutMs = requestTimeoutMs;
    this.adapter = new GeminiFlashAdapter({ ...leaf, reasoning: { ...(leaf as any).reasoning, tier: effort } } as ModelConfig, { requestTimeoutMs });
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    if (this.headerSet !== req.shared) { this.adapter.inlineHeader(req.shared); this.headerSet = req.shared; }
    const started = Date.now();
    const maxOut = this.leaf.max_output_tokens_absolute ?? 8192;
    const r = await this.adapter.execute({ ...req.packet, budget: { ...req.packet.budget, maxOutputTokens: maxOut } });
    const tokens: TypistTokens = { input: r.tokens?.input ?? 0, input_cached: r.tokens?.input_cached ?? 0, output: r.tokens?.output ?? 0, output_reasoning: (r.tokens as any)?.output_reasoning };
    const last = r.attempts?.[r.attempts.length - 1];
    if (!r.success) {
      const text = String(r.error ?? last?.error ?? r.terminal_reason ?? "the completion door failed");
      const o = flashOutcome(last);
      return { answer: null, error: text.slice(0, 300), transport: o.transport, retry_after_ms: o.retry_after_ms, ...(o.cut_off ? { cut_off: true } : {}), ...(last?.error_status !== undefined ? { error_status: last.error_status } : {}), tokens, cost_usd: r.cost_usd ?? 0, price_basis: last?.price_basis, latency_ms: Date.now() - started };
    }
    const answer = parseAnswer(r.result, req.contract);
    return { answer, error: answer ? undefined : `the reply was not an object in the ${contractShape(req.contract)} contract`, transport: false, tokens, cost_usd: r.cost_usd ?? 0, price_basis: last?.price_basis, latency_ms: Date.now() - started };
  }
}

// ─── agy ────────────────────────────────────────────────────────────────

export const TYPIST_WORKER = join(WORKER_DIR, "typist_worker.py");


/**
 * The agent typist's command line: the worker setup described at the top of
 * this file, with the job's answer schema, and the executor's wait rule for
 * rate limits handed to the SDK's own API retry (its errors carry no HTTP
 * status, so the executor cannot wait them out itself; left unset, the SDK
 * applies unstated defaults and a rate limit can surface as a failed attempt).
 */
export function agyWorkerArgs(i: { briefFile: string; sharedFile: string; schemaFile: string; model: string; region: string; workdir: string; receiptFile: string; thinking: string; maxModelCalls: number; timeoutSec: number; apiRetries: number; apiRetryInitialMs: number }): string[] {
  return [TYPIST_WORKER, "--brief-file", i.briefFile, "--system-file", i.sharedFile, "--answer-schema-file", i.schemaFile, "--model", i.model, "--region", i.region,
    "--workdir", i.workdir, "--out", i.receiptFile, "--thinking", i.thinking.toUpperCase(), "--max-model-calls", String(i.maxModelCalls), "--timeout", String(i.timeoutSec),
    "--api-retries", String(i.apiRetries), "--api-retry-initial-ms", String(i.apiRetryInitialMs)];
}

export class AgyTypist implements Typist {
  readonly door = "agy" as const;
  readonly modelId: string;
  readonly modelName: string;
  private readonly agent: AntigravityWorkerAdapter;
  constructor(private readonly leaf: ModelConfig, private readonly opts: { effort: string; maxModelCalls: number; timeoutSec: number; apiRetries: number; apiRetryInitialMs: number }) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    // The product's agent-door adapter resolves the Vertex project, the region,
    // the worker's Python and the price exactly as the agent door does; the
    // typist reuses all four, so its bill is computed the same way.
    this.agent = new AntigravityWorkerAdapter(leaf);
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    // The scratch folder holds the brief, the answer schema, the receipt and the SDK's own files; the
    // receipt is read into the result, so nothing in the folder is needed once the call returns.
    const scratch = mkdtempSync(join(tmpdir(), "mmo-agy-typist-"));
    try {
      return await this.typeIn(scratch, req);
    } finally {
      removeScratch(scratch);
    }
  }
  private async typeIn(scratch: string, req: TypeRequest): Promise<TypistResult> {
    const started = Date.now();
    const briefFile = join(scratch, "brief.md"), receiptFile = join(scratch, "receipt.json"), schemaFile = join(scratch, "answer-schema.json");
    writeFileSync(briefFile, req.framed);
    writeFileSync(schemaFile, JSON.stringify(req.packet.outputSchema));
    const args = agyWorkerArgs({ briefFile, sharedFile: req.sharedFile, schemaFile, model: this.leaf.model_name, region: this.agent.location, workdir: scratch, receiptFile, thinking: this.opts.effort, maxModelCalls: this.opts.maxModelCalls, timeoutSec: this.opts.timeoutSec, apiRetries: this.opts.apiRetries, apiRetryInitialMs: this.opts.apiRetryInitialMs });
    // The worker enforces its own time limit and still writes its receipt; the
    // extra 30 s is the process-group kill for a worker that hangs past it.
    const r = await runChild(this.agent.python, args, { env: agyEnv(process.env, this.agent.project, this.agent.location), cwd: scratch, input: "", timeoutMs: (this.opts.timeoutSec + 30) * 1000, signal: req.signal });
    const latency = Date.now() - started;
    if (!existsSync(receiptFile)) {
      const why = r.timedOut ? `the agent typist did not finish within ${this.opts.timeoutSec + 30} s (killed; its usage is unknown)` : `the agent typist wrote no receipt (usage unknown): ${r.err.slice(-300)}`;
      return { answer: null, error: why, transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    let receipt: any;
    try { receipt = JSON.parse(readFileSync(receiptFile, "utf8")); } catch (e: any) {
      // A receipt cut short (a worker killed mid-write) is a failed attempt whose usage is unknown, never a thrown error.
      return { answer: null, error: `the agent typist left an unreadable receipt (usage unknown): ${e?.message ?? e}`.slice(0, 300), transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    // The worker records the session's cumulative usage even when the session
    // failed or timed out, so a failed call is billed for what it spent.
    const tokens = receipt.usage ? mapSidecarTokens({ sdk_version: receipt.sdk_version, usage: receipt.usage }) : ZERO;
    const price = this.agent.pricingOn(new Date(started));
    const cost = price.unpriced ? 0 : computeCostUsd(tokens, price.billed);
    const basis = price.unpriced ? undefined : price.basis;
    if (receipt.error && !receipt.finish_output) {
      const text = String(receipt.error);
      return { answer: null, error: text.slice(0, 300), transport: agyOutcome(receipt).transport, tokens, cost_usd: cost, price_basis: basis, latency_ms: latency };
    }
    const answer = parseAnswer(receipt.finish_output, req.contract);
    return { answer, error: answer ? undefined : `the agent did not finish with one object in the ${contractShape(req.contract)} contract`, transport: false, tokens, cost_usd: cost, price_basis: basis, latency_ms: latency };
  }
}
