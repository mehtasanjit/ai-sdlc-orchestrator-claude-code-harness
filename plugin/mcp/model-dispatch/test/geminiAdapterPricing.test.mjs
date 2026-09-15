/**
 * T10: the two Gemini adapters price from the dated list, with the Vertex
 * regional surcharge applied on top exactly as before.
 *
 * The regression half pins bit-identical dollars: for every Gemini leaf a
 * shipped policy declares, through every door (AI Studio key, Vertex global,
 * Vertex regional), the adapter's figure must equal what develop computed
 * from the policy block (computeCostUsd over applyVertexSurcharge(block)).
 * The shipped blocks equal the list (test/prices.test.mjs), so moving the
 * source to the list must not move a cent, and must not add float noise.
 *
 * The behaviour half pins what the list changes: a hand-copied wrong block is
 * ignored with a warning; a leaf with no block is priced; `pricing_override`
 * bills the block, labelled custom; an unpriced day is refused before any
 * Gemini call or worker spawn.
 *
 * Offline: the Gemini transport is replaced after construction, and the
 * Antigravity worker is a shell script that writes a usage sidecar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { applyVertexSurcharge } from "../dist/adapters/geminiTransports.js";
import { computeCostUsd } from "../dist/pricing.js";
import { loadPolicy, loadPolicyFromPath } from "../dist/policy.js";
import { lookupPrice } from "../dist/prices.js";
import { WORKER_PYTHON_ENV } from "../dist/delegation/workerProcess.js";

// The governance demo's routing policy, an unedited copy of what the store
// synced into the demo project (see test/governanceDemoPolicy.test.mjs).
const DEMO_POLICY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "governance-demo", "routing-policy.yaml");

const TODAY = () => new Date("2026-09-14T12:00:00Z");
// Changed: the unpriced-day cases used 2027-01-02, a gap only until the list
// gained Google's 2027 Gemini 3.7 Flash card. The day before 3.7 Flash's GA
// (2026-08-13) is a gap no later period can fill; 2027-01-02 now pins the
// 2027 card instead.
const BEFORE_V37_GA = () => new Date("2026-08-12T12:00:00Z");
const IN_2027 = () => new Date("2027-01-02T12:00:00Z");
// The day before Gemini 3.8 Flash's GA (2026-09-02). Gemini 3.7 Flash is
// priced that day, so a shipped 3.8 leaf is refused only if it really names
// gemini-3.8-flash; a copy of the 3.7 policy still naming 3.7 would be billed.
const BEFORE_V38_GA = () => new Date("2026-09-01T12:00:00Z");

const USAGE = { promptTokenCount: 123457, cachedContentTokenCount: 45678, candidatesTokenCount: 2345, thoughtsTokenCount: 6789 };
const TOKENS = { input: 123457 - 45678, input_cached: 45678, output: 2345 + 6789 };
const SIDECAR = {
  usage: { prompt_token_count: 123457, cached_content_token_count: 45678, candidates_token_count: 2345, thoughts_token_count: 6789 },
  tool_call_count: 0,
};

const PACKET = {
  id: "pkt-t10",
  phase: "tests",
  task_type: "test_unit",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "t10",
};

const ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_BACKEND", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", WORKER_PYTHON_ENV];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    return [await fn(), captured];
  } finally {
    process.stderr.write = original;
  }
}

const DOORS = [
  { name: "AI Studio key", env: { GEMINI_API_KEY: "test-key" }, backend: "api-key", location: "" },
  { name: "Vertex global", env: { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "unit-test-project" }, backend: "vertex-adc", location: "global" },
  { name: "Vertex asia-south1", env: { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "unit-test-project", GOOGLE_CLOUD_LOCATION: "asia-south1" }, backend: "vertex-adc", location: "asia-south1" },
];

/** Build a GeminiFlashAdapter through a door, with its transport replaced by a recorder. */
async function flashRun(leaf, door, { now = TODAY } = {}) {
  return withEnv(door.env, async () => {
    const adapter = new GeminiFlashAdapter(leaf, { now });
    const calls = [];
    const real = adapter.transport;
    adapter.transport = {
      backend: real.backend,
      location: real.location,
      createCache: async () => undefined,
      generate: async (args) => { calls.push(args); return { text: '{"ok":true}', usage: USAGE, finishReason: "STOP" }; },
    };
    assert.equal(real.backend, door.backend, `door ${door.name} built the wrong transport`);
    const [out, stderr] = await captureStderr(() => adapter.execute(PACKET));
    return { out, stderr, calls };
  });
}

