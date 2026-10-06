/**
 * The record of a brownfield packet's calls (apply.ts runApplyLoop's `record` hook), as greenfield's stage runner
 * writes its own (executor/run.ts deps.emit): one hand-over per call, as soon as that call's verdict is known, so a
 * server that dies mid-ladder has already written every finished call; a busy vendor's reply that was waited out is
 * tagged `transport` and is no attempt; an attempt says `success` only when its answer was written and passed every
 * check the ladder judges it by, with the cause as its error; and every attempt carries the reason the loop gave it,
 * whatever label the dispatcher put on the event. A typist reads its own vendor's "not now" (its transport flag), so a
 * status a typist reports without that flag is an attempt, as in greenfield. Stub models and temp folders: no model
 * is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA } = await import(join(DIST, "apply.js"));
const { typistResult } = await import(join(DIST, "applyTypist.js"));

process.env.MMO_MANAGED_SETTINGS = join(tmpdir(), "mmo-no-managed-settings.json");
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mmo-apply-record-config-"));

const FLASH = { modelId: "flash", reason: "policy", ruleIndex: 0 };
const FAST = { maxWaits: 2, baseMs: 1, capMs: 60_000 };
const packet = (over = {}) => ({
  id: "tp_codegen_001", phase: "codegen", task_type: "", module: "spec", pass_id: "r", instruction: "Write the file.",
  inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/out.ts", ...over,
});
const has = (word) => `node -e "process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('${word}')?0:1)" {path}`;

/**
 * A dispatcher that numbers its events as server.ts does for a typist call (attempt_number = the ladder's slot + 1) and
 * labels every one past the first "output_cap", the label the loop must not let stand. Replies: an answer, `{busy}`
 * (a typist's own "not now"), or `{status, typist}` (a vendor status with or without a typist's own reading).
 */
function dispatcher(replies, order) {
  const calls = [];
  const dispatch = async (p) => {
    calls.push(p);
    order.push(`dispatch ${calls.length}`);
    const r = replies.shift();
    const n = (p.retry_count ?? 0) + 1;
    const ev = { task_id: p.id, retry_count: p.retry_count ?? 0, attempt_number: n, success: !r.busy && r.status === undefined, ...(n > 1 ? { retry_reason: "output_cap" } : {}) };
    if (r.busy || r.status !== undefined) {
      const typistFields = r.typist === false ? {} : { transient: r.busy === true };
      return { decision: FLASH, events: [ev], result: { success: false, error: r.busy ? "rate limited" : `HTTP ${r.status}`, result: null, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, terminal_reason: "vendor_error", attempts: [{ error_status: r.status ?? 429, ...typistFields }] } };
    }
    return { decision: FLASH, events: [ev], result: { success: true, result: { path: p.artifact_path, ...r }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0.01, terminal_reason: "success" } };
  };
  return { calls, dispatch };
}

test("each call's events are handed over once its verdict is known, before the next call: a wait as transport, an attempt by its checks, with the loop's own reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-record-"));
  const order = [];
  const recorded = [];
  const m = dispatcher([{ busy: true }, { content: "BAD\n" }, { content: "GOOD\n" }], order);
  const out = await runApplyLoop({
    projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(),
    apply: normalizeApply({ write: true, verify: [has("GOOD")] }), dispatch: m.dispatch,
    record: (evs) => { order.push(`record ${evs.length}`); recorded.push(...evs.map((e) => ({ ...e }))); },
    transport: FAST, sleep: async () => {}, random: () => 0.5,
  });
  assert.equal(out.status, "applied");
  assert.deepEqual(order, ["dispatch 1", "record 1", "dispatch 2", "record 1", "dispatch 3", "record 1"], "each call's events go out before the next call starts");
  assert.deepEqual(recorded.map((e) => [e.success, e.retry_reason]), [[false, "transport"], [false, undefined], [true, "verify"]]);
  assert.match(recorded[1].error, /^verify failed: node -e/, "the check that failed is the attempt's error");
  assert.doesNotMatch(recorded[1].error, /\n/, "the event names the cause; the check's output stays in the receipt");
  assert.equal(recorded[2].error, undefined);
  assert.deepEqual(out.events.map((e) => [e.success, e.retry_reason]), [[false, "transport"], [false, undefined], [true, "verify"]], "the receipt's events say the same");
  assert.equal(out.attempts.length, 2, "a wait is no attempt");
  assert.equal(out.transport_waits, 1);
  rmSync(root, { recursive: true, force: true });
});

test("an answer naming another file is a failed event with greenfield's reason, and the attempt after it carries `refused`", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-record-"));
  const recorded = [];
  const m = dispatcher([{ path: "src/b.ts", content: "x\n" }, { content: "fine\n" }], []);
  const out = await runApplyLoop({ projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(), apply: normalizeApply({ write: true }), dispatch: m.dispatch, record: (evs) => recorded.push(...evs) });
  assert.equal(out.status, "applied");
  assert.deepEqual(recorded.map((e) => [e.success, e.retry_reason]), [[false, undefined], [true, "refused"]]);
  assert.match(recorded[0].error, /the answer names src\/b\.ts, not src\/out\.ts/);
  rmSync(root, { recursive: true, force: true });
});

test("a typist's vendor status without its own transport flag is an attempt, as greenfield's runner reads it; a dispatcher that reads none still waits on the status", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-record-"));
  // A typist (the agent door, whose SDK already waited) reports 429 with its transport flag false: an attempt, no sleep.
  const waited = [];
  const t = dispatcher([{ status: 429, typist: true }, { content: "ok\n" }], []);
  const o1 = await runApplyLoop({ projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(), apply: normalizeApply({ write: true }), dispatch: t.dispatch, transport: FAST, sleep: async (ms) => { waited.push(ms); }, random: () => 0.5 });
  assert.equal(o1.status, "applied");
  assert.deepEqual(waited, [], "no wait: the typist's own reading said it was no busy reply");
  assert.equal(o1.attempts.length, 2);
  assert.equal(o1.transport_waits, undefined);
  // An adapter that states no reading of its own is read from the vendor's status: a 429 is waited out.
  const a = dispatcher([{ status: 429, typist: false }, { content: "ok\n" }], []);
  const o2 = await runApplyLoop({ projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(), apply: normalizeApply({ write: true }), dispatch: a.dispatch, transport: FAST, sleep: async (ms) => { waited.push(ms); }, random: () => 0.5 });
  assert.equal(o2.status, "applied");
  assert.equal(o2.transport_waits, 1);
  assert.equal(o2.attempts.length, 1);
  // typistResult states the typist's reading either way, so the loop never falls back to the status for a typist.
  const tok = { input: 0, input_cached: 0, output: 0 };
  assert.equal(typistResult(packet(), { answer: null, transport: false, error_status: 429, tokens: tok, cost_usd: 0, latency_ms: 1, error: "429" }).attempts[0].transient, false);
  assert.equal(typistResult(packet(), { answer: null, transport: true, error_status: 429, tokens: tok, cost_usd: 0, latency_ms: 1, error: "429" }).attempts[0].transient, true);
  rmSync(root, { recursive: true, force: true });
});
