/**
 * Dispatch-time pricing shared by every adapter.
 *
 * Every adapter prices a call with effectivePrice.ts on the day the dispatch
 * starts (the dated list, or the policy block under pricing_override). This
 * wrapper owns the two things effectivePrice deliberately leaves to callers:
 * the clock (injectable, so a test can dispatch on 2027-01-02) and logging
 * (a policy-block mismatch is logged once per adapter instead of once per
 * packet; an unpriced result is logged every time, because each one is a
 * refused dispatch or unpriced billed tokens).
 */

import { log } from "../log.js";
import { effectivePrice, type EffectivePrice } from "../effectivePrice.js";
import type { PeriodRef, PriceModifiers } from "../prices.js";
import type { ModelConfig, ModelPricing, PriceBasis } from "../types.js";

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** A Gemini adapter's price for one dispatch: the effective rates and the rates actually billed at the endpoint. */
export type BilledPrice =
  | { unpriced: true; reason: string }
  | {
      unpriced: false;
      basis: PriceBasis;
      /** Effective rates before any endpoint surcharge. */
      rates: ModelPricing;
      /** Rates billed at the resolved endpoint (the +10% Vertex regional surcharge where it applies). */
      billed: ModelPricing;
      /** The list period; null for a custom price. */
      period: PeriodRef | null;
    };

export class DispatchPricer {
  private readonly logged = new Set<string>();

  constructor(
    private readonly config: ModelConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  /** The dispatch date. Read once at the start of a dispatch and reused for every attempt in it. */
  now(): Date {
    return this.clock();
  }

  /** Effective price of `name` (default: the leaf's own model) on `date`, logged as described above. */
  price(date: Date, modifiers: PriceModifiers | null = {}, name?: string): EffectivePrice {
    const r = effectivePrice(this.config, date, modifiers, name);
    this.logWarnings(r.warnings);
    if (r.unpriced) {
      log("warn", "pricing.unpriced", { model_id: this.config.id, model: r.model_name, reason: r.reason });
    } else if (r.basis === "custom") {
      this.once("custom", () =>
        log("info", "pricing.custom", {
          model_id: this.config.id,
          model_name: this.config.model_name,
          message: "pricing_override: true, so the policy's pricing block is billed and labelled custom",
        }),
      );
    }
    return r;
  }

  /** Log each distinct policy-block warning once for this adapter. */
  logWarnings(warnings: string[]): void {
    for (const w of warnings) {
      this.once(`mismatch:${w}`, () =>
        log("warn", "pricing.policy_mismatch", { model_id: this.config.id, model_name: this.config.model_name, message: w }),
      );
    }
  }

  private once(key: string, emit: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    emit();
  }
}

/** The error an adapter returns instead of dispatching work it cannot price. */
export function unpricedRefusal(config: ModelConfig, date: Date, reason: string): string {
  return (
    `unpriced: model '${config.id}' (${config.model_name}) has no price for a dispatch on ` +
    `${date.toISOString().slice(0, 10)}, so nothing was sent: ${reason}`
  );
}

/**
 * The three rates a Gemini adapter bills. Neither Gemini adapter bills a
 * cache-write bucket, and applyVertexSurcharge scales only these three, so
 * passing the list's write rates through would leave rates in the billed card
 * that the surcharge never touched.
 */
export function geminiRates(p: ModelPricing): ModelPricing {
  return { input: p.input, input_cached: p.input_cached, output: p.output };
}
