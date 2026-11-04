/**
 * The engine's kill rule for an Antigravity worker reads the worker's heartbeat instead of a fixed timer that counts
 * the Mac's sleep. It kills the worker's process group only when two checks at least `confirmS` apart both find no
 * heartbeat for `noBeatS` (60 s and 20 s), or when the last heartbeat reports work or a call's wait beyond its bound
 * plus `overrunS`; it sends SIGTERM first, and SIGKILL `termGraceS` later. A killed worker's tokens and cost come
 * from its last heartbeat; a worker that answers SIGTERM with its receipt is billed from the receipt. Heartbeat lines
 * never reach an error text. Offline: the rule on a fake clock (HeartbeatBackstop in dist/executor/stall.js), and the
 * typist and the agent door against a stand-in worker interpreter on shortened thresholds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alive, beat, fakeWorkerPython, groupAlive, withEnv } from "./agyFakes.mjs";
import { NO_PYTHON, PYTHON, STANDIN, step } from "./agyStandin.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { AgyTypist } = await import(join(DIST, "executor", "typists.js"));
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));
const { computeCostUsd } = await import(join(DIST, "pricing.js"));
const { lookupPrice } = await import(join(DIST, "prices.js"));

async function stallTable() {
  try {
    return await import(join(DIST, "executor", "stall.js"));
  } catch (e) {
    assert.fail(`dist/executor/stall.js (src/executor/stall.ts) could not be loaded: ${e.message}`);
  }
}

const FLASH = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const MIN = 60_000;
/** Thresholds a test can wait out: no heartbeat for 2 s on two checks 1 s apart, then SIGKILL 1 s after SIGTERM. */
const SHORT = { noBeatS: 2, confirmS: 1, termGraceS: 1 };
/** A frozen worker's last billed call: 1,200 input and 300 + 40 output tokens, then the worker stops. */
const BILLED = { prompt_token_count: 1200, cached_content_token_count: 0, candidates_token_count: 300, thoughts_token_count: 40, total_token_count: 1540 };
const flashCost = (tokens) => computeCostUsd(tokens, lookupPrice("gemini-3.8-flash", new Date().toISOString()).pricing);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One typist call against the stand-in, given up on (and its process killed) after `limitMs`. */
async function typeOnce(fake, { limitMs = 15_000, backstop = SHORT, timeoutSec = 600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backstop-"));
  writeFileSync(join(dir, "shared.txt"), "");
  try {
    return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
      const typist = new AgyTypist(FLASH, { effort: "LOW", maxModelCalls: 3, timeoutSec, apiRetries: 6, apiRetryInitialMs: 2000, backstop });
      const started = Date.now();
      const r = await Promise.race([
        typist.type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" }),
        sleep(limitMs).then(() => null),
      ]);
      return { r, ms: Date.now() - started, endedAt: Date.now() };
    });
  } finally {
    for (const s of fake.runs()) if (alive(s.pid)) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}

// E-backstop-sleep: Node's timers count the Mac's sleep; the worker's clock does not.
test("after the Mac sleeps, a check that finds the last heartbeat 20 minutes old is not a kill when the worker beats again within the confirmation window", async () => {
  const { HeartbeatBackstop } = await stallTable();
  const b = new HeartbeatBackstop({ startedAtMs: 0, workLimitS: 540, waitBoundS: 720 });
  b.beat(beat({ work_s: 1 }), 1_000);
  assert.equal(b.check(10_000), null);
  assert.equal(b.check(20 * MIN), null, "the check at wake finds a 20-minute-old heartbeat: one finding is not enough");
  b.beat(beat({ work_s: 2 }), 20 * MIN + 5_000);
  assert.equal(b.check(20 * MIN + 21_000), null, "the second check finds the fresh heartbeat");
  assert.equal(b.check(20 * MIN + 50_000), null);
  // The same through the typist, in real time: a worker that stops beating for longer than noBeatS and beats again
  // within the confirmation window is not killed, and its answer stands.
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat() }, { atMs: 2_700, hb: beat({ work_s: 2 }) }, { atMs: 3_200, hb: beat({ work_s: 3 }) }, { atMs: 3_700, hb: beat({ work_s: 4 }) }], holdMs: 4_000, receipt: { finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), usage: BILLED, sdk_version: "0.1.22", tool_calls: ["finish"] } }] });
  try {
    const { r } = await typeOnce(fake, { backstop: { ...SHORT, confirmS: 2 } });
    assert.ok(r?.answer, `the worker was killed: ${JSON.stringify(r)}`);
    assert.ok(!fake.events().some((e) => e.ev === "term"), "no SIGTERM was sent");
  } finally {
    fake.cleanup();
  }
});

