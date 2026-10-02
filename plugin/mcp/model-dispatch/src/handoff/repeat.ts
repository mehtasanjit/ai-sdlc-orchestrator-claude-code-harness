/**
 * repeat_edit_across_files: the form, the brief and the checks (zero-touch hand-off mode).
 *
 * The chat's model makes a change ONCE, by hand, in one file (the example). Repeating it in other files is typing:
 * the hand-off policy's model gets the example's own change (the chat's own edit, measured against the file's text
 * before the chat first edited it, which the plugin's hook keeps, so changes the person had not committed are never
 * repeated; without that kept text, the diff since the last commit), the change in words, and one target file at a
 * time, and answers with exact edits for that file. Code checks each answer before any file is touched:
 *
 *  - every edit's search text is in the file exactly once (the executor's own rule, applyEdits), so an edit lands
 *    where it was meant or not at all;
 *  - an edit removes only lines the change is about. The words the example's change took away (in its removed lines
 *    and not in its added ones: `getUser` for a rename to `fetchUser`, `moment` for a move to another library) mark
 *    such a line; an edit that removes a line carrying none of them is rewriting something else, and is refused. A
 *    change that only added lines took no word away, so its repeats may add lines and remove none.
 *
 * Then all the changed files are written into a scratch copy of the project (scratch.ts) and the project's check
 * command runs there. Only when it passes are the files written into the project, as one landing that one call
 * undoes. A target whose edits never pass is named back to the chat's model, which changes that file itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitInstalled, gitRoot } from "../git.js";
import type { FileSlice, TaskPacket } from "../types.js";
import { EDIT_ANSWER_SCHEMA } from "../executor/brief.js";
import { applyEdits } from "../executor/run.js";
import type { Edit } from "../executor/typists.js";
import { formProblems, isProjectFile } from "./form.js";

export interface RepeatForm {
  /** The file the chat's model changed by hand. */
  example: string;
  targets: string[];
  /** The change, in words. */
  change: string;
  /** The project's build or test command, run in a scratch copy with every changed file. */
  check_command?: string;
  /** The example's change since the last commit, as a unified diff: the pattern every target follows. */
  diff: string;
}

/**
 * The example's change, or "" when it has none (or the project is not a git repository): the chat's own edit when
 * the file's text from before it is kept (`beforeFile`), else the change since the last commit.
 */
/** How many lines a diff adds or removes (its headers aside). */
function changedLines(diff: string): number {
  return diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
}

/**
 * The example's change to repeat. Two differences can tell it: since the text the hook kept before the chat's first
 * edit of the file (the person's own uncommitted work in it stays out), and since the last commit. The smaller one is
 * the change: a copy kept turns ago, before the person committed that early edit, makes the kept-copy difference carry
 * the old edit too, which would let matching deletions through the check.
 */
function exampleDiff(projectDir: string, example: string, beforeFile?: string): string {
  // Never start git where it cannot help (src/git.ts): on a Mac without the developer tools it opens a dialog.
  if (!gitInstalled() || !gitRoot(projectDir)) return "";
  let sinceHead = "";
  try {
    sinceHead = execFileSync("git", ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3", "--", example], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, maxBuffer: 64 << 20 }).toString("utf8");
  } catch { /* none */ }
  if (!beforeFile || !existsSync(beforeFile)) return sinceHead;
  let sinceKept = "";
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", beforeFile, join(projectDir, example)], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, maxBuffer: 64 << 20 });
    return ""; // the same text as before the chat's first edit: no change of the chat's own
  } catch (e: any) {
    // git diff --no-index exits 1 when the files differ; its headers name the two files, which are relabelled as the example.
    if (e?.status !== 1 || !e.stdout) return sinceHead;
    let inHunk = false;
    sinceKept = e.stdout.toString("utf8").split("\n").map((line: string) => {
      if (line.startsWith("@@")) inHunk = true;
      if (inHunk) return line;
      if (line.startsWith("diff --git ")) return `diff --git a/${example} b/${example}`;
      if (line.startsWith("--- ")) return `--- a/${example}`;
      if (line.startsWith("+++ ")) return `+++ b/${example}`;
      return line;
    }).join("\n");
  }
  if (!sinceHead.trim()) return sinceKept;
  return changedLines(sinceHead) < changedLines(sinceKept) ? sinceHead : sinceKept;
}

