#!/usr/bin/env node
/**
 * The zero-touch settings box, in the chat: the hooks around Claude Code's question tool (AskUserQuestion).
 *
 * argv[2] is the moment:
 *   pre-ask     before a box is shown (PreToolUse, AskUserQuestion)
 *   post-ask    after the person answered it (PostToolUse, AskUserQuestion)
 *   prompt      a message the person sent (UserPromptSubmit): start lines that waited for it, the box's steps, and
 *               this chat's facts when the message names zero-touch
 *   pre-any     any other tool, in the first chat after install only (PreToolUse, every tool; the shell script skips
 *               node entirely unless that chat is waiting for its first settings)
 *
 * What it guarantees:
 *   - Only a box about zero-touch is checked (scripts/boxes.mjs isZeroTouchBox). Claude's own questions and the
 *     workflows' approval steps pass untouched.
 *   - A zero-touch box must be exactly the one expected now, word for word: the mode box first; after "Workflows" the
 *     models box; after "Hand-off" the four hand-off questions. Anything else is replaced by the expected box before
 *     the person sees it.
 *   - Only the fixed choices are saved, all or nothing, and only when the sequence is complete (Off completes it at the
 *     first box). The saved settings reach new chats; in the first chat after install they apply at once.
 *   - A helper agent never opens the settings: they belong to the main chat.
 *   - A closed box reaches no hook, so it is noticed at the person's next message; the first
 *     chat's hold ends as soon as the box has been SHOWN, whatever the person then does, so nobody is ever stuck.
 *
 * Records (scripts/chat-files.mjs): zt_setup.json (first chat), zt_flow.json (a sequence in progress), zt_say.json
 * (start lines waiting for the first message). The settings themselves: scripts/settings.mjs. Always exits 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boxKind, handoffBox, isZeroTouchBox, modeBox, modelsBox, readAnswers, sameBox } from "./boxes.mjs";
import { FILES, chatDir, drop, readJson, writeJson, writeText } from "./chat-files.mjs";
import { lastAssistantModel } from "./transcript-model.mjs";
import { googleReadiness, onlineCheck } from "./google.mjs";
import { claudeCommand, gitProject, mayBillKey, needsClaudeCommand, needsGitHere, routingOffBy } from "./readiness.mjs";
import { canonicalModel, chatMarks, markChat, mmoState, organisationModel, startMessageShown } from "./mark.mjs";
import { updateMmo } from "./mmo-update.mjs";
import { withRelay } from "./relay.mjs";
import * as M from "./messages.mjs";
import { WORKFLOW_COMMAND, mentionsZeroTouch, promptKind } from "./prompt-kind.mjs";
import { WORKFLOW_MODELS, boxCurrent, clean, dataDir, markSummaryShown, needsGoogle, readSettings, settingsInForce, writeSettings } from "./settings.mjs";

/** The first chat's wait for its box ends at the latest at this many messages the transcript cannot place. */
const GIVE_UP_AFTER = 3;

/** Tools that change nothing: they may run while the first chat waits for its settings box. */
const CHANGES_NOTHING = new Set(["AskUserQuestion", "Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch", "TodoWrite", "TodoRead", "TaskList", "TaskGet", "WebFetch", "WebSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

const emit = (out) => process.stdout.write(JSON.stringify(out));
// A refusal's reason is shown to the person (in red in the desktop app) as well as to the model, so the reason is one
// plain sentence for the person and the model's instruction travels separately, as additionalContext.
const deny = (person, model) => emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: person, ...(model ? { additionalContext: model } : {}) } });

/**
 * The chat's records. "asked" and "held" are files of their own (in the setup record, a hook running at the same
 * moment as another could write "asked" back to false), read into the setup record here.
 */