// E-backstop-hung: a worker that never beats is stopped within a set time.
test("a worker with no heartbeat is killed once two checks at least confirmS apart both find none for noBeatS, and not before", async () => {
  const { HeartbeatBackstop } = await stallTable();
  const b = new HeartbeatBackstop({ startedAtMs: 0, workLimitS: 540, waitBoundS: 720 });
  assert.equal(b.check(59_000), null, "under 60 s with no heartbeat");
  assert.equal(b.check(61_000), null, "the first finding");
  assert.equal(b.check(70_000), null, "a second finding under 20 s later is not enough");
  assert.equal(typeof b.check(81_000), "string", "two findings 20 s apart: the reason to kill");
  const fake = fakeWorkerPython({ runs: [{ holdMs: "forever" }] });
  try {
    const { r, ms } = await typeOnce(fake);
    assert.ok(r, "the hung worker was not stopped within 15 s");
    assert.equal(r.answer, null);
    assert.match(String(r.error), /heartbeat/i, r.error);
    assert.ok(ms >= 2_000 && ms < 10_000, `stopped after ${ms} ms (noBeatS 2 s + confirmS 1 s)`);
    assert.ok(fake.events().some((e) => e.ev === "term"), "SIGTERM first");
  } finally {
    fake.cleanup();
  }
});

// E-backstop-runaway: a live loop whose supervisor failed to enforce its own limits.
test("a heartbeat reporting work beyond the work limit, or a call's wait beyond its bound, by more than overrunS is a reason to kill", async () => {
  const { HeartbeatBackstop } = await stallTable();
  const work = new HeartbeatBackstop({ startedAtMs: 0, workLimitS: 540, waitBoundS: 720 });
  work.beat(beat({ work_s: 590 }), 10_000);
  assert.equal(work.check(11_000), null, "within the limit + 60 s");
  work.beat(beat({ work_s: 601 }), 20_000);
  assert.equal(typeof work.check(21_000), "string");
  const wait = new HeartbeatBackstop({ startedAtMs: 0, workLimitS: 540, waitBoundS: 720 });
  wait.beat(beat({ call_wait_s: 781 }), 10_000);
  assert.equal(typeof wait.check(11_000), "string");
});

// E-killed-heartbeat-usage.
test("a typist worker killed after its heartbeat stopped is billed the usage of its last heartbeat, and the error says so", async () => {
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat() }, { atMs: 600, hb: beat({ state: "wait", usage: { global: BILLED } }) }], holdMs: "forever", ignoreTerm: true }] });
  try {
    const { r, ms } = await typeOnce(fake);
    assert.ok(r, "the frozen worker was not stopped within 15 s");
    assert.equal(r.answer, null);
    assert.deepEqual({ input: r.tokens.input, input_cached: r.tokens.input_cached, output: r.tokens.output }, { input: 1200, input_cached: 0, output: 340 });
    assert.ok(Math.abs(r.cost_usd - flashCost({ input: 1200, input_cached: 0, output: 340 })) < 1e-9, `cost ${r.cost_usd}`);
    assert.match(String(r.error), /heartbeat/i, r.error);
    assert.doesNotMatch(String(r.error), /usage is unknown/);
    assert.ok(ms < 12_000, `${ms} ms`);
  } finally {
    fake.cleanup();
  }
});

