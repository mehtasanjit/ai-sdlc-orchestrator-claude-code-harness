/**
 * Guards the report's true-cost rendering — the reader-facing half of the
 * orchestrator-overhead fix. Quiet failures this pins against:
 *   - the collector's `tier: "orchestrator"` event lands in "Runner overhead"
 *     and silently blends the two spends (the exact bug class the collector
 *     exists to prevent);
 *   - a dispatched-only total renders without its scope caveat, and a reader
 *     compares architectures from a number that undercounts one door ~100×;
 *   - the report recomputes the true total instead of preferring the
 *     manifest's, and the two files disagree;
 *   - the Markdown branch drops any of the above.
 *
 * The report runs as a real subprocess against a fixture pass directory,
 * because what is being tested is what a person sees. $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");

/** One dispatched telemetry event, minimal fields the report reads. */
const event = (task_id, phase, cost, over = {}) => ({
  task_id,
  phase,
  model: "m",
  input_tokens: 1000,
  output_tokens: 500,
  cost_usd: cost,
  provenance: "vendor",
  success: true,
  ...over,
});

/** The collector's overhead event, as collect-orchestrator-usage.mjs writes it. */
const orchEvent = (cost, over = {}) => ({
  task_id: "orchestrator-overhead-p1",
  phase: "orchestrator_overhead",
  model: "driver",
  input_tokens: 100_000,
  input_tokens_cached: 900_000,
  input_tokens_cache_write: 300_000,
  output_tokens: 50_000,
  cost_usd: cost,
  provenance: "transcript",
  tier: "orchestrator",
  success: true,
  ...over,
});

/** Build a pass directory, run the report over it, return stdout. */
function report({ events, manifest = {}, receipts = [], markdown = false }) {
  const dir = mkdtempSync(join(tmpdir(), "report-truecost-"));
  try {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ policy_name: "p", started_at: "2026-08-31T09:00:00Z", ...manifest })
    );
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (receipts.length) {
      mkdirSync(join(dir, "delegation"), { recursive: true });
      for (const r of receipts) {
        writeFileSync(join(dir, "delegation", `worker-delegation-${r.task_id}.json`), JSON.stringify(r, null, 2));
      }
    }
    return execFileSync("node", markdown ? [REPORT, dir, "--markdown"] : [REPORT, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal delegation receipt (shape from buildDelegationRecord). */
const receipt = (task_id, phase) => ({
  schema: "delegation-record/1",
  task_id,
  phase,
  model_id: "flash-agsdk-worker",
  model_name: "gemini-3.5-flash",
  started_at: "2026-08-31T09:00:00.000Z",
  duration_ms: 90_000,
  success: true,
  cost_usd: 0.01,
  tokens: {},
  tool_calls: { count: 7, truncated: false, sample: [] },
  files: { added: [], modified: [], removed: [], unchanged: 9, scanned: 9, truncated: false, unreadable: [] },
});

test("before the collector runs, every total is labeled dispatched-only and the report says how to fix it", () => {
  const out = report({ events: [event("tp_1", "codegen", 0.1)] });
  assert.match(out, /Scope: dispatched work only — excludes orchestrator overhead/);
  assert.match(out, /— dispatched work only/);
  assert.match(out, /EXCLUDES ORCHESTRATOR OVERHEAD/);
  // The exact remediation — a reader can paste it.
  assert.match(out, /collect-orchestrator-usage\.mjs/);
  assert.doesNotMatch(out, /True total/);
});

test("the orchestrator event never blends into dispatched aggregations", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.1), event("tp_2", "planning", 0.02), orchEvent(3.7)],
    manifest: {
      total_cost_usd: 0.12,
      orchestrator_overhead: { cost_usd: 3.7, input_tokens: 100_000, input_tokens_cached: 900_000, input_tokens_cache_write: 300_000, output_tokens: 50_000, events: 1, provenance: "transcript" },
      true_total_cost_usd: 3.82,
    },
  });
  // Model calls counts dispatched events only (2, not 3) — the overhead
  // event is a reconstruction, not a call this run dispatched.
  assert.match(out, /Model calls\s+2\b/);
  // Runner overhead is the dispatched planning event alone; the $3.70 must
  // not be inside it (that bucket is where an unpartitioned event lands).
  assert.match(out, /Runner overhead\s+\$0\.0200/);
  // The overhead phase never appears as an SDLC/overhead table row.
  assert.doesNotMatch(out, /orchestrator_overhead\s+\S+\s+\d/);
});

