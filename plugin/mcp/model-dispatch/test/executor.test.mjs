/**
 * The shared executor (execute_stage) with fake typists: routing by the
 * policy on every attempt, the three-attempt ladder, transport waits, the
 * repair stage and its edit contract, warming a cold cache first, the checks
 * (right path, safe path, not empty — the same in every language), routing by
 * stage alone, the files it writes, the bill it emits, the receipt it returns,
 * and the run state it requires. No model calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeStage, backoffMs, applyEdits, placeFixPath, boundReceipt, RECEIPT_MAX_BYTES, LEAN_OPUS_CACHE_TTL_MS } from "../dist/executor/run.js";
import { checkAnswer } from "../dist/executor/checks.js";
import { EXECUTOR_TOOLS, handleExecutorTool, reviewRepairs, failureRepairs, STAGE_CONCURRENCY, TRANSPORT } from "../dist/executor/tools.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import * as executorTools from "../dist/executor/tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const SOLO = loadPolicyFromPath(join(POLICIES, "opus-only-v5.yaml"));
const ORCH = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));

// A unit carries no file-type label: who types it depends on its stage and the policy alone.
const unit = (id, path, phase = "codegen") => ({
  id, path, phase, import_line: "", exports: [{ name: "thing", params: [], returns: "int" }],
  behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5,
});
const SPEC = {
  spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] },
  units: [
    unit("U01", "app/models.py"),          // v38 → Flash: every code file, whatever its language or name
    unit("U02", "config/app.toml"),        // v38 → Flash, whatever the file's type
    unit("U03", "cmd/server/main.go"),     // v38 → Flash
    unit("U04", "tests/test_x.py", "tests"), // another stage
  ],
};
const GOOD = (u) => ({ path: u.path, content: "def thing():\n    return 1\n" });
const tokens = { input: 100, input_cached: 0, output: 50 };

/** A fake typist that answers from a script of results, recording every request. */
function fake(door, modelId, script = () => ({})) {
  const calls = [];
  return {
    door, modelId, modelName: `${door}-model`, calls,
    async type(req) {
      calls.push(req);
      const s = script(req, calls.length);
      return { answer: s.answer === undefined ? GOOD(req.unit) : s.answer, error: s.error, error_status: s.error_status, transport: !!s.transport, retry_after_ms: s.retry_after_ms, cut_off: s.cut_off, tokens, cost_usd: s.cost ?? 0.01, latency_ms: 1 };
    },
  };
}
const OPTS = (policy, dir, over = {}) => ({ stage: "codegen", codeDir: dir, passId: "p1", policy, concurrency: 2, routedAttempts: 2, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 }, ...over });
const okCheck = () => ({ ok: true });

test("solo: every unit of the stage goes to the lean Opus typist, is written, and is billed once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const r = await executeStage(SPEC, OPTS(SOLO, dir), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(r.units, 3, "only the codegen stage");
  assert.equal(r.written, 3);
  assert.deepEqual(r.failed, []);
  assert.equal(opus.calls.length, 3);
  assert.deepEqual(Object.keys(r.by_door), ["lean-opus"]);
  assert.equal(r.cost_usd, 0.03);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.door === "lean-opus" && e.success && e.provenance === "vendor" && e.pass === "p1"));
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 1\n");
  assert.equal(existsSync(join(dir, "tests/test_x.py")), false, "the tests stage is not typed by a codegen call");
});

test("orchestrator: every code unit goes to the policy's typist for the stage, whatever its language or name; the shared block and framed brief reach every typist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const flash = fake("flash-completion", "flash-completion");
  const opus = fake("lean-opus", "opus");
  const typistFor = (id) => (id === "opus" ? opus : flash);
  const r = await executeStage(SPEC, OPTS(ORCH, dir), { typistFor, fallback: opus, shared: "SHARED-BLOCK", sharedFile: "/tmp/shared", emit: () => {}, check: okCheck });
  assert.deepEqual(flash.calls.map((c) => c.unit.id).sort(), ["U01", "U02", "U03"]);
  assert.deepEqual(opus.calls.map((c) => c.unit.id), [], "no code file falls to Opus because of what kind of file it is");
  assert.equal(r.by_door["flash-completion"].units_written, 3);
  assert.equal(r.by_door["lean-opus"], undefined);
  for (const c of [...flash.calls, ...opus.calls]) {
    assert.equal(c.shared, "SHARED-BLOCK");
    assert.equal(c.sharedFile, "/tmp/shared");
    assert.equal(c.contract, "file");
    assert.ok(c.framed.startsWith(`## Task — ${c.unit.id} (codegen)`), c.framed.slice(0, 60));
  }
});

test("the ladder: two routed attempts with the refusal fed back, then one lean Opus attempt; each attempt is billed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  // A refusal the checks make in every language: the answer names another file.
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/other.py", content: "def thing():\n    return 1\n" } }));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: (u, a) => checkAnswer(u, a) });
  assert.equal(flash.calls.length, 2);
  assert.ok(!flash.calls[0].packet.instruction.includes("previous answer was refused"));
  assert.match(flash.calls[1].packet.instruction, /## Your previous answer was refused\nthe answer names app\/other\.py, not app\/models\.py/);
  assert.equal(opus.calls.length, 1, "the lean Opus attempt");
  assert.match(opus.calls[0].packet.instruction, /previous answer was refused/);
  assert.equal(r.written, 1);
  assert.equal(r.by_door["lean-opus"].units_written, 1);
  assert.deepEqual(events.map((e) => [e.door, e.attempt_number, e.success]), [["flash-completion", 1, false], ["flash-completion", 2, false], ["lean-opus", 3, true]]);
  assert.equal(events[2].routing.rule_index, -1);
  assert.equal(r.calls, 3);
});

