/**
 * T11 (Fix E, v0.7.3): the report's orchestrator lines for manifests written by
 * the v0.7.3 collector.
 *
 * Before v0.7.3 the report printed one orchestrator figure. The collector now
 * writes which model each dollar ran on (`per_model`), what a booked receipt
 * billed beyond the transcript (`unlogged_billed`), whether every helper's
 * transcript was there (`attribution_complete`), tokens the price list could
 * not price (`unpriced`), custom policy prices (`price_basis: "custom"`) and
 * Claude Code's own figure as a check (`receipt_cli_usd`). Quiet failures this
 * pins against:
 *   - a session on one model and helpers on another read as one figure;
 *   - a transcript-priced (interactive) figure reads as the whole bill, when
 *     Claude Code bills calls it never logs (2.3% and 22% on measured runs);
 *   - a booked receipt prints Claude Code's own dollars as if they were booked;
 *   - unpriced tokens, a custom price or a missing helper file go unmentioned.
 * Manifests written before v0.7.3 render byte-for-byte as before: see
 * report-old-manifests.test.mjs.
 *
 * Figures are the real collector output for tools/test/fixtures/
 * headless-unlogged-calls (T5), fable-session-opus-helpers (T4) and
 * headless-side-call (T6), trimmed to the fields the report reads. The report
 * runs as a real subprocess: what a person sees is what is tested. $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");

const event = (task_id, phase, cost, over = {}) => ({
  task_id, phase, model: "m", input_tokens: 1000, output_tokens: 500, cost_usd: cost, provenance: "vendor", success: true, ...over,
});
const orchEvent = (cost, over = {}) => ({
  task_id: "orchestrator-overhead-p1", phase: "orchestrator_overhead", model: "driver",
  input_tokens: 248, input_tokens_cached: 12_979_305, input_tokens_cache_write: 443_852, output_tokens: 194_263,
  cost_usd: cost, provenance: "transcript", tier: "orchestrator", success: true, ...over,
});

function report({ events, manifest = {}, markdown = false }) {
  const dir = mkdtempSync(join(tmpdir(), "report-per-model-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ policy_name: "p", started_at: "2026-09-10T17:27:00Z", ...manifest }));
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return execFileSync("node", markdown ? [REPORT, dir, "--markdown"] : [REPORT, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (role, model, cost_usd, over = {}) => ({ model, role, reported_as: [model], price_basis: "list", messages: 1, cost_usd, ...over });

/** T5's real orchestrator_overhead: a headless receipt booked at the list, 2.32% billed but not logged. */
const BOOKED = {
  cost_usd: 14.197776, input_tokens: 248, input_tokens_cached: 12_979_305, input_tokens_cache_write: 443_852, input_tokens_cache_write_1h: 20_329, output_tokens: 194_263,
  events: 1, provenance: "transcript",
  cost_source: "receipt (Anthropic token counts priced at the price list); 2.3% billed but not logged",
  transcript_cost_usd: 13.868479, receipt_cost_usd: 14.19777625, receipt_cli_usd: 14.19777625,
  per_model: [entry("session", "claude-opus-5", 0.499714, { messages: 10 }), entry("helper", "claude-opus-4-8", 13.368765, { messages: 112 })],
  unpriced: [], pricing_complete: true, price_list_verified: "2026-09-14",
  unlogged_billed: {
    per_model: [{ model: "claude-opus-4-8", reported_as: ["claude-opus-4-8"], receipt_only: false, tokens: { input: 4, input_cached: 403_480, input_cache_write: 18_938, output: 367 }, ttl_split: "logged mix", assumed: [], cost_usd: 0.329297 }],
    unpriced: [], cost_usd: 0.329297, pct_of_booked: 2.32,
  },
  attribution_complete: true, missing_helper_ids: [], unreferenced_helper_files: [],
  dispatched_in_session_cost_usd: 0, dispatched_in_session_events: 0,
  window: { start: "2026-09-10T17:27:16.771Z", end: null, start_anchor: "command turn", end_anchor: "end of session", exact: true, lower_bound: false, session_id: "908511af-6158-466f-92ad-beb1cd9f5c73", source: "manifest" },
};

