/**
 * A worker's unavailable call is counted from when its own stretch of unserved calls began (its receipt's
 * unserved_since), never from when the dispatch was sent: a thinking step or an agent packet answers many calls before
 * one goes unserved, and counted from its start a long, served step read as "no call of it was served for 300 s"
 * (review: a step served for its whole length was halted). Pure: the ledger on a set clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BusyLedger, unservedSince } from "../dist/busyLedger.js";

test("a long step's busy stretch counts from the worker's own account, not from when the step was sent", () => {
  let now = 1_000_000_000;
  const clock = () => now;
  const sentAt = now;
  // Ten minutes of served calls, then a call refused for 120 s.
  now += 600_000;
  const short = { unavailable: "refused at global (6 requests over 120 s; last HTTP 429 RESOURCE_EXHAUSTED)", unserved_since: new Date(now - 120_000).toISOString() };
  assert.equal(new BusyLedger({ now: clock }).unavailable("gemini-3.8-flash", short.unavailable, unservedSince(short, sentAt)), null, "120 s of a 300 s window: a wait");
  assert.match(new BusyLedger({ now: clock }).unavailable("gemini-3.8-flash", short.unavailable, sentAt) ?? "", /no call of it was served for 300 s/, "counted from the step's start, the same call halts the run");
  const long = { unavailable: short.unavailable, unserved_since: new Date(now - 301_000).toISOString() };
  assert.match(new BusyLedger({ now: clock }).unavailable("gemini-3.8-flash", long.unavailable, unservedSince(long, sentAt)) ?? "", /no call of it was served for 300 s/, "a stretch the window covers stops the run");
});

test("with no account of its own, or one that cannot be the dispatch's, the stretch begins when the dispatch was sent", () => {
  const sentAt = Date.parse("2026-11-03T10:00:00.000Z");
  assert.equal(unservedSince({}, sentAt), sentAt);
  assert.equal(unservedSince({ unserved_since: "not a time" }, sentAt), sentAt);
  assert.equal(unservedSince({ unserved_since: "2026-11-03T09:59:55.000Z" }, sentAt), sentAt, "before the dispatch was sent: not this dispatch's stretch");
  assert.equal(unservedSince({ unserved_since: "2026-11-03T10:04:00.000Z" }, sentAt), Date.parse("2026-11-03T10:04:00.000Z"));
});
