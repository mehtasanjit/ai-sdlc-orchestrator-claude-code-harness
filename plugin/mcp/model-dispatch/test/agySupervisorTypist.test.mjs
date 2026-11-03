/**
 * The agent typist's worker (worker/typist_worker.py) runs each model call under watch. A call that gets nothing
 * from Google for its stall limit is cut with the SDK's cancel() and sent again in a fresh session with the same
 * brief, the second try with twice the room; Google's HTTP status is read from the SDK's error steps; a call whose
 * refusals use up its budget, at one location or across `--locations`, ends `unavailable`; the session's time limit
 * counts the session's own work, not the time Google held a call until it was cut; every try's location, codes and
 * usage are in the receipt, which is written on every outcome, before the SDK's teardown, and on SIGTERM; a
 * heartbeat line goes to stderr every `--heartbeat-sec`; a sleep of the computer is measured and, from 5 s, cuts the
 * call at once. Offline: the worker runs against the scripted stand-in SDK (test/fixtures/agy-standin), replaying
 * sequences recorded from google-antigravity 0.1.22's harness where one exists.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NO_PYTHON, NOT_MACOS, RAISE_429_UNREACHABLE, RECORDED, TEXT_429_RETRY, TEXT_429_UNREACHABLE, TYPIST_USAGE, finishAnswer, recorded, runWorker, step, sumUsage, tail } from "./agyStandin.mjs";

const ANSWER = { path: "src/a.ts", content: "export const a = 1;\n" };
const answered = (at = 0.2, usage = TYPIST_USAGE) => ({ turns: [[{ at: 0, step: step.user() }, ...finishAnswer(at, ANSWER, usage)]] });
const holding = (before = []) => ({ turns: [[{ at: 0, step: step.user() }, ...before, { at: 0, hold: true }]] });
const TOKENS = ["prompt_token_count", "cached_content_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count"];
const tokensOf = (u) => Object.fromEntries(TOKENS.map((k) => [k, Number(u?.[k] ?? 0)]));
/** A billed answer the harness refused (a malformed FINISH call): its usage, then the harness's error step (code 0). */
const BILLED = { prompt_token_count: 1000, cached_content_token_count: 0, candidates_token_count: 50, thoughts_token_count: 5, total_token_count: 1055, service_tier: "standard" };
const billedRefusal = (at) => [{ at, usage: BILLED }, { at, step: step.error(0, "The model produced an invalid tool call.") }];
/** A refusal at one location with the failover retry (1 retry after 1 s), in the recorded 0.1.22 texts. */
const refusingFast = () => ({ turns: [[
  { at: 0, step: step.user() },
  { at: 0.05, step: step.error(429, TEXT_429_RETRY) },
  { at: 0.1, step: step.error(429, TEXT_429_RETRY) },
  { at: 0.15, step: step.error(429, TEXT_429_UNREACHABLE) },
  { at: 0.16, raise: RAISE_429_UNREACHABLE.raise, message: RAISE_429_UNREACHABLE.message },
]] });

