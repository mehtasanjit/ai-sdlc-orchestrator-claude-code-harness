/**
 * ClaudeCliAdapter — routes an Anthropic call through the local `claude -p`
 * subprocess, so a Claude Max subscription's OAuth session backs the request
 * instead of ANTHROPIC_API_KEY.
 *
 * Cost: the worker is priced from its own token ledger with the dated price
 * list (claudeCliLedger.ts), the same list every other dispatch uses. The
 * CLI's `total_cost_usd` used to be copied into cost_usd verbatim; it comes
 * from Claude Code's own price table, which has been stale (2026-08-24: Opus
 * at exactly 0.6x), so it is now kept beside the cost as
 * `cli_reported_cost_usd` and a warning is logged when the two differ by more
 * than 0.5%. A worker whose own model has no price is refused before `claude`
 * is spawned.
 *
 * Every call spawns a fresh `claude` process, which loads roughly 17k tokens
 * of session context before the packet's prompt runs. `usage.cache_creation`
 * captures that overhead; it is visible in the telemetry as cache writes.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { estimateTokens } from "../pricing.js";
import { log } from "../log.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { DispatchPricer, systemClock, unpricedRefusal, type Clock } from "./dispatchPricer.js";
import {
  claudeProjectsDir,
  findWorkerTranscripts,
  priceClaudeCliResult,
  readWorkerTranscript,
  type ClaudeCliResultLike,
  type WorkerLedger,
} from "./claudeCliLedger.js";

type SpawnFn = typeof spawn;
type VersionProbe = () => void;

const DEFAULT_TIMEOUT_SEC = 300;

interface ClaudeCliOptions {
  spawnFn?: SpawnFn;
  probeBinary?: VersionProbe;
  timeoutSec?: number;
  /** Where the worker session's transcript is looked up. Default: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  projectsDir?: string;
  /** Clock for the dispatch date the price is looked up on; tests pin it. */
  now?: Clock;
}

interface ClaudeCliResponse extends ClaudeCliResultLike {
  /** Always `"result"` on the final JSON object `claude -p` prints. */
  type?: string;
  /**
   * The CLI's actual success signal: `"success"` on a completed run,
   * `"error_max_turns"` / `"error_during_execution"` on failures. This —
   * not `terminal_reason` — is what the result JSON carries; the CLI never
   * emits a `terminal_reason` field on success, which is why the old
   * `terminal_reason !== "completed"` check classified every real success
   * as an error.
   */
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  [key: string]: unknown;
}

