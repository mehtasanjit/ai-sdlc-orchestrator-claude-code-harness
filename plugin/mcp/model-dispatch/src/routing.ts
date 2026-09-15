/**
 * Pure routing: given a task context and a policy, return the model decision.
 *
 * A rule may name a logical slot from `policy.select` instead of a concrete
 * model id; `pickModel` resolves it against the run's chosen options at
 * dispatch time. The resolved `modelId` is always concrete — adapters,
 * pricing, and telemetry never see a slot name.
 */

// The what-if replay prices through the live path's own functions (the same
// effective price, the same computeCostUsd, and for a Gemini event the same
// endpoint and regional surcharge rules in adapters/geminiEndpoint.ts), so a
// replay in the run's own Gemini environment agrees with the dollars the run
// logged for the same token buckets.
import { computeCostUsd } from "./pricing.js";
import { effectivePrice } from "./effectivePrice.js";
import { existsSync } from "node:fs";
import { utcDay } from "./prices.js";
import { defaultAdcPath, geminiDispatchEndpoint, vertexSurchargeFactor } from "./adapters/geminiEndpoint.js";
import type {
  Policy,
  Rule,
  RoutingDecision,
  RuleMatcher,
  SelectOverrides,
} from "./types.js";

export interface TaskContext {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
  /** Brownfield only. Undefined on greenfield packets — never matched against a rule that omits it. */
  intent?: string;
}

/**
 * Parse `slot=option[,slot=option...]`. Empty/whitespace → no choices.
 * (An unset variable and one set to "" must behave identically.)
 */
export function parseSelectOverrides(spec: string | undefined): SelectOverrides {
  const out: SelectOverrides = {};
  if (!spec || !spec.trim()) return out;
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      throw new Error(
        `Invalid select spec '${piece}'. Expected 'slot=option', ` +
          `comma-separated for more than one (e.g. 'gemini-flash=flash-agsdk-worker').`
      );
    }
    out[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Check slot choices against the policy at load, before the run starts.
 * Without this, a bad choice would first throw from `pickModel` partway
 * through a paid phase.
 */
export function validateSelectOverrides(policy: Policy, overrides: SelectOverrides): void {
  for (const [slot, chosen] of Object.entries(overrides)) {
    const declared = policy.select?.[slot];
    if (!declared) {
      const known = Object.keys(policy.select ?? {});
      throw new Error(
        `select '${slot}': policy '${policy.name}' has no such slot. ` +
          (known.length ? `Known slots: ${known.join(", ")}` : "This policy declares no slots.")
      );
    }
    if (!declared.options.includes(chosen)) {
      throw new Error(
        `select ${slot}=${chosen}: '${chosen}' is not one of that slot's options ` +
          `(${declared.options.join(", ")}). The options are the vetted set — ` +
          `add it to the policy first.`
      );
    }
  }
}

/**
 * Turn a rule's `use` target into a concrete model id. Model ids pass through
 * unchanged (with no selection trace), so unslotted policies resolve exactly
 * as before slots existed.
 */
export function resolveNamed(
  policy: Policy,
  named: string,
  overrides: SelectOverrides = {}
): { modelId: string; selection?: RoutingDecision["selection"] } {
  const slot = policy.select?.[named];
  if (!slot) return { modelId: named };

  const override = overrides[named];
  if (override !== undefined && !slot.options.includes(override)) {
    // Reachable only when the caller skipped validateSelectOverrides.
    // Refuse rather than fall back — numbers would be labelled wrong.
    throw new Error(
      `select ${named}=${override}: not one of that slot's options (${slot.options.join(", ")})`
    );
  }

  const chosen = override ?? slot.default;
  return {
    modelId: chosen,
    selection: { slot: named, chosen, overridden: override !== undefined },
  };
}

/**
 * Model ids this run has ruled out by choosing a different option in their
 * slot. Narrow on purpose: an option only counts as unreachable if it lost
 * its slot's selection AND no rule names it directly. Unslotted policies
 * return the empty set.
 */
export function unreachableModelIds(
  policy: Policy,
  overrides: SelectOverrides = {}
): Set<string> {
  const unreachable = new Set<string>();
  if (!policy.select) return unreachable;

  for (const [name, slot] of Object.entries(policy.select)) {
    const { modelId: chosen } = resolveNamed(policy, name, overrides);
    for (const option of slot.options) {
      if (option !== chosen) unreachable.add(option);
    }
  }

  // An id a rule names directly is reachable, and an id one slot chose is
  // reachable even if another slot rejected it.
  for (const rule of policy.rules) {
    const named = "use" in rule ? rule.use : rule.default;
    if (policy.select?.[named]) {
      unreachable.delete(resolveNamed(policy, named, overrides).modelId);
    } else {
      unreachable.delete(named);
    }
  }

  return unreachable;
}

export function pickModel(
  ctx: TaskContext,
  policy: Policy,
  overrides: SelectOverrides = {}
): RoutingDecision {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) continue; // defaults handled last
    if (matches(rule.when, ctx)) {
      const resolved = resolveNamed(policy, rule.use, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? `matched rule ${i} (${describeMatcher(rule.when)})`,
        ruleIndex: i,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
      };
    }
  }
  // Fall through to default
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) {
      const resolved = resolveNamed(policy, rule.default, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? "fell through to policy default",
        ruleIndex: -1,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
      };
    }
  }
  throw new Error(
    `Policy '${policy.name}' has no rule matching ${JSON.stringify(ctx)} and no default rule.`
  );
}

