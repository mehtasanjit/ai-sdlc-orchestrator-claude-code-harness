/**
 * GeminiFlashAdapter — Gemini 3.5 Flash with explicit context caching for
 * the stable project header. Auth-agnostic: the two doors live behind
 * `GeminiTransport`, picked from credentials at construction. Falls back to
 * implicit caching if explicit cache creation fails.
 */

import type {
  AttemptRecord,
  ExecutionResult,
  ModelConfig,
  ModelPricing,
  TaskPacket,
} from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import {
  applyVertexSurcharge,
  billedOutputTokens,
  buildGeminiTransport,
  type BackendChoice,
  type GeminiTransport,
  type GenerateOutcome,
} from "./geminiTransports.js";
import { DispatchPricer, geminiRates, unpricedRefusal, type BilledPrice, type Clock } from "./dispatchPricer.js";

export interface GeminiFlashOptions {
  /** Clock for the dispatch date the price is looked up on; tests pin it. */
  now?: Clock;
  /**
   * A time limit on each request, sent as the SDK's own httpOptions.timeout.
   * Unset sends none. The executor's typist sets one so a hung call cannot
   * stall a stage (tools.ts).
   */
  requestTimeoutMs?: number;
}

// Fallback when the policy YAML omits max_output_tokens_absolute. 8192 is
// the current Gemini 3.5 Flash ceiling.
const GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 8192;

const MAX_DOUBLINGS = 3;

