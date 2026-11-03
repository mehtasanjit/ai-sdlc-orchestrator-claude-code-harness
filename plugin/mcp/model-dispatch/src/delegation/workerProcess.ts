/**
 * Pure half of the Antigravity agent worker launch — decisions that don't
 * touch the filesystem, clock, or network. Interpreter resolution, argv,
 * child env, task brief, and sidecar-to-tokens mapping. The spawn, timeout
 * kill, and file reads live in AntigravityWorkerAdapter (the real-machine
 * half); everything here is unit-tested offline.
 */

import { join } from "node:path";
import type { ReasoningConfig, TaskPacket } from "../types.js";
import { AGENT_API_RETRY, BUSY_BUDGET_SEC, HEARTBEAT_SEC, STALL_TRIES, stallSecFor } from "../executor/stall.js";

/**
 * The worker's own limit on the session's work time; matches the Python `--timeout` default so the two halves agree.
 * 9 minutes — an agent explores, runs commands, and only returns at the end of the whole session. Calls Google held
 * until they were cut, refused requests and their waits are not counted. Override with the policy leaf's
 * `worker_timeout_sec:`.
 */
export const DEFAULT_WORKER_TIMEOUT_SEC = 540;

/**
 * Seconds past the worker's own limit before the engine's kill, as a fixed timer once counted them. The engine no
 * longer times a worker: its kill rule reads the worker's heartbeat (executor/stall.ts HeartbeatBackstop), whose
 * margin past the limit is BACKSTOP.overrunS. Non-zero either way, so the worker's own limit — which ends the session
 * cleanly with a diagnosable message — always fires first.
 */
export const WORKER_KILL_GRACE_SEC = 30;

/** Explicit interpreter for the worker. Escape hatch; the normal path is the built venv. */
export const WORKER_PYTHON_ENV = "GEMINI_WORKER_PYTHON";

export function workerVenvPython(workerDir: string): string {
  return join(workerDir, ".venv", "bin", "python");
}

/**
 * No `python3` fallback: on macOS that resolves to 3.9, and google-antigravity
 * needs ≥ 3.10 — the fallback would turn a setup problem into a subprocess
 * import error paid phases into a run. Refuse here instead.
 * `exists` is injected for offline testing.
 */
export function resolveWorkerPython(opts: {
  env: Record<string, string | undefined>;
  workerDir: string;
  exists: (path: string) => boolean;
}): string {
  const override = opts.env[WORKER_PYTHON_ENV];
  if (override && override.trim() !== "") {
    if (!opts.exists(override)) {
      throw new Error(
        `${WORKER_PYTHON_ENV} points at '${override}', which does not exist. ` +
          `Unset it to use the worker's own virtual environment, or point it at a ` +
          `Python >= 3.10 that has google-antigravity installed.`,
      );
    }
    return override;
  }
  const venv = workerVenvPython(opts.workerDir);
  if (opts.exists(venv)) return venv;
  throw new Error(
    `The Antigravity agent worker has no Python environment. Expected an interpreter at ` +
      `'${venv}'. Run \`npm run setup\` in the plugin root to create it, or set ` +
      `${WORKER_PYTHON_ENV} to a Python >= 3.10 that already has google-antigravity ` +
      `installed. Nothing is dispatched to this adapter until one of those is true.`,
  );
}

/**
 * Policy `reasoning:` → worker's `--thinking` flag. `NONE` = no thinking config.
 * `tier` is the same field the model adapter reads.
 */
export function workerThinkingLevel(reasoning?: ReasoningConfig): string {
  const tier = reasoning?.tier;
  if (!tier) return "NONE";
  return tier.toUpperCase();
}

export interface WorkerArgsInput {
  script: string;
  taskFile: string;
  model: string;
  region: string;
  workdir: string;
  outDir: string;
  usageFile: string;
  thinking: string;
  timeoutSec: number;
  /** The call's locations in order, the leaf's own first (default: `region` alone). */
  locations?: string[];
  stallSec?: number;
  stallTries?: number;
  busyBudgetSec?: number;
  heartbeatSec?: number;
  apiRetries?: number;
  apiRetryInitialMs?: number;
}

