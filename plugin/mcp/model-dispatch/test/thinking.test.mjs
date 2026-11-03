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
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { THINKING_ROLES, outputDirProblem, roleInstructions, roleOutputs, runThinkingStep, stepKey } from "../dist/thinking.js";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { alive, beat, fakeWorkerPython, flagValue, withEnv } from "./agyFakes.mjs";
import { NO_PYTHON, PYTHON, STANDIN, step as standinStep, textAnswer } from "./agyStandin.mjs";

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

// E-thinking-stop-reason. Review: the reply said "ended with pieces still owed" whatever stopped the step, so a person
// could not tell its work budget, a model making no progress and a tool that hung apart.
test("a stopped step's reply names why its worker stopped, in plain words, and what is still owed", async () => {
  const worker = readFileSync(join(PLUGIN_ROOT, "mcp", "model-dispatch", "worker", "thinking_worker.py"), "utf8");
  const turns = /^NO_PROGRESS_TURNS = (\d+)$/m.exec(worker)?.[1];
  assert.ok(turns, "the worker names its no-progress limit");
  const stopped = (summary, error) => runThinkingStep(args(project()), deps(AGENT, () => result({ success: false, error, result: { done: false, missing: ["header.json, accepted"], accepted: ["units-001.json"], conversation_id: "c1", ...summary } })).d);
  const idle = await stopped({ reason: "no_progress" }, "The agent worker exited 1. thinking_worker failed: the step made no progress");
  assert.equal(idle.route, "stopped");
  assert.equal(idle.reason, `the gemini-4-argon step stopped: no progress for ${turns} turns in a row; still owed: header.json, accepted`);
  assert.deepEqual(idle.missing, ["header.json, accepted"], "what is owed, as before");
  assert.deepEqual(idle.accepted, ["units-001.json"], "and what was kept");
  assert.equal((await stopped({ reason: "budget" }, "The agent worker exited 1. thinking_worker failed: the step's own work time reached its limit")).reason,
    "the gemini-4-argon step stopped: its own work time reached the policy's limit, thinking_timeout_sec (14400 s, the time Google held or refused its calls not counted); still owed: header.json, accepted");
  // Where the worker's own error says what happened, it follows.
  assert.equal((await stopped({ reason: "tool_dead" }, "The agent worker exited 1: the step's tool read_file gave no answer in 1800 s; the step stopped there")).reason,
    "the gemini-4-argon step stopped: the step's tools failed (The agent worker exited 1: the step's tool read_file gave no answer in 1800 s; the step stopped there); still owed: header.json, accepted");
  // A worker that could not say why (killed before it could) stops the step with its dispatch's error, as before.
  assert.equal((await stopped({}, "The agent worker was stopped: no heartbeat for 60 s")).reason,
    "the gemini-4-argon step could not finish: The agent worker was stopped: no heartbeat for 60 s; still owed: header.json, accepted");
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

// E-thinking-system. Review: the helper's instructions went in as the first user message, which a long step's trimmed
// history can drop; the design gives them to the session as its system instructions.
test("a step's dispatch carries its system text (how it runs, the helper's instructions) apart from its task; the packet keeps the whole", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => result());
  await runThinkingStep(args(root), d);
  const { packet, thinking } = calls.dispatch[0];
  assert.match(thinking.system, /^## How this step runs\n/);
  assert.match(thinking.system, /write_section/, "the step's own hand-in tools");
  assert.match(thinking.system, /\n## The helper's instructions\n\n\S/);
  assert.doesNotMatch(thinking.system, /## This invocation/);
  assert.equal(thinking.task, "## This invocation\n\nplan it");
  assert.equal(packet.instruction, `${thinking.system}\n\n${thinking.task}`, "the record of what the model is told: the whole text, as before");
  // A revise carries the conversation on: its task is the changes asked for, and the system text is the first call's.
  await runThinkingStep(args(root, { revise: "split U02 into two units" }), d);
  const again = calls.dispatch[1];
  assert.equal(again.thinking.system, thinking.system);
  assert.match(again.thinking.task, /^Changes asked for this step:\n\nsplit U02 into two units/);
  assert.equal(again.packet.instruction, again.thinking.task);
});

test("a greenfield architect's revise hands the whole spec in again, as its instructions say; other steps hand in what changed", async () => {
  const root = project();
  // A real run's architect checks coverage against the run's requirements, which the requirements step handed in.
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: ping.\n");
  const { d, calls } = deps(AGENT, () => result({ result: { done: true, missing: [], accepted: ["header.json", "units-001.json", "finalize"], conversation_id: "c1" } }));
  const architect = (over) => args(root, { role: "architect", intent: undefined, output_dir: "out", ...over });
  const config = () => JSON.parse(readFileSync(join(root, "out", "thinking", "architect.tools.json"), "utf8"));
  await runThinkingStep(architect({}), d);
  assert.equal(config().revise, false);
  // A header after finalize opens a new spec, so a revise that hands in only its changed file would drop the rest.
  await runThinkingStep(architect({ revise: "U02: also return 409 on a duplicate title" }), d);
  const resumed = calls.dispatch[1].packet.instruction;
  assert.match(resumed, /then every units file in order, changed or not/);
  assert.match(resumed, /its name alone/);
  assert.match(resumed, /finalize's drop/);
  assert.doesNotMatch(resumed, /hand each changed one in again/);
  assert.equal(config().revise, true, "the tools hold the step to the approved spec");
  // With no saved conversation the revise starts over, told the same.
  const fresh = project();
  mkdirSync(join(fresh, "out"), { recursive: true });
  writeFileSync(join(fresh, "out", "requirements.md"), "# R\n- FR-1: ping.\n");
  const f = deps(AGENT, () => result({ result: { done: true, missing: [], accepted: [] } }));
  await runThinkingStep(args(fresh, { role: "architect", intent: undefined, output_dir: "out", revise: "U02: also return 409" }), f.d);
  assert.match(f.calls.dispatch[0].packet.instruction, /## Changes asked for[\s\S]*then every units file in order, changed or not/);
  // A brownfield architect's sections stay on disk between calls: it hands in only what changed.
  const b = deps(AGENT, () => result());
  await runThinkingStep(args(root), b.d);
  await runThinkingStep(args(root, { revise: "split U02" }), b.d);
  assert.match(b.calls.dispatch[1].packet.instruction, /hand each changed one in again/);
});

test("an acceptance fix is the architect's: it carries on the architect's conversation, and its reply carries the answer", async () => {
  const root = project();
  // A real run's architect checks coverage against the run's requirements, which the requirements step handed in.
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: ping.\n");
  const fix = { failures: [{ path: "package.json", problem: "set overrides.semver to 7.6.3: the audit's high advisory" }] };
  const { d, calls } = deps(AGENT, (n) => {
    // The step's tools write the answer when it is accepted; the second call is the acceptance fix.
    if (n === 2) writeFileSync(join(root, "out", "acceptance-fix.json"), JSON.stringify(fix));
    return result({ result: { done: true, missing: [], accepted: n === 2 ? ["acceptance_fix"] : ["header.json", "units-001.json", "finalize"], conversation_id: "c1" } });
  });
  const architect = (over) => args(root, { role: "architect", intent: undefined, output_dir: "out", ...over });
  await runThinkingStep(architect({}), d);
  const failure = "audit (npm audit --audit-level=high) failed: exit 1; its log: out/acceptance/logs/2-audit.log";
  const r = await runThinkingStep(architect({ acceptance_fix: failure }), d);
  assert.equal(r.route, "done");
  assert.equal(r.resumed, true);
  assert.deepEqual(r.acceptance_fix, fix, "the entries for execute_stage repair, as the helper replies them");
  const sent = calls.dispatch[1];
  assert.equal(sent.thinking.resumeId, "c1");
  assert.match(sent.packet.instruction, /^Acceptance fix/);
  assert.ok(sent.packet.instruction.includes(failure));
  assert.match(sent.packet.instruction, /write_acceptance_fix/);
  const config = JSON.parse(readFileSync(join(root, "out", "thinking", "architect.tools.json"), "utf8"));
  assert.equal(config.acceptance_fix, true);
  assert.deepEqual(config.outputs, { acceptance_fix: "out/acceptance-fix.json" });
  // Only the architect answers one, and never together with a revise.
  await assert.rejects(runThinkingStep(args(root, { role: "senior-reviewer", output_dir: "out", acceptance_fix: failure }), d), /architect/);
  await assert.rejects(runThinkingStep(architect({ acceptance_fix: failure, revise: "and this" }), d), /not both/);
  // A step that is done with no readable answer is stopped, not passed on empty.
  const empty = project();
  const e = deps(AGENT, () => result({ result: { done: true, missing: [], accepted: ["acceptance_fix"], conversation_id: "c2" } }));
  const lost = await runThinkingStep(args(empty, { role: "architect", intent: undefined, output_dir: "out", acceptance_fix: failure }), e.d);
  assert.equal(lost.route, "stopped");
  assert.match(lost.reason, /acceptance-fix\.json/);
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

test("a step's input is judged by the file it reads: a link or a second name for a refused file is refused, inside the project or out", async () => {
  const root = project();
  writeFileSync(join(root, ".env"), "STRIPE_KEY=sk_live_secret\n");
  symlinkSync(".env", join(root, "notes.txt"));
  linkSync(join(root, ".env"), join(root, "hard.txt"));
  const outside = mkdtempSync(join(tmpdir(), "mmo-brief-"));
  mkdirSync(join(outside, ".aws"));
  writeFileSync(join(outside, ".aws", "credentials"), "aws_secret_access_key = x\n");
  symlinkSync(join(outside, ".aws", "credentials"), join(outside, "brief.md"));
  for (const [bad, why] of [["notes.txt", /never sent to a model/], ["hard.txt", /hard link/], [join(outside, "brief.md"), /never sent to a model/]]) {
    const one = deps(AGENT, () => assert.fail("no dispatch"));
    await assert.rejects(runThinkingStep(args(root, { role: "requirements", output_dir: "out", inputs: [bad] }), one.d), why, bad);
    assert.equal(one.calls.dispatch.length, 0);
    assert.equal(existsSync(join(root, "out", "inputs")), false, "nothing was copied");
  }
});

test("the brownfield architect reads the plugin's stack notes its instructions name, copied into the run's folder", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => result());
  await runThinkingStep(args(root), d);
  const instruction = calls.dispatch[0].packet.instruction;
  assert.doesNotMatch(instruction, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pipeline\/stacks/);
  assert.match(instruction, /\.sdlc\/runs\/r1\/inputs\/plugin-stacks\/nest\.md/);
  for (const f of ["nest.md", "python.md", "generic.md"]) {
    assert.equal(readFileSync(join(root, ".sdlc", "runs", "r1", "inputs", "plugin-stacks", f), "utf8"), readFileSync(join(PLUGIN_ROOT, "skills", "pipeline", "stacks", f), "utf8"), f);
  }
});

test("the folders a step is given are inside the project, and the architect checks coverage against the run's requirements", async () => {
  const root = project();
  const { d, calls } = deps(AGENT, () => result({ result: { done: true, missing: [], accepted: ["header.json", "units-001.json", "finalize"], conversation_id: "c1" } }));
  const architect = (over) => args(root, { role: "architect", intent: undefined, output_dir: "out", ...over });
  await assert.rejects(runThinkingStep(architect({}), d), /requirements/, "no requirements_path and no out/requirements.md");
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: ping.\n");
  await runThinkingStep(architect({}), d);
  assert.equal(JSON.parse(readFileSync(join(root, "out", "thinking", "architect.tools.json"), "utf8")).requirements_path, "out/requirements.md", "the run's own requirements by default");
  await assert.rejects(runThinkingStep(architect({ requirements_path: "../elsewhere.md" }), d), /requirements_path/);
  await assert.rejects(runThinkingStep(architect({ requirements_path: "/etc/hosts" }), d), /requirements_path/);
  await assert.rejects(runThinkingStep(args(root, { role: "senior-reviewer", intent: undefined, output_dir: "out", code_dir: "../x" }), d), /code_dir/);
  assert.equal(calls.dispatch.length, 1, "nothing was sent for a refused call");
});

test("a Gemini architect called with no requirements_path still has its finalize refused for uncovered requirements", async () => {
  const { ThinkingTools } = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "thinking-tools.mjs")).href);
  const root = project();
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: answer ping.\n- FR-2: answer pong.\n");
  const header = { stack: ["Python 3.13"], commands: [{ name: "tests", run: "pytest -q", cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }], no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] } };
  const unit = { id: "U01", path: "src/app.py", phase: "codegen", import_line: "", exports: [], behaviour: "answers ping", depends_on: [], style_from: { reason: "first file" }, covers: ["FR-1"], tests: [], approx_lines: 20 };
  let finalized;
  // The step's own tools, started from the config the server wrote, as its worker starts them.
  const { d } = deps(AGENT, () => assert.fail("dispatch is replaced"), {
    dispatch: async (packet, thinking) => {
      const t = new ThinkingTools(JSON.parse(readFileSync(thinking.toolsConfig, "utf8")));
      await t.call("submit_section", { name: "header.json", json: JSON.stringify(header) });
      await t.call("submit_section", { name: "units-001.json", json: JSON.stringify([unit]) });
      finalized = await t.call("finalize", {});
      return { result: result({ result: { ...JSON.parse((await t.call("status", {})).result), conversation_id: "c1" } }), events: [] };
    },
  });
  const r = await runThinkingStep(args(root, { role: "architect", intent: undefined, output_dir: "out" }), d);
  assert.match(String(finalized.error), /no unit covers FR-2\b/, JSON.stringify(finalized));
  assert.doesNotMatch(String(finalized.error), /FR-1\b/, "a covered requirement is not named");
  assert.equal(existsSync(join(root, "out", "spec.json")), false, "nothing was finalized");
  assert.equal(r.route, "stopped");
  assert.ok(r.missing.some((m) => /^finalize/.test(m)), r.missing.join("; "));
});

