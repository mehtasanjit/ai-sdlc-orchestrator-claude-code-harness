/**
 * Once a stage has stopped (a door refused its login, or Google could not serve a model for the busy ledger's whole
 * window), no further call is sent: whatever came back would be discarded, so a call sent after the stop is paid for
 * and thrown away. And every call that was sent is recorded once: a call the runner waited on before the stop has its
 * event already, and the stop does not write it a second time. Offline: fake typists, the stop made by another job
 * while this one waits, ordered with promises (no timers to race).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { executeStage } = await import(join(DIST, "executor", "run.js"));
const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));
const { BusyLedger } = await import(join(DIST, "busyLedger.js"));

const POLICY = loadPolicyFromPath(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "opus-only-v5.yaml"));
const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "thing", params: [], returns: "int" }], behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5 });
const SPEC = (n) => ({ spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: Array.from({ length: n }, (_, i) => unit(`U0${i + 1}`, `app/m${i + 1}.py`)) });
const ZERO = { input: 0, input_cached: 0, output: 0 };
const GOOD = (req) => ({ answer: { path: req.unit.path, content: "def thing():\n    return 1\n" }, transport: false, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.01, latency_ms: 1 });
const REFUSED_LOGIN = { answer: null, error: "HTTP 401 UNAUTHENTICATED", error_status: 401, transport: false, tokens: ZERO, cost_usd: 0, latency_ms: 1 };
const UNAVAILABLE = "refused at global (7 requests over 104 s; last HTTP 429 RESOURCE_EXHAUSTED)";
const deferred = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };
/** Lets every continuation already queued run (the other job's typist has returned and its result is read). */
const settle = () => new Promise((r) => setImmediate(r));

/** A typist whose answers come from `plan(req, n)`, the job's own n-th call; every request is kept. */
function typist(door, modelId, plan) {
  const calls = [];
  return { door, modelId, modelName: `${modelId}-model`, calls, async type(req) { calls.push(req.unit.id); return plan(req, calls.filter((id) => id === req.unit.id).length); } };
}

async function stage(n, deps, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stage-stopped-"));
  const events = [];
  try {
    const receipt = await executeStage(SPEC(n), { stage: "codegen", codeDir: dir, passId: "p1", policy: POLICY, concurrency: n, routedAttempts: 1, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 }, ...over },
      { shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: () => ({ ok: true }), random: () => 0.5, ...deps });
    return { receipt, events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a stage whose model's window closes while a call waits to be resent records that call once", async () => {
  // One job, every call unavailable and nothing of the model served: the window passes during the wait before the
  // resend, the stage stops with Google's reason, and the call it waited on is the one call and the one event.
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const flash = typist("agy", "flash", () => { clock.ms += 299_600; return { answer: null, error: `Google could not serve flash-model: ${UNAVAILABLE}`, transport: false, error_status: 429, unavailable: UNAVAILABLE, tokens: ZERO, cost_usd: 0.002, latency_ms: 299_600 }; });
  const opus = typist("lean-opus", "opus", () => { throw new Error("never the lean Opus attempt"); });
  const { receipt, events } = await stage(1, { typistFor: () => flash, fallback: opus, ledger, now: () => clock.ms, sleep: async (ms) => { clock.ms += ms; } });
  assert.match(String(receipt.stopped), /Google could not serve flash-model/, JSON.stringify(receipt));
  assert.equal(flash.calls.length, 1, "no call once the window closed during the wait");
  assert.equal(receipt.calls, 1);
  assert.equal(events.length, 1, `one event for the one call: ${JSON.stringify(events.map((e) => e.retry_reason ?? "final"))}`);
  assert.equal(events[0].cost_usd, 0.002, "billed once");
  assert.deepEqual(opus.calls, []);
});

