/**
 * A run's thinking steps (requirements, the architect, the two reviewers), on the model the policy names.
 *
 * A step whose rule names a Claude model is the session's: the reply says so, nothing is spent, and the orchestrator
 * delegates its Claude helper as it always has. A step whose rule names an agent-door leaf runs on Gemini through
 * worker/thinking_worker.py: the helper's own instructions as the session's system instructions, read-only tools that
 * apply the engine's read rule, and hand-in tools that run the same checks the Claude helper's hand-over runs, piece by
 * piece (scripts/thinking-tools.mjs).
 * Gemini works in the project itself and has no tool that can change it; the agent door's before-and-after inventory
 * proves it, and a step that changed a project file is stopped. A step that cannot finish stops the run at that step:
 * no other model takes it over. A gate's revise carries on the same conversation. A worker the agent door's kill rule
 * stopped (frozen, or past a call's bound) is carried on once from the conversation it saved, with what its tools had
 * accepted and what is left of the step's own work budget.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix as posixPath, relative, resolve, sep } from "node:path";

import { holdsPrivateKey, modelReadOf, withoutProtectedText } from "./apply.js";
import { evidenceDir, takeInventory } from "./delegation/evidence.js";
import { loggerTouched } from "./log.js";
import { round6 } from "./pricing.js";
import { openedSpec, PREVIOUS_DIR, SPEC_RECORDS } from "./spec/store.js";

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
  /** Where the run's telemetry goes (absolute; server.ts makes it so): the step's events, and beside it the dispatch's evidence. */
  telemetry_path?: string;
  /**
   * The architect only: the acceptance stage's failure routed to the architect (an install or audit command) and its
   * log_path. The step carries on the architect's conversation and answers as the helper replies: the failures entries
   * for a repair round, or the one line why the brief's fixed stack cannot pass. It changes no spec section.
   */
  acceptance_fix?: string;
}

export type ThinkingReply =
  | { route: "session"; role: string; phase: Phase; model: string; reason: string }
  | { route: "done"; role: string; phase: Phase; model: string; accepted: string[]; cost_usd: number; tokens: ExecutionResult["tokens"]; resumed: boolean; change_check: string; acceptance_fix?: AcceptanceFixAnswer }
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

