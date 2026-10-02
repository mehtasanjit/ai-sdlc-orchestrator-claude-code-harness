/**
 * A hand-off chat, as the server sees it (zero-touch hand-off mode; docs/ambient-mode.md, "Hand-off mode").
 *
 * The server never sees a chat: it learns which chat a hand-off tool call belongs to from the stamp the plugin's
 * hook adds to the call (`_mmo`, see scripts/ambient/hook.mjs "pre-handoff"). The stamp only names the chat. What
 * the chat may do is read from the chat's own records under MMO_HOME, which the zero-touch plugin wrote when the
 * chat started and the hook completed at the chat's first hand-off:
 *   sessions/<chat id>/chat_mode            "b" for a hand-off chat
 *   sessions/<chat id>/handoff.json         the chat's settings: the model the chat is kept on, and who types each
 *                                           kind of work (the person's choices in the settings box)
 *   sessions/<chat id>/handoff_models.json  per kind of work: the model and the shipped policy that route it, or
 *                                           { kept: true } for work the person keeps in the chat; resolved once
 * So a call with no stamp, or a stamp naming a chat that is not a hand-off chat, is refused: the hooks did not see
 * it. A stamp the chat's model wrote itself cannot widen anything, because nothing but the chat's id is taken from
 * it (the hook replaces the stamp on every call it sees).
 *
 * The chat's hand-off bill is kept with its records, never inside the project: handoff-telemetry.jsonl, one line
 * per typist call, in the same shape as a workflow's telemetry.
 *
 * The path rules are the hook's own (scripts/ambient/lib/paths.mjs); test/handoffChat.test.mjs proves the two agree.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function mmoHome(env: Record<string, string | undefined> = process.env): string {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/** A chat id that is not a plain token becomes a hash of itself, so it can never walk out of the sessions folder. */
export function safeId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

/**
 * One kind of hand-off work, as the chat resolved it: the policy leaf, its model, its adapter and the shipped policy it
 * comes from; or `kept` for work the person keeps in the chat (nothing is handed off).
 */
export interface HandoffRoute { id: string; model: string; adapter: string; policy: string; kept?: false }
export interface KeptRoute { kept: true }
export type HandoffWork = "docs" | "tests" | "repeat";

