#!/usr/bin/env node
/**
 * MCP server entrypoint. Tools:
 *   execute_with_model   — run a TaskPacket against the model chosen by policy
 *   simulate_policy      — recompute cost from telemetry against another policy
 *   log_telemetry        — append a direct-tier event to disk
 *   preflight_dispatch   — construct every adapter this run will use (no API call)
 *   load_policy          — return the active policy, each model with its effective price for today
 */

// MUST stay the first import — strips `${NAME}` placeholder env vars before
// any SDK reads process.env. See envBootstrap.ts.
import "./envBootstrap.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { loadPolicy, loadPolicyFromPath, getModel } from "./policy.js";
import {
  pickModel,
  simulatePolicyCost,
  parseSelectOverrides,
  validateSelectOverrides,
  unreachableModelIds,
} from "./routing.js";
import { assessModels, claudeKeyProblem, executorCliCheck, parseAuthMode, type AuthMode } from "./preflight.js";
import { checkModelPrice, withEffectivePrices } from "./effectivePrice.js";
import { appendEvent, cacheWriteBuckets, normalizeDirectTierEvent } from "./telemetry.js";
import { createAdapter } from "./adapters/index.js";
import {
  defaultAdcPath,
  selectGeminiBackend,
  resolveGcpProject,
  resolveGcpLocation,
} from "./adapters/geminiTransports.js";
import type { TaskPacket, TelemetryEvent, Policy, SelectOverrides, ApplySpec, ModelConfig } from "./types.js";
import {
  FILE_OUTPUT_SCHEMA,
  applyContent,
  checkWriteContract,
  hasActiveWriteContract,
  extractFileContent,
  hydrateInputs,
  normalizeApply,
  runApplyLoop,
  applyBudget,
  readsSlicesFromDisk,
} from "./apply.js";
import { runBatch, batchPacketsFromArgs, compactBatchReceipt, markSharedInputs, batchProgress, packetFingerprint, alreadyApplied, appendAppliedRecord, fileSha256, readAppliedRecords } from "./batch.js";
import { executorView } from "./executor/run.js";
import { resolveProjectRoot } from "./project-root.js";
import { log, setLevel, configureSinks, type Level } from "./log.js";
// Typed-spec executor tools (greenfield runs): listed below, handled in executor/tools.ts.
import { EXECUTOR_TOOLS, EXECUTOR_TOOL_NAMES, STAGE_CONCURRENCY, fallbackLeaf, typistForLeaf, executorClaudeLeaves, executorPolicyNotes, handleExecutorTool, type RunState } from "./executor/tools.js";
import { BROWNFIELD_INTENTS, TypistApplyAdapter, usesServerTypist } from "./applyTypist.js";
import { EDIT_ANSWER_SCHEMA } from "./executor/brief.js";
import { HANDOFF_TOOLS, HANDOFF_TOOL_NAMES, handleHandoffTool } from "./handoff/tools.js";
import { handoffListing } from "./handoff/listing.js";
import { leanOpusCliProblem } from "./executor/typists.js";
import { probeEvents, probeTypists, runTypingLeaves } from "./typistProbe.js";
import { runCard } from "./runCard.js";
import { PLUGIN_ROOT } from "./paths.js";

/**
 * Cheap up-front schema validation for TaskPacket inputs to execute_with_model.
 * Purpose: give the orchestrator a clean "missing field X" error instead of the
 * downstream "Cannot read properties of undefined (reading 'map')" that fires
 * when adapters try to iterate `packet.inputs` or read `packet.budget.maxOutputTokens`.
 * Failure mode observed in real run — see PR #21 self-review notes.
 */