function state(sid, env) {
  const dir = chatDir(sid, env);
  const raw = readJson(join(dir, FILES.setup));
  const setup = raw ? { ...raw, asked: raw.asked === true || existsSync(join(dir, FILES.asked)), held: raw.held === true || existsSync(join(dir, FILES.held)) } : null;
  return { setup, flow: readJson(join(dir, FILES.flow)) };
}
/** The setup record as written: without the two flags kept in files of their own. */
const setupRecord = (setup) => { const { asked, held, ...rest } = setup ?? {}; void asked; void held; return rest; };
/** Ends the first chat's questions: its records, and the flags beside them. */
function endFirst(sid, env) {
  for (const f of [FILES.setup, FILES.asked, FILES.held]) drop(sid, f, env);
}

/** The settings the boxes mark as current (settings.mjs boxCurrent): none in the first chat after install. */
function current(env, first) {
  return first ? null : boxCurrent(env);
}
/** The mode box for a later change in this chat, as things stand now. */
const laterBox = (env) => modeBox(current(env, false));
/** Whether any settings are saved (in this chat or another): the first chat's questions are over once there are. */
const anySaved = (env) => readSettings(env).state !== "none";

/** The boxes that may be shown now, in order of preference (the first is the one a refusal names). */
function expected(env, { setup, flow }) {
  const first = Boolean(setup);
  const now = current(env, first);
  const mode = modeBox(now, { first });
  if (flow?.pending === "workflows") return [modelsBox(now), mode];
  if (flow?.pending === "handoff") return [handoffBox(now, { first }), mode];
  return [mode];
}

function preAsk(input, env) {
  const questions = input.tool_input?.questions;
  if (!isZeroTouchBox(questions)) return;
  if (typeof input.agent_id === "string" && input.agent_id) return deny(M.HELPER_BOX_PERSON, M.HELPER_BOX_REASON);
  const sid = input.session_id;
  let st = state(sid, env);
  // Two first chats: once the settings are saved in another chat, this chat's box is a later
  // change ("in your new chats"), never the first chat's.
  if (st.setup && anySaved(env)) {
    endFirst(sid, env);
    if (st.flow?.first) drop(sid, FILES.flow, env);
    st = state(sid, env);
  }
  const allowed = expected(env, st);
  const match = allowed.find((box) => sameBox(questions, box));
  // A zero-touch box that is not word for word (reworded, or with an old "current choice" mark) is replaced by the box
  // that is due now, instead of being refused (a refusal, with the whole box as JSON, would show to the person in red,
  // and Claude would have to try again). So the box shown is always the exact one.
  const shown = match ?? allowed[0];
  if (st.setup && !st.setup.asked) writeText(sid, FILES.asked, "1", env);
  // `started`: when this sequence began (a save made elsewhere after it is named when this one saves).
  writeJson(sid, FILES.flow, { pending: st.flow?.pending ?? null, shown: boxKind(shown.questions), first: Boolean(st.setup), started: st.flow?.started ?? new Date().toISOString() }, env);
  if (!match) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, questions: shown.questions } } });
}

