/**
 * The Gemini thinking step's tools (plugin/scripts/thinking-tools.mjs). Pinned: every read goes through the engine's
 * read rule (credentials and links out of the project never reach the model), hand-ins write only their own fixed
 * paths and never through a link, a review is checked against the shape the repair stage reads, a role gets only its
 * own tools, and the step is done only when every piece it owes is accepted. Real temp folders; no model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

test("an architect called again in the same run resumes from the spec the store holds for the run; a file handed in again unchanged is accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-resume-"));
  mkdirSync(join(root, "out"));
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
  };
  const unit = (id, path, behaviour) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour, depends_on: [], style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });
  const U01 = unit("U01", "backend/app/models.py", "the models");
  const U02 = unit("U02", "backend/app/api.py", "the routes");
  // Each run_thinking_step call is a new tools process; one run's calls share its run token.
  const architect = (over = {}) => new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", run_token: "run-1", ...over });
  const hand = (t, name, value) => t.call("submit_section", { name, json: value === undefined ? "" : JSON.stringify(value) });
  const status = async (t) => JSON.parse((await t.call("status", {})).result);

  // The first call hands in the header and two units files, then stops before finalize.
  const first = architect();
  await hand(first, "header.json", header);
  await hand(first, "units-001.json", [U01]);
  await hand(first, "units-002.json", [U02]);

  // Called again in the same run, the step starts from what the spec holds, and finalize alone completes it.
  const second = architect();
  let s = await status(second);
  assert.deepEqual(s.missing, ["finalize, after every section is accepted"], JSON.stringify(s));
  assert.deepEqual(s.accepted, ["header.json", "units-001.json", "units-002.json"]);
  assert.match((await second.call("finalize", {})).result, /finalized: 2 unit/);
  assert.equal((await status(second)).done, true);

  // A file handed in again as the spec holds it is accepted as unchanged, with its JSON (its keys in any order) or by
  // its name alone; a changed one is refused with the store's reason, and owed until it is handed in as it stands.
  const third = architect();
  assert.deepEqual((await status(third)).missing, ["finalize, after every section is accepted"], "finalize is never carried over: each call checks the spec again");
  assert.match((await hand(third, "units-001.json", [Object.fromEntries(Object.entries(U01).reverse())])).result, /^accepted units-001\.json: unchanged/);
  assert.match((await hand(third, "units-002.json")).result, /^accepted units-002\.json: unchanged/);
  assert.match((await hand(third, "units-002.json", [{ ...U02, behaviour: "the routes; 409 on a duplicate title" }])).error, /^refused:\n\/units\/0\/id duplicate unit id U02/);
  assert.ok((await status(third)).missing.some((m) => /^units-002\.json was refused: \/units\/0\/id duplicate unit id U02/.test(m)));
  assert.match((await hand(third, "units-002.json", [U02])).result, /unchanged/);
  assert.match((await third.call("finalize", {})).result, /finalized: 2 unit/);
  s = await status(third);
  assert.equal(s.done, true, JSON.stringify(s));
  // A header that opens a new spec (one sent after finalize) leaves the earlier spec's units behind: they are owed again.
  assert.match((await hand(third, "header.json", { ...header, stack: ["Python 3.13", "FastAPI", "pytest", "httpx"] })).result, /accepted header\.json: 0 unit/);
  assert.deepEqual((await status(third)).missing, ["at least one units file, accepted", "finalize, after every section is accepted"]);

  // Another run's spec, or the spec a revise answers, is not this step's to resume.
  assert.deepEqual((await status(architect({ run_token: "run-2" }))).missing, ["header.json, accepted", "at least one units file, accepted", "finalize, after every section is accepted"]);
  await hand(third, "units-001.json", [U01]);
  assert.match((await third.call("finalize", {})).result, /finalized: 1 unit/);
  const revise = architect({ revise: true });
  assert.deepEqual((await status(revise)).accepted, [], "a revise hands in a new spec");
  // The revise's own spec, once it is finalized, is the step's: a file handed in again unchanged is still accepted.
  assert.match((await hand(revise, "header.json", header)).result, /accepted header\.json: 0 unit/);
  assert.match((await hand(revise, "units-001.json")).result, /accepted units-001\.json: 1 unit/);
  assert.match((await revise.call("finalize", {})).result, /finalized: 1 unit/);
  assert.match(JSON.stringify(await hand(revise, "units-001.json")), /"result":"accepted units-001\.json: unchanged/);
  assert.equal((await status(revise)).done, true);
});

test("a refused finalize lists every problem in one answer: the coverage gap and each of the store's errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-finalize-"));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: answer ping.\n- FR-2: answer pong.\n- AC-1: a ping is answered with pong.\n");
  // No audit command and no reason for none, no command checks AC-1, and the units cover FR-1 only.
  const header = { stack: ["Node 22"], commands: [{ name: "tests", run: "npm test", cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }], decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] } };
  const unit = { id: "U01", path: "src/app.js", phase: "codegen", import_line: "", exports: [], behaviour: "answers ping", depends_on: [], style_from: { reason: "first file" }, covers: ["FR-1"], tests: [], approx_lines: 20 };
  const t = new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", requirements_path: "out/requirements.md", run_token: "run-1" });
  assert.match((await t.call("submit_section", { name: "header.json", json: JSON.stringify(header) })).result, /accepted/);
  assert.match((await t.call("submit_section", { name: "units-001.json", json: JSON.stringify([unit]) })).result, /accepted/);
  const r = await t.call("finalize", {});
  // As a section refusal reads: one line per problem, each with where it is.
  assert.equal(r.error, [
    "refused:",
    "/units no unit covers FR-2, AC-1: hand in a units file that covers them",
    "/header/commands no command has role \"audit\" and no no_audit_reason is given: add the stack's dependency audit (its threshold set so high or critical advisories exit non-zero), or say in no_audit_reason why there is none",
    "/header/commands no acceptance command checks AC-1: add it to a command's checks, or list it in unchecked with the reason it cannot be checked by running",
  ].join("\n"));
});

test("a refused section is owed until a hand-in of the same name is accepted, in greenfield as in brownfield", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-refused-"));
  mkdirSync(join(root, "out"));
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
  };
  const unit = (id, path, depends_on = []) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour: `writes ${path}`, depends_on, style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });
  const t = new ThinkingTools({ role: "architect", project_root: root, run_id: "r1", output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", run_token: "run-1" });
  const hand = (name, value) => t.call("submit_section", { name, json: typeof value === "string" ? value : JSON.stringify(value) });
  const status = async (tools = t) => JSON.parse((await tools.call("status", {})).result);

  // A refused header is owed with its problems; the same name accepted clears it.
  assert.match((await hand("header.json", { ...header, commands: [{ ...header.commands[0], cwd: "../outside" }] })).error, /^refused:\n\/header\/commands\/0\/cwd/);
  let s = await status();
  assert.equal(s.done, false);
  assert.ok(s.missing.some((m) => /^header\.json was refused: \/header\/commands\/0\/cwd \.\.\/outside is not a folder inside the code directory/.test(m)), s.missing.join("; "));
  assert.match((await hand("header.json", header)).result, /accepted header\.json/);
  assert.ok(!(await status()).missing.some((m) => /was refused/.test(m)), "accepted again, it is no longer owed");

  // A units file refused after another was accepted: finalize assembles what was accepted, and the step is still not
  // done (review: it was done, and spec.json held only the first file's units).
  assert.match((await hand("units-001.json", [unit("U01", "backend/app/models.py")])).result, /accepted units-001\.json/);
  assert.match((await hand("units-002.json", [unit("U02", "backend/tests/test_models.py", ["U09"])])).error, /U09 is not an earlier unit/);
  assert.match((await t.call("finalize", {})).result, /finalized: 1 unit/);
  s = await status();
  assert.equal(s.done, false, `a refused section is owed though finalize assembled the rest: ${JSON.stringify(s)}`);
  assert.ok(s.missing.some((m) => /^units-002\.json was refused: \/units\/0\/depends_on U09 is not an earlier unit/.test(m)), s.missing.join("; "));
  // A piece whose JSON does not parse is a refused piece too.
  assert.match((await hand("units-002.json", "[{nope")).error, /units-002\.json is not valid JSON/);
  assert.ok((await status()).missing.some((m) => /^units-002\.json was refused: units-002\.json is not valid JSON/.test(m)));
  assert.match((await hand("units-002.json", [unit("U02", "backend/tests/test_models.py", ["U01"])])).result, /accepted units-002\.json: 2 unit/);
  assert.match((await t.call("finalize", {})).result, /finalized: 2 unit/);
  assert.deepEqual(await status(), { done: true, missing: [], accepted: ["header.json", "units-001.json", "units-002.json", "finalize"], written: ["out/spec.sections/header.json", "out/spec.sections/units-001.json", "out/spec.sections/units-002.json"] });

  // Brownfield keeps the same rule, a section whose JSON does not parse included.
  const bf = project();
  const b = tools(bf, "brownfield-architect");
  assert.match((await b.call("write_section", { name: "header.json", json: "{nope" })).error, /header\.json is not valid JSON/);
  assert.ok((await status(b)).missing.some((m) => /^header\.json was refused: header\.json is not valid JSON/.test(m)));
  assert.match((await b.call("write_section", { name: "header.json", json: "{}" })).error, /^refused:\nheader\.json/);
  assert.ok((await status(b)).missing.some((m) => /^header\.json was refused: header\.json \//.test(m)), "the check's own problems replace the parse error");
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

test("a search runs in bounded time: a pattern that would backtrack is answered at once, and one that cannot be bounded is refused", async () => {
  const root = project();
  writeFileSync(join(root, "src", "long.txt"), "a".repeat(28) + "!\n");
  const t = tools(root, "senior-reviewer");
  const started = Date.now();
  const r = await t.call("search_files", { pattern: "^(a+)+$", path: "src" });
  assert.ok(Date.now() - started < 500, `answered in ${Date.now() - started} ms`);
  assert.equal(r.error, undefined, r.error);
  assert.match((await t.call("search_files", { pattern: "(a)\\1", path: "src" })).error, /cannot be searched in bounded time/);
  assert.match((await t.call("search_files", { pattern: "const token", path: "src" })).result, /src\/a\.ts:2: const token/);
});

test("a search names the folders it skips and the files it could not read, and searches the rest", async () => {
  const root = project();
  mkdirSync(join(root, "src", "coverage"));
  writeFileSync(join(root, "src", "coverage", "policy.ts"), "const apiKey = load();\n");
  writeFileSync(join(root, "src", "locked.ts"), "const apiKey = 2;\n");
  chmodSync(join(root, "src", "locked.ts"), 0o000);
  writeFileSync(join(root, "src", "open.ts"), "const apiKey = 3;\n");
  const t = tools(root, "senior-reviewer");
  const r = await t.call("search_files", { pattern: "apiKey", path: "src" });
  chmodSync(join(root, "src", "locked.ts"), 0o644);
  assert.equal(r.error, undefined, r.error);
  assert.match(r.result, /src\/open\.ts:1: const apiKey = 3/);
  assert.match(r.result, /not searched[^\n]*src\/coverage/);
  assert.match(r.result, /could not read[^\n]*src\/locked\.ts/);
  // A skipped folder is searched when it is named.
  assert.match((await t.call("search_files", { pattern: "apiKey", path: "src/coverage" })).result, /src\/coverage\/policy\.ts:1/);
});

test("a named pipe is refused at once, through the tool process itself", { timeout: 20_000 }, async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const root = project();
  execFileSync("mkfifo", [join(root, "src", "dev.pipe")]);
  const cfg = join(root, "tools.json");
  writeFileSync(cfg, JSON.stringify({ role: "senior-reviewer", project_root: root, run_id: "r1", output_dir: ".sdlc/runs/r1", outputs: { review: ".sdlc/runs/r1/review.json" } }));
  const child = spawn(process.execPath, [resolve(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs"), "--config", cfg], { stdio: ["pipe", "pipe", "inherit"] });
  const answer = new Promise((done) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; if (buf.includes("\n")) done(JSON.parse(buf.split("\n")[0])); });
    setTimeout(() => done(null), 3000);
  });
  child.stdin.write(JSON.stringify({ id: 1, op: "read_file", args: { path: "src/dev.pipe" } }) + "\n");
  const r = await answer;
  child.kill("SIGKILL");
  assert.ok(r, "the tool answered within 3 s");
  assert.match(r.error, /not a regular file/);
});

// A brownfield run's project: one commit, then the run's own changes, with its provenance.
async function reviewedProject() {
  const { execFileSync } = await import("node:child_process");
  const root = project();
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(root, "src", "crlf.ts"), "export const x = 1;\r\n");
  git("add", "src"); git("commit", "-q", "-m", "base");
  const head = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "src", "crlf.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src", "new-endpoint.js"), "app.get('/x', (req) => eval(req.query.code));\n");
  writeFileSync(join(root, ".sdlc", "runs", "r1", "provenance.json"), JSON.stringify({ git_head_before: head, files_touched: ["src/a.ts", "src/crlf.ts", "src/new-endpoint.js"] }));
  return root;
}

test("git_diff shows the files the run created, ignores line-ending changes, and runs only what the person allows", async () => {
  const root = await reviewedProject();
  const t = tools(root, "brownfield-senior-reviewer");
  const all = (await t.call("git_diff", {})).result;
  assert.match(all, /export const a = 2/);
  assert.match(all, /eval\(req\.query\.code\)/, "a file the run created reaches the reviewer");
  assert.doesNotMatch(all, /crlf\.ts/, "a line-ending change alone is no change, as the reviewers' own command shows it");
  assert.match((await t.call("git_diff", { path: "src" })).result, /eval\(req\.query\.code\)/, "a folder's new files too");
  // The person denies git diff: the tool runs nothing.
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(git diff:*)", "Bash(npm audit:*)"] } }));
  assert.match((await t.call("git_diff", {})).error, /not run: the person's Claude settings deny it \(Bash\(git diff:\*\)\)/);
  assert.match((await t.call("git_diff", { path: "src" })).error, /deny it/);
  const sec = tools(root, "brownfield-security-reviewer");
  assert.match((await sec.call("run_dependency_audit", { kind: "npm-audit" })).error, /not run: the person's Claude settings deny it \(Bash\(npm audit:\*\)\)/);
});

test("the brownfield security reviewer has the file check its instructions allow", async () => {
  const { ROLE_TOOLS } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs")).href);
  assert.ok(ROLE_TOOLS["brownfield-security-reviewer"].includes("run_file_check"));
});

test("under a run's contract the project baseline is read as the Claude architect reads it; the rest of .sdlc stays refused", async () => {
  const root = project();
  mkdirSync(join(root, ".sdlc", "baseline"), { recursive: true });
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "baseline", "stack-profile.md"), "# Stack\nNestJS 11\n");
  writeFileSync(join(root, ".sdlc", "baseline", ".env"), "KEY=1\n");
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: "r1", strict: true, allowlist: ["src/**"], off_limits: [".sdlc/**"] }));
  symlinkSync(join("..", "local", "write-contract.json"), join(root, ".sdlc", "baseline", "contract.md"));
  const t = tools(root, "brownfield-architect");
  assert.match((await t.call("read_file", { path: ".sdlc/baseline/stack-profile.md" })).result, /NestJS 11/);
  assert.match((await t.call("read_file", { path: ".sdlc/local/write-contract.json" })).error, /off-limits/);
  assert.match((await t.call("read_file", { path: ".sdlc/baseline/contract.md" })).error, /off-limits/, "a link out of the baseline is judged where it leads");
  assert.match((await t.call("read_file", { path: ".sdlc/baseline/.env" })).error, /off-limits/, "the always list holds inside it");
});

test("another name for a refused file is found wherever that file sits, a build or cache folder included", async () => {
  const root = project();
  mkdirSync(join(root, "coverage"));
  writeFileSync(join(root, "coverage", ".env"), "STRIPE_KEY=sk_live_x\n");
  linkSync(join(root, "coverage", ".env"), join(root, "src", "notes.txt"));
  const t = tools(root, "senior-reviewer");
  assert.match((await t.call("read_file", { path: "src/notes.txt" })).error, /hard link/);
  const { hydrateInputs } = await import(pathToFileURL(resolve(HERE, "..", "dist", "apply.js")).href);
  assert.throws(() => hydrateInputs({ id: "p", inputs: [{ path: "src/notes.txt", reason: "x" }] }, root), /hard link/);
});
