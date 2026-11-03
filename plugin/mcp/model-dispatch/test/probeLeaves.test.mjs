/**
 * The run-start probe covers every Antigravity leaf the run can reach, typing or not (runProbeLeaves: the typing
 * leaves, plus each reachable antigravity-worker judgment leaf, each probed with the cheap typist worker), while
 * runTypingLeaves keeps its own set; and a probe call that came back `unavailable` (Google held or refused it past
 * its budget) is a busy Google, which passes with a note, never a broken login.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicyFromPath } from "../dist/policy.js";
import * as probe from "../dist/typistProbe.js";
import { fakeWorkerPython, flagValue, withEnv } from "./agyFakes.mjs";

const JUDGE_ONLY = `version: 1
name: judge-on-gemini
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: argon
    adapter: antigravity-worker
    model_name: gemini-4-argon
rules:
  - when: { phase: requirements_analysis }
    use: argon
  - when: { phase: design }
    use: argon
  - default: opus
`;

// E-probe-judgment-leaf: a policy whose only AgSDK leaf judges, never types.
test("runProbeLeaves adds the antigravity-worker leaf a policy only judges with; runTypingLeaves keeps the typing set", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-leaves-"));
  try {
    writeFileSync(join(dir, "p.yaml"), JUDGE_ONLY);
    const policy = loadPolicyFromPath(join(dir, "p.yaml"));
    assert.deepEqual(probe.runTypingLeaves(policy, {}).map((m) => m.id), ["opus"], "unchanged");
    assert.equal(typeof probe.runProbeLeaves, "function", "typistProbe.ts exports runProbeLeaves");
    assert.deepEqual(probe.runProbeLeaves(policy, {}).map((m) => m.id).sort(), ["argon", "opus"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// E-probe-unavailable-busy: a held or refused probe is a busy Google.
test("a probe call that came back unavailable passes as busy with a note, not as a door that cannot answer", async () => {
  const leaf = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
  const held = { door: "agy", modelId: "flash", modelName: "gemini-3.8-flash", type: async () => ({ answer: null, error: "Google could not serve gemini-3.8-flash: accepted the call at global twice and sent nothing back", unavailable: "accepted the call at global twice and sent nothing back (120 s, 240 s)", transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 360_000 }) };
  const [o] = await probe.probeTypists([leaf], "estimated", () => held, () => null);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.busy, true);
  assert.match(String(o.reason), /sent nothing back|could not serve/);
});

/** A probe call Google refused at once with its 429, as the typist worker's receipt states it. */
const REFUSED_429 = {
  finish_output: null, text: "", tool_calls: [], sdk_version: "0.1.22", vertex_project: "p",
  usage: { prompt_token_count: 0, cached_content_token_count: 0, candidates_token_count: 0, thoughts_token_count: 0, total_token_count: 0 },
  error: "Google could not serve gemini-3.8-flash: refused at global (1 requests over 0 s; last HTTP 429 RESOURCE_EXHAUSTED)",
  error_type: "AntigravityExecutionError", error_status: 429,
  unavailable: "refused at global (1 requests over 0 s; last HTTP 429 RESOURCE_EXHAUSTED)",
  tries: [{ location: "global", ended_by: "refused", http_codes: [429], s: 0.2, start_s: 0, end_s: 0.2, usage: null, served_tier: null }],
};

/** The worker runs of one probe of `leaf`, each with its arguments, and the probe's outcomes. */
async function probeRuns(leaf, receipt) {
  const fake = fakeWorkerPython({ runs: [{ receipt }] });
  try {
    const outcomes = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () => probe.probeTypists([leaf], "estimated"));
    return { outcomes, runs: fake.runs().map((r) => r.args) };
  } finally {
    fake.cleanup();
  }
}

// A failover leaf's run-start probe: each call pinned to one location ends at Google's first answer or status.
test("a failover leaf's probe call at each location makes no retry of the harness's own and no resend of a 500, and a 429 there still passes as busy; a leaf without failover_locations keeps its probe's settings", async () => {
  const flash = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
  const pinned = await probeRuns({ ...flash, failover_locations: ["us", "eu"] }, REFUSED_429);
  assert.deepEqual(pinned.runs.map((a) => flagValue(a, "--locations")).sort(), ["eu", "global", "us"]);
  for (const a of pinned.runs) {
    const at = flagValue(a, "--locations");
    assert.equal(flagValue(a, "--api-retries"), "0", `${at}: the harness's own retries`);
    assert.equal(flagValue(a, "--busy-budget-sec"), "0", `${at}: no resend of a 500`);
    assert.equal(flagValue(a, "--stall-tries"), "1", `${at}: one try against a stall, as every probe call`);
    assert.equal(flagValue(a, "--timeout"), "120", `${at}: the probe's own bound, with no retry waits to cover`);
  }
  for (const o of pinned.outcomes) {
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.busy, true, "Google's first 429 is a busy location, which passes");
    assert.match(String(o.reason), /429/);
  }
  const plain = await probeRuns(flash, REFUSED_429);
  assert.equal(plain.runs.length, 1);
  const [a] = plain.runs;
  assert.deepEqual(["--locations", "--api-retries", "--api-retry-initial-ms", "--busy-budget-sec", "--stall-tries", "--timeout"].map((k) => flagValue(a, k)),
    ["global", "6", "2000", "120", "1", "246"], "a leaf without failover_locations: the probe's settings as before");
  assert.equal(plain.outcomes[0].busy, true);
});

// A call Google refused (401 or 403) ran: the worker and its Python worked, and the login, the project or its
// permission is what to fix. A worker that cannot start is this machine's setup, which /mmo:setup builds for any
// policy that reaches an Antigravity leaf; --enable-agent would also change the install's routing.
test("a refused Antigravity probe call says to fix the project and the login; a worker that cannot start says to run /mmo:setup", async () => {
  const leaf = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
  const ZERO = { input: 0, input_cached: 0, output: 0 };
  const refused = (status) => () => ({ door: "agy", modelId: leaf.id, modelName: leaf.model_name, type: async () => ({ answer: null, transport: false, error_status: status, error: `AntigravityConnectionError: Agent execution terminated due to error. ("agent executor error: Error ${status}, Message: Permission denied")`, tokens: ZERO, cost_usd: 0, latency_ms: 900 }) });
  for (const status of [401, 403]) {
    const [o] = await probe.probeTypists([leaf], "estimated", refused(status));
    assert.equal(o.ok, false, `${status} stops the run`);
    assert.match(o.fix, /GOOGLE_CLOUD_PROJECT/, `${status}: names the project setting: ${o.fix}`);
    assert.match(o.fix, /gcloud auth application-default login/, `${status}: and the login`);
    assert.match(o.fix, /Vertex AI User/, `${status}: and the permission it needs`);
    assert.doesNotMatch(o.fix, /Python|enable-agent|setup/, `${status}: not this machine's setup: ${o.fix}`);
  }
  const [unbuilt] = await probe.probeTypists([leaf], "estimated", () => { throw new Error("the Antigravity worker's Python was not found"); });
  assert.equal(unbuilt.ok, false);
  assert.match(unbuilt.fix, /\/mmo:setup/, unbuilt.fix);
  assert.doesNotMatch(unbuilt.fix, /enable-agent/, unbuilt.fix);
});
