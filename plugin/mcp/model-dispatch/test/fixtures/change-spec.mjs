/**
 * A typed change spec and a small project it fits, shared by the tests of plan-lint.mjs and plan-to-packets.mjs.
 * src/a.ts has CRLF endings, as a Windows checkout gives; src/x.ts is LF.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts");
const { checkSection } = await import(join(SCRIPTS, "plan-lint.mjs"));

export const HEADER = {
  conventions: ["two-space indent", "double quotes"],
  decisions: [{ topic: "b's value", choice: "2", reason: "FR-1" }],
  file_checks: [{ id: "lint", run: "npx biome check {path}", fix: "npx biome check --write {path}", timeout_s: 45 }],
  project_checks: [{ id: "types", run: "npx tsc --noEmit" }],
};
export const UNITS = [
  { id: "U01", path: "src/b.ts", action: "create", phase: "codegen", behaviour: "Exports b, returning 2.", exports: [{ name: "b", params: [], returns: "number" }], import_line: 'import { b } from "./b";', style_from: { path: "src/x.ts", reason: "same module style" }, depends_on: [], covers: ["FR-1"], checks: ["lint"] },
  { id: "U02", path: "src/a.ts", action: "edit", phase: "codegen", behaviour: "a also imports b.", sites: [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: 'import { x } from "./x";', rule: "import b" }], depends_on: ["U01"], checks: ["lint"] },
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
  const check = (name, value) => checkSection(root, "r1", value === undefined ? `.sdlc/runs/r1/change.sections/${name}` : put(name, value));
  return { root, put, check, done: () => rmSync(root, { recursive: true, force: true }) };
}

