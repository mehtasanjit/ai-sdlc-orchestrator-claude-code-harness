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
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
