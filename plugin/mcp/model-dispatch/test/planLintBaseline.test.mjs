/**
 * plan-lint.mjs runs each unit's file checks on the file as it is before the change (an edit's own file, a new file's
 * style file), the baseline the server takes at dispatch (apply.ts baselineChecks), while the architect still has the
 * section open. A check that fails there would be set aside at dispatch and judge nothing, so the section is refused
 * with the check's output: the architect fixes a wrong command, or takes the check off a file that already fails it.
 * A reproducing test's red checks, on an existing test file, must pass before the change: a file that already fails
 * cannot show that its new case reproduces the bug. Offline, $0: shell built-ins and node on real files, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { HEADER, UNITS, BUG_HEADER, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));

const text = (r) => r.lines.join("\n");
const header = (checks) => ({ ...HEADER, file_checks: checks });

test("a check that fails on the edited file as it is now is refused with its output; one that passes is accepted", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", header([{ id: "has-y", run: "grep -q 'const y' {path}", timeout_s: 10 }]))).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["has-y"] }]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U02\.checks: has-y fails on src\/a\.ts as it is now, before any change \(exit 1\)/);
    assert.match(text(r), /if the file already fails it, take has-y out of this unit's checks; if the command is wrong, fix it in the header, then check the header and this file again/);
    assert.equal(existsSync(join(p.root, ".sdlc", "runs", "r1", "change.parts", "units-001.json")), false, "nothing stored");
    assert.equal((await p.check("header.json", header([{ id: "has-y", run: "grep -q 'import' {path}", timeout_s: 10 }]))).ok, true);
    const ok = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["has-y"] }]);
    assert.equal(ok.ok, true, text(ok));
  } finally { p.done(); }
});

test("a new file's checks run on its style file: a command wrong for every file is caught before any typing", async () => {
  const p = project();
  try {
    // A runner started in a folder where the path leads nowhere fails on every file, whatever the file holds.
    assert.equal((await p.check("header.json", header([{ id: "unit-file", run: "cd src && test -f {path}", timeout_s: 10 }]))).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[0], checks: ["unit-file"] }]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U01\.checks: unit-file fails on src\/x\.ts \(its style file\) as it is now, before any change \(exit 1\)/);
  } finally { p.done(); }
});

test("a check's output reaches the architect, tailed to the server's receipt bound", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", header([{ id: "loud", run: "node -e \"console.error('x'.repeat(9000) + 'THE END'); process.exit(3)\" -- {path}", timeout_s: 10 }]))).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["loud"] }]);
    assert.match(text(r), /\(exit 3\)/);
    assert.match(text(r), /THE END/);
    assert.ok(text(r).length < 9000, "the end of the output, where the failure is, within the bound");
  } finally { p.done(); }
});

test("a check that runs past its time is stopped with everything it started, and refused as timed out", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", header([{ id: "slow", run: "sleep 8 && test -s {path}", timeout_s: 1 }]))).ok, true);
    const started = Date.now();
    const r = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["slow"] }]);
    assert.ok(Date.now() - started < 6000, `stopped at its limit, not when the command ended (${Date.now() - started} ms)`);
    assert.match(text(r), /U02\.checks: slow fails on src\/a\.ts as it is now, before any change \(timed out after 1s\)/);
  } finally { p.done(); }
});

test("a check never sees the vendor credentials of the session that runs plan-lint", async () => {
  const p = project();
  const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.SOME_VENDOR_API_KEY };
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  process.env.SOME_VENDOR_API_KEY = "also-not-real";
  try {
    assert.equal((await p.check("header.json", header([{ id: "env", run: "test -z \"$ANTHROPIC_API_KEY$SOME_VENDOR_API_KEY\" && test -s {path}", timeout_s: 10 }]))).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["env"] }]);
    assert.equal(r.ok, true, text(r));
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.SOME_VENDOR_API_KEY; else process.env.SOME_VENDOR_API_KEY = saved.b;
    p.done();
  }
});

test("a pair that passed is not run again while the command and the file are unchanged", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", header([{ id: "count", run: "echo x >> ran.log && test -s {path}", timeout_s: 10 }]))).ok, true);
    const units = [{ ...UNITS[1], depends_on: [], checks: ["count"] }];
    assert.equal((await p.check("units-001.json", units)).ok, true);
    assert.equal((await p.check("units-001.json", units)).ok, true, "the same section again");
    assert.equal(readFileSync(join(p.root, "ran.log"), "utf8"), "x\n", "run once");
    p.file("src/a.ts", 'import { x } from "./x";\r\n\r\nexport function a() {\r\n  return x;\r\n}\r\n// changed\r\n');
    assert.equal((await p.check("units-001.json", units)).ok, true);
    assert.equal(readFileSync(join(p.root, "ran.log"), "utf8"), "x\nx\n", "a changed file is checked again");
  } finally { p.done(); }
});

test("a header sent again after units were accepted runs its checks on their files: a changed command is tried at once", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    assert.equal((await p.check("units-001.json", UNITS)).ok, true);
    const r = await p.check("header.json", header([{ id: "lint", run: "grep -q NEVER {path}", timeout_s: 10 }]));
    assert.equal(r.ok, false);
    assert.match(text(r), /units-001\.json U01\.checks: lint fails on src\/x\.ts \(its style file\)/);
    assert.match(text(r), /units-001\.json U02\.checks: lint fails on src\/a\.ts/);
  } finally { p.done(); }
});

// A bugfix's reproducing case added to a test file the project has: its red checks run on the file before the change.
test("a reproducing test in an existing test file: its red checks must pass before the change, or its failure proves nothing", async () => {
  const p = project();
  try {
    p.file("test/old.test.mjs", "// a suite that already fails\nprocess.exit(1);\n");
    p.file("test/good.test.mjs", "// a suite that passes\nconst ok = true;\n");
    const h = { ...BUG_HEADER, file_checks: [...BUG_HEADER.file_checks, { id: "run", run: "node {path}", timeout_s: 30 }] };
    assert.equal((await p.check("header.json", h)).ok, true);
    const unit = (path, first) => ({ id: "U01", path, action: "edit", phase: "tests", behaviour: "b", sites: [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: first, rule: "the case" }], depends_on: [], checks: ["lint"], red_checks: ["run"] });
    const r = await p.check("units-001.json", [unit("test/old.test.mjs", "// a suite that already fails")]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U01\.red_checks: run already fails on test\/old\.test\.mjs before the change, so its failure cannot show that the new case reproduces the bug: point the red check at the new case only, or put the case in a new test file/);
    const ok = await p.check("units-001.json", [unit("test/good.test.mjs", "// a suite that passes")]);
    assert.equal(ok.ok, true, text(ok));
  } finally { p.done(); }
});

// plan-lint runs a unit's checks itself, where Claude Code's own Bash rules see only the `node plan-lint.mjs` call, and
// zero-touch allows that call without a prompt. The server holds every command it runs for a packet to the person's
// Bash deny rules (apply.ts, its packet's checks, write forms and red checks); plan-lint holds its own runs to the same
// rules, and refuses a check the server would refuse, before anything runs.
test("a check the person's Claude settings deny is never run by plan-lint: the section is refused, naming the rule", async () => {
  const p = project();
  try {
    p.file(".claude/settings.json", JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] } }));
    const h = header([
      { id: "net", run: "curl -s http://127.0.0.1:9/ ; touch ran-marker && test -s {path}", timeout_s: 10 },
      { id: "fmt", run: "test -s {path}", fix: "curl -s -o {path} http://127.0.0.1:9/", timeout_s: 10 },
    ]);
    assert.equal((await p.check("header.json", h)).ok, true);
    const r = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["net"] }]);
    assert.equal(r.ok, false);
    assert.match(text(r), /U02\.checks: net runs `curl -s http:\/\/127\.0\.0\.1:9\/ ; touch ran-marker && test -s 'src\/a\.ts'`, which the person's Claude settings deny \(Bash\(curl:\*\)\)/);
    assert.match(text(r), /the server refuses a packet whose check, write form or red check they deny/);
    assert.match(text(r), /a different check is the person's decision: return and say which command the plan needs and why/);
    assert.equal(existsSync(join(p.root, "ran-marker")), false, "the denied command never ran");
    // A write form the server would run after the write is held to the same rules, though plan-lint never runs one.
    const fix = await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["fmt"] }]);
    assert.equal(fix.ok, false);
    assert.match(text(fix), /U02\.checks: fmt's write form runs `curl -s -o 'src\/a\.ts' http:\/\/127\.0\.0\.1:9\/`, which the person's Claude settings deny \(Bash\(curl:\*\)\)/);
    // A header sent again after its units were accepted runs their checks too: the same rule holds there.
    assert.equal((await p.check("header.json", header([{ id: "net", run: "test -s {path}", timeout_s: 10 }]))).ok, true);
    assert.equal((await p.check("units-001.json", [{ ...UNITS[1], depends_on: [], checks: ["net"] }])).ok, true);
    const again = await p.check("header.json", h);
    assert.equal(again.ok, false);
    assert.match(text(again), /units-001\.json U02\.checks: net runs `curl [^`]*`, which the person's Claude settings deny \(Bash\(curl:\*\)\)/);
    assert.equal(existsSync(join(p.root, "ran-marker")), false, "still never ran");
  } finally { p.done(); }
});

// The deny check reads a command as text; shell syntax ($, backquotes, brackets, redirects, quotes beyond the path's
// own) can hide a command from it. While the person has deny rules, plan-lint does not run such a check: its baseline
// is left to dispatch, where the call keeps Claude Code's prompt (lib/own-steps.mjs serverCommandUnchecked). With no
// deny rules there is nothing to hide from, and the check runs.
test("while deny rules exist, a check whose shell syntax the deny check cannot read is left to dispatch, not run", async () => {
  const p = project();
  try {
    const h = header([{ id: "hidden", run: "$(echo touch) ran-marker && test -s {path}", timeout_s: 10 }]);
    assert.equal((await p.check("header.json", h)).ok, true);
    const units = [{ ...UNITS[1], depends_on: [], checks: ["hidden"] }];
    p.file(".claude/settings.json", JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    const r = await p.check("units-001.json", units);
    assert.equal(r.ok, true, text(r));
    assert.equal(existsSync(join(p.root, "ran-marker")), false, "not run under deny rules");
    p.file(".claude/settings.json", JSON.stringify({ permissions: { deny: [] } }));
    assert.equal((await p.check("units-001.json", units)).ok, true);
    assert.equal(existsSync(join(p.root, "ran-marker")), true, "run when there is no rule to hide from");
  } finally { p.done(); }
});

// A new file's checks first run on its style file (its baseline), so a check is held to the deny rules with the style
// file's path too: the command plan-lint and the server would run is the one judged.
test("a new file's check is held to the deny rules as it runs on the style file", async () => {
  const p = project();
  try {
    p.file(".claude/settings.json", JSON.stringify({ permissions: { deny: ["Bash(*x.ts*)"] } }));
    assert.equal((await p.check("header.json", header([{ id: "lint", run: "test -s {path}", timeout_s: 10 }]))).ok, true);
    const r = await p.check("units-001.json", [UNITS[0]]);
    assert.equal(r.ok, false, "the baseline run on src/x.ts is denied");
    assert.match(text(r), /U01\.checks: lint runs `test -s 'src\/x\.ts'`, which the person's Claude settings deny/);
  } finally { p.done(); }
});