test("an architect called again in the run whose spec it finalized is done at once, and nothing is sent; a new pre-flight's call goes to Gemini", async () => {
  // Review of the hand-in fixes: the step's tools owed only finalize then, so Gemini was paid for a turn that could at
  // best finalize the spec again, or hand its header in first, which opens a new spec and moves the approved one aside.
  const { ThinkingTools } = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "thinking-tools.mjs")).href);
  const root = project();
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: answer ping.\n");
  const header = { stack: ["Python 3.13"], commands: [{ name: "tests", run: "pytest -q", cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }], no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] } };
  const unit = { id: "U01", path: "src/app.py", phase: "codegen", import_line: "", exports: [], behaviour: "answers ping", depends_on: [], style_from: { reason: "first file" }, covers: ["FR-1"], tests: [], approx_lines: 20 };
  const hands = async (thinking) => {
    const tools = new ThinkingTools(JSON.parse(readFileSync(thinking.toolsConfig, "utf8")));
    await tools.call("submit_section", { name: "header.json", json: JSON.stringify(header) });
    await tools.call("submit_section", { name: "units-001.json", json: JSON.stringify([unit]) });
    assert.match(String((await tools.call("finalize", {})).result), /^finalized: 1 unit/);
    return { result: result({ result: { ...JSON.parse((await tools.call("status", {})).result), conversation_id: "c1" } }), events: [] };
  };
  const first = deps(AGENT, () => assert.fail("replaced"), { runToken: "tok-1", dispatch: async (packet, thinking) => hands(thinking) });
  assert.equal((await runThinkingStep(args(root, { role: "architect", intent: undefined, output_dir: "out" }), first.d)).route, "done");
  const spec = readFileSync(join(root, "out", "spec.json"), "utf8");
  const again = deps(AGENT, () => result(), { runToken: "tok-1" });
  const r = await runThinkingStep(args(root, { role: "architect", intent: undefined, output_dir: "out" }), again.d);
  assert.equal(r.route, "done", JSON.stringify(r));
  assert.equal(again.calls.dispatch.length, 0, "nothing was sent to Gemini");
  assert.equal(r.cost_usd, 0);
  assert.deepEqual(r.accepted, ["header.json", "units-001.json", "finalize"]);
  assert.equal(readFileSync(join(root, "out", "spec.json"), "utf8"), spec, "the finalized spec is left as it was");
  // A new pre-flight is a new run: its architect writes its own spec.
  const next = deps(AGENT, () => result(), { runToken: "tok-2" });
  await runThinkingStep(args(root, { role: "architect", intent: undefined, output_dir: "out" }), next.d);
  assert.equal(next.calls.dispatch.length, 1, "a new run's step goes to Gemini");
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