test("a unit every attempt refuses is reported failed, and nothing is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const bad = fake("lean-opus", "opus", () => ({ answer: null, error: "the reply was not one JSON object {path, content}" }));
  const one = { ...SPEC, units: [SPEC.units[1]] };
  const r = await executeStage(one, OPTS(SOLO, dir), { typistFor: () => bad, fallback: bad, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(bad.calls.length, 3, "solo gets the same three attempts, all lean Opus");
  assert.deepEqual(r.failed, [{ id: "U02", path: "config/app.toml", reason: "the reply was not one JSON object {path, content}" }]);
  assert.equal(existsSync(join(dir, "config/app.toml")), false);
});

test("a transport failure waits (the vendor's own delay when given, else jittered backoff) and is not an attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const waits = [];
  const flaky = fake("flash-completion", "flash-completion", (req, n) => (n === 1 ? { answer: null, transport: true, error: "429 RESOURCE_EXHAUSTED", retry_after_ms: 7000, cost: 0 } : n === 2 ? { answer: null, transport: true, error: "503 UNAVAILABLE", cost: 0 } : {}));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flaky), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  assert.deepEqual(waits, [7000, 1000], "the vendor's 7 s, then 0.5 × min(8000, 1000·2^1)");
  assert.equal(r.transport_waits, 2);
  assert.equal(r.written, 1);
  assert.equal(opus.calls.length, 0, "no attempt was used up");
  assert.deepEqual(events.map((e) => [e.retry_reason, e.attempt_number, e.success]), [["transport", 1, false], ["transport", 1, false], [undefined, 1, true]]);
});

test("an answer for another path, an unsafe path or an empty file is refused", () => {
  const u = SPEC.units[0];
  assert.match(checkAnswer(u, { path: "app/other.py", content: "def thing(): pass\n" }).reason, /names app\/other\.py, not app\/models\.py/);
  assert.equal(checkAnswer({ ...u, path: "../x.py" }, { path: "../x.py", content: "def thing(): pass\n" }).ok, false);
  assert.equal(checkAnswer(u, { path: u.path, content: "   \n" }).reason, "the file is empty");
});

test("only faults that hold in every language refuse a file: no file is parsed, so no language is checked more than another", () => {
  // Parsing some languages and not others would give the others a weaker check. Whether a file is
  // right is judged by the project's own build and tests, which the pipeline runs after every stage with
  // repair rounds, the same way for every language and every policy.
  const ok = (path, content) => assert.equal(checkAnswer({ path }, { path, content }).ok, true, path);
  ok("app/main.py", "def f(:\n");                                   // broken syntax: the tests and repair round find it
  ok("src/App.tsx", "export default function App( {\n");
  ok("data/rates.json", "{ \"a\": }\n");
  ok("package.json", "{\n  // a comment npm would refuse\n  \"name\": \"x\"\n}\n");
  ok("cmd/server/main.go", "package main\n\nfunc main() {}\n");
  ok("src/lib.rs", "pub fn add(a: i32, b: i32) -> i32 { a + b }\n");
  ok("config/app.toml", "[server]\nport = 8080\n");
  ok("Makefile", "test:\n\tgo test ./...\n");
  const no = (path, content, why) => assert.match(checkAnswer({ path }, { path, content }).reason ?? "", why, path);
  no("cmd/server/main.go", "  \n", /empty/);
  no("src/lib.rs", "", /empty/);
});

test("the checks need no toolchain: a stage runs with no Python and no parser installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  // No check override: the stage's own checks run, and they need no language tool on this machine.
  const r = await executeStage(SPEC, OPTS(SOLO, dir), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {} });
  assert.equal(r.written, 3);
  assert.equal(r.failed.length, 0);
});

test("a policy that routes a stage by task type is read by stage: every file of the stage goes to that rule's model, none silently to the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const flash = fake("flash-completion", "flash-completion");
  const opus = fake("lean-opus", "opus");
  const labelled = { ...SOLO, models: [...SOLO.models, ...ORCH.models.filter((m) => m.id === "flash-completion")], rules: [{ when: { phase: "codegen", task_type: ["controller_handler"] }, use: "flash-completion" }, ...SOLO.rules] };
  const r = await executeStage(SPEC, OPTS(labelled, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.written, 3);
  assert.equal(flash.calls.length, 3, "every code file went to the model the code rule names");
  assert.equal(opus.calls.length, 0);
});