/** T4's real orchestrator_overhead: an interactive Fable 5.1 session with Opus 5 helpers, no receipt. */
const TRANSCRIPT = {
  cost_usd: 13.933431, input_tokens: 1078, input_tokens_cached: 7_753_756, input_tokens_cache_write: 692_812, input_tokens_cache_write_1h: 147_929, output_tokens: 152_411,
  events: 1, provenance: "transcript",
  cost_source: "transcript (no receipt; unverified)",
  transcript_cost_usd: 13.933431, receipt_cost_usd: null, receipt_cli_usd: null,
  per_model: [entry("session", "claude-fable-5-1", 4.801151, { messages: 31 }), entry("helper", "claude-opus-5", 9.13228, { messages: 102 })],
  unpriced: [], pricing_complete: true, price_list_verified: "2026-09-14",
  unlogged_billed: null,
  // The real fixture names all five helpers (three in the session file, two in a
  // nested result's text), so attribution is complete. An earlier copy of the
  // fixture had dropped those two result texts and this constant carried the
  // false INCOMPLETE it produced; the incomplete cases below say so explicitly.
  attribution_complete: true, missing_helper_ids: [], unreferenced_helper_files: [],
  dispatched_in_session_cost_usd: 0, dispatched_in_session_events: 0,
};

/** A helper file no Agent/Task result names: the shape an incomplete copy of a transcript tree produces. */
const UNREFERENCED = {
  attribution_complete: false, missing_helper_ids: [],
  unreferenced_helper_files: ["cf8e4f5c/subagents/agent-a2c641503e98ecc4c.jsonl", "cf8e4f5c/subagents/agent-a3e06ad488f47acef.jsonl"],
};

const run = (overhead, { markdown = false, dispatched = 0.1 } = {}) =>
  report({
    events: [event("tp_1", "codegen", dispatched), orchEvent(overhead.cost_usd)],
    manifest: { total_cost_usd: dispatched, orchestrator_overhead: overhead, true_total_cost_usd: dispatched + overhead.cost_usd },
    markdown,
  });

test("a booked receipt prints the cost per model and role, and what Claude Code billed but never logged", () => {
  const out = run(BOOKED);
  assert.match(out, /    By model: session \(claude-opus-5\): \$0\.4997 · helpers \(claude-opus-4-8\): \$13\.3688 \(price list verified 2026-09-14\)\.\n/);
  assert.match(out, /    Of the booked receipt, billed but not logged: \$0\.3293 \(2\.32%\) — claude-opus-4-8 \$0\.3293\.\n/);
  // $0.4997 + $13.3688 + $0.3293 = the booked $14.1978.
  assert.match(out, /Orchestrator overhead \(receipt tokens at the price list\)\s+\$14\.1978/);
  assert.match(out, /the run's own loop \(\$14\.1978, receipt tokens at the price list\) is a separate line in Costs/);
  assert.match(out, /The overhead line is the run's own loop: Claude Code's receipt token\n    counts, checked against the session transcripts and priced at the price\n    list by collect-orchestrator-usage\.mjs/);
  assert.doesNotMatch(out, /transcript-measured\)/, "a booked receipt is not a transcript measurement");
  assert.doesNotMatch(out, /floor: excludes calls/, "the booked receipt already includes the unlogged calls");
  assert.doesNotMatch(out, /Attribution incomplete|Unpriced|Custom price/);
});

