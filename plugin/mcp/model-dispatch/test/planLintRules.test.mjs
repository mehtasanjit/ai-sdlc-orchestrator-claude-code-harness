/**
 * plan-lint.mjs: the rules a units or header section meets on arrival, beyond its shape — what the run may read and
 * write (the write contract and the always-off-limits list), the server's bound on one input, a tooling step's folder,
 * a reproducing test's own checks, and the job's rules once the run's job is known (Gate 0's record in
 * intent_brief.md, or --intent). Each refusal names the unit and the field, so the architect fixes it with one Edit in
 * the same session. Offline, $0: real files in a temporary project, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const { main } = await import(join(SCRIPTS, "plan-lint.mjs"));
const { MAX_SLICE_BYTES } = await import(join(SCRIPTS, "lib", "change-spec.mjs"));
const { HEADER, UNITS, BUG_HEADER, BUG_UNITS, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));

const text = (r) => r.lines.join("\n");

// Nothing a model reads may come from a file the run may never touch: the always-off-limits list (credentials, git's
// store, machine config) at any depth, and the run contract's own off_limits. Only the run's own folder is exempt.
test("a uses or style_from path that is off-limits is refused with the pattern it matches: its text would reach a model", async () => {
  const p = project();
  try {
    p.file(".env", "DATABASE_PASSWORD=hunter2\n");
    p.file("secrets/prod.yml", "password: x\n");
    p.file(".git/config", "[core]\n");
    p.file("config/.env.local", "K=V\n");
    p.contract({ allowlist: ["src/**"], off_limits: ["secrets/**"] });
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    const cases = [
      [{ ...UNITS[0], style_from: { path: ".env", reason: "env keys" } }, /U01\.style_from: \.env is off-limits \(always: \.env\)/],
      [{ ...UNITS[0], uses: [{ path: "secrets/prod.yml", reason: "r" }] }, /U01\.uses\[0\]: secrets\/prod\.yml is off-limits \(the write contract: secrets\/\*\*\)/],
      [{ ...UNITS[0], uses: [{ path: ".git/config", reason: "r" }] }, /U01\.uses\[0\]: \.git\/config is off-limits \(always: \.git\/\*\*\)/],
      [{ ...UNITS[0], uses: [{ path: "config/.env.local", reason: "r" }] }, /config\/\.env\.local is off-limits \(always: \.env\.\*\)/],
    ];
    for (const [unit, want] of cases) {
      const r = await p.check("units-001.json", [unit]);
      assert.equal(r.ok, false, `${want} should be refused`);
      assert.match(text(r), want);
      assert.match(text(r), /its text is never sent to a model/);
    }
  } finally { p.done(); }
});

test("a uses path that links to an off-limits file is judged by the file it reaches", async () => {
  const p = project();
  try {
    p.file(".env", "DATABASE_PASSWORD=hunter2\n");
    symlinkSync(join(p.root, ".env"), join(p.root, "src", "settings.txt"));
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[0], uses: [{ path: "src/settings.txt", reason: "r" }] }]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U01\.uses\[0\]: src\/settings\.txt is off-limits \(always: \.env, through the link to \.env\)/);
  } finally { p.done(); }
});

// The write side, in the order the server's writer refuses: always-off-limits at any depth, the contract's off_limits,
// then its allowlist. A unit on such a file would be typed, paid for, its text sent out, and then refused at write.
test("a unit's own file is held to the writer's whole rule: always-off-limits, then the contract's off_limits, then its allowlist", async () => {
  const p = project();
  try {
    p.file("config/secrets.yml", "db:\n  password: CONFIGSECRET\n");
    p.file(".env.example", "K=\n");
    p.file("config/.env.local", "K=V\n");
    p.contract({ allowlist: ["config/**", "src/**", ".env.example"], off_limits: ["config/secrets.yml"] });
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    const edit = (path, first) => ({ id: "U01", path, action: "edit", phase: "codegen", behaviour: "b", sites: [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: first, rule: "r" }], depends_on: [] });
    const cases = [
      [edit("config/secrets.yml", "db:"), /U01 \(config\/secrets\.yml\): off-limits \(the write contract: config\/secrets\.yml\); plan only files the run may write/],
      [edit(".env.example", "K="), /U01 \(\.env\.example\): off-limits \(always: \.env\.\*\)/],
      [edit("config/.env.local", "K=V"), /U01 \(config\/\.env\.local\): off-limits \(always: \.env\.\*\)/],
    ];
    for (const [unit, want] of cases) {
      const r = await p.check("units-001.json", [unit]);
      assert.equal(r.ok, false, `${want} should be refused`);
      assert.match(text(r), want);
    }
  } finally { p.done(); }
});

// The server refuses an input over its bound at dispatch, which fails the packet and blocks the packets that wait for
// it; the same bound, checked on arrival, costs the architect one Edit.
test("a uses or style_from slice over the server's bound on one input is refused on arrival; narrowed with lines, it is accepted", async () => {
  const p = project();
  try {
    const row = '{"id": 1, "name": "a value"},\n';
    p.file("data/selection.json", row.repeat(Math.ceil((MAX_SLICE_BYTES + 1000) / row.length)));
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    const whole = await p.check("units-001.json", [{ ...UNITS[0], uses: [{ path: "data/selection.json", reason: "r" }] }]);
    assert.equal(whole.ok, false);
    assert.match(text(whole), new RegExp(`U01\\.uses\\[0\\]: data/selection\\.json is \\d+ bytes, over the server's bound on one input \\(${MAX_SLICE_BYTES}\\): narrow it with lines`));
    const style = await p.check("units-001.json", [{ ...UNITS[0], style_from: { path: "data/selection.json", reason: "r" } }]);
    assert.match(text(style), /U01\.style_from: data\/selection\.json is \d+ bytes/);
    const narrowed = await p.check("units-001.json", [{ ...UNITS[0], uses: [{ path: "data/selection.json", lines: [1, 20], reason: "r" }] }]);
    assert.equal(narrowed.ok, true, text(narrowed));
  } finally { p.done(); }
});

// A tooling step runs through the shell where its cwd says: the same path rule as every other path of the spec.
test("a tooling unit's cwd is a path relative to the project root, like every other path of the spec", async () => {
  const p = project();
  try {
    p.file("package.json", "{}\n");
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    for (const cwd of ["../..", "/etc", ".sdlc/runs"]) {
      const r = await p.check("units-001.json", [{ id: "U01", path: "package.json", action: "tooling", phase: "codegen", behaviour: "b", run: "touch outside-marker", cwd, depends_on: [] }]);
      assert.equal(r.ok, false, cwd);
      assert.match(text(r), /U01\.cwd: /);
    }
    const ok = await p.check("units-001.json", [{ id: "U01", path: "package.json", action: "tooling", phase: "codegen", behaviour: "b", run: "npm install", cwd: "src", depends_on: [] }]);
    assert.equal(ok.ok, true, text(ok));
  } finally { p.done(); }
});

// A bugfix's reproducing test is judged by exit code alone, so a test file that fails on a typo would pass as the
// reproduction: a check that must pass proves the file is well-formed. A formatter must never rewrite the judge.
test("a reproducing test also names a check that must pass, and its red checks have no write form", async () => {
  const p = project();
  try {
    const header = { ...BUG_HEADER, file_checks: [...BUG_HEADER.file_checks, { id: "unit-fmt", run: "node --test {path}", fix: "touch {path}", timeout_s: 60 }] };
    assert.equal((await p.check("header.json", header)).ok, true);
    const noPass = await p.check("units-001.json", [{ ...BUG_UNITS[0], checks: undefined }]);
    assert.equal(noPass.ok, false);
    assert.match(text(noPass), /U01 \(test\/a\.test\.ts\): a reproducing test also names a check that must pass \(checks\): one that proves the file is well-formed \(a syntax, type or load check\)/);
    const withFix = await p.check("units-001.json", [{ ...BUG_UNITS[0], red_checks: ["unit-fmt"] }]);
    assert.equal(withFix.ok, false);
    assert.match(text(withFix), /U01\.red_checks: unit-fmt has a write form \(fix\); a formatter must not rewrite the test that judges the fix/);
  } finally { p.done(); }
});

// A typed test file with no check is applied unjudged: every mistake in it becomes a fix round of the orchestrator.
test("a tests unit names at least one file check: a test file can always be run on its own", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    const unit = { id: "U01", path: "test/b.test.ts", action: "create", phase: "tests", behaviour: "b returns 2.", style_from: { reason: "none yet" }, depends_on: [], tests: [{ name: "b", given: "x", expect: "2" }] };
    const r = await p.check("units-001.json", [unit]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U01 \(test\/b\.test\.ts\): a test file names at least one file check that runs or loads it \(checks\)/);
    assert.equal((await p.check("units-001.json", [{ ...unit, checks: ["lint"] }])).ok, true);
  } finally { p.done(); }
});

// The job's rules, on arrival: plan-lint reads the run's job from Gate 0's record (intent_brief.md) or --intent, and
// checks each section against it while the architect still has it open.
test("with the run's job known, a header without whole-project checks is refused on arrival for refactor, test and deps", async () => {
  for (const job of ["refactor", "test", "deps"]) {
    const p = project();
    try {
      p.brief(job);
      const r = await p.check("header.json", { ...HEADER, project_checks: [] });
      assert.equal(r.ok, false, job);
      assert.match(text(r), new RegExp(`a ${job} run is checked on the whole project`));
    } finally { p.done(); }
  }
  const p = project();
  try {
    assert.equal((await p.check("header.json", { ...HEADER, project_checks: [] })).ok, true, "no job known: finalize checks it");
  } finally { p.done(); }
});

test("with the run's job known, a units section that breaks the job's rules is refused on arrival", async () => {
  const cases = [
    // red_checks outside a bugfix.
    ["feature-extend", BUG_HEADER, [BUG_UNITS[0]], /U01 \(test\/a\.test\.ts\): red_checks are a bugfix run's reproducing test; this is a feature-extend run/],
    // A fix before any reproducing test.
    ["bugfix", BUG_HEADER, [BUG_UNITS[1]], /U02 \(src\/a\.ts\): a fix is typed after the test that reproduces the bug: put the tests unit with red_checks before it and add it to depends_on/],
    // A docs run holds documentation only.
    ["docs", HEADER, [UNITS[0]], /U01 \(src\/b\.ts\): a docs run holds documentation units only \(phase docs\); this unit is phase codegen/],
    // A tooling step is a shell command no gate shows in a job without Gate 2.
    ["test", HEADER, [{ id: "U01", path: "package.json", action: "tooling", phase: "codegen", behaviour: "b", run: "npm i -D vitest", depends_on: [] }], /U01 \(package\.json\): a tooling unit runs a shell step, and a test run has no Gate 2 to show it: a test run holds no tooling unit/],
    // A bugfix's tests units are its reproducing tests.
    ["bugfix", BUG_HEADER, [{ ...BUG_UNITS[0], red_checks: undefined }], /U01 \(test\/a\.test\.ts\): a bugfix run's tests units are the tests that reproduce the bug: give it red_checks/],
  ];
  for (const [job, header, units, want] of cases) {
    const p = project();
    try {
      p.file("package.json", "{}\n");
      p.brief(job);
      assert.equal((await p.check("header.json", header)).ok, true);
      const r = await p.check("units-001.json", units.map((u) => structuredClone(u)));
      assert.equal(r.ok, false, `${job}: ${want}`);
      assert.match(text(r), want);
    } finally { p.done(); }
  }
});

test("a reproducing test that waits for a fix, or comes after one, is refused: it must fail on the code as it is", async () => {
  const p = project();
  try {
    p.brief("bugfix");
    assert.equal((await p.check("header.json", BUG_HEADER)).ok, true);
    assert.equal((await p.check("units-001.json", [BUG_UNITS[0]])).ok, true);
    assert.equal((await p.check("units-002.json", [BUG_UNITS[1]])).ok, true, "the fix waits for the test");
    const late = await p.check("units-003.json", [{ ...BUG_UNITS[0], id: "U03", path: "test/c.test.ts", depends_on: ["U02"] }]);
    assert.equal(late.ok, false);
    assert.match(text(late), /U03 \(test\/c\.test\.ts\): the test that reproduces the bug waits for U02, a fix: it must fail on the code as it is, so it waits for no fix/);
    assert.match(text(late), /U03 \(test\/c\.test\.ts\): the tests that reproduce the bug come before every fix: put it before U02/);
  } finally { p.done(); }
});

test("--intent is checked against the run's job as Gate 0 recorded it; with no record, --intent names the job", async () => {
  const p = project();
  try {
    p.brief("bugfix");
    const r = await p.check("header.json", HEADER, { intent: "feature-extend" });
    assert.equal(r.ok, false);
    assert.equal(r.usage, true);
    assert.match(text(r), /--intent feature-extend is not this run's job: Gate 0 recorded bugfix \(intent_brief\.md\)/);
    assert.equal((await p.check("header.json", HEADER, { intent: "bugfix" })).ok, true);
    assert.equal(await main(["--section", ".sdlc/runs/r1/change.sections/header.json", "--run-id", "r1", "--project-root", p.root, "--intent", "docs"]), 2);
  } finally { p.done(); }
  const q = project();
  try {
    const r = await q.check("header.json", { ...HEADER, project_checks: [] }, { intent: "refactor" });
    assert.match(text(r), /a refactor run is checked on the whole project/, "no record: --intent names the job");
    const bad = await q.check("header.json", HEADER, { intent: "feature" });
    assert.equal(bad.usage, true);
    assert.match(text(bad), /--intent must be one of docs, bugfix/);
  } finally { q.done(); }
});

// Nothing inside a run widens its write contract: when the reproducing test's file is outside the allowlist, the
// refusal says so and how the run stops, instead of a loop of specs that can never finalize.
test("a reproducing test outside the allowlist is refused with the way out: the allowlist is the person's decision", async () => {
  const p = project();
  try {
    p.contract({ allowlist: ["src/**"] });
    assert.equal((await p.check("header.json", BUG_HEADER)).ok, true);
    const r = await p.check("units-001.json", [BUG_UNITS[0]]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U01 \(test\/a\.test\.ts\): outside the write contract's allowlist \(src\/\*\*\); plan only files the run may write; the test that reproduces the bug must be a file the run may write: if no such file will do, return and say which test file the run needs and why — the allowlist is the person's decision/);
  } finally { p.done(); }
});
