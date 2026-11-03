/**
 * What a Gemini call records and costs. A typist receipt or agent sidecar with `tries` is priced try by try: each
 * try's own tokens, at its own location (the list card, x1.1 outside `global`), on its own UTC day, and at its served
 * tier (a tier the list does not price is left unpriced and named, never billed at the standard card). The result
 * carries one `gemini` record with the project, the location that ended the call, every try with its tokens and
 * dollars, Google's status codes, the cuts, failovers and waits, and the SDK version; a call Google could not serve
 * carries `unavailable` through to the attempt the loops read. A receipt without tries (the earlier workers' shape) is
 * priced exactly as before. The direct Gemini route's attempts gain the record and nothing else. Offline: stand-in worker
 * interpreters and a stand-in transport; the expected dollars come from the dated price list itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeWorkerPython, withEnv } from "./agyFakes.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { AgyTypist } = await import(join(DIST, "executor", "typists.js"));
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));
const { GeminiFlashAdapter } = await import(join(DIST, "adapters", "GeminiFlashAdapter.js"));
const { applyVertexSurcharge } = await import(join(DIST, "adapters", "geminiTransports.js"));
const { computeCostUsd } = await import(join(DIST, "pricing.js"));
const { lookupPrice } = await import(join(DIST, "prices.js"));
const { mapSidecarTokens } = await import(join(DIST, "delegation", "workerProcess.js"));
const { typistResult } = await import(join(DIST, "applyTypist.js"));

const FLASH = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const ARGON = { id: "argon", adapter: "antigravity-worker", model_name: "gemini-4-argon" };
const card = (model, date, location = "global") => applyVertexSurcharge(lookupPrice(model, date).pricing, { backend: "vertex-adc", location, modelName: model });
const close = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} != ${b}`);

/** Usage in the SDK's field names. */
const usage = (prompt, cached, candidates, thoughts = 0, tier = "standard") => ({ prompt_token_count: prompt, cached_content_token_count: cached, candidates_token_count: candidates, thoughts_token_count: thoughts, total_token_count: prompt + candidates + thoughts, service_tier: tier });
/** A recorded typist call's tokens (6,914 in, 0 cached, 1,542 out), answered at `us` after two 429s at `global`. */
const US_TOKENS = usage(6914, 0, 1542);
const tryOf = (o) => ({ http_codes: [], s: o.end_s - o.start_s, served_tier: o.ended_by === "answer" ? "standard" : null, ...o });
const MOVED = [
  tryOf({ location: "global", ended_by: "refused", http_codes: [429, 429], start_s: 0, end_s: 2.1, usage: usage(0, 0, 0, 0, null) }),
  tryOf({ location: "us", ended_by: "answer", start_s: 2.1, end_s: 11.9, usage: US_TOKENS }),
];
const v2 = (tries, over = {}) => ({
  finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), text: "Finished", tool_calls: ["finish"], error: null, error_type: null,
  sdk: "google-antigravity", sdk_version: "0.1.22", vertex_project: "p", vertex_location: tries[tries.length - 1].location, thinking: "LOW", seconds: 12,
  usage: tries.reduce((a, t) => Object.fromEntries(Object.keys(US_TOKENS).filter((k) => k !== "service_tier").map((k) => [k, (a[k] ?? 0) + (t.usage[k] ?? 0)])), {}),
  tries, stall_cuts: 0, failovers: tries.length - 1, cut_calls: 0, google_wait_s: 2.1, work_s: 9.8, slept_s: 0, served_tier: "standard", ...over,
});

