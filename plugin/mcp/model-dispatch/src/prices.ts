import type { ModelPricing } from "./types.js";

/**
 * The dated price list: the one place a per-token rate is written down.
 *
 * Each model id maps to one or more dated periods. A lookup takes the model
 * name however a transcript, receipt, telemetry line or policy spells it
 * (`resolveModel`) plus the day the tokens were spent, and returns that
 * period's rates with the request's modifiers applied, or `unpriced` with the
 * reason. A rate is never borrowed from a similar model, a neighbouring
 * period or a default: a gap in this list is reported, never filled.
 *
 * All rates are USD per 1M tokens. Field names match `ModelPricing`, so a
 * looked-up `pricing` feeds `computeCostUsd` directly.
 *
 * `from` is the first day this list vouches for a rate, not a launch date.
 * Claude rows start at 2026-01-01, the list's coverage start: Anthropic's page
 * publishes no other 2026 rate for these models (Sonnet 5's launch price was
 * made its standing price), and no run can use a model before it exists.
 * Gemini rows start at the model's GA day in Google's changelog. `to` is
 * inclusive; `null` means no end date is published.
 */

export const PRICE_LIST_VERIFIED = "2026-09-14";
export const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
export const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
/**
 * The second page every Gemini rate is checked against (its Global rows), and
 * the source of the +10% non-global surcharge. Not a period's source_url: the
 * AI Studio page is, because both doors bill its rates at the global endpoint.
 */
export const VERTEX_PRICING_URL = "https://cloud.google.com/vertex-ai/generative-ai/pricing";
/** Where each Gemini period's first day, the model's GA day, is read. */
export const GEMINI_CHANGELOG_URL = "https://ai.google.dev/gemini-api/docs/changelog";

export interface PricePeriod {
  from: string;
  to: string | null;
  input: number;
  input_cached: number;
  /** 5-minute-TTL cache write. */
  input_cache_write: number;
  input_cache_write_1h: number;
  output: number;
  source_url: string;
  verified: string;
  /**
   * Fast-mode base rates (`usage.speed: "fast"`). The cache rates scale with
   * input by this period's own ratios, because Anthropic applies the caching
   * multipliers on top of the fast input price. Absent: no fast price exists.
   */
  fast?: { input: number; output: number };
  /**
   * Multiplier on every token class for `inference_geo: "us"`. Absent: the
   * model has no US-only price (Anthropic prices it for Claude 4.6 and later;
   * earlier models reject the parameter).
   */
  geo_us_multiplier?: number;
  /**
   * USD per server-side web search request: a transcript message's
   * `usage.server_tool_use.web_search_requests`, a receipt's
   * `modelUsage[*].webSearchRequests`. It is billed on top of tokens and is
   * not a token rate, so fast mode and the US-only multiplier (both token
   * pricing) never scale it. Absent: the list has no per-search price for this
   * period, and searches on it are unpriced, never borrowed.
   */
  web_search_per_request?: number;
}

export type PriceList = Readonly<Record<string, ReadonlyArray<Readonly<PricePeriod>>>>;

const CLAUDE_FROM = "2026-01-01";
const US_ONLY = { geo_us_multiplier: 1.1 };
const OPUS_FAST = { fast: { input: 10, output: 50 } };
/**
 * Anthropic's page, verified 2026-09-14: web search "is available on the
 * Claude API for $10 per 1,000 searches, plus standard token costs", each
 * search one use whatever it returns; web fetch has no additional charge.
 * The fee is not model-specific, so every Claude period carries it. Review
 * finding M3: booking only token counts under-booked any run that searched.
 */
const CLAUDE_WEB_SEARCH_PER_REQUEST = 10 / 1000;

