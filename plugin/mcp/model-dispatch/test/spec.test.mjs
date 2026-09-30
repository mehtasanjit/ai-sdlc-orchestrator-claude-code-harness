/**
 * The typed build spec: its vocabulary, its schema, the section-by-section
 * hand-over, the coverage check and the briefs rendered from it.
 * Pure functions and a temp directory; no model calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { SPEC_HEADER_SCHEMA, SPEC_UNIT_SCHEMA, SPEC_UNITS_SECTION_SCHEMA, validate } from "../dist/spec/schema.js";
import { submitSpecSection, finalizeSpec, storedUnits, isSafeRelativePath, requiredIds, loadSpec } from "../dist/spec/store.js";
import { renderShared, renderUnitInstruction, renderRepairInstruction, framedUnit, unitPacket } from "../dist/executor/brief.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { buildUserPrompt } from "../dist/adapters/GeminiFlashAdapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "..", "..", "..");
const YAML = createRequire(import.meta.url)("yaml");

// A tiny made-up project: a to-do API. Enough to exercise every rule.
const HEADER = {
  stack: ["Python 3.13", "FastAPI", "pytest"],
  commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: ["AC-1"], pass: { exit_code: 0 }, timeout_s: 600 }],
  no_audit_reason: "the brief provides a fixed environment with no dependency audit tool",
  decisions: [{ topic: "ids", choice: "integer autoincrement", rejected: ["uuid"], reason: "simplest for SQLite" }],
  shared: {
    conventions: ["snake_case for Python names"],
    data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }, { name: "title", type: "str" }] }],
    api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }],
  },
};
const unit = (id, path, over = {}) => ({
  id, path, phase: "codegen", kind: "dto", import_line: "",
  exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }],
  behaviour: "Pydantic models for a to-do.", depends_on: [], style_from: { reason: "first file of its kind" },
  covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20, ...over,
});
const REQUIREMENTS = "# Requirements\nFR-1.1 create a to-do.\nFR-1.2 list to-dos.\nAC-1 a to-do can be created.\nNFR-1 fast.\n";

test("a unit needs no file-type label; a label it does carry is free text for the design table, never refused and never routed on", () => {
  // A greenfield project can be in any language, so a unit is described by its path and behaviour;
  // who types it depends on its stage and the policy alone (test/stageRouting.test.mjs).
  const { kind, ...bare } = unit("U01", "backend/app/schemas.py");
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, bare), [], "no kind needed");
  for (const k of ["config", "go_handler", "rust_module", "anything at all"]) assert.deepEqual(validate(SPEC_UNIT_SCHEMA, { ...bare, kind: k }), [], k);
  const exp = { name: "Router", params: [], returns: "Router" };
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, { ...bare, exports: [exp] }), [], "an export needs no kind either");
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, { ...bare, exports: [{ ...exp, kind: "trait" }] }), [], "and any export kind is accepted");
});

test("the schema accepts a well-formed header and unit and names each problem by path", () => {
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, HEADER), []);
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "backend/app/schemas.py")), []);
  const bad = validate(SPEC_UNIT_SCHEMA, { ...unit("U1", "x.py"), kind: "config", extra: 1, behaviour: "two\nlines" });
  const paths = bad.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/behaviour", "/extra", "/id"], "a free-text kind is not a problem");
  assert.match(bad.find((e) => e.path === "/behaviour").message, /must match/);
  assert.match(validate(SPEC_HEADER_SCHEMA, { stack: [] })[0].message, /missing required field 'commands'/);
});

test("the plan refuses on structure, never on characters or sizes", () => {
  // No character caps: a long one-line choice is fine.
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, { ...HEADER, decisions: [{ topic: "t", choice: "c".repeat(182), reason: "r" }] }), []);
  assert.match(validate(SPEC_HEADER_SCHEMA, { ...HEADER, decisions: [{ topic: "t", choice: "a\nb", reason: "r" }] })[0].message, /must match/);
  // Dotted export names are members (Class.method); anything else is not a name.
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { exports: [{ name: "NoteStore.add", kind: "function", params: [], returns: "Note" }] })), []);
  assert.equal(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { exports: [{ name: "GET /notes", kind: "function", params: [], returns: "x" }] }))[0].path, "/exports/0/name");
  // No size caps: approx_lines is an estimate only; a typist answer cut off at its output limit goes to the
  // typist with the larger limit (executor); the architect keeps a one-hour cache like the orchestrator, so a
  // call's size does not race the cache.
  for (const n of [539, 5000]) assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { approx_lines: n })), [], `${n} lines`);
  const many = (n) => Array.from({ length: n }, (_, i) => unit(`U${String(i + 1).padStart(2, "0")}`, `f${i}.py`));
  assert.deepEqual(validate(SPEC_UNITS_SECTION_SCHEMA, { units: many(40) }), [], "no units-per-call cap");
  const architect = readFileSync(join(PLUGIN, "agents", "architect.md"), "utf8");
  const front = architect.split("\n---")[0];
  assert.match(front, /\n\s*cacheTtl: 1h\b/, "the architect keeps a one-hour cache, like the orchestrator");
  assert.match(front, /\ntools:[^\n]*\bEdit\b/, "the architect can fix one spot of a section file with Edit");
  assert.ok(!/at most \d+ (per call|lines)/.test(architect), "the architect's prompt states no fitted bound");
});

test("paths the executor may write are relative, normalised and stay inside the code directory", () => {
  for (const ok of ["backend/app/main.py", "README.md", ".env.example"]) assert.equal(isSafeRelativePath(ok), true, ok);
  for (const no of ["/etc/passwd", "../x.py", "a/../../x", "a//b.py", "./a.py", "a\\b.py", ""]) assert.equal(isSafeRelativePath(no), false, no);
});

test("sections arrive header first, each checked on arrival; a refused batch stores nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const early = submitSpecSection(dir, { section: "units", units: [unit("U01", "a.py")] });
  assert.equal(early.ok, false);
  assert.match(early.errors[0].message, /header section first/);

  assert.equal(submitSpecSection(dir, { section: "header", header: HEADER }).ok, true);
  // U02 depends on U03, which has not been sent: the whole batch is refused.
  const forward = submitSpecSection(dir, { section: "units", units: [unit("U02", "b.py", { depends_on: ["U03"] }), unit("U03", "c.py")] });
  assert.equal(forward.ok, false);
  assert.match(forward.errors[0].message, /U03 is not an earlier unit/);
  assert.equal(storedUnits(dir).length, 0, "nothing stored from a refused batch");

  const first = submitSpecSection(dir, { section: "units", units: [unit("U01", "a.py"), unit("U02", "b.py", { depends_on: ["U01"], style_from: { unit: "U01", reason: "same kind" } })] });
  assert.deepEqual([first.ok, first.stored_units, first.total_units], [true, 2, 2]);
  const dup = submitSpecSection(dir, { section: "units", units: [unit("U02", "d.py"), unit("U04", "a.py"), unit("U05", "../e.py")] });
  assert.equal(dup.ok, false);
  const msgs = dup.errors.map((e) => e.message).join(" | ");
  assert.match(msgs, /duplicate unit id U02/);
  assert.match(msgs, /another unit already writes a\.py/);
  assert.match(msgs, /not a safe relative path: \.\.\/e\.py/);
  assert.equal(storedUnits(dir).length, 2);
});

test("a unit path that is another unit's folder is refused: the two files could not both be written", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  submitSpecSection(dir, { section: "header", header: HEADER });
  const r = submitSpecSection(dir, { section: "units", units: [unit("U01", "src/config"), unit("U02", "src/config/app.py")] });
  assert.equal(r.ok, false);
  assert.match(r.errors.map((e) => e.message).join(" | "), /src\/config is also a folder of src\/config\/app\.py/);
});

test("requirement ids are read by the same grammar a unit's covers field uses, whatever the numbering", () => {
  // Requirements may number FR-1, FR-2 ... or FR-1.1; both, and AC-1.2, are ids.
  const text = "FR-1 add a note. FR-2 list notes. FR-3.1 search. AC-1.2 a note can be added. See AC-3. NFR-1 fast.";
  assert.deepEqual(requiredIds(text).sort(), ["AC-1.2", "AC-3", "FR-1", "FR-2", "FR-3.1"]);
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  submitSpecSection(dir, { section: "header", header: { ...HEADER, commands: [{ ...HEADER.commands[0], checks: ["AC-1.2"] }] } });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "a.py", { covers: ["FR-1", "AC-1.2"] })] });
  const req = join(dir, "requirements.md");
  writeFileSync(req, "FR-1 x. AC-1.2 y.\n");
  assert.equal(finalizeSpec(dir, req).ok, true, "AC-1.2 is covered as written, not as AC-1");
  const gone = finalizeSpec(dir, join(dir, "no-such-requirements.md"));
  assert.equal(gone.ok, false, "a requirements file that is named but missing is never 'covered'");
  assert.match(gone.errors[0].message, /requirements file .* does not exist/);
});

test("finalize refuses a spec that leaves a requirement uncovered, then writes spec.json and design.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const req = join(dir, "requirements.md");
  writeFileSync(req, REQUIREMENTS);
  assert.deepEqual(requiredIds(REQUIREMENTS).sort(), ["AC-1", "FR-1.1", "FR-1.2"], "NFR ids are not required to be covered");
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "backend/app/schemas.py")] });
  const short = finalizeSpec(dir, req);
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing_coverage.sort(), ["AC-1", "FR-1.2"]);
  assert.equal(existsSync(join(dir, "spec.json")), false);

  submitSpecSection(dir, { section: "units", units: [unit("U02", "backend/tests/test_todos.py", { phase: "tests", kind: "test_integration", depends_on: ["U01"], covers: ["FR-1.2", "AC-1"] })] });
  const done = finalizeSpec(dir, req);
  assert.equal(done.ok, true);
  assert.deepEqual(done.by_phase, { codegen: 1, tests: 1 });
  const spec = loadSpec(done.spec_path);
  assert.equal(spec.spec_version, "1");
  assert.deepEqual(spec.units.map((u) => u.id), ["U01", "U02"]);
  const design = readFileSync(done.design_path, "utf8");
  assert.match(design, /\| U02 \| backend\/tests\/test_todos\.py \| tests \| [^|]+ \| [^|]+ \| U01 \|/);
  assert.match(design, /\| ids \| integer autoincrement \| simplest for SQLite \| uuid \|/);
});

test("every unit states how other files import it, in the project's own language; the line reaches the file's own brief, every dependent's brief, the shared index and design.md", () => {
  // "exports app" can mean two things in JavaScript (module.exports = app, or module.exports = { app }), so
  // files typed apart must share one exact import line. The architect writes it in the project's language;
  // code never parses it, only carries it, so no language rule is involved.
  const { import_line, ...noLine } = unit("U01", "a.py");
  assert.ok(validate(SPEC_UNIT_SCHEMA, noLine).some((e) => /import_line/.test(e.path + " " + e.message)), "required");
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, { ...noLine, import_line: "" }), [], "empty when nothing imports the file");
  assert.ok(validate(SPEC_UNIT_SCHEMA, { ...noLine, import_line: "a\nb" }).some((e) => e.path === "/import_line"), "one line");
  const lib = unit("U01", "src/app.js", { import_line: "const { app } = require('./src/app');", exports: [{ name: "app", params: [], returns: "Express" }] });
  const user = unit("U02", "server.js", { depends_on: ["U01"], style_from: { unit: "U01", reason: "same stack" } });
  const spec = { spec_version: "1", ...HEADER, units: [lib, user] };
  assert.match(renderShared(spec), /- src\/app\.js: app — imported as: const \{ app \} = require\('\.\/src\/app'\);/);
  assert.match(renderUnitInstruction(spec, user), /- src\/app\.js — [^\n]+\n  exports: [^\n]+\n  imported as: const \{ app \} = require\('\.\/src\/app'\); \(adjust only the relative path\)/);
  assert.match(renderUnitInstruction(spec, lib), /- other files import it as: const \{ app \} = require\('\.\/src\/app'\); — export exactly what this line expects/);
  assert.ok(!/imported as|import it as/.test(renderUnitInstruction(spec, user).split("## The file to write")[1]), "a file nothing imports carries no import line of its own");
  const dir = mkdtempSync(join(tmpdir(), "spec-imp-"));
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [{ ...lib, covers: ["FR-1.1", "FR-1.2", "AC-1"] }, user] });
  const req = join(dir, "requirements.md");
  writeFileSync(req, REQUIREMENTS);
  const done = finalizeSpec(dir, req);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(readFileSync(done.design_path, "utf8"), /\| U01 \| src\/app\.js \| codegen \| [^|]+ \| const \{ app \} = require\('\.\/src\/app'\); \|/, "the reviewers read the same contract");
});

test("briefs: the shared block is identical for every unit, the unit block names its dependencies, and the frame is the completion door's own", () => {
  const spec = { spec_version: "1", ...HEADER, units: [unit("U01", "backend/app/schemas.py"), unit("U02", "backend/app/main.py", { kind: "module_wiring", depends_on: ["U01"], style_from: { unit: "U01", reason: "same package" } })] };
  const shared = renderShared(spec);
  assert.equal(shared, renderShared(JSON.parse(JSON.stringify(spec))), "deterministic");
  assert.ok(shared.startsWith("# Write one file of a project"));
  assert.ok(!shared.includes("U01"), "no unit ids in the shared block");
  assert.ok(shared.endsWith("## Every file of the project, with what it exports (import only these modules and names)\n- backend/app/schemas.py: Todo\n- backend/app/main.py: Todo"), "the same file index in every brief, so no typist invents a module");

  const ins = renderUnitInstruction(spec, spec.units[1]);
  assert.match(ins, /- backend\/app\/schemas\.py — Pydantic models for a to-do\.\n  exports: Todo\(\) -> Todo \[class\]/);
  assert.match(ins, /- style: follow the conventions of backend\/app\/schemas\.py \(Pydantic models for a to-do\.\) — same package/, "the style file as its spec entry, which the typist can use");
  assert.match(ins, /Return ONLY a JSON object \{"path": "backend\/app\/main\.py", "content": "<the complete file>"\}/);
  assert.ok(!ins.includes("previous answer was refused"));
  assert.match(renderUnitInstruction(spec, spec.units[1], "missing exports: app"), /## Your previous answer was refused\nmissing exports: app\nWrite the whole file again, correcting that\./);

  const framed = framedUnit(spec.units[1], ins, "p1");
  assert.equal(framed, buildUserPrompt(unitPacket(spec.units[1], ins, "p1", 0), ""));
  assert.ok(framed.startsWith("## Task — U02 (codegen)\n"), "the brief names the stage, never a kind of file");

  const fix = renderRepairInstruction(spec, { path: "backend/app/main.py", unit: spec.units[1] }, ["blocker: wrong status — fix: return 201"]);
  assert.match(fix, /## The file to fix\n- path: backend\/app\/main\.py/);
  assert.match(fix, /## What must change\n- blocker: wrong status — fix: return 201/);
  assert.match(fix, /Return ONLY a JSON object \{"path": "backend\/app\/main\.py", "edits": \[\{"search": /);
  assert.match(renderRepairInstruction(spec, { path: ".env.test" }, ["missing"]), /a supporting file the specification does not list/);
});

/*
 * The architect writes the section files itself, so the submit tool's input schema does not carry
 * the header and unit shapes. The tool's description does, rendered from the schemas by code, so
 * the description cannot drift from what the check enforces.
 */