/** What develop billed: the policy block with the surcharge applied at the resolved endpoint. */
const developFigure = (tokens, block, door, modelName) =>
  computeCostUsd(tokens, applyVertexSurcharge(block, { backend: door.backend, location: door.location, modelName }));

function shippedLeaves(adapter) {
  const out = [];
  // Changed: opus-plus-flash-v38 (Gemini 3.8 Flash, added in v0.7.3) joins the
  // shipped policies whose Gemini leaves are pinned here.
  for (const name of ["opus-plus-flash", "opus-plus-flash-v37", "opus-plus-flash-v38", "flash-agsdk-only"]) {
    for (const m of loadPolicy({ policyName: name }).models) if (m.adapter === adapter) out.push({ policy: name, leaf: m });
  }
  return out;
}

// ─── GeminiFlashAdapter ─────────────────────────────────────────────────

test("T10 GeminiFlashAdapter: list price x surcharge equals today's figure for every shipped completion leaf and door", async () => {
  const leaves = shippedLeaves("mcp:model-dispatch");
  assert.ok(leaves.length >= 3, "expected the 3.5, 3.7 and 3.8 completion leaves");
  for (const { policy, leaf } of leaves) {
    for (const door of DOORS) {
      const { out } = await flashRun(leaf, door);
      const expected = developFigure(TOKENS, leaf.pricing, door, leaf.model_name);
      assert.equal(out.cost_usd, expected, `${policy}/${leaf.id} via ${door.name}`);
      assert.equal(out.attempts[0].cost_usd, expected, `${policy}/${leaf.id} via ${door.name} (attempt)`);
    }
  }
});

test("T10 GeminiFlashAdapter: a hand-copied wrong block is ignored, the list is billed, a warning names both", async () => {
  // A 3.5 Flash leaf carrying someone else's card (0.30 / 0.03 / 2.50).
  const leaf = { id: "flash-wrong-card", adapter: "mcp:model-dispatch", model_name: "gemini-3.5-flash", pricing: { input: 0.3, input_cached: 0.03, output: 2.5 } };
  const door = DOORS[2];
  const { out, stderr } = await flashRun(leaf, door);
  assert.equal(out.cost_usd, developFigure(TOKENS, { input: 1.5, input_cached: 0.15, output: 9 }, door, leaf.model_name));
  assert.equal(out.attempts[0].price_basis, "list");
  assert.match(stderr, /WARN\s+pricing\.policy_mismatch/);
  assert.match(stderr, /model_id=flash-wrong-card/);
});

