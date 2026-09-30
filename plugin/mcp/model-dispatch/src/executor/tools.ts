/**
 * The MCP tools of the typed-spec executor (greenfield: `/mmo:greenfield` and `/mmo:pass`):
 *
 *  - submit_spec_section — the architect hands the typed spec over one section
 *    at a time (the header, then units in batches); each is checked on arrival.
 *    A header after finalize_spec, or from a new run, starts a new spec.
 *  - finalize_spec — assembles spec.json, checks requirement coverage, renders
 *    design.md.
 *  - execute_stage — types every unit of one stage (codegen, tests, docs), or
 *    every fix of a repair round, and returns one short receipt. Same machine
 *    for every policy; the policy only decides which typist types each job.
 *    Stage "acceptance" types nothing: it runs the plan's acceptance commands
 *    (acceptance.ts) and needs no model and no pre-flight.
 *
 * server.ts lists these tools and forwards their calls here with the run
 * state pre-flight recorded (the auth mode and the policy arguments), the
 * run's slot choices (the Gemini door: completion or agent) and the request's
 * progress channel. The model never chooses the auth mode, the policy or how
 * many jobs run at once for a stage call: those are the run's, set once at
 * pre-flight or fixed in code, so no stage can differ from another by a value
 * a model typed.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModelConfig, Policy, SelectOverrides, TelemetryEvent } from "../types.js";
import { pickModel, resolveNamed, unreachableModelIds } from "../routing.js";
import { getModel } from "../policy.js";
import { appendEvent } from "../telemetry.js";
import { log } from "../log.js";
import { finalizeSpec, loadSpec, openedSpec, readSectionFile, storedUnits, submitSpecSection } from "../spec/store.js";
import { SPEC_HEADER_SCHEMA, SPEC_UNIT_SCHEMA, shapeOf } from "../spec/schema.js";
import { renderShared } from "./brief.js";
import { boundReceipt, executeStage, executorView, type RepairItem, type Stage } from "./run.js";
import { runAcceptance } from "./acceptance.js";
import { AgyTypist, FlashCompletionTypist, LeanOpusTypist, type Door, type Typist } from "./typists.js";
import { LEGACY_GEMINI_ADAPTER_ID } from "../adapters/index.js";
import { runStateConflict } from "../runCard.js";

/**
 * Every typist types at LOW effort, for both vendors: the lowest effort whose
 * first-try passes equal the highest effort's.
 */
export const TYPIST_EFFORT = "low";
/**
 * Jobs typed at once, for every stage and every policy: a stated upper bound on
 * one vendor quota's load, not a measurement. A rate-limited call waits and is
 * not an attempt (and a 429 bills $0), so a lower number would change only the
 * wall time, never who types or what is billed.
 */
export const STAGE_CONCURRENCY = 4;
/** Routed attempts before the lean Opus attempt (the same ladder for every policy). */
export const ROUTED_ATTEMPTS = 2;
/**
 * Transport waits per call, and the backoff's base and cap. Both vendors meter
 * rate limits per minute (Vertex AI quotas per minute; Anthropic's requests and
 * tokens per minute), so no single wait longer than one 60 s window helps: that
 * is the cap, and a vendor asking for a longer pause turns the call into an
 * attempt (run.ts). Six waits and a 2 s base are stated bounds.
 */
export const TRANSPORT = { maxWaits: 6, baseMs: 2_000, capMs: 60_000 };
/**
 * Every typist call's time limit, the same for all three doors: a stated
 * safety bound that only catches a hung call. 540 s is the agent door's
 * per-job limit, well above how long a low-effort typist call takes. A call
 * past it is an attempt: a lean Opus or agent process is killed, process
 * group and all; a completion request fails by the SDK's own timeout.
 */
export const TYPIST_TIMEOUT_S = 540;
/** The agent typist's model-call budget: a typist normally finishes in one model call; 3 bounds an agent that keeps going. */
export const AGY_MAX_MODEL_CALLS = 3;
/** Progress heartbeat while a stage runs: any interval well inside Claude Code's MCP idle limit keeps the call alive. */
export const HEARTBEAT_MS = 30_000;