test("an answer cut off at a typist's output limit is never retried at the same limit: the file goes to the typist with a larger one, and fails only when none has one", async () => {
  // The vendor says when an answer stopped at the output limit; asking the same typist again cannot help.
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const cut = { answer: null, error: "stopped at the output limit", cut_off: true };
  const flash = fake("flash-completion", "flash-completion", () => cut);
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(flash.calls.length, 1, "no second attempt at the same limit");
  assert.equal(opus.calls.length, 1);
  assert.match(opus.calls[0].packet.instruction, /previous answer was refused\n[^\n]*cut off at the flash-completion typist's output limit/);
  assert.equal(r.written, 1);
  // Solo: every attempt is the same typist, so a cut-off answer fails the file at once, with the reason.
  const dir2 = mkdtempSync(join(tmpdir(), "exec-"));
  const opusCut = fake("lean-opus", "opus", () => cut);
  const r2 = await executeStage(one, OPTS(SOLO, dir2), { typistFor: () => opusCut, fallback: opusCut, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(opusCut.calls.length, 1);
  assert.match(r2.failed[0].reason, /cut off at the lean-opus typist's output limit/);
});

test("the architect hands a spec section over as a file it wrote; a file that is not valid JSON is refused with its exact line, column and text, nothing is stored, and a fixed file is accepted", async () => {
  // A large section sent inline as a tool argument can arrive as JSON Claude Code cannot parse, and is then
  // thrown away whole, with no location, costing a full resend. So the section travels as a file the
  // architect writes, and this server parses it and names the spot, which the architect fixes with Edit.
  const dir = mkdtempSync(join(tmpdir(), "spec-file-"));
  mkdirSync(join(dir, "spec.sections"));
  const call = async (a) => JSON.parse((await handleExecutorTool("submit_spec_section", { spec_dir: dir, ...a }, { overrides: {} })).content[0].text);
  const header = { stack: SPEC.stack, commands: SPEC.commands, decisions: SPEC.decisions, shared: SPEC.shared };
  writeFileSync(join(dir, "spec.sections/header.json"), JSON.stringify(header, null, 2));
  const h = await call({ section: "header", file: "spec.sections/header.json" });
  assert.equal(h.ok, true, JSON.stringify(h));
  const u = [unit("U01", "app/models.py")];
  const broken = JSON.stringify(u, null, 2).replace('"path": "app/models.py",', '"path": "app/models.py"');
  writeFileSync(join(dir, "spec.sections/units-001.json"), broken);
  const bad = await call({ section: "units", file: "spec.sections/units-001.json" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /not valid JSON at line 5, column \d+/, "where the parser noticed it");
  assert.match(bad.errors[0].message, /the line before \(4\) reads: +"path": "app\/models\.py"$/m, "and the line where the comma is missing");
  assert.match(bad.errors[0].message, /Edit/);
  assert.equal(bad.total_units, 0, "nothing stored");
  writeFileSync(join(dir, "spec.sections/units-001.json"), JSON.stringify(u, null, 2));
  const good = await call({ section: "units", file: "spec.sections/units-001.json" });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.total_units, 1);
  assert.match((await call({ section: "units", file: "../outside.json" })).errors[0].message, /outside the spec directory/);
  assert.match((await call({ section: "units", file: "spec.sections/none.json" })).errors[0].message, /no file at/);
  // The section cannot be sent inline: the tool takes the file only.
  const tool = EXECUTOR_TOOLS.find((t) => t.name === "submit_spec_section");
  assert.deepEqual(tool.inputSchema.required.sort(), ["file", "section", "spec_dir"]);
  assert.equal(tool.inputSchema.properties.header, undefined);
  assert.equal(tool.inputSchema.properties.units, undefined);
});

test("never more units in flight than the stated limit, and the receipt stays short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let inFlight = 0, peak = 0;
  const slow = {
    door: "lean-opus", modelId: "opus", modelName: "m",
    async type(req) { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answer: null, error: "x".repeat(400), transport: false, tokens, cost_usd: 0, latency_ms: 1 }; },
  };
  const many = { ...SPEC, units: Array.from({ length: 30 }, (_, i) => unit(`U${String(i + 10).padStart(2, "0")}`, `f${i}.py`)) };
  const r = await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => slow, fallback: slow, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(peak, 4);
  assert.equal(r.failed.length + r.failed_not_listed, 30, "every failure is either listed or counted");
  assert.ok(r.failed.length >= 1);
  assert.ok(r.failed.every((f) => f.reason.length <= 160));
  assert.ok(JSON.stringify(r).length <= 2048, `receipt is ${JSON.stringify(r).length} bytes`);
});

test("a typist that throws fails only that attempt; the stage carries on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let n = 0;
  const shaky = { door: "lean-opus", modelId: "opus", modelName: "m", async type(req) { if (++n === 1) throw new Error("spawn claude ENOENT"); return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0.01, latency_ms: 1 }; } };
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[1]] };
  const r = await executeStage(one, OPTS(SOLO, dir), { typistFor: () => shaky, fallback: shaky, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(r.written, 1);
  assert.match(events[0].error, /the lean-opus typist failed: spawn claude ENOENT/);
  assert.deepEqual(events.map((e) => [e.attempt_number, e.success]), [[1, false], [2, true]]);
});

test("a typist that cannot be built stops the stage before any unit is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const typistFor = (id) => { if (id !== "opus") throw new Error("no Python for the agent door"); return opus; };
  await assert.rejects(executeStage(SPEC, OPTS(ORCH, dir), { typistFor, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck }), /no Python for the agent door/);
  assert.equal(opus.calls.length, 0, "nothing was paid for");
});

test("backoff is full jitter under a cap", () => {
  assert.equal(backoffMs(0, 1000, 8000, () => 0.999), 999);
  assert.equal(backoffMs(5, 1000, 8000, () => 0.5), 4000, "capped at 8 s before the jitter");
  assert.equal(backoffMs(3, 1000, 8000, () => 0), 0);
});

