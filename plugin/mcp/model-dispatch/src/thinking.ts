/**
 * A run's thinking steps (requirements, the architect, the two reviewers, discovery), on the model the policy names.
 *
 * A step whose rule names a Claude model is the session's: the reply says so, nothing is spent, and the orchestrator
 * delegates its Claude helper as it always has. A step whose rule names an agent-door leaf runs on Gemini through
 * worker/thinking_worker.py: the helper's own instructions, read-only tools that apply the engine's read rule, and
 * hand-in tools that run the same checks the Claude helper's hand-over runs, piece by piece (scripts/thinking-tools.mjs).
 * Gemini works in the project itself and has no tool that can change it; the agent door's before-and-after inventory
 * proves it, and a step that changed a project file is stopped. A step that cannot finish stops the run at that step:
 * no other model takes it over. A gate's revise carries on the same conversation.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { holdsPrivateKey, modelReadOf } from "./apply.js";

import type { ExecutionResult, ModelConfig, Phase, RunContext, TaskPacket, TelemetryEvent } from "./types.js";

export interface ThinkingRole {
  phase: Phase;
  /** Where the helper's instructions come from: its agent file, or the pipeline skill's phase section. */
  instructions: { agent: string } | { skillSection: string };
}

export const THINKING_ROLES: Readonly<Record<string, ThinkingRole>> = Object.freeze({
  requirements: { phase: "requirements_analysis", instructions: { skillSection: "### Phase 1 — requirements_analysis" } },
  architect: { phase: "architecture_design", instructions: { agent: "architect" } },
  "brownfield-architect": { phase: "architecture_design", instructions: { agent: "brownfield-architect" } },
  "senior-reviewer": { phase: "senior_code_review", instructions: { agent: "senior-reviewer" } },
  "brownfield-senior-reviewer": { phase: "senior_code_review", instructions: { agent: "brownfield-senior-reviewer" } },
  "security-reviewer": { phase: "security_review", instructions: { agent: "security-reviewer" } },
  "brownfield-security-reviewer": { phase: "security_review", instructions: { agent: "brownfield-security-reviewer" } },
  discovery: { phase: "discovery", instructions: { agent: "discovery" } },
});

/**
 * How every thinking step is routed, here, at pre-flight's route table and in driver-model-check.mjs: by phase, with
 * these task_type and module values, plus the run's intent. One context everywhere, so the model the run is told is
 * the model the step gets.
 */
export const THINKING_TASK_TYPE = "judgment";
export const THINKING_MODULE = "judgment";

/** A thinking step's own work budget when the policy sets none (thinking_timeout_sec): the longest recorded architect step took about three hours. */
export const DEFAULT_THINKING_TIMEOUT_SEC = 14_400;

export interface ThinkingArgs {
  role: string;
  /** What the orchestrator would put in the Claude helper's delegation prompt. */
  prompt: string;
  project_root: string;
  run_id?: string;
  intent?: string;
  /** The run's own folder, relative to project_root: `.sdlc/runs/<run_id>` in brownfield, `output_dir` in greenfield. */
  output_dir: string;
  code_dir?: string;
  requirements_path?: string;
  /** Senior reviewer: the review.json path, inside output_dir (default <output_dir>/review.json). */
  review_path?: string;
  /**
   * Files the step reads that may lie outside the project (a greenfield brief): each is copied into
   * <output_dir>/inputs/ through the read rule before the step, and the step is told where (stepInputsCopied).
   */
  inputs?: string[];
  /** A gate's revise, or a check's lines to fix: the step carries on its saved conversation with this. */
  revise?: string;
  /**
   * The architect only: the acceptance stage's failure routed to the architect (an install or audit command) and its
   * log_path. The step carries on the architect's conversation and answers as the helper replies: the failures entries
   * for a repair round, or the one line why the brief's fixed stack cannot pass. It changes no spec section.
   */
  acceptance_fix?: string;
}

