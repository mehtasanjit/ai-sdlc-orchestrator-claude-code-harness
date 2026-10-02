/**
 * The workflow's own steps, allowed without a permission prompt while the person's workflow runs.
 *
 * Why: in Claude Code's default "ask" permission mode, a workflow brings dozens of prompts, each naming one of this
 * plugin's bookkeeping scripts ("node …/scripts/mmo-log.mjs --event=phase.start …") or one of its model server's
 * tools ("mmo - preflight_dispatch (MCP)"): steps of the workflow the person has just asked for, in words they cannot
 * judge. While a workflow runs in a zero-touch chat, the hook that sees every tool call answers "allow" for exactly
 * these, and for nothing else:
 *   - a shell command that is one call of one of the plugin's own scripts below, `node "<this plugin>/scripts/<name>"
 *     <arguments>`, with no other shell syntax (no ; & | ` < > or a new line, and no $ except the literal "$(pwd)"
 *     the workflow texts pass as the project folder);
 *   - the run-start check with the chat's model in front of it, `CLAUDE_CODE_SUBAGENT_MODEL=<model id> node "<this
 *     plugin>/scripts/driver-model-check.mjs" …`, the one setting zero-touch itself puts there (lib/run-check.mjs);
 *   - a call of this plugin's own model-server tools (both names Claude Code gives them).
 * Every other command, file edit or tool keeps Claude Code's own rules and prompts. Chats without zero-touch, and a
 * zero-touch chat with no workflow running, are untouched.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The scripts the workflow texts run at their steps (plugin/agents, commands and skills), in mmo's scripts folder. */
export const OWN_SCRIPTS = new Set([
  "mmo-log.mjs", "write-provenance.mjs", "collect-orchestrator-usage.mjs", "write-manifest.mjs", "driver-model-check.mjs",
  "verify-setup.mjs", "setup-policy.mjs", "pre-check.mjs", "session-hydrate.mjs", "discovery-refresh.mjs",
]);
/** Zero-touch's own step scripts, in its folder inside mmo's (plugin/scripts/ambient/): Claude runs them when told to. */
export const ZERO_TOUCH_SCRIPTS = new Set(["workflow-stopped.mjs", "git-baseline.mjs"]);

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Whether a shell command is exactly one call of one of this plugin's own step scripts in `scriptsDir`. */
export function ownScriptCall(command, scriptsDir) {
  if (typeof command !== "string") return false;
  const text = command.trim().replaceAll('"$(pwd)"', "PWD_HERE").replaceAll("$(pwd)", "PWD_HERE");
  if (/[;&|`<>\n\r$\\]/.test(text)) return false;
  const m = /^(CLAUDE_CODE_SUBAGENT_MODEL=[A-Za-z0-9][A-Za-z0-9._-]{0,80}\s+)?node\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/.exec(text);
  if (!m) return false;
  const script = m[2] ?? m[3] ?? m[4];
  const name = basename(script);
  // Only the run-start check is given the chat's model; any other script with a setting in front is not a step.
  if (m[1] && name !== "driver-model-check.mjs") return false;
  // The script must be this plugin's own, in its own folder, wherever the path goes through a link.
  const home = OWN_SCRIPTS.has(name) ? scriptsDir : ZERO_TOUCH_SCRIPTS.has(name) ? join(scriptsDir, "ambient") : null;
  return home !== null && realOr(dirname(script)) === realOr(home);
}

/** This plugin's own model-server tools, under either name Claude Code gives them. */
export function ownServerTool(toolName) {
  return /^mcp__(?:plugin_mmo_)?model-dispatch__[a-z_]+$/.test(String(toolName ?? ""));
}
