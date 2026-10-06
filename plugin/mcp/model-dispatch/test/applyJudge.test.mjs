/**
 * What judges a brownfield packet's answer, and what happens before any typist is paid (apply.ts runApplyLoop):
 * a fix round's checks all judge (no baseline), the reproducing test is never handed to a fix round, a reproducing
 * test added to a file that already fails is refused, a formatter never rewrites the judge, greenfield's answer check
 * (its own path, not empty) runs before a write, a packet that cannot be written or whose commands the person's
 * settings forbid costs nothing, every vendor failure is an attempt on greenfield's ladder, and the record of each
 * attempt means what greenfield's does. Stub models and temp folders: no model is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const { runApplyLoop, normalizeApply, refinePacket, FILE_OUTPUT_SCHEMA, commandDeniedBy } = await import(join(DIST, "apply.js"));
const { typistResult, TypistApplyAdapter } = await import(join(DIST, "applyTypist.js"));
const bashRules = await import(join(HERE, "..", "..", "..", "scripts", "ambient", "lib", "bash-rules.mjs"));

// The machine's own Claude settings (managed, and the person's) must not change what these tests see.
process.env.MMO_MANAGED_SETTINGS = join(tmpdir(), "mmo-no-managed-settings.json");
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mmo-apply-judge-config-"));

const tmpRoot = () => mkdtempSync(join(tmpdir(), "mmo-apply-judge-"));
const silent = () => {};
const FLASH = { modelId: "flash", reason: "policy", ruleIndex: 0 };
const LAST = () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 });
const packet = (over = {}) => ({
  id: "tp_codegen_001", phase: "codegen", task_type: "", module: "spec", pass_id: "r", instruction: "Write the file.",
  inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/out.ts", ...over,
});
const has = (word) => `node -e "process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('${word}')?0:1)" {path}`;
const lacks = (word) => `node -e "process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('${word}')?1:0)" {path}`;
const MARK = (name) => `node -e "require('fs').appendFileSync('${name}','x')"`;

/**
 * A stub dispatch: each call pops the next scripted reply. A reply is an answer object, `{fail: {...}}` (a failed call
 * with the vendor's fields), `{throws: "msg"}`, or a function of the packet.
 */
function stub(replies, decision = () => FLASH) {
  const calls = [];
  const dispatch = async (p, force) => {
    calls.push({ packet: p, force });
    let r = replies.shift() ?? { content: "fallback\n" };
    if (typeof r === "function") r = r(p);
    if (r.throws) throw new Error(r.throws);
    const d = force ?? decision(p);
    const events = [{ task_id: p.id, retry_count: p.retry_count ?? 0, success: !r.fail }];
    if (r.fail) {
      const f = r.fail;
      return {
        decision: d, events,
        result: { success: false, error: f.error ?? "failed", result: null, tokens: { input: 1, input_cached: 0, output: f.replied ? 3 : 0 }, cost_usd: f.cost ?? 0,
          terminal_reason: f.terminal ?? "vendor_error",
          attempts: [{ error_status: f.status, error_code: f.code, retry_after_ms: f.retryAfter, ...(f.transient ? { transient: true } : {}) }] },
      };
    }
    return { decision: d, events, result: { success: true, result: { path: p.artifact_path, ...r }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: r.cost ?? 0.01, terminal_reason: "success" } };
  };
  return { calls, dispatch };
}
const loop = (over) => runApplyLoop({ projectRoot: over.root, keepEvents: true, route: () => FLASH, log: silent, ...over });
const sleeps = () => { const waited = []; return { waited, sleep: async (ms) => { waited.push(ms); } }; };

// ---------------------------------------------------------------------------------------------------------------
// A fix round is judged: its file fails a check, which is why the round exists, so no check is set aside for it.
// ---------------------------------------------------------------------------------------------------------------

