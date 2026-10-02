/**
 * Everything the zero-touch plugin says: the start message a person sees at the top of a chat, the lines after a
 * settings box, and the notes Claude reads (the person never sees those).
 *
 * The wording is written for a person with no context and no technical knowledge. Its rules: true every time it is
 * shown; what happened, why, and what to do now; one word per thing (Workflows / Hand-off / Off, workflow, approval
 * step, hand off, chat model, checked automatically, zero-touch settings); no file to edit and no command to learn,
 * except the few a person must type, given in full; money said when money is spent; "this chat" and "new chats" never
 * mixed up. The one way to change anything, in every mode, is to type "change zero-touch settings" (any wording
 * works: it only opens the box).
 */
import { CHAT_MODELS, KINDS, TYPISTS, WORKFLOW_MODELS, clean, describe } from "./settings.mjs";

export const CHANGE = "change zero-touch settings";
/** The eight jobs that get a full workflow, as the person reads them (one list, used wherever they are named). */
const JOBS = "build a new app, fix a bug, add to a feature, build a new feature, clean up code, write tests, write documentation, upgrade a library";

// ─── Start messages ──────────────────────────────────────────────────────

/**
 * The plain-language guide (docs/zero-touch-guide.md), on the branch zero-touch installs from: installing a plugin
 * copies only its own folder, so the welcome is where every new user is shown where it is.
 * tools/test/zero-touch-guide-link.test.mjs checks the file is there.
 */
export const GUIDE_URL = "https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness/blob/develop/docs/zero-touch-guide.md";

/** The first chat after install, nothing chosen yet. */
export function welcomeMessage() {
  return [
    // No price claim: on a Claude plan "AI models that cost less than Opus 5" is not a price the person pays, and
    // Flash 3.8 adds a Google bill. tools/test/zero-touch-cost-words.test.mjs.
    "Welcome to zero-touch. It lets Claude give parts of the work to other AI models you choose, with no special commands to learn.",
    "Before Claude answers your first message, it will ask you a few quick questions: how zero-touch should work, and which AI models to use. Your answers apply straight away, starting with this chat.",
    `You can change them at any time: type "${CHANGE}".`,
    `The guide, with what to type and what you'll see: ${GUIDE_URL}`,
  ].join("\n");
}

// A run with no screen says nothing at all: zero-touch leaves it exactly as Claude Code alone would (start-chat.mjs,
// mark.mjs noScreen).

/**
 * The settings cannot be used (damaged, or a value that is not a choice) and there is no last good save: zero-touch is
 * off in this chat. Said in every chat until the person chooses again.
 */
export function unreadableMessage() {
  return `Zero-touch couldn't read your settings, so it's off in this chat. To choose them again, type "${CHANGE}".`;
}

/** The same, with a last good save to fall back on: those settings are used, and said. */
export function restoredLine(settings) {
  return `• Zero-touch couldn't read your settings file, so it's using the last settings you saved: ${describe(settings)}. To save them again, type "${CHANGE}".`;
}

/** The project has its own model rules file, which zero-touch does not follow. */
export function folderPolicyLine() {
  return "• This project has its own AI-model rules file (routing-policy.yaml), probably added by your team. Zero-touch doesn't follow it; it uses your settings above. (Workflows you start by typing a command do use it.)";
}

/**
 * Google cannot be used and the settings use Flash 3.8. `g` is google.mjs's answer: { state, shellOnly } offline, plus
 * `online: "refused"` when Google turned the sign-in down at save time. Never a raw error, a file path or a command:
 * the one way to fix it is a sentence the person can say to Claude.
 */
export function googleLine(settings, g = {}) {
  const s = clean(settings);
  // Hand-off: a Flash hand-off fails at once without Google, and the ladder's last attempt is the chat's own model,
  // or, if that fails too, the chat does the piece itself. "This chat's model" is true in both cases, and also when an
  // organisation keeps the chat on a model other than the one chosen in the box.
  // Workflows: with no Google login a workflow does not start (route-flow.mjs startProblem, checked offline). A login
  // that exists but that Google refused passes that offline check, so the workflow starts and its Flash steps fail
  // (the start-up check builds the model's connection, it does not call it): said as such.
  const until = s.mode !== "workflows"
    ? "work set to Flash 3.8 is done by this chat's model instead"
    : g.online === "refused" ? "workflows can't use Flash 3.8: they may stop, or use another model for those steps" : "workflows won't start";
  const fix = `To fix it, ask Claude: "${CONNECT_GOOGLE}". Or type "${CHANGE}" and choose models without Flash.`;
  if (g.online === "refused") return `• Google turned down this computer's sign-in just now (it may have expired), so Google's Flash 3.8 can't be used yet. Until it's fixed, ${until}. ${fix}`;
  if (g.shellOnly?.length) return `• Your Google sign-in is set up for the terminal only, and the Claude app doesn't read the terminal's settings, so Google's Flash 3.8 can't be used here yet. Until it is, ${until}. ${fix}`;
  if (g.state === "broken") return `• This computer's Google sign-in is damaged or incomplete, so Google's Flash 3.8 can't be used yet. Until it's fixed, ${until}. ${fix}`;
  // Signed in to Google Cloud, but no project chosen for it.
  if (g.state === "no-project") return `• This computer is signed in to Google Cloud, but no Google Cloud project is chosen for it, so Google's Flash 3.8 can't be used yet. Until one is, ${until}. ${fix}`;
  return `• Google's Flash 3.8 can't be used yet, because this computer isn't connected to Google. Until it is, ${until}. ${fix}`;
}

