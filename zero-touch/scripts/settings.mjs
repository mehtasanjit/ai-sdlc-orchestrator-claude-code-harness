/**
 * The person's zero-touch settings: what they chose in the settings box, kept by the zero-touch plugin itself.
 *
 * Why here, and why this shape:
 *   - A person never edits a file or types a command to set zero-touch up. They choose in Claude's own question box
 *     in the chat (scripts/boxes.mjs), which is the one picker the desktop app shows for a plugin; Claude Code's plugin
 *     settings form exists only in the terminal, and an MCP server's pop-up form is declined by the desktop app.
 *   - The choices live in this plugin's own data folder (${CLAUDE_PLUGIN_DATA}, `~/.claude/plugins/data/<id>/`),
 *     which Claude Code keeps across updates and deletes when the plugin is removed. So removing zero-touch forgets
 *     them, and installing it again asks again. Without that variable (a developer running the script by hand) the
 *     folder is `<MMO_HOME>/zero-touch/`.
 *   - Only the fixed choices of the box are ever stored. Fail safe: a file that cannot be read, or holds any value
 *     that is not one of the choices (a damaged file, or one edited by hand to "OFF"), is not used at all, so it never
 *     switches a person who chose Off to paid workflows. The last good save is used instead
 *     (`settings.last-good.json`, written beside it at every save), and when there is none zero-touch is off in new
 *     chats until the person chooses again; either way the person is told.
 *   - Written atomically (a temporary file, then a rename), so two chats saving at the same moment leave one whole
 *     file: the later save wins, and each chat's saved line says exactly what that chat saved.
 *
 * The file: { version: 1, mode, workflows: { models }, handoff: { chat_model, documents, tests, repeats }, saved_at }
 *   mode                 "workflows" | "handoff" | "off"
 *   workflows.models     the shipped policy the workflows run on (four of them are offered)
 *   handoff.chat_model   the model a hand-off chat is kept on
 *   handoff.<kind>       who types that kind of hand-off work: "flash" | "sonnet" | "chat" (kept in the chat)
 *
 * Self-contained on purpose: Claude Code copies each plugin on its own at install, so this plugin carries no code
 * of mmo's (see start-chat.mjs).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The three modes, as stored, and as the box names them. */
export const MODES = {
  workflows: { label: "Workflows", name: "Workflows mode" },
  handoff: { label: "Hand-off", name: "Hand-off mode" },
  off: { label: "Off", name: "Off" },
};

/**
 * The models a workflow can run on: four shipped policies. Each one passes the workflows' run-start check and routes
 * every step of all eight jobs to a current model: planning and review on Opus 5 (or Fable 5.1), and the writing on
 * Flash 3.8, Sonnet 5 or Opus 5. Four is the most Claude Code's question box shows. `plans` is the model each plans
 * and reviews with: the workflow's helpers follow the chat's model, as mmo does without zero-touch (zero-touch as a
 * strict add-on), so the chat must be on it (tools/test/zero-touch-chat-model.test.mjs checks it against the
 * workflows' own router).
 */
export const WORKFLOW_MODELS = {
  "opus-plus-flash-v38": { label: "Opus 5 + Flash 3.8", says: "Opus 5 plans and reviews; Google's Flash 3.8 writes the code", usesFlash: true, plans: "claude-opus-5" },
  "fable51-plus-flash-v38": { label: "Fable 5.1 + Flash 3.8", says: "Fable 5.1 plans and reviews; Google's Flash 3.8 writes the code", usesFlash: true, plans: "claude-fable-5-1" },
  "opus-plus-sonnet": { label: "Opus 5 + Sonnet 5", says: "Opus 5 plans and reviews; Sonnet 5 writes the code", usesFlash: false, plans: "claude-opus-5" },
  "opus-only-v5": { label: "Opus 5 only", says: "Opus 5 does everything", usesFlash: false, plans: "claude-opus-5" },
};

/** The models a hand-off chat can be kept on. */
export const CHAT_MODELS = {
  "claude-opus-5": { label: "Opus 5 (Recommended)", name: "Opus 5" },
  "claude-sonnet-5": { label: "Sonnet 5", name: "Sonnet 5" },
};

/**
 * Who types a kind of hand-off work. `policy` is the shipped policy whose stage for that kind routes to this typist
 * (the hand-off tools read the model from there, through the same router the workflows use); "chat" hands nothing off.
 */
export const TYPISTS = {
  flash: { label: "Flash 3.8", name: "Flash 3.8", policy: "opus-plus-flash-v38", usesFlash: true },
  sonnet: { label: "Sonnet 5", name: "Sonnet 5", policy: "opus-plus-sonnet", usesFlash: false },
  chat: { label: "Keep in chat", name: "kept in the chat", policy: null, usesFlash: false },
};