test("two review paths never share a step key, the same path always gets the same key, and a step without one keeps its role", () => {
  const key = (review_path) => stepKey({ role: "senior-reviewer", review_path });
  // Both read out_m1_review.json once every other character is made "_" (review: they shared one step's files).
  assert.notEqual(key("out/m1/review.json"), key("out/m1_review.json"));
  assert.notEqual(key("out/m1 review.json"), key("out/m1_review.json"));
  assert.match(key("out/m1/review.json"), /^senior-reviewer--out_m1_review\.json-[0-9a-f]{8}$/, "readable, with the path's own hash");
  assert.equal(key("out/m1/review.json"), key("out/m1/review.json"));
  assert.equal(key("./out/m1/review.json"), key("out/m1/review.json"), "another spelling of the same file is the same step");
  assert.equal(stepKey({ role: "architect" }), "architect");
  assert.equal(key(""), "senior-reviewer");
});

test("a second call of a step while it runs is refused at once; a lock left by a process that is gone is taken over", async () => {
  const root = project();
  let letGo;
  const held = new Promise((done) => { letGo = done; });
  const { d, calls } = deps(AGENT, () => result());
  // The first call's dispatch is in flight until the test lets it go.
  const first = runThinkingStep(args(root), { ...d, dispatch: async (packet, thinking) => { calls.dispatch.push({ packet, thinking }); await held; return { result: result(), events: [] }; } });
  while (calls.dispatch.length === 0) await new Promise((done) => setTimeout(done, 5));
  const started = Date.now();
  await assert.rejects(runThinkingStep(args(root), d), /the brownfield-architect step of run r1 is already running \(process \d+, since /);
  assert.ok(Date.now() - started < 1000, "refused at once, not after the first call");
  assert.equal(calls.dispatch.length, 1, "nothing was sent for the second call");
  const lock = join(root, ".sdlc", "runs", "r1", "thinking", "brownfield-architect.lock");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid, "the running call holds the step's lock");
  // Another step of the same run is not held by it.
  assert.equal((await runThinkingStep(args(root, { role: "brownfield-senior-reviewer" }), deps(AGENT, () => result()).d)).route, "done");
  letGo();
  assert.equal((await first).route, "done");
  assert.equal(existsSync(lock), false, "removed when the call returned");
  // A call that is refused once it holds the lock (an input that does not exist) leaves no lock behind.
  await assert.rejects(runThinkingStep(args(root, { inputs: [join(root, "no-such-brief.md")] }), d), /does not exist/);
  assert.equal(existsSync(lock), false);

  // A lock whose process is gone (a server stopped mid-step) is taken over, and removed when that call returns.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lock, JSON.stringify({ pid: gone, started_at: "2026-11-01T09:00:00.000Z", token: "left-behind" }) + "\n");
  const again = deps(AGENT, () => result());
  let holder;
  const r = await runThinkingStep(args(root), { ...again.d, dispatch: async (packet, thinking) => { holder = JSON.parse(readFileSync(lock, "utf8")); return again.d.dispatch(packet, thinking); } });
  assert.equal(r.route, "done");
  assert.equal(holder.pid, process.pid, "taken over by this call");
  assert.equal(existsSync(lock), false);
  // So is one that cannot be read, and one with this server's process id that no call of this server holds: an earlier
  // server had the same id (ids start again after a restart).
  writeFileSync(lock, "");
  assert.equal((await runThinkingStep(args(root), deps(AGENT, () => result()).d)).route, "done");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: "2026-11-01T09:00:00.000Z", token: "an-earlier-server" }) + "\n");
  assert.equal((await runThinkingStep(args(root), deps(AGENT, () => result()).d)).route, "done");
  assert.deepEqual(readdirSync(join(root, ".sdlc", "runs", "r1", "thinking")).filter((f) => /lock/.test(f)), [], "nothing of the lock is left behind");
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

