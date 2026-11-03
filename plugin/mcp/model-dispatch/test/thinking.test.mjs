/**
 * Thinking steps on the policy's model (thinking.ts). Pinned:
 *   - a Claude rule is the session's: nothing is dispatched;
 *   - a leaf that cannot read the project stops the step, and nothing runs before this server's pre-flight;
 *   - an agent step is done only when every piece is accepted; a step that cannot finish stops, with no other model;
 *   - a project file that changed while the step ran stops it;
 *   - a revise carries on the saved conversation;
 *   - the step's tools are configured for its own fixed paths, and its packet is routed as the route table reads it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { THINKING_ROLES, outputDirProblem, roleInstructions, roleOutputs, runThinkingStep } from "../dist/thinking.js";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLAUDE = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5-5" };
const AGENT = { id: "argon", adapter: "antigravity-worker", model_name: "gemini-4-argon" };
const COMPLETION = { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };

const project = () => mkdtempSync(join(tmpdir(), "mmo-thinking-"));
const result = (over = {}) => ({ result: { done: true, missing: [], accepted: ["header.json", "units-001.json"], conversation_id: "c1" }, tokens: { input: 10, input_cached: 0, output: 5 }, cost_usd: 0.02, latency_ms: 1, cache_hit: false, success: true, workspace_changes: [], ...over });

function deps(model, answer, over = {}) {
  const calls = { dispatch: [], record: [] };
  return {
    calls,
    d: {
      pluginRoot: PLUGIN_ROOT,
      route: () => ({ model, reason: "test rule" }),
      agentDoorProblem: () => null,
      contractActive: () => false,
      thinkingTimeoutSec: 14400,
      dispatch: async (packet, thinking) => {
        calls.dispatch.push({ packet, thinking });
        return { result: answer(calls.dispatch.length, thinking), events: [{ phase: packet.phase, model: model.model_name, cost_usd: 0.02 }] };
      },
      record: (e) => calls.record.push(...e),
      log: () => {},
      ...over,
    },
  };
}
const args = (root, over = {}) => ({ role: "brownfield-architect", prompt: "plan it", project_root: root, run_id: "r1", intent: "bugfix", output_dir: ".sdlc/runs/r1", ...over });

test("a Claude rule is the session's step: nothing is dispatched", async () => {
  const root = project();
  const { d, calls } = deps(CLAUDE, () => assert.fail("no dispatch"));
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "session");
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(calls.dispatch.length, 0);
});

test("a leaf called as a model stops the step: it cannot read the project, and no other model takes over", async () => {
  const root = project();
  const { d, calls } = deps(COMPLETION, () => assert.fail("no dispatch"));
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "stopped");
  assert.match(r.reason, /cannot read the project/);
  assert.equal(calls.dispatch.length, 0);
});

test("nothing is sent before this server's pre-flight", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => assert.fail("no dispatch"), { agentDoorProblem: () => "Call preflight_dispatch first" });
  await assert.rejects(runThinkingStep(args(root), d), /preflight_dispatch/);
  assert.equal(calls.dispatch.length, 0);
});

test("an agent step with every piece accepted is done, its spend recorded under its role", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => result());
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "done");
  assert.deepEqual(r.accepted, ["header.json", "units-001.json"]);
  assert.equal(calls.record[0].judgment_role, "brownfield-architect");
  const { packet, thinking } = calls.dispatch[0];
  assert.equal(packet.phase, "architecture_design");
  assert.equal(packet.intent, "bugfix");
  assert.equal(packet.task_type, "judgment");
  assert.match(packet.instruction, /write_section/);
  assert.match(packet.instruction, /plan it/);
  assert.equal(thinking.timeoutSec, 14400);
  const cfg = JSON.parse(readFileSync(thinking.toolsConfig, "utf8"));
  assert.equal(cfg.role, "brownfield-architect");
  assert.deepEqual(cfg.outputs, { sections_dir: ".sdlc/runs/r1/change.sections" });
});

test("a step that ends with pieces owed stops the run at that step, saying what is owed", async () => {
  const root = project();
  const { d } = deps(AGENT, () => result({ result: { done: false, missing: ["header.json, accepted"], conversation_id: "c1" } }));
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "stopped");
  assert.deepEqual(r.missing, ["header.json, accepted"]);
});

test("a worker that fails stops the step with its reason", async () => {
  const root = project();
  const { d } = deps(AGENT, () => result({ success: false, result: null, error: "the step's own work time reached the policy's limit" }));
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "stopped");
  assert.match(r.reason, /own work time/);
});

test("a project file that changed while the step ran stops it; the step's own folders do not count", async () => {
  const root = project();
  const { d } = deps(AGENT, () => result({ workspace_changes: [".sdlc/runs/r1/change.sections/header.json", "src/app.ts"] }));
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "stopped");
  assert.match(r.reason, /src\/app\.ts/);
  assert.doesNotMatch(r.reason, /header\.json/);
});

test("Google serving nothing for the busy window is a halt", async () => {
  const root = project();
  const { d } = deps(AGENT, () => result({ success: false, halt: "nothing served for 300 s" }));
  assert.equal((await runThinkingStep(args(root), d)).route, "halt");
});

test("a revise carries on the step's saved conversation with the changes asked for", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => result());
  await runThinkingStep(args(root), d);
  const r = await runThinkingStep(args(root, { revise: "split U02 into two units" }), d);
  assert.equal(r.resumed, true);
  assert.equal(calls.dispatch[1].thinking.resumeId, "c1");
  assert.match(calls.dispatch[1].packet.instruction, /split U02 into two units/);
  assert.doesNotMatch(calls.dispatch[1].packet.instruction, /The helper's instructions/, "a resumed conversation already holds them");
});

test("a brownfield step writes only in the run's folder under .sdlc", () => {
  assert.match(outputDirProblem("/p", "src", true), /outside \.sdlc/);
  assert.equal(outputDirProblem("/p", ".sdlc/runs/r1", true), null);
  assert.match(outputDirProblem("/p", "../x", false), /inside project_root/);
  assert.equal(outputDirProblem("/p", "examples/x/passes/p1", false), null);
});

test("a review_path outside the run's own folder is refused before anything is sent", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => assert.fail("no dispatch"));
  for (const review_path of ["../outside/review.json", "/tmp/review.json", "src/review.json", ".sdlc/runs/r1"]) {
    await assert.rejects(runThinkingStep(args(root, { role: "brownfield-senior-reviewer", review_path }), d), /review_path/, review_path);
  }
  assert.equal(calls.dispatch.length, 0);
});

test("a step's input files are copied into its run folder through the read rule, and the step is told where", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "mmo-brief-"));
  writeFileSync(join(outside, "brief.md"), "# Brief\n\nBuild a ping service.\n");
  const { d, calls } = deps(AGENT, () => result({ result: { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1" } }));
  const r = await runThinkingStep(args(root, { role: "requirements", output_dir: "out", prompt: "The brief is at the path given.", inputs: [join(outside, "brief.md")] }), d);
  assert.equal(r.route, "done");
  assert.equal(readFileSync(join(root, "out", "inputs", "brief.md"), "utf8"), "# Brief\n\nBuild a ping service.\n");
  assert.match(calls.dispatch[0].packet.instruction, /out\/inputs\/brief\.md/);
  // An input that is missing, has a refused name, or holds a private key refuses the step before anything is sent.
  writeFileSync(join(outside, ".env"), "KEY=1\n");
  writeFileSync(join(outside, "notes.txt"), "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
  for (const bad of [join(outside, "missing.md"), join(outside, ".env"), join(outside, "notes.txt")]) {
    const one = deps(AGENT, () => assert.fail("no dispatch"));
    await assert.rejects(runThinkingStep(args(root, { role: "requirements", output_dir: "out", inputs: [bad] }), one.d), /input/, bad);
    assert.equal(one.calls.dispatch.length, 0);
  }
});

test("per-module reviews are separate steps: each keeps its own files, conversation and packet", async () => {
  const root = project();
  const review = (m, conv) => deps(AGENT, () => result({ result: { done: true, missing: [], accepted: ["review"], conversation_id: conv } }));
  const one = review("m1", "conv-m1");
  await runThinkingStep(args(root, { role: "senior-reviewer", output_dir: "out", review_path: "out/m1/review.json", prompt: "Review module m1" }), one.d);
  const two = review("m2", "conv-m2");
  await runThinkingStep(args(root, { role: "senior-reviewer", output_dir: "out", review_path: "out/m2/review.json", prompt: "Review module m2" }), two.d);
  const [a, b] = [one.calls.dispatch[0], two.calls.dispatch[0]];
  assert.notEqual(a.thinking.toolsConfig, b.thinking.toolsConfig);
  assert.notEqual(a.thinking.saveDir, b.thinking.saveDir);
  assert.notEqual(a.packet.id, b.packet.id);
  assert.equal(JSON.parse(readFileSync(a.thinking.toolsConfig, "utf8")).outputs.review, "out/m1/review.json");
  // Module 1's revise carries on module 1's conversation, not the last one saved.
  const again = review("m1", "conv-m1");
  await runThinkingStep(args(root, { role: "senior-reviewer", output_dir: "out", review_path: "out/m1/review.json", prompt: "Review module m1", revise: "fix it" }), again.d);
  assert.equal(again.calls.dispatch[0].thinking.resumeId, "conv-m1");
});

test("a step whose worker stopped after every piece was accepted is done; one with pieces owed says what is owed and what was kept", async () => {
  const root = project();
  const failed = (summary) => deps(AGENT, () => result({ success: false, error: "The agent worker exited 1: the step's own work time reached the policy's limit", result: summary }));
  const done = failed({ done: true, missing: [], accepted: ["header.json", "units-001.json"], conversation_id: "c9" });
  const r = await runThinkingStep(args(root), done.d);
  assert.equal(r.route, "done", JSON.stringify(r));
  const owed = failed({ done: false, missing: ["units-002.json, refused: U03.path is outside the allowlist"], accepted: ["header.json"], conversation_id: "c7" });
  const s = await runThinkingStep(args(root), owed.d);
  assert.equal(s.route, "stopped");
  assert.deepEqual(s.missing, ["units-002.json, refused: U03.path is outside the allowlist"]);
  assert.deepEqual(s.accepted, ["header.json"]);
  // Its conversation is kept, so a revise carries it on.
  const again = deps(AGENT, () => result());
  await runThinkingStep(args(root, { revise: "fix U03" }), again.d);
  assert.equal(again.calls.dispatch[0].thinking.resumeId, "c7");
});

test("each role's hand-in paths are fixed under the run's folder", () => {
  const a = { output_dir: "out/" };
  assert.deepEqual(roleOutputs("requirements", a), { requirements: "out/requirements.md" });
  assert.deepEqual(roleOutputs("architect", a), { sections_dir: "out/spec.sections" });
  assert.deepEqual(roleOutputs("senior-reviewer", { ...a, review_path: "out/m1/review.json" }), { review: "out/m1/review.json" });
  assert.deepEqual(roleOutputs("brownfield-security-reviewer", a), { security_review: "out/security_review.md" });
});

test("every role's instructions resolve from the shipped plugin", () => {
  for (const [name, role] of Object.entries(THINKING_ROLES)) {
    const text = roleInstructions(PLUGIN_ROOT, role);
    assert.ok(text.length > 200, name);
    assert.doesNotMatch(text, /^---\n/, name);
  }
});