export const EXECUTOR_TOOLS = [
  {
    name: "submit_spec_section",
    description:
      `Hand over ONE section of the typed build spec as a FILE you wrote with the Write tool under spec_dir: first the header (section: "header", file: spec.sections/header.json holding {stack, commands, decisions, shared}), then the units in batches (section: "units", file: spec.sections/units-001.json, units-002.json, ... each holding a JSON array of units), each unit after the units it depends on. Each section is checked on arrival; a refused section stores nothing. If the file is not valid JSON the reply names the line, column and text: fix that spot with Edit and submit the same file again, never rewrite the whole file. Other problems are listed by path; fix them in the file the same way. A header sent after finalize_spec, or from a new run (a new preflight_dispatch), starts a new spec: the earlier spec's records move to <spec_dir>/previous/<time>/ (the reply's \`previous\` field names that folder), and the whole spec is then sent again: the header, then every units file (the same unit ids and paths are accepted again). The exact shapes (every string is one line; ? marks an optional field): the header file holds ${shapeOf(SPEC_HEADER_SCHEMA)}; each units file holds a JSON array of units, each ${shapeOf(SPEC_UNIT_SCHEMA)}.`,
    inputSchema: {
      type: "object",
      properties: {
        spec_dir: { type: "string", description: "The run's output directory; the spec is assembled there." },
        section: { type: "string", enum: ["header", "units"] },
        file: { type: "string", description: "The section file you wrote with the Write tool, under spec_dir (for example spec.sections/header.json, then spec.sections/units-001.json, ...): the header object, or a JSON array of units." },
      },
      required: ["spec_dir", "section", "file"],
    },
  },
  {
    name: "finalize_spec",
    description:
      "Assemble spec.json from the accepted sections, check that every FR- and AC- requirement in requirements.md is covered by some unit, and render design.md from the spec. If coverage is short, the reply names the missing ids: submit more units, then finalize again.",
    inputSchema: {
      type: "object",
      properties: { spec_dir: { type: "string" }, requirements_path: { type: "string" } },
      required: ["spec_dir"],
    },
  },
  {
    name: "execute_stage",
    description:
      "Type every unit of one stage of the finalized spec (codegen, tests or docs), or every fix of a repair round (stage: \"repair\"): each job goes to the typist the run's policy routes it to, is checked, and is written under code_dir by code. A repair round takes the senior reviewer's review.json files (review_paths: every finding with a file is fixed) and/or failures you name from a test run (failures: the file to change, what is wrong, and optionally files to show beside it). Returns one short receipt (files written, failures, dollars by typist). Long-running: it reports progress as each job finishes. The auth mode and policy are the ones preflight_dispatch recorded for this run. Stage \"acceptance\" types nothing: code runs every command of the spec's acceptance list in code_dir with its whole output kept, marks every acceptance criterion pass, fail or not checked (a command the machine cannot run — its program not found, or stopped at the plan's time limit — leaves its criteria not checked, with that reason), writes acceptance.json and acceptance.md beside spec.json, and names each failure's route (architect for an install or audit failure, repair for a failing check). It runs at most once plus three re-checks; a further call runs nothing.",
    inputSchema: {
      type: "object",
      properties: {
        spec_path: { type: "string" },
        stage: { type: "string", enum: ["codegen", "tests", "docs", "repair", "acceptance"] },
        code_dir: { type: "string", description: "Where the files are written; every path is relative to it." },
        pass_id: { type: "string" },
        telemetry_path: { type: "string" },
        review_paths: { type: "array", items: { type: "string" }, description: "repair only: review.json files written by the senior reviewer." },
        failures: {
          type: "array",
          description: "repair only: one entry per file to change, from a failing test run.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "The file to change, relative to code_dir." },
              problem: { type: "string", description: "What fails: the test name and its error, verbatim." },
              context_paths: { type: "array", items: { type: "string" }, description: "Files to show beside it, e.g. the failing test file (relative to code_dir)." },
              new_file: { type: "boolean", description: "true when the fix needs a file that does not exist yet: path is then where to create it, relative to code_dir. A review finding that needs a new file comes back in not_routed; send it again here with new_file." },
            },
            required: ["path", "problem"],
          },
        },
      },
      required: ["spec_path", "stage", "code_dir"],
    },
  },
] as const;

