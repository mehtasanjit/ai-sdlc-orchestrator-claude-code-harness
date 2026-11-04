/**
 * The agent door's worker (worker/gemini_worker.py) runs its session under the same call supervisor as the typist:
 * a call held past its stall limit is cut and recovered (a fresh session with the identical task before any tool
 * has run; after one, the same session is continued or, where the harness cannot continue it, the dispatch fails as
 * stalled with its usage kept); Google's status is read from the SDK's error steps; the session gets the executor's
 * retry rule; an answer the harness interrupted part-way and continued is not passed off as an answer; the usage
 * sidecar is written on every outcome, before teardown and on SIGTERM; stdout carries the reply only on success.
 * Offline: the scripted stand-in SDK (test/fixtures/agy-standin), with sequences recorded from google-antigravity
 * 0.1.22's harness.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NO_PYTHON, NOT_MACOS, RAISE_429_UNREACHABLE, RECORDED, TEXT_429_RETRY, TEXT_429_UNREACHABLE, TYPIST_USAGE, recorded, runWorker, step, sumUsage, tail, textAnswer } from "./agyStandin.mjs";

const TASK = "Write test/helpers/app.helper.ts.";
const REPLY = '{"result":"done"}';
/** The executor's retry rule, as buildWorkerArgs passes it on every call; tests about anything else leave the optional flags out. */
const RETRY = ["--api-retries", "6", "--api-retry-initial-ms", "2000"];
const TOKENS = ["prompt_token_count", "cached_content_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count"];
const tokensOf = (u) => Object.fromEntries(TOKENS.map((k) => [k, Number(u?.[k] ?? 0)]));
const TOOL_USAGE = RECORDED.tool_then_held.usage;
const answering = (at = 0.2, usage = TYPIST_USAGE) => ({ turns: [[{ at: 0, step: step.user(TASK) }, ...textAnswer(at, REPLY, usage)]] });
const holding = (before = []) => ({ turns: [[{ at: 0, step: step.user(TASK) }, ...before, { at: 0, hold: true }]] });
/** A tool call that ran (the recorded view_file of e28, its call's usage), then a request that is never answered. */
const toolThenHeld = () => [{ at: 0, step: step.user(TASK) }, { at: 0.05, step: step.tool("view_file", "ACTIVE") }, { at: 0.06, usage: TOOL_USAGE }, { at: 0.06, step: step.tool("view_file", "DONE") }, { at: 0.07, hold: true }];
const withUsage = (events, usage) => [...events, { at: events[events.length - 1].at, usage }, { at: events[events.length - 1].at, end: true }];

