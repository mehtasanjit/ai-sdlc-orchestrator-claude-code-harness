/**
 * The Antigravity doors' call limits, in one table: how long a Gemini call may go without receiving anything before
 * the worker cuts it and sends it again, how many tries it gets against stalls and how long against refusals, the
 * worker's heartbeat, the engine's kill rule that reads it, and how long a run waits on a model Google serves nothing
 * of before it stops. The worker enforces the call limits itself (worker/agy_supervisor.py); the engine only passes
 * them and, as a backstop, kills a worker whose heartbeat stopped or that failed to keep its own limits.
 *
 * A measured change to a default is one line here and one value in test/stallSettings.test.mjs.
 */
import type { ChildProcess } from "node:child_process";
import type { ModelConfig } from "../types.js";

/**
 * Seconds of silence a call may have before it is cut, by model, when the leaf sets no `stall_sec`. They clear
 * Google's own healthy maxima with margin (14 days of the project's latency and first-token distributions): at `us`
 * and `eu` no Flash call of 50-10,000 output tokens took more than 117 s end to end, and large typist answers stream
 * at 56-190 tokens/s; no Argon call at `us` took more than 202 s, and Argon's `global` first-token p99.9 is 349 s. A
 * function-call answer arrives whole, so its silence is first-token time plus the whole generation; the second try's
 * doubled room covers the longest call recorded (502 s).
 */
export const STALL_SEC_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
  "gemini-3.8-flash": 180,
  "gemini-3.7-flash": 180,
  "gemini-3.5-flash": 180,
  "gemini-3.5-flash-lite": 180,
  "gemini-4-argon": 300,
});
/** A model with no data gets the safe direction: fewer cuts. */
export const STALL_SEC_UNLISTED = 300;
/** Tries per model call against stalls: `stall_sec`, then twice that. */
export const STALL_TRIES = 2;
/**
 * How long a call may keep meeting refusals across its tries before it is `unavailable`: the sum of the executor's
 * transport waits (2 + 4 + 8 + 16 + 32 + 60 s), so a call waits as long here as on the other doors.
 */
export const BUSY_BUDGET_SEC = 120;
/** The harness's own retry per location when a leaf lists failover_locations: a refusing location gives up in seconds. */
export const FAILOVER_API_RETRY = { retries: 1, initialMs: 1_000 } as const;
/**
 * The harness's own retry on the agent door without failover: the executor's transport rule (executor/tools.ts
 * TRANSPORT: 6 waits from 2 s, doubling), which the agent typist already passed, in place of the SDK's unstated
 * default.
 */
export const AGENT_API_RETRY = { retries: 6, initialMs: 2_000 } as const;
/** The worker's heartbeat interval, on its own clock. */
export const HEARTBEAT_SEC = 10;
/**
 * The engine's kill rule (HeartbeatBackstop): kill only when two checks at least `confirmS` apart both find no
 * heartbeat for `noBeatS` (Node's clock counts the Mac's sleep, the worker's does not, so one stale finding at wake
 * is not enough), or when the last heartbeat reports work or a call's wait beyond its bound by more than `overrunS`
 * (a worker that failed to keep its own limits). SIGTERM first, so the worker writes its receipt; SIGKILL `termGraceS`
 * later.
 */
export const BACKSTOP = Object.freeze({ noBeatS: 60, confirmS: 20, termGraceS: 10, overrunS: 60 });
/**
 * How long a run waits on a model Google serves nothing of: a batch, a stage or the agent door stops on a model only
 * when none of its calls in the run was served for this window while they kept coming back `unavailable`
 * (busyLedger.ts).
 */
export const BUSY_WINDOW_SEC = 300;

/** The stall limit of a leaf's calls: its `stall_sec`, else its model's default. */
export function stallSecFor(leaf: Pick<ModelConfig, "model_name" | "stall_sec">): number {
  if (typeof leaf.stall_sec === "number") return leaf.stall_sec;
  return STALL_SEC_DEFAULTS[leaf.model_name] ?? STALL_SEC_UNLISTED;
}

/** The harness's own retry of a refused request (ModelAPIRetryConfig): how many retries, and its first wait. */
export interface ApiRetry { retries: number; initialMs: number }

/**
 * The most the harness's own retries add to one try of a call: its wait before each retry (the first wait, doubling)
 * and, once its last retry is out, that wait doubled once more, which the worker allows a held retry before it reads
 * the silence as a stall (worker/agy_supervisor.py retry_wait_after): first wait x (2^(retries+1) - 1), 254 s for six
 * retries from 2 s, 3 s for the failover rule. With no retries nothing is waited.
 */
export function harnessRetryWaitSec(retry: ApiRetry): number {
  return retry.retries > 0 ? (retry.initialMs / 1000) * (2 ** (retry.retries + 1) - 1) : 0;
}

/**
 * The most one model call may wait on Google while its worker keeps its own rules: every stall try (stall_sec, then
 * twice that), the busy budget, and on each try the harness's own retry waits (a try may meet every retry's refusal
 * and then be held). Past it, plus BACKSTOP.overrunS, the backstop kills a worker whose heartbeat says it is still
 * waiting. The defaults are the agent door's: its stall tries, its retry rule and the busy budget.
 */
export function callWaitBoundSec(stallSec: number, o: { tries?: number; retry?: ApiRetry; busyBudgetSec?: number } = {}): number {
  const tries = o.tries ?? STALL_TRIES;
  let stalls = 0;
  for (let k = 0; k < tries; k++) stalls += stallSec * 2 ** k;
  return stalls + (o.busyBudgetSec ?? BUSY_BUDGET_SEC) + tries * harnessRetryWaitSec(o.retry ?? AGENT_API_RETRY);
}