export const EXECUTOR_TOOL_NAMES = new Set(EXECUTOR_TOOLS.map((t) => t.name));

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (value: unknown, isError = false): Reply => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) });
/** A stage receipt is sent as compact JSON: the size bound (boundReceipt) is measured on exactly what is sent. */
const compact = (value: unknown): Reply => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** What pre-flight recorded for this run: the auth mode and the policy arguments every later call uses. */
export interface RunState {
  authMode: "estimated" | "vendor";
  policyName?: string;
  projectRoot?: string;
  policyPath?: string;
}

/**
 * The fixes a review asks for: every finding that names a file becomes a
 * problem for that file, with its severity, line (when the finding gives one)
 * issue and fix. The file is kept as the reviewer wrote it; the executor
 * places it (placeFixPath) exactly as it places a test failure's file, and
 * reports any it cannot place. An unreadable review or a finding with no file
 * is reported here.
 */
export function reviewRepairs(reviewPaths: string[]): { items: RepairItem[]; not_routed: { file: string; reason: string }[] } {
  const items: RepairItem[] = [];
  const notRouted: { file: string; reason: string }[] = [];
  for (const rp of reviewPaths) {
    let review: any;
    try { review = JSON.parse(readFileSync(rp, "utf8")); } catch (e: any) { notRouted.push({ file: rp, reason: `unreadable review: ${e?.message ?? e}` }); continue; }
    for (const f of review?.findings ?? []) {
      if (typeof f?.file !== "string" || !f.file) { notRouted.push({ file: rp, reason: "a finding with no file" }); continue; }
      const where = Number.isInteger(f.line) ? ` (line ${f.line})` : "";
      items.push({ path: f.file, problems: [`${f.severity ?? "finding"}${where}: ${f.issue ?? ""}${f.fix ? ` — fix: ${f.fix}` : ""}`] });
    }
  }
  return { items, not_routed: notRouted };
}

/** The fixes a test run names: one per entry, new_file carried through (a fix that creates a file). */
export function failureRepairs(failures: any[]): RepairItem[] {
  return failures.map((f: any) => ({
    path: String(f.path), problems: [String(f.problem)], context_paths: (f.context_paths ?? []).map(String),
    ...(f.new_file === true ? { new_file: true } : {}),
  }));
}

/** The stages execute_stage types. */
const STAGES = new Set(["codegen", "tests", "docs", "repair"]);

/**
 * Where a stage's typist calls are billed: the call's telemetry_path, else the
 * pass folder's telemetry.jsonl beside spec.json (the file the pipeline logs
 * to), so a call that omits the path still lands on the run's bill.
 */
export function telemetryPathFor(a: { spec_path: string; telemetry_path?: string }): string {
  return a.telemetry_path ?? join(dirname(resolve(a.spec_path)), "telemetry.jsonl");
}

/** The request's progress channel, when the client sent a progress token. */
export interface ProgressChannel {
  token?: string | number;
  send(params: { progressToken: string | number; progress: number; total?: number; message?: string }): Promise<void>;
}

/**
 * The door a policy leaf types through, by its adapter, or null when the executor has no typist for
 * it. It reads nothing of this machine: whether the machine can run that door (the claude CLI's flags,
 * the agent door's Python) is pre-flight's check and the typist's own.
 */
export function typistDoorFor(leaf: Pick<ModelConfig, "adapter">): Door | null {
  switch (leaf.adapter) {
    case "builtin-anthropic":
    case "claude-cli":
      return "lean-opus";
    case "mcp:model-dispatch":
    case LEGACY_GEMINI_ADAPTER_ID: // the registry's compat alias, accepted wherever the registry accepts it
      return "flash-completion";
    case "antigravity-worker":
      return "agy";
    default:
      return null;
  }
}
const noTypist = (leaf: ModelConfig) => new Error(`execute_stage has no typist for adapter '${leaf.adapter}' (leaf ${leaf.id})`);

/** The typist for a policy leaf, by the leaf's adapter. */
export function typistForLeaf(leaf: ModelConfig, authMode: "estimated" | "vendor"): Typist {
  switch (typistDoorFor(leaf)) {
    case "lean-opus":
      return new LeanOpusTypist(leaf, { authMode, effort: TYPIST_EFFORT, timeoutMs: TYPIST_TIMEOUT_S * 1000 });
    case "flash-completion":
      return new FlashCompletionTypist(leaf, TYPIST_EFFORT, TYPIST_TIMEOUT_S * 1000);
    case "agy":
      // The leaf's worker_timeout_sec bounds a whole agent job; a typist types one file, so the executor's bound applies.
      return new AgyTypist(leaf, { effort: TYPIST_EFFORT, maxModelCalls: AGY_MAX_MODEL_CALLS, timeoutSec: TYPIST_TIMEOUT_S, apiRetries: TRANSPORT.maxWaits, apiRetryInitialMs: TRANSPORT.baseMs });
    default:
      throw noTypist(leaf);
  }
}

