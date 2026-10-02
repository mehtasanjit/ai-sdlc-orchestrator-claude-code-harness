/**
 * Whether this server lists zero-touch's four hand-off tools.
 *
 * Why: Claude Code gives the model every tool a server lists, in every chat, with every message, and the four
 * hand-off tools' descriptions are about 1,600 tokens. They are usable only in a zero-touch Hand-off chat, but Claude
 * Code does not tell a server which chat it serves (only the project folder), so listing them always would put them in
 * every chat where the mmo plugin is on, also for people who never installed zero-touch.
 *
 * The rule, read when the server starts:
 *   - MMO_HANDOFF_TOOLS=on|off decides outright (tests, a developer's run);
 *   - zero-touch not installed → not listed: a hand-off chat cannot exist without it. An install for one project only
 *     (installed_plugins.json scope "project" or "local", with its projectPath) counts in that project alone;
 *   - plugin hooks switched off for everyone (`disableAllHooks` in any settings file, or `allowManagedHooksOnly` in the
 *     organisation's): zero-touch cannot act, so not listed;
 *   - zero-touch switched off (enabledPlugins false, at the scope that decides) → not listed;
 *   - zero-touch's saved settings say Workflows or Off → not listed, and the settings file is watched (server.ts): if
 *     it later says Hand-off, the tools are added and Claude Code is told the list changed (it then lists the tools
 *     again at once). They are never taken away while the server runs: a chat that has them keeps them;
 *   - zero-touch's settings file cannot be read, or holds a value that is not one of its choices → zero-touch's own
 *     rule (zero-touch/scripts/settings.mjs, fail safe): its last good save decides, and with none zero-touch is Off,
 *     so not listed (the file is watched, as for Workflows and Off);
 *   - Hand-off saved with every kind of work kept in the chat: only undo_hand_off is listed (a landing made earlier can
 *     still be taken back), and the file is watched, so handing a kind off later adds the other three;
 *   - Claude Code's record of installed plugins cannot be read and no zero-touch data folder exists (a developer's
 *     clone or --plugin-dir setup without zero-touch) → not listed;
 *   - anything else (Hand-off saved, nothing chosen yet, so the first chat may choose Hand-off, or Claude Code's own
 *     records cannot be read beside a zero-touch data folder) → listed. When in doubt, the tools are listed.
 *
 * Where Claude Code keeps what is read here: `<config>/plugins/installed_plugins.json` (which plugins are installed),
 * the settings files' `enabledPlugins` (managed, then the project's local file, then the project's, then the user's:
 * the first that names the plugin decides), and `<config>/plugins/data/<plugin id, other characters as "-">/
 * settings.json` (zero-touch's own settings, its ${CLAUDE_PLUGIN_DATA}). `<config>` is CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mmoHome } from "./chat.js";

export interface ListingDecision {
  list: boolean;
  /** Only these tools are listed (every kind of work kept in the chat: the undo alone); absent: all four. */
  only?: string[];
  /** Why, in a word: for the server's log. */
  reason: "override" | "no-zero-touch" | "zero-touch-off" | "other-mode" | "handoff" | "handoff-all-kept" | "undo-after-handoff" | "not-chosen" | "unreadable" | "unreadable-off";
  /** Zero-touch settings files to watch, when tools are left out only because of the saved settings. */
  watch: string[];
}

type Env = Record<string, string | undefined>;

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The folder Claude Code keeps its settings and plugins in. */
export function claudeConfigDir(env: Env): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return set ? set : join(env.HOME?.trim() || homedir(), ".claude");
}

