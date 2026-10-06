/**
 * A typed change spec and a small project it fits, shared by the tests of plan-lint.mjs and plan-to-packets.mjs.
 * src/a.ts has CRLF endings, as a Windows checkout gives; src/x.ts is LF.
 *
 * The file checks are shell built-ins (`test -s`, `touch`): plan-lint runs each unit's checks on its file before the
 * change, so a check here must run offline and at no cost, as every test of this suite does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts");
const { checkSection } = await import(join(SCRIPTS, "plan-lint.mjs"));

// plan-lint holds every check it runs to the person's Bash deny rules, read from the settings Claude Code reads
// (lib/change-spec.mjs baselineErrors). These tests read none of this machine's: an empty settings folder and no
// managed settings file, so only a project's own .claude/settings.json, written by a test, holds a rule.
const SETTINGS = mkdtempSync(join(tmpdir(), "change-spec-settings-"));
process.env.CLAUDE_CONFIG_DIR = SETTINGS;
process.env.MMO_MANAGED_SETTINGS = join(SETTINGS, "managed-settings.json");
process.on("exit", () => rmSync(SETTINGS, { recursive: true, force: true }));

export const HEADER = {
  conventions: ["two-space indent", "double quotes"],
  decisions: [{ topic: "b's value", choice: "2", reason: "FR-1" }],
  file_checks: [{ id: "lint", run: "test -s {path}", fix: "touch {path}", timeout_s: 45 }],
  project_checks: [{ id: "types", run: "npx tsc --noEmit" }],
};
export const UNITS = [
  { id: "U01", path: "src/b.ts", action: "create", phase: "codegen", behaviour: "Exports b, returning 2.", exports: [{ name: "b", params: [], returns: "number" }], import_line: 'import { b } from "./b";', style_from: { path: "src/x.ts", reason: "same module style" }, depends_on: [], covers: ["FR-1"], checks: ["lint"] },
  { id: "U02", path: "src/a.ts", action: "edit", phase: "codegen", behaviour: "a also imports b.", sites: [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: 'import { x } from "./x";', rule: "import b" }], depends_on: ["U01"], checks: ["lint"] },
];

/**
 * A bugfix's spec: the test that reproduces the bug first (its `unit` check must fail before the fix: red_checks), then
 * the fix, which waits for it.
 */
export const BUG_HEADER = { ...HEADER, file_checks: [...HEADER.file_checks, { id: "unit", run: "npx vitest run {path}", timeout_s: 120 }] };
export const BUG_UNITS = [
  { id: "U01", path: "test/a.test.ts", action: "create", phase: "tests", behaviour: "a() returns b's value.", style_from: { reason: "no test file yet" }, depends_on: [], tests: [{ name: "a returns 2", given: "the module", expect: "a() is 2" }], checks: ["lint"], red_checks: ["unit"] },
  { id: "U02", path: "src/a.ts", action: "edit", phase: "codegen", behaviour: "a returns 2.", sites: [{ id: "S1", at: "replace", from: 4, to: 4, first_line: "return x;", rule: "return 2" }], depends_on: ["U01"], checks: ["lint"] },
];

/** A project with two source files and a run folder r1; returns helpers to write and check sections. */
export function project() {
  const root = mkdtempSync(join(tmpdir(), "change-spec-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), 'import { x } from "./x";\r\n\r\nexport function a() {\r\n  return x;\r\n}\r\n');
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  const sections = join(root, ".sdlc", "runs", "r1", "change.sections");
  mkdirSync(sections, { recursive: true });
  const put = (name, value) => { writeFileSync(join(sections, name), typeof value === "string" ? value : JSON.stringify(value, null, 2)); return `.sdlc/runs/r1/change.sections/${name}`; };
  const check = (name, value, opts) => checkSection(root, "r1", value === undefined ? `.sdlc/runs/r1/change.sections/${name}` : put(name, value), opts);
  /** Gate 0's record of the run's job: the first line of intent_brief.md (brownfield-guide's heading contract). */
  const brief = (job) => writeFileSync(join(root, ".sdlc", "runs", "r1", "intent_brief.md"), `# Intent Brief — ${job} — a test run\n\n## Goal\n`);
  /** The run's write contract, as write-contract.mjs --freeze writes it. */
  const contract = (c) => {
    mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, run_id: "r1", ...c }));
  };
  const file = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  return { root, put, check, brief, contract, file, done: () => rmSync(root, { recursive: true, force: true }) };
}

