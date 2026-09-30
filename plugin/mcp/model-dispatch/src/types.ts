/**
 * Shared types for the multi-model orchestration layer.
 */

// Type-only (erased at build): the orchestrator event's Fix E fields reuse the
// manifest block's shapes, which live beside Manifest in telemetry.ts.
import type { OrchestratorModelCost, OrchestratorUnloggedBilled, OrchestratorUnpriced } from "./telemetry.js";

export type Phase =
  | "requirements_analysis"
  | "architecture_design"
  | "plan_task_packets"
  | "codegen"
  | "tests"
  | "docs"
  | "debug"
  | "senior_code_review"
  | "security_review"
  | "refactor"
  | "final_report"
  // Brownfield additions (v1). Discovery is scoped to Tier 1 repo read;
  // change_plan is the brownfield analog of architecture_design (delta doc
  // rather than full subsystem design). Both routed to premium tier by
  // default — see plugin/config/policies/*.yaml.
  | "discovery"
  | "change_plan"
  // Not a routed phase — the label the orchestrator-overhead collector
  // (plugin/scripts/collect-orchestrator-usage.mjs) stamps on its transcript
  // event. No policy rule ever matches it and no packet ever carries it; it
  // exists in this union only so the event type-checks. Readers must key on
  // `tier: "orchestrator"`, not on this phase name.
  | "orchestrator_overhead";

export interface FileSlice {
  path: string;
  content: string;
  reason: string;
}

export interface TaskPacket {
  id: string;
  phase: Phase;
  task_type: string;
  module: string;
  instruction: string;
  inputs: FileSlice[];
  outputSchema: Record<string, any>;
  acceptance: string[];
  budget: { maxInputTokens: number; maxOutputTokens: number };
  retry_count?: number;
  pass_id: string;
  /**
   * Brownfield only. The repo-relative path this packet will write to.
   * The MCP dispatcher validates this against `.sdlc/baseline/current.json`
   * allowlist before dispatching. Undefined = packet writes nothing
   * (analysis / review packet) or greenfield mode.
   */
  artifact_path?: string;
  /**
   * Brownfield only — the job type confirmed at Gate 0 (plugin/config/intents.json).
   * Undefined on greenfield packets. Lets a policy route the same phase
   * differently per intent (e.g. Tests routes differently for `refactor`
   * than for `docs`) via a rule matching on both `phase` and `intent`.
   */
  intent?: string;
}

