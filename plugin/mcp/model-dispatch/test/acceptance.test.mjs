/**
 * The acceptance stage: code runs every command of the plan's acceptance list in the code directory, keeps the
 * whole output, applies each command's pass rule, and marks every acceptance criterion pass, fail or not checked.
 * The plan must give every criterion a command or a stated reason, and name the stack's dependency audit.
 * Temp directories and short local node scripts; no model calls, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SPEC_HEADER_SCHEMA, validate } from "../dist/spec/schema.js";
import { submitSpecSection, finalizeSpec } from "../dist/spec/store.js";
import { runAcceptance, commandEnv, programOf, ACCEPTANCE_RECHECKS, NOT_FOUND_EXIT } from "../dist/executor/acceptance.js";
import { EXECUTOR_TOOLS, handleExecutorTool } from "../dist/executor/tools.js";
import { RECEIPT_MAX_BYTES } from "../dist/executor/run.js";

/** A code directory holding the given files. */
function project(files) {
  const code = mkdtempSync(join(tmpdir(), "acc-code-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(code, dirname(p)), { recursive: true });
    writeFileSync(join(code, p), c);
  }
  return code;
}
const out = () => mkdtempSync(join(tmpdir(), "acc-out-"));
const node = (file) => `"${process.execPath}" ${file}`;
const cmd = (name, file, over = {}) => ({ name, run: node(file), cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 60, ...over });
const plan = (commands, extra = {}) => ({
  spec_version: "1", stack: [], commands, decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: [], ...extra,
});
const print = (...lines) => lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");
const WARN = "npm warn deprecated glob@7.2.3: Old versions of glob are not supported";

test("the plan's commands say what each is for, which criteria it checks and how it passes", () => {
  const good = {
    stack: [], decisions: [], shared: { conventions: [], data_model: [], api: [] },
    commands: [
      { name: "install", run: "tool install", cwd: ".", role: "install", checks: ["AC-1"], pass: { exit_code: 0, forbid_lines_starting_with: ["tool warn"] }, timeout_s: 600 },
      { name: "audit", run: "tool audit --level high", cwd: ".", role: "audit", checks: [], pass: { exit_code: 0 }, timeout_s: 120 },
      { name: "tests", run: "tool test", cwd: "backend", role: "check", checks: ["AC-2", "AC-3.1"], pass: { exit_code: 0 }, timeout_s: 900 },
    ],
    unchecked: [{ id: "AC-4", reason: "drag and drop in a browser; no browser on this machine" }],
  };
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, good), []);
  const bare = validate(SPEC_HEADER_SCHEMA, { ...good, commands: [{ name: "t", run: "x", cwd: "." }] }).map((e) => e.message).join(" | ");
  // The plan states each command's own time limit; no limit lives in code.
  for (const f of ["role", "checks", "pass", "timeout_s"]) assert.match(bare, new RegExp(`'${f}'`), `a command must state its ${f}`);
  assert.ok(validate(SPEC_HEADER_SCHEMA, { ...good, commands: [{ ...good.commands[0], timeout_s: 0 }] }).some((e) => e.path === "/commands/0/timeout_s"), "a time limit is at least one second");
  const wrong = validate(SPEC_HEADER_SCHEMA, { ...good, commands: [{ ...good.commands[0], role: "deploy", checks: ["FR-1"] }] });
  assert.ok(wrong.some((e) => e.path === "/commands/0/role"), "role is one of install, audit, check");
  assert.ok(wrong.some((e) => e.path === "/commands/0/checks/0"), "a command checks acceptance criteria only");
  assert.ok(validate(SPEC_HEADER_SCHEMA, { ...good, unchecked: [{ id: "AC-4" }] }).some((e) => /reason/.test(e.message)), "a criterion left unchecked needs its reason");
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, { ...good, no_audit_reason: "no third-party packages" }), []);
});

test("a command's folder must lie inside the code directory", () => {
  const header = (cwd) => ({ stack: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, commands: [{ name: "t", run: "x", cwd, role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 60 }] });
  for (const cwd of [".", "backend", "web/app"]) assert.equal(submitSpecSection(out(), { section: "header", header: header(cwd) }).ok, true, cwd);
  for (const cwd of ["../x", "/abs", "a/../../b"]) {
    const r = submitSpecSection(out(), { section: "header", header: header(cwd) });
    assert.equal(r.ok, false, cwd);
    assert.match(r.errors.map((e) => e.message).join(" "), /inside the code directory/);
  }
});