test("a fix packet (baseline: false) is judged by every check: a fix that leaves its file failing is never applied", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "BROKEN\n");
  const apply = normalizeApply({ write: true, mode: "edits", baseline: false, checks: [{ id: "good", run: has("GOOD") }], max_retries: 1 });
  assert.equal(apply.baseline, false, "normalizeApply keeps the fix packet's baseline: false");
  const m = stub([{ edits: [{ search: "BROKEN", replace: "STILL-BROKEN" }] }, { edits: [{ search: "BROKEN", replace: "STILL-BROKEN" }] }]);
  const out = await loop({ root, packet: packet({ phase: "debug", id: "tp_debug_r1_001" }), apply, dispatch: m.dispatch });
  assert.equal(out.status, "verify_failed", JSON.stringify(out.attempts));
  assert.equal(out.set_aside, undefined, "nothing set aside: the run's own failure is what the fix must cure");
  assert.equal(m.calls.length, 2, "the ladder's retry is used, with the failure");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "BROKEN\n", "the failed edit is undone");
  // The same packet with a fix that cures it is applied on its second attempt.
  const good = stub([{ edits: [{ search: "BROKEN", replace: "STILL-BROKEN" }] }, { edits: [{ search: "BROKEN", replace: "GOOD" }] }]);
  const ok = await loop({ root, packet: packet({ phase: "debug", id: "tp_debug_r1_001" }), apply, dispatch: good.dispatch });
  assert.equal(ok.status, "applied");
  assert.equal(good.calls.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("a packet without baseline: false still has its checks tried on the file before the change", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "BROKEN\n");
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "good", run: has("GOOD") }] }), dispatch: stub([{ edits: [{ search: "BROKEN", replace: "X" }] }]).dispatch });
  assert.equal(out.status, "applied");
  assert.deepEqual(out.set_aside.map((c) => c.id), ["good"]);
  rmSync(root, { recursive: true, force: true });
});

// The reproducing test is the judge of a bugfix: a fix round never edits it.
function bugfixRun(root, runId = "r1") {
  mkdirSync(join(root, ".sdlc", "runs", runId), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "test", "a.test.mjs"), "assert(add(2,2) === 4)\n");
  writeFileSync(join(root, "src", "a.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(root, ".sdlc", "runs", runId, "packets.json"), JSON.stringify([
    { id: "tp_tests_U01", artifact_path: "test/a.test.mjs", apply: { write: true, mode: "edits", checks: [{ id: "syntax", run: "true {path}" }, { id: "unit", run: "node --test '{path}'", expect: "fail" }] } },
    { id: "tp_codegen_U02", artifact_path: "src/a.mjs", apply: { write: true, mode: "edits", checks: [{ id: "syntax", run: "true {path}" }] } },
  ]));
}

