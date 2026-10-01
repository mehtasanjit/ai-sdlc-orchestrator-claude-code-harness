/**
 * Pins for the dated price list (src/prices.ts): the model-name reader
 * (resolveModel), every rate against the vendor pages as verified on
 * 2026-09-14, the fast / US-only modifiers, dated lookups, and the rule that
 * a shipped policy's `pricing:` card must equal the list for today's date.
 *
 * Why the card check uses the REAL current date, not a pinned one: the cards
 * are what the orchestrator copies into estimated telemetry and what the
 * adapters bill with today. When a list period ends (Gemini 3.7 Flash's
 * introductory card ends 2026-12-31) this suite goes red on purpose, so a
 * stale card is fixed before it prices a run, instead of drifting silently
 * the way the Sonnet 5 card did (3.00/15.00 shipped; the page says 2/10).
 *
 * Imports from dist/ (this suite runs via `npm run build && node --test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { PRICE_LIST, PRICE_LIST_VERIFIED, resolveModel, lookupPrice } from "../dist/prices.js";
import { computeCostUsd } from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const POLICY_DIR = join(HERE, "..", "..", "..", "config", "policies");

const ANTHROPIC_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const GEMINI_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const DAY = "2026-09-14";
const STD = { speed: "standard", service_tier: "standard", inference_geo: "not_available" };

/** Build the pricing object from the page's column order: base input, 5m write, 1h write, cache read, output. */
const card = (input, write5m, write1h, cacheRead, output) => ({
  input,
  input_cache_write: write5m,
  input_cache_write_1h: write1h,
  input_cached: cacheRead,
  output,
});

function priced(model, date = DAY, modifiers = STD) {
  const r = lookupPrice(model, date, modifiers);
  assert.equal(r.unpriced, false, `${model} on ${date} ${JSON.stringify(modifiers)} should be priced, got: ${r.reason}`);
  return r;
}

function unpriced(model, date = DAY, modifiers = STD) {
  const r = lookupPrice(model, date, modifiers);
  assert.equal(r.unpriced, true, `${model} on ${date} ${JSON.stringify(modifiers)} must be unpriced, got ${JSON.stringify(r.pricing)}`);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
  assert.equal(r.pricing, undefined, "an unpriced lookup must not carry a rate to fall back on");
  return r;
}

// ── T1: the model-name reader ────────────────────────────────────────────

test("T1 resolveModel accepts a bracketed Claude Code option in any case and with any content", () => {
  assert.deepEqual(resolveModel("claude-opus-5[1m]"), { id: "claude-opus-5", tag: "[1m]", snapshotDate: null });
  assert.deepEqual(resolveModel("claude-opus-5[1M]"), { id: "claude-opus-5", tag: "[1M]", snapshotDate: null });
  assert.deepEqual(resolveModel("claude-opus-5[anything else]"), { id: "claude-opus-5", tag: "[anything else]", snapshotDate: null });
  assert.deepEqual(resolveModel("claude-opus-4-8"), { id: "claude-opus-4-8", tag: null, snapshotDate: null });
});

test("T1 resolveModel accepts Anthropic's -YYYYMMDD snapshot suffix, alone or before an option", () => {
  assert.deepEqual(resolveModel("claude-haiku-4-5-20251001"), { id: "claude-haiku-4-5", tag: null, snapshotDate: "20251001" });
  assert.deepEqual(resolveModel("claude-haiku-4-5-20251001[1m]"), { id: "claude-haiku-4-5", tag: "[1m]", snapshotDate: "20251001" });
  assert.deepEqual(resolveModel("claude-3-5-haiku-20241022"), { id: "claude-3-5-haiku", tag: null, snapshotDate: "20241022" });
});