/** The organisation's managed settings file (the same places zero-touch's mark.mjs reads). */
function managedSettingsFile(env: Env): string {
  if (env.MMO_MANAGED_SETTINGS?.trim()) return env.MMO_MANAGED_SETTINGS.trim();
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** A plugin's data folder name: its id with characters other than letters, digits, "_" and "-" as "-". */
export const dataFolderName = (pluginId: string) => pluginId.replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * Whether an install record holds an install that applies in this project: one for the user (or with no scope
 * recorded), or one for this project (scope "project" or "local" with its projectPath). An entry that is not a list
 * (an older record's shape) counts as installed.
 */
function installedHere(entries: unknown, project: string): boolean {
  if (!Array.isArray(entries)) return true;
  if (!entries.length) return true;
  const here = resolve(project);
  return entries.some((e) => {
    if (!isObject(e)) return true;
    const scope = typeof e.scope === "string" ? e.scope : "user";
    if (scope !== "project" && scope !== "local") return true;
    return typeof e.projectPath === "string" && resolve(e.projectPath) === here;
  });
}

/** Whether a plugin is switched on: the first settings scope that names it decides; none names it → on (installing turns it on). */
function enabled(pluginId: string, layers: unknown[]): boolean {
  for (const layer of layers) {
    const value = isObject(layer) && isObject(layer.enabledPlugins) ? layer.enabledPlugins[pluginId] : undefined;
    if (typeof value === "boolean") return value;
  }
  return true;
}

export function handoffListing(env: Env = process.env): ListingDecision {
  const override = env.MMO_HANDOFF_TOOLS?.trim().toLowerCase();
  if (override === "on" || override === "off") return { list: override === "on", reason: "override", watch: [] };

  const config = claudeConfigDir(env);
  const installed = readJson(join(config, "plugins", "installed_plugins.json"));
  if (!isObject(installed)) {
    // No record to read: listed only where zero-touch has a data folder (it has run here), not in a setup without it.
    let zeroTouchData = false;
    try { zeroTouchData = readdirSync(join(config, "plugins", "data")).some((n) => n.startsWith("zero-touch-")); } catch { /* no data folder at all */ }
    return zeroTouchData ? { list: true, reason: "unreadable", watch: [] } : { list: false, reason: "no-zero-touch", watch: [] };
  }
  const plugins = isObject(installed.plugins) ? installed.plugins : installed;
  const project = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const ids = Object.keys(plugins).filter((id) => id.startsWith("zero-touch@") && installedHere(plugins[id], project));
  if (!ids.length) return { list: false, reason: "no-zero-touch", watch: [] };

  const layers = [
    readJson(managedSettingsFile(env)),
    readJson(join(project, ".claude", "settings.local.json")),
    readJson(join(project, ".claude", "settings.json")),
    readJson(join(config, "settings.json")),
  ];
  if (layers.some((l) => isObject(l) && l.disableAllHooks === true) || (isObject(layers[0]) && layers[0].allowManagedHooksOnly === true)) {
    return { list: false, reason: "zero-touch-off", watch: [] };
  }
  const on = ids.filter((id) => enabled(id, layers));
  if (!on.length) return { list: false, reason: "zero-touch-off", watch: [] };

  const watch: string[] = [];
  let fellBack = false;
  let allKept = false;
  for (const id of on) {
    const file = join(config, "plugins", "data", dataFolderName(id), "settings.json");
    let mode = savedMode(file);
    let read = file;
    if (mode === "none") return { list: true, reason: "not-chosen", watch: [] };
    if (mode === "unreadable") {
      fellBack = true;
      read = join(dirname(file), "settings.last-good.json");
      const last = savedMode(read);
      mode = last === "handoff" || last === "workflows" ? last : "off";
    }
    if (mode === "handoff") {
      if (!everyKindKept(read)) return { list: true, reason: "handoff", watch: [] };
      allKept = true;
    }
    watch.push(file);
  }
  if (allKept) return { list: true, only: [UNDO_ONLY], reason: "handoff-all-kept", watch };
  // A hand-off made earlier can still be undone after the person left Hand-off mode: the undo alone is listed while
  // any landing is not undone yet.
  if (landingToUndo(env)) return { list: true, only: [UNDO_ONLY], reason: "undo-after-handoff", watch };
  return { list: false, reason: fellBack ? "unreadable-off" : "other-mode", watch };
}

/** Whether any chat's records hold a hand-off that is not fully undone (sessions/<id>/handoff_landings.json). */
function landingToUndo(env: Env): boolean {
  const sessions = join(mmoHome(env), "sessions");
  let names: string[] = [];
  try { names = readdirSync(sessions); } catch { return false; }
  for (const name of names.slice(0, 5000)) {
    const all = readJson(join(sessions, name, "handoff_landings.json"));
    if (Array.isArray(all) && all.some((l: any) => l && l.undone !== true)) return true;
  }
  return false;
}

const UNDO_ONLY = "undo_hand_off";

/** Whether saved Hand-off settings keep all three kinds of work in the chat ("chat"); a value left out is not kept. */
function everyKindKept(file: string): boolean {
  const saved = readJson(file);
  const h = isObject(saved) && isObject(saved.handoff) ? saved.handoff : {};
  return ["documents", "tests", "repeats"].every((k) => h[k] === "chat");
}

/** The mode a zero-touch settings file names: a known one, "none" (no file) or "unreadable" (anything else). */
/**
 * zero-touch's full rule for a settings file (zero-touch/scripts/settings.mjs readFile and invalidValues; the mmo
 * hook's copy is plugin/scripts/ambient/lib/zt-saved.mjs): at most 16 KB, an object, and only values the box offers,
 * so the three readers agree.
 */
const CHOICES = {
  modes: ["handoff", "workflows", "off"],
  workflowModels: ["opus-plus-flash-v38", "fable51-plus-flash-v38", "opus-plus-sonnet", "opus-only-v5"],
  chatModels: ["claude-opus-5", "claude-sonnet-5"],
  typists: ["flash", "sonnet", "chat"],
  kinds: ["documents", "tests", "repeats"],
};
const choice = (v: unknown, list: string[]): boolean => typeof v === "string" && list.includes(v);
function onlyChoices(raw: unknown): raw is Record<string, any> {
  if (!isObject(raw) || !choice(raw.mode, CHOICES.modes)) return false;
  const w = raw.workflows;
  if (w !== undefined && (!isObject(w) || (w.models !== undefined && !choice(w.models, CHOICES.workflowModels)))) return false;
  const h = raw.handoff;
  if (h !== undefined) {
    if (!isObject(h)) return false;
    if (h.chat_model !== undefined && !choice(h.chat_model, CHOICES.chatModels)) return false;
    for (const k of CHOICES.kinds) if (h[k] !== undefined && !choice(h[k], CHOICES.typists)) return false;
  }
  return true;
}

export function savedMode(file: string): "handoff" | "workflows" | "off" | "none" | "unreadable" {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? "none" : "unreadable"; }
  if (text.length > 16 * 1024) return "unreadable";
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return "unreadable"; }
  return onlyChoices(saved) ? (saved.mode as "handoff" | "workflows" | "off") : "unreadable";
}
