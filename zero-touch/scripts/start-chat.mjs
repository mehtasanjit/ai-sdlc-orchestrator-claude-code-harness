#!/usr/bin/env node
/**
 * The zero-touch plugin's start hook: at the start of a chat it marks the chat with the person's zero-touch mode and
 * models, and tells the person what they need to know.
 *
 * Claude Code runs it at SessionStart while the zero-touch plugin is enabled, and never while it is disabled (then
 * nothing of zero-touch runs, and nothing can be shown). The mmo plugin, which holds all of zero-touch's code, acts
 * only in a chat this hook marked (plugin/scripts/ambient/lib/chat-mode.mjs); what a mark holds is scripts/mark.mjs.
 *
 * Where the settings come from: the person's choices in the zero-touch settings box, kept in this plugin's own data
 * folder (scripts/settings.mjs, scripts/boxes.mjs). No file to edit and no command: the person types "change
 * zero-touch settings" in any chat, in any mode, and Claude opens the box.
 *
 * At a fresh start (a new chat, /clear, which Claude Code gives a new chat id, or a fork, which is a new chat id too):
 *   Node.js older than zero-touch needs        no mark; the person is told, in every chat
 *   nothing saved yet, and the run can show a box   the first chat after install: no mark yet; Claude opens the box
 *                                                    first (the settings hook holds other tools until it is shown)
 *   nothing saved yet, and no screen (claude -p)    no mark; the person is told to choose in a normal chat
 *   settings cannot be used, a last good save exists  that save's settings, and the person is told in every chat
 *   settings cannot be used, no last good save       no mark: zero-touch is OFF (fail safe), and the person is told
 *   Off                                              nothing at all: no mark, no line, no note
 *   Workflows / Hand-off                             the chat is marked (mark.mjs)
 *
 * What the person is shown (quiet by default): the summary of the saved settings (what the mode does, the
 * models) once, in the first new chat after a save (settings.mjs summaryShown); after that only lines that need their
 * action (Google not connected, the chat on the wrong model, settings that cannot be read, a folder with its own model
 * rules). Off says nothing: the saved line already confirmed it. Where the lines go (mark.mjs startMessageShown): the
 * terminal shows a start hook's message at the top of the chat; the desktop app does not show it at all, so there the
 * lines wait in the chat's folder (zt_say.json) and the message hook shows them with the chat's first message.
 *
 * What Claude is given: a Hand-off chat's rules (again after a compaction, which drops them from what Claude reads);
 * the first chat's note to open the box. Nothing else: when the person names zero-touch, the message hook gives Claude
 * the facts of this chat and the settings box then (settings-hook.mjs), in every chat, so the one way to change
 * anything always works. A compaction or a reopened chat keeps its marks and shows nothing again.
 * MMO_AMBIENT (off / observe / on) is a one-run override for a developer or a measuring setup.
 *
 * Self-contained on purpose: Claude Code gives each plugin its own copy of any file it links to at install, so this
 * plugin carries no code of mmo's. Always exits 0: a failure leaves the chat without zero-touch, never blocks it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modeBox } from "./boxes.mjs";
import { FILES, chatDir, drop, readJson, sweepOldChats, writeJson, writeText } from "./chat-files.mjs";
import { googleReadiness } from "./google.mjs";
import { claudeCommand, gitProject, mayBillKey, needsClaudeCommand, needsGitHere, routingOffBy } from "./readiness.mjs";
import { MIN_NODE, canAsk, canonicalModel, chatMarks, hasFolderPolicy, markChat, mmoState, noScreen, nodeTooOld, rememberMmoRoot, startMessageShown, unmarkChat } from "./mark.mjs";
import * as M from "./messages.mjs";
import { updateMmo } from "./mmo-update.mjs";
import { clean, markSummaryShown, mmoHome, needsGoogle, readSettings, settingsInForce, summaryShown } from "./settings.mjs";

const FRESH_STARTS = ["startup", "clear", "fork"];

/**
 * Gives Claude its note now, and shows the person `message` where they can see it: at once where a start message is
 * shown (the terminal), else with the chat's first message (zt_say.json, shown by settings-hook.mjs "prompt").
 * `summaryOf` is the save whose summary the message holds: recorded as shown once it is (at once here, or by the
 * message hook when the message waits). `act`: the message asks the person to do something (a warning), so where the
 * app folds lines away Claude says it too, at the first message (lib relay.mjs).
 */
function reply(sid, env, { message = null, note = null, summaryOf = null, act = false } = {}) {
  const out = {};
  if (message) {
    if (startMessageShown(env)) {
      out.systemMessage = message;
      if (summaryOf !== null) markSummaryShown(summaryOf, env);
    } else {
      writeJson(sid, FILES.say, { text: message, ...(summaryOf !== null ? { summary_of: summaryOf } : {}), ...(act ? { act: true } : {}) }, env);
    }
  }
  if (note) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: note };
  if (out.systemMessage || note) process.stdout.write(JSON.stringify(out));
}