function postAsk(input, env) {
  const questions = input.tool_input?.questions;
  if (!isZeroTouchBox(questions) || (typeof input.agent_id === "string" && input.agent_id)) return;
  const kind = boxKind(questions);
  if (!kind) return;
  const sid = input.session_id;
  const st = state(sid, env);
  const first = Boolean(st.setup);
  const before = readSettings(env);
  // The settings in force (the saved ones, or the last good save), or null when nothing can be read; a save over
  // unreadable settings starts from the standard ones for the other mode's values.
  const inForce = settingsInForce(before);
  const base = inForce ?? clean({});
  const got = readAnswers(kind, input.tool_response);
  const endFlow = () => drop(sid, FILES.flow, env);
  if (got.invalid) {
    // The answers that were not choices: the one typed in "Other", or the questions left unanswered, named.
    const typed = got.invalid.find((i) => i.answer)?.answer ?? null;
    const unanswered = got.invalid.filter((i) => !i.answer && i.header).map((i) => i.header);
    // The first chat: the same box once more, so a typo or a skipped question never ends its questions for good; a
    // second miss ends them.
    if (first && !st.setup.retried) {
      writeJson(sid, FILES.setup, { ...setupRecord(st.setup), retried: true }, env);
      if (kind === "mode") endFlow(); else writeJson(sid, FILES.flow, { ...st.flow, shown: null }, env);
      const again = expected(env, state(sid, env))[0];
      return emit({ systemMessage: M.notAChoiceRetryLine(typed, unanswered), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.retryNote(again) } });
    }
    endFlow();
    if (first) endFirst(sid, env);
    return emit({ systemMessage: M.notAChoiceLine(typed, inForce, { first, unanswered }), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.notSavedNote(laterBox(env)) } });
  }
  if (kind === "mode" && got.values.mode !== "off") {
    const mode = got.values.mode;
    // The same rule the check before a box uses (expected): the box named here is the one it will let through.
    const next = mode === "workflows" ? modelsBox(current(env, first)) : handoffBox(current(env, first), { first });
    // The sequence's start is kept: a save made in another chat between this mode answer and the second box is then
    // said, never replaced silently.
    writeJson(sid, FILES.flow, { pending: mode, shown: null, first, ...(st.flow?.started ? { started: st.flow.started } : { started: new Date().toISOString() }) }, env);
    return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.nextBoxNote(mode, next) } });
  }
  // A complete answer: Off from the first box, or the second box after the mode.
  let settings;
  if (kind === "mode") settings = { ...base, mode: "off" };
  else if (kind === "models") {
    if (st.flow?.pending !== "workflows") return; // not in a sequence: the pre-ask check never shows it
    settings = { ...base, mode: "workflows", workflows: { models: got.values.models } };
  } else {
    if (st.flow?.pending !== "handoff") return;
    const { chat_model, documents, tests, repeats } = got.values;
    settings = { ...base, mode: "handoff", handoff: { chat_model, documents, tests, repeats } };
  }
  let saved;
  try {
    saved = writeSettings(settings, env);
  } catch (err) {
    // Nothing was saved: said, so Claude never says it was saved.
    endFlow();
    if (first) endFirst(sid, env);
    return emit({ systemMessage: M.saveFailedLine(err?.code, { first }), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.saveFailedNote(laterBox(env)) } });
  }
  endFlow();
  // The first chat after install: the settings apply to this chat now, once its marks are written. Should that fail,
  // the settings are still saved, and the lines say they apply from the next new chat, which is then the truth.
  let applied = false;
  let marked = null;
  // The model the chat is on: this moment's input does not say, its transcript does.
  const chatModelNow = canonicalModel(input.model) || canonicalModel(lastAssistantModel(input.transcript_path)?.model) || null;
  if (first) {
    endFirst(sid, env);
    try {
      marked = markChat(sid, saved, { model: chatModelNow, env });
      applied = true;
    } catch { /* this chat stays without zero-touch */ }
  }
  // A save made in another chat after this sequence began is replaced by this one: said, never silently.
  const previous = before.state === "ok" && st.flow?.started && String(before.save).split("|")[0] > st.flow.started ? before.settings : null;
  // The setup check: what the chosen settings need, checked now, so the person hears "ready" or exactly what is
  // missing at the moment they choose, never later from a workflow that fails.
  let google = null;
  if (needsGoogle(saved)) {
    const g = googleReadiness(env);
    if (!g.connected) google = g;
    else {
      const live = onlineCheck(env);
      if (live.result === "refused") google = { ...g, online: "refused", detail: live.detail };
    }
  }
  const claudeMissing = needsClaudeCommand(saved) && !claudeCommand(env);
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  // An mmo older than zero-touch needs is brought up to date by zero-touch itself (mmo-update.mjs): "updating" while
  // that runs, so the line says to start a new chat in a minute instead of asking for a manual update.
  const mmoFound = saved.mode === "off" ? "ok" : mmoState(env);
  const mmo = mmoFound === "too-old" && updateMmo(env) === "running" ? "updating" : mmoFound;
  // Workflows from plain words switched off by a setting file, and a helper-model setting that blocks every workflow:
  // said now. A person whose workflows may bill an API key is never told about the chat's or the helpers' model, which
  // their runs do not follow.
  const routingOff = saved.mode === "workflows" ? routingOffBy(projectDir, env) : null;
  // The chat's own model too, in the first chat. Said once, with why, and the first message is not started:
  // switching this chat's model fixes it, so it is not "missing on this computer".
  const helper = saved.mode === "workflows" && !mayBillKey(projectDir, env) ? M.workflowModelLine(saved.workflows.models, { helperSetting: String(env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim() || null, model: applied ? chatModelNow : null }) : null;
  const helperLine = helper?.warn && helper.kind === "setting" ? helper.line : null;
  const switchLine = helper?.warn && helper.kind === "chat" ? helper.line : null;
  // Claude answers the first message now unless a workflow could start from it in this chat (none can with workflows
  // switched off by a setting file, or mmo unavailable).
  const answersNow = saved.mode !== "workflows" || Boolean(routingOff) || mmo !== "ok";
  // The first chat, Workflows saved: its first message is judged once Claude ends this turn (the mmo plugin's
  // end-of-turn hook), so the person does not have to send it again. Also when something is missing: a job then gets
  // the plain reason it cannot start, anything else an answer. Only while the first message is the latest one (a
  // choice made later in the first chat never re-judges it).
  const replay = applied && saved.mode === "workflows" && !answersNow && !switchLine && typeof st.setup?.first_prompt === "string" && !st.setup?.closed_said;
  if (replay) writeJson(sid, FILES.replay, { prompt: st.setup.first_prompt }, env);
  // The first message waits for a model switch: kept all the same, marked `waits`, so the mmo plugin holds a job in it
  // like any start that cannot happen (no file changes in this turn) and never judges it at the turn's end.
  else if (applied && saved.mode === "workflows" && !answersNow && switchLine && typeof st.setup?.first_prompt === "string" && !st.setup?.closed_said) {
    writeJson(sid, FILES.replay, { prompt: st.setup.first_prompt, waits: "chat-model" }, env);
  }
  // Off chosen in an open chat, said here: the mmo plugin does not say it again at the next message.
  if (!applied && saved.mode === "off") writeText(sid, FILES.offSaid, "1", env);
  const switchModel = switchLine ? { have: chatModelNow, want: WORKFLOW_MODELS[saved.workflows.models]?.plans ?? null } : null;
  let note = M.savedNote(saved, { first: applied, box: laterBox(env), missing: Boolean(google || claudeMissing || mmo !== "ok" || helperLine), replay, answersNow, switchModel });
  // The Hand-off rules with the Google state: a kind set to Flash 3.8 on a computer not connected to Google is
  // Claude's own work, never a hand-off it would be refused.
  if (marked?.mode === "b") note = `${note}\n\n${M.rulesNote(marked.stamp, { google: !google })}`;
  // An organisation's pinned model holds a Hand-off chat whatever was chosen: the line names the model that will run.
  const orgModel = saved.mode === "handoff" ? organisationModel(env) : null;
  // mmo off, gone or too old: the line never promises what cannot come true.
  // A first-chat Hand-off chat known to be on another model than the one chosen: the line says to switch.
  const wrongModel = marked?.mode === "b" && marked.stamp.pin !== "admin" && chatModelNow && marked.stamp.chat_model && chatModelNow !== marked.stamp.chat_model;
  // The project folder of this chat has no git while tests or repeats are handed off: said now.
  const noGitHere = needsGitHere(saved) && !gitProject(projectDir);
  const line = [previous ? M.replacedLine(previous) : null, M.savedLine(saved, { first: applied, google, claudeMissing, orgModel, replay, mmo, noGitHere, routingOff, helperLine, switchLine }), wrongModel ? M.chatModelLine(marked.stamp, chatModelNow) : null].filter(Boolean).join("\n");
  // Something the person must act on, where the app folds lines away: Claude says the line too (relay.mjs). A save
  // with nothing to act on is confirmed by Claude's own short sentence, as the note says.
  const actOn = Boolean(google || claudeMissing || mmo !== "ok" || helperLine || switchLine || noGitHere || routingOff || previous || wrongModel);
  const out = { systemMessage: line, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
  emit(actOn ? withRelay(out, "PostToolUse", env) : out);
}

/**
 * A message the person sent. Three things, in this order, all in one answer:
 *   1. start lines that waited for the chat's first message (start-chat.mjs, outside the terminal): shown once;
 *   2. the settings box's own steps (the first chat after install; a box sequence left half done);
 *   3. otherwise, when the message names zero-touch: Claude gets this chat's facts and the settings box (given only
 *      then, not to every chat at its start, so a chat that never mentions zero-touch carries none of it, and a chat
 *      that started before zero-touch was installed or switched on gets it too).
 * A notice Claude Code queues is not the person's message: it shows nothing and changes nothing.
 */
function prompt(input, env) {
  const kind = promptKind(input);
  if (kind === "notice") return;
  const sid = input.session_id;
  const lines = [];
  const notes = [];
  const st = state(sid, env);
  const step = kind === "working" ? null : boxStep(sid, st, kind, env, input.prompt);
  const waiting = readJson(join(chatDir(sid, env), FILES.say));
  if (waiting) {
    drop(sid, FILES.say, env);
    if (typeof waiting.text === "string" && waiting.text && !step?.replacesWelcome) lines.push(waiting.text);
    if (typeof waiting.summary_of === "string") markSummaryShown(waiting.summary_of, env);
  }
  if (step) {
    if (step.line) lines.push(step.line);
    if (step.note) notes.push(step.note);
  // A typed command is the person's own ("/mmo:docs … zero-touch …" gets no settings note): only plain words about
  // zero-touch get its facts and box.
  } else if (!st.setup && !st.flow && !/^\s*\//.test(String(input.prompt ?? "")) && mentionsZeroTouch(input.prompt)) {
    // A chat where zero-touch cannot act because of mmo: the facts say so.
    const marks = chatMarks(sid, env);
    const mmo = marks ? "ok" : (() => { const found = mmoState(env, env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()); return found === "too-old" && readJson(join(dataDir(env), "mmo-update.json")) ? "updating" : found; })();
    notes.push(`${M.modeFactNote(marks, readSettings(env), { mmo })}\n\n${M.settingsNote(laterBox(env))}`);
    // "help me connect Google for zero-touch", the sentence every Google line gives: its fixed steps.
    if (/\b(google|gemini|flash|vertex)\b/i.test(String(input.prompt ?? ""))) notes.push(M.connectGoogleNote(googleReadiness(env)));
  }
  if (!lines.length && !notes.length) return;
  const out = {
    ...(lines.length ? { systemMessage: lines.join("\n\n") } : {}),
    ...(notes.length ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: notes.join("\n\n") } } : {}),
  };
  // Start lines that ask the person to act, where the app folds lines away: Claude says them too (relay.mjs). The
  // welcome and a plain summary are not repeated: the first-chat note already has Claude write the welcome.
  emit(waiting?.act && !step?.replacesWelcome ? withRelay(out, "UserPromptSubmit", env) : out);
}

