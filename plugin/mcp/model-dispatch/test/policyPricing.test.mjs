/**
 * T9 through the modules that already exist: the policy loader, pre-flight,
 * the Anthropic API adapter and the what-if replay, each pricing a policy
 * model with its effective price (src/effectivePrice.ts) instead of the
 * policy block.
 *
 * - Loader: a `pricing:` block is optional; `pricing_override` is a boolean
 *   and needs a block to bill.
 * - Pre-flight: an unpriced model this run can reach halts the run before
 *   anything is spent, in both auth modes. A model run in-session under
 *   `estimated` needs no block (Q3: the orchestrator's estimates read
 *   load_policy's effective price). Price warnings are reported, never halting.
 * - BuiltinAnthropicAdapter: bills the list; a wrong block is ignored with a
 *   warning; today's Opus figure is unchanged.
 * - simulate_policy: replays at the effective price on each event's own day,
 *   lists what it could not price, and reads the 1-hour cache-write count as
 *   a share of `input_tokens_cache_write`, the convention both producers of
 *   that field write.
 *
 * Offline: the Anthropic client is replaced after construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy, loadPolicyFromPath } from "../dist/policy.js";
import * as preflight from "../dist/preflight.js";
import { BuiltinAnthropicAdapter } from "../dist/adapters/BuiltinAnthropicAdapter.js";
import { simulatePolicyCost } from "../dist/routing.js";
import { computeCostUsd } from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = "2026-09-14";
const SONNET_5_LIST = { input: 2, input_cached: 0.2, output: 10, input_cache_write: 2.5, input_cache_write_1h: 4 };
const OLD_SONNET_5_CARD = { input: 3, input_cached: 0.3, output: 15 };

async function effectivePriceModule() {
  try {
    return await import("../dist/effectivePrice.js");
  } catch (err) {
    assert.fail(`dist/effectivePrice.js is missing: ${err.message}`);
  }
}

function policyFile(yamlText) {
  const dir = mkdtempSync(join(tmpdir(), "t9-policy-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, yamlText);
  return path;
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

// ─── loader ─────────────────────────────────────────────────────────────

test("T9 loader: a model with no pricing block loads (the list prices it)", () => {
  const policy = loadPolicyFromPath(policyFile(`
version: 1
name: t9-no-card
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: opus
`));
  assert.equal(policy.models[0].pricing, undefined);
});

test("T9 loader: pricing_override must be a boolean and needs a block to bill", () => {
  const base = (extra) => `
version: 1
name: t9-override
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
${extra}
rules:
  - default: opus
`;
  assert.throws(() => loadPolicyFromPath(policyFile(base("    pricing_override: true"))), /pricing_override: true.*needs a pricing block/);
  assert.throws(
    () => loadPolicyFromPath(policyFile(base("    pricing_override: \"yes\"\n    pricing: { input: 5, input_cached: 0.5, output: 25 }"))),
    /pricing_override must be true or false/,
  );
  assert.throws(
    () => loadPolicyFromPath(policyFile(base("    pricing: { input: 5, input_cached: 0.5, output: 25, input_cache_write_1h: \"10\" }"))),
    /pricing\.input_cache_write_1h must be number/,
  );
  const ok = loadPolicyFromPath(policyFile(base("    pricing_override: true\n    pricing: { input: 5, input_cached: 0.5, output: 25 }")));
  assert.equal(ok.models[0].pricing_override, true);
});

// ─── pre-flight ─────────────────────────────────────────────────────────

const MODELS = [
  { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", pricing: { input: 5, input_cached: 0.5, output: 25 } },
  // Changed fixture: this leaf was gemini-3.5-flash-lite, which is now on the
  // list. A name no vendor publishes keeps the case about a model the list
  // cannot know. The real Flash-Lite policy is test/governanceDemoPolicy.test.mjs.
  { id: "lite", adapter: "mcp:model-dispatch", model_name: "gateway-unlisted-model", pricing: { input: 0.1, input_cached: 0.01, output: 0.4 } },
];
const healthy = () => ({});

async function priceCheckFor(models, authMode) {
  const ep = await effectivePriceModule();
  const byId = new Map(models.map((m) => [m.id, m]));
  return (m) => ep.checkModelPrice(byId.get(m.id), DAY, authMode);
}

test("T9 pre-flight: an unpriced model halts the run before anything is spent, in both auth modes", async () => {
  for (const mode of ["vendor", "estimated"]) {
    const out = preflight.assessModels(MODELS, mode, healthy, await priceCheckFor(MODELS, mode));
    assert.equal(out.ok, false, `${mode}: unpriced work must never be dispatched`);
    assert.match(out.halt_reason, /Cannot price 1 of 2 models/);
    assert.match(out.halt_reason, /lite \(gateway-unlisted-model: unknown model/);
    assert.match(out.halt_reason, /pricing_override: true/);
    const lite = out.models.find((m) => m.id === "lite");
    assert.equal(lite.ok, true, "construction succeeded; the price is what failed");
    assert.equal(lite.unpriced, true);
    assert.match(lite.price_error, /unknown model/);
    assert.equal(out.models.find((m) => m.id === "opus").price_basis, "list");
  }
});

test("T9 pre-flight: pricing_override lets a model the list cannot price start, labelled custom", async () => {
  const models = [MODELS[0], { ...MODELS[1], pricing_override: true }];
  const out = preflight.assessModels(models, "vendor", healthy, await priceCheckFor(models, "vendor"));
  assert.equal(out.ok, true);
  assert.equal(out.halt_reason, null);
  assert.equal(out.models.find((m) => m.id === "lite").price_basis, "custom");
});

test("T9 pre-flight: a policy block that differs from the list is a price warning, not a halt", async () => {
  const models = [{ id: "sonnet", adapter: "mcp:model-dispatch", model_name: "claude-sonnet-5", pricing: OLD_SONNET_5_CARD }];
  const out = preflight.assessModels(models, "vendor", healthy, await priceCheckFor(models, "vendor"));
  assert.equal(out.ok, true);
  assert.deepEqual(out.warnings, [], "`warnings` stays reserved for models this run does not dispatch to");
  assert.equal(out.price_warnings.length, 1);
  assert.match(out.price_warnings[0], /input 3\b.*input 2\b/s);
});

test("T9 pre-flight (Q3): an in-session model with no pricing block starts in both modes — estimates read load_policy's effective price, not the block", async () => {
  // RE-DERIVED (Q3, v0.7.3): this halted under estimated, because orchestrator.md
  // rule 6 priced in-session estimates from the block text. The estimates now read
  // `effective_price` from load_policy (the list, or the block only under
  // pricing_override), so a missing block leaves nothing unpriced; a model with no
  // list price still halts (the "unpriced model" test above).
  const models = [{ id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5" }];
  for (const mode of ["estimated", "vendor"]) {
    const out = preflight.assessModels(models, mode, healthy, await priceCheckFor(models, mode));
    assert.equal(out.ok, true, `${mode}: ${out.halt_reason}`);
    assert.equal(out.halt_reason, null);
    assert.equal(out.models[0].price_basis, "list");
  }
});

test("T9 load_policy server wiring (Q3): the tool returns the policy with every model's effective price for the day it is called", () => {
  // dist-grep, as above: importing dist/server.js starts a stdio server.
  // withEffectivePrices itself is pinned in effectivePrice.test.mjs.
  const src = readFileSync(join(HERE, "..", "dist", "server.js"), "utf-8");
  assert.match(src, /case "load_policy": \{[\s\S]*?withEffectivePrices\(policy, new Date\(\)\)[\s\S]*?\}/);
});

test("T9 pre-flight: a credential failure and an unpriced model are both named", async () => {
  const failing = (id) => { if (id === "opus") throw new Error("ANTHROPIC_API_KEY not set"); return {}; };
  const out = preflight.assessModels(MODELS, "vendor", failing, await priceCheckFor(MODELS, "vendor"));
  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /Cannot dispatch to 1 of 2 models/);
  assert.match(out.halt_reason, /Cannot price 1 of 2 models/);
});

test("T9 pre-flight server wiring: the tool prices every reachable model for today and returns price_warnings", () => {
  // dist-grep, because importing dist/server.js starts a stdio server. The
  // behaviour is pinned above through assessModels; this pins that the
  // preflight_dispatch tool actually passes the price check and returns its notes.
  const src = readFileSync(join(HERE, "..", "dist", "server.js"), "utf-8");
  assert.match(src, /checkModelPrice\(getModel\(policy, m\.id\), today, authMode\)/);
  assert.match(src, /price_warnings: assessment\.price_warnings/);
});

test("T9 dispatch server wiring: every telemetry event carries the attempt's price fields", () => {
  const src = readFileSync(join(HERE, "..", "dist", "server.js"), "utf-8");
  // transcript_logged_cost_usd (review finding M4): the collector subtracts only this share of a claude-cli event.
  for (const field of ["price_basis: att.price_basis", "cli_reported_cost_usd: att.cli_reported_cost_usd", "ttl_split: att.ttl_split", "transcript_logged_cost_usd: att.transcript_logged_cost_usd"]) {
    assert.ok(src.includes(field), `server.js must map ${field} into the event`);
  }
  assert.match(src, /unpriced_models: att\.unpriced_models\?\.length \? att\.unpriced_models : undefined/);
});

// ─── BuiltinAnthropicAdapter ────────────────────────────────────────────

const RESPONSE = {
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 5000, cache_creation_input_tokens: 3000 },
};
const RESPONSE_TOKENS = { input: 1200, input_cached: 5000, input_cache_write: 3000, output: 800 };
const PACKET = {
  id: "pkt-t9", phase: "codegen", task_type: "controller_handler", module: "example",
  instruction: "Return {ok:true}.", inputs: [], outputSchema: { type: "object" },
  acceptance: ["valid JSON"], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 }, pass_id: "t9",
};

async function anthropicRun(config, { response = RESPONSE, now = () => new Date(`${DAY}T12:00:00Z`) } = {}) {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const adapter = new BuiltinAnthropicAdapter(config, { now });
    const calls = [];
    adapter.client = { messages: { create: async (req) => { calls.push(req); return response; } } };
    const [out, stderr] = await captureStderr(() => adapter.execute(PACKET));
    return { out, stderr, calls };
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

test("T9 BuiltinAnthropicAdapter: the old Sonnet 5 card is ignored with a warning, the list is billed", async () => {
  const { out, stderr } = await anthropicRun({ id: "sonnet-api", adapter: "builtin-anthropic", model_name: "claude-sonnet-5", pricing: OLD_SONNET_5_CARD });
  assert.equal(out.cost_usd, computeCostUsd(RESPONSE_TOKENS, SONNET_5_LIST));
  assert.equal(out.attempts[0].price_basis, "list");
  assert.match(stderr, /WARN\s+pricing\.policy_mismatch/);
  assert.match(stderr, /model_id=sonnet-api/);
});

test("T9 BuiltinAnthropicAdapter: today's Opus figure is unchanged (the shipped block equals the list)", async () => {
  // Changed: opus-plus-flash-v38 (Gemini 3.8 Flash, added in v0.7.3) carries
  // the same Opus 5 leaf as -v37, so its Opus figure is pinned the same way.
  // The v38 file is new, so "unchanged" means equal to the -v37 figure.
  for (const name of ["opus-plus-flash", "opus-plus-flash-v37", "opus-plus-flash-v38"]) {
    const leaf = loadPolicy({ policyName: name }).models.find((m) => m.adapter === "builtin-anthropic");
    const { out } = await anthropicRun(leaf);
    assert.equal(out.cost_usd, computeCostUsd(RESPONSE_TOKENS, leaf.pricing), name);
  }
});

test("T9 BuiltinAnthropicAdapter: pricing_override bills the block, labelled custom", async () => {
  const { out, stderr } = await anthropicRun({ id: "sonnet-custom", adapter: "builtin-anthropic", model_name: "claude-sonnet-5", pricing: OLD_SONNET_5_CARD, pricing_override: true });
  assert.equal(out.cost_usd, computeCostUsd(RESPONSE_TOKENS, OLD_SONNET_5_CARD));
  assert.equal(out.attempts[0].price_basis, "custom");
  assert.doesNotMatch(stderr, /pricing\.policy_mismatch/);
});

test("T9 BuiltinAnthropicAdapter: an unpriced model is refused before any API call", async () => {
  const { out, calls } = await anthropicRun({ id: "unknown", adapter: "builtin-anthropic", model_name: "claude-opus-4-9" });
  assert.equal(calls.length, 0);
  assert.equal(out.success, false);
  assert.match(out.error, /unpriced/);
});

test("T9 BuiltinAnthropicAdapter: a response billed under a tier the list has no price for is recorded unpriced", async () => {
  const priority = { ...RESPONSE, usage: { ...RESPONSE.usage, service_tier: "priority" } };
  const { out, stderr } = await anthropicRun({ id: "opus-priority", adapter: "builtin-anthropic", model_name: "claude-opus-5" }, { response: priority });
  assert.equal(out.success, true);
  assert.equal(out.cost_usd, 0);
  assert.equal(out.attempts[0].unpriced_models.length, 1);
  assert.match(out.attempts[0].unpriced_models[0].reason, /service_tier "priority"/);
  assert.match(stderr, /WARN\s+pricing\.unpriced/);
});

// ─── simulate_policy ────────────────────────────────────────────────────

const REPLAY_POLICY = `
version: 1
name: t9-replay
models:
  - id: sonnet
    adapter: builtin-anthropic
    model_name: claude-sonnet-5
    pricing: { input: 3.00, input_cached: 0.30, output: 15.00 }
  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.7-flash
    pricing: { input: 0.75, input_cached: 0.075, output: 3.75 }
rules:
  - when: { phase: codegen }
    use: flash
  - default: sonnet
`;
const replayEvent = (over) => ({ phase: "requirements_analysis", task_type: "analysis", module: "cross", retry_count: 0, ts: `${DAY}T10:00:00.000Z`, input_tokens: 10_000, input_tokens_cached: 40_000, output_tokens: 2_000, ...over });

// Changed (v0.7.3 review fix): the replay now bills a Gemini event at the
// endpoint the environment would dispatch it to, with the Vertex regional
// surcharge. These pins replay with no Gemini environment, so they read the
// global rate on any machine; test/simulatePolicyCost.test.mjs pins the surcharge.
const OFFLINE = { env: {}, adcFileExists: false };

test("T9 simulate_policy replays at the list price, not a mismatched block", () => {
  const policy = loadPolicyFromPath(policyFile(REPLAY_POLICY));
  const out = simulatePolicyCost([replayEvent({})], policy, {}, OFFLINE);
  assert.equal(out.total_cost_usd, computeCostUsd({ input: 10_000, input_cached: 40_000, output: 2_000 }, SONNET_5_LIST));
  assert.deepEqual(out.unpriced, []);
});

test("T9 simulate_policy prices each event on its own day and lists what it cannot price", () => {
  const policy = loadPolicyFromPath(policyFile(REPLAY_POLICY));
  const tokens = { input: 10_000, input_cached: 40_000, output: 2_000 };
  const priced = replayEvent({ phase: "codegen" });
  // Changed case: the unpriced event was dated 2027-01-02, a gap only until the
  // list gained Google's 2027 Gemini 3.7 Flash card. The day before 3.7 Flash's
  // GA is a gap no later period fills, and a 2027 event now replays at the
  // 2027 card.
  const early = replayEvent({ phase: "codegen", ts: "2026-08-12T10:00:00.000Z" });
  const out = simulatePolicyCost([priced, early], policy, {}, OFFLINE);
  assert.equal(out.total_cost_usd, computeCostUsd(tokens, { input: 0.75, input_cached: 0.075, output: 3.75 }));
  assert.equal(out.unpriced.length, 1);
  assert.equal(out.unpriced[0].model_id, "flash");
  assert.equal(out.unpriced[0].events, 1);
  assert.match(out.unpriced[0].reason, /no price period for gemini-3\.7-flash on 2026-08-12/);
  const y2027 = simulatePolicyCost([replayEvent({ phase: "codegen", ts: "2027-01-02T10:00:00.000Z" })], policy, {}, OFFLINE);
  assert.equal(y2027.total_cost_usd, computeCostUsd(tokens, { input: 1.5, input_cached: 0.15, output: 7.5 }));
  assert.deepEqual(y2027.unpriced, []);
});

test("T9 simulate_policy reads input_tokens_cache_write_1h as a share of input_tokens_cache_write", () => {
  // Shaped like the collector's orchestrator event: 20,329 writes, all 1-hour.
  const policy = loadPolicyFromPath(policyFile(REPLAY_POLICY));
  const ev = replayEvent({ input_tokens_cache_write: 20_329, input_tokens_cache_write_1h: 20_329 });
  const out = simulatePolicyCost([ev], policy, {}, OFFLINE);
  assert.equal(
    out.total_cost_usd,
    computeCostUsd({ input: 10_000, input_cached: 40_000, input_cache_write: 0, input_cache_write_1h: 20_329, output: 2_000 }, SONNET_5_LIST),
    "each written token is priced once, at its own TTL rate",
  );
});
