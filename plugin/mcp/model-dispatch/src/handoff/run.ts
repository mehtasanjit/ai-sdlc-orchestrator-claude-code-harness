/**
 * One hand-off, run (zero-touch hand-off mode): a job goes to the typist the chat's hand-off policy routes it to,
 * its answer is checked by code, and what passes is handed back to be landed.
 *
 * The ladder is the executor's (executor/run.ts), for the same reasons: the routed typist gets two attempts, the
 * second with the reason the first was refused; then the policy's Claude model gets one. A vendor or network
 * failure ("not now") waits and is not an attempt; a pause longer than one rate-limit window is an attempt. Every
 * call is billed, failed ones included, and every call is one telemetry line.
 *
 * Two things differ from a workflow stage. A door that refuses the login or permission (HTTP 401 or 403) does not
 * stop anything: its second attempt is skipped (the same call would be refused the same way), the Claude model
 * writes the job, and the receipt says the routed model failed and why, so the person sees the cost of a broken
 * login instead of paying for it silently. And when every attempt fails, the job is handed back to the chat's own
 * model, which does it by hand.
 *
 * Nothing here writes into the project: the caller lands what `accept` returned (a document is written as it is;
 * tests are run in a scratch copy first).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Phase, TaskPacket, TelemetryEvent } from "../types.js";
import { cacheWriteBuckets } from "../telemetry.js";
import { framedPacket } from "../executor/brief.js";
import { backoffMs } from "../executor/run.js";
import type { Answer, Contract, Typist, TypistResult } from "../executor/typists.js";

/** HTTP statuses of a refused login or permission: the same call would be refused the same way again. */
const LOGIN_REFUSALS = new Set([401, 403]);

export interface HandoffJob {
  /** The job's id on the bill ("doc:docs/setup.md"). */
  id: string;
  /** The file the answer must name, relative to the project folder. */
  path: string;
  /** The policy stage the job is billed as. */
  phase: Phase;
  /** The kind of hand-off work, for the bill ("docs", "spec", "plan", "tests", "repeat"). */
  kind: string;
  contract: Contract;
  /** The block the brief starts with. */
  shared: string;
  /** The job as a packet; `refusal` is why the previous answer was refused. */
  packet(refusal?: string): TaskPacket;
  /**
   * Code's verdict on a well-formed answer: what to land and what was checked, or why it is refused. It may take
   * time (a test file is run in a scratch copy before it is accepted).
   */
  accept(answer: Answer): Verdict | Promise<Verdict>;
}

export type Verdict = { content: string; checked: string[] } | { reason: string };

export interface HandoffDeps {
  /** The typist the chat's policy routes this kind of work to. */
  routed: Typist;
  /** The policy's Claude model, for the last attempt; null when the policy has none. */
  fallback: Typist | null;
  routedAttempts: number;
  transport: { maxWaits: number; baseMs: number; capMs: number };
  policy: { name: string; version: number };
  emit(ev: TelemetryEvent): void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  /**
   * The person stopped the hand-off (the request's own cancel signal): no further attempt or wait starts,
   * a running typist's program is ended, and the outcome says `stopped`.
   */
  signal?: AbortSignal;
}

