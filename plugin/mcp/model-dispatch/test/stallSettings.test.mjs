/**
 * The Antigravity doors' call limits live in one table (dist/executor/stall.js): a call's stall limit from its model
 * when the policy leaf sets none (Flash 180 s, Argon 300 s, any other model 300 s), two tries against stalls, the
 * 120 s busy budget, the 10 s heartbeat and the kill rule's thresholds, the bound on one call's wait they imply, and
 * the 300 s window after which a run that Google serves nothing stops. Each door hands the leaf's settings to its worker: the leaf's own location first,
 * then its failover_locations, its stall limit, and the failover retry (1 retry after 1 s) only for a leaf that opts
 * into failover; every other leaf keeps the executor's retry rule. Offline: a stand-in worker interpreter records the
 * flags it was given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeWorkerPython, flagValue, withEnv } from "./agyFakes.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { AgyTypist } = await import(join(DIST, "executor", "typists.js"));
const { typistForLeaf, TRANSPORT } = await import(join(DIST, "executor", "tools.js"));
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));

/** The stall table, or a failure that says it does not exist yet (instead of failing the whole file at import). */
async function stallTable() {
  try {
    return await import(join(DIST, "executor", "stall.js"));
  } catch (e) {
    assert.fail(`dist/executor/stall.js (src/executor/stall.ts) could not be loaded: ${e.message}`);
  }
}

const FLASH = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const ARGON = { id: "argon", adapter: "antigravity-worker", model_name: "gemini-4-argon" };
const ANSWER = { finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), usage: { prompt_token_count: 10, candidates_token_count: 2 }, sdk_version: "0.1.22", tool_calls: ["finish"] };

async function typistArgs(leaf, env = {}) {
  const fake = fakeWorkerPython({ runs: [{ receipt: ANSWER }] });
  const dir = mkdtempSync(join(tmpdir(), "stall-args-"));
  try {
    writeFileSync(join(dir, "shared.txt"), "");
    await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", ...env }, async () => {
      const typist = typistForLeaf(leaf, "estimated");
      assert.ok(typist instanceof AgyTypist);
      await typist.type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" });
    });
    const [run] = fake.runs();
    assert.ok(run, "the worker was not started");
    return run.args;
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