describe("the typist worker's call supervisor", { skip: NO_PYTHON, concurrency: 4 }, () => {
  // W-stall-cut: a request that is out and never answered.
  test("a call that receives nothing for its stall limit is cut with cancel() and sent again in a fresh session with the same brief and twice the room; a second stall makes it unavailable (stalled)", async () => {
    const r = await runWorker("typist", { script: { sessions: [holding(), holding()] }, args: ["--stall-sec", "1"], timeout: 20 });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.ok(rc, `no receipt: ${tail(r)}`);
    assert.equal(rc.finish_output, null);
    assert.match(String(rc.unavailable), /stall/i, JSON.stringify(rc));
    assert.equal(rc.stall_cuts, 2);
    assert.deepEqual(rc.tries.map((t) => t.ended_by), ["stalled", "stalled"]);
    assert.equal(r.sessions.length, 2, "one fresh session per try");
    assert.equal(r.chats.length, 2);
    assert.equal(r.chats[1].message, r.chats[0].message, "the second try sends the identical brief");
    assert.equal(r.cancels.length, 2, "each stalled try is cut with the SDK's cancel()");
    const first = r.cancels[0].mono - r.chats[0].mono, second = r.cancels[1].mono - r.chats[1].mono;
    assert.ok(first >= 0.9 && first < 3.5, `the first try was cut after ${first.toFixed(2)} s (its limit: 1 s)`);
    assert.ok(second >= 1.9 && second < 4.5, `the second try was cut after ${second.toFixed(2)} s (twice the limit: 2 s)`);
    assert.ok(r.elapsedMs < 15_000, "ended by the stall rule, not by the session's 20 s limit");
  });

  // W-stall-after-chunk: a stream that stops after its first bytes (0.1.22's e22 shape).
  test("a call that stops sending after its first chunk is cut once nothing more has come for its stall limit", async () => {
    const r = await runWorker("typist", { script: { sessions: [holding([{ at: 0.2, step: step.thinking("Thinking ") }]), answered(0.2)] }, args: ["--stall-sec", "1"], timeout: 20 });
    assert.equal(r.code, 0, tail(r));
    assert.ok(r.cancels.length >= 1, "the silent stream is cut");
    const waited = r.cancels[0].mono - r.chats[0].mono;
    assert.ok(waited >= 1.1 && waited < 4, `cut ${waited.toFixed(2)} s after the call (its chunk at 0.2 s, then 1 s of nothing)`);
    assert.deepEqual(r.receipt?.tries?.map((t) => t.ended_by), ["stalled", "answer"], JSON.stringify(r.receipt));
  });

  // W-network-budget: the harness's code 2 is a connection that was refused, reset or cut.
  test("a call whose harness retries all met network errors (code 2) is unavailable for the network, with every code, in one session", async () => {
    const net = RECORDED.network_refused.events;
    const ev = [...net.map((e) => ({ ...e, at: Math.round(e.at * 20) / 1000 })), { at: 1.1, step: step.error(2, "Agent execution terminated due to error. (\"agent executor error: model unreachable: There was a network issue connecting to the server\")") }, { at: 1.11, raise: "AntigravityExecutionError", message: "model unreachable: There was a network issue connecting to the server, please try again." }];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [ev] }] } });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.match(String(rc?.unavailable), /network|refus/i, JSON.stringify(rc));
    assert.equal(r.sessions.length, 1);
    assert.equal(rc.tries[0].ended_by, "network");
    assert.deepEqual(rc.tries[0].http_codes, [2, 2, 2, 2, 2]);
    assert.equal(rc.error_status, undefined, "code 2 is the harness's, not an HTTP status");
  });

  // W-stream-never-cut: a call that is still sending is still working.
  test("a call that keeps streaming is never cut, however much longer than its stall limit it runs", async () => {
    const ev = [{ at: 0, step: step.user() }];
    for (let t = 1; t <= 6; t++) ev.push({ at: t, step: step.thinking(`thought ${t}`) });
    const r = await runWorker("typist", { script: { sessions: [{ turns: [[...ev, ...finishAnswer(6.5, ANSWER)]] }] }, args: ["--stall-sec", "2"], timeout: 30 });
    assert.equal(r.code, 0, tail(r));
    assert.deepEqual(JSON.parse(r.receipt?.finish_output ?? "null"), ANSWER, tail(r));
    assert.equal(r.cancels.length, 0, "an update every second is progress against a 2 s limit");
    assert.equal(r.sessions.length, 1);
    assert.deepEqual(r.receipt.tries.map((t) => t.ended_by), ["answer"]);
    assert.equal(r.receipt.stall_cuts, 0);
  });

  // W-work-excludes-wait: the limit is the session's own work.
  test("the session's time limit does not count a call Google held until it was cut: a held try and an answer fit a limit shorter than both", async () => {
    const r = await runWorker("typist", { script: { sessions: [holding(), answered(1.0)] }, args: ["--stall-sec", "2"], timeout: 3 });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(JSON.parse(rc?.finish_output ?? "null"), ANSWER, `the 3 s limit ended the call: ${JSON.stringify(rc)} ${tail(r)}`);
    assert.ok(!rc.error, rc.error);
    assert.deepEqual(rc.tries.map((t) => t.ended_by), ["stalled", "answer"]);
    assert.ok(rc.work_s < 3, `work_s ${rc.work_s} counts the held call`);
    assert.ok(rc.google_wait_s >= 1.9, `google_wait_s ${rc.google_wait_s} is the held call's time`);
  });

  // W-status-from-steps: Google's status is on the SDK's error step.
  test("Google's HTTP status is read from the SDK's error step: a refused login, a missing model or a bad request reaches the receipt as 403, 401, 404 or 400, in one session", async () => {
    for (const [name, status] of [["refused_403", 403], ["refused_401", 401], ["not_found_404", 404], ["bad_request_400", 400]]) {
      const r = await runWorker("typist", { script: { sessions: [{ turns: [recorded(name)] }] } });
      assert.equal(r.code, 0, `${name}: ${tail(r)}`);
      assert.equal(r.receipt?.error_status, status, `${name}: ${JSON.stringify(r.receipt)}`);
      assert.equal(r.receipt.unavailable, undefined, `${name}: a refused login or a wrong model is not Google being unable to serve`);
      assert.equal(r.sessions.length, 1, `${name}: the call ends at once, no second session`);
      assert.deepEqual(r.receipt.tries?.[0]?.http_codes, [status], name);
    }
  });

  // W-refused-budget: the harness's own retries were the budget.
  test("without failover, a call whose harness retries all met 429 carries Google's 429 and is unavailable (refused), with every code, in one session", async () => {
    const r = await runWorker("typist", { script: { sessions: [{ turns: [recorded("refused_429_six_retries", { factor: 0.02 })] }] } });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.equal(rc?.error_status, 429, JSON.stringify(rc));
    assert.match(String(rc.unavailable), /refus/i);
    assert.equal(rc.finish_output, null);
    assert.equal(r.sessions.length, 1, "no second session: the harness already spent the call's budget");
    assert.equal(rc.tries.length, 1);
    assert.equal(rc.tries[0].ended_by, "refused");
    assert.deepEqual(rc.tries[0].http_codes, [429, 429, 429, 429, 429, 429, 429], "the six retried refusals and the last one");
  });

  // W-failover-order: busy belongs to a location.
  test("with --locations, a call refused at one location carries on at the next within seconds, in a fresh session, and the try that answered names the location", async () => {
    const r = await runWorker("typist", {
      script: { by_location: { global: [refusingFast()], us: [answered(0.2)] } },
      args: ["--locations", "global,us,eu", "--api-retries", "1", "--api-retry-initial-ms", "1000"],
    });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(JSON.parse(rc?.finish_output ?? "null"), ANSWER, JSON.stringify(rc));
    assert.deepEqual(r.sessions.map((s) => s.location), ["global", "us"]);
    for (const s of r.sessions) assert.deepEqual([s.retry?.max_retries, s.retry?.initial_sleep_duration_ms], [1, 1000], "the failover retry: 1 retry after 1 s");
    assert.equal(r.chats[1].message, r.chats[0].message, "the identical brief at the next location");
    assert.ok(r.sessions[1].mono - r.chats[0].mono < 5, "the next location within seconds");
    assert.deepEqual(rc.tries.map((t) => [t.location, t.ended_by]), [["global", "refused"], ["us", "answer"]]);
    assert.equal(rc.vertex_location, "us");
    assert.equal(rc.failovers, 1);
    assert.deepEqual(tokensOf(rc.tries[1].usage), tokensOf(TYPIST_USAGE), "the answering try's own usage");
  });

  // W-failover-order, budget end: every location refuses for the whole budget.
  test("with --locations, a call refused everywhere goes round the locations in order, waits between rounds, and is unavailable (refused) once its busy budget is spent", async () => {
    const r = await runWorker("typist", {
      script: { by_location: { global: [refusingFast()], us: [refusingFast()], eu: [refusingFast()] } },
      args: ["--locations", "global,us,eu", "--api-retries", "1", "--api-retry-initial-ms", "1000", "--busy-budget-sec", "3"],
    });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.match(String(rc?.unavailable), /refus/i, JSON.stringify(rc));
    assert.deepEqual(r.sessions.slice(0, 4).map((s) => s.location), ["global", "us", "eu", "global"], "in order, then round again");
    assert.ok(rc.tries.every((t) => t.ended_by === "refused"));
    assert.ok(rc.failovers >= 3, `failovers ${rc.failovers}`);
    assert.equal(rc.error_status, 429);
    assert.ok(r.elapsedMs < 15_000, `the 3 s busy budget ended it (${r.elapsedMs} ms)`);
  });

  // W-500-retry: the harness does not retry a 500.
  test("a 500, which the harness does not retry, is sent again in a fresh session after the transport wait, and the call answers", async () => {
    const r = await runWorker("typist", { script: { sessions: [{ turns: [recorded("internal_500")] }, answered(0.1)] } });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(JSON.parse(rc?.finish_output ?? "null"), ANSWER, JSON.stringify(rc));
    assert.ok(!rc.error, rc.error);
    assert.deepEqual(r.sessions.map((s) => s.location), ["global", "global"], "the same location without failover");
    const raised = r.log.find((e) => e.ev === "raise");
    const gap = r.sessions[1].mono - raised.mono;
    assert.ok(gap < 8, `the resend came ${gap.toFixed(2)} s after the 500 (within the transport wait's first steps)`);
    assert.equal(rc.tries.length, 2);
    assert.deepEqual(rc.tries[0].http_codes, [500]);
    assert.equal(rc.tries[1].ended_by, "answer");
  });

  // W-empty-loop: the harness's empty-answer retries have no cap of their own.
  test("three empty-output error steps in a row cut the turn: the call ends 'empty output 3 times' with the usage of the billed empty answers", async () => {
    const ev = [{ at: 0, step: step.user() }];
    const empty = RECORDED.empty_output_loop;
    for (let i = 1; i <= 40; i++) ev.push({ at: 0.05 * i, usage: empty.usage_per_call }, { at: 0.05 * i, step: empty.events[1].step });
    ev.push({ at: 2.1, hold: true });
    const r = await runWorker("typist", { script: { sessions: [{ turns: [ev] }] }, timeout: 10 });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.match(String(rc?.error), /empty output 3 times/i, JSON.stringify(rc));
    assert.ok(r.cancels.length >= 1, "the turn is cut with cancel()");
    assert.ok(Number(rc.usage?.prompt_token_count) >= 30_000, "every billed empty answer's usage is kept");
    assert.equal(rc.unavailable, undefined, "an empty answer is the model's, an attempt, never Google being unable to serve");
    assert.ok(r.elapsedMs < 8_000, `cut at the third, not at the 10 s limit (${r.elapsedMs} ms)`);
  });

  // W-empty-loop, the typist door: the harness's own call budget (--max-model-calls 3) ends its empty-answer loop, with
  // an error step for the first two empty answers only and no SDK error (the recorded 0.1.22 sequence).
  test("three empty answers that end the turn on the harness's own call budget, with no SDK error, end the call 'empty output 3 times' with their billed usage", async () => {
    const empty = RECORDED.empty_output_budget_end;
    const [user, ...rest] = recorded("empty_output_budget_end");
    // Each billed answer's usage arrives with it; the third has no step of its own.
    const ev = [user, ...rest.slice(0, 2).flatMap((e) => [{ at: e.at, usage: empty.usage_per_call }, e]), { at: rest[2].at, usage: empty.usage_per_call }, rest[2]];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [ev] }] }, timeout: 10 });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.match(String(rc?.error), /empty output 3 times/i, `the reason is lost: ${JSON.stringify(rc)}`);
    assert.equal(rc.error_type, "EmptyOutput");
    assert.equal(rc.finish_output, null);
    assert.deepEqual(rc.tries.map((t) => t.ended_by), ["error"]);
    assert.equal(Number(rc.usage?.prompt_token_count), empty.calls * empty.usage_per_call.prompt_token_count, "the three billed answers");
    assert.equal(rc.unavailable, undefined, "an empty answer is the model's, never Google being unable to serve");
  });

  // W-empty-loop, the bound: the steps are read often enough that an instant loop is cut within a request or two.
  test("empty answers that come back at once, every 20 ms with no budget to end them, are cut within two requests of the third", async () => {
    const empty = RECORDED.empty_output_loop;
    const ev = [{ at: 0, step: step.user() }];
    for (let i = 1; i <= 200; i++) ev.push({ at: 0.02 * i, usage: empty.usage_per_call }, { at: 0.02 * i, step: empty.events[1].step });
    ev.push({ at: 4.1, hold: true });
    const r = await runWorker("typist", { script: { sessions: [{ turns: [ev] }] }, timeout: 10 });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.match(String(rc?.error), /empty output 3 times/i, JSON.stringify(rc));
    const billed = Number(rc.usage?.prompt_token_count) / empty.usage_per_call.prompt_token_count;
    assert.ok(billed >= 3 && billed <= 5, `${billed} empty answers were billed before the cut`);
    assert.ok(r.cancels.length >= 1, "the turn is cut with cancel()");
  });

  // W-usage-every-outcome: usage on every outcome, summed over tries.
  test("the receipt's usage is the sum of its tries' own usage on every outcome: an answer after a stall, two stalls, a refusal, the work limit, an error", async () => {
    const cases = [
      { name: "answer after a stalled try", sessions: [holding(billedRefusal(0.05)), answered(0.2)], args: ["--stall-sec", "1"], usages: [BILLED, TYPIST_USAGE], end: "answer" },
      { name: "both tries stalled", sessions: [holding(billedRefusal(0.05)), holding(billedRefusal(0.05))], args: ["--stall-sec", "1"], usages: [BILLED, BILLED], end: "stalled" },
      { name: "refused", sessions: [{ turns: [recorded("refused_429_six_retries", { factor: 0.02 })] }], args: [], usages: [null], end: "refused" },
      { name: "work limit", sessions: [{ turns: [[{ at: 0, step: step.user() }, ...billedRefusal(0.05), ...[1, 2, 3, 4, 5, 6].map((i) => ({ at: 0.4 * i, step: step.thinking(`t${i}`) })), { at: 2.5, hold: true }]] }], args: ["--stall-sec", "2"], timeout: 2, usages: [BILLED], end: "work_limit" },
      { name: "an error after a billed call", sessions: [{ turns: [[{ at: 0, usage: BILLED }, ...recorded("not_found_404")]] }], args: [], usages: [BILLED], end: "error" },
    ];
    for (const c of cases) {
      const r = await runWorker("typist", { script: { sessions: c.sessions }, args: c.args, timeout: c.timeout ?? 20 });
      assert.equal(r.code, 0, `${c.name}: ${tail(r)}`);
      const rc = r.receipt;
      assert.ok(Array.isArray(rc?.tries), `${c.name}: no tries in ${JSON.stringify(rc)}`);
      assert.equal(rc.tries.length, c.usages.length, c.name);
      assert.equal(rc.tries[rc.tries.length - 1].ended_by, c.end, c.name);
      assert.deepEqual(tokensOf(rc.usage), tokensOf(sumUsage(...c.usages)), `${c.name}: usage is the sum over tries`);
      c.usages.forEach((u, i) => assert.deepEqual(tokensOf(rc.tries[i].usage), tokensOf(u), `${c.name}: try ${i + 1}'s own usage`));
      for (const t of rc.tries) {
        assert.ok(typeof t.start_s === "number" && typeof t.end_s === "number" && t.end_s >= t.start_s, `${c.name}: each try's start and end on the worker's clock`);
        assert.ok(Array.isArray(t.http_codes) && typeof t.location === "string" && typeof t.s === "number", `${c.name}: ${JSON.stringify(t)}`);
      }
    }
  });

  // W-teardown-error: from 0.1.21 the SDK raises when leaving the session if its harness exited non-zero.
  test("an answer whose session teardown raises keeps the answer and its usage, records teardown_error, and exits 0", async () => {
    const r = await runWorker("typist", { script: { sessions: [{ aexit: { raise: "AntigravityExecutionError", message: "Harness process exited with code 1.\nHarness stderr:\n(no stderr output)" }, ...answered(0.1) }] } });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(JSON.parse(rc?.finish_output ?? "null"), ANSWER, `the answer was lost: ${JSON.stringify(rc)}`);
    assert.deepEqual(tokensOf(rc.usage), tokensOf(TYPIST_USAGE));
    assert.match(String(rc.teardown_error), /exited with code 1/);
    assert.ok(!rc.error, rc.error);
  });

  // W-cancel-caught: the SDK's cancellation error is a BaseException.
  test("the AntigravityCancelledError a cut raises is handled: the worker sends the call again, exits 0 and writes its receipt", async () => {
    const r = await runWorker("typist", { script: { sessions: [holding(), answered(0.2)] }, args: ["--stall-sec", "1"], timeout: 20 });
    assert.equal(r.code, 0, tail(r));
    assert.doesNotMatch(r.stderr, /Traceback[\s\S]*CancelledError/, "the cancellation did not escape");
    assert.equal(r.receipt?.tries?.[0]?.ended_by, "stalled", JSON.stringify(r.receipt));
    assert.deepEqual(JSON.parse(r.receipt.finish_output ?? "null"), ANSWER);
  });

  // W-no-cancel-before-send: a cancel during start-up orphans the harness.
  test("a slow session start-up is not a stall: nothing is cancelled before the call is sent", async () => {
    const r = await runWorker("typist", { script: { sessions: [{ aenter_delay: 3, ...answered(0.2) }] }, args: ["--stall-sec", "1"] });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.cancels.length, 0);
    assert.equal(r.sessions.length, 1);
    assert.deepEqual(r.receipt?.tries?.map((t) => t.ended_by), ["answer"], JSON.stringify(r.receipt));
  });

  // W-heartbeat: the engine's kill rule reads it; a blocked event loop stops it.
  test("the worker prints a heartbeat every --heartbeat-sec with its state, times and per-location usage, and none while its event loop is blocked", async () => {
    const ev = [{ at: 0, step: step.user() }, ...billedRefusal(0.3), ...[0.5, 1.5, 2.5, 3.5].map((t) => ({ at: t, step: step.thinking("thinking") })), ...finishAnswer(4.5, ANSWER)];
    const r = await runWorker("typist", { script: { sessions: [{ aexit: { block: 2.5 }, turns: [ev] }] }, args: ["--heartbeat-sec", "1"] });
    assert.equal(r.code, 0, tail(r));
    const exitStart = r.log.find((e) => e.ev === "aexit_start"), exitEnd = r.log.find((e) => e.ev === "aexit_end");
    const before = r.beats.filter((b) => b.wall < exitStart.wall);
    assert.ok(before.length >= 3, `${before.length} heartbeats in a 4.5 s call at 1 s`);
    for (const { hb } of before) {
      assert.equal(hb?.v, 1, JSON.stringify(hb));
      assert.equal(typeof hb.state, "string");
      for (const k of ["work_s", "wait_s", "call_wait_s"]) assert.equal(typeof hb[k], "number", `${k} in ${JSON.stringify(hb)}`);
      assert.equal(hb.try, 1);
      assert.equal(hb.location, "global");
      assert.equal(typeof hb.usage, "object");
    }
    const gaps = before.slice(1).map((b, i) => b.atMs - before[i].atMs);
    assert.ok(gaps.every((g) => g > 500 && g < 2_000), `heartbeat gaps ${gaps}`);
    assert.ok(r.beats.some((b) => Number(b.hb?.usage?.global?.prompt_token_count) === BILLED.prompt_token_count), "a heartbeat after a billed call carries its usage by location");
    assert.ok(!r.beats.some((b) => b.wall > exitStart.wall + 0.3 && b.wall < exitEnd.wall - 0.1), "no heartbeat while the loop is blocked");
  });

  // W-slept: a sleep of the computer, measured by the clocks that do and do not count it.
  test("a sleep of the computer during a call is recorded as slept_s, and one under 5 s does not cut the call", { skip: NOT_MACOS }, async () => {
    const ev = [{ at: 0, step: step.user() }, { at: 0.3, os_sleep: 3 }, ...finishAnswer(1.0, ANSWER)];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [ev] }] } });
    assert.equal(r.code, 0, tail(r));
    const slept = r.receipt?.slept_s;
    assert.ok(typeof slept === "number" && slept >= 2.5 && slept <= 3.5, `slept_s ${slept}`);
    assert.equal(r.cancels.length, 0);
    assert.deepEqual(r.receipt.tries.map((t) => t.ended_by), ["answer"]);
  });

  // W-sleep-resend: after a sleep of 5 s or more the request's connection is stale; resend at once.
  test("a sleep of 5 s or more during a call cuts it at once and sends it again, recorded as a stall cut because the computer slept", { skip: NOT_MACOS }, async () => {
    const r = await runWorker("typist", {
      script: { sessions: [holding([{ at: 0.5, os_sleep: 600 }]), answered(0.2)] },
      args: ["--stall-sec", "60"],
    });
    assert.equal(r.code, 0, tail(r));
    const slept = r.log.find((e) => e.ev === "os_sleep");
    assert.equal(r.cancels.length, 1, "the held call is cut");
    assert.ok(r.cancels[0].mono - slept.mono < 3, "at once, not after the 60 s stall limit");
    assert.equal(r.sessions.length, 2);
    const rc = r.receipt;
    assert.equal(rc?.stall_cuts, 1, JSON.stringify(rc));
    assert.equal(rc.tries[0].ended_by, "stalled");
    assert.match(JSON.stringify(rc), /the computer slept/);
    assert.ok(rc.slept_s >= 599, `slept_s ${rc.slept_s}`);
    assert.deepEqual(JSON.parse(rc.finish_output ?? "null"), ANSWER);
  });

  // W-sigterm-receipt: the engine's kill rule sends SIGTERM first.
  test("a worker given SIGTERM cancels its turn and writes its receipt with the usage so far", async () => {
    const r = await runWorker("typist", { script: { sessions: [holding([{ at: 0.1, usage: BILLED }])] }, killAfterMs: 1500 });
    const rc = r.receipt;
    assert.ok(rc, `no receipt after SIGTERM: ${tail(r)}`);
    assert.deepEqual(tokensOf(rc.usage), tokensOf(BILLED));
    assert.ok(r.cancels.length >= 1, "the turn is cancelled");
    assert.ok(r.elapsedMs < 6_000, `exited ${r.elapsedMs} ms after start`);
  });

  // W-noproxy: the SDK's websocket to its own harness must not go through a proxy.
  test("with a proxy set and no NO_PROXY, the worker adds localhost and 127.0.0.1 to NO_PROXY before it opens a session, keeping what was there", async () => {
    for (const given of [undefined, "corp.example"]) {
      const env = { HTTPS_PROXY: "http://127.0.0.1:9", ...(given ? { NO_PROXY: given } : {}) };
      const r = await runWorker("typist", { script: { sessions: [answered(0.1)] }, env });
      assert.equal(r.code, 0, tail(r));
      const hosts = String(r.sessions[0]?.no_proxy ?? "").split(",").map((h) => h.trim());
      assert.ok(hosts.includes("localhost") && hosts.includes("127.0.0.1"), `NO_PROXY was ${r.sessions[0]?.no_proxy}`);
      if (given) assert.ok(hosts.includes(given), "the existing entry is kept");
    }
  });
});