test("a job waiting to resend an unavailable call while another job's refused login stops the stage sends nothing more, and its call is recorded once", async () => {
  const stopped = deferred();
  const flash = typist("agy", "flash", (req) => (req.unit.id === "U02"
    ? REFUSED_LOGIN
    : { answer: null, error: `Google could not serve flash-model: ${UNAVAILABLE}`, transport: false, error_status: 429, unavailable: UNAVAILABLE, tokens: ZERO, cost_usd: 0.002, latency_ms: 1 }));
  // U01's wait before its resend ends only once U02's call has come back refused and stopped the stage.
  const flashU02 = flash.type.bind(flash);
  flash.type = async (req) => { const r = await flashU02(req); if (req.unit.id === "U02") settle().then(stopped.resolve); return r; };
  const opus = typist("lean-opus", "opus", GOOD);
  const { receipt, events } = await stage(2, { typistFor: () => flash, fallback: opus, sleep: async () => { await stopped.promise; } });
  assert.match(String(receipt.stopped), /agy door refused the call with HTTP 401/, JSON.stringify(receipt));
  assert.deepEqual(flash.calls.filter((id) => id === "U01"), ["U01"], "U01 is not sent again after the stop");
  assert.equal(receipt.calls, 2, "two calls sent");
  assert.deepEqual(events.map((e) => e.task_id).sort(), ["U01", "U02"], "one event per call");
  assert.deepEqual(opus.calls, [], "never handed to the lean Opus attempt");
  assert.deepEqual(receipt.failed.map((f) => f.reason), ["stopped: the door refused the login or permission", "stopped: the door refused the login or permission"]);
});

test("a job waiting out a transport failure while another job's refused login stops the stage sends nothing more, and its call is recorded once", async () => {
  const stopped = deferred();
  const flash = typist("flash-completion", "flash", (req) => (req.unit.id === "U02"
    ? REFUSED_LOGIN
    : { answer: null, error: "HTTP 503 UNAVAILABLE", error_status: 503, transport: true, tokens: ZERO, cost_usd: 0, latency_ms: 1 }));
  const inner = flash.type.bind(flash);
  flash.type = async (req) => { const r = await inner(req); if (req.unit.id === "U02") settle().then(stopped.resolve); return r; };
  const opus = typist("lean-opus", "opus", GOOD);
  const { receipt, events } = await stage(2, { typistFor: () => flash, fallback: opus, sleep: async () => { await stopped.promise; } });
  assert.match(String(receipt.stopped), /flash-completion door refused the call with HTTP 401/, JSON.stringify(receipt));
  assert.deepEqual(flash.calls.filter((id) => id === "U01"), ["U01"], "U01 is not sent again after the stop");
  assert.equal(receipt.calls, 2, "two calls sent");
  assert.deepEqual(events.map((e) => e.task_id).sort(), ["U01", "U02"], "one event per call");
  assert.deepEqual(opus.calls, [], "never handed to the lean Opus attempt");
});

test("a job waiting for the lean Opus cache warm-up when another job's refused login stops the stage is not sent to Opus", async () => {
  // U01 and U03 fail their routed attempt and reach the lean Opus attempt; U01's call warms the cache, so U03 waits for
  // it. While U01's Opus call is out, U02's call comes back refused and stops the stage: U03's Opus call is never sent
  // (the stage would discard its answer), and U01's, sent before the stop, is recorded once.
  const warming = deferred();
  const refusedBack = deferred();
  const flash = typist("flash-completion", "flash", (req) => (req.unit.id === "U02" ? REFUSED_LOGIN : { answer: { path: "elsewhere.py", content: "x = 1\n" }, transport: false, tokens: { input: 50, input_cached: 0, output: 5 }, cost_usd: 0.001, latency_ms: 1 }));
  const inner = flash.type.bind(flash);
  flash.type = async (req) => {
    if (req.unit.id === "U02") { await warming.promise; await settle(); }
    const r = await inner(req);
    if (req.unit.id === "U02") settle().then(refusedBack.resolve);
    return r;
  };
  const opus = typist("lean-opus", "opus", GOOD);
  const innerOpus = opus.type.bind(opus);
  opus.type = async (req) => { warming.resolve(); await refusedBack.promise; return innerOpus(req); };
  const { receipt, events } = await stage(3, { typistFor: () => flash, fallback: opus });
  assert.match(String(receipt.stopped), /flash-completion door refused the call with HTTP 401/, JSON.stringify(receipt));
  assert.equal(opus.calls.length, 1, `only the call that was already out reached Opus: ${opus.calls}`);
  assert.equal(receipt.calls, 4, "three routed calls and the one Opus call");
  assert.equal(events.length, 4, `one event per call: ${events.map((e) => `${e.task_id}/${e.door}`)}`);
  assert.equal(receipt.failed.length, 3, JSON.stringify(receipt.failed));
});
