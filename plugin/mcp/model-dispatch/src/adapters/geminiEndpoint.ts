/**
 * Where a Gemini call is billed: the door (AI Studio key or Vertex), the
 * Vertex location, and the +10% regional surcharge. Pure rules, no SDK.
 *
 * Split out of geminiTransports.ts (v0.7.3 review fix) so the what-if replay
 * (routing.ts simulatePolicyCost) bills a replayed Gemini event by the same
 * rules the adapters bill a dispatch by. routing.ts is imported by the
 * collector and the driver-model check, which must not load @google/genai to
 * price a replay, so these rules cannot live beside the transports.
 * geminiTransports.ts re-exports everything here, so existing imports keep
 * working.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelConfig } from "../types.js";

// ─── backend selection (pure; unit-tested) ────────────────────────────

export type GeminiBackend = "api-key" | "vertex-adc";

export interface BackendSelectionInput {
  /** process.env (or a fixture in tests). */
  env: Record<string, string | undefined>;
  /** The env var the policy names for the API key (auth.env, default GEMINI_API_KEY). */
  keyEnvName: string;
  /** Whether a default gcloud ADC file exists on this machine. */
  adcFileExists: boolean;
}

export interface BackendChoice {
  backend: GeminiBackend;
  /** Human-readable trail for logs and error messages. */
  reason: string;
}

/**
 * Precedence:
 *   1. GEMINI_BACKEND=vertex|api-key — explicit override.
 *   2. Policy's API-key env var set → api-key. A key is a deliberate local
 *      decision; ADC is often ambient machine state.
 *   3. Any Vertex signal (GOOGLE_APPLICATION_CREDENTIALS, ADC file, or
 *      GOOGLE_CLOUD_PROJECT) → vertex-adc.
 *   4. Nothing → throw, naming both doors.
 *
 * No logging: selectGeminiBackend (geminiTransports.ts) logs the choice for a
 * real dispatch, and the what-if replay calls this once per replayed event.
 */
export function resolveGeminiBackend(input: BackendSelectionInput): BackendChoice {
  const { env, keyEnvName, adcFileExists } = input;
  const override = env.GEMINI_BACKEND?.trim().toLowerCase();
  if (override) {
    if (override === "vertex") return { backend: "vertex-adc", reason: "GEMINI_BACKEND=vertex" };
    if (override === "api-key") return { backend: "api-key", reason: "GEMINI_BACKEND=api-key" };
    throw new Error(
      `GEMINI_BACKEND='${env.GEMINI_BACKEND}' is not a recognized value. Use 'vertex' or 'api-key', ` +
        `or unset it to let credentials decide.`,
    );
  }

  if (env[keyEnvName]) return { backend: "api-key", reason: `${keyEnvName} is set` };

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { backend: "vertex-adc", reason: "GOOGLE_APPLICATION_CREDENTIALS is set" };
  }
  if (adcFileExists) {
    return { backend: "vertex-adc", reason: "gcloud ADC file present" };
  }
  if (env.GOOGLE_CLOUD_PROJECT) {
    return { backend: "vertex-adc", reason: "GOOGLE_CLOUD_PROJECT is set" };
  }

  // Keep aligned with verify-setup.mjs's `gemini-credentials` warning
  // (synced by hand — that script runs pre-build).
  throw new Error(
    `No Gemini credentials found. Either authenticate to Vertex AI with ` +
      `\`gcloud auth application-default login\` (no key; the project is read from ` +
      `GOOGLE_CLOUD_PROJECT, or from the ADC file's quota project), or export ` +
      `${keyEnvName}=... for the AI Studio path (https://aistudio.google.com/app/apikey).`,
  );
}

