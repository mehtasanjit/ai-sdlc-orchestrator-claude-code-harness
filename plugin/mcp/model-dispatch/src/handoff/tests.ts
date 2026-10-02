/**
 * write_tests_from_cases: the form, the brief and the checks (zero-touch hand-off mode).
 *
 * Deciding what to test is judgment; typing the test file is not. The chat's model names the code under test and the
 * cases (what is given, what is expected); the hand-off policy's model writes ONE new test file for them; and code
 * RUNS that file, with the project's own test command, in a scratch copy of the project (scratch.ts). Only a file
 * whose tests pass is written into the project.
 *
 * A case's expected result is the specification. The typist is told never to change it, or weaken an assertion, to
 * make a test pass, and code checks that every case has a test with exactly its name. So when the code under test
 * does something else than a case expects, the test keeps failing, nothing is written, and the chat's model gets the
 * run's output: a wrong case is corrected and handed off again, a real bug is told to the person. A hand-off that
 * bent the tests until they passed would hide exactly the bugs tests exist to find.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileSlice, TaskPacket } from "../types.js";
import { FILE_ANSWER_SCHEMA } from "../executor/brief.js";
import { formProblems, isProjectFile } from "./form.js";

export interface TestCase { name: string; given: string; expect: string }
export interface TestsForm {
  /** The new test file, relative to the project folder. */
  file: string;
  /** The file under test. */
  target: string;
  /** The names in it the tests exercise. */
  functions: string[];
  cases: TestCase[];
  /** An existing test file whose framework, imports and layout the new one follows. */
  style_from?: string;
  /** The command that runs the new test file, as typed from the project folder. */
  test_command: string;
  /** Anything else the typist must know (one line). */
  notes?: string;
  /**
   * A regression test written before the fix of the bug it shows: the file must fail now, on its own cases, and is
   * written for the chat's model to make pass with its fix.
   */
  fails_until_fixed?: boolean;
}

