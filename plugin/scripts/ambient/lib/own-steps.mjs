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
 *   - a call of this plugin's own model-server tools (both names Claude Code gives them), unless a command it would
 *     make the server run is one the check below cannot read (serverCommandUnchecked) or the person's settings forbid;
 *   - the brownfield write contract's own script (write-contract.mjs), only as the brownfield guide runs it in the main
 *     chat (contractStepCall; the hook adds who and where): Gate 0's freeze, before the chat's run has started, and the
 *     close-out. Its --abandon, which ends a run on purpose, is the person's decision and never a step.
 * Every other command, file edit or tool keeps Claude Code's own rules and prompts. Chats without zero-touch, and a
 * zero-touch chat with no workflow running, are untouched.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The scripts the workflow texts run at their steps (plugin/agents, commands and skills), in mmo's scripts folder.
 * Bookkeeping steps, all but one: plan-lint.mjs also runs the change spec's file checks (the repository's own commands,
 * from the spec's header) on the files as they are before the change, the same commands the model server runs at
 * dispatch without a prompt (its baseline). Allowing plan-lint without a prompt allows those commands too.
 */
export const OWN_SCRIPTS = new Set([
  "mmo-log.mjs", "write-provenance.mjs", "collect-orchestrator-usage.mjs", "write-manifest.mjs", "driver-model-check.mjs",
  "verify-setup.mjs", "setup-policy.mjs", "pre-check.mjs", "session-hydrate.mjs", "discovery-refresh.mjs",
  "plan-lint.mjs", "plan-to-packets.mjs", "findings-to-packets.mjs",
]);
/**
 * The write contract's own script. Not one of OWN_SCRIPTS: it decides what the run may write, so a call of it is a step
 * only when contractStepCall reads it as Gate 0's freeze or the close-out, and the hook finds it is the main chat's,
 * in the chat's own project (and, for a freeze, before the chat's run has started). Anything else keeps the prompt: a
 * helper's call, a freeze mid-run or under a second run id (a live run swapping its contract for a wider one), a call
 * into another folder, any chain, and every --abandon.
 */
export const CONTRACT_SCRIPT = "write-contract.mjs";
/**
 * The model-server tools that take a policy file: in a run zero-touch started, each is stamped with the person's
 * policy. tools/test/zero-touch-own-steps.test.mjs checks the list against the server's own.
 */
export const STAMPED_TOOLS = /__(?:load_policy|preflight_dispatch|execute_with_model|execute_batch|simulate_policy)$/;
/**
 * The stamped tools that the zero-touch plugin's stamp hook (pre-dispatch) receives: exactly those its released
 * matcher names (zero-touch/hooks/hooks.json, kept as released). An installed zero-touch moves only through its own
 * update, so mmo cannot count on a newer matcher: a stamped tool added after it (execute_batch) is stamped and answered
 * by the hook that sees every call (pre-any), and these are left to pre-dispatch, so one call never gets two answers.
 */
export const PRE_DISPATCH_TOOLS = /__(?:load_policy|preflight_dispatch|execute_with_model|simulate_policy)$/;
/** Zero-touch's own step scripts, in its folder inside mmo's (plugin/scripts/ambient/): Claude runs them when told to. */
export const ZERO_TOUCH_SCRIPTS = new Set(["workflow-stopped.mjs", "git-baseline.mjs"]);

const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The agent of a brownfield run that runs its steps (the orchestrator copy built by tools/build-agent-copies.mjs). Its
 * texts wrap long step calls over lines and chain bookkeeping calls with &&, so only its calls are read that way;
 * every other caller keeps the one-call check below.
 */
const BROWNFIELD_RUN_AGENTS = ["brownfield-orchestrator"];
const foldName = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s_-]/g, "");
export function brownfieldRunAgent(agentType) {
  const n = foldName(agentType).replace(/^mmo:/, "");
  return BROWNFIELD_RUN_AGENTS.some((a) => foldName(a) === n);
}

/**
 * Whether a shell command is exactly one call of one of this plugin's own step scripts in `scriptsDir`. With
 * `joined` (a brownfield run's agent), a call wrapped over lines, a backslash just before each line feed, is read as the
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

/** A run id as the workflows write it (lib/workflow-log.mjs RUN_ID). */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Stands in for the literal "$(pwd)" while a command is read; a command that already holds it is not read. */
const PWD_MARK = "\u0001pwd\u0001";

/**
 * A command's words as the shell splits them, or null when the shell would do more than split and unquote: unquoted
 * characters are limited to a plain set (no globs, braces, tildes, comments), and a quote must close. The callers have
 * already refused $, backquotes, backslashes, redirects and separators, so a quoted part is taken as written.
 */