/** Default location of the ADC file `gcloud auth application-default login` writes. */
export function defaultAdcPath(home: string = homedir()): string {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

// ─── Vertex location ──────────────────────────────────────────────────

/**
 * Region for Vertex calls. Defaults to `global` — a pricing default, not
 * latency: Vertex bills regional endpoints +10% on every token class for
 * Gemini 3+ (effective 2026-07-01), and the policy YAMLs pin the flat global
 * rates. Overriding with GOOGLE_CLOUD_LOCATION applies the surcharge to the
 * reported cost — see applyVertexSurcharge.
 */
export function resolveGcpLocation(env: Record<string, string | undefined>): string {
  return env.GOOGLE_CLOUD_LOCATION ?? "global";
}

/**
 * The Vertex location an Antigravity worker leaf runs and bills in: the leaf's
 * `region:`, then GOOGLE_CLOUD_LOCATION, then `global`. AntigravityWorkerAdapter
 * and the what-if replay both read it here, so the two cannot disagree.
 */
export function workerVertexLocation(model: Pick<ModelConfig, "region">, env: Record<string, string | undefined>): string {
  return model.region ?? resolveGcpLocation(env);
}

// ─── the regional surcharge ───────────────────────────────────────────

// Vertex regional surcharge — Gemini 3+ non-global endpoints, effective
// 2026-07-01. https://cloud.google.com/vertex-ai/generative-ai/pricing
export const VERTEX_NONGLOBAL_SURCHARGE = 1.1;
export const VERTEX_NONGLOBAL_EFFECTIVE = "2026-07-01";

/** A Vertex location bills the surcharge unless it is the flat "global" endpoint. */
export function isVertexNonGlobal(location: string): boolean {
  return Boolean(location) && location.trim().toLowerCase() !== "global";
}

/**
 * Gemini 3+ only (2.5 has no regional premium). Family digit rather than
 * allow-list, so a new 3.x/4.x id surcharges by default — over-reporting is
 * the safe direction, under-reporting is not.
 */
export function vertexSurchargeApplies(modelName: string): boolean {
  const m = modelName.trim().toLowerCase();
  if (!m.startsWith("gemini-")) return false;
  const major = Number(m.slice("gemini-".length).match(/^(\d+)/)?.[1]);
  return Number.isFinite(major) && major >= 3;
}

/**
 * The multiplier Vertex bills a Gemini call at: VERTEX_NONGLOBAL_SURCHARGE for
 * Gemini 3+ at a non-global Vertex endpoint, else 1.
 *
 * `day` (a UTC YYYY-MM-DD) is for the what-if replay, which prices past
 * events: a day before VERTEX_NONGLOBAL_EFFECTIVE is 1, because Google did not
 * bill the surcharge then. A live dispatch is always on or after that day and
 * passes none.
 */
export function vertexSurchargeFactor(opts: {
  backend: GeminiBackend;
  location: string;
  modelName: string;
  day?: string;
}): number {
  const surcharged =
    opts.backend === "vertex-adc" && isVertexNonGlobal(opts.location) && vertexSurchargeApplies(opts.modelName);
  if (!surcharged) return 1;
  if (opts.day !== undefined && opts.day < VERTEX_NONGLOBAL_EFFECTIVE) return 1;
  return VERTEX_NONGLOBAL_SURCHARGE;
}

/**
 * The rates a Gemini adapter bills at its resolved endpoint: input, cached
 * input and output multiplied by vertexSurchargeFactor. The same arithmetic
 * as before the split (rate x 1.1), so a dispatch's dollars do not move.
 */
export function applyVertexSurcharge<T extends { input: number; input_cached: number; output: number }>(
  pricing: T,
  opts: { backend: GeminiBackend; location: string; modelName: string },
): T {
  const k = vertexSurchargeFactor(opts);
  if (k === 1) return pricing;
  return {
    ...pricing,
    input: pricing.input * k,
    input_cached: pricing.input_cached * k,
    output: pricing.output * k,
  };
}

// ─── the endpoint a policy leaf dispatches to ─────────────────────────

/**
 * The endpoint a policy leaf's Gemini call would be billed at in `env`, or
 * null for a leaf that is not a Gemini adapter. Mirrors the adapters:
 *
 * - `antigravity-worker` (AntigravityWorkerAdapter): always Vertex, at
 *   workerVertexLocation.
 * - `mcp:model-dispatch` and its old spelling `mcp:gemini-flash-server`
 *   (GeminiFlashAdapter via buildGeminiTransport): the door
 *   resolveGeminiBackend picks with the leaf's `auth.env` key name, at
 *   resolveGcpLocation(env). That adapter's Vertex transport reads no
 *   `region:`, so neither does this.
 *
 * When resolveGeminiBackend finds no credentials (or GEMINI_BACKEND holds an
 * unrecognized value), the adapter cannot be built and pre-flight halts, so no
 * dispatch figure exists to agree with. Vertex is assumed: at a non-global
 * GOOGLE_CLOUD_LOCATION that can only over-report, the safe direction.
 */
export function geminiDispatchEndpoint(
  model: Pick<ModelConfig, "adapter" | "region" | "auth">,
  env: Record<string, string | undefined>,
  adcFileExists: boolean,
): { backend: GeminiBackend; location: string } | null {
  if (model.adapter === "antigravity-worker") {
    return { backend: "vertex-adc", location: workerVertexLocation(model, env) };
  }
  if (model.adapter === "mcp:model-dispatch" || model.adapter === "mcp:gemini-flash-server") {
    let backend: GeminiBackend;
    try {
      backend = resolveGeminiBackend({ env, keyEnvName: model.auth?.env ?? "GEMINI_API_KEY", adcFileExists }).backend;
    } catch {
      backend = "vertex-adc";
    }
    return { backend, location: resolveGcpLocation(env) };
  }
  return null;
}