test("a fix packet aimed at the reproducing test's own file is refused before any typist is paid", async () => {
  const root = tmpRoot();
  bugfixRun(root);
  const apply = normalizeApply({ write: true, mode: "edits", baseline: false, checks: [{ id: "unit", run: "true {path}" }] });
  const m = stub([{ edits: [{ search: "=== 4", replace: "=== 0" }] }]);
  const out = await loop({ root, runId: "r1", packet: packet({ phase: "debug", id: "tp_debug_r1_001", artifact_path: "test/a.test.mjs" }), apply, dispatch: m.dispatch });
  assert.equal(out.status, "refused");
  assert.match(out.refusal, /the reproducing test judges the fix; a problem in it goes back to the architect/);
  assert.equal(m.calls.length, 0);
  assert.equal(readFileSync(join(root, "test", "a.test.mjs"), "utf8"), "assert(add(2,2) === 4)\n");
  // A fix packet on the code under fault goes ahead.
  const fix = stub([{ edits: [{ search: "a - b", replace: "a + b" }] }]);
  const ok = await loop({ root, runId: "r1", packet: packet({ phase: "debug", id: "tp_debug_r1_002", artifact_path: "src/a.mjs" }), apply, dispatch: fix.dispatch });
  assert.equal(ok.status, "applied");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// A reproducing check proves something only when the test file did not already fail before the change.
// ---------------------------------------------------------------------------------------------------------------

test("a reproducing test added to a test file that already fails is refused before any typist is paid", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "test"));
  // The red check exits 1 while the file holds a failing case ("FAILS") or the new reproducing case.
  const RED = `node -e "const t=require('fs').readFileSync(process.argv[1],'utf8');process.exit(/FAILS|reproduces/.test(t)?1:0)" {path}`;
  writeFileSync(join(root, "test", "a.test.mjs"), "case old: FAILS\n");
  const apply = normalizeApply({ write: true, mode: "edits", checks: [{ id: "syntax", run: "true {path}" }, { id: "unit", run: RED, expect: "fail" }] });
  const m = stub([{ edits: [{ search: "case old: FAILS\n", replace: "case old: FAILS\ncase new: passes on the bug\n" }] }]);
  const out = await loop({ root, packet: packet({ phase: "tests", artifact_path: "test/a.test.mjs" }), apply, dispatch: m.dispatch });
  assert.equal(out.status, "refused");
  assert.equal(out.refusal, "test/a.test.mjs: the test file already fails before the change, so its failure cannot show that the new case reproduces the bug: point the red check at the new case only, or put the case in a new test file");
  assert.equal(m.calls.length, 0);
  // The same edit on a test file that passes before the change goes ahead, and is judged by its red check.
  writeFileSync(join(root, "test", "a.test.mjs"), "case old: passes\n");
  const ok = stub([{ edits: [{ search: "case old: passes\n", replace: "case old: passes\ncase new: reproduces\n" }] }]);
  const o2 = await loop({ root, packet: packet({ phase: "tests", artifact_path: "test/a.test.mjs" }), apply, dispatch: ok.dispatch });
  assert.equal(o2.status, "applied", JSON.stringify(o2.attempts));
  rmSync(root, { recursive: true, force: true });
});

// A formatter must not rewrite the judge: a reproducing check's write form never runs, whatever else was set aside.
test("a reproducing check's write form never runs, whether or not another check was set aside", async () => {
  const a = normalizeApply({ write: true, checks: [{ id: "lint", run: "lint '{path}'", fix: "lint --write '{path}'" }, { id: "test", run: "t '{path}'", fix: "t --fmt '{path}'", expect: "fail" }] });
  assert.deepEqual(a.format, ["lint --write '{path}'"]);
  for (const styleFails of [false, true]) {
    const root = tmpRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "style.ts"), styleFails ? "BAD\n" : "ok\n");
    const apply = normalizeApply({ write: true, baseline_from: "src/style.ts", checks: [{ id: "lint", run: lacks("BAD") }, { id: "red", run: "exit 1", fix: MARK("red-fix-ran"), expect: "fail" }] });
    const out = await loop({ root, packet: packet({ artifact_path: "test/new.test.ts" }), apply, dispatch: stub([{ content: "reproduces\n" }]).dispatch });
    assert.equal(out.status, "applied");
    assert.equal(existsSync(join(root, "red-fix-ran")), false, `style file ${styleFails ? "fails" : "passes"} lint`);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Greenfield's answer check before a write: the answer names the packet's own file, and the file is not empty.
// ---------------------------------------------------------------------------------------------------------------

test("an answer naming another file, or an empty file, is a failed attempt with greenfield's reason, never written", async () => {
  const root = tmpRoot();
  const m = stub([{ path: "src/b.ts", content: "export const b = 2;\n" }, { content: "   \n" }, { content: "good\n" }]);
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true }), dispatch: m.dispatch });
  assert.equal(out.status, "applied");
  assert.equal(m.calls.length, 3);
  assert.match(m.calls[1].packet.instruction, /the answer names src\/b\.ts, not src\/out\.ts/);
  assert.match(m.calls[2].packet.instruction, /the file is empty/);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "good\n");
  // Edits mode: the whole-file form with an empty file, and an edit list naming another file.
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "util.mjs"), "export const u = 1;\n");
  const e = stub([{ content: "" }, { path: "lib/other.mjs", edits: [{ search: "u = 1", replace: "u = 2" }] }]);
  const o2 = await loop({ root, packet: packet({ artifact_path: "lib/util.mjs" }), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "syntax", run: "true {path}" }], max_retries: 1 }), dispatch: e.dispatch });
  assert.equal(o2.status, "no_content");
  assert.match(o2.attempts[0].failure, /the file is empty/);
  assert.match(o2.attempts[1].failure, /the answer names lib\/other\.mjs, not lib\/util\.mjs/);
  assert.equal(readFileSync(join(root, "lib", "util.mjs"), "utf8"), "export const u = 1;\n");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// A packet that ends with nothing usable leaves nothing of its own on disk.
