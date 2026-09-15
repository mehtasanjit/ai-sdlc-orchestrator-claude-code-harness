/*
 * What-if replay pricing (routing.ts simulatePolicyCost, the `simulate_policy`
 * MCP tool).
 *
 * Pins that a replayed event is priced by the SAME arithmetic the live path
 * uses (pricing.ts computeCostUsd) on the SAME disjoint buckets a telemetry
 * event stores. The replay used to compute `input_tokens - input_tokens_cached`
 * before pricing — but `input_tokens` is already the fresh count, so every
 * cache-hit event was under-priced by its cached count and a cache-heavy event
 * replayed NEGATIVE. The only earlier test (selectSlots.test.mjs) used
 * input_tokens_cached: 0, which is why it never fired.
 *
 * Also pins the Vertex regional surcharge on replayed Gemini events (section
 * below).
 *
 * Offline, no network. The surcharge tests construct the two Gemini adapters
 * with test credentials to read what they bill, and never call them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPolicy } from "../dist/policy.js";
import { simulatePolicyCost } from "../dist/routing.js";
import {
  computeCostUsd,
  CACHE_WRITE_PREMIUM,
  CACHE_WRITE_PREMIUM_1H,
} from "../dist/pricing.js";
import { effectivePrice } from "../dist/effectivePrice.js";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { WORKER_PYTHON_ENV } from "../dist/delegation/workerProcess.js";

const policy = loadPolicy({ policyName: "opus-plus-flash-v37" });

// The replay bills a Gemini event at the endpoint this environment would
// dispatch it to (section below). These arithmetic pins replay with no Gemini
// environment at all, so they read the global rate on any machine, whatever
// GOOGLE_CLOUD_LOCATION or an API key its shell happens to carry.
const OFFLINE = { env: {}, adcFileExists: false };

// The replay prices each event on the day in its `ts`. Pinned inside the Gemini
// 3.7 Flash introductory period, so these arithmetic pins do not start
// failing on 2027-01-01 for a reason that has nothing to do with them.
const base = { phase: "tests", task_type: "test_unit", module: "cross", retry_count: 0, ts: "2026-09-14T10:00:00.000Z" };

// The live path's rates for a model on the events' day: the effective price
// (the dated list, or the block under pricing_override). Changed expectation
// (v0.7.3): these pins used the policy block directly. For the Gemini leaf
// these events route to, the block's omitted write rates fell back to
// Anthropic's 1.25x / 2x premiums, while the list prices Gemini writes at the
// input rate (Gemini has no write premium). The replay now bills what a
// dispatch bills, so the expectations follow the same rates.
function rates(model) {
  const price = effectivePrice(model, base.ts);
  assert.equal(price.unpriced, false, `${model.id} must be priced on ${base.ts}`);
  return price.pricing;
}

// Every event below matches the same rule, so the replay routes all of them
// to one model; read that model back from the replay itself rather than
// hardcoding an id that a future policy edit could move.
function modelFor(ev) {
  const { per_model } = simulatePolicyCost([ev], policy, {}, OFFLINE);
  const ids = Object.keys(per_model);
  assert.equal(ids.length, 1, "fixture event must route to exactly one model");
  return policy.models.find((m) => m.id === ids[0]);
}
// computeCostUsd rounds EVERY event to 6 decimals (round6), exactly as the
// live path does before an event's cost_usd is written, so a difference of
// two replayed prices can sit up to 1e-6 off the exact rate arithmetic.
const near = (a, b) => Math.abs(a - b) <= 1e-6;

test("a cache-hit event replays at the live price, never negative", () => {
  const ev = { ...base, input_tokens: 20_000, input_tokens_cached: 80_000, output_tokens: 3_000 };
  const model = modelFor(ev);
  const live = computeCostUsd({ input: 20_000, input_cached: 80_000, output: 3_000 }, rates(model));
  const replay = simulatePolicyCost([ev], policy, {}, OFFLINE);

  assert.ok(live > 0);
  assert.equal(replay.total_cost_usd, live);
  assert.equal(replay.per_model[model.id], live);

  // Regression guard: the pre-fix arithmetic on this very event went below
  // zero (fresh = 20k − 80k). If this ever stops being negative the fixture
  // no longer exercises the bug and needs bigger cached counts.
  const preFix =
    ((20_000 - 80_000) / 1e6) * rates(model).input +
    (80_000 / 1e6) * rates(model).input_cached +
    (3_000 / 1e6) * rates(model).output;
  assert.ok(preFix < 0, "fixture must be one the old subtraction priced negative");
});

test("cache reads only ever ADD their discounted cost to an event", () => {
  const noCache = { ...base, input_tokens: 20_000, input_tokens_cached: 0, output_tokens: 3_000 };
  const withCache = { ...noCache, input_tokens_cached: 80_000 };
  const model = modelFor(noCache);

  const a = simulatePolicyCost([noCache], policy, {}, OFFLINE).total_cost_usd;
  const b = simulatePolicyCost([withCache], policy, {}, OFFLINE).total_cost_usd;

  assert.ok(b > a, "adding cache reads must not lower the price");
  assert.ok(near(b - a, (80_000 / 1e6) * rates(model).input_cached));
});

test("5-minute and 1-hour cache writes replay at their own premiums", () => {
  const ev5m = { ...base, input_tokens: 10_000, input_tokens_cached: 0, input_tokens_cache_write: 5_000, output_tokens: 1_000 };
  // Changed fixture (v0.7.3): input_tokens_cache_write is the TOTAL written and
  // input_tokens_cache_write_1h its 1-hour share, the convention the
  // collector's event and claude-cli events write. The old fixture
  // ({write: 0, write_1h: 5000}) encoded a disjoint reading that priced every
  // real event's 1-hour writes twice.
  const ev1h = { ...ev5m, input_tokens_cache_write: 5_000, input_tokens_cache_write_1h: 5_000 };
  const model = modelFor(ev5m);

  const c5m = simulatePolicyCost([ev5m], policy, {}, OFFLINE).total_cost_usd;
  const c1h = simulatePolicyCost([ev1h], policy, {}, OFFLINE).total_cost_usd;

  assert.equal(c5m, computeCostUsd({ input: 10_000, input_cached: 0, input_cache_write: 5_000, output: 1_000 }, rates(model)));
  assert.equal(c1h, computeCostUsd({ input: 10_000, input_cached: 0, input_cache_write_1h: 5_000, output: 1_000 }, rates(model)));

  // The two tiers differ by exactly their rate gap on the written tokens
  // (explicit per-model rates when the policy declares them, else the
  // fresh-rate premiums pricing.ts defines).
  const rate5m = rates(model).input_cache_write ?? rates(model).input * CACHE_WRITE_PREMIUM;
  const rate1h = rates(model).input_cache_write_1h ?? rates(model).input * CACHE_WRITE_PREMIUM_1H;
  assert.ok(near(c1h - c5m, (5_000 / 1e6) * (rate1h - rate5m)));
});

test("a mixed batch replays to the sum of its live prices", () => {
  const events = [
    // pre-bucket shape: no cache-write key at all
    { ...base, input_tokens: 1_000, input_tokens_cached: 0, output_tokens: 100 },
    // the cache-heavy shape that used to go negative
    { ...base, input_tokens: 20_000, input_tokens_cached: 80_000, output_tokens: 3_000 },
    // all three input buckets populated
    { ...base, input_tokens: 500, input_tokens_cached: 4_500, input_tokens_cache_write: 2_000, output_tokens: 50 },
  ];
  const model = modelFor(events[0]);
  const expected = events.reduce(
    (sum, ev) =>
      sum +
      computeCostUsd(
        { input: ev.input_tokens, input_cached: ev.input_tokens_cached, input_cache_write: ev.input_tokens_cache_write, output: ev.output_tokens },
        rates(model)
      ),
    0
  );

  const out = simulatePolicyCost(events, policy, {}, OFFLINE);
  assert.ok(out.total_cost_usd > 0);
  assert.ok(near(out.total_cost_usd, expected));
  assert.ok(near(out.per_model[model.id], expected));
});

// ─── The Vertex regional surcharge on replayed Gemini events ────────────
//
// What: a replayed Gemini event is billed at the endpoint this environment
// would dispatch it to, with the +10% regional surcharge the adapters apply
// there: the agent door at the leaf's `region:`, else GOOGLE_CLOUD_LOCATION;
// the completion door through AI Studio (never surcharged) when its API key is
// set, else through Vertex at GOOGLE_CLOUD_LOCATION. Claude leaves, the global
// endpoint, and days before the surcharge took effect (2026-07-01) are not
// surcharged.
//
// Why (v0.7.3 review finding): the replay billed every event at the effective
// price alone, while both Gemini adapters bill that price x1.10 at a regional
// Vertex endpoint. On a regional install a what-if sat exactly 10% below the
// dollars the run logged for the same tokens, and docs/architecture.md said
// the two could not disagree.

const V38 = loadPolicy({ policyName: "opus-plus-flash-v38" });
const DAY = "2026-09-15T10:00:00.000Z";
const TOKENS = { input_tokens: 1_000_000, input_tokens_cached: 200_000, output_tokens: 1_000_000 };
const GEMINI_EVENT = { phase: "tests", task_type: "test_unit", module: "cross", retry_count: 0, ts: DAY, ...TOKENS };
const CLAUDE_EVENT = { ...GEMINI_EVENT, phase: "requirements_analysis" };
const WORKER_DOOR = { "gemini-flash": "flash-agsdk-worker" };
const VERTEX_REGIONAL = { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "unit-test-project", GOOGLE_CLOUD_LOCATION: "asia-south1" };

const ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_BACKEND", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", WORKER_PYTHON_ENV];
/** Run `fn` with exactly `vars` among the Gemini variables, restoring the shell's own afterwards. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const withLeaf = (p, id, extra) => ({ ...p, models: p.models.map((m) => (m.id === id ? { ...m, ...extra } : m)) });
const leafOf = (p, id) => p.models.find((m) => m.id === id);
const replay = (p, ev, overrides, env) => simulatePolicyCost([ev], p, overrides, { env, adcFileExists: false }).total_cost_usd;

/** What an adapter bills for GEMINI_EVENT's tokens: its own pricingOn(day).billed rates through computeCostUsd. */
function adapterFigure(adapter) {
  const price = adapter.pricingOn(new Date(DAY));
  assert.equal(price.unpriced, false);
  return computeCostUsd({ input: TOKENS.input_tokens, input_cached: TOKENS.input_tokens_cached, output: TOKENS.output_tokens }, price.billed);
}
const tenPercentAbove = (regional, global) => Math.abs(regional - global * 1.1) <= 2e-6;

