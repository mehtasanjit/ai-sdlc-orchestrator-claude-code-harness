/**
 * A call that keeps coming back `unavailable` is a wait only for a set time: once none of one packet's (or one stage
 * job's) own calls was served for the busy ledger's window, it ends as a failed dispatch with Google's reason, even
 * while other calls of the model are served (so the ledger does not stop the run). It is never handed to the Claude
 * leaf, the run goes on, and each of its calls is billed and recorded once, whether its window was found passed when
 * the call came back or during the wait before its resend. Offline: the apply loop and the stage runner on a fake
 * clock, with stubs whose calls advance it, and a ledger told that the run's other calls of the model are served
 * meanwhile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA } = await import(join(DIST, "apply.js"));
const { executeStage } = await import(join(DIST, "executor", "run.js"));
const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));
const { BusyLedger } = await import(join(DIST, "busyLedger.js"));

const MODEL = "gemini-3.8-flash";
const REFUSED = "refused at global (7 requests over 104 s; last HTTP 429 RESOURCE_EXHAUSTED)";
const S = 1000;
const ZERO = { input: 0, input_cached: 0, output: 0 };
/** Calls an engine with no bound of its own would go on sending for ever: the stub answers this one, so such a test ends. */
const GIVE_UP_AT = 20;
/**
 * How long each unavailable call takes, and how many are sent (the waits are the loops' own backoff, half its range):
 * with 120 s calls the window is found passed as the third call comes back (at 363 s in the apply loop); with the
 * longer ones the second comes back just inside it (299 s) and it passes during the wait before the third.
 */
const APPLY_CASES = [{ callSec: 120, calls: 3, when: "as its call came back" }, { callSec: 149, calls: 2, when: "during the wait before its resend" }];
const STAGE_CASES = [{ callSec: 120, calls: 3, when: "as its call came back" }, { callSec: 149.6, calls: 2, when: "during the wait before its resend" }];

async function applyCase({ callSec }) {
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const root = mkdtempSync(join(tmpdir(), "ledger-unserved-"));
  const calls = [];
  const decision = { modelId: "flash", reason: "policy", ruleIndex: 0 };
  const dispatch = async (packet, force) => {
    calls.push({ at: clock.ms, retry_count: packet.retry_count ?? 0, force: force?.modelId });
    const events = [{ task_id: packet.id, call: calls.length }];
    if (calls.length >= GIVE_UP_AT) {
      clock.ms += 5 * S;
      const tokens = { input: 100, input_cached: 0, output: 20 };
      return { decision, result: { success: true, result: { path: packet.artifact_path, content: "export const c = 1;\n" }, tokens, cost_usd: 0.0001, latency_ms: 5 * S, terminal_reason: "success", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens, cost_usd: 0.0001, latency_ms: 5 * S, success: true }] }, events };
    }
    clock.ms += callSec * S;
    // The run's other packets of this model are served while this call is out.
    ledger.served(MODEL);
    return { decision, result: { success: false, error: `Google could not serve ${MODEL}: ${REFUSED}`, result: null, tokens: ZERO, cost_usd: 0, latency_ms: callSec * S, terminal_reason: "vendor_error", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens: ZERO, cost_usd: 0, latency_ms: callSec * S, success: false, error: REFUSED, error_status: 429, unavailable: REFUSED }] }, events };
  };
  try {
    const packet = { id: "c", phase: "codegen", task_type: "x", module: "m", pass_id: "run-1", instruction: "Write src/c.ts.", inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }, artifact_path: "src/c.ts", apply: { write: true } };
    const out = await runApplyLoop({
      packet, apply: normalizeApply(packet.apply), projectRoot: root, keepEvents: true, ledger, modelOf: () => MODEL,
      route: () => decision, lastAttempt: () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 }), typesInServer: () => true,
      dispatch, log: () => {}, transport: { maxWaits: 6, baseMs: 2_000, capMs: 60_000 }, sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5,
    });
    let written = null;
    try { written = readFileSync(join(root, "src", "c.ts"), "utf8"); } catch { /* nothing written */ }
    return { out, calls, written };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The apply loop: one packet's calls are never served while the model's other calls are.
