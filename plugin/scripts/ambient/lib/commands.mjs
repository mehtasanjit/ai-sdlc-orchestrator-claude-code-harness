/**
 * The plugin's own /mmo: commands, as a typed line or a command expansion names them. A chat where the person typed
 * one is a workflow run, and zero-touch stands down in it until the run ends.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plugin's own command names, read from its commands folder, so this list
 * can never drift from what the plugin ships.
 */
const COMMANDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commands");
export const PLUGIN_COMMANDS = (() => {
  try { return new Set(readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))); } catch { return new Set(); }
})();

/**
 * A command name, as a typed line or an expansion reports it, that is one of
 * the plugin's own: "mmo:bugfix", "/mmo:bugfix" or, typed without the prefix
 * where Claude Code allows it, "bugfix". A bare name that another command
 * also has is not mmo's (typedCommand, bareNameTaken).
 */
export function isPluginCommandName(name) {
  const m = /^\/?(?:mmo:)?([a-z][a-z-]*)$/i.exec(String(name ?? "").trim());
  return Boolean(m) && PLUGIN_COMMANDS.has(m[1].toLowerCase());
}

/** A prompt that types one of the plugin's commands makes the session a pipeline session. */
export function isPipelineCommand(prompt) {
  if (typeof prompt !== "string") return false;
  const m = /^\s*(\/[\w:-]+)/.exec(prompt);
  return Boolean(m) && isPluginCommandName(m[1]);
}

/**
 * The plugin's commands that start a workflow: a gated run with its own run log (`.sdlc/runs/<run-id>/
 * orchestrator.log`). Only these make a chat a workflow run, can wait in the queue, or be replaced. The
 * other commands (setup, policy, revert) are one-off tools: typing one never makes the chat a workflow run, since no
 * run log would ever show its end and the chat would stay quiet for the rest of its life.
 * tools/test/zero-touch-queue.test.mjs checks every shipped command is classified here or in ONE_OFF_COMMANDS.
 */
export const WORKFLOW_COMMANDS = new Set(["greenfield", "brownfield", "bugfix", "feature-extend", "feature-new", "refactor", "test", "docs", "deps", "pass"]);
export const ONE_OFF_COMMANDS = new Set(["setup", "policy", "revert"]);

/**
 * Whether a command typed without "mmo:" belongs to someone else: the project's own `/test`
 * (.claude/commands/test.md), the person's, or another installed plugin's. Claude Code runs that one, so reading it
 * as mmo's would mark the chat as running a workflow that never exists, and hold the project for every other chat.
 * Looks for a command or skill of that name in the project, in the person's Claude folder, and in every
 * other installed plugin.
 */
export function bareNameTaken(name, { projectDir = process.cwd(), env = process.env } = {}) {
  const config = env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
  const own = [
    join(projectDir, ".claude", "commands", `${name}.md`),
    join(projectDir, ".claude", "skills", name, "SKILL.md"),
    join(config, "commands", `${name}.md`),
    join(config, "skills", name, "SKILL.md"),
  ];
  if (own.some((f) => existsSync(f))) return true;
  try {
    const installed = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
    for (const [id, entries] of Object.entries(installed?.plugins ?? {})) {
      if (id.startsWith("mmo@")) continue;
      for (const e of Array.isArray(entries) ? entries : []) {
        const at = typeof e?.installPath === "string" ? e.installPath : null;
        if (at && (existsSync(join(at, "commands", `${name}.md`)) || existsSync(join(at, "skills", name, "SKILL.md")))) return true;
      }
    }
  } catch { /* no record of installed plugins: nothing else to find */ }
  return false;
}

/**
 * A typed line's plugin command: { name, args, workflow } (name without "mmo:"), or null for anything else. A name
 * typed without "mmo:" is mmo's only when nothing else has that name (bareNameTaken; `where` gives the project).
 */
export function typedCommand(prompt, where = {}) {
  if (!isPipelineCommand(prompt)) return null;
  const m = /^\s*\/(mmo:)?([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const name = m[2].toLowerCase();
  if (!m[1] && bareNameTaken(name, where)) return null;
  return { name, args: (m[3] ?? "").trim(), workflow: WORKFLOW_COMMANDS.has(name) };
}
