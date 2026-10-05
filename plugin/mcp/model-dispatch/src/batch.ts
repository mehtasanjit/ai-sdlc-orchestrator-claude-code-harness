/**
 * Batch dispatch — several packets in one `execute_batch` call, run in
 * parallel by the server under a concurrency cap, in dependency order.
 *
 * Why: with one call per packet the orchestrator pays a turn per packet, and
 * every turn re-reads its whole context (measured: 25 turns for 21 packets,
 * $3.21 of a $17 run, at ~150k tokens a turn). One call for the phase costs the packet
 * list once and the receipts once, and the packets run side by side instead
 * of one after another, which also shortens the waits that expire caches.
 *
 * Ordering: a packet runs when every id in its `depends_on` that is in the
 * batch has finished with status `applied`; a dependency that ends any other
 * way blocks its dependents (`blocked`), which stay for the orchestrator to
 * decide on. Packets that write the same `artifact_path` never run at the
 * same time (a plan can name a file twice without saying so).
 */

import { RECEIPT_MAX_BYTES } from "./executor/run.js";
import { HEARTBEAT_MS, type ProgressChannel } from "./executor/tools.js";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
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

export interface BatchItemResult {
  id: string;
  status: string;
  artifact_path?: string;
  cost_usd: number;
  attempts: number;
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
  /** Why the batch stopped starting packets: a vendor refused a call's credentials (401, 403). */
  halted?: string;
  items: BatchItemResult[];
}

export interface BatchDeps {
  packets: TaskPacket[];
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
  // A dependency cycle would wait forever; a reference to an id outside the batch is fine (it ran before).
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

  const depsOf = (p: TaskPacket): string[] => (((p as any).depends_on ?? []) as string[]).filter((d) => byId.has(d));
  const ready = (p: TaskPacket) =>
    depsOf(p).every((d) => done.get(d)?.status === "applied") &&
    !(p.artifact_path && busyPaths.has(p.artifact_path));
  const blockedBy = (p: TaskPacket) => depsOf(p).filter((d) => done.has(d) && done.get(d)!.status !== "applied");

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted || halted) {
        for (const p of pending.splice(0)) {
          settle(p.id, { id: p.id, status: "stopped", artifact_path: p.artifact_path, cost_usd: 0, attempts: 0, ...(halted ? { stopped_reason: halted } : {}) });
          log("info", "batch.stopped", { packet_id: p.id, ...(halted ? { reason: "halt" } : {}) });
        }
      }
      // Settle packets whose dependency already failed.
      for (const p of [...pending]) {
        const b = blockedBy(p);
        if (b.length) {
          pending.splice(pending.indexOf(p), 1);
          settle(p.id, { id: p.id, status: "blocked", artifact_path: p.artifact_path, cost_usd: 0, attempts: 0, blocked_by: b });
          log("warn", "batch.blocked", { packet_id: p.id, blocked_by: b.join(",") });
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
            settle(next.id, {
              id: next.id,
              status: r.status,
              artifact_path: next.artifact_path,
              cost_usd: Number(r.cost_usd ?? 0),
              attempts: Array.isArray(r.attempts) ? r.attempts.length : 1,
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
  return {
    status: items.every((i) => i.status === "applied") ? "applied" : "partial",
    counts,
    cost_usd: items.reduce((a, i) => a + i.cost_usd, 0),
    duration_ms: Date.now() - started,
    max_parallel: maxParallel,
    ...(halted ? { halted } : {}),
    items,
  };
}

/**
 * The packets for one execute_batch call: inline `packets`, or `packets_path`
 * (plan-to-packets output, optionally narrowed by `packet_ids`). Reading the
 * file here keeps ~15k tokens of packets out of the orchestrator's context,
 * where it was read once and then typed back out as tool input (Runs 27b/28).
 * Packets with no apply block (tooling) are skipped and named in the receipt.
 */
export function batchPacketsFromArgs(a: any): { list: unknown[]; skipped: string[] } {
  let list: unknown[];
  if (typeof a?.packets_path === "string" && a.packets_path) {
    const raw = JSON.parse(readFileSync(a.packets_path, "utf-8"));
    list = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : [];
    if (Array.isArray(a.packet_ids) && a.packet_ids.length) {
      const want = new Set<string>(a.packet_ids);
      const found = list.filter((p: any) => want.has(p?.id));
      const missing = [...want].filter((id) => !found.some((p: any) => p.id === id));
      if (missing.length) throw new Error(`execute_batch: packet_ids not in ${a.packets_path}: ${missing.join(", ")}`);
      list = found;
    }
    const skipped = list.filter((p: any) => !p?.apply).map((p: any) => String(p?.id));
    list = list.filter((p: any) => p?.apply);
    if (list.length === 0) throw new Error(`execute_batch: no apply-form packets in ${a.packets_path}`);
    return { list, skipped };
  }
  if (!Array.isArray(a?.packets) || a.packets.length === 0) {
    throw new Error("execute_batch: pass `packets` (a non-empty array of TaskPackets) or `packets_path`.");
  }
  return { list: a.packets, skipped: [] };
}

// Receipt fields that restate the routing and bookkeeping of a packet that went fine.
const ROUTINE_OUTCOME_KEYS = new Set(["status", "decision", "apply", "attempts", "tokens", "cost_usd", "terminal_reason", "events_written", "set_aside"]);
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
 * (path, lines, cost, attempts, verify, and any non-routine outcome field such as deferred commands); one that did not
 * keeps its decision fields and a short reason (failedItem). Over the bound, applied packets are counted instead of
 * listed first (a failure is what the orchestrator acts on), then failures from the end. `fullReceipt` names the
 * file with every outcome whole (the server writes it in the run's folder); every figure is also in telemetry.
 */
export function compactBatchReceipt(result: BatchResult, skipped: string[] = [], opts: { fullReceipt?: string } = {}): unknown {
  const items: Array<Record<string, unknown>> = result.items.map((it) => {
    const o = it.outcome as any;
    if (it.status !== "applied" || !o || o.verify?.ok === false) return failedItem(it);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!ROUTINE_OUTCOME_KEYS.has(k) && k !== "verify") extra[k] = v;
    return { id: it.id, status: it.status, path: it.artifact_path, lines: o.apply?.lines, cost_usd: it.cost_usd, attempts: it.attempts, verify: o.verify, ...extra, ...(setAsideNames(o) ? { set_aside: setAsideNames(o) } : {}) };
  });
  const receipt: Record<string, unknown> = { ...result, items, ...(skipped.length ? { skipped_no_apply: skipped } : {}) };
  const anyFailed = items.some((i) => i.status !== "applied");
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
  while (size() > RECEIPT_MAX_BYTES && dropLast((i) => i.status === "applied", "applied_not_listed")) { /* applied first */ }
  while (size() > RECEIPT_MAX_BYTES && dropLast(() => true, "failed_not_listed")) { /* then failures, from the end */ }
  if (opts.fullReceipt && (receipt.applied_not_listed || receipt.failed_not_listed)) receipt.full_receipt = opts.fullReceipt;
  return receipt;
}