test("a booked receipt's verification line names Claude Code's own figure as a check, never as the booked figure", () => {
  const out = run(BOOKED);
  assert.match(out, /    Verified against Claude Code's own receipt \(receipt \(Anthropic token counts priced at the price list\); 2\.3% billed but not logged\); Claude Code's own figure, \$14\.1978, is a check and never booked\.\n/);
  // Claude Code's table 10% above the list: the report says so beside its figure.
  const drift = run({ ...BOOKED, receipt_cli_usd: 15.617553, receipt_cost_usd: 15.617553 });
  assert.match(drift, /Claude Code's own figure, \$15\.6176, is a check and never booked \(10\.00% above the booked figure\)\./);
  const below = run({ ...BOOKED, receipt_cli_usd: 14.1, receipt_cost_usd: 14.1 });
  assert.match(below, /\$14\.1000, is a check and never booked \(0\.69% below the booked figure\)\./);
});

test("a transcript-priced figure prints the cost per model and says it is a floor, never the whole bill", () => {
  const out = run(TRANSCRIPT);
  assert.match(out, /    By model: session \(claude-fable-5-1\): \$4\.8012 · helpers \(claude-opus-5\): \$9\.1323 \(price list verified 2026-09-14\)\.\n/);
  assert.match(out, /    No receipt booked, so this is a floor: excludes calls Claude Code bills but does not log \(2\.3%–22% on measured runs\)\.\n/);
  assert.doesNotMatch(out, /billed but not logged:/);
  // Unchanged for a transcript figure: the verification line and the overhead label.
  assert.match(out, /UNVERIFIED — transcript \(no receipt; unverified\)/);
  assert.match(out, /Orchestrator overhead \(transcript-measured\)\s+\$13\.9334/);
});

test("attribution_complete false is a warning that says what it does and does not change", () => {
  // The real fixture is complete, so nothing is printed for it.
  assert.doesNotMatch(run(TRANSCRIPT), /Attribution incomplete/);
  const unreferenced = run({ ...TRANSCRIPT, ...UNREFERENCED });
  assert.match(
    unreferenced,
    /    Attribution incomplete: 2 helper file\(s\) named by no Agent\/Task result \(cf8e4f5c\/subagents\/agent-a2c641503e98ecc4c\.jsonl, cf8e4f5c\/subagents\/agent-a3e06ad488f47acef\.jsonl\); their tokens are counted, only the helper call they came from is unknown\.\n/,
  );
  const missingTranscript = run({ ...TRANSCRIPT, attribution_complete: false, missing_helper_ids: ["a2222"], unreferenced_helper_files: [] });
  assert.match(missingTranscript, /Attribution incomplete: helper\(s\) a2222 named by an Agent\/Task result have no transcript file; their tokens are in no figure above — copy the session's whole subagents\/ directory and re-run the collector\./);
  const missingBooked = run({ ...BOOKED, attribution_complete: false, missing_helper_ids: ["a2222"] });
  assert.match(missingBooked, /Attribution incomplete: helper\(s\) a2222 named by an Agent\/Task result have no transcript file; the booked total is unaffected, but their tokens sit in billed but not logged instead of By model\./);
  // Null (scan not pinned to a session) and true print nothing.
  assert.doesNotMatch(run({ ...TRANSCRIPT, attribution_complete: null, unreferenced_helper_files: [] }), /Attribution incomplete/);
});

test("entries of one model and role at different prices sum into one figure; a role with two models gets one figure each", () => {
  const out = run({
    ...TRANSCRIPT,
    attribution_complete: true, unreferenced_helper_files: [],
    per_model: [
      entry("helper", "claude-opus-5", 1.25),
      entry("session", "claude-sonnet-5", 2),
      entry("helper", "claude-haiku-4-5", 0.5),
      entry("helper", "claude-opus-5", 0.75, { applied_modifiers: { speed: "fast" } }),
    ],
  });
  assert.match(out, /By model: session \(claude-sonnet-5\): \$2\.0000 · helpers \(claude-opus-5\): \$2\.0000 · helpers \(claude-haiku-4-5\): \$0\.5000 \(price list verified 2026-09-14\)\./);
});

test("custom policy prices and unpriced tokens each get their own line", () => {
  const out = run({
    ...BOOKED,
    per_model: [entry("session", "claude-opus-5", 0.499714, { price_basis: "custom" }), entry("helper", "claude-opus-4-8", 13.368765)],
    unpriced: [{ model: "claude-mystery-9", role: "helper", reason: "not on the price list", messages: 2, tokens: { input: 1000, input_cached: 200, input_cache_write_5m: 30, input_cache_write_1h: 4, output: 10 } }],
    unlogged_billed: { ...BOOKED.unlogged_billed, unpriced: [{ model: "claude-opus-4-8", reported_as: ["claude-opus-4-8"], reason: "two prices across the window", tokens: { input: 1, input_cached: 2, input_cache_write: 3, output: 4 } }] },
    pricing_complete: false,
  });
  assert.match(out, /    Custom price, from the policy's pricing_override card and not the price list: session \(claude-opus-5\) \$0\.4997\.\n/);
  assert.match(out, /    Unpriced, so in no figure above: helpers \(claude-mystery-9\) 1,244 tokens on 2 message\(s\), not on the price list · billed but not logged \(claude-opus-4-8\) 10 tokens, two prices across the window\.\n/);
});

test("a receipt-only figure (no transcript message in the window) is booked from the receipt's token counts, all of it billed but not logged", () => {
  const out = run({
    ...BOOKED,
    cost_source: "receipt-only (Anthropic token counts priced at the price list)",
    transcript_cost_usd: null,
    per_model: [],
    unlogged_billed: { per_model: [{ model: "claude-opus-5", reported_as: ["claude-opus-5[1m]"], receipt_only: true, tokens: {}, cost_usd: 14.197776 }], unpriced: [], cost_usd: 14.197776, pct_of_booked: 100 },
  });
  assert.match(out, /    Booked from the receipt's token counts at the price list \(receipt-only \(Anthropic token counts priced at the price list\)\); no transcript message fell inside the window to cross-check it, and Claude Code's own figure, \$14\.1978, is a check and never booked\.\n/);
  assert.match(out, /Of the booked receipt, billed but not logged: \$14\.1978 \(100\.00%\) — claude-opus-5 \(receipt only\) \$14\.1978\./);
  assert.doesNotMatch(out, /By model:/, "no transcript message, so no per-model line");
  assert.doesNotMatch(out, /Booked from Claude Code's own receipt/, "the pre-v0.7.3 wording booked Claude Code's dollars");
});

test("a receipt-only model inside a booked receipt is marked, e.g. a Haiku side call the log never records (T6)", () => {
  const out = run({
    ...BOOKED,
    cost_usd: 0.184171, transcript_cost_usd: 0.183168, receipt_cli_usd: 0.1841705, receipt_cost_usd: 0.1841705,
    cost_source: "receipt (Anthropic token counts priced at the price list); 0.5% billed but not logged",
    per_model: [entry("session", "claude-opus-5", 0.106795), entry("helper", "claude-opus-4-8", 0.076373)],
    unlogged_billed: { per_model: [{ model: "claude-haiku-4-5", reported_as: ["claude-haiku-4-5-20251001"], receipt_only: true, tokens: { input: 928, input_cached: 0, input_cache_write: 0, output: 15 }, cost_usd: 0.001003 }], unpriced: [], cost_usd: 0.001003, pct_of_booked: 0.54 },
  });
  assert.match(out, /By model: session \(claude-opus-5\): \$0\.1068 · helpers \(claude-opus-4-8\): \$0\.0764/);
  assert.match(out, /Of the booked receipt, billed but not logged: \$0\.0010 \(0\.54%\) — claude-haiku-4-5 \(receipt only\) \$0\.0010\./);
});

test("the Markdown branch carries every new line", () => {
  const booked = run(BOOKED, { markdown: true });
  assert.match(booked, /\| Orchestrator overhead \(receipt tokens at the price list\) \| \$14\.1978 \|/);
  assert.match(booked, /_By model: session \(claude-opus-5\): \$0\.4997 · helpers \(claude-opus-4-8\): \$13\.3688 \(price list verified 2026-09-14\)\._/);
  assert.match(booked, /_Of the booked receipt, billed but not logged: \$0\.3293 \(2\.32%\) — claude-opus-4-8 \$0\.3293\._/);
  assert.match(booked, /The overhead line is the run's own loop: Claude Code's receipt token counts, checked against the session transcripts and priced at the price list by collect-orchestrator-usage\.mjs; only the true total compares architectures fairly\._/);
  const transcript = run(TRANSCRIPT, { markdown: true });
  assert.match(transcript, /_No receipt booked, so this is a floor: excludes calls Claude Code bills but does not log \(2\.3%–22% on measured runs\)\._/);
  assert.doesNotMatch(transcript, /Attribution incomplete/);
  const unreferenced = run({ ...TRANSCRIPT, ...UNREFERENCED }, { markdown: true });
  assert.match(unreferenced, /_Attribution incomplete: 2 helper file\(s\) named by no Agent\/Task result/);
});

// From v0.7.3 a dispatched dollar comes from the dated price list (or a
// pricing_override card), not the policy YAML, so "a pricing-YAML drift" is the
// wrong thing to tell a reader whose total differs from the dashboard. Only
// v0.7.3 dispatched events carry price_basis; older runs keep the old sentence,
// which was true when they ran (report-old-manifests.test.mjs pins those bytes).
test("the dashboard cross-check names the price list for a run whose dispatches carry price_basis, and keeps the old sentence otherwise", () => {
  const listPriced = report({ events: [event("tp_1", "codegen", 0.1, { price_basis: "list" })] });
  assert.match(listPriced, /a material divergence means a telemetry gap, a stale period on the dated price list \(plugin\/mcp\/model-dispatch\/src\/prices\.ts\), or a policy's pricing_override card\./);
  assert.doesNotMatch(listPriced, /pricing-YAML drift/);
  const older = report({ events: [event("tp_1", "codegen", 0.1)] });
  assert.match(older, /a material divergence means either a telemetry gap or a pricing-YAML drift\./);
});

test("telemetry-only overhead (manifest not yet patched) takes the new lines from the orchestrator event", () => {
  const { per_model, unpriced, unlogged_billed, attribution_complete, missing_helper_ids, unreferenced_helper_files, receipt_cli_usd, price_list_verified } = BOOKED;
  const out = report({
    events: [event("tp_1", "codegen", 0.1), orchEvent(14.197776, { per_model, unpriced, unlogged_billed, attribution_complete, missing_helper_ids, unreferenced_helper_files, receipt_cli_usd, price_list_verified })],
  });
  assert.match(out, /By model: session \(claude-opus-5\): \$0\.4997 · helpers \(claude-opus-4-8\): \$13\.3688/);
  assert.match(out, /Of the booked receipt, billed but not logged: \$0\.3293 \(2\.32%\)/);
});