export class ClaudeCliAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private cachedSystem = "";
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly projectsDir: string;
  private readonly pricer: DispatchPricer;

  /**
   * Constructor verifies the `claude` binary is reachable rather than probing
   * for OAuth state — the CLI surfaces its own auth errors far more clearly
   * than a filesystem check on `~/.claude/` could.
   */
  constructor(config: ModelConfig, options: ClaudeCliOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = (options.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    this.projectsDir = options.projectsDir ?? claudeProjectsDir();
    this.pricer = new DispatchPricer(config, options.now ?? systemClock);

    const probe =
      options.probeBinary ??
      (() => {
        execFileSync("claude", ["--version"], { stdio: "pipe" });
      });
    try {
      probe();
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          `ClaudeCliAdapter needs the \`claude\` binary on PATH for model '${config.id}'. ` +
            `Install Claude Code (https://docs.claude.com/en/docs/claude-code) or add it to PATH.`,
        );
      }
      throw new Error(
        `ClaudeCliAdapter could not probe \`claude --version\` for model '${config.id}': ` +
          `${err?.message ?? err}`,
      );
    }
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const started = Date.now();
    // Priced on the day the dispatch starts. A worker whose own model has no
    // price is never spawned: its dollars could not be reported.
    const dispatchDate = this.pricer.now();
    const primary = this.pricer.price(dispatchDate);
    if (primary.unpriced) {
      return this.failure(packet, { input: 0, input_cached: 0, output: 0 }, started, unpricedRefusal(this.modelConfig, dispatchDate, primary.reason));
    }

    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    const prompt = stableBlock ? `${stableBlock}\n\n${userPrompt}` : userPrompt;

    const run = await this.runClaudeCli(prompt);

    if (!run.ok) {
      return this.failure(packet, { input: estimateTokens(prompt), input_cached: 0, output: 0 }, started, run.error);
    }

    const response = run.response;
    // Success is `subtype === "success"` — the field the CLI actually emits
    // on its result JSON. The old check compared `terminal_reason` against
    // `"completed"`, a field/value pair the CLI never produces, so every
    // successful call was misclassified as a vendor_error and the whole
    // Max-subscription tier "failed" every packet. A payload with no
    // `subtype` at all still lands on the error side — absence of the
    // success signal is not success.
    const isError = response.is_error === true || response.subtype !== "success";

    // An errored call still billed its tokens, so it is priced the same way.
    const ledger = this.ledgerFor(response, dispatchDate);
    const attemptTokens = ledger.tokens;
    const cost = ledger.cost_usd;
    const latency = response.duration_api_ms ?? response.duration_ms ?? Date.now() - started;
    const stopReason = response.stop_reason;
    const hitOutputCap = stopReason === "max_tokens";

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      stop_reason: stopReason,
      hit_output_cap: hitOutputCap,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      success: !isError,
      error: isError ? response.result ?? response.subtype ?? "claude-cli error" : undefined,
      ...(ledger.price_basis ? { price_basis: ledger.price_basis } : {}),
      unpriced_models: ledger.unpriced_models,
      ...(ledger.cli_reported_cost_usd !== undefined ? { cli_reported_cost_usd: ledger.cli_reported_cost_usd } : {}),
      // Present when the worker's transcript was read: the share of cost_usd
      // its transcript explains, which is all the collector's scan can see of
      // this worker, so the collector subtracts only this (review finding M4).
      ...(ledger.transcript_logged_cost_usd !== undefined ? { transcript_logged_cost_usd: ledger.transcript_logged_cost_usd } : {}),
      ttl_split: ledger.ttl_split,
      per_model: ledger.per_model,
    };

    if (isError) {
      return {
        result: null,
        tokens: attemptTokens,
        cost_usd: cost,
        latency_ms: latency,
        cache_hit: attemptTokens.input_cached > 0,
        success: false,
        error: attempt.error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    const text = (response.result ?? "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    return {
      result: parsed,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      cache_hit: attemptTokens.input_cached > 0,
      success: true,
      attempts: [attempt],
      terminal_reason: "success",
    };
  }

  /**
   * Price the result from its ledger and log what a reader must know: a
   * policy block that differs from the list, a billed model with no price,
   * and a CLI figure more than 0.5% away from the list's. A transcript that
   * cannot be found or read only makes the TTL split approximate; it never
   * fails the call.
   */
  private ledgerFor(response: ClaudeCliResponse, dispatchDate: Date): WorkerLedger {
    let transcript = null;
    try {
      const files = findWorkerTranscripts(this.projectsDir, response.session_id);
      transcript = files ? readWorkerTranscript(files, response.session_id as string) : null;
    } catch {
      transcript = null;
    }
    const ledger = priceClaudeCliResult(response, { config: this.modelConfig, date: dispatchDate, transcript });

    this.pricer.logWarnings(ledger.warnings);
    for (const u of ledger.unpriced_models) {
      log("warn", "pricing.unpriced", { model_id: this.id, model: u.model, reason: u.reason });
    }
    if (ledger.cli_mismatch) {
      const m = ledger.cli_mismatch;
      log("warn", "pricing.cli_cost_mismatch", {
        model_id: this.id,
        cli_usd: m.cli_usd,
        list_usd: m.list_usd,
        delta_pct: m.delta_pct,
        ttl_split: ledger.ttl_split,
        models: m.models.length ? m.models.join(",") : undefined,
        message:
          "Claude Code's own dollar figure differs from the price list by more than 0.5%. cost_usd uses the list; " +
          "the CLI figure is kept as cli_reported_cost_usd. Either Claude Code's price table is stale (2026-08-24 " +
          "billed Opus at exactly 0.6x) or the cache-write TTL split was approximate.",
      });
    }
    return ledger;
  }

  /** A call that billed nothing measurable: refused before spawning, or the CLI never produced a result. */
  private failure(
    packet: TaskPacket,
    tokens: { input: number; input_cached: number; output: number },
    started: number,
    error: string,
  ): ExecutionResult {
    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      hit_output_cap: false,
      tokens,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      success: false,
      error,
    };
    return {
      result: null,
      tokens,
      cost_usd: 0,
      latency_ms: attempt.latency_ms,
      cache_hit: false,
      success: false,
      error,
      attempts: [attempt],
      terminal_reason: "vendor_error",
    };
  }

  private runClaudeCli(
    prompt: string,
  ): Promise<{ ok: true; response: ClaudeCliResponse } | { ok: false; error: string }> {
    return new Promise((resolveRun) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(
          "claude",
          ["-p", "--model", this.modelConfig.model_name, "--output-format", "json"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (err: any) {
        resolveRun({ ok: false, error: `claude-cli spawn failed: ${err?.message ?? err}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: Awaited<ReturnType<typeof this.runClaudeCli>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: `claude-cli timeout after ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        finish({ ok: false, error: `claude-cli process error: ${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0 && !stdout.trim()) {
          finish({
            ok: false,
            error: `claude-cli exited ${code}. ${stderr.trim() || "no stderr"}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as ClaudeCliResponse;
          finish({ ok: true, response: parsed });
        } catch (err: any) {
          finish({
            ok: false,
            error: `claude-cli JSON parse failed: ${err?.message ?? err}. stdout head: ${stdout.slice(0, 200)}`,
          });
        }
      });

      try {
        child.stdin?.end(prompt);
      } catch (err: any) {
        finish({ ok: false, error: `claude-cli stdin write failed: ${err?.message ?? err}` });
      }
    });
  }
}
