/**
 * Landing a hand-off in the project, and undoing it (zero-touch hand-off mode).
 *
 * A hand-off's checked files are written into the project here and nowhere else, and every landing is recorded with
 * what each file held before: a file that was there keeps a copy of its earlier text, a file the hand-off created is
 * marked as new. One call then undoes a landing. Undo never overwrites work done since without the person's word: a
 * file whose text is no longer what the hand-off wrote is left alone and named, so the chat's model can ask them.
 *
 * The record lives with the chat's other records under MMO_HOME, never in the project:
 *   sessions/<chat id>/handoff_landings.json     the chat's landings, in order, each with its id and its project
 *   sessions/<chat id>/handoff_undo/<id>/<n>     the earlier text of the landing's n-th file
 *
 * Ids: an id is "h" and four letters or digits, unique among every chat's landings, so an id one chat showed never
 * names another chat's landing. An undo looks in the other chats' records too, for a landing in the same project, so
 * it still finds the landing after /clear (a new chat id).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LANDINGS = "handoff_landings.json";
const UNDO_DIR = "handoff_undo";

export interface LandedFile { path: string; existed: boolean; sha256: string; undone?: boolean }
export interface Landing { id: string; tool: string; at: string; files: LandedFile[]; undone?: boolean; project?: string }

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** Letters and digits nobody misreads (no 0, o, 1, l, i). */
const ID_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";

/** The chat's landings, oldest first. */
export function landings(sessionDir: string): Landing[] {
  try {
    const v = JSON.parse(readFileSync(join(sessionDir, LANDINGS), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function save(sessionDir: string, all: Landing[]): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(sessionDir, LANDINGS), JSON.stringify(all), { mode: 0o600 });
}

/** Every other chat's records folder beside this one (sessions/<id>/), for ids and for an undo asked in another chat. */
function otherChats(sessionDir: string): string[] {
  const sessions = dirname(sessionDir);
  try { return readdirSync(sessions).map((n) => join(sessions, n)).filter((d) => d !== sessionDir && existsSync(join(d, LANDINGS))); } catch { return []; }
}

/** A new landing id, unique among every chat's landings. */
function newId(sessionDir: string, random: (n: number) => Buffer = randomBytes): string {
  const taken = new Set([sessionDir, ...otherChats(sessionDir)].flatMap((d) => landings(d).map((l) => l.id)));
  for (let tries = 0; ; tries++) {
    const bytes = random(4);
    const id = "h" + Array.from(bytes, (b) => ID_LETTERS[b % ID_LETTERS.length]).join("");
    if (!taken.has(id) || tries > 50) return id;
  }
}

/**
 * Writes a hand-off's files into the project and records the landing. The earlier text of every file is kept before
 * anything is written, so a failure halfway leaves a record that undoes exactly what was written. Returns the
 * landing's id.
 */
export function recordLanding(sessionDir: string, projectDir: string, landing: { tool: string; files: { path: string; content: string }[] }): string {
  const all = landings(sessionDir);
  const id = newId(sessionDir);
  const keep = join(sessionDir, UNDO_DIR, id);
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  const files: LandedFile[] = landing.files.map((f, n) => {
    const target = join(projectDir, f.path);
    const existed = existsSync(target);
    if (existed) writeFileSync(join(keep, String(n)), readFileSync(target), { mode: 0o600 });
    return { path: f.path, existed, sha256: sha(f.content) };
  });
  save(sessionDir, [...all, { id, tool: landing.tool, at: new Date().toISOString(), files, project: resolve(projectDir) }]);
  for (const f of landing.files) {
    const target = join(projectDir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  return id;
}

export type UndoResult =
  | { restored: string[]; left_alone: string[]; kept?: false }
  /** Every file changed since, and the person has not agreed to lose those changes: nothing was undone. */
  | { restored: []; left_alone: string[]; kept: true }
  | { refused: string; cause: "unknown-id" | "already-undone" | "other-project" };

/**
 * Takes a landing back: a changed file gets its earlier text, a created file is removed. A file that no longer holds
 * what the hand-off wrote was changed since and is left alone, unless `includeChanged` (the person agreed). The
 * landing is found in this chat's records, else in another chat's records for the same project (an undo asked after
 * /clear, or in another chat). Undo is kept per file: a file once restored is never touched again, so the follow-up
 * the receipt asks for (include_changed, on the person's yes) restores the rest, and the landing is undone when every
 * file is.
 */
/**
 * The id of the latest hand-off in this project that wrote `file` and is not undone yet, this chat's first, then the
 * other chats' (the person names the file, not a hand-off id they cannot know). Null when there is none.
 */
export function landingIdForFile(sessionDir: string, projectDir: string, file: string): string | null {
  const project = resolve(projectDir);
  const want = file.trim().replace(/^\.\//, "");
  if (!want) return null;
  for (const dir of [sessionDir, ...otherChats(sessionDir)]) {
    const mine = dir === sessionDir;
    const hit = [...landings(dir)].reverse().find((l) => !l.undone && (mine ? !l.project || l.project === project : l.project === project) && l.files.some((f) => f.path === want && !f.undone));
    if (hit) return hit.id;
  }
  return null;
}

export function undoLanding(sessionDir: string, projectDir: string, id: string, { includeChanged = false }: { includeChanged?: boolean } = {}): UndoResult {
  const project = resolve(projectDir);
  let home = sessionDir;
  let all = landings(sessionDir);
  let landing = all.find((l) => l.id === id);
  if (!landing) {
    for (const other of otherChats(sessionDir)) {
      const theirs = landings(other);
      const found = theirs.find((l) => l.id === id);
      if (!found) continue;
      // A landing with no project recorded is undone only from its own chat.
      if (found.project !== project) return { refused: `hand-off ${id} was made in another project`, cause: "other-project" };
      home = other; all = theirs; landing = found;
      break;
    }
  }
  if (!landing) return { refused: `there is no hand-off ${id} in this project`, cause: "unknown-id" };
  if (landing.project && landing.project !== project) return { refused: `hand-off ${id} was made in another project`, cause: "other-project" };
  const pending = landing.files.map((f, n) => ({ f, n })).filter(({ f }) => !f.undone);
  if (landing.undone || pending.length === 0) return { refused: `hand-off ${id} is already undone`, cause: "already-undone" };
  const restored: string[] = [];
  const leftAlone: string[] = [];
  const changed = new Map(pending.map(({ f, n }) => {
    let now: Buffer | null = null;
    try { now = readFileSync(join(projectDir, f.path)); } catch { /* removed since */ }
    return [n, !now || sha(now) !== f.sha256];
  }));
  if (!includeChanged && pending.every(({ n }) => changed.get(n))) return { restored: [], left_alone: pending.map(({ f }) => f.path), kept: true };
  for (const { f, n } of pending) {
    const target = join(projectDir, f.path);
    if (changed.get(n) && !includeChanged) { leftAlone.push(f.path); continue; }
    if (f.existed) writeFileSync(target, readFileSync(join(home, UNDO_DIR, id, String(n))));
    else rmSync(target, { force: true });
    f.undone = true;
    restored.push(f.path);
  }
  if (landing.files.every((f) => f.undone)) landing.undone = true;
  save(home, all);
  return { restored, left_alone: leftAlone };
}