export type ThinkingReply =
  | { route: "session"; role: string; phase: Phase; model: string; reason: string }
  | { route: "done"; role: string; phase: Phase; model: string; accepted: string[]; cost_usd: number; tokens: ExecutionResult["tokens"]; resumed: boolean; acceptance_fix?: AcceptanceFixAnswer }
  | { route: "stopped"; role: string; phase: Phase; model: string; reason: string; missing?: string[]; accepted?: string[]; cost_usd: number }
  | { route: "halt"; role: string; phase: Phase; model: string; reason: string; cost_usd: number };

/** An acceptance fix's answer: the entries execute_stage repair takes as `failures`, or why no change can pass. */
export type AcceptanceFixAnswer = { failures: unknown[] } | { cannot_pass: string };

export interface ThinkingDeps {
  pluginRoot: string;
  route: (phase: Phase) => { model: ModelConfig; reason: string };
  /** Why an agent-door call may not be sent now (no pre-flight in this server process), or null. */
  agentDoorProblem: () => string | null;
  /** True while a brownfield run's write contract binds the project. */
  contractActive: (projectRoot: string) => boolean;
  thinkingTimeoutSec: number;
  /**
   * The token the spec store knows the run's pre-flight by (executor/tools.ts runToken). A Gemini architect's sections
   * go in with it, as submit_spec_section's do: a new run's header opens a new spec, and an earlier run's unfinalized
   * units never join this run's (review: a stopped run's units were finalized into the Gemini-planned spec).
   */
  runToken?: string;
  dispatch: (packet: TaskPacket, thinking: NonNullable<RunContext["thinking"]>) => Promise<{ result: ExecutionResult; events: TelemetryEvent[] }>;
  record: (events: TelemetryEvent[]) => void;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
}

const isClaudeLeaf = (m: ModelConfig) => m.adapter === "builtin-anthropic" || m.adapter === "claude-cli";

