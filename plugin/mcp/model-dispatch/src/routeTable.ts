/**
 * The run's route table: for every phase, the model the policy names and who runs it, computed once at pre-flight by
 * the routing the steps themselves use, so the person sees which model does what before anything is spent and the
 * run follows it. A thinking phase nothing can run as a thinking step fails closed here; one whose rule says
 * `use: session_model`, and one no rule names, is the session's, on the session's own model (routing.ts routeThinking).
 * A phase no rule can route is listed with who runs it and "a rule for it has no effect", so a policy's rule for it is
 * shown, never silently ignored and never refused: change_plan and plan_task_packets, which code renders (the
 * brownfield architect is routed by architecture_design), and discovery, the session's Claude helper before Gate 0.
 */

import { executorView } from "./executor/run.js";
import { getModel } from "./policy.js";
import { pickModel, routeThinking, THINKING_PHASES } from "./routing.js";
import { THINKING_MODULE, THINKING_TASK_TYPE } from "./thinking.js";
import type { Phase, Policy, SelectOverrides } from "./types.js";

export type Who = "session" | "engine, thinking" | "engine, typing" | "code";

export interface RouteRow {
  phase: string;
  model: string;
  model_id: string | null;
  who: Who;
  reason: string;
}

const TYPING: Phase[] = ["codegen", "tests", "docs", "debug"];
/** Why a policy's rule for a phase no rule can route changes nothing, by who runs the phase. */
const NO_EFFECT = { code: "rendered by code; a rule for it has no effect", session: "a Claude helper; a rule for it has no effect" } as const;
const isClaude = (adapter: string) => adapter === "builtin-anthropic" || adapter === "claude-cli";

export function routeTable(policy: Policy, overrides: SelectOverrides, intent?: string): { rows: RouteRow[]; problems: string[] } {
  const rows: RouteRow[] = [];
  const problems: string[] = [];
  // Thinking rows the session runs on its own model, which is known once every phase is routed.
  const onSession: RouteRow[] = [];
  for (const phase of THINKING_PHASES) {
    const d = routeThinking({ phase, task_type: THINKING_TASK_TYPE, module: THINKING_MODULE, retry_count: 0, ...(intent ? { intent } : {}) }, policy, overrides);
    if ("session" in d) {
      const r: RouteRow = { phase, model: "", model_id: null, who: "session", reason: d.reason };
      rows.push(r);
      onSession.push(r);
      continue;
    }
    const m = getModel(policy, d.modelId);
    if (isClaude(m.adapter)) rows.push({ phase, model: m.model_name, model_id: m.id, who: "session", reason: d.reason });
    else if (m.adapter === "antigravity-worker") rows.push({ phase, model: m.model_name, model_id: m.id, who: "engine, thinking", reason: d.reason });
    else {
      rows.push({ phase, model: m.model_name, model_id: m.id, who: "engine, thinking", reason: d.reason });
      problems.push(`${phase} is routed to '${m.id}' (${m.adapter}), which is called as a model and cannot read the project; route it to an antigravity-worker leaf or a Claude model.`);
    }
  }
  for (const phase of ["change_plan", "plan_task_packets"]) rows.push({ phase, model: "none", model_id: null, who: "code", reason: NO_EFFECT.code });
  const typing = executorView(policy).policy;
  for (const phase of TYPING) {
    const d = pickModel({ phase, task_type: "", module: "", retry_count: 0, ...(intent ? { intent } : {}) }, typing, overrides);
    rows.push({ phase, model: getModel(typing, d.modelId).model_name, model_id: d.modelId, who: "engine, typing", reason: d.reason });
  }
  const sessionModel = rows.find((r) => r.who === "session" && r.model_id !== null)?.model ?? policy.session_model ?? "the session's own model";
  for (const r of onSession) r.model = sessionModel;
  // Discovery runs in the brownfield guide before Gate 0 confirms the policy and the auth mode, and so before
  // pre-flight, which every agent-door call needs: it is the session's Claude helper, whatever its rule says.
  rows.unshift({ phase: "discovery", model: sessionModel, model_id: null, who: "session", reason: NO_EFFECT.session });
  rows.push({ phase: "orchestrator", model: sessionModel, model_id: null, who: "session", reason: "Claude Code runs the orchestrator and the gates" });
  return { rows, problems };
}
