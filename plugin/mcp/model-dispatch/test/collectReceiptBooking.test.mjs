/**
 * Fix D: the receipt rule, with no percentage.
 *
 * A receipt (`claude -p` result) is Anthropic's count for ONE invocation, and
 * it includes calls Claude Code bills but never writes to a transcript. The
 * collector used to require every token bucket in the window to EQUAL the
 * receipt, so a good headless run was refused whenever Claude Code billed a
 * call it did not log (Sep 10 2026: two Opus 4.8 calls, 2.3% of the bill), and
 * when it did book a receipt it booked Claude Code's own dollars, whose price
 * table was stale on Aug 24 2026. It also compared model names verbatim, so a
 * receipt's `claude-opus-5[1m]` never matched the log's `claude-opus-5`.
 *
 * The rule now:
 *   1. a receipt for another session: exit 3 (unchanged);
 *   2. names on both sides are read with the price list's resolveModel (and,
 *      from Q2, a model_name the run's policy declares under
 *      pricing_override: true, exactly or with one [option]) and compared per
 *      model; a name that does not resolve is exit 3; a log
 *      bucket above the receipt, or a log model the receipt does not bill, takes
 *      the ABOVE path: with a second human turn in the window, the last
 *      invocation alone by rules 3 and 4 (Q1: booked for that invocation, the
 *      earlier ones transcript-priced), else exit 3;
 *   3. log at or below the receipt on every bucket: the receipt is booked, as
 *      its token counts priced from the list: the logged part per message, the
 *      gap (receipt minus log, per bucket) at that model's logged cache-write
 *      TTL mix and modifier mix. `unlogged_billed` records the gap per model,
 *      and `attribution_complete` says whether every helper an Agent/Task
 *      result names has its transcript file. When some bucket is BELOW the
 *      receipt, booking also needs the window to be provably the receipt's
 *      invocation (pinned to the receipt's session, opened at the command turn,
 *      no later human turn, exact); a log EQUAL to the receipt proves that on
 *      its own, exactly as before;
 *   4. below the receipt without that proof: exit 3.
 *
 * Fixtures (token-only copies of real headless runs, see their READMEs):
 *   T5 tools/test/fixtures/headless-unlogged-calls (CLI 2.1.245)
 *   T6 tools/test/fixtures/headless-side-call      (CLI 2.1.270)
 *
 * RE-DERIVED EXPECTATIONS (existing tests whose outcome or figures moved, and why)
 *
 * receivables-ops (tools/test/fixtures/receivables-ops; no human turns kept, so no
 * command turn and every window approximate):
 *   - pass1: every bucket ABOVE the receipt. ABOVE path unchanged: exit 3.
 *   - pass2: still exit 3, by a different path. Its cache buckets are far BELOW
 *     the receipt (cached 2,503,877 < 4,002,221; cache_write 70,808 < 263,021;
 *     transcript -44.7%, a subagent file missing), but its input is ABOVE it
 *     (78 > 56): the window also holds messages this receipt never billed.
 *     ABOVE is decided first, and with no human turns there is no last
 *     invocation to check, so it refuses as ABOVE. The old exact rule reported
 *     the shortfall first ("BELOW the CLI's own receipt"). Without the input
 *     excess it would still refuse: its window opens at the first dispatch and
 *     is not pinned to the receipt's session, so it cannot be proven.
 *   - pass3: every bucket EQUAL. Still booked. The booked figure is now the
 *     receipt's tokens at the list, $16.235409, which equals Claude Code's own
 *     figure to the micro-dollar (its top-level usage matches the model's counts
 *     exactly, so the 1-hour write split is the receipt's own). The label changes
 *     from "receipt (transcript agrees, +0.0%)" to "receipt (Anthropic token
 *     counts priced at the price list); 0.0% billed but not logged". True total
 *     unchanged ($22.311708).
 *   - pass3 plus a synthetic Haiku line on the receipt ($0.01 for 10 in / 100
 *     out): booked $16.235919, not $16.245409. Haiku is priced from the list
 *     ($0.00051) instead of taking Claude Code's dollars.
 *   - pass3 receipt-only (no transcript in the window): $16.235409, unchanged in
 *     dollars, label "receipt-only (Anthropic token counts priced at the price
 *     list)"; the old "its $16.235409 is used verbatim" NOTE is gone.
 *   - pass2 receipt-only: $4.703347, was Claude Code's $4.766478. That receipt's
 *     top-level usage is a per-turn snapshot that matches no model's counts, so
 *     no cache-write split can be attributed to a model: its 263,021 writes are
 *     priced at the 5-minute rate and flagged, and the drift NOTE says Claude
 *     Code's figure is 1.3% higher. The Gemini vendor spend still survives.
 *
 * collectOrchestratorUsage.test.mjs, synthetic runs whose logs EQUAL their
 * receipts: the booked dollars are unchanged ($30, $10), the label is the new
 * one. Two figures move:
 *   - a Haiku receipt line never logged ($0.02 for 200 in / 50 out): booked
 *     $30.00045, not $30.02 (Haiku at the list, $0.00045);
 *   - rate drift (a receipt claiming $33 for tokens that cost $30 at the run's
 *     pricing_override card): booked $30, not $33, with a NOTE naming the 10%
 *     difference; Claude Code's own dollars are never booked.
 *   - SHORT with an exact window but a receipt naming no session: still exit 3,
 *     now because the invocation cannot be proven (the receipt names no session).
 * collectPerModelPricing.test.mjs pass3 regression: label only.
 * The manifest's first-test deepEqual gains the new fields (null / [] when no
 * receipt is booked and no session is pinned).
 *
 * Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pricesMod from "../dist/prices.js";
import * as effectiveMod from "../dist/effectivePrice.js";
import * as pricingMod from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const REPO = join(HERE, "..", "..", "..", "..");
const UNLOGGED = join(REPO, "tools", "test", "fixtures", "headless-unlogged-calls");
const SIDE_CALL = join(REPO, "tools", "test", "fixtures", "headless-side-call");
const ENV = { ...process.env, MMO_SELECT: "" };
const helpers = () => import(pathToFileURL(SCRIPT).href);

const exec = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: ENV });
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const readLines = (p) => readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

// ── T5: the Sep 10 headless run the exact rule refused ─────────────────────

test("T5: the Sep 10 headless run is booked at $14.197777 — receipt tokens at the list, 2.3% billed but not logged, all four helpers attributed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t5-"));
  try {
    cpSync(UNLOGGED, root, { recursive: true });
    const r = exec([join(root, "pass1"), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The receipt's claude-opus-5[1m] is the log's claude-opus-5 once names are resolved.
    assert.match(r.stdout, /receipt names resolved: claude-opus-5\[1m\] → claude-opus-5/);
    assert.match(r.stdout, /claude-opus-5: in 20=20 · cached 327898=327898 · cache_write 20329=20329 · out 5295≤5295 → agrees/);
    assert.match(r.stdout, /claude-opus-4-8: in 224<228 · cached 12247927<12651407 · cache_write 404585<423523 · out 188601≤188968 → short of the receipt/);
    assert.match(r.stdout, /= \$14\.19777[67] \[receipt \(Anthropic token counts priced at the price list\); 2\.3% billed but not logged\]/);
    // Claude Code's own table agrees with the list on this run: no drift note.
    assert.doesNotMatch(r.stderr, /price table differs/);

    const m = readJson(join(root, "pass1", "manifest.json"));
    const o = m.orchestrator_overhead;
    near(o.cost_usd, 14.197777, 0.000002, "booked");
    assert.equal(o.transcript_cost_usd, 13.868479, "the logged part, priced per message");
    near(o.receipt_cli_usd, 14.19777625, 1e-9, "Claude Code's own figure, kept as a check");
    // v0.7.3 review fix: the booked part's list figure, the one receipt_cli_usd is checked against; the whole window here.
    assert.equal(o.booked_cost_usd, o.cost_usd);
    assert.equal(o.receipt_cost_usd, o.receipt_cli_usd, "receipt_cost_usd keeps its meaning");
    assert.deepEqual(o.per_model.map((e) => [e.role, e.model, e.cost_usd]), [["session", "claude-opus-5", 0.499714], ["helper", "claude-opus-4-8", 13.368765]]);

    const u = o.unlogged_billed;
    assert.equal(u.per_model.length, 1);
    const g = u.per_model[0];
    assert.deepEqual([g.model, g.reported_as, g.receipt_only, g.ttl_split], ["claude-opus-4-8", ["claude-opus-4-8"], false, "logged mix"]);
    assert.deepEqual(g.tokens, { input: 4, input_cached: 403_480, input_cache_write: 18_938, output: 367 });
    // 4 x $5 + 403,480 x $0.50 + 18,938 x $6.25 (all logged writes were 5-minute) + 367 x $25, per 1M.
    near(g.cost_usd, 0.3292975, 0.000001, "unlogged Opus 4.8");
    near(u.cost_usd, 0.3292975, 0.000001, "unlogged total");
    assert.ok(u.pct_of_booked > 2.3 && u.pct_of_booked < 2.35, `pct_of_booked ${u.pct_of_booked}`);
    assert.deepEqual(u.unpriced, []);
    near(o.cost_usd, round6(o.transcript_cost_usd + u.cost_usd), 0.000001, "booked = logged + unlogged");

    assert.equal(o.attribution_complete, true);
    assert.deepEqual(o.missing_helper_ids, []);
    assert.deepEqual(o.unreferenced_helper_files, []);
    assert.equal(o.pricing_complete, true);
    // Token fields are the receipt's; the 1-hour share is the session's logged 20,329 (no 1-hour gap).
    assert.deepEqual([o.input_tokens, o.input_tokens_cached, o.input_tokens_cache_write, o.input_tokens_cache_write_1h, o.output_tokens], [248, 12_979_305, 443_852, 20_329, 194_263]);
    assert.deepEqual([o.window.start_anchor, o.window.exact, o.window.lower_bound, o.window.session_id], ["command turn", true, false, "908511af-6158-466f-92ad-beb1cd9f5c73"]);

    // True total: the Gemini vendor calls plus the booked receipt; the estimated Opus events ran inside the session.
    const gemini = readLines(join(root, "pass1", "telemetry.jsonl")).filter((e) => e.provenance === "vendor").reduce((s, e) => s + e.cost_usd, 0);
    near(m.true_total_cost_usd, gemini + o.cost_usd, 0.000003, "true total");
    const event = readLines(join(root, "pass1", "telemetry.jsonl")).find((e) => e.tier === "orchestrator");
    assert.deepEqual(event.unlogged_billed, u);
    assert.equal(event.attribution_complete, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ── T6: [1m] and a Haiku side call on a 2.1.270 receipt ────────────────────

test("T6: a receipt naming claude-opus-5[1m] and a Haiku side call the log never records is booked; Haiku is priced from the list inside unlogged_billed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t6-"));
  try {
    cpSync(SIDE_CALL, root, { recursive: true });
    const r = exec([root, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-haiku-4-5-20251001 → claude-haiku-4-5/);
    assert.match(r.stdout, /claude-opus-5\[1m\] → claude-opus-5/);
    assert.match(r.stdout, /claude-opus-5: in 34=34 · cached 28810=28810 · cache_write 8837=8837 · out 154≤154 → agrees/);
    assert.match(r.stdout, /claude-opus-4-8: in 2=2 · cached 0=0 · cache_write 12202=12202 · out 4≤4 → agrees/);
    assert.match(r.stderr, /NOTE: the receipt also bills claude-haiku-4-5 \(943 tokens, \$0\.001003\) for calls the transcript does not record/);
    assert.match(r.stdout, /= \$0\.184171 \[receipt \(Anthropic token counts priced at the price list\); 0\.5% billed but not logged\]/);

    const o = readJson(join(root, "manifest.json")).orchestrator_overhead;
    assert.equal(o.cost_usd, 0.184171);
    assert.equal(o.transcript_cost_usd, 0.183168);
    near(o.receipt_cli_usd, 0.1841705, 1e-9, "Claude Code's own figure");
    const u = o.unlogged_billed;
    assert.equal(u.per_model.length, 1, JSON.stringify(u.per_model));
    const haiku = u.per_model[0];
    assert.deepEqual([haiku.model, haiku.reported_as, haiku.receipt_only, haiku.ttl_split], ["claude-haiku-4-5", ["claude-haiku-4-5-20251001"], true, "none"]);
    assert.deepEqual(haiku.tokens, { input: 928, input_cached: 0, input_cache_write: 0, output: 15 });
    assert.deepEqual(haiku.rates, { input: 1, input_cached: 0.1, input_cache_write: 1.25, output: 5 });
    assert.equal(haiku.cost_usd, 0.001003); // 928 x $1 + 15 x $5, per 1M
    assert.match(haiku.assumed.join(" | "), /no logged message/);
    assert.equal(o.attribution_complete, true);
    assert.deepEqual([o.input_tokens, o.input_tokens_cached, o.input_tokens_cache_write, o.input_tokens_cache_write_1h, o.output_tokens], [964, 28_810, 21_039, 8_837, 173]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T7: the rule on a small headless-shaped run ─────────────────────────────

const AT = (hms) => `2026-09-10T${hms}.000Z`;
const usage = (input, cached, write5m, write1h, output) => ({
  input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  output_tokens: output, service_tier: "standard", speed: "standard", inference_geo: "not_available",
});
const asst = (sid, id, model, u, ts, content) => JSON.stringify({ type: "assistant", timestamp: ts, sessionId: sid, message: { id, model, stop_reason: content ? "tool_use" : "end_turn", usage: u, ...(content ? { content } : {}) } });
const human = (sid, ts, text) => JSON.stringify({ type: "user", timestamp: ts, sessionId: sid, message: { role: "user", content: text } });
const COMMAND = "<command-message>mmo:pass</command-message>\n<command-name>/mmo:pass</command-name>\n<command-args>--run-id=r-h brief.md</command-args>";

/**
 * Session sess-h on Opus 5 spawns two Opus 4.8 helpers: a1111 (named by the
 * result line's toolUseResult) and a2222 (named only in the result text, the
 * shape a nested orchestrator writes). Log: Opus 5 in 10 / cached 200,000 / 1h
 * writes 20,000 / out 2,000 ($0.35005); Opus 4.8 in 70 / 700,000 / 5m 70,000 /
 * 7,000 ($0.96285). The receipt bills Opus 5 exactly and Opus 4.8 at
 * 100 / 1,000,000 / 100,000 / 10,000: the log is 30% short on every bucket.
 * Receipt at the list: $0.35005 + $1.3755 = $1.72555, of which $0.41265 unlogged.
 */