/**
 * `--region` is passed on every invocation. The worker has its own env
 * fallback for hand runs, but here we want the region in the manifest and
 * the region on the endpoint to match by construction. Every flag the worker
 * declares is passed on every call, the call supervisor's included, with the
 * model's and the executor's defaults when the input omits them.
 */
export function buildWorkerArgs(i: WorkerArgsInput): string[] {
  const locations = i.locations?.length ? i.locations : [i.region];
  return [
    i.script,
    "--task-file", i.taskFile,
    "--model", i.model,
    "--region", i.region,
    "--workdir", i.workdir,
    "--out-dir", i.outDir,
    "--usage-file", i.usageFile,
    "--thinking", i.thinking,
    "--timeout", String(i.timeoutSec),
    "--locations", locations.join(","),
    "--stall-sec", String(i.stallSec ?? stallSecFor({ model_name: i.model })),
    "--stall-tries", String(i.stallTries ?? STALL_TRIES),
    "--busy-budget-sec", String(i.busyBudgetSec ?? BUSY_BUDGET_SEC),
    "--heartbeat-sec", String(i.heartbeatSec ?? HEARTBEAT_SEC),
    "--api-retries", String(i.apiRetries ?? AGENT_API_RETRY.retries),
    "--api-retry-initial-ms", String(i.apiRetryInitialMs ?? AGENT_API_RETRY.initialMs),
  ];
}

/**
 * API-key variables removed from the child env. The whole claim this adapter
 * makes is "reached Vertex on project P in region R". Google's libraries
 * prefer an API key in several code paths — if one took it, the sidecar
 * would still say `vertex_project: P` because the worker writes what it was
 * TOLD, not what the transport chose.
 */
export const WORKER_STRIPPED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * Child env. Starts from the parent's (child needs PATH, HOME for ADC, and
 * on macOS DYLD_LIBRARY_PATH for pyexpat), pins project + location, strips
 * API-key doors. Parent env has already been through sanitizePluginEnv.
 */
export function buildWorkerEnv(
  parent: Record<string, string | undefined>,
  pins: { project: string; location: string },
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    child[key] = value;
  }
  for (const key of WORKER_STRIPPED_ENV) delete child[key];
  child.GOOGLE_CLOUD_PROJECT = pins.project;
  child.GOOGLE_CLOUD_LOCATION = pins.location;
  // Unbuffered so a killed process's last stderr line — often the timeout
  // diagnostic — isn't lost.
  child.PYTHONUNBUFFERED = "1";
  return child;
}

/**
 * Filesystem-safe stem. Substitution is defensive: an id is a string from a
 * model-authored plan, and a `/` would write the sidecar into a different
 * directory. Leading/trailing dots go so evidence is never hidden.
 */
export function evidenceStem(packet: TaskPacket): string {
  const raw = packet.id || `${packet.phase}-untitled`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "packet";
}

/**
 * Brief the worker reads as its opening message. Different from a completion
 * prompt: file slices are EXCERPTS with real paths, and the worker is told
 * it may open the originals. The output contract is restated at the end
 * because an agent that has run tools is more likely to narrate.
 */
