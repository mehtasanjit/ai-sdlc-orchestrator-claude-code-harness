/**
 * Pre-flight reachability assessment for the models a policy names.
 *
 * Which models this server actually dispatches to depends on the run's auth
 * mode. Under `vendor` every call goes through this server, so every adapter
 * must work. Under `estimated` the orchestrator's own tier runs inside Claude
 * Code on the user's subscription — its adapter is never constructed, so
 * failures there are informational, not blocking.
 *
 * Split from server.ts because server.ts opens a stdio transport as a
 * top-level side effect and hangs a test runner on import. `makeAdapter` is
 * injected so the decision table is testable without any credentials.
 */

/**
 * Adapter the orchestrator runs in-session under `estimated` rather than
 * dispatching. Keyed by adapter name (a transport concept), not by tier.
 * `claude-cli` is Anthropic but NOT in-session — it always spawns a
 * subprocess, so its reachability must be checked under both auth modes.
 */
export const IN_SESSION_ADAPTER = "builtin-anthropic";

export type AuthMode = "vendor" | "estimated";

export interface PreflightModel {
  id: string;
  model_name: string;
  adapter: string;
}

export interface PreflightModelResult extends PreflightModel {
  /** Whether this run will actually dispatch to this model through this server. */
  required: boolean;
  /** Whether the adapter could be constructed. A price problem does not flip it; see `price_error`. */
  ok: boolean;
  error?: string;
  /** Present only on failures: "blocking" halts the run, "warning" does not. */
  severity?: "blocking" | "warning";
  /** Present when a price check ran and priced the model: `list` or `custom` (pricing_override). */
  price_basis?: "list" | "custom";
  /** True when the model has no price for today and no override. Always blocking. */
  unpriced?: boolean;
  /** Why this model's price blocks the run. */
  price_error?: string;
}

export interface PreflightAssessment {
  models: PreflightModelResult[];
  ok: boolean;
  halt_reason: string | null;
  /** Construction failures on models this run does not dispatch to. Never blocking. */
  warnings: string[];
  /**
   * Price notes that do not stop the run, such as a policy pricing block that
   * differs from the price list (the list is billed). Kept apart from
   * `warnings`, which only ever means "a model this run does not dispatch to".
   */
  price_warnings: string[];
}

/**
 * One model's price verdict for pre-flight, built by effectivePrice.ts
 * checkModelPrice. Declared here so this module needs no imports.
 */
export interface PriceCheck {
  /** False when the run must not start because of this model's price. */
  ok: boolean;
  basis?: "list" | "custom";
  /** True when no price exists for the model on the day. */
  unpriced?: boolean;
  /** Why `ok` is false. */
  reason?: string;
  /** Non-halting notes, such as a block that differs from the list. */
  warnings: string[];
}

/**
 * Validate the run's auth mode. Throws rather than defaulting: `vendor` as
 * default reinstates the false halt this module exists to remove, and
 * `estimated` as default waves through a vendor run that then dies at the
 * first dispatch. The error text matches orchestrator.md rule 6.
 */
export function parseAuthMode(value: unknown): AuthMode {
  if (value === "vendor" || value === "estimated") return value;
  throw new Error(
    "this run requires auth_mode=vendor|estimated. Pre-flight cannot tell which models " +
      "will be dispatched through this server without it: under 'vendor' every model is, " +
      "under 'estimated' the orchestrator's own tier runs in-session and its adapter is " +
      "never constructed.",
  );
}

/** Under `vendor`, yes for everything. Under `estimated`, only for non-in-session models. */
export function requiresServerDispatch(adapter: string, authMode: AuthMode): boolean {
  if (authMode === "vendor") return true;
  return adapter !== IN_SESSION_ADAPTER;
}

/**
 * Construct an adapter for every model and classify what fails. `makeAdapter`
 * is called for required and non-required models alike: warming the cache for
 * a non-required one is cheap and its failure is worth reporting.
 *
 * `checkPrice` (server.ts passes effectivePrice.ts checkModelPrice for today)
 * adds the price gate. A model with no price halts the run whether or not
 * this server dispatches it: dispatched work would be refused mid-run, and
 * in-session work is priced from the same list after the run, so either way
 * the run's cost would have a hole in it. Omitted (as in the reachability
 * tests), no price is checked.
 */