test("every attempt is routed with its own retry count: a fix under the orchestrator policy goes Flash, Flash, then lean Opus; under solo, lean Opus throughout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app/models.py"), "def thing():\n    return 0\n");
  const refuse = () => ({ answer: { path: "app/models.py", edits: [{ search: "not in the file", replace: "x" }] } });
  const flash = fake("flash-completion", "flash-completion", refuse);
  const opus = fake("lean-opus", "opus", refuse);
  const events = [];
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [{ path: "app/models.py", problems: ["thing() must return 1"] }] }), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.deepEqual(events.map((e) => [e.phase, e.door, e.retry_count]), [["debug", "flash-completion", 0], ["debug", "flash-completion", 1], ["debug", "lean-opus", 2]]);
  assert.deepEqual(events.slice(0, 2).map((e) => e.routing.rule_reason), ["Most debugs have clear cause", "Most debugs have clear cause"]);
  assert.equal(r.failed.length, 1);
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 0\n", "a refused fix leaves the file untouched");
  const soloEvents = [];
  const opus2 = fake("lean-opus", "opus", refuse);
  await executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [{ path: "app/models.py", problems: ["x"] }] }), { typistFor: () => opus2, fallback: opus2, shared: "S", sharedFile: "/dev/null", emit: (e) => soloEvents.push(e), check: okCheck });
  assert.deepEqual(soloEvents.map((e) => e.door), ["lean-opus", "lean-opus", "lean-opus"]);
});

test("a fix: the brief carries the current text and the problems; exact edits apply; several problems for one file are one job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app/models.py"), "def thing():\n    return 0\n");
  writeFileSync(join(dir, "app/test_models.py"), "def test_thing():\n    assert thing() == 1\n");
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/models.py", edits: [{ search: "return 0", replace: "return 1" }] } }));
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [
    { path: "app/models.py", problems: ["test_thing: assert 0 == 1"], context_paths: ["app/test_models.py"] },
    { path: "app/models.py", problems: ["major: thing() returns the wrong value — fix: return 1"] },
  ] }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: (u, a) => checkAnswer(u, a) });
  assert.equal(r.units, 1, "one job per file");
  assert.equal(r.written, 1);
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 1\n");
  const req = flash.calls[0];
  assert.equal(req.contract, "edit");
  assert.equal(req.packet.phase, "debug");
  assert.match(req.packet.instruction, /## What must change\n- test_thing: assert 0 == 1\n- major: thing\(\) returns the wrong value — fix: return 1/);
  assert.match(req.framed, /### app\/models\.py  — current text \(your edits apply to this\)\n```\ndef thing\(\):\n    return 0\n/);
  assert.match(req.framed, /### app\/test_models\.py  — for reference only; do not edit/);
});

test("the edit contract fails closed: a search found twice or not at all changes nothing; a whole file is accepted", () => {
  assert.deepEqual(applyEdits("a b a", [{ search: "b", replace: "c" }]), { content: "a c a" });
  assert.match(applyEdits("a b a", [{ search: "a", replace: "c" }]).reason, /edit 1: its search text appears 2 times/);
  assert.match(applyEdits("a b", [{ search: "b", replace: "c" }, { search: "z", replace: "y" }]).reason, /edit 2: its search text appears 0 times/);
  assert.deepEqual(applyEdits("x", [{ search: "x", replace: "$&$1" }]), { content: "$&$1" }, "replacement text is literal");
  // Overlapping occurrences count: "}\n}" appears twice in "}\n}\n}", so the edit is ambiguous.
  assert.match(applyEdits("}\n}\n}", [{ search: "}\n}", replace: "X" }]).reason, /appears 2 times/);
});

test("a fix whose path leaves the code directory is reported, and nothing is read or sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const r = await executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [{ path: "../etc/passwd", problems: ["x"] }] }), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.not_routed.length, 1);
  assert.equal(r.not_routed[0].file, "../etc/passwd");
  assert.match(r.not_routed[0].reason, /^names no file under the code directory and no file of the spec/);
  assert.equal(r.units, 0);
  assert.equal(opus.calls.length, 0);
});

test("a cold lean Opus typist sends one job alone, then fans out; a warm one does not wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let inFlight = 0;
  const seen = [];
  let clock = 0;
  const slow = { door: "lean-opus", modelId: "opus", modelName: "m", async type(req) { inFlight++; seen.push(inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0.01, latency_ms: 1 }; } };
  const many = { ...SPEC, units: Array.from({ length: 6 }, (_, i) => unit(`U${10 + i}`, `f${i}.py`)) };
  await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => slow, fallback: slow, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck, now: () => clock });
  assert.equal(seen[0], 1, "the first call runs alone");
  assert.ok(Math.max(...seen) > 1, "then the others run together");
  const flashSeen = [];
  let f = 0;
  const flash = { door: "flash-completion", modelId: "flash-completion", modelName: "f", async type(req) { f++; flashSeen.push(f); await new Promise((r) => setTimeout(r, 5)); f--; return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0, latency_ms: 1 }; } };
  await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.ok(flashSeen[1] > 1, "the Gemini doors are not held back: no cache the executor controls");
  assert.equal(LEAN_OPUS_CACHE_TTL_MS, 300000, "the five-minute lifetime the typist is launched with");
});