// ---------------------------------------------------------------------------------------------------------------

test("a new file whose packet ends without an answer that stands is not left on disk", async () => {
  const root = tmpRoot();
  const noReply = { fail: { error: "no reply", terminal: "no_answer" } };
  const m = stub([{ content: "WRONG\n" }, noReply]);
  const out = await loop({ root, runId: "run-1", packet: packet({ artifact_path: "src/deep/new.txt" }), apply: normalizeApply({ write: true, verify: [has("RIGHT")], max_retries: 1 }), dispatch: m.dispatch });
  assert.equal(out.status, "dispatch_failed");
  assert.equal(existsSync(join(root, "src", "deep", "new.txt")), false, "the earlier attempt that failed its check is gone");
  assert.equal(existsSync(join(root, "src")), false, "and the folders the packet made for it");
  const rec = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-1", "provenance.json"), "utf8")).files_touched.find((f) => f.path === "src/deep/new.txt");
  assert.equal(rec.sha_after, null, "the record says the file is as it was: absent");
  // An existing file rewritten whole comes back as it was when the packet ends with no content.
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "a.txt"), "ORIG\n");
  const g = stub([{ content: "WRONG\n" }, { fail: { error: "not json", terminal: "invalid_answer", replied: true } }]);
  const o2 = await loop({ root, packet: packet({ artifact_path: "lib/a.txt" }), apply: normalizeApply({ write: true, verify: [has("RIGHT")], max_retries: 1 }), dispatch: g.dispatch });
  assert.equal(o2.status, "no_content");
  assert.equal(readFileSync(join(root, "lib", "a.txt"), "utf8"), "ORIG\n");
  // verify_failed keeps the last attempt on disk, as the status table says, for the fix round that follows.
  const v = stub([{ content: "WRONG\n" }, { content: "WRONG2\n" }]);
  const o3 = await loop({ root, packet: packet({ artifact_path: "lib/b.txt" }), apply: normalizeApply({ write: true, verify: [has("RIGHT")], max_retries: 1 }), dispatch: v.dispatch });
  assert.equal(o3.status, "verify_failed");
  assert.equal(readFileSync(join(root, "lib", "b.txt"), "utf8"), "WRONG2\n");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Nothing is paid for a packet that cannot be written, or whose commands the person's settings forbid.
// ---------------------------------------------------------------------------------------------------------------

test("a packet the write contract refuses costs no typist call, with or without a run id", async () => {
  for (const runId of [undefined, "run-1"]) {
    const root = tmpRoot();
    const m = stub([{ content: "SECRET=1\n" }]);
    const out = await loop({ root, runId, packet: packet({ artifact_path: ".env.local" }), apply: normalizeApply({ write: true }), dispatch: m.dispatch });
    assert.equal(out.status, "refused");
    assert.match(out.refusal, /off-limits/);
    assert.equal(m.calls.length, 0);
    assert.equal(out.cost_usd, 0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packet whose check the person's Claude settings deny is refused before any command runs or any typist is paid", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
  writeFileSync(join(root, "victim.txt"), "keep\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "a\n");
  const m = stub([{ edits: [{ search: "a", replace: "b" }] }]);
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "c", run: "rm -f victim.txt && test -f {path}" }] }), dispatch: m.dispatch });
  assert.equal(out.status, "refused");
  assert.match(out.refusal, /Bash\(rm:\*\)/);
  assert.equal(readFileSync(join(root, "victim.txt"), "utf8"), "keep\n", "not even the baseline ran it");
  assert.equal(m.calls.length, 0);
  // With no rule against it, the same command runs.
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] } }));
  const ok = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "c", run: "rm -f victim.txt && test -f {path}" }] }), dispatch: stub([{ edits: [{ search: "a", replace: "b" }] }]).dispatch });
  assert.equal(ok.status, "applied");
  rmSync(root, { recursive: true, force: true });
});