/** Arguments follow the price page's column order: base input, 5m write, 1h write, cache read, output. */
function claude(
  input: number,
  write5m: number,
  write1h: number,
  cacheRead: number,
  output: number,
  modifiers: Pick<PricePeriod, "fast" | "geo_us_multiplier"> = {},
): PricePeriod[] {
  return [{
    from: CLAUDE_FROM,
    to: null,
    input,
    input_cache_write: write5m,
    input_cache_write_1h: write1h,
    input_cached: cacheRead,
    output,
    source_url: ANTHROPIC_PRICING_URL,
    verified: PRICE_LIST_VERIFIED,
    web_search_per_request: CLAUDE_WEB_SEARCH_PER_REQUEST,
    ...modifiers,
  }];
}

/**
 * Gemini has no cache-write premium: tokens written to an explicit cache bill
 * at the input rate (plus hourly storage, which is not a token rate and is not
 * modelled). The Gemini adapters bill no write bucket today, so these write
 * rates cannot change a Gemini figure. The +10% Vertex regional surcharge is
 * not a list modifier: geminiTransports.applyVertexSurcharge applies it at
 * dispatch, where the endpoint is known.
 *
 * Every Gemini rate below is on both of Google's pages and the two agree: the
 * AI Studio Standard paid-tier table (GEMINI_PRICING_URL) and the Vertex
 * Global rows (VERTEX_PRICING_URL). The Vertex Non-global rows for every row
 * below are exactly the Global rates x1.10 (3.5 Flash-Lite: "$0.33",
 * "$0.033", "$2.75"), which is what applyVertexSurcharge applies to Gemini 3+,
 * so a surcharged list rate matches Vertex's regional price.
 */