test("finalize refuses a plan that leaves an acceptance criterion without a command or a reason, or names no dependency audit", () => {
  const dir = out();
  const req = join(dir, "requirements.md");
  writeFileSync(req, "FR-1 add a note.\nAC-1 installs cleanly.\nAC-2 a note can be added.\n");
  const base = { stack: [], decisions: [], shared: { conventions: [], data_model: [], api: [] } };
  const install = { name: "install", run: "tool install", cwd: ".", role: "install", checks: ["AC-1"], pass: { exit_code: 0 }, timeout_s: 600 };
  submitSpecSection(dir, { section: "header", header: { ...base, commands: [install] } });
  const u = { id: "U01", path: "a.txt", phase: "codegen", import_line: "", exports: [], behaviour: "b", depends_on: [], style_from: { reason: "first" }, covers: ["FR-1", "AC-1", "AC-2"], tests: [], approx_lines: 1 };
  submitSpecSection(dir, { section: "units", units: [u] });
  const short = finalizeSpec(dir, req);
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing_acceptance, ["AC-2"]);
  assert.match(short.errors.map((e) => e.message).join(" "), /audit/);
  assert.equal(existsSync(join(dir, "spec.json")), false);

  const audit = { name: "audit", run: "tool audit", cwd: ".", role: "audit", checks: [], pass: { exit_code: 0 }, timeout_s: 120 };
  submitSpecSection(dir, { section: "header", header: { ...base, commands: [install, audit], unchecked: [{ id: "AC-2", reason: "needs a live mail server" }] } });
  const done = finalizeSpec(dir, req);
  assert.equal(done.ok, true, JSON.stringify(done));
  const design = readFileSync(done.design_path, "utf8");
  assert.match(design, /## Acceptance checks/);
  assert.match(design, /\| install \| install \| `tool install` \(in \.\) \| AC-1 \| exit code 0 \| 600 s \|/, "design.md shows each command's time limit");
  assert.match(design, /AC-2: no command could check this by running — needs a live mail server/);

  // A project with no dependency audit tool says why instead.
  const d2 = out();
  submitSpecSection(d2, { section: "header", header: { ...base, commands: [install], unchecked: [{ id: "AC-2", reason: "r" }], no_audit_reason: "no third-party packages" } });
  submitSpecSection(d2, { section: "units", units: [u] });
  assert.equal(finalizeSpec(d2, req).ok, true);
});

test("install: a clean run passes; lines the brief forbids fail it, quoted, and send it to the architect", async () => {
  const code = project({ "clean.js": print("added 3 packages"), "warn.js": print(WARN, "NPM WARN deprecated rimraf@3.0.2", "added 3 packages") });
  const install = (file) => cmd("install", file, { role: "install", checks: ["AC-1"], pass: { exit_code: 0, forbid_lines_starting_with: ["npm warn"] } });
  const noAudit = { no_audit_reason: "test" };

  const ok = await runAcceptance(plan([install("clean.js")], noAudit), { codeDir: code, outDir: out() });
  assert.deepEqual([ok.passed, ok.failed.length], [1, 0]);

  const o = out();
  const bad = await runAcceptance(plan([install("warn.js")], noAudit), { codeDir: code, outDir: o });
  assert.equal(bad.failed.length, 1);
  const f = bad.failed[0];
  assert.equal(f.route, "architect", "a version problem goes to the architect, who owns the versions");
  assert.match(f.reason, /2 output lines start with "npm warn"/, "matched without regard to case");
  assert.deepEqual(f.lines, [WARN, "NPM WARN deprecated rimraf@3.0.2"]);
  const results = JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8"));
  assert.deepEqual(results.criteria.map((c) => [c.id, c.verdict]), [["AC-1", "fail"]]);
});

