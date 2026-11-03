/**
 * The engine's bound on how long one Gemini call may wait on Google (executor/stall.ts callWaitBoundSec) covers
 * everything the worker allows a call while it keeps its own rules: every stall try, the busy budget, and on each try
 * the harness's own retry waits (a try may meet a refusal on every retry and then be held). The backstop kills a
 * worker whose heartbeat reports a call waiting past that bound, so a bound below it would kill a worker that is
 * waiting out Google exactly as told: the call would then count as an attempt and could reach the Claude leaf, and the
 * run-start probe would read a busy Google as broken credentials. The bound's values are in stallSettings.test.mjs,
 * with the table. Offline: the typist, the agent door and the probe with a stand-in worker that reports such a wait;
 * and the real typist worker against the scripted stand-in SDK, meeting refusals then a hold on both of its tries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beat, fakeWorkerPython, withEnv } from "./agyFakes.mjs";
import { NO_PYTHON, TEXT_429_RETRY, runWorker, step, tail } from "./agyStandin.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const stall = await import(join(DIST, "executor", "stall.js"));
const { AgyTypist } = await import(join(DIST, "executor", "typists.js"));
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));
const { probeTypists } = await import(join(DIST, "typistProbe.js"));

const FLASH = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const GOOGLE = { GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" };
const USAGE = { prompt_token_count: 1200, cached_content_token_count: 0, candidates_token_count: 300, thoughts_token_count: 40, total_token_count: 1540 };
const ANSWER = { finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), usage: USAGE, sdk_version: "0.1.22", tool_calls: ["finish"], tries: [{ location: "global", ended_by: "answer", http_codes: [429, 429, 429, 429, 429, 429], s: 900, usage: USAGE, served_tier: "standard" }] };
/** Six refusals waited out by the harness (126 s), then a held retry at its stall limit plus the harness's next wait: one try's 434 s, then the second try, 600 s in. */
const LONG_WAIT = 1000;

/** A stand-in worker run that reports one call waiting LONG_WAIT s, then ends with `body`. */
const longWait = (body) => ({ beats: [{ atMs: 100, hb: beat({ call_wait_s: LONG_WAIT, work_s: 1 }) }], holdMs: 2500, ...body });

// The typist door's call site: the bound of the worker's own settings.
test("the agent typist does not kill a worker that reports a call waiting past the old bound but within its own rules: the call answers", async () => {
  const fake = fakeWorkerPython({ runs: [longWait({ receipt: ANSWER })] });
  const dir = mkdtempSync(join(tmpdir(), "wait-bound-typist-"));
  try {
    writeFileSync(join(dir, "shared.txt"), "");
    const r = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, ...GOOGLE }, () => {
      const typist = new AgyTypist(FLASH, { effort: "low", maxModelCalls: 3, timeoutSec: 540, apiRetries: 6, apiRetryInitialMs: 2000, backstop: { confirmS: 1 } });
      return typist.type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" });
    });
    assert.deepEqual(r.answer, { path: "a.txt", content: "x\n" }, `the worker was stopped: ${r.error}`);
    assert.equal(fake.events().filter((e) => e.ev === "term").length, 0, "no SIGTERM");
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The agent door's call site.
test("the agent door does not kill a worker that reports a call waiting past the old bound but within its own rules: the dispatch answers", async () => {
  const fake = fakeWorkerPython({ runs: [longWait({ sidecar: { sdk_version: "0.1.22", usage: USAGE }, stdout: '{"ok":true}' })] });
  const dir = mkdtempSync(join(tmpdir(), "wait-bound-agent-"));
  try {
    mkdirSync(join(dir, "work"));
    const packet = { id: "tp_x_001", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    const out = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, ...GOOGLE }, () =>
      new AntigravityWorkerAdapter(FLASH, { backstop: { confirmS: 1 } }).execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") }));
    assert.equal(out.success, true, out.error);
    assert.deepEqual(out.result, { ok: true });
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The run-start probe of a leaf without failover: six refusals, then a hold, is a busy Google.
test("the run-start probe does not kill a worker that waits out six refusals and then a hold: the call that comes back unavailable passes as busy", async () => {
  const unavailable = "refused at global (7 requests over 430 s; last HTTP 429 RESOURCE_EXHAUSTED)";
  const receipt = { finish_output: null, usage: { prompt_token_count: 0, candidates_token_count: 0 }, sdk_version: "0.1.22", tool_calls: [], error: `Google could not serve gemini-3.8-flash: ${unavailable}`, error_type: "AntigravityExecutionError", error_status: 429, unavailable };
  // 126 s of refusals and the held retry's 308 s: past the old 360 s line, within the probe's 554 s.
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat({ call_wait_s: 434, work_s: 1 }) }], holdMs: 6500, receipt }] });
  try {
    const [o] = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, ...GOOGLE }, () => probeTypists([FLASH], "estimated"));
    assert.equal(o.ok, true, `the probe stopped the run: ${o.reason}`);
    assert.equal(o.busy, true);
    assert.equal(fake.events().filter((e) => e.ev === "term").length, 0, "no SIGTERM");
  } finally {
    fake.cleanup();
  }
});

// The contract itself, on the real worker: the most it lets one call wait is within the bound of its settings.
test("the real typist worker meeting a refusal on every harness retry and then a hold, on both tries, reports a call wait within the bound of its own settings", { skip: NO_PYTHON }, async () => {
  const retry = { retries: 6, initialMs: 50 };
  const args = ["--stall-sec", "1", "--stall-tries", "2", "--busy-budget-sec", "1", "--heartbeat-sec", "1", "--api-retries", String(retry.retries), "--api-retry-initial-ms", String(retry.initialMs)];
  // The harness emits each refusal's step as it sends its next retry, its first wait doubling: 0.05, 0.15, 0.35 ...
  const at = []; let t = 0;
  for (let j = 0; j < retry.retries; j++) { t += (retry.initialMs / 1000) * 2 ** j; at.push(Math.round(t * 1000) / 1000); }
  const refusedThenHeld = { turns: [[{ at: 0, step: step.user() }, ...at.map((s) => ({ at: s, step: step.error(429, TEXT_429_RETRY) })), { at: at[at.length - 1], hold: true }]] };
  const r = await runWorker("typist", { script: { sessions: [refusedThenHeld, refusedThenHeld] }, args, timeout: 60 });
  assert.equal(r.code, 0, tail(r));
  const rc = r.receipt;
  assert.deepEqual(rc?.tries?.map((x) => x.ended_by), ["stalled", "stalled"], JSON.stringify(rc));
  assert.match(String(rc.unavailable), /stall/i);
  const bound = stall.callWaitBoundSec(1, { tries: 2, retry, busyBudgetSec: 1 });
  const waited = Math.max(rc.google_wait_s, ...r.beats.map((b) => b.hb?.call_wait_s ?? 0));
  assert.ok(waited <= bound, `the call waited ${waited} s; the bound of its settings is ${bound} s`);
  // Each try met every retry's refusal before its hold: a bound with one try's retry waits would already be passed.
  assert.ok(waited > 1 + 2 + 1 + stall.harnessRetryWaitSec(retry), `both tries' retry waits are part of it (${waited} s)`);
});
