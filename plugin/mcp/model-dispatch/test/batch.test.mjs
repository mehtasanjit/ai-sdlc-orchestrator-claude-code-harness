/**
 * runBatch (batch.ts): dependency order, the concurrency cap, one writer per
 * artifact_path at a time, blocking on a failed dependency, cycle refusal.
 * The packet runner is a stub; no model, no disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runBatch, validateBatch, batchPacketsFromArgs, compactBatchReceipt, markSharedInputs, batchProgress } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "batch.js"));
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

test("stopped by the person mid-batch: no packet starts after the stop, the waiting ones are reported stopped, the running one ends", async () => {
  const stop = new AbortController();
  const r = runner({ delay: 20 });
  const run = async (p) => { const out = await r.run(p); if (p.id === "a") stop.abort(); return out; };
  const out = await runBatch({ packets: ["a", "b", "c"].map((id) => pk(id)), maxParallel: 1, run, log: silent, signal: stop.signal });
  assert.deepEqual(out.items.map((i) => [i.id, i.status]), [["a", "applied"], ["b", "stopped"], ["c", "stopped"]]);
  assert.ok(!r.events.includes("start:b") && !r.events.includes("start:c"), "nothing started after the stop");
  assert.equal(out.status, "partial");
});

test("a packet whose door refused its credentials halts the batch: nothing more starts, the rest are stopped with the reason", async () => {
  const r = runner({ delay: 5 });
  const halt = "the flash call was refused with HTTP 401 (its login or permission is broken); the batch stopped here";
  const run = async (p) => (p.id === "a" ? { status: "dispatch_failed", cost_usd: 0, attempts: [{}], halt } : r.run(p));
  const out = await runBatch({ packets: ["a", "b", "c"].map((id) => pk(id)), maxParallel: 1, run, log: silent });
  assert.deepEqual(out.items.map((i) => [i.id, i.status]), [["a", "dispatch_failed"], ["b", "stopped"], ["c", "stopped"]]);
  assert.equal(out.halted, halt);
  assert.equal(out.items[1].stopped_reason, halt);
  assert.ok(!r.events.includes("start:b"), "nothing started after the halt");
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

// The outcome here has the keys the server's apply loop returns (apply.ts ApplyOutcome): the end-of-run checks are not
// an outcome field, they come from the packets and sit on the batch result (runBatch verify_deferred, batchSettle.test).
test("compactBatchReceipt trims applied+verified items, keeps failures and the batch's end-of-run checks", () => {
  const ok = { id: "a", status: "applied", artifact_path: "src/a.ts", cost_usd: 0.01, attempts: 1,
    outcome: { status: "applied", decision: { modelId: "m" }, apply: { lines: 12 }, verify: { ok: true, ran: 2 }, attempts: [{}], tokens: {}, cost_usd: 0.01, events_written: 1 } };
  const bad = { id: "b", status: "verify_failed", cost_usd: 0.02, attempts: 2, outcome: { status: "verify_failed", verify: { ok: false, tail: "x" } } };
  const out = compactBatchReceipt({ status: "partial", counts: {}, cost_usd: 0.03, duration_ms: 1, max_parallel: 4, verify_deferred: ["pnpm typecheck"], items: [ok, bad] }, ["t"]);
  assert.deepEqual(out.items[0], { id: "a", status: "applied", path: "src/a.ts", lines: 12, cost_usd: 0.01, attempts: 1, verify: { ok: true, ran: 2 } });
  assert.deepEqual(out.items[1], { id: "b", status: "verify_failed", cost_usd: 0.02, attempts: 2 }, "a failed packet: the decision fields only; its detail is in the full receipt");
  assert.deepEqual(out.skipped_no_apply, ["t"]);
  assert.deepEqual(out.verify_deferred, ["pnpm typecheck"]);
});

// The receipt as sent stays within greenfield's stated bound (executor/run.ts RECEIPT_MAX_BYTES): the orchestrator
// re-reads it every later turn. A failed packet keeps what the orchestrator decides on (status, a short reason, the
// escalation target, what blocked it) and the full outcomes go to a file the receipt names.
test("compactBatchReceipt keeps the receipt within 2 kB, failures first, and names the full receipt when it trimmed anything", async () => {
  const { RECEIPT_MAX_BYTES } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "executor", "run.js"));
  const failure = "verify failed: pnpm exec biome check src/x.ts (exit 1)\n" + "x".repeat(3000);
  const failed = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, status: "escalate", artifact_path: `src/f${i}.ts`, cost_usd: 0.01, attempts: 2,
    outcome: { status: "escalate", attempts: [{ failure }, { failure }], escalate: { retry_count: 2, model_id: "opus", failure } } }));
  const applied = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, status: "applied", artifact_path: `src/a${i}.ts`, cost_usd: 0.001, attempts: 1,
    outcome: { status: "applied", apply: { lines: 10 }, verify: { ok: true, ran: 1 } } }));
  const out = compactBatchReceipt({ status: "partial", counts: { applied: 30, escalate: 6 }, cost_usd: 0.1, duration_ms: 1, max_parallel: 4, items: [...applied, ...failed] }, [], { fullReceipt: ".sdlc/runs/r1/batches/b1.json" });
  assert.ok(JSON.stringify(out).length <= RECEIPT_MAX_BYTES, `${JSON.stringify(out).length} bytes`);
  assert.equal(out.full_receipt, ".sdlc/runs/r1/batches/b1.json");
  const first = out.items.find((i) => i.status === "escalate");
  assert.deepEqual(Object.keys(first).sort(), ["attempts", "cost_usd", "escalate", "id", "path", "reason", "status"]);
  assert.deepEqual(first.escalate, { retry_count: 2, model_id: "opus" });
  assert.ok(first.reason.length <= 160);
  assert.equal(out.items.filter((i) => i.status === "escalate").length + (out.failed_not_listed ?? 0), 6, "every failure listed or counted");
  assert.equal(out.items.filter((i) => i.status === "applied").length + (out.applied_not_listed ?? 0), 30);
  assert.equal(out.applied_not_listed, 30, "applied packets go first: a failure is what the orchestrator acts on");
});

// Greenfield's shared block, brownfield's way: the inputs every packet of a batch carries, from a file no packet in the
// batch writes, are marked `shared`; the lean Opus typist sends them as its cached system-prompt tail (applyTypist.ts).
test("markSharedInputs: only an input every packet carries, from a file no packet writes, is shared; a caller's mark is replaced", () => {
  const house = { path: "change_plan.md", section: "House style", reason: "house style (stable run record)" };
  const pk = (id, path, own) => ({ id, artifact_path: path, inputs: [{ path: "change_plan.md", section: id, reason: "unit spec (stable run record)", shared: true }, ...own, house] });
  const out = markSharedInputs([
    pk("A1", "src/a.ts", [{ path: "src/b.ts", reason: "mirror" }]),
    pk("A2", "src/b.ts", [{ path: "src/b.ts", reason: "mirror" }]),
  ]);
  for (const p of out) {
    assert.deepEqual(p.inputs.filter((s) => s.shared).map((s) => s.section), ["House style"]);
    assert.equal(p.inputs.find((s) => s.section === p.id).shared, undefined, "a caller's mark on a per-unit input is dropped");
  }
  assert.equal(out[0].inputs.find((s) => s.path === "src/b.ts").shared, undefined, "src/b.ts is written by a packet of the batch");
  const one = markSharedInputs([pk("A1", "src/a.ts", [{ path: "src/m.ts", reason: "mirror" }])]);
  assert.deepEqual(one[0].inputs.filter((s) => s.shared).map((s) => s.path), ["change_plan.md", "src/m.ts", "change_plan.md"], "one packet: its own retries read every input it carries from the cache");
});

// A check the file failed before the change (apply.ts baselineChecks) is named in the receipt the orchestrator reads,
// by id only, so the run's report can list it; its output stays in the full receipt file.
test("compactBatchReceipt: a set-aside check is named by id on an applied and on a failed item", () => {
  const long = "x".repeat(400);
  const result = {
    status: "partial", counts: {}, cost_usd: 0, duration_ms: 1,
    items: [
      { id: "p1", status: "applied", artifact_path: "src/a.ts", cost_usd: 0, attempts: 1, outcome: { status: "applied", apply: { lines: 3 }, set_aside: [{ id: "lint", run: "lint '{path}'", output: long }] } },
      { id: "p2", status: "verify_failed", artifact_path: "src/b.ts", cost_usd: 0, attempts: 3, outcome: { status: "verify_failed", attempts: [{ failure: "tests failed" }], set_aside: [{ run: "fmt '{path}'", output: long }] } },
    ],
  };
  const r = compactBatchReceipt(result, [], { fullReceipt: ".sdlc/runs/r/batches/x.json" });
  assert.deepEqual(r.items.find((i) => i.id === "p1").set_aside, ["lint"]);
  assert.deepEqual(r.items.find((i) => i.id === "p2").set_aside, ["fmt '{path}'"]);
  assert.ok(!JSON.stringify(r).includes(long), "the output is in the full receipt only");
});

// Greenfield's long stage call sends progress (executor/tools.ts HEARTBEAT_MS), because Claude Code aborts an MCP call
// that stays silent for its idle limit; a batch of slow typists can run that long. One message per finished packet,
// and a heartbeat between them.
test("runBatch reports each settled packet with a running count, blocked ones included", async () => {
  const seen = [];
  const packets = [{ id: "a", artifact_path: "a" }, { id: "b", artifact_path: "b", depends_on: ["a"] }, { id: "c", artifact_path: "c" }];
  await runBatch({ packets, maxParallel: 2, run: async (p) => ({ status: p.id === "a" ? "verify_failed" : "applied", cost_usd: 0 }), log: () => {}, onSettled: (item, done, total) => seen.push(`${item.id}:${item.status}:${done}/${total}`) });
  assert.equal(seen.length, 3);
  assert.ok(seen.includes("b:blocked:3/3") || seen.some((s) => s.startsWith("b:blocked:")));
  assert.deepEqual(seen.map((s) => s.split(":")[2]), ["1/3", "2/3", "3/3"]);
});

test("batchProgress: a message per settled packet and a heartbeat between them, only when the caller asked for progress", async () => {
  const sent = [];
  const channel = { token: "t1", send: async (p) => { sent.push(p); } };
  const pr = batchProgress(channel, 2, 15);
  await new Promise((r) => setTimeout(r, 50));
  pr.settled({ id: "a", status: "applied" }, 1, 2);
  pr.stop();
  const beats = sent.filter((m) => /still typing/.test(m.message));
  assert.ok(beats.length >= 2, `heartbeats: ${beats.length}`);
  assert.deepEqual(sent.at(-1), { progressToken: "t1", progress: 1, total: 2, message: "a applied (1 of 2)" });
  const after = sent.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, after, "stopped");
  const silent = batchProgress({ token: undefined, send: async () => { throw new Error("must not send"); } }, 2, 5);
  silent.settled({ id: "a", status: "applied" }, 1, 2);
  silent.stop();
});

// The batch's answer must not overtake its own last progress message: a client stops listening for a request's
// progress once the answer arrives, so stop() waits for the messages still being sent.
test("batchProgress.stop waits for the progress messages still being sent", async () => {
  const delivered = [];
  const channel = { token: "t", send: (p) => new Promise((r) => setTimeout(() => { delivered.push(p.message); r(); }, 20)) };
  const pr = batchProgress(channel, 1, 60_000);
  pr.settled({ id: "a", status: "applied" }, 1, 1);
  await pr.stop();
  assert.deepEqual(delivered, ["a applied (1 of 1)"]);
});