test("shapeOf renders required and optional fields, arrays, enums, integers and nesting", async () => {
  const { shapeOf } = await import("../dist/spec/schema.js");
  assert.equal(
    shapeOf({ type: "object", required: ["a"], properties: {
      a: { type: "string" }, b: { type: "array", items: { type: "integer" } }, c: { type: "string", enum: ["X", "Y"] },
      d: { type: "object", required: [], properties: { e: { type: "string" } } },
    } }),
    '{a: string, b?: integer[], c?: "X"|"Y", d?: {e?: string}}',
  );
});

test("submit_spec_section's description carries the exact shape of the header file and of a unit, as the schemas define them", async () => {
  const { shapeOf, SPEC_HEADER_SCHEMA, SPEC_UNIT_SCHEMA } = await import("../dist/spec/schema.js");
  const { EXECUTOR_TOOLS } = await import("../dist/executor/tools.js");
  const d = EXECUTOR_TOOLS.find((t) => t.name === "submit_spec_section").description;
  assert.ok(d.includes(shapeOf(SPEC_HEADER_SCHEMA)), "the header's shape");
  assert.ok(d.includes(shapeOf(SPEC_UNIT_SCHEMA)), "a unit's shape");
  assert.match(d, /stack: string\[\]/, "stack is an array of one-line strings");
  for (const k of SPEC_UNIT_SCHEMA.required) assert.match(d, new RegExp(`[{ ]${k}: `), `required unit field ${k}`);
});

