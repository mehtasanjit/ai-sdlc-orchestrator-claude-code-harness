/**
 * The effective price of a policy model: the one rule every adapter, the
 * what-if replay and pre-flight use to turn a policy entry into a rate.
 *
 * Why this exists: a policy `pricing:` block used to be the price. Blocks are
 * hand-copied into every policy file and carry no dates, so a wrong copy
 * (a 3.5 Flash card pasted into another policy, a Sonnet 5 card left at a
 * cancelled price increase) billed silently, and a dated change (Gemini 3.7
 * Flash's introductory card ends on 2026-12-31) could not be expressed at all.
 *
 * The rule, in order:
 *   1. `pricing_override: true` bills the policy block, labelled `custom`.
 *      It applies to the leaf's own model only (a `claude-cli` worker's
 *      helpers and side calls are still priced from the list).
 *   2. Otherwise the dated list (prices.ts) prices the model on the dispatch
 *      day. A block that differs from the list's standard card by more than
 *      0.5% on any rate it declares is ignored, and a warning names both.
 *   3. A model the list cannot price, without an override, is unpriced: the
 *      caller refuses to dispatch it (or, for tokens already billed, records
 *      them as unpriced). A rate is never borrowed or remembered.
 *
 * The same prices reach the orchestrator (v0.7.3 Q3): withEffectivePrices
 * builds load_policy's output, the policy with each model's effective price
 * for the day, and orchestrator.md rule 6 prices estimated in-session events
 * from it. Before, rule 6 read the policy file's block text, so a block that
 * differed from the list made the run's estimates and its bills disagree.
 *
 * Pure: warnings are returned, and each caller decides where to log them.
 */

import type { ModelConfig, ModelPricing, PriceBasis } from "./types.js";
import {
  lookupPrice,
  resolveModel,
  utcDay,
  type AppliedModifiers,
  type PeriodRef,
  type PriceModifiers,
} from "./prices.js";
import { CACHE_WRITE_PREMIUM, CACHE_WRITE_PREMIUM_1H } from "./pricing.js";
import type { AuthMode, PriceCheck } from "./preflight.js";

// PriceCheck is declared in preflight.ts, which consumes it, so that module
// stays free of imports; re-exported here beside the function that builds it.
export type { PriceCheck };

/** A declared block rate further than this fraction from the list's rate is a mismatch. */
export const POLICY_PRICE_TOLERANCE = 0.005;

const RATE_KEYS = ["input", "input_cached", "output", "input_cache_write", "input_cache_write_1h"] as const;
type RateKey = (typeof RATE_KEYS)[number];

export type PricedModel = Pick<ModelConfig, "id" | "model_name" | "pricing" | "pricing_override">;

export interface EffectivePriced {
  unpriced: false;
  basis: PriceBasis;
  /** The name that was priced (the leaf's model_name unless the caller passed another). */
  model_name: string;
  /** Rates for computeCostUsd. A list price carries all five; a custom price carries what the block declares. */
  pricing: ModelPricing;
  /** The list period that priced it; null for a custom price. */
  period: PeriodRef | null;
  /** The modifiers the list applied; null for a custom price (a block is one flat card). */
  applied_modifiers: AppliedModifiers | null;
  /**
   * USD per web search request: the list period's fee for this model on this
   * day, for a custom price too (a policy block declares token rates only, and
   * the search fee is the model's own dated list fee). Null when the list has
   * no per-search price, so searches are unpriced.
   */
  web_search_per_request: number | null;
  warnings: string[];
}

export interface EffectiveUnpriced {
  unpriced: true;
  model_name: string;
  reason: string;
  warnings: string[];
}

export type EffectivePrice = EffectivePriced | EffectiveUnpriced;

/**
 * True when two model names name the same model: equal; or both resolve to
 * the same list id (so `claude-opus-5[1m]` and `claude-haiku-4-5-20251001`
 * match their bare ids); or, when neither is on the list, equal once a
 * trailing Claude Code `[option]` is dropped (so a custom gateway name still
 * matches its `[1m]` spelling). A listed and an unlisted name never match.
 */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolveModel(a);
  const rb = resolveModel(b);
  if (ra && rb) return ra.id === rb.id;
  if (ra || rb) return false;
  const strip = (n: string) => n.replace(/\[[^[\]]+\]$/, "");
  return strip(a) === strip(b);
}

/** A Date prices on its UTC day; a string goes to lookupPrice as given (YYYY-MM-DD or a zoned timestamp). */
function dateArg(date: Date | string): string {
  return typeof date === "string" ? date : date.toISOString();
}

/**
 * Effective price of `name` (default: the leaf's own model_name) under policy
 * model `model`, on `date`, with the request's `modifiers`.
 */
