/**
 * Policy loader & validator. Precedence:
 *   1. explicit policy_path — an upstream caller that wants a specific file
 *      (e.g. an explicit --policy flag resolved to its preset path) routes it
 *      through loadPolicyFromPath, which bypasses this loader's search
 *   2. <projectRoot>/routing-policy.yaml — the repo-local override
 *   3. plugin/config/policies/<name>.yaml — the shipped preset for policyName
 *
 * Inside loadPolicy itself the override at (2) always beats the name at (3):
 * passing policy_name + project_root together means "use the project's file
 * if it has one, else this preset".
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Policy, ModelConfig } from "./types.js";
import { KNOWN_ADAPTER_IDS } from "./adapters/index.js";

const PLUGIN_POLICY_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "config",
  "policies"
);

export function loadPolicy(opts: {
  policyName?: string;          // e.g. "opus-only"
  projectRoot?: string;         // for project-level override
}): Policy {
  // 1. Project override
  if (opts.projectRoot) {
    const override = join(opts.projectRoot, "routing-policy.yaml");
    if (existsSync(override)) {
      return validatePolicy(parseYaml(readFileSync(override, "utf-8")));
    }
  }
  // 2. Named preset
  const name = opts.policyName ?? "opus-only";
  const presetPath = join(PLUGIN_POLICY_DIR, `${name}.yaml`);
  if (!existsSync(presetPath)) {
    throw new Error(
      `Policy '${name}' not found at ${presetPath}. ` +
        `Available: ${shippedPresetNames()}. ` +
        // Point at the repo-local override, not the plugin dir: the plugin
        // cache is wiped by every /plugin update, so a YAML dropped there
        // silently disappears. routing-policy.yaml lives in the project.
        `Add your own as <projectRoot>/routing-policy.yaml (a YAML in ` +
        `${PLUGIN_POLICY_DIR} is lost on every plugin update).`
    );
  }
  return validatePolicy(parseYaml(readFileSync(presetPath, "utf-8")));
}

/**
 * The "Available:" list is read from disk on demand, never hardcoded — a
 * hardcoded list already went stale once (it said two presets while seven
 * shipped). Failure to read the directory degrades the message, not the error.
 */
function shippedPresetNames(): string {
  try {
    const names = readdirSync(PLUGIN_POLICY_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length))
      .sort();
    return names.length > 0 ? names.join(", ") : `(none found in ${PLUGIN_POLICY_DIR})`;
  } catch {
    return `(could not list ${PLUGIN_POLICY_DIR})`;
  }
}

export function loadPolicyFromPath(path: string): Policy {
  if (!existsSync(path)) throw new Error(`Policy file not found: ${path}`);
  return validatePolicy(parseYaml(readFileSync(path, "utf-8")));
}

function validatePolicy(raw: any): Policy {
  if (!raw || typeof raw !== "object") {
    throw new Error("Policy: root must be an object");
  }
  if (typeof raw.version !== "number") {
    throw new Error("Policy: 'version' (number) required");
  }
  if (typeof raw.name !== "string") {
    throw new Error("Policy: 'name' (string) required");
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error("Policy: 'models' (non-empty array) required");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error("Policy: 'rules' (non-empty array) required");
  }
  for (const m of raw.models) validateModel(m);
  const modelIds = new Set<string>(raw.models.map((m: ModelConfig) => m.id));
  const slotNames = validateSelect(raw, modelIds);
  // Every rule references a known model id or a declared slot; check at load
  // so a routing failure never reaches a paid dispatch.
  raw.rules.forEach((r: any, i: number) => {
    const used = r.use ?? r.default;
    if (!used) throw new Error(`Policy rule ${i}: needs 'use' or 'default'`);
    if (!modelIds.has(used) && !slotNames.has(used)) {
      const known = [...modelIds, ...slotNames].join(", ");
      throw new Error(
        `Policy rule ${i}: references unknown model id '${used}'. Known: ${known}`
      );
    }
  });
  return raw as Policy;
}

/**
 * Validate the optional `select:` block and return the slot names it declares.
 * A slot name that collides with a model id is refused: `use: <name>` would
 * be ambiguous.
 */