/** The three kinds of hand-off work a person chooses a typist for, in the box's order. */
export const KINDS = ["documents", "tests", "repeats"];

/** The standard settings: what the box offers first, and the values a saved file may leave out. */
export const DEFAULTS = Object.freeze({
  mode: "workflows",
  workflows: Object.freeze({ models: "opus-plus-flash-v38" }),
  handoff: Object.freeze({ chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" }),
});

const FILE = "settings.json";
const LAST_GOOD = "settings.last-good.json";
const MAX_BYTES = 16 * 1024;

/** The zero-touch home folder (the same rule as mmo's lib/paths.mjs). */
export function mmoHome(env = process.env) {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/** This plugin's own data folder, where the settings live. */
export function dataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.trim() ? env.CLAUDE_PLUGIN_DATA : join(mmoHome(env), "zero-touch");
}

export function settingsFile(env = process.env) {
  return join(dataDir(env), FILE);
}

const pick = (value, allowed, fallback) => (typeof value === "string" && Object.hasOwn(allowed, value) ? value : fallback);

/** A settings object with every value one of the fixed choices; a value left out (or not a choice) takes the standard one. */
export function clean(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const w = r.workflows && typeof r.workflows === "object" ? r.workflows : {};
  const h = r.handoff && typeof r.handoff === "object" ? r.handoff : {};
  return {
    mode: pick(r.mode, MODES, DEFAULTS.mode),
    workflows: { models: pick(w.models, WORKFLOW_MODELS, DEFAULTS.workflows.models) },
    handoff: {
      chat_model: pick(h.chat_model, CHAT_MODELS, DEFAULTS.handoff.chat_model),
      documents: pick(h.documents, TYPISTS, DEFAULTS.handoff.documents),
      tests: pick(h.tests, TYPISTS, DEFAULTS.handoff.tests),
      repeats: pick(h.repeats, TYPISTS, DEFAULTS.handoff.repeats),
    },
  };
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isChoice = (value, allowed) => typeof value === "string" && Object.hasOwn(allowed, value);

/**
 * The values a saved file holds that are not one of the box's choices: the mode is required; any other value may be
 * left out (it then takes the standard one), but when it is there it must be a choice. Empty: the file is good.
 */
export function invalidValues(raw) {
  const bad = [];
  if (!isChoice(raw.mode, MODES)) bad.push("mode");
  if (raw.workflows !== undefined) {
    if (!isObject(raw.workflows)) bad.push("workflows");
    else if (raw.workflows.models !== undefined && !isChoice(raw.workflows.models, WORKFLOW_MODELS)) bad.push("workflows.models");
  }
  if (raw.handoff !== undefined) {
    if (!isObject(raw.handoff)) bad.push("handoff");
    else {
      if (raw.handoff.chat_model !== undefined && !isChoice(raw.handoff.chat_model, CHAT_MODELS)) bad.push("handoff.chat_model");
      for (const k of KINDS) if (raw.handoff[k] !== undefined && !isChoice(raw.handoff[k], TYPISTS)) bad.push(`handoff.${k}`);
    }
  }
  return bad;
}

/** One settings file: { state: "none" | "ok" | "unreadable", settings?, save? }. */
function readFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { return { state: err?.code === "ENOENT" ? "none" : "unreadable" }; }
  if (text.length > MAX_BYTES) return { state: "unreadable" };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { state: "unreadable" }; }
  if (!isObject(parsed) || invalidValues(parsed).length) return { state: "unreadable" };
  const settings = clean(parsed);
  return { state: "ok", settings, save: `${typeof parsed.saved_at === "string" ? parsed.saved_at : ""}|${JSON.stringify(settings)}` };
}

/**
 * The person's settings: { state, settings, save }.
 *   state "none"        nothing saved yet: the first chat after install asks (settings are the standard ones)
 *   state "ok"          saved and read
 *   state "restored"    the file cannot be read, or holds a value that is not a choice, and the last good save is
 *                       used instead; the person is told in every chat until they choose again
 *   state "unreadable"  the same, and there is no last good save: zero-touch is OFF in new chats (`settings` are the
 *                       standard ones only so callers have a whole object; nothing may act on them), and the person is
 *                       told
 * `save` names this save ("" unless the state is "ok"): its time and what it holds, so a file without a time (written
 * by hand, or by a test) still tells one save from another. The start message shows a save's summary once
 * (summaryShown below).
 */
export function readSettings(env = process.env) {
  const main = readFile(settingsFile(env));
  if (main.state === "ok") return main;
  if (main.state === "none") return { state: "none", settings: clean(DEFAULTS), save: "" };
  const last = readFile(join(dataDir(env), LAST_GOOD));
  if (last.state === "ok") return { state: "restored", settings: last.settings, save: "" };
  return { state: "unreadable", settings: clean(DEFAULTS), save: "" };
}

/** The settings in force for new chats, or null when there are none to act on (nothing saved, or unreadable). */
export function settingsInForce(r) {
  return r.state === "ok" || r.state === "restored" ? r.settings : null;
}

/**
 * Whether the summary of a save (what the mode does, the models) has been shown in some chat already (quiet by
 * default). The saved line says what was chosen; the first new chat after that shows the summary once; later
 * chats show only what the person must act on (Google not connected, a wrong chat model, settings that cannot be
 * read). The record holds one save's stamp, in this plugin's data folder; a record that cannot be read or written
 * only means the summary shows once more.
 */
const SUMMARY_SHOWN = "summary-shown.json";
export function summaryShown(save, env = process.env) {
  try { return JSON.parse(readFileSync(join(dataDir(env), SUMMARY_SHOWN), "utf8"))?.save === String(save ?? ""); } catch { return false; }
}
export function markSummaryShown(save, env = process.env) {
  try {
    const dir = dataDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, SUMMARY_SHOWN), JSON.stringify({ save: String(save ?? "") }) + "\n", { mode: 0o600 });
  } catch { /* shown once more next time: harmless */ }
}