function matches(matcher: RuleMatcher, ctx: TaskContext): boolean {
  if (matcher.phase !== undefined && !inSet(matcher.phase, ctx.phase)) return false;
  if (matcher.task_type !== undefined && !inSet(matcher.task_type, ctx.task_type)) return false;
  if (matcher.module !== undefined && !inSet(matcher.module, ctx.module)) return false;
  // A rule scoped to an intent never matches a packet with no intent (greenfield).
  if (matcher.intent !== undefined && (ctx.intent === undefined || !inSet(matcher.intent, ctx.intent))) return false;
  if (matcher.retry_count !== undefined) {
    const r = ctx.retry_count;
    const m = matcher.retry_count;
    if (m.lt !== undefined && !(r < m.lt)) return false;
    if (m.lte !== undefined && !(r <= m.lte)) return false;
    if (m.gt !== undefined && !(r > m.gt)) return false;
    if (m.gte !== undefined && !(r >= m.gte)) return false;
    if (m.eq !== undefined && !(r === m.eq)) return false;
  }
  return true;
}

function inSet(set: string | string[], value: string): boolean {
  return Array.isArray(set) ? set.includes(value) : set === value;
}

function describeMatcher(m: RuleMatcher): string {
  const parts: string[] = [];
  for (const k of ["phase", "task_type", "module", "intent"] as const) {
    if (m[k] !== undefined) parts.push(`${k}=${JSON.stringify(m[k])}`);
  }
  if (m.retry_count) parts.push(`retry_count=${JSON.stringify(m.retry_count)}`);
  return parts.join(", ") || "wildcard";
}

/** What-if replay: recompute cost of a real run's events under another policy. */
export interface ReplayEvent {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
  /**
   * FRESH input count — the same bucket a TelemetryEvent stores. Cache reads
   * and cache writes are NOT inside it: every adapter splits them before
   * server.ts writes the event, so a reader must never subtract them again.
   */
  input_tokens: number;
  input_tokens_cached: number;
  /** TOTAL cache writes, disjoint from input_tokens. Absent on events written before the bucket existed. */
  input_tokens_cache_write?: number;
  /**
   * The 1-hour-TTL SHARE of `input_tokens_cache_write`. Both producers write
   * it that way: the collector's `tier: "orchestrator"` event and claude-cli
   * worker events. The replay prices min(total, this) at the 1-hour rate and
   * the rest at the 5-minute rate. It used to read this as a count disjoint
   * from the total, which priced every 1-hour write of a real telemetry file
   * twice (once at 5 minutes inside the total, once at 1 hour).
   */
  input_tokens_cache_write_1h?: number;
  output_tokens: number;
  /** When the event ran; the replay prices it on that day. Absent: priced on today's date. */
  ts?: string;
}

export interface ReplayResult {
  total_cost_usd: number;
  per_model: Record<string, number>;
  /** Models the replay could not price (no list period for an event's day, or not on the list), with how many events it skipped. */
  unpriced: Array<{ model_id: string; model_name: string; reason: string; events: number }>;
  /** Policy pricing blocks that differ from the list and were ignored. */
  price_warnings: string[];
}

/** Every declared rate multiplied by `k` (the Vertex regional surcharge on a replayed Gemini event). */
function scaleRates<T extends { input: number; input_cached: number; output: number; input_cache_write?: number; input_cache_write_1h?: number }>(
  p: T,
  k: number
): T {
  return {
    ...p,
    input: p.input * k,
    input_cached: p.input_cached * k,
    output: p.output * k,
    ...(p.input_cache_write !== undefined ? { input_cache_write: p.input_cache_write * k } : {}),
    ...(p.input_cache_write_1h !== undefined ? { input_cache_write_1h: p.input_cache_write_1h * k } : {}),
  };
}