export function effectivePrice(
  model: PricedModel,
  date: Date | string,
  modifiers: PriceModifiers | null = {},
  name: string = model.model_name,
): EffectivePrice {
  const warnings: string[] = [];
  const ownModel = sameModel(name, model.model_name);

  // 1. A deliberate custom price. The loader refuses pricing_override without
  //    a block, so `pricing` is present whenever the flag is true.
  if (ownModel && model.pricing_override === true && model.pricing) {
    // The block has no search fee; the list's fee for the model's day applies,
    // and a model or day the list cannot price leaves searches unpriced.
    const listed = lookupPrice(name, dateArg(date), {});
    return {
      unpriced: false,
      basis: "custom",
      model_name: name,
      pricing: { ...model.pricing },
      period: null,
      applied_modifiers: null,
      web_search_per_request: listed.unpriced ? null : listed.web_search_per_request,
      warnings,
    };
  }

  // 3. No list price and no override: unpriced, with what would price it.
  const day = dateArg(date);
  const looked = lookupPrice(name, day, modifiers);
  if (looked.unpriced) {
    const hint = ownModel
      ? `; add its verified price period to plugin/mcp/model-dispatch/src/prices.ts, or give policy model ` +
        `'${model.id}' a pricing block with pricing_override: true to bill a custom price`
      : "";
    return { unpriced: true, model_name: name, reason: `${looked.reason}${hint}`, warnings };
  }

  // 2. The list prices it. A declared block is compared with the list's
  //    STANDARD card (no modifiers): a block is one flat card, so comparing it
  //    with a fast-mode or US-only rate would warn on every correct block.
  if (ownModel && model.pricing) {
    const standard = lookupPrice(name, day, {});
    if (!standard.unpriced) {
      const warning = blockMismatch(model, standard.pricing, standard.period);
      if (warning) warnings.push(warning);
    }
  }

  return {
    unpriced: false,
    basis: "list",
    model_name: name,
    pricing: looked.pricing,
    period: looked.period,
    applied_modifiers: looked.applied_modifiers,
    web_search_per_request: looked.web_search_per_request,
    warnings,
  };
}

/** A declared rate differs when it is more than the tolerance away (any nonzero rate differs from a zero list rate). */
function differs(declared: number, listed: number): boolean {
  if (listed === 0) return declared !== 0;
  // The 1e-12 keeps a value exactly at the boundary from flipping on float noise.
  return Math.abs(declared - listed) > POLICY_PRICE_TOLERANCE * listed + 1e-12;
}

function blockMismatch(model: PricedModel, list: Required<ModelPricing>, period: PeriodRef): string | null {
  const block = model.pricing as ModelPricing;
  const declared = RATE_KEYS.filter((k) => typeof block[k] === "number");
  const off = declared.filter((k) => differs(block[k] as number, list[k]));
  if (off.length === 0) return null;
  const card = (rates: Partial<Record<RateKey, number>>) => `{${declared.map((k) => `${k} ${rates[k]}`).join(", ")}}`;
  return (
    `Policy model '${model.id}' (${model.model_name}): its pricing block ${card(block)} differs on ` +
    `${off.join(", ")} by more than ${POLICY_PRICE_TOLERANCE * 100}% from the price list ${card(list)} ` +
    `(period ${period.from}..${period.to ?? "open"}, ${period.source_url}, verified ${period.verified}). ` +
    `The list price is used; set pricing_override: true on this model to bill the block instead ` +
    `(reported as a custom price).`
  );
}

/**
 * Whether a run may start with this model, price-wise, on `date`.
 *
 * Unpriced is blocking in both auth modes and whether or not the server
 * dispatches the model: dispatched work would be refused mid-run, and work a
 * session runs in-session is priced from the same list by the collector, so
 * either way the run's cost would have a hole in it.
 *
 * The auth mode does not change the answer since v0.7.3 Q3. Under `estimated`
 * a model the orchestrator runs in-session used to need a pricing block as
 * well, because orchestrator.md rule 6 priced that estimated work from the
 * block's text. Rule 6 now prices it from the model's `effective_price` in
 * load_policy's output (withEffectivePrices below), which is the price checked
 * here, so a model without a block is priced exactly like one whose block
 * equals the list, and a model with no price halts in both modes. `_authMode`
 * stays in the signature so callers (server.ts preflightDispatch, the tests)
 * are unchanged.
 */
export function checkModelPrice(model: ModelConfig, date: Date | string, _authMode: AuthMode): PriceCheck {
  const r = effectivePrice(model, date);
  if (r.unpriced) return { ok: false, unpriced: true, reason: r.reason, warnings: r.warnings };
  return { ok: true, basis: r.basis, warnings: r.warnings };
}

