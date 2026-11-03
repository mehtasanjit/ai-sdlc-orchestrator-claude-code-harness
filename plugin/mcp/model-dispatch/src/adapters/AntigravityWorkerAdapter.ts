/**
 * AntigravityWorkerAdapter — Gemini as an AGENT, via `worker/gemini_worker.py`.
 * The worker gets a workspace and tools; it lists, reads, runs commands, and
 * edits files itself.
 *
 * Vertex-only (Application Default Credentials; no API-key branch).
 * No output-cap doubling loop: an agent session has no ceiling under our
 * control, and a retry would be a fresh fully-billed session. One attempt.
 *
 * The worker runs its session under the call supervisor (worker/agy_supervisor.py): a held call is cut and sent
 * again, Google's status is read, a refused call can move to the leaf's failover_locations, and the usage sidecar is
 * written on every outcome with each try's own usage and location. This adapter prices each try at its own location,
 * day and served tier, and stops the worker only by the heartbeat kill rule (executor/stall.ts).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type {
  AttemptRecord,
  ExecutionResult,
  GeminiCallRecord,
  GeminiTry,
  ModelConfig,
  ModelPricing,
  RunContext,
  TaskPacket,
  UnpricedModel,
} from "../types.js";
import { computeCostUsd, round6 } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { applyVertexSurcharge, resolveGcpProject, workerVertexLocation } from "./geminiTransports.js";
import { DispatchPricer, geminiRates, unpricedRefusal, type BilledPrice, type Clock } from "./dispatchPricer.js";
import {
  DEFAULT_WORKER_TIMEOUT_SEC,
  buildWorkerArgs,
  buildWorkerEnv,
  evidenceStem,
  mapSidecarTokens,
  resolveWorkerPython,
  sidecarUsageSemantics,
  workerTaskMarkdown,
  workerThinkingLevel,
} from "../delegation/workerProcess.js";
import {
  buildDelegationRecord,
  diffInventories,
  takeInventory,
} from "../delegation/evidence.js";
import {
  AGENT_API_RETRY,
  BUSY_BUDGET_SEC,
  FAILOVER_API_RETRY,
  HEARTBEAT_SEC,
  STALL_TRIES,
  STOPPED_BY_REQUEST,
  callWaitBoundSec,
  stallSecFor,
  watchWorker,
  withoutHeartbeats,
  type BackstopOptions,
  type Heartbeat,
} from "../executor/stall.js";
import { log } from "../log.js";
import { WORKER_DIR } from "../paths.js";

// Module-location relative, not cwd — the server runs in the user's project.
// dist/adapters/ → package root two levels up.
// The worker folder comes from the package root (paths.ts): in the single-file bundle this module's own location
// does not say where the package is.
const WORKER_SCRIPT = join(WORKER_DIR, "gemini_worker.py");

// Tail (exception is at the bottom of the traceback) kept when the worker fails.
const STDERR_TAIL_CHARS = 4000;

/** A worker's receipt or sidecar (or a killed worker's last heartbeat) as tokens, dollars and the gemini record. */
export interface AgyBill {
  tokens: { input: number; input_cached: number; output: number; output_reasoning?: number };
  cost_usd: number;
  unpriced_models: UnpricedModel[];
  gemini: GeminiCallRecord;
}

/**
 * How a whole Gemini call ended, for its record: answered, or the reason it did not. `stopped` is how the engine
 * stopped the worker, when it did: killed by the heartbeat rule, or cancelled by the request. An answer comes first:
 * the typist writes its receipt before the SDK's teardown, which can block until the kill rule stops the worker, and
 * that call still answered (the kill is in the agsdk.backstop_kill log line).
 */
function callEndedBy(receipt: any, answered: boolean, stopped?: "killed" | "cancelled"): string {
  if (answered) return "answer";
  if (stopped) return stopped;
  const tries = Array.isArray(receipt?.tries) ? receipt.tries : [];
  const last = tries[tries.length - 1]?.ended_by;
  if (receipt?.unavailable) return last === "stalled" ? "stalled" : "refused";
  if (last === "work_limit" || last === "cancelled") return last;
  return "error";
}

