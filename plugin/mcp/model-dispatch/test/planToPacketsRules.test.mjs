/**
 * plan-to-packets.mjs --spec: the job's rules over the whole spec at finalize (what each job's spec holds, the order
 * of a bugfix and of a deps run), the run's job read from Gate 0's record, and what the derived packets carry so the
 * server can run and judge them: check commands whose `{path}` is quoted by the shell's own rules, the edit's sites,
 * and a rendered plan that shows every existing test the change edits. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const { finalize } = await import(join(SCRIPTS, "plan-to-packets.mjs"));
const { quotePath, fillPath, GATE2_JOBS } = await import(join(SCRIPTS, "lib", "change-spec.mjs"));
const { HEADER, UNITS, BUG_HEADER, BUG_UNITS, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));

const run = (root, intent) => finalize({ projectRoot: root, runId: "r1", intent });
const read = (root, f) => readFileSync(join(root, ".sdlc", "runs", "r1", f), "utf8");
const err = (r) => r.err.join("\n");
async function accepted(p, units, header = HEADER) {
  assert.equal((await p.check("header.json", header)).ok, true);
  const u = await p.check("units-001.json", units);
  assert.equal(u.ok, true, u.lines.join("\n"));
}
/** The shell's own reading of a command once the server fills `{path}` (apply.ts: the path in place of the token). */
const sh = (cmd, cwd) => spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8" });

const docUnit = { id: "U01", path: "docs/usage.md", action: "create", phase: "docs", behaviour: "How to use a.", style_from: { reason: "no doc yet" }, depends_on: [] };
const testUnit = { id: "U03", path: "test/b.test.ts", action: "create", phase: "tests", behaviour: "b is 2.", style_from: { reason: "none" }, depends_on: [], tests: [{ name: "b", given: "x", expect: "2" }], checks: ["lint"] };

test("a docs run holds documentation; a test run adds at least one test file; both finalize when they do", async () => {
  const cases = [
    ["docs", UNITS, /U01 \(src\/b\.ts\): a docs run holds documentation units only \(phase docs\); this unit is phase codegen/],
    ["test", UNITS, /a test run adds to the suite: the spec holds at least one tests unit/],
  ];
  for (const [job, units, want] of cases) {
    const p = project();
    try {
      await accepted(p, units);
      const r = await run(p.root, job);
      assert.equal(r.code, 1, job);
      assert.match(err(r), want);
    } finally { p.done(); }
  }
  const d = project();
  try {
    await accepted(d, [docUnit]);
    assert.equal((await run(d.root, "docs")).code, 0, "a docs spec of doc units");
  } finally { d.done(); }
  const t = project();
  try {
    await accepted(t, [...UNITS, testUnit]);
    assert.equal((await run(t.root, "test")).code, 0, "a test spec with a test file, and the source files its brief asks for");
  } finally { t.done(); }
});

test("a tooling unit is a shell step no gate shows in a bugfix, test or docs run: it is refused there", async () => {
  for (const job of ["bugfix", "test", "docs"]) {
    const p = project();
    try {
      p.file("package.json", "{}\n");
      await accepted(p, [{ id: "U01", path: "package.json", action: "tooling", phase: "docs", behaviour: "b", run: "pip install x", depends_on: [] }]);
      const r = await run(p.root, job);
      assert.equal(r.code, 1, job);
      // A bugfix opens Gate 2 only for a design-affecting spec, so no gate is sure to show the step there either.
      const why = job === "bugfix" ? "a bugfix run opens Gate 2 only for a design-affecting spec, so no gate is sure to show it" : `a ${job} run has no Gate 2 to show it`;
      assert.match(err(r), new RegExp(`U01 \\(package\\.json\\): a tooling unit runs a shell step, and ${why}: a ${job} run holds no tooling unit`));
    } finally { p.done(); }
  }
});

test("the jobs with a Gate 2 are the ones the run's texts give one", () => {
  // brownfield-runs.md, "The jobs": the table's Gate 2 column.
  const table = readFileSync(join(SCRIPTS, "..", "skills", "pipeline", "brownfield-runs.md"), "utf8");
  const yes = [...table.matchAll(/^\| (.+?) \| yes \|/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1]));
  assert.deepEqual([...GATE2_JOBS].sort(), yes.sort());
});

