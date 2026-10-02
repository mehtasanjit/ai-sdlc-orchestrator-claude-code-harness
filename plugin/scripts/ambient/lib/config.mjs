/**
 * Zero-touch's settings for the hook path. Plain JSON on purpose: hooks run on machines that installed the plugin
 * with /plugin install and have no node_modules, so the YAML policy cannot be parsed here.
 *
 * Order, weakest to strongest:
 *   1. plugin/config/ambient.default.json          shipped defaults
 *   2. <MMO_HOME>/ambient.json                      the person's own file (MMO_HOME defaults to ~/.mmo-ambient)
 *   3. <project>/.sdlc/ambient.json                 a project file: it may only switch routing off
 *   4. MMO_AMBIENT=off|observe|on                   one-run override of the on/off decision
 *
 * The settings (docs/ambient-mode.md, "Settings"):
 *   routing            on | off: start the /mmo: workflow a chat message asks for, recognised by the rules only
 *   routing_defaults   the cost-recording mode a routed workflow starts with (auth)
 *   retention_days     how long a chat's records under MMO_HOME are kept
 *
 * The person's zero-touch choices (the mode, the workflow models, hand-off's chat model and typists) are not here:
 * they are chosen in the settings box in the chat and kept by the zero-touch plugin
 * (zero-touch/scripts/settings.mjs), which stamps them on each chat at its start. A `handoff` block or a
 * `routing_defaults.policy` in a file is ignored.
 *
 * None of the files switches zero-touch on or off. Whether a chat has zero-touch is the chat's own
 * record, written when the chat starts by the zero-touch plugin, the switch people use in Claude Code's plugin list
 * (lib/chat-mode.mjs; zero-touch/scripts/start-chat.mjs). A `mode` key in a file is ignored; `config.mode` here is
 * only MMO_AMBIENT's one-run override for a developer or a measuring setup, "off" without it.
 *
 * A project file is anyone's input: anyone who can land a commit can edit it. So it can only make the plugin do
 * less (switch routing off), never start a paid workflow on someone's machine by itself.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mmoHome } from "./paths.mjs";

export const MODES = ["off", "observe", "on"];
export const ROUTING = ["off", "on"];
const MAX_CONFIG_BYTES = 64 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, "..", "..", "..", "config", "ambient.default.json");

function readJsonSafe(file) {
  try {
    if (!existsSync(file) || statSync(file).size > MAX_CONFIG_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlain(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** The person's own file over the defaults: known keys only, each of the default's type; unknown keys are dropped. */
function mergeUser(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    if (isPlain(v) && isPlain(base[k])) out[k] = { ...base[k], ...v };
    else if (typeof v === typeof base[k] && Array.isArray(v) === Array.isArray(base[k])) out[k] = v;
  }
  return out;
}

/**
 * Returns the effective settings plus `sources`, a short list of which layers applied, so a report can say why a
 * chat ran as it did. Never throws: any unreadable layer is skipped.
 */
export function loadConfig({ projectDir, env = process.env, defaultFile = DEFAULT_FILE } = {}) {
  const shipped = readJsonSafe(defaultFile);
  if (!shipped) return { config: { mode: "off", routing: "off", routing_defaults: {} }, sources: ["defaults-unreadable"] };
  let config = shipped;
  const sources = ["defaults"];

  const user = readJsonSafe(join(mmoHome(env), "ambient.json"));
  if (user) { config = mergeUser(config, user); sources.push("user"); }
  // Which file switched routing off, so the person can be told.
  let routingOffBy = config.routing === "off" ? (user && user.routing === "off" ? "user" : "defaults") : null;

  if (projectDir) {
    const project = readJsonSafe(join(projectDir, ".sdlc", "ambient.json"));
    if (project) {
      // Routing can only be switched off: a repository never starts a paid workflow on someone's machine by itself.
      if (project.routing === "off") { config.routing = "off"; routingOffBy = "project"; }
      sources.push("project");
    }
  }

  // No file switches zero-touch (see the header): only the one-run override is read, and "off" without it.
  config.mode = "off";
  if (typeof env.MMO_AMBIENT === "string" && MODES.includes(env.MMO_AMBIENT)) {
    config.mode = env.MMO_AMBIENT;
    sources.push("env");
  }
  // A value the plugin does not know means the safe default, never a guess.
  if (!ROUTING.includes(config.routing)) { config.routing = "off"; routingOffBy ??= "defaults"; }
  config.routing_off_by = config.routing === "off" ? routingOffBy ?? "defaults" : null;
  if (!isPlain(config.routing_defaults)) config.routing_defaults = {};
  // Only the cost-recording mode is read here; the models are the person's zero-touch choice (see the header).
  config.routing_defaults = { auth: ["estimated", "vendor"].includes(config.routing_defaults.auth) ? config.routing_defaults.auth : "estimated" };
  delete config.handoff;
  return { config, sources };
}