test("a vendor pause longer than one rate-limit window is an attempt, not a wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const waits = [];
  const flash = fake("flash-completion", "flash-completion", (req, n) => (n === 1 ? { answer: null, transport: true, error: "429", retry_after_ms: 90_000, cost: 0 } : {}));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [8000], "one full window before the next attempt, so the next attempt does not hit the same wall");
  assert.match(events[0].error, /asked for a 90 s pause, longer than one 8 s rate-limit window/);
  assert.deepEqual(events.map((e) => [e.attempt_number, e.success]), [[1, false], [2, true]]);
  assert.equal(TRANSPORT.capMs, 60_000, "one 60 s rate-limit window");
});

test("execute_stage takes no auth mode, policy or concurrency from the model; it refuses to run before pre-flight", async () => {
  const props = EXECUTOR_TOOLS.find((t) => t.name === "execute_stage").inputSchema.properties;
  for (const k of ["auth_mode", "concurrency", "policy_name", "policy_path", "project_root"]) assert.equal(props[k], undefined, k);
  assert.equal(STAGE_CONCURRENCY, 4);
  const r = await handleExecutorTool("execute_stage", { spec_path: "/x/spec.json", stage: "codegen", code_dir: "/x" }, { run: () => undefined, overrides: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only after preflight_dispatch has recorded this run's auth mode and policy/);
});

test("a review's findings become fixes by file; a finding that cannot be placed is reported, never guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const rp = join(dir, "review.json");
  writeFileSync(rp, JSON.stringify({ module: "m", verdict: "needs_changes", findings: [
    { severity: "blocker", file: "app/models.py", issue: "wrong value", fix: "return 1" },
    { severity: "minor", file: join(dir, "app/routes.py"), issue: "naming", fix: "rename" },
    { severity: "major", file: "/elsewhere/x.py", issue: "i", fix: "f" },
    { severity: "major", issue: "no file" },
  ] }));
  const r = reviewRepairs([rp]);
  // Findings are read as written; where each file is placed is the executor's job (placeFixPath), for review and test fixes alike.
  assert.deepEqual(r.items, [
    { path: "app/models.py", problems: ["blocker: wrong value — fix: return 1"] },
    { path: join(dir, "app/routes.py"), problems: ["minor: naming — fix: rename"] },
    { path: "/elsewhere/x.py", problems: ["major: i — fix: f"] },
  ]);
  assert.deepEqual(r.not_routed.map((x) => x.reason), ["a finding with no file"]);
});

/** A code directory under the project: the code lives in <project>/src, the spec's paths are relative to it. */
function smokeLayout() {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const code = join(project, "src");
  mkdirSync(join(code, "notes_api"), { recursive: true });
  writeFileSync(join(code, "notes_api/api.py"), "def thing():\n    return 0\n");
  writeFileSync(join(code, "notes_api/store.py"), "def thing():\n    return 0\n");
  const units = new Set(["notes_api/api.py", "notes_api/store.py", "tests/conftest.py", "README.md"]);
  return { project, code, units };
}

test("a fix path is placed only on a real file under the code directory or a file of the spec — never guessed, never a new stray file", () => {
  const { project, code, units } = smokeLayout();
  const ok = (p, want) => assert.deepEqual(placeFixPath(p, code, units), { path: want }, p);
  const no = (p) => assert.ok("reason" in placeFixPath(p, code, units), `${p} must not be placed`);
  ok("notes_api/api.py", "notes_api/api.py");
  ok("./notes_api/api.py", "notes_api/api.py");
  // The senior reviewer writes paths from the project root: "src/notes_api/api.py" with code_dir <project>/src.
  ok("src/notes_api/api.py", "notes_api/api.py");
  ok(join(code, "notes_api/api.py"), "notes_api/api.py");
  ok("tests/conftest.py", "tests/conftest.py"); // a planned file the spec lists may be written even if it is missing
  no("src/notes_api/api.py:12"); // a line number glued to the path names no file
  no("notes_api/missing.py");
  no("../outside.py");
  no("/elsewhere/x.py");
  no("notes_api"); // a directory
  mkdirSync(join(project, "elsewhere"));
  writeFileSync(join(project, "elsewhere", "x.py"), "x = 1\n");
  symlinkSync(join(project, "elsewhere"), join(code, "link"));
  no("link/x.py"); // a symlink out of the code directory
});

test("a repair round built from a real review (project-root paths) edits the real files and creates none; unplaceable findings are reported", async () => {
  const { code, units } = smokeLayout();
  const spec = { ...SPEC, commands: [], units: [...units].map((p, i) => unit(`U0${i + 1}`, p)) };
  const rp = join(code, "..", "review.json");
  writeFileSync(rp, JSON.stringify({ findings: [
    { severity: "minor", file: "src/notes_api/api.py", line: 3, issue: "returns 0", fix: "return 1" },
    { severity: "minor", file: "src/notes_api/store.py:2", issue: "glued line", fix: "x" },
    { severity: "minor", file: "src/notes_api/nowhere.py", issue: "no such file", fix: "x" },
  ] }));
  const flash = fake("flash-completion", "flash-completion", (req) => ({ answer: { path: req.unit.path, edits: [{ search: "return 0", replace: "return 1" }] } }));
  const r = await executeStage(spec, OPTS(ORCH, code, { stage: "repair", repairs: reviewRepairs([rp]).items }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.written, 1);
  assert.equal(readFileSync(join(code, "notes_api/api.py"), "utf8"), "def thing():\n    return 1\n");
  assert.equal(existsSync(join(code, "src")), false, "no shadow src/src tree");
  assert.match(flash.calls[0].packet.instruction, /minor \(line 3\): returns 0 — fix: return 1/);
  assert.deepEqual(r.not_routed.map((x) => x.file).sort(), ["src/notes_api/nowhere.py", "src/notes_api/store.py:2"]);
});

test("a job that throws is a failed job, not a crashed stage; writes never follow a symlink out of the code directory", async () => {
  const { project, code, units } = smokeLayout();
  mkdirSync(join(project, "outside"));
  symlinkSync(join(project, "outside"), join(code, "gen"));
  const spec = { ...SPEC, units: [unit("U01", "gen/out.py"), unit("U02", "notes_api/new.py")] };
  const opus = fake("lean-opus", "opus");
  const r = await executeStage(spec, OPTS(SOLO, code), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.written, 1);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /outside the code directory/);
  assert.deepEqual(readdirSync(join(project, "outside")), [], "nothing written through the symlink");
});

test("the receipt as sent — compact, not_routed included — stays within its stated bound", () => {
  const big = { stage: "repair", units: 60, written: 0, failed: Array.from({ length: 40 }, (_, i) => ({ id: `U${i}`, path: `a/very/long/path/number/${i}/file.ts`, reason: "x".repeat(120) })), not_routed: Array.from({ length: 30 }, (_, i) => ({ file: `src/f${i}.py:${i}`, reason: "names no file under the code directory and no file of the spec" })), by_door: {}, calls: 0, transport_waits: 0, cost_usd: 0, seconds: 1 };
  const b = boundReceipt(big);
  assert.ok(JSON.stringify(b).length <= RECEIPT_MAX_BYTES, `${JSON.stringify(b).length} bytes`);
  assert.equal(b.failed.length + b.failed_not_listed, 40);
  assert.equal(b.not_routed.length + (b.not_routed_not_listed ?? 0), 30);
});

test("execute_stage refuses an unknown stage, and bills to the pass folder's telemetry when no telemetry_path is given", async () => {
  const r = await handleExecutorTool("execute_stage", { spec_path: "/x/spec.json", stage: "test", code_dir: "/x" }, { run: () => ({ authMode: "estimated" }), overrides: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown stage 'test'/);
  const { telemetryPathFor } = await import("../dist/executor/tools.js");
  assert.equal(telemetryPathFor({ spec_path: "/runs/p1/spec.json" }), "/runs/p1/telemetry.jsonl");
  assert.equal(telemetryPathFor({ spec_path: "/runs/p1/spec.json", telemetry_path: "/t.jsonl" }), "/t.jsonl");
});

test("a door that refuses the login or permission (401/403) stops the stage — the files are never quietly sent to Opus", async () => {
  // Otherwise, with every Flash call refused, each unit falls back to lean Opus and the receipt shows no
  // failure, so an orchestrator run silently becomes a costlier solo run.
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const refused = fake("flash-completion", "flash-completion", () => ({ answer: null, error: "HTTP 403 PERMISSION_DENIED", error_status: 403, cost: 0 }));
  const opus = fake("lean-opus", "opus");
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { concurrency: 1 }), { typistFor: (id) => (id === "opus" ? opus : refused), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.match(r.stopped, /flash-completion door refused .* HTTP 403/);
  assert.equal(refused.calls.length, 1, "the first refusal stops it");
  assert.ok(!opus.calls.some((c) => c.unit.id === "U01"), "the refused file is not handed to the lean Opus attempt");
  assert.ok(r.written < 3);
  // Symmetric: a solo run whose Claude login is refused stops the same way.
  const bad = fake("lean-opus", "opus", () => ({ answer: null, error: "authentication_failed", error_status: 401, cost: 0 }));
  const s2 = await executeStage(SPEC, OPTS(SOLO, mkdtempSync(join(tmpdir(), "exec-")), { concurrency: 1 }), { typistFor: () => bad, fallback: bad, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.match(s2.stopped, /lean-opus door refused .* HTTP 401/);
  assert.equal(bad.calls.length, 1);
});

/*
 * A fix may create a file, for a finding that asks for code to move into a new one. A missing
 * file is never guessed from a finding's path — the reviewer writes paths from the project root,
 * so a new name could mean two places — the orchestrator, which knows the code directory, asks
 * for it explicitly with new_file and a path relative to the code directory. The file is held to
 * the same checks as every file the executor writes.
 */
test("a fix may create a new file: asked for with new_file and a path relative to the code directory, it is typed whole and written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/setup.py", content: "def setup():\n    return 1\n" } }));
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [
    { path: "app/setup.py", new_file: true, problems: ["major: the start-up code is written twice — fix: move it into app/setup.py"] },
  ] }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: (u, a) => checkAnswer(u, a) });
  assert.equal(r.written, 1);
  assert.deepEqual(r.created, ["app/setup.py"]);
  assert.deepEqual(r.not_routed, []);
  assert.equal(readFileSync(join(dir, "app/setup.py"), "utf8"), "def setup():\n    return 1\n");
  assert.match(flash.calls[0].framed, /### app\/setup\.py  — current text: the file does not exist yet/);
});

