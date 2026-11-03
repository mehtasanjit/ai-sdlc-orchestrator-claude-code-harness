/**
 * The Gemini thinking step's tools (plugin/scripts/thinking-tools.mjs). Pinned: every read goes through the engine's
 * read rule (credentials and links out of the project never reach the model), hand-ins write only their own fixed
 * paths and never through a link, a review is checked against the shape the repair stage reads, a role gets only its
 * own tools, and the step is done only when every piece it owes is accepted. Real temp folders; no model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { ThinkingTools } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs")).href);

function project() {
  const root = mkdtempSync(join(tmpdir(), "mmo-tools-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nconst token = 'x';\n");
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  return root;
}
const tools = (root, role, over = {}) => new ThinkingTools({ role, project_root: root, run_id: "r1", output_dir: ".sdlc/runs/r1", outputs: { requirements: ".sdlc/runs/r1/requirements.md", review: ".sdlc/runs/r1/review.json", security_review: ".sdlc/runs/r1/security_review.md", sections_dir: ".sdlc/runs/r1/change.sections" }, ...over });

test("credentials, paths outside the project and links out of it are never read", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "mmo-outside-"));
  writeFileSync(join(outside, "key"), "PRIVATE");
  symlinkSync(join(outside, "key"), join(root, "src", "link"));
  const t = tools(root, "requirements");
  assert.match((await t.call("read_file", { path: ".env" })).error, /off-limits/);
  assert.match((await t.call("read_file", { path: "../x" })).error, /outside the project/);
  assert.match((await t.call("read_file", { path: "src/link" })).error, /leads outside the project/);
  assert.match((await t.call("read_file", { path: "src/a.ts" })).result, /1\texport const a = 1;/);
});

test("search never reads the files the read rule keeps from models; a listing names them, marked, with nothing of theirs", async () => {
  const root = project();
  const t = tools(root, "requirements");
  const hits = (await t.call("search_files", { pattern: "SECRET|token" })).result;
  assert.match(hits, /src\/a\.ts:2/);
  assert.doesNotMatch(hits, /SECRET/);
  const listed = (await t.call("list_files", { path: "." })).result;
  assert.match(listed, /^\.env  \(kept from you by the read rule\)$/m);
  assert.doesNotMatch(listed, /hunter2/);
});

test("a role gets only its own tools", async () => {
  const root = project();
  const t = tools(root, "requirements");
  assert.match((await t.call("write_review", { content: "{}" })).error, /not a tool of the requirements step/);
  assert.match((await t.call("run_dependency_audit", { kind: "npm-audit" })).error, /not a tool/);
});

test("a hand-in writes its own fixed path, and never through a link", async () => {
  const root = project();
  const t = tools(root, "requirements");
  assert.match((await t.call("write_requirements", { content: "# Requirements\n" })).result, /wrote \.sdlc\/runs\/r1\/requirements\.md/);
  assert.equal(readFileSync(join(root, ".sdlc/runs/r1/requirements.md"), "utf8"), "# Requirements\n");
  const linked = project();
  symlinkSync(join(linked, "src"), join(linked, ".sdlc", "runs", "r2"));
  // The step's own folder is the link: its hand-in is refused, not written through it into src/.
  const t2 = tools(linked, "requirements", { run_id: "r2", output_dir: ".sdlc/runs/r2", outputs: { requirements: ".sdlc/runs/r2/requirements.md" } });
  assert.match((await t2.call("write_requirements", { content: "x" })).error, /is a link/);
  assert.equal(existsSync(join(linked, "src", "requirements.md")), false);
});

test("the senior review is checked against the findings shape the repair stage reads", async () => {
  const root = project();
  const t = tools(root, "brownfield-senior-reviewer");
  assert.match((await t.call("write_review", { content: "not json" })).error, /is JSON/);
  assert.match((await t.call("write_review", { content: '{"verdict":"ok"}' })).error, /findings array/);
  assert.match((await t.call("write_review", { content: '{"findings":[{"issue":"x"}]}' })).error, /findings\[0\] needs file and issue/);
  assert.match((await t.call("write_review", { content: '{"findings":[{"file":"src/a.ts","issue":"x","fix":"y"}]}' })).result, /wrote/);
});

test("the step is done only when every piece it owes is accepted", async () => {
  const root = project();
  const t = tools(root, "brownfield-architect");
  let s = JSON.parse((await t.call("status", {})).result);
  assert.equal(s.done, false);
  assert.deepEqual(s.missing, ["header.json, accepted", "at least one units file, accepted"]);
  assert.match((await t.call("write_section", { name: "notes.json", json: "{}" })).error, /name the section header\.json/);
  assert.match((await t.call("write_section", { name: "header.json", json: "{nope" })).error, /not valid JSON/);
  const r = tools(root, "requirements");
  await r.call("write_requirements", { content: "# R" });
  assert.equal(JSON.parse((await r.call("status", {})).result).done, true);
});

test("a dependency audit runs only its named commands", async () => {
  const root = project();
  const t = tools(root, "security-reviewer");
  assert.match((await t.call("run_dependency_audit", { kind: "rm -rf /" })).error, /kind is one of npm-audit, npm-outdated, pip-outdated/);
});

test("a Gemini architect's spec holds only its own run's units, as submit_spec_section's does", async () => {
  const { loadServerLib } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "server-lib.mjs")).href);
  const { specStore } = await loadServerLib();
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
  };
  const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour: `writes ${path}`, depends_on: [], style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });
  const architect = (root, run_token) => new ThinkingTools({ role: "architect", project_root: root, run_id: "r2", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", run_token });
  // An earlier run (its own pre-flight) handed in its header and one units file through the server, then stopped
  // before finalize: a crashed run, or a run id used again.
  const earlierRun = () => {
    const root = mkdtempSync(join(tmpdir(), "mmo-spec-"));
    const specDir = join(root, "out");
    mkdirSync(specDir);
    assert.equal(specStore.submitSpecSection(specDir, { section: "header", header }, { run: "earlier-run" }).ok, true);
    assert.equal(specStore.submitSpecSection(specDir, { section: "units", units: [unit("U01", "src/from_earlier_run.py")] }, { run: "earlier-run" }).ok, true);
    return root;
  };

  const root = earlierRun();
  const t = architect(root, "this-run");
  assert.match((await t.call("submit_section", { name: "header.json", json: JSON.stringify(header) })).result, /accepted header\.json: 0 unit/);
  assert.match((await t.call("submit_section", { name: "units-001.json", json: JSON.stringify([unit("U02", "src/todo.py")]) })).result, /1 unit/);
  // The same header again within the run keeps the run's units (a fix and a hand-in again, not a new spec).
  assert.match((await t.call("submit_section", { name: "header.json", json: JSON.stringify(header) })).result, /accepted header\.json: 1 unit/);
  assert.match((await t.call("finalize", {})).result, /finalized: 1 unit/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "out", "spec.json"), "utf8")).units.map((u) => u.path), ["src/todo.py"], "the earlier run's unit is not in this run's spec");

  // Units first, into the spec another run opened: refused, header first.
  const other = earlierRun();
  assert.match((await architect(other, "this-run").call("submit_section", { name: "units-001.json", json: JSON.stringify([unit("U02", "src/todo.py")]) })).error, /earlier run's spec/);
});

test("a revise keeps every unit of the approved spec, or removes one only by name; an unchanged section goes by its name alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-revise-"));
  mkdirSync(join(root, "out"));
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
  };
  const unit = (id, path, behaviour) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour, depends_on: [], style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });
  // Each run_thinking_step call is a new tools process; a revise is told so in its config.
  const architect = (revise) => new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", run_token: "run-1", revise });
  const hand = (t, name, value) => t.call("submit_section", { name, json: value === undefined ? "" : JSON.stringify(value) });
  const specUnits = () => JSON.parse(readFileSync(join(root, "out", "spec.json"), "utf8")).units.map((u) => `${u.id}: ${u.behaviour}`);

  const first = architect(false);
  await hand(first, "header.json", header);
  await hand(first, "units-001.json", [unit("U01", "backend/app/models.py", "the models")]);
  await hand(first, "units-002.json", [unit("U02", "backend/app/api.py", "the routes")]);
  assert.match((await first.call("finalize", {})).result, /finalized: 2 unit/);

  // The revise changes U02 only. Its header opens a new spec; U01 must go in again.
  const revise = architect(true);
  assert.match((await hand(revise, "header.json", header)).result, /accepted header\.json: 0 unit/);
  assert.match((await hand(revise, "units-002.json", [unit("U02", "backend/app/api.py", "the routes; 409 on a duplicate title")])).result, /1 unit/);
  const owed = JSON.parse((await revise.call("status", {})).result);
  assert.equal(owed.done, false);
  assert.ok(owed.missing.some((m) => /U01 \(backend\/app\/models\.py\) of the approved spec/.test(m)), owed.missing.join("; "));
  assert.match((await revise.call("finalize", {})).error, /U01 \(backend\/app\/models\.py\)/, "a revise that would drop an approved unit is not finalized");
  // The unchanged file goes again by its name alone, as it stands.
  assert.match((await hand(revise, "units-001.json")).result, /accepted units-001\.json: 2 unit/);
  assert.match((await hand(revise, "units-009.json")).error, /no units-009\.json/);
  assert.match((await revise.call("finalize", {})).result, /finalized: 2 unit/);
  assert.deepEqual(specUnits(), ["U02: the routes; 409 on a duplicate title", "U01: the models"]);
  assert.equal(JSON.parse((await revise.call("status", {})).result).done, true);

  // A revise that removes a unit names it.
  const removal = architect(true);
  await hand(removal, "header.json", header);
  await hand(removal, "units-001.json");
  assert.match((await removal.call("finalize", { drop: ["U01"] })).error, /drop names only/, "U01 is in this spec: it is not dropped");
  assert.match((await removal.call("finalize", { drop: ["U02"] })).result, /finalized: 1 unit.*removed from the approved spec: U02/);
  assert.deepEqual(specUnits(), ["U01: the models"]);

  // A first call (no revise) is a new design: nothing earlier holds it.
  const again = architect(false);
  await hand(again, "header.json", header);
  await hand(again, "units-002.json", [unit("U02", "backend/app/api.py", "the routes")]);
  assert.match((await again.call("finalize", {})).result, /finalized: 1 unit/);
});

test("an acceptance fix hands in its failures entries, or the one line why it cannot pass, and changes no spec section", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-fix-"));
  mkdirSync(join(root, "out"));
  const { loadServerLib } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "server-lib.mjs")).href);
  const { specStore } = await loadServerLib();
  const header = {
    stack: ["Node 22", "Express"], commands: [{ name: "audit", run: "npm audit --audit-level=high", cwd: ".", role: "audit", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] },
  };
  const unit = { id: "U01", path: "src/app.js", phase: "codegen", import_line: "", exports: [], behaviour: "the app", depends_on: [], style_from: { reason: "first file" }, covers: ["FR-1"], tests: [], approx_lines: 20 };
  assert.equal(specStore.submitSpecSection(join(root, "out"), { section: "header", header }, { run: "run-1" }).ok, true);
  assert.equal(specStore.submitSpecSection(join(root, "out"), { section: "units", units: [unit] }, { run: "run-1" }).ok, true);
  assert.equal(specStore.finalizeSpec(join(root, "out")).ok, true);
  const approved = readFileSync(join(root, "out", "spec.json"), "utf8");
  const fixer = () => new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { acceptance_fix: "out/acceptance-fix.json" }, spec_dir: "out", run_token: "run-1", acceptance_fix: true });

  const t = fixer();
  assert.match((await t.call("submit_section", { name: "header.json", json: JSON.stringify(header) })).error, /acceptance fix/);
  assert.match((await t.call("finalize", {})).error, /acceptance fix/);
  assert.deepEqual(JSON.parse((await t.call("status", {})).result).missing, ["the acceptance fix: its failures entries, or the one line why it cannot pass (write_acceptance_fix)"]);
  assert.match((await t.call("write_acceptance_fix", { failures_json: "[{nope" })).error, /not valid JSON/);
  assert.match((await t.call("write_acceptance_fix", { failures_json: "[]" })).error, /at least 1/);
  assert.match((await t.call("write_acceptance_fix", { failures_json: JSON.stringify([{ problem: "pin it" }]) })).error, /missing required field 'path'/);
  assert.match((await t.call("write_acceptance_fix", { failures_json: JSON.stringify([{ path: "package.json", problem: "pin it", new_file: "yes" }]) })).error, /new_file must be true or false/);
  assert.match((await t.call("write_acceptance_fix", { failures_json: "[]", cannot_pass: "no" })).error, /one of failures_json or cannot_pass/);
  assert.match((await t.call("write_acceptance_fix", {})).error, /one of failures_json or cannot_pass/);
  const entries = [{ path: "package.json", problem: "set overrides.semver to 7.6.3: the audit's high advisory GHSA-c2qf (line 12)" }, { path: ".npmrc", problem: "audit-level=high", new_file: true }];
  assert.match((await t.call("write_acceptance_fix", { failures_json: JSON.stringify(entries) })).result, /accepted: 2 failures entries/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "out", "acceptance-fix.json"), "utf8")), { failures: entries });
  assert.equal(JSON.parse((await t.call("status", {})).result).done, true);
  assert.equal(readFileSync(join(root, "out", "spec.json"), "utf8"), approved, "the approved spec is untouched");

  const stuck = fixer();
  assert.match((await stuck.call("write_acceptance_fix", { cannot_pass: "two lines\nare not one" })).error, /one line/);
  assert.match((await stuck.call("write_acceptance_fix", { cannot_pass: "the brief fixes Node 16, and no release of the audited package supports it" })).result, /accepted/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "out", "acceptance-fix.json"), "utf8")), { cannot_pass: "the brief fixes Node 16, and no release of the audited package supports it" });

  // A design step hands in no acceptance fix.
  const design = new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", run_token: "run-1" });
  assert.match((await design.call("write_acceptance_fix", { failures_json: JSON.stringify(entries) })).error, /only an acceptance fix/);
});