/*
 * A second run into the same output folder (the default run id again, a retry after an abort, a Gate 2
 * revise) starts on clean records: the header of a new spec moves the earlier spec's records under
 * previous/, never deletes them. A header sent again for the spec still being written keeps its units.
 */
const RUN_RECORDS = ["spec.json", "design.md", "acceptance", "acceptance.md", "acceptance.json", "written-files.json", "shared-brief.txt"];

function finishedRun(dir, req) {
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py"), unit("U02", "old_only.py")] });
  assert.equal(finalizeSpec(dir, req).ok, true);
  // What the run's stages leave beside spec.json.
  mkdirSync(join(dir, "acceptance", "round-4"), { recursive: true });
  writeFileSync(join(dir, "acceptance", "state.json"), JSON.stringify({ runs: 4 }));
  writeFileSync(join(dir, "acceptance.md"), "the earlier run's table\n");
  writeFileSync(join(dir, "acceptance.json"), "{}\n");
  writeFileSync(join(dir, "written-files.json"), JSON.stringify(["app.py", "old_only.py"]));
  writeFileSync(join(dir, "shared-brief.txt"), "S\n");
  writeFileSync(join(dir, "telemetry.jsonl"), "{}\n");
}

test("a new spec in a folder that holds an earlier run's records starts clean; the earlier records are moved under previous/, never deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-rerun-"));
  const req = join(dir, "requirements.md");
  writeFileSync(req, "FR-1.1 create a to-do.\n");
  finishedRun(dir, req);

  const h = submitSpecSection(dir, { section: "header", header: HEADER });
  assert.equal(h.ok, true, JSON.stringify(h.errors));
  assert.equal(h.total_units, 0, "no unit of the earlier spec is carried over");
  assert.ok(h.previous && existsSync(h.previous), "the reply names the folder the earlier records went to");
  assert.equal(dirname(h.previous), join(dir, "previous"));
  for (const name of RUN_RECORDS) {
    assert.equal(existsSync(join(dir, name)), false, `${name} is no longer beside the new spec`);
    assert.equal(existsSync(join(h.previous, name)), true, `${name} is kept under previous/`);
  }
  assert.ok(existsSync(join(h.previous, "spec.parts", "units-001.json")), "the earlier units are kept too");
  assert.deepEqual(loadSpec(join(h.previous, "spec.json")).units.map((u) => u.path), ["app.py", "old_only.py"]);
  assert.equal(readFileSync(join(h.previous, "acceptance.md"), "utf8"), "the earlier run's table\n");
  for (const kept of ["requirements.md", "telemetry.jsonl"]) assert.equal(existsSync(join(dir, kept)), true, `${kept} is another phase's file and stays`);

  // The same unit ids and paths are accepted again, and the new spec holds only its own units.
  const u = submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py", { behaviour: "The new app." }), unit("U02", "server.py")] });
  assert.equal(u.ok, true, JSON.stringify(u.errors));
  const done = finalizeSpec(dir, req);
  assert.equal(done.ok, true);
  assert.deepEqual(loadSpec(done.spec_path).units.map((x) => [x.path, x.behaviour]), [["app.py", "The new app."], ["server.py", "Pydantic models for a to-do."]]);

  // A third spec keeps the second one's records in a folder of its own.
  const third = submitSpecSection(dir, { section: "header", header: HEADER });
  assert.notEqual(third.previous, h.previous);
  assert.equal(readdirSync(join(dir, "previous")).length, 2);
  assert.deepEqual(loadSpec(join(third.previous, "spec.json")).units.map((x) => x.path), ["app.py", "server.py"]);
});