test("with the collector's output present, Costs renders three labeled numbers and prefers the manifest's true total", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.1), orchEvent(3.7)],
    manifest: {
      total_cost_usd: 0.05,
      orchestrator_overhead: { cost_usd: 3.7, input_tokens: 100_000, input_tokens_cached: 900_000, input_tokens_cache_write: 300_000, output_tokens: 50_000, events: 1, provenance: "transcript" },
      // Deliberately NOT total + overhead of this fixture's events: the
      // manifest is the collector's authoritative figure and must win over
      // any recomputation.
      true_total_cost_usd: 9.99,
    },
  });
  assert.match(out, /Scope: dispatched work \+ orchestrator overhead/);
  assert.match(out, /— dispatched work only\s+\$0\.0500/);
  assert.match(out, /Orchestrator overhead \(transcript-measured\)\s+\$3\.7000/);
  assert.match(out, /True total \(dispatched \+ orchestrator\)\s+\$9\.9900/);
});

test("telemetry-only overhead (manifest not yet patched) still renders a true total from the events", () => {
  const out = report({ events: [event("tp_1", "codegen", 0.1), orchEvent(2)] });
  // sessionCost falls back to the dispatched sum (0.1); true total = 2.1.
  assert.match(out, /Orchestrator overhead \(transcript-measured\)\s+\$2\.0000/);
  assert.match(out, /True total \(dispatched \+ orchestrator\)\s+\$2\.1000/);
});

test("the delegation table warns hard against door comparisons until the collector has run, then softens", () => {
  const base = { events: [event("tp_1", "codegen", 0.1), event("tp_2", "codegen", 0.05)], receipts: [receipt("tp_2", "codegen")] };
  const before = report(base);
  assert.match(before, /Do not compare architectures/);
  const after = report({ ...base, events: [...base.events, orchEvent(2)] });
  assert.match(after, /only the true total there compares architectures fairly/);
  assert.doesNotMatch(after, /Do not compare architectures/);
});

test("the Markdown branch carries the same scope, three numbers, and warning", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.1), orchEvent(3.7)],
    manifest: {
      total_cost_usd: 0.05,
      orchestrator_overhead: { cost_usd: 3.7, input_tokens: 100_000, input_tokens_cached: 900_000, input_tokens_cache_write: 300_000, output_tokens: 50_000, events: 1, provenance: "transcript" },
      true_total_cost_usd: 3.75,
    },
    markdown: true,
  });
  assert.match(out, /\*\*Scope: dispatched work \+ orchestrator overhead\*\*/);
  assert.match(out, /\| Orchestrator overhead \(transcript-measured\) \| \$3\.7000 \|/);
  assert.match(out, /\*\*True total \(dispatched \+ orchestrator\)\*\* \| \*\*\$3\.7500\*\*/);
});

test("Markdown without the collector carries the dispatched-only caveat and the command", () => {
  const out = report({ events: [event("tp_1", "codegen", 0.1)], markdown: true });
  assert.match(out, /\*\*Scope: dispatched work only — excludes orchestrator overhead\*\*/);
  assert.match(out, /Excludes orchestrator overhead/);
  assert.match(out, /collect-orchestrator-usage\.mjs/);
});

test("tokens-in includes the cache-write bucket for column continuity", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.1, { input_tokens: 1000, input_tokens_cache_write: 500 })],
  });
  // 1000 fresh + 500 cache-write render as 1.5K in the tokens column —
  // cache writes are billed input, and older reports counted them here.
  assert.match(out, /codegen.*1\.5K \/ 500/);
});

// ── The verification line: one sentence per cost_source the collector writes ──
// The reader must be able to tell a receipt-verified figure from a provisional
// or partly verified one without opening the manifest, and a figure collected
// under the old 5%-tolerance rule must never read as verified.
const overheadWith = (cost_source, extra = {}) => ({
  cost_usd: 3.7, input_tokens: 100_000, input_tokens_cached: 900_000, input_tokens_cache_write: 300_000, output_tokens: 50_000, events: 1, provenance: "transcript",
  cost_source, receipt_cost_usd: 3.7, transcript_cost_usd: 3.62, ...extra,
});
const withSource = (cost_source, extra = {}, markdown = false) => report({
  events: [event("tp_1", "codegen", 0.1), orchEvent(3.7)],
  manifest: { total_cost_usd: 0.05, orchestrator_overhead: overheadWith(cost_source, extra), true_total_cost_usd: 3.75 },
  markdown,
});