function validateTaskPacket(raw: unknown): TaskPacket {
  if (raw == null || typeof raw !== "object") {
    throw new Error("execute_with_model: `packet` argument is missing or not an object.");
  }
  const packet = raw as Record<string, unknown>;
  const required = [
    "id", "phase", "task_type", "module", "instruction",
    "inputs", "outputSchema", "acceptance", "budget", "pass_id",
  ];
  // Under apply the server supplies the {path, content} schema (apply.ts).
  const applying = normalizeApply(packet.apply) !== null;
  const missing = required.filter((k) => packet[k] === undefined && !(applying && k === "outputSchema"));
  if (missing.length > 0) {
    log("warn", "packet.validate.fail", {
      packet_id: typeof packet.id === "string" ? packet.id : undefined,
      missing_fields: missing.join(","),
    });
    throw new Error(
      `execute_with_model: TaskPacket is missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
      `See plugin/mcp/model-dispatch/src/types.ts for the schema (or plugin/agents/orchestrator.md for the required-fields table).`,
    );
  }
  if (!Array.isArray(packet.inputs)) {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "inputs" });
    throw new Error(
      `execute_with_model: TaskPacket.inputs must be a FileSlice[] array — pass [] for packets that read no files. Got: ${typeof packet.inputs}`,
    );
  }
  const budget = packet.budget as { maxOutputTokens?: unknown; maxInputTokens?: unknown } | undefined;
  if (!budget || typeof budget.maxOutputTokens !== "number" || typeof budget.maxInputTokens !== "number") {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "budget" });
    throw new Error(
      `execute_with_model: TaskPacket.budget must be { maxInputTokens: number, maxOutputTokens: number }.`,
    );
  }
  if (applying && typeof packet.artifact_path !== "string") {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "artifact_path" });
    throw new Error(
      `execute_with_model: packet.apply.write requires artifact_path — the repo-relative file the server writes.`,
    );
  }
  return packet as unknown as TaskPacket;
}

const SERVER_NAME = "model-dispatch";
const SERVER_VERSION = "0.1.0";

// Runtime state: loaded policies cached by name, adapters cached by the model configuration they were built from.
const adapterCache = new Map<string, ReturnType<typeof createAdapter>>();
let activePolicy: Policy | null = null;
/** A run as its pre-flight recorded it; the run id and the brownfield job (intent) when pre-flight was given them. */
type ServerRun = RunState & { runId?: string; intent?: string };
/**
 * The run as pre-flight saw it: the auth mode and the policy arguments.
 * execute_stage reads these instead of taking them per call, so the model
 * states the run's auth mode once (Phase -1) and every stage uses that same
 * value.
 */
let runState: ServerRun | undefined;
/**
 * Each run's pre-flight, by project and run id (runKey): the source of truth for that run's policy and auth mode. A
 * brownfield call that names the run (execute_with_model, execute_batch) is typed under the policy its pre-flight
 * checked and probed (runFor).
 */
const runStates = new Map<string, ServerRun>();
/** A run's key: a run id names a folder under one project's .sdlc/runs, so the project is part of it. */
const runKey = (projectRoot: string | undefined, runId: string) => `${resolvePath(resolveProjectRoot(projectRoot) ?? "")}|${runId}`;
let activePolicyKey = "";

/** Slot choices, spelled `slot=option[,slot=option...]`. Property of the install. */
const SELECT_ENV = "MMO_SELECT";
/** MMO-D8 compat shim: pre-rename installs still export this. Warn once, keep working. */
const LEGACY_SELECT_ENV = "SDLC_SELECT";
let legacySelectWarned = false;

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  // An omitted project_root falls back to the one an earlier caller supplied,
  // so a dispatch resolves the same policy the preview did. See project-root.ts.
  projectRoot = resolveProjectRoot(projectRoot);
  const key = `${policyName ?? "opus-only"}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  const policy = policyPath
    ? loadPolicyFromPath(policyPath)
    : loadPolicy({ policyName, projectRoot });
  // Every policy load goes through here, so a bad slot choice fails at load
  // rather than partway through a paid phase.
  validateSelectOverrides(policy, selectOverrides());
  activePolicy = policy;
  activePolicyKey = key;
  log("info", "policy.load", {
    policy_name: policy.name,
    resolved_path: policyPath,
    source: policyPath ? "path" : "name",
    version: policy.version,
    model_count: policy.models.length,
    rule_count: policy.rules.length,
  });
  return activePolicy;
}

/** Re-read on every call — a test can set the variable without restarting. */
function selectOverrides(): SelectOverrides {
  const value = process.env[SELECT_ENV] ?? legacySelectValue();
  return parseSelectOverrides(value);
}

function legacySelectValue(): string | undefined {
  const value = process.env[LEGACY_SELECT_ENV];
  if (value === undefined) return undefined;
  if (!legacySelectWarned) {
    legacySelectWarned = true;
    log("warn", "env.legacy_name", { names: LEGACY_SELECT_ENV, canonical: SELECT_ENV });
  }
  return value;
}

/**
 * A model configuration as a cache key: the whole leaf (model name, adapter, auth, region, limits, pricing), keys
 * sorted. Shipped policies reuse leaf ids (opus, flash-completion) for different models, and one chat can run two
 * policies, so a typist or adapter built for one policy's leaf is reused only for exactly the same leaf.
 */
function configKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(configKey).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${configKey((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * Greenfield's typist for a policy leaf (executor/tools.ts typistForLeaf), wrapped for the apply loop: one per leaf
 * configuration and billing mode, so its warm gate and Flash's inline header persist across a batch's packets, and a
 * later run under a policy whose leaf of the same id names another model gets its own.
 */
const typistAdapters = new Map<string, TypistApplyAdapter>();
function typistApplyAdapter(leaf: ModelConfig, authMode: "estimated" | "vendor"): TypistApplyAdapter {
  const key = `${authMode}|${configKey(leaf)}`;
  let adapter = typistAdapters.get(key);
  if (!adapter) { adapter = new TypistApplyAdapter(leaf, typistForLeaf(leaf, authMode)); typistAdapters.set(key, adapter); }
  return adapter;
}

function adapterFor(policy: Policy, modelId: string) {
  // Keyed by the configuration the adapter is built from: two policies can give one leaf id different models. An
  // apply packet never comes here: it is typed by a typist (dispatchOnce).
  const key = configKey(getModel(policy, modelId));
  const cacheHit = adapterCache.has(key);
  if (cacheHit) {
    const cached = adapterCache.get(key)!;
    log("debug", "adapter.construct", { model_id: modelId, adapter: getModel(policy, modelId).adapter, cache_hit: true });
    return cached;
  }
  const model = getModel(policy, modelId);
  const adapter = createAdapter(model);
  adapterCache.set(key, adapter);
  log("debug", "adapter.construct", { model_id: modelId, adapter: model.adapter, cache_hit: false });
  return adapter;
}

/** The plugin's directory and its version, for the run card (from paths.ts, so the bundle finds it too). */
const PLUGIN_DIR = PLUGIN_ROOT;
function pluginVersion(): string {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown"; } catch { return "unknown"; }
}

/**
 * Construct every adapter the loaded policy names, before the run spends
 * anything. Adapters are otherwise built lazily on first dispatch, where a
 * credential problem would surface after premium-tier phases had already been
 * billed. No API call — construction is where credential discovery happens.
 * Adapters land in the shared cache, so the first real dispatch reuses them.
 *
 * Takes authMode because only models this run actually dispatches to matter:
 * under `estimated` the orchestrator runs its own tier in-session and never
 * constructs `builtin-anthropic`, so an unset ANTHROPIC_API_KEY is inert.
 * Classification lives in preflight.ts.
 */
function preflightDispatch(policy: Policy, authMode: AuthMode, projectRoot?: string, executor?: boolean) {
  const overrides = selectOverrides();
  // Losing options of `select:` slots are excluded: their prerequisites
  // (Python venv, worker script) are not this run's problem.
  const notSelected = unreachableModelIds(policy, overrides);
  // Every reachable model is also priced for today: a model with no price
  // halts the run here, before anything is spent, and a policy pricing block
  // that differs from the price list is reported under price_warnings. A
  // Claude model whose vendor-mode key is unset fails here too, as a model
  // that cannot be dispatched.
  const today = new Date();
  // The Claude models the run's typists type with (the lean Opus typist, the last attempt included), when the typists
  // type this run's files: the claude CLI must run them, and under estimated their API adapter goes unused while the
  // models themselves type (assessModels says so in their note).
  const claudeTypists = executor === false ? [] : executorClaudeLeaves(policy, overrides).map((m) => m.id);
  const assessment = assessModels(
    policy.models.filter((m) => !notSelected.has(m.id)),
    authMode,
    (modelId) => {
      const keyProblem = claudeKeyProblem(getModel(policy, modelId), authMode, process.env);
      if (keyProblem) throw new Error(keyProblem);
      return adapterFor(policy, modelId);
    },
    (m) => checkModelPrice(getModel(policy, m.id), today, authMode),
    claudeTypists,
  );
  for (const message of assessment.price_warnings) {
    log("warn", "pricing.policy_mismatch", { message });
  }

  // The typists' own checks (a new-app build's units, a brownfield run's packets): every Claude model they type
  // with, the lean Opus last attempt included, runs through this machine's claude CLI, so the CLI must offer the flags
  // that route needs. How the policy is read for typed files is shown now, before any paid phase: the executor and a
  // brownfield run's packets read it the same way (executorView).
  const cli = executorCliCheck({
    executor,
    claudeTypists,
    cliProblem: () => leanOpusCliProblem(),
  });
  if (cli.halt || cli.warning) log("warn", "preflight.claude_cli", { problem: cli.check.claude_cli, halts: !!cli.halt });
  const policyNotes = executorPolicyNotes(policy, overrides);
  const haltReason = [assessment.halt_reason, cli.halt].filter((r): r is string => !!r).join(" ") || null;
  const warnings = cli.warning ? [...assessment.warnings, cli.warning] : assessment.warnings;

  // Resolved Gemini configuration — the project and region the run will bill.
  const adcPath = defaultAdcPath();
  const adcFileExists = existsSync(adcPath);
  let gemini: Record<string, unknown>;
  try {
    const keyEnvName =
      policy.models.find(
        (m) => m.adapter === "mcp:model-dispatch" || m.adapter === "mcp:gemini-flash-server"
      )?.auth?.env ?? "GEMINI_API_KEY";
    const choice = selectGeminiBackend({ env: process.env, keyEnvName, adcFileExists });
    gemini = {
      backend: choice.backend,
      reason: choice.reason,
      adc_file: adcFileExists ? adcPath : null,
      ...(choice.backend === "vertex-adc"
        ? {
            project: resolveGcpProject(process.env, adcPath),
            location: resolveGcpLocation(process.env),
          }
        : {}),
    };
  } catch (err: any) {
    gemini = { backend: null, error: err?.message ?? String(err), adc_file: adcFileExists ? adcPath : null };
  }

  for (const m of assessment.models) {
    log("info", "preflight.model", {
      model_id: m.id,
      adapter: m.adapter,
      ok: m.ok,
      error_class: m.ok ? undefined : "PreflightFailed",
      classification: m.ok ? undefined : (m.severity ?? "warning"),
      price_basis: m.price_basis,
      unpriced: m.unpriced,
    });
  }
  for (const id of notSelected) {
    log("info", "preflight.model", { model_id: id, ok: true, classification: "not_selected" });
  }
  // The run card: the code and cache rules this run used, so compared runs can
  // be shown to have run the same way. A cache override is a warning, never a
  // halt: a user may set one on purpose; a tool comparing runs can refuse it.
  // Nothing about the card stops pre-flight.
  let card: ReturnType<typeof runCard> | { error: string };
  try {
    card = runCard({ pluginDir: PLUGIN_DIR, pluginVersion: pluginVersion(), env: process.env, projectRoot });
    for (const o of card.cache_overrides) {
      log("warn", "run.cache_override", { setting: o, note: "overrides the plugin's pinned prompt-cache lifetimes; this run's cache costs are not comparable with a run without it" });
    }
    for (const p of card.settings_problems) log("warn", "run.settings_unread", { problem: p });
  } catch (err: any) {
    card = { error: `the run card could not be made: ${err?.message ?? String(err)}` };
  }
  log("info", "run.card", card as unknown as Record<string, unknown>);
  log("info", "preflight.result", {
    ok: haltReason === null,
    halt_reason: haltReason,
    warnings_n: warnings.length,
    backend: (gemini as any).backend,
    project: (gemini as any).project,
    location: (gemini as any).location,
  });

  return {
    ok: haltReason === null,
    auth_mode: authMode,
    policy: { name: policy.name, version: policy.version },
    models: assessment.models,
    // Named so "you did not select it" stays distinguishable from
    // "pre-flight forgot about it".
    not_selected: [...notSelected],
    gemini,
    halt_reason: haltReason,
    // Failures on adapters this run will not use, and a claude CLI problem
    // when pre-flight was not told whether the typists type this run's files
    // — informational, never blocking.
    warnings,
    // Price notes that do not stop the run (a policy block that differs from
    // the price list; the list is billed).
    price_warnings: assessment.price_warnings,
    // How the run's typed files read this policy — execute_stage's units and a
    // brownfield run's packets alike (none of these stops a run) — and whether
    // this machine's claude CLI can run the executor's Claude typists.
    policy_notes: policyNotes,
    executor: cli.check,
    run_card: card,
  };
}

interface DispatchOnce {
  decision: ReturnType<typeof pickModel>;
  result: Awaited<ReturnType<ReturnType<typeof adapterFor>["execute"]>>;
  events: TelemetryEvent[];
}

/** What routing reads of a packet. */
const routeContext = (p: TaskPacket) => ({ phase: p.phase, task_type: p.task_type, module: p.module, retry_count: p.retry_count ?? 0, intent: p.intent });

interface DispatchOptions {
  /**
   * An apply-form packet: its budget is the routed model's own limit, it is typed by greenfield's typist for its leaf,
   * and its events are returned unwritten, since the apply loop judges each call's answer first and hands the events
   * to its record hook (runPacket writes them there).
   */
  forApply?: boolean;
  /** The model for this attempt instead of the policy's route (the apply loop's cut-off and last attempt). */
  force?: { modelId: string; reason: string; ruleIndex: number; selection?: any };
  /** The run the call belongs to (runFor): how it is billed, for the typist. */
  run?: ServerRun;
}

/** Route one packet, run it, log it; append its telemetry unless the apply loop records it (forApply). */
async function dispatchOnce(packet: TaskPacket, policy: Policy, a: any, opts: DispatchOptions = {}): Promise<DispatchOnce> {
  const { forApply = false, force, run = runState } = opts;
  const decision = force ?? pickModel(routeContext(packet), policy, selectOverrides());
  log("info", "route.decide", {
    packet_id: packet.id,
    phase: packet.phase,
    intent: packet.intent,
    task_type: packet.task_type,
    module: packet.module,
    rule_index: decision.ruleIndex,
    rule_reason: decision.reason,
    model_id: decision.modelId,
    select_slot: decision.selection?.slot,
    select_chosen: decision.selection?.chosen,
    select_overridden: decision.selection?.overridden,
  });

  // A brownfield run's apply packet is typed by greenfield's own typist for its leaf (applyTypist.ts): the lean Opus
  // typist, Flash through the completion door, or the Antigravity agent — one machine for both flows and every policy.
  // runPacket admits an apply packet only with its job and its run's pre-flight (applyFormProblem), so it never falls
  // back to a policy adapter. Every other packet goes to its policy adapter, as before.
  const leafForDispatch = getModel(policy, decision.modelId);
  // An apply packet starts at the routed model's own output limit (apply.ts applyBudget): a cut-off is then a true one,
  // and goes to the next typist in the apply loop. (Greenfield's typists set their own limit the same way.)
  if (forApply) packet = applyBudget(packet, leafForDispatch);
  if (forApply && !usesServerTypist(leafForDispatch, packet, run)) {
    // Every adapter a policy may name has a typist (executor/tools.ts typistDoorFor); this is the line for one that does not.
    throw new Error(`${packet.id}: '${decision.modelId}' (${leafForDispatch.adapter}) has no typist, so it cannot type a brownfield run's file. Nothing was typed.`);
  }
  const adapter = forApply ? typistApplyAdapter(leafForDispatch, run!.authMode) : adapterFor(policy, decision.modelId);
  const dispatchStarted = Date.now();
  log("info", "dispatch.start", {
    packet_id: packet.id,
    model_id: decision.modelId,
    max_out: packet.budget?.maxOutputTokens,
    max_in: packet.budget?.maxInputTokens,
    cache_context: a.cache_context,
    work_dir: a.work_dir ?? a.project_root,
  });
  // Passed on every dispatch; completion adapters ignore it.
  const result = await adapter.execute(packet, a.cache_context, {
    project_root: a.project_root,
    work_dir: a.work_dir ?? a.project_root,
    telemetry_path: a.telemetry_path,
  });
  for (const att of result.attempts ?? []) {
    log("debug", "dispatch.attempt", {
      packet_id: packet.id,
      attempt_number: att.attempt_number,
      ceiling_used: att.ceiling_used,
      hit_output_cap: att.hit_output_cap,
      stop_reason: att.stop_reason,
    });
  }
  if (result.success) {
    log("info", "dispatch.end", {
      packet_id: packet.id,
      model_id: decision.modelId,
      ok: true,
      terminal_reason: result.terminal_reason,
      tokens_in: result.tokens.input,
      tokens_out: result.tokens.output,
      tokens_cached: result.tokens.input_cached,
      cost_usd: result.cost_usd,
      latency_ms: Date.now() - dispatchStarted,
      attempts: result.attempts?.length ?? 1,
      price_basis: result.attempts?.[result.attempts.length - 1]?.price_basis,
    });
  } else {
    log("error", "dispatch.error", {
      packet_id: packet.id,
      model_id: decision.modelId,
      error_class: "DispatchFailed",
      message: result.error,
    });
  }

  // One TelemetryEvent per attempt, all sharing the packet's task_id.
  const attempts = result.attempts ?? [
    {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      hit_output_cap: false,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      success: result.success,
      error: result.error,
    },
  ];
  const modelName = getModel(policy, decision.modelId).model_name;
  const baseEvent = {
    ts: new Date().toISOString(),
    pass: packet.pass_id,
    phase: packet.phase,
    task_type: packet.task_type,
    task_id: packet.id,
    module: packet.module,
    model: modelName,
    routed_by: "orchestrator" as const,
    // Server-measured from the vendor's own usage report, so always
    // "vendor" — in BOTH auth modes (estimated mode's MCP-dispatched
    // calls still carry vendor tokens; only direct-tier events are
    // estimates, and those arrive via log_telemetry, not here). The
    // report keys the run's cost label off this field; before this
    // stamp existed every dispatched event fell to "unknown" and the
    // whole run's numbers were disowned.
    provenance: "vendor" as const,
    // Leaf id; the only field that distinguishes two leaves that share
    // a vendor model name (e.g. flash-completion vs flash-agsdk-worker).
    model_id: decision.modelId,
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: decision.ruleIndex,
      rule_reason: decision.reason,
      // Undefined unless the rule went through a slot; JSON.stringify
      // drops undefined keys, so unslotted policies produce identical
      // events to before slots existed.
      select: decision.selection,
    },
    retry_count: packet.retry_count ?? 0,
    // A lean typist call names its door, as greenfield's typist events do: it runs `claude -p` with no session file,
    // so the run's true total keeps its dollars (collect-orchestrator-usage.mjs inSessionDispatched never subtracts an
    // event with a door). Every other dispatch writes the event as before.
    ...(adapter instanceof TypistApplyAdapter ? { door: adapter.door } : {}),
  };
  const events: TelemetryEvent[] = attempts.map((att) => ({
    ...baseEvent,
    input_tokens: att.tokens.input,
    input_tokens_cached: att.tokens.input_cached,
    // Cache writes, disjoint from input_tokens: the total written, plus
    // the 1-hour share when the adapter knows it (claude-cli). Anthropic
    // adapters populate it; Gemini leaves both undefined and
    // JSON.stringify drops the keys, keeping those events unchanged.
    ...cacheWriteBuckets(att.tokens),
    output_tokens: att.tokens.output,
    // Already counted in output_tokens and billed at the output rate;
    // surfaced only so a reader can see how much of a delegation's
    // output was thinking. Undefined on adapters that don't report it.
    output_tokens_reasoning: att.tokens.output_reasoning,
    cost_usd: att.cost_usd,
    latency_ms: att.latency_ms,
    success: att.success,
    attempt_number: att.attempt_number,
    ceiling_used: att.ceiling_used,
    // Why this attempt follows another. A typist's attempt says so itself (applyTypist.ts typistResult: "transport" for
    // a busy vendor's reply that was waited out, else the apply loop's reason, as greenfield tags its events); an
    // adapter's own later attempts are its output-cap doublings.
    retry_reason: att.retry_reason ?? (att.attempt_number > 1 ? "output_cap" : undefined),
    error: att.error,
    // Where the dollars' rates came from ("list" or "custom" under
    // pricing_override), which billed models had no price, and, for a
    // claude-cli worker, Claude Code's own figure and how the cache
    // TTL split was known. Undefined fields are dropped from the line.
    price_basis: att.price_basis,
    unpriced_models: att.unpriced_models?.length ? att.unpriced_models : undefined,
    cli_reported_cost_usd: att.cli_reported_cost_usd,
    ttl_split: att.ttl_split,
    // claude-cli only: the dollars for the tokens the worker's own
    // transcript explains. collect-orchestrator-usage.mjs subtracts only
    // this share of an in-session worker, so its receipt-only side calls
    // and unlogged tokens stay in the true total (review finding M4).
    transcript_logged_cost_usd: att.transcript_logged_cost_usd,
  }));
  if (a.telemetry_path && !forApply) {
    for (const ev of events) appendEvent(a.telemetry_path, ev);
    log("debug", "telemetry.append", { telemetry_path: a.telemetry_path, events_written: events.length });
  }
  return { decision, result, events };
}

/**
 * The run a brownfield call belongs to and the policy it is typed under. When pre-flight recorded the call's run_id,
 * that record decides (the run state is the source of truth, as execute_stage's): a call that leaves the policy out is
 * typed under it, and a call that names another policy is refused before anything is typed, since pre-flight's price,
 * CLI and typist checks covered only that one. A call with no recorded run reads its own arguments, as before.
 */
function runFor(a: any): { policy: Policy; run: ServerRun | undefined } {
  const bound = typeof a?.run_id === "string" && a.run_id ? runStates.get(runKey(a.project_root, a.run_id)) : undefined;
  if (!bound) return { policy: ensurePolicy(a?.policy_name, a?.project_root, a?.policy_path), run: runState };
  const policy = ensurePolicy(bound.policyName, bound.projectRoot ?? a.project_root, bound.policyPath);
  const given = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const name = given(a.policy_name), path = given(a.policy_path);
  const otherPath = path !== undefined && (bound.policyPath === undefined || resolvePath(path) !== resolvePath(bound.policyPath));
  const otherName = name !== undefined && name !== (bound.policyName ?? policy.name);
  if (otherPath || otherName) {
    throw new Error(
      `run ${a.run_id}: its pre-flight recorded policy ${bound.policyName ?? bound.policyPath ?? policy.name}, and this call names ` +
        `${name ?? path}. A run is typed under the policy its pre-flight checked, so nothing was typed.`,
    );
  }
  return { policy, run: bound };
}

/**
 * Why an apply packet cannot be typed, or null. The apply form types a brownfield run's packet with greenfield's
 * typists (applyTypist.ts) on every door: the packet names the run's job (`intent`), by which the policy's job-scoped
 * rules route it, and the run's pre-flight recorded how the run is billed and tested the typists that type it. Any
 * other packet would fall back to another way of typing (a policy adapter billed apart from the run's auth mode, a door
 * without greenfield's lean Opus last attempt, an agent editing the project folder itself), so it is refused before
 * any call.
 */
function applyFormProblem(packet: TaskPacket, run: ServerRun | undefined): string | null {
  const why: string[] = [];
  const intent = (packet as any).intent;
  if (!BROWNFIELD_INTENTS.has(String(intent ?? ""))) {
    why.push(`an apply packet names its job (intent: one of ${[...BROWNFIELD_INTENTS].join(", ")})${typeof intent === "string" && intent ? `, and '${intent}' is not one` : ""}`);
  }
  if (!run) why.push("call preflight_dispatch for this run first: it records how the run is billed and tests the typists that type it");
  return why.length ? `${packet.id}: ${why.join("; ")}. Nothing was typed.` : null;
}

/**
 * Whether the run's applied record (batch.ts) names `p` as it is planned now: its id, file and fingerprint (read the way
 * runPacket reads it). The batch asks this to tell that a tooling step ran: the orchestrator sends a step's dependents
 * only after the step (batch.ts stillToRun).
 */
function appliedInRun(p: TaskPacket, a: any): boolean {
  const projectRoot: string | undefined = a.project_root ?? resolveProjectRoot(undefined);
  if (!projectRoot) return false;
  const recs = readAppliedRecords(projectRoot, a.run_id).filter((r) => r.packet_id === p.id && r.path === p.artifact_path);
  if (!recs.length) return false;
  try {
    const fingerprint = packetFingerprint(p, { runId: a.run_id, read: hydrateInputs(p, projectRoot).packet });
    return recs.some((r) => r.fingerprint === fingerprint);
  } catch {
    return false;
  }
}

/**
 * One packet, start to receipt: validate, hydrate, route, dispatch — and under
 * `apply`, write / verify / retry (runApplyLoop). Shared by execute_with_model
 * and execute_batch so a batched packet behaves exactly like a single one.
 */
async function runPacket(raw: unknown, a: any, signal?: AbortSignal): Promise<unknown> {
  const packet0 = validateTaskPacket(raw);
  const { policy: asWritten, run } = runFor(a);
  const apply = normalizeApply(packet0.apply);
  const projectRoot: string | undefined = a.project_root ?? resolveProjectRoot(undefined);
  // A brownfield run's apply packets are routed the way greenfield's executor and the run-start probe read the policy
  // (executorView): a rule narrowed by task_type is read by its stage alone, since these packets carry none, so a
  // policy sends a file to the same model in both flows and the probe tests exactly the models the run types with.
  // Every other packet is routed by the policy as written, as before.
  const policy = apply ? executorView(asWritten).policy : asWritten;

  // Content-less slices are read from disk for brownfield packets only (apply.ts readsSlicesFromDisk).
  const needsDisk = readsSlicesFromDisk(packet0, apply, projectRoot);
  if (needsDisk && !projectRoot) {
    throw new Error(
      "execute_with_model: project_root is required when a packet uses apply or an inputs[] slice without content.",
    );
  }
  let packet: TaskPacket = packet0;
  let hydrated: string[] = [];
  if (needsDisk) {
    ({ packet, hydrated } = hydrateInputs(packet0, projectRoot!));
    if (hydrated.length) log("info", "packet.hydrate", { packet_id: packet.id, files: hydrated.join(",") });
  }
  // The apply form is the brownfield packet flow's writer. Greenfield writes through the executor,
  // and a greenfield project has no write contract, so apply is refused there.
  if (apply && !hasActiveWriteContract(projectRoot!)) {
    throw new Error(
      `${packet0.id}: the apply form writes only inside a brownfield run, after Gate 0 activates ` +
        ".sdlc/local/write-contract.json; no active write contract under project_root.",
    );
  }
  // Only a brownfield run's packet, after its run's pre-flight, is typed (applyFormProblem): nothing falls back.
  const problem = apply ? applyFormProblem(packet0, run) : null;
  if (problem) throw new Error(problem);
  // A packet this run already applied, whose file is still as it (or a later packet of the run on that file) left it,
  // has nothing left to do: no typist call, $0 (batch.ts alreadyApplied). A re-sent batch then types only what did not
  // apply. The packet is judged as planned (packet0), with its briefs as read (batch.ts packetFingerprint).
  const fingerprint = apply ? packetFingerprint(packet0, { runId: a.run_id, read: packet }) : "";
  if (apply) {
    const rec = alreadyApplied(projectRoot!, a.run_id, packet, fingerprint);
    if (rec) {
      log("info", "apply.already_applied", { packet_id: packet.id, path: rec.path, applied_at: rec.ts });
      return {
        status: "already_applied",
        apply: { path: rec.path, sha256: rec.sha256 },
        attempts: [],
        tokens: { input: 0, input_cached: 0, output: 0 },
        cost_usd: 0,
        events_written: 0,
        applied_at: rec.ts,
        ...(rec.set_aside?.length ? { set_aside: rec.set_aside } : {}),
      };
    }
  }
  if (apply && !packet.outputSchema) {
    // Greenfield's answer contracts: exact edits (or the whole file) for an edit, the whole file for a new one.
    packet = { ...packet, outputSchema: apply.mode === "edits" ? EDIT_ANSWER_SCHEMA : FILE_OUTPUT_SCHEMA };
  }

  if (!apply) {
    // Outside the apply form an agent-door worker edits the project folder itself: while a brownfield run's write
    // contract is active nothing may write the project outside it and its snapshots, so such a packet is not sent.
    if (projectRoot && hasActiveWriteContract(projectRoot)) {
      const d = pickModel(routeContext(packet), policy, selectOverrides());
      if (getModel(policy, d.modelId).adapter === "antigravity-worker") {
        throw new Error(
          `${packet0.id}: routed to '${d.modelId}' (antigravity-worker), an agent that edits the project folder itself. While a brownfield run's ` +
            "write contract is active, nothing writes the project outside it and its per-file snapshots, so nothing was dispatched.",
        );
      }
    }
    const one = await dispatchOnce(packet, policy, a, { run });
    return { decision: one.decision, result: one.result, events: one.events, terminal_reason: one.result.terminal_reason };
  }

  // Each call's events are written as soon as the loop has judged it (its record hook), as greenfield's stage runner
  // writes each attempt's event when it is judged (executor/run.ts deps.emit): a busy vendor's reply at once, an answer
  // once it is written and its file's checks have run (success only when they pass). A server stopped partway through a
  // packet's ladder has then already written every call it made. Without a telemetry file the events ride in the
  // receipt (keepEvents).
  const outcome = await runApplyLoop({
    packet,
    apply,
    projectRoot: projectRoot!,
    runId: a.run_id,
    keepEvents: !a.telemetry_path,
    record: (evs) => {
      if (!a.telemetry_path) return;
      for (const ev of evs) appendEvent(a.telemetry_path, ev);
      log("debug", "telemetry.append", { telemetry_path: a.telemetry_path, events_written: evs.length });
    },
    route: (p) => pickModel(routeContext(p), policy, selectOverrides()),
    dispatch: async (p, force) => {
      const one = await dispatchOnce(p, policy, a, { forApply: true, force, run });
      return { decision: one.decision, result: one.result, events: one.events };
    },
    // A retry routed to a Claude leaf of a brownfield run is typed here by the lean typist (applyTypist.ts), so it
    // stays in the loop: greenfield's ladder ends in one lean Opus attempt inside the server.
    typesInServer: (d) => usesServerTypist(getModel(policy, d.modelId), packet, run),
    // The ladder's last attempt is greenfield's last-attempt model (executor/tools.ts fallbackLeaf: the policy's
    // default leaf when it is a Claude model, else its first Claude leaf the run can reach) when the server can type
    // with it: a brownfield run's packets only (usesServerTypist).
    lastAttempt: () => {
      const leaf = fallbackLeaf(policy, selectOverrides());
      return leaf && usesServerTypist(leaf, packet, run) ? { modelId: leaf.id, reason: "the ladder's last attempt", ruleIndex: -1 } : null;
    },
    log: (level, event, fields) => log(level, event, fields),
    signal,
  });
  if (outcome.status === "applied" && packet.artifact_path) {
    const sha256 = fileSha256(projectRoot!, packet.artifact_path);
    if (sha256) {
      appendAppliedRecord(projectRoot!, a.run_id, {
        packet_id: packet.id, fingerprint, path: packet.artifact_path, sha256,
        ...(outcome.set_aside?.length ? { set_aside: outcome.set_aside } : {}),
        ts: new Date().toISOString(),
      });
    }
  }
  return outcome;
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  // listChanged: the hand-off tools can be added while the server runs (handoff/listing.ts).
  { capabilities: { tools: { listChanged: true } } }
);

// Zero-touch's four hand-off tools are listed only where a Hand-off chat can use them (handoff/listing.ts says
// exactly when; when in doubt they are listed). When they are left out only because of zero-touch's saved settings
// (not Hand-off, or Hand-off with every kind of work kept in the chat, which lists the undo alone), that settings file
// is watched: once it hands work off the tools are added and Claude Code is told, so a first chat or a cleared one
// that becomes a Hand-off chat has them. They are never taken away while the server runs.
let handoffListed = handoffListing(process.env);
log("info", "handoff.listing", { listed: handoffListed.list, only: handoffListed.only, reason: handoffListed.reason });
/** The hand-off tools listed now: all four, only the undo (every kind kept in the chat), or none. */
const handoffToolsNow = () => (!handoffListed.list ? [] : handoffListed.only ? HANDOFF_TOOLS.filter((t) => handoffListed.only!.includes(t.name)) : HANDOFF_TOOLS);
if ((!handoffListed.list || handoffListed.only) && handoffListed.watch.length) {
  const watched = handoffListed.watch;
  // Tools are only ever added: none → the undo alone → all four (every kind kept, then one handed off).
  const recheck = () => {
    if (handoffListed.list && !handoffListed.only) return;
    const now = handoffListing(process.env);
    if (!now.list || (handoffListed.list && now.only)) return;
    handoffListed = now;
    if (!now.only) for (const file of watched) unwatchFile(file);
    log("info", "handoff.listing", { listed: true, only: now.only, reason: now.reason, changed: true });
    server.sendToolListChanged().catch(() => { /* the client is gone */ });
  };
  // Polled, not event-based: the file is replaced by a rename when saved, which some watchers miss. Never keeps the
  // server alive by itself.
  for (const file of watched) watchFile(file, { interval: 2000, persistent: false }, recheck);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_with_model",
      description:
        "Execute a TaskPacket. Routes to the model chosen by the policy. " +
        "Returns structured result + tokens + cost_usd + latency.",
      inputSchema: {
        type: "object",
        properties: {
          // The definition every orchestrator sees, greenfield's included, is develop's. A brownfield run's packets also
          // carry `apply` and pass `run_id` beside them (the input is not closed to other fields); the brownfield run's
          // own instructions and execute_batch's definition describe both.
          packet: { type: "object", description: "TaskPacket (see types.ts)" },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          work_dir: {
            type: "string",
            description:
              "Directory a delegated agent worker may read, edit and run commands in — " +
              "normally the run's code_dir. Ignored by models that are called as models; " +
              "required by policy leaves that delegate to an agent (adapter: " +
              "antigravity-worker), which have no way to act without one. Defaults to " +
              "project_root.",
          },
          cache_context: { type: "string", description: "Key for explicit context cache (e.g. 'pass2:workforce-ops')" },
          telemetry_path: { type: "string", description: "JSONL file to append telemetry to" },
          log_level: {
            type: "string",
            enum: ["error", "warn", "info", "debug", "trace"],
            description: "Per-call MMO: log verbosity override — the only way a --verbose on one run reaches a server process that started when the session did.",
          },
          verbose: { type: "boolean", description: "Shorthand for log_level: debug." },
        },
        required: ["packet"],
      },
    },
    {
      name: "execute_batch",
      description:
        "Execute several apply-form TaskPackets in one call: the server runs them in parallel (4 at a time) " +
        "in depends_on order, never two on the same artifact_path at once, and returns one receipt per packet plus " +
        "totals. Same routing, apply, verify and telemetry as execute_with_model; one orchestrator turn for the phase " +
        "instead of one per packet.",
      inputSchema: {
        type: "object",
        properties: {
          packets: { type: "array", items: { type: "object" }, description: "TaskPackets, each with an apply block (plan-to-packets output) and the run's job (`intent`), after the run's preflight_dispatch; a batch with a packet that lacks either types nothing. Omit when packets_path is given. `apply: { write: true, mode?: 'content'|'edits', checks?: [{id, run: 'cmd {path}', fix?: 'cmd --write {path}'}], baseline_from?, max_retries? }` (or `verify` and `format` command lists) makes the server write the returned content to artifact_path (write contract + provenance), run each check's fix then its run, retry with the failure appended, and return a receipt instead of the file. A check the file already fails before the change is set aside for it (the receipt's set_aside). Status 'escalate' when the policy routes the next attempt to a model the server cannot type with. An inputs[] slice without `content` is read from disk under project_root (narrow it with `lines: [from, to]` or `section: '<heading>'`)." },
          packets_path: { type: "string", description: "Path to packets.json (plan-to-packets output); the server reads it so the packets never pass through the caller's context. Packets without an apply block (tooling) are skipped and listed in the receipt (skipped_no_apply). A tooling step that has not run blocks the packets that depend on it: one the call skips, or one it leaves out (packet_ids) that waits for a packet of the call; tooling_steps lists each such step with its instruction, for you to run before sending what waits for it. A step a dependent of which this run already applied has run, and blocks nothing. A packet this run already applied whose file is unchanged since settles already_applied, with no model call. The packets' end-of-run checks are in the receipt's verify_deferred." },
          packet_ids: { type: "array", items: { type: "string" }, description: "With packets_path: run only these ids." },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          run_id: { type: "string", description: "The run's id: provenance, the full receipt and the record of applied packets go under .sdlc/runs/<run_id>/. Once preflight_dispatch recorded this run id, the batch is typed under the policy recorded there, and a call naming another policy is refused." },
          cache_context: { type: "string" },
          telemetry_path: { type: "string" },
          log_level: { type: "string", enum: ["error", "warn", "info", "debug", "trace"] },
        },
        required: [],
      },
    },
    {
      name: "simulate_policy",
      description:
        "What-if: given a list of telemetry events from a real run, recompute total cost under a different policy. No LLM calls.",
      inputSchema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            description:
              "Telemetry events exactly as telemetry.jsonl stores them. input_tokens is the " +
              "FRESH count (cache reads and writes are not inside it); input_tokens_cached " +
              "and input_tokens_cache_write (the TOTAL written) are disjoint from it; " +
              "input_tokens_cache_write_1h is the 1-hour SHARE of input_tokens_cache_write. " +
              "Pass them as-is. Each event is priced at the model's effective price on the day " +
              "in its `ts` (the dated price list, or the policy block under pricing_override); " +
              "events the list cannot price are left out of the total and listed under `unpriced`. " +
              "A Gemini event adds the +10% Vertex regional surcharge at the endpoint this server " +
              "would dispatch it to (a worker leaf's region:, else GOOGLE_CLOUD_LOCATION; none " +
              "through an AI Studio key or at global), as the adapters bill it.",
          },
          policy_name: { type: "string" },
          project_root: {
            type: "string",
            description:
              "Project root, so a repo-local routing-policy.yaml resolves here exactly as it " +
              "does for the run being simulated. Omitting it silently falls back to the " +
              "shipped preset — a what-if against the wrong policy.",
          },
          policy_path: { type: "string" },
        },
        required: ["events"],
      },
    },
    {
      name: "log_telemetry",
      description: "Append a telemetry event to the pass JSONL log.",
      inputSchema: {
        type: "object",
        properties: { telemetry_path: { type: "string" }, event: { type: "object" } },
        required: ["telemetry_path", "event"],
      },
    },
    {
      name: "preflight_dispatch",
      description:
        "Prove every model this run will dispatch to can be reached, BEFORE the run spends " +
        "anything. Constructs each adapter (where credential discovery happens and fails) and " +
        "reports the resolved Gemini backend, project and region. Makes no API call and costs " +
        "nothing, unless probe_typists is true: then it also sends one minimal call through every " +
        "typist the run types with (cents at most), so a login that exists but cannot be used stops " +
        "the run here. Call this once at the start of every run and halt on ok:false — otherwise a " +
        "credential problem only surfaces at the first mechanical packet, after the premium " +
        "phases are billed. Requires auth_mode: under 'vendor' every model is dispatched through " +
        "this server and so every adapter must work, while under 'estimated' the orchestrator's " +
        "own tier's API adapter is not used (its own work runs in-session, and the typists type " +
        "files with this computer's Claude login) — failures there are " +
        "reported in `warnings` and do not halt. Pass executor: true for every run whose files the typists " +
        "type (every new-app build and every brownfield run): pre-flight then also halts when this machine's " +
        "claude CLI cannot run the typists' Claude models (the lean Opus typist). The result's policy_notes " +
        "say how the run's typed files read the policy " +
        "(execute_stage's units and a brownfield run's packets alike). With run_id, the policy and " +
        "auth mode recorded here are that run's for its execute_with_model and execute_batch calls.",
      inputSchema: {
        type: "object",
        properties: {
          auth_mode: {
            type: "string",
            enum: ["vendor", "estimated"],
            description: "The run's auth mode. Decides which models are actually dispatched here.",
          },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          executor: {
            type: "boolean",
            description:
              "true when the typists type this run's files: every new-app build (execute_stage) and every brownfield run " +
              "(its packets); false only for a run whose files no typist types. Omitted, a claude CLI that cannot run the " +
              "typists' Claude models is reported under warnings instead of halting.",
          },
          log_level: {
            type: "string",
            enum: ["error", "warn", "info", "debug", "trace"],
            description: "Per-call MMO: log verbosity override.",
          },
          verbose: { type: "boolean", description: "Shorthand for log_level: debug." },
          probe_typists: {
            type: "boolean",
            description:
              "true: after the free checks pass, send one minimal call through every typist this run types with (the " +
              "routed attempts of codegen, tests, docs and debug, and the lean Opus last attempt), the same door, login " +
              "and model as the run's own calls. A call refused (401/403) or with no reply at all stops the run (ok:false, " +
              "with what to fix); a busy vendor passes with a warning. Each call's cost is in typist_probe and, with " +
              "telemetry_path, in the run's telemetry.",
          },
          telemetry_path: { type: "string", description: "The run's telemetry.jsonl: the probe calls are written there (with probe_typists)." },
          run_id: { type: "string", description: "The run's id: its probe calls' telemetry events name it, and its execute_with_model and execute_batch calls are typed under the policy recorded here." },
          intent: { type: "string", description: "A brownfield run's job (docs, bugfix, feature-extend, feature-new, refactor, test, deps): its packets carry it, so with probe_typists the probe also covers the typists a policy rule scoped to that job routes to." },
        },
        required: ["auth_mode"],
      },
    },
    {
      name: "load_policy",
      description:
        "Return the policy that would be active for the given args, with each model's effective price for " +
        "today in models[].effective_price: the dated price list's rates, or the model's pricing block only " +
        "under pricing_override: true. Those are the rates this server bills every dispatch at, so under " +
        "auth_mode=estimated the orchestrator prices its own in-session estimates from effective_price.rates, " +
        "never from a pricing block's text.",
      inputSchema: {
        type: "object",
        properties: {
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
      },
    },
    ...EXECUTOR_TOOLS,
    // Zero-touch's four hand-off tools (handoff/tools.ts), the only tools zero-touch adds: its workflow routing
    // needs none. Listed only where a Hand-off chat can use them (above); a call is refused unless the plugin's hook
    // stamped it in a hand-off chat (test/toolList.test.mjs).
    ...handoffToolsNow(),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  const a0 = args as any;

  // Per-call override outranks every env var — the only way a --verbose on
  // one run reaches a server process that started when the session did.
  if (a0?.log_level) setLevel(a0.log_level as Level);
  else if (a0?.verbose) setLevel("debug");

  if (a0?.telemetry_path) configureSinks({ telemetryPath: a0.telemetry_path });
  else if (a0?.project_root) configureSinks({ projectRoot: a0.project_root });

  const toolStarted = Date.now();
  let toolCallErrorClass: string | undefined;
  log("debug", "tool.call.start", { tool: name, arg_keys: Object.keys(a0 ?? {}).join(",") });

  try {
    // The executor's tools get the run state pre-flight recorded (the auth mode,
    // and the policy loaded from pre-flight's own arguments), the run's slot
    // choices — the same ones execute_with_model honours, so the Gemini door is
    // the run's choice — and the request's progress channel (MCP progress
    // messages keep a long stage call alive).
    if (EXECUTOR_TOOL_NAMES.has(name as any)) {
      const token = (req.params as any)._meta?.progressToken;
      return await handleExecutorTool(name, a0, {
        run: () => runState,
        policy: (run) => ensurePolicy(run.policyName, run.projectRoot, run.policyPath),
        overrides: selectOverrides(),
        progress: { token, send: (params) => extra.sendNotification({ method: "notifications/progress", params } as any) },
      });
    }
    // Zero-touch's hand-off tools: the chat, its policy and its models come from the hook's stamp and the chat's own
    // records, never from pre-flight (a hand-off chat runs no workflow).
    if (HANDOFF_TOOL_NAMES.has(name)) {
      const token = (req.params as any)._meta?.progressToken;
      return await handleHandoffTool(name, a0, {
        overrides: selectOverrides(),
        progress: { token, send: (params) => extra.sendNotification({ method: "notifications/progress", params } as any) },
        // The request's own cancel signal: Claude Code cancels the call when the person presses
        // Stop, and a hand-off then ends without writing anything into the project.
        signal: extra.signal,
      });
    }
    switch (name) {
      case "execute_with_model": {
        const a = args as any;
        // An apply packet's checks and typist calls can run long: it sends progress as execute_batch does (a message
        // when it settles, a heartbeat between), so Claude Code does not cut the call off as idle. Any other packet is
        // one model call, as before.
        const token = (req.params as any)._meta?.progressToken;
        const progress = normalizeApply(a?.packet?.apply) !== null
          ? batchProgress({ token, send: (params) => extra.sendNotification({ method: "notifications/progress", params } as any) }, 1)
          : null;
        try {
          // The request's own cancel signal: a call the person stops writes nothing more (apply.ts runApplyLoop).
          const out = await runPacket(a.packet, a, extra.signal);
          progress?.settled({ id: String(a.packet?.id), status: String((out as any)?.status) }, 1);
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        } finally {
          await progress?.stop();
        }
      }
      case "execute_batch": {
        const a = args as any;
        const { list: rawPackets, skipped, tooling, plan } = batchPacketsFromArgs(a);
        // The inputs every packet carries are marked shared: the lean Opus typist sends them once, cached (batch.ts).
        const packets: TaskPacket[] = markSharedInputs(rawPackets.map((p: unknown) => validateTaskPacket(p)));
        for (const p of packets) {
          if (!normalizeApply(p.apply)) throw new Error(`execute_batch: packet ${p.id} has no apply block; a batch carries apply-form packets only (the receipt is what makes a batch cheap).`);
        }
        // The run's policy, once for the batch: a call that names another policy than the run's pre-flight recorded is
        // refused here, before any packet starts (runFor). Every packet is admitted here too (applyFormProblem), so a
        // batch with one packet that cannot be typed starts none.
        const { run: batchRun } = runFor(a);
        const refused = packets.map((p) => applyFormProblem(p, batchRun)).filter((r): r is string => r !== null);
        if (refused.length) throw new Error(`execute_batch: ${refused.join(" ")}`);
        // Packets typed at once: greenfield's stated bound for every stage and policy (executor/tools.ts
        // STAGE_CONCURRENCY), fixed by the server, not chosen per call. A rate-limited call waits, so it changes only
        // the wall time, never who types or what is billed.
        const maxParallel = STAGE_CONCURRENCY;
        // Progress as greenfield's execute_stage sends it: a message per settled packet and a heartbeat between.
        const token = (req.params as any)._meta?.progressToken;
        const progress = batchProgress({ token, send: (params) => extra.sendNotification({ method: "notifications/progress", params } as any) }, packets.length);
        let result;
        try {
          result = await runBatch({
            packets,
            // The plan's tooling steps this call skips, and the whole plan for those it leaves out: what waits for a step
            // that has not run is blocked by it, never typed before it runs. A step a dependent of which this run applied
            // has run (appliedInRun).
            tooling,
            plan,
            appliedBefore: (p) => appliedInRun(p, a),
            maxParallel,
            run: (p) => runPacket(p, a, extra.signal) as Promise<any>,
            signal: extra.signal,
            log: (level, event, fields) => log(level, event, fields),
            onSettled: (item, done) => progress.settled(item, done),
          });
        } finally {
          await progress.stop();
        }
        log("info", "batch.done", { packets: packets.length, status: result.status, counts: JSON.stringify(result.counts), cost_usd: result.cost_usd, duration_ms: result.duration_ms });
        // Every outcome whole, in the run's own folder, for the orchestrator to read one packet of with jq; the
        // receipt it reads each turn stays within its bound (batch.ts compactBatchReceipt).
        let fullReceipt: string | undefined;
        if (typeof a.run_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.run_id) && typeof a.project_root === "string") {
          const rel = `.sdlc/runs/${a.run_id}/batches/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
          try {
            mkdirSync(dirname(join(a.project_root, rel)), { recursive: true });
            writeFileSync(join(a.project_root, rel), JSON.stringify({ ...result, skipped_no_apply: skipped }, null, 2) + "\n");
            fullReceipt = rel;
          } catch { fullReceipt = undefined; }
        }
        return { content: [{ type: "text", text: JSON.stringify(compactBatchReceipt(result, skipped, { fullReceipt })) }] };
      }
      case "simulate_policy": {
        const a = args as any;
        // project_root flows through like every sibling tool's does
        // (execute_with_model, preflight_dispatch, load_policy) — this
        // handler used to hardcode `undefined` here, so a simulation for a
        // project with a repo-local routing-policy.yaml silently priced the
        // shipped preset instead of the policy the run actually used.
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        // Replay against the same slot choices the real run uses.
        const out = simulatePolicyCost(a.events, policy, selectOverrides());
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "log_telemetry": {
        const a = args as any;
        // Direct-tier caller is a model with no clock — normalize overwrites
        // its `ts` and nulls `latency_ms`.
        appendEvent(a.telemetry_path, normalizeDirectTierEvent(a.event as TelemetryEvent));
        log("debug", "telemetry.append", { telemetry_path: a.telemetry_path, events_written: 1 });
        return { content: [{ type: "text", text: "ok" }] };
      }
      case "preflight_dispatch": {
        const a = args as any;
        // Parse before the policy loads so a missing mode fails on the mode.
        const authMode = parseAuthMode(a.auth_mode);
        // Pre-flight opens a run: it records the auth mode and policy the run's
        // executor stages and brownfield packets will use. It never refuses a
        // new one: the lock that keeps one run on one policy is per run (the
        // executor's RUN_BINDINGS in executor/tools.ts; runFor for a brownfield
        // run's calls, by run_id), so a second, separate /mmo: run in the same
        // chat may use another policy or auth mode.
        const runId = typeof a.run_id === "string" && a.run_id ? a.run_id : undefined;
        // A brownfield run's job: its packets carry it, so a policy rule scoped to it routes them, and the probe covers it.
        const intent = typeof a.intent === "string" && a.intent ? a.intent : undefined;
        const next: ServerRun = { authMode, policyName: a.policy_name, projectRoot: a.project_root, policyPath: a.policy_path, ...(runId ? { runId } : {}), ...(intent ? { intent } : {}) };
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const executor = typeof a.executor === "boolean" ? a.executor : undefined;
        const out: any = preflightDispatch(policy, authMode, a.project_root, executor);
        // The run's typists, tested only when asked and only once the free checks pass: a call costs cents, and a run
        // the free checks already stop needs no call to know it (typistProbe.ts).
        if (a.probe_typists === true && out.ok) {
          const probes = await probeTypists(runTypingLeaves(policy, selectOverrides(), intent), authMode);
          out.typist_probe = probes;
          if (typeof a.telemetry_path === "string" && a.telemetry_path) {
            for (const ev of probeEvents(probes, { pass: String(a.run_id ?? ""), policy: { name: policy.name, version: policy.version } })) appendEvent(a.telemetry_path, ev);
          }
          for (const p of probes) log(p.ok ? "info" : "warn", "preflight.typist_probe", { model_id: p.model_id, door: p.door, ok: p.ok, busy: p.busy, reason: p.reason, cost_usd: p.cost_usd });
          const failed = probes.filter((p) => !p.ok);
          if (failed.length) {
            out.ok = false;
            out.halt_reason = [out.halt_reason, ...failed.map((p) => `The ${p.door} typist (${p.model_id}, ${p.model_name}) could not answer a one-line test call: ${p.reason}. ${p.fix ?? ""}`.trim())].filter(Boolean).join(" ");
          }
          for (const p of probes.filter((x) => x.busy)) out.warnings.push(`The ${p.door} typist (${p.model_id}) was busy at the test call (${p.reason}); the run waits a busy vendor out as usual.`);
        }
        runState = next;
        if (runId) runStates.set(runKey(a.project_root, runId), next);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "load_policy": {
        const a = args as any;
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        // v0.7.3 Q3: the policy as loaded, plus every model's effective price for
        // today. orchestrator.md rule 6 prices estimated events from this output,
        // so it must carry the price this server bills (the list, or a block only
        // under pricing_override), not only the policy file's pricing blocks, which
        // can differ from the list and are otherwise documentation. It is built by
        // the same effectivePrice that prices every dispatch and pre-flight.
        const view = withEffectivePrices(policy, new Date());
        return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    toolCallErrorClass = err?.name ?? "Error";
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  } finally {
    log("debug", "tool.call.end", {
      tool: name,
      duration_ms: Date.now() - toolStarted,
      ok: toolCallErrorClass === undefined,
      error_class: toolCallErrorClass,
    });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