test("a revise after finalize can change a unit: the header sent again opens a new spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-revise-"));
  const req = join(dir, "requirements.md");
  writeFileSync(req, "FR-1.1 create a to-do.\n");
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py")] });
  assert.equal(finalizeSpec(dir, req).ok, true);
  assert.equal(submitSpecSection(dir, { section: "header", header: HEADER }).ok, true);
  assert.equal(submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py", { behaviour: "Revised." })] }).ok, true);
  const done = finalizeSpec(dir, req);
  assert.deepEqual(loadSpec(done.spec_path).units.map((x) => x.behaviour), ["Revised."]);
  assert.match(readFileSync(done.design_path, "utf8"), /\| U01 \| app\.py \| codegen \| Revised\. \|/, "design.md shows the revised unit");
});

test("a header sent again while its spec is still being written replaces the header and keeps the units already stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-retry-"));
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py")] });
  const extra = { topic: "pagination", choice: "limit and offset", reason: "simplest" };
  const again = submitSpecSection(dir, { section: "header", header: { ...HEADER, decisions: [...HEADER.decisions, extra] } });
  assert.deepEqual([again.ok, again.total_units, again.previous], [true, 1, undefined]);
  assert.equal(existsSync(join(dir, "previous")), false, "nothing is moved aside");
  const req = join(dir, "requirements.md");
  writeFileSync(req, "FR-1.1 create a to-do.\n");
  const spec = loadSpec(finalizeSpec(dir, req).spec_path);
  assert.deepEqual(spec.units.map((u) => u.id), ["U01"]);
  assert.equal(spec.decisions.length, 2, "the header sent last is the one used");
});

