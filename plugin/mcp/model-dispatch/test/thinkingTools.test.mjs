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
  // its name alone. A changed one is refused with the store's reason, and the spec keeps the version it accepted: the
  // store changes nothing on a refusal, so the step does not either (its file is put back), and nothing is owed for it.
  const third = architect();
  assert.deepEqual((await status(third)).missing, ["finalize, after every section is accepted"], "finalize is never carried over: each call checks the spec again");
  assert.match((await hand(third, "units-001.json", [Object.fromEntries(Object.entries(U01).reverse())])).result, /^accepted units-001\.json: unchanged/);
  assert.match((await hand(third, "units-002.json")).result, /^accepted units-002\.json: unchanged/);
  assert.match((await hand(third, "units-002.json", [{ ...U02, behaviour: "the routes; 409 on a duplicate title" }])).error, /^refused:\n\/units\/0\/id duplicate unit id U02[\s\S]*\nThe spec keeps units-002\.json as it was accepted/);
  assert.deepEqual((await status(third)).missing, ["finalize, after every section is accepted"]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "out", "spec.sections", "units-002.json"), "utf8")), [U02], "its file is the accepted version again");
  assert.match((await hand(third, "units-002.json")).result, /unchanged/);
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

// E-thinking-carry-on. Design §12: "a frozen worker is killed, and the step continues from its saved conversation".
// Review: the tools kept what they had accepted only in their own process, so a step carried on after its worker was
// killed would owe every piece again, whatever its conversation said it had handed in.
test("the tools keep their state in the step's state file: a carried-on step holds what was accepted and refused; any other starts empty", async () => {
  const root = project();
  mkdirSync(join(root, "out"), { recursive: true });
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [], api: [] },
  };
  const stateFile = join(root, ".sdlc", "runs", "r1", "thinking", "architect.state.json");
  const status = async (t) => JSON.parse((await t.call("status", {})).result);
  // A greenfield architect with no run token: what it starts from is its state file alone, never the spec store.
  const architect = (over) => tools(root, "architect", { output_dir: "out", outputs: { sections_dir: "out/spec.sections" }, spec_dir: "out", ...over });
  const first = architect({ state_file: stateFile });
  assert.match((await first.call("submit_section", { name: "header.json", json: JSON.stringify(header) })).result, /accepted header\.json/);
  assert.ok(existsSync(stateFile), "the state is kept on disk at once");
  // The worker was killed; the step is carried on with a new tools process.
  const again = await status(architect({ state_file: stateFile, carry_on: true }));
  assert.deepEqual(again.accepted, ["header.json"], "what was accepted before the kill is still accepted");
  assert.deepEqual(again.missing, ["at least one units file, accepted", "finalize, after every section is accepted"], "only the rest is owed");
  assert.deepEqual(again.written, ["out/spec.sections/header.json"]);
  // A refused piece is still owed with its problems.
  const archState = join(root, ".sdlc", "runs", "r1", "thinking", "brownfield-architect.state.json");
  const arch = tools(root, "brownfield-architect", { state_file: archState });
  assert.match((await arch.call("write_section", { name: "header.json", json: "{}" })).error, /refused/);
  const archAgain = await status(tools(root, "brownfield-architect", { state_file: archState, carry_on: true }));
  assert.ok(archAgain.missing.some((m) => /^header\.json was refused: header\.json \/: is missing required field/.test(m)), archAgain.missing.join("; "));
  // A step that is not carried on (a first call, a revise) starts empty, and the file then holds its state.
  const fresh = architect({ state_file: stateFile });
  assert.deepEqual((await status(fresh)).accepted, []);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).accepted, [], "an earlier step's state is overwritten");
  // A carried-on step whose tools never kept a state starts empty; one whose state cannot be read is not started.
  assert.deepEqual((await status(architect({ state_file: join(root, "no-such.state.json"), carry_on: true }))).accepted, []);
  writeFileSync(stateFile, "{not json");
  assert.throws(() => architect({ state_file: stateFile, carry_on: true }), /state .*cannot be read/);
});