test("T10 GeminiFlashAdapter: a leaf with no pricing block is priced from the list", async () => {
  const leaf = { id: "flash-no-card", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash" };
  const { out } = await flashRun(leaf, DOORS[0]);
  assert.equal(out.success, true);
  assert.equal(out.cost_usd, computeCostUsd(TOKENS, { input: 0.75, input_cached: 0.075, output: 3.75 }));
});

test("T10 GeminiFlashAdapter: pricing_override bills the block with the surcharge, labelled custom", async () => {
  const block = { input: 0.3, input_cached: 0.03, output: 2.5 };
  const leaf = { id: "flash-custom", adapter: "mcp:model-dispatch", model_name: "gemini-3.5-flash", pricing: block, pricing_override: true };
  const door = DOORS[2];
  const { out, stderr } = await flashRun(leaf, door);
  assert.equal(out.cost_usd, developFigure(TOKENS, block, door, leaf.model_name));
  assert.equal(out.attempts[0].price_basis, "custom");
  assert.doesNotMatch(stderr, /pricing\.policy_mismatch/);
});

test("T10 GeminiFlashAdapter: an unpriced dispatch day is refused before any Gemini call", async () => {
  const leaf = loadPolicy({ policyName: "opus-plus-flash-v37" }).models.find((m) => m.id === "flash-completion");
  const { out, calls } = await flashRun(leaf, DOORS[0], { now: BEFORE_V37_GA });
  assert.equal(calls.length, 0);
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /unpriced/);
  assert.match(out.error, /no price period for gemini-3\.7-flash on 2026-08-12/);
  assert.equal(out.cost_usd, 0);
});

test("T10 GeminiFlashAdapter: the shipped 3.8 leaf is refused the day before Gemini 3.8 Flash's GA, a day 3.7 Flash is priced", async () => {
  // Pins that opus-plus-flash-v38 names gemini-3.8-flash, not the 3.7 model it
  // was copied from: on 2026-09-01 a 3.7 leaf is billed, a 3.8 leaf is refused.
  const leaf = loadPolicy({ policyName: "opus-plus-flash-v38" }).models.find((m) => m.id === "flash-completion");
  const { out, calls } = await flashRun(leaf, DOORS[0], { now: BEFORE_V38_GA });
  assert.equal(calls.length, 0);
  assert.equal(out.success, false);
  assert.match(out.error, /no price period for gemini-3\.8-flash on 2026-09-01/);
  assert.equal(out.cost_usd, 0);
  const v37 = loadPolicy({ policyName: "opus-plus-flash-v37" }).models.find((m) => m.id === "flash-completion");
  assert.equal((await flashRun(v37, DOORS[0], { now: BEFORE_V38_GA })).out.success, true, "3.7 Flash is priced on 2026-09-01");
});

test("T10 GeminiFlashAdapter: from 2027-01-01 the shipped 3.7 and 3.8 leaves bill the list's 2027 card at every door and warn their block is stale", async () => {
  // The 2027 behaviour end to end: the dispatch is not refused, the list's
  // 1.50 / 0.15 / 7.50 card is billed with the regional surcharge where it
  // applies, and the shipped introductory block draws a mismatch warning.
  // Changed: the 3.8 policy (added in v0.7.3) ships the same introductory
  // card, so it is held to the same 2027 behaviour.
  for (const policyName of ["opus-plus-flash-v37", "opus-plus-flash-v38"]) {
    const leaf = loadPolicy({ policyName }).models.find((m) => m.id === "flash-completion");
    for (const door of DOORS) {
      const where = `${policyName} via ${door.name}`;
      const { out, calls, stderr } = await flashRun(leaf, door, { now: IN_2027 });
      assert.equal(calls.length, 1, where);
      assert.equal(out.success, true, where);
      assert.equal(out.cost_usd, developFigure(TOKENS, { input: 1.5, input_cached: 0.15, output: 7.5 }, door, leaf.model_name), where);
      assert.equal(out.attempts[0].price_basis, "list", where);
      assert.match(stderr, /WARN\s+pricing\.policy_mismatch/, where);
    }
  }
});

