/**
 * An unavailable call is sent again only while its model's window is open. The window can close while a packet waits
 * before its resend (no call of the model served since its stretch began, this packet's or another's): the packet
 * then stops with Google's reason without another call, and a stage stops typing. Offline: the ledger on a fake clock; the apply loop and the stage runner with stubs whose calls
 * advance that clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { BusyLedger } = await import(join(DIST, "busyLedger.js"));
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA } = await import(join(DIST, "apply.js"));
const { executeStage } = await import(join(DIST, "executor", "run.js"));
const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));

const MODEL = "gemini-3.8-flash";
const REFUSED = "refused at global (7 requests over 104 s; last HTTP 429 RESOURCE_EXHAUSTED)";
const S = 1000;
const ZERO = { input: 0, input_cached: 0, output: 0 };

test("the ledger's window closes on time with nothing served, whether or not a call has come back since; a served call opens it again", () => {
  let t = 0;
  const L = new BusyLedger({ windowSec: 300, now: () => t });
  assert.equal(L.closed(MODEL), null, "no call of the model yet");
  const sent = L.time();
  t = 120 * S; assert.equal(L.unavailable(MODEL, REFUSED, sent), null);
  t = 250 * S; assert.equal(L.closed(MODEL), null, "the window is open");
  t = 301 * S;
  const why = L.closed(MODEL);
  assert.match(String(why), /Google could not serve gemini-3\.8-flash/);
  assert.ok(why.includes(REFUSED), "with Google's reason");
  t = 302 * S; L.served(MODEL);
  assert.equal(L.closed(MODEL), null, "a served call opens it again");
});

test("a packet whose window closes while it waits to resend stops with Google's reason, without another call", async () => {
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const calls = [];
  const dispatch = async (packet) => {
    calls.push(clock.ms);
    clock.ms += 299.5 * S;
    const decision = { modelId: "flash", reason: "policy", ruleIndex: 0 };
    return { decision, result: { success: false, error: `Google could not serve ${MODEL}: ${REFUSED}`, result: null, tokens: ZERO, cost_usd: 0, latency_ms: 299 * S, terminal_reason: "vendor_error", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens: ZERO, cost_usd: 0, latency_ms: 299 * S, success: false, error: REFUSED, error_status: 429, transient: false, unavailable: REFUSED }] }, events: [{ task_id: packet.id }] };
  };
  const root = mkdtempSync(join(tmpdir(), "ledger-closed-"));
  try {
    const packet = { id: "a", phase: "codegen", task_type: "x", module: "m", pass_id: "run-1", instruction: "Write src/a.ts.", inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }, artifact_path: "src/a.ts", apply: { write: true } };
    const out = await runApplyLoop({
      packet, apply: normalizeApply(packet.apply), projectRoot: root, keepEvents: true, ledger, modelOf: () => MODEL,
      route: () => ({ modelId: "flash", reason: "policy", ruleIndex: 0 }),
      lastAttempt: () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 }),
      typesInServer: () => true, dispatch, log: () => {},
      transport: { maxWaits: 6, baseMs: 2_000, capMs: 60_000 }, sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5,
    });
    assert.equal(calls.length, 1, "no call once the window closed during the wait");
    assert.equal(out.status, "dispatch_failed");
    assert.match(String(out.halt), /Google could not serve/);
    assert.ok(out.halt.includes(REFUSED));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage whose window closes while it waits to retype stops with Google's reason, without another call", async () => {
  const clock = { ms: 0 };
  const calls = [];
  const typist = {
    door: "agy", modelId: "flash-agsdk", modelName: MODEL, calls,
    async type(req) {
      calls.push(req.unit.id);
      clock.ms += 299.6 * S;
      return { answer: null, error: `Google could not serve ${MODEL}: ${REFUSED}`, transport: false, error_status: 429, unavailable: REFUSED, tokens: ZERO, cost_usd: 0, latency_ms: 299 * S };
    },
  };
  const opus = { door: "lean-opus", modelId: "opus", modelName: "claude-opus-5", calls: [], async type() { throw new Error("never the Claude rung"); } };
  const unit = { id: "U01", path: "app/m1.py", phase: "codegen", import_line: "", exports: [{ name: "thing", params: [], returns: "int" }], behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5 };
  const spec = { spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: [unit] };
  const policy = loadPolicyFromPath(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "opus-only-v5.yaml"));
  const dir = mkdtempSync(join(tmpdir(), "ledger-closed-stage-"));
  try {
    const receipt = await executeStage(spec, { stage: "codegen", codeDir: dir, passId: "p1", policy, concurrency: 1, routedAttempts: 2, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 } },
      { typistFor: () => typist, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: () => ({ ok: true }), sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5, now: () => clock.ms, ledger: new BusyLedger({ windowSec: 300, now: () => clock.ms }) });
    assert.match(String(receipt.stopped), /Google could not serve/, JSON.stringify(receipt));
    assert.equal(calls.length, 1, "no call once the window closed during the wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