test("a header from another run opens a new spec even before the earlier one was finalized; a header from the same run is a retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-runs-"));
  submitSpecSection(dir, { section: "header", header: HEADER }, { run: "run-a" });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py")] }, { run: "run-a" });
  const retry = submitSpecSection(dir, { section: "header", header: HEADER }, { run: "run-a" });
  assert.deepEqual([retry.ok, retry.total_units, retry.previous], [true, 1, undefined]);

  // Another run's units cannot join a spec that run did not open: it sends its own header first.
  const stray = submitSpecSection(dir, { section: "units", units: [unit("U02", "b.py")] }, { run: "run-b" });
  assert.equal(stray.ok, false);
  assert.match(stray.errors[0].message, /header section first/);
  assert.equal(storedUnits(dir).length, 1);

  const next = submitSpecSection(dir, { section: "header", header: HEADER }, { run: "run-b" });
  assert.deepEqual([next.ok, next.total_units], [true, 0]);
  assert.ok(existsSync(join(next.previous, "spec.parts", "units-001.json")), "the unfinished spec is kept under previous/");
  assert.equal(submitSpecSection(dir, { section: "units", units: [unit("U01", "app.py")] }, { run: "run-b" }).ok, true);
  // A caller that names no run cannot tell a retry from a new run: the spec being written keeps its units.
  assert.equal(submitSpecSection(dir, { section: "header", header: HEADER }).total_units, 1);
});