/**
 * Saves the settings whole, atomically, then the same as the last good save (best effort: a failure there keeps the
 * previous last good copy). Returns what was saved; throws when the settings themselves could not be saved, and then
 * nothing has changed (a temporary file is removed).
 */
export function writeSettings(settings, env = process.env) {
  const saved = { version: 1, ...clean(settings), saved_at: new Date().toISOString() };
  const dir = dataDir(env);
  const text = JSON.stringify(saved, null, 2) + "\n";
  const put = (name) => {
    const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, join(dir, name));
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  put(FILE);
  try { put(LAST_GOOD); } catch { /* the previous last good copy stays */ }
  return saved;
}

/** Whether these settings need Google (Flash 3.8) anywhere. */
export function needsGoogle(settings) {
  const s = clean(settings);
  if (s.mode === "workflows") return WORKFLOW_MODELS[s.workflows.models].usesFlash;
  if (s.mode === "handoff") return KINDS.some((k) => TYPISTS[s.handoff[k]].usesFlash);
  return false;
}

/**
 * The settings in one plain sentence, for the saved line and the start message:
 * "Workflows mode, Opus 5 + Flash 3.8" / "Hand-off mode on Opus 5; documents go to Flash 3.8, tests to Sonnet 5,
 * repeated changes stay in the chat" / "Off".
 */
/** An organisation's model as a person reads it: a known id by its name, anything else as written. */
function orgModelName(id) {
  const known = CHAT_MODELS[String(id).replace(/\[[^\]]*\]$/, "").trim()];
  return known ? known.name : String(id);
}

/**
 * The settings a settings box marks as the current choice: the ones in force (the saved file's, or the last good save
 * when the file cannot be used), or null when nothing is saved or nothing can be read (nothing is marked then). Every
 * box and every note that gives a box uses this one rule, so the box a note gives Claude is the box the hook then
 * expects.
 */
export function boxCurrent(env = process.env) {
  return settingsInForce(readSettings(env));
}

export function describe(settings, { orgModel = null } = {}) {
  const s = clean(settings);
  if (s.mode === "off") return "Off";
  if (s.mode === "workflows") return `Workflows mode, ${WORKFLOW_MODELS[s.workflows.models].label}`;
  const word = { documents: "documents", tests: "tests", repeats: "repeated changes" };
  // "documents go to Flash 3.8, tests to Sonnet 5, repeated changes stay in the chat": the verb once, as a person says it.
  const parts = KINDS.map((k, i) => {
    const t = s.handoff[k];
    return t === "chat" ? `${word[k]} stay in the chat` : `${word[k]} ${i === 0 ? "go " : ""}to ${TYPISTS[t].name}`;
  });
  // An organisation's pinned model holds a Hand-off chat whatever the person chose (mark.mjs handoffStamp), so a line
  // that says which model a chat runs on names that one.
  const chat = orgModel ? `${orgModelName(orgModel)} (the model your organisation set)` : CHAT_MODELS[s.handoff.chat_model].name;
  return `Hand-off mode on ${chat}; ${parts.join(", ")}`;
}