/**
 * The settings box's steps at a message: { line, note } or null. Only a message the person typed while the chat was
 * idle says anything about the box (prompt-kind.mjs): a message typed while Claude works (delivered into the running
 * turn, where a sequence may be half done) is never asked here. A message the transcript does not show yet
 * ("unknown") ends nothing either; the first chat's wait counts it, with a limit.
 */
function boxStep(sid, st, kind, env, text) {
  const endAll = () => { endFirst(sid, env); drop(sid, FILES.flow, env); };
  if (st.setup && anySaved(env)) {
    // The first chat after install, and the settings were saved in another chat meanwhile: this chat's questions are
    // over. It started without settings, so it stays without zero-touch, like any chat that is already open.
    endAll();
    return { line: M.savedElsewhereLine(), note: M.savedElsewhereNote(laterBox(env)) };
  }
  if (st.setup && !st.setup.asked) {
    // A command typed as the message: it runs as typed, with nothing held, and the questions come with the next plain
    // message.
    // A typed /mmo: workflow (mmo's own command names, with or without "mmo:"): zero-touch steps out of this chat for
    // good, so the run is exactly as without zero-touch, and the welcome held for this message is not shown (it says
    // the questions come first). Any other command runs, and the questions come with the next message.
    if (typeof text === "string" && WORKFLOW_COMMAND.test(text)) {
      endAll();
      return { line: M.firstWorkflowCommandLine(), note: M.FIRST_WORKFLOW_COMMAND_NOTE, replacesWelcome: true };
    }
    if (typeof text === "string" && /^\s*\//.test(text)) {
      writeJson(sid, FILES.setup, { ...setupRecord(st.setup), command_turn: true }, env);
      return { line: null, note: M.FIRST_COMMAND_NOTE };
    }
    const prompts = (st.setup.prompts ?? 0) + 1;
    if ((prompts >= 2 && kind === "idle") || prompts >= GIVE_UP_AFTER) {
      // A whole turn went by and the box was never shown (Claude did not open it, or the question tool is not
      // available here): zero-touch gives up in this chat, so nothing is held for ever.
      // A new turn is known from a message the transcript shows as typed while idle; without that evidence, the
      // limit decides.
      endAll();
      return { line: M.notShownLine(), note: M.notShownNote(laterBox(env)) };
    }
    // The first chat after install: the box comes before anything else. Where the welcome was not shown at the
    // chat's start, Claude says it in a sentence before the box, once.
    // The first message is kept, so once Workflows is saved it can be judged without being sent again.
    const firstPrompt = prompts === 1 && typeof text === "string" && text.trim() ? { first_prompt: text.slice(0, 20000) } : {};
    const { command_turn: _done, ...rest } = setupRecord(st.setup);
    void _done;
    writeJson(sid, FILES.setup, { ...rest, prompts, ...firstPrompt }, env);
    return { line: null, note: M.firstRunNote(modeBox(null, { first: true }), { say: prompts === 1 && !startMessageShown(env) }) };
  }
  // A choice left half done is said to be closed only on positive evidence of a new message ("idle").
  if (kind !== "idle") return null;
  if (st.setup && st.setup.asked) {
    // The box was shown in the first chat and nothing was saved: it was closed, or the person asked something first.
    // Nothing is held; the chat stays the first chat until a choice, so a later choice in it applies now. Said once.
    drop(sid, FILES.flow, env);
    if (st.setup.closed_said) return null;
    writeJson(sid, FILES.setup, { ...setupRecord(st.setup), closed_said: true }, env);
    return { line: M.notChosenYetLine(), note: M.notChosenYetNote(modeBox(null, { first: true })) };
  }
  if (st.flow) {
    // A sequence that never completed: a box was closed, or the second one never opened. Nothing was saved.
    drop(sid, FILES.flow, env);
    return { line: M.closedLine(settingsInForce(readSettings(env))), note: M.closedNote({ box: laterBox(env) }) };
  }
  return null;
}

