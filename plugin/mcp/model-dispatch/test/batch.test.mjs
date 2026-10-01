/**
 * runBatch (batch.ts): dependency order, the concurrency cap, one writer per
 * artifact_path at a time, blocking on a failed dependency, cycle refusal.
 * The packet runner is a stub; no model, no disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runBatch, validateBatch, batchPacketsFromArgs, compactBatchReceipt } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "batch.js"));
const silent = () => {};
const pk = (id, over = {}) => ({ id, phase: "codegen", task_type: "x", module: "m", instruction: "", inputs: [], acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "r", artifact_path: `src/${id}.ts`, apply: { write: true }, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A runner that records start/end order and peak concurrency; `fail` names ids that end verify_failed. */
function runner({ delay = 20, fail = [] } = {}) {
  const events = [];
  let running = 0, peak = 0;
  return {
    events, peak: () => peak,
    run: async (p) => {
      running++; peak = Math.max(peak, running); events.push(`start:${p.id}`);
      await sleep(delay);
      running--; events.push(`end:${p.id}`);
      return { status: fail.includes(p.id) ? "verify_failed" : "applied", cost_usd: 0.01, attempts: [{}] };
    },
  };
}

test("independent packets run in parallel up to max_parallel; receipts come back in input order", async () => {
  const r = runner();
  const out = await runBatch({ packets: ["a", "b", "c", "d", "e"].map((id) => pk(id)), maxParallel: 2, run: r.run, log: silent });
  assert.equal(out.status, "applied");
  assert.deepEqual(out.counts, { applied: 5 });
  assert.equal(r.peak(), 2, "never more than max_parallel at once");
  assert.deepEqual(out.items.map((i) => i.id), ["a", "b", "c", "d", "e"]);
  assert.ok(Math.abs(out.cost_usd - 0.05) < 1e-9);
  assert.equal(out.items[0].attempts, 1);
});

test("depends_on is honoured: a dependent starts only after its dependency applied", async () => {
  const r = runner({ delay: 30 });
  const packets = [pk("wire", { depends_on: ["ctrl", "svc"] }), pk("ctrl"), pk("svc"), pk("test", { depends_on: ["wire"] })];
  const out = await runBatch({ packets, maxParallel: 4, run: r.run, log: silent });
  assert.equal(out.status, "applied");
  const idx = (e) => r.events.indexOf(e);
  assert.ok(idx("start:wire") > idx("end:ctrl") && idx("start:wire") > idx("end:svc"));
  assert.ok(idx("start:test") > idx("end:wire"));
  assert.ok(idx("start:svc") < idx("end:ctrl"), "ctrl and svc overlapped");
});

test("two packets on the same artifact_path never run at the same time, even without depends_on", async () => {
  const r = runner({ delay: 30 });
  const packets = [pk("x-a", { artifact_path: "src/index.ts" }), pk("x-b", { artifact_path: "src/index.ts" }), pk("y")];
  const out = await runBatch({ packets, maxParallel: 4, run: r.run, log: silent });
  assert.equal(out.status, "applied");
  const idx = (e) => r.events.indexOf(e);
  assert.ok(idx("start:x-b") > idx("end:x-a"), "second writer waited for the first");
  assert.ok(idx("start:y") < idx("end:x-a"), "an unrelated packet still ran alongside");
});

test("a failed dependency blocks its dependents; unrelated packets still run; status is partial", async () => {
  const r = runner({ fail: ["ctrl"] });
  const packets = [pk("ctrl"), pk("wire", { depends_on: ["ctrl"] }), pk("test", { depends_on: ["wire"] }), pk("other")];
  const out = await runBatch({ packets, maxParallel: 2, run: r.run, log: silent });
  assert.equal(out.status, "partial");
  assert.deepEqual(out.counts, { verify_failed: 1, blocked: 2, applied: 1 });
  const wire = out.items.find((i) => i.id === "wire");
  assert.deepEqual(wire.blocked_by, ["ctrl"]);
  assert.equal(wire.outcome, undefined);
  assert.ok(!r.events.includes("start:wire") && !r.events.includes("start:test"));
});

test("a runner exception becomes an error item and does not stop the batch", async () => {
  const run = async (p) => { if (p.id === "boom") throw new Error("vendor down"); return { status: "applied", cost_usd: 0 }; };
  const out = await runBatch({ packets: [pk("boom"), pk("fine")], maxParallel: 2, run, log: silent });
  assert.equal(out.items[0].status, "error");
  assert.match(out.items[0].error, /vendor down/);
  assert.equal(out.items[1].status, "applied");
});

test("validateBatch refuses duplicate ids and depends_on cycles; ids outside the batch are fine", () => {
  assert.throws(() => validateBatch([pk("a"), pk("a")]), /duplicate packet id a/);
  assert.throws(() => validateBatch([pk("a", { depends_on: ["b"] }), pk("b", { depends_on: ["a"] })]), /cycle: a → b → a/);
  assert.doesNotThrow(() => validateBatch([pk("a", { depends_on: ["ran-earlier"] })]));
});

test("batchPacketsFromArgs reads packets_path (array or {packets}), narrows by packet_ids, skips tooling", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "batch-path-"));
  try {
    const f = join(dir, "packets.json");
    writeFileSync(f, JSON.stringify({ packets: [pk("a"), pk("b"), pk("t", { apply: undefined })] }));
    const all = batchPacketsFromArgs({ packets_path: f });
    assert.deepEqual(all.list.map((p) => p.id), ["a", "b"]);
    assert.deepEqual(all.skipped, ["t"]);
    writeFileSync(f, JSON.stringify([pk("a"), pk("b")]));
    assert.deepEqual(batchPacketsFromArgs({ packets_path: f, packet_ids: ["b"] }).list.map((p) => p.id), ["b"]);
    assert.throws(() => batchPacketsFromArgs({ packets_path: f, packet_ids: ["zz"] }), /packet_ids not in/);
    assert.deepEqual(batchPacketsFromArgs({ packets: [pk("x")] }).list.map((p) => p.id), ["x"]);
    assert.throws(() => batchPacketsFromArgs({}), /pass `packets`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compactBatchReceipt trims applied+verified items, keeps failures and non-routine fields whole", () => {
  const ok = { id: "a", status: "applied", artifact_path: "src/a.ts", cost_usd: 0.01, attempts: 1,
    outcome: { status: "applied", decision: { modelId: "m" }, apply: { lines: 12 }, verify: { ok: true, ran: 2 }, tokens: {}, verify_deferred: ["pnpm typecheck"] } };
  const bad = { id: "b", status: "verify_failed", cost_usd: 0.02, attempts: 2, outcome: { status: "verify_failed", verify: { ok: false, tail: "x" } } };
  const out = compactBatchReceipt({ status: "partial", counts: {}, cost_usd: 0.03, duration_ms: 1, max_parallel: 4, items: [ok, bad] }, ["t"]);
  assert.deepEqual(out.items[0], { id: "a", status: "applied", path: "src/a.ts", lines: 12, cost_usd: 0.01, attempts: 1, verify: { ok: true, ran: 2 }, verify_deferred: ["pnpm typecheck"] });
  assert.deepEqual(out.items[1], bad);
  assert.deepEqual(out.skipped_no_apply, ["t"]);
});