const isClaude = (m: ModelConfig) => typistDoorFor(m) === "lean-opus";

/**
 * The lean Opus attempt every unit gets last: the policy's default leaf when it is a Claude model, else its first
 * Claude leaf the run can reach, else null (a policy with no Claude model types with its own models only). A default
 * rule that names a slot is resolved by the run's choice, as routing resolves it, so the last attempt never goes to
 * a model the run de-selected.
 */
export function fallbackLeaf(policy: Policy, overrides: SelectOverrides = {}): ModelConfig | null {
  const def = policy.rules.find((r: any) => "default" in r) as any;
  const d = def ? policy.models.find((m) => m.id === resolveNamed(policy, def.default, overrides).modelId) : undefined;
  const unreachable = unreachableModelIds(policy, overrides);
  const leaf = d && isClaude(d) ? d : policy.models.find((m) => isClaude(m) && !unreachable.has(m.id));
  return leaf ?? null;
}

/**
 * The Claude models the executor types with for this policy and slot choice, each through `claude -p`: every
 * stage's routed attempts (a repair round's fixes are routed as the debug phase) and the lean Opus last attempt. Pre-flight checks that
 * this machine's claude CLI can run them.
 */
export function executorClaudeLeaves(policy: Policy, overrides: SelectOverrides): ModelConfig[] {
  const view = executorView(policy).policy;
  const ids = new Set<string>();
  // A stage the policy cannot route has no typist to check; execute_stage reports it when that stage runs.
  const add = (pick: () => string) => { try { ids.add(pick()); } catch { /* unroutable */ } };
  for (const phase of ["codegen", "tests", "docs", "debug"]) {
    for (let k = 0; k < ROUTED_ATTEMPTS; k++) add(() => pickModel({ phase, task_type: "", module: "spec", retry_count: k }, view, overrides).modelId);
  }
  const fb = fallbackLeaf(view, overrides);
  if (fb) ids.add(fb.id);
  return view.models.filter((m) => ids.has(m.id) && isClaude(m));
}

/**
 * How the executor reads this policy, as notes: rules read by stage alone, no Claude last attempt. None of
 * these stops a run; pre-flight and the run's first receipt both list them.
 */
export function executorPolicyNotes(policy: Policy, overrides: SelectOverrides): string[] {
  const view = executorView(policy);
  const notes: string[] = [];
  const fb = fallbackLeaf(view.policy, overrides);
  if (!fb) notes.push(`policy '${policy.name}' has no Claude model this run can use: its own models type every file, with no Claude last attempt`);
  notes.push(...view.notes);
  return notes;
}

/**
 * The typists of one execute_stage call, one per model. A routed typist is built when the stage plans its jobs,
 * so one that cannot run on this machine stops the stage before anything is sent. The lean Opus last attempt is
 * built when a job first reaches it: a stage its routed typists finish never needs the claude CLI, and if this
 * machine cannot run it, that attempt fails with the reason (pre-flight has already said so). The last attempt
 * and a routed attempt on the same model share one typist, so the model's cache warm-up is shared too.
 */
export function stageTypists(policy: Policy, authMode: "estimated" | "vendor", overrides: SelectOverrides, build: (leaf: ModelConfig, authMode: "estimated" | "vendor") => Typist = typistForLeaf): { typistFor(modelId: string): Typist; fallback: Typist | null } {
  const built = new Map<string, Typist>();
  const handles = new Map<string, Typist>();
  const real = (modelId: string): Typist => {
    let t = built.get(modelId);
    if (!t) { t = build(getModel(policy, modelId), authMode); built.set(modelId, t); }
    return t;
  };
  const handle = (modelId: string, door: Door): Typist => {
    let h = handles.get(modelId);
    if (!h) {
      const leaf = getModel(policy, modelId);
      h = { door, modelId: leaf.id, modelName: leaf.model_name, type: async (req) => real(modelId).type(req) };
      handles.set(modelId, h);
    }
    return h;
  };
  const fb = fallbackLeaf(policy, overrides);
  return {
    typistFor: (modelId) => handle(modelId, real(modelId).door),
    fallback: fb ? handle(fb.id, "lean-opus") : null,
  };
}