/** The person's own helper-model setting (Claude Code's CLAUDE_CODE_SUBAGENT_MODEL), or null when there is none. */
function helperSetting(env) {
  return String(env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim() || null;
}


/** The lines that need the person's action, in every chat: settings restored, a folder's own rules file, Google. */
function extras(settings, { restored, projectDir, env }) {
  const lines = [];
  if (restored) lines.push(M.restoredLine(settings));
  if (hasFolderPolicy(projectDir)) lines.push(M.folderPolicyLine());
  if (needsGoogle(settings)) {
    const g = googleReadiness(env);
    if (!g.connected) lines.push(M.googleLine(settings, g));
  }
  if (needsClaudeCommand(settings) && !claudeCommand(env)) lines.push(M.claudeCommandLine(settings));
  // Workflows switched off by a setting file: mmo's routing reads <MMO_HOME>/ambient.json and
  // <project>/.sdlc/ambient.json (plugin/scripts/ambient/lib/config.mjs), where "routing": "off" stops every start.
  if (clean(settings).mode === "workflows") {
    const by = routingOffBy(projectDir, env);
    if (by) lines.push(M.routingOffLine(by));
  }
  // Hand-off in a project folder without git: tests and repeats are Claude's own here.
  if (needsGitHere(settings) && !gitProject(projectDir)) lines.push(M.noGitHereLine(settings, { google: !needsGoogle(settings) || googleReadiness(env).connected }));
  return lines;
}

/**
 * What a freshly marked chat shows and gives Claude. `saveKey` names the save these settings came from (null when they
 * did not come from a readable save: the summary is then never due). `always`: the summary every time (a developer's
 * one-run switch, which no save stands behind).
 */
function sayMarked(sid, marked, settings, { model, restored = false, projectDir, env, saveKey, always = false }) {
  if (marked.mode === "observe") return undefined; // a measuring run: it only records
  // Off says nothing (the saved line already confirmed it), unless its settings came from the last good save.
  if (marked.mode === "off") return restored ? reply(sid, env, { message: M.warningsMessage(marked, [M.restoredLine(settings)]) }) : undefined;
  // The Hand-off rules with the Google state: a kind set to Flash 3.8 on a computer not connected to Google is
  // Claude's own work, never a hand-off it would be refused.
  const note = marked.mode === "b" ? M.rulesNote(marked.stamp, { google: !needsGoogle(settings) || googleReadiness(env).connected }) : null;
  const extra = extras(settings, { restored, projectDir, env });
  // A Workflows chat's model: the workflow's helpers follow it unless the person's own setting names one. Not for a
  // person whose workflows may bill an API key: there the run's helpers are not bound to the chat's model, so "no
  // workflow starts until you switch" and "switching is blocked" would be false; the line at a job, which knows the
  // run's real cost recording, speaks instead.
  const wm = marked.mode === "on" ? (mayBillKey(projectDir, env) ? { line: null, warn: false } : M.workflowModelLine(marked.policy, { model, helperSetting: helperSetting(env) })) : null;
  // The chat model line is a warning only when the chat is known to be on another model than Hand-off needs.
  const s = marked.stamp;
  const wrongModel = marked.mode === "b" && s.pin !== "admin" && model && s.chat_model && model !== s.chat_model;
  if (always || (saveKey !== null && !summaryShown(saveKey, env))) {
    const message = marked.mode === "on" ? M.workflowMessage({ policy: marked.policy, extra, modelLine: wm.line }) : M.handoffMessage(marked.stamp, model, { extra });
    return reply(sid, env, { message, note, summaryOf: always ? null : saveKey, act: Boolean(wm?.warn || wrongModel || extra.length) });
  }
  const warn = [...(wrongModel ? [M.chatModelLine(s, model)] : []), ...(wm?.warn ? [wm.line] : []), ...extra];
  return reply(sid, env, { message: warn.length ? M.warningsMessage(marked, warn) : null, note, act: warn.length > 0 });
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const sid = input.session_id;
  const projectDir = (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim()) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  // The model the chat is on, when Claude Code says so at this moment (it does not always).
  const model = canonicalModel(input.model) || null;
  const source = input.source ?? "startup";
  // Where mmo is installed, for the workflow and hand-off hooks this plugin registers (hooks/mmo-hook.sh), kept at
  // every start so an update of either plugin is followed.
  try { rememberMmoRoot(env); } catch { /* the shell script looks beside this plugin instead */ }
  // Old chat records go once a day, Off included.
  sweepOldChats(env);

  // A compaction or a reopened chat keeps its marks and shows nothing again (quiet by default). Claude gets back what
  // a compaction drops: the first chat's note to open the box, or a Hand-off chat's rules.
  if (!FRESH_STARTS.includes(source)) {
    const setup = readJson(join(chatDir(sid, env), FILES.setup));
    if (setup && !setup.asked) {
      if (readSettings(env).state === "none") return reply(sid, env, { note: M.firstRunNote(modeBox(null, { first: true })) });
      // Saved in another chat meanwhile: this chat's first questions are over, and it stays without zero-touch.
      for (const f of [FILES.setup, FILES.flow, FILES.asked, FILES.held]) drop(sid, f, env);
    }
    const kept = chatMarks(sid, env);
    // The model the chat is on, kept for both modes (a Workflows chat's helpers follow it too).
    if (model && (kept?.marked.mode === "b" || kept?.marked.mode === "on")) writeText(sid, FILES.modelNow, model, env);
    if (kept?.marked.mode !== "b") return undefined;
    // Off reaches a reopened chat: the mmo plugin lets go of it at its next message and says so; Claude is not handed
    // the Hand-off rules again meanwhile.
    const now = readSettings(env);
    if (now.state === "unreadable" || settingsInForce(now)?.mode === "off") return undefined;
    return reply(sid, env, { note: M.rulesNote(kept.marked.stamp, { google: !needsGoogle(kept.settings) || googleReadiness(env).connected }) });
  }

  // A fresh start: a new chat id. Anything a settings box or a start left here belongs to no one now.
  for (const f of [FILES.setup, FILES.flow, FILES.say, FILES.replay, FILES.asked, FILES.held, FILES.forked]) drop(sid, f, env);
  // A branch (/branch): a new chat, marked from the settings in force now like any new chat. A
  // workflow running in the chat it was branched from stays there: the mmo plugin says so at its first message.
  if (source === "fork") writeText(sid, FILES.forked, "1", env);
  if (env.MMO_AMBIENT === "off") { unmarkChat(sid, env); return undefined; }
  // Node.js older than zero-touch needs (mark.mjs MIN_NODE): the chat stays plain, and the person is told in every
  // chat (the case where Node.js is missing altogether is the shell script's: it cannot run this file).
  if (nodeTooOld(process.versions?.node)) {
    unmarkChat(sid, env);
    return reply(sid, env, { message: M.nodeOldMessage(process.versions?.node, MIN_NODE), note: M.nodeOldNote(process.versions?.node, MIN_NODE) });
  }
  const r = readSettings(env);
  const saveKey = r.state === "ok" ? r.save : null;
  if (env.MMO_AMBIENT === "observe") { unmarkChat(sid, env); writeText(sid, FILES.mode, "observe", env); return undefined; }
  if (env.MMO_AMBIENT === "on") {
    // A developer's override: workflows on, with the person's workflow models (or the standard ones).
    const settings = clean({ ...r.settings, mode: "workflows" });
    const marked = markChat(sid, settings, { model, env });
    return sayMarked(sid, marked, settings, { model, restored: r.state === "restored", projectDir, env, saveKey: null, always: true });
  }
  // A run with no person at a screen (a script, the Agent SDK, a `claude -p` started from a chat): exactly as Claude
  // Code alone, nothing marked and nothing said.
  if (noScreen(env)) { unmarkChat(sid, env); return undefined; }
  // Off, or settings that cannot be used and no last good save (zero-touch's fail-safe Off): nothing at all, before
  // anything about mmo (an Off person is never told zero-touch is updating mmo, and their mmo is never updated
  // unasked). A last good save of Off still says it is in use.
  if (r.state === "unreadable") { unmarkChat(sid, env); return reply(sid, env, { message: M.unreadableMessage() }); }
  if ((r.state === "ok" || r.state === "restored") && clean(r.settings).mode === "off") {
    unmarkChat(sid, env);
    return r.state === "restored" ? reply(sid, env, { message: M.warningsMessage({ mode: "off" }, [M.restoredLine(r.settings)]) }) : undefined;
  }
  // mmo off, gone, or older than zero-touch needs: no marks, the person is told (with the first message on the
  // desktop app, where a start message is not shown), and Claude is told not to offer zero-touch's settings in this
  // chat.
  const mmo = mmoState(env, projectDir);
  if (mmo !== "ok") {
    unmarkChat(sid, env);
    // Too old: zero-touch updates mmo itself (mmo-update.mjs), so the person is told to start a new chat in a minute;
    // the manual step is said only when the update cannot run or did not help.
    const updating = mmo === "too-old" && updateMmo(env) === "running";
    return reply(sid, env, { message: updating ? M.mmoUpdatingMessage() : mmo === "too-old" ? M.mmoTooOldMessage() : M.mmoMissingMessage(), note: M.MMO_UNAVAILABLE_NOTE });
  }
  if (r.state === "none") {
    unmarkChat(sid, env);
    writeJson(sid, FILES.setup, { asked: false }, env);
    return reply(sid, env, { message: M.welcomeMessage(), note: M.firstRunNote(modeBox(null, { first: true }), { say: !startMessageShown(env) }) });
  }
  const marked = markChat(sid, r.settings, { model, env });
  return sayMarked(sid, marked, r.settings, { model, restored: r.state === "restored", projectDir, env, saveKey });
}

try { main(); } catch { /* a failure leaves the chat without zero-touch, never blocks it */ }