/** The UTC day a try is priced on: its own start, read from the worker's clock, else the dispatch's start plus its offset. */
function tryDate(t: any, dispatchStart: Date): Date {
  const at = typeof t?.started_at === "string" ? new Date(t.started_at) : null;
  if (at && !Number.isNaN(at.getTime())) return at;
  if (typeof t?.start_s === "number") return new Date(dispatchStart.getTime() + t.start_s * 1000);
  return dispatchStart;
}

const msOf = (s: unknown): number => (typeof s === "number" && Number.isFinite(s) ? Math.round(s * 1000) : 0);

export class AntigravityWorkerAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  /** GCP project every delegation bills to. */
  readonly project: string;
  /** Vertex region every delegation runs in first (the leaf's own location). */
  readonly location: string;
  /** Absolute path to the interpreter. */
  readonly python: string;
  private readonly pricer: DispatchPricer;
  private readonly backstop?: BackstopOptions;

  /**
   * Strict on purpose. preflight_dispatch constructs every adapter before the
   * run starts, so a missing project / interpreter / worker script surfaces
   * once at the start, not as a crash after premium phases are billed.
   */
  constructor(config: ModelConfig, options: { now?: Clock; backstop?: BackstopOptions } = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.pricer = new DispatchPricer(config, options.now);
    this.backstop = options.backstop;

    const project = resolveGcpProject(process.env as Record<string, string | undefined>);
    if (!project) {
      throw new Error(
        `Model '${config.id}' dispatches through the Antigravity SDK, which runs on Vertex ` +
          `and therefore needs a Google Cloud project. None was found: set ` +
          `GOOGLE_CLOUD_PROJECT, or run \`gcloud auth application-default login\` on a ` +
          `project whose credentials record a quota project.`,
      );
    }
    this.project = project;

    // The policy leaf's `region:`, then GOOGLE_CLOUD_LOCATION, then `global`
    // (workerVertexLocation, the rule the what-if replay bills by too). Passed
    // to the worker explicitly so the region in the manifest and on the
    // endpoint match by construction.
    this.location = workerVertexLocation(config, process.env as Record<string, string | undefined>);

    if (!existsSync(WORKER_SCRIPT)) {
      throw new Error(
        `Model '${config.id}' needs the agent worker at '${WORKER_SCRIPT}', which is missing. ` +
          `The plugin install is incomplete — reinstall it, or check out the file from the repo.`,
      );
    }
    this.python = resolveWorkerPython({
      env: process.env as Record<string, string | undefined>,
      workerDir: WORKER_DIR,
      exists: existsSync,
    });
  }

  /** The call's locations in order: the leaf's own, then its failover_locations. */
  get locations(): string[] {
    const out = [this.location];
    for (const l of this.modelConfig.failover_locations ?? []) if (!out.includes(l)) out.push(l);
    return out;
  }

  /**
   * The price of a call on `date` at `location`: the effective rates (the dated list, or the policy block under
   * pricing_override) with the +10% regional surcharge for that Vertex location. A served tier the list does not price
   * (anything but standard) leaves the call unpriced, never billed at the standard card. Resolved per try, not once at
   * construction, because a list period can end while the server runs.
   */
  pricingAt(date: Date, location: string = this.location, servedTier?: string | null): BilledPrice {
    const price = this.pricer.price(date, servedTier && servedTier !== "standard" ? { service_tier: servedTier } : {});
    if (price.unpriced) return { unpriced: true, reason: price.reason };
    const rates = geminiRates(price.pricing);
    const billed = applyVertexSurcharge(rates, {
      backend: "vertex-adc",
      location,
      modelName: this.modelConfig.model_name,
    });
    return { unpriced: false, basis: price.basis, rates, billed, period: price.period };
  }

  /** The price of a delegation on `date` at the leaf's own location. */
  pricingOn(date: Date = this.pricer.now()): BilledPrice {
    return this.pricingAt(date, this.location);
  }

  /** Rates billed for a delegation now, surcharge applied; undefined when the model has no price today. */
  get billedPricing(): ModelPricing | undefined {
    const price = this.pricingOn();
    return price.unpriced ? undefined : price.billed;
  }

  /**
   * A worker's receipt (the typist) or sidecar (the agent door) as tokens, dollars and the gemini record. With `tries`,
   * each try is priced on its own: its own tokens (read by the SDK version's usage reading), at its own location, on its
   * own UTC day, at its served tier, and the call's figures are the tries' sums. Without (an earlier worker's shape),
   * the call is priced exactly as before: its usage at the leaf's location on the dispatch day.
   */
  bill(receipt: any, o: { started: Date; answered: boolean; stopped?: "killed" | "cancelled" }): AgyBill {
    const unpriced: UnpricedModel[] = [];
    const tries: GeminiTry[] = [];
    const sdk = receipt?.sdk_version;
    const total = { input: 0, input_cached: 0, output: 0, output_reasoning: 0 };
    let cost = 0;
    const raw: any[] = Array.isArray(receipt?.tries) ? receipt.tries : [];
    if (raw.length) {
      for (const t of raw) {
        const tokens = mapSidecarTokens({ sdk_version: sdk, usage: t?.usage });
        const location = typeof t?.location === "string" && t.location ? t.location : this.location;
        const tier = t?.served_tier ?? t?.usage?.service_tier ?? null;
        const price = this.pricingAt(tryDate(t, o.started), location, tier);
        let tryCost = 0;
        if (price.unpriced) {
          if (tokens.input + tokens.input_cached + tokens.output > 0) unpriced.push({ model: this.modelConfig.model_name, reason: price.reason });
        } else tryCost = computeCostUsd(tokens, price.billed);
        total.input += tokens.input;
        total.input_cached += tokens.input_cached;
        total.output += tokens.output;
        total.output_reasoning += tokens.output_reasoning;
        cost += tryCost;
        tries.push({
          location, ended_by: String(t?.ended_by ?? "unknown"), http_codes: Array.isArray(t?.http_codes) ? t.http_codes : [],
          s: typeof t?.s === "number" ? t.s : 0, served_tier: tier,
          input_tokens: tokens.input, input_tokens_cached: tokens.input_cached, output_tokens: tokens.output, cost_usd: tryCost,
          ...(t?.reason ? { reason: String(t.reason) } : {}),
        });
      }
    } else {
      const tokens = receipt?.usage ? mapSidecarTokens(receipt) : { input: 0, input_cached: 0, output: 0 };
      const price = this.pricingOn(o.started);
      const c = price.unpriced ? 0 : computeCostUsd(tokens, price.billed);
      Object.assign(total, tokens);
      cost = c;
      tries.push({
        location: typeof receipt?.vertex_location === "string" ? receipt.vertex_location : this.location,
        ended_by: callEndedBy(receipt, o.answered, o.stopped), http_codes: [], s: typeof receipt?.seconds === "number" ? receipt.seconds : 0,
        served_tier: receipt?.usage?.service_tier ?? null,
        input_tokens: tokens.input, input_tokens_cached: tokens.input_cached, output_tokens: tokens.output, cost_usd: c,
      });
      if (!receipt?.usage) delete (total as any).output_reasoning;
    }
    const codes = tries.flatMap((t) => t.http_codes).filter((c) => c >= 100 && c <= 599);
    const gemini: GeminiCallRecord = {
      project: typeof receipt?.vertex_project === "string" ? receipt.vertex_project : this.project,
      location: typeof receipt?.vertex_location === "string" ? receipt.vertex_location : tries[tries.length - 1].location,
      tries,
      ended_by: callEndedBy(receipt, o.answered, o.stopped),
      last_status: codes.length ? codes[codes.length - 1] : null,
      stall_cuts: Number(receipt?.stall_cuts ?? 0) || 0,
      failovers: Number(receipt?.failovers ?? 0) || 0,
      cut_calls: Number(receipt?.cut_calls ?? 0) || 0,
      google_wait_ms: msOf(receipt?.google_wait_s),
      work_ms: msOf(receipt?.work_s),
      slept_ms: typeof receipt?.slept_s === "number" ? msOf(receipt.slept_s) : null,
      sdk_version: typeof sdk === "string" ? sdk : null,
      usage_semantics: sidecarUsageSemantics({ sdk_version: sdk, usage: receipt?.usage ?? {} }),
      unavailable: typeof receipt?.unavailable === "string" ? receipt.unavailable : null,
      endpoint_override: process.env.GOOGLE_VERTEX_BASE_URL?.trim() || null,
    };
    return { tokens: total, cost_usd: round6(cost), unpriced_models: unpriced, gemini };
  }

  /**
   * A worker that left no receipt, billed from its last heartbeat: one try per location it reported usage at.
   * `stopped`: how the engine stopped it, or absent when it ended by itself (a crash).
   */
  billHeartbeat(hb: Heartbeat, o: { started: Date; stopped?: "killed" | "cancelled" }): AgyBill {
    const endedBy = o.stopped ?? "error";
    const tries = Object.entries(hb.usage ?? {}).map(([location, usage]) => ({
      location, ended_by: endedBy, http_codes: [], s: 0, usage, served_tier: (usage as any)?.service_tier ?? null,
    }));
    const receipt = {
      sdk_version: hb.sdk_version, vertex_project: this.project, vertex_location: hb.location ?? this.location,
      tries: tries.length ? tries : [{ location: hb.location ?? this.location, ended_by: endedBy, http_codes: [], s: 0, usage: null }],
      work_s: hb.work_s, google_wait_s: hb.wait_s, slept_s: hb.slept_s ?? undefined,
    };
    return this.bill(receipt, { started: o.started, answered: false, stopped: o.stopped });
  }

  /** How the engine stopped a worker, from the kill reason (null: it ended by itself). */
  static stoppedBy(killed: string | null): "killed" | "cancelled" | undefined {
    return killed === null ? undefined : killed === STOPPED_BY_REQUEST ? "cancelled" : "killed";
  }

  /** `cacheContext` accepted and ignored — no cache handle for agent sessions. */
  async execute(
    packet: TaskPacket,
    _cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    // Priced on the day the delegation starts. A model with no price is
    // refused before the brief is staged or the worker is spawned, so no
    // unpriced session is ever billed.
    const dispatchDate = this.pricer.now();
    const price = this.pricingOn(dispatchDate);
    if (price.unpriced) {
      return this.failure(started, unpricedRefusal(this.modelConfig, dispatchDate, price.reason));
    }

    // Workspace the agent may act in. Refused rather than defaulted to a
    // temp dir whose edits nobody would look at.
    const workdir = runContext?.work_dir ?? runContext?.project_root;
    if (!workdir) {
      return this.failure(
        started,
        `Model '${this.id}' delegates to an agent that edits files, so it needs a working ` +
          `directory. Pass work_dir (or project_root) to execute_with_model.`,
      );
    }

    // Evidence lands beside telemetry, where the report reads. Fallback under
    // the workspace keeps a hand-run invocation from writing into wherever
    // the server was launched from.
    const outDir = runContext?.telemetry_path
      ? join(dirname(runContext.telemetry_path), "delegation")
      : join(workdir, ".sdlc", "delegation");

    const stem = evidenceStem(packet);
    const taskFile = join(outDir, `worker-task-${stem}.md`);
    const usageFile = join(outDir, `worker-usage-${stem}.json`);
    const recordFile = join(outDir, `worker-delegation-${stem}.json`);

    try {
      mkdirSync(outDir, { recursive: true });
      keepEarlierDispatch(outDir, stem);
      writeFileSync(taskFile, workerTaskMarkdown(packet, { workdir }), "utf8");
    } catch (err: any) {
      return this.failure(started, `Could not stage the delegation brief: ${err?.message ?? err}`);
    }

    const timeoutSec = this.modelConfig.worker_timeout_sec ?? DEFAULT_WORKER_TIMEOUT_SEC;
    const failover = (this.modelConfig.failover_locations ?? []).length > 0;
    const stallSec = stallSecFor(this.modelConfig);
    const retry = failover ? FAILOVER_API_RETRY : AGENT_API_RETRY;
    const args = buildWorkerArgs({
      script: WORKER_SCRIPT,
      taskFile,
      model: this.modelConfig.model_name,
      region: this.location,
      workdir,
      outDir,
      usageFile,
      thinking: workerThinkingLevel(this.modelConfig.reasoning),
      timeoutSec,
      locations: this.locations,
      stallSec,
      stallTries: STALL_TRIES,
      busyBudgetSec: BUSY_BUDGET_SEC,
      heartbeatSec: HEARTBEAT_SEC,
      apiRetries: retry.retries,
      apiRetryInitialMs: retry.initialMs,
    });

    // Inventoried as late as possible so nothing this adapter wrote appears
    // in the delta. `outDir` is excluded because it sits inside the workspace
    // and the SDK writes session state there.
    const before = takeInventory(workdir, { exclude: [outDir] });
    log("debug", "agsdk.inventory.before", {
      packet_id: packet.id,
      files_scanned: before.entries.length,
      truncated: before.truncated,
    });

    log("info", "agsdk.spawn", {
      packet_id: packet.id,
      python_path: this.python,
      arg_count: args.length,
      work_dir: workdir,
      timeout_sec: timeoutSec,
      forwarded_env_keys: Object.keys(
        buildWorkerEnv(process.env as Record<string, string | undefined>, {
          project: this.project,
          location: this.location,
        }),
      ).join(","),
      project: this.project,
      location: this.location,
      locations: this.locations.join(","),
      stall_sec: stallSec,
    });

    // The kill rule's bound for one call: the worker's own stall tries, harness retry rule and busy budget.
    const waitBoundS = callWaitBoundSec(stallSec, { tries: STALL_TRIES, retry, busyBudgetSec: BUSY_BUDGET_SEC });
    const run = await this.spawnWorker(args, workdir, timeoutSec, waitBoundS, packet.id, runContext?.signal);

    const after = takeInventory(workdir, { exclude: [outDir] });

    // Read whatever the exit status: a failed delegation still spent tokens. A worker that wrote nothing (killed
    // before it could) is billed its last heartbeat's usage.
    const sidecar = readJsonIfPresent(usageFile);
    const bill = sidecar
      ? this.bill(sidecar, { started: dispatchDate, answered: run.ok, stopped: AntigravityWorkerAdapter.stoppedBy(run.killed) })
      : run.lastBeat
        ? this.billHeartbeat(run.lastBeat, { started: dispatchDate, stopped: AntigravityWorkerAdapter.stoppedBy(run.killed) })
        : null;
    const tokens = bill?.tokens ?? mapSidecarTokens(null);
    const cost = bill?.cost_usd ?? 0;
    const latency = Date.now() - started;

    // An SDK version whose usage reading has not been checked against Google's
    // own token counter is billed on the larger reading (never under-reported);
    // say so, so the version gets checked and added to AGY_USAGE_SEMANTICS.
    if (sidecar && sidecarUsageSemantics(sidecar) === "unverified") {
      log("warn", "agsdk.usage_semantics_unverified", {
        packet_id: packet.id,
        sdk_version: sidecar.sdk_version ?? null,
        billed_as: "disjoint (fresh = prompt_token_count, cached on top)",
      });
    }

    if (sidecar) {
      log("info", "agsdk.sidecar", {
        packet_id: packet.id,
        sdk: sidecar.sdk,
        sdk_version: sidecar.sdk_version,
        vertex_project: sidecar.vertex_project,
        vertex_location: sidecar.vertex_location,
        thinking: sidecar.thinking,
        tool_call_count: sidecar.tool_call_count,
        tool_calls_truncated: sidecar.tool_calls_truncated,
        tries: Array.isArray(sidecar.tries) ? sidecar.tries.length : undefined,
        stall_cuts: sidecar.stall_cuts,
        failovers: sidecar.failovers,
        unavailable: sidecar.unavailable,
      });
      for (const [index, tc] of (sidecar.tool_calls ?? []).entries()) {
        log("debug", "agsdk.toolcall", {
          packet_id: packet.id,
          index,
          name: tc?.name,
          target: tc?.canonical_path,
        });
      }
    }

    const diff = diffInventories(before, after);
    log("info", "agsdk.diff", {
      packet_id: packet.id,
      added_n: diff.added.length,
      modified_n: diff.modified.length,
      removed_n: diff.removed.length,
      unchanged: diff.unchanged,
      truncated: diff.truncated,
      unreadable_n: diff.unreadable.length,
    });

    // The worker's own reason when it gave one (a refusal, a stall, an interrupted answer, the work limit).
    const error = run.ok
      ? undefined
      : run.killed !== null
        ? run.error
        : typeof sidecar?.error === "string" && sidecar.error
          ? `The agent worker exited ${run.code}: ${sidecar.error}`
          : run.error;
    const unavailable = typeof sidecar?.unavailable === "string" && sidecar.unavailable ? sidecar.unavailable : undefined;
    const status = Number.isInteger(sidecar?.error_status) ? (sidecar.error_status as number) : undefined;

    // Written for BOTH outcomes — a failed delegation is what a reader most
    // needs a receipt for.
    this.writeRecord(recordFile, {
      packet: {
        id: packet.id,
        phase: packet.phase,
        task_type: packet.task_type,
        module: packet.module,
      },
      modelId: this.id,
      modelName: this.modelConfig.model_name,
      workdir,
      startedAt,
      durationMs: latency,
      success: run.ok,
      error,
      costUsd: cost,
      tokens,
      sidecar,
      diff,
      briefFile: basename(taskFile),
      usageFile: basename(usageFile),
      gemini: bill?.gemini,
    });

    const record = bill ? { gemini: bill.gemini, ...(bill.unpriced_models.length ? { unpriced_models: bill.unpriced_models } : {}) } : {};
    if (!run.ok) {
      const attempt: AttemptRecord = {
        attempt_number: 1,
        ceiling_used: packet.budget.maxOutputTokens,
        hit_output_cap: false,
        tokens,
        cost_usd: cost,
        latency_ms: latency,
        success: false,
        error,
        ...(status !== undefined ? { error_status: status } : {}),
        price_basis: price.basis,
        ...(unavailable ? { unavailable } : {}),
        ...record,
      };
      return {
        result: null,
        tokens,
        cost_usd: cost,
        latency_ms: latency,
        cache_hit: false,
        success: false,
        error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    // Worker prints the final message on stdout. `{ raw }` fallback matches
    // the model tier's shape.
    const text = run.stdout.trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      stop_reason: "agent_session_complete",
      hit_output_cap: false,
      tokens,
      cost_usd: cost,
      latency_ms: latency,
      success: true,
      price_basis: price.basis,
      ...record,
    };
    return {
      result: parsed,
      tokens,
      cost_usd: cost,
      latency_ms: latency,
      cache_hit: false,
      success: true,
      attempts: [attempt],
      terminal_reason: "success",
    };
  }

  /**
   * `detached: true` puts the child in its own process group; the worker
   * spawns shell commands as grandchildren, and killing only the Python
   * process would leave them running (holding the workdir, still talking to
   * Vertex). Signalling the negative pid takes the whole group. `shell: false`
   * (default) prevents re-parsing user paths in the argv. The group is stopped
   * only by the heartbeat kill rule, or by the request's own stop.
   */
  private spawnWorker(
    args: string[],
    cwd: string,
    workLimitS: number,
    waitBoundS: number,
    packetId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; stdout: string; error: string; code: number | null; killed: string | null; lastBeat: Heartbeat | null }> {
    const spawnStarted = Date.now();
    return new Promise((resolveRun) => {
      const child = spawn(this.python, args, {
        cwd,
        detached: true,
        env: buildWorkerEnv(process.env as Record<string, string | undefined>, {
          project: this.project,
          location: this.location,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let stderrLineBuf = "";
      const watch = watchWorker(child, { workLimitS, waitBoundS, backstop: this.backstop });
      const onAbort = () => watch.stop(STOPPED_BY_REQUEST);
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text; // still buffered whole, for tail() on the error path

        // Streamed line by line at TRACE — was previously discarded entirely
        // on success and only the last STDERR_TAIL_CHARS survived a failure.
        stderrLineBuf += text;
        const lines = stderrLineBuf.split("\n");
        stderrLineBuf = lines.pop() ?? "";
        for (const line of lines) {
          log("trace", "agsdk.worker.stderr", { packet_id: packetId, line });
        }
      });

      let settled = false;
      const settle = (r: Parameters<typeof resolveRun>[0]) => {
        if (settled) return;
        settled = true;
        watch.closed();
        signal?.removeEventListener("abort", onAbort);
        resolveRun(r);
      };

      child.on("error", (err) => {
        settle({ ok: false, stdout, code: null, killed: null, lastBeat: watch.lastBeat, error: `Could not start the agent worker with '${this.python}': ${err.message}` });
      });

      child.on("close", (code) => {
        if (stderrLineBuf) {
          log("trace", "agsdk.worker.stderr", { packet_id: packetId, line: stderrLineBuf });
          stderrLineBuf = "";
        }
        const killed = watch.reason;
        log("info", "agsdk.exit", {
          packet_id: packetId,
          exit_code: code,
          killed: killed ?? undefined,
          duration_ms: Date.now() - spawnStarted,
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
        });
        const tailText = tail(withoutHeartbeats(stderr));
        if (killed !== null) {
          if (killed !== STOPPED_BY_REQUEST) log("warn", "agsdk.backstop_kill", { packet_id: packetId, reason: killed });
          settle({
            ok: false, stdout, code, killed, lastBeat: watch.lastBeat,
            error: `The agent worker was stopped: ${killed}${watch.lastBeat ? "; its tokens are its last heartbeat's" : ""}. ${tailText}`,
          });
          return;
        }
        if (code !== 0) {
          settle({ ok: false, stdout, code, killed: null, lastBeat: watch.lastBeat, error: `The agent worker exited ${code}. ${tailText}` });
          return;
        }
        settle({ ok: true, stdout, code, killed: null, lastBeat: watch.lastBeat, error: "" });
      });
    });
  }

  /**
   * Never fail the delegation over the receipt. stderr, not stdout — stdout
   * is the MCP transport.
   */
  private writeRecord(path: string, input: Parameters<typeof buildDelegationRecord>[0]): void {
    try {
      writeFileSync(path, JSON.stringify(buildDelegationRecord(input), null, 2), "utf8");
      log("debug", "agsdk.record.write", { packet_id: input.packet.id, path, ok: true });
    } catch (err: any) {
      log("debug", "agsdk.record.write", { packet_id: input.packet.id, path, ok: false });
      process.stderr.write(
        `[antigravity-worker] could not write the delegation record to '${path}': ` +
          `${err?.message ?? err}. The delegation itself was unaffected.\n`,
      );
    }
  }

  /** Pre-subprocess failure. Zeros throughout — no tokens spent. */
  private failure(started: number, error: string): ExecutionResult {
    const tokens = { input: 0, input_cached: 0, output: 0 };
    const latency = Date.now() - started;
    return {
      result: null,
      tokens,
      cost_usd: 0,
      latency_ms: latency,
      cache_hit: false,
      success: false,
      error,
      attempts: [
        {
          attempt_number: 1,
          ceiling_used: 0,
          hit_output_cap: false,
          tokens,
          cost_usd: 0,
          latency_ms: latency,
          success: false,
          error,
        },
      ],
      terminal_reason: "vendor_error",
    };
  }
}

/**
 * A packet id dispatched again keeps every earlier dispatch's evidence: its delegation record and usage sidecar are
 * renamed `<name>.<n>.json` (n counting up) before the new dispatch starts, so the newest keeps the plain name, and a
 * worker that writes no sidecar is never billed an earlier dispatch's usage.
 */
function keepEarlierDispatch(outDir: string, stem: string): void {
  const record = join(outDir, `worker-delegation-${stem}.json`);
  const usage = join(outDir, `worker-usage-${stem}.json`);
  if (!existsSync(record) && !existsSync(usage)) return;
  const taken = new RegExp(`^worker-(?:delegation|usage)-${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.json$`);
  let n = 0;
  for (const name of readdirSync(outDir)) {
    const m = taken.exec(name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  n += 1;
  for (const [from, prefix] of [[record, "worker-delegation"], [usage, "worker-usage"]] as const) {
    if (existsSync(from)) renameSync(from, join(outDir, `${prefix}-${stem}.${n}.json`));
  }
  log("info", "agsdk.record.kept", { stem, as: n });
}

/** Absent and unparseable are the same answer — null → mapSidecarTokens → zeros. */
function readJsonIfPresent(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "No output on stderr.";
  return trimmed.length <= STDERR_TAIL_CHARS
    ? trimmed
    : `...${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}