// One hour comfortably covers a full pass.
const CACHE_TTL_SECONDS = 3600;

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private transport: GeminiTransport;
  /** Which door was picked — surfaced in errors and setup logs. */
  readonly backendChoice: BackendChoice;
  private readonly pricer: DispatchPricer;
  private cachingAvailable = true;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig, options: GeminiFlashOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    // Throws at construction (before any premium spend) if neither door works.
    const { transport, choice } = buildGeminiTransport(config.auth?.env ?? "GEMINI_API_KEY");
    this.transport = transport;
    this.backendChoice = choice;
    this.pricer = new DispatchPricer(config, options.now);
    this.requestTimeoutMs = options.requestTimeoutMs;
  }
  private readonly requestTimeoutMs?: number;

  /**
   * The price of a dispatch on `date`: the effective rates (the dated list,
   * or the policy block under pricing_override) with the +10% regional
   * surcharge applied for the resolved endpoint. Resolved per dispatch rather
   * than once at construction, because a list period can end while a server
   * process is running (Gemini 3.7 Flash's introductory card ends 2026-12-31).
   */
  pricingOn(date: Date = this.pricer.now()): BilledPrice {
    const price = this.pricer.price(date);
    if (price.unpriced) return { unpriced: true, reason: price.reason };
    const rates = geminiRates(price.pricing);
    const billed = applyVertexSurcharge(rates, {
      backend: this.transport.backend,
      location: this.transport.location,
      modelName: this.modelConfig.model_name,
    });
    return { unpriced: false, basis: price.basis, rates, billed, period: price.period };
  }

  /** Rates billed for a dispatch now, surcharge applied; undefined when the model has no price today. */
  get billedPricing(): ModelPricing | undefined {
    const price = this.pricingOn();
    return price.unpriced ? undefined : price.billed;
  }

  /**
   * Place `header` first in every prompt this adapter sends, inline, without
   * creating an explicit context cache. The executor uses it for the run's
   * shared specification: text identical across calls and placed first is
   * what Gemini's implicit caching can reuse, with no storage charge.
   */
  inlineHeader(header: string): void {
    this.cacheHeader = header;
  }

  /**
   * Prime the explicit context cache with the stable project header.
   * Call once at the start of a pass. cacheKey is e.g. "pass2:workforce-ops".
   */
  async primeCache(cacheKey: string, header: string): Promise<void> {
    this.cacheHeader = header;
    if (!this.cachingAvailable) return;
    try {
      const cacheName = await this.transport.createCache(
        this.modelConfig.model_name,
        cacheKey,
        header,
        CACHE_TTL_SECONDS,
      );
      if (cacheName) {
        this.cacheNamesByKey.set(cacheKey, cacheName);
      } else {
        // Transport says caching is unavailable (e.g. no resolvable project).
        this.cachingAvailable = false;
      }
    } catch {
      // Quota / model mismatch / minimum-token floor. Inline the header on
      // every call instead — more expensive, still completes.
      this.cachingAvailable = false;
    }
  }

  async execute(packet: TaskPacket, cacheContext?: string): Promise<ExecutionResult> {
    const cacheName = cacheContext ? this.cacheNamesByKey.get(cacheContext) : undefined;
    const cacheHit = !!cacheName;
    const userPrompt = buildUserPrompt(packet, !cacheHit ? this.cacheHeader : "");

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    // `__free_text__` marker means the caller wants markdown, not JSON.
    // Skip JSON mode; the marker never reaches the vendor (400 on unknown).
    const wantsJson = packet.outputSchema && !(packet.outputSchema as any).__free_text__;

    const attempts: AttemptRecord[] = [];
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    // One price for the whole dispatch, read on the day it starts. Work this
    // model cannot be priced for is refused before any Gemini call, so no
    // unpriced dollars are ever spent.
    const dispatchDate = this.pricer.now();
    const price = this.pricingOn(dispatchDate);
    if (price.unpriced) {
      attempts.push({
        attempt_number: 1,
        ceiling_used: ceiling,
        hit_output_cap: false,
        tokens: { input: 0, input_cached: 0, output: 0 },
        cost_usd: 0,
        latency_ms: 0,
        success: false,
        error: unpricedRefusal(this.modelConfig, dispatchDate, price.reason),
      });
      return this.finalizeResult(attempts, null, false, "vendor_error");
    }

    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      // The leaf's reasoning tier, when set, becomes Gemini's thinkingLevel;
      // with no tier the request carries none and Google's default applies.
      // Reasoning tokens are billed at the output rate and count against
      // maxOutputTokens, which is why the executor's typists run at "low" (one
      // rule for every typist). Each tier is sent as written: "minimal",
      // "low", "medium" and "high" are all members of the vendor's
      // ThinkingLevel enum (@google/genai), and the agent door sends the same
      // value, so one policy tier means one thing on both doors.
      const tier = this.modelConfig.reasoning?.tier;
      const thinkingLevel = tier === "minimal" || tier === "low" || tier === "medium" || tier === "high" ? tier : undefined;
      const generationConfig: any = {
        temperature: 0.2,
        maxOutputTokens: ceiling,
        ...(wantsJson ? { responseMimeType: "application/json" } : {}),
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        ...(this.requestTimeoutMs ? { httpOptions: { timeout: this.requestTimeoutMs } } : {}),
      };
      if (wantsJson) generationConfig.responseSchema = packet.outputSchema;

      let outcome: GenerateOutcome;
      try {
        outcome = await this.transport.generate({
          modelName: this.modelConfig.model_name,
          prompt: userPrompt,
          generationConfig,
          cachedContentName: cacheName,
        });
      } catch (err: any) {
        const failure = describeVendorFailure(err);
        // A call Google answered with an error status bills nothing. Vertex AI:
        // "You're charged only for requests that return a 200 response code.
        // Requests returning any other response codes, such as 4xx and 5xx
        // codes, aren't charged for the input or output." (VERTEX_PRICING_URL);
        // the Gemini API: "If your request fails with a 400 or 500 error, you
        // won't be charged for the tokens used." (its billing page). A
        // connection that failed with no response keeps the stated bound — the
        // prompt billed as input — since the request may have been answered.
        const answeredWithError = failure.error_status !== undefined && failure.error_status !== 200;
        // No connection was made (no address, refused, no route): the request never reached Google.
        const neverSent = failure.error_code !== undefined && NEVER_SENT_CODES.has(failure.error_code);
        const failTokens = answeredWithError || neverSent
          ? { input: 0, input_cached: 0, output: 0 }
          : { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        attempts.push({
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, price.billed),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: err?.message ?? String(err),
          ...failure,
          price_basis: price.basis,
        });
        return this.finalizeResult(attempts, null, cacheHit, "vendor_error");
      }

      const text = outcome.text;
      const usage = outcome.usage;

      // `cachedContentTokenCount` is a SUBSET of `promptTokenCount` — subtract
      // to get disjoint counts (fresh at full rate, cached at discounted).
      // Without this, cached tokens are billed twice.
      const cachedTokens =
        usage.cachedContentTokenCount ?? (cacheHit ? estimateTokens(this.cacheHeader) : 0);
      const promptTokens = usage.promptTokenCount ?? estimateTokens(userPrompt);
      // Output = candidates + thoughts (see billedOutputTokens). Estimate
      // stands in only when the vendor sent no usage block at all.
      const outputTokens =
        usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
          ? estimateTokens(text)
          : billedOutputTokens(usage);
      const attemptTokens = {
        input: Math.max(0, promptTokens - cachedTokens),
        input_cached: cachedTokens,
        output: outputTokens,
      };

      // Only MAX_TOKENS triggers doubling. STOP/SAFETY/RECITATION/OTHER are
      // genuine terminations.
      const finishReason = outcome.finishReason;
      const hitOutputCap = finishReason === "MAX_TOKENS";

      attempts.push({
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: finishReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, price.billed),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
        price_basis: price.basis,
      });

      if (!hitOutputCap) {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, cacheHit, "success");
      }

      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling;
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        return this.finalizeResult(
          attempts,
          { raw: text, _truncated: true },
          cacheHit,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
        );
      }
      ceiling = nextCeiling;
    }

    return this.finalizeResult(attempts, null, cacheHit, "output_cap_doubling_budget_exhausted");
  }

  private finalizeResult(
    attempts: AttemptRecord[],
    parsed: any,
    cacheHit: boolean,
    terminalReason:
      | "success"
      | "output_cap_doubling_budget_exhausted"
      | "output_cap_at_model_absolute"
      | "vendor_error",
  ): ExecutionResult {
    const totalTokens = attempts.reduce(
      (acc, a) => ({
        input: acc.input + a.tokens.input,
        input_cached: acc.input_cached + a.tokens.input_cached,
        output: acc.output + a.tokens.output,
      }),
      { input: 0, input_cached: 0, output: 0 },
    );
    const totalCost = attempts.reduce((s, a) => s + a.cost_usd, 0);
    const totalLatency = attempts.reduce((s, a) => s + a.latency_ms, 0);
    const finalAttempt = attempts[attempts.length - 1];
    return {
      result: parsed,
      tokens: totalTokens,
      cost_usd: totalCost,
      latency_ms: totalLatency,
      cache_hit: cacheHit,
      success: terminalReason === "success",
      error: finalAttempt?.error,
      attempts,
      terminal_reason: terminalReason,
    };
  }
}

