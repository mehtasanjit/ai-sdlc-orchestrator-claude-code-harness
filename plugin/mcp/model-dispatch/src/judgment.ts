/**
 * A run's thinking steps (requirements, the architect, the two reviewers), routed by the policy like every typed file.
 *
 * A step whose rule names a Claude model runs in the Claude Code session, as it always has: the reply says so and
 * nothing is spent here. A step whose rule names an agent-door leaf (antigravity-worker) runs that helper's own
 * instructions on the agent, inside a scratch clone of the project, and only the step's declared outputs are copied
 * back, so the agent never writes the project itself (a brownfield run's write contract stays whole). A step that
 * fails its checks gets one fix round with the problems sent back; a second failure, or a leaf that cannot run as an
 * agent, hands the step back to the session's Claude helper, marked as a fallback.
 */

import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExecutionResult, ModelConfig, Phase, TaskPacket, TelemetryEvent } from "./types.js";

export interface JudgmentRole {
  phase: Phase;
  /** Where the helper's instructions come from: its agent file, or the pipeline skill's phase section. */
  instructions: { agent: string } | { skillSection: string };
  /** Code that checks the outputs after the agent returns, beyond "each exists, each .json parses". */
  check?: "spec" | "change-spec";
}

export const JUDGMENT_ROLES: Readonly<Record<string, JudgmentRole>> = Object.freeze({
  requirements: { phase: "requirements_analysis", instructions: { skillSection: "### Phase 1 — requirements_analysis" } },
  architect: { phase: "architecture_design", instructions: { agent: "architect" }, check: "spec" },
  "brownfield-architect": { phase: "architecture_design", instructions: { agent: "brownfield-architect" }, check: "change-spec" },
  "senior-reviewer": { phase: "senior_code_review", instructions: { agent: "senior-reviewer" } },
  "brownfield-senior-reviewer": { phase: "senior_code_review", instructions: { agent: "brownfield-senior-reviewer" } },
  "security-reviewer": { phase: "security_review", instructions: { agent: "security-reviewer" } },
  "brownfield-security-reviewer": { phase: "security_review", instructions: { agent: "brownfield-security-reviewer" } },
});

/** Never copied into the clone: installed dependencies and caches, rebuilt rather than read. */
export const CLONE_SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", ".cache", "coverage"]);

export const JUDGMENT_FIX_ROUNDS = 1;

export interface JudgmentArgs {
  role: string;
  prompt: string;
  /** Paths relative to project_root the step must write: a file, or a folder ending in `/` that must hold one. */
  outputs: string[];
  project_root: string;
  run_id?: string;
  /** Greenfield architect: the run's output directory, where the spec is assembled. */
  spec_dir?: string;
  requirements_path?: string;
}

export type JudgmentReply =
  | { route: "claude"; role: string; phase: Phase; model: string; fallback: false; reason: string }
  | { route: "claude"; role: string; phase: Phase; model: string; fallback: true; reason: string; cost_usd: number }
  | { route: "done"; role: string; phase: Phase; model: string; outputs: string[]; rounds: number; cost_usd: number; tokens: ExecutionResult["tokens"] };

export interface JudgmentDeps {
  pluginRoot: string;
  route: (phase: Phase) => { model: ModelConfig; reason: string };
  dispatch: (packet: TaskPacket, workDir: string) => Promise<{ result: ExecutionResult; events: TelemetryEvent[] }>;
  record: (events: TelemetryEvent[]) => void;
  submitSection: (specDir: string, section: "header" | "units", file: string) => Promise<{ ok: boolean; problems: string[] }>;
  finalizeSpec: (specDir: string, requirementsPath?: string) => Promise<{ ok: boolean; problems: string[] }>;
  lintSection: (file: string, runId: string, projectRoot: string) => { ok: boolean; problems: string[] };
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  /** Tests pin the clone's parent folder. */
  scratchParent?: string;
}

const isClaudeLeaf = (m: ModelConfig) => m.adapter === "builtin-anthropic" || m.adapter === "claude-cli";

/** An output path may only name a place under the project root, and in a brownfield run only under `.sdlc/`. */
export function outputProblem(projectRoot: string, out: string, brownfield: boolean): string | null {
  if (typeof out !== "string" || out === "" || isAbsolute(out)) return `output '${out}' must be a path relative to project_root`;
  const rel = relative(resolve(projectRoot), resolve(projectRoot, out));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `output '${out}' is outside project_root`;
  if (brownfield && rel.split(sep)[0] !== ".sdlc") return `output '${out}' is outside .sdlc/; a brownfield run's thinking steps write only the run's own records`;
  return null;
}

