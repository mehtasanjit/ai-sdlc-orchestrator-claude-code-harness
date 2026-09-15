/**
 * The two doors into Gemini, behind one interface. GeminiFlashAdapter owns
 * everything model-agnostic (doubling loop, prompt assembly, JSON-schema mode,
 * telemetry); this module owns request signing and endpoint choice.
 *
 *   api-key    — Google AI Studio. API key in an env var.
 *   vertex-adc — Vertex AI. Application Default Credentials; bills a project.
 *
 * Both run on `@google/genai`. Backend selection is a pure function so the
 * precedence rules are unit-testable without touching process state.
 */

import { existsSync, readFileSync } from "node:fs";

import { GoogleGenAI } from "@google/genai";
import { log } from "../log.js";
import {
  defaultAdcPath,
  resolveGcpLocation,
  resolveGeminiBackend,
  type BackendChoice,
  type BackendSelectionInput,
  type GeminiBackend,
} from "./geminiEndpoint.js";

// Changed (v0.7.3 review fix): the pure endpoint rules (door precedence, the
// Vertex location, the regional surcharge) moved to geminiEndpoint.ts, which
// loads no SDK, so the what-if replay in routing.ts bills by the same rules
// without pulling @google/genai into the collector and the driver-model check.
// Re-exported here so every existing import keeps working.
export {
  VERTEX_NONGLOBAL_EFFECTIVE,
  VERTEX_NONGLOBAL_SURCHARGE,
  applyVertexSurcharge,
  defaultAdcPath,
  geminiDispatchEndpoint,
  isVertexNonGlobal,
  resolveGcpLocation,
  resolveGeminiBackend,
  vertexSurchargeApplies,
  vertexSurchargeFactor,
  workerVertexLocation,
} from "./geminiEndpoint.js";
export type { BackendChoice, BackendSelectionInput, GeminiBackend } from "./geminiEndpoint.js";

// ─── backend selection ────────────────────────────────────────────────

/**
 * The door for a real Gemini dispatch: resolveGeminiBackend's precedence
 * (geminiEndpoint.ts), logged on every call.
 */
export function selectGeminiBackend(input: BackendSelectionInput): BackendChoice {
  const choice = resolveGeminiBackend(input);
  // Logged on every call; this is a pure function, so no run-scoped dedup state.
  log("info", "api.gemini.backend", {
    backend: choice.backend,
    reason: choice.reason,
    project: input.env.GOOGLE_CLOUD_PROJECT,
    adc_file_present: input.adcFileExists,
  });
  return choice;
}

/**
 * GOOGLE_CLOUD_PROJECT → the project inside the credentials file.
 * Undefined when nothing resolves: generateContent still works (SDK runs its
 * own resolution against gcloud config and the metadata server), but explicit
 * cache creation is skipped because the cache name embeds the project.
 */