/**
 * Hand-off in a project folder without git: new tests and repeated changes are checked in a git test copy, so in this
 * folder Claude does them itself; documents still go to their model. Said when the settings are saved and at a chat's
 * start in such a folder.
 */
export function noGitHereLine(settings, { google = true } = {}) {
  const s = clean(settings);
  // Only when that is true: documents set to Flash 3.8 without Google are the chat's own work too.
  const docs = s.handoff.documents !== "chat" && (!TYPISTS[s.handoff.documents].usesFlash || google) ? " New documents are still handed off." : "";
  return `• This project folder isn't set up with git, so new tests and repeated changes can't be checked in a test copy here; Claude does them itself in this folder.${docs}`;
}

/** Workflows switched off by a setting file: said in every chat that has it. */
export function routingOffLine(by) {
  return `• Workflows from plain words are switched off ${by === "project" ? "for this project by a setting file in it" : "by a zero-touch setting file on this computer"}, so none start here; Claude answers normally.`;
}

/** What the person says to Claude to get help connecting Google (the note Claude then follows: connectGoogleNote). */
export const CONNECT_GOOGLE = "help me connect Google for zero-touch";

/**
 * Something the chosen models need is not on this computer: Claude Code's own command-line program, which a new-app
 * workflow (its last attempt at any step) and a Claude typist or last attempt in Hand-off mode run.
 */
export function claudeCommandLine(settings) {
  const what = clean(settings).mode === "workflows" ? "new-app workflows can't run yet" : "work handed off can't be checked by Claude's own models yet";
  return `• Claude Code's command-line program wasn't found on this computer, so ${what}. Installing Claude Code for the terminal fixes it; Claude can help.`;
}

/**
 * The chat-model line of a Workflows chat (zero-touch as a strict add-on): a workflow's helpers follow the chat's
 * model, as mmo does without zero-touch, unless the person's own helper setting (CLAUDE_CODE_SUBAGENT_MODEL) names
 * one, so the chat must be on the model the workflow models plan with. `model`: the model the chat is on, when known.
 * Returns { line, warn, kind }: `warn` when no workflow can start until the person acts (the line then shows in every
 * chat); `kind` "setting" (a setting on the computer decides) or "chat" (this chat's own model decides). Every line
 * says why, naming the models the person chose.
 */
export function workflowModelLine(policy, { model = null, helperSetting = null } = {}) {
  const chosen = WORKFLOW_MODELS[policy] ?? WORKFLOW_MODELS["opus-plus-flash-v38"];
  const want = chosen.plans;
  const name = modelName(want);
  const why = `you chose ${chosen.label}, where ${name} plans and reviews, and that part runs on this chat's own model`;
  if (helperSetting) {
    if (helperSetting === want) return { line: null, warn: false, kind: "setting" };
    return { line: `• A setting on this computer makes workflow helpers run on ${modelName(helperSetting)}, but you chose ${chosen.label}, where ${name} plans and reviews, so no workflow starts until that setting is changed. Claude can help you change it.`, warn: true, kind: "setting" };
  }
  if (model && model !== want) return { line: `• This chat is on ${modelName(model)}, but ${why}. So no workflow starts until you switch this chat to ${name} with the model menu next to the message box (in the terminal, type /model ${want}).`, warn: true, kind: "chat" };
  if (!model) return { line: `• Workflows need this chat on ${name}, because ${why}. If it's on a different model, switch it with the model menu next to the message box (in the terminal, type /model ${want}).`, warn: false, kind: "chat" };
  // What is enforced: only a workflow zero-touch started holds the model (a typed one is mmo's own, as without
  // zero-touch), and only a switch Claude Code reports can be refused.
  return { line: `• This chat is on ${name}, which workflows need, because ${why}. While a workflow zero-touch started runs, zero-touch refuses a switch to another model.`, warn: false, kind: "chat" };
}

/** Workflows mode. `policy` is the chat's stamped policy name; `modelLine` the chat-model line (workflowModelLine). */
export function workflowMessage({ policy, extra = [], modelLine = null }) {
  const m = WORKFLOW_MODELS[policy] ?? WORKFLOW_MODELS["opus-plus-flash-v38"];
  return [
    "Zero-touch is on in this chat: Workflows mode.",
    // What zero-touch recognises, said as such: "in your own words" would promise more (another language, or a
    // request that only describes a problem, gets a normal answer), and a change must say what it is about ("add a
    // due date to each to-do" names no part of the project, so it is answered as chat; route.mjs keeps precision
    // first). Every example here is recognised: tools/test/zero-touch-cost-words.test.mjs routes them. The cost said
    // as usage, with the report's figure an estimate: true on a Claude plan and with an API key alike.
    `• When you ask in English for one of these jobs, starting with what you want done and saying what it is about (for example "fix the login bug", "add a due date to the to-do form", or "build a small to-do app" in an empty folder), Claude starts a full workflow for it: ${JOBS}.`,
    `• A workflow works in steps and waits for your approval at the main ones (for a new app: requirements, design, security review, final check). It uses ${policy === "opus-only-v5" ? "" : "several AI models and "}far more usage than a normal chat. The report at the end shows an estimate of what it cost.`,
    `• Your models: ${m.says}.`,
    ...(modelLine ? [modelLine] : []),
    "• Anything else you type gets a normal answer from Claude.",
    ...extra,
    `• To change how zero-touch works, type "${CHANGE}". Changes apply from your next new chat; choosing Off stops zero-touch in open chats too.`,
  ].join("\n");
}