// A git project with these files committed: the change check reads the disk as git sees it.
async function gitProject(files = {}) {
  const { execFileSync } = await import("node:child_process");
  const root = project();
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return root;
}
const put = (root, f, text = "changed\n") => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
// A step whose worker changes these project files while it runs.
const changing = (edit, over = {}) => deps(AGENT, () => { edit(); return result(over); }).d;

test("files git ignores (a test runner's cache) do not stop a step; a tracked file still does; outside git, nothing is ignored", async () => {
  const repo = await gitProject({ "src/a.ts": "export const a = 1;\n" });
  // pytest writes its cache with a .gitignore of "*" inside it, so git ignores the whole folder.
  const cache = () => { put(repo, ".pytest_cache/.gitignore", "*\n"); put(repo, ".pytest_cache/v/cache/nodeids", "[]\n"); };
  assert.equal((await runThinkingStep(args(repo), changing(cache))).route, "done", "a cache the project's own check wrote is not a change to the project");
  const source = await runThinkingStep(args(repo), changing(() => { cache(); put(repo, "src/a.ts", "export const a = 2;\n"); }));
  assert.equal(source.route, "stopped");
  assert.match(source.reason, /src\/a\.ts/);
  assert.doesNotMatch(source.reason, /pytest_cache/);
  // Outside git the worker's own inventory decides, and nothing says what is ignored.
  const plain = project();
  const step = (changes) => runThinkingStep(args(plain), deps(AGENT, () => result({ workspace_changes: changes })).d);
  assert.equal((await step([".pytest_cache/.gitignore", ".pytest_cache/v/cache/nodeids"])).route, "stopped", "with no git to say what is ignored, every change counts");
});