test("surcharge: the agent door pinned to a region replays at exactly what the adapter bills there", () => {
  const p = withLeaf(V38, "flash-agsdk-worker", { region: "us-central1" });
  const adapter = withEnv({ GOOGLE_CLOUD_PROJECT: "unit-test-project", [WORKER_PYTHON_ENV]: process.execPath }, () => new AntigravityWorkerAdapter(leafOf(p, "flash-agsdk-worker")));
  assert.equal(adapter.location, "us-central1");

  const regional = replay(p, GEMINI_EVENT, WORKER_DOOR, {});
  assert.equal(regional, adapterFigure(adapter));
  assert.ok(tenPercentAbove(regional, replay(V38, GEMINI_EVENT, WORKER_DOOR, {})), "10% above the same leaf at the global endpoint");
});

test("surcharge: the agent door with no region follows GOOGLE_CLOUD_LOCATION, as the adapter does", () => {
  const env = { GOOGLE_CLOUD_PROJECT: "unit-test-project", GOOGLE_CLOUD_LOCATION: "asia-south1" };
  const adapter = withEnv({ ...env, [WORKER_PYTHON_ENV]: process.execPath }, () => new AntigravityWorkerAdapter(leafOf(V38, "flash-agsdk-worker")));
  assert.equal(adapter.location, "asia-south1");

  const regional = replay(V38, GEMINI_EVENT, WORKER_DOOR, env);
  assert.equal(regional, adapterFigure(adapter));
  assert.ok(tenPercentAbove(regional, replay(V38, GEMINI_EVENT, WORKER_DOOR, {})));
});