/**
 * One run, one auth mode and policy. A run is its spec: the first
 * execute_stage of a spec that gets past its start-up binds the auth mode and
 * policy pre-flight recorded, and a later stage of the same spec stops rather
 * than run under different ones, so one run's files never come from two
 * policies. A spec is its file and the id the store gives each spec it opens
 * (openedSpec), so a new spec in the same folder — a new run, or a Gate 2
 * revise — binds its own, and two separate /mmo: runs in one chat (one server
 * process) can use different policies.
 */
const RUN_BINDINGS = new Map<string, RunState>();
const runKey = (specPath: string) => `${realpathSync(specPath)}#${openedSpec(dirname(resolve(specPath)))?.id ?? ""}`;

/**
 * One token per run: server.ts records a new run state object at every
 * preflight_dispatch, so a new pre-flight is a new run. The spec store reads
 * it to tell a header sent again within one run (the units stay) from a new
 * run's header (a new spec), even when the earlier spec was never finalized.
 */
const RUN_TOKENS = new WeakMap<RunState, string>();
function runToken(run: RunState): string {
  let t = RUN_TOKENS.get(run);
  if (t === undefined) { t = randomUUID(); RUN_TOKENS.set(run, t); }
  return t;
}

export async function handleExecutorTool(name: string, a: any, ctx: { run?: () => RunState | undefined; policy?: (run: RunState) => Policy; overrides: SelectOverrides; progress?: ProgressChannel }): Promise<Reply> {
  if (name === "submit_spec_section") {
    // The section travels as a file the architect wrote, never inline: a large inline section can arrive unparseable and be lost whole (readSectionFile).
    const loaded = readSectionFile(a.spec_dir, a.file, a.section === "header" ? "header" : "units");
    if ("error" in loaded) {
      log("warn", "spec.section", { section: a.section, ok: false, file_error: true });
      return reply({ ok: false, section: a.section, errors: [{ path: "/", message: loaded.error }], stored_units: 0, total_units: existsSync(a.spec_dir ?? "") ? storedUnits(a.spec_dir).length : 0 }, true);
    }
    const run = ctx.run?.();
    const r = submitSpecSection(a.spec_dir, a.section === "header" ? { section: "header", header: loaded.value } : { section: "units", units: loaded.value }, run ? { run: runToken(run) } : {});
    log(r.ok ? "info" : "warn", "spec.section", { section: r.section, ok: r.ok, errors: r.errors.length, total_units: r.total_units });
    return reply(r, !r.ok);
  }
  if (name === "finalize_spec") {
    const r = finalizeSpec(a.spec_dir, a.requirements_path);
    log(r.ok ? "info" : "warn", "spec.finalize", { ok: r.ok, units: r.units, missing: r.missing_coverage.length });
    return reply(r, !r.ok);
  }
  if (a.stage === "acceptance") {
    const receipt = await runAcceptance(loadSpec(a.spec_path), { codeDir: a.code_dir, outDir: dirname(resolve(a.spec_path)) });
    log("info", "executor.acceptance", { round: receipt.round, final: receipt.final, passed: receipt.passed, failed: receipt.failed.length + (receipt.failed_not_listed ?? 0), refused: !!receipt.refused });
    return compact(receipt);
  }
  // execute_stage — a known stage, and only after pre-flight has recorded the run's auth mode and policy.
  if (!STAGES.has(a.stage)) return reply({ error: `unknown stage '${a.stage}': execute_stage types codegen, tests, docs or repair, and runs the acceptance commands (acceptance); nothing was typed.` }, true);
  const run = ctx.run?.();
  if (!run) return reply({ error: "execute_stage runs only after preflight_dispatch has recorded this run's auth mode and policy (Phase -1). Call preflight_dispatch first; nothing was typed." }, true);
  const authMode = run.authMode;
  const asWritten = ctx.policy!(run);
  const policy = executorView(asWritten).policy;
  const spec = loadSpec(a.spec_path);
  const key = runKey(a.spec_path);
  const bound = RUN_BINDINGS.get(key);
  const switched = bound ? runStateConflict(bound, run) : null;
  if (switched) {
    log("warn", "executor.stage.run_switched", { stage: a.stage, spec_path: realpathSync(a.spec_path), reason: switched });
    const stopped = `${switched}. A run cannot switch its auth mode or policy halfway, so nothing was typed. Start a new /mmo: run to use the new ones.`;
    return { ...compact(boundReceipt({ stage: a.stage, units: 0, written: 0, failed: [], stopped, by_door: {}, calls: 0, transport_waits: 0, cost_usd: 0, seconds: 0 })), isError: true };
  }
  // The run's first stage says once how the executor reads this policy (pre-flight listed the same notes).
  const policyNotes = bound ? [] : executorPolicyNotes(asWritten, ctx.overrides);
  if (policyNotes.length) log("info", "executor.policy_notes", { policy: policy.name, notes: policyNotes });
  const withNotes = <T extends object>(r: T) => (policyNotes.length ? { ...r, policy_notes: policyNotes } : r);
  let repairs: RepairItem[] | undefined;
  let notRouted: { file: string; reason: string }[] = [];
  if (a.stage === "repair") {
    const fromReview = reviewRepairs(a.review_paths ?? []);
    notRouted = fromReview.not_routed;
    repairs = [
      ...fromReview.items,
      ...failureRepairs(a.failures ?? []),
    ];
    if (!repairs.length) return compact(boundReceipt({ stage: "repair", units: 0, written: 0, failed: [], not_routed: notRouted, note: "nothing to fix" }));
  }
  const shared = renderShared(spec);
  const sharedFile = join(dirname(resolve(a.spec_path)), "shared-brief.txt");
  writeFileSync(sharedFile, shared);
  const { typistFor, fallback } = stageTypists(policy, authMode, ctx.overrides);
  const recordDir = dirname(resolve(a.spec_path));
  // A new project has no code folder yet: the executor, which writes every file into it, creates it.
  mkdirSync(resolve(a.code_dir), { recursive: true });
  const telemetryPath = telemetryPathFor(a);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  const emit = (ev: TelemetryEvent) => appendEvent(telemetryPath, ev);
  // Bound only now that the start-up has succeeded: a start-up that throws binds nothing, so the next
  // call still runs every check above and may come from another pre-flight. Nothing between the
  // check above and here awaits, so two calls cannot both find the spec unbound.
  if (!bound) RUN_BINDINGS.set(key, { ...run });

  let done = 0, total = spec.units.filter((u) => u.phase === a.stage).length;
  const token = ctx.progress?.token;
  const say = (message: string) => { if (token !== undefined) void ctx.progress!.send({ progressToken: token, progress: done, total, message }).catch(() => {}); };
  const heartbeat = token !== undefined ? setInterval(() => say(`still typing: ${done} of ${total} units done`), HEARTBEAT_MS) : null;
  log("info", "executor.stage.start", { stage: a.stage, units: total, policy: policy.name, auth_mode: authMode });
  try {
    const receipt = await executeStage(spec, {
      stage: a.stage as Stage, codeDir: a.code_dir, passId: a.pass_id ?? "pass", policy, overrides: ctx.overrides,
      concurrency: STAGE_CONCURRENCY, routedAttempts: ROUTED_ATTEMPTS, transport: TRANSPORT, repairs, recordDir,
    }, {
      typistFor, fallback, shared, sharedFile, emit,
      progress: (d, t, m) => { done = d; total = t; say(`${m} (${d}/${t})`); },
    });
    const final = boundReceipt(notRouted.length ? { ...receipt, not_routed: [...notRouted, ...(receipt.not_routed ?? [])] } : receipt);
    log("info", "executor.stage.end", { stage: final.stage, written: final.written, failed: final.failed.length + (final.failed_not_listed ?? 0), cost_usd: final.cost_usd, seconds: final.seconds, not_routed: (final.not_routed?.length ?? 0) + (final.not_routed_not_listed ?? 0), telemetry_path: telemetryPath });
    // A stopped stage is an error the orchestrator must report, with the receipt (and its bill) attached.
    return final.stopped ? { ...compact(withNotes(final)), isError: true } : compact(withNotes(final));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