function headlessRun({ commandTurn = true, runLog = true, helperA2 = true, extraLines = [], receipt = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t7-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts");
  const sub = join(tDir, "sess-h", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: h-policy\nmodels:\n  - id: driver\n    adapter: builtin-anthropic\n    model_name: claude-opus-4-8\nrules:\n  - default: driver\n");
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "r-h", policy_name: "h-policy", started_at: AT("10:00:20"), ended_at: AT("10:01:20"), totals: { dispatched_cost_usd: 0, models_used: [] } }));
  writeFileSync(join(passDir, "telemetry.jsonl"), "");
  if (runLog) {
    mkdirSync(join(root, ".sdlc", "runs", "r-h"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "runs", "r-h", "orchestrator.log"), `MMO: ${AT("10:00:05")} INFO   run.start run_id=r-h mode=greenfield\nMMO: ${AT("10:01:30")} INFO   run.end run_id=r-h outcome=completed\n`);
  }
  const session = [
    ...(commandTurn ? [human("sess-h", AT("10:00:00"), COMMAND)] : []),
    asst("sess-h", "s1", "claude-opus-5", usage(10, 100_000, 0, 10_000, 1_000), AT("10:00:10"), [{ type: "tool_use", id: "toolu_1", name: "Agent" }, { type: "tool_use", id: "toolu_2", name: "Agent" }]),
    JSON.stringify({ type: "user", timestamp: AT("10:01:00"), sessionId: "sess-h", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] }, toolUseResult: { agentId: "a1111" } }),
    JSON.stringify({ type: "user", timestamp: AT("10:01:05"), sessionId: "sess-h", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "done\nagentId: a2222 (use SendMessage with to: 'a2222', summary: '<5-10 word recap>' to continue this agent)" }] }] } }),
    ...extraLines,
    asst("sess-h", "s2", "claude-opus-5", usage(0, 100_000, 0, 10_000, 1_000), AT("10:01:10")),
  ];
  writeFileSync(join(tDir, "sess-h.jsonl"), session.join("\n") + "\n");
  writeFileSync(join(sub, "agent-a1111.jsonl"), asst("sess-h", "h1", "claude-opus-4-8", usage(40, 400_000, 40_000, 0, 4_000), AT("10:00:30")) + "\n");
  if (helperA2) writeFileSync(join(sub, "agent-a2222.jsonl"), asst("sess-h", "h2", "claude-opus-4-8", usage(30, 300_000, 30_000, 0, 3_000), AT("10:00:40")) + "\n");
  const opus48 = { inputTokens: 100, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 100_000, outputTokens: 10_000, costUSD: 1.3755, ...(receipt.opus48 ?? {}) };
  writeFileSync(join(passDir, "claude-session.json"), JSON.stringify({
    type: "result",
    session_id: receipt.session_id ?? "sess-h",
    total_cost_usd: 1.72555,
    usage: { input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 20_000, output_tokens: 2_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 } },
    modelUsage: {
      "claude-opus-5[1m]": { inputTokens: 10, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 20_000, outputTokens: 2_000, costUSD: 0.35005 },
      [receipt.opus48Name ?? "claude-opus-4-8"]: opus48,
    },
  }));
  const run = () => exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir]);
  return { root, passDir, run, manifest: () => readJson(join(passDir, "manifest.json")), rm: () => rmSync(root, { recursive: true, force: true }) };
}

