/**
 * Batch dispatch — several packets in one `execute_batch` call, run in
 * parallel by the server under a concurrency cap, in dependency order.
 *
 * Why: with one call per packet the orchestrator pays a turn per packet, and
 * every turn re-reads its whole context. One call for the phase costs the packet
 * list once and the receipts once, and the packets run side by side instead
 * of one after another, which also shortens the waits that expire caches.
 *
 * Ordering: a packet runs when every id in its `depends_on` that is in the
 * batch has finished applied (`applied`, or `already_applied` by an earlier
 * call of the run); a dependency that ends any other way blocks its dependents
 * (`blocked`), which stay for the orchestrator to decide on. A tooling step of
 * the same plan (the orchestrator's shell step, never the server's) has not run
 * when this call skips it, or leaves it out while it waits for a packet of this
 * call, so it blocks its dependents too, unless a packet of the run applied
 * after it (then it ran). Packets that write the same `artifact_path` never run
 * at the same time (a plan can name a file twice without saying so).
 */

import { RECEIPT_MAX_BYTES } from "./executor/run.js";
import { HEARTBEAT_MS, type ProgressChannel } from "./executor/tools.js";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FileSlice, TaskPacket } from "./types.js";

/** One input's identity across packets: its file, the part of it read, and its text when the caller sent it inline. */
export function inputKey(s: FileSlice): string {
  return JSON.stringify([posix.normalize(s.path.replace(/\\/g, "/")), s.section ?? null, s.lines ?? null, typeof s.content === "string" ? s.content : null]);
}

/**
 * The batch's shared inputs, marked `shared`: those every packet carries, from a file no packet in the batch writes, so
 * the text is the same bytes for every packet whenever it is read. The lean Opus typist sends them as its cached
 * system-prompt tail, greenfield's shared block (executor/brief.ts): the first call writes the cache and every other
 * call reads it (applyTypist.ts). Every other input stays in the packet. Only this rule sets the mark: a caller's is
 * replaced. A batch of one packet shares everything it reads but the file it writes, so its own retries read the cache.
 */
export function markSharedInputs(packets: TaskPacket[]): TaskPacket[] {
  const norm = (p: string) => posix.normalize(p.replace(/\\/g, "/"));
  const written = new Set(packets.flatMap((p) => (typeof p.artifact_path === "string" ? [norm(p.artifact_path)] : [])));
  const carried = new Map<string, number>();
  for (const p of packets) for (const k of new Set(p.inputs.map(inputKey))) carried.set(k, (carried.get(k) ?? 0) + 1);
  return packets.map((p) => ({
    ...p,
    inputs: p.inputs.map((s) => {
      const { shared: _caller, ...rest } = s;
      return carried.get(inputKey(s)) === packets.length && !written.has(norm(s.path)) ? { ...rest, shared: true } : rest;
    }),
  }));
}

// ---------------------------------------------------------------------------
// What a run already applied
// ---------------------------------------------------------------------------

/**
 * Each packet a run applied, one JSON line each, in the run's own folder (`.sdlc/runs/<run_id>/applied.jsonl`). A batch
 * re-sent after an interruption, or for the receipt's "carry on", would otherwise type every packet again: paid twice,
 * an insert edit applied a second time, a replace edit whose search text is gone failing every attempt. A packet whose
 * latest record names the same packet (packetFingerprint) has nothing left to do while its file is still exactly the
 * bytes it left, or the bytes a later packet of the run left on the same file (a second packet on that file, a fix)
 * (alreadyApplied): the server settles it `already_applied`, $0, with no typist call.
 */
export const APPLIED_RECORD = "applied.jsonl";
/** A run id as the workflows write it: a folder name under .sdlc/runs, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AppliedRecord {
  packet_id: string;
  /** packetFingerprint of the packet as it was applied. */
  fingerprint: string;
  /** The file it wrote, relative to the project root. */
  path: string;
  /** SHA-256 of the file's bytes once its checks passed (a check's write form may have rewritten it). */
  sha256: string;
  /** The checks set aside for it (apply.ts baselineChecks), kept so a later receipt still names them. */
  set_aside?: unknown[];
  ts: string;
}

