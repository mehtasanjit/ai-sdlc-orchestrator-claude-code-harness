/**
 * The run's route table (routeTable.ts): every phase's model and who runs it, computed at pre-flight by the routing
 * the steps use. Pinned on the shipped policies, and the fail-closed case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { routeTable } from "../dist/routeTable.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const POLICIES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const load = (name) => loadPolicyFromPath(join(POLICIES, `${name}.yaml`));
const row = (rows, phase) => rows.find((r) => r.phase === phase);

test("argon4-plus-sonnet55: the thinking steps on Argon through the engine, the typing on Sonnet, the session on Opus 5.5", () => {
  const { rows, problems } = routeTable(load("argon4-plus-sonnet55"), {});
  assert.deepEqual(problems, []);
  for (const p of ["requirements_analysis", "architecture_design", "senior_code_review", "security_review"]) {
    assert.deepEqual([row(rows, p).model, row(rows, p).who], ["gemini-4-argon", "engine, thinking"], p);
  }
  assert.deepEqual([row(rows, "codegen").model, row(rows, "codegen").who], ["claude-sonnet-5-5", "engine, typing"]);
  assert.deepEqual([row(rows, "orchestrator").model, row(rows, "discovery").who], ["claude-opus-5-5", "session"]);
});

test("a Claude-thinking policy keeps its thinking in the session, unchanged", () => {
  const { rows, problems } = routeTable(load("opus-plus-flash-v38"), {});
  assert.deepEqual(problems, []);
  assert.deepEqual([row(rows, "architecture_design").model, row(rows, "architecture_design").who], ["claude-opus-5", "session"]);
  assert.equal(row(rows, "orchestrator").model, "claude-opus-5");
});

test("every shipped policy has a route table with no problem", () => {
  for (const name of ["argon4-agsdk-only", "argon4-plus-flash38", "argon4-plus-sonnet55", "fable51-plus-flash-v38", "flash-agsdk-only", "flash-agsdk-only-v38", "opus-only", "opus-only-v5", "opus-plus-flash", "opus-plus-flash-v37", "opus-plus-flash-v38", "opus-plus-sonnet", "opus-plus-sonnet-max"]) {
    assert.deepEqual(routeTable(load(name), {}).problems, [], name);
  }
});

test("a thinking phase routed to a model that cannot read the project fails closed", () => {
  const policy = {
    version: 1, name: "t",
    models: [{ id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }, { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5-5" }],
    rules: [{ when: { phase: "architecture_design" }, use: "flash" }, { default: "opus" }],
  };
  const { problems } = routeTable(policy, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /architecture_design is routed to 'flash' \(mcp:model-dispatch\)/);
});

// Review: change_plan was neither routed nor shown, so a policy's change_plan rule (every shipped policy has one) read
// as a choice the run honours; the brownfield architect is routed by architecture_design, and code renders
// change_plan.md and the packets. Discovery is the session's Claude helper whatever its rule says. The table shows
// each such rule as having no effect, so a rule for these phases is never silently ignored, and never refused.
test("phases no rule can route are shown as such: change_plan and plan_task_packets are code, discovery is the session's helper", () => {
  const { rows, problems } = routeTable(load("argon4-agsdk-only"), {});
  assert.deepEqual(problems, []);
  for (const phase of ["change_plan", "plan_task_packets"]) {
    assert.deepEqual(row(rows, phase), { phase, model: "none", model_id: null, who: "code", reason: "rendered by code; a rule for it has no effect" }, phase);
  }
  assert.deepEqual(row(rows, "discovery"), { phase: "discovery", model: "claude-opus-5-5", model_id: null, who: "session", reason: "a Claude helper; a rule for it has no effect" });
  // A rule that sends them to a model reached as a plain completion changes nothing and stops nothing.
  const policy = {
    version: 1, name: "t", session_model: "claude-opus-5-5",
    models: [{ id: "argon", adapter: "antigravity-worker", model_name: "gemini-4-argon" }, { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }],
    rules: [{ when: { phase: ["change_plan", "plan_task_packets", "discovery"] }, use: "flash" }, { default: "argon" }],
  };
  const t = routeTable(policy, {});
  assert.deepEqual(t.problems, []);
  assert.deepEqual(["discovery", "change_plan", "plan_task_packets"].map((p) => [row(t.rows, p).who, row(t.rows, p).model_id]), [["session", null], ["code", null], ["code", null]]);
});