export interface TelemetryEvent {
  ts: string;
  pass: string;
  phase: Phase;
  task_type: string;
  task_id: string;
  module: string;
  model: string;
  /**
   * Policy leaf that ran (e.g. `flash-completion`, `flash-agsdk-worker`).
   * Distinguishes two leaves that share a vendor `model` name. Optional
   * because events written before this field existed lack it.
   */
  model_id?: string;
  routed_by: "orchestrator" | "fallback" | "manual";
  /**
   * Executor events only (execute_stage): which typist typed the unit —
   * `lean-opus` (a `claude -p` with no tools), `flash-completion` (Gemini
   * through the completion door) or `agy` (Gemini through the Antigravity
   * SDK). Absent on every other event.
   */
  door?: "lean-opus" | "flash-completion" | "agy";
  /**
   * Where this event's numbers came from. `"vendor"` = measured by the
   * dispatch server from the vendor's own usage report (every
   * `execute_with_model` event, in both auth modes); `"estimated"` =
   * direct-tier char-count logged by the orchestrator via `log_telemetry`;
   * `"transcript"` = reconstructed post-run from session transcripts
   * (orchestrator-overhead collector). Optional because events written
   * before this field existed lack it — readers treat absence as
   * "unknown" and disown the run's label (tools/report.mjs).
   */
  provenance?: "vendor" | "estimated" | "transcript";
  /**
   * `"orchestrator"` marks the run's own overhead (the driver session's
   * reasoning, file reads, growing-conversation re-sends), reconstructed
   * post-run from transcripts by collect-orchestrator-usage.mjs. Absent on
   * every dispatched-work event. `buildManifest` and tools/report.mjs
   * partition on this field so overhead is never silently blended into
   * dispatched-work totals.
   */
  tier?: "orchestrator";
  routing: {
    policy_name: string;
    policy_version: number;
    rule_index: number;      // -1 = default
    rule_reason: string;
    /**
     * Present only when the matched rule named a slot. `overridden`
     * distinguishes an explicit run choice from an inherited default.
     */
    select?: { slot: string; chosen: string; overridden: boolean };
  };
  input_tokens: number;
  input_tokens_cached: number;
  /**
   * Prompt-cache-WRITE count, disjoint from `input_tokens` and
   * `input_tokens_cached`. Optional — events written while cache writes were
   * still folded into `input_tokens` lack it; readers treat absence as 0.
   */
  input_tokens_cache_write?: number;
  /**
   * The 1-hour-TTL SHARE of `input_tokens_cache_write` (which stays the total
   * written). The collector's `tier: "orchestrator"` event and claude-cli
   * worker events carry it; a reader prices `min(total, this)` at the 1-hour
   * rate and the rest at the 5-minute rate. Absent = every write is 5-minute.
   */
  input_tokens_cache_write_1h?: number;
  output_tokens: number;
  /** Thinking/reasoning tokens; already counted in output_tokens. */
  output_tokens_reasoning?: number;
  cost_usd: number;
  /** Copied from the attempt: `list` or `custom` (policy block under pricing_override). */
  price_basis?: PriceBasis;
  /** Copied from the attempt; `cost_usd` excludes these models' tokens. */
  unpriced_models?: UnpricedModel[];
  /** claude-cli only: Claude Code's own dollar figure, kept as a check. */
  cli_reported_cost_usd?: number;
  /** claude-cli only: where the cache-write TTL split came from. */
  ttl_split?: TtlSplit;
  /**
   * claude-cli only, copied from the attempt: the share of cost_usd for the
   * tokens the worker's own transcript explains. The collector subtracts only
   * this share of an in-session worker; absent on events written before it existed.
   */
  transcript_logged_cost_usd?: number;
  /*
   * Orchestrator event only (`tier: "orchestrator"`, written by
   * collect-orchestrator-usage.mjs): the Fix E fields of the manifest's
   * `orchestrator_overhead` block, with the same meanings (see Manifest in
   * telemetry.ts), so telemetry.jsonl alone says which model each dollar ran
   * on, what a booked receipt billed beyond the transcript, and whether every
   * helper's transcript was read. The collector wrote most of these from the
   * per-message and receipt fixes on while this interface did not declare
   * them; since v0.7.3 orchestratorOverheadFields.test.mjs type-checks its real
   * output against this interface so the two cannot drift again.
   */
  transcript_cost_usd?: number | null;
  receipt_cost_usd?: number | null;
  receipt_cli_usd?: number | null;
  /** The booked part at the price list: the whole receipt, or a resumed window's last invocation. receipt_cli_usd is checked against it; null unless a receipt was booked. */
  booked_cost_usd?: number | null;
  unlogged_billed?: OrchestratorUnloggedBilled | null;
  attribution_complete?: boolean | null;
  missing_helper_ids?: string[];
  unreferenced_helper_files?: string[];
  per_model?: OrchestratorModelCost[];
  unpriced?: OrchestratorUnpriced[];
  pricing_complete?: boolean;
  price_list_verified?: string;
  /** `null` on the direct tier — no stopwatch ever ran. `0` would mean "instant". */
  latency_ms: number | null;
  success: boolean;
  retry_count: number;
  /** Output-cap doubling attempts share a task_id. attempt_number is 1-indexed. */
  attempt_number?: number;
  ceiling_used?: number;
  retry_reason?: "output_cap" | "validation" | "escalation";
  artifact_path?: string;
  error?: string;
}

