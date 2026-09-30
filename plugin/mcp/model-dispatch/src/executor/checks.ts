/**
 * The executor's checks on a typist's answer, run by code before a file is
 * written. The same checks for every typist and every language, so no door and
 * no project is held to a different bar — and they refuse a file only when it
 * is certainly wrong whatever it is written in:
 *  1. the answer names the job's own path, and that path is safe;
 *  2. the file is not empty.
 *
 * No file is parsed: a parser covers only some languages, so the others would
 * get a weaker check. Whether a file is right — its syntax as much as its
 * behaviour — is judged by the project's own build and tests, which the
 * pipeline runs after every stage with repair rounds, the same way for every
 * language. Export/import checks are left out for the same reason: they would
 * need a rule for every idiom of every language.
 */
import { isSafeRelativePath } from "../spec/store.js";

export interface CheckResult { ok: boolean; reason?: string }
/** What the checks need to know about the job: its path. */
export type CheckTarget = { path: string };

export function checkAnswer(target: CheckTarget, answer: { path: string; content: string }): CheckResult {
  if (answer.path !== target.path) return { ok: false, reason: `the answer names ${answer.path}, not ${target.path}` };
  if (!isSafeRelativePath(answer.path)) return { ok: false, reason: `unsafe path ${answer.path}` };
  if (!answer.content.trim()) return { ok: false, reason: "the file is empty" };
  return { ok: true };
}