test("a packet whose every call comes back unavailable while the model's other calls are served ends dispatch_failed once its own calls went unserved for the window: no halt, never the Claude leaf, each call recorded once", async () => {
  for (const c of APPLY_CASES) {
    const { out, calls, written } = await applyCase(c);
    assert.equal(out.status, "dispatch_failed", `${c.when}: the packet was sent ${calls.length} times: ${JSON.stringify(out.attempts)}`);
    assert.equal(out.halt, undefined, `${c.when}: no halt, Google serves the model's other calls, so the run goes on`);
    const reason = out.attempts[out.attempts.length - 1]?.failure ?? "";
    assert.ok(reason.includes(REFUSED), `${c.when}: Google's reason: ${reason}`);
    assert.match(reason, /none of this packet's calls was served for 300 s/);
    assert.equal(calls.length, c.calls, `${c.when}: ${calls.map((x) => x.at / S)}`);
    assert.ok(calls.every((x) => x.retry_count === 0 && x.force === undefined), "never an attempt of the ladder, never the Claude leaf");
    assert.deepEqual(out.events.map((e) => e.call), calls.map((_, i) => i + 1), `${c.when}: each call's event recorded once`);
    assert.equal(written, null, "nothing was written");
  }
});

// The stage runner: the same bound on one job.
test("a stage job whose every call comes back unavailable while the model's other calls are served fails once its own calls went unserved for the window: the stage goes on, the job is never typed by the lean Opus attempt, and each call is billed and recorded once", async () => {
  const policy = loadPolicyFromPath(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "opus-only-v5.yaml"));
  const spec = { spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: [{ id: "U01", path: "app/m1.py", phase: "codegen", import_line: "", exports: [{ name: "thing", params: [], returns: "int" }], behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5 }] };
  for (const c of STAGE_CASES) {
    const clock = { ms: 0 };
    const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
    const calls = [];
    const typist = {
      door: "agy", modelId: "flash-agsdk", modelName: MODEL, calls,
      async type(req) {
        calls.push(req.unit.id);
        if (calls.length >= GIVE_UP_AT) { clock.ms += 5 * S; return { answer: { path: req.unit.path, content: "def thing():\n    return 1\n" }, transport: false, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.0001, latency_ms: 5 * S }; }
        clock.ms += c.callSec * S;
        ledger.served(MODEL);
        return { answer: null, error: `Google could not serve ${MODEL}: ${REFUSED}`, transport: false, error_status: 429, unavailable: REFUSED, tokens: ZERO, cost_usd: 0.001, latency_ms: c.callSec * S };
      },
    };
    const opusCalls = [];
    const opus = { door: "lean-opus", modelId: "opus", modelName: "claude-opus-5", async type(req) { opusCalls.push(req.unit.id); return { answer: { path: req.unit.path, content: "x\n" }, transport: false, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0, latency_ms: 1 }; } };
    const emitted = [];
    const dir = mkdtempSync(join(tmpdir(), "ledger-unserved-stage-"));
    try {
      const receipt = await executeStage(spec, { stage: "codegen", codeDir: dir, passId: "p1", policy, concurrency: 1, routedAttempts: 2, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 } },
        { typistFor: () => typist, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => emitted.push(e), check: () => ({ ok: true }), sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5, now: () => clock.ms, ledger });
      assert.equal(receipt.stopped, undefined, `${c.when}: the stage goes on: ${receipt.stopped}`);
      assert.equal(receipt.written, 0, JSON.stringify(receipt));
      assert.equal(receipt.failed.length, 1, JSON.stringify(receipt));
      assert.match(receipt.failed[0].reason, /none of this job's calls was served for 300 s/);
      assert.equal(calls.length, c.calls, `${c.when}: typed ${calls.length} times`);
      assert.equal(receipt.calls, c.calls, `${c.when}: each call counted once in the receipt`);
      assert.ok(Math.abs(receipt.cost_usd - c.calls * 0.001) < 1e-9, `${c.when}: each call billed once: ${receipt.cost_usd}`);
      assert.equal(emitted.length, c.calls, `${c.when}: one event per call: ${emitted.map((e) => e.retry_reason)}`);
      assert.deepEqual(opusCalls, [], "never typed by the lean Opus attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