/** The helper's instructions as the agent reads them: the agent file without its frontmatter, or one skill section. */
export function roleInstructions(pluginRoot: string, role: JudgmentRole): string {
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

const RUNNING_OUTSIDE = [
  "## How this step runs",
  "",
  "You are running this helper's instructions as an agent in a copy of the project. You have file and shell tools only:",
  "no MCP tools, no Agent or Task tool, no `${CLAUDE_PLUGIN_ROOT}` folder. Where the instructions tell you to call",
  "`submit_spec_section` or `finalize_spec`, or to run `plan-lint.mjs`, do not: write the section files they name and",
  "return. Code checks every file after you return and sends back any problem to fix. Write only the outputs listed",
  "at the end; any other file you change is discarded.",
].join("\n");

export function judgmentPacket(id: string, role: JudgmentRole, instructions: string, args: JudgmentArgs, problems: string[]): TaskPacket {
  const fix = problems.length
    ? `\n\n## Fix these problems\n\nYour outputs from the last round are in place. Fix each spot with an edit, then return.\n\n${problems.map((p) => `- ${p}`).join("\n")}`
    : "";
  return {
    id,
    phase: role.phase,
    task_type: "judgment",
    module: args.role,
    instruction: `${RUNNING_OUTSIDE}\n\n## The helper's instructions\n\n${instructions}\n\n## This invocation\n\n${args.prompt}\n\n## Outputs\n\n${args.outputs.map((o) => `- ${o}`).join("\n")}${fix}`,
    inputs: [],
    outputSchema: { __free_text__: true },
    acceptance: args.outputs.map((o) => `${o} is written`),
    budget: { maxInputTokens: 0, maxOutputTokens: 0 },
    pass_id: args.run_id ?? "judgment",
  };
}

function copyTree(src: string, dest: string, skip: (rel: string, name: string) => boolean, rel = ""): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const childRel = rel ? join(rel, name) : name;
    if (skip(childRel, name)) continue;
    const from = join(src, name), to = join(dest, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (st.isDirectory()) copyTree(from, to, skip, childRel);
    // A copy-on-write clone where the filesystem has one (APFS, Btrfs, XFS), a plain copy elsewhere.
    else if (st.isFile()) copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
  }
}