function validateSelect(raw: any, modelIds: Set<string>): Set<string> {
  const names = new Set<string>();
  if (raw.select === undefined) return names;
  if (typeof raw.select !== "object" || raw.select === null || Array.isArray(raw.select)) {
    throw new Error("Policy: 'select' must be a map of slot name → { default, options }");
  }
  for (const [name, slot] of Object.entries<any>(raw.select)) {
    if (modelIds.has(name)) {
      throw new Error(
        `Policy select '${name}': collides with a model id — a rule naming it would be ` +
          `ambiguous. Rename the slot or the model.`
      );
    }
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      throw new Error(`Policy select '${name}': must be an object with 'default' and 'options'`);
    }
    if (!Array.isArray(slot.options) || slot.options.length === 0) {
      throw new Error(`Policy select '${name}': 'options' (non-empty array of model ids) required`);
    }
    for (const opt of slot.options) {
      if (!modelIds.has(opt)) {
        throw new Error(
          `Policy select '${name}': option '${opt}' is not a model id in this policy. ` +
            `Known: ${[...modelIds].join(", ")}`
        );
      }
    }
    if (typeof slot.default !== "string" || !slot.options.includes(slot.default)) {
      throw new Error(
        `Policy select '${name}': 'default' must be one of its own options ` +
          `(${slot.options.join(", ")}). A default outside the option list is a routing ` +
          `target no run could ever have chosen deliberately.`
      );
    }
    names.add(name);
  }
  return names;
}

function validateModel(m: any) {
  // `pricing` is no longer required: the dated price list (src/prices.ts)
  // prices every dispatch (effectivePrice.ts), so a model the list knows
  // needs no block. A block is still validated when present, because
  // pricing_override bills it and a shipped block documents the list's card.
  // The orchestrator's estimates read load_policy's effective price since
  // v0.7.3 Q3, not the block.
  for (const key of ["id", "adapter", "model_name"]) {
    if (!(key in m)) throw new Error(`Policy model: missing '${key}'`);
  }
  // The adapter id must be one the registry can actually construct. Without
  // this check a typo'd `adapter:` passed validation and only failed when
  // createAdapter ran mid-run — after the premium phases were already billed.
  // KNOWN_ADAPTER_IDS is derived from the registry's own keys, so it can
  // never drift from what createAdapter accepts.
  if (!KNOWN_ADAPTER_IDS.has(m.adapter)) {
    throw new Error(
      `Policy model '${m.id}': unknown adapter '${m.adapter}'. ` +
        `Known adapters: ${[...KNOWN_ADAPTER_IDS].join(", ")}. ` +
        `Register new adapters in adapters/index.ts.`
    );
  }
  // pricing_override is the only way a policy block is billed, so it must be
  // unambiguous: a string "yes" or a flag with nothing to bill is refused at
  // load, before any run could be priced on a misread intent.
  if (m.pricing_override !== undefined && typeof m.pricing_override !== "boolean") {
    throw new Error(`Policy model '${m.id}': pricing_override must be true or false, got ${JSON.stringify(m.pricing_override)}`);
  }
  if (m.pricing === undefined || m.pricing === null) {
    if (m.pricing_override === true) {
      throw new Error(
        `Policy model '${m.id}': pricing_override: true needs a pricing block to bill, and this model has none. ` +
          `Add the block, or remove pricing_override to price the model from the price list.`
      );
    }
    return;
  }
  if (typeof m.pricing !== "object" || Array.isArray(m.pricing)) {
    throw new Error(`Policy model '${m.id}': pricing must be a map of USD-per-1M rates`);
  }
  for (const k of ["input", "input_cached", "output"]) {
    if (typeof m.pricing[k] !== "number") {
      throw new Error(`Policy model '${m.id}': pricing.${k} must be number`);
    }
  }
  // The write rates are optional (computeCostUsd falls back to input x 1.25 /
  // x 2), but a declared one must be a number: a string would price as NaN.
  for (const k of ["input_cache_write", "input_cache_write_1h"]) {
    if (m.pricing[k] !== undefined && typeof m.pricing[k] !== "number") {
      throw new Error(`Policy model '${m.id}': pricing.${k} must be number`);
    }
  }
}

export function getModel(policy: Policy, modelId: string): ModelConfig {
  const m = policy.models.find((x) => x.id === modelId);
  if (!m) throw new Error(`Model id '${modelId}' not found in policy '${policy.name}'`);
  return m;
}
