/**
 * The busy ledger's window counts from when the first unserved call was sent, not from when it came back: a call
 * Google held is unserved from its start. So a Flash typist held past both stall tries (180 s, then 360 s) with
 * nothing of the model served stops the batch when it comes back, 540 s in, instead of waiting out another 540 s
 * call first; a call served meanwhile still restarts the window. Offline: the ledger on a fake clock, and the apply
 * loop with a dispatcher stub whose calls advance that clock.
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

const MODEL = "gemini-3.8-flash";
const HELD = "stalled at global: accepted the call twice and sent nothing back (180 s, 360 s)";
const S = 1000;

test("a call sent with nothing of its model served since, and held past the window, stops the run when it comes back", () => {
  let t = 0;
  const L = new BusyLedger({ windowSec: 300, now: () => t });
  const sent = L.time();
  t = 540 * S;
  const why = L.unavailable(MODEL, HELD, sent);
  assert.match(String(why), /Google could not serve gemini-3\.8-flash/);
  assert.ok(why.includes(HELD));
});

test("a call served after the held one was sent restarts the window; with no send time the window starts at the report", () => {
  let t = 0;
  const L = new BusyLedger({ windowSec: 300, now: () => t });
  const sent = L.time();
  t = 400 * S; L.served(MODEL);
  t = 540 * S;
  assert.equal(L.unavailable(MODEL, HELD, sent), null, "served 140 s ago");
  let u = 0;
  const M = new BusyLedger({ windowSec: 300, now: () => u });
  u = 540 * S;
  assert.equal(M.unavailable(MODEL, HELD), null, "no send time: the stretch begins now");
});

test("a packet whose only call is held for 540 s, nothing of the model served, halts the batch on that call: one call, no resend", async () => {
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const calls = [];
  const dispatch = async (packet) => {
    calls.push(clock.ms);
    clock.ms += 540 * S;
    const decision = { modelId: "flash", reason: "policy", ruleIndex: 0 };
    const zero = { input: 0, input_cached: 0, output: 0 };
    return { decision, result: { success: false, error: `Google could not serve ${MODEL}: ${HELD}`, result: null, tokens: zero, cost_usd: 0, latency_ms: 540 * S, terminal_reason: "vendor_error", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens: zero, cost_usd: 0, latency_ms: 540 * S, success: false, error: HELD, transient: false, unavailable: HELD }] }, events: [{ task_id: packet.id }] };
  };
  const root = mkdtempSync(join(tmpdir(), "ledger-sent-"));
  try {
    const packet = { id: "a", phase: "codegen", task_type: "x", module: "m", pass_id: "run-1", instruction: "Write src/a.ts.", inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }, artifact_path: "src/a.ts", apply: { write: true } };
    const out = await runApplyLoop({
      packet, apply: normalizeApply(packet.apply), projectRoot: root, keepEvents: true, ledger, modelOf: () => MODEL,
      route: () => ({ modelId: "flash", reason: "policy", ruleIndex: 0 }),
      lastAttempt: () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 }),
      typesInServer: () => true, dispatch, log: () => {},
      transport: { maxWaits: 6, baseMs: 2_000, capMs: 60_000 }, sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5,
    });
    assert.match(String(out.halt), /Google could not serve/, JSON.stringify(out));
    assert.equal(calls.length, 1, "halted on the first call, 540 s with nothing served");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