/** One attempt from the output-cap doubling loop. */
export interface AttemptRecord {
  attempt_number: number;
  ceiling_used: number;
  stop_reason?: string;
  hit_output_cap: boolean;
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number;
    /** Prompt-cache-write count, disjoint from `input`. Anthropic adapters only. */
    input_cache_write?: number;
    /** 1-hour-TTL prompt-cache-write count, disjoint from `input_cache_write` (5-minute). */
    input_cache_write_1h?: number;
  };
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error?: string;
  /**
   * A failed call's HTTP status, as the vendor's error object states it
   * (Google's ApiError.status). Callers classify failures from this field,
   * never from `error`'s wording.
   */
  error_status?: number;
  /** A call that failed in transit: its Node/undici error code (ECONNRESET, ETIMEDOUT, ...). */
  error_code?: string;
  /** The pause the vendor asked for (google.rpc.RetryInfo.retryDelay), in ms. */
  retry_after_ms?: number;
  /**
   * Where `cost_usd`'s rates came from: `list` (src/prices.ts) or `custom`
   * (the policy block under `pricing_override: true`; on a claude-cli attempt,
   * set when any model in it was custom-priced). Absent on an attempt refused
   * before dispatch.
   */
  price_basis?: PriceBasis;
  /**
   * Models whose tokens were billed but have no price (unknown model, no
   * period for the day, or a modifier value the list does not price).
   * `cost_usd` excludes them. Empty when everything was priced.
   */
  unpriced_models?: UnpricedModel[];
  /**
   * claude-cli only: Claude Code's own `total_cost_usd` for the call, kept as
   * a check. It comes from Claude Code's price table, which has been stale
   * (2026-08-24: Opus at 0.6x), so it is never the cost.
   */
  cli_reported_cost_usd?: number;
  /**
   * claude-cli only, when the worker's transcript was read: the dollars of
   * `cost_usd` for the tokens that transcript explains (each model's logged
   * tokens at that model's price). The rest of cost_usd is what the result
   * billed that no transcript line logged: receipt-only side calls (a Haiku
   * call) and unlogged tokens. collect-orchestrator-usage.mjs subtracts only
   * this share of a worker its scan swept in, because the scan counts only the
   * logged tokens; subtracting the whole cost took the unlogged dollars out of
   * the true total (review finding M4).
   */
  transcript_logged_cost_usd?: number;
  /**
   * claude-cli only: where the 5-minute / 1-hour cache-write split came from.
   * `transcript` = the worker session's own transcript explained every
   * written token; `approximate` = some model's writes were not all explained
   * by it: the one model whose four token counts equal the result's top-level
   * `usage` takes that usage's `cache_creation` split, and any other model's
   * unexplained writes are priced at the 5-minute rate (written into its
   * `per_model[].assumed`); `no_cache_writes` = nothing to split.
   */
  ttl_split?: TtlSplit;
  /** claude-cli only: the per-model ledger behind `cost_usd`. */
  per_model?: WorkerModelCost[];
}

export type PriceBasis = "list" | "custom";

export type TtlSplit = "transcript" | "approximate" | "no_cache_writes";

export interface UnpricedModel {
  /** The model name as the vendor reported it. */
  model: string;
  reason: string;
}

/** One model's share of a claude-cli worker call. */
export interface WorkerModelCost {
  /** The price-list id, or the reported name when it is not on the list. */
  model: string;
  /** Every name the result used for this model (e.g. `claude-opus-5[1m]`). */
  reported_as: string[];
  /** Disjoint buckets: `input_cache_write` is the 5-minute share, `input_cache_write_1h` the 1-hour share. */
  tokens: { input: number; input_cached: number; input_cache_write: number; input_cache_write_1h: number; output: number };
  /** null when unpriced. */
  price_basis: PriceBasis | null;
  /** null when unpriced. */
  cost_usd: number | null;
  /** The CLI's `modelUsage[*].costUSD` for these names, when it reported one. */
  cli_cost_usd: number | null;
  ttl_split: TtlSplit;
  unpriced_reason?: string;
  /**
   * What the price had to assume, in words: cache writes that no worker
   * transcript line explains are priced at the 5-minute rate, unless the
   * result's top-level `usage` proves this model's split. Absent when nothing
   * was assumed.
   */
  assumed?: string[];
  /** Web search requests the result bills for this model (`modelUsage[*].webSearchRequests`). Absent when none. */
  web_search_requests?: number;
  /**
   * Their fee at the list's per-search price, included in cost_usd. Null when
   * the list has no per-search price for the model (the searches are then in
   * `unpriced_models`). Absent when none.
   */
  web_search_cost_usd?: number | null;
}

export interface ModelPricing {
  input: number;          // USD per 1M tokens
  input_cached: number;   // USD per 1M cached tokens
  output: number;         // USD per 1M tokens
  /**
   * USD per 1M prompt-cache-WRITE tokens. Optional — policies written before
   * this rate existed omit it, and `computeCostUsd` falls back to
   * `input × CACHE_WRITE_PREMIUM` (1.25, Anthropic's 5-min-TTL premium).
   */
  input_cache_write?: number;
  /** Optional explicit 1-hour-TTL cache-write rate; defaults to input x 2.0. */
  input_cache_write_1h?: number;
}

/**
 * Optional reasoning/thinking controls. Vendors disagree on vocabulary
 * (Gemini uses `thinkingLevel`; OpenAI-compat uses `reasoning_effort`);
 * adapters consume the fields they understand and ignore the rest.
 */