/** JSON with keys in sorted order and undefined values dropped, so equal values always give equal text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * What a packet asks for, as one hash: the packet as planned (`packet`, before the server read its slices), so a
 * packet whose instruction, checks or inputs changed is typed again. An input counts by what it reads (path, lines,
 * section) and by the text the caller sent with it; the text read from disk counts only for the run's own records
 * under `.sdlc/runs/<runId>/` (its briefs, part of the plan), taken from `read`, the packet as read. The text of any
 * other project file is left out: a later packet of the run may edit a file an earlier one read (a bugfix's fix edits
 * the module its reproducing test reads), and the earlier packet is still done. Also left out: the `shared` mark
 * (markSharedInputs sets it from the batch the packet is in) and the packet's own file (an edit carries its file's
 * current text, which its own write changes; alreadyApplied judges that file by its bytes).
 */
export function packetFingerprint(packet: TaskPacket, opts: { runId?: unknown; read?: TaskPacket } = {}): string {
  const norm = (p: string) => posix.normalize(p.replace(/\\/g, "/"));
  const own = typeof packet.artifact_path === "string" ? norm(packet.artifact_path) : null;
  // The run's own folder, compared without case, as the disk the run lives on may ignore it.
  const runDir = typeof opts.runId === "string" && RUN_ID.test(opts.runId) ? `.sdlc/runs/${opts.runId}/`.toLowerCase() : null;
  const inputs = (packet.inputs ?? []).map((s, i) => {
    const { shared: _shared, ...rest } = s;
    const path = typeof s.path === "string" ? norm(s.path) : "";
    if (own !== null && path === own) return { ...rest, content: undefined };
    if (typeof s.content === "string") return rest;
    if (runDir !== null && path.toLowerCase().startsWith(runDir)) return { ...rest, content: opts.read?.inputs?.[i]?.content };
    return rest;
  });
  return createHash("sha256").update(canonical({ ...packet, inputs })).digest("hex");
}

/** SHA-256 of a project file's bytes, or null when it cannot be read. */
export function fileSha256(projectRoot: string, rel: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(projectRoot, rel))).digest("hex"); } catch { return null; }
}

/** The run's applied records in the order they were written ([] with no run id, no record, or an unreadable one). */
export function readAppliedRecords(projectRoot: string, runId: unknown): AppliedRecord[] {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return [];
  let text = "";
  try { text = readFileSync(join(projectRoot, ".sdlc", "runs", runId, APPLIED_RECORD), "utf8"); } catch { return []; }
  const out: AppliedRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.packet_id === "string" && typeof r.fingerprint === "string" && typeof r.path === "string" && typeof r.sha256 === "string") out.push(r);
    } catch { /* a line cut short by a killed process: skipped */ }
  }
  return out;
}

/**
 * The record that shows `packet` already applied in this run, or null: its latest record names the same packet
 * (fingerprint) and file, and the file is now exactly as that packet, or a later packet of the run on the same file,
 * left it. A file changed any other way since is the packet's to type again.
 */
export function alreadyApplied(projectRoot: string, runId: unknown, packet: TaskPacket, fingerprint: string): AppliedRecord | null {
  const recs = readAppliedRecords(projectRoot, runId);
  let mine = -1;
  recs.forEach((r, i) => { if (r.packet_id === packet.id) mine = i; });
  if (mine < 0 || recs[mine].fingerprint !== fingerprint || recs[mine].path !== packet.artifact_path) return null;
  let latest = mine;
  for (let i = mine + 1; i < recs.length; i++) if (recs[i].path === recs[mine].path) latest = i;
  return fileSha256(projectRoot, recs[mine].path) === recs[latest].sha256 ? recs[mine] : null;
}

/** Appends a packet's record to the run's applied record; a record that cannot be written only loses the shortcut. */
export function appendAppliedRecord(projectRoot: string, runId: unknown, rec: AppliedRecord): boolean {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return false;
  try {
    const dir = join(projectRoot, ".sdlc", "runs", runId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, APPLIED_RECORD), JSON.stringify(rec) + "\n");
    return true;
  } catch {
    return false;
  }
}