test("a check that fails goes to a repair round; every criterion is marked pass, fail or not checked, and the table says so", async () => {
  const code = project({ "pass.js": print("14 passed"), "fail.js": print("1 failing: login returns 500") + "\nprocess.exit(1);" });
  const o = out();
  const r = await runAcceptance(plan([
    cmd("unit tests", "pass.js", { checks: ["AC-2"] }),
    cmd("api tests", "fail.js", { checks: ["AC-3"] }),
  ], { unchecked: [{ id: "AC-4", reason: "needs a browser" }], no_audit_reason: "test" }), { codeDir: code, outDir: o });
  assert.equal(r.failed.length, 1);
  assert.deepEqual([r.failed[0].command, r.failed[0].route], ["api tests", "repair"]);
  assert.match(r.failed[0].reason, /exit code 1, expected 0/);
  assert.ok(r.failed[0].lines.includes("1 failing: login returns 500"), "the end of the output travels with the failure");
  assert.deepEqual(r.not_checked, ["AC-4"]);
  const results = JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8"));
  assert.deepEqual(results.criteria.map((c) => [c.id, c.verdict]), [["AC-2", "pass"], ["AC-3", "fail"], ["AC-4", "not checked"]]);
  const table = readFileSync(join(o, "acceptance.md"), "utf8");
  assert.match(table, /^## Acceptance criteria \(checked by code\)/);
  assert.match(table, /\| AC-2 \| pass \| unit tests \|/);
  assert.match(table, /\| AC-3 \| fail \| api tests \| exit code 1, expected 0 \|/);
  assert.match(table, /\| AC-4 \| not checked \| — \| needs a browser \|/);
});

test("an install that does not finish stops the commands after it: they are reported as not run", async () => {
  const code = project({ "broken.js": print("ERESOLVE could not resolve") + "\nprocess.exit(2);", "t.js": "require('fs').writeFileSync('ran.txt','x');" });
  const o = out();
  const r = await runAcceptance(plan([
    cmd("install", "broken.js", { role: "install", checks: ["AC-1"] }),
    cmd("tests", "t.js", { checks: ["AC-2"] }),
  ], { no_audit_reason: "test" }), { codeDir: code, outDir: o });
  assert.equal(existsSync(join(code, "ran.txt")), false, "nothing after a failed install runs");
  assert.deepEqual(r.failed.map((f) => [f.command, f.route]), [["install", "architect"], ["tests", "repair"]]);
  assert.match(r.failed[1].reason, /not run: install did not finish/);
  const results = JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8"));
  assert.deepEqual(results.criteria.map((c) => c.verdict), ["fail", "fail"]);
});

test("the whole output is kept on disk, and the receipt stays small", async () => {
  const code = project({ "loud.js": "for (let i = 1; i <= 3000; i++) console.log('npm warn line ' + i);" });
  const o = out();
  const r = await runAcceptance(plan([cmd("install", "loud.js", { role: "install", pass: { exit_code: 0, forbid_lines_starting_with: ["npm warn"] } })], { no_audit_reason: "test" }), { codeDir: code, outDir: o });
  const log = readFileSync(r.failed[0].log_path, "utf8").trim().split("\n");
  assert.equal(log.length, 3000, "nothing filtered, nothing cut");
  assert.equal(log[2999], "npm warn line 3000");
  assert.match(r.failed[0].reason, /3000 output lines start with "npm warn"/);
  assert.ok(JSON.stringify(r).length <= RECEIPT_MAX_BYTES, `receipt ${JSON.stringify(r).length} bytes`);
  assert.equal(JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8")).commands[0].forbidden_count, 3000);
});

test("a command that runs past the plan's own time limit is stopped; its criteria are not checked, and nothing is routed for repair", async () => {
  const code = project({ "hang.js": "setTimeout(() => {}, 60000);" });
  const t0 = Date.now();
  const o = out();
  const r = await runAcceptance(plan([cmd("server check", "hang.js", { checks: ["AC-3"], timeout_s: 1 })], { no_audit_reason: "test" }), { codeDir: code, outDir: o });
  assert.ok(Date.now() - t0 < 10_000, "the process was stopped, not waited for");
  assert.deepEqual(r.failed, [], "a timeout is not a defect to fix");
  assert.match(r.not_run[0].reason, /stopped at the plan's time limit \(1 s\)/);
  assert.deepEqual(r.not_checked, ["AC-3"]);
  const results = JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8"));
  assert.deepEqual(results.criteria.map((c) => [c.id, c.verdict]), [["AC-3", "not checked"]]);
  assert.match(readFileSync(join(o, "acceptance.md"), "utf8"), /\| server check \| check \| not run: not run to the end: stopped at the plan's time limit/);
});

test("a command whose program the shell cannot find (exit 127) is not run: its criteria are not checked with that reason, and it is never sent for repair", async () => {
  assert.equal(NOT_FOUND_EXIT, 127, "POSIX: the shell's exit status for a command it cannot find");
  assert.equal(programOf("FOO=1 npm run build"), "npm");
  const code = project({ "ok.js": print("ok") });
  const o = out();
  const r = await runAcceptance(plan([
    { name: "frontend build", run: "no-such-tool-xyz run build", cwd: ".", role: "check", checks: ["AC-6"], pass: { exit_code: 0 }, timeout_s: 30 },
    cmd("backend tests", "ok.js", { checks: ["AC-2"] }),
  ], { no_audit_reason: "test" }), { codeDir: code, outDir: o });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.not_run.map((n) => n.command), ["frontend build"]);
  assert.match(r.not_run[0].reason, /command not found \(exit code 127 from the shell\): no-such-tool-xyz/);
  const results = JSON.parse(readFileSync(join(o, "acceptance.json"), "utf8"));
  assert.deepEqual(results.criteria.map((c) => [c.id, c.verdict]), [["AC-6", "not checked"], ["AC-2", "pass"]]);
  assert.match(results.criteria[0].evidence, /command not found/);
});

test("an install the machine cannot run (its program not found) leaves every command after it not run and their criteria not checked; an install that ran and failed still fails them", async () => {
  const code = project({ "t.js": "require('fs').writeFileSync('ran.txt','x');" });
  const o = out();
  const r = await runAcceptance(plan([
    { name: "install", run: "no-such-pm-xyz install", cwd: ".", role: "install", checks: ["AC-1"], pass: { exit_code: 0 }, timeout_s: 30 },
    cmd("tests", "t.js", { checks: ["AC-2"] }),
  ], { no_audit_reason: "test" }), { codeDir: code, outDir: o });
  assert.equal(existsSync(join(code, "ran.txt")), false);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.not_checked, ["AC-1", "AC-2"]);
  assert.match(r.not_run[1].reason, /could not run on this machine/);
});

test("a plan command with no time limit is not run, and says so; no limit is guessed", async () => {
  const code = project({ "ok.js": print("ok") });
  const c = cmd("tests", "ok.js", { checks: ["AC-2"] });
  delete c.timeout_s;
  const r = await runAcceptance(plan([c], { no_audit_reason: "test" }), { codeDir: code, outDir: out() });
  assert.deepEqual(r.not_checked, ["AC-2"]);
  assert.match(r.not_run[0].reason, /states no time limit/);
});

test("the model vendors' credentials the plugin uses never reach a product command", async () => {
  const env = commandEnv({ PATH: "/bin", HOME: "/h", NPM_CONFIG_REGISTRY: "r", ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_OAUTH_TOKEN: "o", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/c.json" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NPM_CONFIG_REGISTRY", "PATH"]);
  const code = project({ "leak.js": "console.log('key=' + (process.env.ANTHROPIC_API_KEY ?? 'none'));" });
  const o = out();
  await runAcceptance(plan([cmd("tests", "leak.js")], { no_audit_reason: "test" }), { codeDir: code, outDir: o, env: { ...process.env, ANTHROPIC_API_KEY: "secret-value" } });
  const logs = readdirSync(join(o, "acceptance", "round-1"));
  assert.match(readFileSync(join(o, "acceptance", "round-1", logs[0]), "utf8"), /^key=none$/m);
});

test("a folder outside the code directory is never run in", async () => {
  const code = project({ "t.js": "require('fs').writeFileSync('ran.txt','x');" });
  const r = await runAcceptance(plan([cmd("tests", "t.js", { cwd: "../", checks: ["AC-2"] })], { no_audit_reason: "test" }), { codeDir: code, outDir: out() });
  assert.match(r.failed[0].reason, /outside the code directory/);
  assert.equal(existsSync(join(dirname(code), "ran.txt")), false);
});

test("at most three re-checks after the first run: the last is final and a further call runs nothing", async () => {
  assert.equal(ACCEPTANCE_RECHECKS, 3);
  const code = project({ "fail.js": "process.exit(1);" });
  const o = out();
  const p = plan([cmd("tests", "fail.js", { checks: ["AC-2"] })], { no_audit_reason: "test" });
  const seen = [];
  for (let i = 0; i < 4; i++) { const r = await runAcceptance(p, { codeDir: code, outDir: o }); seen.push([r.round, r.rechecks_left, r.final]); }
  assert.deepEqual(seen, [[1, 3, false], [2, 2, false], [3, 1, false], [4, 0, true]]);
  const fifth = await runAcceptance(p, { codeDir: code, outDir: o });
  assert.match(fifth.refused, new RegExp(`${ACCEPTANCE_RECHECKS} re-checks`));
  assert.equal(fifth.final, true);
  assert.equal(existsSync(join(o, "acceptance", "round-5")), false, "nothing was run");
});

test("the acceptance count belongs to one spec: another spec in the same folder starts at run 1, and the earlier spec's results are kept under previous/", async () => {
  const code = project({ "fail.js": "process.exit(1);", "ok.js": print("ok") });
  const o = out();
  const first = plan([cmd("tests", "fail.js", { checks: ["AC-2"] })], { no_audit_reason: "test" });
  for (let i = 0; i < 1 + ACCEPTANCE_RECHECKS; i++) await runAcceptance(first, { codeDir: code, outDir: o });
  assert.match((await runAcceptance(first, { codeDir: code, outDir: o })).refused, /already ran/);

  const second = plan([cmd("tests", "ok.js", { checks: ["AC-1"] })], { no_audit_reason: "test" });
  const r = await runAcceptance(second, { codeDir: code, outDir: o });
  assert.equal(r.refused, undefined, JSON.stringify(r));
  assert.deepEqual([r.round, r.rechecks_left, r.final, r.passed], [1, ACCEPTANCE_RECHECKS, false, 1]);
  assert.doesNotMatch(readFileSync(join(o, "acceptance.md"), "utf8"), /AC-2/, "the table is the new spec's alone");
  const kept = readdirSync(join(o, "previous"));
  assert.equal(kept.length, 1);
  assert.match(readFileSync(join(o, "previous", kept[0], "acceptance.md"), "utf8"), /AC-2/, "the earlier table is kept");
  assert.ok(existsSync(join(o, "previous", kept[0], "acceptance", `round-${1 + ACCEPTANCE_RECHECKS}`)), "with its logs");
  assert.equal((await runAcceptance(second, { codeDir: code, outDir: o })).round, 2, "the new spec counts on from its own first run");
});

test("the same brief run twice into one folder: the second run's spec starts its acceptance count at 1", async () => {
  const code = project({ "fail.js": "process.exit(1);" });
  const o = out();
  const req = join(o, "requirements.md");
  writeFileSync(req, "FR-1 add a note.\nAC-1 the tests pass.\n");
  const header = { stack: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, no_audit_reason: "test", commands: [cmd("tests", "fail.js", { checks: ["AC-1"] })] };
  const u = { id: "U01", path: "app.js", phase: "codegen", import_line: "", exports: [], behaviour: "b", depends_on: [], style_from: { reason: "first" }, covers: ["FR-1", "AC-1"], tests: [], approx_lines: 1 };
  const oneRun = async () => {
    assert.equal(submitSpecSection(o, { section: "header", header }).ok, true);
    assert.equal(submitSpecSection(o, { section: "units", units: [u] }).ok, true);
    const f = finalizeSpec(o, req);
    assert.equal(f.ok, true);
    return JSON.parse(readFileSync(f.spec_path, "utf8"));
  };
  const spec1 = await oneRun();
  for (let i = 0; i < 1 + ACCEPTANCE_RECHECKS; i++) await runAcceptance(spec1, { codeDir: code, outDir: o });
  const spec2 = await oneRun();
  const r = await runAcceptance(spec2, { codeDir: code, outDir: o });
  assert.equal(r.refused, undefined, JSON.stringify(r));
  assert.equal(r.round, 1);
});

test("execute_stage runs the acceptance stage with no model and no pre-flight, and its description says so", async () => {
  const stage = EXECUTOR_TOOLS.find((t) => t.name === "execute_stage");
  assert.ok(stage.inputSchema.properties.stage.enum.includes("acceptance"));
  assert.match(stage.description, /acceptance/);
  const code = project({ "ok.js": print("ok") });
  const o = out();
  writeFileSync(join(o, "spec.json"), JSON.stringify(plan([cmd("tests", "ok.js", { checks: ["AC-1"] })], { no_audit_reason: "test" })));
  const reply = await handleExecutorTool("execute_stage", { spec_path: join(o, "spec.json"), stage: "acceptance", code_dir: code }, { overrides: {} });
  const r = JSON.parse(reply.content[0].text);
  assert.equal(r.stage, "acceptance", JSON.stringify(r));
  assert.equal(r.passed, 1);
  assert.equal(existsSync(join(o, "acceptance.md")), true, "written beside spec.json");
});