// Review of 0.10.1, each proved with a probe: what a file the read rule keeps from models holds never reaches one,
// whichever tool would carry it.
const BF_HEADER = (run = "test -s {path}") => ({ conventions: ["two-space indent"], decisions: [{ topic: "x", choice: "y", reason: "FR-1" }], file_checks: [{ id: "lint", run, timeout_s: 45 }], project_checks: [{ id: "types", run: "true" }] });
const SECRETS = ["hunter2", "postgres://u:pw@db", "npm_TOKEN123", "MIIEowIBAAKCAQEA", "BEGIN RSA PRIVATE KEY"];
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7FAKEFAKEFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----\n";
function secretProject() {
  const root = project();
  writeFileSync(join(root, ".env"), "DB_URL=postgres://u:pw@db\nSECRET=hunter2\n");
  writeFileSync(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_TOKEN123\n");
  writeFileSync(join(root, "src", "key.ts"), `export const k = \`\n${PEM}\`;\n`);
  return root;
}
const noSecret = (said) => { for (const s of SECRETS) assert.ok(!String(said).includes(s), `${s} reached the model: ${said}`); };

test("a hand-in never quotes a file the read rule keeps from models: an edit there is refused, with nothing of the file in the refusal", async () => {
  // The brownfield architect's site check answered `line 2 of .env reads "SECRET=hunter2"` and quoted .npmrc's token,
  // though read_file refuses both; a site over several lines quoted its last line too.
  const root = secretProject();
  const t = tools(root, "brownfield-architect", { spec_dir: ".sdlc/runs/r1" });
  assert.match((await t.call("write_section", { name: "header.json", json: JSON.stringify(BF_HEADER()) })).result, /accepted/);
  const edit = (id, path, from, to = from) => ({ id, path, action: "edit", phase: "codegen", behaviour: "add a key", sites: [{ id: "S1", at: "replace", from, to, first_line: "x", rule: "r" }], depends_on: [], checks: ["lint"] });
  const r = await t.call("write_section", { name: "units-001.json", json: JSON.stringify([edit("U01", ".env", 2), edit("U02", ".npmrc", 1), edit("U03", "src/key.ts", 2, 4)]) });
  const said = r.error ?? r.result;
  noSecret(said);
  for (const p of [".env", ".npmrc", "src/key.ts"]) assert.match(said, new RegExp(`${p.replace(".", "\\.")}`), p);
  assert.match(said, /src\/key\.ts.*private key/);
  // A file the model may read is quoted as before, so the architect can correct its site.
  const ok = await t.call("write_section", { name: "units-001.json", json: JSON.stringify([edit("U04", "src/a.ts", 1)]) });
  assert.match(ok.error ?? ok.result, /line 1 of src\/a\.ts reads "export const a = 1;"/);
});

test("a check command never carries what the read rule keeps from models: one naming such a file is refused, and no check's output holds their text", async () => {
  // A Gemini architect's header check `cat .env && test -s {path}` was accepted, and the reviewer's run_file_check
  // answered `exit 0\nSECRET=hunter2`: under --gates=auto-approve no person reads the plan before its checks run.
  // No person's settings are read here: their deny rules would refuse the indirect command below before it ran.
  const cfgDir = mkdtempSync(join(tmpdir(), "mmo-nosettings-"));
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, m: process.env.MMO_MANAGED_SETTINGS };
  process.env.CLAUDE_CONFIG_DIR = cfgDir; process.env.MMO_MANAGED_SETTINGS = join(cfgDir, "managed.json");
  try {
  const root = secretProject();
  const arch = tools(root, "brownfield-architect", { spec_dir: ".sdlc/runs/r1" });
  for (const run of ["cat .env && test -s {path}", "head -1 .npmrc; test -s {path}", "cat src/key.ts {path}"]) {
    const r = await arch.call("write_section", { name: "header.json", json: JSON.stringify(BF_HEADER(run)) });
    assert.match(r.error ?? "", /read rule/, `${run}: ${JSON.stringify(r)}`);
    noSecret(r.error);
  }
  // At run time too, whatever the plan on disk says: a plan approved before this check, or changed by hand.
  const spec = (run) => writeFileSync(join(root, ".sdlc", "runs", "r1", "change-spec.json"), JSON.stringify({ header: BF_HEADER(run) }));
  const rev = tools(root, "brownfield-senior-reviewer", { spec_dir: ".sdlc/runs/r1" });
  spec("cat .env && test -s {path}");
  const named = await rev.call("run_file_check", { path: "src/a.ts", check_id: "lint" });
  assert.match(named.error ?? "", /read rule/); noSecret(JSON.stringify(named));
  // A command that reaches such a file without naming it: its output reaches the model without their text.
  spec("cat \"$(printf '.e%s' nv)\" .\"npm\"rc; echo kept-line; test -s {path}");
  const indirect = await rev.call("run_file_check", { path: "src/a.ts", check_id: "lint" });
  noSecret(JSON.stringify(indirect));
  assert.match(indirect.result ?? "", /kept-line/, "the rest of the output is untouched");
  assert.match(indirect.result ?? "", /kept from you by the read rule/);
  // A check that touches nothing protected answers exactly as before.
  spec("echo fine && test -s {path}");
  assert.equal((await rev.call("run_file_check", { path: "src/a.ts", check_id: "lint" })).result, "exit 0\nfine");
  // A check of a file that holds a private key is refused, as reading it is.
  assert.match((await rev.call("run_file_check", { path: "src/key.ts", check_id: "lint" })).error ?? "", /private key/);
  } finally {
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.c], ["MMO_MANAGED_SETTINGS", saved.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("git_diff never carries a file that holds a private key, created or edited by the run, whole or in a folder", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = project();
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(root, "src", "app.js"), "console.log(1)\n");
  writeFileSync(join(root, "src", "ok.js"), "a\n");
  git("add", "src"); git("commit", "-qm", "init");
  const head = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "src", "jwt_fixture.txt"), PEM);
  writeFileSync(join(root, "src", "app.js"), "console.log(1)\n" + PEM);
  writeFileSync(join(root, "src", "ok.js"), "b\n");
  writeFileSync(join(root, ".sdlc", "runs", "r1", "provenance.json"), JSON.stringify({ git_head_before: head, files_touched: ["src/jwt_fixture.txt", "src/app.js", "src/ok.js"] }));
  const t = tools(root, "brownfield-senior-reviewer", { spec_dir: ".sdlc/runs/r1" });
  for (const path of ["", "src", "src/app.js", "src/jwt_fixture.txt"]) {
    const d = await t.call("git_diff", { path });
    noSecret(JSON.stringify(d));
    if (path === "" || path === "src") assert.match(d.result ?? "", /ok\.js/, `${path || "(all)"}: the other changes are still shown`);
    else assert.match(d.error ?? "", /private key/, path);
  }
  // A key the run removed: the file's earlier text holds it, so its diff (which shows the removed lines) is refused too.
  git("add", "-A"); git("commit", "-qm", "with key");
  const head2 = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "src", "app.js"), "console.log(1)\n");
  writeFileSync(join(root, ".sdlc", "runs", "r1", "provenance.json"), JSON.stringify({ git_head_before: head2, files_touched: ["src/app.js"] }));
  const gone = await tools(root, "brownfield-senior-reviewer", { spec_dir: ".sdlc/runs/r1" }).call("git_diff", { path: "src/app.js" });
  noSecret(JSON.stringify(gone)); assert.match(gone.error ?? "", /private key/);
});