// W-stall-defaults: the defaults clear Google's healthy first-token and answer times.
test("a call's stall limit comes from its model when the leaf sets none: Flash 180 s, Argon 300 s, any other 300 s; a leaf's stall_sec wins", async () => {
  const { stallSecFor } = await stallTable();
  for (const m of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"]) assert.equal(stallSecFor({ ...FLASH, model_name: m }), 180, m);
  assert.equal(stallSecFor(ARGON), 300);
  assert.equal(stallSecFor({ ...FLASH, model_name: "gemini-9-unlisted" }), 300, "the safe direction for a model with no data");
  assert.equal(stallSecFor({ ...ARGON, stall_sec: 45 }), 45);
  assert.equal(stallSecFor({ ...FLASH, stall_sec: 600 }), 600);
});

// W-stall-defaults, the rest of the one table: a measured change is one line here.
test("the table holds two stall tries, the 120 s busy budget, the 10 s heartbeat, the kill rule's 60 s / 20 s / 10 s / 60 s, and the 300 s busy window", async () => {
  const t = await stallTable();
  assert.equal(t.STALL_TRIES, 2);
  assert.equal(t.BUSY_BUDGET_SEC, 120);
  assert.equal(t.HEARTBEAT_SEC, 10);
  assert.deepEqual(t.BACKSTOP, { noBeatS: 60, confirmS: 20, termGraceS: 10, overrunS: 60 });
  assert.equal(t.BUSY_WINDOW_SEC, 300);
  assert.ok(t.STALL_SEC_DEFAULTS && typeof t.STALL_SEC_DEFAULTS === "object");
});

// The engine's bound on one call's wait (the kill rule reads it), from the same table.
test("one call's wait bound is its stall tries, the busy budget and the harness's retry waits on every try: 1,168 s for a Flash call on the executor's retry rule, 666 s with the failover rule", async () => {
  const t = await stallTable();
  assert.equal(typeof t.harnessRetryWaitSec, "function", "stall.ts exports harnessRetryWaitSec");
  assert.equal(t.harnessRetryWaitSec({ retries: 6, initialMs: 2000 }), 254, "2+4+8+16+32+64 s of waits, then 128 s allowed on the last retry");
  assert.equal(t.harnessRetryWaitSec(t.FAILOVER_API_RETRY), 3);
  assert.equal(t.harnessRetryWaitSec({ retries: 0, initialMs: 2000 }), 0, "no retries: nothing waited");
  assert.equal(t.callWaitBoundSec(180, { tries: 2, retry: t.AGENT_API_RETRY }), 180 + 360 + 120 + 2 * 254);
  assert.equal(t.callWaitBoundSec(180), 1168, "the defaults are the agent door's: two tries, six retries from 2 s, the busy budget");
  assert.equal(t.callWaitBoundSec(180, { tries: 2, retry: t.FAILOVER_API_RETRY }), 666);
  assert.equal(t.callWaitBoundSec(300, { tries: 2, retry: t.AGENT_API_RETRY }), 1528, "Argon");
  assert.equal(t.callWaitBoundSec(180, { tries: 1, retry: { retries: 6, initialMs: 2000 } }), 554, "the run-start probe of a leaf without failover");
  assert.equal(t.callWaitBoundSec(180, { tries: 1, retry: { retries: 0, initialMs: 2000 }, busyBudgetSec: 0 }), 180, "a probe call pinned to one location");
});

// The heartbeat contract: one stderr line, `@mmo-heartbeat <json>`, version 1.
test("a heartbeat line is parsed to its fields; any other stderr line, or a cut one, is no heartbeat", async () => {
  const { parseHeartbeat } = await stallTable();
  const hb = { v: 1, state: "wait", work_s: 12.5, wait_s: 3, call_wait_s: 2, slept_s: 0, try: 2, location: "us", usage: { global: { prompt_token_count: 0 }, us: { prompt_token_count: 1200 } } };
  assert.deepEqual(parseHeartbeat(`@mmo-heartbeat ${JSON.stringify(hb)}`), hb);
  assert.equal(parseHeartbeat("Traceback (most recent call last):"), null);
  assert.equal(parseHeartbeat('@mmo-heartbeat {"v":1,"state":"wa'), null);
});

// typistForLeaf: failover is a setting a policy opts into.
test("a typist leaf that lists failover_locations gets the failover retry (1 retry after 1 s); a leaf without it keeps the executor's rule", async () => {
  await withEnv({ GEMINI_WORKER_PYTHON: process.execPath, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () => {
    const failover = typistForLeaf({ ...FLASH, failover_locations: ["us", "eu"] }, "estimated");
    assert.deepEqual([failover.opts.apiRetries, failover.opts.apiRetryInitialMs], [1, 1000]);
    const plain = typistForLeaf(FLASH, "estimated");
    assert.deepEqual([plain.opts.apiRetries, plain.opts.apiRetryInitialMs], [TRANSPORT.maxWaits, TRANSPORT.baseMs]);
  });
});

// AgyTypist: the leaf's settings reach the worker.
test("the agent typist hands its worker the leaf's locations in order, its stall limit and the call budgets", async () => {
  const fo = await typistArgs({ ...FLASH, failover_locations: ["us", "eu"] });
  assert.equal(flagValue(fo, "--locations"), "global,us,eu", "the leaf's own location first, then its list");
  assert.equal(flagValue(fo, "--stall-sec"), "180");
  assert.equal(flagValue(fo, "--stall-tries"), "2");
  assert.equal(flagValue(fo, "--busy-budget-sec"), "120");
  assert.equal(flagValue(fo, "--heartbeat-sec"), "10");
  assert.deepEqual([flagValue(fo, "--api-retries"), flagValue(fo, "--api-retry-initial-ms")], ["1", "1000"]);
  const own = await typistArgs({ ...ARGON, region: "us", stall_sec: 45 });
  assert.equal(flagValue(own, "--locations"), "us");
  assert.equal(flagValue(own, "--stall-sec"), "45");
  assert.deepEqual([flagValue(own, "--api-retries"), flagValue(own, "--api-retry-initial-ms")], ["6", "2000"]);
  assert.equal(flagValue(own, "--timeout"), "540", "the typist's time limit keeps its value");
});

// The agent door's adapter: buildWorkerArgs passes every new flag on every call.
test("the agent door hands its worker the leaf's locations, stall limit, call budgets and retry rule", async () => {
  const fake = fakeWorkerPython({ runs: [{ sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: '{"ok":true}' }] });
  const dir = mkdtempSync(join(tmpdir(), "stall-agent-"));
  try {
    mkdirSync(join(dir, "work"));
    const packet = { id: "tp_x_001", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
      for (const leaf of [{ ...ARGON, failover_locations: ["us"] }, { ...FLASH, worker_timeout_sec: 600 }]) {
        const out = await new AntigravityWorkerAdapter(leaf).execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") });
        assert.equal(out.success, true, out.error);
      }
    });
    const [argon, flash] = fake.runs().map((r) => r.args);
    assert.equal(flagValue(argon, "--locations"), "global,us");
    assert.equal(flagValue(argon, "--stall-sec"), "300");
    assert.deepEqual([flagValue(argon, "--api-retries"), flagValue(argon, "--api-retry-initial-ms")], ["1", "1000"]);
    assert.equal(flagValue(flash, "--locations"), "global");
    assert.equal(flagValue(flash, "--stall-sec"), "180");
    assert.deepEqual([flagValue(flash, "--api-retries"), flagValue(flash, "--api-retry-initial-ms")], ["6", "2000"], "the executor's rule, not the SDK's unstated default");
    assert.equal(flagValue(flash, "--timeout"), "600", "worker_timeout_sec keeps its meaning and value");
    for (const f of ["--stall-tries", "--busy-budget-sec", "--heartbeat-sec"]) assert.ok(flash.includes(f), `${f} passed`);
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