test("the change check sees what git sees: a build folder it does not ignore, a large file of the same size, any number of files", async () => {
  const root = await gitProject({ "src/a.ts": "export const a = 1;\n", "assets/model.bin": "a".repeat(3_000_000), ".gitignore": "node_modules/\n" });
  const reason = async (edit) => { const r = await runThinkingStep(args(root), changing(edit)); return r.route === "done" ? "done" : r.reason; };
  assert.equal(await reason(() => put(root, "node_modules/dep/index.js")), "done", "what git ignores is not the project's");
  assert.match(await reason(() => put(root, "build/release.js")), /build\/release\.js/);
  assert.match(await reason(() => put(root, "assets/model.bin", "b".repeat(3_000_000))), /assets\/model\.bin/, "a same-size change over 2 MB");
  // Past the walked inventory's 20,000 files.
  for (let i = 0; i < 20_050; i++) put(root, `data/f${i}.txt`, "x\n");
  assert.match(await reason(() => put(root, "data/f20049.txt", "y\n")), /data\/f20049\.txt/);
});

test("only the step's own hand-ins are spared: the code under review, the plugin's settings and the run's contract are checked", async () => {
  // /mmo:pass: the generated code lies inside the run's folder.
  const root = await gitProject({ "examples/s/passes/r1/src/app.ts": "export const app = 1;\n", ".sdlc/project.json": "{}\n" });
  const review = (edit) => runThinkingStep(args(root, { role: "senior-reviewer", intent: undefined, output_dir: "examples/s/passes/r1" }), changing(() => { put(root, "examples/s/passes/r1/review.json", "{}\n"); edit(); }));
  assert.equal((await review(() => {})).route, "done", "the review it handed in is its own");
  assert.match((await review(() => put(root, "examples/s/passes/r1/src/app.ts", "export const app = 2;\n"))).reason, /src\/app\.ts/);
  assert.match((await review(() => put(root, ".sdlc/project.json", "{\"default_policy\":\"x\"}\n"))).reason, /\.sdlc\/project\.json/);
  // Brownfield: the run's own folder is its records; the contract beside it is not.
  const bf = await gitProject({ ".sdlc/local/write-contract.json": "{}\n" });
  assert.equal((await runThinkingStep(args(bf), changing(() => put(bf, ".sdlc/runs/r1/change.sections/units-001.json", "[]\n")))).route, "done");
  assert.match((await runThinkingStep(args(bf), changing(() => put(bf, ".sdlc/local/write-contract.json", "{\"active\":false}\n")))).reason, /write-contract\.json/);
});

test("the run log the plugin writes during a step is the step's own: the log beside the run's telemetry, its rotated pieces, the run's own log; a file of that name elsewhere is not", async () => {
  // Live test of 0.10.1: the server's logger writes orchestrator.log beside the run's telemetry while the step runs
  // (log.ts configureSinks), and the change check stopped a step whose requirements were accepted, naming that log.
  const root = await gitProject({ "src/a.ts": "export const a = 1;\n" });
  const step = (edit, over = {}) => runThinkingStep(args(root, { role: "senior-reviewer", intent: undefined, output_dir: "examples/s/passes/r1", telemetry_path: "examples/s/passes/r1/telemetry.jsonl", ...over }), changing(() => { put(root, "examples/s/passes/r1/review.json", "{}\n"); edit(); }));
  const logs = () => {
    put(root, "examples/s/passes/r1/orchestrator.log", "MMO: thinking.start\n");
    put(root, "examples/s/passes/r1/orchestrator.log.1", "MMO: an older piece\n");
    put(root, "examples/s/passes/r1/orchestrator.log.rotating", "");
    put(root, ".sdlc/runs/r1/orchestrator.log", "MMO: the run's own log\n");
    put(root, ".sdlc/local/debug.log", "MMO: the debug log the logger falls back to\n");
    put(root, ".sdlc/local/debug.log.2", "MMO: an older piece of it\n");
  };
  assert.equal((await step(logs)).route, "done", "the plugin's own logs are not the project's");
  // Telemetry kept outside the run's folder: the log beside it is the run's too.
  assert.equal((await step(() => put(root, "records/t/orchestrator.log", "MMO: x\n"), { telemetry_path: "records/t/telemetry.jsonl" })).route, "done");
  // A file of that name anywhere else is the project's.
  assert.match((await step(() => put(root, "src/orchestrator.log", "x\n"))).reason, /src\/orchestrator\.log/);
  assert.match((await step(() => put(root, "examples/s/passes/r1/orchestrator.log.bak", "x\n"))).reason, /orchestrator\.log\.bak/);
  assert.match((await step(() => put(root, ".sdlc/local/notes.log", "x\n"))).reason, /\.sdlc\/local\/notes\.log/, "the debug log alone, never its folder");
});