function preAny(input, env) {
  const sid = input.session_id;
  const st = state(sid, env);
  // A command typed as the message runs as typed: nothing is held in its turn.
  if (!st.setup || st.setup.asked || st.setup.command_turn) return;
  const tool = String(input.tool_name ?? "");
  if (CHANGES_NOTHING.has(tool)) return;
  // Settings saved in another chat end this chat's hold at once.
  if (anySaved(env)) return;
  // One refusal at most: a run that cannot show the question box (a `claude -p` run started from inside a chat
  // inherits the chat's label, so it looks like a chat with a screen) is never blocked for its whole turn. The one
  // refusal says to open the box, or, where it cannot be shown, to carry on; then nothing is
  // held any more in this chat.
  if (st.setup.held) return;
  // A file of its own, so a box shown at the same moment ("asked") is never written back to false.
  writeText(sid, FILES.held, "1", env);
  deny(M.HOLD_PERSON, M.holdReason(modeBox(null, { first: true })));
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const moment = process.argv[2];
  if (moment === "pre-ask") return preAsk(input, env);
  if (moment === "post-ask") return postAsk(input, env);
  if (moment === "prompt") return prompt(input, env);
  if (moment === "pre-any") return preAny(input, env);
}

try { main(); } catch { /* a failure never blocks the chat */ }
