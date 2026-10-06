/**
 * The premium phases a helper agent of the session runs — the architect and the two reviewers — priced from that
 * helper's own transcript, under the phase, in the manifest's phase_breakdown.
 *
 * Why: these helpers run inside the orchestrator's Claude Code session, so no dispatch telemetry sees them; the
 * orchestrator logged each one as a hand estimate (a character count at an assumed input/output split), so the
 * per-phase table showed a guess where the session's transcript holds every token, and the orchestrator spent its own
 * turns producing it. The collector already reads every helper's transcript, and Claude Code writes each one's
 * agent type beside it (`agent-<id>.meta.json`, `agentType`), so each phase gets the measured figure. The true total
 * does not change: the helpers were always inside the orchestrator overhead, and the estimates (provenance
 * `estimated`) were always subtracted once (collect-orchestrator-usage.mjs inSessionDispatched).
 *
 * The collector computes the figures; applyHelperPhases puts them into phase_breakdown, each phase with a `measured`
 * record that keeps the whole measurement (cost, messages, files, agent types, per model, the estimate it replaced).
 * write-manifest.mjs rebuilds phase_breakdown from telemetry, so when it keeps the collector's figures (a Gate 4
 * rewrite) it reads those records back (measuredHelperPhases) and applies them again, and the two never disagree.
 *
 * Exports: HELPER_PHASES, phaseOfAgentType(agentType), helperAgentType(file), measuredHelperPhases(manifest),
 * applyHelperPhases(manifest, events, phases).
 */
import { readFileSync } from "node:fs";

/** Agent name → the phase its work is. Greenfield's and brownfield's agents of each role map to the same phase. */
export const HELPER_PHASES = Object.freeze({
  architect: "architecture_design",
  "brownfield-architect": "architecture_design",
  "senior-reviewer": "senior_code_review",
  "brownfield-senior-reviewer": "senior_code_review",
  "security-reviewer": "security_review",
  "brownfield-security-reviewer": "security_review",
});

/**
 * The phase of a helper's agent type, or null. This plugin's agents only: `mmo:<name>` (the plugin route) or the bare
 * `<name>` the clone route installs as a project agent (tools/setup.mjs copies them into ./.claude/agents). Another
 * plugin's `x:architect` is not this plugin's architect, and the orchestrators and the discovery helper are no phase.
 */
export function phaseOfAgentType(agentType) {
  if (typeof agentType !== "string") return null;
  const m = /^(?:mmo:)?([a-z-]+)$/.exec(agentType);
  return m && Object.hasOwn(HELPER_PHASES, m[1]) ? HELPER_PHASES[m[1]] : null;
}

/** The agent type Claude Code recorded for a helper transcript (`agent-<id>.jsonl` → `agent-<id>.meta.json`), or null. */
export function helperAgentType(file) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  try {
    const meta = JSON.parse(readFileSync(`${file.slice(0, -".jsonl".length)}.meta.json`, "utf8"));
    return typeof meta?.agentType === "string" ? meta.agentType : null;
  } catch {
    return null;
  }
}

/** The provenances of in-session work, which the collector subtracts once (inSessionDispatched): the estimates. */
const IN_SESSION = new Set(["estimated", "apportioned_from_measured_total"]);
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** The measured helper phases a manifest carries ({ phase: measured record }), as applyHelperPhases wrote them. */
export function measuredHelperPhases(manifest) {
  const breakdown = manifest?.phase_breakdown;
  if (!breakdown || typeof breakdown !== "object") return {};
  return Object.fromEntries(Object.entries(breakdown).filter(([, p]) => p?.measured && Number.isFinite(p.measured.cost_usd)).map(([phase, p]) => [phase, p.measured]));
}

/**
 * Puts measured helper phases (`phases`: { phase: { cost_usd, messages, files, agent_types, per_model,
 * pricing_complete } }) into `manifest.phase_breakdown`, in place: each phase is rebuilt from the telemetry `events` of
 * that phase that are not in-session estimates (a dispatched call in the same phase stays) plus the measured figure,
 * and carries a `measured` record with the measurement and what it replaced. Returns the manifest.
 */
export function applyHelperPhases(manifest, events = [], phases = {}) {
  if (!manifest || typeof manifest !== "object" || !phases || typeof phases !== "object") return manifest;
  const work = (Array.isArray(events) ? events : []).filter((ev) => ev && ev.tier !== "orchestrator");
  for (const [phase, h] of Object.entries(phases)) {
    if (!h || !Number.isFinite(h.cost_usd)) continue;
    const breakdown = (manifest.phase_breakdown ??= {});
    const inPhase = work.filter((ev) => ev.phase === phase);
    const estimates = inPhase.filter((ev) => IN_SESSION.has(ev.provenance));
    const kept = inPhase.filter((ev) => !IN_SESSION.has(ev.provenance));
    const byModel = {};
    const add = (model, calls, cost, input, cached, output) => {
      const b = (byModel[model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0 });
      b.calls += calls;
      b.cost_usd += cost;
      b.input_tokens += input;
      b.input_tokens_cached += cached;
      b.output_tokens += output;
    };
    for (const ev of kept) add(ev.model, 1, ev.cost_usd ?? 0, ev.input_tokens ?? 0, ev.input_tokens_cached ?? 0, ev.output_tokens ?? 0);
    for (const [model, b] of Object.entries(h.per_model ?? {})) add(model, b.messages ?? 0, b.cost_usd ?? 0, b.input_tokens ?? 0, b.input_tokens_cached ?? 0, b.output_tokens ?? 0);
    for (const b of Object.values(byModel)) b.cost_usd = r6(b.cost_usd);
    const sum = (k) => Object.values(byModel).reduce((s, b) => s + b[k], 0);
    breakdown[phase] = {
      calls: sum("calls"),
      cost_usd: r6(kept.reduce((s, ev) => s + (ev.cost_usd ?? 0), 0) + h.cost_usd),
      models: Object.keys(byModel),
      input_tokens: sum("input_tokens"),
      input_tokens_cached: sum("input_tokens_cached"),
      output_tokens: sum("output_tokens"),
      by_model: byModel,
      measured: {
        source: "helper transcripts",
        cost_usd: h.cost_usd,
        messages: h.messages ?? 0,
        files: h.files ?? 0,
        agent_types: h.agent_types ?? [],
        per_model: h.per_model ?? {},
        pricing_complete: h.pricing_complete !== false,
        replaced_estimate_usd: r6(estimates.reduce((s, ev) => s + (ev.cost_usd ?? 0), 0)),
        replaced_estimate_events: estimates.length,
      },
    };
  }
  return manifest;
}