function gitHead(root: string): string | null {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Compared as real paths: git prints /private/var where the caller may say /var (macOS).
    if (realpathSync(top) !== realpathSync(root)) return null;
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The project as it is now, in a new folder: its working tree (uncommitted changes included) and, in a git repository,
 * a `--shared` clone of its history at the same HEAD, so `git diff <head_before>` reads as it does in the project and
 * anything the agent commits lands in the clone's own objects.
 */
export function cloneWorkspace(projectRoot: string, parent = tmpdir()): string {
  const dest = mkdtempSync(join(parent, "mmo-judgment-"));
  const head = gitHead(projectRoot);
  if (head) {
    execFileSync("git", ["clone", "--shared", "--no-checkout", "-q", projectRoot, dest], { stdio: "ignore" });
    execFileSync("git", ["-C", dest, "update-ref", "--no-deref", "HEAD", head], { stdio: "ignore" });
    execFileSync("git", ["-C", dest, "read-tree", head], { stdio: "ignore" });
  }
  copyTree(projectRoot, dest, (rel, name) => rel === ".git" || CLONE_SKIP_DIRS.has(name));
  return dest;
}

function outputExists(root: string, out: string): boolean {
  const p = join(root, out);
  if (!existsSync(p)) return false;
  const st = statSync(p);
  return st.isDirectory() ? readdirSync(p).length > 0 : st.size > 0;
}

function jsonFiles(root: string, out: string): string[] {
  const p = join(root, out);
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return out.endsWith(".json") ? [out] : [];
  return readdirSync(p).filter((n) => n.endsWith(".json")).sort().map((n) => join(out, n));
}

/** Problems with the outputs as the agent left them in the clone: each must exist, and each JSON file must parse. */
export function outputProblems(clone: string, outputs: string[]): string[] {
  const problems: string[] = [];
  for (const out of outputs) {
    if (!outputExists(clone, out)) { problems.push(`${out} was not written`); continue; }
    for (const f of jsonFiles(clone, out)) {
      try { JSON.parse(readFileSync(join(clone, f), "utf8")); } catch (e: any) { problems.push(`${f} is not valid JSON: ${e.message}`); }
    }
  }
  return problems;
}

function copyBack(clone: string, projectRoot: string, outputs: string[]): void {
  for (const out of outputs) {
    const from = join(clone, out), to = join(projectRoot, out);
    if (!existsSync(from)) continue;
    if (statSync(from).isDirectory()) copyTree(from, to, () => false);
    else { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
  }
}

/** Code's own checks of the outputs once they are in the project: the change spec's plan-lint, the build spec's hand-over. */
async function codeChecks(role: JudgmentRole, args: JudgmentArgs, deps: JudgmentDeps, accepted: Set<string>): Promise<string[]> {
  const problems: string[] = [];
  if (role.check === "change-spec") {
    for (const out of args.outputs) {
      for (const f of jsonFiles(args.project_root, out)) {
        const r = deps.lintSection(join(args.project_root, f), args.run_id ?? "", args.project_root);
        if (!r.ok) problems.push(...r.problems.map((p) => `${f}: ${p}`));
      }
    }
  }
  if (role.check === "spec") {
    if (!args.spec_dir) return ["spec_dir is required for the architect"];
    const files = args.outputs.flatMap((o) => jsonFiles(args.project_root, o));
    const header = files.filter((f) => /(^|\/)header\.json$/.test(f));
    const units = files.filter((f) => !header.includes(f));
    // A section the spec already holds is not sent again: a unit id sent twice is a refusal.
    for (const [section, list] of [["header", header], ["units", units]] as const) {
      for (const f of list) {
        if (accepted.has(f)) continue;
        const r = await deps.submitSection(args.spec_dir, section, relative(args.spec_dir, join(args.project_root, f)));
        if (r.ok) accepted.add(f);
        else problems.push(...r.problems.map((p) => `${f}: ${p}`));
      }
    }
    if (!problems.length) {
      const r = await deps.finalizeSpec(args.spec_dir, args.requirements_path);
      if (!r.ok) problems.push(...r.problems);
    }
  }
  return problems;
}

const sumTokens = (a: ExecutionResult["tokens"], b: ExecutionResult["tokens"]) => ({
  input: a.input + b.input,
  input_cached: a.input_cached + b.input_cached,
  output: a.output + b.output,
});

export async function executeJudgment(args: JudgmentArgs, deps: JudgmentDeps): Promise<JudgmentReply> {
  const role = JUDGMENT_ROLES[args.role];
  if (!role) throw new Error(`execute_judgment: unknown role '${args.role}' (known: ${Object.keys(JUDGMENT_ROLES).join(", ")})`);
  if (!args.project_root) throw new Error("execute_judgment: project_root is required");
  if (!Array.isArray(args.outputs) || !args.outputs.length) throw new Error("execute_judgment: outputs must list at least one path");
  const brownfield = args.role.startsWith("brownfield-") || existsSync(join(args.project_root, ".sdlc", "local", "write-contract.json"));
  for (const out of args.outputs) {
    const p = outputProblem(args.project_root, out, brownfield);
    if (p) throw new Error(`execute_judgment: ${p}`);
  }

  const { model, reason } = deps.route(role.phase);
  const base = { role: args.role, phase: role.phase, model: model.model_name };
  if (isClaudeLeaf(model)) {
    return { ...base, route: "claude", fallback: false, reason: `the policy routes ${role.phase} to ${model.model_name} (${reason}): run the ${args.role} step in this session as before` };
  }
  const fallback = (why: string, cost: number): JudgmentReply => {
    deps.log("warn", "judgment.fallback", { role: args.role, phase: role.phase, model: model.model_name, reason: why });
    return { ...base, route: "claude", fallback: true, reason: `${why}; run the ${args.role} step in this session instead`, cost_usd: cost };
  };
  if (model.adapter !== "antigravity-worker") {
    return fallback(`the policy routes ${role.phase} to '${model.id}' (${model.adapter}), which is called as a model and cannot read the project as an agent`, 0);
  }

  const instructions = roleInstructions(deps.pluginRoot, role);
  const clone = cloneWorkspace(args.project_root, deps.scratchParent);
  let cost = 0;
  let tokens = { input: 0, input_cached: 0, output: 0 };
  let problems: string[] = [];
  const accepted = new Set<string>();
  try {
    for (let round = 0; round <= JUDGMENT_FIX_ROUNDS; round++) {
      const packet = judgmentPacket(`${args.run_id ?? "run"}-${args.role}-r${round}`, role, instructions, args, problems);
      deps.log("info", "judgment.start", { role: args.role, phase: role.phase, model: model.model_name, round, clone });
      const { result, events } = await deps.dispatch(packet, clone);
      cost += result.cost_usd;
      tokens = sumTokens(tokens, result.tokens);
      if (!result.success) {
        deps.record(events.map((e) => ({ ...e, judgment_role: args.role, judgment_fallback: result.error ?? "worker failed" })));
        return fallback(`the ${model.model_name} agent failed: ${result.error ?? "no reason given"}`, cost);
      }
      problems = outputProblems(clone, args.outputs);
      if (!problems.length) {
        copyBack(clone, args.project_root, args.outputs);
        problems = await codeChecks(role, args, deps, accepted);
      }
      const last = round === JUDGMENT_FIX_ROUNDS;
      deps.record(events.map((e) => ({ ...e, judgment_role: args.role, ...(problems.length && last ? { judgment_fallback: problems.join("; ") } : {}) })));
      deps.log(problems.length ? "warn" : "info", "judgment.end", { role: args.role, round, ok: !problems.length, problems: problems.length, cost_usd: result.cost_usd });
      if (!problems.length) return { ...base, route: "done", outputs: args.outputs, rounds: round + 1, cost_usd: cost, tokens };
    }
    return fallback(`the ${model.model_name} agent's outputs still fail their checks after ${JUDGMENT_FIX_ROUNDS} fix round(s): ${problems.slice(0, 5).join("; ")}`, cost);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}