// E-backstop-sigterm-first: SIGTERM first, SIGKILL later.
test("the kill rule sends SIGTERM first: a worker that answers it with its receipt is billed from the receipt; one that ignores it is SIGKILLed termGraceS later", async () => {
  const kept = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat({ usage: { global: { prompt_token_count: 1 } } }) }], holdMs: "forever", onTerm: { receipt: { finish_output: null, usage: BILLED, sdk_version: "0.1.22", tool_calls: [], error: "the session was stopped", error_type: "Terminated" }, exitCode: 143 } }] });
  try {
    const { r } = await typeOnce(kept);
    assert.ok(r, "not stopped within 15 s");
    assert.ok(kept.events().some((e) => e.ev === "term"));
    assert.ok(kept.events().some((e) => e.ev === "exit" && e.which === "term"), "the worker wrote its receipt on SIGTERM");
    assert.deepEqual({ input: r.tokens.input, output: r.tokens.output }, { input: 1200, output: 340 }, "the receipt's usage, not the heartbeat's");
  } finally {
    kept.cleanup();
  }
  const stubborn = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat() }], holdMs: "forever", ignoreTerm: true }] });
  // The engine's two signals to the worker's process group, timed here as the engine sends them: the time the stand-in
  // writes down for SIGTERM is later by however long its handler took to run.
  const signals = [];
  const kill = process.kill;
  process.kill = (pid, sig) => { if (pid < 0) signals.push({ sig, at: Date.now() }); return kill.call(process, pid, sig); };
  try {
    const { r } = await typeOnce(stubborn);
    assert.ok(r, "not stopped within 15 s");
    const term = stubborn.events().find((e) => e.ev === "term");
    assert.ok(term, "SIGTERM first");
    const [run] = stubborn.runs();
    assert.equal(alive(run.pid), false, "SIGKILL followed");
    const sentTerm = signals.find((s) => s.sig === "SIGTERM"), sentKill = signals.find((s) => s.sig === "SIGKILL");
    assert.ok(sentTerm && sentKill && sentTerm.at <= sentKill.at, `the engine's signals: ${JSON.stringify(signals)}`);
    const grace = sentKill.at - sentTerm.at;
    assert.ok(grace >= 900 && grace < 5_000, `SIGKILL came ${grace} ms after SIGTERM (termGraceS 1 s)`);
  } finally {
    process.kill = kill;
    stubborn.cleanup();
  }
});