export interface BatchItemResult {
  id: string;
  status: string;
  artifact_path?: string;
  cost_usd: number;
  /** Attempts a model was asked for: a busy vendor's reply that was waited out is not one (transport_waits). */
  attempts: number;
  /** Busy-vendor replies waited out (apply.ts ApplyOutcome.transport_waits); absent when there were none. */
  transport_waits?: number;
  /** The receipt as execute_with_model would have returned it; absent for `blocked`. */
  outcome?: unknown;
  blocked_by?: string[];
  error?: string;
  /** Set on a packet stopped because another packet's call was refused its credentials (the batch's `halted`). */
  stopped_reason?: string;
}

export interface BatchResult {
  status: "applied" | "partial";
  counts: Record<string, number>;
  cost_usd: number;
  duration_ms: number;
  max_parallel: number;
  /** Busy-vendor replies waited out across the batch, as greenfield's stage receipt counts them; absent when none. */
  transport_waits?: number;
  /** Why the batch stopped starting packets: a vendor refused a call's credentials (401, 403). */
  halted?: string;
  /**
   * The plan's end-of-run checks the batch's packets carry (derivePackets puts them on the last packet; a bugfix's
   * reproducing test comes first), once each in plan order: the orchestrator runs each once after the phase.
   */
  verify_deferred?: string[];
  /**
   * The plan's tooling steps still to run (the orchestrator runs them): those this call skipped, and those it left out
   * that wait for one of its packets, with what each still waits for. A step a packet of the run applied after has
   * run, and is not listed.
   */
  tooling_steps?: ToolingStep[];
  items: BatchItemResult[];
}

/** A tooling step of the plan: the orchestrator's shell step, which the server never runs. */
export interface ToolingStep {
  id: string;
  instruction: string;
  /** Its dependencies in this batch that did not apply: the step waits for them. */
  blocked_by?: string[];
}

/** Statuses that leave the packet's file written and checked: a dependent may start. */
const SATISFIED = new Set(["applied", "already_applied"]);

/** A tooling packet of the plan, as the batch keeps it: its shell step, what it waits for, its end-of-run checks. */
export interface ToolingPacket { id: string; instruction?: string; depends_on?: string[]; verify_deferred?: string[] }

/** One packet of the plan's packets file, as the batch reads the plan: its id, what it waits for, whether it is a tooling step. */
export interface PlanEntry extends ToolingPacket { tooling: boolean }

export interface BatchDeps {
  packets: TaskPacket[];
  /**
   * The plan's tooling packets this call skipped (batchPacketsFromArgs): they have not run, so a packet that depends
   * on one cannot start in this call and is blocked by it.
   */
  tooling?: ToolingPacket[];
  /**
   * Every packet of the packets file the call read (batchPacketsFromArgs), for the tooling steps the call left out
   * (packet_ids): such a step has not run when it waits, through the plan, for a packet of this call.
   */
  plan?: PlanEntry[];
  /**
   * Whether the run already applied this packet as planned now (server.ts: its record in the run's applied record).
   * The orchestrator sends a tooling step's dependents only after it ran the step, so a step one of whose dependents
   * in this call the run applied has run: it blocks nothing and is not asked for again.
   */
  appliedBefore?: (packet: TaskPacket) => boolean;
  maxParallel: number;
  /** Runs one packet to its receipt; throws on a dispatch error the loop did not catch. */
  run: (packet: TaskPacket) => Promise<{ status: string; cost_usd?: number; attempts?: unknown[] } & Record<string, unknown>>;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  /** The request's own cancel signal: once the person stops the call, no packet starts and the waiting ones end "stopped". */
  signal?: AbortSignal;
  /** Called as each packet settles (any status), with how many have settled: the call's progress (batchProgress). */
  onSettled?: (item: BatchItemResult, done: number, total: number) => void;
}
// A packet's outcome may carry `halt` (apply.ts: the vendor refused the call's credentials). Every other packet would
// fail the same way, so no packet starts after it, and the waiting ones end "stopped" with that reason.

/**
 * The batch's progress on the request's channel, as greenfield's stage call sends it (executor/tools.ts): one message
 * per settled packet and a heartbeat every HEARTBEAT_MS between them, because Claude Code aborts an MCP call that
 * stays silent past its idle limit and a batch of slow typists can run that long. Nothing is sent when the caller
 * asked for no progress (no token). Await stop() when the batch ends: it waits for the messages still being sent, so
 * the call's answer never overtakes its last progress message (a client stops listening once the answer arrives).
 */