test("T7: an exact window with a log 30% short of the receipt is booked — there is no percentage", () => {
  const fix = headlessRun();
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-opus-4-8: in 70<100 · cached 700000<1000000 · cache_write 70000<100000 · out 7000≤10000 → short of the receipt/);
    assert.match(r.stdout, /= \$1\.72555 \[receipt \(Anthropic token counts priced at the price list\); 23\.9% billed but not logged\]/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 1.72555);
    assert.equal(o.transcript_cost_usd, 1.3129);
    assert.equal(o.unlogged_billed.cost_usd, 0.41265);
    assert.deepEqual(o.unlogged_billed.per_model.map((g) => [g.model, g.tokens]), [["claude-opus-4-8", { input: 30, input_cached: 300_000, input_cache_write: 30_000, output: 3_000 }]]);
    assert.equal(o.unlogged_billed.pct_of_booked, 23.91);
    assert.equal(o.attribution_complete, true);
  } finally { fix.rm(); }
});

test("T7: a helper transcript that is missing is still booked (the receipt is the bill) with attribution_complete false and the helper named", () => {
  const fix = headlessRun({ helperA2: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /helper a2222 .*has no transcript file/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 1.72555, "the total is the receipt's either way");
    assert.equal(o.unlogged_billed.cost_usd, 0.8253, "the unread helper's tokens are inside the gap");
    assert.equal(o.attribution_complete, false);
    assert.deepEqual(o.missing_helper_ids, ["a2222"]);
    assert.deepEqual(o.unreferenced_helper_files, []);
  } finally { fix.rm(); }
});

test("T7 refusal: a log bucket ABOVE the receipt is exit 3, nothing written", () => {
  const fix = headlessRun({ receipt: { opus48: { cacheReadInputTokens: 600_000 } } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the window holds messages the receipt never billed \(claude-opus-4-8 input_cached: transcript 700000 > receipt 600000\)/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined);
  } finally { fix.rm(); }
});