test("a new file is held to the same safety as every file: a path that leaves the code directory, even through a symlink, is reported and nothing is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(dir, "link"));
  const opus = fake("lean-opus", "opus");
  const r = await executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [
    { path: "../escape.py", new_file: true, problems: ["x"] },
    { path: "/etc/escape.py", new_file: true, problems: ["x"] },
    { path: "link/escape.py", new_file: true, problems: ["x"] },
  ] }), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.deepEqual(r.not_routed.map((x) => x.file), ["../escape.py", "/etc/escape.py", "link/escape.py"]);
  assert.equal(r.units, 0);
  assert.equal(opus.calls.length, 0);
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
});

test("without new_file a missing file is still never guessed, and the reply says how to ask for a new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const r = await executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [{ path: "app/setup.py", problems: ["x"] }] }), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.units, 0);
  assert.match(r.not_routed[0].reason, /new_file: true/);
  assert.equal(existsSync(join(dir, "app/setup.py")), false);
});

test("new_file on a file that already exists is an ordinary fix of that file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app/models.py"), "def thing():\n    return 0\n");
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/models.py", edits: [{ search: "return 0", replace: "return 1" }] } }));
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [{ path: "app/models.py", new_file: true, problems: ["x"] }] }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.written, 1);
  assert.deepEqual(r.created ?? [], []);
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 1\n");
});

