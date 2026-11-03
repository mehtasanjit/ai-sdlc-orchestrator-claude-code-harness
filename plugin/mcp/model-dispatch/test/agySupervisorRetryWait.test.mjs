/**
 * The harness waits out a refused request itself (ModelAPIRetryConfig: its first wait, doubling) and emits the
 * refusal's step as it sends the next try. That wait is the harness's, not Google holding the call: a call whose
 * refusals are waited out for longer than its stall limit is still a refusal, never cut as a stall. A retry that
 * Google then holds is cut once the silence passes the stall limit plus the harness's wait. Offline: the real typist
 * worker against the scripted stand-in SDK, the harness's retry 6 times from 0.5 s, a 1 s stall limit.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NO_PYTHON, TEXT_429_RETRY, TEXT_429_UNREACHABLE, RAISE_429_UNREACHABLE, finishAnswer, runWorker, step, tail } from "./agyStandin.mjs";

const ARGS = ["--api-retries", "6", "--api-retry-initial-ms", "500", "--stall-sec", "1"];
const refusal = (at) => ({ at, step: step.error(429, TEXT_429_RETRY) });

describe("the harness's own retry waits", { skip: NO_PYTHON }, () => {
  test("refusals waited out for longer than the stall limit end the call refused, with no stall cut", async () => {
    // Gaps 0.6, 1.7, 2.5 and 3.8 s: each past the 1 s stall limit after the first, each within the harness's wait.
    const turn = [{ at: 0, step: step.user() }, refusal(0.6), refusal(2.3), refusal(4.8), refusal(8.6),
      { at: 8.65, step: step.error(429, TEXT_429_UNREACHABLE) }, { at: 8.66, raise: RAISE_429_UNREACHABLE.raise, message: RAISE_429_UNREACHABLE.message }];
    const r = await runWorker("typist", { script: { sessions: [{ turns: [turn] }] }, args: ARGS });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(rc?.tries?.map((t) => t.ended_by), ["refused"], JSON.stringify(rc));
    assert.equal(rc.stall_cuts, 0);
    assert.equal(rc.tries[0].http_codes.filter((c) => c === 429).length, 5);
    assert.match(String(rc.unavailable), /refus/i);
  });

  test("a retry Google holds is cut once the silence passes the stall limit plus the harness's wait, and the next try answers", async () => {
    const held = { turns: [[{ at: 0, step: step.user() }, refusal(0.6), { at: 0.6, hold: true }]] };
    const answered = { turns: [[{ at: 0, step: step.user() }, ...finishAnswer(0.2)]] };
    const r = await runWorker("typist", { script: { sessions: [held, answered] }, args: ARGS });
    assert.equal(r.code, 0, tail(r));
    const rc = r.receipt;
    assert.deepEqual(rc?.tries?.map((t) => t.ended_by), ["stalled", "answer"], JSON.stringify(rc));
    const s = rc.tries[0].s;
    assert.ok(s >= 2.3 && s < 4.5, `cut ${s} s in: after 1 s of stall limit and 1 s of the harness's wait, past the 0.6 s refusal`);
  });
});