/** The kinds of hand-off work, as the start message and the rules note name them. */
const KIND_WORDS = {
  documents: "new documents, specs and plans",
  tests: "new tests",
  repeats: "the same change repeated in many files",
};

/** The kinds of work a Hand-off stamp hands off (not kept in the chat). */
function handedKinds(stamp) {
  return KINDS.filter((k) => (stamp.typists?.[k]?.typist ?? "chat") !== "chat");
}

/** The chat-model line of a Hand-off chat. `model` is the model the chat is on now, when known. */
export function chatModelLine(stamp, model) {
  const want = stamp.chat_model;
  const name = modelName(want);
  if (stamp.pin === "admin") return `• This chat stays on ${stamp.chat_model ? name : stamp.admin_model}, the model your organisation set.`;
  // Says why, naming the person's own choice.
  if (model && model !== want) {
    return `• This chat is on ${modelName(model)}, but you chose ${name} to do the development in Hand-off mode. Switch it to ${name} using the model menu next to the message box (in the terminal, type /model ${want}). After that, zero-touch refuses a switch away.`;
  }
  if (!model) return `• Hand-off mode needs this chat on ${name}, because you chose ${name} to do the development. If it's on a different model, switch it using the model menu next to the message box (in the terminal, type /model ${want}).`;
  // Savings and hand-off decisions are named only when something is handed off (all kept in the chat: neither exists).
  const handsOff = handedKinds(stamp).length > 0;
  if (want === "claude-opus-5") {
    return handsOff
      ? "• This chat stays on Opus 5, because good development and good hand-off decisions need its judgment; the models you chose do the simple writing. Zero-touch refuses a switch to another model, and points it out if the chat runs on another one anyway."
      : "• This chat stays on Opus 5, because good development needs its judgment. Zero-touch refuses a switch to another model, and points it out if the chat runs on another one anyway.";
  }
  return `• This chat stays on ${name}, as you chose. The quality of ${handsOff ? "the development and the hand-offs" : "the work"} depends on this model; Opus 5 gives the best results. Zero-touch refuses a switch to another model, and points it out if the chat runs on another one anyway.`;
}

/** Hand-off mode. */
export function handoffMessage(stamp, model, { extra = [] } = {}) {
  const chat = modelName(stamp.chat_model ?? stamp.admin_model);
  const rows = KINDS.map((k) => {
    const t = stamp.typists?.[k]?.typist ?? "chat";
    if (t === "chat") return `  – ${KIND_WORDS[k]}: kept in this chat (${chat} does it)`;
    const who = t === "flash" ? "Google's Flash 3.8" : TYPISTS[t].name;
    return `  – ${KIND_WORDS[k]}: ${who}${k === "tests" ? " (tests are only added after a run in a test copy of your project gives the expected result)" : ""}`;
  });
  // What is handed off, said only as far as it is true: no price claim (on a Claude plan the typists' per-token
  // prices are not what the person pays); nothing about hand-offs when all three kinds stay here.
  const work = handedKinds(stamp).length === 0
    ? [`• Nothing is handed off, because you chose to keep all of it in this chat: new documents, specs and plans, new tests, and the same change repeated in many files are all done by ${chat} here.`]
    : [
        `• Simple writing work is handed off to the AI model you chose for it, and checked automatically before it's added to your project:`,
        ...rows,
        // The last attempt is the chat's own model; when an organisation keeps the chat on a model that is not one
        // named id (an alias), the server uses the policy's Claude model instead, so no model is named for it.
        `• ${chat} decides what to hand off and gives that model clear instructions. If a hand-off fails twice, ${stamp.chat_model ? `${chat} tries once more itself` : "Claude tries once more"}; if that fails too, ${chat} does the work directly in this chat. Anything a hand-off adds to your project can be undone: just ask Claude.`,
      ];
  return [
    "Zero-touch is on in this chat: Hand-off mode.",
    // "the model you chose", never "this chat's model": the setting is the person's choice, not a fact about the chat.
    `• ${chat}, the model you chose for this chat, does the real development work itself: understanding your project, deciding what to do, writing and fixing code, and reviewing.`,
    ...work,
    chatModelLine(stamp, model),
    "• In this mode, asking for a job doesn't start a full workflow; Claude simply does the work in this chat.",
    ...extra,
    `• To change how zero-touch works, type "${CHANGE}". Changes apply from your next new chat; choosing Off stops zero-touch in open chats too.`,
  ].join("\n");
}

// Off has no start message: the saved line already confirmed the choice, and a line at every chat of a person who
// chose Off would be noise.

/**
 * A chat after the summary of the saved settings has been shown once (quiet by default), when something
 * needs the person's action: the mode in one line, then only those lines. `marked` is mark.mjs markChat's answer.
 */
export function warningsMessage(marked, lines) {
  const head = marked.mode === "b" ? "Zero-touch is on in this chat: Hand-off mode." : marked.mode === "off" ? "Zero-touch is off in this chat, as you chose." : "Zero-touch is on in this chat: Workflows mode.";
  return [head, ...lines].join("\n");
}