async function typeWith(receipt, leaf = FLASH) {
  const fake = fakeWorkerPython({ runs: [{ receipt }] });
  const dir = mkdtempSync(join(tmpdir(), "records-"));
  writeFileSync(join(dir, "shared.txt"), "");
  try {
    return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
      new AgyTypist(leaf, { effort: "LOW", maxModelCalls: 3, timeoutSec: 540, apiRetries: 6, apiRetryInitialMs: 2000 })
        .type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" }));
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function dispatchWith(sidecar, leaf, now, { code = 0, stdout = '{"ok":true}' } = {}) {
  const fake = fakeWorkerPython({ runs: [{ sidecar, stdout: code === 0 ? stdout : "", exitCode: code }] });
  const dir = mkdtempSync(join(tmpdir(), "records-agent-"));
  mkdirSync(join(dir, "work"));
  try {
    const packet = { id: "tp_x_001", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
      new AntigravityWorkerAdapter(leaf, { now: () => now }).execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") }));
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

// E-price-per-location and E-old-receipt-unchanged: each try at its own location.
test("a typist call that moved from global to us is billed the us try's own tokens at the us card x1.1, try by try; a receipt without tries is billed exactly as before", async () => {
  const today = new Date().toISOString();
  const r = await typeWith(v2(MOVED));
  const usCost = computeCostUsd({ input: 6914, input_cached: 0, output: 1542 }, card("gemini-3.8-flash", today, "us"));
  close(r.cost_usd, usCost, "the call's cost is the us try's tokens at the us card");
  assert.ok(r.gemini, `no gemini record on the typist's result: ${JSON.stringify(r)}`);
  assert.deepEqual(r.gemini.tries.map((t) => t.location), ["global", "us"]);
  close(r.gemini.tries.reduce((a, t) => a + t.cost_usd, 0), r.cost_usd, "the tries' dollars sum to the call's");
  close(r.gemini.tries[0].cost_usd, 0, "a refused try bills nothing");
  assert.deepEqual([r.gemini.tries[1].input_tokens, r.gemini.tries[1].input_tokens_cached, r.gemini.tries[1].output_tokens], [6914, 0, 1542]);
  assert.equal(r.gemini.location, "us");
  // A receipt without tries (the earlier workers' shape) is billed as before: its usage, read by its SDK version, at the leaf's location.
  const old = { finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), usage: usage(6914, 0, 1542), sdk_version: "0.1.16", tool_calls: ["finish"], vertex_location: "global" };
  const o = await typeWith(old);
  const tokens = mapSidecarTokens({ sdk_version: "0.1.16", usage: old.usage });
  assert.deepEqual({ input: o.tokens.input, input_cached: o.tokens.input_cached, output: o.tokens.output }, { input: tokens.input, input_cached: tokens.input_cached, output: tokens.output });
  close(o.cost_usd, computeCostUsd(tokens, card("gemini-3.8-flash", today, "global")), "an old receipt's cost");
});

// E-price-per-location, Argon after its 1 Dec price change.
test("an agent dispatch on 2 Dec that moved to us is billed the us try at Argon's December card x1.1", async () => {
  const out = await dispatchWith(v2(MOVED, { finish_output: undefined }), ARGON, new Date("2026-12-02T10:00:00Z"));
  assert.equal(out.success, true, out.error);
  close(out.cost_usd, computeCostUsd({ input: 6914, input_cached: 0, output: 1542 }, card("gemini-4-argon", "2026-12-02", "us")), "the December card, x1.1 at us");
  assert.equal(out.attempts[0].gemini?.location, "us", JSON.stringify(out.attempts[0]));
  assert.deepEqual(out.attempts[0].gemini.tries.map((t) => [t.location, t.ended_by]), [["global", "refused"], ["us", "answer"]]);
});

// E-price-per-try-day: each try priced on its own UTC day.
test("a dispatch whose tries straddle 30 Nov and 1 Dec prices each Argon try on its own day", async () => {
  const start = new Date("2026-11-30T23:59:00Z");
  const tokens = usage(10000, 0, 1000);
  const tries = [
    tryOf({ location: "global", ended_by: "stalled", start_s: 0, end_s: 30, started_at: "2026-11-30T23:59:00.000Z", usage: tokens }),
    tryOf({ location: "global", ended_by: "answer", start_s: 90, end_s: 100, started_at: "2026-12-01T00:00:30.000Z", usage: tokens }),
  ];
  const out = await dispatchWith(v2(tries, { finish_output: undefined, failovers: 0, stall_cuts: 1 }), ARGON, start);
  assert.equal(out.success, true, out.error);
  const each = { input: 10000, input_cached: 0, output: 1000 };
  const expected = computeCostUsd(each, card("gemini-4-argon", "2026-11-30")) + computeCostUsd(each, card("gemini-4-argon", "2026-12-01"));
  close(out.cost_usd, expected, "the November try at November's card, the December try at December's");
});

// E-served-tier-unpriced: a tier the list does not price is never billed at the standard card.
test("a try served at a tier the list does not price is left unpriced and named; the standard try is billed", async () => {
  const tries = [
    tryOf({ location: "global", ended_by: "stalled", start_s: 0, end_s: 30, usage: usage(5000, 0, 100) }),
    tryOf({ location: "global", ended_by: "answer", start_s: 31, end_s: 40, served_tier: "priority", usage: usage(5000, 0, 100, 0, "priority") }),
  ];
  const now = new Date("2026-11-10T10:00:00Z");
  const out = await dispatchWith(v2(tries, { finish_output: undefined, served_tier: "priority" }), FLASH, now);
  assert.equal(out.success, true, out.error);
  close(out.cost_usd, computeCostUsd({ input: 5000, input_cached: 0, output: 100 }, card("gemini-3.8-flash", "2026-11-10")), "only the standard try is billed");
  const unpriced = out.attempts[0].unpriced_models ?? [];
  assert.ok(unpriced.some((u) => u.model === "gemini-3.8-flash" && /priority|service_tier/.test(u.reason)), JSON.stringify(out.attempts[0]));
});

// The gemini record on the typist's result.
test("the typist's result carries the gemini record: project, the location that ended the call, every try with its codes, cuts, failovers, waits and the SDK version", async () => {
  const r = await typeWith(v2(MOVED, { stall_cuts: 1, cut_calls: 1, slept_s: 0 }));
  const g = r.gemini;
  assert.ok(g, JSON.stringify(r));
  assert.equal(g.project, "p");
  assert.equal(g.location, "us");
  assert.equal(g.ended_by, "answer");
  assert.equal(g.last_status, 429);
  assert.deepEqual(g.tries[0].http_codes, [429, 429]);
  assert.deepEqual([g.stall_cuts, g.failovers, g.cut_calls], [1, 1, 1]);
  assert.equal(g.google_wait_ms, 2100);
  assert.equal(g.work_ms, 9800);
  assert.equal(g.sdk_version, "0.1.22");
  assert.equal(typeof g.usage_semantics, "string");
  assert.equal(g.unavailable ?? null, null);
});

// unavailable, carried to the attempt the apply loop and stage runner read.
test("a receipt with unavailable gives a typist result and its attempt the reason, with transport still false, and the agent door's attempt carries it too", async () => {
  const reason = "refused at global (7 requests over 104 s; last HTTP 429 RESOURCE_EXHAUSTED)";
  const refused = v2([tryOf({ location: "global", ended_by: "refused", http_codes: [429, 429, 429, 429, 429, 429, 429], start_s: 0, end_s: 104, usage: usage(0, 0, 0, 0, null) })],
    { finish_output: null, error: "AntigravityExecutionError: model unreachable: Error 429", error_type: "AntigravityExecutionError", error_status: 429, unavailable: reason, failovers: 0 });
  const r = await typeWith(refused);
  assert.equal(r.answer, null);
  assert.equal(r.transport, false, "the worker has already waited");
  assert.equal(typeof r.unavailable, "string", JSON.stringify(r));
  assert.ok(r.unavailable.includes("refused at global"), r.unavailable);
  assert.equal(r.error_status, 429);
  const attempt = typistResult({ id: "p1", budget: { maxOutputTokens: 100 } }, r).attempts[0];
  assert.equal(attempt.unavailable, r.unavailable);
  assert.deepEqual(attempt.gemini, r.gemini);
  const out = await dispatchWith({ ...refused, text: "" }, FLASH, new Date("2026-11-10T10:00:00Z"), { code: 1 });
  assert.equal(out.success, false);
  assert.ok(String(out.attempts[0].unavailable).includes("refused at global"), JSON.stringify(out.attempts[0]));
  assert.equal(out.attempts[0].error_status, 429);
});

// E-direct-route-same: the direct route behaves the same and gains only the record.
test("the direct Gemini route's attempt keeps every field and gains a gemini record of backend, project, location and served tier", async () => {
  const saved = { b: process.env.GEMINI_BACKEND, p: process.env.GOOGLE_CLOUD_PROJECT, l: process.env.GOOGLE_CLOUD_LOCATION, k: process.env.GEMINI_API_KEY };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "unit-test-project" });
  delete process.env.GOOGLE_CLOUD_LOCATION;
  delete process.env.GEMINI_API_KEY;
  try {
    const adapter = new GeminiFlashAdapter({ id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }, { now: () => new Date("2026-11-03T12:00:00Z") });
    const real = adapter.transport;
    adapter.transport = { backend: real.backend, location: real.location, project: real.project, createCache: async () => undefined, generate: async () => ({ text: '{"ok":true}', usage: { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 5, trafficType: "ON_DEMAND" }, finishReason: "STOP" }) };
    const out = await adapter.execute({ id: "p", phase: "tests", task_type: "t", module: "m", instruction: "x", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 }, pass_id: "t" });
    const { gemini, latency_ms, ...rest } = out.attempts[0];
    assert.deepEqual(rest, { attempt_number: 1, ceiling_used: 2000, stop_reason: "STOP", hit_output_cap: false, tokens: { input: 1000, input_cached: 0, output: 55 }, cost_usd: 0.000956, success: true, price_basis: "list" }, "every field and number as before");
    assert.equal(typeof latency_ms, "number");
    assert.deepEqual(gemini, { backend: "vertex-adc", project: "unit-test-project", location: "global", served_tier: "standard" });
  } finally {
    for (const [k, v] of [["GEMINI_BACKEND", saved.b], ["GOOGLE_CLOUD_PROJECT", saved.p], ["GOOGLE_CLOUD_LOCATION", saved.l], ["GEMINI_API_KEY", saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// The gemini record on the stage runner's events and the probe's events.
test("the stage runner's event for a Gemini typist call, and the run-start probe's event, carry the typist's gemini record", async () => {
  const { executeStage } = await import(join(DIST, "executor", "run.js"));
  const { probeTypists, probeEvents } = await import(join(DIST, "typistProbe.js"));
  const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));
  const gemini = { project: "p", location: "us", tries: [{ location: "us", ended_by: "answer", http_codes: [], s: 3, input_tokens: 100, input_tokens_cached: 0, output_tokens: 20, cost_usd: 0.0001 }], ended_by: "answer", last_status: null, stall_cuts: 0, failovers: 0, cut_calls: 0, google_wait_ms: 0, work_ms: 3000, slept_ms: 0, sdk_version: "0.1.22", usage_semantics: "unverified", unavailable: null, endpoint_override: null };
  const typist = { door: "agy", modelId: "flash", modelName: "gemini-3.8-flash", type: async (req) => ({ answer: { path: req.unit.path, content: "def thing():\n    return 1\n" }, transport: false, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.0001, latency_ms: 3000, gemini }) };
  const policy = loadPolicyFromPath(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "opus-only-v5.yaml"));
  const spec = { spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: [{ id: "U01", path: "app/m.py", phase: "codegen", import_line: "", exports: [], behaviour: "x", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 2 }] };
  const dir = mkdtempSync(join(tmpdir(), "records-stage-"));
  const emitted = [];
  try {
    await executeStage(spec, { stage: "codegen", codeDir: dir, passId: "p1", policy, concurrency: 1, routedAttempts: 2, transport: { maxWaits: 1, baseMs: 1, capMs: 1 } }, { typistFor: () => typist, fallback: typist, shared: "S", sharedFile: "/dev/null", emit: (e) => emitted.push(e), check: () => ({ ok: true }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(emitted[0]?.gemini, gemini, `the stage event: ${JSON.stringify(emitted[0])}`);
  const outcomes = await probeTypists([FLASH], "estimated", () => ({ ...typist, type: async () => ({ answer: { path: "probe.txt", content: "ok" }, transport: false, tokens: { input: 10, input_cached: 0, output: 2 }, cost_usd: 0.00001, latency_ms: 900, gemini }) }), () => null);
  assert.deepEqual(probeEvents(outcomes, { pass: "r1", policy: { name: "p", version: 1 } })[0].gemini, gemini, "the probe event");
});

// The typist writes its receipt before the SDK's teardown, which can block until the kill rule stops the worker.
test("a typist call that answered, whose worker the kill rule then stopped during the SDK's teardown, is recorded as answered, with its tokens", async () => {
  const receipt = v2(MOVED);
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 50, hb: { v: 1, state: "wait", work_s: 1, wait_s: 0, call_wait_s: 0, try: 1, location: "global", usage: {} } }], holdMs: "forever", onTerm: { receipt, exitCode: 143 } }] });
  const dir = mkdtempSync(join(tmpdir(), "records-teardown-"));
  writeFileSync(join(dir, "shared.txt"), "");
  try {
    const r = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
      new AgyTypist(FLASH, { effort: "LOW", maxModelCalls: 3, timeoutSec: 540, apiRetries: 6, apiRetryInitialMs: 2000, backstop: { noBeatS: 0.5, confirmS: 0.5 } })
        .type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" }));
    assert.equal(fake.events().filter((e) => e.ev === "term").length, 1, "the kill rule stopped the worker");
    assert.deepEqual(r.answer, { path: "a.txt", content: "x\n" });
    assert.equal(r.gemini?.ended_by, "answer", `an answered call is not recorded as a kill: ${JSON.stringify(r.gemini)}`);
    assert.equal(r.tokens.input, US_TOKENS.prompt_token_count);
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