test("a receipt-agreed figure reads as verified, and the measured window is printed with its anchors", () => {
  const window = { start: "2026-09-05T18:51:15.673Z", end: null, start_anchor: "command turn", end_anchor: "end of session", exact: true, session_id: "bf2c3ee0" };
  const out = withSource("receipt (transcript agrees, -2.2%)", { window });
  assert.match(out, /Verified against Claude Code's own receipt \(\$3\.7000; receipt \(transcript agrees, -2\.2%\)\)\./);
  assert.match(out, /Window 2026-09-05T18:51:15\.673Z → end of session \(exact: opens at command turn, closes at end of session; session bf2c3ee0\)\./);
  const md = withSource("receipt (transcript agrees, -2.2%)", { window }, true);
  assert.match(md, /_Verified against Claude Code's own receipt \(\$3\.7000; receipt \(transcript agrees, -2\.2%\)\)\._/);
  assert.match(md, /_Window 2026-09-05T18:51:15\.673Z → end of session \(exact: .*\)\._/);
});

test("an approximate window says so, and a receipt-only figure is booked, not called verified", () => {
  const window = { start: "2026-09-05T18:48:03.107Z", end: "2026-09-05T19:11:00.000Z", start_anchor: "run.start - 5m", end_anchor: "manifest ended_at + 5m", exact: false, session_id: null };
  const out = withSource("receipt-only", { window, transcript_cost_usd: null });
  assert.match(out, /Booked from Claude Code's own receipt \(\$3\.7000\); no transcript message fell inside the window to cross-check it\./);
  assert.match(out, /Window 2026-09-05T18:48:03\.107Z → 2026-09-05T19:11:00\.000Z \(approximate: opens at run\.start - 5m, closes at manifest ended_at \+ 5m\)\./);
  assert.doesNotMatch(out, /Verified against/);
});

test("a receipt that covered only the last --resume leg is PARTLY VERIFIED; pending and absent receipts are provisional and unverified", () => {
  const partly = withSource("transcript (receipt covers only the last invocation, verified +0.4%; 1 earlier invocation(s) unverified)", { receipt_cost_usd: 1.2 });
  assert.match(partly, /PARTLY VERIFIED — transcript \(receipt covers only the last invocation, verified \+0\.4%; 1 earlier invocation\(s\) unverified\); the receipt \(\$1\.2000\) bills only the last invocation/);
  // Q1 (v0.7.3): the collector now books the last invocation's receipt at the list. That
  // label starts with "receipt", so without its own branch it would read as fully verified.
  const booked = withSource(
    "receipt for the last invocation (Anthropic token counts priced at the price list); 19.9% of it billed but not logged; 1 earlier invocation(s) transcript-priced, unverified",
    { receipt_cost_usd: 2.07555, receipt_cli_usd: 2.07555, booked_cost_usd: 2.07555, cost_usd: 2.4256, unlogged_billed: { per_model: [], unpriced: [], cost_usd: 0.41265, pct_of_booked: 19.88 } },
  );
  // v0.7.3 review fix: Claude Code's figure is the booked invocation's bill, so it is checked
  // against that invocation's list figure (booked_cost_usd, $2.07555), not the whole window's
  // $2.4256. The whole window used to print "14.43% below the booked figure" here, a
  // difference of span that reads as a stale price table.
  assert.doesNotMatch(booked, /% (above|below) the booked figure/);
  const drifted = withSource(
    "receipt for the last invocation (Anthropic token counts priced at the price list); 19.9% of it billed but not logged; 1 earlier invocation(s) transcript-priced, unverified",
    { receipt_cost_usd: 2.28, receipt_cli_usd: 2.28, booked_cost_usd: 2.07555, cost_usd: 2.4256, unlogged_billed: { per_model: [], unpriced: [], cost_usd: 0.41265, pct_of_booked: 19.88 } },
  );
  // A real drift is still named, measured against the booked invocation: (2.28 - 2.07555) / 2.07555.
  assert.match(drifted, /Claude Code's own figure, \$2\.2800, is a check and never booked \(9\.85% above the booked figure\)/);
  assert.match(booked, /PARTLY VERIFIED — receipt for the last invocation \(Anthropic token counts priced at the price list\); 19\.9% of it billed but not logged; 1 earlier invocation\(s\) transcript-priced, unverified; the receipt's token counts are booked for the last invocation only, the earlier ones are transcript-priced/);
  assert.doesNotMatch(booked, /Verified against/);
  assert.match(booked, /last invocation's receipt tokens at the price list, earlier invocations transcript-measured/);
  const pending = withSource("transcript (receipt pending; provisional; approximate window)", { receipt_cost_usd: null });
  assert.match(pending, /PROVISIONAL — transcript \(receipt pending; provisional; approximate window\); the headless capture has no result line yet/);
  const none = withSource("transcript (no receipt; unverified)", { receipt_cost_usd: null });
  assert.match(none, /UNVERIFIED — transcript \(no receipt; unverified\); no receipt was found beside the manifest/);
  assert.doesNotMatch(none, /Window /); // no window block on this manifest → no window line
});

test("a manifest written by the collector before the exact rule is named as such, never as verified", () => {
  const old = withSource("transcript (receipt-verified, -2.2%)");
  assert.match(old, /COLLECTED UNDER THE OLD RULE — transcript \(receipt-verified, -2\.2%\); that check allowed a 5% shortfall and any excess, re-run the collector to verify exactly\./);
  assert.doesNotMatch(old, /Verified against/);
  const bare = withSource("transcript", { receipt_cost_usd: null });
  assert.match(bare, /COLLECTED UNDER THE OLD RULE — transcript;/);
});