/** zero-touch starts in a chat whose mmo plugin is switched off or missing (a backstop; see start-chat.mjs). */
export function mmoMissingMessage() {
  return "Zero-touch can't work right now, because a plugin it needs, mmo, is switched off or missing. Switch mmo back on in your plugins list, or remove zero-touch as well.";
}

/** The installed mmo is older than zero-touch needs. */
export function mmoTooOldMessage() {
  return "Zero-touch can't work right now, because a plugin it needs, mmo, is an older version. Update mmo in your plugins list, then start a new chat.";
}

/**
 * The installed mmo is older than zero-touch needs, and zero-touch is updating it (mmo-update.mjs): the person
 * does nothing but start a new chat, where the updated mmo is loaded.
 */
export function mmoUpdatingMessage() {
  return "Zero-touch is updating mmo, a plugin it needs, which is an older version. Claude works as normal in this chat. Start a new chat in a minute to use zero-touch.";
}

/** What Claude is told in a chat where zero-touch cannot act because of mmo. */
export const MMO_UNAVAILABLE_NOTE = "Zero-touch, a plugin installed here, cannot act in this chat because a plugin it needs (mmo) is switched off, missing or out of date; the person has been shown a line saying so. Answer their messages normally. Do not open zero-touch's settings box unless they ask to change zero-touch's settings.";

/**
 * Node.js is not installed: said once per chat by the hooks' shell scripts, which cannot run this file (at the start
 * in the terminal, at the chat's first message elsewhere; tools/test/zero-touch-plugin.test.mjs runs them and checks
 * they print exactly these words). No apostrophe in the note: the shell scripts print it inside single quotes.
 */
export const NODE_MISSING = "Zero-touch can't run on this computer, because a program it needs, Node.js, isn't installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat.";
export const NODE_MISSING_NOTE = "Zero-touch, a plugin installed here, cannot run because Node.js is not installed on this computer, so it does nothing in this chat. The person has been shown a line saying so. Answer their message normally. If they ask about zero-touch, tell them to install Node.js from nodejs.org and then start a new chat.";

/** Node.js is installed but older than zero-touch needs (mark.mjs MIN_NODE): said once per chat, like NODE_MISSING. */
export function nodeOldMessage(version, min) {
  return `Zero-touch can't run on this computer, because its Node.js is too old (version ${String(version).replace(/^v/, "")}; zero-touch needs version ${min} or newer). Claude works as normal without it. To use zero-touch, install a newer Node.js from nodejs.org, then start a new chat.`;
}
export function nodeOldNote(version, min) {
  return `Zero-touch, a plugin installed here, cannot run because the Node.js on this computer is too old (version ${String(version).replace(/^v/, "")}; it needs ${min} or newer), so it does nothing in this chat. The person has been shown a line saying so. Answer their message normally. If they ask about zero-touch, tell them to install a newer Node.js from nodejs.org and then start a new chat.`;
}

// ─── After the settings box ──────────────────────────────────────────────

/**
 * Saved, with the setup check's result: what the chosen settings need is checked the moment they are
 * chosen, so the person hears "ready" or exactly what is missing, never later from a workflow that fails. `first` is
 * the first chat after install, where the settings apply to this chat too. `google` is set when the settings use
 * Flash and Google cannot be used (google.mjs googleReadiness, or the real check refused); `claudeMissing` when
 * Claude Code's command-line program is needed and not found (readiness.mjs).
 */
/**
 * `switchLine`: the first chat is on another model than the chosen workflow models plan with. It is not "missing on
 * this computer" (switching this chat's model fixes it, no new chat needed), so it is said after the setup check, and
 * the first message is not started.
 */
export function savedLine(settings, { first = false, google = null, claudeMissing = false, orgModel = null, replay = false, mmo = "ok", noGitHere = false, routingOff = null, helperLine = null, switchLine = null } = {}) {
  const s = clean(settings);
  // The mmo plugin switched off, gone or too old: listed as the missing piece, so nothing is
  // promised that cannot happen until it is fixed.
  const mmoLine = mmo === "updating" ? "• mmo, a plugin zero-touch needs, is an older version; zero-touch is updating it now. Start a new chat in a minute."
    : mmo === "too-old" ? "• mmo, a plugin zero-touch needs, is an older version. Update it in your plugins list."
    : mmo === "off" || mmo === "missing" ? "• mmo, a plugin zero-touch needs, is switched off or missing. Switch it back on in your plugins list." : null;
  // A helper-model setting naming another model: listed with what is missing.
  const missing = [...(mmoLine ? [mmoLine] : []), ...(google ? [googleLine(s, google)] : []), ...(claudeMissing ? [claudeCommandLine(s)] : []), ...(helperLine ? [helperLine] : [])];
  const check = s.mode === "off" ? "" : missing.length
    ? `\n${missing.length > 1 ? `Setup check: ${missing.length === 2 ? "two things" : `${missing.length} things`} are missing on this computer.` : "Setup check: one thing is missing on this computer."}\n${missing.join("\n")}`
    : "\nSetup check: everything these settings need is ready on this computer.";
  const what = describe(s, { orgModel });
  // Folder facts, not something missing on the computer: said after the check.
  const folder = `${noGitHere ? `\n${noGitHereLine(s, { google: !google })}` : ""}${routingOff ? `\n${routingOffLine(routingOff)}` : ""}`;
  // Off reaches open chats at once: said as it happens.
  if (!first && s.mode === "off") return "Zero-touch: your settings are saved: Off. Zero-touch stops in this chat from your next message (a workflow already running here finishes first), and new chats start without it.";
  if (!first) return `Zero-touch: your settings are saved. From your next new chat: ${what}. This chat carries on as it started.${check}${folder}`;
  // The first message arrived before there were settings, so zero-touch never judged it. Claude answers it now unless
  // a workflow could start from it here; otherwise zero-touch judges it at the end of this turn, with nothing resent,
  // also when something is missing: a job then gets the plain reason it cannot start, and any other message an answer.
  const tail = s.mode !== "workflows" || routingOff || (mmo !== "ok")
    ? " Claude now answers your message."
    : replay
      ? missing.length
        ? ` Zero-touch now looks at your first message: if it asks for one of these jobs, its full workflow can start in a new chat once the missing piece below is fixed; anything else gets a normal answer.`
        : ` Zero-touch now looks at your first message: if it asks for one of these jobs, its full workflow starts: ${JOBS}. Anything else gets a normal answer.`
      : missing.length
        ? " Once the missing piece below is fixed, ask again in a new chat."
        : switchLine
          ? " Your first message hasn't been started as a workflow yet, because of this chat's model (see below): switch it, then send your request again."
          : ` Send your request again: if it asks for one of these jobs, zero-touch starts a full workflow for it: ${JOBS}. Anything else gets a normal answer.`;
  return `Zero-touch: your settings are saved and apply from now on, in this chat too: ${what}.${tail}${check}${folder}${switchLine ? `\n${switchLine}` : ""}`;
}

