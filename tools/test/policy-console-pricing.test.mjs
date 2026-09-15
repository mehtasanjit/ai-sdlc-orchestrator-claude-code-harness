/**
 * The policy console handles a model with no `pricing:` block, which v0.7.3
 * made valid.
 *
 * v0.7.3 prices every dispatch from the dated price list
 * (plugin/mcp/model-dispatch/src/prices.ts), so the loader
 * (src/policy.ts validateModel) no longer requires a block; a block is billed
 * only under `pricing_override: true`. The console still treated the block as
 * mandatory: renderModels and renderDefaultPhases read
 * `pricing.input.toFixed(2)` unguarded, so selecting a block-less policy threw
 * a TypeError and blanked the editor, and validateSaveInput refused every model
 * without `pricing.input`, so such a policy could not be previewed or saved.
 * It also showed a block's rates as if they were billed.
 *
 * Pins:
 * - modelPricingErrors (policy-server.mjs) accepts what the loader accepts and
 *   refuses what it refuses, and validateSaveInput checks pricing through it
 *   alone;
 * - rateLabel / rateTitle (index.html) render every model shape a valid policy
 *   can hold without throwing, and say which price a run bills;
 * - no other read of a model's `.pricing.input` / `.pricing.output` is left in
 *   the page.
 *
 * Offline and dependency-free, like the rest of the root suite: the console's
 * one dependency (yaml) is installed only when the browser flow first runs, so
 * the functions are read out of the source text and evaluated on their own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSOLE = join(REPO, "plugin", "policy-console");
const server = readFileSync(join(CONSOLE, "policy-server.mjs"), "utf-8");
const page = readFileSync(join(CONSOLE, "index.html"), "utf-8");

/** The text of a top-level `function name(...) {` whose body closes on a line holding only `}`. */
function extractFunction(src, name) {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `function ${name} not found`);
  return m[0];
}

/** Evaluate self-contained functions pulled out of a source file. */
function load(src, names) {
  return new Function(`${names.map((n) => extractFunction(src, n)).join("\n")}\nreturn { ${names.join(", ")} };`)();
}

const CARD = { input: 5, input_cached: 0.5, output: 25 };

test("modelPricingErrors accepts what the policy loader accepts and refuses what it refuses", () => {
  const { modelPricingErrors } = load(server, ["modelPricingErrors"]);
  const ok = (m) => assert.deepEqual(modelPricingErrors(m), [], JSON.stringify(m));
  const bad = (m, re) => {
    const errors = modelPricingErrors(m);
    assert.ok(errors.length > 0, `expected an error for ${JSON.stringify(m)}`);
    assert.match(errors.join(" "), re);
  };

  // Valid under v0.7.3: no block (priced from the list), a full card, optional write rates, the override flag.
  ok({ id: "opus" });
  ok({ id: "opus", pricing: null });
  ok({ id: "opus", pricing_override: false });
  ok({ id: "opus", pricing: CARD });
  ok({ id: "opus", pricing: { ...CARD, input_cache_write: 6.25, input_cache_write_1h: 10 } });
  ok({ id: "opus", pricing: CARD, pricing_override: true });

  // Refused by the loader, so a saved file would not load.
  bad({ id: "opus", pricing_override: true }, /pricing_override: true needs a pricing block/);
  bad({ id: "opus", pricing: CARD, pricing_override: "yes" }, /pricing_override must be true or false/);
  bad({ id: "opus", pricing: [5, 0.5, 25] }, /pricing must be a map/);
  bad({ id: "opus", pricing: { input: 5, output: 25 } }, /pricing\.input_cached must be a number/);
  bad({ id: "opus", pricing: { ...CARD, input: "5" } }, /pricing\.input must be a number/);
  bad({ id: "opus", pricing: { ...CARD, input_cache_write: "6.25" } }, /pricing\.input_cache_write must be a number/);
  // Stricter than the loader on purpose, as the console always was: no negative rate.
  bad({ id: "opus", pricing: { ...CARD, output: -1 } }, /pricing\.output must be a number ≥ 0/);
});

test("validateSaveInput checks model pricing only through modelPricingErrors", () => {
  const body = extractFunction(server, "validateSaveInput");
  assert.match(body, /modelPricingErrors\(m\)/);
  // A second pricing check here is how block-less models were refused before.
  assert.doesNotMatch(body, /m\.pricing/);
});

test("the page labels a model's rate for every shape a valid policy can hold", () => {
  const { rateLabel, rateTitle } = load(page, ["rateLabel", "rateTitle"]);

  // A phase routed to no model shows nothing.
  assert.equal(rateLabel(undefined), "");
  assert.equal(rateTitle(undefined), "");

  // No block: the run bills the list, and the page says so instead of throwing.
  assert.equal(rateLabel({ id: "opus" }), "list price");
  assert.match(rateTitle({ id: "opus" }), /price list/);

  // A block without the override is shown, and labelled as not what a run bills.
  assert.equal(rateLabel({ id: "opus", pricing: CARD }), "$5.00 in / $25.00 out /1M");
  assert.equal(rateLabel({ id: "opus", pricing: CARD }, true), "<b>$5.00</b> in / <b>$25.00</b> out /1M");
  assert.match(rateTitle({ id: "opus", pricing: CARD }), /price list/);
  assert.match(rateTitle({ id: "opus", pricing: CARD }), /pricing_override: true/);

  // Under the override the block is the billed price.
  assert.equal(rateLabel({ id: "opus", pricing: CARD, pricing_override: true }), "$5.00 in / $25.00 out /1M");
  assert.match(rateTitle({ id: "opus", pricing: CARD, pricing_override: true }), /^Billed/);
});

test("no unguarded read of a model's pricing is left in the page", () => {
  const rest = page.replace(extractFunction(page, "rateLabel"), "");
  assert.doesNotMatch(rest, /\.pricing\.(input|input_cached|output)\b/);
});