export function workerTaskMarkdown(
  packet: TaskPacket,
  opts: { workdir: string; header?: string },
): string {
  const wantsJson = !!packet.outputSchema && !(packet.outputSchema as any).__free_text__;
  const excerpts = packet.inputs
    .map((s) => `#### ${s.path}\n_Included because: ${s.reason}_\n\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    opts.header ? `## Project context\n\n${opts.header}\n` : "",
    `## Task ${packet.id} — ${packet.phase} / ${packet.task_type}`,
    ``,
    `Module: ${packet.module}`,
    ``,
    `### Working directory`,
    ``,
    `You are running as an agent inside \`${opts.workdir}\`. You may list, read,`,
    `edit and create files there, and run commands there. That directory is the`,
    `only place you can act; nothing outside it is reachable.`,
    ``,
    `### Instruction`,
    ``,
    packet.instruction,
    ``,
    `### Provided excerpts`,
    ``,
    excerpts
      ? `These are extracts, not whole files. The paths are real — open them in the\nworking directory when you need more than the excerpt shows.\n\n${excerpts}`
      : `_None supplied. Explore the working directory to find what you need._`,
    ``,
    `### Acceptance criteria`,
    ``,
    ...(packet.acceptance.length ? packet.acceptance.map((a) => `- ${a}`) : ["- _(none stated)_"]),
    ``,
    `### Your final message`,
    ``,
    wantsJson
      ? [
          `Your final message must be a single JSON object and nothing else — no`,
          `prose before it, no summary after it, no \`\`\` fence around it. It must`,
          `conform to this schema:`,
          ``,
          "```json",
          JSON.stringify(packet.outputSchema, null, 2),
          "```",
        ].join("\n")
      : [
          `Return the deliverable itself as your final message — the file content or`,
          `the document that was asked for, not a report about producing it.`,
        ].join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * How each Antigravity SDK version reports input in its usage totals. The SDK
 * changed this between releases, and the two readings disagree by the whole
 * cached amount:
 *  - "inclusive": `prompt_token_count` is ALL input and
 *    `cached_content_token_count` is part of it (the Gemini API convention).
 *  - "disjoint": `prompt_token_count` is the FRESH input only and
 *    `cached_content_token_count` comes on top of it.
 * Only versions checked against Google's own token counter are listed (Cloud
 * Monitoring, aiplatform.googleapis.com/publisher/online_serving/token_count,
 * for a real job whose per-call records were summed too): 0.1.9 counted
 * prompt_token_count exactly; 0.1.16 counted prompt + cached exactly; 0.1.22
 * counted prompt_token_count exactly. Add a version here only after the same
 * check.
 */
export const AGY_USAGE_SEMANTICS: Readonly<Record<string, "inclusive" | "disjoint">> = Object.freeze({
  "0.1.9": "inclusive",
  "0.1.16": "disjoint",
  "0.1.22": "inclusive",
});

export type AgyUsageSemantics = "inclusive" | "disjoint" | "unverified";

/**
 * The reading that applies to one sidecar, from the SDK version the worker
 * recorded in it. A version nobody has checked is "unverified"; so is a
 * sidecar whose numbers contradict its version's reading (cached larger than
 * prompt cannot be inclusive).
 */
export function sidecarUsageSemantics(sidecar: any): AgyUsageSemantics {
  const known = AGY_USAGE_SEMANTICS[String(sidecar?.sdk_version ?? "")];
  if (!known) return "unverified";
  const usage = (sidecar && sidecar.usage) || {};
  if (known === "inclusive" && Number(usage.cached_content_token_count ?? 0) > Number(usage.prompt_token_count ?? 0)) return "unverified";
  return known;
}

/**
 * Map worker-sidecar tokens onto the orchestrator's disjoint convention
 * (`input` fresh, `input_cached` cached, never overlapping — computeCostUsd
 * bills them at different rates).
 * TWO TRAPS:
 *  1. Sidecar keys are snake_case (Python SDK), not camelCase.
 *  2. What `prompt_token_count` means depends on the SDK version (see
 *     AGY_USAGE_SEMANTICS): subtract the cached count only where the version
 *     is known to include it. Subtracting where it is not (0.1.16) floors fresh
 *     input to zero and bills the dearest tokens as free; not subtracting where
 *     it is (0.1.9) bills cached tokens twice.
 * An unverified version takes the disjoint reading, the larger of the two
 * bills, so an unchecked SDK can over-report a cost but never under-report it;
 * the adapter logs a warning so the version gets checked.
 * Thoughts fold into `output` for costing and duplicate to `output_reasoning`
 * for reporting only (computeCostUsd never reads that field).
 */
export function mapSidecarTokens(sidecar: any): {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning: number;
} {
  const usage = (sidecar && sidecar.usage) || {};
  const prompt = Number(usage.prompt_token_count ?? 0);
  const cached = Number(usage.cached_content_token_count ?? 0);
  const candidates = Number(usage.candidates_token_count ?? 0);
  const thoughts = Number(usage.thoughts_token_count ?? 0);
  const fresh = sidecarUsageSemantics(sidecar) === "inclusive" ? Math.max(0, prompt - cached) : prompt;
  return {
    input: fresh,
    input_cached: cached,
    output: candidates + thoughts,
    output_reasoning: thoughts,
  };
}

/**
 * True tool-call count, not the sampled list length. `tool_call_count` is
 * the honest number; `tool_calls_truncated` says when the list is bounded.
 */
export function sidecarToolCallCount(sidecar: any): number {
  const n = Number(sidecar?.tool_call_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
