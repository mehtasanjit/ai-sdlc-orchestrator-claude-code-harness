/**
 * Setup builds the Antigravity worker's environment for a project whose policy reaches an antigravity-worker leaf
 * with no MMO_SELECT choice: a rule names the leaf, or names a slot whose default it is. A policy whose agent leaf is
 * only a slot's other option (opus-plus-flash's flash-agsdk-worker) runs on the model path unless MMO_SELECT picks
 * the agent, so its installs are never asked about Python. verify-setup.mjs reads the policy by lines (it runs before
 * the server is built); every shipped policy is checked against a real YAML parse.
 *
 * $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { policyReachesAgentWorker, projectPolicyUsingAgentWorker } from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugin");
const POLICIES = join(PLUGIN, "config", "policies");

/** The loader's answer: a rule's target is an agent leaf, or a slot whose default is one. */
function reaches(policy) {
  const agent = new Set(policy.models.filter((m) => m.adapter === "antigravity-worker").map((m) => m.id));
  return policy.rules.some((r) => {
    const t = r.use ?? r.default;
    return agent.has(t) || agent.has(policy.select?.[t]?.default);
  });
}

test("every shipped policy is read as the YAML says: an agent leaf a rule reaches counts, a slot's other option does not", () => {
  const files = readdirSync(POLICIES).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const text = readFileSync(join(POLICIES, f), "utf8");
    assert.equal(policyReachesAgentWorker(text), reaches(YAML.parse(text)), f);
  }
  assert.equal(policyReachesAgentWorker(readFileSync(join(POLICIES, "flash-agsdk-only-v38.yaml"), "utf8")), true);
  assert.equal(policyReachesAgentWorker(readFileSync(join(POLICIES, "opus-plus-flash.yaml"), "utf8")), false, "the agent is a slot option there");
});

test("a project's routing-policy.yaml decides before its default_policy, in block or flow style", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-gate-"));
  try {
    mkdirSync(join(dir, ".sdlc"));
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ default_policy: "opus-plus-flash" }));
    assert.equal(projectPolicyUsingAgentWorker(dir, PLUGIN), null, "opus-plus-flash on the model path");
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ default_policy: "argon4-agsdk-only" }));
    assert.equal(projectPolicyUsingAgentWorker(dir, PLUGIN), "argon4-agsdk-only");
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ default_policy: "../../etc/passwd" }));
    assert.equal(projectPolicyUsingAgentWorker(dir, PLUGIN), null, "a name, not a path");
    const own = [
      "version: 1",
      "name: own",
      "models:",
      "  - { id: opus, adapter: builtin-anthropic, model_name: claude-opus-5 }",
      "  - { id: agent, adapter: antigravity-worker, model_name: gemini-3.8-flash }  # the agent",
      "select:",
      "  mech: { default: agent, options: [agent, opus] }",
      "rules:",
      "  - when: { phase: codegen }",
      "    use: mech",
      "  - default: opus",
      "",
    ].join("\n");
    assert.equal(reaches(YAML.parse(own)), true);
    writeFileSync(join(dir, "routing-policy.yaml"), own);
    assert.equal(projectPolicyUsingAgentWorker(dir, PLUGIN), "routing-policy.yaml");
    writeFileSync(join(dir, "routing-policy.yaml"), own.replace("default: agent", "default: opus"));
    assert.equal(projectPolicyUsingAgentWorker(dir, PLUGIN), null, "the slot's default is no agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