test("a run folder written ./out is the same folder; an operating system's own files are not the project's", async () => {
  const root = await gitProject({ "src/a.ts": "export const a = 1;\n" });
  // The worker's own inventory reports what it saw as well; both views must agree that these are no change.
  const req = (edit, seen) => runThinkingStep(args(root, { role: "requirements", intent: undefined, output_dir: "./out" }), changing(() => { put(root, "out/requirements.md", "# R\n"); edit(); }, { workspace_changes: ["out/requirements.md", ...seen] }));
  assert.equal((await req(() => {}, [])).route, "done", "its hand-in under ./out is its own");
  assert.equal((await req(() => { put(root, "src/.DS_Store", "\0"); put(root, "._notes.txt", "\0"); }, ["src/.DS_Store", "._notes.txt"])).route, "done", "Finder's files are not the project's");
});

test("a step halted by Google's busy window still names the project files that changed", async () => {
  const root = await gitProject({ "src/a.ts": "export const a = 1;\n" });
  const r = await runThinkingStep(args(root), changing(() => put(root, "src/a.ts", "export const a = 2;\n"), { success: false, halt: "Google could not serve gemini-4-argon: refused; no call of it was served for 300 s" }));
  assert.equal(r.route, "halt");
  assert.match(r.reason, /no call of it was served/);
  assert.match(r.reason, /src\/a\.ts/);
});

test("outside git the check is the worker's inventory, and the reply says it is partial", async () => {
  const r = await runThinkingStep(args(project()), deps(AGENT, () => result()).d);
  assert.equal(r.route, "done");
  assert.match(r.change_check, /not a git work tree/);
  const g = await runThinkingStep(args(await gitProject()), deps(AGENT, () => result()).d);
  assert.equal(g.change_check, "git");
});