export interface ReasoningConfig {
  tier?: "minimal" | "low" | "medium" | "high";
  effort?: "off" | "low" | "high" | "max";
  enabled?: boolean;
}

export interface ModelConfig {
  id: string;
  adapter: string;
  model_name: string;
  display_name?: string;
  /**
   * The policy's copy of the model's rates. Optional, and by default NOT what
   * a dispatch is billed at: every adapter prices from the dated price list
   * (src/prices.ts) via effectivePrice.ts, and a block that differs from the
   * list by more than 0.5% is ignored with a warning. Under
   * `pricing_override: true` it IS the price (labelled custom); otherwise it is
   * documentation. The orchestrator's `--auth=estimated` estimates no longer
   * read it (v0.7.3 Q3): load_policy returns each model's `effective_price`
   * (effectivePrice.ts withEffectivePrices), orchestrator.md rule 6 prices from
   * that, and so no model needs a block in either auth mode.
   */
  pricing?: ModelPricing;
  /**
   * Bill `pricing` instead of the price list, for this leaf's own model.
   * Telemetry labels the dollars `price_basis: "custom"`. Requires a block.
   */
  pricing_override?: boolean;
  pricing_source?: string;
  pricing_last_verified?: string;
  auth?: { env: string };
  endpoint?: string;
  reasoning?: ReasoningConfig;
  /** Vendor's absolute output-tokens limit; doubling loop clamps here. */
  max_output_tokens_absolute?: number;
  /**
   * Vertex region for this leaf. Unset → follows GOOGLE_CLOUD_LOCATION, else
   * `global`. Declared here because non-`global` triggers a +10% surcharge
   * on Gemini 3+, so cost is only reproducible if the region is recorded.
   */
  region?: string;
  /**
   * Deadline for an agent-worker delegation. Read only by adapters that spawn
   * a worker; ignored by completion adapters.
   */
  worker_timeout_sec?: number;
}

/**
 * Where the run is happening, distinct from what it is asking for. Completion
 * adapters ignore this; an agent worker needs a workspace and a place to
 * leave evidence.
 */
export interface RunContext {
  project_root?: string;
  /** Narrower than project_root when confining a worker to generated code. */
  work_dir?: string;
  /** Delegation evidence lands beside this path. */
  telemetry_path?: string;
}

export type RuleMatcher = {
  phase?: string | string[];
  task_type?: string | string[];
  module?: string | string[];
  /** Brownfield only (see plugin/config/intents.json). Undefined on greenfield packets. */
  intent?: string | string[];
  retry_count?: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number };
};

export type Rule =
  | { when: RuleMatcher; use: string; reason?: string }
  | { default: string; reason?: string };

/**
 * One logical slot a rule may name instead of a concrete leaf. `options`
 * enumerates the vetted answers so a typo fails at policy load rather than
 * as an unknown-model throw partway through a paid phase.
 */
export interface SelectSlot {
  /** Used when the run selects nothing. Must be one of `options`. */
  default: string;
  /** Every leaf this slot may resolve to. Non-empty; each is a real model id. */
  options: string[];
  reason?: string;
}

/** A run's answers to the policy's slots, keyed by slot name. */
export type SelectOverrides = Record<string, string>;

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
  /** Optional; absent from policies written before slots existed. */
  select?: Record<string, SelectSlot>;
}

export interface RoutingDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;   // -1 if default
  /** Present only when the matched rule named a slot. */
  selection?: { slot: string; chosen: string; overridden: boolean };
}

export interface ExecutionResult {
  result: any;
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number;
    /** Prompt-cache-write count, disjoint from `input`. Anthropic adapters only. */
    input_cache_write?: number;
    /** 1-hour-TTL prompt-cache-write count, disjoint from `input_cache_write` (5-minute). */
    input_cache_write_1h?: number;
  };
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
  success: boolean;
  error?: string;
  /** Populated on doubling loop; length ≥ 1. */
  attempts?: AttemptRecord[];
  /**
   * Why the doubling loop stopped. `_budget_exhausted` means "retries used but
   * model still had headroom" (raise the cap); `_at_model_absolute` means "hit
   * the vendor's ceiling" (packet too big).
   */
  terminal_reason?:
    | "success"
    | "output_cap_doubling_budget_exhausted"
    | "output_cap_at_model_absolute"
    | "vendor_error";
}