export function checkRepeatForm(raw: unknown, projectDir: string, { before }: { before?: (path: string) => string } = {}): { form: RepeatForm } | { problems: string[] } {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f = formProblems();

  let example: string | null = null;
  let diff = "";
  if (!isProjectFile(projectDir, a.example)) f.add(`example ${String(a.example ?? "")} is not a file of the project`);
  else {
    diff = exampleDiff(projectDir, a.example, before?.(a.example));
    if (!diff.trim()) f.add(`example ${a.example} has no change to repeat: make the change in it first, by hand; it is the pattern the other files follow`);
    else example = a.example;
  }

  const targets: string[] = [];
  if (!Array.isArray(a.targets) || !a.targets.length) f.add("targets needs at least one file: where the change is repeated");
  else a.targets.forEach((t: unknown, i: number) => {
    if (typeof t === "string" && t === a.example) { f.add(`targets[${i}] is the example itself`); return; }
    if (!isProjectFile(projectDir, t)) { f.add(`targets[${i}] ${String(t ?? "")} is not a file of the project`); return; }
    if (targets.includes(t)) { f.add(`targets[${i}] ${t} is listed twice`); return; }
    targets.push(t);
  });

  const change = f.line(a.change, "change");
  const check = a.check_command === undefined || a.check_command === "" ? undefined : f.command(a.check_command, "check_command", projectDir) ?? undefined;

  if (f.problems.length || !example || !change) return { problems: f.problems };
  return { form: { example, targets, change, ...(check ? { check_command: check } : {}), diff } };
}

/** A word of code: a name, with the characters names carry in the common languages. */
const WORD = /[A-Za-z_$][\w$]*/g;
const wordsOf = (text: string) => new Set(text.match(WORD) ?? []);

/** The words the example's change took away: in its removed lines, and in none of its added lines. */
export function changeMarkers(diff: string): Set<string> {
  const removed: string[] = [];
  const added: string[] = [];
  // A diff's file headers ("--- a/x", "+++ b/x") come before its first hunk ("@@"); inside a hunk every line that
  // starts with - or + is a line of the change, even one that itself starts with dashes (an SQL comment).
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  const kept = wordsOf(added.join("\n"));
  return new Set([...wordsOf(removed.join("\n"))].filter((w) => !kept.has(w)));
}

/**
 * The edits of one target, checked: each applies exactly once, and each removes only lines the change is about. A
 * line an edit removes is a line of its search text that is not in its replacement; a blank line carries nothing.
 */
export function checkRepeatEdits(text: string, edits: Edit[], markers: Set<string>): { ok: true; content: string } | { ok: false; reason: string } {
  // Whether the edits apply comes first: an edit whose search text is not in the file is told as exactly that.
  const applied = applyEdits(text, edits);
  if (applied.reason !== undefined) return { ok: false, reason: applied.reason };
  for (let i = 0; i < edits.length; i++) {
    const kept = new Map<string, number>();
    for (const l of edits[i].replace.split("\n")) kept.set(l.trim(), (kept.get(l.trim()) ?? 0) + 1);
    for (const l of edits[i].search.split("\n")) {
      const line = l.trim();
      const left = kept.get(line) ?? 0;
      if (left > 0) { kept.set(line, left - 1); continue; } // the line is still there after the edit
      if (!line) continue;
      if (![...wordsOf(line)].some((w) => markers.has(w))) {
        return { ok: false, reason: `edit ${i + 1} removes the line \`${line}\`, which the change is not about: change only what the example's change changes` };
      }
    }
  }
  return { ok: true, content: applied.content! };
}

/** The block every job of one repeated change shares: the rules, the change in words, the example's own change. */
export function renderRepeatShared(form: RepeatForm): string {
  return [
    "# Repeat one change in another file",
    "A change was made by hand in one file of a project. You repeat the SAME change in one other file, and change nothing else.",
    "",
    "## Rules",
    "- Make only this change. Touch no line the change is not about: no reformatting, no renaming of anything else, no fixes of your own.",
    "- Answer with exact edits: each search text copied exactly from the file's current text, appearing in it exactly once.",
    "- If the file needs no change, return one edit whose replace is exactly its search.",
    "",
    "## The change, in words",
    form.change,
    "",
    `## The change as it was made in ${form.example}`,
    "```diff",
    form.diff.trimEnd(),
    "```",
  ].join("\n");
}

export function renderRepeatInstruction(target: string, refusal?: string): string {
  const lines = [
    "## The file to change",
    `- path: ${target}`,
    "- its current text is under Inputs; your edits apply to exactly that text",
  ];
  if (refusal) lines.push("", "## Your previous answer was refused", refusal, "Answer again from the current text, correcting that.");
  lines.push("", "## Answer", `Return ONLY a JSON object {"path": "${target}", "edits": [{"search": "<text copied exactly from the current text>", "replace": "<its replacement>"}]} with no other text. The edits apply in order.`);
  return lines.join("\n");
}

/** One target as a packet: the policy's codegen stage; the target's current text as its only input. */
export function repeatPacket(target: string, currentText: string, instruction: string, maxOutputTokens: number): TaskPacket {
  const inputs: FileSlice[] = [{ path: target, content: currentText, reason: "current text" }];
  return {
    id: `repeat:${target}`,
    phase: "codegen",
    task_type: "",
    module: "handoff",
    instruction,
    inputs,
    outputSchema: EDIT_ANSWER_SCHEMA,
    acceptance: [],
    budget: { maxInputTokens: 400_000, maxOutputTokens },
    pass_id: "handoff",
  };
}

export const readTarget = (projectDir: string, target: string) => readFileSync(join(projectDir, target), "utf8");
