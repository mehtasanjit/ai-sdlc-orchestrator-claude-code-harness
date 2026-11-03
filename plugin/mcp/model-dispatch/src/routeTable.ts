/**
 * The run's route table: for every phase, the model the policy names and who runs it, computed once at pre-flight by
 * the routing the steps themselves use, so the person sees which model does what before anything is spent and the
 * run follows it. A thinking phase nothing can run as a thinking step fails closed here.
 */

import { executorView } from "./executor/run.js";
import { getModel } from "./policy.js";
import { pickModel } from "./routing.js";
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

const THINKING: Phase[] = ["requirements_analysis", "architecture_design", "senior_code_review", "security_review"];
const TYPING: Phase[] = ["codegen", "tests", "docs", "debug"];
const isClaude = (adapter: string) => adapter === "builtin-anthropic" || adapter === "claude-cli";

export function routeTable(policy: Policy, overrides: SelectOverrides, intent?: string): { rows: RouteRow[]; problems: string[] } {
  const rows: RouteRow[] = [];
  const problems: string[] = [];
  for (const phase of THINKING) {
    const d = pickModel({ phase, task_type: THINKING_TASK_TYPE, module: THINKING_MODULE, retry_count: 0, ...(intent ? { intent } : {}) }, policy, overrides);
    const m = getModel(policy, d.modelId);
    if (isClaude(m.adapter)) rows.push({ phase, model: m.model_name, model_id: m.id, who: "session", reason: d.reason });
    else if (m.adapter === "antigravity-worker") rows.push({ phase, model: m.model_name, model_id: m.id, who: "engine, thinking", reason: d.reason });
    else {
      rows.push({ phase, model: m.model_name, model_id: m.id, who: "engine, thinking", reason: d.reason });
      problems.push(`${phase} is routed to '${m.id}' (${m.adapter}), which is called as a model and cannot read the project; route it to an antigravity-worker leaf or a Claude model.`);
    }
  }
  rows.push({ phase: "plan_task_packets", model: "none", model_id: null, who: "code", reason: "packets are built from the spec by code" });
  const typing = executorView(policy).policy;
  for (const phase of TYPING) {
    const d = pickModel({ phase, task_type: "", module: "", retry_count: 0, ...(intent ? { intent } : {}) }, typing, overrides);
    rows.push({ phase, model: getModel(typing, d.modelId).model_name, model_id: d.modelId, who: "engine, typing", reason: d.reason });
  }
  const sessionModel = rows.find((r) => r.who === "session")?.model ?? policy.session_model ?? "the session's own model";
  // Discovery runs in the brownfield guide before Gate 0 confirms the policy and the auth mode, and so before
  // pre-flight, which every agent-door call needs: it runs on the session.
  rows.unshift({ phase: "discovery", model: sessionModel, model_id: null, who: "session", reason: "runs before Gate 0 confirms the policy and pre-flight runs" });
  rows.push({ phase: "orchestrator", model: sessionModel, model_id: null, who: "session", reason: "Claude Code runs the orchestrator and the gates" });
  return { rows, problems };
}
