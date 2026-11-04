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

test("a step Google served until its own stretch began is served in the run's ledger: a stretch an earlier batch left open does not run on across it", () => {
  // Review of 0.10.1: an earlier batch left the ledger's stretch open; a thinking step then ran, served by Google for
  // minutes, and its closing call was refused for 120 s. Counted from the earlier stretch, the run was halted although
  // the step had just been served.
  let now = 2_000_000_000;
  const ledger = new BusyLedger({ now: () => now });
  assert.equal(ledger.unavailable("gemini-3.8-flash", "refused", now), null, "an earlier batch's call goes unserved: a wait");
  now += 250_000;
  const stepServedUntil = now;
  now += 120_000;
  // The step's worker was served until stepServedUntil, then its last call was refused for 120 s.
  ledger.served("gemini-3.8-flash", stepServedUntil);
  assert.equal(ledger.unavailable("gemini-3.8-flash", "refused", stepServedUntil), null, "120 s since the step was last served: a wait, not a halt");
  // Without the step's own served time the same call halts the run: the negative control.
  let t = 2_000_000_000;
  const old = new BusyLedger({ now: () => t });
  old.unavailable("gemini-3.8-flash", "refused", t);
  t += 370_000;
  assert.match(old.unavailable("gemini-3.8-flash", "refused", t - 120_000) ?? "", /no call of it was served for 300 s/);
  // The stretch counts from when the step was last served, not from when the ledger heard of it: 301 s after it, with
  // nothing served since, the window has passed.
  now += 181_000;
  assert.match(ledger.closed("gemini-3.8-flash") ?? "", /no call of it was served for 300 s/, "301 s since the step was last served");
});

test("a served time never moves the ledger's last service back, and never ahead of its clock", () => {
  let now = 3_000_000_000;
  const ledger = new BusyLedger({ now: () => now });
  ledger.served("m", now);
  ledger.served("m", now - 60_000);
  ledger.unavailable("m", "refused", now);
  now += 299_000;
  assert.equal(ledger.closed("m"), null, "an older served time did not move the stretch back");
  const ahead = new BusyLedger({ now: () => now });
  ahead.served("m", now + 600_000);
  ahead.unavailable("m", "refused", now);
  now += 301_000;
  assert.match(ahead.closed("m") ?? "", /300 s/, "a served time ahead of the clock is taken as now");
});
