/**
 * runBatch and the batch receipt (batch.ts) on the cases where a batch must settle every packet and tell the truth
 * about it: a dependency chain listed dependents first, the plan's tooling steps the server never runs, busy-vendor
 * waits that are no attempt, the plan's end-of-run checks, and a packet an earlier call already applied. The packet
 * runner is a stub; no model, no disk (the packets file is a temp file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runBatch, batchPacketsFromArgs, compactBatchReceipt, packetFingerprint, alreadyApplied, appendAppliedRecord, fileSha256 } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "batch.js"));
const silent = () => {};
const pk = (id, over = {}) => ({ id, phase: "codegen", task_type: "", module: "spec", instruction: "", inputs: [], acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "r", artifact_path: `src/${id}.ts`, apply: { write: true }, ...over });
const tooling = (id, over = {}) => ({ id, phase: "codegen", task_type: "tooling", module: "spec", instruction: `Orchestrator shell step, no model (unit ${id}): run \`npm install\`.`, inputs: [], acceptance: [], budget: { maxInputTokens: 0, maxOutputTokens: 0 }, pass_id: "r", ...over });

/** runBatch, or a rejection when it has not settled within `ms`: a batch that never settles hangs its MCP call. */
function settles(promise, ms = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`runBatch did not settle within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}

// A dependent listed before its dependency: when the root fails, every packet above it must settle as blocked in the
// same pass, or nothing is left running to call the scheduler again and the call never returns.
test("a chain listed dependents first, whose root fails, settles every packet as blocked", async () => {
  const packets = [pk("A", { depends_on: ["B"] }), pk("B", { depends_on: ["C"] }), pk("C")];
  const run = async (p) => ({ status: p.id === "C" ? "verify_failed" : "applied", cost_usd: 0, attempts: [{}] });
  const out = await settles(runBatch({ packets, maxParallel: 4, run, log: silent }));
  assert.deepEqual(out.items.map((i) => [i.id, i.status]), [["A", "blocked"], ["B", "blocked"], ["C", "verify_failed"]]);
  assert.deepEqual(out.items[0].blocked_by, ["B"]);
  assert.deepEqual(out.items[1].blocked_by, ["C"]);
});

// A deps run: the manifest edit, the install (a tooling step the orchestrator runs, never the server), then code that
// needs the new version. Passed whole, the server skips the install; a packet that waits for it cannot start in this
// call, so it is blocked by the install, and so is everything after it.
test("a packet that waits for a tooling step this call skips is blocked by it, transitively; the receipt names the step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify({ packets: [
      pk("tp_codegen_U01", { artifact_path: "package.json" }),
      tooling("tooling_U02", { depends_on: ["tp_codegen_U01"] }),
      pk("tp_codegen_U03", { depends_on: ["tooling_U02"] }),
      pk("tp_tests_U04", { depends_on: ["tp_codegen_U03"] }),
      pk("tp_docs_U05"),
    ] }));
    const args = batchPacketsFromArgs({ packets_path: file });
    assert.deepEqual(args.skipped, ["tooling_U02"]);
    const ran = [];
    const run = async (p) => { ran.push(p.id); return { status: "applied", cost_usd: 0.01, attempts: [{}] }; };
    const out = await settles(runBatch({ packets: args.list, tooling: args.tooling, maxParallel: 4, run, log: silent }));
    assert.deepEqual(ran.sort(), ["tp_codegen_U01", "tp_docs_U05"], "nothing that waits for the install is typed");
    const by = Object.fromEntries(out.items.map((i) => [i.id, i]));
    assert.equal(by.tp_codegen_U03.status, "blocked");
    assert.deepEqual(by.tp_codegen_U03.blocked_by, ["tooling_U02"]);
    assert.equal(by.tp_tests_U04.status, "blocked");
    assert.deepEqual(by.tp_tests_U04.blocked_by, ["tp_codegen_U03"]);
    assert.equal(out.status, "partial");
    const receipt = compactBatchReceipt(out, args.skipped);
    assert.deepEqual(receipt.skipped_no_apply, ["tooling_U02"]);
    assert.deepEqual(receipt.tooling_steps, [{ id: "tooling_U02", instruction: "Orchestrator shell step, no model (unit tooling_U02): run `npm install`." }],
      "the step to run, so the orchestrator never reads packets.json for it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tooling step whose own dependency did not apply says what it waits for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify([pk("tp_codegen_U01"), tooling("tooling_U02", { depends_on: ["tp_codegen_U01"] }), pk("tp_codegen_U03", { depends_on: ["tooling_U02"] })]));
    const args = batchPacketsFromArgs({ packets_path: file });
    const run = async () => ({ status: "verify_failed", cost_usd: 0, attempts: [{}] });
    const out = await settles(runBatch({ packets: args.list, tooling: args.tooling, maxParallel: 4, run, log: silent }));
    assert.deepEqual(out.tooling_steps, [{ id: "tooling_U02", instruction: args.tooling[0].instruction, blocked_by: ["tp_codegen_U01"] }]);
    assert.equal(out.items.find((i) => i.id === "tp_codegen_U03").status, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with packet_ids that leave the tooling step out, a dependency on it is outside the call, as before (it ran between calls)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify([pk("tp_codegen_U01"), tooling("tooling_U02", { depends_on: ["tp_codegen_U01"] }), pk("tp_codegen_U03", { depends_on: ["tooling_U02"] })]));
    const args = batchPacketsFromArgs({ packets_path: file, packet_ids: ["tp_codegen_U03"] });
    assert.deepEqual(args.tooling, []);
    const out = await settles(runBatch({ packets: args.list, tooling: args.tooling, maxParallel: 4, run: async () => ({ status: "applied", cost_usd: 0, attempts: [{}] }), log: silent }));
    assert.deepEqual(out.items.map((i) => [i.id, i.status]), [["tp_codegen_U03", "applied"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A busy vendor's reply is waited out and is no attempt: the apply loop lists attempts only and counts its waits in
// transport_waits (apply.ts ApplyOutcome). The receipt counts the two apart, as greenfield's stage receipt does
// (calls, transport_waits).
test("a packet's attempts leave out the busy-vendor waits, which are counted on their own", async () => {
  const out = await settles(runBatch({ packets: [pk("tp_1"), pk("tp_2")], maxParallel: 4, run: async (p) => ({ status: "applied", cost_usd: 0, attempts: [{ dispatch_ok: true, verify_ok: true }], ...(p.id === "tp_1" ? { transport_waits: 2 } : {}) }), log: silent }));
  assert.equal(out.items[0].attempts, 1);
  assert.equal(out.items[0].transport_waits, 2);
  assert.equal(out.items[1].transport_waits, undefined, "no waits, no field");
  assert.equal(out.transport_waits, 2);
  const receipt = compactBatchReceipt(out);
  assert.equal(receipt.items[0].attempts, 1);
  assert.equal(receipt.items[0].transport_waits, 2);
  assert.equal(Object.keys(receipt.items[0]).filter((k) => k === "transport_waits").length, 1);
  assert.equal(receipt.items[1].transport_waits, undefined);
});

// The plan's end-of-run checks (derivePackets puts them on the last packet as verify_deferred; in a bugfix the
// reproducing test's command comes first) reach the orchestrator in the receipt it reads, whatever the packet's status.
test("the end-of-run checks the batch's packets carry are in the receipt, in plan order, once each", async () => {
  const packets = [pk("tp_1"), pk("tp_2", { verify_deferred: ["npx vitest run 'test/a.test.ts'", "npm test"] }), pk("tp_3", { verify_deferred: ["npm test"] })];
  const out = await settles(runBatch({ packets, maxParallel: 4, run: async (p) => ({ status: p.id === "tp_2" ? "verify_failed" : "applied", cost_usd: 0, attempts: [{}] }), log: silent }));
  assert.deepEqual(out.verify_deferred, ["npx vitest run 'test/a.test.ts'", "npm test"]);
  const receipt = compactBatchReceipt(out);
  assert.deepEqual(receipt.verify_deferred, ["npx vitest run 'test/a.test.ts'", "npm test"]);
  const none = await settles(runBatch({ packets: [pk("tp_9")], maxParallel: 4, run: async () => ({ status: "applied", cost_usd: 0, attempts: [{}] }), log: silent }));
  assert.equal(none.verify_deferred, undefined);
  assert.equal(compactBatchReceipt(none).verify_deferred, undefined);
});

test("a skipped tooling packet's end-of-run checks are kept too", () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify([pk("tp_1"), tooling("tooling_2", { verify_deferred: ["npm test"] })]));
    const args = batchPacketsFromArgs({ packets_path: file });
    assert.deepEqual(args.tooling.map((t) => t.verify_deferred), [["npm test"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A packet an earlier call of the same run applied, and whose file is still as it left it (server.ts appliedRecord),
// settles `already_applied` at $0: it satisfies its dependents and counts as applied for the batch's status.
test("an already-applied packet satisfies its dependents and the batch's status", async () => {
  const packets = [pk("tp_1"), pk("tp_2", { depends_on: ["tp_1"] })];
  const run = async (p) => (p.id === "tp_1" ? { status: "already_applied", cost_usd: 0, attempts: [] } : { status: "applied", cost_usd: 0.01, attempts: [{}] });
  const out = await settles(runBatch({ packets, maxParallel: 4, run, log: silent }));
  assert.deepEqual(out.items.map((i) => [i.id, i.status]), [["tp_1", "already_applied"], ["tp_2", "applied"]]);
  assert.equal(out.items[0].attempts, 0);
  assert.equal(out.status, "applied");
  const receipt = compactBatchReceipt(out);
  assert.deepEqual(receipt.items[0], { id: "tp_1", status: "already_applied", path: "src/tp_1.ts", cost_usd: 0, attempts: 0 });
});

// The applied record (batch.ts alreadyApplied): a packet is done while its file is as it left it, or as a later packet
// of the run on the same file left it (a plan's second packet on one file, a fix); a file changed any other way, or a
// packet that asks for something else, is typed again.
test("alreadyApplied: the packet's own bytes, or a later packet's on the same file; never a changed file or packet", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-applied-"));
  try {
    const write = (text) => writeFileSync(join(root, "index.ts"), text);
    const a = pk("x-a", { artifact_path: "index.ts", instruction: "add a" });
    const b = pk("x-b", { artifact_path: "index.ts", instruction: "add b" });
    const rec = (p, ts) => appendAppliedRecord(root, "r1", { packet_id: p.id, fingerprint: packetFingerprint(p), path: "index.ts", sha256: fileSha256(root, "index.ts"), ts });
    write("a\n"); assert.equal(rec(a, "t1"), true);
    assert.equal(alreadyApplied(root, "r1", a, packetFingerprint(a))?.packet_id, "x-a");
    write("a\nb\n"); rec(b, "t2");
    assert.equal(alreadyApplied(root, "r1", a, packetFingerprint(a))?.packet_id, "x-a", "a later packet on the same file built on it");
    assert.equal(alreadyApplied(root, "r1", b, packetFingerprint(b))?.packet_id, "x-b");
    const changed = { ...a, instruction: "add a, differently" };
    assert.equal(alreadyApplied(root, "r1", changed, packetFingerprint(changed)), null, "a packet that asks for something else");
    write("someone else's text\n");
    assert.equal(alreadyApplied(root, "r1", a, packetFingerprint(a)), null, "a file changed since");
    assert.equal(alreadyApplied(root, "no-such-run", a, packetFingerprint(a)), null);
    assert.equal(alreadyApplied(root, "../escape", a, packetFingerprint(a)), null, "a run id is a folder name, never a path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packetFingerprint ignores the batch's shared mark and the text of the packet's own file, and nothing else the packet carries", () => {
  const p = pk("tp_1", { artifact_path: "src/a.ts", inputs: [{ path: "brief.md", reason: "r", content: "B" }, { path: "src/a.ts", reason: "current text", content: "old" }] });
  const same = { ...p, inputs: [{ ...p.inputs[0], shared: true }, { ...p.inputs[1], content: "new, after its own write" }] };
  assert.equal(packetFingerprint(same), packetFingerprint(p));
  assert.notEqual(packetFingerprint({ ...p, inputs: [{ ...p.inputs[0], content: "B2" }, p.inputs[1]] }), packetFingerprint(p), "text the caller sent counts");
  assert.notEqual(packetFingerprint({ ...p, apply: { write: true, mode: "edits" } }), packetFingerprint(p));
});

// What a packet asks for is the packet as planned. The text a slice read from a project file is not part of it: a
// later packet of the run may edit that file (a bugfix's fix edits the module its reproducing test reads), and the
// earlier packet is still done. The run's own briefs (.sdlc/runs/<run_id>/) are part of the plan, so their text counts.
test("packetFingerprint: a project file's read text never counts, a run brief's does; what a slice reads always does", () => {
  const asWritten = pk("tp_tests_U01", { artifact_path: "test/x.test.mjs", inputs: [
    { path: ".sdlc/runs/r1/briefs/shared.md", reason: "brief" },
    { path: "src/x.mjs", reason: "uses", lines: [1, 20] },
    { path: "test/x.test.mjs", reason: "current text" },
  ] });
  const read = (brief, src, own) => ({ ...asWritten, inputs: [{ ...asWritten.inputs[0], content: brief }, { ...asWritten.inputs[1], content: src }, { ...asWritten.inputs[2], content: own }] });
  const fp = (r) => packetFingerprint(asWritten, { runId: "r1", read: r });
  const base = fp(read("brief v1", "export const two = () => 3;", "old test"));
  assert.equal(fp(read("brief v1", "export const two = () => 2;", "new test")), base, "the module under fault was fixed since: same packet");
  assert.notEqual(fp(read("brief v2", "export const two = () => 3;", "old test")), base, "a re-planned brief is another packet");
  assert.notEqual(packetFingerprint({ ...asWritten, inputs: [asWritten.inputs[0], { ...asWritten.inputs[1], lines: [1, 40] }, asWritten.inputs[2]] }, { runId: "r1", read: read("brief v1", "x", "y") }), base, "another part of the file is another packet");
  assert.equal(packetFingerprint(asWritten, { runId: "r2", read: read("brief v1", "x", "y") }), packetFingerprint(asWritten, { runId: "r2", read: read("brief v2", "x", "y") }), "another run's folder is a project file to this run");
});

// The plan's tooling steps (the orchestrator's shell steps). A step a call leaves out (packet_ids) has not run when it
// waits, through the plan, for a packet of this call: a packet of the call that waits for the step is blocked by it.
test("a tooling step left out of the call that waits for one of its packets has not run: what waits for it is blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify([
      pk("tp_codegen_U01", { artifact_path: "package.json" }),
      pk("tp_codegen_U05", { depends_on: ["tp_codegen_U01"] }),
      tooling("tooling_U02", { depends_on: ["tp_codegen_U05"] }),
      pk("tp_codegen_U03", { depends_on: ["tooling_U02"] }),
    ]));
    const ran = [];
    const run = async (p) => { ran.push(p.id); return { status: "applied", cost_usd: 0, attempts: [{}] }; };
    const args = batchPacketsFromArgs({ packets_path: file, packet_ids: ["tp_codegen_U01", "tp_codegen_U03"] });
    const out = await settles(runBatch({ packets: args.list, tooling: args.tooling, plan: args.plan, maxParallel: 4, run, log: silent }));
    assert.deepEqual(ran, ["tp_codegen_U01"], "the packet after the install is not typed before it");
    assert.deepEqual(out.items.map((i) => [i.id, i.status, i.blocked_by]), [["tp_codegen_U01", "applied", undefined], ["tp_codegen_U03", "blocked", ["tooling_U02"]]]);
    assert.deepEqual(out.tooling_steps, [{ id: "tooling_U02", instruction: "Orchestrator shell step, no model (unit tooling_U02): run `npm install`." }], "the receipt names the step to run");
    // The step waits for nothing in a call that sends only what comes after it: it ran between the calls.
    const later = batchPacketsFromArgs({ packets_path: file, packet_ids: ["tp_codegen_U03"] });
    const after = await settles(runBatch({ packets: later.list, tooling: later.tooling, plan: later.plan, maxParallel: 4, run, log: silent }));
    assert.deepEqual(after.items.map((i) => [i.id, i.status]), [["tp_codegen_U03", "applied"]]);
    assert.equal(after.tooling_steps, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A tooling step that a packet of the run applied after has run (the orchestrator sends a step's dependents only once
// it ran it). Re-sending the whole file then blocks nothing on it and asks for no shell step again.
test("a tooling step whose dependent the run already applied has run: nothing is blocked by it and the receipt does not ask for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-tooling-"));
  try {
    const file = join(dir, "packets.json");
    writeFileSync(file, JSON.stringify([pk("tp_codegen_U01"), tooling("tooling_U02", { depends_on: ["tp_codegen_U01"] }), pk("tp_codegen_U03", { depends_on: ["tooling_U02"] }), pk("tp_codegen_U04", { depends_on: ["tooling_U02"] })]));
    const args = batchPacketsFromArgs({ packets_path: file });
    const ran = [];
    const run = async (p) => { ran.push(p.id); return { status: p.id === "tp_codegen_U04" ? "applied" : "already_applied", cost_usd: 0, attempts: [] }; };
    const appliedBefore = (p) => p.id === "tp_codegen_U01" || p.id === "tp_codegen_U03";
    const out = await settles(runBatch({ packets: args.list, tooling: args.tooling, plan: args.plan, appliedBefore, maxParallel: 4, run, log: silent }));
    assert.deepEqual(ran.sort(), ["tp_codegen_U01", "tp_codegen_U03", "tp_codegen_U04"], "nothing is blocked by a step that ran");
    assert.equal(out.items.find((i) => i.id === "tp_codegen_U03").status, "already_applied");
    assert.equal(out.tooling_steps, undefined, "no shell step to run again");
    // With no dependent applied, the step is still to run, as before.
    const fresh = await settles(runBatch({ packets: args.list, tooling: args.tooling, plan: args.plan, appliedBefore: () => false, maxParallel: 4, run: async () => ({ status: "applied", cost_usd: 0, attempts: [{}] }), log: silent }));
    assert.deepEqual(fresh.items.map((i) => i.status), ["applied", "blocked", "blocked"]);
    assert.equal(fresh.tooling_steps?.[0]?.id, "tooling_U02");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