test("a brownfield step's folder is its run's own records folder", async () => {
  const root = project();
  for (const output_dir of [".sdlc", ".sdlc/runs/OTHER", ".sdlc/runs"]) {
    await assert.rejects(runThinkingStep(args(root, { output_dir }), deps(AGENT, () => assert.fail("no dispatch")).d), /\.sdlc\/runs\/r1/, output_dir);
  }
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

// E-thinking-carry-on. Design §12: "a frozen worker is killed, and the step continues from its saved conversation".
// Review: a worker the agent door's kill rule stopped was not carried on; calling the step again started a new
// conversation at full cost, and what its tools had accepted was lost with their process.
const KILLED = "The agent worker was stopped: the worker sent no heartbeat for 82 s; its tokens are its last heartbeat's.";
const killed = (over = {}) => result({ success: false, worker_stopped: "killed", error: KILLED, result: { done: false, missing: ["units-001.json, accepted"], accepted: ["header.json"], conversation_id: "c-killed", answered: true }, attempts: [{ gemini: { work_ms: 600_000 } }], ...over });

test("a step whose worker the kill rule stopped is carried on once, from its saved conversation, with its tools' state and the rest of its budget", async () => {
  const root = project();
  // An earlier step's tools state, left in the step's folder: a new step never starts from it.
  mkdirSync(join(root, ".sdlc", "runs", "r1", "thinking"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "runs", "r1", "thinking", "brownfield-architect.state.json"), JSON.stringify({ accepted: [["header.json", true]], refused: [], written: [] }));
  const configs = [];
  const logged = [];
  const { d, calls } = deps(AGENT, (n, thinking) => {
    const cfg = JSON.parse(readFileSync(thinking.toolsConfig, "utf8"));
    configs.push({ ...cfg, state_there: existsSync(cfg.state_file) });
    return n === 1 ? killed() : result({ cost_usd: 0.05 });
  }, { log: (level, event, fields) => logged.push({ level, event, fields }) });
  const r = await runThinkingStep(args(root), d);
  assert.equal(r.route, "done", JSON.stringify(r));
  assert.equal(r.resumed, true, "the step carried on a saved conversation");
  assert.equal(calls.dispatch.length, 2);
  const [one, two] = calls.dispatch.map((c) => c.thinking);
  assert.equal(one.carryOn, false);
  assert.equal(one.timeoutSec, 14400);
  assert.equal(two.carryOn, true);
  assert.equal(two.resumeId, "c-killed", "the conversation the killed worker kept");
  assert.equal(two.timeoutSec, 14400 - 600, "what is left of the step's own work budget");
  assert.equal(configs[0].carry_on, false);
  assert.equal(configs[0].state_there, false, "a new step's tools start empty: the earlier state file is gone");
  assert.equal(configs[1].carry_on, true, "the carried-on tools load the killed ones' state");
  assert.equal(configs[1].state_file, configs[0].state_file);
  assert.equal(configs[0].state_file, join(root, ".sdlc", "runs", "r1", "thinking", "brownfield-architect.state.json"));
  assert.ok(Math.abs(r.cost_usd - 0.07) < 1e-9, `both dispatches' cost: ${r.cost_usd}`);
  assert.equal(calls.record.length, 2, "both dispatches' spend is recorded");
  const carry = logged.find((l) => l.event === "thinking.carry_on");
  assert.ok(carry, JSON.stringify(logged.map((l) => l.event)));
  assert.equal(carry.level, "warn");
  assert.match(carry.fields.reason, /no heartbeat for 82 s/);
});

test("a step killed again after it was carried on stops, saying so; a kill with nothing to carry on stops as before", async () => {
  const twice = deps(AGENT, () => killed());
  const r = await runThinkingStep(args(project()), twice.d);
  assert.equal(r.route, "stopped");
  assert.match(r.reason, /killed twice/);
  assert.match(r.reason, /no heartbeat for 82 s/);
  assert.deepEqual(r.missing, ["units-001.json, accepted"]);
  assert.equal(twice.calls.dispatch.length, 2, "carried on once only");
  for (const [why, answer] of [
    ["no saved conversation", killed({ result: { done: false, missing: ["units-001.json, accepted"], accepted: [], answered: true } })],
    ["no session of its own answered (its interrupted turn, a revise's comments, may not be saved)", killed({ result: { done: false, missing: ["units-001.json, accepted"], accepted: [], conversation_id: "c-killed", answered: false } })],
    ["no budget left", killed({ attempts: [{ gemini: { work_ms: 14_400_000 } }] })],
    ["no work time known", killed({ attempts: [] })],
    ["stopped by the request (the person pressed Stop)", killed({ worker_stopped: "cancelled" })],
    ["a worker that failed on its own", killed({ worker_stopped: undefined })],
  ]) {
    const one = deps(AGENT, () => answer);
    const s = await runThinkingStep(args(project()), one.d);
    assert.equal(s.route, "stopped", why);
    assert.equal(one.calls.dispatch.length, 1, why);
  }
  // A step whose worker changed a project file is stopped there, not carried on.
  const repo = await gitProject({ "src/a.ts": "export const a = 1;\n" });
  const changed = deps(AGENT, () => { put(repo, "src/a.ts", "export const a = 2;\n"); return killed(); });
  const c = await runThinkingStep(args(repo), changed.d);
  assert.equal(c.route, "stopped");
  assert.match(c.reason, /src\/a\.ts/);
  assert.equal(changed.calls.dispatch.length, 1);
});

test("through the agent door: a frozen worker is killed by the kill rule, and the step goes on in a new worker from its saved conversation", { timeout: 60_000 }, async () => {
  // Shortened kill rule: no heartbeat for 2 s on two checks 1 s apart, then SIGKILL 1 s after SIGTERM.
  const SHORT = { noBeatS: 2, confirmS: 1, termGraceS: 1 };
  // The worker's first session ends (its receipt: 1 s of work) and it keeps its summary after the status; its next
  // session beats once (30 s of its own work in all), then the worker freezes.
  const kept = { done: false, missing: ["units-001.json, accepted"], accepted: ["header.json"], conversation_id: "conv-1", answered: true, text: "" };
  const firstSession = { sdk_version: "0.1.22", vertex_location: "global", work_s: 1, usage: { prompt_token_count: 10 }, tries: [{ location: "global", ended_by: "answer", http_codes: [], s: 1, usage: { prompt_token_count: 10 } }] };
  const frozen = { writes: [{ atMs: 20, sidecar: firstSession, summary: kept }], beats: [{ atMs: 50, hb: beat({ work_s: 30, usage: { global: { prompt_token_count: 40 } } }) }], holdMs: "forever", ignoreTerm: true };
  const finishes = { holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, summary: { done: true, missing: [], accepted: ["header.json", "units-001.json"], conversation_id: "conv-1", text: "" } };
  const runStep = async (runs) => {
    const fake = fakeWorkerPython({ runs });
    const root = project();
    try {
      return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
        const door = new AntigravityWorkerAdapter({ id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" }, { backstop: SHORT });
        const { d } = deps(AGENT, () => assert.fail("dispatched through the agent door"), {
          dispatch: async (packet, thinking) => ({ result: await door.execute(packet, undefined, { project_root: root, work_dir: root, telemetry_path: join(root, "t.jsonl"), thinking }), events: [] }),
        });
        return { reply: await runThinkingStep(args(root), d), runs: fake.runs() };
      });
    } finally {
      for (const s of fake.runs()) if (alive(s.pid)) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } }
      fake.cleanup();
    }
  };
  const { reply, runs } = await runStep([frozen, finishes]);
  assert.equal(reply.route, "done", JSON.stringify(reply));
  assert.equal(reply.resumed, true);
  assert.equal(runs.length, 2);
  const [first, second] = runs;
  assert.equal(flagValue(first.args, "--timeout"), "14400");
  assert.equal(first.args.includes("--carry-on"), false);
  assert.equal(first.toolsConfig.carry_on, false);
  assert.equal(flagValue(second.args, "--resume-id"), "conv-1", "the conversation the frozen worker kept");
  assert.ok(second.args.includes("--carry-on"), "told to continue, not to start the task again");
  assert.equal(flagValue(second.args, "--timeout"), "14370", "the step's budget less the frozen worker's 30 s of work");
  assert.equal(second.toolsConfig.carry_on, true);
  // Frozen again after the carry-on: the step stops, naming the second kill.
  const again = await runStep([frozen]);
  assert.equal(again.reply.route, "stopped", JSON.stringify(again.reply));
  assert.match(again.reply.reason, /killed twice/);
  assert.match(again.reply.reason, /no heartbeat/);
  assert.equal(again.runs.length, 2, "carried on once only");
});

