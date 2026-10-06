/**
 * Greenfield's typists, typing a brownfield run's apply-form packets, whatever the job.
 *
 * Why: one machine for both flows. Greenfield's executor types every file through a typist chosen by the policy's
 * leaf (executor/tools.ts typistForLeaf): the lean Opus typist (`claude -p` with no tools, low effort), Flash through
 * the completion door, or the Antigravity SDK agent working in a scratch folder — each answers, and code writes. A
 * brownfield run's apply loop (apply.ts runApplyLoop) types its packets with those same typists, unchanged, in their
 * own answer contracts (greenfield's "file" for a new file, "edit" — exact search/replace, or the whole file — for an
 * existing one). The two flows then differ only in what they type, never in who types or how.
 *
 * This file is the seam: an adapter (TypistApplyAdapter) that sends a packet to a typist and reports the call the way
 * the apply loop and the server's telemetry read any adapter (an ExecutionResult with one AttemptRecord). Two pieces
 * of greenfield's stage runner come with it, because they belong to the caller there: the shared block first (the
 * inputs every packet of a batch carries, marked `shared` by batch.ts markSharedInputs, are the typist's `shared` — the
 * lean typist's cached system-prompt file, Flash's inline header, the agent's system file), and the warm gate (a lean
 * Opus typist whose cache has gone cold sends one call alone; executor/run.ts warmGate).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptRecord, ExecutionResult, FileSlice, ModelConfig, TaskPacket } from "./types.js";
import type { ModelAdapter } from "./adapters/ModelAdapter.js";
import type { Contract, Typist, TypistResult } from "./executor/typists.js";
import { typistDoorFor } from "./executor/tools.js";
import { EDIT_ANSWER_SCHEMA, FILE_ANSWER_SCHEMA, framedPacket } from "./executor/brief.js";
import { LEAN_OPUS_CACHE_TTL_MS } from "./executor/run.js";
import { inputKey } from "./batch.js";

/**
 * The brownfield jobs (plugin/config/intents.json; a test keeps the two equal). Every one runs the same packet flow
 * (skills/pipeline/brownfield-runs.md): the feature jobs had it first, and the other five took it in place of the
 * orchestrator typing or dispatching each file itself, so a job differs from another only in what it plans.
 */
export const BROWNFIELD_INTENTS = new Set(["docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"]);

/**
 * Whether this apply packet is typed by one of greenfield's typists: a brownfield run's packet (it names its job,
 * `intent`) routed to a leaf greenfield has a typist for (a Claude model, Flash through the completion door, or the
 * Antigravity agent), once the run's start check (preflight_dispatch) has recorded how the run is billed. What happens
 * to any other packet is the server's decision (server.ts runPacket), not this predicate's.
 */
export function usesServerTypist(leaf: Pick<ModelConfig, "adapter">, packet: Pick<TaskPacket, "intent">, run: { authMode: "estimated" | "vendor" } | undefined): boolean {
  return Boolean(run) && BROWNFIELD_INTENTS.has(String(packet.intent ?? "")) && typistDoorFor(leaf) !== null;
}

/**
 * The packet's shared inputs as one block, and the packet without them. Sorted by identity, so every packet of a batch
 * renders the same bytes whatever order it lists them in; empty when the packet has none.
 */
export function splitShared(packet: TaskPacket): { shared: string; packet: TaskPacket } {
  const shared = packet.inputs.filter((s) => s.shared === true).sort((x, y) => (inputKey(x) < inputKey(y) ? -1 : inputKey(x) > inputKey(y) ? 1 : 0));
  if (!shared.length) return { shared: "", packet };
  const block = (s: FileSlice) => `### ${s.path}${s.section ? ` § ${s.section}` : ""}${s.lines ? ` lines ${s.lines[0]}-${s.lines[1]}` : ""} — ${s.reason}\n\`\`\`\n${s.content ?? ""}\n\`\`\``;
  const text = ["## Shared inputs (the same for every file of this batch)", ...shared.map(block)].join("\n\n");
  return { shared: text, packet: { ...packet, inputs: packet.inputs.filter((s) => s.shared !== true) } };
}

/** An apply packet's answer contract: greenfield's "edit" for an existing file, "file" for a new one. */
export function contractFor(packet: TaskPacket): Contract {
  return (packet as any).apply?.mode === "edits" ? "edit" : "file";
}

export class TypistApplyAdapter implements ModelAdapter {
  readonly id: string;
  /** When a call with this shared block last reached the model, and the call warming it now (greenfield's warmGate). */
  private readonly lastCall = new Map<string, number>();
  private readonly warming = new Map<string, Promise<void>>();

  constructor(
    readonly modelConfig: ModelConfig,
    readonly typist: Typist,
    private readonly opts: { now?: () => number } = {},
  ) {
    this.id = typist.door;
  }

  get door() {
    return this.typist.door;
  }

