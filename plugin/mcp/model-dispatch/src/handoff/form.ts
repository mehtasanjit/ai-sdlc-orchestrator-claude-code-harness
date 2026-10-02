/**
 * What every hand-off form is checked with (zero-touch hand-off mode).
 *
 * A form is a brief the chat's model fills in, and code checks it against the project before anything is sent:
 * every string is one line (a field that holds several lines or a code block is the finished work, which would mean
 * the chat's model did the typing), every path stays inside the project, and a command is one this project can run.
 * Each problem is named by its field, and all of them are reported at once, so one corrected call fixes them all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeRelativePath } from "../spec/store.js";
import { insideCodeDir } from "../executor/run.js";

/** A project-relative path that stays inside the project, symlinks followed. */
export function insideProject(projectDir: string, rel: unknown): rel is string {
  if (typeof rel !== "string" || !isSafeRelativePath(rel)) return false;
  try { return insideCodeDir(projectDir, rel); } catch { return false; }
}

export function isProjectFile(projectDir: string, rel: unknown): rel is string {
  if (!insideProject(projectDir, rel)) return false;
  try { return statSync(join(projectDir, rel)).isFile(); } catch { return false; }
}

/** A collector of a form's problems, with the checks every form shares. */
export function formProblems() {
  const problems: string[] = [];
  return {
    problems,
    add: (problem: string) => { problems.push(problem); },
    /** A filled, one-line string, or null with the problem recorded. */
    line(value: unknown, name: string): string | null {
      if (typeof value !== "string" || !value.trim()) { problems.push(`${name} is empty`); return null; }
      if (value.includes("```")) { problems.push(`${name} holds a code block: the form is a brief, so say what must be written, never the finished text`); return null; }
      if (/[\r\n]/.test(value.trim())) { problems.push(`${name} is more than one line: the form is a brief, so say what must be written, never the finished text`); return null; }
      return value.trim();
    },
    /** A path for a NEW file of the project, or null with the problem recorded. */
    newFile(value: unknown, name: string, projectDir: string, tool: string): string | null {
      if (typeof value !== "string" || !value.trim()) { problems.push(`${name} is empty`); return null; }
      if (!insideProject(projectDir, value)) { problems.push(`${name} must be a path inside the project, written from the project folder (for example docs/setup.md)`); return null; }
      if (value.split("/")[0] === ".git") { problems.push(`${name} is inside .git, which is not the project's own content`); return null; }
      let there = false;
      try { statSync(join(projectDir, value)); there = true; } catch { /* new, as it must be */ }
      if (there) { problems.push(`${value} exists already: ${tool} writes new files; change a file that exists yourself`); return null; }
      return value;
    },
    /** A command this project can run, or null with the problem recorded (checkCommand). */
    command(value: unknown, name: string, projectDir: string): string | null {
      const text = this.line(value, name);
      if (!text) return null;
      const why = commandProblem(text, projectDir);
      if (why) { problems.push(`${name} ${why}`); return null; }
      return text;
    },
  };
}

/**
 * Why a command cannot run in this project, or null. Two things can be told without running it: its program is on
 * this machine (asked of the shell itself, so a shell builtin and a path both count), and, for `npm run <script>`
 * and `npm test`, the script is one package.json has. Anything else about the command shows when it runs.
 */
export function commandProblem(command: string, projectDir: string): string | null {
  // Variables set before the program ("CI=1 node ...") are not the program.
  const words = command.trim().split(/\s+/);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const program = words[0];
  if (!program) return "names no program";
  try {
    execFileSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", program], { cwd: projectDir, stdio: "ignore", timeout: 10_000 });
  } catch {
    return `starts with ${program}, which is not a program on this machine`;
  }
  const script = program === "npm" ? (words[1] === "test" ? "test" : ["run", "run-script"].includes(words[1] ?? "") ? words[2] : null) : null;
  if (script) {
    let scripts: Record<string, unknown> = {};
    try { scripts = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).scripts ?? {}; } catch { /* no package.json: the script cannot be in it */ }
    if (typeof scripts[script] !== "string") return `names the npm script ${script}, which package.json does not have`;
  }
  return null;
}