// E-thinking-frozen (design section 13, the fake-Google cases for a thinking step): the real thinking worker, its real
// tools and the SDK stand-in, under the agent door's own kill rule.
test("a frozen thinking worker is killed, and the step goes on from its saved conversation with what its tools accepted", { skip: NO_PYTHON, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frozen-thinking-"));
  // A greenfield architect: the first worker hands its header in, is told the units and finalize are still owed, and
  // freezes in its next session; the second worker, carried on, hands in the units and finalizes. Each worker the
  // engine starts reads its own script.
  const header = { stack: ["Python 3.13"], commands: [{ name: "tests", run: "pytest -q", cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }], no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] } };
  const unit = { id: "U01", path: "src/app.py", phase: "codegen", import_line: "", exports: [], behaviour: "answers ping", depends_on: [], style_from: { reason: "first file" }, covers: ["FR-1"], tests: [], approx_lines: 20 };
  const first = { sessions: [
    { turns: [[{ at: 0, step: standinStep.tool("submit_section", "ACTIVE", { name: "header.json", section_json: JSON.stringify(header) }, "h1") }, ...textAnswer(0, "Handed the header in.", { prompt_token_count: 10 })]] },
    { turns: [[{ at: 0.1, freeze: true }]] },
  ] };
  const second = { sessions: [{ turns: [[
    { at: 0, step: standinStep.tool("submit_section", "ACTIVE", { name: "units-001.json", section_json: JSON.stringify([unit]) }, "u1") },
    { at: 0, step: standinStep.tool("finalize", "ACTIVE", {}, "f1") },
    ...textAnswer(0, "Finalized.", { prompt_token_count: 10 }),
  ]] }] };
  writeFileSync(join(dir, "script-1.json"), JSON.stringify(first));
  writeFileSync(join(dir, "script-2.json"), JSON.stringify(second));
  const log = join(dir, "standin.jsonl");
  const python = join(dir, "python");
  writeFileSync(python, `#!/bin/sh\nn=$(cat ${JSON.stringify(join(dir, "count"))} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${JSON.stringify(join(dir, "count"))}\nexport PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(STANDIN)} AGY_STANDIN_SCRIPT=${JSON.stringify(dir)}/script-$n.json AGY_STANDIN_LOG=${JSON.stringify(log)}\nexec ${JSON.stringify(PYTHON)} "$@"\n`);
  chmodSync(python, 0o755);
  const root = project();
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: answer ping.\n");
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    const reply = await withEnv({ GEMINI_WORKER_PYTHON: python, GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
      // The kill rule, shortened: no heartbeat for 4 s on two checks 2 s apart, then SIGKILL 1 s after SIGTERM.
      const door = new AntigravityWorkerAdapter({ id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" }, { backstop: { noBeatS: 4, confirmS: 2, termGraceS: 1 } });
      const { d } = deps(AGENT, () => assert.fail("dispatched through the agent door"), {
        dispatch: async (packet, thinking) => ({ result: await door.execute(packet, undefined, { project_root: root, work_dir: root, telemetry_path: join(root, "t.jsonl"), thinking }), events: [] }),
      });
      return runThinkingStep(args(root, { role: "architect", intent: undefined, output_dir: "out" }), d);
    });
    assert.equal(reply.route, "done", JSON.stringify(reply));
    assert.equal(reply.resumed, true);
    assert.deepEqual(reply.accepted, ["header.json", "units-001.json", "finalize"]);
    const seen = events();
    const pids = [...new Set(seen.filter((e) => e.ev === "agent").map((e) => e.pid))];
    assert.equal(pids.length, 2, "two workers: the frozen one and the one carried on");
    assert.ok(seen.some((e) => e.ev === "freeze" && e.pid === pids[0]), "the first worker froze");
    assert.equal(alive(pids[0]), false, "the frozen worker was killed");
    const later = seen.filter((e) => e.pid === pids[1]);
    assert.equal(later.find((e) => e.ev === "agent").conversation_id, "standin-1", "the conversation the frozen worker kept");
    assert.equal(later.find((e) => e.ev === "chat").message, "Please continue the task you were working on.");
    assert.deepEqual(later.filter((e) => e.ev === "tool_run").map((e) => e.name), ["submit_section", "finalize"], "only what was still owed is handed in again");
    assert.match(later.find((e) => e.ev === "tool_run").result, /accepted units-001\.json/);
    assert.ok(existsSync(join(root, "out", "spec.json")), "the spec was finalized");
  } finally {
    for (const e of events()) if (alive(e.pid)) { try { process.kill(e.pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