function gemini(from: string, to: string | null, input: number, cacheRead: number, output: number): PricePeriod {
  return {
    from,
    to,
    input,
    input_cached: cacheRead,
    input_cache_write: input,
    input_cache_write_1h: input,
    output,
    source_url: GEMINI_PRICING_URL,
    verified: PRICE_LIST_VERIFIED,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Frozen so no caller can reprice every later lookup by mutating a period.
export const PRICE_LIST: PriceList = deepFreeze({
  // Every non-Mythos row on Anthropic's page (Mythos is limited availability).
  "claude-fable-5-1":  claude(10, 12.5, 20, 0.25, 50, US_ONLY), // cache read is 0.025x input on this model
  "claude-fable-5":    claude(10, 12.5, 20, 1, 50, US_ONLY),
  "claude-opus-5":     claude(5, 6.25, 10, 0.5, 25, { ...US_ONLY, ...OPUS_FAST }),
  "claude-opus-4-8":   claude(5, 6.25, 10, 0.5, 25, { ...US_ONLY, ...OPUS_FAST }),
  "claude-opus-4-7":   claude(5, 6.25, 10, 0.5, 25, US_ONLY),
  "claude-opus-4-6":   claude(5, 6.25, 10, 0.5, 25, US_ONLY),
  "claude-opus-4-5":   claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1":   claude(15, 18.75, 30, 1.5, 75),
  "claude-opus-4":     claude(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5":   claude(2, 2.5, 4, 0.2, 10, US_ONLY),
  "claude-sonnet-4-6": claude(3, 3.75, 6, 0.3, 15, US_ONLY),
  "claude-sonnet-4-5": claude(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4":   claude(3, 3.75, 6, 0.3, 15),
  "claude-haiku-4-5":  claude(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku":  claude(0.8, 1, 1.6, 0.08, 4),

  // Gemini rows. Verified 2026-09-14: GEMINI_PRICING_URL and VERTEX_PRICING_URL
  // each fetched twice with identical text, the two pages agreeing on every
  // number below, and each first day read from GEMINI_CHANGELOG_URL. Quotes
  // are verbatim ("AI Studio" = the Standard, paid-tier table; "Vertex" = the
  // Global rows). A model on Google's pages but not here (Gemini 3.6 Flash,
  // 3.1 Flash-Lite, and others) stays unpriced until its period is added the
  // same way.

  // Changelog "September 2, 2026": "Gemini 3.8 Flash generally available (GA)".
  // AI Studio: input "$0.75 through December 31, 2026. $1.50 starting January
  // 1, 2027."; output "$3.75 through December 31, 2026. $7.50 starting January
  // 1, 2027."; context caching "$0.075 through December 31, 2026. $0.15
  // starting January 1, 2027.". Vertex: "Gemini 3.8 Flash* through December
  // 31, 2026" input $0.75, cached $0.075, output $3.75; "Gemini 3.8 Flash
  // Starting January 1, 2027" input $1.50, cached $0.15, output $7.50.
  "gemini-3.8-flash": [
    gemini("2026-09-02", "2026-12-31", 0.75, 0.075, 3.75),
    gemini("2027-01-01", null, 1.5, 0.15, 7.5),
  ],
  // Changelog "August 13, 2026": "Gemini 3.7 Flash generally available (GA)",
  // "available at an introductory price through December 31, 2026."
  // AI Studio: the same three strings as 3.8 Flash above. Vertex: "Gemini 3.7
  // Flash * through December 31, 2026" input $0.75, cached $0.075, output
  // $3.75; "Gemini 3.7 Flash starting January 1, 2027" input $1.50, cached
  // $0.15, output $7.50; page banner "Starting January 1, 2027, standard
  // pricing of $1.5 / $7.5 per 1M tokens input / output will apply." The 2027
  // period was missing before, so a 3.7 Flash run on or after 2027-01-01
  // halted at pre-flight instead of billing the published card.
  "gemini-3.7-flash": [
    gemini("2026-08-13", "2026-12-31", 0.75, 0.075, 3.75),
    gemini("2027-01-01", null, 1.5, 0.15, 7.5),
  ],
  // Changelog "May 19, 2026": "Released gemini-3.5-flash, the generally
  // available (GA) version". AI Studio: input "$1.50", output "$9.00", context
  // caching "$0.15". Vertex "Gemini 3.5 Flash": input $1.50, cached $0.15,
  // output $9.00. No end date is published.
  "gemini-3.5-flash": [gemini("2026-05-19", null, 1.5, 0.15, 9)],
  // Changelog "July 21, 2026": "Gemini 3.6 Flash and Gemini 3.5 Flash-Lite
  // generally available (GA)". AI Studio: input "$0.30 (text / image / video /
  // audio)", output "$2.50", context caching "$0.03". Vertex "Gemini 3.5
  // Flash-Lite": input $0.30, cached $0.03, output $2.50 (Non-global* $0.33 /
  // $0.033 / $2.75). No end date is published. It was absent before, so the
  // governance demo policy, whose codegen rule routes to it, halted at
  // pre-flight (test/governanceDemoPolicy.test.mjs).
  "gemini-3.5-flash-lite": [gemini("2026-07-21", null, 0.3, 0.03, 2.5)],
});

export interface ResolvedModel {
  /** The price-list id. */
  id: string;
  /** A trailing Claude Code option such as `[1m]`, verbatim, or null. */
  tag: string | null;
  /** Anthropic's `-YYYYMMDD` snapshot suffix as its 8 digits, or null. */
  snapshotDate: string | null;
}

const IDS_LONGEST_FIRST = Object.keys(PRICE_LIST).sort((a, b) => b.length - a.length);
const NAME_SUFFIX = /^(?:-(\d{4})(\d{2})(\d{2}))?(\[[^[\]]+\])?$/;

/**
 * Maps a model name to a price-list id. Accepted, and nothing else: the exact
 * id; the id plus `-YYYYMMDD`; either of those plus one bracketed option
 * (`[1m]` is Claude Code's 1M-context option and does not change the price;
 * any other bracket content is accepted the same way so a new option does not
 * stop a run). Ids are tried longest first, so `claude-fable-5-1` can never
 * resolve to `claude-fable-5`. Anything else returns null: no pairing guesses.
 */
export function resolveModel(name: unknown): ResolvedModel | null {
  if (typeof name !== "string") return null;
  for (const id of IDS_LONGEST_FIRST) {
    if (!name.startsWith(id)) continue;
    const m = NAME_SUFFIX.exec(name.slice(id.length));
    if (!m) continue;
    const hasDate = m[1] !== undefined;
    if (hasDate && !isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
    return { id, tag: m[4] ?? null, snapshotDate: hasDate ? `${m[1]}${m[2]}${m[3]}` : null };
  }
  return null;
}

export interface PriceModifiers {
  speed?: string | null;
  service_tier?: string | null;
  inference_geo?: string | null;
}

export interface AppliedModifiers {
  speed: "standard" | "fast";
  service_tier: "standard";
  inference_geo: "not_available" | "global" | "us";
  /** Product of the multipliers applied on top of the period's rates (1.1 for US-only). */
  multiplier: number;
  /** Modifiers that were absent and took the API default. */
  defaulted: Array<keyof PriceModifiers>;
}

export interface PeriodRef {
  from: string;
  to: string | null;
  source_url: string;
  verified: string;
}

export interface PricedLookup {
  unpriced: false;
  model: ResolvedModel;
  pricing: Required<ModelPricing>;
  period: PeriodRef;
  applied_modifiers: AppliedModifiers;
  /** USD per web search request for this model and day, never scaled by modifiers; null when the period has no per-search price. */
  web_search_per_request: number | null;
}

export interface UnpricedLookup {
  unpriced: true;
  reason: string;
  /** What the name resolved to, when it resolved; null for an unknown model. */
  model: ResolvedModel | null;
}

export type PriceLookup = PricedLookup | UnpricedLookup;

const FAST_IDS = Object.keys(PRICE_LIST).filter((id) => PRICE_LIST[id].some((p) => p.fast));
const US_IDS = Object.keys(PRICE_LIST).filter((id) => PRICE_LIST[id].some((p) => p.geo_us_multiplier !== undefined));

/**
 * Prices a model on a day under the request's modifiers.
 *
 * `date` is `YYYY-MM-DD` or an ISO-8601 timestamp carrying a timezone (a
 * transcript's `timestamp`); a timestamp prices on its UTC day. A timestamp
 * without a zone is refused because its day would depend on this machine's
 * clock setting.
 *
 * Modifiers, as transcripts record them in `message.usage`:
 * - `service_tier`: only `standard` is priced (priority and batch bill at
 *   other rates);
 * - `speed`: `standard`, or `fast` where the period has a fast price;
 * - `inference_geo`: `global` and `not_available` (what Claude Code writes;
 *   receipts reproduce at standard rates) are standard; `us` applies the
 *   period's US-only multiplier where one exists.
 * An absent modifier takes the API default (standard, standard, global) and is
 * listed in `applied_modifiers.defaulted`, so the choice stays visible. Any
 * other value is unpriced.
 */
export function lookupPrice(modelName: unknown, date: unknown, modifiers: PriceModifiers | null = {}): PriceLookup {
  const model = resolveModel(modelName);
  if (!model) {
    return unpriced(
      `unknown model ${JSON.stringify(modelName)}: not on the price list (accepted: a listed id, id-YYYYMMDD, either followed by one [option])`,
      null,
    );
  }

  const day = utcDay(date);
  if (!day) {
    return unpriced(`invalid date ${JSON.stringify(date)}: expected YYYY-MM-DD or an ISO-8601 timestamp with a timezone`, model);
  }

  const periods = PRICE_LIST[model.id];
  const period = periods.find((p) => p.from <= day && (p.to === null || day <= p.to));
  if (!period) {
    const covered = periods.map((p) => `${p.from}..${p.to ?? "open"}`).join(", ");
    return unpriced(`no price period for ${model.id} on ${day} (the list covers ${covered})`, model);
  }

  const mods = modifiers ?? {};
  const defaulted: AppliedModifiers["defaulted"] = [];

  if (mods.service_tier == null) defaulted.push("service_tier");
  else if (mods.service_tier !== "standard") {
    return unpriced(`service_tier ${JSON.stringify(mods.service_tier)} is not priced (only "standard" is)`, model);
  }

  let speed: AppliedModifiers["speed"] = "standard";
  if (mods.speed == null) defaulted.push("speed");
  else if (mods.speed === "standard" || mods.speed === "fast") speed = mods.speed;
  else return unpriced(`speed ${JSON.stringify(mods.speed)} is not a known value (expected "standard" or "fast")`, model);
  if (speed === "fast" && !period.fast) {
    return unpriced(`speed "fast" has no price for ${model.id} on ${day} (fast mode is priced for ${FAST_IDS.join(", ")})`, model);
  }

  let geo: AppliedModifiers["inference_geo"] = "global";
  if (mods.inference_geo == null) defaulted.push("inference_geo");
  else if (mods.inference_geo === "global" || mods.inference_geo === "not_available" || mods.inference_geo === "us") geo = mods.inference_geo;
  else {
    return unpriced(`inference_geo ${JSON.stringify(mods.inference_geo)} is not a known value (expected "not_available", "global" or "us")`, model);
  }
  let multiplier = 1;
  if (geo === "us") {
    if (period.geo_us_multiplier === undefined) {
      return unpriced(`inference_geo "us" has no price for ${model.id} (US-only inference is priced for ${US_IDS.join(", ")})`, model);
    }
    multiplier = period.geo_us_multiplier;
  }

  const k = speed === "fast" && period.fast ? period.fast.input / period.input : 1;
  const base: Required<ModelPricing> = {
    input: speed === "fast" && period.fast ? period.fast.input : period.input,
    input_cached: period.input_cached * k,
    input_cache_write: period.input_cache_write * k,
    input_cache_write_1h: period.input_cache_write_1h * k,
    output: speed === "fast" && period.fast ? period.fast.output : period.output,
  };
  const pricing: Required<ModelPricing> = {
    input: roundRate(base.input * multiplier),
    input_cached: roundRate(base.input_cached * multiplier),
    input_cache_write: roundRate(base.input_cache_write * multiplier),
    input_cache_write_1h: roundRate(base.input_cache_write_1h * multiplier),
    output: roundRate(base.output * multiplier),
  };

  // Canonical order for the defaulted list, independent of check order above.
  const order: Array<keyof PriceModifiers> = ["speed", "service_tier", "inference_geo"];
  defaulted.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return {
    unpriced: false,
    model,
    pricing,
    period: { from: period.from, to: period.to, source_url: period.source_url, verified: period.verified },
    applied_modifiers: { speed, service_tier: "standard", inference_geo: geo, multiplier, defaulted },
    web_search_per_request: period.web_search_per_request ?? null,
  };
}

function unpriced(reason: string, model: ResolvedModel | null): UnpricedLookup {
  return { unpriced: true, reason, model };
}

/** Multiplied rates carry float noise (5 x 1.1 = 5.500000000000001); a nano-dollar grid removes it. */
function roundRate(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function isCalendarDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The UTC calendar day a date prices on: a YYYY-MM-DD string as given, a
 * zoned ISO-8601 timestamp as its UTC day, anything else null. Exported
 * (v0.7.3 Q3) so effectivePrice.ts withEffectivePrices names the day its
 * rates apply to with the same rule lookupPrice uses to pick the period.
 */
export function utcDay(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const dayOnly = DAY_ONLY.exec(date);
  if (dayOnly) return isCalendarDay(Number(dayOnly[1]), Number(dayOnly[2]), Number(dayOnly[3])) ? date : null;
  const ts = ZONED_TIMESTAMP.exec(date);
  if (!ts || !isCalendarDay(Number(ts[1]), Number(ts[2]), Number(ts[3]))) return null;
  const t = new Date(date);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}
