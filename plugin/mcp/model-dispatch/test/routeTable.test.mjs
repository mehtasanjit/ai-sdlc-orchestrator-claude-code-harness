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