test("T1 resolveModel: the longest id wins, so a point release never collapses onto its parent", () => {
  assert.equal(resolveModel("claude-fable-5-1").id, "claude-fable-5-1");
  assert.equal(resolveModel("claude-fable-5-1[1m]").id, "claude-fable-5-1");
  assert.equal(resolveModel("claude-fable-5").id, "claude-fable-5");
  assert.equal(resolveModel("claude-fable-5-20260101").id, "claude-fable-5");
  assert.equal(resolveModel("claude-opus-4-1-20250805").id, "claude-opus-4-1");
  assert.equal(resolveModel("claude-opus-4-20250514").id, "claude-opus-4");
  assert.equal(resolveModel("claude-opus-4-5").id, "claude-opus-4-5");
  assert.equal(resolveModel("gemini-3.7-flash").id, "gemini-3.7-flash");
  // Flash-Lite is tried before 3.5 Flash, and 3.5 Flash never absorbs "-lite".
  assert.equal(resolveModel("gemini-3.5-flash-lite").id, "gemini-3.5-flash-lite");
  assert.equal(resolveModel("gemini-3.5-flash").id, "gemini-3.5-flash");
  assert.equal(resolveModel("gemini-3.8-flash").id, "gemini-3.8-flash");
});

test("T1 resolveModel returns null for everything else: no pairing guesses", () => {
  const junk = [
    "", " claude-opus-5", "claude-opus-5 ", "CLAUDE-OPUS-5", "claude-opus",
    "claude-opus-5-1",          // not a listed id; must not become claude-opus-5
    "claude-sonnet-5-1", "claude-opus-4-9", "claude-opus-5x", "claude-opus-5-fast",
    "claude-opus-5-2026", "claude-opus-5-202601011", "claude-opus-5-20261301", "claude-opus-5-20260230",
    "claude-opus-5[]", "claude-opus-5[1m]x", "claude-opus-5[1m][2]", "claude-opus-5[[1m]]",
    "claude-opus-5@20260101", "us.anthropic.claude-opus-5", "anthropic/claude-opus-5",
    "claude-mythos-5-1", "claude-mythos-5",  // limited availability, deliberately not listed
    // gemini-3.5-flash-lite and gemini-3.8-flash left this list when their
    // verified periods were added. Gemini 3.6 Flash is on Google's page but
    // not on the list (no shipped or demo policy routes to it), so it, and
    // near-miss spellings of the listed ids, must not resolve.
    "<synthetic>", "gemini-3.7-flash-preview", "gemini-3.6-flash", "gemini-3.5-flash-lite-preview", "gemini-3.8-flash-lite",
  ];
  for (const name of junk) assert.equal(resolveModel(name), null, `${JSON.stringify(name)} must not resolve`);
  for (const notString of [undefined, null, 5, {}, ["claude-opus-5"]]) assert.equal(resolveModel(notString), null);
});

// ── T2: every Claude rate, pinned to the page ────────────────────────────