export function resolveGcpProject(
  env: Record<string, string | undefined>,
  adcPath: string = defaultAdcPath(),
): string | undefined {
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  const candidate = env.GOOGLE_APPLICATION_CREDENTIALS ?? adcPath;
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    // User ADC records quota_project_id; service-account files record project_id.
    return parsed.quota_project_id ?? parsed.project_id ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Google bills reasoning at the output rate. `thoughtsTokenCount` is a
 * SIBLING of `candidatesTokenCount`, not a subset (contrast
 * `cachedContentTokenCount`, which IS a subset of `promptTokenCount` — the
 * two fields look alike and behave oppositely). Billed output = sum.
 */
export function billedOutputTokens(usage: Record<string, number | undefined>): number {
  return (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
}

// ─── the transport interface ──────────────────────────────────────────

export interface GenerateArgs {
  modelName: string;
  prompt: string;
  generationConfig: Record<string, unknown>;
  /** Server-side cache resource name from createCache; omit on cache miss. */
  cachedContentName?: string;
}

export interface GenerateOutcome {
  text: string;
  /** Vendor usageMetadata verbatim: promptTokenCount / candidatesTokenCount / cachedContentTokenCount. */
  usage: Record<string, number | undefined>;
  finishReason?: string;
}

export interface GeminiTransport {
  readonly backend: GeminiBackend;
  /** "global" or a region name; empty on the AI Studio path. Cost depends on it. */
  readonly location: string;
  /** Create an explicit context cache; undefined → adapter inlines the header. */
  createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined>;
  generate(args: GenerateArgs): Promise<GenerateOutcome>;
}

// ─── the shared implementation behind both doors ──────────────────────

/**
 * Shared request/response handling. The two doors differ only in client
 * construction and how the caches API addresses a model.
 */
abstract class GenAiTransport implements GeminiTransport {
  abstract readonly backend: GeminiBackend;
  abstract readonly location: string;
  protected readonly ai: GoogleGenAI;

  protected constructor(ai: GoogleGenAI) {
    this.ai = ai;
  }

  /**
   * Model name for the caches API. Vertex needs a fully-qualified resource
   * path (project + location); AI Studio takes bare `models/<name>`.
   * Undefined → cache cannot be addressed.
   */
  protected abstract cacheModelId(modelName: string): string | undefined;

  async createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined> {
    const model = this.cacheModelId(modelName);
    if (!model) return undefined;
    const created = await this.ai.caches.create({
      model,
      config: {
        displayName,
        contents: [{ role: "user", parts: [{ text: headerText }] }],
        ttl: `${ttlSeconds}s`,
      },
    });
    log("debug", "api.gemini.cache.create", {
      cache_context: displayName,
      token_count: undefined,
      ttl: ttlSeconds,
    });
    return created?.name;
  }

  async generate(args: GenerateArgs): Promise<GenerateOutcome> {
    log("debug", "api.gemini.request", {
      model_name: args.modelName,
      transport: this.backend,
      cached_content: args.cachedContentName,
      max_output_tokens: (args.generationConfig as any)?.maxOutputTokens,
      thinking_budget: (args.generationConfig as any)?.thinkingConfig?.thinkingBudget,
    });
    if (args.cachedContentName) {
      log("debug", "api.gemini.cache.hit", { cache_context: args.cachedContentName });
    }
    const resp = await this.ai.models.generateContent({
      model: args.modelName,
      contents: [{ role: "user", parts: [{ text: args.prompt }] }],
      config: {
        ...(args.generationConfig as Record<string, unknown>),
        ...(args.cachedContentName ? { cachedContent: args.cachedContentName } : {}),
      },
    });
    const finishReason = resp.candidates?.[0]?.finishReason
      ? String(resp.candidates[0].finishReason)
      : undefined;
    log("debug", "api.gemini.response", {
      model_name: args.modelName,
      transport: this.backend,
      finish_reason: finishReason,
      usage: JSON.stringify(resp.usageMetadata ?? {}),
      http_status: 200,
    });
    return {
      // `text` is "" (not undefined) when the model returned no text —
      // happens when the output cap is spent entirely on thinking.
      text: resp.text ?? "",
      usage: (resp.usageMetadata ?? {}) as Record<string, number | undefined>,
      finishReason,
    };
  }
}

// ─── door 1: AI Studio API key ────────────────────────────────────────

export class ApiKeyTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "api-key";
  // AI Studio has no regional endpoints.
  readonly location = "";

  constructor(apiKey: string) {
    super(new GoogleGenAI({ apiKey }));
  }

  protected cacheModelId(modelName: string): string {
    return `models/${modelName}`;
  }
}

// ─── door 2: Vertex AI with Application Default Credentials ───────────

export class VertexAdcTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "vertex-adc";
  readonly location: string;
  private readonly project?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const project = resolveGcpProject(env);
    const location = resolveGcpLocation(env);
    // Only pass project when resolved, so the SDK can fall back to its own
    // resolution (gcloud config, metadata server).
    super(
      new GoogleGenAI({
        vertexai: true,
        ...(project ? { project } : {}),
        location,
      }),
    );
    this.project = project;
    this.location = location;
  }

  protected cacheModelId(modelName: string): string | undefined {
    if (!this.project) return undefined;
    return `projects/${this.project}/locations/${this.location}/publishers/google/models/${modelName}`;
  }
}

// ─── construction helper used by GeminiFlashAdapter ───────────────────

export function buildGeminiTransport(
  keyEnvName: string,
  env: Record<string, string | undefined> = process.env,
): { transport: GeminiTransport; choice: BackendChoice } {
  const choice = selectGeminiBackend({
    env,
    keyEnvName,
    adcFileExists: existsSync(defaultAdcPath()),
  });
  const transport =
    choice.backend === "api-key"
      ? new ApiKeyTransport(env[keyEnvName]!)
      : new VertexAdcTransport(env);
  return { transport, choice };
}
