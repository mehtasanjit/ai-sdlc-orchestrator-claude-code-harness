/**
 * Reads the END of a chat's transcript to learn two things the hook input does not carry: whether a message was typed
 * while Claude was still working (sentWhileWorking), and which model the chat last answered with (lastAssistantModel,
 * for hand-off mode, which keeps a chat on one model). Only a bounded tail is read, so the cost is the same for a
 * 2 MB transcript and a 200 MB one.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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

/** The text a transcript entry's content carries: a string, or the text parts of a list. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

/**
 * Was this message typed while Claude was still working on the previous one? Claude Code writes every message to
 * the transcript before the prompt hook runs: one sent when the chat is idle is an ordinary user entry; one sent
 * while Claude is working is delivered into the running task and recorded as a "queued_command" attachment carrying
 * the text. Reads the tail, newest entry first; the latest entry carrying exactly
 * this text decides. Returns true (sent while working), false (sent when idle), or null (not found, or no transcript).
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
 * Whether a message is still waiting in Claude Code's input queue. Every message goes through the queue, recorded as
 * queue-operation entries: enqueue (with the text), then dequeue or remove. A message sent while the chat is idle is
 * enqueued and dequeued at once, and its user entry follows. A message sent while Claude works waits there: in the
 * terminal the prompt hook runs at Enter, while the text is only enqueued, with no user entry and no queued_command
 * attachment yet, so the entry check (sentWhileWorking) would find nothing and judge it as if the chat were idle.
 * Replaying the queue in order says which texts are still waiting.
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
 * The model the chat itself last answered with, and when: `{ model, at }` (at in milliseconds), or null when the tail
 * holds no answer of the chat's own. A helper agent's answers (sidechain entries) and the entries Claude Code writes
 * itself without a model ("<synthetic>") are not the chat's model. The name is returned as written; the caller
 * removes a context tag such as "[1m]".
 */
export function lastAssistantModel(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "assistant" || rec.isSidechain === true) continue;
    const model = rec.message?.model;
    if (typeof model !== "string" || !model || model.startsWith("<")) continue;
    const at = Date.parse(rec.timestamp ?? "");
    return { model, at: Number.isFinite(at) ? at : 0 };
  }
  return null;
}

/**
 * Whether the conversation as it stands now still holds a tool call: after a rewind (/rewind, or
 * editing an earlier message in the desktop app), Claude Code keeps the old entries in the file but continues from an
 * earlier one, so the file still holds the call while the conversation does not. The conversation is the chain of
 * entries from the newest one back through each entry's parent (`parentUuid`; at a compaction, whose boundary has no
 * parent, its `logicalParentUuid`). Walking it back from now:
 *   - an entry that carries the call (the assistant's tool_use, or its result): true, the call is still there;
 *   - the start of the conversation, without passing the call, while the call IS in the file: false, the conversation
 *     went back past it;
 *   - anything else (the chain leaves the bounded tail read here, the call is not in what was read, or the file cannot
 *     be read): null, unknown, and the caller changes nothing.
 * Timestamps are never read: along a real chain they are not in order (the entries Claude Code writes right after a
 * Skill call carry earlier times than the call's result), so stopping at the first entry older than the start would
 * call every workflow "rewound" at the person's first reply. `sinceMs` is kept in
 * the signature for callers and not used. Helper agents' entries (sidechains) are not the conversation. Only a bounded
 * tail is read.
 */
export function onActiveChain(transcriptPath, toolUseId, sinceMs, { tailBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath || typeof toolUseId !== "string" || !toolUseId) return null;
  const carries = (rec) => {
    const content = rec.message?.content;
    return Array.isArray(content) && content.some((p) => p && ((p.type === "tool_use" && p.id === toolUseId) || (p.type === "tool_result" && p.tool_use_id === toolUseId)));
  };
  const byId = new Map();
  let newest = null;
  let inFile = false;
  for (const line of readTail(transcriptPath, tailBytes).split("\n")) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain === true || typeof rec.uuid !== "string") continue;
    byId.set(rec.uuid, rec);
    newest = rec;
    if (carries(rec)) inFile = true;
  }
  let rec = newest;
  for (let steps = 0; rec && steps < 1000000; steps++) {
    if (carries(rec)) return true;
    const next = typeof rec.parentUuid === "string" ? rec.parentUuid : typeof rec.logicalParentUuid === "string" ? rec.logicalParentUuid : null;
    if (next === null) return inFile ? false : null;
    rec = byId.get(next) ?? null;
  }
  return null;
}