test("surcharge: the completion door through Vertex at a regional endpoint replays at what the adapter bills", () => {
  const adapter = withEnv(VERTEX_REGIONAL, () => new GeminiFlashAdapter(leafOf(V38, "flash-completion")));
  const regional = replay(V38, GEMINI_EVENT, {}, VERTEX_REGIONAL);
  assert.equal(regional, adapterFigure(adapter));
  assert.ok(tenPercentAbove(regional, replay(V38, GEMINI_EVENT, {}, {})));
});

test("surcharge: the completion door through an AI Studio key is never surcharged, whatever GOOGLE_CLOUD_LOCATION says", () => {
  const env = { GEMINI_API_KEY: "test-key", GOOGLE_CLOUD_LOCATION: "asia-south1" };
  const adapter = withEnv(env, () => new GeminiFlashAdapter(leafOf(V38, "flash-completion")));
  const viaKey = replay(V38, GEMINI_EVENT, {}, env);
  assert.equal(viaKey, adapterFigure(adapter));
  assert.equal(viaKey, replay(V38, GEMINI_EVENT, {}, {}));
});

test("surcharge: a Claude leaf is never surcharged, even in a regional Vertex environment", () => {
  assert.equal(replay(V38, CLAUDE_EVENT, {}, VERTEX_REGIONAL), replay(V38, CLAUDE_EVENT, {}, {}));
  assert.ok(replay(V38, CLAUDE_EVENT, {}, {}) > 0);
});

test("surcharge: an event dated before the surcharge took effect (2026-07-01, UTC day) replays at the list rate at any endpoint", () => {
  // Gemini 3.5 Flash, priced from 2026-05-19, so both days are on the list.
  const p = loadPolicy({ policyName: "opus-plus-flash" });
  const before = { ...GEMINI_EVENT, ts: "2026-06-30T23:59:00.000Z" };
  const on = { ...GEMINI_EVENT, ts: "2026-07-01T00:01:00.000Z" };
  assert.ok(replay(p, before, {}, {}) > 0);
  assert.equal(replay(p, before, {}, VERTEX_REGIONAL), replay(p, before, {}, {}));
  assert.ok(tenPercentAbove(replay(p, on, {}, VERTEX_REGIONAL), replay(p, on, {}, {})));
});
