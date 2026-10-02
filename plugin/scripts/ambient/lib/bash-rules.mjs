/**
 * Whether the person's Claude settings forbid a shell command.
 *
 * Why: a hand-off checks its work by running a command the chat names (write_tests_from_cases' test_command,
 * repeat_edit_across_files' check_command) in a scratch copy of the project. The model server runs it, and Claude
 * Code's own permission rules for its Bash tool never see a command a server runs, so a command the person, or their
 * organisation, has forbidden ("Bash(rm:*)", "Bash(curl *)", or all of Bash) could run anyway. The hand-off hook
 * reads the same deny rules and refuses such a call before it reaches the server. The same holds for a workflow's
 * apply-form packets, whose check and format commands the server runs after writing a file (lib/own-steps.mjs
 * serverCommands): the stamp's hook refuses such a call in a workflow zero-touch started, and the hook that allows the
 * workflow's own steps leaves it to Claude Code's prompt in a workflow the person typed. A packet command with shell
 * syntax this check cannot see through (a lone &, $, backquotes, brackets, redirects, a backslash, a new line) is
 * never allowed by those hooks either: it keeps Claude Code's prompt.
 *
 * The rules are read from the settings files Claude Code reads: the organisation's managed settings, the person's
 * ~/.claude/settings.json, and the project's .claude/settings.json and .claude/settings.local.json; a deny rule in any
 * of them counts. The rule forms Claude Code documents: "Bash" (every command), "Bash(npm test)" (exactly), "Bash(npm
 * run test:*)" (that prefix), and "*" wildcards ("Bash(curl *)"). A command made of several (&&, ||, ;, |, a new
 * line) is checked part by part, as Claude Code checks one. Not covered (said in docs/ambient-mode.md): Claude Code's
 * sandbox does not apply to a server's commands, and an "ask" rule is not asked here.
 *
 * A new document and an undo are allowed without Claude Code's permission prompt, except where a
 * deny or ask rule in those same files names the tool (toolRuleFor): then Claude Code's own rules decide. The two
 * tools that run a command keep Claude Code's prompt for the tool call, which shows the command.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The organisation's managed settings file (the same places zero-touch/scripts/mark.mjs reads). */
function managedSettingsFile(env) {
  if (env.MMO_MANAGED_SETTINGS && env.MMO_MANAGED_SETTINGS.trim()) return env.MMO_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** Every Bash deny rule in the settings Claude Code reads for this project: the text inside "Bash(…)", or "" for all. */
export function bashDenyRules(projectDir, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  const files = [managedSettingsFile(env), join(config, "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  const rules = [];
  for (const f of files) {
    const deny = readJson(f)?.permissions?.deny;
    if (!Array.isArray(deny)) continue;
    for (const r of deny) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t === "Bash") rules.push("");
      const m = /^Bash\((.*)\)$/s.exec(t);
      if (m) rules.push(m[1].trim());
    }
  }
  return rules;
}

/**
 * The deny or ask rule in the person's settings that names an MCP tool, as written ("mcp__plugin_mmo_model-dispatch"),
 * or null. The forms Claude Code documents: the server ("mcp__<server>"), one tool ("mcp__<server>__<tool>"), and "*"
 * wildcards ("mcp__<server>__*", "mcp__*").
 */
export function toolRuleFor(toolName, projectDir, env = process.env) {
  const tool = String(toolName ?? "");
  if (!tool) return null;
  const config = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  const files = [managedSettingsFile(env), join(config, "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  for (const f of files) {
    const p = readJson(f)?.permissions;
    for (const list of [p?.deny, p?.ask]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (typeof r !== "string") continue;
        const t = r.trim();
        if (!t.startsWith("mcp__") && t !== "*") continue;
        if (t === tool || tool.startsWith(`${t}__`) || (t.includes("*") && matches(tool, t))) return t;
      }
    }
  }
  return null;
}

/** Whether one simple command matches one rule's text. */
function matches(command, rule) {
  if (rule === "" || rule === "*") return true;
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -2).trim();
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (rule.includes("*")) {
    const re = new RegExp(`^${rule.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
    return re.test(command);
  }
  return command === rule;
}

/** The deny rule a command breaks, as written in the settings ("Bash(rm:*)"), or null. */
export function deniedBy(command, projectDir, env = process.env) {
  const rules = bashDenyRules(projectDir, env);
  if (!rules.length || typeof command !== "string") return null;
  const parts = command.split(/&&|\|\||;|\||\n/).map((p) => p.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
  for (const rule of rules) for (const part of parts.length ? parts : [command.trim()]) if (matches(part, rule)) return rule === "" ? "Bash" : `Bash(${rule})`;
  return null;
}