/** Node/undici codes of a request that never left this machine, so nothing reached Google to bill. */
const NEVER_SENT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EAI_AGAIN"]);

/**
 * A failed Gemini call, described by the vendor's own fields: the HTTP status
 * on @google/genai's ApiError, the Node/undici code of a connection that failed
 * in transit (on the error or its `cause`), and the delay a
 * `google.rpc.RetryInfo` entry in the JSON error body asks for. Nothing is read
 * from the error's wording.
 */
export function describeVendorFailure(err: any): { error_status?: number; error_code?: string; retry_after_ms?: number } {
  const out: { error_status?: number; error_code?: string; retry_after_ms?: number } = {};
  if (typeof err?.status === "number") out.error_status = err.status;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string") out.error_code = code;
  let body: any;
  try { body = JSON.parse(err?.message ?? ""); } catch { body = undefined; }
  const info = (body?.error?.details ?? []).find((d: any) => typeof d?.["@type"] === "string" && d["@type"].endsWith("google.rpc.RetryInfo"));
  // RetryInfo.retryDelay is a protobuf Duration, serialised in JSON as seconds with an "s" suffix ("7s", "0.5s").
  const m = typeof info?.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(info.retryDelay) : null;
  if (m) out.retry_after_ms = Math.round(Number(m[1]) * 1000);
  return out;
}

// Exported so the executor's other typists (lean Opus, the Antigravity typist)
// frame a unit's brief with exactly this text: parity means every typist reads
// byte-identical words, and this function is the one place the frame is defined.
export function buildUserPrompt(packet: TaskPacket, headerInline: string): string {
  const inputsBlock = packet.inputs
    .map((s) => `### ${s.path}  — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    headerInline ? `## Project header (inlined; cache miss)\n${headerInline}\n` : "",
    `## Task — ${packet.id} (${packet.phase}${packet.task_type ? ` / ${packet.task_type}` : ""})`, // an executor packet carries no task type
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    inputsBlock || "_(none)_",
    ``,
    `### Acceptance criteria`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output`,
    `Respond with strictly valid JSON conforming to the provided response schema.`,
    `Do not include any prose, markdown, or commentary outside the JSON.`,
  ]
    .filter(Boolean)
    .join("\n");
}