export function batchProgress(progress: ProgressChannel | undefined, total: number, heartbeatMs = HEARTBEAT_MS) {
  const token = progress?.token;
  let done = 0;
  const pending = new Set<Promise<void>>();
  const say = (message: string) => {
    if (token === undefined) return;
    const p: Promise<void> = progress!.send({ progressToken: token, progress: done, total, message }).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  };
  const timer = token !== undefined ? setInterval(() => say(`still typing: ${done} of ${total} packets settled`), heartbeatMs) : null;
  return {
    settled(item: { id: string; status: string }, n: number, _total?: number) {
      done = n;
      say(`${item.id} ${item.status} (${n} of ${total})`);
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      await Promise.all([...pending]);
    },
  };
}

export function validateBatch(packets: TaskPacket[]): void {
  const ids = new Set<string>();
  for (const p of packets) {
    if (ids.has(p.id)) throw new Error(`execute_batch: duplicate packet id ${p.id}`);
    ids.add(p.id);
  }
  // A dependency cycle would wait forever. A reference to an id outside the batch is fine here: it ran before, or it
  // is a tooling step that has not run, which runBatch blocks on (stillToRun).
  const state = new Map<string, number>(); // 0 unvisited, 1 visiting, 2 done
  const byId = new Map(packets.map((p) => [p.id, p]));
  const visit = (id: string, trail: string[]) => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) throw new Error(`execute_batch: depends_on cycle: ${[...trail, id].join(" → ")}`);
    state.set(id, 1);
    for (const d of ((byId.get(id) as any)?.depends_on ?? []) as string[]) if (byId.has(d)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const p of packets) visit(p.id, []);
}

/**
 * The plan's tooling steps that have not run when this call starts: every step the call skipped, then every step it
 * left out (packet_ids) that a packet of the call waits for and that itself waits, through the plan's packets, for a
 * packet of the call (it cannot have run before a packet that is only now being typed), each in plan order. A step the
 * run applied a dependent of after it (appliedBefore) has run, and is not one of them.
 */
export function stillToRun(packets: TaskPacket[], skipped: ToolingPacket[], plan: PlanEntry[], appliedBefore?: (p: TaskPacket) => boolean): ToolingPacket[] {
  const inCall = new Set(packets.map((p) => p.id));
  const planById = new Map(plan.map((e) => [e.id, e]));
  const skippedIds = new Set(skipped.map((t) => t.id));
  const waitedFor = new Set(packets.flatMap((p) => ((p as any).depends_on ?? []) as string[]));
  // Whether `id` waits, through the plan, for a packet of this call.
  const reachesCall = (id: string, seen = new Set<string>()): boolean => {
    for (const d of planById.get(id)?.depends_on ?? []) {
      if (inCall.has(d)) return true;
      if (seen.has(d)) continue;
      seen.add(d);
      if (reachesCall(d, seen)) return true;
    }
    return false;
  };
  const leftOut = plan.filter((e) => e.tooling && !inCall.has(e.id) && !skippedIds.has(e.id) && waitedFor.has(e.id) && reachesCall(e.id));
  const ran = (step: ToolingPacket) => Boolean(appliedBefore) && packets.some((p) => (((p as any).depends_on ?? []) as string[]).includes(step.id) && appliedBefore!(p));
  return [...skipped, ...leftOut.map(({ tooling: _t, ...step }) => step)].filter((t) => !ran(t));
}

