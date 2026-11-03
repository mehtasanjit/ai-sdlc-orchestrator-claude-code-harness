/**
 * A worker sends a heartbeat as it starts and reports a billed call's usage in one as soon as the call is billed (at
 * most a second after its previous heartbeat), not only at its next regular heartbeat: a worker that is stopped or
 * frozen right after a billed call has already told the engine what it cost. A fast stream of billed calls is reported
 * without flooding stderr. Offline: the real typist worker against the scripted stand-in SDK, with a 30 s heartbeat
 * interval.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NO_PYTHON, runWorker, step } from "./agyStandin.mjs";

const BILLED = { prompt_token_count: 1200, cached_content_token_count: 0, candidates_token_count: 340, thoughts_token_count: 0, total_token_count: 1540 };

describe("the heartbeat after a billed call", { skip: NO_PYTHON }, () => {
  test("a billed call's usage reaches a heartbeat within about a second, long before the next regular one", async () => {
    const turn = [{ at: 0, step: step.user() }, { at: 0.3, usage: BILLED }, { at: 0.3, step: step.error(0, "The model produced an invalid tool call.") }, { at: 0.4, hold: true }];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [turn] }] }, args: ["--heartbeat-sec", "30", "--stall-sec", "60"], killAfterMs: 3000 });
    const billed = r.beats.filter((b) => Number(b.hb?.usage?.global?.prompt_token_count) === BILLED.prompt_token_count);
    assert.ok(billed.length >= 1, `no heartbeat carried the billed call's usage: ${JSON.stringify(r.beats.map((b) => [b.atMs, b.hb?.usage]))}`);
    assert.ok(billed[0].atMs < 2900, `first such heartbeat at ${billed[0].atMs} ms`);
    assert.ok(r.beats.length <= 4, `a beat per usage change, not one per poll: ${r.beats.length} beats`);
  });

  // The call is billed just after the worker's first second (when a once-a-second check would last have looked) and the
  // worker freezes 0.65 s later, long before its next regular heartbeat.
  test("a worker that freezes less than a second after a billed call, long before its next regular heartbeat, has already sent one with that call's usage; its first heartbeat comes as it starts", async () => {
    const turn = [{ at: 0, step: step.user() }, { at: 1.05, usage: BILLED }, { at: 1.05, step: step.error(0, "The model produced an invalid tool call.") }, { at: 1.7, freeze: true }, { at: 1.8, hold: true }];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [turn] }] }, args: ["--heartbeat-sec", "30", "--stall-sec", "60"], limitMs: 4000 });
    const froze = r.log.find((e) => e.ev === "freeze");
    assert.ok(froze, "the stand-in froze the worker");
    const chat = r.log.find((e) => e.ev === "chat");
    const before = r.beats.filter((b) => b.wall < froze.wall);
    assert.ok(before.length >= 1, `no heartbeat before the freeze: ${JSON.stringify(r.beats.map((b) => [b.atMs, b.hb?.usage]))}`);
    assert.ok(before[0].wall <= chat.wall, "a heartbeat as the worker starts, before its call is sent");
    const last = before[before.length - 1];
    assert.equal(Number(last.hb?.usage?.global?.prompt_token_count), BILLED.prompt_token_count, `the last heartbeat holds the billed call's usage: ${JSON.stringify(last.hb)}`);
  });

  test("a fast stream of billed calls does not flood stderr: at most one heartbeat a second while the usage keeps changing", async () => {
    const turn = [{ at: 0, step: step.user() }];
    for (let i = 1; i <= 100; i++) turn.push({ at: 0.03 * i, usage: BILLED }, { at: 0.03 * i, step: step.thinking(`t${i}`) });
    turn.push({ at: 3.1, hold: true });
    const r = await runWorker("typist", { script: { sessions: [{ turns: [turn] }] }, args: ["--heartbeat-sec", "30", "--stall-sec", "60"], killAfterMs: 3500 });
    const during = r.beats.filter((b) => b.atMs < 3300);
    assert.ok(during.length >= 3, `the changing usage is reported: ${during.length} heartbeats`);
    assert.ok(during.length <= 5, `${during.length} heartbeats in about 3.3 s`);
    const gaps = during.slice(1).map((b, i) => b.atMs - during[i].atMs);
    assert.ok(gaps.every((g) => g >= 800), `gaps ${gaps}`);
  });
});
