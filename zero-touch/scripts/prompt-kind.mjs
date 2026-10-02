/**
 * Which messages the settings box's hooks may act on: only a message the person typed while the chat was idle.
 *
 * Why: the prompt hook fires for more than that. Claude Code queues its own notices (a background command finished,
 * …) as messages, and a message the person types while Claude is working is delivered into the running turn, where a
 * settings sequence may be half done (the mode answered, the next box not yet shown). Taking either for "the person
 * moved on" would drop the sequence and say "nothing was saved" while the person is still choosing. So those
 * messages are left alone here, exactly as the mmo plugin's routing leaves them alone.
 *
 * Both rules are COPIES of the mmo plugin's own (plugin/scripts/ambient/hook.mjs NOTICE_TAG, lib/transcript.mjs
 * sentWhileWorking): Claude Code gives each plugin its own files, so zero-touch carries no mmo code.
 * tools/test/zero-touch-prompt-kind.test.mjs keeps the copies identical in behaviour.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The tags Claude Code wraps its own queued notices in (the mmo plugin's list, read from the program). */
export const NOTICE_TAG = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

const TAIL_BYTES = 256 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

/**
 * Whether a message is still waiting in Claude Code's input queue: typed while Claude works, the prompt hook can run
 * while the text is only enqueued (the terminal runs it at Enter). A copy of mmo's rule
 * (plugin/scripts/ambient/lib/transcript.mjs stillQueued).
 */
function stillQueued(lines, want) {
  const queue = [];
  for (const line of lines) {
    if (!line || !line.startsWith('{"type":"queue-operation"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = typeof rec.content === "string" ? rec.content.trim() : null;
    if (rec.operation === "enqueue" && content !== null) queue.push(content);
    else if (rec.operation === "dequeue") queue.shift();
    else if (rec.operation === "remove") {
      const at = content !== null ? queue.indexOf(content) : 0;
      if (at >= 0) queue.splice(at, 1);
    } else if (rec.operation === "popAll" || rec.operation === "clear") queue.length = 0;
  }
  return queue.includes(want);
}

/**
 * Was this message typed while Claude was still working? true (sent while working: still in the input queue, or a
 * "queued_command" attachment), false (sent when idle: an ordinary user entry), or null (not found, or no
 * transcript). The latest entry carrying exactly this text decides.
 */
export function sentWhileWorking(transcriptPath, text) {
  if (typeof transcriptPath !== "string" || !transcriptPath || typeof text !== "string" || !text.trim()) return null;
  const want = text.trim();
  const lines = readTail(transcriptPath).split("\n");
  if (stillQueued(lines, want)) return true;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain === true) continue;
    if (rec.type === "attachment" && rec.attachment?.type === "queued_command" && typeof rec.attachment.prompt === "string" && rec.attachment.prompt.trim() === want) return true;
    if (rec.type === "user" && contentText(rec.message?.content).trim() === want) return false;
  }
  return null;
}

/**
 * What a message the prompt hook sees is, for the settings box:
 *   "notice"   a notice Claude Code queued (never the person);
 *   "working"  typed while Claude was working: it joins the running turn;
 *   "idle"     typed while the chat was idle: the transcript shows it as an ordinary entry, or there is no transcript
 *              to tell (as the mmo plugin's routing assumes);
 *   "unknown"  a transcript exists but does not show this message yet (it may be one typed mid-turn, not yet written).
 * The settings box ends a half-done choice, or gives up waiting in the first chat, only on positive evidence
 * ("idle"); "unknown" is waited out, with a limit (settings-hook.mjs), so nothing is held for ever.
 */
/**
 * Whether a message names zero-touch ("change zero-touch settings", "is zero touch on?"): the mmo plugin's routing
 * leaves such a message alone (plugin/scripts/ambient/lib/route.mjs mentionsZeroTouch), and the settings hook gives
 * Claude this chat's facts and the settings box. A COPY of mmo's rule, like the two above;
 * tools/test/zero-touch-prompt-kind.test.mjs keeps them the same.
 */
export const ABOUT_ZERO_TOUCH = /\bzero[\s-]?touch\b|\bzerotouch\b/i;

/**
 * mmo's workflow commands as typed, with or without "mmo:": a COPY of mmo's own list
 * (plugin/scripts/ambient/lib/commands.mjs WORKFLOW_COMMANDS), kept equal by tools/test/zero-touch-settings-box.test.mjs.
 */
export const WORKFLOW_COMMAND_NAMES = ["greenfield", "brownfield", "bugfix", "feature-extend", "feature-new", "refactor", "test", "docs", "deps", "pass"];
export const WORKFLOW_COMMAND = new RegExp(`^\\s*\\/(?:mmo:)?(?:${WORKFLOW_COMMAND_NAMES.join("|")})(?:\\s|$)`, "i");
export function mentionsZeroTouch(text) {
  return ABOUT_ZERO_TOUCH.test(String(text ?? ""));
}

export function promptKind(input) {
  const text = typeof input?.prompt === "string" ? input.prompt : "";
  if (NOTICE_TAG.test(text)) return "notice";
  const path = input?.transcript_path;
  if (typeof path !== "string" || !path) return "idle";
  const w = sentWhileWorking(path, text);
  return w === true ? "working" : w === false ? "idle" : "unknown";
}
