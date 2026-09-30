/**
 * /mmo:greenfield runs the executor flow.
 *
 * /mmo:greenfield, the interactive command, must hand the orchestrator executor mode itself: without
 * it an interactive run takes the flow where the orchestrator writes every packet and receives every
 * file. These pins keep the interactive command on the executor flow; /mmo:pass keeps --executor as
 * its opt-in.
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(REPO, "plugin", ...p), "utf-8");

test("/mmo:greenfield hands the orchestrator executor mode", () => {
  const cmd = read("commands", "greenfield.md");
  const run = cmd.slice(cmd.indexOf("# 6. Run"), cmd.indexOf("# 7. Report"));
  assert.match(run, /`executor` — on/);
});

test("the pipeline skill and the orchestrator name both entry points of executor mode", () => {
  const skill = read("skills", "pipeline", "SKILL.md");
  assert.match(skill, /## Executor mode — greenfield: `\/mmo:greenfield` and `\/mmo:pass`/);
  const orch = read("agents", "orchestrator.md");
  assert.match(orch, /`\/mmo:greenfield` and `\/mmo:pass` always run it for a new app/);
});

test("/mmo:pass always runs executor mode for a greenfield brief: no flag chooses the flow", () => {
  const pass = read("commands", "pass.md");
  assert.doesNotMatch(pass, /--no-executor/, "a new app cannot be sent to the packet flow");
  assert.doesNotMatch(pass, /\[--executor\]/, "no flag is needed for executor mode");
  assert.match(pass, /`--executor` — accepted and changes nothing/, "old scripts that pass it keep working");
  for (const f of [["skills", "pipeline", "SKILL.md"], ["agents", "orchestrator.md"], ["commands", "greenfield.md"]]) assert.doesNotMatch(read(...f), /--no-executor/, f.join("/"));
});

// execute_stage writes every file under code_dir and Phase 9 counts the product there, so /mmo:pass must
// name it; otherwise each scripted run invents its own folder. It sits in the run folder's src/, where
// /mmo:pass runs have always put the product, apart from the run record files.
test("/mmo:pass names the code folder with its other output paths: src/ inside the run folder", () => {
  const pass = read("commands", "pass.md");
  const paths = pass.slice(pass.indexOf("**Output paths:**"), pass.indexOf("\n\n", pass.indexOf("**Output paths:**")));
  const value = (name) => paths.match(new RegExp("^- `" + name + "`: `([^`]+)`", "m"))?.[1];
  const outputDir = value("output_dir");
  const codeDir = value("code_dir");
  assert.ok(outputDir, "output_dir is among the output paths");
  assert.ok(codeDir, "code_dir is among the output paths");
  assert.equal(codeDir, `${outputDir}src/`, "the product goes in the run folder's src/");
  // Every setting the executor stage and Phase 9 take from the invoking command is named here.
  const skill = read("skills", "pipeline", "SKILL.md");
  assert.match(skill, /`spec_path: <output_dir>\/spec\.json`, `stage`, `code_dir`, `pass_id` and `telemetry_path`/);
  assert.match(skill, /write-manifest\.mjs" <output_dir> [^\n]*--code-dir <code_dir>/);
  for (const name of ["pass_id", "output_dir", "telemetry_path", "code_dir"]) assert.ok(value(name), `${name} is among /mmo:pass's output paths`);
});

// The acceptance stage: every acceptance criterion gets its verdict from a command code runs, and the
// report's table is code's, so no report can say "install clean" over warnings a fresh install prints.
const skill = read("skills", "pipeline", "SKILL.md");
const executorMode = skill.slice(skill.indexOf("## Executor mode"), skill.indexOf("\n## ", skill.indexOf("## Executor mode") + 5)).replace(/\s+/g, " ");

test("executor mode ends with the acceptance stage, after the security review and before Gate 3", () => {
  const flow = skill.slice(skill.indexOf("## Executor mode"), skill.indexOf("Rules for executor mode:"));
  assert.match(flow, /8\. security_review[\s\S]*8b\. execute_stage acceptance[\s\S]*── GATE 3/);
});

test("each acceptance failure goes where it can be fixed: versions to the architect, code to a repair round, then a re-check; at most three re-checks", () => {
  assert.match(executorMode, /`stage: "acceptance"`/);
  assert.match(executorMode, /`architect`[^.]*install or audit/);
  assert.match(executorMode, /"acceptance fix"/);
  assert.match(executorMode, /`repair` means a check failed \(code\): send it to `execute_stage` repair as a `failures` entry/);
  assert.match(executorMode, /three re-checks/);
  assert.match(executorMode, /Do not rerun, filter or re-judge the commands yourself/);
});

test("the report's acceptance table is the one code wrote; the orchestrator writes no pass/fail claims of its own", () => {
  assert.match(executorMode, /`<output_dir>\/acceptance\.md` is the report's acceptance table/);
  assert.match(executorMode, /the collector copies it into SUMMARY\.md/);
  assert.match(executorMode, /do not write your own pass\/fail statements/);
});

test("the orchestrator's executor-mode brief names the acceptance stage", () => {
  assert.match(read("agents", "orchestrator.md"), /`stage: "acceptance"`/);
});

// The orchestrator runs the spec's install and check commands itself and decides the fixes; code types every fix.
test("executor mode has the orchestrator run the checks after the tests stage and after the review's repair, and send the fixes to execute_stage repair", () => {
  const flow = skill.slice(skill.indexOf("## Executor mode"), skill.indexOf("Rules for executor mode:"));
  assert.match(flow, /4\. execute_stage tests[\s\S]*5\. test_run\s+→ the spec's install and check commands, run by you with Bash/);
  assert.match(flow, /execute_stage repair \(failures\)\s+→ one receipt; run the checks again/);
  assert.match(flow, /execute_stage repair \(review_paths\)\s+→ one receipt; run the checks once more/);
  assert.match(executorMode, /run the spec's install and check commands yourself with Bash/);
  assert.match(executorMode, /call `execute_stage` with `stage: "repair"` and `failures`/);
  assert.match(executorMode, /Repeat while the number of failing tests goes down, at most three repair rounds/);
});

test("no file the model reads, and no stage of the tool, offers a code-run check-and-fix stage", () => {
  for (const f of [["skills", "pipeline", "SKILL.md"], ["agents", "orchestrator.md"], ["agents", "architect.md"], ["agents", "senior-reviewer.md"], ["agents", "security-reviewer.md"], ["commands", "pass.md"], ["commands", "greenfield.md"]]) {
    const t = read(...f);
    assert.doesNotMatch(t, /stage: "verify"|execute_stage verify|verify_results_path|repair_rounds/, f.join("/"));
  }
  const tools = readFileSync(join(REPO, "plugin", "mcp", "model-dispatch", "src", "executor", "tools.ts"), "utf-8");
  assert.match(tools, /enum: \["codegen", "tests", "docs", "repair", "acceptance"\]/, "execute_stage's stages");
  assert.doesNotMatch(tools, /"verify"/);
});

test("the orchestrator reads a failing check's output itself: it never hires other helpers to diagnose and never writes a project file; a failure outside the project is told to the person", () => {
  assert.match(executorMode, /Read the failing output yourself: never start other helpers \(general-purpose,\s+Explore\) to investigate failures/);
  assert.match(executorMode, /You never write a project file yourself/);
  assert.match(executorMode, /A failure that is not in the project's files/);
  assert.match(executorMode, /tell the person that reason, with the command, at the next gate\. Do not change the project\s+to get around it/);
  assert.match(read("skills", "pipeline", "SKILL.md"), /write-manifest\.mjs/, "Phase 9 writes the manifest with the script");
  const orch = read("agents", "orchestrator.md");
  assert.match(orch, /which\s+you run yourself with Bash/);
  assert.match(orch, /executor guard refuses/);
});

test("brownfield keeps its own test step unchanged", () => {
  assert.match(skill, /7\. test_run {27}→ npm install && npm test; debug failures \(route via policy\)/);
  assert.match(skill, /### Phase 7 — test_run/);
  assert.match(skill, /The test command in brownfield is `baseline\.test_command`/);
});

const flat = (s) => s.replace(/\s+/g, " ");
const SRC = (...p) => readFileSync(join(REPO, "plugin", "mcp", "model-dispatch", "src", ...p), "utf-8");

// Pre-flight halts on a claude CLI that cannot run the executor's Claude typists only when it is told that
// execute_stage types this run. A brownfield run never uses that CLI, so it says false there and is not stopped.
test("pre-flight gets executor: true on every new-app run and executor: false on brownfield, and its notes are shown", () => {
  const orch = read("agents", "orchestrator.md");
  const rule0 = flat(orch.slice(orch.indexOf("0. **Pre-flight before anything else.**"), orch.indexOf("`auth_mode` is not optional here")));
  const phase = flat(skill.slice(skill.indexOf("## Phase -1"), skill.indexOf("\n---", skill.indexOf("## Phase -1"))));
  for (const [name, text] of [["orchestrator rule 0", rule0], ["pipeline Phase -1", phase]]) {
    assert.match(text, /`executor: true` on every new-app \(greenfield\) run/, name);
    assert.match(text, /`executor: false` on a brownfield run/, name);
    assert.match(text, /old or missing `claude` CLI halts pre-flight before any paid phase/, name);
    assert.match(text, /`policy_notes` \(when there are any\) and its `executor\.claude_cli`, one short line each/, name);
  }
  const flow = skill.slice(skill.indexOf("## Executor mode"), skill.indexOf("Rules for executor mode:"));
  assert.match(flow, /-1\. preflight_dispatch +\(with `executor: true`/);
  // The names the prompts use are the server's own.
  assert.match(SRC("server.ts"), /\n {10}executor: \{\n {12}type: "boolean",/, "preflight_dispatch takes executor");
  assert.match(SRC("server.ts"), /\n {4}policy_notes: policyNotes,\n {4}executor: cli\.check,/, "and returns policy_notes and executor");
  assert.match(SRC("preflight.ts"), /\n {2}claude_cli: string;/, "executor.claude_cli");
});

// After finalize_spec a header opens a new spec and the earlier one's records move aside (spec/store.ts), so a
// Gate 2 revise hands the whole spec over again; its units' ids and paths are free again.
test("on a Gate 2 revise the architect sends the header again, then every units file, then finalizes", () => {
  const arch = flat(read("agents", "architect.md"));
  const exec = arch.slice(arch.indexOf("# Executor mode"), arch.indexOf("# Brownfield mode"));
  assert.match(exec, /`revise:`[^.]* after `finalize_spec`/);
  assert.match(exec, /send the header section again first, then every units file in order \(the same ids and paths are accepted again\), then call `finalize_spec` again/);
  // No sentence forbids the re-submission a revise needs.
  for (const s of exec.split(/(?<=\.) /)) {
    if (/re-submit/.test(s) && /accepted/.test(s) && /never/i.test(s)) assert.match(s, /^Until `finalize_spec`/, s);
  }
  assert.match(executorMode, /On a Gate 2 `revise: <comments>`/);
  assert.match(executorMode, /sends the header section again first, then every units file \(the same ids and paths are accepted again\), then calls `finalize_spec`/);
});

// The spec store moves exactly these records aside when the new run's header arrives (SPEC_RECORDS); the other
// files in the run folder are written over as before.
test("/mmo:pass says an existing run folder's executor records move under previous/<time>/ and the rest is overwritten", () => {
  const pass = read("commands", "pass.md");
  const line = pass.split("\n").find((l) => l.startsWith("If `examples/<study-id>/passes/<run-id>/` already exists"));
  assert.ok(line, "the line about an existing run folder is there");
  assert.doesNotMatch(line, /its contents will be overwritten/);
  assert.match(line, /are moved under `<output_dir>\/previous\/<time>\/` when the new run's architect sends its header, and other files are overwritten/);
  const store = SRC("spec", "store.ts");
  const records = [...store.match(/SPEC_RECORDS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(records.length > 0);
  for (const r of records) assert.ok(line.includes(`\`${r}\``) || line.includes(`\`${r}/\``), `${r} is named`);
  assert.match(store, /PREVIOUS_DIR = "previous"/);
});
