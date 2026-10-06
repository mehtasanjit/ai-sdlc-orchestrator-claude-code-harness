/**
 * plan-lint.mjs: a brownfield run's change spec, checked one section at a time when the architect hands it
 * over (greenfield's rule, spec/store.ts submitSpecSection), against the schema and against the files as they are.
 * A refusal names the unit, the field and, for a site, the file's actual text, so one Edit fixes it; nothing is
 * stored. Offline, $0: real files in a temporary project, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const { checkSection, main } = await import(join(SCRIPTS, "plan-lint.mjs"));
const { changeShape } = await import(join(SCRIPTS, "lib", "change-spec.mjs"));
const { HEADER, UNITS, BUG_HEADER, BUG_UNITS, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));

test("--shape prints both section shapes, rendered from the schemas the check enforces", async () => {
  const shape = await changeShape();
  assert.match(shape, /^header\.json: \{conventions: string\[\], decisions\?:/m);
  assert.match(shape, /^units-NNN\.json: \{id: string matching \^U\[0-9\]\{2,4\}\$, path: string, action: "create"\|"edit"\|"tooling"/m);
  assert.match(shape, /sites\?: \{id: string matching \^S\[0-9\]\+\$, at: "replace"\|"delete"\|"insert_before"\|"insert_after", from: integer, to: integer, first_line: string/);
  assert.match(shape, /import_line\?: string/, "greenfield's own sub-schemas");
});

test("a header and a units section are accepted and stored with the hash of every file they point into", async () => {
  const p = project();
  try {
    const h = await p.check("header.json", HEADER);
    assert.equal(h.ok, true, h.lines.join("\n"));
    const u = await p.check("units-001.json", UNITS);
    assert.equal(u.ok, true, u.lines.join("\n"));
    assert.match(u.lines[0], /accepted units-001\.json: 2 unit\(s\) \(U01, U02\)/);
    const part = JSON.parse(readFileSync(join(p.root, ".sdlc", "runs", "r1", "change.parts", "units-001.json"), "utf8"));
    assert.deepEqual(Object.keys(part.hashes).sort(), ["src/a.ts", "src/x.ts"]);
  } finally { p.done(); }
});

test("a text field with a line break is refused: no code fits in the spec", async () => {
  const p = project();
  try {
    const r = await p.check("header.json", { ...HEADER, conventions: ["function f() {\n  return 1;\n}"] });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /\/conventions\/0/);
    assert.equal(existsSync(join(p.root, ".sdlc", "runs", "r1", "change.parts", "header.json")), false, "nothing stored");
  } finally { p.done(); }
});

test("a file check states how long it may run, as greenfield's commands do", async () => {
  const p = project();
  try {
    const r = await p.check("header.json", { ...HEADER, file_checks: [{ id: "lint", run: "lint {path}" }] });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /file_checks\/0: is missing required field 'timeout_s'/);
  } finally { p.done(); }
});

test("units are refused until the header is accepted", async () => {
  const p = project();
  try {
    const r = await p.check("units-001.json", UNITS);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /check the header section first/);
  } finally { p.done(); }
});

test("a site whose text differs from the file is refused with the file's actual line; the other problems come in the same answer", async () => {
  const p = project();
  try {
    await p.check("header.json", HEADER);
    const units = structuredClone(UNITS);
    units[0].action = "new";
    units[1].sites[0].first_line = 'import { y } from "./x";';
    const r = await p.check("units-001.json", units);
    assert.equal(r.ok, false);
    const text = r.lines.join("\n");
    assert.match(text, /\/0\/action: must be one of: create, edit, tooling/);
    assert.match(text, /U02\.sites\.S1: line 1 of src\/a\.ts reads "import \{ x \} from \\"\.\/x\\";"/, "the file's text, so one Edit fixes it");
  } finally { p.done(); }
});

test("every pointer is checked against the files as they are", async () => {
  const p = project();
  try {
    await p.check("header.json", HEADER);
    const cases = [
      [{ ...UNITS[0], path: "src/a.ts" }, /action "create", but the file exists/],
      [{ ...UNITS[1], path: "src/none.ts" }, /action "edit", but there is no such file/],
      [{ ...UNITS[1], sites: [{ id: "S1", at: "replace", from: 4, to: 9, first_line: "return x;", last_line: "}", rule: "r" }] }, /line 9 is past the end of src\/a\.ts \(6 lines\)/],
      [{ ...UNITS[1], sites: [{ id: "S1", at: "replace", from: 3, to: 5, first_line: "export function a() {", rule: "r" }] }, /gives last_line, the text of line 5: "}"/],
      [{ ...UNITS[1], sites: [{ id: "S1", at: "insert_after", from: 1, to: 2, first_line: 'import { x } from "./x";', rule: "r" }] }, /an insert sits next to one line/],
      [{ ...UNITS[1], sites: [{ id: "S1", at: "replace", from: 3, to: 5, first_line: "export function a() {", last_line: "}", rule: "r" }, { id: "S2", at: "insert_before", from: 4, to: 4, first_line: "return x;", rule: "r" }] }, /S1 \(lines 3-5\) and S2 \(lines 4-4\) overlap/],
      [{ ...UNITS[1], sites: undefined }, /an edit names its sites/],
      [{ ...UNITS[0], sites: UNITS[1].sites }, /only an edit has sites/],
      [{ ...UNITS[0], depends_on: ["U09"] }, /U09 is not an earlier unit/],
      [{ ...UNITS[0], checks: ["prettier"] }, /prettier is not a file check in the header/],
      [{ ...UNITS[0], path: "../outside.ts" }, /must be a path relative to the project root/],
      [{ ...UNITS[0], path: ".sdlc/runs/r1/x.md" }, /the run's own record/],
      [{ ...UNITS[0], style_from: { path: "src/x.ts", lines: [1, 7], reason: "r" } }, /lines 1-7 are outside src\/x\.ts \(2 lines\)/],
      [{ ...UNITS[0], uses: [{ path: "src/gone.ts", reason: "r" }] }, /src\/gone\.ts is not a file in the project/],
      [{ ...UNITS[0], action: "tooling", sites: undefined }, /a tooling unit names its shell step in run/],
    ];
    for (const [unit, want] of cases) {
      const r = await p.check("units-001.json", [unit]);
      assert.equal(r.ok, false, `${want} should be refused`);
      assert.match(r.lines.join("\n"), want);
    }
    const twice = await p.check("units-001.json", [UNITS[0], { ...UNITS[0], id: "U02" }]);
    assert.match(twice.lines.join("\n"), /U01 already changes this file; one unit per file/);
    const styleUnit = await p.check("units-001.json", [UNITS[0], { ...UNITS[1], style_from: { unit: "U01", reason: "r" }, depends_on: [] }]);
    assert.match(styleUnit.lines.join("\n"), /U01 is not in depends_on, so its file may not exist/);
  } finally { p.done(); }
});

test("a unit depends only on units before it: a later section may name an earlier section's units, never the reverse", async () => {
  const p = project();
  try {
    await p.check("header.json", HEADER);
    assert.equal((await p.check("units-001.json", [UNITS[0]])).ok, true);
    assert.equal((await p.check("units-002.json", [UNITS[1]])).ok, true, "U01 is in an earlier section");
    const back = await p.check("units-000.json", [{ ...UNITS[0], id: "U05", path: "src/c.ts", depends_on: ["U01"] }]);
    assert.match(back.lines.join("\n"), /U01 is not an earlier unit/);
  } finally { p.done(); }
});

test("the run's write contract: a unit outside its allowlist is refused on arrival", async () => {
  const p = project();
  try {
    mkdirSync(join(p.root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(p.root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, run_id: "r1", allowlist: ["src/a.ts"] }));
    await p.check("header.json", HEADER);
    const r = await p.check("units-001.json", [UNITS[0]]);
    assert.match(r.lines.join("\n"), /outside the write contract's allowlist \(src\/a\.ts\)/);
  } finally { p.done(); }
});

test("a file that is not valid JSON is refused at the line and column, with that line's text", async () => {
  const p = project();
  try {
    const r = await p.check("header.json", '{\n  "conventions": ["a"]\n  "file_checks": []\n}');
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /not valid JSON at line 3, column \d+/);
    assert.match(r.lines[0], /the line before \(2\) reads: +"conventions": \["a"\]/);
  } finally { p.done(); }
});

test("only the run's own section folder: another file, or a run that does not exist, is a usage error (exit 2)", async () => {
  const p = project();
  try {
    writeFileSync(join(p.root, "elsewhere.json"), JSON.stringify(HEADER));
    const out = await checkSection(p.root, "r1", "elsewhere.json");
    assert.equal(out.ok, false);
    assert.equal(out.usage, true);
    const none = await checkSection(p.root, "r9", ".sdlc/runs/r9/change.sections/header.json");
    assert.match(none.lines[0], /no run folder \.sdlc\/runs\/r9/);
    const bad = await checkSection(p.root, "../x", "header.json");
    assert.match(bad.lines[0], /--run-id must be the run's id/);
    assert.equal(await main(["--section", "x.json"]), 2, "no run id");
  } finally { p.done(); }
});

// red_checks: the checks of a test unit that must fail before the fix (a bugfix's reproducing test). They name the
// header's file checks, only a test unit has them, and a check is either one that must pass or one that must fail.
test("red_checks are checked on arrival: a test unit's, naming the header's file checks, never also among its checks", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", BUG_HEADER)).ok, true);
    assert.equal((await p.check("units-001.json", BUG_UNITS)).ok, true, "the bugfix fixture is accepted");
    const bad = [
      { ...BUG_UNITS[0], red_checks: ["nope"] },
      { ...BUG_UNITS[1], red_checks: ["unit"] },
    ];
    const r = await p.check("units-002.json", [{ ...bad[0], id: "U03", path: "test/b.test.ts" }, { ...bad[1], id: "U04", path: "src/x.ts", sites: [{ id: "S1", at: "replace", from: 1, to: 1, first_line: "export const x = 1;", rule: "r" }], depends_on: [] }, { ...BUG_UNITS[0], id: "U05", path: "test/c.test.ts", checks: ["lint", "unit"], red_checks: ["unit"] }]);
    assert.equal(r.ok, false);
    const text = r.lines.join("\n");
    assert.match(text, /U03\.red_checks: nope is not a file check in the header/);
    assert.match(text, /U04 \(src\/x\.ts\): only a tests unit has red_checks/);
    assert.match(text, /U05\.red_checks: unit is also among its checks; a check either must pass or must fail/);
  } finally { p.done(); }
});
