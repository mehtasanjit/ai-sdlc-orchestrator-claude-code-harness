/**
 * The chat's own on/off decision, taken once at its start.
 *
 * Whether a chat has zero-touch is decided once, at the chat's start moment (SessionStart with source "startup", or
 * "clear", which begins a fresh conversation), and that answer is kept here for the whole chat; every hook moment
 * acts on it, and a change reaches new chats only. Read at different times, a setting changed in the middle of a
 * chat would leave it half on and half off (a running chat's worker tools and its start-of-chat note would
 * disagree). A chat with no record (it started while zero-touch was off, or before the plugin
 * was installed) is off. The record is written by the zero-touch plugin itself, so that plugin is the switch
 * (below). A reopened chat ("resume") and a compaction keep the record they already have.
 *
 * The record is one small file beside the chat's other records: `sessions/<chat id>/chat_mode`, holding "on" or
 * "observe".
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, sessionDir } from "./paths.mjs";

const FILE = "chat_mode";
const ACTIVE = ["on", "observe", "b"];
const FRESH_STARTS = ["startup", "clear"];

/** The mode this chat was started in ("on" or "observe"), or null: no record, so the chat is off. */
export function chatMode(sessionId, env = process.env) {
  try {
    const value = readFileSync(join(sessionDir(sessionId, env), FILE), "utf8").trim();
    return ACTIVE.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** Keeps `mode` as this chat's decision; "off" (or anything else) removes the record. Returns what was kept. */
export function recordChatMode(sessionId, mode, env = process.env) {
  if (!ACTIVE.includes(mode)) {
    dropChatMode(sessionId, env);
    return null;
  }
  const dir = ensureDir(sessionDir(sessionId, env));
  writeFileSync(join(dir, FILE), mode, { mode: 0o600 });
  return mode;
}

export function dropChatMode(sessionId, env = process.env) {
  try { rmSync(join(sessionDir(sessionId, env), FILE), { force: true }); } catch { /* already gone */ }
}

/**
 * The mode this moment of the chat acts in: "on", "observe" or null (off).
 *
 * The record is written at the chat's fresh start (a new chat, or /clear) by the zero-touch plugin's start hook
 * (zero-touch/scripts/start-chat.mjs), which is how people switch zero-touch: enabled in Claude Code's plugin list,
 * every new chat gets the record; disabled, none does. `override` is MMO_AMBIENT, a one-run override
 * for a developer or a measuring setup: at a fresh start "on" or "observe" writes the record without the plugin, and
 * "off" removes it; "off" also wins at every other moment. No settings file takes part.
 */
export function decideChatMode({ event, source, override, sessionId, env = process.env }) {
  const fresh = event === "session-start" && FRESH_STARTS.includes(source ?? "startup");
  if (override === "off") {
    if (fresh) dropChatMode(sessionId, env);
    return null;
  }
  if (fresh && ACTIVE.includes(override)) return recordChatMode(sessionId, override, env);
  return chatMode(sessionId, env);
}
