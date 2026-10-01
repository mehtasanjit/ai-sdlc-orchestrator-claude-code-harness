/**
 * Batch dispatch — several packets in one `execute_batch` call, run in
 * parallel by the server under a concurrency cap, in dependency order.
 *
 * Why: with one call per packet the orchestrator pays a turn per packet —
 * on the row-8 run 25 turns for 21 packets, $3.21 of a $17 run, every turn
 * re-reading a ~150k-token context. One call for the phase costs the packet
 * list once and the receipts once, and the packets run side by side instead
 * of one after another, which also shortens the waits that expire caches.
 *
 * Ordering: a packet runs when every id in its `depends_on` that is in the
 * batch has finished with status `applied`; a dependency that ends any other
 * way blocks its dependents (`blocked`), which stay for the orchestrator to
 * decide on. Packets that write the same `artifact_path` never run at the
 * same time (chunked edits are also chained by `depends_on`, but a plan can
 * name a file twice without saying so).
 */

import { readFileSync } from "node:fs";
import type { TaskPacket } from "./types.js";

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
}

export interface BatchResult {
  status: "applied" | "partial";
  counts: Record<string, number>;
  cost_usd: number;
  duration_ms: number;
  max_parallel: number;
  items: BatchItemResult[];
}

export interface BatchDeps {
  packets: TaskPacket[];
  maxParallel: number;
  /** Runs one packet to its receipt; throws on a dispatch error the loop did not catch. */
  run: (packet: TaskPacket) => Promise<{ status: string; cost_usd?: number; attempts?: unknown[] } & Record<string, unknown>>;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
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
  const { packets, maxParallel, run, log } = deps;
  validateBatch(packets);
  const started = Date.now();
  const byId = new Map(packets.map((p) => [p.id, p]));
  const done = new Map<string, BatchItemResult>();
  const running = new Set<string>();
  const busyPaths = new Set<string>();
  const pending = [...packets];

  const depsOf = (p: TaskPacket): string[] => (((p as any).depends_on ?? []) as string[]).filter((d) => byId.has(d));
  const ready = (p: TaskPacket) =>
    depsOf(p).every((d) => done.get(d)?.status === "applied") &&
    !(p.artifact_path && busyPaths.has(p.artifact_path));
  const blockedBy = (p: TaskPacket) => depsOf(p).filter((d) => done.has(d) && done.get(d)!.status !== "applied");

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      // Settle packets whose dependency already failed.
      for (const p of [...pending]) {
        const b = blockedBy(p);
        if (b.length) {
          pending.splice(pending.indexOf(p), 1);
          done.set(p.id, { id: p.id, status: "blocked", artifact_path: p.artifact_path, cost_usd: 0, attempts: 0, blocked_by: b });
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
            done.set(next.id, {
              id: next.id,
              status: r.status,
              artifact_path: next.artifact_path,
              cost_usd: Number(r.cost_usd ?? 0),
              attempts: Array.isArray(r.attempts) ? r.attempts.length : 1,
              outcome: r,
            });
          })
          .catch((err: any) => {
            done.set(next.id, { id: next.id, status: "error", artifact_path: next.artifact_path, cost_usd: 0, attempts: 0, error: err?.message ?? String(err) });
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
const ROUTINE_OUTCOME_KEYS = new Set(["status", "decision", "apply", "attempts", "tokens", "cost_usd", "terminal_reason", "events_written"]);

/**
 * The receipt the orchestrator reads, on one line. A packet that applied and
 * verified keeps only what a decision needs (path, lines, cost, attempts,
 * verify, and any non-routine outcome field such as deferred commands);
 * anything else keeps its full outcome. Every figure is already in telemetry.
 */
export function compactBatchReceipt(result: BatchResult, skipped: string[] = []): unknown {
  const items = result.items.map((it) => {
    const o = it.outcome as any;
    if (it.status !== "applied" || !o || o.verify?.ok === false) return it;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!ROUTINE_OUTCOME_KEYS.has(k) && k !== "verify") extra[k] = v;
    return { id: it.id, status: it.status, path: it.artifact_path, lines: o.apply?.lines, cost_usd: it.cost_usd, attempts: it.attempts, verify: o.verify, ...extra };
  });
  return { ...result, items, ...(skipped.length ? { skipped_no_apply: skipped } : {}) };
}
