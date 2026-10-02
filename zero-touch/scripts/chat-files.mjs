/**
 * A chat's zero-touch records, as the zero-touch plugin writes them (shared by start-chat.mjs and settings-hook.mjs).
 *
 * Every record lives in the chat's own folder, `<MMO_HOME>/sessions/<chat id>/`, beside the records the mmo plugin
 * keeps there; the path rules are the same as mmo's lib/paths.mjs (tools/test/zero-touch-plugin.test.mjs proves it).
 * Claude Code gives a conversation a new chat id at /clear, so a record belongs to exactly one conversation.
 *
 *   chat_mode       "on" (Workflows) or "b" (Hand-off): the mmo plugin acts only in a chat that has it
 *   workflow.json   a Workflows chat's models: { policy, at }
 *   handoff.json    a Hand-off chat's settings: chat model, and who types each kind of work
 *   model_now       the model the chat is on, when Claude Code said so (both modes: a Workflows chat's helpers follow
 *                   the chat's model, so the mmo plugin checks it before it starts a workflow)
 *   zt_setup.json   the first chat after install, until its settings are saved: { asked, at }
 *   zt_flow.json    a settings box sequence in progress: { pending, shown, first, at }
 *   zt_say.json     start lines waiting for the chat's first message: { text, summary_of?, at }. Outside the terminal
 *                   (the desktop app) Claude Code does not show a start hook's message, so start-chat.mjs leaves it
 *                   here and the message hook (settings-hook.mjs "prompt") shows it once.
 *   zt_node_said    Node.js is missing and this chat was told (written by the shell scripts, which cannot run node)
 *   zt_asked        the first chat's settings box was shown (written by the hook before a box)
 *   zt_held         the first chat's one refusal of a tool was used
 *   zt_forked       this chat was made by /branch (a fork): the mmo plugin says once, at its first message, when a
 *                   workflow runs in another chat of the folder (the one it was branched from, most likely)
 *   zt_replay.json  the first chat's first message, left for the mmo plugin when Workflows is saved there: { prompt, at },
 *                   plus `waits` when the chat must switch model first (then held, never judged)
 *                   (its end-of-turn hook judges it once and removes it; plugin/scripts/ambient/hook.mjs takeReplay)
 *   zt_off          not written (an Off chat leaves nothing); one found is removed with the other marks
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mmoHome } from "./settings.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Same as mmo's lib/paths.mjs safeId(): a chat id that is not a plain token becomes a hash, never a path. */
export function safeId(id) {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

export function chatDir(sid, env = process.env) {
  return join(mmoHome(env), "sessions", safeId(sid));
}

export function ensureChatDir(sid, env = process.env) {
  const dir = chatDir(sid, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  return dir;
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readText(file) {
  try { return readFileSync(file, "utf8").trim(); } catch { return null; }
}

export function writeJson(sid, name, value, env = process.env) {
  writeFileSync(join(ensureChatDir(sid, env), name), JSON.stringify({ ...value, at: new Date().toISOString() }), { mode: 0o600 });
}

export function writeText(sid, name, text, env = process.env) {
  writeFileSync(join(ensureChatDir(sid, env), name), text, { mode: 0o600 });
}

export function drop(sid, name, env = process.env) {
  rmSync(join(chatDir(sid, env), name), { force: true });
}

/**
 * The once-a-day sweep of old chat records, from this plugin's start hook too: the mmo plugin's hooks sweep only in
 * a chat zero-touch acts in, so a person who chose Off would keep every record for ever. The same rule
 * and the same day marker as the mmo plugin's (plugin/scripts/ambient/hook.mjs sweepOldSessions): a chat folder whose
 * newest file is older than the retention (30 days) is removed. Never fails a chat's start.
 */
export const RETENTION_DAYS = 30;
export function sweepOldChats(env = process.env, now = Date.now()) {
  const home = mmoHome(env);
  const stamp = join(home, "last-sweep");
  const dayMs = 24 * 3600 * 1000;
  try {
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < dayMs) return;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(stamp, "", { mode: 0o600 });
    for (const root of [join(home, "sessions"), join(home, "logs")]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        let newest = statSync(dir).mtimeMs;
        try { for (const n of readdirSync(dir)) { try { newest = Math.max(newest, statSync(join(dir, n)).mtimeMs); } catch { /* gone */ } } } catch { /* not a folder */ }
        if (now - newest > RETENTION_DAYS * dayMs) rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch { /* housekeeping must never fail a chat's start */ }
}

export const FILES = {
  mode: "chat_mode",
  workflow: "workflow.json",
  handoff: "handoff.json",
  models: "handoff_models.json",
  modelNow: "model_now",
  off: "zt_off",
  setup: "zt_setup.json",
  flow: "zt_flow.json",
  say: "zt_say.json",
  replay: "zt_replay.json",
  nodeSaid: "zt_node_said",
  // The first chat's box was shown, and its one hold was used: files of their own, so two hooks
  // running at once never write one of them back to false.
  asked: "zt_asked",
  held: "zt_held",
  // Off was chosen in this chat and said here: the mmo plugin's "you turned zero-touch off" line, at the
  // next message, is then not said a second time.
  offSaid: "zt_off_said",
  // A chat made by /branch (SessionStart source "fork"): read once by the mmo plugin's hooks.
  forked: "zt_forked",
};