/** Whether `name` stands in `text` as a whole name, not as a piece of a longer one. */
function hasName(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w$])${esc}($|[^\\w$])`).test(text);
}

export function checkTestsForm(raw: unknown, projectDir: string): { form: TestsForm } | { problems: string[] } {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f = formProblems();
  const file = f.newFile(a.file, "file", projectDir, "write_tests_from_cases");

  let target: string | null = null;
  let targetText = "";
  if (!isProjectFile(projectDir, a.target)) f.add(`target ${String(a.target ?? "")} is not a file of the project`);
  else { target = a.target; try { targetText = readFileSync(join(projectDir, target), "utf8"); } catch { /* unreadable: no name can be in it */ } }

  const functions: string[] = [];
  if (!Array.isArray(a.functions) || !a.functions.length) f.add("functions needs at least one name: what in the target the tests exercise");
  else a.functions.forEach((name: unknown, i: number) => {
    const n = f.line(name, `functions[${i}]`);
    if (!n) return;
    if (target && !hasName(targetText, n)) f.add(`functions[${i}] ${n} is not in ${target}`);
    else functions.push(n);
  });

  const cases: TestCase[] = [];
  if (!Array.isArray(a.cases) || !a.cases.length) f.add("cases needs at least one case: what is given and what is expected");
  else {
    const seen = new Set<string>();
    a.cases.forEach((c: any, i: number) => {
      const name = f.line(c?.name, `cases[${i}].name`);
      const given = f.line(c?.given, `cases[${i}].given`);
      const expect = f.line(c?.expect, `cases[${i}].expect`);
      if (name) {
        if (seen.has(name)) f.add(`cases[${i}].name repeats "${name}"`);
        seen.add(name);
      }
      if (name && given && expect) cases.push({ name, given, expect });
    });
  }

  let style: string | undefined;
  if (a.style_from !== undefined && a.style_from !== "") {
    if (!isProjectFile(projectDir, a.style_from)) f.add(`style_from ${String(a.style_from)} is not a file of the project`);
    else style = a.style_from;
  }
  const command = f.command(a.test_command, "test_command", projectDir);
  const notes = a.notes === undefined || a.notes === "" ? undefined : f.line(a.notes, "notes") ?? undefined;
  if (a.fails_until_fixed !== undefined && typeof a.fails_until_fixed !== "boolean") f.add("fails_until_fixed is true or false");
  const failing = a.fails_until_fixed === true;

  if (f.problems.length || !file || !target || !command) return { problems: f.problems };
  return { form: { file, target, functions, cases, ...(style ? { style_from: style } : {}), test_command: command, ...(notes ? { notes } : {}), ...(failing ? { fails_until_fixed: true } : {}) } };
}

/** The block every tests brief starts with. */
export function renderTestsShared(): string {
  return [
    "# Write one test file for code that exists",
    "You are writing ONE new test file. The code under test and the cases are given; you cannot see the rest of the project.",
    "",
    "## Rules",
    "- Write one test for every case listed, each titled with exactly the case's name.",
    "- A case's expected result is the specification: never change it, and never weaken an assertion, to make a test pass. If the code under test does something else, the test must fail.",
    "- Test the code through what its file exports. Do not change, copy or restate the code under test.",
    "- Follow the style file when one is given: its test framework, its imports, its layout. Otherwise use the framework the test command names.",
    "- Import the code under test by its relative path from the test file's own folder.",
  ].join("\n");
}

export function renderTestsInstruction(form: TestsForm, refusal?: string): string {
  const lines = [
    "## The test file to write",
    `- path: ${form.file}`,
    `- code under test: ${form.target} (${form.functions.join(", ")}); its text is under Inputs`,
    `- test command: ${form.test_command}`,
    ...(form.style_from ? [`- style: follow ${form.style_from}, whose text is under Inputs`] : []),
    ...(form.notes ? [`- note: ${form.notes}`] : []),
    ...(form.fails_until_fixed ? ["- these tests are written BEFORE the bug they show is fixed: the code under test is expected to fail them now. Write each case's assertion exactly as expected; do not make the tests pass against the current code."] : []),
    "",
    "## Cases, one test each",
    ...form.cases.map((c, i) => `${i + 1}. ${c.name} — given: ${c.given} → expect: ${c.expect}`),
  ];
  if (refusal) lines.push("", "## Your previous answer was refused", refusal, "Write the whole test file again, correcting that. Keep every case's expected result as written.");
  lines.push("", "## Answer", `Return ONLY a JSON object {"path": "${form.file}", "content": "<the complete test file>"} with no other text.`);
  return lines.join("\n");
}

/** The test file as a packet: the policy's tests stage; the code under test and the style file as inputs. */
export function testsPacket(form: TestsForm, projectDir: string, instruction: string, maxOutputTokens: number): TaskPacket {
  const inputs: FileSlice[] = [{ path: form.target, content: readFileSync(join(projectDir, form.target), "utf8"), reason: "the code under test" }];
  if (form.style_from) inputs.push({ path: form.style_from, content: readFileSync(join(projectDir, form.style_from), "utf8"), reason: "style: follow its framework, imports and layout" });
  return {
    id: `tests:${form.file}`,
    phase: "tests",
    task_type: "",
    module: "handoff",
    instruction,
    inputs,
    outputSchema: FILE_ANSWER_SCHEMA,
    acceptance: [],
    budget: { maxInputTokens: 400_000, maxOutputTokens },
    pass_id: "handoff",
  };
}

/** What can be told of a test file without running it: it is not empty, and every case has a test with its name. */
export function checkTestsText(form: Pick<TestsForm, "cases">, content: string): { ok: true } | { ok: false; reason: string } {
  if (!content.trim()) return { ok: false, reason: "the test file is empty" };
  // A test file writes a title inside quotes of its own choosing, escaping the ones the title holds: the name is
  // looked for with escapes removed and every kind of quote read as one.
  const plain = (s: string) => s.replace(/\\/g, "").replace(/["'`]/g, "'");
  const text = plain(content);
  const missing = form.cases.filter((c) => !text.includes(plain(c.name)));
  if (missing.length) return { ok: false, reason: missing.map((c) => `the case "${c.name}" has no test with that name`).join("; ") };
  return { ok: true };
}