export async function runBatch(deps: BatchDeps): Promise<BatchResult> {
  const { packets, maxParallel, run, log, signal } = deps;
  validateBatch(packets);
  const started = Date.now();
  const byId = new Map(packets.map((p) => [p.id, p]));
  const done = new Map<string, BatchItemResult>();
  const settle = (id: string, item: BatchItemResult) => {
    done.set(id, item);
    deps.onSettled?.(item, done.size, packets.length);
  };
  const running = new Set<string>();
  const busyPaths = new Set<string>();
  const pending = [...packets];
  let halted: string | null = null;
  // The tooling steps that have not run (stillToRun): a dependency on one is never met in this call. Any other id
  // outside the batch ran before it (the caller narrowed the batch with packet_ids around it).
  const pendingSteps = stillToRun(packets, deps.tooling ?? [], deps.plan ?? [], deps.appliedBefore);
  const notRun = new Set(pendingSteps.map((t) => t.id));

  const depsOf = (p: TaskPacket): string[] => (((p as any).depends_on ?? []) as string[]).filter((d) => byId.has(d) || notRun.has(d));
  const ready = (p: TaskPacket) =>
    depsOf(p).every((d) => SATISFIED.has(done.get(d)?.status ?? "")) &&
    !(p.artifact_path && busyPaths.has(p.artifact_path));
  const blockedBy = (p: TaskPacket) => depsOf(p).filter((d) => notRun.has(d) || (done.has(d) && !SATISFIED.has(done.get(d)!.status)));

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted || halted) {
        for (const p of pending.splice(0)) {
          settle(p.id, { id: p.id, status: "stopped", artifact_path: p.artifact_path, cost_usd: 0, attempts: 0, ...(halted ? { stopped_reason: halted } : {}) });
          log("info", "batch.stopped", { packet_id: p.id, ...(halted ? { reason: "halt" } : {}) });
        }
      }
      // Settle packets whose dependency already failed, until none is left to settle: a packet listed before its
      // dependency is only blocked once that dependency is, and with nothing running no later event would call tick.
      for (let settled = true; settled; ) {
        settled = false;
        for (const p of [...pending]) {
          const b = blockedBy(p);
          if (b.length) {
            pending.splice(pending.indexOf(p), 1);
            settle(p.id, { id: p.id, status: "blocked", artifact_path: p.artifact_path, cost_usd: 0, attempts: 0, blocked_by: b });
            log("warn", "batch.blocked", { packet_id: p.id, blocked_by: b.join(",") });
            settled = true;
          }
        }
      }
      while (running.size < maxParallel) {
        const next = pending.find(ready);
        if (!next) break;
        pending.splice(pending.indexOf(next), 1);
        running.add(next.id);
        if (next.artifact_path) busyPaths.add(next.artifact_path);
        log("info", "batch.start", { packet_id: next.id, running: running.size });
        run(next)
          .then((r) => {
            if (typeof r.halt === "string" && r.halt && !halted) halted = r.halt;
            // A busy vendor's reply that was waited out is no attempt: the apply loop lists attempts only and counts
            // its waits apart (apply.ts ApplyOutcome.transport_waits), as greenfield's stage receipt counts calls and
            // transport_waits.
            const waits = typeof r.transport_waits === "number" && r.transport_waits > 0 ? r.transport_waits : 0;
            settle(next.id, {
              id: next.id,
              status: r.status,
              artifact_path: next.artifact_path,
              cost_usd: Number(r.cost_usd ?? 0),
              attempts: Array.isArray(r.attempts) ? r.attempts.length : 1,
              ...(waits ? { transport_waits: waits } : {}),
              outcome: r,
            });
          })
          .catch((err: any) => {
            settle(next.id, { id: next.id, status: "error", artifact_path: next.artifact_path, cost_usd: 0, attempts: 0, error: err?.message ?? String(err) });
            log("warn", "batch.error", { packet_id: next.id, message: err?.message ?? String(err) });
          })
          .finally(() => {
            running.delete(next.id);
            if (next.artifact_path) busyPaths.delete(next.artifact_path);
            log("info", "batch.end", { packet_id: next.id, status: done.get(next.id)?.status });
            tick();
          });
      }
      if (running.size === 0 && pending.length === 0) resolve();
      else if (running.size === 0 && pending.length > 0 && !pending.some(ready) && pending.every((p) => blockedBy(p).length === 0)) {
        reject(new Error(`execute_batch: ${pending.length} packet(s) can never start: ${pending.map((p) => p.id).join(", ")}`));
      }
    };
    tick();
  });

  const items = packets.map((p) => done.get(p.id)!);
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  const transportWaits = items.reduce((a, i) => a + (i.transport_waits ?? 0), 0);
  // The end-of-run checks ride on the plan's last packet (change-spec.mjs derivePackets), whatever it ends as: they
  // reach the orchestrator here, since it never reads packets.json whole.
  const deferred = [...new Set([...packets, ...(deps.tooling ?? [])].flatMap((p: any) => (Array.isArray(p.verify_deferred) ? p.verify_deferred.map(String) : [])))];
  const tooling = pendingSteps.map((t): ToolingStep => {
    const waits = (t.depends_on ?? []).filter((d) => byId.has(d) && !SATISFIED.has(done.get(d)?.status ?? ""));
    return { id: t.id, instruction: String(t.instruction ?? ""), ...(waits.length ? { blocked_by: waits } : {}) };
  });
  return {
    status: items.every((i) => SATISFIED.has(i.status)) ? "applied" : "partial",
    counts,
    cost_usd: items.reduce((a, i) => a + i.cost_usd, 0),
    duration_ms: Date.now() - started,
    max_parallel: maxParallel,
    ...(transportWaits ? { transport_waits: transportWaits } : {}),
    ...(halted ? { halted } : {}),
    ...(deferred.length ? { verify_deferred: deferred } : {}),
    ...(tooling.length ? { tooling_steps: tooling } : {}),
    items,
  };
}

