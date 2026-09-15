/**
 * The governance demo's routing policy through v0.7.3 pre-flight.
 *
 * What: test/fixtures/governance-demo/routing-policy.yaml is an unedited copy
 * of the policy the governance store synced into the demo project (store
 * policy version 4, `opus-plus-flash`). It is kept byte-identical on purpose,
 * its pricing_source URLs and stale pricing blocks included, so this suite
 * prices exactly what a demo run loads.
 *
 * Why: the policy's codegen rule routes to `flash-lite`
 * (gemini-3.5-flash-lite). v0.7.3 prices every reachable model from the dated
 * list before a run starts, and Flash-Lite was not on the list, so pre-flight
 * halted this policy in both auth modes before any work ran:
 *   "Cannot price 1 of 4 models in this policy: flash-lite
 *    (gemini-3.5-flash-lite: unknown model ..."
 * With Flash-Lite's verified period on the list (src/prices.ts), the policy
 * starts, flash-lite bills the list card, and its stale block is a warning.
 *
 * The suite assembles pre-flight the way server.ts preflightDispatch does:
 * losing `select:` options are excluded (unreachableModelIds), then
 * assessModels runs checkModelPrice on every remaining model. The day is
 * pinned so the suite does not change meaning as the calendar moves.
 *
 * Offline: the adapter factory is a stub that always constructs, so only the
 * price gate is exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyFromPath, getModel } from "../dist/policy.js";
import { unreachableModelIds } from "../dist/routing.js";
import { assessModels } from "../dist/preflight.js";
import { checkModelPrice, effectivePrice } from "../dist/effectivePrice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "governance-demo", "routing-policy.yaml");
const DAY = "2026-09-14";
const GEMINI_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const healthy = () => ({});

/** Pre-flight as server.ts preflightDispatch assembles it, on a fixed day and with no select override. */
function preflightOn(policy, authMode, day) {
  const notSelected = unreachableModelIds(policy, {});
  return assessModels(
    policy.models.filter((m) => !notSelected.has(m.id)),
    authMode,
    healthy,
    (m) => checkModelPrice(getModel(policy, m.id), day, authMode),
  );
}

test("the demo policy reaches flash-lite through a rule, so pre-flight must price gemini-3.5-flash-lite", () => {
  const policy = loadPolicyFromPath(FIXTURE);
  assert.equal(policy.name, "opus-plus-flash");
  assert.equal(getModel(policy, "flash-lite").model_name, "gemini-3.5-flash-lite");
  assert.ok(policy.rules.some((r) => r.use === "flash-lite"), "the codegen rule names flash-lite directly");
  assert.deepEqual([...unreachableModelIds(policy, {})], ["flash-agsdk-worker"], "only the losing select option is skipped");
});

test("the demo policy passes pre-flight on 2026-09-14 in both auth modes, every reachable model priced from the list", () => {
  const policy = loadPolicyFromPath(FIXTURE);
  for (const mode of ["vendor", "estimated"]) {
    const out = preflightOn(policy, mode, DAY);
    assert.equal(out.halt_reason, null, `${mode}: ${out.halt_reason}`);
    assert.equal(out.ok, true, mode);
    assert.deepEqual(
      out.models.map((m) => [m.id, m.price_basis, m.unpriced]),
      [
        ["opus", "list", undefined],
        ["flash-completion", "list", undefined],
        ["flash-lite", "list", undefined],
      ],
      mode,
    );
  }
});

test("flash-lite bills the verified list card 0.30 / 0.03 / 2.50; the demo's 0.50 / 0.05 / 3.00 block is reported, not billed", () => {
  const policy = loadPolicyFromPath(FIXTURE);
  const r = effectivePrice(getModel(policy, "flash-lite"), DAY);
  assert.equal(r.unpriced, false, r.reason);
  assert.equal(r.basis, "list");
  assert.deepEqual(r.pricing, { input: 0.3, input_cached: 0.03, input_cache_write: 0.3, input_cache_write_1h: 0.3, output: 2.5 });
  assert.deepEqual(r.period, { from: "2026-07-21", to: null, source_url: GEMINI_URL, verified: DAY });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /'flash-lite' \(gemini-3\.5-flash-lite\)/);
  assert.match(r.warnings[0], /differs on input, input_cached, output/);
  // The other demo cards (Opus 4.7, 3.5 Flash) already equal the list.
  assert.deepEqual(preflightOn(policy, "vendor", DAY).price_warnings, r.warnings);
});

test("before Flash-Lite's GA day (2026-07-21) pre-flight halts, naming the model and both ways to price it", () => {
  const policy = loadPolicyFromPath(FIXTURE);
  for (const mode of ["vendor", "estimated"]) {
    const out = preflightOn(policy, mode, "2026-07-20");
    assert.equal(out.ok, false, mode);
    assert.match(
      out.halt_reason,
      /Cannot price 1 of 3 models in this policy: flash-lite \(gemini-3\.5-flash-lite: no price period for gemini-3\.5-flash-lite on 2026-07-20/,
    );
    assert.match(out.halt_reason, /add its verified price period to plugin\/mcp\/model-dispatch\/src\/prices\.ts/);
    assert.match(out.halt_reason, /give policy model 'flash-lite' a pricing block with pricing_override: true/);
    assert.equal(out.models.find((m) => m.id === "flash-lite").unpriced, true);
  }
});

test("Q3: load_policy's view of the demo policy shows flash-lite at the list card its dispatches bill, not its stale block, and names the block as ignored", async () => {
  // Imported here so a missing export fails this test alone, not the file.
  const { withEffectivePrices } = await import("../dist/effectivePrice.js");
  const { lookupPrice } = await import("../dist/prices.js");
  const policy = loadPolicyFromPath(FIXTURE);
  const view = withEffectivePrices(policy, DAY);
  const by = Object.fromEntries(view.models.map((m) => [m.id, m]));
  const lite = by["flash-lite"];
  assert.deepEqual(lite.pricing && [lite.pricing.input, lite.pricing.input_cached, lite.pricing.output], [0.5, 0.05, 3], "the demo's own block, kept as written");
  assert.equal(lite.effective_price.basis, "list");
  assert.deepEqual(lite.effective_price.rates, lookupPrice("gemini-3.5-flash-lite", DAY, {}).pricing);
  assert.deepEqual([lite.effective_price.rates.input, lite.effective_price.rates.input_cached, lite.effective_price.rates.output], [0.3, 0.03, 2.5]);
  assert.equal(lite.effective_price.pricing_block, "ignored_differs_from_list");
  // The same numbers a dispatch bills that day.
  assert.deepEqual(lite.effective_price.rates, effectivePrice(getModel(policy, "flash-lite"), DAY).pricing);
  // The in-session Opus seat, whose rates the orchestrator's estimates use.
  const opus = by.opus;
  assert.equal(opus.adapter, "builtin-anthropic");
  assert.deepEqual([opus.effective_price.basis, opus.effective_price.rates], ["list", lookupPrice(opus.model_name, DAY, {}).pricing]);
});
