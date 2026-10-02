#!/usr/bin/env node
/**
 * PreToolUse hook (matcher Agent|Task): keeps the pipeline's own helpers in the
 * foreground.
 *
 * Why: a run's orchestrator that launches the architect or a reviewer in the
 * background ends its turn and waits for a notice, and a helper's five-minute
 * prompt cache can expire in the meantime; worse, a background helper's result
 * can arrive after the orchestrator has moved on. A launch of one of this
 * plugin's agents (`mmo:<name>`, or the bare name inside the plugin's own
 * orchestrator) that asks for the background is refused with a reason, and
 * the model launches it again in the foreground.
 *
 * Scope: ONLY this plugin's agents. A bare name such as `architect` outside
 * the plugin's orchestrator is someone else's agent (plugin agents are always
 * named `mmo:<name>`), so it is allowed, as is every other agent launch in any
 * session — the plugin must not change how people use helpers outside a run.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The plugin's own agents (plugin/agents/*.md). */
export const PIPELINE_AGENTS = new Set(["orchestrator", "architect", "senior-reviewer", "security-reviewer", "discovery", "brownfield-orchestrator", "brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer", "packet-worker"]);

/** The plugin's orchestrators: every run's, and the copy brownfield feature runs use (tools/build-agent-copies.mjs). */
const ORCHESTRATORS = new Set(["orchestrator", "brownfield-orchestrator"]);

// Claude Code looks an agent up by its exact name, then by the name with case, spaces, dashes and
// underscores ignored, so `mmo:Architect` still starts the plugin's architect. Names compare the same way.
const fold = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s_-]/g, "");
const FOLDED = new Map([...PIPELINE_AGENTS].map((n) => [fold(n), n]));

/** The pipeline agent a name refers to, as `{ name, prefixed }` (`prefixed` when written `mmo:<name>`), or null for any other agent. */
export function pipelineAgent(type) {
  const f = fold(type);
  const prefixed = f.startsWith("mmo:");
  const name = FOLDED.get(prefixed ? f.slice(4) : f);
  return name ? { name, prefixed } : null;
}

// The clone route copies the plugin's orchestrator into the project's .claude/agents, where it is
// named `orchestrator`. The copy is told apart from a user's own orchestrator by its grant of this
// plugin's dispatch tools.
function isPluginOrchestratorCopy(projectDir, name = "orchestrator") {
  if (!projectDir) return false;
  try {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(projectDir, ".claude", "agents", `${name}.md`), "utf8"))?.[1] ?? "";
    return /\bmcp__(plugin_mmo_)?model-dispatch__/.test(front);
  } catch { return false; }
}

/** Whether the caller is one of this plugin's orchestrators: `mmo:orchestrator` or `mmo:brownfield-orchestrator`, or the clone route's copy. */
function fromPluginOrchestrator(input, projectDir) {
  const caller = pipelineAgent(input.agent_type);
  if (!ORCHESTRATORS.has(caller?.name)) return false;
  return caller.prefixed || isPluginOrchestratorCopy(projectDir, caller.name);
}

/** The hook's decision for one tool call: a PreToolUse deny object, or null to allow. */
export function decide(input, projectDir = input?.cwd) {
  if (!input || !["Agent", "Task"].includes(input.tool_name)) return null;
  const ti = input.tool_input ?? {};
  if (ti.run_in_background !== true) return null;
  const type = String(ti.subagent_type ?? "");
  const agent = pipelineAgent(type);
  if (!agent) return null;
  if (!agent.prefixed && !fromPluginOrchestrator(input, projectDir)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${type} is one of the mmo pipeline's helpers, which run in the foreground: launch it again with run_in_background set to false and wait for its answer.`,
    },
  };
}

// Run as the hook when this file is the entry point. Compared as resolved file
// URLs: a plugin under a path with a space (URL-encoded in import.meta.url) or
// behind a symlink (Node resolves the entry to its real path) must still match.
const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === entry) {
  let input = null;
  try { input = JSON.parse(readFileSync(0, "utf8") || "null"); } catch { /* not a hook payload: allow */ }
  const out = decide(input, process.env.CLAUDE_PROJECT_DIR || input?.cwd);
  if (out) process.stdout.write(JSON.stringify(out));
}
