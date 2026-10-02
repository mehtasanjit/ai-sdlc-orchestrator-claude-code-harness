/**
 * Marking a chat with its zero-touch mode and models, from the person's settings. Used at a chat's start
 * (start-chat.mjs) and in the first chat after install, the moment its settings are saved (settings-hook.mjs).
 *
 * A chat is marked once and keeps its marks for its whole life (a compaction or a reopened chat keeps them; /clear
 * starts a new chat id, so a cleared conversation is marked afresh). Settings saved later reach new chats only. So a
 * chat's start message, its model guard and its hand-offs can never disagree, and one chat's costs never split across
 * two sets of models.
 *
 * What the mmo plugin (which holds all of zero-touch's code) reads:
 *   chat_mode       "on" = Workflows, "b" = Hand-off; no file = zero-touch does nothing in the chat
 *   workflow.json   { policy }: the shipped policy every workflow zero-touch starts in this chat runs on. A project's
 *                   own routing-policy.yaml and its saved choice in .sdlc/project.json are NOT used by zero-touch;
 *                   commands a person types still follow them.
 *   handoff.json    { chat_model, pin, admin_model, typists: { documents|tests|repeats: { typist, policy } }, policy }
 *                   typist is "flash", "sonnet" or "chat" (kept in the chat, policy null). `policy` is the first
 *                   handed-off kind's policy, for a reader that takes one policy for every kind.
 * An organisation's pinned model (managed settings `model`) outranks the person's chat model.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, chatDir, drop, readJson, readText, writeJson, writeText } from "./chat-files.mjs";
import { DEFAULTS, KINDS, TYPISTS, clean, dataDir } from "./settings.mjs";

/** An exact model id, as a chat's pin must be (an alias follows whichever model is newest). */
const MODEL_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._:@/-]{2,100}$/;

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
export function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/** Where an organisation's settings live on this machine; MMO_MANAGED_SETTINGS names another file for tests. */
export function managedSettingsFile(env = process.env) {
  if (env.MMO_MANAGED_SETTINGS && env.MMO_MANAGED_SETTINGS.trim()) return env.MMO_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** The model an organisation's managed settings pin every chat to, or null when there is none. */
export function organisationModel(env = process.env) {
  const admin = readJson(managedSettingsFile(env))?.model;
  return typeof admin === "string" && admin.trim() ? admin.trim() : null;
}

/** A Hand-off chat's stamp from the settings (and the organisation's pinned model, when there is one). */
export function handoffStamp(settings, env = process.env) {
  const h = clean(settings).handoff;
  let chat_model = h.chat_model;
  let pin = "setting";
  let admin_model = null;
  const admin = organisationModel(env);
  if (admin) {
    pin = "admin";
    admin_model = admin;
    // Written as an alias it cannot be compared with the model a chat is on, so nothing is pinned: the
    // organisation's own setting holds the chat.
    chat_model = MODEL_ID.test(canonicalModel(admin_model)) ? canonicalModel(admin_model) : null;
  }
  const typists = {};
  for (const k of KINDS) typists[k] = { typist: h[k], policy: TYPISTS[h[k]].policy };
  const first = KINDS.map((k) => typists[k].policy).find(Boolean) ?? DEFAULTS.workflows.models;
  return { chat_model, pin, admin_model, typists, policy: first, policy_file: null };
}

/**
 * Marks the chat from the settings. Returns what was written: { mode: "on"|"b"|"off", policy?, stamp? }.
 * The record is written last, so whatever reads the record finds the chat's models already there.
 */
export function markChat(sid, settings, { model = null, env = process.env } = {}) {
  const s = clean(settings);
  for (const f of [FILES.workflow, FILES.handoff, FILES.models, FILES.modelNow, FILES.off]) drop(sid, f, env);
  if (s.mode === "off") {
    // An Off chat leaves nothing behind: no record, no folder. Nothing reads one: the mmo plugin acts only
    // in a chat with a mode record, and nothing is shown again for an Off chat.
    drop(sid, FILES.mode, env);
    return { mode: "off" };
  }
  if (s.mode === "workflows") {
    writeJson(sid, FILES.workflow, { policy: s.workflows.models }, env);
    // The chat's model, when Claude Code said it: a workflow's helpers follow the chat's model, so the mmo plugin
    // checks it before it starts one (plugin/scripts/ambient/lib/route-flow.mjs startProblem).
    if (model) writeText(sid, FILES.modelNow, canonicalModel(model), env);
    writeText(sid, FILES.mode, "on", env);
    return { mode: "on", policy: s.workflows.models };
  }
  const stamp = handoffStamp(s, env);
  writeJson(sid, FILES.handoff, stamp, env);
  if (model) writeText(sid, FILES.modelNow, canonicalModel(model), env);
  writeText(sid, FILES.mode, "b", env);
  return { mode: "b", stamp };
}

/**
 * A chat's marks, read back (never from the settings file: a chat keeps what it started with): { marked, settings },
 * or null for a chat without zero-touch (Off, or started before any settings). A record without its models reads as
 * the standard ones. Used after a compaction (the hand-off rules are given again) and
 * when the person names zero-touch (settings-hook.mjs: Claude is told what zero-touch does in this chat).
 */
export function chatMarks(sid, env = process.env) {
  const dir = chatDir(sid, env);
  const mode = readText(join(dir, FILES.mode));
  if (mode === "on") {
    const policy = readJson(join(dir, FILES.workflow))?.policy;
    const s = clean({ mode: "workflows", workflows: { models: policy } });
    return { marked: { mode: "on", policy: s.workflows.models }, settings: s };
  }
  if (mode === "b") {
    const stamp = readJson(join(dir, FILES.handoff));
    const full = stamp?.typists ? stamp : { ...(stamp ?? {}), ...oldStampTypists(stamp), ...(stamp?.pin ? { pin: stamp.pin, admin_model: stamp.admin_model ?? null, chat_model: stamp.chat_model ?? null } : {}) };
    const h = full.typists;
    const s = clean({ mode: "handoff", handoff: { chat_model: full.chat_model, documents: h.documents?.typist, tests: h.tests?.typist, repeats: h.repeats?.typist } });
    return { marked: { mode: "b", stamp: full }, settings: s };
  }
  if (mode === "observe") return { marked: { mode: "observe" }, settings: clean(DEFAULTS) };
  return null;
}

/**
 * A Hand-off stamp's typists for a record that names one policy for every kind of work:
 * Sonnet types when that policy is the Sonnet one, Flash otherwise (the shipped hand-off default).
 */
function oldStampTypists(stamp) {
  const typist = stamp?.policy === "opus-plus-sonnet" ? "sonnet" : "flash";
  const typists = {};
  for (const k of KINDS) typists[k] = { typist, policy: typist === "sonnet" ? "opus-plus-sonnet" : "opus-plus-flash-v38" };
  return { chat_model: clean({ mode: "handoff", handoff: { chat_model: stamp?.chat_model } }).handoff.chat_model, pin: "setting", admin_model: null, typists };
}

/** Removes every zero-touch mark from a chat (it has no zero-touch). */
export function unmarkChat(sid, env = process.env) {
  for (const f of [FILES.mode, FILES.workflow, FILES.handoff, FILES.models, FILES.modelNow, FILES.off]) drop(sid, f, env);
}

// ─── Facts the start message needs ───────────────────────────────────────

/** Whether the project folder has its own model rules file (zero-touch does not follow it; the start message says so). */
export function hasFolderPolicy(projectDir) {
  return typeof projectDir === "string" && projectDir !== "" && existsSync(join(projectDir, "routing-policy.yaml"));
}

/**
 * Whether Claude Code can show a question box in this run: false for a run with no screen (`claude -p` is labelled
 * "sdk-cli", the Agent SDK "sdk-ts" / "sdk-py"). Such a run gets no
 * first-chat questions and no hold. A run started from inside another Claude chat inherits that chat's label.
 */
export function canAsk(env = process.env) {
  return !["sdk-cli", "sdk-ts", "sdk-py"].includes(String(env.CLAUDE_CODE_ENTRYPOINT ?? ""));
}

/**
 * A run with no person at a screen: a script's or the Agent SDK's run (sdk-cli, sdk-ts, sdk-py), or a run Claude
 * Code itself marks unattended (CLAUDE_CODE_SESSION_ATTENDED "0", which it gives every hook: a `claude -p` started
 * from inside a chat, which keeps the chat's label, and background sessions). Zero-touch leaves such a run exactly as
 * Claude Code alone would, so a scripted `claude -p "fix ..."` never becomes a workflow waiting at approval steps
 * nobody could answer.
 */
export function noScreen(env = process.env) {
  return !canAsk(env) || String(env.CLAUDE_CODE_SESSION_ATTENDED ?? "") === "0";
}

/**
 * Whether the person sees a start hook's message in this run: the terminal ("cli") shows it at the top of the chat;
 * the desktop app ("claude-desktop") shows nothing of it, while a message hook's line does show there (collapsed, as
 * a "Claude Code notice"). So everywhere but the terminal, the start lines wait for the chat's first message
 * (chat-files.mjs zt_say.json). A label this code does not know waits too: the message hook's line shows on every
 * screen known. A run with no screen keeps them at the start (no one reads either), and so does a run with no label
 * at all (the terminal before it set one).
 */
export function startMessageShown(env = process.env) {
  const label = String(env.CLAUDE_CODE_ENTRYPOINT ?? "").trim();
  return label === "" || label === "cli" || !canAsk(env);
}

/** The oldest Node.js zero-touch runs on: the mmo plugin's own floor (its package.json "engines"). */
export const MIN_NODE = 20;
/** Whether a Node.js version ("18.19.0") is older than zero-touch needs. Anything unreadable counts as too old. */
export function nodeTooOld(version) {
  const major = Number(String(version ?? "").replace(/^v/, "").split(".")[0]);
  return !(Number.isInteger(major) && major >= MIN_NODE);
}

/**
 * A backstop, never an alarm: true only when Claude Code's own records say the mmo plugin (which holds all of
 * zero-touch's code) is switched off, or is installed at a folder that no longer exists. Claude Code refuses to switch
 * mmo off while zero-touch needs it in the terminal, and switches zero-touch off at the next load when it is off
 * anyway; this catches what gets past both (the desktop app's switch, a hand-edited settings file, a broken install).
 * Anything it cannot read, or a setup that does not list mmo at all (a developer's --plugin-dir), counts as fine.
 */
/** This plugin's own folder (zero-touch/), wherever it is installed. */
const ZT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The folder of the installed mmo plugin whose hook script runs zero-touch's workflow and hand-off hooks (they
 * are registered in zero-touch's own hook list and run through hooks/mmo-hook.sh), from Claude Code's record of
 * installed plugins: an mmo from the same marketplace as this zero-touch first, then any, and only a folder that holds
 * mmo's hook script. Null when there is none, or the record cannot be read (the shell script then looks beside this
 * plugin, and in this repository's own layout).
 */
export function mmoRoot(env = process.env, ztRoot = ZT_ROOT) {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"))?.plugins;
  if (!installed || typeof installed !== "object") return null;
  const entries = (key) => (Array.isArray(installed[key]) ? installed[key] : []);
  const own = Object.keys(installed).find((key) => /^zero-touch@/.test(key) && entries(key).some((e) => typeof e?.installPath === "string" && realOr(e.installPath) === realOr(ztRoot)));
  const market = own ? own.slice("zero-touch@".length) : null;
  const keys = Object.keys(installed).filter((key) => /^mmo@/.test(key)).sort((a, b) => Number(b === `mmo@${market}`) - Number(a === `mmo@${market}`));
  for (const key of keys) {
    for (const e of entries(key)) {
      // With zero-touch's hooks (api.json), as hooks/mmo-hook.sh checks too: an mmo without them is never kept as
      // the one to run.
      if (typeof e?.installPath === "string" && existsSync(join(e.installPath, "hooks", "ambient.sh")) && carriesZeroTouch(e.installPath)) return e.installPath;
    }
  }
  return null;
}

/** Whether an mmo folder carries zero-touch's hooks: scripts/ambient/api.json with "zero_touch_api" 1 or more. */
function carriesZeroTouch(root) {
  const v = readJson(join(root, "scripts", "ambient", "api.json"))?.zero_touch_api;
  return Number.isFinite(v) && v >= 1;
}

/** Keeps mmoRoot's answer in this plugin's data folder for hooks/mmo-hook.sh, written only when it changed. */
export function rememberMmoRoot(env = process.env, ztRoot = ZT_ROOT) {
  const root = mmoRoot(env, ztRoot);
  const file = join(dataDir(env), "mmo-root");
  let kept = null;
  try { kept = readFileSync(file, "utf8").trim(); } catch { /* none yet */ }
  if (!root || root === kept || /[\n\r]/.test(root)) return root;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${root}\n`, { mode: 0o600 });
  return root;
}

/**
 * The version of the mmo plugin's zero-touch hooks this plugin needs: mmo ships it in scripts/ambient/api.json. An
 * older mmo (one without zero-touch's code) is "too-old": zero-touch then marks no chat and says so, instead of
 * promising modes that would do nothing.
 */
export const MMO_API_NEEDED = 1;

/** Whether a plugin is switched on in this project: the first settings file that names it decides (managed, then the
 * project's local file, then the project's, then the user's; the model server's handoff/listing.ts uses the same
 * order); none names it → on. Returns true, false, or null when none names it. */
function switchedOn(id, layers) {
  for (const layer of layers) {
    const v = layer && typeof layer === "object" ? layer.enabledPlugins?.[id] : undefined;
    if (typeof v === "boolean") return v;
  }
  return null;
}

/**
 * The mmo plugin, as Claude Code's own records say: "ok", "off" (switched off at the
 * scope that decides for this project), "missing" (installed at a folder that no longer exists), or "too-old" (its
 * zero-touch hooks are older than this plugin needs). A backstop, never an alarm: anything it cannot read, or a setup
 * that does not list mmo at all (a developer's --plugin-dir), counts as "ok", and one mmo that is on and current is
 * enough (an old entry from another marketplace, switched off, is not an alarm).
 */
export function mmoState(env = process.env, projectDir = env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  const layers = [
    readJson(managedSettingsFile(env)),
    readJson(join(projectDir, ".claude", "settings.local.json")),
    readJson(join(projectDir, ".claude", "settings.json")),
    readJson(join(configDir, "settings.json")),
  ];
  const named = new Set(layers.flatMap((l) => (l && typeof l === "object" && l.enabledPlugins && typeof l.enabledPlugins === "object" ? Object.keys(l.enabledPlugins) : [])).values());
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"))?.plugins;
  const ids = new Set([...named, ...(installed && typeof installed === "object" ? Object.keys(installed) : [])].filter((id) => /^mmo@/.test(id)));
  if (!ids.size) return "ok";
  const onIds = [...ids].filter((id) => switchedOn(id, layers) !== false);
  if (!onIds.length) return "off";
  if (!installed || typeof installed !== "object") return "ok";
  const paths = onIds.flatMap((id) => (Array.isArray(installed[id]) ? installed[id] : []).map((e) => e?.installPath).filter((p) => typeof p === "string" && p));
  if (!paths.length) return "ok";
  const present = paths.filter((p) => existsSync(p));
  if (!present.length) return "missing";
  const api = (p) => { const v = readJson(join(p, "scripts", "ambient", "api.json"))?.zero_touch_api; return Number.isFinite(v) ? v : 0; };
  return present.some((p) => api(p) >= MMO_API_NEEDED) ? "ok" : "too-old";
}

/** Kept for its callers: true when mmo is off or missing (mmoState). */
export function mmoMissing(env = process.env, projectDir) {
  const state = mmoState(env, projectDir);
  return state === "off" || state === "missing";
}
