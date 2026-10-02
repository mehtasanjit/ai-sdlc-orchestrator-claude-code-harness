/**
 * The mode zero-touch's saved settings put in force for new chats.
 *
 * Why: a chat keeps the mode it started with, so choosing other models or another mode reaches new chats only. Off is
 * different: a person who chooses Off wants zero-touch out of the way now, also in a chat they reopen (the desktop
 * sidebar, `claude --continue`, `/resume`), which would otherwise keep starting workflows, holding tools and locking
 * the model. So Off reaches every open and reopened chat at its next message (hook.mjs main). Disabling or
 * uninstalling the zero-touch plugin needs nothing here: its hooks, which run this code, are then not run at all.
 *
 * The settings file is zero-touch's own (zero-touch/scripts/settings.mjs): `<its data folder>/settings.json`, where
 * the data folder is the plugin's ${CLAUDE_PLUGIN_DATA} (these hooks run from zero-touch's hook list, so it is set to
 * zero-touch's), else `<MMO_HOME>/zero-touch`. The rule for a file that cannot be used is zero-touch's fail-safe
 * rule, the same as the model server's listing (plugin/mcp/model-dispatch/src/handoff/listing.ts savedMode): its last
 * good save decides, and with none zero-touch is Off. tools/test/zero-touch-off-now.test.mjs keeps the two agreeing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mmoHome } from "./paths.mjs";

/** Zero-touch's data folder, as zero-touch/scripts/settings.mjs dataDir names it. */
export function ztDataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.trim() ? env.CLAUDE_PLUGIN_DATA : join(mmoHome(env), "zero-touch");
}

/**
 * The choices the settings box offers (zero-touch/scripts/settings.mjs MODES, WORKFLOW_MODELS, CHAT_MODELS, TYPISTS,
 * KINDS), copied: a file holding any other value is not used, as zero-touch's own reader does, so the two never
 * disagree about the same chat. tools/test/zero-touch-off-now.test.mjs keeps the lists equal.
 */
/**
 * The names the person saw for each workflow choice in zero-touch's box (zero-touch/scripts/settings.mjs
 * WORKFLOW_MODELS labels; tools/test/zero-touch-off-now.test.mjs keeps the two equal). Used to say why a chat must be
 * on a model: "you chose Opus 5 + Flash 3.8, where Opus 5 plans and reviews".
 */
export const WORKFLOW_LABELS = {
  "opus-plus-flash-v38": "Opus 5 + Flash 3.8",
  "fable51-plus-flash-v38": "Fable 5.1 + Flash 3.8",
  "opus-plus-sonnet": "Opus 5 + Sonnet 5",
  "opus-only-v5": "Opus 5 only",
};

export const CHOICES = {
  modes: ["handoff", "workflows", "off"],
  workflowModels: ["opus-plus-flash-v38", "fable51-plus-flash-v38", "opus-plus-sonnet", "opus-only-v5"],
  chatModels: ["claude-opus-5", "claude-sonnet-5"],
  typists: ["flash", "sonnet", "chat"],
  kinds: ["documents", "tests", "repeats"],
};
const MAX_BYTES = 16 * 1024;
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const choice = (v, list) => typeof v === "string" && list.includes(v);

/** Whether a parsed settings file holds only values the box offers (zero-touch's settings.mjs invalidValues). */
export function onlyChoices(raw) {
  if (!isObject(raw) || !choice(raw.mode, CHOICES.modes)) return false;
  if (raw.workflows !== undefined && (!isObject(raw.workflows) || (raw.workflows.models !== undefined && !choice(raw.workflows.models, CHOICES.workflowModels)))) return false;
  if (raw.handoff !== undefined) {
    if (!isObject(raw.handoff)) return false;
    if (raw.handoff.chat_model !== undefined && !choice(raw.handoff.chat_model, CHOICES.chatModels)) return false;
    for (const k of CHOICES.kinds) if (raw.handoff[k] !== undefined && !choice(raw.handoff[k], CHOICES.typists)) return false;
  }
  return true;
}

/** The mode a settings file names: a known one, "none" (no file) or "unreadable" (anything else). */
export function savedMode(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { return e?.code === "ENOENT" ? "none" : "unreadable"; }
  if (text.length > MAX_BYTES) return "unreadable";
  let saved;
  try { saved = JSON.parse(text); } catch { return "unreadable"; }
  return onlyChoices(saved) ? saved.mode : "unreadable";
}

/** The mode in force for new chats: "handoff", "workflows", "off", or "none" (nothing chosen yet). */
export function modeInForce(env = process.env) {
  const dir = ztDataDir(env);
  const mode = savedMode(join(dir, "settings.json"));
  if (mode !== "unreadable") return mode;
  const last = savedMode(join(dir, "settings.last-good.json"));
  return last === "handoff" || last === "workflows" || last === "off" ? last : "off";
}
