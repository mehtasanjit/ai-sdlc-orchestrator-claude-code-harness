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
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The scripts the workflow texts run at their steps (plugin/agents, commands and skills), in mmo's scripts folder. */
export const OWN_SCRIPTS = new Set([
  "mmo-log.mjs", "write-provenance.mjs", "collect-orchestrator-usage.mjs", "write-manifest.mjs", "driver-model-check.mjs",
  "verify-setup.mjs", "setup-policy.mjs", "pre-check.mjs", "session-hydrate.mjs", "discovery-refresh.mjs",
  "plan-lint.mjs", "plan-to-packets.mjs", "findings-to-packets.mjs",
]);
/**
 * The model-server tools that take a policy file. In a run zero-touch started, the zero-touch plugin's pre-dispatch
 * hook stamps each with the person's policy (its matcher in zero-touch/hooks/hooks.json names the same tools) and
 * answers for it, so the hook that sees every call leaves these to that one (tools/test/zero-touch-own-steps.test.mjs
 * checks both lists against the server's own).
 */
export const STAMPED_TOOLS = /__(?:load_policy|preflight_dispatch|execute_with_model|execute_batch|simulate_policy)$/;
/** Zero-touch's own step scripts, in its folder inside mmo's (plugin/scripts/ambient/): Claude runs them when told to. */
export const ZERO_TOUCH_SCRIPTS = new Set(["workflow-stopped.mjs", "git-baseline.mjs"]);

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The agent of a brownfield feature run that runs its steps (the orchestrator copy built by tools/build-agent-copies.mjs). Its
 * texts wrap long step calls over lines and chain bookkeeping calls with &&, so only its calls are read that way;
 * every other caller keeps the one-call check below.
 */
const FEATURE_RUN_AGENTS = ["brownfield-orchestrator"];
const foldName = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s_-]/g, "");
export function featureRunAgent(agentType) {
  const n = foldName(agentType).replace(/^mmo:/, "");
  return FEATURE_RUN_AGENTS.some((a) => foldName(a) === n);
}

/**
 * Whether a shell command is exactly one call of one of this plugin's own step scripts in `scriptsDir`. With
 * `joined` (a feature run's agent), a call wrapped over lines, a backslash just before each line feed, is read as the
 * one call the shell joins it into, and calls chained by && count when each is a step on its own. Only a backslash
 * directly before a line feed is joined: after a backslash and a carriage return the line feed still ends the
 * command, so that form fails the one-call check.
 */
export function ownScriptCall(command, scriptsDir, { joined = false } = {}) {
  if (typeof command !== "string") return false;
  if (joined) {
    const text = command.replace(/\\\n/g, "");
    if (text.includes("&&")) return text.split("&&").every((part) => part.trim() !== "" && ownScriptCall(part, scriptsDir));
    return ownScriptCall(text, scriptsDir);
  }
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

/**
 * The shell commands a model-server call makes the server run in the project, as the server will run them: each
 * apply-form packet's typed `checks` (every `run` and `fix` on the file, and every `run` on its `baseline_from` file,
 * which the server tries first; apply.ts normalizeApply, baselineChecks), or else its `verify` and `format` commands,
 * with `{path}` filled in. Only packets the server applies count: `apply.write` true, and for execute_batch only the
 * `packet_ids` it names when it names any (execute_with_model's packet; execute_batch's packets, inline or in the
 * packets file it names, read as the server reads it, from the project folder). Claude Code's Bash rules never see a
 * command a server runs, so the hooks check these against the person's deny rules (lib/bash-rules.mjs), as they check
 * a hand-off's command. Returns `{ commands: [{ run, template }] }` (`template` keeps `{path}`), or `{ unreadable }`
 * with the file's path when a named packets file cannot be read.
 */
export function serverCommands(toolName, input, projectDir) {
  const tool = String(toolName ?? "");
  let packets = [];
  if (/__execute_with_model$/.test(tool)) packets = [input?.packet];
  else if (/__execute_batch$/.test(tool)) {
    if (typeof input?.packets_path === "string" && input.packets_path) {
      const file = isAbsolute(input.packets_path) ? input.packets_path : resolve(projectDir, input.packets_path);
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        packets = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : [];
      } catch { return { unreadable: file }; }
      if (Array.isArray(input.packet_ids) && input.packet_ids.length) {
        const want = new Set(input.packet_ids);
        packets = packets.filter((p) => want.has(p?.id));
      }
    } else if (Array.isArray(input?.packets)) packets = input.packets;
  }
  const commands = [];
  for (const p of packets) {
    const apply = p && typeof p === "object" ? p.apply : null;
    if (!apply || typeof apply !== "object" || apply.write !== true) continue;
    const add = (template, path) => { if (typeof template === "string" && template.trim()) commands.push({ run: template.replaceAll("{path}", String(path ?? "")), template }); };
    const checks = Array.isArray(apply.checks) ? apply.checks.filter((c) => c && typeof c === "object" && typeof c.run === "string" && c.run.trim()) : [];
    if (checks.length) {
      for (const c of checks) { add(c.run, p.artifact_path); add(c.fix, p.artifact_path); }
      if (typeof apply.baseline_from === "string" && apply.baseline_from) for (const c of checks) add(c.run, apply.baseline_from);
      continue;
    }
    for (const template of Array.isArray(apply.verify) ? apply.verify : []) add(template, p.artifact_path);
    for (const template of Array.isArray(apply.format) ? apply.format : []) add(template, p.artifact_path);
  }
  return { commands };
}