// E-typist-server-gone. Review: a typist worker outlived its server: after the server was gone it went on with its call,
// up to its own limits, its spend never recorded. The real typist worker and the SDK stand-in, under a server killed
// with SIGKILL, which it cannot see coming.
test("a typist worker ends with its server, however the server ends: it stops as the kill rule stops it, and its receipt is written", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "typist-server-gone-"));
  // The call is out, billed so far, and never answered.
  writeFileSync(join(dir, "script.json"), JSON.stringify({ sessions: [{ turns: [[{ at: 0, step: step.user() }, { at: 0.1, usage: BILLED }, { at: 0.1, hold: true }]] }] }));
  writeFileSync(join(dir, "shared.txt"), "");
  const log = join(dir, "standin.jsonl");
  const python = join(dir, "python");
  writeFileSync(python, `#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(STANDIN)} AGY_STANDIN_SCRIPT=${JSON.stringify(join(dir, "script.json"))} AGY_STANDIN_LOG=${JSON.stringify(log)}\nexec ${JSON.stringify(PYTHON)} "$@"\n`);
  chmodSync(python, 0o755);
  const scratch = join(dir, "tmp");
  mkdirSync(scratch);
  // The server: one typing call through the agent typist, as a stage runs it.
  const server = join(dir, "server.mjs");
  writeFileSync(server, [
    `import { AgyTypist } from ${JSON.stringify(pathToFileURL(join(DIST, "executor", "typists.js")).href)};`,
    `const typist = new AgyTypist(${JSON.stringify(FLASH)}, { effort: "LOW", maxModelCalls: 3, timeoutSec: 600, apiRetries: 6, apiRetryInitialMs: 2000 });`,
    `await typist.type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: ${JSON.stringify(join(dir, "shared.txt"))}, contract: "file", passId: "r" });`,
  ].join("\n"));
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const child = spawn(process.execPath, [server], { env: { ...process.env, GEMINI_WORKER_PYTHON: python, GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", TMPDIR: scratch }, stdio: "ignore" });
  try {
    for (const until = Date.now() + 30_000; !events().some((e) => e.ev === "usage") && Date.now() < until; ) await sleep(50);
    const worker = events().find((e) => e.ev === "agent")?.pid;
    assert.ok(worker && events().some((e) => e.ev === "usage"), `the worker started and its call was billed: ${JSON.stringify(events().map((e) => e.ev))}`);
    child.kill("SIGKILL");
    for (const until = Date.now() + 8_000; (alive(worker) || groupAlive(worker)) && Date.now() < until; ) await sleep(50);
    assert.equal(alive(worker), false, "the typist worker outlived its server");
    assert.equal(groupAlive(worker), false, "a process of the worker's group outlived its server");
    assert.ok(events().some((e) => e.ev === "cancel" && e.pid === worker), "it ended its call in flight, as on the kill rule's SIGTERM");
    const [folder] = readdirSync(scratch).filter((f) => f.startsWith("mmo-agy-typist-"));
    const receipt = JSON.parse(readFileSync(join(scratch, folder, "receipt.json"), "utf8"));
    assert.equal(receipt.usage.prompt_token_count, BILLED.prompt_token_count, "its receipt says what its call cost");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    for (const e of events()) if (alive(e.pid)) { try { process.kill(-e.pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

// The agent door's backstop.
test("an agent worker killed after its heartbeat stopped is billed its last heartbeat's usage, and no heartbeat line reaches the error text", async () => {
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat() }, { atMs: 500, hb: beat({ state: "tool", usage: { global: BILLED } }) }], holdMs: "forever", ignoreTerm: true }] });
  const dir = mkdtempSync(join(tmpdir(), "backstop-agent-"));
  mkdirSync(join(dir, "work"));
  try {
    const packet = { id: "tp_x_001", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    const out = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
      Promise.race([new AntigravityWorkerAdapter({ ...FLASH, worker_timeout_sec: 600 }, { backstop: SHORT }).execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") }), sleep(15_000).then(() => null)]));
    assert.ok(out, "the frozen agent worker was not stopped within 15 s");
    assert.equal(out.success, false);
    assert.deepEqual({ input: out.tokens.input, output: out.tokens.output }, { input: 1200, output: 340 });
    assert.ok(out.cost_usd > 0);
    assert.doesNotMatch(String(out.error), /@mmo-heartbeat/, "heartbeat lines are kept out of the stderr tail");
    assert.match(String(out.error), /heartbeat/i);
  } finally {
    for (const s of fake.runs()) if (alive(s.pid)) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } }
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A thinking worker writes its receipt as each of its sessions ends and runs on in later sessions, so a worker frozen
// in a later session leaves an older receipt behind. Found with the thinking step's carry-on, whose budget is the
// killed worker's own work: billed from that older receipt, the session it froze in was neither paid nor timed.
test("a killed worker is billed its newest reading: its last heartbeat when its receipt is older, its receipt when written after", async () => {
  const SESSION_1 = { prompt_token_count: 1000, cached_content_token_count: 0, candidates_token_count: 100, thoughts_token_count: 0, total_token_count: 1100 };
  const BOTH = { prompt_token_count: 5000, cached_content_token_count: 0, candidates_token_count: 400, thoughts_token_count: 0, total_token_count: 5400 };
  const receipt = (usage, work_s) => ({ sdk_version: "0.1.22", vertex_location: "global", work_s, usage, tries: [{ location: "global", ended_by: "answer", http_codes: [], s: work_s, usage }] });
  const killedOnce = async (plan) => {
    const fake = fakeWorkerPython({ runs: [plan] });
    const dir = mkdtempSync(join(tmpdir(), "backstop-newest-"));
    mkdirSync(join(dir, "work"));
    try {
      const packet = { id: "tp_x_002", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
      return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
        Promise.race([new AntigravityWorkerAdapter({ ...FLASH, worker_timeout_sec: 600 }, { backstop: SHORT }).execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") }), sleep(15_000).then(() => null)]));
    } finally {
      for (const s of fake.runs()) if (alive(s.pid)) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } }
      fake.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Its first session ended (receipt: 1 s of work, that session's tokens); the next one billed more (the heartbeat:
  // 30 s, both sessions' tokens), and then the worker froze.
  const stale = await killedOnce({ writes: [{ atMs: 20, sidecar: receipt(SESSION_1, 1) }], beats: [{ atMs: 60, hb: beat({ work_s: 30, usage: { global: BOTH } }) }], holdMs: "forever", ignoreTerm: true });
  assert.ok(stale, "the frozen worker was not stopped within 15 s");
  assert.equal(stale.worker_stopped, "killed");
  assert.deepEqual({ input: stale.tokens.input, output: stale.tokens.output }, { input: 5000, output: 400 }, "the last heartbeat's tokens, not the older receipt's");
  assert.equal(stale.attempts[0].gemini.work_ms, 30_000, "the last heartbeat's work");
  assert.ok(Math.abs(stale.cost_usd - flashCost({ input: 5000, input_cached: 0, output: 400 })) < 1e-9, `billed ${stale.cost_usd}`);
  assert.match(String(stale.error), /its tokens are its last heartbeat's/);
  // A worker that answers SIGTERM with its receipt, after its last heartbeat, is billed that receipt, and says so.
  const final = await killedOnce({ beats: [{ atMs: 50, hb: beat({ work_s: 1, usage: { global: SESSION_1 } }) }], holdMs: "forever", onTerm: { sidecar: receipt(BOTH, 31), exitCode: 1 } });
  assert.ok(final, "the worker was not stopped within 15 s");
  assert.deepEqual({ input: final.tokens.input, output: final.tokens.output }, { input: 5000, output: 400 }, "the receipt's tokens");
  assert.equal(final.attempts[0].gemini.work_ms, 31_000);
  assert.doesNotMatch(String(final.error), /its tokens are its last heartbeat's/, "billed from its receipt, not its heartbeat");
});