/** The run's folder as one spelling: `./out/` and `out` are the same folder (review: `./out` stopped a clean step). */
export function runFolder(outputDir: string): string {
  return posixPath.normalize(posix(outputDir)).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The run folder a step writes into: relative, inside the project, and in a brownfield run exactly the run's own
 * records folder, `.sdlc/runs/<run_id>` (review: any folder under .sdlc was accepted, and the change check then spared
 * all of it, the write contract included).
 */
export function outputDirProblem(projectRoot: string, dir: string, brownfield: boolean, runId?: string): string | null {
  if (typeof dir !== "string" || dir === "" || isAbsolute(dir) || !inside(projectRoot, dir)) return `output_dir '${dir}' must be a folder inside project_root, given relative to it`;
  if (brownfield && posix(relative(resolve(projectRoot), resolve(projectRoot, dir))).split("/")[0] !== ".sdlc") return `output_dir '${dir}' is outside .sdlc/; a brownfield run's thinking steps write only the run's own records`;
  if (brownfield && typeof runId === "string" && runFolder(dir) !== `.sdlc/runs/${runId}`) return `output_dir '${dir}' must be the run's own folder, .sdlc/runs/${runId}`;
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

/**
 * A folder or file the manager names for the step (code_dir, requirements_path): given relative to project_root and
 * inside it, as output_dir is. Review: both were used as given, so a step could be pointed outside the project.
 */
export function projectPathProblem(projectRoot: string, p: unknown, label: string, opts: { root?: boolean } = {}): string | null {
  if (p === undefined) return null;
  // With `root`, the project folder itself is the path's own answer: the code under review can be the whole project
  // (live test of 0.10.1: a brownfield senior review given code_dir "." was refused as outside the project).
  const isRoot = typeof p === "string" && p !== "" && !isAbsolute(p) && relative(resolve(projectRoot), resolve(projectRoot, p)) === "";
  if (opts.root && isRoot) return null;
  if (typeof p !== "string" || p === "" || isAbsolute(p) || !inside(projectRoot, p)) return `${label} '${String(p)}' must be inside project_root, given relative to it`;
  return null;
}

/** Where the plugin's stack notes are named in the helpers' instructions, a folder outside the project. */
const PLUGIN_STACKS = "${CLAUDE_PLUGIN_ROOT}/skills/pipeline/stacks/";

/** The step's own folders in its run's folder: its records (conversation, packet, tools' state) and its input copies. */
const STEP_RECORDS_DIR = "thinking";
const STEP_INPUTS_DIR = "inputs";

/**
 * The helper's instructions as this step reads them: where they name the plugin's stack notes, which lie outside the
 * project and so outside the step's tools, the notes are copied into the run's inputs and named there (review: the
 * Gemini brownfield architect could not read nest.md, which its instructions require).
 */
export function stepInstructions(pluginRoot: string, role: ThinkingRole, projectRoot: string, outputDir: string): string {
  const text = roleInstructions(pluginRoot, role);
  if (!text.includes(PLUGIN_STACKS)) return text;
  const rel = `${runFolder(outputDir)}/${STEP_INPUTS_DIR}/plugin-stacks`;
  const from = join(pluginRoot, "skills", "pipeline", "stacks");
  mkdirSync(join(projectRoot, rel), { recursive: true });
  for (const f of readdirSync(from)) if (f.endsWith(".md")) copyFileSync(join(from, f), join(projectRoot, rel, f));
  return text.split(PLUGIN_STACKS).join(`${rel}/`);
}

/**
 * What git shows of the project: its HEAD, and every file git does not ignore that differs from HEAD or is new, each
 * with its contents' hash; null outside a git work tree. Taken before and after a thinking step, it sees a change
 * wherever git does: in a build or cache folder git does not ignore, in a file of any size, among any number of files
 * (review: the walked inventory passed changes under build/, past 20,000 files, and same-size ones over 2 MB).
 */
export interface ProjectSnapshot { head: string | null; files: Map<string, string> }
export function projectSnapshot(projectRoot: string, walk: string[] = []): ProjectSnapshot | null {
  const git = (args: string[]) => spawnSync("git", ["-C", projectRoot, ...args], { encoding: "buffer", timeout: 120_000, maxBuffer: 512_000_000 });
  const tree = git(["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  const [isTree, prefix = ""] = tree.status === 0 ? tree.stdout.toString("utf8").split("\n") : [];
  if (isTree !== "true") return null;
  const head = git(["rev-parse", "-q", "--verify", "HEAD"]);
  // Porcelain paths are the repository's; `-- .` keeps them to the project, and the project's own prefix is dropped.
  const status = git(["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."]);
  if (status.status !== 0) return null;
  const files = new Map<string, string>();
  for (const entry of status.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const repoPath = entry.slice(3);
    const rel = prefix && repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
    let hash = "absent";
    try { hash = createHash("sha256").update(readFileSync(join(projectRoot, rel))).digest("hex"); } catch { /* deleted, or not a file */ }
    files.set(rel, `${entry.slice(0, 2)}:${hash}`);
  }
  // The code under review is the project's whatever git ignores: a folder of it that git ignores (this repo's own
  // /mmo:pass layout, examples/*/passes/*/) is walked as 0.10.0 walked every step's project, skipping what the walk
  // skips (an install's node_modules, caches), so a change to that code during a review is seen (review of 0.10.1).
  for (const folder of walk) {
    if (!folder || folder === "." || git(["check-ignore", "-q", "--", folder]).status !== 0) continue;
    for (const e of takeInventory(join(projectRoot, folder)).entries) files.set(posixPath.join(folder, e.path), `walked:${e.digest}`);
  }
  return { head: head.status === 0 ? head.stdout.toString("utf8").trim() : null, files };
}

/** The project files that differ between two snapshots, and a moved HEAD (a commit made, or another one checked out). */
export function snapshotChanges(before: ProjectSnapshot, after: ProjectSnapshot): string[] {
  const out = new Set<string>();
  for (const [p, v] of after.files) if (before.files.get(p) !== v) out.add(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) out.add(p);
  const changed = [...out].sort();
  if (before.head !== after.head) changed.unshift(`the checked-out commit (${before.head ?? "none"} to ${after.head ?? "none"})`);
  return changed;
}

/** Files an operating system writes on its own beside a project's (a file browser's folder records): never its content. */
const OS_FILES = /(^|\/)(\.DS_Store|\._[^/]+|Thumbs\.db|desktop\.ini|Icon\r)$/i;

/**
 * Caches a check's tools write on their own beside the code, never its content: Python's bytecode, the caches of pytest,
 * mypy, ruff and Hypothesis, TypeScript's build info, ESLint's cache and the tools' cache under node_modules. A step's
 * own checks write them, in a repo whose .gitignore may not name them (review of 0.10.1: a reviewer's check wrote one
 * and the finished review was stopped). A source file a check changes is still a change.
 */
const CACHE_FILES = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.hypothesis)\/|(^|\/)node_modules\/\.cache\/|\.py[co]$|\.tsbuildinfo$|(^|\/)\.eslintcache$/;

/**
 * What a step itself writes, which its change check spares, each named by the code that writes it: in brownfield the
 * run's own records folder; in greenfield the step's records and input copies, each piece it hands in, the records the
 * spec store keeps for an architect's spec (spec/store.ts), and the dispatch's evidence and telemetry
 * (delegation/evidence.ts). The plugin's logger reports the files it writes itself (stepOwns). Not the rest of the
 * run's folder: under /mmo:pass the code under review lies inside it (review: a change to it during a review went
 * unseen, as did one to .sdlc/project.json).
 */
export function stepOwnPaths(args: ThinkingArgs, outputs: Record<string, string>, brownfield: boolean): string[] {
  const d = runFolder(args.output_dir);
  if (brownfield) return [`${d}/`];
  const own = [`${d}/${STEP_RECORDS_DIR}/`, `${d}/${STEP_INPUTS_DIR}/`];
  for (const [key, p] of Object.entries(outputs)) own.push(key === "sections_dir" ? `${runFolder(p)}/` : runFolder(p));
  // A header that opens a new spec moves the earlier spec's records, files and folders, under PREVIOUS_DIR (store.ts
  // moveAside), in the folder the architect's tools are given as spec_dir: the run's (review of 0.10.1: a copy of the
  // store's list here missed five of its eight records, so a step that only opened a new spec was stopped).
  if (args.role === "architect") own.push(...SPEC_RECORDS.flatMap((n) => [`${d}/${n}`, `${d}/${n}/`]), `${d}/${PREVIOUS_DIR}/`);
  // The dispatch records each call in the run's telemetry and keeps its evidence where evidenceDir puts it, from the
  // same telemetry path and workspace the step's dispatch is given (server.ts: work_dir is the project).
  const root = resolve(args.project_root);
  const inProject = (abs: string): string | null => {
    const rel = posix(relative(root, abs));
    return rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel;
  };
  const telemetry = typeof args.telemetry_path === "string" && args.telemetry_path ? resolve(root, args.telemetry_path) : undefined;
  const t = telemetry === undefined ? null : inProject(telemetry);
  if (t !== null) own.push(t);
  const evidence = inProject(evidenceDir(telemetry, root));
  if (evidence !== null) own.push(`${evidence}/`);
  return own;
}

/**
 * Whether a path the change check found is the step's own (stepOwnPaths): under one of its folders, one of its files,
 * an operating system's own file, a cache a check's tools write (CACHE_FILES), or a file the plugin's logger touched while the server ran (log.ts loggerTouched): its
 * log, the pieces it rotated out, its lock. The logger is asked rather than its names copied (live test of 0.10.1: the
 * log it wrote beside the run's telemetry stopped a step whose requirements were accepted).
 */
export function stepOwns(own: string[], p: string, projectRoot: string): boolean {
  return OS_FILES.test(p) || CACHE_FILES.test(p) || own.some((o) => (o.endsWith("/") ? p.startsWith(o) : p === o)) || loggerTouched(join(projectRoot, p));
}

/**
 * A step's own name in its run: its role, and for a senior review with its own review_path, that path too, readable
 * (each run of other characters made "_") and followed by 8 hex characters of the path's sha256, so two paths that read
 * the same (out/m1/review.json and out/m1_review.json) never share one step's files (review: they did). The path is
 * taken in one spelling (runFolder), so ./out/m1/review.json is the same step as out/m1/review.json.
 */
export function stepKey(args: Pick<ThinkingArgs, "role" | "review_path">): string {
  if (typeof args.review_path !== "string" || args.review_path === "") return args.role;
  const path = runFolder(args.review_path);
  return `${args.role}--${path.replace(/[^A-Za-z0-9._-]+/g, "_")}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
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
  const dir = join(projectRoot, outputDir, STEP_INPUTS_DIR);
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
    copies.push(posix(join(outputDir, STEP_INPUTS_DIR, file)));
  }
  return copies;
}

/** The fixed paths each role's hand-in tools write, all relative to project_root. */
export function roleOutputs(role: string, args: ThinkingArgs): Record<string, string> {
  const d = runFolder(args.output_dir);
  switch (role) {
    case "requirements": return { requirements: `${d}/requirements.md` };
    case "architect": return args.acceptance_fix ? { acceptance_fix: `${d}/acceptance-fix.json` } : { sections_dir: `${d}/spec.sections` };
    case "brownfield-architect": return { sections_dir: `${d}/change.sections` };
    case "senior-reviewer":
    case "brownfield-senior-reviewer": return { review: args.review_path ? posix(args.review_path) : `${d}/review.json` };
    case "security-reviewer":
    case "brownfield-security-reviewer": return { security_review: `${d}/security_review.md` };
    default: throw new Error(`run_thinking_step: no hand-in paths for role '${role}'`);
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

/** How many reminders in a row a Gemini step may answer without progress (worker/thinking_worker.py NO_PROGRESS_TURNS; a test holds the two equal). */
export const NO_PROGRESS_TURNS = 3;

/**
 * Why a Gemini step stopped with pieces owed, by its worker's summary `reason` (worker/thinking_worker.py), in the
 * reply's words; with `detail`, the dispatch's own error follows, where it says what happened.
 */
const WORKER_STOPS: Readonly<Record<string, { words: (timeoutSec: number) => string; detail: boolean }>> = {
  budget: { words: (t) => `its own work time reached the policy's limit, thinking_timeout_sec (${t} s, the time Google held or refused its calls not counted)`, detail: false },
  no_progress: { words: () => `no progress for ${NO_PROGRESS_TURNS} turns in a row`, detail: false },
  busy: { words: () => "Google could not serve the model for the run's busy window", detail: true },
  tool_dead: { words: () => "the step's tools failed", detail: true },
  stopped: { words: () => "the worker was stopped", detail: true },
  error: { words: () => "its model call ended with an error", detail: true },
};

/**
 * A step's reason when it stopped with pieces owed: why its worker stopped, in plain words, then what is still owed
 * (review: the reply said "ended with pieces still owed" whatever stopped the step). A worker that gave no reason
 * (killed before it could say) is told by its dispatch's error.
 */
export function stoppedReason(model: string, summary: { reason?: string | null; missing?: string[] }, result: Pick<ExecutionResult, "success" | "error">, timeoutSec: number): string {
  const stop = summary.reason ? WORKER_STOPS[summary.reason] : undefined;
  const why = stop
    ? `stopped: ${stop.words(timeoutSec)}${stop.detail && result.error ? ` (${result.error})` : ""}`
    : !result.success ? `could not finish: ${result.error ?? "no reason given"}` : "ended with pieces still owed";
  return `the ${model} step ${why}${summary.missing?.length ? `; still owed: ${summary.missing.join("; ")}` : ""}`;
}

/**
 * The pieces of this run's finalized spec in `specDir` (its header, each units file, finalize), or null when the spec
 * there is not this run's (another pre-flight's token, or none to tell) or is not finalized (spec.json is written only by
 * a passing finalize, and a header after it moves it aside).
 */
function finalizedSpecOf(specDir: string, runToken: string | undefined, sectionsDir: string): string[] | null {
  if (!runToken || openedSpec(specDir)?.run !== runToken || !existsSync(join(specDir, "spec.json"))) return null;
  const units = existsSync(sectionsDir) ? readdirSync(sectionsDir).filter((f) => /^units-\d{3}\.json$/.test(f)).sort() : [];
  return ["header.json", ...units, "finalize"];
}

interface SessionRecord { conversation_id?: string }

function readRecord(path: string): SessionRecord {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

/**
 * The worker's summary of a dispatch (thinking_worker.py): whether the step is done, what it owes and has, its
 * conversation, why it stopped (`reason`), with `reason: "setup"` what in the step's own setup kept a hand-in from
 * being checked (`setup_error`), and whether a session of its own answered (so that conversation holds a turn that
 * ended in a harness that closed).
 */
export interface StepSummary { done?: boolean; missing?: string[]; accepted?: string[]; conversation_id?: string; reason?: string | null; setup_error?: string; answered?: boolean }

/**
 * Whether a dispatch is carried on, and with how much of the step's budget: its worker was killed by the agent door's
 * kill rule (no heartbeat, or a heartbeat past a bound: executor/stall.ts), it kept a conversation that holds a turn of
 * its own that answered and is not done, and its own work so far (the worker's own clock, from its receipt or its last
 * heartbeat) leaves part of the budget. The seconds left, whole, or null. A worker the person stopped, or one that
 * ended by itself, is never carried on, nor one whose work time is not known. Nor one stopped before a session of its
 * own answered: a conversation whose turn ended in a harness that closed is what the SDK has been shown to resume, and
 * that interrupted turn (for a revise, its comments) may not be saved.
 */
export function carryOnBudget(result: ExecutionResult, summary: StepSummary, budgetSec: number): number | null {
  if (result.worker_stopped !== "killed" || result.halt || summary.done || !summary.conversation_id || summary.answered !== true) return null;
  const record = result.attempts?.[result.attempts.length - 1]?.gemini;
  const workMs = record && "work_ms" in record ? record.work_ms : undefined;
  if (typeof workMs !== "number" || !Number.isFinite(workMs)) return null;
  const left = Math.floor(budgetSec - workMs / 1000);
  return left > 0 ? left : null;
}

/** Several dispatches' tokens, field by field. */
function sumTokens(results: ExecutionResult[]): ExecutionResult["tokens"] {
  const out: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.tokens ?? {})) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return { input: 0, input_cached: 0, output: 0, ...out } as ExecutionResult["tokens"];
}

interface StepLock { pid?: unknown; started_at?: unknown; token?: unknown }

/** A step's lock as its file holds it; undefined when there is none, null when it cannot be read. */
function readLock(path: string): StepLock | null | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? undefined : null; }
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** Whether a process runs with this id: process.kill(pid, 0) sends no signal, and fails with ESRCH when there is none. */
function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** The tokens of the step locks this server's calls hold now. */
const HELD_LOCKS = new Set<string>();

/**
 * Whether a lock is held by a call that still runs. One with this server's process id is live only while a call of
 * this server holds it: else it was left by an earlier server that had the same id (ids start again after a restart).
 */
function lockLive(lock: StepLock): boolean {
  return lock.pid === process.pid ? typeof lock.token === "string" && HELD_LOCKS.has(lock.token) : processAlive(lock.pid);
}

/** A step as a person names it: its role, its review file when it has one, and its run. */
function stepName(args: ThinkingArgs): string {
  return `the ${args.role} step${args.review_path ? ` for ${args.review_path}` : ""}${args.run_id ? ` of run ${args.run_id}` : ""}`;
}

/**
 * One call of a step at a time. The call holds `<stepDir>/<key>.lock`, created exclusively and holding the server's
 * process id and the call's start time; it is removed when the call returns. A second call of the step while it is held
 * is refused before it writes anything, so two workers never share one save folder, tools config, record and packet
 * (review: nothing refused it). A lock whose call no longer runs is taken over: its process is gone (process.kill(pid,
 * 0) finds none: the server stopped mid-step), or it names this server's process id but no call of this server holds
 * it, or it cannot be read. In one server, taking the lock is one synchronous step, so two calls there can never both
 * hold it; between servers, a lock being taken over is first moved aside, in one step, and one that turns out to be
 * another call's live lock is put back. Returns the release.
 */
export function takeStepLock(lockPath: string, step: string): () => void {
  const mine = { pid: process.pid, started_at: new Date().toISOString(), token: randomUUID() };
  const running = (held: StepLock) => new Error(`run_thinking_step: ${step} is already running (process ${String(held.pid)}, since ${String(held.started_at)}; its lock is ${lockPath}); nothing was sent. Two calls of one step would share its save folder, tools config and record: wait for that call to return.`);
  for (let tries = 0; ; tries++) {
    try { writeFileSync(lockPath, JSON.stringify(mine) + "\n", { flag: "wx" }); break; } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
    if (tries >= 3) throw new Error(`run_thinking_step: ${step} could not take its lock ${lockPath}; nothing was sent`);
    const held = readLock(lockPath);
    if (held === undefined) continue;
    if (held && lockLive(held)) throw running(held);
    const aside = `${lockPath}.${mine.token}.stale`;
    try { renameSync(lockPath, aside); } catch (e: any) { if (e?.code === "ENOENT") continue; throw e; }
    const moved = readLock(aside);
    if (moved && moved.token !== held?.token && lockLive(moved)) {
      try { writeFileSync(lockPath, readFileSync(aside), { flag: "wx" }); } catch { /* a third call holds it now */ }
      rmSync(aside, { force: true });
      throw running(moved);
    }
    rmSync(aside, { force: true });
  }
  HELD_LOCKS.add(mine.token);
  return () => {
    HELD_LOCKS.delete(mine.token);
    if (readLock(lockPath)?.token === mine.token) rmSync(lockPath, { force: true });
  };
}

export async function runThinkingStep(args: ThinkingArgs, deps: ThinkingDeps): Promise<ThinkingReply> {
  const role = THINKING_ROLES[args.role];
  if (!role) throw new Error(`run_thinking_step: unknown role '${args.role}' (known: ${Object.keys(THINKING_ROLES).join(", ")})`);
  if (!args.project_root) throw new Error("run_thinking_step: project_root is required");
  const brownfield = args.role.startsWith("brownfield-") || deps.contractActive(args.project_root);
  const dirProblem = outputDirProblem(args.project_root, args.output_dir, brownfield, args.run_id) ?? reviewPathProblem(args.project_root, args.output_dir, args.review_path);
  if (dirProblem) throw new Error(`run_thinking_step: ${dirProblem}`);
  const pathProblem = projectPathProblem(args.project_root, args.code_dir, "code_dir", { root: true }) ?? projectPathProblem(args.project_root, args.requirements_path, "requirements_path");
  if (pathProblem) throw new Error(`run_thinking_step: ${pathProblem}`);
  // The greenfield architect's finalize checks that every requirement is covered, against requirements_path; without
  // one it finalized unchecked (review). Its default is the run's own requirements.md, which the requirements step
  // hands in there, and a design step with no such file is refused before anything is sent.
  let requirementsPath = args.requirements_path;
  if (args.role === "architect" && args.acceptance_fix === undefined) {
    requirementsPath ??= `${runFolder(args.output_dir)}/requirements.md`;
    if (!existsSync(join(args.project_root, requirementsPath))) throw new Error(`run_thinking_step: the architect checks every requirement is covered against requirements_path '${requirementsPath}', which names no file`);
  }
  if (args.acceptance_fix !== undefined) {
    if (args.role !== "architect") throw new Error(`run_thinking_step: an acceptance fix is the architect's (role 'architect'), not the ${args.role}'s`);
    if (args.revise) throw new Error("run_thinking_step: pass acceptance_fix or revise, not both: an acceptance fix answers the acceptance stage and changes no spec section");
    if (typeof args.acceptance_fix !== "string" || !args.acceptance_fix.trim()) throw new Error("run_thinking_step: acceptance_fix holds the acceptance receipt's failure and its log_path");
  }
  const stepDir = join(args.project_root, args.output_dir, STEP_RECORDS_DIR);
  mkdirSync(stepDir, { recursive: true });
  // Each step keeps its own files, conversation and packet: a run has one step per role, except the senior review,
  // which greenfield runs once per module, each with its own review_path (review: one module's revise resumed another
  // module's conversation, and both read one brief). One call of a step runs at a time: a second call while it runs is
  // refused before it writes anything of the step's, its input copies and tools config included (takeStepLock).
  const key = stepKey(args);
  const release = takeStepLock(join(stepDir, `${key}.lock`), stepName(args));
  try {
    return await lockedStep(args, deps, role, brownfield, requirementsPath, stepDir, key);
  } finally {
    release();
  }
}

/** The step itself, while its call holds the step's lock: its inputs, its route, its dispatch and its reply. */
async function lockedStep(args: ThinkingArgs, deps: ThinkingDeps, role: ThinkingRole, brownfield: boolean, requirementsPath: string | undefined, stepDir: string, key: string): Promise<ThinkingReply> {
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
  // An architect called again in the run whose spec it finalized (no revise, no acceptance fix) owes nothing: the step
  // is done, and nothing is sent (review of the hand-in fixes: Gemini was paid for a turn that could at best finalize
  // the spec again, or hand its header in first, which opens a new spec and moves the approved one aside). A new
  // pre-flight is a new run token, whose architect writes its own spec.
  if (args.role === "architect" && !args.revise && args.acceptance_fix === undefined) {
    const pieces = finalizedSpecOf(join(args.project_root, runFolder(args.output_dir)), deps.runToken, join(args.project_root, outputs.sections_dir));
    if (pieces) {
      deps.log("info", "thinking.already_done", { role: args.role, phase: role.phase, model: model.model_name });
      return { ...base, route: "done", accepted: pieces, cost_usd: 0, tokens: { input: 0, input_cached: 0, output: 0 }, resumed: false, change_check: "none: nothing ran" };
    }
  }
  const instructions = stepInstructions(deps.pluginRoot, role, args.project_root, args.output_dir);
  const toolsConfig = join(stepDir, `${key}.tools.json`);
  const recordPath = join(stepDir, `${key}.json`);
  const saveDir = join(stepDir, `${key}.save`);
  // The step's tools keep what they accepted, refused and wrote in this file on every change (thinking-tools.mjs), so a
  // dispatch that carries on one the kill rule stopped starts from it (carry_on). An earlier step's file is removed
  // first: a step that is not carried on starts empty, even if its tools never start.
  const stateFile = resolve(stepDir, `${key}.state.json`);
  rmSync(stateFile, { force: true });
  const writeToolsConfig = (carryOn: boolean) => writeFileSync(toolsConfig, JSON.stringify({
    role: args.role, project_root: resolve(args.project_root), run_id: args.run_id, intent: args.intent,
    output_dir: runFolder(args.output_dir), outputs, spec_dir: runFolder(args.output_dir), requirements_path: requirementsPath, code_dir: args.code_dir,
    run_token: deps.runToken, revise: !!args.revise, acceptance_fix: !!args.acceptance_fix, state_file: stateFile, carry_on: carryOn,
  }, null, 2));
  writeToolsConfig(false);

  const prior = readRecord(recordPath).conversation_id;
  // A revise and an acceptance fix carry on the step's saved conversation: the model keeps what it read and decided.
  const resumeId = (args.revise || args.acceptance_fix) && prior ? prior : undefined;
  const fix = args.acceptance_fix ? `An install or audit command of the acceptance list failed.\n\n${args.acceptance_fix}\n\n${ACCEPTANCE_FIX_HAND_IN}` : "";
  // How the step runs and the helper's instructions are the session's system instructions, which the SDK keeps
  // whatever it trims from a long conversation (review: as the first user message, a long step's trimmed history could
  // drop them); the task is the first message. A resumed conversation is given the same system text again.
  const system = `${preface(args.role)}\n\n## The helper's instructions\n\n${instructions}`;
  // What the step is told leaves for the model here: the read rule's text never goes with it, whatever the session
  // wrote into the prompt, a revise or an acceptance failure's output (review of 0.10.1; apply.ts withoutProtectedText).
  const task = withoutProtectedText(args.project_root, resumeId
    ? (fix ? `Acceptance fix: ${fix}` : `Changes asked for this step:\n\n${args.revise}\n\n${reviseHandIn(args.role)}`)
    : `## This invocation\n\n${args.prompt}${inputCopies.length ? `\n\n## The step's input files\n\nCopied into the project for you, in the order given (read each with read_file):\n${inputCopies.map((c) => `- ${c}`).join("\n")}` : ""}${args.revise ? `\n\n## Changes asked for\n\n${args.revise}\n\n${reviseHandIn(args.role)}` : ""}${fix ? `\n\n## Acceptance fix\n\n${fix}` : ""}`);
  // The packet's instruction is the whole text, as before: the step's record of what the model is told. Only how it
  // reaches the SDK changed (thinking.system and thinking.task, below).
  const instruction = resumeId ? task : `${system}\n\n${task}`;
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
  // The code under review is walked where git ignores it (projectSnapshot).
  const reviewed = typeof args.code_dir === "string" && args.code_dir ? [runFolder(args.code_dir)] : [];
  const before = projectSnapshot(args.project_root, reviewed);
  // Gemini has no tool that writes the project; any change outside what the step itself writes means something else
  // did, or a tool misbehaved: nothing from the step is used. In a git work tree the check is git's own view of the
  // project, before and after; what git ignores is not the project's (a test runner's cache: review, pytest's cache
  // stopped a finished step). Outside git it is the workers' walked inventories, which the reply calls partial.
  const own = stepOwnPaths(args, outputs, brownfield);
  const mine = (p: string) => stepOwns(own, p, args.project_root);
  const dispatched: ExecutionResult[] = [];
  let checkedByGit = false;
  const changedSince = (): string[] => {
    const after = before ? projectSnapshot(args.project_root, reviewed) : null;
    checkedByGit = before !== null && after !== null;
    const seen = before && after ? snapshotChanges(before, after) : notIgnoredByGit(args.project_root, dispatched.flatMap((r) => r.workspace_changes ?? []).map((p) => runFolder(p)));
    return seen.filter((p) => !mine(p));
  };
  const send = async (thinking: NonNullable<RunContext["thinking"]>) => {
    const { result, events } = await deps.dispatch(packet, thinking);
    dispatched.push(result);
    const changed = changedSince();
    deps.record(events.map((e) => ({ ...e, judgment_role: args.role })));
    const summary = (result.result ?? {}) as StepSummary;
    if (summary.conversation_id) writeFileSync(recordPath, JSON.stringify({ conversation_id: summary.conversation_id }) + "\n");
    return { result, summary, changed };
  };
  let { result, summary, changed } = await send({ role: args.role, toolsConfig, saveDir, resumeId, carryOn: false, timeoutSec: deps.thinkingTimeoutSec, system, task });
  // A worker the kill rule stopped (frozen, or past a call's bound) is carried on once, from the conversation it saved,
  // its tools starting from what the killed ones had accepted, with what is left of the step's own work budget (design
  // section 12: "a frozen worker is killed, and the step continues from its saved conversation"; review: calling the
  // step again started a new conversation at full cost, and the tools' state was lost with their process). Never
  // after a project file changed: nothing from such a step is used. Its system text is the same as the first's.
  const left = changed.length ? null : carryOnBudget(result, summary, deps.thinkingTimeoutSec);
  const carriedOn = left !== null;
  if (left !== null) {
    deps.log("warn", "thinking.carry_on", { role: args.role, phase: role.phase, model: model.model_name, reason: result.error, conversation_id: summary.conversation_id, timeout_sec: left });
    writeToolsConfig(true);
    ({ result, summary, changed } = await send({ role: args.role, toolsConfig, saveDir, resumeId: summary.conversation_id, carryOn: true, timeoutSec: left, system, task }));
  }
  // The step's spend is every dispatch's.
  const cost = round6(dispatched.reduce((a, r) => a + (r.cost_usd ?? 0), 0));
  const stop = (why: string, missing?: string[]): ThinkingReply => {
    deps.log("warn", "thinking.stopped", { role: args.role, phase: role.phase, model: model.model_name, reason: why });
    return { ...base, route: "stopped", reason: why, ...(missing?.length ? { missing } : {}), ...(summary.accepted?.length ? { accepted: summary.accepted } : {}), cost_usd: cost };
  };
  const changeCheck = checkedByGit ? "git" : "partial: not a git work tree, so the worker's walk of the project is the check; it skips dependency, build and cache folders, compares files over 2 MB by size, and stops at 20,000 files";
  const changedText = changed.length ? `project files changed while the step ran: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""}` : "";
  // Every piece accepted, nothing changed: the step is done, even when Google held its closing call and the busy window
  // then said halt. The window is the run's, kept in its ledger, so the run's next call halts if Google still serves
  // nothing; this step's work is in (review of 0.10.1: a finished step was answered halt, and its accepted work lost).
  const finished = summary.done === true && !changed.length && summary.reason !== "setup";
  if (result.halt && finished) deps.log("warn", "thinking.done_after_halt", { role: args.role, phase: role.phase, model: model.model_name, reason: result.halt });
  if (result.halt && !finished) {
    // A halt still names what changed (review: it returned before the check, and the files were never named).
    const reason = changedText ? `${result.halt}; ${changedText}` : result.halt;
    deps.log("warn", "thinking.halt", { role: args.role, phase: role.phase, model: model.model_name, reason });
    return { ...base, route: "halt", reason, cost_usd: cost };
  }
  if (changed.length) return stop(changedText);
  // A hand-in's check could not run for the step's own setup (plan-lint's usage error: a run id or folder it cannot
  // use, a job that is not the run's): the worker stopped at once, and the reply says what was wrong and where, as a
  // setup error for the person, never as the model's failure (review: such errors went to Gemini as refusals to fix).
  if (summary.reason === "setup") return stop(`the ${model.model_name} step stopped on its own setup, which no hand-in can fix: ${summary.setup_error ?? result.error ?? "no reason given"}`, summary.missing);
  if (!summary.done) {
    // Killed again after its carry-on: the step stops, saying so; any other stop says why its worker stopped, and that
    // the step had been carried on once.
    if (carriedOn && result.worker_stopped === "killed") return stop(`the ${model.model_name} step could not finish: its worker was killed twice, the second time after it was carried on from its saved conversation: ${result.error ?? "no reason given"}`, summary.missing);
    const why = stoppedReason(model.model_name, summary, result, deps.thinkingTimeoutSec);
    return stop(carriedOn ? `${why} (it had been carried on once, after its worker was killed)` : why, summary.missing);
  }
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
  deps.log("info", "thinking.end", { role: args.role, phase: role.phase, model: model.model_name, accepted: (summary.accepted ?? []).length, cost_usd: cost, change_check: changeCheck === "git" ? "git" : "partial", carried_on: carriedOn });
  return { ...base, route: "done", accepted: summary.accepted ?? [], cost_usd: cost, tokens: sumTokens(dispatched), resumed: !!resumeId || carriedOn, change_check: changeCheck, ...(answer ? { acceptance_fix: answer } : {}) };
}