const inside = (root: string, p: string) => {
  const rel = relative(resolve(root), resolve(root, p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const posix = (p: string) => p.split(sep).join("/");

/** The run folder a step writes into: relative, inside the project, and in a brownfield run under `.sdlc/`. */
export function outputDirProblem(projectRoot: string, dir: string, brownfield: boolean): string | null {
  if (typeof dir !== "string" || dir === "" || isAbsolute(dir) || !inside(projectRoot, dir)) return `output_dir '${dir}' must be a folder inside project_root, given relative to it`;
  if (brownfield && posix(relative(resolve(projectRoot), resolve(projectRoot, dir))).split("/")[0] !== ".sdlc") return `output_dir '${dir}' is outside .sdlc/; a brownfield run's thinking steps write only the run's own records`;
  return null;
}

/**
 * A senior reviewer's review file, when the call names one: given relative to project_root and inside the run's own
 * folder, as every hand-in is. Review: one given as `../x` was written beside the project, and one in `src/` into the
 * source, before the step was stopped.
 */
export function reviewPathProblem(projectRoot: string, dir: string, reviewPath: unknown): string | null {
  if (reviewPath === undefined) return null;
  const rel = typeof reviewPath === "string" && reviewPath !== "" && !isAbsolute(reviewPath)
    ? posix(relative(resolve(projectRoot, dir), resolve(projectRoot, reviewPath)))
    : "..";
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `review_path '${String(reviewPath)}' must be a file inside output_dir ('${dir}'), given relative to project_root`;
  return null;
}

/**
 * The paths git does not ignore in the project (tracked files, and untracked ones it would add), from a list relative to
 * project_root. Outside a git work tree, or if git cannot answer, every path is kept: nothing says what is ignored.
 */
export function notIgnoredByGit(projectRoot: string, paths: string[]): string[] {
  if (!paths.length) return paths;
  const r = spawnSync("git", ["-C", projectRoot, "check-ignore", "-z", "--stdin"], { input: paths.join("\0") + "\0", encoding: "utf8", timeout: 30_000 });
  // check-ignore exits 0 when some path is ignored, 1 when none is, and otherwise (128: not a work tree) answers nothing.
  if (r.status !== 0 && r.status !== 1) return paths;
  const ignored = new Set((r.stdout ?? "").split("\0").filter(Boolean));
  return paths.filter((p) => !ignored.has(p));
}

/** A step's own name in its run: its role, and for a senior review with its own review_path, that path too. */
export function stepKey(args: Pick<ThinkingArgs, "role" | "review_path">): string {
  return typeof args.review_path === "string" && args.review_path !== "" ? `${args.role}--${posix(args.review_path).replace(/[^A-Za-z0-9._-]+/g, "_")}` : args.role;
}

/** The largest input file a step is given, as the step's own read_file reads (thinking-tools.mjs MAX_FILE_BYTES). */
const MAX_INPUT_BYTES = 2_000_000;

/**
 * The step's input files, copied into <output_dir>/inputs/ so a step that reads only the project can read them: a
 * greenfield brief usually lies outside it, and the Gemini step could not read it and handed in requirements without it
 * (review). Each must be a regular file the read rule allows by its name (a refused name such as .env, anywhere), by
 * its size, and by its text (a private key's marker); else the step is refused before anything is sent. Returns the
 * copies, relative to project_root, in the order given.
 */
export function stepInputsCopied(projectRoot: string, outputDir: string, inputs: unknown): string[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs) || inputs.some((p) => typeof p !== "string" || p === "")) throw new Error("run_thinking_step: inputs must be a list of file paths");
  const dir = join(projectRoot, outputDir, "inputs");
  const copies: string[] = [];
  const names = new Set<string>();
  for (const given of inputs as string[]) {
    // Judged as every file a model is sent is judged (apply.ts modelReadOf): by the path given, by the file it reaches
    // through links, and by its other names in the project; an input may lie outside the project (a greenfield brief).
    // Review: an input judged by the name given let a link or a hard link to .env be copied in, and then read.
    const read = modelReadOf(projectRoot, given, { outside: true });
    if ("refused" in read) {
      const r = read.refused;
      switch (r.kind) {
        case "missing": throw new Error(`run_thinking_step: input '${given}' does not exist`);
        case "not-a-file": throw new Error(`run_thinking_step: input '${given}' is not a file`);
        case "hard-link": throw new Error(`run_thinking_step: input '${given}' is never sent to a model: it is the same file as an off-limits one, under another name (a hard link)`);
        case "off-limits": throw new Error(`run_thinking_step: input '${given}' is never sent to a model (${r.why}${r.via ? `, reached through a symbolic link as ${r.via}` : ""})`);
        default: throw new Error(`run_thinking_step: input '${given}' cannot be read`);
      }
    }
    const { abs, st } = read;
    if (st.size > MAX_INPUT_BYTES) throw new Error(`run_thinking_step: input '${given}' is ${st.size} bytes, over the ${MAX_INPUT_BYTES} a step reads`);
    const text = readFileSync(abs, "utf8");
    if (holdsPrivateKey(text)) throw new Error(`run_thinking_step: input '${given}' is never sent to a model: it holds a private key`);
    let file = basename(abs);
    for (let n = 2; names.has(file.toLowerCase()); n++) file = `${n}-${basename(abs)}`;
    names.add(file.toLowerCase());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    copies.push(posix(join(outputDir, "inputs", file)));
  }
  return copies;
}

/** The fixed paths each role's hand-in tools write, all relative to project_root. */
export function roleOutputs(role: string, args: ThinkingArgs): Record<string, string> {
  const d = posix(args.output_dir).replace(/\/+$/, "");
  switch (role) {
    case "requirements": return { requirements: `${d}/requirements.md` };
    case "architect": return args.acceptance_fix ? { acceptance_fix: `${d}/acceptance-fix.json` } : { sections_dir: `${d}/spec.sections` };
    case "brownfield-architect": return { sections_dir: `${d}/change.sections` };
    case "senior-reviewer":
    case "brownfield-senior-reviewer": return { review: args.review_path ? posix(args.review_path) : `${d}/review.json` };
    case "security-reviewer":
    case "brownfield-security-reviewer": return { security_review: `${d}/security_review.md` };
    default: return { discovery: `${d}/discovery.md` };
  }
}

/** The helper's instructions as Gemini reads them: the agent file without its frontmatter, or one skill section. */
export function roleInstructions(pluginRoot: string, role: ThinkingRole): string {
  if ("agent" in role.instructions) {
    const text = readFileSync(join(pluginRoot, "agents", `${role.instructions.agent}.md`), "utf8");
    return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  }
  const skill = readFileSync(join(pluginRoot, "skills", "pipeline", "SKILL.md"), "utf8");
  const heading = role.instructions.skillSection;
  const start = skill.indexOf(heading);
  if (start < 0) throw new Error(`pipeline skill has no section '${heading}'`);
  const level = heading.match(/^#+/)![0].length;
  const rest = skill.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return (heading + (next < 0 ? rest : rest.slice(0, next))).trim();
}

/**
 * How a revise's pieces go in again. A greenfield architect's header after finalize opens a new spec (the store moves
 * the approved one aside), so the whole spec goes again, as the architect's own instructions say, and its tools hold
 * the revised spec to every approved unit (review: a revise told to hand in only what changed finalized the spec with
 * an approved unit gone). Every other step's pieces stay where they were handed in.
 */
/** How an acceptance fix's answer goes in: as the architect's instructions say, through its own hand-in. */
export const ACCEPTANCE_FIX_HAND_IN =
  "Read that command's whole output (its log file) with read_file, and look up what you need with registry_versions. " +
  "Then hand in your answer with write_acceptance_fix, as your instructions' acceptance fix says: failures_json, the " +
  "JSON array of failures entries for a repair round ({path, problem, and new_file: true for a file that does not exist " +
  "yet}); or, if the only way to pass is to change what the brief fixes, that one line as cannot_pass. This step " +
  "changes no spec section.";

export function reviseHandIn(role: string): string {
  return role === "architect"
    ? "Hand in header.json again first, then every units file in order, changed or not: a changed one with its new JSON, an unchanged one by its name alone (its file goes as it stands). Then finalize. A unit of the approved spec that the changes remove: name it in finalize's drop."
    : "Edit the pieces you handed in and hand each changed one in again.";
}

/** What Gemini reads before the helper's instructions: its tools, under their names here, and how it hands work in. */
export function preface(role: string): string {
  const handIn: Record<string, string> = {
    requirements: "Hand in requirements.md with write_requirements (the whole document).",
    architect: "Hand in each spec section with submit_section (header.json first, then units-001.json, …): where the instructions say to write a section file and call submit_spec_section, call submit_section with the file's JSON; where they say to submit a file again as it stands, call submit_section with its name alone; then call finalize where they say finalize_spec. For a package version, use registry_versions. An acceptance fix's answer goes in with write_acceptance_fix.",
    "brownfield-architect": "Hand in each change-spec section with write_section (header.json first, then units-001.json, …): where the instructions say to write a section file and check it with plan-lint, call write_section with the file's JSON; it writes and checks it in one step.",
    "senior-reviewer": "Hand in the review JSON with write_review.",
    "brownfield-senior-reviewer": "Read the change with git_diff and read_provenance; run a file check only with run_file_check; hand in review.json with write_review.",
    "security-reviewer": "Run the dependency check with run_dependency_audit; hand in security_review.md with write_review.",
    "brownfield-security-reviewer": "Read the change with git_diff and read_provenance; run the dependency check with run_dependency_audit; hand in security_review.md with write_review.",
    discovery: "Check the baseline with baseline_status; hand in each of your files with write_discovery.",
  };
  return [
    "## How this step runs",
    "",
    "You are running this helper's instructions with tools of your own instead of the ones they name. Read the project",
    "with read_file, list_files and search_files (paths relative to the project root); some files are kept from you by",
    "the run's read rule, and a refusal says so. " + handIn[role],
    "Every piece you hand in is checked at once; a refusal lists every problem: fix the piece and hand it in again.",
    "You have no tool that changes a project file or runs a shell; where the instructions say Write, Edit or Bash for",
    "anything else, there is nothing to do. The step is done when every piece is accepted.",
  ].join("\n");
}

interface SessionRecord { conversation_id?: string }

function readRecord(path: string): SessionRecord {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

export async function runThinkingStep(args: ThinkingArgs, deps: ThinkingDeps): Promise<ThinkingReply> {
  const role = THINKING_ROLES[args.role];
  if (!role) throw new Error(`run_thinking_step: unknown role '${args.role}' (known: ${Object.keys(THINKING_ROLES).join(", ")})`);
  if (!args.project_root) throw new Error("run_thinking_step: project_root is required");
  const brownfield = args.role.startsWith("brownfield-") || args.role === "discovery" || deps.contractActive(args.project_root);
  const dirProblem = outputDirProblem(args.project_root, args.output_dir, brownfield) ?? reviewPathProblem(args.project_root, args.output_dir, args.review_path);
  if (dirProblem) throw new Error(`run_thinking_step: ${dirProblem}`);
  if (args.acceptance_fix !== undefined) {
    if (args.role !== "architect") throw new Error(`run_thinking_step: an acceptance fix is the architect's (role 'architect'), not the ${args.role}'s`);
    if (args.revise) throw new Error("run_thinking_step: pass acceptance_fix or revise, not both: an acceptance fix answers the acceptance stage and changes no spec section");
    if (typeof args.acceptance_fix !== "string" || !args.acceptance_fix.trim()) throw new Error("run_thinking_step: acceptance_fix holds the acceptance receipt's failure and its log_path");
  }
  // The step's inputs, through the read rule, before anything is routed or spent.
  const inputCopies = stepInputsCopied(args.project_root, args.output_dir, args.inputs);

  const { model, reason } = deps.route(role.phase);
  const base = { role: args.role, phase: role.phase, model: model.model_name };
  if (isClaudeLeaf(model)) {
    return { ...base, route: "session", reason: `the policy routes ${role.phase} to ${model.model_name} (${reason}): delegate the ${args.role} helper (or, for requirements, write it yourself) as before` };
  }
  if (model.adapter !== "antigravity-worker") {
    return { ...base, route: "stopped", cost_usd: 0, reason: `the policy routes ${role.phase} to '${model.id}' (${model.adapter}), which is called as a model and cannot read the project; route the phase to an antigravity-worker leaf or a Claude model` };
  }
  const notReady = deps.agentDoorProblem();
  if (notReady) throw new Error(`run_thinking_step: ${notReady}`);

  const outputs = roleOutputs(args.role, args);
  const stepDir = join(args.project_root, args.output_dir, "thinking");
  mkdirSync(stepDir, { recursive: true });
  // Each step keeps its own files, conversation and packet: a run has one step per role, except the senior review,
  // which greenfield runs once per module, each with its own review_path (review: one module's revise resumed another
  // module's conversation, and both read one brief).
  const key = stepKey(args);
  const toolsConfig = join(stepDir, `${key}.tools.json`);
  const recordPath = join(stepDir, `${key}.json`);
  const saveDir = join(stepDir, `${key}.save`);
  writeFileSync(toolsConfig, JSON.stringify({
    role: args.role, project_root: resolve(args.project_root), run_id: args.run_id, intent: args.intent,
    output_dir: posix(args.output_dir), outputs, spec_dir: posix(args.output_dir), requirements_path: args.requirements_path, code_dir: args.code_dir,
    run_token: deps.runToken, revise: !!args.revise, acceptance_fix: !!args.acceptance_fix,
  }, null, 2));

  const prior = readRecord(recordPath).conversation_id;
  // A revise and an acceptance fix carry on the step's saved conversation: the model keeps what it read and decided.
  const resumeId = (args.revise || args.acceptance_fix) && prior ? prior : undefined;
  const fix = args.acceptance_fix ? `An install or audit command of the acceptance list failed.\n\n${args.acceptance_fix}\n\n${ACCEPTANCE_FIX_HAND_IN}` : "";
  const instruction = resumeId
    ? (fix ? `Acceptance fix: ${fix}` : `Changes asked for this step:\n\n${args.revise}\n\n${reviseHandIn(args.role)}`)
    : `${preface(args.role)}\n\n## The helper's instructions\n\n${roleInstructions(deps.pluginRoot, role)}\n\n## This invocation\n\n${args.prompt}${inputCopies.length ? `\n\n## The step's input files\n\nCopied into the project for you, in the order given (read each with read_file):\n${inputCopies.map((c) => `- ${c}`).join("\n")}` : ""}${args.revise ? `\n\n## Changes asked for\n\n${args.revise}\n\n${reviseHandIn(args.role)}` : ""}${fix ? `\n\n## Acceptance fix\n\n${fix}` : ""}`;
  const packet: TaskPacket = {
    id: `${args.run_id ?? "run"}-${key}`,
    phase: role.phase,
    task_type: THINKING_TASK_TYPE,
    module: THINKING_MODULE,
    ...(args.intent ? { intent: args.intent } : {}),
    instruction,
    inputs: [],
    outputSchema: { __free_text__: true },
    acceptance: Object.values(outputs).map((o) => `${o} handed in and accepted`),
    budget: { maxInputTokens: 0, maxOutputTokens: 0 },
    pass_id: args.run_id ?? "thinking",
  };

  deps.log("info", "thinking.start", { role: args.role, phase: role.phase, model: model.model_name, resumed: !!resumeId });
  const { result, events } = await deps.dispatch(packet, { role: args.role, toolsConfig, saveDir, resumeId, timeoutSec: deps.thinkingTimeoutSec });
  deps.record(events.map((e) => ({ ...e, judgment_role: args.role })));
  const summary = (result.result ?? {}) as { done?: boolean; missing?: string[]; accepted?: string[]; conversation_id?: string };
  if (summary.conversation_id) writeFileSync(recordPath, JSON.stringify({ conversation_id: summary.conversation_id }) + "\n");

  const stop = (why: string, missing?: string[]): ThinkingReply => {
    deps.log("warn", "thinking.stopped", { role: args.role, phase: role.phase, model: model.model_name, reason: why });
    return { ...base, route: "stopped", reason: why, ...(missing?.length ? { missing } : {}), ...(summary.accepted?.length ? { accepted: summary.accepted } : {}), cost_usd: result.cost_usd };
  };
  if (result.halt) {
    deps.log("warn", "thinking.halt", { role: args.role, phase: role.phase, model: model.model_name, reason: result.halt });
    return { ...base, route: "halt", reason: result.halt, cost_usd: result.cost_usd };
  }
  // Gemini has no tool that writes the project; any change outside the step's own folders means something else
  // did, or a tool misbehaved: nothing from the step is used.
  const own = [posix(args.output_dir).replace(/\/+$/, "") + "/", ".sdlc/"];
  // What git ignores is not the project's own: a check the step ran writes it (a test runner's cache, an OS's folder
  // file), and git never sees it (review: pytest's cache stopped a finished step). A file git tracks, or would add,
  // still stops the step.
  const changed = notIgnoredByGit(args.project_root, (result.workspace_changes ?? []).map(posix).filter((p) => !own.some((o) => p.startsWith(o))));
  if (changed.length) return stop(`project files changed while the step ran: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""}`);
  if (!result.success && !summary.done) return stop(`the ${model.model_name} step could not finish: ${result.error ?? "no reason given"}`, summary.missing);
  if (!summary.done) return stop(`the ${model.model_name} step ended with pieces still owed`, summary.missing);
  // Every piece is handed in and accepted by the checks a Claude helper's hand-over runs: the step is done, even when
  // its last turn ended with an error (review: a fully accepted step was reported stopped and its work thrown away).
  if (!result.success) deps.log("warn", "thinking.done_after_error", { role: args.role, phase: role.phase, model: model.model_name, reason: result.error });
  // An acceptance fix's answer goes back in the reply, as the helper's reply does: the run's repair round takes it.
  let answer: AcceptanceFixAnswer | undefined;
  if (outputs.acceptance_fix) {
    try { answer = JSON.parse(readFileSync(join(args.project_root, outputs.acceptance_fix), "utf8")); } catch (e: any) {
      return stop(`the acceptance fix was accepted, but ${outputs.acceptance_fix} cannot be read: ${e?.message ?? e}`);
    }
  }
  deps.log("info", "thinking.end", { role: args.role, phase: role.phase, model: model.model_name, accepted: (summary.accepted ?? []).length, cost_usd: result.cost_usd });
  return { ...base, route: "done", accepted: summary.accepted ?? [], cost_usd: result.cost_usd, tokens: result.tokens, resumed: !!resumeId, ...(answer ? { acceptance_fix: answer } : {}) };
}