  /**
   * Greenfield's warm gate, per shared block (its cache is that block): warm for a block a call reached the model with
   * less than the cache lifetime ago; cold, this call goes alone and the rest wait for it. Only the lean Opus typist,
   * as in greenfield: the Gemini doors have no cache the caller controls.
   */
  private async warmGate(key: string): Promise<(reachedModel: boolean) => void> {
    if (this.typist.door !== "lean-opus") return () => {};
    const now = this.opts.now ?? Date.now;
    for (;;) {
      const w = this.warming.get(key);
      if (w) { await w; continue; }
      const startedAt = now();
      const last = this.lastCall.get(key);
      const mark = (reached: boolean) => { if (reached) this.lastCall.set(key, Math.max(this.lastCall.get(key) ?? 0, startedAt)); };
      if (last !== undefined && startedAt - last < LEAN_OPUS_CACHE_TTL_MS) return mark;
      let release!: () => void;
      this.warming.set(key, new Promise<void>((r) => (release = r)));
      return (reached) => { mark(reached); this.warming.delete(key); release(); };
    }
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const contract = contractFor(packet);
    const { shared, packet: own } = splitShared(packet);
    const typed: TaskPacket = { ...own, outputSchema: contract === "edit" ? EDIT_ANSWER_SCHEMA : FILE_ANSWER_SCHEMA };
    const dir = mkdtempSync(join(tmpdir(), "mmo-apply-typist-"));
    const done = await this.warmGate(shared);
    let r: TypistResult;
    let reached = false;
    try {
      const sharedFile = join(dir, "shared.txt");
      writeFileSync(sharedFile, shared);
      const t0 = Date.now();
      try {
        r = await this.typist.type({ unit: { id: packet.id, path: packet.artifact_path ?? "" }, packet: typed, framed: framedPacket(typed), shared, sharedFile, contract, passId: packet.pass_id });
      } catch (e: any) {
        // A typist that throws (a spawn failure, an unreadable receipt, a constructor's missing CLI flag) fails this
        // attempt and nothing else, as in greenfield's stage runner (executor/run.ts call): no answer, its reason, and
        // no tokens, so the apply loop retries it and the packet keeps what its earlier attempts spent.
        r = { answer: null, error: `the ${this.typist.door} typist failed: ${e?.message ?? String(e)}`.slice(0, 300), transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: Date.now() - t0 };
      }
      const t = r.tokens;
      reached = t.input + t.input_cached + (t.input_cache_write ?? 0) + (t.input_cache_write_1h ?? 0) > 0;
    } finally {
      done(reached);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ }
    }
    return typistResult(packet, r);
  }
}

/**
 * A typist's result as the apply loop reads an adapter's: an answer is a success of the call; a cut-off reply goes to
 * the next model (the loop's cut-off rule); a vendor's or network's "not now" waits (`transient`), and a refused login
 * halts (the HTTP status); any other failure is a failed attempt the loop retries with the reason, as greenfield's
 * stage runner retries it: `invalid_answer` when the model replied outside the contract, `no_answer` when no reply came
 * at all (a crash, a timeout, a login the CLI could not use and reported with no HTTP status), `vendor_error` for a
 * vendor's other refusal (its HTTP status). Which is read from the reply's own fields and output tokens, not from the
 * error's words. A call with no answer is recorded as failed here; a call with one is recorded as greenfield's runner
 * records it (executor/run.ts, `success: ok`) once the loop has judged the answer — its own path, applied, not empty,
 * and passing the file's checks (apply.ts runApplyLoop judges its events). The attempt is numbered by the ladder's slot
 * (the packet's retry_count + 1), with the reason the loop gave it, as greenfield numbers a job's attempts; the loop
 * puts that reason on the event itself, so no dispatcher's label stands in for it.
 */
export function typistResult(packet: TaskPacket, r: TypistResult): ExecutionResult {
  const tokens = {
    input: r.tokens.input,
    input_cached: r.tokens.input_cached,
    output: r.tokens.output,
    ...(r.tokens.input_cache_write !== undefined ? { input_cache_write: r.tokens.input_cache_write } : {}),
    ...(r.tokens.input_cache_write_1h !== undefined ? { input_cache_write_1h: r.tokens.input_cache_write_1h } : {}),
    ...(r.tokens.output_reasoning !== undefined ? { output_reasoning: r.tokens.output_reasoning } : {}),
  };
  const vendor = !r.answer && (r.transport || r.error_status !== undefined || r.cut_off === true);
  const ok = Boolean(r.answer);
  const attempt: AttemptRecord = {
    attempt_number: (packet.retry_count ?? 0) + 1,
    ceiling_used: packet.budget.maxOutputTokens,
    hit_output_cap: r.cut_off === true,
    tokens,
    cost_usd: r.cost_usd,
    latency_ms: r.latency_ms,
    success: ok,
    ...(r.error ? { error: r.error } : {}),
    ...(r.error_status !== undefined ? { error_status: r.error_status } : {}),
    ...(r.retry_after_ms !== undefined ? { retry_after_ms: r.retry_after_ms } : {}),
    // The typist's own reading, stated either way: the loop waits on it alone, as greenfield's runner waits on
    // TypistResult.transport alone, so a status a typist reports without the flag (the agent door, whose SDK already
    // waited) is an attempt in both flows.
    transient: r.transport === true,
    ...(r.transport ? { retry_reason: "transport" as const } : packet.retry_reason ? { retry_reason: packet.retry_reason } : {}),
    ...(r.price_basis ? { price_basis: r.price_basis as any } : {}),
  };
  return {
    result: r.answer,
    tokens,
    cost_usd: r.cost_usd,
    latency_ms: r.latency_ms,
    cache_hit: false,
    success: ok,
    ...(r.error ? { error: r.error } : !ok ? { error: "the typist returned no answer" } : {}),
    attempts: [attempt],
    terminal_reason: ok ? "success" : vendor ? (r.cut_off ? "output_cap_at_model_absolute" : "vendor_error") : r.tokens.output > 0 ? "invalid_answer" : "no_answer",
  };
}