export function assessModels(
  models: PreflightModel[],
  authMode: AuthMode,
  makeAdapter: (modelId: string) => unknown,
  checkPrice?: (model: PreflightModel) => PriceCheck,
): PreflightAssessment {
  const priceWarnings: string[] = [];
  const results: PreflightModelResult[] = models.map((m) => {
    const required = requiresServerDispatch(m.adapter, authMode);
    let result: PreflightModelResult;
    try {
      makeAdapter(m.id);
      result = { id: m.id, model_name: m.model_name, adapter: m.adapter, required, ok: true };
    } catch (err: any) {
      result = {
        id: m.id,
        model_name: m.model_name,
        adapter: m.adapter,
        required,
        ok: false,
        error: err?.message ?? String(err),
        severity: required ? "blocking" : "warning",
      };
    }
    if (checkPrice) {
      const price = checkPrice(m);
      priceWarnings.push(...price.warnings);
      if (price.basis) result.price_basis = price.basis;
      if (!price.ok) {
        if (price.unpriced) result.unpriced = true;
        result.price_error = price.reason ?? "no price";
      }
    }
    return result;
  });

  const blocking = results.filter((m) => !m.ok && m.required);
  const nonBlocking = results.filter((m) => !m.ok && !m.required);
  const unpriced = results.filter((m) => m.unpriced);
  // A price error that is not "no price". checkModelPrice raises none since v0.7.3
  // Q3, which removed its estimated-mode pricing-block requirement (the
  // orchestrator's estimates read load_policy's effective price now); a price
  // check that gives any other reason still halts with that reason, rather than
  // letting it pass silently.
  const otherPriceErrors = results.filter((m) => m.price_error !== undefined && !m.unpriced);

  const reasons: string[] = [];
  if (blocking.length > 0) {
    reasons.push(
      `Cannot dispatch to ${blocking.length} of ${results.length} models in this policy: ` +
        blocking.map((f) => `${f.id} (${f.error})`).join("; ") +
        ". Do not start the run — every packet routed to these models would fall back to the " +
        "premium tier, producing a run that costs more than a single-model baseline. Fix " +
        "credentials first, then re-run this check.",
    );
  }
  if (unpriced.length > 0) {
    reasons.push(
      `Cannot price ${unpriced.length} of ${results.length} models in this policy: ` +
        unpriced.map((f) => `${f.id} (${f.model_name}: ${f.price_error})`).join("; ") +
        ". Do not start the run — work routed to a model with no price is refused at dispatch, and " +
        "tokens the session spends on it could not be priced, so the run's cost would have a hole in it.",
    );
  }
  for (const f of otherPriceErrors) {
    reasons.push(`Model '${f.id}' (${f.model_name}) ${f.price_error}.`);
  }
  const halt_reason = reasons.length === 0 ? null : reasons.join(" ");

  const warnings = nonBlocking.map(
    (f) =>
      `${f.id} could not be constructed (${f.error}), but this run does not dispatch to it: ` +
      `auth_mode=${authMode} runs '${f.adapter}' work inside the Claude Code session instead of ` +
      `through this server. Not a blocker. It would block a vendor-mode run of the same policy.`,
  );

  return { models: results, ok: reasons.length === 0, halt_reason, warnings, price_warnings: priceWarnings };
}

/**
 * Why a Claude model cannot be billed as the policy says under `vendor`, or
 * null. A vendor run bills the Anthropic API key the model's `auth.env`
 * names (ANTHROPIC_API_KEY for the in-session adapter when it names none);
 * with that variable unset its calls would go out on whatever login the
 * machine has, under a run labelled vendor. A claude-cli model that names no
 * key runs on the CLI's own login, as it always has.
 */
export function claudeKeyProblem(model: { id: string; adapter: string; auth?: { env: string } }, authMode: AuthMode, env: Record<string, string | undefined>): string | null {
  if (authMode !== "vendor" || (model.adapter !== IN_SESSION_ADAPTER && model.adapter !== "claude-cli")) return null;
  const name = model.auth?.env ?? (model.adapter === IN_SESSION_ADAPTER ? "ANTHROPIC_API_KEY" : undefined);
  if (!name || env[name]) return null;
  return `${name} not set for ${model.id}: under auth_mode=vendor this model is billed to the Anthropic API key in ${name}${model.auth?.env ? " (the policy's auth.env)" : ""}. Export it, or run with auth_mode=estimated`;
}

/** What pre-flight reports about the claude CLI the executor's Claude typists need. */
export interface ExecutorCliReport {
  /** Models the executor types with `claude -p` for this policy and slot choice, the lean Opus last attempt included. */
  claude_typists: string[];
  /** "ok", "not checked" (no Claude typist, or not an executor run), or what is wrong and how to fix it. */
  claude_cli: string;
}

/**
 * The claude CLI check. `executor` says whether execute_stage types this
 * run's files (every new-app build): true halts on a problem, before any paid
 * phase; false skips the check (the packet flow never starts a typist);
 * omitted reports a problem as a warning, since pre-flight cannot tell the
 * flows apart and a brownfield run, which never needs the CLI, must not stop.
 */
export function executorCliCheck(o: { executor?: boolean; claudeTypists: string[]; cliProblem: () => string | null }): { check: ExecutorCliReport; halt: string | null; warning: string | null } {
  const check: ExecutorCliReport = { claude_typists: o.claudeTypists, claude_cli: "not checked" };
  if (o.executor === false || o.claudeTypists.length === 0) return { check, halt: null, warning: null };
  const problem = o.cliProblem();
  check.claude_cli = problem ?? "ok";
  if (!problem) return { check, halt: null, warning: null };
  const what = `execute_stage types ${o.claudeTypists.join(", ")} with this machine's claude CLI (the lean Opus last attempt included), but ${problem}.`;
  if (o.executor === true) return { check, halt: `${what} Nothing was spent; fix it and run pre-flight again.`, warning: null };
  return { check, halt: null, warning: `${what} A new-app build (execute_stage) cannot type with Claude until this is fixed; pass executor: true to pre-flight to stop such a run here. A brownfield run does not use the claude CLI.` };
}