test("the server reads the person's deny rules exactly as zero-touch's hook does (lib/bash-rules.mjs)", () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)", "Bash(curl *)", "Bash(npm test)", "Read(./x)"] } }));
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ permissions: { deny: ["Bash(printenv:*)"] } }));
  const cases = ["rm -rf x", "rmdir x", "echo a && rm x", "FOO=1 rm x", "curl -s https://example.invalid", "npm test", "npm test -- -u", "printenv", "true | printenv HOME", "node --check a.mjs", "ls; cat x", ""];
  for (const c of cases) assert.equal(commandDeniedBy(c, root, process.env), bashRules.deniedBy(c, root, process.env), c);
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash"] } }));
  for (const c of cases.slice(0, 3)) assert.equal(commandDeniedBy(c, root, process.env), bashRules.deniedBy(c, root, process.env), c);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// Every vendor failure is an attempt on greenfield's ladder (executor/run.ts typeJob), never the end of the packet.
// ---------------------------------------------------------------------------------------------------------------

const FAST = { maxWaits: 2, baseMs: 1, capMs: 60_000 };

test("a vendor failure that is neither busy nor a refused login is an attempt: the ladder carries on to its last model", async () => {
  const root = tmpRoot();
  const m = stub([{ fail: { status: 400, error: "prompt too long" } }, { fail: { status: 404, error: "no such model" } }, { content: "good\n" }]);
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true }), dispatch: m.dispatch, lastAttempt: LAST });
  assert.equal(out.status, "applied");
  assert.deepEqual(m.calls.map((c) => c.force?.modelId ?? "routed"), ["routed", "routed", "opus"]);
  assert.match(m.calls[1].packet.instruction, /prompt too long/);
  rmSync(root, { recursive: true, force: true });
});

test("waits used up, or a pause longer than one rate-limit window, end that attempt, not the packet; each attempt has its own waits", async () => {
  const root = tmpRoot();
  const busy = { fail: { status: 503, error: "busy" } };
  const s1 = sleeps();
  const a = stub([busy, busy, busy, { content: "good\n" }]);
  const o1 = await loop({ root, packet: packet(), apply: normalizeApply({ write: true }), dispatch: a.dispatch, transport: FAST, sleep: s1.sleep, random: () => 0.5, lastAttempt: LAST });
  assert.equal(o1.status, "applied");
  assert.equal(a.calls.length, 4, "two waits, then the third busy reply is an attempt, then the next attempt");
  assert.equal(o1.transport_waits, 2);
  const s2 = sleeps();
  const b = stub([{ fail: { status: 429, retryAfter: 120_000, error: "quota" } }, { content: "good\n" }]);
  const o2 = await loop({ root, packet: packet(), apply: normalizeApply({ write: true }), dispatch: b.dispatch, transport: FAST, sleep: s2.sleep, random: () => 0.5 });
  assert.equal(o2.status, "applied");
  assert.deepEqual(s2.waited, [60_000], "one full window before the next attempt, so it does not hit the same wall at once");
  assert.match(b.calls[1].packet.instruction, /longer than one 60 s rate-limit window/);
  const s3 = sleeps();
  const c = stub([busy, busy, { content: "bad\n" }, busy, busy, { content: "good\n" }]);
  const o3 = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, verify: [has("good")] }), dispatch: c.dispatch, transport: FAST, sleep: s3.sleep, random: () => 0.5 });
  assert.equal(o3.status, "applied", "the second attempt gets its own two waits");
  assert.equal(o3.transport_waits, 4);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// The record of each attempt means what greenfield's does.
// ---------------------------------------------------------------------------------------------------------------