test("opus-plus-flash-v38 is opus-plus-flash-v37 with the mechanical tier on Gemini 3.8 Flash", () => {
  // The 3.8 policy is a copy of the 3.7 one. This keeps the two from drifting:
  // same Opus leaf, same routing rules, same doors and default door, same cap,
  // and every Gemini leaf names gemini-3.8-flash.
  const v37 = loadPolicy({ policyName: "opus-plus-flash-v37" });
  const v38 = loadPolicy({ policyName: "opus-plus-flash-v38" });
  assert.equal(v38.name, "opus-plus-flash-v38");
  assert.deepEqual(v38.rules, v37.rules);
  assert.equal(v38.hard_cost_cap_usd, v37.hard_cost_cap_usd);
  assert.deepEqual(v38.models.map((m) => [m.id, m.adapter]), v37.models.map((m) => [m.id, m.adapter]));
  const strip = ({ reason, ...slot }) => slot;
  assert.deepEqual(strip(v38.select["gemini-flash"]), strip(v37.select["gemini-flash"]));
  assert.match(v38.select["gemini-flash"].reason, /Gemini 3\.8/);
  for (const m of v38.models) {
    const m37 = v37.models.find((x) => x.id === m.id);
    if (m.adapter === "builtin-anthropic") {
      assert.deepEqual(m, m37, m.id);
      continue;
    }
    assert.equal(m.model_name, "gemini-3.8-flash", m.id);
    assert.deepEqual(m.pricing, m37.pricing, `${m.id}: 3.7 and 3.8 Flash share the introductory card`);
    assert.equal(m.worker_timeout_sec, m37.worker_timeout_sec, m.id);
    assert.equal(m.max_output_tokens_absolute, m37.max_output_tokens_absolute, m.id);
    assert.deepEqual(m.auth, m37.auth, m.id);
  }
});

// ─── Every Gemini list period at Vertex's published regional price ─────
//
// What: each Gemini period on the dated list, run through
// applyVertexSurcharge, equals the row Google prints for it on the Vertex AI
// pricing page: the Global row at the global endpoint and through the AI
// Studio key, the Non-global row at a regional endpoint.
//
// Why: the list stores only the Global / AI Studio rate and relies on
// applyVertexSurcharge for the +10% regional price. Gemini 3.5 Flash-Lite,
// 3.8 Flash's two periods and the 2027 period of 3.7 Flash were added to the
// list on 2026-09-14; if the surcharge rule (which keys on the model name)
// skipped one of them, regional Vertex work on it would bill 10% low with no
// failing test. The coverage check also fails when a Gemini period is added
// to the list without its Non-global row here.
//
// Source: https://cloud.google.com/vertex-ai/generative-ai/pricing, read on
// 2026-09-14 (two fetches, identical text). Global and Non-global rows as
// printed, USD per 1M tokens: 3.5 Flash $1.50 / $0.15 / $9.00 and $1.65 /
// $0.165 / $9.90; 3.5 Flash-Lite $0.30 / $0.03 / $2.50 and $0.33 / $0.033 /
// $2.75; 3.7 and 3.8 Flash "through December 31, 2026" $0.75 / $0.075 /
// $3.75 and $0.825 / $0.0825 / $4.125, "starting January 1, 2027" $1.50 /
// $0.15 / $7.50 and $1.65 / $0.165 / $8.25.
const r3 = (input, input_cached, output) => ({ input, input_cached, output });
const VERTEX_ROWS = {
  "gemini-3.5-flash|2026-05-19": { global: r3(1.5, 0.15, 9), nonGlobal: r3(1.65, 0.165, 9.9) },
  "gemini-3.5-flash-lite|2026-07-21": { global: r3(0.3, 0.03, 2.5), nonGlobal: r3(0.33, 0.033, 2.75) },
  "gemini-3.7-flash|2026-08-13": { global: r3(0.75, 0.075, 3.75), nonGlobal: r3(0.825, 0.0825, 4.125) },
  "gemini-3.7-flash|2027-01-01": { global: r3(1.5, 0.15, 7.5), nonGlobal: r3(1.65, 0.165, 8.25) },
  "gemini-3.8-flash|2026-09-02": { global: r3(0.75, 0.075, 3.75), nonGlobal: r3(0.825, 0.0825, 4.125) },
  "gemini-3.8-flash|2027-01-01": { global: r3(1.5, 0.15, 7.5), nonGlobal: r3(1.65, 0.165, 8.25) },
};
// Two regional endpoints, so the check is about "not global", not one region.
const SURCHARGE_DOORS = [...DOORS, { name: "Vertex us-central1", backend: "vertex-adc", location: "us-central1" }];
const round4 = (rates) => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]));