export function simulatePolicyCost(
  events: ReplayEvent[],
  policy: Policy,
  // Defaulting to no overrides prices the policy's defaults — the right
  // answer when the caller has not said otherwise.
  overrides: SelectOverrides = {},
  opts: {
    now?: () => Date;
    /** The Gemini environment the replay bills endpoints in. Default: this process's, the one the adapters dispatch from. */
    env?: Record<string, string | undefined>;
    /** Whether a gcloud ADC file exists. Default: checked on disk. */
    adcFileExists?: boolean;
  } = {}
): ReplayResult {
  const perModel: Record<string, number> = {};
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const adcFileExists = opts.adcFileExists ?? existsSync(defaultAdcPath());
  const unpriced = new Map<string, ReplayResult["unpriced"][number]>();
  const priceWarnings = new Set<string>();
  let total = 0;
  for (const ev of events) {
    const decision = pickModel(ev, policy, overrides);
    const model = policy.models.find((m) => m.id === decision.modelId);
    if (!model) continue;
    // The effective price on the event's own day, exactly as the live
    // dispatch priced it: the dated list, or the policy block under
    // pricing_override. A what-if never bills a mismatched block, and an
    // event on a day the list cannot price is left out of the total and
    // listed, never priced at a remembered rate.
    const when = typeof ev.ts === "string" ? ev.ts : (opts.now ?? (() => new Date()))();
    const price = effectivePrice(model, when);
    for (const w of price.warnings) priceWarnings.add(w);
    if (price.unpriced) {
      // `\u0000` is typed as an escape, not a raw NUL byte: the key string is
      // identical, and the file stays text that ripgrep and grep will search
      // (a raw NUL made them skip this file as binary; no-nul-bytes.test.mjs).
      const key = `${model.id}\u0000${price.reason}`;
      const entry = unpriced.get(key) ?? { model_id: model.id, model_name: model.model_name, reason: price.reason, events: 0 };
      entry.events++;
      unpriced.set(key, entry);
      continue;
    }
    const written = ev.input_tokens_cache_write ?? 0;
    const oneHour = Math.min(written, ev.input_tokens_cache_write_1h ?? 0);
    // v0.7.3 review fix: a Gemini event is billed at the endpoint this
    // environment would dispatch it to, with the +10% Vertex regional
    // surcharge the adapters apply there (geminiEndpoint.ts holds the rules
    // both use). Without it, a regional install's what-if read exactly 10%
    // below the dollars its run logged. The factor also scales a declared
    // cache-write rate: a replay can move a Claude event that carries cache
    // writes onto a Gemini leaf, and Vertex surcharges every token class.
    const endpoint = geminiDispatchEndpoint(model, env, adcFileExists);
    const factor = endpoint
      ? vertexSurchargeFactor({ ...endpoint, modelName: model.model_name, day: utcDay(when) ?? undefined })
      : 1;
    const billed = factor === 1 ? price.pricing : scaleRates(price.pricing, factor);
    // Price the replayed event with the SAME function the live path uses
    // (pricing.ts computeCostUsd) on the SAME disjoint buckets the event
    // stores, so a what-if replayed in the run's own Gemini environment
    // agrees with the dollars the run logged for the same tokens (the
    // regional surcharge above included).
    //
    // This loop used to compute `inputFresh = ev.input_tokens -
    // ev.input_tokens_cached` first. That assumed `input_tokens` was the
    // TOTAL prompt count, but every adapter already subtracts the cached
    // share before the event is written, so the replay took the cache reads
    // out a second time: a 20k-fresh / 80k-cached event replayed as −60k
    // fresh tokens and a NEGATIVE dollar figure, and any cache-heavy run was
    // told a policy was cheaper than it really was. The only test used
    // input_tokens_cached: 0, which is why it never fired. The hand-rolled
    // arithmetic also never learned the 1-hour cache-write tier the live
    // path prices at 2×. Delegating to computeCostUsd fixes both and keeps
    // the two paths from drifting apart again.
    const cost = computeCostUsd(
      {
        input: ev.input_tokens,
        input_cached: ev.input_tokens_cached,
        input_cache_write: written - oneHour,
        input_cache_write_1h: oneHour,
        output: ev.output_tokens,
      },
      billed
    );
    perModel[model.id] = (perModel[model.id] ?? 0) + cost;
    total += cost;
  }
  return { total_cost_usd: total, per_model: perModel, unpriced: [...unpriced.values()], price_warnings: [...priceWarnings] };
}