test("T7 refusal: a receipt for a different session is exit 3", () => {
  const fix = headlessRun({ receipt: { session_id: "sess-other" } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /is for session sess-other, but the run's command turn/);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with an approximate window (no command turn) is exit 3, and says why the invocation cannot be proven", () => {
  const fix = headlessRun({ commandTurn: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /BELOW the CLI's own receipt/);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*the window opens at run\.start - 5m, not at the run's command turn/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with a lower-bound window (no command turn, no run log) is exit 3", () => {
  const fix = headlessRun({ commandTurn: false, runLog: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*the window opens at the first dispatch \(a lower bound\)/);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with a second human turn inside the window is exit 3 (the receipt may bill only the last invocation)", () => {
  const fix = headlessRun({ extraLines: [human("sess-h", AT("10:01:07"), "keep going")] });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*2 human turns fall inside the window/);
  } finally { fix.rm(); }
});

test("T7 refusal: a receipt model name the price list cannot read is exit 3, printing both name lists", () => {
  const fix = headlessRun({ receipt: { opus48Name: "claude-opus-9-9" } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot resolve model name\(s\) the price list does not carry: receipt claude-opus-9-9/);
    assert.match(r.stderr, /transcript names: claude-opus-4-8, claude-opus-5/);
    assert.match(r.stderr, /receipt names: claude-opus-5\[1m\], claude-opus-9-9/);
  } finally { fix.rm(); }
});

// ── Unit pins on the exported helpers ───────────────────────────────────────

test("resolveBucketNames: names resolve to price-list ids and their buckets merge; unresolvable names are listed per side", async () => {
  const { resolveBucketNames } = await helpers();
  const T = (input, input_cached, input_cache_write, input_cache_write_1h, output) => ({ input, input_cached, input_cache_write, input_cache_write_1h, output });
  const R = (input, input_cached, input_cache_write, output, cost_usd) => ({ input, input_cached, input_cache_write, output, cost_usd });
  const r = resolveBucketNames(
    { "claude-opus-5": T(1, 2, 3, 3, 4), "(unlabeled)": T(1, 0, 0, 0, 1), "claude-mystery-1": T(1, 0, 0, 0, 0) },
    { "claude-opus-5[1m]": R(1, 2, 3, 4, 0.1), "claude-haiku-4-5-20251001": R(5, 0, 0, 1, 0.01), "claude-haiku-4-5": R(1, 0, 0, 1, 0.002), "gpt-x": R(1, 0, 0, 0, null) },
    pricesMod.resolveModel,
  );
  assert.deepEqual(r.unresolved, { transcript: ["claude-mystery-1"], receipt: ["gpt-x"] });
  assert.deepEqual(r.receipt["claude-haiku-4-5"], { input: 6, input_cached: 0, input_cache_write: 0, output: 2, cost_usd: 0.012, names: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"] });
  assert.deepEqual(r.receipt["claude-opus-5"].names, ["claude-opus-5[1m]"]);
  assert.deepEqual(r.transcript["claude-opus-5"], { ...T(1, 2, 3, 3, 4), names: ["claude-opus-5"] });
  // A message with no model name can match nothing; it stays under its own key for the ABOVE rule.
  assert.ok(r.transcript["(unlabeled)"]);
});

test("helperAttribution: ids come from Agent/Task results only (toolUseResult.agentId or the result text), at any depth; missing and unreferenced files are named", async () => {
  const { helperAttribution, sessionHelperFiles } = await helpers();
  const dir = mkdtempSync(join(tmpdir(), "mmo-attrib-"));
  try {
    const sub = join(dir, "sess", "subagents");
    mkdirSync(join(sub, "workflows", "wf1"), { recursive: true });
    const tu = (id, name) => ({ type: "tool_use", id, name });
    writeFileSync(join(dir, "sess.jsonl"), [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [tu("t1", "Agent"), tu("b1", "Bash")] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] }, toolUseResult: { agentId: "a1" } }),
      // A Bash result that happens to print "agentId:" names no helper.
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "agentId: zzz" }] }, toolUseResult: { stdout: "agentId: zzz" } }),
    ].join("\n") + "\n");
    writeFileSync(join(sub, "agent-a1.jsonl"), [
      JSON.stringify({ type: "assistant", message: { id: "m2", content: [tu("t2", "Task"), tu("t4", "Agent")] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok\nagentId: a2 (use SendMessage with to: 'a2')" }] }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "agentId: a4" }] } }),
    ].join("\n") + "\n");
    writeFileSync(join(sub, "workflows", "wf1", "agent-a4.jsonl"), "\n");
    writeFileSync(join(sub, "agent-a3.jsonl"), "\n");
    writeFileSync(join(sub, "agent-a1.meta.json"), "{}\n");

    const files = sessionHelperFiles(dir, "sess");
    assert.deepEqual(files.map((f) => f.slice(dir.length + 1)), ["sess/subagents/agent-a1.jsonl", "sess/subagents/agent-a3.jsonl", "sess/subagents/workflows/wf1/agent-a4.jsonl"]);
    const a = helperAttribution(join(dir, "sess.jsonl"), files, { root: dir });
    assert.deepEqual(a, {
      complete: false,
      referenced: ["a1", "a2", "a4"],
      missing_helper_ids: ["a2"],
      unreferenced_helper_files: ["sess/subagents/agent-a3.jsonl"],
    });
    assert.deepEqual(sessionHelperFiles(dir, "no-such-session"), []);
    assert.equal(helperAttribution(join(dir, "sess.jsonl"), files.filter((f) => !f.endsWith("agent-a3.jsonl")).concat([]), { root: dir }).complete, false, "a2 is still missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bookReceiptTokens: the gap is priced at the model's logged TTL and modifier mix; a receipt-only model at API defaults, 5-minute writes flagged unless the receipt's own usage proves the split", async () => {
  const { resolveBucketNames, bookReceiptTokens, priceMessages, makeMessagePricer } = await helpers();
  const pricer = makeMessagePricer({ models: [] }, { pricesMod, effectiveMod, pricingMod });
  const ts = "2026-09-10T10:00:00.000Z";
  const msg = (speed, w5m, w1h) => ({ model: "claude-opus-4-8", role: "helper", timestamp: ts, modifiers: { speed, service_tier: "standard", inference_geo: "not_available" }, conflicts: [], tokens: { input: 1000, input_cached: 0, input_cache_write_5m: w5m, input_cache_write_1h: w1h, output: 1000 } });
  // Logged: one standard message with 5-minute writes ($0.655), one fast message with 1-hour writes ($2.06).
  const priced = priceMessages([msg("standard", 100_000, 0), msg("fast", 0, 100_000)], pricer);
  assert.equal(priced.cost_usd, 2.715);
  const receiptModels = {
    "claude-opus-4-8": { input: 4000, input_cached: 0, input_cache_write: 400_000, output: 4000, cost_usd: 5.43 },
    "claude-haiku-4-5-20251001": { input: 1000, input_cached: 0, input_cache_write: 8000, output: 100, cost_usd: 0.0175 },
  };
  const { receipt } = resolveBucketNames({}, receiptModels, pricesMod.resolveModel);
  const book = (receiptUsage, referenceTimes = [ts, ts]) => bookReceiptTokens({ receipt, priced, pricer, referenceTimes, receiptUsage });

  const b = book(null);
  const opus = b.unlogged_billed.per_model.find((g) => g.model === "claude-opus-4-8");
  // Gap: 2,000 in at (5+10)/2 = $7.50; 200,000 writes at (6.25+20)/2 = $13.125; 2,000 out at (25+50)/2 = $37.50.
  // No logged cache reads, so that bucket has no mix: its rate is the list's at API defaults ($0.50), and no
  // assumption is flagged because the gap holds no cache reads to price with it.
  assert.deepEqual(opus.tokens, { input: 2000, input_cached: 0, input_cache_write: 200_000, output: 2000 });
  assert.deepEqual(opus.rates, { input: 7.5, input_cached: 0.5, input_cache_write: 13.125, output: 37.5 });
  assert.deepEqual(opus.assumed, []);
  assert.equal(opus.ttl_split, "logged mix");
  assert.equal(opus.cost_usd, 2.715);
  const haiku = b.unlogged_billed.per_model.find((g) => g.model === "claude-haiku-4-5");
  assert.equal(haiku.receipt_only, true);
  assert.equal(haiku.ttl_split, "5-minute (assumed)");
  assert.equal(haiku.cost_usd, 0.0115); // 1000 x $1 + 8,000 x $1.25 + 100 x $5
  assert.match(haiku.assumed.join(" | "), /no logged message: API-default speed, service_tier and inference_geo/);
  assert.match(haiku.assumed.join(" | "), /5-minute/);
  assert.equal(b.cost_usd, round6(2.715 + 2.715 + 0.0115));
  assert.equal(b.logged_cost_usd, 2.715);
  // The 1-hour token share: logged 100,000 plus half of the Opus gap's 200,000 writes; Haiku's writes counted 5-minute.
  assert.deepEqual(b.tokens, { input: 5000, input_cached: 0, input_cache_write: 408_000, input_cache_write_5m: 208_000, input_cache_write_1h: 200_000, output: 4100 });
  assert.equal(b.complete, true);

  // The receipt's top-level usage equals Haiku's four counts exactly, so its split is Haiku's own.
  const proven = book({ input: 1000, input_cached: 0, input_cache_write: 8000, output: 100, cache_write_5m: 0, cache_write_1h: 8000 });
  const h2 = proven.unlogged_billed.per_model.find((g) => g.model === "claude-haiku-4-5");
  assert.equal(h2.ttl_split, "receipt usage");
  assert.equal(h2.cost_usd, 0.0175); // 1000 x $1 + 8,000 x $2 + 100 x $5
  assert.doesNotMatch(h2.assumed.join(" | "), /5-minute/);

  // A receipt-only model on a day the list does not price is unpriced, never borrowed.
  const early = book(null, ["2025-12-31T23:00:00.000Z", ts]);
  assert.equal(early.complete, false);
  assert.match(early.unlogged_billed.unpriced.find((x) => x.model === "claude-haiku-4-5").reason, /no price period for claude-haiku-4-5 on 2025-12-31/);
  assert.equal(early.unlogged_billed.per_model.some((g) => g.model === "claude-haiku-4-5"), false);
});

// ── M3: web searches are billed per search, on top of tokens ────────────────

/**
 * Review finding M3. A receipt counts server-side web searches per model
 * (modelUsage[*].webSearchRequests) and a transcript message counts them in
 * usage.server_tool_use.web_search_requests; Anthropic bills $10 per 1,000 on
 * top of tokens (price page, verified 2026-09-14). The collector read only the
 * four token counts, so a booked receipt left the fee out and still said
 * pricing_complete true, where the pre-v0.7.3 collector had booked Claude
 * Code's total, fee included.
 *
 * The T6 fixture, with the receipt saying the Opus 5 session searched 3 times
 * and the Haiku side call twice, and the session's first message recording 2
 * searches on each of its lines (counted once per message).
 */
test("M3: a booked receipt bills $0.01 per web search: the logged searches in the per-message figure, the rest in unlogged_billed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-websearch-"));
  try {
    cpSync(SIDE_CALL, root, { recursive: true });
    const receiptPath = join(root, "claude-session.json");
    const rec = readJson(receiptPath);
    rec.modelUsage["claude-opus-5[1m]"].webSearchRequests = 3;
    rec.modelUsage["claude-opus-5[1m]"].costUSD += 0.03;
    rec.modelUsage["claude-haiku-4-5-20251001"].webSearchRequests = 2;
    rec.modelUsage["claude-haiku-4-5-20251001"].costUSD += 0.02;
    rec.total_cost_usd += 0.05;
    writeFileSync(receiptPath, JSON.stringify(rec));
    const session = join(root, "transcripts", "58591543-407d-4a7a-8a86-b29f035f1e7d.jsonl");
    const lines = readFileSync(session, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const firstId = lines.find((o) => o.type === "assistant").message.id;
    for (const o of lines) if (o.type === "assistant" && o.message.id === firstId) o.message.usage.server_tool_use = { web_search_requests: 2, web_fetch_requests: 0 };
    writeFileSync(session, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");

    const r = exec([root, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = readJson(join(root, "manifest.json")).orchestrator_overhead;
    // Logged: the fixture's $0.183168 of tokens plus 2 searches.
    assert.equal(o.transcript_cost_usd, 0.203168);
    const session5 = o.per_model.find((e) => e.role === "session" && e.model === "claude-opus-5");
    assert.deepEqual([session5.web_search_requests, session5.web_search_cost_usd], [2, 0.02]);
    const gap = Object.fromEntries(o.unlogged_billed.per_model.map((g) => [g.model, g]));
    assert.deepEqual([gap["claude-opus-5"].web_search_requests, gap["claude-opus-5"].cost_usd], [1, 0.01], "3 billed, 2 logged");
    assert.deepEqual(gap["claude-opus-5"].tokens, { input: 0, input_cached: 0, input_cache_write: 0, output: 0 });
    assert.deepEqual([gap["claude-haiku-4-5"].web_search_requests, gap["claude-haiku-4-5"].cost_usd], [2, 0.021003], "$0.001003 of tokens + 2 searches");
    assert.equal(o.unlogged_billed.cost_usd, 0.031003);
    assert.equal(o.cost_usd, 0.234171, "the receipt's tokens at the list ($0.184171) + 5 searches");
    assert.equal(o.pricing_complete, true);
    assert.doesNotMatch(r.stderr, /price table differs/, "Claude Code's total includes the fee, and so does the booked figure");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M3: web searches on a model with no per-search price are unpriced, never borrowed — in priceMessages and in a booked receipt's gap", async () => {
  const { resolveBucketNames, bookReceiptTokens, priceMessages, makeMessagePricer } = await helpers();
  const pricer = makeMessagePricer({ models: [] }, { pricesMod, effectiveMod, pricingMod });
  const ts = "2026-09-10T10:00:00.000Z";
  const zero = { input: 0, input_cached: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 0 };
  const gem = { model: "gemini-3.5-flash", role: "session", timestamp: ts, modifiers: { speed: null, service_tier: null, inference_geo: null }, conflicts: [], web_search_requests: 4, tokens: { ...zero, input: 1_000_000 } };
  const priced = priceMessages([gem], pricer);
  assert.equal(priced.cost_usd, 1.5, "the tokens are still priced");
  assert.equal(priced.complete, false);
  const u = priced.unpriced.find((x) => x.model === "gemini-3.5-flash");
  assert.equal(u.web_search_requests, 4);
  assert.deepEqual(u.tokens, zero, "only the searches are unpriced");
  assert.match(u.reason, /4 web search request\(s\) have no per-search price for gemini-3\.5-flash/);

  const { receipt } = resolveBucketNames({}, { "gemini-3.5-flash": { input: 0, input_cached: 0, input_cache_write: 0, output: 0, web_search_requests: 3, cost_usd: null } }, pricesMod.resolveModel);
  const b = bookReceiptTokens({ receipt, priced: priceMessages([], pricer), pricer, referenceTimes: [ts, ts] });
  assert.equal(b.complete, false);
  assert.equal(b.unlogged_billed.unpriced.length, 1);
  assert.equal(b.unlogged_billed.unpriced[0].web_search_requests, 3);
  assert.match(b.unlogged_billed.unpriced[0].reason, /no per-search price for gemini-3\.5-flash/);
  assert.equal(b.cost_usd, 0);
});

// ── F1: a human turn AFTER the window means the receipt may bill a later leg ──

/**
 * Review finding F1. One session runs two invocations: `/mmo:pass --run-id
 * pass1` at 10:00 (one Opus 5 message, $0.17505 at the list), its run.end at
 * 10:05, then `/mmo:pass --run-id pass2` at 11:00 (one larger Opus 5 message,
 * $0.90025). The receipt beside pass1 is the LATER leg's (same session id).
 * pass1's window closes exactly at the 11:00 turn, so its log is short of that
 * receipt on every bucket. Before the fix, provableInvocation counted only the
 * human turns INSIDE the window (one), called the window provable and booked
 * the later leg's $0.90025 onto pass1 with exit 0. The rule it was written
 * from (plan section 2, Fix D step 3; docs/methodology.md) also requires no
 * later human turn, and a receipt is Claude Code's bill for the LAST
 * invocation of a session, so a later turn means it cannot be shown to be
 * this run's.
 */
test("T7 refusal: a receipt from a LATER invocation of the same session is exit 3 — a human turn after the window means the short log cannot be proven to be the receipt's invocation", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-laterleg-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    const tDir = join(root, "transcripts"); mkdirSync(tDir);
    writeFileSync(join(root, "policy.yaml"), "version: 1\nname: h-policy\nmodels:\n  - id: driver\n    adapter: builtin-anthropic\n    model_name: claude-opus-4-8\nrules:\n  - default: driver\n");
    writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "pass1", policy_name: "h-policy", started_at: AT("10:00:20"), ended_at: AT("10:04:00"), totals: { dispatched_cost_usd: 0, models_used: [] } }));
    writeFileSync(join(passDir, "telemetry.jsonl"), "");
    mkdirSync(join(root, ".sdlc", "runs", "pass1"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "runs", "pass1", "orchestrator.log"), `MMO: ${AT("10:00:10")} INFO   run.start run_id=pass1 mode=greenfield\nMMO: ${AT("10:05:00")} INFO   run.end run_id=pass1 outcome=completed\n`);
    const command = (runId) => `<command-message>mmo:pass</command-message>\n<command-name>/mmo:pass</command-name>\n<command-args>--run-id ${runId} brief.md</command-args>`;
    writeFileSync(join(tDir, "sess-l.jsonl"), [
      human("sess-l", AT("10:00:00"), command("pass1")),
      asst("sess-l", "l1", "claude-opus-5", usage(10, 100_000, 0, 10_000, 1_000), AT("10:00:30")),
      human("sess-l", AT("11:00:00"), command("pass2")),
      asst("sess-l", "l2", "claude-opus-5", usage(50, 500_000, 0, 50_000, 6_000), AT("11:00:30")),
    ].join("\n") + "\n");
    // The later leg's receipt: 50 x $5 + 500,000 x $0.50 + 50,000 x $10 (1-hour) + 6,000 x $25, per 1M = $0.90025.
    writeFileSync(join(passDir, "claude-session.json"), JSON.stringify({
      type: "result",
      session_id: "sess-l",
      total_cost_usd: 0.90025,
      usage: { input_tokens: 50, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 50_000, output_tokens: 6_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50_000 } },
      modelUsage: { "claude-opus-5[1m]": { inputTokens: 50, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 50_000, outputTokens: 6_000, costUSD: 0.90025 } },
    }));
    const r = exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /closes at the next human turn 2026-09-10T11:00:00\.000Z after run\.end/);
    assert.match(r.stdout, /claude-opus-5: in 10<50 · cached 100000<500000 · cache_write 10000<50000 · out 1000≤6000 → short of the receipt/);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: 1 human turn\(s\) follow the window \(from 2026-09-10T11:00:00\.000Z\), so the receipt may bill a later invocation of this session/);
    assert.equal(readJson(join(passDir, "manifest.json")).orchestrator_overhead, undefined, "nothing written");
    assert.equal(readFileSync(join(passDir, "telemetry.jsonl"), "utf-8"), "", "nothing written");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── F2: lines Claude Code injects as `type: "user"` are not human turns ─────