/** One heartbeat line of the worker contract (worker/agy_supervisor.py). */
export interface Heartbeat {
  v: number;
  state: string;
  work_s: number;
  wait_s: number;
  call_wait_s: number;
  slept_s?: number | null;
  try: number;
  location: string;
  usage: Record<string, Record<string, number | null | undefined>>;
  sdk_version?: string;
}

export const HEARTBEAT_PREFIX = "@mmo-heartbeat ";

/** A worker's stderr line as a heartbeat, or null for any other line or one cut short. */
export function parseHeartbeat(line: string): Heartbeat | null {
  const s = line.trim();
  if (!s.startsWith(HEARTBEAT_PREFIX.trim())) return null;
  try {
    const hb = JSON.parse(s.slice(HEARTBEAT_PREFIX.trim().length).trim());
    return hb && typeof hb === "object" && hb.v === 1 ? (hb as Heartbeat) : null;
  } catch {
    return null;
  }
}

/** A worker's stderr without its heartbeat lines: the text error messages quote. */
export function withoutHeartbeats(text: string): string {
  return text.split("\n").filter((l) => !l.trim().startsWith(HEARTBEAT_PREFIX.trim())).join("\n");
}

/**
 * The engine's kill rule for one Antigravity worker, on the caller's clock (milliseconds). `check(at)` says why to
 * kill the worker now, or null.
 */
export class HeartbeatBackstop {
  private lastBeatAt: number;
  private last: Heartbeat | null = null;
  private firstFinding: number | null = null;
  private readonly noBeatMs: number;
  private readonly confirmMs: number;
  private readonly overrunS: number;
  private readonly workLimitS: number;
  private readonly waitBoundS: number;

  constructor(o: { startedAtMs: number; workLimitS: number; waitBoundS: number; noBeatS?: number; confirmS?: number; overrunS?: number }) {
    this.lastBeatAt = o.startedAtMs;
    this.workLimitS = o.workLimitS;
    this.waitBoundS = o.waitBoundS;
    this.noBeatMs = (o.noBeatS ?? BACKSTOP.noBeatS) * 1000;
    this.confirmMs = (o.confirmS ?? BACKSTOP.confirmS) * 1000;
    this.overrunS = o.overrunS ?? BACKSTOP.overrunS;
  }

  beat(hb: Heartbeat, atMs: number): void {
    this.last = hb;
    this.lastBeatAt = atMs;
    this.firstFinding = null;
  }

  /** The last heartbeat the worker sent, or null. */
  get lastBeat(): Heartbeat | null {
    return this.last;
  }

  check(atMs: number): string | null {
    const hb = this.last;
    if (hb && typeof hb.work_s === "number" && hb.work_s > this.workLimitS + this.overrunS) {
      return `the worker's heartbeat reports ${Math.round(hb.work_s)} s of work, past its ${this.workLimitS} s limit`;
    }
    if (hb && typeof hb.call_wait_s === "number" && hb.call_wait_s > this.waitBoundS + this.overrunS) {
      return `the worker's heartbeat reports a call waiting ${Math.round(hb.call_wait_s)} s, past the ${this.waitBoundS} s one call may wait`;
    }
    if (atMs - this.lastBeatAt < this.noBeatMs) {
      this.firstFinding = null;
      return null;
    }
    if (this.firstFinding === null) {
      this.firstFinding = atMs;
      return null;
    }
    if (atMs - this.firstFinding < this.confirmMs) return null;
    return `the worker sent no heartbeat for ${Math.round((atMs - this.lastBeatAt) / 1000)} s`;
  }
}

/** Shorter kill-rule thresholds, for tests that cannot wait out the real ones. */
export type BackstopOptions = Partial<typeof BACKSTOP>;

/** Why a worker's group was stopped when the request itself was cancelled (the person pressed Stop). */
export const STOPPED_BY_REQUEST = "stopped: the call was cancelled";

/**
 * One worker process group under the kill rule: reads its heartbeat lines from stderr, checks the rule on an interval,
 * and stops the group when it says so, or when `stop()` is called (the person pressed Stop): SIGTERM first, so the
 * worker writes its receipt, then SIGKILL `termGraceS` later, which also takes any process the worker left in its group
 * holding its output open. Call `closed()` when the child's streams have closed.
 */
export function watchWorker(child: ChildProcess, o: { workLimitS: number; waitBoundS: number; backstop?: BackstopOptions }) {
  const rule = new HeartbeatBackstop({ startedAtMs: Date.now(), workLimitS: o.workLimitS, waitBoundS: o.waitBoundS, ...o.backstop });
  const confirmS = o.backstop?.confirmS ?? BACKSTOP.confirmS;
  const termGraceMs = (o.backstop?.termGraceS ?? BACKSTOP.termGraceS) * 1000;
  let buf = "";
  let reason: string | null = null;
  let done = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  child.stderr?.on("data", (d) => {
    buf += String(d);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const hb = parseHeartbeat(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (hb) rule.beat(hb, Date.now());
    }
  });
  const group = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
  const stop = (why: string) => {
    if (reason !== null || done) return;
    reason = why;
    group("SIGTERM");
    killTimer = setTimeout(() => group("SIGKILL"), termGraceMs);
  };
  // A quarter of the confirmation window, so the two findings are confirmS apart give or take one interval.
  const interval = setInterval(() => {
    if (reason !== null || done) return;
    const why = rule.check(Date.now());
    if (why) stop(why);
  }, Math.max(250, Math.min(5_000, confirmS * 250)));
  return {
    stop,
    closed(): void {
      done = true;
      clearInterval(interval);
      if (killTimer) clearTimeout(killTimer);
    },
    /** Why the group was stopped, or null. */
    get reason(): string | null { return reason; },
    get lastBeat(): Heartbeat | null { return rule.lastBeat; },
  };
}