// A bugfix proves itself by its test: the test first, failing on the code as it is; then a fix that waits for it.
test("a bugfix spec needs a fix as well as its test, and a fix that comes first is told to move the test, not to wait for a later unit", async () => {
  const onlyTest = project();
  try {
    await accepted(onlyTest, [BUG_UNITS[0]], BUG_HEADER);
    const r = await run(onlyTest.root, "bugfix");
    assert.equal(r.code, 1);
    assert.match(err(r), /a bugfix run fixes the bug: add the fix, a codegen unit that waits for the test that reproduces it/);
  } finally { onlyTest.done(); }
  const fixFirst = project();
  try {
    const fix = { ...BUG_UNITS[1], id: "U01", depends_on: [] };
    const red = { ...BUG_UNITS[0], id: "U02", depends_on: ["U01"] };
    await accepted(fixFirst, [fix, red], BUG_HEADER);
    const r = await run(fixFirst.root, "bugfix");
    assert.equal(r.code, 1);
    assert.doesNotMatch(err(r), /add U02 to its depends_on/, "an instruction plan-lint would refuse");
    assert.match(err(r), /U02 \(test\/a\.test\.ts\): the tests that reproduce the bug come before every fix: put it before U01/);
    assert.match(err(r), /U02 \(test\/a\.test\.ts\): the test that reproduces the bug waits for U01, a fix/);
  } finally { fixFirst.done(); }
});