const CLAUDE_PAGE = {
  // model id:          base in, 5m write, 1h write, cache read, output  (per MTok, 2026-09-14)
  "claude-fable-5-1":   card(10, 12.5, 20, 0.25, 50),
  "claude-fable-5":     card(10, 12.5, 20, 1, 50),
  "claude-opus-5":      card(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8":    card(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7":    card(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6":    card(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5":    card(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1":    card(15, 18.75, 30, 1.5, 75),
  "claude-opus-4":      card(15, 18.75, 30, 1.5, 75),
  "claude-opus-5-5":    card(4, 5, 8, 0.2, 20),
  "claude-sonnet-5":    card(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6":  card(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5":  card(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4":    card(3, 3.75, 6, 0.3, 15),
  "claude-haiku-4-5":   card(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku":   card(0.8, 1, 1.6, 0.08, 4),
};

test("T2 the list carries exactly the non-Mythos Claude rows on the page, nothing more", () => {
  const claudeIds = Object.keys(PRICE_LIST).filter((id) => id.startsWith("claude-")).sort();
  assert.deepEqual(claudeIds, Object.keys(CLAUDE_PAGE).sort());
  assert.equal(PRICE_LIST_VERIFIED, DAY);
});

test("T2 every Claude rate equals Anthropic's price page as verified 2026-09-14 (incl. Fable 5.1 cache read 0.25)", () => {
  for (const [id, expected] of Object.entries(CLAUDE_PAGE)) {
    const r = priced(id);
    assert.deepEqual(r.pricing, expected, id);
    assert.deepEqual(r.model, { id, tag: null, snapshotDate: null });
    assert.equal(r.period.source_url, ANTHROPIC_URL, id);
    assert.equal(r.period.verified, DAY, id);
    assert.equal(r.period.to, null, `${id}: no end date is published`);
    assert.deepEqual(r.applied_modifiers, { speed: "standard", service_tier: "standard", inference_geo: "not_available", multiplier: 1, defaulted: [] });
  }
  // The names Claude Code actually writes price identically to the bare id.
  assert.deepEqual(priced("claude-opus-5[1m]").pricing, CLAUDE_PAGE["claude-opus-5"]);
  assert.deepEqual(priced("claude-haiku-4-5-20251001").pricing, CLAUDE_PAGE["claude-haiku-4-5"]);
});

test("T2 fast mode: Opus 5 and Opus 4.8 only, $10/$50 with the cache multipliers on top", () => {
  for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-5[1m]"]) {
    const r = priced(id, DAY, { ...STD, speed: "fast" });
    assert.deepEqual(r.pricing, card(10, 12.5, 20, 1, 50), id);
    assert.equal(r.applied_modifiers.speed, "fast");
  }
  for (const id of ["claude-opus-4-7", "claude-opus-4-6", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"]) {
    const r = unpriced(id, DAY, { ...STD, speed: "fast" });
    assert.match(r.reason, /fast/, id);
  }
});

test("T2 US-only inference: x1.1 on every token class for Claude 4.6 and later; unpriced before 4.6", () => {
  const us = { ...STD, inference_geo: "us" };
  assert.deepEqual(priced("claude-opus-5", DAY, us).pricing, card(5.5, 6.875, 11, 0.55, 27.5));
  assert.deepEqual(priced("claude-fable-5-1", DAY, us).pricing, card(11, 13.75, 22, 0.275, 55));
  assert.deepEqual(priced("claude-sonnet-5", DAY, us).pricing, card(2.2, 2.75, 4.4, 0.22, 11));
  assert.equal(priced("claude-opus-5", DAY, us).applied_modifiers.multiplier, 1.1);
  for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
    assert.equal(priced(id, DAY, us).applied_modifiers.inference_geo, "us", id);
  }
  // Stacks with fast mode.
  assert.deepEqual(priced("claude-opus-4-8", DAY, { ...us, speed: "fast" }).pricing, card(11, 13.75, 22, 1.1, 55));
  for (const id of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-opus-4", "claude-sonnet-4", "claude-3-5-haiku"]) {
    assert.match(unpriced(id, DAY, us).reason, /inference_geo/, id);
  }
  // "global" (the API default) and "not_available" (what Claude Code transcripts write) are standard pricing.
  assert.deepEqual(priced("claude-opus-5", DAY, { ...STD, inference_geo: "global" }).pricing, CLAUDE_PAGE["claude-opus-5"]);
});

test("T2 unknown models and unknown modifier values are unpriced with a precise reason, never borrowed", () => {
  assert.match(unpriced("claude-opus-4-9").reason, /claude-opus-4-9/);
  assert.equal(unpriced("claude-opus-4-9").model, null);
  assert.match(unpriced("claude-sonnet-5-1").reason, /claude-sonnet-5-1/);
  assert.match(unpriced("claude-opus-5", DAY, { ...STD, service_tier: "priority" }).reason, /service_tier "priority"/);
  assert.match(unpriced("claude-opus-5", DAY, { ...STD, service_tier: "batch" }).reason, /service_tier "batch"/);
  assert.match(unpriced("claude-opus-5", DAY, { ...STD, speed: "turbo" }).reason, /speed "turbo"/);
  assert.match(unpriced("claude-opus-5", DAY, { ...STD, speed: "Standard" }).reason, /speed "Standard"/);
  assert.match(unpriced("claude-opus-5", DAY, { ...STD, inference_geo: "eu" }).reason, /inference_geo "eu"/);
  // A resolved model that is unpriced still names what it resolved to.
  assert.deepEqual(unpriced("claude-opus-5[1m]", DAY, { ...STD, service_tier: "priority" }).model, { id: "claude-opus-5", tag: "[1m]", snapshotDate: null });
});

test("T2 absent modifiers take the API defaults and say so", () => {
  const r = priced("claude-opus-5", DAY, {});
  assert.deepEqual(r.pricing, CLAUDE_PAGE["claude-opus-5"]);
  assert.deepEqual(r.applied_modifiers, { speed: "standard", service_tier: "standard", inference_geo: "global", multiplier: 1, defaulted: ["speed", "service_tier", "inference_geo"] });
  const none = lookupPrice("claude-opus-5", DAY);
  assert.equal(none.unpriced, false);
  assert.deepEqual(none.applied_modifiers.defaulted, ["speed", "service_tier", "inference_geo"]);
  assert.deepEqual(priced("claude-opus-5", DAY, { speed: null, service_tier: "standard", inference_geo: "not_available" }).applied_modifiers.defaulted, ["speed"]);
});

// ── T2: every Gemini period, pinned to Google's pages ────────────────────
//
// Verified 2026-09-14 on both of Google's pages, each fetched twice with
// identical text: ai.google.dev/gemini-api/docs/pricing (Standard, paid tier)
// and cloud.google.com/vertex-ai/generative-ai/pricing (Global rows). GA days
// come from ai.google.dev/gemini-api/docs/changelog. The exact quotes sit
// beside each row in src/prices.ts. Gemini has no cache-write premium, so both
// write rates equal input.

const gcard = (input, cacheRead, output) => card(input, input, input, cacheRead, output);
const GEMINI_PAGE = {
  "gemini-3.8-flash": [
    { from: "2026-09-02", to: "2026-12-31", rates: gcard(0.75, 0.075, 3.75) },
    { from: "2027-01-01", to: null, rates: gcard(1.5, 0.15, 7.5) },
  ],
  "gemini-3.7-flash": [
    { from: "2026-08-13", to: "2026-12-31", rates: gcard(0.75, 0.075, 3.75) },
    { from: "2027-01-01", to: null, rates: gcard(1.5, 0.15, 7.5) },
  ],
  "gemini-3.5-flash": [{ from: "2026-05-19", to: null, rates: gcard(1.5, 0.15, 9) }],
  "gemini-3.5-flash-lite": [{ from: "2026-07-21", to: null, rates: gcard(0.3, 0.03, 2.5) }],
};

test("T2 the list carries exactly these Gemini periods, each equal to Google's pages as verified 2026-09-14", () => {
  const geminiIds = Object.keys(PRICE_LIST).filter((id) => id.startsWith("gemini-")).sort();
  assert.deepEqual(geminiIds, Object.keys(GEMINI_PAGE).sort());
  for (const [id, expected] of Object.entries(GEMINI_PAGE)) {
    const listed = PRICE_LIST[id].map((p) => ({
      from: p.from,
      to: p.to,
      rates: card(p.input, p.input_cache_write, p.input_cache_write_1h, p.input_cached, p.output),
    }));
    assert.deepEqual(listed, expected, id);
    for (const p of PRICE_LIST[id]) {
      assert.equal(p.source_url, GEMINI_URL, id);
      assert.equal(p.verified, DAY, id);
      assert.equal(p.web_search_per_request, undefined, `${id}: the list has no per-search price for Gemini`);
    }
    // Each period prices on its own first and last day, with no multiplier.
    for (const { from, to, rates } of expected) {
      for (const day of to === null ? [from] : [from, to]) {
        const r = priced(id, day, {});
        assert.deepEqual(r.pricing, rates, `${id} on ${day}`);
        assert.deepEqual(r.period, { from, to, source_url: GEMINI_URL, verified: DAY }, `${id} on ${day}`);
        assert.equal(r.applied_modifiers.multiplier, 1, `${id} on ${day}`);
      }
    }
    // Nothing before GA.
    const gaEve = new Date(Date.parse(`${expected[0].from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    assert.match(unpriced(id, gaEve, {}).reason, new RegExp(`no price period for ${id.replace(/\./g, "\\.")} on ${gaEve}`));
  }
});

// ── T3: dated lookups ────────────────────────────────────────────────────

test("T3 Gemini 3.7 Flash: introductory card through 2026-12-31, the 2027 card from 2027-01-01, nothing before GA", () => {
  const r = priced("gemini-3.7-flash", DAY, {});
  assert.deepEqual(r.pricing, card(0.75, 0.75, 0.75, 0.075, 3.75));
  assert.deepEqual(r.period, { from: "2026-08-13", to: "2026-12-31", source_url: GEMINI_URL, verified: DAY });
  // Changed expectation: a 2027 day used to be unpriced because the list had
  // no 2027 period, so a 3.7 Flash run halted at pre-flight on 2027-01-01.
  // Both of Google's pages publish the 2027 card, so it now bills
  // 1.50 / 0.15 / 7.50.
  const y2027 = priced("gemini-3.7-flash", "2027-01-02", {});
  assert.deepEqual(y2027.pricing, card(1.5, 1.5, 1.5, 0.15, 7.5));
  assert.deepEqual(y2027.period, { from: "2027-01-01", to: null, source_url: GEMINI_URL, verified: DAY });
  // Both ends are inclusive, the card switches on 2027-01-01, and nothing
  // before launch is priced.
  assert.equal(priced("gemini-3.7-flash", "2026-08-13", {}).pricing.input, 0.75);
  assert.equal(priced("gemini-3.7-flash", "2026-12-31", {}).pricing.input, 0.75);
  assert.equal(priced("gemini-3.7-flash", "2027-01-01", {}).pricing.input, 1.5);
  assert.match(unpriced("gemini-3.7-flash", "2026-08-12", {}).reason, /no price period for gemini-3\.7-flash on 2026-08-12/);
});

test("T3 Gemini 3.8 Flash: introductory card from GA (2026-09-02) through 2026-12-31, the 2027 card from 2027-01-01", () => {
  const r = priced("gemini-3.8-flash", DAY, {});
  assert.deepEqual(r.pricing, card(0.75, 0.75, 0.75, 0.075, 3.75));
  assert.deepEqual(r.period, { from: "2026-09-02", to: "2026-12-31", source_url: GEMINI_URL, verified: DAY });
  assert.deepEqual(priced("gemini-3.8-flash", "2027-01-01", {}).pricing, card(1.5, 1.5, 1.5, 0.15, 7.5));
  assert.equal(priced("gemini-3.8-flash", "2026-09-02", {}).pricing.input, 0.75);
  assert.match(unpriced("gemini-3.8-flash", "2026-09-01", {}).reason, /no price period for gemini-3\.8-flash on 2026-09-01/);
});

test("T3 Gemini 3.5 Flash and 3.5 Flash-Lite are priced from their GA days; Flash-Lite never reads as 3.5 Flash", () => {
  const r = priced("gemini-3.5-flash", DAY, {});
  assert.deepEqual(r.pricing, card(1.5, 1.5, 1.5, 0.15, 9));
  assert.deepEqual(r.period, { from: "2026-05-19", to: null, source_url: GEMINI_URL, verified: DAY });
  unpriced("gemini-3.5-flash", "2026-05-18", {});
  // Changed expectation: Flash-Lite was unpriced on every day (not on the
  // list), which halted the governance demo policy at pre-flight. Google's
  // pages publish 0.30 / 0.03 / 2.50 and the changelog dates GA 2026-07-21,
  // so the unpriced check moves to the day before GA.
  const lite = priced("gemini-3.5-flash-lite", DAY, {});
  assert.deepEqual(lite.model, { id: "gemini-3.5-flash-lite", tag: null, snapshotDate: null });
  assert.deepEqual(lite.pricing, card(0.3, 0.3, 0.3, 0.03, 2.5));
  assert.deepEqual(lite.period, { from: "2026-07-21", to: null, source_url: GEMINI_URL, verified: DAY });
  assert.match(unpriced("gemini-3.5-flash-lite", "2026-07-20", {}).reason, /no price period for gemini-3\.5-flash-lite on 2026-07-20/);
});

test("T3 Gemini carries no Anthropic modifiers: fast or US-only on Gemini is unpriced", () => {
  for (const id of Object.keys(GEMINI_PAGE)) {
    unpriced(id, DAY, { speed: "fast" });
    unpriced(id, DAY, { inference_geo: "us" });
  }
});

test("T3 dates: a Claude row starts at the list's coverage start; timestamps use their UTC day; bad dates are unpriced", () => {
  unpriced("claude-opus-5", "2025-12-31");
  priced("claude-opus-5", "2026-01-01");
  // Transcript timestamps work directly, and the UTC day decides the period.
  priced("gemini-3.7-flash", "2026-09-08T11:45:25.809Z", {});
  // Changed expectation: with the 2027 period on the list these two pin WHICH
  // period the UTC day selects, instead of priced versus unpriced.
  assert.equal(priced("gemini-3.7-flash", "2026-12-31T23:30:00-05:00", {}).period.from, "2027-01-01"); // 2027-01-01T04:30Z
  assert.equal(priced("gemini-3.7-flash", "2027-01-01T01:00:00+05:30", {}).period.from, "2026-08-13"); // 2026-12-31T19:30Z
  unpriced("gemini-3.5-flash-lite", "2026-07-21T01:00:00+05:30", {});                                   // 2026-07-20T19:30Z
  // lookupPrice is called directly: the helpers' default date would silently replace `undefined`.
  for (const bad of ["", "yesterday", "2026-02-30", "2026-13-01", "20260914", "2026-09-08T11:45:25", undefined, null, 20260914]) {
    const r = lookupPrice("claude-opus-5", bad, STD);
    assert.equal(r.unpriced, true, String(bad));
    assert.match(r.reason, /invalid date/, String(bad));
  }
});

test("the list is frozen and lookups hand back copies, so no caller can reprice another", () => {
  assert.throws(() => { PRICE_LIST["claude-opus-5"][0].input = 1; }, TypeError);
  assert.throws(() => { PRICE_LIST["claude-opus-5"].push({}); }, TypeError);
  const a = priced("claude-opus-5");
  a.pricing.input = 999;
  assert.equal(priced("claude-opus-5").pricing.input, 5);
});

test("every period is well formed: ordered, non-overlapping, sourced and dated", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  for (const [id, periods] of Object.entries(PRICE_LIST)) {
    assert.ok(periods.length > 0, id);
    periods.forEach((p, i) => {
      assert.match(p.from, ISO, id);
      if (p.to !== null) { assert.match(p.to, ISO, id); assert.ok(p.from <= p.to, id); }
      if (i > 0) assert.ok(periods[i - 1].to !== null && periods[i - 1].to < p.from, `${id}: periods overlap or are out of order`);
      assert.match(p.source_url, /^https:\/\//, id);
      assert.match(p.verified, ISO, id);
      for (const k of ["input", "input_cached", "input_cache_write", "input_cache_write_1h", "output"]) {
        assert.ok(Number.isFinite(p[k]) && p[k] >= 0, `${id}.${k}`);
      }
    });
  }
});

// ── shipped policy cards must equal the list ─────────────────────────────

const BUCKETS = ["input", "input_cached", "output", "input_cache_write", "input_cache_write_1h"];
const TODAY = new Date().toISOString().slice(0, 10);

test("every shipped policy's pricing card equals the price list for today's date", () => {
  const files = readdirSync(POLICY_DIR).filter((f) => f.endsWith(".yaml"));
  // Changed: 8 since opus-plus-flash-v38 shipped in v0.7.3.
  assert.ok(files.length >= 8, `expected the shipped policies under ${POLICY_DIR}`);
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const policy = parseYaml(readFileSync(join(POLICY_DIR, file), "utf-8"));
    for (const m of policy.models ?? []) {
      const where = `${file} models[${m.id}] (${m.model_name})`;
      if (!m.pricing) { problems.push(`${where}: no pricing card (the orchestrator's estimated telemetry needs one)`); continue; }
      const r = lookupPrice(m.model_name, TODAY, {});
      if (r.unpriced) { problems.push(`${where}: ${r.reason}; add the verified period to src/prices.ts and update this card`); continue; }
      checked++;
      for (const k of Object.keys(m.pricing)) {
        if (!BUCKETS.includes(k)) problems.push(`${where}: unknown pricing field ${k}`);
      }
      for (const k of BUCKETS) {
        if (m.pricing[k] !== undefined) {
          if (m.pricing[k] !== r.pricing[k]) problems.push(`${where}: ${k} is ${m.pricing[k]}, the list says ${r.pricing[k]} (${r.period.source_url}, verified ${r.period.verified})`);
          continue;
        }
        // An omitted write rate falls back to input x 1.25 / x 2 inside computeCostUsd.
        // For Claude that fallback must land on the list's rate. Gemini cards omit
        // them because the Gemini adapters never bill a write bucket (pinned below).
        if (!k.startsWith("input_cache_write") || m.model_name.startsWith("gemini-")) continue;
        const effective = computeCostUsd({ input: 0, input_cached: 0, output: 0, [k]: 1_000_000 }, m.pricing);
        if (effective !== r.pricing[k]) problems.push(`${where}: omitted ${k} falls back to ${effective}, the list says ${r.pricing[k]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 10, `expected every shipped model card to be checked, checked ${checked}`);
});

// A card also says where its rates were checked and when. A card equal to the
// list carries the list period's `verified` date, and its source starts with
// the page that period cites. Found on 2026-09-14: cards stamped 2026-08-04 and
// 2026-08-19 while the list was re-verified that day, and every Claude card
// citing .../docs/en/docs/about-claude/pricing, a doubled path Anthropic only
// answers with a 307 redirect to .../docs/en/about-claude/pricing.
test("every shipped card cites its list period's source page and carries that period's verified date", () => {
  const files = readdirSync(POLICY_DIR).filter((f) => f.endsWith(".yaml"));
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const raw = readFileSync(join(POLICY_DIR, file), "utf-8");
    if (raw.includes("docs/en/docs")) problems.push(`${file}: contains the doubled docs/en/docs pricing path`);
    for (const m of parseYaml(raw).models ?? []) {
      const where = `${file} models[${m.id}] (${m.model_name})`;
      const r = lookupPrice(m.model_name, TODAY, {});
      if (r.unpriced) continue; // the card test above reports it
      checked++;
      const source = String(m.pricing_source ?? "");
      if (source !== r.period.source_url && !source.startsWith(`${r.period.source_url} `)) {
        problems.push(`${where}: pricing_source ${JSON.stringify(source)} does not start with the list's source ${r.period.source_url}`);
      }
      if (String(m.pricing_last_verified) !== r.period.verified) {
        problems.push(`${where}: pricing_last_verified is ${m.pricing_last_verified}, the list period was verified ${r.period.verified}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 10, `expected every shipped model card to be checked, checked ${checked}`);
});

test("the Gemini adapters bill no cache-write bucket, so the list's Gemini write rates cannot move today's Gemini dollars", () => {
  for (const rel of ["adapters/GeminiFlashAdapter.js", "adapters/AntigravityWorkerAdapter.js", "delegation/workerProcess.js"]) {
    assert.doesNotMatch(readFileSync(join(DIST, rel), "utf-8"), /input_cache_write/, rel);
  }
});

// ── Review finding M3: web search is billed per search, not per token ─────
//
// Anthropic's page (verified 2026-09-14): "Web search is available on the
// Claude API for $10 per 1,000 searches, plus standard token costs". Each
// search is one use whatever it returns; web fetch has no additional charge.
// The fee is not a token pricing category, so the US-only multiplier ("all
// token pricing categories") and fast mode (token rates) do not scale it.
// Receipts count searches in modelUsage[*].webSearchRequests and transcripts in
// usage.server_tool_use.web_search_requests. Booking a receipt's token counts
// without this fee under-booked any run that searched, while pricing_complete
// still said true. Gemini carries no per-search price on this list, so a
// Gemini search is unpriced, never borrowed from Claude's fee.
test("M3 every Claude period bills web search at $0.01 per search ($10 per 1,000), unscaled by fast mode or US-only inference; Gemini has no per-search price", () => {
  for (const id of Object.keys(CLAUDE_PAGE)) {
    assert.equal(PRICE_LIST[id][0].web_search_per_request, 0.01, id);
    assert.equal(priced(id).web_search_per_request, 0.01, id);
  }
  assert.equal(priced("claude-opus-5", DAY, { ...STD, speed: "fast" }).web_search_per_request, 0.01, "fast mode prices tokens, not searches");
  assert.equal(priced("claude-opus-5", DAY, { ...STD, inference_geo: "us" }).web_search_per_request, 0.01, "US-only multiplies token categories only");
  assert.equal(priced("claude-haiku-4-5-20251001").web_search_per_request, 0.01);
  assert.equal(priced("gemini-3.5-flash", DAY, {}).web_search_per_request, null);
  assert.equal(PRICE_LIST["gemini-3.7-flash"][0].web_search_per_request, undefined);
});
