/**
 * The executor guard: once an orchestrator has called execute_stage (a greenfield executor run),
 * that orchestrator hires only the pipeline's own helpers and writes only its run's record folder, never a
 * code folder inside it — it reads a failing check's output itself, and every change to the project's files
 * goes through the typist.
 * An orchestrator that never called execute_stage (every brownfield run) and the main chat are untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { record, decide, MARKER } from "../../plugin/scripts/executor-guard.mjs";

const project = () => mkdtempSync(join(tmpdir(), "guard-"));
const stageCall = (agent_id, spec_path = ".sdlc/spec.json") => ({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_mmo_model-dispatch__execute_stage", tool_input: { stage: "codegen", spec_path }, ...(agent_id ? { agent_id, agent_type: "mmo:orchestrator" } : {}) });
const agentCall = (agent_id, subagent_type) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type, prompt: "x" }, ...(agent_id ? { agent_id, agent_type: "mmo:orchestrator" } : {}) });
const writeCall = (agent_id, file_path, tool_name = "Write") => ({ hook_event_name: "PreToolUse", tool_name, tool_input: tool_name === "NotebookEdit" ? { notebook_path: file_path } : { file_path, content: "x" }, ...(agent_id ? { agent_id, agent_type: "mmo:orchestrator" } : {}) });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("an orchestrator's execute_stage call marks it as an executor-run orchestrator, with its run's record folder; the main chat's call marks nothing", () => {
  const dir = project();
  record(stageCall(undefined), dir);
  assert.equal(existsSync(join(dir, MARKER)), false);
  record(stageCall("orch-1"), dir);
  const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")).agents["orch-1"];
  assert.deepEqual(m.record_dirs, [join(dir, ".sdlc")]);
  // a second run (another spec) by the same orchestrator adds its folder
  record(stageCall("orch-1", join(dir, "examples/x/passes/p1/.sdlc/spec.json")), dir);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, MARKER), "utf8")).agents["orch-1"].record_dirs, [join(dir, ".sdlc"), join(dir, "examples/x/passes/p1/.sdlc")]);
});

test("the executor orchestrator may hire only the pipeline's own helpers: general-purpose and Explore are refused with the way to go instead", () => {
  const dir = project();
  record(stageCall("orch-1"), dir);
  for (const t of ["general-purpose", "Explore", "some-other-agent"]) {
    const out = decide(agentCall("orch-1", t), dir);
    assert.ok(denied(out), t);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Read the failing check's output yourself, then send each file to change to execute_stage with stage "repair"/);
  }
  for (const t of ["mmo:architect", "mmo:senior-reviewer", "mmo:security-reviewer", "senior-reviewer", "mmo:discovery"]) assert.equal(decide(agentCall("orch-1", t), dir), null, t);
});

test("the executor orchestrator writes only inside its own run's record folder: a project file, a `.sdlc` inside the product, or another run's folder, by Write, Edit or NotebookEdit, is refused", () => {
  const dir = project();
  record(stageCall("orch-1"), dir);
  for (const [p, tool] of [[join(dir, "src/package.json"), "Edit"], ["src/app.ts", "Write"], [join(dir, "src/n.ipynb"), "NotebookEdit"], [join(dir, "src/.sdlc/notes.md"), "Write"], [join(dir, "examples/x/passes/p1/.sdlc/notes.md"), "Write"]]) {
    const out = decide(writeCall("orch-1", p, tool), dir);
    assert.ok(denied(out), `${tool} ${p}`);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /typist/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /record folder/);
  }
  for (const p of [join(dir, ".sdlc/local/state.json"), ".sdlc/SUMMARY.md", ".sdlc/acceptance/notes.md"]) assert.equal(decide(writeCall("orch-1", p), dir), null, p);
  // a /mmo:pass run records its own folder and may write there
  record(stageCall("orch-2", join(dir, "examples/x/passes/p1/.sdlc/spec.json")), dir);
  assert.equal(decide(writeCall("orch-2", join(dir, "examples/x/passes/p1/.sdlc/notes.md")), dir), null);
  assert.ok(denied(decide(writeCall("orch-2", join(dir, ".sdlc/notes.md")), dir)), "another run's folder");
});

test("untouched: another orchestrator (a brownfield run never calls execute_stage), the helpers, and the main chat", () => {
  const dir = project();
  record(stageCall("orch-1"), dir);
  assert.equal(decide(agentCall("orch-2", "general-purpose"), dir), null, "another orchestrator");
  assert.equal(decide(writeCall("orch-2", "src/app.ts"), dir), null);
  assert.equal(decide(agentCall(undefined, "general-purpose"), dir), null, "the main chat");
  assert.equal(decide(writeCall(undefined, "src/app.ts"), dir), null);
  const fresh = project();
  assert.equal(decide(agentCall("orch-1", "general-purpose"), fresh), null, "no executor run in this project");
});

test("a tool the guard does not govern passes; an unreadable marker fails open (the guard never breaks a session)", () => {
  const dir = project();
  record(stageCall("orch-1"), dir);
  assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, agent_id: "orch-1" }, dir), null);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "orch-1" }, dir), null);
  // A damaged marker file is read as "no executor run recorded": the write passes rather than breaking the session.
  writeFileSync(join(dir, MARKER), "{ not json");
  assert.equal(decide(writeCall("orch-1", "src/a.ts"), dir), null);
});

test("the record folder is compared by its real location: a new file there is allowed however its path is spelled", () => {
  const base = realpathSync(project());
  const real = join(base, "proj");
  const link = join(base, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  // The project folder reached through a symlink (as /tmp is on macOS), the write through the real path.
  record(stageCall("orch-1"), link);
  for (const p of [join(real, ".sdlc", "SUMMARY.md"), join(real, ".sdlc", "acceptance", "round-2", "notes.md"), join(link, ".sdlc", "SUMMARY.md")]) {
    assert.equal(existsSync(p), false, `${p} is a new file`);
    assert.equal(decide(writeCall("orch-1", p), link), null, p);
  }
  assert.ok(denied(decide(writeCall("orch-1", join(real, "src", "new.ts")), link)), "a project file through the real path");
  // The other way round: recorded through the real path, written through the symlink.
  record(stageCall("orch-2"), real);
  assert.equal(decide(writeCall("orch-2", join(link, ".sdlc", "SUMMARY.md")), real), null);
  assert.ok(denied(decide(writeCall("orch-2", join(link, "src", "new.ts")), real)));
  // A symlink inside the record folder that leads to the product is judged by where it leads.
  mkdirSync(join(real, "src"));
  symlinkSync(join(real, "src"), join(real, ".sdlc", "into-src"));
  assert.ok(denied(decide(writeCall("orch-2", join(real, ".sdlc", "into-src", "app.ts")), real)), "a write through a symlink out of the record folder");
});

// /mmo:pass keeps its record in <output_dir> and the product in <output_dir>/src, so the record folder holds the product.
const passCall = (agent_id, out, code_dir = `${out}src/`, stage = "codegen") => ({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_mmo_model-dispatch__execute_stage", tool_input: { stage, spec_path: `${out}spec.json`, code_dir }, agent_id, agent_type: "mmo:orchestrator" });

test("a run whose code folder sits inside its record folder: the orchestrator writes its record there, never the product", () => {
  const dir = project();
  const out = "examples/s/passes/r/";
  record(passCall("orch-1", out), dir);
  for (const p of [`${out}SUMMARY.md`, join(dir, out, "acceptance", "notes.md"), `${out}srcnotes.md`]) assert.equal(decide(writeCall("orch-1", p), dir), null, p);
  for (const [p, tool] of [[`${out}src/app.js`, "Write"], [join(dir, out, "src", "lib", "a.ts"), "Edit"], [`${out}src/package.json`, "MultiEdit"], [`${out}src/n.ipynb`, "NotebookEdit"], [`${out}src`, "Write"], ["src/app.js", "Write"]]) {
    const out2 = decide(writeCall("orch-1", p, tool), dir);
    assert.ok(denied(out2), `${tool} ${p}`);
    assert.match(out2.hookSpecificOutput.permissionDecisionReason, /typist/);
    assert.match(out2.hookSpecificOutput.permissionDecisionReason, /record folder/);
  }
  assert.match(decide(writeCall("orch-1", `${out}src/app.js`), dir).hookSpecificOutput.permissionDecisionReason, /examples\/s\/passes\/r\/src/);
  const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")).agents["orch-1"];
  assert.deepEqual(m.record_dirs, [join(dir, out.slice(0, -1))]);
  assert.deepEqual(m.code_dirs, [join(dir, out, "src")]);
});

test("the code folder is compared by its real location, and a code folder named by a later call is added", () => {
  const base = realpathSync(project());
  const real = join(base, "proj");
  const link = join(base, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  const out = "examples/s/passes/r/";
  // An entry recorded before code folders were kept: the next call names one and it is added.
  mkdirSync(join(real, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(real, MARKER), JSON.stringify({ agents: { "orch-1": { since: "t", record_dirs: [join(link, out.slice(0, -1))] } } }));
  assert.equal(decide(writeCall("orch-1", join(real, out, "src", "app.js")), link), null, "no code folder recorded yet: as before");
  record(passCall("orch-1", out), link);
  assert.deepEqual(JSON.parse(readFileSync(join(real, MARKER), "utf8")).agents["orch-1"].code_dirs, [join(link, out, "src")]);
  assert.ok(denied(decide(writeCall("orch-1", join(real, out, "src", "app.js")), link)), "the product through the real path");
  assert.equal(decide(writeCall("orch-1", join(real, out, "SUMMARY.md")), link), null);
  // The same code folder again adds nothing; a second one is kept beside it.
  record(passCall("orch-1", out, `${out}src`, "repair"), link);
  record(passCall("orch-1", out, `${out}web/`, "repair"), link);
  assert.deepEqual(JSON.parse(readFileSync(join(real, MARKER), "utf8")).agents["orch-1"].code_dirs, [join(link, out, "src"), join(link, out, "web")]);
  assert.ok(denied(decide(writeCall("orch-1", join(link, out, "web", "index.html")), link)));
  // A symlink in the record folder that leads into the product is judged by where it leads.
  mkdirSync(join(real, out, "src"), { recursive: true });
  symlinkSync(join(real, out, "src"), join(real, out, "into-src"));
  assert.ok(denied(decide(writeCall("orch-1", join(real, out, "into-src", "app.js")), link)));
});

test("a code folder that is or holds the record folder never takes the record folder away", () => {
  const dir = project();
  // Greenfield: the product in ./src beside ./.sdlc.
  record({ ...stageCall("orch-1"), tool_input: { stage: "codegen", spec_path: ".sdlc/spec.json", code_dir: "./src" } }, dir);
  assert.equal(decide(writeCall("orch-1", ".sdlc/SUMMARY.md"), dir), null);
  assert.ok(denied(decide(writeCall("orch-1", "src/app.ts"), dir)));
  // The project folder itself as the code folder: the record folder inside it stays writable.
  record({ ...stageCall("orch-2"), tool_input: { stage: "codegen", spec_path: ".sdlc/spec.json", code_dir: "." } }, dir);
  assert.equal(decide(writeCall("orch-2", ".sdlc/acceptance/notes.md"), dir), null);
  assert.ok(denied(decide(writeCall("orch-2", "app.ts"), dir)));
  // The record folder named as the code folder: nothing tells the record from the product, so the record folder stays writable.
  record(passCall("orch-3", "out/", "out"), dir);
  assert.equal(decide(writeCall("orch-3", "out/SUMMARY.md"), dir), null);
});