test("execute_stage carries new_file from a failure through to the repair job", () => {
  const items = failureRepairs([{ path: "app/setup.py", problem: "p", new_file: true }, { path: "app/models.py", problem: "q", context_paths: ["t.py"] }]);
  assert.deepEqual(items, [
    { path: "app/setup.py", problems: ["p"], context_paths: [], new_file: true },
    { path: "app/models.py", problems: ["q"], context_paths: ["t.py"] },
  ]);
  const schema = EXECUTOR_TOOLS.find((t) => t.name === "execute_stage").inputSchema.properties.failures.items.properties;
  assert.equal(schema.new_file.type, "boolean");
});

// ─── One run, one policy ───────────────────────────────────────────────
// The lock belongs to one run, not to the chat (one server process): a run is its spec file, and the first
// stage of a spec binds the auth mode and policy pre-flight recorded. A separate /mmo: run in the same chat
// may use another policy or auth mode, which brownfield's per-run policy choice at Gate 0 relies on.

/** A spec on disk with no docs units: a docs stage types nothing, so no typist is ever called. */
function specOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), "run-lock-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(SPEC));
  return { dir, specPath };
}
const policyOf = (run) => (run.policyName === "opus-only-v5" ? SOLO : ORCH);
const stage = (specPath, dir, runState) => handleExecutorTool(
  "execute_stage",
  { spec_path: specPath, stage: "docs", code_dir: dir, telemetry_path: join(dir, "telemetry.jsonl") },
  { run: () => runState, policy: policyOf, overrides: {} },
);

test("a run cannot switch policy or auth mode halfway: the next stage of the same spec stops, with the reason, and types nothing", async () => {
  const { dir, specPath } = specOnDisk();
  const first = { authMode: "estimated", policyName: "opus-plus-flash-v38" };
  const ok = await stage(specPath, dir, first);
  assert.notEqual(ok.isError, true, ok.content[0].text);
  const switchedPolicy = await stage(specPath, dir, { ...first, policyName: "opus-only-v5" });
  assert.equal(switchedPolicy.isError, true);
  const r = JSON.parse(switchedPolicy.content[0].text);
  assert.match(r.stopped, /started its stages under policy opus-plus-flash-v38; the latest pre-flight asked for opus-only-v5/);
  assert.match(r.stopped, /cannot switch/);
  assert.equal(r.written, 0);
  const switchedAuth = await stage(specPath, dir, { ...first, authMode: "vendor" });
  assert.match(JSON.parse(switchedAuth.content[0].text).stopped, /auth mode estimated; the latest pre-flight asked for vendor/);
  // Back on the run's own settings, the run goes on.
  assert.notEqual((await stage(specPath, dir, first)).isError, true);
});

test("two separate runs in one chat may use different policies: each run binds its own", async () => {
  const a = specOnDisk();
  const b = specOnDisk();
  assert.notEqual((await stage(a.specPath, a.dir, { authMode: "estimated", policyName: "opus-plus-flash-v38" })).isError, true);
  const second = await stage(b.specPath, b.dir, { authMode: "estimated", policyName: "opus-only-v5" });
  assert.notEqual(second.isError, true, second.content[0].text);
});

test("pre-flight does not lock the chat: a second pre-flight for a new run with another policy is not refused", async () => {
  // The real server over stdio. Both policies are Opus-only and the mode is estimated, so pre-flight has no
  // model to reach: no network, no credential.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "run-lock-home-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: process.env.PATH, HOME: home }, stderr: "ignore" });
  const client = new Client({ name: "run-lock-test", version: "0" });
  await client.connect(transport);
  try {
    const preflight = async (policy_name) => JSON.parse((await client.callTool({ name: "preflight_dispatch", arguments: { auth_mode: "estimated", policy_name, project_root: home } })).content[0].text);
    const first = await preflight("opus-only-v5");
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await preflight("opus-only");
    assert.equal(second.ok, true, JSON.stringify(second));
  } finally {
    await client.close();
  }
});

// ─── Typists are built when they are needed ────────────────────────────

test("the lean Opus last attempt is built only when a job reaches it: a stage its routed typists finish never needs the claude CLI", async () => {
  const { stageTypists } = executorTools;
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const built = [];
  const flash = fake("flash-completion", "flash-completion");
  // Building the Claude typist fails the way an old claude CLI makes it fail.
  const build = (leaf) => { built.push(leaf.id); if (leaf.id === "opus") throw new Error("this claude CLI lists no --tools flag, so the lean Opus typist cannot run; nothing was sent"); return flash; };
  const t = stageTypists(ORCH, "estimated", {}, build);
  assert.equal(t.fallback.door, "lean-opus");
  assert.equal(t.fallback.modelId, "opus");
  assert.deepEqual(built, [], "nothing is built before a job needs it");
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: t.typistFor, fallback: t.fallback, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(r.written, 1);
  assert.deepEqual(built, ["flash-completion"], "Flash typed the file; the Claude typist was never built");
  assert.equal(t.typistFor("flash-completion"), t.typistFor("flash-completion"), "one typist per model for the whole call");
});