/**
 * The packets for one execute_batch call: inline `packets`, or `packets_path`
 * (plan-to-packets output, optionally narrowed by `packet_ids`). Reading the
 * file here keeps the packets out of the orchestrator's context, where they
 * would be read once and then typed back out as tool input.
 * Packets with no apply block (tooling) are skipped and named in the receipt;
 * `tooling` holds them whole, so the batch blocks what waits for them. `plan`
 * is every packet of the file, so the batch can tell whether a tooling step the
 * call left out has run (stillToRun).
 */
export function batchPacketsFromArgs(a: any): { list: unknown[]; skipped: string[]; tooling: ToolingPacket[]; plan: PlanEntry[] } {
  let list: unknown[];
  if (typeof a?.packets_path === "string" && a.packets_path) {
    const raw = JSON.parse(readFileSync(a.packets_path, "utf-8"));
    list = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : [];
    const asStep = (p: any): ToolingPacket => ({
      id: String(p?.id),
      ...(typeof p?.instruction === "string" ? { instruction: p.instruction } : {}),
      ...(Array.isArray(p?.depends_on) ? { depends_on: p.depends_on.map(String) } : {}),
      ...(Array.isArray(p?.verify_deferred) ? { verify_deferred: p.verify_deferred.map(String) } : {}),
    });
    const plan: PlanEntry[] = list.map((p: any) => ({ ...asStep(p), tooling: !p?.apply }));
    if (Array.isArray(a.packet_ids) && a.packet_ids.length) {
      const want = new Set<string>(a.packet_ids);
      const found = list.filter((p: any) => want.has(p?.id));
      const missing = [...want].filter((id) => !found.some((p: any) => p.id === id));
      if (missing.length) throw new Error(`execute_batch: packet_ids not in ${a.packets_path}: ${missing.join(", ")}`);
      list = found;
    }
    const tooling = list.filter((p: any) => !p?.apply).map(asStep);
    list = list.filter((p: any) => p?.apply);
    if (list.length === 0) throw new Error(`execute_batch: no apply-form packets in ${a.packets_path}`);
    return { list, skipped: tooling.map((t) => t.id), tooling, plan };
  }
  if (!Array.isArray(a?.packets) || a.packets.length === 0) {
    throw new Error("execute_batch: pass `packets` (a non-empty array of TaskPackets) or `packets_path`.");
  }
  return { list: a.packets, skipped: [], tooling: [], plan: [] };
}

// Receipt fields that restate the routing and bookkeeping of a packet that went fine.
const ROUTINE_OUTCOME_KEYS = new Set(["status", "decision", "apply", "attempts", "transport_waits", "tokens", "cost_usd", "terminal_reason", "events_written", "set_aside"]);
/** The checks set aside for a packet (apply.ts baselineChecks), by id: their output stays in the full receipt file. */
const setAsideNames = (o: any): string[] | undefined =>
  Array.isArray(o?.set_aside) && o.set_aside.length ? o.set_aside.map((c: any) => String(c?.id ?? c?.run)) : undefined;
/** A failed packet's reason in the receipt: greenfield's length for the same field (executor/run.ts receipt.failed). */
const REASON_CHARS = 160;

