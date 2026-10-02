#!/usr/bin/env node
/**
 * The executor guard, two hooks in one file:
 *
 *   post — PostToolUse on execute_stage: records the calling helper's agent_id (Claude Code sends it on
 *          every hook call made inside a helper) in <project>/.sdlc/local/executor-agents.json, with the
 *          run's record folder (the folder of the spec_path the call named) and its code folder (the
 *          call's code_dir). Only an orchestrator running a greenfield executor run calls execute_stage.
 *   pre  — PreToolUse on Agent|Task|Write|Edit|MultiEdit|NotebookEdit: when the caller is a recorded
 *          orchestrator, it may hire only the pipeline's own helpers (it reads a failing check's
 *          output itself and sends the files to change to execute_stage repair — never to
 *          general-purpose or Explore helpers on Opus), and it may write only inside its own run's
 *          record folder, never inside a code folder there (every change to the project's files goes
 *          through the typist, execute_stage repair, so the policy decides which model changes code). The allowed
 *          folder is the one the run named, not any `.sdlc` folder, so a `.sdlc` inside the product is
 *          not writable; a code folder inside the record folder (/mmo:pass writes its product to
 *          <record folder>/src) is not writable either.
 *
 * Why: diagnosis helpers and the orchestrator's own edits do the typist's work on Opus, outside the
 * policy's routing. The playbook forbids both; this makes it hold.
 *
 * Scope: only an orchestrator that called execute_stage. A brownfield run never does, so brownfield is
 * untouched; the main chat has no agent_id and is never touched. Fails open: an unreadable marker, a
 * missing field or any error allows the call — the guard never breaks a session.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { pipelineAgent } from "./foreground-helpers.mjs";

// A greenfield executor run's helpers. The foreground rule's list (foreground-helpers.mjs) also holds the brownfield
// reviewers' copies, which a greenfield run never hires, so this guard keeps its own list.
const EXECUTOR_HELPERS = new Set(["orchestrator", "architect", "senior-reviewer", "security-reviewer", "discovery"]);

/** Where the executor-run orchestrators are recorded, relative to the project folder. */
export const MARKER = join(".sdlc", "local", "executor-agents.json");
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function readMarker(projectDir) {
  try { return JSON.parse(readFileSync(join(projectDir, MARKER), "utf8")); } catch { return { agents: {} }; }
}

/** PostToolUse on execute_stage: remember the calling orchestrator, its run's record folder and code folder. The main chat (no agent_id) is never recorded. */
export function record(input, projectDir) {
  const id = typeof input?.agent_id === "string" && input.agent_id ? input.agent_id : null;
  if (!id) return;
  const m = readMarker(projectDir);
  m.agents = m.agents && typeof m.agents === "object" ? m.agents : {};
  const given = (k) => (typeof input?.tool_input?.[k] === "string" && input.tool_input[k] ? input.tool_input[k] : null);
  const specPath = given("spec_path");
  const codeDir = given("code_dir");
  const recordDir = specPath ? dirname(resolve(projectDir, specPath)) : null;
  const codeFolder = codeDir ? resolve(projectDir, codeDir) : null;
  const known = Boolean(m.agents[id]);
  const entry = m.agents[id] ?? { since: new Date().toISOString(), agent_type: typeof input.agent_type === "string" ? input.agent_type : undefined, record_dirs: [] };
  entry.record_dirs = Array.isArray(entry.record_dirs) ? entry.record_dirs : [];
  // An entry written before code folders were kept has none: the next call's code_dir is added to it.
  entry.code_dirs = Array.isArray(entry.code_dirs) ? entry.code_dirs : [];
  let changed = !known;
  if (recordDir && !entry.record_dirs.includes(recordDir)) { entry.record_dirs.push(recordDir); changed = true; }
  if (codeFolder && !entry.code_dirs.includes(codeFolder)) { entry.code_dirs.push(codeFolder); changed = true; }
  if (!changed) return;
  m.agents[id] = entry;
  const file = join(projectDir, MARKER);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}

const deny = (why) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });

/**
 * Where a path really is: the real path of its nearest existing folder with the rest added back. A file
 * the orchestrator is about to create does not exist yet, and one folder has many spellings (a
 * symlinked project folder, /tmp against /private/tmp on macOS).
 */
function realLocation(p) {
  let head = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail); } catch { /* not there yet: try its folder */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.unshift(basename(head));
    head = up;
  }
}

/** Where `p` lies relative to `dir`, by where both really are: "" for `dir` itself, null when outside it. */
function within(dir, p) {
  const r = relative(realLocation(dir), realLocation(p));
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)) ? r : null;
}

/** Whether `p` lies inside `dir`, by where both really are. */
const inside = (dir, p) => within(dir, p) !== null;

/**
 * Whether `p` is in a record folder and outside every code folder that folder holds. A code folder that
 * is the record folder, or holds it, takes nothing away: the run's own record is written there, so the
 * record folder stays writable.
 */
function inRecord(recordDir, codeDirs, p) {
  if (!inside(recordDir, p)) return false;
  return !codeDirs.some((c) => { const r = within(recordDir, c); return r !== null && r !== "" && inside(c, p); });
}

/** PreToolUse: the decision for one call — a deny object, or null to allow. */
export function decide(input, projectDir) {
  const id = typeof input?.agent_id === "string" && input.agent_id ? input.agent_id : null;
  if (!id) return null;
  const agent = readMarker(projectDir).agents?.[id];
  if (!agent) return null;
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input ?? {};
  if (tool === "Agent" || tool === "Task") {
    if (EXECUTOR_HELPERS.has(pipelineAgent(ti.subagent_type)?.name)) return null;
    return deny(`In a greenfield executor run the orchestrator hires only the pipeline's own helpers. Read the failing check's output yourself, then send each file to change to execute_stage with stage "repair" (failures): the typist the run's policy routes fixes to changes it. Nothing was started.`);
  }
  if (WRITE_TOOLS.has(tool)) {
    const p = String(ti.file_path ?? ti.notebook_path ?? "");
    if (!p) return null;
    const dirs = Array.isArray(agent.record_dirs) ? agent.record_dirs : [];
    const codeDirs = Array.isArray(agent.code_dirs) ? agent.code_dirs.filter((c) => typeof c === "string" && c) : [];
    // A record with no folder (the call named no spec_path) cannot be judged: the guard fails open.
    if (!dirs.length) return null;
    const full = resolve(projectDir, p);
    if (dirs.some((d) => inRecord(d, codeDirs, full))) return null;
    const product = codeDirs.filter((c) => inside(c, full));
    return deny(`In a greenfield executor run every change to the project's files goes through the typist (execute_stage "repair"), so every policy changes code the same way; the orchestrator writes only its run's record folder (${dirs.join(", ")})${product.length ? `, never the product in its code folder (${product.join(", ")})` : ""}. Nothing was changed: send this change as a repair failure entry (the file, what must change) instead.`);
  }
  return null;
}

// Run as the hook when this file is the entry point (resolved file URLs, as foreground-helpers.mjs does).
const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === entry) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "null");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === "string" ? input.cwd : process.cwd());
    if (process.argv[2] === "post") record(input, projectDir);
    else { const out = decide(input, projectDir); if (out) process.stdout.write(JSON.stringify(out)); }
  } catch { /* fail open: the guard never breaks a session */ }
}