test("a job that reaches its last attempt builds the lean Opus typist then; if this machine cannot run it, that attempt fails with the reason and the stage goes on", async () => {
  const { stageTypists } = executorTools;
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const refusing = fake("flash-completion", "flash-completion", () => ({ answer: null, error: "not an object" }));
  const build = (leaf) => { if (leaf.id === "opus") throw new Error("this claude CLI lists no --tools flag, so the lean Opus typist cannot run; nothing was sent"); return refusing; };
  const t = stageTypists(ORCH, "estimated", {}, build);
  const events = [];
  const r = await executeStage({ ...SPEC, units: SPEC.units.slice(0, 2) }, OPTS(ORCH, dir), { typistFor: t.typistFor, fallback: t.fallback, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(r.written, 0);
  assert.equal(r.failed.length, 2);
  const last = events.filter((e) => e.door === "lean-opus");
  assert.equal(last.length, 2, "each job's last attempt is recorded");
  for (const e of last) assert.match(e.error, /lists no --tools flag/);
  assert.equal(r.cost_usd, 0.04, "the four routed calls; the lean Opus attempts sent nothing");
});

test("the lean Opus typist a routed attempt uses is the same one the last attempt uses, so the model's cache warm-up is shared", () => {
  const { stageTypists } = executorTools;
  const opus = fake("lean-opus", "opus");
  const t = stageTypists(SOLO, "estimated", {}, () => opus);
  assert.equal(t.typistFor("opus"), t.fallback);
});

// ─── The real server, with a stand-in claude CLI ───────────────────────
// Only the stand-in's folder and the system folders are on the server's PATH, so no real claude can be reached.

const FULL_HELP = ["-p, --print", "--output-format <format>", "--model <model>", "--tools <tools...>", "--append-system-prompt-file <file>", "--effort <level>", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"].map((l) => `  ${l}  x`).join("\n");
const OLD_HELP = ["-p, --print", "--output-format <format>", "--model <model>", "--append-system-prompt <prompt>"].map((l) => `  ${l}  x`).join("\n");

/** A stand-in `claude`: its --version, its --help, and for a typist call the receipt given (or no answer). */
function standInClaude({ version, help, receipt }) {
  const bin = mkdtempSync(join(tmpdir(), "standin-claude-"));
  writeFileSync(join(bin, "help.txt"), help + "\n");
  writeFileSync(join(bin, "receipt.json"), receipt ? JSON.stringify(receipt) : "");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in\n  --version) echo "${version} (Claude Code)"; exit 0;;\n  --help) cat "${bin}/help.txt"; exit 0;;\nesac\ncat > /dev/null\ncat "${bin}/receipt.json"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

async function serverWith(bin, extraEnv = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "stage-home-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MMO_LOG_LEVEL: "error", ...extraEnv }, stderr: "ignore" });
  const client = new Client({ name: "stage-test", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content[0].text }; };
  return { client, call, home };
}

test("with a claude CLI too old for the lean Opus typist, a stage whose files Flash types still runs: the last attempt is not built up front", async () => {
  const bin = standInClaude({ version: "1.0.99", help: OLD_HELP });
  const { client, call, home } = await serverWith(bin, { GEMINI_API_KEY: "fake-not-real", GEMINI_BACKEND: "api-key" });
  try {
    const pre = await call("preflight_dispatch", { auth_mode: "estimated", policy_name: "opus-plus-flash-v38", project_root: home });
    assert.equal(pre.isError, false, pre.text);
    const { dir, specPath } = specOnDisk();
    const r = await call("execute_stage", { spec_path: specPath, stage: "docs", code_dir: dir, telemetry_path: join(dir, "telemetry.jsonl") });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).units, 0);
  } finally {
    await client.close();
  }
});

test("execute_stage types into a code_dir that does not exist yet: the folder is created, not left to the orchestrator", async () => {
  const receipt = { type: "result", subtype: "success", is_error: false, result: JSON.stringify(GOOD(SPEC.units[0])), usage: { input_tokens: 10, output_tokens: 5 } };
  const bin = standInClaude({ version: "2.1.283", help: FULL_HELP, receipt });
  const { client, call, home } = await serverWith(bin);
  try {
    const pre = await call("preflight_dispatch", { auth_mode: "estimated", policy_name: "opus-only-v5", project_root: home });
    assert.equal(JSON.parse(pre.text).ok, true, pre.text);
    const dir = mkdtempSync(join(tmpdir(), "fresh-project-"));
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify({ ...SPEC, units: [SPEC.units[0]] }));
    const codeDir = join(dir, "src");
    const r = await call("execute_stage", { spec_path: specPath, stage: "codegen", code_dir: codeDir, telemetry_path: join(dir, "telemetry.jsonl") });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).written, 1, r.text);
    assert.equal(readFileSync(join(codeDir, "app", "models.py"), "utf8"), GOOD(SPEC.units[0]).content);
  } finally {
    await client.close();
  }
});