/** What the orchestrator decides on for a packet that did not apply: the status, a short reason, the target, the cause. */
function failedItem(it: BatchItemResult): Record<string, unknown> {
  const o = (it.outcome ?? {}) as any;
  const attempts = Array.isArray(o.attempts) ? o.attempts : [];
  const why = o.escalate?.failure ?? attempts[attempts.length - 1]?.failure ?? o.refusal ?? o.halt ?? it.error ?? it.stopped_reason;
  return {
    id: it.id,
    status: it.status,
    ...(it.artifact_path ? { path: it.artifact_path } : {}),
    cost_usd: it.cost_usd,
    attempts: it.attempts,
    ...(it.transport_waits ? { transport_waits: it.transport_waits } : {}),
    ...(typeof why === "string" && why ? { reason: why.slice(0, REASON_CHARS) } : {}),
    ...(o.escalate ? { escalate: { retry_count: o.escalate.retry_count, model_id: o.escalate.model_id } } : {}),
    ...(it.blocked_by ? { blocked_by: it.blocked_by } : {}),
    ...(it.stopped_reason ? { stopped_reason: it.stopped_reason } : {}),
    ...(setAsideNames(o) ? { set_aside: setAsideNames(o) } : {}),
  };
}

/**
 * The receipt the orchestrator reads, on one line, within greenfield's stated bound (RECEIPT_MAX_BYTES): the
 * orchestrator re-reads it on every later turn. A packet that applied and verified keeps only what a decision needs
 * (path, lines, cost, attempts, busy-vendor waits, verify, and any non-routine outcome field); one an earlier call
 * already applied keeps its path and $0; one that did not apply keeps its decision fields and a short reason
 * (failedItem). The batch's end-of-run checks (`verify_deferred`) and the tooling steps it skipped (`tooling_steps`,
 * each with its shell step) are on the receipt itself. Over the bound, applied packets are counted instead of listed
 * first (a failure is what the orchestrator acts on), then failures from the end. `fullReceipt` names the file with
 * every outcome whole (the server writes it in the run's folder); every figure is also in telemetry.
 */
export function compactBatchReceipt(result: BatchResult, skipped: string[] = [], opts: { fullReceipt?: string } = {}): unknown {
  const items: Array<Record<string, unknown>> = result.items.map((it) => {
    const o = it.outcome as any;
    if (it.status === "already_applied") {
      return { id: it.id, status: it.status, ...(it.artifact_path ? { path: it.artifact_path } : {}), cost_usd: it.cost_usd, attempts: it.attempts, ...(setAsideNames(o) ? { set_aside: setAsideNames(o) } : {}) };
    }
    if (it.status !== "applied" || !o || o.verify?.ok === false) return failedItem(it);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!ROUTINE_OUTCOME_KEYS.has(k) && k !== "verify") extra[k] = v;
    return { id: it.id, status: it.status, path: it.artifact_path, lines: o.apply?.lines, cost_usd: it.cost_usd, attempts: it.attempts, ...(it.transport_waits ? { transport_waits: it.transport_waits } : {}), verify: o.verify, ...extra, ...(setAsideNames(o) ? { set_aside: setAsideNames(o) } : {}) };
  });
  const receipt: Record<string, unknown> = { ...result, items, ...(skipped.length ? { skipped_no_apply: skipped } : {}) };
  const anyFailed = items.some((i) => !SATISFIED.has(String(i.status)));
  if (opts.fullReceipt && anyFailed) receipt.full_receipt = opts.fullReceipt;
  const size = () => JSON.stringify(receipt).length;
  const dropLast = (pred: (i: Record<string, unknown>) => boolean, counter: string) => {
    for (let k = items.length - 1; k >= 0; k--) {
      if (!pred(items[k])) continue;
      items.splice(k, 1);
      receipt[counter] = ((receipt[counter] as number) ?? 0) + 1;
      return true;
    }
    return false;
  };
  while (size() > RECEIPT_MAX_BYTES && dropLast((i) => SATISFIED.has(String(i.status)), "applied_not_listed")) { /* applied first */ }
  while (size() > RECEIPT_MAX_BYTES && dropLast(() => true, "failed_not_listed")) { /* then failures, from the end */ }
  if (opts.fullReceipt && (receipt.applied_not_listed || receipt.failed_not_listed)) receipt.full_receipt = opts.fullReceipt;
  return receipt;
}
