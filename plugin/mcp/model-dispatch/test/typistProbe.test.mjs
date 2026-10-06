/**
 * typistProbe.ts: the run's typists, tested before the run spends anything. preflight_dispatch with probe_typists sends
 * one minimal call through every typist the run types with (greenfield's executor and a brownfield run's apply loop
 * alike), so a login that cannot answer stops the run at its start instead of failing every file later. Offline: the
 * typists here are stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runTypingLeaves, probeTypists, probeEvents, PROBE_TIMEOUT_S } = await import(join(DIST, "typistProbe.js"));
const { loadPolicy } = await import(join(DIST, "policy.js"));
const { TYPIST_TIMEOUT_S } = await import(join(DIST, "executor", "tools.js"));

const TOK = (output) => ({ input: 10, input_cached: 0, output });
const stand = (byId) => (leaf) => {
  const r = byId[leaf.id];
  if (r instanceof Error) throw r;
  return { door: leaf.adapter === "mcp:model-dispatch" ? "flash-completion" : leaf.adapter === "antigravity-worker" ? "agy" : "lean-opus", modelId: leaf.id, modelName: leaf.model_name, type: async () => r };
};

test("the run's typing models: every routed attempt of every typed stage, and the last attempt", () => {
  const flash = loadPolicy({ policyName: "opus-plus-flash-v38" });
  const ids = runTypingLeaves(flash, {}).map((m) => m.id).sort();
  assert.ok(ids.length >= 2, "Flash types, and the Claude model takes the last attempt");
  assert.ok(runTypingLeaves(flash, {}).some((m) => m.adapter === "claude-cli" || m.adapter === "builtin-anthropic"), "the lean Opus last attempt is a typist of the run");
  const solo = loadPolicy({ policyName: "opus-only-v5" });
  assert.deepEqual(runTypingLeaves(solo, {}).map((m) => m.model_name), ["claude-opus-5"], "one model types an Opus-only run");
});

test("a typist that answers passes; a busy vendor passes with a note; a refused or silent login stops the run", async () => {
  const leaves = [
    { id: "ok", adapter: "claude-cli", model_name: "claude-opus-5" },
    { id: "busy", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" },
    { id: "refused", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" },
    { id: "nologin", adapter: "claude-cli", model_name: "claude-opus-5" },
    { id: "offcontract", adapter: "claude-cli", model_name: "claude-opus-5" },
    { id: "cannotbuild", adapter: "claude-cli", model_name: "claude-opus-5" },
  ];
  const out = await probeTypists(leaves, "estimated", stand({
    ok: { answer: { path: "probe.txt", content: "ok" }, transport: false, tokens: TOK(5), cost_usd: 0.004, latency_ms: 900 },
    busy: { answer: null, transport: true, error_status: 429, tokens: TOK(0), cost_usd: 0, latency_ms: 50, error: "rate limited" },
    refused: { answer: null, transport: false, error_status: 403, tokens: TOK(0), cost_usd: 0, latency_ms: 50, error: "permission denied" },
    nologin: { answer: null, transport: false, tokens: TOK(0), cost_usd: 0, latency_ms: 50, error: "success: Failed to authenticate: OAuth session expired and could not be refreshed" },
    offcontract: { answer: null, transport: false, tokens: TOK(7), cost_usd: 0.003, latency_ms: 800, error: "the reply was not one JSON object" },
    cannotbuild: new Error("this machine's claude CLI lists no --system-prompt-file flag"),
  }));
  const by = Object.fromEntries(out.map((o) => [o.model_id, o]));
  assert.equal(by.ok.ok, true);
  assert.equal(by.busy.ok, true, "a busy vendor is waited out during the run, as every call is");
  assert.equal(by.busy.busy, true);
  assert.equal(by.refused.ok, false);
  assert.match(by.refused.reason, /HTTP 403/);
  assert.equal(by.nologin.ok, false, "no reply at all: the login cannot be used");
  assert.match(by.nologin.reason, /Failed to authenticate/);
  assert.match(by.nologin.fix, /login/i, "says what to fix");
  assert.equal(by.offcontract.ok, true, "the model replied, so its login and door work");
  assert.equal(by.cannotbuild.ok, false);
  assert.match(by.cannotbuild.reason, /system-prompt-file/);
  assert.equal(out.reduce((s, o) => s + o.cost_usd, 0), 0.007, "every probe's cost is reported");
});

test("each probe call is a telemetry event of the run, priced from its own receipt", async () => {
  const out = await probeTypists([{ id: "opus", adapter: "claude-cli", model_name: "claude-opus-5" }], "estimated", stand({ opus: { answer: { path: "probe.txt", content: "ok" }, transport: false, tokens: TOK(5), cost_usd: 0.004, latency_ms: 900 } }));
  const [e] = probeEvents(out, { pass: "r1", policy: { name: "p", version: 1 } });
  assert.equal(e.phase, "preflight");
  assert.equal(e.task_type, "typist_probe");
  assert.equal(e.model, "claude-opus-5");
  assert.equal(e.door, "lean-opus");
  assert.equal(e.cost_usd, 0.004);
  assert.equal(e.success, true);
});

test("a probe waits less than a typing call: a stated bound, so a hung door stops pre-flight in minutes", () => {
  assert.ok(PROBE_TIMEOUT_S > 0 && PROBE_TIMEOUT_S < TYPIST_TIMEOUT_S);
});