test("a wait is no attempt in the outcome; a retry keeps the planned packet's id, its attempt number and its reason", async () => {
  const root = tmpRoot();
  const s = sleeps();
  const m = stub([{ fail: { status: 429, error: "busy", transient: true } }, { content: "bad\n" }, { content: "good\n" }]);
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, verify: [has("good")] }), dispatch: m.dispatch, transport: FAST, sleep: s.sleep, random: () => 0.5 });
  assert.equal(out.status, "applied");
  assert.equal(out.attempts.length, 2, "two attempts; the wait is counted apart");
  assert.equal(out.transport_waits, 1);
  assert.deepEqual(m.calls.map((c) => [c.packet.id, c.packet.retry_count ?? 0]), [["tp_codegen_001", 0], ["tp_codegen_001", 0], ["tp_codegen_001", 1]]);
  assert.equal(m.calls[2].packet.retry_reason, "verify");
  const r = refinePacket(packet(), "x", "content", "error");
  assert.equal(r.id, "tp_codegen_001");
  assert.equal(r.retry_reason, "error");
  // The typist's record: attempt number from the ladder's slot, its retry reason, and a wait marked as one.
  const tok = { input: 1, input_cached: 0, output: 1 };
  const second = typistResult({ ...packet(), retry_count: 1, retry_reason: "verify" }, { answer: { path: "src/out.ts", content: "x" }, transport: false, tokens: tok, cost_usd: 0, latency_ms: 1 });
  assert.equal(second.attempts[0].attempt_number, 2);
  assert.equal(second.attempts[0].retry_reason, "verify");
  const wait = typistResult(packet(), { answer: null, transport: true, error_status: 429, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 1, error: "busy" });
  assert.equal(wait.attempts[0].retry_reason, "transport");
  rmSync(root, { recursive: true, force: true });
});

test("an attempt's event says success only when its answer was written and passed its checks, and every event is handed to the recorder (applyRecord.test.mjs has the rest)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "line1\n");
  const recorded = [];
  const m = stub([{ edits: [{ search: "missing", replace: "x" }] }, { edits: [{ search: "line1", replace: "line2" }] }]);
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits" }), dispatch: m.dispatch, record: (evs) => recorded.push(...evs) });
  assert.equal(out.status, "applied");
  assert.deepEqual(out.events.map((e) => e.success), [false, true]);
  assert.match(out.events[0].error, /appears 0 times/);
  assert.deepEqual(recorded.map((e) => e.success), [false, true], "the recorder gets each event once it is judged");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// A typist that throws is a failed attempt, never a lost packet.
// ---------------------------------------------------------------------------------------------------------------

test("a typist that throws is a failed attempt with its reason, as in greenfield's stage runner", async () => {
  const typist = { door: "lean-opus", modelId: "opus", modelName: "claude-opus-5", type: async () => { throw new Error("boom"); } };
  const ad = new TypistApplyAdapter({ id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5" }, typist);
  const r = await ad.execute({ ...packet(), apply: { write: true } });
  assert.equal(r.success, false);
  assert.equal(r.terminal_reason, "no_answer");
  assert.match(r.error, /the lean-opus typist failed: boom/);
});

test("a dispatch that throws mid-packet keeps the packet's cost and attempts, and its provenance matches the disk", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "ORIG\n");
  const m = stub([{ edits: [{ search: "ORIG", replace: "BAD" }], cost: 0.25 }, { throws: "spawn failed" }, { throws: "spawn failed" }]);
  const out = await loop({ root, runId: "run-1", packet: packet(), apply: normalizeApply({ write: true, mode: "edits", verify: [has("GOOD")] }), dispatch: m.dispatch });
  assert.equal(out.status, "dispatch_failed");
  assert.equal(out.cost_usd, 0.25);
  assert.equal(out.attempts.length, 3);
  assert.match(out.attempts[1].failure, /spawn failed/);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "ORIG\n");
  const rec = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-1", "provenance.json"), "utf8")).files_touched.find((f) => f.path === "src/out.ts");
  assert.equal(rec.sha_after, `sha256:${createHash("sha256").update("ORIG\n").digest("hex")}`);
  rmSync(root, { recursive: true, force: true });
});
