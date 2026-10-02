/**
 * The model a chat last answered with, read from the end of its transcript.
 *
 * Why: after the first chat's settings box, the saved line names the Hand-off chat model the person chose, but the
 * hook moment after a box (PostToolUse) does not say which model the chat is on, so a chat on another model would not
 * be told to switch until its second message. The transcript says: its last answer of the chat's own carries the model.
 *
 * A copy of the mmo plugin's own reader (plugin/scripts/ambient/lib/transcript.mjs lastAssistantModel): this plugin
 * carries no code of mmo's (see this plugin's README). tools/test/zero-touch-transcript-model.test.mjs keeps the two
 * giving the same answer.
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

/**
 * The model the chat itself last answered with, and when: `{ model, at }`, or null. A helper agent's answers
 * (sidechain entries) and Claude Code's own entries ("<synthetic>") are not the chat's model.
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