test("a project folder named in another spelling than the disk's (another case, or Unicode composed differently) is read as the same folder", async () => {
  // The root kept the spelling it was given while each file took the disk's, so every read answered "leads outside
  // the project" for MyProject named myproject, or Résumé named composed while the disk keeps it decomposed.
  const base = mkdtempSync(join(tmpdir(), "mmo-spelling-"));
  const make = (name) => { mkdirSync(join(base, name, "src"), { recursive: true }); writeFileSync(join(base, name, "src", "a.txt"), "hello\n"); };
  make("MyProject");
  make("Résumé");
  const caseFolds = existsSync(join(base, "myproject"));
  const read = (root) => new ThinkingTools({ role: "senior-reviewer", project_root: root, output_dir: "out", outputs: { review: "out/review.json" }, spec_dir: "out" }).read_file({ path: "src/a.txt" });
  assert.match(read(join(base, "MyProject")).result ?? "", /hello/);
  if (caseFolds) assert.match(read(join(base, "myproject")).result ?? "", /hello/, "another case");
  if (existsSync(join(base, "Résumé"))) assert.match(read(join(base, "Résumé")).result ?? "", /hello/, "composed, where the disk keeps it decomposed");
});

test("every tool's answer leaves without what the read rule keeps from models: a log a check wrote that echoes a secret is read without it", async () => {
  // The tools' one exit (call): a file the rule lets the model read (a check's log in the run folder) can still hold
  // a protected file's value; it reaches the model without it.
  const root = secretProject();
  writeFileSync(join(root, ".sdlc", "runs", "r1", "acceptance.log"), "npm test\nconnecting to postgres://u:pw@db\nSECRET=hunter2\n1 failing\n");
  const t = tools(root, "requirements");
  const r = await t.call("read_file", { path: ".sdlc/runs/r1/acceptance.log" });
  noSecret(JSON.stringify(r));
  assert.match(r.result, /1 failing/);
  assert.match(r.result, /kept from you by the read rule/);
  // A file with nothing protected in it reads exactly as before.
  assert.equal((await t.call("read_file", { path: "src/a.ts" })).result, "1\texport const a = 1;\n2\tconst token = 'x';\n3\t");
});