function shellWords(text) {
  const words = [];
  let cur = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (cur !== null) words.push(cur); cur = null; i++; continue; }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) return null;
      cur = (cur ?? "") + text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z0-9._\/:=@%+,\u0001-]/.test(ch)) return null;
    cur = (cur ?? "") + ch;
    i++;
  }
  if (cur !== null) words.push(cur);
  return words;
}

/**
 * Reads a shell command as one call of the write contract's own script in `scriptsDir`: `{ mode: "freeze" | "close",
 * runId, projectRoot }` (`projectRoot` as written, "$(pwd)" kept literally, or null when the call names none), or null.
 * Null for anything else: another script, other shell syntax (as ownScriptCall refuses it), a word the script does not
 * take, no run id, more than one mode, and every --abandon. The words are read exactly as the script reads them
 * (write-contract.mjs parseArgs: `--name=value` or `--name value`, the last one counting), so the run id and project
 * folder the hook judges are the ones the script will use.
 */
export function contractStepCall(command, scriptsDir) {
  if (typeof command !== "string" || command.includes(PWD_MARK)) return null;
  const text = command.trim().replaceAll('"$(pwd)"', PWD_MARK).replaceAll("$(pwd)", PWD_MARK);
  if (/[;&|`<>\n\r$\\]/.test(text)) return null;
  // The shell splits words on a space or a tab only; any other blank (a no-break space, a vertical tab, a form feed) is
  // part of a word to it, so the words read here would not be the words the script gets: no step.
  if (/[^\S \t]/.test(text)) return null;
  const m = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  const script = m[1] ?? m[2] ?? m[3];
  if (basename(script) !== CONTRACT_SCRIPT || realOr(dirname(script)) !== realOr(scriptsDir)) return null;
  const words = shellWords(m[4] ?? "");
  if (!words) return null;
  const modes = [];
  let runId = null, projectRoot = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const value = () => (w.includes("=") ? w.slice(w.indexOf("=") + 1) : words[++i]);
    if (w === "--freeze" || w === "--close") modes.push(w.slice(2));
    else if (w.startsWith("--abandon")) return null;
    else if (w.startsWith("--run-id")) runId = value();
    else if (w.startsWith("--project-root")) projectRoot = value();
    else if (w.startsWith("--allowlist") || w.startsWith("--off-limits") || w.startsWith("--reason")) value();
    else if (w !== "--strict-write=off") return null;
  }
  if (modes.length !== 1 || typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  if (projectRoot !== null && typeof projectRoot !== "string") return null;
  return { mode: modes[0], runId, projectRoot: projectRoot === null ? null : projectRoot.replaceAll(PWD_MARK, "$(pwd)") };
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
 * a hand-off's command. Returns `{ commands: [{ run, template, path }] }` (`template` keeps `{path}`; `path` is what
 * fills it), or `{ unreadable }` with the file's path when a named packets file cannot be read.
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
    const add = (template, path) => { if (typeof template === "string" && template.trim()) commands.push({ run: template.replaceAll("{path}", String(path ?? "")), template, path: String(path ?? "") }); };
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

/**
 * A file path the server can paste into a command and the deny check can still read: plain path characters only, and
 * not starting with "-" (a path read as an option). The server fills `{path}` in as written and runs the command through
 * a shell, so `$(…)`, backquotes, a lone &, quotes, spaces or globs in a packet's path would run, or change, commands
 * the person's settings forbid; the deny check reads the command as text and cannot see them.
 */
const PLAIN_PATH = /^(?!-)[\p{L}\p{N}._\/@+,=:%-]+$/u;
/**
 * Whether a server command (one of serverCommands' entries) cannot be checked against the person's deny rules, so it
 * keeps Claude Code's prompt: shell syntax in its template outside the path's own placeholder (a lone &, $, backquotes,
 * brackets, redirects, a backslash, a line end, or quotes, which also hide a command's name from the check: 'rm',
 * r''m), any blank other than a plain space (a tab between a command's name and its arguments is a space to the shell,
 * which runs the command, and a check reading the text could miss it: rm<TAB>-rf), or a path that is not a plain path.
 * The placeholder may stand alone or in quotes of its own ('{path}').
 */
export function serverCommandUnchecked({ template, path }) {
  const t = String(template ?? "");
  if (t.includes("{path}") && !PLAIN_PATH.test(String(path ?? ""))) return true;
  const rest = t.replaceAll("'{path}'", "PATH").replaceAll('"{path}"', "PATH").replaceAll("{path}", "PATH").replaceAll("&&", " ");
  return /[&$`(){}<>\\\r\n'"]|[^\S ]/.test(rest);
}