/** What "your settings are still" says: the settings in force, or, when they cannot be read, that zero-touch stays off. */
const stillIs = (settings) => (settings ? `Your settings are still: ${describe(settings)}.` : "Your settings still can't be read, so zero-touch stays off in new chats.");

/** An answer typed in "Other" (or no answer): nothing saved. `settings`: the ones in force, or null when unreadable. */
export function notAChoiceLine(answer, settings, { first = false, unanswered = [] } = {}) {
  const said = typeof answer === "string" && answer ? `"${answer}" isn't one of the choices, so nothing was changed.`
    : unanswered.length ? `${listWords(unanswered)} ${unanswered.length === 1 ? "wasn't" : "weren't"} answered, so nothing was changed.`
      : "No choice was made, so nothing was changed.";
  if (first) return `Zero-touch: ${said} Zero-touch won't do anything in this chat; it will ask again in your next new chat, or type "${CHANGE}" at any time.`;
  return `Zero-touch: ${said} ${stillIs(settings)} To try again, type "${CHANGE}".`;
}

/** "Tests", "Tests and Repeats", "Documents, Tests and Repeats". */
function listWords(words) {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The first chat after install, an answer that is not a choice: the same box once more, so a typo or a skipped
 * question never ends the first chat's questions for good.
 */
export function notAChoiceRetryLine(answer, unanswered = []) {
  const said = typeof answer === "string" && answer ? `"${answer}" isn't one of the choices` : unanswered.length ? `${listWords(unanswered)} ${unanswered.length === 1 ? "wasn't" : "weren't"} answered` : "no choice was made";
  return `Zero-touch: ${said}, so nothing was saved yet. Claude shows the choices once more.`;
}
export function retryNote(box) {
  return `The person's answer in the zero-touch settings box was not one of its choices, so nothing was saved. Open the same box once more, with ${exactly(box)}. If they say they don't want to choose now, don't open it again: answer their first message normally.`;
}

/**
 * The first chat after install, the box shown but nothing chosen: the person may have asked something first. Nothing
 * is held, and a choice made later in this chat still applies to it.
 */
export function notChosenYetLine() {
  return `Zero-touch: nothing is chosen yet, so zero-touch does nothing for now. When you're ready, type "${CHANGE}".`;
}
export function notChosenYetNote(box) {
  return `The person has not chosen zero-touch's settings yet; nothing is held. Answer their message normally. If they ask what the choices mean, explain them in a sentence or two (Workflows: a job asked for in plain words runs as a full workflow; Hand-off: you do the development and simple writing work goes to another model; Off: nothing changes). When they want to choose, open the box with ${exactly(box)}; their choice then applies to this chat too.`;
}

/**
 * A typed /mmo: workflow as the first message after install: zero-touch steps out of that chat for good, so the typed
 * run is exactly mmo's. Nothing is saved, so the next new chat asks.
 */
export function firstWorkflowCommandLine() {
  return "Zero-touch: your command runs as you typed it. Zero-touch won't do anything in this chat; it will ask for its settings in your next new chat.";
}
export const FIRST_WORKFLOW_COMMAND_NOTE = "This message is a workflow command the person typed: carry it out exactly as usual. Zero-touch does nothing in this chat: do not open its settings box, now or later in this chat, unless the person asks to change zero-touch's settings.";

/** A command typed as the first message after install: it runs as typed; the questions come later. */
export const FIRST_COMMAND_NOTE = "This message is a command the person typed: carry it out as usual. Do not open the zero-touch settings box in this turn; zero-touch asks for its settings with the person's next message.";

/** A save that replaces settings saved in another chat a moment before. */
export function replacedLine(previous) {
  return `Zero-touch: this replaces the settings chosen in another chat a moment ago (${describe(previous)}).`;
}

/** The box was closed (seen at the next message: Claude Code tells no hook about a closed box). */
export function closedLine(settings, { first = false } = {}) {
  if (first) return `Zero-touch: nothing was saved, so zero-touch won't do anything in this chat. It will ask again in your next new chat, or type "${CHANGE}" at any time.`;
  return `Zero-touch: nothing was changed. ${stillIs(settings)}`;
}

/**
 * The choice could not be written on this computer. `code` is the system's error code; the cause is said in plain
 * words.
 */
export function saveFailedLine(code, { first = false } = {}) {
  const cause = code === "ENOSPC" ? "the disk is full"
    : ["EACCES", "EPERM", "EROFS"].includes(code) ? "zero-touch isn't allowed to write to its own settings folder"
      : "something on this computer stopped the file being written";
  const after = first ? ` Zero-touch won't do anything in this chat; it will ask again in your next new chat.` : "";
  return `Zero-touch: your choice couldn't be saved, because ${cause}, so nothing changed.${after} Once that's fixed, type "${CHANGE}" to choose again.`;
}

// ─── Notes Claude reads ──────────────────────────────────────────────────

const exactly = (box) => `the AskUserQuestion tool, passing exactly this input, word for word: ${JSON.stringify(box)}`;

/** Every chat, every mode (Off included): how the settings are opened. `box` is the mode box as it stands now. */
export function settingsNote(box) {
  return [
    "Zero-touch settings: if the person asks to change how zero-touch works (its mode, its models, which model does the writing, turning it on or off), open the zero-touch settings box with " + exactly(box) + ".",
    // Explaining is allowed: a person who asks what the choices mean deserves an answer.
    "Do not change any setting another way (no files, no commands). If the person asks what the choices mean, you may explain them in a sentence or two; the box is where they choose. If the request is not about zero-touch, do not open this box.",
    "After the person answers, follow the note that comes back.",
  ].join(" ");
}

/**
 * What Claude writes before the first box where the person may not see zero-touch's welcome (the desktop app shows it
 * only as a collapsed notice): the box alone, right after their first message, would come out of nowhere.
 */
export const WELCOME_SAY = `Welcome to zero-touch. Before I answer, please choose how it should work. You can change this at any time by typing "${CHANGE}". The guide, with what to type and what you'll see: ${GUIDE_URL}`;

/** The first chat after install: the box comes before anything else. `say`: Claude writes WELCOME_SAY first. */
export function firstRunNote(box, { say = false } = {}) {
  return [
    "Zero-touch was just installed and has no settings yet. Before you answer the person's first message or use any other tool, open the zero-touch settings box with " + exactly(box) + ".",
    "Do not describe the choices yourself: the box does. After the person answers, follow the note that comes back. If the question tool is not available to you here, carry on with the person's request instead: zero-touch will ask in a later chat.",
    // Last, so nothing follows the sentence Claude is to copy (it holds quotation marks of its own).
    ...(say ? [`The person may not see zero-touch's welcome on this screen, so in the same reply, just before you open the box, write them this one short paragraph, word for word (everything after the colon): ${WELCOME_SAY}`] : []),
  ].join(" ");
}

/**
 * What Claude is told when the person names zero-touch: what zero-touch does in THIS chat and what is
 * saved for new chats, so "is zero-touch on here? which models?" gets a true answer, never a guess. Claude never
 * reads a start message, and the desktop app does not show one, so this is the one place the facts come from.
 * `marks`: mark.mjs chatMarks (null for a chat without zero-touch); `saved`: settings.mjs readSettings.
 */
export function modeFactNote(marks, saved, { mmo = "ok" } = {}) {
  const m = marks?.marked?.mode;
  // A chat where zero-touch cannot act because of mmo: the note gives that cause, not "it was off, or had no settings
  // yet".
  const mmoWhy = mmo === "updating" ? "a plugin it needs, mmo, is an older version and zero-touch is updating it (a new chat in a minute will have it)"
    : mmo === "too-old" ? "a plugin it needs, mmo, is an older version (updating mmo in the plugins list fixes it)"
    : mmo === "off" || mmo === "missing" ? "a plugin it needs, mmo, is switched off or missing (switching it back on in the plugins list fixes it)" : null;
  const here = !m && mmoWhy ? `Zero-touch cannot act in this chat, because ${mmoWhy}.` : m === "on"
    ? `In this chat zero-touch is on, set when the chat started: ${describe(marks.settings)}. A request for one of these jobs starts a full workflow: ${JOBS}. Anything else gets a normal answer.`
    : m === "b"
      ? `In this chat zero-touch is on, set when the chat started: ${describe(marks.settings)}.`
      : m === "observe"
        ? "In this chat zero-touch only records what happens (a measuring run); it starts nothing."
        : "Zero-touch is not active in this chat: it was off, or had no settings yet, when the chat started.";
  const later = saved.state === "none"
    ? "Zero-touch has no saved settings yet."
    : saved.state === "unreadable"
      ? "Zero-touch's saved settings cannot be read, so zero-touch is off in new chats until the person chooses again."
      : saved.state === "restored"
        ? `Zero-touch's settings file cannot be read, so the last settings the person saved are used, from their next new chat: ${describe(saved.settings)}.`
        : `The saved zero-touch settings, which apply from the person's next new chat: ${describe(saved.settings)}.`;
  return `${here} ${later} If the person asks what zero-touch does here, tell them these facts in plain words.`;
}

/** After the mode answer: the next box. */
export function nextBoxNote(mode, box) {
  return `The person chose ${mode === "handoff" ? "Hand-off" : "Workflows"} in the zero-touch settings. Nothing is saved yet. Now open the next zero-touch settings box with ${exactly(box)}. Do nothing else first.`;
}

/**
 * The box for a later change in this chat, as it stands after what just happened (a save, a closed box, a refused
 * answer): the box Claude was given at the chat's start may no longer be the expected one.
 */
const laterChange = (box) => (box ? ` If the person later asks to change how zero-touch works, open the zero-touch settings box with ${exactly(box)}.` : "");

/** `switchModel`: { have, want } when the first chat is on another model than the workflow models plan with. */
export function savedNote(settings, { first = false, box = null, missing = false, replay = false, answersNow = false, switchModel = null } = {}) {
  const s = clean(settings);
  const lack = missing ? ` Something these settings need is missing on this computer; the person has been shown what, and how to fix it (for Google: they can ask "${CONNECT_GOOGLE}"). Do not tell them it is all ready.` : "";
  if (!first && s.mode === "off") return `The zero-touch settings are saved: Off. Zero-touch stops acting in this chat from the person's next message (a workflow already running here finishes first), and new chats start without it. The person has been shown a line saying so; confirm in one short sentence at most.${laterChange(box)}`;
  if (!first) return `The zero-touch settings are saved: ${describe(s)}. They apply from the person's next new chat; this chat carries on as it started. The person has already been shown a line saying so; confirm in one short sentence at most.${lack}${laterChange(box)}`;
  if (s.mode === "workflows" && !answersNow && switchModel && !missing) {
    return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now. The person's first message was not started as a workflow: this chat is on ${modelName(switchModel.have)}, and the models they chose plan and review with ${modelName(switchModel.want)} on the chat's own model, so no workflow can start here until they switch this chat to ${modelName(switchModel.want)}. Do not do their first request yourself and do not start a workflow: in one short sentence, tell them to switch this chat's model to ${modelName(switchModel.want)} with the model menu, then send their request again.${laterChange(box)}`;
  }
  if (s.mode === "workflows" && !answersNow && replay) {
    return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now.${lack} As soon as you end this turn, zero-touch judges the person's first message itself: it either starts that message's workflow, says why it cannot start, or hands the message back for you to answer. So do not do that request yourself and do not start a workflow: say one short sentence at most, then end your turn.${laterChange(box)}`;
  }
  if (s.mode === "workflows" && !answersNow && missing) {
    return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now.${lack} Do not ask them to send their request again now: their first message arrived before zero-touch had settings, and its workflow could not start until that is fixed. In one short sentence, ask whether they want help fixing it, and wait.${laterChange(box)}`;
  }
  if (s.mode === "workflows" && !answersNow) {
    return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now.${lack} The person's first message arrived before zero-touch had any settings, so zero-touch could not judge whether it is a workflow job. The person has been asked to send it again, so zero-touch can judge it: do not do that request yourself now, and say nothing more than one short sentence.${laterChange(box)}`;
  }
  return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now.${lack} Now answer the person's first message.${laterChange(box)}`;
}

/**
 * The person asked for help connecting Google (the sentence every Google line gives them, CONNECT_GOOGLE): the steps,
 * fixed, so Claude never improvises them. Claude never handles a key: the person pastes it where it belongs. `g` is
 * google.mjs googleReadiness.
 */
export function connectGoogleNote(g = {}) {
  const now = g.connected ? "This computer is already connected to Google for zero-touch; say so, and that nothing more is needed."
    : g.shellOnly?.length ? `This computer has Google settings (${g.shellOnly.join(", ")}) in the terminal's start-up files only; the Claude app does not read those, which is why zero-touch cannot use them here. The fix is to put the same settings in Claude's own settings file, as below.`
      : g.state === "broken" ? "A Google sign-in is set up on this computer but is damaged or incomplete; signing in again (way 2, step 1) replaces it, or way 1 avoids it."
        : g.state === "no-project" ? "This computer is signed in to Google Cloud, but no Google Cloud project is set for that sign-in: way 2's last step (adding GOOGLE_CLOUD_PROJECT) is the missing piece; or way 1 avoids it."
        : "This computer is not connected to Google yet.";
  return [
    `The person wants zero-touch to use Google's Flash 3.8. ${now}`,
    "If it is not connected, explain the two ways in plain words, one step at a time, and let them choose:",
    `1. A Google AI Studio key (simplest): they create a key at https://aistudio.google.com/app/apikey, then add it to Claude's own settings file, ~/.claude/settings.json, inside its "env" block, as "GEMINI_API_KEY": "<their key>". The Claude app reads keys only from that file, not from the terminal's start-up files.`,
    `2. Google Cloud (Vertex AI), for people who already use Google Cloud: in a terminal, "gcloud auth application-default login", then add their project to the same "env" block as "GOOGLE_CLOUD_PROJECT": "<project id>".`,
    "Then they start a new chat: zero-touch checks again at the start of every chat and says if anything is still missing.",
    `Never ask for, read, write or repeat a key, and never open their credential files: they paste the key into the file themselves. You may open ~/.claude/settings.json for them only to show where the "env" block goes, without any key in it.`,
  ].join("\n");
}

export function saveFailedNote(box = null) {
  return `The person's zero-touch choice could NOT be saved on this computer, so nothing changed. They have been shown a line saying why. Say in one short sentence that it was not saved; never say it was saved, and do not change any setting another way.${laterChange(box)}`;
}

export function notSavedNote(box = null) {
  return `Nothing was saved in the zero-touch settings: the answer was not one of the choices. The person has been shown a line saying so. Do not change any setting another way.${laterChange(box)}`;
}

export function closedNote({ first = false, box = null } = {}) {
  return (first
    ? "The person closed the zero-touch settings box, so nothing was saved and zero-touch does nothing in this chat. Answer their message normally."
    : "The zero-touch settings box was closed without an answer, so nothing was changed. Answer the person's message normally.") + laterChange(box);
}

/** The first chat after install, while another chat saved the settings: this chat's questions are over. */
export function savedElsewhereLine() {
  return "Zero-touch: your settings were just saved in another chat. They apply from your next new chat; this chat carries on without zero-touch.";
}
export function savedElsewhereNote(box) {
  return `The zero-touch settings were saved in another chat, so this chat's first questions are over: do not open the settings box now. This chat has no zero-touch; answer the person normally.${laterChange(box)}`;
}

/**
 * The first chat after install, where a whole turn went by and the box was never shown (Claude did not open it, or the
 * question tool is not available here): zero-touch gives up in this chat, so nothing is held for ever.
 */
export function notShownLine() {
  return `Zero-touch: its questions weren't shown in this chat, so zero-touch won't do anything here. It will ask again in your next new chat, or type "${CHANGE}" at any time.`;
}
export function notShownNote(box) {
  return `The zero-touch settings box was not shown, so zero-touch does nothing in this chat and nothing is blocked any more. Answer the person normally.${laterChange(box)}`;
}

export const HELPER_BOX_REASON = "The zero-touch settings belong to the main chat, so a helper does not open them. Carry on with your task.";
/**
 * What the person reads with a refusal (a refusal's reason is shown to them; the model's instruction goes
 * separately).
 */
export const HELPER_BOX_PERSON = "Zero-touch: the settings are chosen in the main chat, so the helper carries on with its task.";
export const HOLD_PERSON = "Zero-touch: Claude asks for your settings first.";

export function holdReason(box) {
  return `Zero-touch has no settings yet: open the zero-touch settings box first, with ${exactly(box)}. If the question tool is not available to you here, carry on with the person's request instead: this is the only time a tool is held for it.`;
}

/**
 * The hand-off rules, built from who types each kind of work: work kept in the chat is Claude's own; the rest goes to
 * the hand-off tools of the mmo plugin (tools/test/zero-touch-handoff-tools.test.mjs proves they exist).
 */
export function rulesNote(stamp, { google = true } = {}) {
  // A kind set to Flash 3.8 on a computer not connected to Google is Claude's own work: its tool
  // would only be refused.
  const t = (k) => { const typist = stamp.typists?.[k]?.typist ?? "chat"; return !google && TYPISTS[typist]?.usesFlash ? "chat" : typist; };
  const handed = [];
  if (t("documents") !== "chat") handed.push("- A NEW document (a README, a guide, an API reference, a changelog), a NEW spec (requirements, a design document, an API spec, a data-model write-up) or NEW planning text (a plan, a task breakdown or tickets, a status report, release notes): the write_document tool.");
  if (t("tests") !== "chat") handed.push("- NEW tests for code that exists: decide the cases yourself, then the write_tests_from_cases tool.");
  if (t("repeats") !== "chat") handed.push("- The same change in several files: make it yourself in ONE file, then the repeat_edit_across_files tool for the others.");
  const kept = KINDS.filter((k) => t(k) === "chat").map((k) => KIND_WORDS[k]);
  const lines = [
    "This chat is in zero-touch hand-off mode. You do the development yourself: reading, deciding, new code, bug fixes, refactors, reviews and answers.",
  ];
  if (handed.length) {
    lines.push(
      "These kinds of work are handed to another model through this plugin's hand-off tools, which check the result before anything reaches the project:",
      ...handed,
      "How to hand off: read what the tool's form needs, fill in every field with exact facts from the project (real paths, commands, names and values), and make one call. The form is a brief, never the finished text. The tool refuses a form with an empty field or a fact that is not in the project, and says what to fix. When it returns, read what it wrote before you tell the person it is done.",
      "Creating such a file yourself, with the Write tool or a shell command, is refused; a change to a file that exists is yours to make.",
      "When a tool reports that the hand-off failed or cannot run, do that piece yourself and say so in one line. When tests handed off do not pass, read the output the tool returns: correct a wrong case and hand off again; a real bug in the code under test you tell the person, and you never change a test to hide it.",
      "Every hand-off that changed the project has an id on its receipt; the undo_hand_off tool takes one back.",
    );
  }
  if (kept.length) lines.push(`The person chose to keep this work in the chat, so you do it yourself, with your own tools: ${kept.join("; ")}.`);
  lines.push("No full workflow starts from the person's plain words in this chat: do the work yourself.");
  return lines.join("\n");
}

/** A model's name as a person reads it. */
export function modelName(id) {
  if (!id) return "the chat's model";
  if (CHAT_MODELS[id]) return CHAT_MODELS[id].name;
  const m = /^claude-([a-z]+)-(\d+(?:[.-]\d+)?)/.exec(String(id));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace("-", ".")}` : String(id);
}