test("T10 every Gemini list period bills Vertex's Global row at global and AI Studio, and its Non-global row at a regional endpoint", () => {
  const expectedKeys = Object.keys(VERTEX_ROWS);
  for (const key of expectedKeys) {
    const [id, from] = key.split("|");
    const r = lookupPrice(id, from, {});
    assert.equal(r.unpriced, false, `${id} on ${from}: ${r.reason}`);
    assert.equal(r.period.from, from, `${id}: ${from} must be a period's first day`);
    const list = r3(r.pricing.input, r.pricing.input_cached, r.pricing.output);
    assert.deepEqual(list, VERTEX_ROWS[key].global, `${id} from ${from}: list rate vs Vertex Global row`);
    for (const door of SURCHARGE_DOORS) {
      const billed = applyVertexSurcharge(list, { backend: door.backend, location: door.location, modelName: id });
      const regional = door.backend === "vertex-adc" && door.location !== "global";
      assert.deepEqual(
        round4(r3(billed.input, billed.input_cached, billed.output)),
        regional ? VERTEX_ROWS[key].nonGlobal : VERTEX_ROWS[key].global,
        `${id} from ${from} via ${door.name}`,
      );
    }
  }
});

test("T10 every Gemini period on the list has its Vertex rows pinned above", async () => {
  const { PRICE_LIST } = await import("../dist/prices.js");
  const listed = Object.entries(PRICE_LIST)
    .filter(([id]) => id.startsWith("gemini-"))
    .flatMap(([id, periods]) => periods.map((p) => `${id}|${p.from}`))
    .sort();
  assert.deepEqual(listed, Object.keys(VERTEX_ROWS).sort());
});

test("T10 GeminiFlashAdapter: the governance demo's flash-lite leaf dispatches at every door, billed at the Flash-Lite list card, its 0.50 / 0.05 / 3.00 block reported", async () => {
  // Why: the demo policy routes its codegen rule to this leaf. Before
  // Flash-Lite's period was on the list, pre-flight halted the policy
  // (test/governanceDemoPolicy.test.mjs) and this adapter refused every such
  // dispatch as unpriced. This pins the dispatch itself: one Gemini call per
  // door, the list card billed with the regional surcharge where it applies,
  // and the demo's stale block logged as a mismatch, never billed.
  const leaf = loadPolicyFromPath(DEMO_POLICY).models.find((m) => m.id === "flash-lite");
  assert.equal(leaf.model_name, "gemini-3.5-flash-lite");
  for (const door of DOORS) {
    const { out, calls, stderr } = await flashRun(leaf, door);
    assert.equal(calls.length, 1, `${door.name}: ${out.error}`);
    assert.equal(out.success, true, door.name);
    assert.equal(out.attempts[0].price_basis, "list", door.name);
    assert.equal(out.cost_usd, developFigure(TOKENS, { input: 0.3, input_cached: 0.03, output: 2.5 }, door, leaf.model_name), door.name);
    assert.match(stderr, /WARN\s+pricing\.policy_mismatch/, door.name);
    assert.match(stderr, /model_id=flash-lite/, door.name);
  }
});

// ─── AntigravityWorkerAdapter ───────────────────────────────────────────