export interface HandoffOutcome {
  ok: boolean;
  /** What to land, and what code checked in it. */
  content?: string;
  checked?: string[];
  /** The model whose answer passed. */
  written_by?: string;
  /** The model the chat's policy routes this work to (it is `written_by` unless it failed). */
  routed_model: string;
  /** Attempts made (a wait for the vendor is not one). */
  attempts: number;
  calls: number;
  cost_usd: number;
  /** Set when the routed model failed and the Claude model wrote the job. */
  note?: string;
  /** Why the last attempt failed, when none passed. */
  reason?: string;
  /** The person stopped it before it finished (HandoffDeps.signal). */
  stopped?: boolean;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const times = (n: number) => (n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`);
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A reason's headline: a refusal can carry a command's whole output after its first line, which a receipt does not repeat. */
const headline = (s: string) => s.split("\n")[0];

export async function runHandoff(job: HandoffJob, deps: HandoffDeps): Promise<HandoffOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  // The Claude and agent typists read the shared block from a file; it lives for this one hand-off.
  const scratch = mkdtempSync(join(tmpdir(), "mmo-handoff-"));
  const sharedFile = join(scratch, "shared-brief.txt");
  writeFileSync(sharedFile, job.shared);

  const outcome: HandoffOutcome = { ok: false, routed_model: deps.routed.modelName, attempts: 0, calls: 0, cost_usd: 0 };
  const event = (typist: Typist, r: TypistResult, attempt: number, ok: boolean, why: string | undefined, retryReason?: string): TelemetryEvent => ({
    ts: new Date().toISOString(),
    pass: "handoff",
    phase: job.phase,
    task_type: job.kind,
    task_id: job.id,
    module: "handoff",
    model: typist.modelName,
    model_id: typist.modelId,
    routed_by: typist === deps.routed ? "orchestrator" : "fallback",
    provenance: "vendor",
    door: typist.door,
    routing: {
      policy_name: deps.policy.name,
      policy_version: deps.policy.version,
      rule_index: -1,
      rule_reason: typist === deps.routed
        ? `hand-off: the model this chat's policy gives the ${job.phase} stage`
        : "hand-off: the policy's Claude model, after the routed model failed",
    },
    input_tokens: r.tokens.input,
    input_tokens_cached: r.tokens.input_cached,
    ...cacheWriteBuckets(r.tokens),
    output_tokens: r.tokens.output,
    output_tokens_reasoning: r.tokens.output_reasoning,
    cost_usd: r.cost_usd,
    latency_ms: r.latency_ms,
    success: ok,
    attempt_number: attempt,
    retry_count: attempt - 1,
    retry_reason: retryReason,
    error: ok ? undefined : why,
    price_basis: r.price_basis as any,
  } as TelemetryEvent);

  /** One typist call, waiting out transport failures. Every call is billed. */
  async function call(typist: Typist, refusal: string | undefined, attempt: number): Promise<TypistResult> {
    const packet = job.packet(refusal);
    for (let k = 0; ; k++) {
      const t0 = Date.now();
      let r: TypistResult;
      try {
        r = await typist.type({ unit: { id: job.id, path: job.path }, packet, framed: framedPacket(packet), shared: job.shared, sharedFile, contract: job.contract, passId: "handoff", ...(deps.signal ? { signal: deps.signal } : {}) });
      } catch (e: any) {
        // A typist that throws (it cannot be built on this machine, a spawn failure) fails this attempt.
        r = { answer: null, error: `the ${typist.door} typist failed: ${e?.message ?? String(e)}`.slice(0, 300), transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: Date.now() - t0 };
      }
      if (r.transport && r.retry_after_ms !== undefined && r.retry_after_ms > deps.transport.capMs) {
        r = { ...r, transport: false, error: `${r.error ?? "rate limited"} — the vendor asked for a ${Math.round(r.retry_after_ms / 1000)} s pause, longer than one ${Math.round(deps.transport.capMs / 1000)} s rate-limit window` };
      }
      outcome.calls++;
      outcome.cost_usd += r.cost_usd;
      if (r.transport && k < deps.transport.maxWaits && !deps.signal?.aborted) {
        deps.emit(event(typist, r, attempt, false, r.error, "transport"));
        await stoppable(sleep(r.retry_after_ms ?? backoffMs(k, deps.transport.baseMs, deps.transport.capMs, random)), deps.signal);
        if (deps.signal?.aborted) return r;
        continue;
      }
      return r;
    }
  }

  const plan: Typist[] = [...Array.from({ length: deps.routedAttempts }, () => deps.routed), ...(deps.fallback ? [deps.fallback] : [])];
  let refusal: string | undefined;
  let routedFailures = 0;
  let routedWhy = "";
  try {
    for (let i = 0; i < plan.length; i++) {
      // Stopped by the person: no further attempt starts (what was spent so far is on the bill).
      if (deps.signal?.aborted) { outcome.stopped = true; outcome.reason = "stopped before it finished"; break; }
      const typist = plan[i];
      const attempt = ++outcome.attempts;
      const r = await call(typist, refusal, attempt);
      if (deps.signal?.aborted) {
        deps.emit(event(typist, r, attempt, false, "stopped before it finished"));
        outcome.stopped = true;
        outcome.reason = "stopped before it finished";
        break;
      }
      let why = r.error;
      let landed: { content: string; checked: string[] } | null = null;
      if (r.answer) {
        if (r.answer.path !== job.path) why = `the answer names ${r.answer.path}, not ${job.path}`;
        else {
          const verdict = await job.accept(r.answer);
          if ("reason" in verdict) why = verdict.reason;
          else landed = verdict;
        }
      }
      deps.emit(event(typist, r, attempt, !!landed, why, attempt > 1 ? (refusal ? "refused" : "error") : undefined));
      if (landed) {
        outcome.ok = true;
        outcome.content = landed.content;
        outcome.checked = landed.checked;
        outcome.written_by = typist.modelName;
        if (typist !== deps.routed && routedFailures) outcome.note = `${deps.routed.modelName} failed${routedWhy === LOGIN_WORDS ? "" : times(routedFailures)} (${clip(headline(routedWhy))}); done by ${typist.modelName}`;
        break;
      }
      const login = r.error_status !== undefined && LOGIN_REFUSALS.has(r.error_status);
      const reason = login ? LOGIN_WORDS : r.cut_off ? "the answer was cut off at the typist's output limit" : (why ?? "no answer");
      if (typist === deps.routed) { routedFailures++; routedWhy = reason; }
      outcome.reason = reason;
      // The same typist would be refused, or cut off, the same way again: its remaining attempts are skipped.
      if (login || r.cut_off) while (i + 1 < plan.length && plan[i + 1] === typist) i++;
      // The next typist is told why the last answer was refused; a refused login is no fault of the answer.
      refusal = login ? undefined : reason;
    }
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ }
  }
  outcome.cost_usd = round6(outcome.cost_usd);
  if (outcome.ok) delete outcome.reason;
  else if (outcome.reason) outcome.reason = clip(headline(outcome.reason), 300);
  return outcome;
}

const LOGIN_WORDS = "its login or permission was refused";

/** A wait that ends early when the hand-off is stopped. */
function stoppable(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    const stop = () => done();
    signal.addEventListener("abort", stop, { once: true });
    wait.then(() => { signal.removeEventListener("abort", stop); done(); });
  });
}