const UNLOGGED_SESSION = "908511af-6158-466f-92ad-beb1cd9f5c73";
/**
 * Two kinds of `type: "user"` line that no person typed, in the shapes real
 * Claude Code transcripts on this machine carry (keys read 2026-09-14; text
 * replaced): a compaction summary (`isCompactSummary: true`,
 * `isVisibleInTranscriptOnly: true`, string content, no `isMeta`) and a
 * background-task notification (`origin: {kind: "task-notification"}`, string
 * content, no `isMeta`). Neither carries `isMeta` or a tool result, so the
 * human-turn reader used to count both, and the receipt rule depends on that
 * count.
 */
const INJECTED_LINES = {
  "compaction summary": (ts) => ({ type: "user", isSidechain: false, sessionId: UNLOGGED_SESSION, timestamp: ts, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "(summary text removed)" } }),
  "background-task notification": (ts) => ({ type: "user", isSidechain: false, sessionId: UNLOGGED_SESSION, timestamp: ts, origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>(removed)</task-notification>" } }),
};

/** A copy of the T5 fixture with one line inserted into the session file in timestamp order. */
function unloggedWithLine(line) {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-injected-"));
  cpSync(UNLOGGED, root, { recursive: true });
  const file = join(root, "transcripts", `${UNLOGGED_SESSION}.jsonl`);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const at = lines.findIndex((l) => Date.parse(JSON.parse(l).timestamp) > Date.parse(line.timestamp));
  lines.splice(at === -1 ? lines.length : at, 0, JSON.stringify(line));
  writeFileSync(file, lines.join("\n") + "\n");
  return root;
}

for (const [shape, make] of Object.entries(INJECTED_LINES)) {
  test(`F2: a ${shape} inside the window is not a second human turn — the Sep 10 run still books $14.197776 with 2.32% billed but not logged`, () => {
    // Between the command turn (17:27:16.771Z) and run.end (18:16:20.212Z). Counted as a
    // turn, it made "2 human turns" and refused a provable run with exit 3.
    const root = unloggedWithLine(make("2026-09-10T17:50:00.000Z"));
    try {
      const r = exec([join(root, "pass1"), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /= \$14\.19777[67] \[receipt \(Anthropic token counts priced at the price list\); 2\.3% billed but not logged\]/);
      const o = readJson(join(root, "pass1", "manifest.json")).orchestrator_overhead;
      near(o.cost_usd, 14.197777, 0.000002, "booked");
      assert.equal(o.unlogged_billed.pct_of_booked, 2.32);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`F2: a ${shape} just after run.end does not close the window — it still ends at the end of the session, with no logged message pushed out`, () => {
    // Just after run.end, among the session's closing messages. Counted as a turn, it closed
    // the window there, so the closing messages fell outside and were booked as "billed but
    // not logged" (3.6% instead of 2.32%).
    const root = unloggedWithLine(make("2026-09-10T18:16:54.842Z"));
    try {
      const r = exec([join(root, "pass1"), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /, 0 outside window\)/);
      const o = readJson(join(root, "pass1", "manifest.json")).orchestrator_overhead;
      assert.equal(o.window.end_anchor, "end of session");
      near(o.unlogged_billed.cost_usd, 0.3292975, 0.000001, "unlogged");
      near(o.cost_usd, 14.197777, 0.000002, "booked");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("humanTurns: compaction summaries and harness-injected notifications are not turns; a line with origin.kind human, or with no origin (older transcripts), is", async () => {
  const { humanTurns } = await helpers();
  const dir = mkdtempSync(join(tmpdir(), "mmo-humanturns-"));
  try {
    const injected = join(dir, "injected.jsonl");
    writeFileSync(injected, [
      human(UNLOGGED_SESSION, "2026-09-10T17:27:16.771Z", "<command-message>mmo:pass</command-message>\n<command-name>/mmo:pass</command-name>"),
      JSON.stringify(INJECTED_LINES["compaction summary"]("2026-09-10T17:50:00.000Z")),
      JSON.stringify(INJECTED_LINES["background-task notification"]("2026-09-10T18:00:00.000Z")),
      // Only the transcript-only flag, and a harness origin of another kind: neither is typed by a person.
      JSON.stringify({ type: "user", sessionId: UNLOGGED_SESSION, timestamp: "2026-09-10T18:05:00.000Z", isVisibleInTranscriptOnly: true, message: { role: "user", content: "x" } }),
      JSON.stringify({ type: "user", sessionId: UNLOGGED_SESSION, timestamp: "2026-09-10T18:06:00.000Z", origin: { kind: "some-future-kind" }, message: { role: "user", content: "x" } }),
    ].join("\n") + "\n");
    const turns = humanTurns(injected);
    assert.deepEqual(turns.map((t) => [t.iso, t.command]), [["2026-09-10T17:27:16.771Z", true]]);

    const people = join(dir, "people.jsonl");
    writeFileSync(people, [
      JSON.stringify({ type: "user", sessionId: "s", timestamp: "2026-09-10T10:00:00.000Z", origin: { kind: "human" }, message: { role: "user", content: "/mmo:pass --run-id r1" } }),
      human("s", "2026-09-10T10:30:00.000Z", "keep going"),
    ].join("\n") + "\n");
    assert.deepEqual(humanTurns(people).map((t) => [t.iso, t.command]), [["2026-09-10T10:00:00.000Z", true], ["2026-09-10T10:30:00.000Z", false]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provableInvocation: pinned to the receipt's session, opened at the command turn, one human turn, no later human turn, exact", async () => {
  const { provableInvocation } = await helpers();
  const ok = { receiptSessionId: "s", pinnedId: "s", startAnchor: "command turn", humanTurnsInWindow: 1, laterHumanTurns: 0, laterHumanTurnFrom: null, windowExact: true, lowerBound: false };
  assert.deepEqual(provableInvocation(ok), { provable: true, reasons: [] });
  assert.match(provableInvocation({ ...ok, receiptSessionId: null }).reasons.join("; "), /the receipt names no session/);
  assert.match(provableInvocation({ ...ok, pinnedId: null }).reasons.join("; "), /not pinned to the receipt's session s/);
  assert.match(provableInvocation({ ...ok, startAnchor: "run.start - 5m", windowExact: false }).reasons.join("; "), /opens at run\.start - 5m, not at the run's command turn/);
  assert.match(provableInvocation({ ...ok, humanTurnsInWindow: 3 }).reasons.join("; "), /3 human turns fall inside the window/);
  // F1: a human turn after the window closes means the receipt may bill a later invocation.
  assert.match(
    provableInvocation({ ...ok, laterHumanTurns: 2, laterHumanTurnFrom: "2026-09-10T11:00:00.000Z" }).reasons.join("; "),
    /2 human turn\(s\) follow the window \(from 2026-09-10T11:00:00\.000Z\), so the receipt may bill a later invocation of this session/,
  );
  assert.match(provableInvocation({ ...ok, windowExact: false }).reasons.join("; "), /approximate/);
  assert.match(provableInvocation({ ...ok, startAnchor: "manifest started_at - 5m", windowExact: false, lowerBound: true }).reasons.join("; "), /opens at the first dispatch \(a lower bound\)/);
});

// ── Q2: a model name the run's policy declares under pricing_override ───────
//
// A policy may bill a model the price list does not carry by declaring it on a
// model entry with pricing_override: true (a gateway alias, say). Pre-flight and
// dispatch already accept that. The collector did not: the receipt check read
// names with the list's resolveModel only, so a receipt naming the declared
// model refused the run with exit 3 ("cannot resolve model name(s)"), and
// per-message pricing kept `acme-gateway-opus` and `acme-gateway-opus[1m]` as
// two models. The declared name, exactly or with one bracketed option, is now a
// known model priced by that override, for that run's policy only.

const GATEWAY = "acme-gateway-opus";
const GATEWAY_CARD = { input: 4, input_cached: 0.4, input_cache_write: 5, input_cache_write_1h: 8, output: 20 };

/**
 * Session sess-g on the gateway model: one message per name in `messageNames`,
 * each in 10 / cached 100,000 / 1-hour writes 10,000 / out 1,000, which is
 * $0.14004 at GATEWAY_CARD. The receipt (session sess-g) bills in 20 / 200,000 /
 * 20,000 / 2,000 under `receiptName`: $0.28008. Exact window: command turn,
 * run.start and run.end, no later human turn.
 */
function gatewayRun({ override = true, receiptName = `${GATEWAY}[1m]`, messageNames = [GATEWAY], withReceipt = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-gateway-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts"); mkdirSync(tDir);
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: g-policy", "models:", "  - id: driver", "    adapter: builtin-anthropic", `    model_name: ${GATEWAY}`,
    `    pricing: ${JSON.stringify(GATEWAY_CARD)}`, ...(override ? ["    pricing_override: true"] : []), "rules:", "  - default: driver", "",
  ].join("\n"));
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "r-g", policy_name: "g-policy", started_at: AT("10:00:20"), ended_at: AT("10:01:20"), totals: { dispatched_cost_usd: 0, models_used: [] } }));
  writeFileSync(join(passDir, "telemetry.jsonl"), "");
  mkdirSync(join(root, ".sdlc", "runs", "r-g"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "runs", "r-g", "orchestrator.log"), `MMO: ${AT("10:00:05")} INFO   run.start run_id=r-g mode=greenfield\nMMO: ${AT("10:01:30")} INFO   run.end run_id=r-g outcome=completed\n`);
  writeFileSync(join(tDir, "sess-g.jsonl"), [
    human("sess-g", AT("10:00:00"), COMMAND.replace("--run-id=r-h", "--run-id=r-g")),
    ...messageNames.map((name, i) => asst("sess-g", `g${i + 1}`, name, usage(10, 100_000, 0, 10_000, 1_000), AT(`10:00:${String(10 + i * 10)}`))),
  ].join("\n") + "\n");
  if (withReceipt) {
    writeFileSync(join(passDir, "claude-session.json"), JSON.stringify({
      type: "result",
      session_id: "sess-g",
      total_cost_usd: 0.28008,
      modelUsage: { [receiptName]: { inputTokens: 20, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 20_000, outputTokens: 2_000, costUSD: 0.28008 } },
    }));
  }
  const run = () => exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir]);
  return { run, manifest: () => readJson(join(passDir, "manifest.json")), rm: () => rmSync(root, { recursive: true, force: true }) };
}

test("Q2: a receipt naming the policy's pricing_override model with a [1m] option is compared, and booked at that override's card", () => {
  const fix = gatewayRun();
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /receipt names resolved: acme-gateway-opus\[1m\] → acme-gateway-opus/);
    assert.match(r.stdout, /acme-gateway-opus: in 10<20 · cached 100000<200000 · cache_write 10000<20000 · out 1000≤2000 → short of the receipt/);
    // Logged $0.14004 at the card, plus the same token gap at the logged (all 1-hour) write mix: $0.28008.
    assert.match(r.stdout, /= \$0\.28008 \[receipt \(Anthropic token counts priced at the price list; custom policy price for acme-gateway-opus\); 50\.0% billed but not logged\]/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 0.28008);
    assert.equal(o.transcript_cost_usd, 0.14004);
    assert.deepEqual(o.per_model.map((e) => [e.model, e.price_basis, e.rates]), [[GATEWAY, "custom", GATEWAY_CARD]]);
    assert.deepEqual(
      o.unlogged_billed.per_model.map((g) => [g.model, g.reported_as, g.tokens, g.cost_usd]),
      [[GATEWAY, [`${GATEWAY}[1m]`], { input: 10, input_cached: 100_000, input_cache_write: 10_000, output: 1_000 }, 0.14004]],
    );
    assert.equal(o.pricing_complete, true);
  } finally { fix.rm(); }
});

test("Q2: without pricing_override the same unlisted names still stop the receipt check with exit 3, and the message names both fixes", () => {
  const fix = gatewayRun({ override: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    // The refusal line itself must name both fixes. stderr as a whole already
    // carries "pricing_override: true" from the per-message WARNING printed
    // before the receipt check, so matching all of stderr would pass on that
    // unrelated line and prove nothing about the refusal.
    const failed = r.stderr.split("\n").find((l) => l.startsWith("collect-orchestrator-usage FAILED: cannot resolve")) ?? "";
    assert.match(failed, /cannot resolve model name\(s\) the price list does not carry: transcript acme-gateway-opus, receipt acme-gateway-opus\[1m\]/);
    assert.match(failed, /plugin\/mcp\/model-dispatch\/src\/prices\.ts/);
    assert.match(failed, /give the policy model a pricing block with pricing_override: true/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined, "nothing written");
  } finally { fix.rm(); }
});

test("Q2: per-message pricing books the override-declared name and its [1m] spelling as one custom-priced model", () => {
  const fix = gatewayRun({ withReceipt: false, messageNames: [GATEWAY, `${GATEWAY}[1m]`] });
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = fix.manifest().orchestrator_overhead;
    assert.deepEqual(o.per_model.map((e) => [e.model, e.reported_as, e.price_basis, e.messages, e.cost_usd]), [[GATEWAY, [GATEWAY, `${GATEWAY}[1m]`], "custom", 2, 0.28008]]);
    assert.deepEqual(o.unpriced, []);
    assert.equal(o.cost_usd, 0.28008);
  } finally { fix.rm(); }
});

test("Q2 runModelResolver: the price list first; then a pricing_override model's own name, exactly or with one [option]; nothing else, and only for that policy", async () => {
  const { runModelResolver } = await helpers();
  const gw = { id: "gw", adapter: "builtin-anthropic", model_name: GATEWAY, pricing: GATEWAY_CARD, pricing_override: true };
  const plain = { id: "plain", adapter: "builtin-anthropic", model_name: "acme-plain", pricing: GATEWAY_CARD };
  const listed = { id: "listed", adapter: "builtin-anthropic", model_name: "claude-opus-4-8", pricing: GATEWAY_CARD, pricing_override: true };
  const resolve = runModelResolver({ models: [gw, plain, listed] }, pricesMod.resolveModel);
  for (const n of ["claude-opus-5[1m]", "claude-haiku-4-5-20251001", "claude-opus-4-8"]) assert.deepEqual(resolve(n), pricesMod.resolveModel(n), n);
  assert.deepEqual(resolve(GATEWAY), { id: GATEWAY, tag: null, snapshotDate: null, declared_by: ["gw"] });
  assert.deepEqual(resolve(`${GATEWAY}[1m]`), { id: GATEWAY, tag: "[1m]", snapshotDate: null, declared_by: ["gw"] });
  for (const n of [`${GATEWAY}-20260101`, `${GATEWAY}[1m][2]`, `${GATEWAY}x`, "acme-gateway", "acme-plain", "acme-plain[1m]", "", null, undefined]) {
    assert.equal(resolve(n), null, `${String(n)} is not declared under pricing_override`);
  }
  assert.equal(runModelResolver({ models: [plain] }, pricesMod.resolveModel)(GATEWAY), null, "a policy that declares nothing resolves nothing extra");
  // The flag without a block bills nothing (the loader refuses it), so it declares nothing either.
  assert.equal(runModelResolver({ models: [{ ...gw, pricing: undefined }] }, pricesMod.resolveModel)(GATEWAY), null);
  // A declared name that itself carries an option is the same model as its bare
  // spelling, exactly as effectivePrice's sameModel reads it when it bills the
  // override: the id is the name without the option.
  const bracketed = runModelResolver({ models: [{ ...gw, model_name: `${GATEWAY}[1m]` }] }, pricesMod.resolveModel);
  assert.deepEqual(bracketed(GATEWAY), { id: GATEWAY, tag: null, snapshotDate: null, declared_by: ["gw"] });
  assert.deepEqual(bracketed(`${GATEWAY}[200k]`), { id: GATEWAY, tag: "[200k]", snapshotDate: null, declared_by: ["gw"] });
  for (const n of [GATEWAY, `${GATEWAY}[1m]`, `${GATEWAY}[200k]`]) {
    assert.equal(effectiveMod.sameModel(`${GATEWAY}[1m]`, n), true, `${n} is billed at the override, so it must resolve too`);
  }
  // Two override entries declaring one name are both named; which card bills is the pricer's decision (it refuses two different cards).
  assert.deepEqual(runModelResolver({ models: [gw, { ...gw, id: "gw2" }] }, pricesMod.resolveModel)(GATEWAY).declared_by, ["gw", "gw2"]);
});

// ── Q1: a resumed run, whose receipt bills only its last invocation ─────────
//
// Claude Code bills per invocation, and a runner's `--resume` continuation
// restarts the bill, so a window holding two invocations is ABOVE the receipt
// and the last invocation is checked alone. That check used to demand every
// bucket equal: a last invocation that was BELOW the receipt (a call Claude
// Code bills but never logs) was exit 3, and an equal one was written
// transcript-priced. The last invocation now gets the main path's rule: below
// or equal on every bucket books the receipt (its token counts at the list,
// the gap in unlogged_billed); a bucket below also needs the last invocation to
// be provably the receipt's (pinned to its session, opened at that invocation's
// human turn, no later human turn, an exact close). Attribution is checked over
// that invocation's helpers only. The earlier invocations stay
// transcript-priced and labelled unverified.

/**
 * Session sess-r (run r-r). Earlier invocation, from the command turn at
 * 10:00:00: two Opus 5 messages (in 10 / cached 200,000 / 1h writes 20,000 /
 * out 2,000 together, $0.35005) and a helper a0000 whose transcript file is
 * missing. Last invocation, from the resume turn at 10:02:00: two Opus 5
 * messages (in 10 / 400,000 / 1h 40,000 / 4,000, $0.70005) and helper a3333 on
 * Opus 4.8 (in 70 / 700,000 / 5m 70,000 / 7,000, $0.96285). The receipt bills
 * the last invocation: Opus 5 exactly, Opus 4.8 at 100 / 1,000,000 / 100,000 /
 * 10,000 ($1.3755 at the list), so $0.41265 of it is billed but not logged.
 */
function resumedRun({ receipt = {}, laterTurn = false, helperA3 = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-resumed-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts");
  const sub = join(tDir, "sess-r", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: h-policy\nmodels:\n  - id: driver\n    adapter: builtin-anthropic\n    model_name: claude-opus-4-8\nrules:\n  - default: driver\n");
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "r-r", policy_name: "h-policy", started_at: AT("10:00:20"), ended_at: AT("10:03:20"), totals: { dispatched_cost_usd: 0, models_used: [] } }));
  writeFileSync(join(passDir, "telemetry.jsonl"), "");
  mkdirSync(join(root, ".sdlc", "runs", "r-r"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "runs", "r-r", "orchestrator.log"), `MMO: ${AT("10:00:05")} INFO   run.start run_id=r-r mode=greenfield\nMMO: ${AT("10:04:00")} INFO   run.end run_id=r-r outcome=completed\n`);
  const result = (ts, toolUseId, agentId) => JSON.stringify({ type: "user", timestamp: ts, sessionId: "sess-r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] }, toolUseResult: { agentId } });
  writeFileSync(join(tDir, "sess-r.jsonl"), [
    human("sess-r", AT("10:00:00"), COMMAND.replace("--run-id=r-h", "--run-id=r-r")),
    asst("sess-r", "e1", "claude-opus-5", usage(10, 100_000, 0, 10_000, 1_000), AT("10:00:10"), [{ type: "tool_use", id: "toolu_e", name: "Agent" }]),
    result(AT("10:00:50"), "toolu_e", "a0000"),
    asst("sess-r", "e2", "claude-opus-5", usage(0, 100_000, 0, 10_000, 1_000), AT("10:01:00")),
    human("sess-r", AT("10:02:00"), "Continue the run from where it stopped."),
    asst("sess-r", "s1", "claude-opus-5", usage(10, 200_000, 0, 20_000, 2_000), AT("10:02:10"), [{ type: "tool_use", id: "toolu_l", name: "Agent" }]),
    result(AT("10:03:00"), "toolu_l", "a3333"),
    asst("sess-r", "s2", "claude-opus-5", usage(0, 200_000, 0, 20_000, 2_000), AT("10:03:10")),
    ...(laterTurn ? [human("sess-r", AT("11:00:00"), "one more thing"), asst("sess-r", "x1", "claude-opus-5", usage(5, 50_000, 0, 5_000, 500), AT("11:00:10"))] : []),
  ].join("\n") + "\n");
  if (helperA3) writeFileSync(join(sub, "agent-a3333.jsonl"), asst("sess-r", "h3", "claude-opus-4-8", usage(70, 700_000, 70_000, 0, 7_000), AT("10:02:30")) + "\n");
  const opus5 = { inputTokens: 10, cacheReadInputTokens: 400_000, cacheCreationInputTokens: 40_000, outputTokens: 4_000, costUSD: 0.70005, ...(receipt.opus5 ?? {}) };
  const opus48 = { inputTokens: 100, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 100_000, outputTokens: 10_000, costUSD: 1.3755, ...(receipt.opus48 ?? {}) };
  writeFileSync(join(passDir, "claude-session.json"), JSON.stringify({
    type: "result",
    ...(receipt.noSession ? {} : { session_id: "sess-r" }),
    total_cost_usd: 2.07555,
    usage: { input_tokens: 10, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 40_000, output_tokens: 4_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40_000 } },
    ...(receipt.noModelUsage ? {} : { modelUsage: { "claude-opus-5[1m]": opus5, "claude-opus-4-8": opus48 } }),
  }));
  const run = () => exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir]);
  const event = () => readLines(join(passDir, "telemetry.jsonl")).find((e) => e.tier === "orchestrator");
  return { run, passDir, manifest: () => readJson(join(passDir, "manifest.json")), event, rm: () => rmSync(root, { recursive: true, force: true }) };
}

test("Q1: a resumed run whose last invocation is below the receipt and provably its invocation books the receipt for that invocation; the earlier one stays transcript-priced and unverified", () => {
  const fix = resumedRun();
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The whole window is over the receipt: it also holds the earlier invocation.
    assert.match(r.stdout, /claude-opus-5: in 20>10 · cached 600000>400000 · cache_write 60000>40000 · out 6000>4000 → over the receipt/);
    assert.match(r.stdout, /last invocation \(from the human turn at 2026-09-10T10:02:00\.000Z, 1 earlier turn\(s\) in the window\):/);
    assert.match(r.stdout, /claude-opus-4-8: in 70<100 · cached 700000<1000000 · cache_write 70000<100000 · out 7000≤10000 → short of the receipt/);
    // $2.01295 logged (earlier $0.35005 + last $1.6629) + $0.41265 billed but not logged = $2.4256;
    // the booked invocation is $2.07555, of which $0.41265 (19.9%) no transcript message recorded.
    assert.match(r.stdout, /= \$2\.4256 \[receipt for the last invocation \(Anthropic token counts priced at the price list\); 19\.9% of it billed but not logged; 1 earlier invocation\(s\) transcript-priced, unverified\]/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 2.4256);
    assert.equal(o.transcript_cost_usd, 2.01295);
    assert.equal(o.unlogged_billed.cost_usd, 0.41265);
    assert.equal(o.unlogged_billed.pct_of_booked, 19.88, "the share of the booked invocation");
    assert.deepEqual(o.unlogged_billed.per_model.map((g) => [g.model, g.tokens, g.ttl_split]), [["claude-opus-4-8", { input: 30, input_cached: 300_000, input_cache_write: 30_000, output: 3_000 }, "logged mix"]]);
    // cost_usd = transcript_cost_usd + unlogged_billed.cost_usd, as on the main path.
    assert.equal(o.cost_usd, Math.round((o.transcript_cost_usd + o.unlogged_billed.cost_usd) * 1e6) / 1e6);
    // Earlier invocation's logged tokens plus the receipt's: in 10 + 110, cached 200,000 + 1,400,000, writes 20,000 (1h) + 140,000 (40,000 of them 1h), out 2,000 + 14,000.
    assert.deepEqual([o.input_tokens, o.input_tokens_cached, o.input_tokens_cache_write, o.input_tokens_cache_write_1h, o.output_tokens], [120, 1_600_000, 160_000, 60_000, 16_000]);
    assert.equal(o.receipt_cli_usd, 2.07555);
    // v0.7.3 review fix: Claude Code's figure bills the last invocation, so the report checks it against
    // that invocation's list figure ($1.6629 logged + $0.41265 not logged), not the window's $2.4256.
    assert.equal(o.booked_cost_usd, 2.07555);
    assert.equal(fix.event().booked_cost_usd, 2.07555);
    assert.equal(o.pricing_complete, true);
    // Attribution covers the booked invocation's helpers: a3333 has its file. The earlier
    // invocation's missing a0000 is in no booked figure, so it is not this check's gap.
    assert.equal(o.attribution_complete, true);
    assert.deepEqual([o.missing_helper_ids, o.unreferenced_helper_files], [[], []]);
    assert.match(r.stdout, /last invocation helpers: 1 named by Agent\/Task results, 1 transcript file\(s\) → attribution complete/);
  } finally { fix.rm(); }
});

test("Q1: a helper file missing from the last invocation is still booked, and the scoped attribution names only that helper", () => {
  const fix = resumedRun({ helperA3: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = fix.manifest().orchestrator_overhead;
    // The receipt is the bill: the unread helper's whole Opus 4.8 count is in the gap ($1.3755).
    assert.equal(o.unlogged_billed.cost_usd, 1.3755);
    assert.equal(o.cost_usd, 2.4256, "the total is the same either way");
    assert.equal(o.attribution_complete, false);
    assert.deepEqual(o.missing_helper_ids, ["a3333"], "a0000 belongs to the earlier invocation");
  } finally { fix.rm(); }
});

test("Q1 refusal: a last invocation below the receipt with a human turn after the window cannot be proven to be the receipt's invocation — exit 3, nothing written", () => {
  const fix = resumedRun({ laterTurn: true });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the receipt matches neither the whole window nor its last invocation/);
    assert.match(r.stderr, /last invocation \(from 2026-09-10T10:02:00\.000Z\) is BELOW the receipt/);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: 1 human turn\(s\) follow the window \(from 2026-09-10T11:00:00\.000Z\)/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined, "nothing written");
  } finally { fix.rm(); }
});

