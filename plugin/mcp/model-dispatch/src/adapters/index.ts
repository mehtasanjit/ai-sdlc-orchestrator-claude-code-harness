import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
import { AntigravityWorkerAdapter } from "./AntigravityWorkerAdapter.js";
import { ClaudeCliAdapter } from "./ClaudeCliAdapter.js";
import { log } from "../log.js";

/**
 * Adapter registry, keyed on the policy YAML's `adapter:` field.
 *   builtin-anthropic  → Claude, direct SDK (needs ANTHROPIC_API_KEY)
 *   claude-cli         → Claude, via local `claude -p` subprocess (Max subscription OAuth)
 *   mcp:model-dispatch → Gemini as a model (one completion call)
 *   antigravity-worker → Gemini as an agent (Antigravity SDK session)
 */

/** MMO-D8 compat shim: a hand-authored policy may still use the pre-rename id. Exported so every place that routes by adapter id (the executor's typists) accepts the same alias. */
export const LEGACY_GEMINI_ADAPTER_ID = "mcp:gemini-flash-server";
let legacyAdapterIdWarned = false;

/**
 * The registry is a map so the set of known adapter ids and the dispatch in
 * createAdapter can never drift apart: both are derived from these keys.
 * validateModel() in policy.ts checks each model's `adapter:` against
 * KNOWN_ADAPTER_IDS at policy-load time — previously a typo'd adapter id
 * passed validation and only exploded when createAdapter ran mid-run, after
 * premium phases had already been billed.
 */
const ADAPTER_FACTORIES: Record<string, (config: ModelConfig) => ModelAdapter> = {
  "builtin-anthropic": (config) => new BuiltinAnthropicAdapter(config),
  "claude-cli": (config) => new ClaudeCliAdapter(config),
  "mcp:model-dispatch": (config) => new GeminiFlashAdapter(config),
  [LEGACY_GEMINI_ADAPTER_ID]: (config) => {
    if (!legacyAdapterIdWarned) {
      legacyAdapterIdWarned = true;
      log("warn", "policy.adapter.deprecated", { adapter_id_seen: LEGACY_GEMINI_ADAPTER_ID, canonical: "mcp:model-dispatch" });
    }
    return new GeminiFlashAdapter(config);
  },
  "antigravity-worker": (config) => new AntigravityWorkerAdapter(config),
};

/** Every adapter id a policy may name, including the legacy compat alias. */
export const KNOWN_ADAPTER_IDS: ReadonlySet<string> = new Set(Object.keys(ADAPTER_FACTORIES));

export function createAdapter(config: ModelConfig): ModelAdapter {
  const factory = ADAPTER_FACTORIES[config.adapter];
  if (!factory) {
    throw new Error(
      `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`,
    );
  }
  return factory(config);
}

export type { ModelAdapter } from "./ModelAdapter.js";