export interface ChatHandoff {
  sessionId: string;
  /** The chat's records folder. */
  dir: string;
  /** The project the chat works in (the hook's own reading of it). */
  projectDir: string;
  /** Who pays for a Claude typist: "estimated" is the person's Claude login, "vendor" the API key. */
  authMode: "estimated" | "vendor";
  /**
   * The model the chat is kept on (the person's choice, or the organisation's pinned model): it makes the last
   * attempt when the chosen typist fails twice. Null when the organisation pinned an alias that names no one model;
   * the policy's own Claude model then makes it.
   */
  chatModel: string | null;
  routes: Record<HandoffWork, HandoffRoute | KeptRoute>;
  /** This tool call's own id, from the hook's stamp: see callInterrupted. */
  callId?: string;
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

const isRoute = (r: any): boolean => !!r && (r.kept === true || (typeof r.id === "string" && !!r.id && typeof r.model === "string" && !!r.model && typeof r.adapter === "string" && typeof r.policy === "string" && !!r.policy));

/**
 * The hand-off chat a stamped call belongs to, or why the call is refused. `needRoutes: false` is for a call that
 * sends nothing to a model (an undo): it needs the chat and its project, not the chat's models.
 */
export function readChatHandoff(stamp: unknown, env: Record<string, string | undefined> = process.env, { needRoutes = true }: { needRoutes?: boolean } = {}): ChatHandoff | { refused: string } {
  const s = stamp as { session_id?: unknown; project_dir?: unknown; auth?: unknown; tool_use_id?: unknown } | undefined;
  if (!s || typeof s !== "object" || typeof s.session_id !== "string" || !s.session_id) {
    return { refused: "this call carries no stamp from the plugin's hook, so it is not inside a zero-touch hand-off chat" };
  }
  if (typeof s.project_dir !== "string" || !isAbsolute(s.project_dir) || !existsSync(s.project_dir)) {
    return { refused: "the hook's stamp names no project folder" };
  }
  const dir = join(mmoHome(env), "sessions", safeId(s.session_id));
  // An undo (needRoutes false) works in any chat the hook stamped: the person is told "To undo it, ask Claude to undo
  // hand-off h…", and the hand-off may have been made in a Hand-off chat they have since left. The undo sends nothing to a model and finds the landing in any chat of the same project.
  if (!needRoutes) {
    const none: KeptRoute = { kept: true };
    return {
      sessionId: s.session_id, dir, projectDir: s.project_dir, authMode: s.auth === "vendor" ? "vendor" : "estimated", chatModel: null,
      routes: { docs: none, tests: none, repeat: none },
      ...(typeof s.tool_use_id === "string" && s.tool_use_id ? { callId: s.tool_use_id } : {}),
    };
  }
  let mode = "";
  try { mode = readFileSync(join(dir, "chat_mode"), "utf8").trim(); } catch { /* no record: not a zero-touch chat */ }
  if (mode !== "b") return { refused: "this is not a hand-off chat: the hand-off tools work only in a chat that started in zero-touch hand-off mode" };
  const settings = readJson(join(dir, "handoff.json"));
  if (!settings || typeof settings !== "object" || (!settings.typists && (typeof settings.policy !== "string" || !settings.policy))) {
    return { refused: "this chat's hand-off settings cannot be read" };
  }
  const routes = readJson(join(dir, "handoff_models.json"))?.routes;
  const resolved = isRoute(routes?.docs) && isRoute(routes?.tests) && isRoute(routes?.repeat);
  if (!resolved && needRoutes) return { refused: "this chat's hand-off models are not resolved" };
  const none: KeptRoute = { kept: true };
  return {
    sessionId: s.session_id,
    dir,
    projectDir: s.project_dir,
    authMode: s.auth === "vendor" ? "vendor" : "estimated",
    chatModel: typeof settings.chat_model === "string" && settings.chat_model ? settings.chat_model : null,
    routes: resolved ? { docs: routes.docs, tests: routes.tests, repeat: routes.repeat } : { docs: none, tests: none, repeat: none },
    ...(typeof s.tool_use_id === "string" && s.tool_use_id ? { callId: s.tool_use_id } : {}),
  };
}

/**
 * Whether the person interrupted this call: the plugin's hook marks an interrupted call's id
 * (PostToolUseFailure, hook.mjs "handoff-failed"), which Claude Code reports even when it does not tell this server
 * the call was cancelled. Read just before anything is written into the project.
 */
export function callInterrupted(chat: Pick<ChatHandoff, "dir" | "callId">): boolean {
  if (!chat.callId) return false;
  const v = readJson(join(chat.dir, "handoff_interrupted.json"));
  return Array.isArray(v) && v.includes(chat.callId);
}

/** Where the chat's hand-off calls are billed. */
export function handoffTelemetryPath(chat: Pick<ChatHandoff, "dir">): string {
  return join(chat.dir, "handoff-telemetry.jsonl");
}

const RELEASED = "handoff_released.json";
const REFUSALS = "handoff_form_refusals.json";
const STOPPED = "handoff_stopped.json";
/** The chat's own earlier text of a file it edited, kept by the plugin's hook before the edit (hook.mjs "pre-any"). */
const BEFORE_DIR = "handoff_before";

/**
 * Where the hook keeps a file's text from before the chat's first edit of it: the file's path from
 * the project folder, hashed, so the name is always safe. The hook's lib/handoff.mjs beforeSnapshotFile names it the
 * same way (test/handoffChat.test.mjs).
 */
export function beforeSnapshotFile(dir: string, relPath: string): string {
  return join(dir, BEFORE_DIR, createHash("sha256").update(relPath).digest("hex").slice(0, 32));
}

/**
 * Counts a refused form for a new file and says whether the file is now handed back to the chat's model: the second
 * refusal of the same file, or a refusal the form cannot fix (its command's program is not on this machine). Otherwise
 * a file the net claims could never be written at all.
 */
export function formRefused(dir: string, path: unknown, problems: string[]): boolean {
  if (typeof path !== "string" || !path) return false;
  const counts = readJson(join(dir, REFUSALS));
  const all: Record<string, number> = counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {};
  all[path] = (Number.isFinite(all[path]) ? all[path] : 0) + 1;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, REFUSALS), JSON.stringify(all), { mode: 0o600 });
  const unfixable = problems.some((p) => /is not a program on this machine/.test(p));
  if (all[path] >= 2 || unfixable) { releasePath(dir, path); return true; }
  return false;
}

/**
 * A hand-off the person stopped: Claude never sees its reply, so the plugin's hook tells the person
 * at their next message (hook.mjs "prompt", lib/handoff.mjs takeStopped) and the record is removed then.
 */
export function recordStopped(dir: string, entry: { files: string[]; cost_usd: number }): void {
  const v = readJson(join(dir, STOPPED));
  const all = Array.isArray(v) ? v : [];
  all.push({ ...entry, at: new Date().toISOString() });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, STOPPED), JSON.stringify(all), { mode: 0o600 });
}

/** The project files a failed hand-off left for the chat's model to write by hand. */
export function releasedPaths(dir: string): string[] {
  const v = readJson(join(dir, RELEASED));
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * A hand-off that failed hands its file back: the chat's model writes it itself, and the hook, which refuses a new
 * document typed by hand in a hand-off chat, reads this list and lets that one file through.
 */
export function releasePath(dir: string, path: string): void {
  const all = new Set(releasedPaths(dir));
  if (all.has(path)) return;
  all.add(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, RELEASED), JSON.stringify([...all].sort()), { mode: 0o600 });
}