/**
 * What a policy entry's own `pricing:` block is, beside its effective price:
 *   - "none": no block; the list prices the model;
 *   - "equals_list": within 0.5% of the list on every rate it declares; the list is billed;
 *   - "ignored_differs_from_list": more than 0.5% off; the list is billed and pre-flight warns;
 *   - "billed_pricing_override": `pricing_override: true`; the block is the price, labelled custom;
 *   - "ignored_model_unpriced": a block without the override on a model the list cannot price;
 *     nothing prices the model, and pre-flight halts.
 */
export type PricingBlockStatus =
  | "none"
  | "equals_list"
  | "ignored_differs_from_list"
  | "billed_pricing_override"
  | "ignored_model_unpriced";

/** One model's effective price as load_policy presents it (withEffectivePrices). */
export interface EffectivePriceView {
  /** The UTC day the rates apply to: the day load_policy was called. */
  priced_on: string;
  /** "list" or "custom"; null when the model has no price. */
  basis: PriceBasis | null;
  /**
   * USD per 1M tokens for all five buckets: what a dispatch of this model on
   * `priced_on` bills at standard modifiers, before the Vertex regional
   * surcharge (applied at dispatch, Gemini 3+ at a non-global endpoint). A
   * custom card's undeclared cache-write rates are the computeCostUsd fallbacks
   * it bills (input x CACHE_WRITE_PREMIUM and x CACHE_WRITE_PREMIUM_1H). Null
   * when the model has no price.
   */
  rates: Required<ModelPricing> | null;
  /** The list period that priced it; null for a custom price or no price. */
  period: PeriodRef | null;
  /** USD per web search request on that day, or null when none is priced. */
  web_search_per_request: number | null;
  /** Why the model has no price (pre-flight halts on it); null when priced. */
  unpriced_reason: string | null;
  pricing_block: PricingBlockStatus;
  /** effectivePrice's warnings, such as a block that differs from the list. */
  warnings: string[];
}

/** The sentence load_policy's output carries beside the prices, for the model reading it. */
export const EFFECTIVE_PRICES_NOTE =
  "Each models[].effective_price is the price the dispatch server bills that model at on effective_prices_on, " +
  "and the post-run collector prices the session at: the dated price list (plugin/mcp/model-dispatch/src/prices.ts), " +
  "or the model's pricing block only under pricing_override: true (effective_price.pricing_block says which). Price " +
  "estimated events from effective_price.rates, never from a pricing block: a block is documentation unless " +
  "pricing_override is true. A Gemini leaf at a non-global Vertex endpoint bills these rates x1.10 at dispatch.";

function effectivePriceView(model: PricedModel, date: Date | string, day: string): EffectivePriceView {
  const r = effectivePrice(model, date);
  const hasBlock = model.pricing != null;
  if (r.unpriced) {
    return {
      priced_on: day,
      basis: null,
      rates: null,
      period: null,
      web_search_per_request: null,
      unpriced_reason: r.reason,
      pricing_block: hasBlock ? "ignored_model_unpriced" : "none",
      warnings: r.warnings,
    };
  }
  const p = r.pricing;
  return {
    priced_on: day,
    basis: r.basis,
    rates: {
      input: p.input,
      input_cached: p.input_cached,
      // A list card always carries both write rates; a custom card may not, and
      // computeCostUsd bills the missing ones at these fallbacks.
      input_cache_write: p.input_cache_write ?? p.input * CACHE_WRITE_PREMIUM,
      input_cache_write_1h: p.input_cache_write_1h ?? p.input * CACHE_WRITE_PREMIUM_1H,
      output: p.output,
    },
    period: r.period,
    web_search_per_request: r.web_search_per_request,
    unpriced_reason: null,
    // effectivePrice's only warning on a list price is the block mismatch.
    pricing_block:
      r.basis === "custom" ? "billed_pricing_override" : !hasBlock ? "none" : r.warnings.length > 0 ? "ignored_differs_from_list" : "equals_list",
    warnings: r.warnings,
  };
}

/**
 * load_policy's output (v0.7.3 Q3): the policy as loaded, unchanged, with
 * every model given its `effective_price` for `date`, and the day and a note
 * at the top. Pure: the loaded policy object is not modified. The day is the
 * price list's own UTC-day reading of `date` (utcDay), so `priced_on` names
 * the period the rates came from.
 */
export function withEffectivePrices<P extends { models: PricedModel[] }>(policy: P, date: Date | string) {
  const arg = dateArg(date);
  const day = utcDay(arg) ?? arg;
  return {
    effective_prices_on: day,
    effective_prices_note: EFFECTIVE_PRICES_NOTE,
    ...policy,
    models: policy.models.map((m) => ({ ...m, effective_price: effectivePriceView(m, date, day) })),
  };
}