test("Q1 refusal: a last invocation below a receipt that names no session is exit 3", () => {
  const fix = resumedRun({ receipt: { noSession: true } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: the receipt names no session/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined, "nothing written");
  } finally { fix.rm(); }
});

test("Q1 refusal: a last invocation ABOVE the receipt is exit 3 even when it is provably the receipt's invocation", () => {
  const fix = resumedRun({ receipt: { opus5: { cacheReadInputTokens: 390_000 } } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the receipt matches neither the whole window nor its last invocation/);
    assert.match(r.stderr, /claude-opus-5 input_cached: transcript 400000 > receipt 390000/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined, "nothing written");
  } finally { fix.rm(); }
});

test("Q1 provableInvocation: a window opened at the last invocation's own human turn counts as opened at the invocation", async () => {
  const { provableInvocation, LAST_INVOCATION_ANCHOR } = await helpers();
  assert.equal(typeof LAST_INVOCATION_ANCHOR, "string");
  const ok = { receiptSessionId: "s", pinnedId: "s", startAnchor: LAST_INVOCATION_ANCHOR, humanTurnsInWindow: 1, laterHumanTurns: 0, laterHumanTurnFrom: null, windowExact: true, lowerBound: false };
  assert.deepEqual(provableInvocation(ok), { provable: true, reasons: [] });
  assert.match(provableInvocation({ ...ok, laterHumanTurns: 1, laterHumanTurnFrom: "x" }).reasons.join("; "), /follow the window/);
  assert.match(provableInvocation({ ...ok, windowExact: false }).reasons.join("; "), /approximate/);
});