test("a bugfix with no reproducing test names the write contract when one binds: a test file the run may not write is the person's call", async () => {
  const p = project();
  try {
    p.contract({ allowlist: ["src/**"] });
    await accepted(p, [{ ...BUG_UNITS[1], depends_on: [] }], BUG_HEADER);
    const r = await run(p.root, "bugfix");
    assert.equal(r.code, 1);
    assert.match(err(r), /a bugfix run starts with the test that reproduces the bug/);
    assert.match(err(r), /the write contract allows src\/\*\*: if no test file the bug needs is among them, return and say which test file the run needs and why; the allowlist is the person's decision/);
  } finally { p.done(); }
});

// A deps run: the manifest edit, then the install, then the code that waits for it. A tooling unit's path is the file
// its step writes (the lockfile, as the architect is told), so the install's place is read from depends_on alone: it
// waits for a typed unit (the manifest edit), and every other unit comes before it or waits for it. An install that
// waits for no typed unit would run on the manifest as it is, with the manifest edit after it or nowhere.
test("a deps spec orders every unit around the install: the install waits for the manifest edit, the code waits for the install", async () => {
  const setup = (p) => {
    p.file("package.json", '{\n  "dependencies": {}\n}\n');
    p.file("package-lock.json", "{}\n");
    p.file("src/use.ts", "export const u = 1;\n");
  };
  const manifest = { id: "U01", path: "package.json", action: "edit", phase: "codegen", behaviour: "lib 2", sites: [{ id: "S1", at: "insert_after", from: 2, to: 2, first_line: '"dependencies": {}', rule: "r" }], depends_on: [], checks: ["lint"] };
  const install = { id: "U02", path: "package-lock.json", action: "tooling", phase: "codegen", behaviour: "install", run: "npm install", depends_on: ["U01"] };
  const code = { id: "U03", path: "src/use.ts", action: "edit", phase: "codegen", behaviour: "new API", sites: [{ id: "S1", at: "replace", from: 1, to: 1, first_line: "export const u = 1;", rule: "r" }], depends_on: ["U02"], checks: ["lint"] };
  const cases = [
    [[manifest, { ...install, depends_on: [] }, code], [/U02 \(package-lock\.json\): the install waits for no typed unit, so it would run on the manifest as it is: type the manifest edit before it and add that unit to U02's depends_on/, /U01 \(package\.json\): neither waits for the install \(U02\) nor is waited for by it: a file the install reads comes before it \(add U01 to U02's depends_on\)/]],
    [[manifest, install, { ...code, depends_on: [] }], [/U03 \(src\/use\.ts\): neither waits for the install \(U02\) nor is waited for by it: code a dependency upgrade needs waits for the install \(add U02 to its depends_on\)/]],
    // The install first, the manifest edit waiting for it: the install would run on the old manifest.
    [[{ ...install, id: "U01", depends_on: [] }, { ...manifest, id: "U02", depends_on: ["U01"] }, { ...code, depends_on: ["U01"] }], [/U01 \(package-lock\.json\): the install waits for no typed unit/]],
  ];
  for (const [units, wants] of cases) {
    const p = project();
    try {
      setup(p);
      await accepted(p, units);
      const r = await run(p.root, "deps");
      assert.equal(r.code, 1);
      for (const want of wants) assert.match(err(r), want);
      assert.doesNotMatch(err(r), /add U0\d to U01's depends_on/, "never a dependency on a later unit");
    } finally { p.done(); }
  }
  const p = project();
  try {
    setup(p);
    await accepted(p, [manifest, install, code]);
    const r = await run(p.root, "deps");
    assert.equal(r.code, 0, err(r));
  } finally { p.done(); }
});

// One convention for a tooling unit's path, held on arrival in every job: the file its step writes, which no model
// types. A typed unit at that path would be typed and then written over by the step (or the step's file read as the
// manifest), so the two never share a path, whichever section comes first.
test("a tooling unit's path is the file its step writes: no typed unit shares it", async () => {
  for (const order of ["typed first", "tooling first"]) {
    const p = project();
    try {
      p.file("package.json", '{\n  "dependencies": {}\n}\n');
      const typed = { id: "U01", path: "package.json", action: "edit", phase: "codegen", behaviour: "lib 2", sites: [{ id: "S1", at: "insert_after", from: 2, to: 2, first_line: '"dependencies": {}', rule: "r" }], depends_on: [], checks: ["lint"] };
      const tool = { id: "U02", path: "package.json", action: "tooling", phase: "codegen", behaviour: "install", run: "npm install", depends_on: ["U01"] };
      assert.equal((await p.check("header.json", HEADER)).ok, true);
      const units = order === "typed first" ? [typed, tool] : [{ ...tool, id: "U01", depends_on: [] }, { ...typed, id: "U02" }];
      const r = await p.check("units-001.json", units);
      assert.equal(r.ok, false, order);
      assert.match(r.lines.join("\n"), /a tooling unit's path is the file its step writes \(an install: its lockfile\), which no model types: give the tooling unit the file its step writes, or leave this file to the step/, order);
    } finally { p.done(); }
  }
});

// A bugfix opens Gate 2 only when its spec is design-affecting, and code decides it from the spec, never from its
// wording (brownfield-runs.md, "The jobs"): a recorded decision, a file created outside the tests phase, or lines of an
// existing test file replaced or deleted (anything beyond the new case that reproduces the bug). The summary says so,
// with the first reason; the other jobs open it always or never.
test("plan-to-packets' summary says whether Gate 2 opens: for a bugfix, only when its spec is design-affecting", async () => {
  const plain = { ...BUG_HEADER, decisions: undefined, file_checks: [{ id: "lint", run: "test -s {path}", timeout_s: 10 }, { id: "unit", run: "test -s {path}", timeout_s: 10 }] };
  const gate = async (units, header = plain, intent = "bugfix", setup = () => {}) => {
    const p = project();
    try {
      setup(p);
      await accepted(p, units, header);
      const r = await run(p.root, intent);
      assert.equal(r.code, 0, err(r));
      return { text: r.text, json: r.out[0] };
    } finally { p.done(); }
  };
  const none = await gate(BUG_UNITS);
  assert.match(none.text, / · Gate 2: no$/);
  assert.equal(none.json.gate2, false);
  assert.equal(typeof none.json.gate2_reason, "string");
  const decided = await gate(BUG_UNITS, { ...plain, decisions: [{ topic: "retry policy", choice: "none", reason: "the bug is the retry" }] });
  assert.match(decided.text, / · Gate 2: yes \(the spec records a decision: retry policy\)$/);
  assert.equal(decided.json.gate2, true);
  assert.equal(decided.json.gate2_reason, "the spec records a decision: retry policy");
  const helper = { id: "U03", path: "src/helper.ts", action: "create", phase: "codegen", behaviour: "h", style_from: { reason: "none" }, depends_on: ["U01"], checks: ["lint"] };
  assert.match((await gate([...BUG_UNITS, helper])).text, / · Gate 2: yes \(U03 creates src\/helper\.ts outside the tests phase\)$/);
  const loosen = { id: "U01", path: "test/old.test.ts", action: "edit", phase: "tests", behaviour: "b", sites: [{ id: "S1", at: "replace", from: 2, to: 2, first_line: "expect(add(2, 3)).toBe(5);", rule: "the new case" }], depends_on: [], checks: ["lint"], red_checks: ["unit"] };
  const replaced = await gate([loosen, BUG_UNITS[1]], plain, "bugfix", (p) => p.file("test/old.test.ts", "it('adds', () => {\nexpect(add(2, 3)).toBe(5);\n});\n"));
  assert.match(replaced.text, / · Gate 2: yes \(U01 replaces lines of an existing test file: test\/old\.test\.ts, S1\)$/);
  const added = await gate([{ ...loosen, sites: [{ id: "S1", at: "insert_after", from: 3, to: 3, first_line: "});", rule: "the new case" }] }, BUG_UNITS[1]], plain, "bugfix", (p) => p.file("test/old.test.ts", "it('adds', () => {\nexpect(add(2, 3)).toBe(5);\n});\n"));
  assert.match(added.text, / · Gate 2: no$/, "a new case added to an existing test file is the reproduction itself");
  assert.match((await gate(UNITS, HEADER, "feature-extend")).text, / · Gate 2: yes \(every feature-extend run\)$/);
  assert.match((await gate([docUnit], HEADER, "docs")).text, / · Gate 2: no$/);
});

// The checked party does not name its own rules: the run's job is the one Gate 0 recorded.
test("finalize refuses an --intent that is not the job Gate 0 recorded for the run", async () => {
  const p = project();
  try {
    await accepted(p, [{ ...BUG_UNITS[1], depends_on: [] }], BUG_HEADER);
    p.brief("bugfix");
    const r = await run(p.root, "feature-extend");
    assert.equal(r.code, 2);
    assert.match(err(r), /--intent feature-extend is not this run's job: Gate 0 recorded bugfix \(intent_brief\.md\)/);
    assert.equal((await run(p.root, "bugfix")).code, 1, "under its own job, the bugfix rules hold");
  } finally { p.done(); }
});

// Code quotes every `{path}` by the shell's own rules (quotePath), so the command the architect wrote runs as written
// whatever the path holds ($ in route files, spaces), except a single quote: the server fills the path in as written,
// inside those quotes, so a checked file whose path holds one is refused on arrival (below).
test("{path} is single-quoted where it stands: on its own, joined to a word, or wrapped in quotes of its own", () => {
  assert.equal(quotePath("node --check {path}"), "node --check '{path}'");
  assert.equal(quotePath("node --check ./{path}"), "node --check ./'{path}'");
  assert.equal(quotePath("tool --file={path}"), "tool --file='{path}'");
  assert.equal(quotePath('biome check "{path}" && x \'{path}\''), "biome check '{path}' && x '{path}'");
  assert.equal(quotePath("node -e \"console.log(1)\" {path}"), "node -e \"console.log(1)\" '{path}'", "quotes elsewhere are left alone");
  for (const bad of ['node --check "./{path}"', "node -e 'require(\"fs\").statSync(\"{path}\")'", 'node -e "import(\'./{path}\')"', "x \\{path}", "x '{path}"]) {
    assert.throws(() => quotePath(bad), /\{path\}|quote/, bad);
  }
});

test("a file check whose {path} sits inside a longer quoted string is refused on arrival, with how to write it", async () => {
  const p = project();
  try {
    const r = await p.check("header.json", { ...HEADER, file_checks: [{ id: "syntax", run: 'node --check "./{path}"', timeout_s: 10 }] });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /header\.json \/file_checks\/0\/run: \{path\} sits inside a quoted string: write it outside quotes — code puts the path in single quotes itself, so \.\/\{path\} works and "\.\/\{path\}" does not/);
    const open = await p.check("header.json", { ...HEADER, file_checks: [{ id: "syntax", run: "node --check {path} 'x", timeout_s: 10 }] });
    assert.match(open.lines.join("\n"), /header\.json \/file_checks\/0\/run: the command leaves a quote open/);
  } finally { p.done(); }
});

// fillPath is code's own fill, for the commands code runs or hands over as written (plan-lint's run of a check before
// the change, a bugfix's end-of-run test command): exact for any path, a quote included.
test("a quoted check runs on its file through the shell: a path joined to ./, a path with $ or a quote in it", () => {
  const p = project();
  try {
    p.file("src/routes/$userId.tsx", "export {};\n");
    p.file("docs/What's new.md", "# New\n");
    for (const [cmd, path] of [["test -s ./{path}", "src/x.ts"], ["test -s {path}", "src/routes/$userId.tsx"], ["grep -q '^# ' {path}", "docs/What's new.md"]]) {
      const r = sh(fillPath(quotePath(cmd), path), p.root);
      assert.equal(r.status, 0, `${cmd} on ${path}: ${r.stderr}`);
    }
  } finally { p.done(); }
});

// The server fills a packet's `{path}` with the path as written (apply.ts), inside the single quotes code puts around
// it, so a quote in the path ends them: the shell refuses the command, a baseline that cannot run sets the check aside,
// and a red check that cannot run reads as failing. plan-lint, finalize and the server agree only if such a file has
// no check: one that would carry checks is refused on arrival, and so is a style file with one that a new file's
// checks would run on first. A file whose path holds a quote can still be planned, without checks.
test("a checked file whose path holds a single quote is refused on arrival; the same file without checks is accepted", async () => {
  const p = project();
  try {
    p.file("docs/What's new.md", "# New\n");
    p.file("src/it's.ts", "export const i = 1;\n");
    assert.equal((await p.check("header.json", BUG_HEADER)).ok, true);
    const doc = { id: "U01", path: "docs/What's new.md", action: "edit", phase: "docs", behaviour: "b", sites: [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: "# New", rule: "r" }], depends_on: [], checks: ["lint"] };
    const r = await p.check("units-001.json", [doc]);
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /U01 \(docs\/What's new\.md\): the server puts a file's path into its checks as it is written, inside single quotes, so the ' in this path ends them and no check could run on it: give this file no checks/);
    const red = await p.check("units-001.json", [{ ...BUG_UNITS[0], path: "test/it's.test.ts" }]);
    assert.equal(red.ok, false);
    assert.match(red.lines.join("\n"), /U01 \(test\/it's\.test\.ts\): the server puts a file's path into its checks as it is written[^\n]*a test file needs a check, so put the case in a test file whose path has no '/);
    const styled = await p.check("units-001.json", [{ ...UNITS[0], style_from: { path: "src/it's.ts", reason: "same style" } }]);
    assert.equal(styled.ok, false);
    assert.match(styled.lines.join("\n"), /U01\.style_from: a new file's checks run first on its style file, and the server puts that path into them as it is written, inside single quotes, so the ' in src\/it's\.ts ends them: give a style file whose path has no '/);
    const unchecked = await p.check("units-001.json", [{ ...doc, checks: undefined }]);
    assert.equal(unchecked.ok, true, unchecked.lines.join("\n"));
  } finally { p.done(); }
});

// An edit is typed "at these sites only": the packet carries the sites so the server can hold the answer to them.
test("an edit packet carries its sites, as line ranges of the file before the change", async () => {
  const p = project();
  try {
    await accepted(p, UNITS);
    assert.equal((await run(p.root, "feature-extend")).code, 0);
    const [b, a] = JSON.parse(read(p.root, "packets.json"));
    assert.deepEqual(a.apply.sites, [{ id: "S1", at: "insert_after", from: 1, to: 1 }]);
    assert.equal(b.apply.sites, undefined, "a new file has none");
  } finally { p.done(); }
});

// A change to an existing test's lines changes what the suite pins: the plan lists each one under its own heading,
// so the gate and the reviewers see it as such, not as one more site.
test("the rendered plan lists every replace or delete site on an existing test file under its own heading", async () => {
  const p = project();
  try {
    p.file("tests/test_calc.py", "from calc import divide\n\ndef test_divide():\n    assert divide(7, 2) == 3.5\n");
    const t = { id: "U03", path: "tests/test_calc.py", action: "edit", phase: "tests", behaviour: "b", sites: [{ id: "S1", at: "replace", from: 4, to: 4, first_line: "assert divide(7, 2) == 3.5", rule: "floor division" }], depends_on: [], checks: ["lint"] };
    await accepted(p, [...UNITS, t]);
    assert.equal((await run(p.root, "refactor")).code, 0);
    const plan = read(p.root, "change_plan.md");
    assert.match(plan, /## Existing tests this change edits\n\nEach changes lines of a test file the project already has, so it changes what the suite checks\.\n\n- U03 `tests\/test_calc\.py` S1: replace line 4 \(`assert divide\(7, 2\) == 3\.5`\) — floor division/);
  } finally { p.done(); }
  const q = project();
  try {
    await accepted(q, UNITS);
    await run(q.root, "feature-extend");
    assert.doesNotMatch(read(q.root, "change_plan.md"), /Existing tests this change edits/, "only when there is one");
  } finally { q.done(); }
});