describe("the agent worker's call supervisor", { skip: NO_PYTHON, concurrency: 4 }, () => {
  // W-status-from-steps: the status is on the error step; the sidecar is written on failure.
  test("a refused login reaches the sidecar as Google's 403 or 401, the dispatch fails at once, and the sidecar is written", async () => {
    for (const [name, status] of [["refused_403", 403], ["refused_401", 401]]) {
      const r = await runWorker("agent", { script: { sessions: [{ turns: [recorded(name)] }] } });
      assert.equal(r.code, 1, `${name}: ${tail(r)}`);
      assert.ok(r.sidecar, `${name}: no sidecar on failure: ${tail(r)}`);
      assert.equal(r.sidecar.error_status, status, `${name}: ${JSON.stringify(r.sidecar)}`);
      assert.equal(r.sessions.length, 1, name);
      assert.equal(r.stdout.trim(), "", `${name}: no reply on stdout`);
    }
  });

  // W-refused-budget: the executor's retry rule, then unavailable.
  test("the session gets the executor's retry rule (6 retries from 2 s), and a call whose retries all met 429 is unavailable (refused) with Google's status", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ turns: [recorded("refused_429_six_retries", { factor: 0.02 })] }] }, args: RETRY });
    assert.equal(r.code, 1, tail(r));
    assert.deepEqual([r.sessions[0]?.retry?.max_retries, r.sessions[0]?.retry?.initial_sleep_duration_ms], [6, 2000], "the SDK's unstated default is no longer used");
    const sc = r.sidecar;
    assert.equal(sc?.error_status, 429, JSON.stringify(sc));
    assert.match(String(sc.unavailable), /refus/i);
    assert.deepEqual(sc.tries?.map((t) => t.ended_by), ["refused"]);
    assert.equal(r.sessions.length, 1);
  });

  // W-stall-cut: before any tool has run, a fresh session is safe.
  test("a call held before any tool has run is cut and sent again in a fresh session with the identical task; a second stall fails the dispatch as unavailable (stalled)", async () => {
    const r = await runWorker("agent", { script: { sessions: [holding(), holding()] }, args: ["--stall-sec", "1"], timeout: 20 });
    assert.equal(r.code, 1, tail(r));
    assert.doesNotMatch(r.stderr, /Traceback[\s\S]*CancelledError/, "the SDK's cancellation error is handled");
    assert.equal(r.sessions.length, 2);
    assert.equal(r.chats[1].message, r.chats[0].message, "the identical task");
    assert.equal(r.cancels.length, 2);
    const sc = r.sidecar;
    assert.match(String(sc?.unavailable), /stall/i, JSON.stringify(sc));
    assert.equal(sc.stall_cuts, 2);
    assert.deepEqual(sc.tries.map((t) => t.ended_by), ["stalled", "stalled"]);
    assert.ok(r.elapsedMs < 15_000);
  });

  // W-agent-recovery, before a tool: the recovered call answers.
  test("a call held before any tool has run is answered by the fresh session that replaces it: the reply is on stdout and the dispatch succeeds", async () => {
    const r = await runWorker("agent", { script: { sessions: [holding(), answering(0.2)] }, args: ["--stall-sec", "1"], timeout: 20 });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.stdout.trim(), REPLY);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.chats[1].message, r.chats[0].message);
    assert.deepEqual(r.sidecar?.tries?.map((t) => t.ended_by), ["stalled", "answer"], JSON.stringify(r.sidecar));
  });

  // W-agent-recovery, after a tool: a fresh session would start over a half-edited folder.
  // Which of the two outcomes ships depends on whether the harness continues a session after cancel() (settled on the
  // fake endpoint first): either the same session is continued with the harness's own words, or the dispatch fails
  // as stalled with its usage kept. A fresh session after a tool has run is never one of them.
  test("a call held after a tool has run is never replaced by a fresh session: the same session is continued, or the dispatch fails as stalled with its usage kept", async () => {
    const sessions = [{ turns: [toolThenHeld(), [...textAnswer(0.2, REPLY, TYPIST_USAGE)]] }];
    const r = await runWorker("agent", { script: { sessions }, args: ["--stall-sec", "1"], timeout: 20, brief: TASK });
    assert.equal(r.sessions.length, 1, "no fresh session over a folder a tool has already changed");
    assert.ok(r.sidecar, `no sidecar: ${tail(r)}`);
    assert.ok(Number(r.sidecar.usage?.prompt_token_count) >= TOOL_USAGE.prompt_token_count, "the tool call's usage is kept");
    assert.ok(r.cancels.length >= 1, "the held call is cut");
    if (r.code === 0) {
      assert.deepEqual(r.chats.map((c) => c.message), [TASK, "Please continue the task you were working on."], "continued in the same session with the harness's own words");
      assert.equal(r.stdout.trim(), REPLY);
    } else {
      assert.equal(r.code, 1, tail(r));
      assert.match(JSON.stringify(r.sidecar), /stall/i, "failed as stalled");
      assert.equal(r.stdout.trim(), "");
    }
  });

  // W-interrupted-answer: the harness continues an interrupted answer and text() joins both.
  test("an answer the harness interrupted part-way (Google's bare 504, a dropped connection) and continued fails the dispatch, with its usage, instead of returning both texts joined", async () => {
    for (const name of ["text_then_bare_504_then_restart", "text_then_tcp_close_then_restart"]) {
      const fx = RECORDED[name];
      const r = await runWorker("agent", { script: { sessions: [{ turns: [withUsage(recorded(name, { factor: 0.1 }), fx.usage)] }] } });
      assert.equal(r.code, 1, `${name}: the joined text was returned as the answer: ${JSON.stringify(r.stdout.trim())}`);
      assert.doesNotMatch(r.stdout, /Partial answer/, name);
      assert.match(String(r.sidecar?.error), /interrupted/i, `${name}: ${JSON.stringify(r.sidecar)}`);
      assert.deepEqual(tokensOf(r.sidecar.usage), tokensOf(fx.usage), `${name}: usage kept`);
    }
    // No answer text came before the error: nothing was interrupted, and the dispatch answers as before.
    const fx = RECORDED.thought_then_bare_429;
    const ok = await runWorker("agent", { script: { sessions: [{ turns: [withUsage(recorded("thought_then_bare_429", { factor: 0.1 }), fx.usage)] }] } });
    assert.equal(ok.code, 0, tail(ok));
    assert.equal(ok.stdout.trim(), "FINAL-ANSWER");
  });

  // W-usage-every-outcome: the sidecar on every outcome, summed over tries.
  test("the sidecar is written on every outcome with the usage of every try: an answer, an error after tools, a refusal, two stalls, the work limit", async () => {
    const two = RECORDED.two_tools_then_text;
    const afterTools = [...recorded("two_tools_then_text").slice(0, 9), { at: 0.05, usage: two.usage }, ...recorded("not_found_404", { offset: 0.06 }).slice(1)];
    const cases = [
      { name: "answer", sessions: [{ turns: [withUsage(recorded("two_tools_then_text"), two.usage)] }], code: 0, usages: [two.usage], end: "answer" },
      { name: "error after tools", sessions: [{ turns: [afterTools] }], code: 1, usages: [two.usage], end: "error" },
      { name: "refused", sessions: [{ turns: [recorded("refused_429_six_retries", { factor: 0.02 })] }], code: 1, usages: [null], end: "refused" },
      { name: "two stalls", sessions: [holding(), holding()], args: ["--stall-sec", "1"], code: 1, usages: [null, null], end: "stalled" },
      { name: "work limit", sessions: [{ turns: [[...toolThenHeld().slice(0, 4), ...[1, 2, 3, 4, 5, 6].map((i) => ({ at: 0.4 * i, step: step.thinking(`t${i}`) })), { at: 2.5, hold: true }]] }], args: ["--stall-sec", "2"], timeout: 2, code: 1, usages: [TOOL_USAGE], end: "work_limit" },
    ];
    for (const c of cases) {
      const r = await runWorker("agent", { script: { sessions: c.sessions }, args: c.args ?? [], timeout: c.timeout ?? 20 });
      assert.equal(r.code, c.code, `${c.name}: ${tail(r)}`);
      const sc = r.sidecar;
      assert.ok(sc, `${c.name}: no sidecar: ${tail(r)}`);
      assert.ok(Array.isArray(sc.tries), `${c.name}: ${JSON.stringify(sc)}`);
      assert.equal(sc.tries.length, c.usages.length, c.name);
      assert.equal(sc.tries[sc.tries.length - 1].ended_by, c.end, c.name);
      assert.deepEqual(tokensOf(sc.usage), tokensOf(sumUsage(...c.usages)), `${c.name}: the sum over tries`);
      for (const k of ["model", "sdk", "sdk_version", "vertex_project", "vertex_location", "usage", "tool_call_count", "tool_calls", "text"]) assert.ok(k in sc, `${c.name}: the sidecar key ${k} kept`);
    }
  });

  // W-teardown-error: from 0.1.21 leaving the session raises when the harness exited non-zero.
  test("an answer whose session teardown raises is still the dispatch's answer: the reply on stdout, exit 0, the sidecar with usage and teardown_error", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ aexit: { raise: "AntigravityExecutionError", message: "Harness process exited with code 1." }, ...answering(0.1) }] } });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.stdout.trim(), REPLY);
    assert.deepEqual(tokensOf(r.sidecar?.usage), tokensOf(TYPIST_USAGE), JSON.stringify(r.sidecar));
    assert.match(String(r.sidecar.teardown_error), /exited with code 1/);
  });

  // W-history-trim: the SDK keeps 10,000 steps and drops the oldest.
  test("new steps are seen after the SDK's history cap trims the oldest: a session that keeps streaming is not cut", async () => {
    const ev = [{ at: 0, step: step.user(TASK) }];
    for (let i = 1; i <= 20; i++) ev.push({ at: 0.4 * i, step: step.text(`part${i} `) });
    const r = await runWorker("agent", { script: { max_history: 5, sessions: [{ turns: [[...ev, ...textAnswer(8.4, REPLY, TYPIST_USAGE)]] }] }, args: ["--stall-sec", "2"], timeout: 30 });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.cancels.length, 0, "progress is found by the new step objects, not by the history's length");
    assert.deepEqual(r.sidecar?.tries?.map((t) => t.ended_by), ["answer"], JSON.stringify(r.sidecar));
  });

  // W-work-excludes-wait: the policy's worker_timeout_sec counts the session's own work.
  test("a held call cut before any tool, then an answer, fit a worker time limit shorter than both", async () => {
    const r = await runWorker("agent", { script: { sessions: [holding(), answering(1.0)] }, args: ["--stall-sec", "2"], timeout: 3 });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.stdout.trim(), REPLY);
    assert.ok(r.sidecar.work_s < 3, `work_s ${r.sidecar.work_s}`);
  });

  // W-no-cancel-before-send.
  test("a slow session start-up is not a stall: nothing is cancelled before the task is sent", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ aenter_delay: 3, ...answering(0.2) }] }, args: ["--stall-sec", "1"] });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.cancels.length, 0);
    assert.deepEqual(r.sidecar?.tries?.map((t) => t.ended_by), ["answer"], JSON.stringify(r.sidecar));
  });

  // W-500-retry: before any tool, a 500 is sent again in a fresh session.
  test("a 500 before any tool has run is sent again in a fresh session and the dispatch answers", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ turns: [recorded("internal_500")] }, answering(0.1)] } });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.stdout.trim(), REPLY);
    assert.equal(r.sessions.length, 2);
    assert.deepEqual(r.sidecar?.tries?.[0]?.http_codes, [500], JSON.stringify(r.sidecar));
  });

  // W-empty-loop.
  test("three empty-output error steps in a row cut the turn; the dispatch fails 'empty output 3 times' with the billed usage", async () => {
    const ev = [{ at: 0, step: step.user(TASK) }];
    const empty = RECORDED.empty_output_loop;
    for (let i = 1; i <= 40; i++) ev.push({ at: 0.05 * i, usage: empty.usage_per_call }, { at: 0.05 * i, step: empty.events[1].step });
    ev.push({ at: 2.1, hold: true });
    const r = await runWorker("agent", { script: { sessions: [{ turns: [ev] }] }, timeout: 10 });
    assert.equal(r.code, 1, tail(r));
    assert.match(String(r.sidecar?.error), /empty output 3 times/i, JSON.stringify(r.sidecar));
    assert.ok(Number(r.sidecar.usage?.prompt_token_count) >= 30_000);
    assert.ok(r.elapsedMs < 8_000);
  });

  // W-empty-loop, the bound: the agent door has no call budget of its own, and the harness re-sends an empty answer at once.
  test("empty answers that come back at once, every 20 ms, are cut within two requests of the third: the dispatch fails 'empty output 3 times' with their billed usage", async () => {
    const empty = RECORDED.empty_output_loop;
    const ev = [{ at: 0, step: step.user(TASK) }];
    for (let i = 1; i <= 200; i++) ev.push({ at: 0.02 * i, usage: empty.usage_per_call }, { at: 0.02 * i, step: empty.events[1].step });
    ev.push({ at: 4.1, hold: true });
    const r = await runWorker("agent", { script: { sessions: [{ turns: [ev] }] }, timeout: 10 });
    assert.equal(r.code, 1, tail(r));
    assert.match(String(r.sidecar?.error), /empty output 3 times/i, JSON.stringify(r.sidecar));
    const billed = Number(r.sidecar.usage?.prompt_token_count) / empty.usage_per_call.prompt_token_count;
    assert.ok(billed >= 3 && billed <= 5, `${billed} empty answers were billed before the cut`);
    assert.equal(r.stdout.trim(), "");
  });

  // W-subagents: a sub-agent that has answered no longer holds the stall check.
  test("a tool call that runs two sub-agents in turn, with a pause longer than the stall limit between them, is not cut: each sub-agent's final text settles it, whatever its target", async () => {
    const sub = (tid, at, text) => [
      { at, step: { ...step.text(text, "ACTIVE"), trajectory_id: tid, target: "TARGET_UNSPECIFIED" } },
      { at: at + 0.1, step: { ...step.text(text, "DONE"), trajectory_id: tid, target: "TARGET_UNSPECIFIED", content: text } },
    ];
    const main = (s) => ({ ...s, trajectory_id: "main-1" });
    const ev = [
      { at: 0, step: main(step.user(TASK)) },
      { at: 0.05, step: main(step.tool("invoke_subagent", "ACTIVE")) },
      ...sub("sub-1", 0.1, "first sub-agent's answer"),
      // 2.5 s with nothing in flight: the first sub-agent answered, the second has not started.
      ...sub("sub-2", 2.7, "second sub-agent's answer"),
      { at: 2.9, step: main(step.tool("invoke_subagent", "DONE")) },
      { at: 3.0, step: main(step.text(REPLY, "ACTIVE")) },
      { at: 3.0, usage: TYPIST_USAGE },
      { at: 3.0, step: main(step.text(REPLY, "DONE", { is_complete_response: true })) },
      { at: 3.0, end: true },
    ];
    const r = await runWorker("agent", { script: { sessions: [{ turns: [ev] }] }, args: ["--stall-sec", "1"], timeout: 20, brief: TASK });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.cancels.length, 0, `cut while no request was out: ${JSON.stringify(r.sidecar?.tries)}`);
    assert.deepEqual(r.sidecar?.tries?.map((t) => t.ended_by), ["answer"], JSON.stringify(r.sidecar));
  });

  // W-500-after-a-tool: the harness never retries a 500, and its connection closes with the turn's error, so the session
  // cannot take another turn; a fresh session would start over a folder a tool changed.
  test("a 500 after a tool has run, without failover, is carried on by resuming the session's own conversation at the same location with the harness's own words, and the dispatch answers", async () => {
    const R500 = RECORDED.internal_500.events;
    const toolThen500 = [{ at: 0, step: step.user(TASK) }, { at: 0.05, step: step.tool("view_file", "ACTIVE") }, { at: 0.06, usage: TOOL_USAGE }, { at: 0.06, step: step.tool("view_file", "DONE") },
      ...R500.filter((e) => e.step?.source === "SYSTEM" || e.raise).map((e) => ({ ...e, at: 0.1 }))];
    const sessions = [{ turns: [toolThen500] }, { turns: [[...textAnswer(0.2, REPLY, TYPIST_USAGE)]] }];
    const r = await runWorker("agent", { script: { sessions }, args: RETRY, timeout: 20, brief: TASK });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.log.filter((e) => e.ev === "chat_refused").length, 0, "no turn sent on the closed session");
    const resumed = (s) => (s.continuation === null ? null : /resume/i.test(s.continuation));
    assert.deepEqual(r.sessions.map((s) => [s.location, resumed(s), s.conversation_id]), [["global", null, null], ["global", true, "standin-1"]], "the same conversation resumed, never a fresh one");
    assert.deepEqual(r.chats.map((c) => c.message), [TASK, "Please continue the task you were working on."]);
    assert.equal(r.stdout.trim(), REPLY);
    assert.deepEqual(r.sidecar?.tries?.map((t) => [t.ended_by, t.http_codes]), [["refused", [500]], ["answer", []]], JSON.stringify(r.sidecar));
    assert.deepEqual(tokensOf(r.sidecar.usage), tokensOf(sumUsage(TOOL_USAGE, TYPIST_USAGE)), "the tool call's usage and the answer's");
  });

  // W-failover-order: before any tool, the next location gets a fresh session.
  test("with --locations, a call refused before any tool has run carries on at the next location in a fresh session", async () => {
    const refusing = { turns: [[{ at: 0, step: step.user(TASK) }, { at: 0.05, step: step.error(429, TEXT_429_RETRY) }, { at: 0.1, step: step.error(429, TEXT_429_UNREACHABLE) }, { at: 0.11, raise: RAISE_429_UNREACHABLE.raise, message: RAISE_429_UNREACHABLE.message }]] };
    const r = await runWorker("agent", { script: { by_location: { global: [refusing], us: [answering(0.2)] } }, args: ["--api-retries", "1", "--api-retry-initial-ms", "1000", "--locations", "global,us"] });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.stdout.trim(), REPLY);
    assert.deepEqual(r.sessions.map((s) => s.location), ["global", "us"]);
    assert.equal(r.chats[1].message, r.chats[0].message);
    assert.equal(r.sidecar?.vertex_location, "us", JSON.stringify(r.sidecar));
    assert.equal(r.sidecar.failovers, 1);
  });

  // W-heartbeat.
  test("the agent worker prints a heartbeat every --heartbeat-sec while its session runs", async () => {
    // Thinking, not answer text, keeps the session busy: the SDK's text() joins every answer-text chunk of the turn.
    const ev = [{ at: 0, step: step.user(TASK) }, ...[0.5, 1.5, 2.5].map((t) => ({ at: t, step: step.thinking("x") })), ...textAnswer(3.2, REPLY, TYPIST_USAGE)];
    const r = await runWorker("agent", { script: { sessions: [{ turns: [ev] }] }, args: ["--heartbeat-sec", "1"] });
    assert.equal(r.code, 0, tail(r));
    assert.ok(r.beats.length >= 3, `${r.beats.length} heartbeats`);
    assert.ok(r.beats.every((b) => b.hb?.v === 1 && typeof b.hb.work_s === "number"), JSON.stringify(r.beats[0]));
    assert.equal(r.stdout.trim(), REPLY, "heartbeats go to stderr, never into the reply");
  });

  // W-noproxy.
  test("with a proxy set and no NO_PROXY, the agent worker adds localhost and 127.0.0.1 to NO_PROXY before it opens a session", async () => {
    const r = await runWorker("agent", { script: { sessions: [answering(0.1)] }, env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
    assert.equal(r.code, 0, tail(r));
    const hosts = String(r.sessions[0]?.no_proxy ?? "").split(",").map((h) => h.trim());
    assert.ok(hosts.includes("localhost") && hosts.includes("127.0.0.1"), `NO_PROXY was ${r.sessions[0]?.no_proxy}`);
  });

  // W-sigterm-receipt.
  test("an agent worker given SIGTERM cancels its session and writes its sidecar with the usage so far", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ turns: [toolThenHeld()] }] }, killAfterMs: 1500 });
    assert.ok(r.sidecar, `no sidecar after SIGTERM: ${tail(r)}`);
    assert.deepEqual(tokensOf(r.sidecar.usage), tokensOf(TOOL_USAGE));
    assert.ok(r.elapsedMs < 6_000);
  });

  // W-engine-gone. Review: a worker outlived its engine, calling Gemini up to its budget with nobody to record it. The
  // engine holds the worker's stdin open (--watch-stdin), so the pipe's end is the engine's, however the engine ended.
  test("an agent worker whose engine's end of its stdin closes stops as on SIGTERM: it cancels its session and writes its sidecar", async () => {
    const r = await runWorker("agent", { script: { sessions: [{ turns: [toolThenHeld()] }] }, args: ["--watch-stdin", "--term-grace-sec", "10"], closeStdinAfterMs: 1500 });
    assert.ok(r.sidecar, `no sidecar after the engine's end closed: ${tail(r)}`);
    assert.deepEqual(tokensOf(r.sidecar.usage), tokensOf(TOOL_USAGE));
    assert.equal(r.cancels.length, 1, `the call in flight was cancelled: ${tail(r)}`);
    assert.ok(r.elapsedMs < 6_000, `stopped at once, not at the call's stall limit: ${r.elapsedMs} ms`);
  });

  // W-sleep-resend, agent door.
  test("a sleep of 5 s or more during an agent call cuts it at once and sends it again", { skip: NOT_MACOS }, async () => {
    const r = await runWorker("agent", { script: { sessions: [holding([{ at: 0.5, os_sleep: 600 }]), answering(0.2)] }, args: ["--stall-sec", "60"] });
    assert.equal(r.code, 0, tail(r));
    const slept = r.log.find((e) => e.ev === "os_sleep");
    assert.ok(r.cancels[0] && r.cancels[0].mono - slept.mono < 3, "at once");
    assert.equal(r.stdout.trim(), REPLY);
    assert.match(JSON.stringify(r.sidecar), /the computer slept/);
  });
});