test("Q1 helperAttribution: with a time scope, only Agent/Task uses and results inside it name helpers, and only helper files that start inside it are compared", async () => {
  const { helperAttribution } = await helpers();
  const dir = mkdtempSync(join(tmpdir(), "mmo-attrib-scope-"));
  try {
    const sub = join(dir, "sess", "subagents");
    mkdirSync(sub, { recursive: true });
    const tu = (id) => ({ type: "tool_use", id, name: "Agent" });
    const res = (ts, id, agentId) => JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id }] }, toolUseResult: { agentId } });
    const sessionFile = join(dir, "sess.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "assistant", timestamp: AT("10:00:10"), message: { id: "m1", content: [tu("t_old")] } }),
      res(AT("10:00:50"), "t_old", "aold"),
      JSON.stringify({ type: "assistant", timestamp: AT("10:02:10"), message: { id: "m2", content: [tu("t_new")] } }),
      res(AT("10:03:00"), "t_new", "anew"),
    ].join("\n") + "\n");
    const file = (id, ts) => { const p = join(sub, `agent-${id}.jsonl`); writeFileSync(p, JSON.stringify({ type: "assistant", timestamp: ts, message: { id: `h-${id}` } }) + "\n"); return p; };
    const files = [file("anew", AT("10:02:30")), file("astray", AT("10:00:30"))];
    const whole = helperAttribution(sessionFile, files);
    assert.deepEqual([whole.complete, whole.missing_helper_ids, whole.unreferenced_helper_files.length], [false, ["aold"], 1]);
    const scoped = helperAttribution(sessionFile, files, { fromMs: Date.parse(AT("10:02:00")), toMs: Number.POSITIVE_INFINITY });
    assert.deepEqual(scoped, { complete: true, referenced: ["anew"], missing_helper_ids: [], unreferenced_helper_files: [] });
    // A helper file with no timestamp cannot be placed: it is compared, so it can only make the check incomplete.
    const undated = join(sub, "agent-aundated.jsonl");
    writeFileSync(undated, JSON.stringify({ type: "assistant", message: { id: "h-u" } }) + "\n");
    const withUndated = helperAttribution(sessionFile, [...files, undated], { fromMs: Date.parse(AT("10:02:00")), toMs: Number.POSITIVE_INFINITY });
    assert.equal(withUndated.complete, false);
    assert.deepEqual(withUndated.unreferenced_helper_files, [undated]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── A receipt with no per-model token counts (v0.7.3 review fix) ────────────
//
// What: a receipt that carries a session id and Claude Code's dollars but no
// modelUsage is refused (exit 3, nothing written) with a message that says the
// receipt has no per-model token counts, on every path: a single invocation, a
// resumed window, and a window with no transcript line.
//
// Why: only the no-transcript path said so. With transcript lines in the
// window, every model read as "in the transcript, none on the receipt", and
// the user was told the window had opened too early (a stale run.start, a
// reused run id, another run's messages) when the receipt was the problem.

/** Copy the Sep 10 run with its receipt (the live-run.log result line) stripped of modelUsage. */
function unloggedWithoutModelUsage() {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-nomodelusage-"));
  cpSync(UNLOGGED, root, { recursive: true });
  const log = join(root, "pass1", "live-run.log");
  const lines = readFileSync(log, "utf-8").split("\n");
  const last = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('"type":"result"')).at(-1);
  assert.ok(last, "the fixture's live-run.log carries a result line");
  const result = JSON.parse(last[0]);
  assert.ok(result.modelUsage, "the fixture's result line has modelUsage to strip");
  delete result.modelUsage;
  lines[last[1]] = JSON.stringify(result);
  writeFileSync(log, lines.join("\n"));
  return root;
}

const NO_MODEL_USAGE = /carries no per-model token counts \(modelUsage\)/;

test("a receipt with no modelUsage and transcript lines in the window is refused as a receipt without per-model counts, not as a wrong window", () => {
  const root = unloggedWithoutModelUsage();
  try {
    const r = exec([join(root, "pass1"), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, NO_MODEL_USAGE);
    assert.doesNotMatch(r.stderr, /stale run\.start|opened before this invocation/);
    assert.equal(readJson(join(root, "pass1", "manifest.json")).orchestrator_overhead, undefined, "nothing written");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a resumed window whose receipt has no modelUsage is refused the same way", () => {
  const fix = resumedRun({ receipt: { noModelUsage: true } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, NO_MODEL_USAGE);
    assert.doesNotMatch(r.stderr, /matches neither the whole window nor its last invocation/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined, "nothing written");
  } finally { fix.rm(); }
});