/** A stand-in interpreter: writes the usage sidecar the adapter reads, prints a result, leaves a marker. */
function fakeWorker() {
  const dir = mkdtempSync(join(tmpdir(), "t10-agsdk-"));
  const marker = join(dir, "worker-ran");
  const script = join(dir, "fake-python.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `touch '${marker}'`,
      'U=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--usage-file" ]; then U="$2"; fi',
      "  shift",
      "done",
      `printf '%s' '${JSON.stringify(SIDECAR)}' > "$U"`,
      `printf '%s' '{"ok":true}'`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  const work = join(dir, "work");
  mkdirSync(work);
  mkdirSync(join(dir, "evidence"));
  return { script, marker, work, telemetry: join(dir, "evidence", "telemetry.jsonl") };
}

async function workerRun(leaf, { now = TODAY, location } = {}) {
  const fake = fakeWorker();
  const env = { GOOGLE_CLOUD_PROJECT: "unit-test-project", [WORKER_PYTHON_ENV]: fake.script, ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}) };
  return withEnv(env, async () => {
    const adapter = new AntigravityWorkerAdapter(leaf, { now });
    const [out, stderr] = await captureStderr(() => adapter.execute(PACKET, undefined, { work_dir: fake.work, telemetry_path: fake.telemetry }));
    return { out, stderr, ran: existsSync(fake.marker), location: adapter.location };
  });
}

test("T10 AntigravityWorkerAdapter: list price x surcharge equals today's figure for every shipped worker leaf, global and regional", async () => {
  const leaves = shippedLeaves("antigravity-worker");
  assert.ok(leaves.length >= 4, "expected the worker leaves of opus-plus-flash, -v37, -v38 and flash-agsdk-only");
  const tokens = { input: TOKENS.input, input_cached: TOKENS.input_cached, output: TOKENS.output };
  for (const { policy, leaf } of leaves) {
    for (const location of [undefined, "asia-south1"]) {
      const { out, ran, location: resolved } = await workerRun(leaf, { location });
      assert.equal(ran, true);
      assert.equal(out.success, true, `${policy}/${leaf.id}: ${out.error}`);
      const expected = computeCostUsd(tokens, applyVertexSurcharge(leaf.pricing, { backend: "vertex-adc", location: resolved, modelName: leaf.model_name }));
      assert.equal(out.cost_usd, expected, `${policy}/${leaf.id} in ${resolved}`);
    }
  }
});

test("T10 AntigravityWorkerAdapter: a wrong block is ignored with a warning; an unpriced day never spawns the worker", async () => {
  const wrong = { id: "agsdk-wrong-card", adapter: "antigravity-worker", model_name: "gemini-3.5-flash", pricing: { input: 0.3, input_cached: 0.03, output: 2.5 } };
  const priced = await workerRun(wrong, { location: "asia-south1" });
  assert.equal(
    priced.out.cost_usd,
    computeCostUsd(TOKENS, applyVertexSurcharge({ input: 1.5, input_cached: 0.15, output: 9 }, { backend: "vertex-adc", location: "asia-south1", modelName: "gemini-3.5-flash" })),
  );
  assert.equal(priced.out.attempts[0].price_basis, "list");
  assert.match(priced.stderr, /WARN\s+pricing\.policy_mismatch/);

  const v37 = loadPolicy({ policyName: "flash-agsdk-only" }).models[0];
  const refused = await workerRun(v37, { now: BEFORE_V37_GA });
  assert.equal(refused.ran, false, "no unpriced work is ever dispatched");
  assert.equal(refused.out.success, false);
  assert.match(refused.out.error, /unpriced/);

  // Changed: the 3.8 policy's agent door (added in v0.7.3) is refused the day
  // before Gemini 3.8 Flash's GA without spawning the worker.
  const v38 = loadPolicy({ policyName: "opus-plus-flash-v38" }).models.find((m) => m.id === "flash-agsdk-worker");
  const refused38 = await workerRun(v38, { now: BEFORE_V38_GA });
  assert.equal(refused38.ran, false, "no unpriced 3.8 work is ever dispatched");
  assert.equal(refused38.out.success, false);
  assert.match(refused38.out.error, /no price period for gemini-3\.8-flash on 2026-09-01/);
});
