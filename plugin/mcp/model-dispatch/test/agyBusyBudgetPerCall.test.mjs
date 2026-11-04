/**
 * The busy budget is one call's (agy_supervisor.py BUSY_BUDGET_SEC: "how long a call may keep meeting refusals across
 * its tries"), counted from when that call was sent. A thinking step or an agent packet answers many calls in one
 * session; a call refused late in it gets the whole budget, not what is left of the session's. Offline, $0: the
 * scripted stand-in SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_PYTHON, RAISE_429_UNREACHABLE, TEXT_429_RETRY, TEXT_429_UNREACHABLE, TYPIST_USAGE, RECORDED, runWorker, step, tail, textAnswer } from "./agyStandin.mjs";

const TASK = "Write test/helpers/app.helper.ts.";
const REPLY = '{"result":"done"}';
const TOOL_USAGE = RECORDED.tool_then_held.usage;

/** A session whose tool call is answered, runs until `doneAt`, and whose next call is then refused at the location. */
const toolThenRefused = (doneAt) => ({ turns: [[
  { at: 0, step: step.user(TASK) },
  { at: 0.05, step: step.tool("view_file", "ACTIVE") },
  { at: 0.06, usage: TOOL_USAGE },
  { at: doneAt, step: step.tool("view_file", "DONE") },
  { at: doneAt + 0.05, step: step.error(429, TEXT_429_RETRY) },
  { at: doneAt + 0.1, step: step.error(429, TEXT_429_UNREACHABLE) },
  { at: doneAt + 0.11, raise: RAISE_429_UNREACHABLE.raise, message: RAISE_429_UNREACHABLE.message },
]] });
const ARGS = ["--api-retries", "1", "--api-retry-initial-ms", "1000", "--locations", "global,us", "--busy-budget-sec", "2"];

test("a call refused late in a long session gets its own busy budget: it carries on at the next location", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  for (const doneAt of [0.07, 3.0]) {
    const r = await runWorker("agent", { script: { by_location: { global: [toolThenRefused(doneAt)], us: [{ turns: [[...textAnswer(0.2, REPLY, TYPIST_USAGE)]] }] } }, args: ARGS, timeout: 30, brief: TASK });
    assert.equal(r.code, 0, `tool done at ${doneAt} s: ${tail(r)}; tries ${JSON.stringify(r.sidecar?.tries?.map((t) => [t.location, t.ended_by, t.s]))}`);
    assert.deepEqual(r.sessions.map((s) => s.location), ["global", "us"], `tool done at ${doneAt} s`);
    assert.equal(r.sidecar.failovers, 1);
    assert.equal(r.stdout.trim(), REPLY);
  }
});
