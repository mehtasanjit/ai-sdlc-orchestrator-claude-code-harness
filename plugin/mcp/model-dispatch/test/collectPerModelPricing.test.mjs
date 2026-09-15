/**
 * Fix C: collect-orchestrator-usage.mjs prices every assistant message in the
 * window on its own model, its own day and its own speed / service_tier /
 * inference_geo, from the dated price list, with that message's own 5-minute /
 * 1-hour cache-write split. It used to price every token at one rate (the
 * policy's derived driver model), so a session on one model with helpers on
 * another was charged at the wrong price.
 *
 * T4 uses a token-only copy of a real run (tools/test/fixtures/
 * fable-session-opus-helpers): a Claude Fable 5.1 session with Claude Opus 5
 * helpers. The single rate charged it $12.577352; per message it is
 * $13.933431.
 *
 * The collector's window, message dedupe, synthetic exclusion and in-session
 * subtraction are unchanged and pinned by collectOrchestratorUsage.test.mjs.
 * Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeCostUsd, round6 } from "../dist/pricing.js";
import * as pricesMod from "../dist/prices.js";
import * as effectiveMod from "../dist/effectivePrice.js";
import * as pricingMod from "../dist/pricing.js";
import { priceClaudeCliResult, readWorkerTranscript } from "../dist/adapters/claudeCliLedger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const REPO = join(HERE, "..", "..", "..", "..");
const FABLE = join(REPO, "tools", "test", "fixtures", "fable-session-opus-helpers");
const RECEIVABLES = join(REPO, "tools", "test", "fixtures", "receivables-ops");
const ENV = { ...process.env, MMO_SELECT: "" };
const helpers = () => import(pathToFileURL(SCRIPT).href);
const { lookupPrice, ANTHROPIC_PRICING_URL, PRICE_LIST_VERIFIED } = pricesMod;

const exec = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: ENV });
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const readLines = (p) => readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** List rates for a model on a day, with the modifiers Claude Code records. */
function listRates(model, day, modifiers = { speed: "standard", service_tier: "standard", inference_geo: "not_available" }) {
  const r = lookupPrice(model, day, modifiers);
  assert.equal(r.unpriced, false, `${model} on ${day} must be on the list: ${r.reason}`);
  return r;
}
/** computeCostUsd takes the 5-minute bucket as `input_cache_write`. */
const cost = (t, rates) =>
  computeCostUsd({ input: t.input, input_cached: t.input_cached, output: t.output, input_cache_write: t.input_cache_write_5m, input_cache_write_1h: t.input_cache_write_1h }, rates);

// ── T4: a Fable 5.1 session with Opus 5 helpers ─────────────────────────────

const FABLE_SESSION_TOKENS = { input: 874, input_cached: 2_785_324, input_cache_write_5m: 0, input_cache_write_1h: 147_929, output: 22_750 };
const OPUS_HELPER_TOKENS = { input: 204, input_cached: 4_968_432, input_cache_write_5m: 544_883, input_cache_write_1h: 0, output: 129_661 };

test("T4 arithmetic: per model the fixture costs $13.933431; one Opus rate for every token gives $12.577352", () => {
  const fable = listRates("claude-fable-5-1", "2026-09-08");
  const opus5 = listRates("claude-opus-5", "2026-09-08");
  assert.equal(cost(FABLE_SESSION_TOKENS, fable.pricing), 4.801151);
  assert.equal(cost(OPUS_HELPER_TOKENS, opus5.pricing), 9.13228);
  assert.equal(round6(4.801151 + 9.13228), 13.933431);
  // The single rate the collector used before: the policy's derived driver
  // (opus-plus-flash -> claude-opus-4-7) applied to both models' tokens.
  const opus47 = listRates("claude-opus-4-7", "2026-09-08").pricing;
  const all = Object.fromEntries(Object.keys(FABLE_SESSION_TOKENS).map((k) => [k, FABLE_SESSION_TOKENS[k] + OPUS_HELPER_TOKENS[k]]));
  assert.equal(cost(all, opus47), 12.577352);
});

test("T4: a Fable 5.1 session with Opus 5 helpers is priced per message: $13.933431, one entry per model and role", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-permodel-fable-"));
  try {
    cpSync(FABLE, root, { recursive: true });
    const r = exec([root, "--project-root", root, "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /counted 133 unique API message\(s\)/);
    assert.match(r.stdout, /= \$13\.933431 \[transcript \(no receipt; unverified\)\]/);
    assert.doesNotMatch(r.stdout, /12\.577352/, "the single-rate figure must be gone");
    assert.doesNotMatch(r.stderr, /assume a single rate/, "the single-rate warning is removed");
    assert.match(r.stdout, /session claude-fable-5-1 .*= \$4\.801151/);
    assert.match(r.stdout, /helper {2}claude-opus-5 .*= \$9\.13228\b/);

    const fable = listRates("claude-fable-5-1", "2026-09-08");
    const opus5 = listRates("claude-opus-5", "2026-09-08");
    const period = { from: "2026-01-01", to: null, source_url: ANTHROPIC_PRICING_URL, verified: PRICE_LIST_VERIFIED };
    const m = readJson(join(root, "manifest.json"));
    const o = m.orchestrator_overhead;
    assert.deepEqual(o.per_model, [
      {
        model: "claude-fable-5-1",
        role: "session",
        reported_as: ["claude-fable-5-1"],
        price_basis: "list",
        price_period: period,
        applied_modifiers: { speed: "standard", service_tier: "standard", inference_geo: "not_available", multiplier: 1, defaulted: [] },
        rates: fable.pricing,
        messages: 31,
        tokens: FABLE_SESSION_TOKENS,
        cost_usd: 4.801151,
      },
      {
        model: "claude-opus-5",
        role: "helper",
        reported_as: ["claude-opus-5"],
        price_basis: "list",
        price_period: period,
        // 12 helper messages were cut off before their terminal line, and no
        // line of theirs records `speed`: the API default applies and is named.
        applied_modifiers: { speed: "standard", service_tier: "standard", inference_geo: "not_available", multiplier: 1, defaulted: ["speed"] },
        rates: opus5.pricing,
        messages: 102,
        tokens: OPUS_HELPER_TOKENS,
        cost_usd: 9.13228,
      },
    ]);
    assert.deepEqual(o.unpriced, []);
    assert.equal(o.pricing_complete, true);
    assert.equal(o.price_list_verified, PRICE_LIST_VERIFIED);
    assert.equal(o.cost_usd, 13.933431);
    assert.equal(o.transcript_cost_usd, 13.933431);
    assert.equal(round6(o.per_model.reduce((s, e) => s + e.cost_usd, 0)), o.cost_usd, "the figure is the sum of the per-model costs");
    // Existing fields keep their meaning: totals across every model.
    assert.equal(o.input_tokens, 1078);
    assert.equal(o.input_tokens_cached, 7_753_756);
    assert.equal(o.input_tokens_cache_write, 692_812);
    assert.equal(o.input_tokens_cache_write_1h, 147_929);
    assert.equal(o.output_tokens, 152_411);
    assert.equal(m.true_total_cost_usd, 13.933431);
    // All five helpers are named by an Agent result, as in the real session: the
    // session file names three in toolUseResult.agentId, and helper
    // a7de90a49669913e0 names a2c641503e98ecc4c and a3e06ad488f47acef in its
    // result text (lines 125 and 133 of its real transcript). The fixture had
    // lost those two text lines, so attribution read INCOMPLETE on a complete tree.
    assert.match(r.stdout, /helpers: 5 named by Agent\/Task results, 5 transcript file\(s\) → attribution complete/);
    assert.equal(o.attribution_complete, true);
    assert.deepEqual(o.missing_helper_ids, []);
    assert.deepEqual(o.unreferenced_helper_files, []);

    const event = readLines(join(root, "telemetry.jsonl")).find((e) => e.tier === "orchestrator");
    assert.equal(event.cost_usd, 13.933431);
    assert.deepEqual(event.per_model, o.per_model);
    assert.deepEqual(event.unpriced, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Regression: single-priced real runs keep their dollars ──────────────────

test("regression: receivables pass1 (Opus 5 only, no receipt) is still $16.152465, now as one per-model entry", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-permodel-pass1-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl"]) writeFileSync(join(passDir, f), readFileSync(join(RECEIVABLES, "pass1", f)));
    const r = exec([passDir, "--project-root", RECEIVABLES, "--policy-path", join(RECEIVABLES, "policies", "receivables-premium.yaml"), "--transcripts-dir", join(RECEIVABLES, "pass1", "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = readJson(join(passDir, "manifest.json")).orchestrator_overhead;
    assert.equal(o.cost_usd, 16.152465);
    assert.equal(o.per_model.length, 1);
    assert.deepEqual([o.per_model[0].model, o.per_model[0].role, o.per_model[0].price_basis, o.per_model[0].cost_usd], ["claude-opus-5", "session", "list", 16.152465]);
    assert.deepEqual(o.per_model[0].tokens, { input: 158, input_cached: 15_843_890, input_cache_write_5m: 0, input_cache_write_1h: 355_943, output: 186_812 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("regression: receivables pass3 (Gemini-only policy) now carries a transcript figure, and it equals the receipt to the micro-dollar", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-permodel-pass3-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl", "claude-session.json"]) writeFileSync(join(passDir, f), readFileSync(join(RECEIVABLES, "pass3", f)));
    const r = exec([passDir, "--project-root", RECEIVABLES, "--policy-path", join(RECEIVABLES, "policies", "receivables-floor.yaml"), "--transcripts-dir", join(RECEIVABLES, "pass3", "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = readJson(join(passDir, "manifest.json"));
    const o = m.orchestrator_overhead;
    // Before per-message pricing a policy with no Claude rate left the transcript unpriced (null).
    assert.equal(o.transcript_cost_usd, 16.235409);
    assert.equal(o.receipt_cost_usd, 16.235409);
    // Fix D (collectReceiptBooking.test.mjs): an equal transcript books the receipt's token counts at the
    // list, which here equal Claude Code's own $16.235409; nothing was billed beyond the log.
    assert.equal(o.cost_source, "receipt (Anthropic token counts priced at the price list); 0.0% billed but not logged");
    assert.equal(o.unlogged_billed.cost_usd, 0);
    assert.equal(o.receipt_cli_usd, 16.235409);
    assert.equal(o.cost_usd, 16.235409);
    assert.equal(m.true_total_cost_usd, 22.311708);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Unit pins on the exported helpers ───────────────────────────────────────

const SONNET_DAY = "2026-09-10";
const aLine = (id, model, usage, { ts = `${SONNET_DAY}T10:00:00.000Z`, stop = "end_turn" } = {}) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, stop_reason: stop, usage } });

/** Session file + one subagent file; returns { dir, files }. */
function tree(sessionLines, helperLines) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-permodel-unit-"));
  const sub = join(dir, "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(dir, "sess.jsonl"), sessionLines.join("\n") + "\n");
  writeFileSync(join(sub, "agent-x.jsonl"), helperLines.join("\n") + "\n");
  return { dir, files: [join(dir, "sess.jsonl"), join(sub, "agent-x.jsonl")] };
}

test("roleOfTranscript: files under a subagents/ directory are helpers, everything else is the session", async () => {
  const { roleOfTranscript } = await helpers();
  assert.equal(roleOfTranscript("/t", "/t/abc.jsonl"), "session");
  assert.equal(roleOfTranscript("/t", "/t/abc/subagents/agent-1.jsonl"), "helper");
  assert.equal(roleOfTranscript("/t", "/t/abc/subagents/workflows/wf/agent-2.jsonl"), "helper");
  assert.equal(roleOfTranscript("/t", "/t/subagents/top.jsonl"), "helper");
  // A `subagents` directory above the transcript root says nothing about the file.
  assert.equal(roleOfTranscript("/x/subagents/t", "/x/subagents/t/abc.jsonl"), "session");
});

test("each message is priced on its own model, cache-write split and speed — the speed recorded only on a message's terminal line still counts", async () => {
  const { sumTranscriptUsage, priceMessages, makeMessagePricer, roleOfTranscript } = await helpers();
  const { dir, files } = tree(
    [
      // Sonnet 5 session message streamed as two lines; only the terminal line records speed.
      aLine("s1", "claude-sonnet-5", { input_tokens: 1000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 300_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 200_000 }, output_tokens: 3, service_tier: "standard", inference_geo: "not_available" }, { stop: null }),
      aLine("s1", "claude-sonnet-5", { input_tokens: 1000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 300_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 200_000 }, output_tokens: 5000, service_tier: "standard", speed: "standard", inference_geo: "not_available" }),
    ],
    [
      // An Opus 4.8 helper in fast mode: the first line has no speed, the terminal line says fast.
      aLine("h1", "claude-opus-4-8", { input_tokens: 10_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1, service_tier: "standard", inference_geo: "not_available" }, { stop: null }),
      aLine("h1", "claude-opus-4-8", { input_tokens: 10_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 20_000, service_tier: "standard", speed: "fast", inference_geo: "not_available" }),
      aLine("h2", "claude-opus-4-8", { input_tokens: 100, output_tokens: 1000, service_tier: "standard", speed: "standard", inference_geo: "not_available" }),
    ],
  );
  try {
    const usage = sumTranscriptUsage(files, 0, Number.POSITIVE_INFINITY, { roleOf: (f) => roleOfTranscript(dir, f) });
    assert.equal(usage.messages.length, 3);
    const pricer = makeMessagePricer({ models: [] }, { pricesMod, effectiveMod, pricingMod });
    const priced = priceMessages(usage.messages, pricer);

    const sonnet = lookupPrice("claude-sonnet-5", SONNET_DAY, { speed: "standard", service_tier: "standard", inference_geo: "not_available" });
    const fast = lookupPrice("claude-opus-4-8", SONNET_DAY, { speed: "fast", service_tier: "standard", inference_geo: "not_available" });
    const opus48 = lookupPrice("claude-opus-4-8", SONNET_DAY, { speed: "standard", service_tier: "standard", inference_geo: "not_available" });
    // Hand check of the list: Sonnet 5 2/0.2/2.5/4/10; Opus 4.8 fast 10/1/12.5/20/50.
    assert.deepEqual(sonnet.pricing, { input: 2, input_cached: 0.2, input_cache_write: 2.5, input_cache_write_1h: 4, output: 10 });
    assert.deepEqual(fast.pricing, { input: 10, input_cached: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 });

    const byKey = Object.fromEntries(priced.per_model.map((e) => [`${e.role}/${e.model}/${e.applied_modifiers.speed}`, e]));
    assert.deepEqual(Object.keys(byKey).sort(), ["helper/claude-opus-4-8/fast", "helper/claude-opus-4-8/standard", "session/claude-sonnet-5/standard"]);
    const s = byKey["session/claude-sonnet-5/standard"];
    assert.deepEqual(s.tokens, { input: 1000, input_cached: 2_000_000, input_cache_write_5m: 100_000, input_cache_write_1h: 200_000, output: 5000 });
    assert.equal(s.cost_usd, 1.502); // 0.002 + 0.4 + 0.25 + 0.8 + 0.05
    assert.equal(byKey["helper/claude-opus-4-8/fast"].cost_usd, 2.725); // 0.1 + 1.0 + 0.625 + 1.0
    assert.deepEqual(byKey["helper/claude-opus-4-8/fast"].rates, fast.pricing);
    assert.equal(byKey["helper/claude-opus-4-8/standard"].cost_usd, 0.0255);
    assert.deepEqual(byKey["helper/claude-opus-4-8/standard"].rates, opus48.pricing);
    assert.equal(priced.cost_usd, 4.2525);
    assert.deepEqual(priced.unpriced, []);
    assert.equal(priced.complete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tokens the list cannot price are listed with the reason and left out of the figure — never borrowed from a similar model", async () => {
  const { sumTranscriptUsage, priceMessages, makeMessagePricer, roleOfTranscript } = await helpers();
  const { dir, files } = tree(
    [
      aLine("ok", "claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0, speed: "standard", service_tier: "standard", inference_geo: "not_available" }),
      aLine("unknown", "claude-opus-5-9", { input_tokens: 400, output_tokens: 600 }),
      JSON.stringify({ type: "assistant", message: { id: "no-ts", model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } } }),
      aLine("too-early", "claude-opus-5", { input_tokens: 11, output_tokens: 1 }, { ts: "2025-12-31T23:59:59.000Z" }),
      aLine("geo", "claude-opus-5", { input_tokens: 20, output_tokens: 2, inference_geo: "eu" }),
    ],
    [
      // Two lines of one message disagree on speed: no single price is provable.
      aLine("split", "claude-opus-4-8", { input_tokens: 30, output_tokens: 1, speed: "standard" }, { stop: null }),
      aLine("split", "claude-opus-4-8", { input_tokens: 30, output_tokens: 9, speed: "fast" }),
      JSON.stringify({ type: "assistant", timestamp: `${SONNET_DAY}T10:00:00.000Z`, message: { id: "nomodel", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } } }),
    ],
  );
  try {
    const usage = sumTranscriptUsage(files, 0, Number.POSITIVE_INFINITY, { roleOf: (f) => roleOfTranscript(dir, f) });
    const priced = priceMessages(usage.messages, makeMessagePricer({ models: [] }, { pricesMod, effectiveMod, pricingMod }));
    assert.equal(priced.per_model.length, 1);
    assert.equal(priced.cost_usd, 5); // 1M Opus 5 input at $5
    assert.equal(priced.complete, false);
    const reasons = Object.fromEntries(priced.unpriced.map((u) => [`${u.role}/${u.model}`, u]));
    assert.match(reasons["session/claude-opus-5-9"].reason, /unknown model "claude-opus-5-9"/);
    assert.deepEqual(reasons["session/claude-opus-5-9"].tokens, { input: 400, input_cached: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 600 });
    assert.equal(reasons["session/claude-opus-5-9"].messages, 1);
    const opus5 = priced.unpriced.filter((u) => u.role === "session" && u.model === "claude-opus-5").map((u) => u.reason);
    assert.equal(opus5.length, 3);
    assert.ok(opus5.some((x) => /no timestamp/.test(x)), opus5.join(" | "));
    assert.ok(opus5.some((x) => /no price period for claude-opus-5 on 2025-12-31/.test(x)), opus5.join(" | "));
    assert.ok(opus5.some((x) => /inference_geo "eu"/.test(x)), opus5.join(" | "));
    assert.match(reasons["helper/claude-opus-4-8"].reason, /disagree on speed/);
    assert.deepEqual(reasons["helper/claude-opus-4-8"].tokens.output, 9, "the terminal line's output is what the message billed");
    assert.match(reasons["helper/(unlabeled)"].reason, /no model name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a policy price applies to a transcript model only under pricing_override: true (labelled custom); a differing block without it is ignored with a note; two different custom prices for one model price nothing", async () => {
  const { priceMessages, makeMessagePricer } = await helpers();
  const msg = (model) => ({ model, role: "session", timestamp: `${SONNET_DAY}T10:00:00.000Z`, modifiers: { speed: "standard", service_tier: "standard", inference_geo: "not_available" }, conflicts: [], tokens: { input: 1_000_000, input_cached: 0, input_cache_write_5m: 400_000, input_cache_write_1h: 0, output: 100_000 } });
  const block = { input: 1, input_cached: 0.1, output: 5 };

  const custom = makeMessagePricer({ models: [{ id: "drv", adapter: "builtin-anthropic", model_name: "claude-opus-4-8", pricing: block, pricing_override: true }] }, { pricesMod, effectiveMod, pricingMod });
  const c = priceMessages([msg("claude-opus-4-8")], custom);
  assert.deepEqual([c.per_model[0].price_basis, c.per_model[0].price_period, c.per_model[0].applied_modifiers], ["custom", null, null]);
  assert.equal(c.cost_usd, 2); // 1 + 0.5 (400k at the 1.25x fallback) + 0.5
  assert.deepEqual(c.custom_models, ["claude-opus-4-8"]);

  const ignored = makeMessagePricer({ models: [{ id: "drv", adapter: "builtin-anthropic", model_name: "claude-opus-4-8", pricing: block }] }, { pricesMod, effectiveMod, pricingMod });
  const l = priceMessages([msg("claude-opus-4-8")], ignored);
  assert.equal(l.per_model[0].price_basis, "list");
  assert.equal(l.cost_usd, 10); // 5 + 2.5 + 2.5 at the list
  assert.equal(ignored.warnings.length, 1);
  assert.match(ignored.warnings[0], /differs .* from the price list/);

  const conflicting = makeMessagePricer({ models: [
    { id: "a", adapter: "builtin-anthropic", model_name: "claude-opus-4-8", pricing: block, pricing_override: true },
    { id: "b", adapter: "claude-cli", model_name: "claude-opus-4-8", pricing: { ...block, output: 6 }, pricing_override: true },
  ] }, { pricesMod, effectiveMod, pricingMod });
  const x = priceMessages([msg("claude-opus-4-8")], conflicting);
  assert.equal(x.per_model.length, 0);
  assert.match(x.unpriced[0].reason, /different custom prices/);
});

// ── End to end: unpriced tokens, --strict-pricing, and the in-session invariant ──

const T0 = "2026-09-10T10:00:00.000Z", T1 = "2026-09-10T10:05:00.000Z", T2 = "2026-09-10T10:10:00.000Z";

function mkRun({ policy, manifest, telemetry, transcripts }) {
  const root = mkdtempSync(join(tmpdir(), "mmo-permodel-e2e-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts"); mkdirSync(tDir);
  writeFileSync(join(root, "policy.yaml"), policy);
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(passDir, "telemetry.jsonl"), telemetry.map((e) => JSON.stringify(e)).join("\n") + (telemetry.length ? "\n" : ""));
  for (const [name, lines] of Object.entries(transcripts)) {
    mkdirSync(dirname(join(tDir, name)), { recursive: true });
    writeFileSync(join(tDir, name), lines.join("\n") + "\n");
  }
  const run = (extra = []) => exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir, ...extra]);
  return { root, passDir, tDir, run, rm: () => rmSync(root, { recursive: true, force: true }) };
}

const OPUS_ONLY_POLICY = `
version: 1
name: opus-only-list
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: driver
`;

test("an unpriced model in the window: the figure is written and labelled INCOMPLETE; --strict-pricing refuses with exit 1 and writes nothing", () => {
  const make = () => mkRun({
    policy: OPUS_ONLY_POLICY,
    manifest: { pass: "p", policy_name: "opus-only-list", started_at: T0, ended_at: T2, totals: { dispatched_cost_usd: 0, models_used: [] } },
    telemetry: [],
    transcripts: { "s.jsonl": [
      aLine("a", "claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 }, { ts: T1 }),
      aLine("b", "claude-opus-5-9", { input_tokens: 400, output_tokens: 600 }, { ts: T1 }),
    ] },
  });
  const strict = make();
  const loose = make();
  try {
    const r = strict.run(["--strict-pricing"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--strict-pricing/);
    assert.match(r.stderr, /claude-opus-5-9/);
    assert.equal(readJson(join(strict.passDir, "manifest.json")).orchestrator_overhead, undefined);
    assert.equal(readFileSync(join(strict.passDir, "telemetry.jsonl"), "utf-8"), "");

    const r2 = loose.run();
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /WARNING: .*could not be priced/);
    const o = readJson(join(loose.passDir, "manifest.json")).orchestrator_overhead;
    assert.equal(o.cost_usd, 5);
    assert.equal(o.pricing_complete, false);
    assert.match(o.cost_source, /INCOMPLETE/);
    assert.equal(o.unpriced.length, 1);
    assert.equal(o.unpriced[0].model, "claude-opus-5-9");
    assert.equal(o.unpriced[0].role, "session");
    assert.match(o.unpriced[0].reason, /unknown model/);
    assert.deepEqual(o.unpriced[0].tokens, { input: 400, input_cached: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 600 });
  } finally { strict.rm(); loose.rm(); }
});

test("in-session invariant: a claude-cli worker event priced from its ledger equals its transcript's per-model entry, so subtracting it leaves the true total transcript-priced", () => {
  const ts = "2026-09-10T10:05:00.000Z";
  const workerUsage = (out, stop) => ({ input_tokens: 40, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 12_000, cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 10_000 }, output_tokens: out, service_tier: "standard", speed: "standard", inference_geo: "not_available" });
  const wLine = (id, out, stop = "end_turn") => JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "wrk-1", message: { id, model: "claude-sonnet-5", stop_reason: stop, usage: workerUsage(out, stop) } });
  const workerLines = [wLine("w1", 700), wLine("w2", 300)];
  // Review findings M1 / R1: a second worker, on a fast-capable model, whose one
  // message is streamed as two lines and records `speed: "fast"` only on its
  // stop_reason line (the shape Claude Code writes). The ledger read modifiers
  // from the first line only and priced it standard; the collector merges every
  // line and prices it fast. The two must agree to the micro-dollar, or the
  // in-session subtraction removes a different figure from the one the scan added.
  const fastUsage = (out, extra) => ({ input_tokens: 25, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 30_000, cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 0 }, output_tokens: out, service_tier: "standard", inference_geo: "not_available", ...extra });
  const fastLine = (out, stop, extra = {}) => JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "wrk-2", message: { id: "f1", model: "claude-opus-4-8", stop_reason: stop, usage: fastUsage(out, extra) } });
  const fastLines = [fastLine(2, null), fastLine(4_000, "end_turn", { speed: "fast" })];
  // The M4 worker's one logged message (its result bills more; see below).
  const shortLines = [JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "wrk-3", message: { id: "s1", model: "claude-sonnet-4-6", stop_reason: "end_turn", usage: { input_tokens: 100, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 2_000, service_tier: "standard", speed: "standard", inference_geo: "not_available" } } })];
  const policy = `
version: 1
name: cli-invariant
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: worker
    adapter: claude-cli
    model_name: claude-sonnet-5
  - id: fast-worker
    adapter: claude-cli
    model_name: claude-opus-4-8
  - id: short-worker
    adapter: claude-cli
    model_name: claude-sonnet-4-6
  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.5-flash
rules:
  - when: { phase: codegen }
    use: worker
  - when: { phase: tests }
    use: fast-worker
  - when: { phase: docs }
    use: flash
  - default: driver
`;
  // What ClaudeCliAdapter books for each worker call: its modelUsage tokens
  // priced from the list, TTL split and modifiers read from the worker's own transcript.
  const scratch = mkdtempSync(join(tmpdir(), "mmo-permodel-ledger-"));
  let workerCost;
  let workerLedger;
  let fastLedger;
  let shortLedger;
  try {
    const wf = join(scratch, "wrk-1.jsonl");
    writeFileSync(wf, workerLines.join("\n") + "\n");
    const ledger = priceClaudeCliResult(
      { session_id: "wrk-1", total_cost_usd: 0.1, usage: {}, modelUsage: { "claude-sonnet-5": { inputTokens: 80, cacheReadInputTokens: 180_000, cacheCreationInputTokens: 24_000, outputTokens: 1000, costUSD: 0.1 } } },
      { config: { id: "worker", adapter: "claude-cli", model_name: "claude-sonnet-5" }, date: new Date(ts), transcript: readWorkerTranscript([wf], "wrk-1") },
    );
    assert.deepEqual(ledger.unpriced_models, []);
    workerCost = ledger.cost_usd;
    workerLedger = ledger;
    const ff = join(scratch, "wrk-2.jsonl");
    writeFileSync(ff, fastLines.join("\n") + "\n");
    fastLedger = priceClaudeCliResult(
      { session_id: "wrk-2", total_cost_usd: 0.9, usage: {}, modelUsage: { "claude-opus-4-8": { inputTokens: 25, cacheReadInputTokens: 400_000, cacheCreationInputTokens: 30_000, outputTokens: 4_000, costUSD: 0.9 } } },
      { config: { id: "fast-worker", adapter: "claude-cli", model_name: "claude-opus-4-8" }, date: new Date(ts), transcript: readWorkerTranscript([ff], "wrk-2") },
    );
    assert.deepEqual(fastLedger.unpriced_models, []);
    // 25 x $10 + 400,000 x $1 + 30,000 x $12.50 + 4,000 x $50, per 1M, at the fast rates.
    assert.equal(fastLedger.cost_usd, 0.97525);
    // Review finding M4: a third worker whose result bills MORE than its
    // transcript logs. Its Sonnet 4.6 modelUsage is 150 / 300,000 / 15,000 /
    // 3,000 against a logged 100 / 200,000 / 10,000 (5-minute) / 2,000, and it
    // made a Haiku side call no transcript records. The ledger books all of it
    // ($0.19170 Sonnet 4.6 + $0.001003 Haiku); only the logged $0.1278 is inside
    // the collector's scan. Subtracting the whole ledger took the unlogged
    // $0.064903 out of the true total.
    const sf = join(scratch, "wrk-3.jsonl");
    writeFileSync(sf, shortLines.join("\n") + "\n");
    shortLedger = priceClaudeCliResult(
      {
        session_id: "wrk-3",
        total_cost_usd: 0.192703,
        usage: {},
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 150, cacheReadInputTokens: 300_000, cacheCreationInputTokens: 15_000, outputTokens: 3_000, costUSD: 0.1917 },
          "claude-haiku-4-5-20251001": { inputTokens: 928, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 15, costUSD: 0.001003 },
        },
      },
      { config: { id: "short-worker", adapter: "claude-cli", model_name: "claude-sonnet-4-6" }, date: new Date(ts), transcript: readWorkerTranscript([sf], "wrk-3") },
    );
    assert.deepEqual(shortLedger.unpriced_models, []);
    assert.equal(shortLedger.cost_usd, 0.192703);
    // 100 x $3 + 200,000 x $0.30 + 10,000 x $3.75 + 2,000 x $15, per 1M: what the transcript explains.
    assert.equal(shortLedger.transcript_logged_cost_usd, 0.1278);
    assert.equal(workerLedger.transcript_logged_cost_usd, workerCost, "a worker whose transcript explains every billed token: the logged share is the whole cost");
    assert.equal(fastLedger.transcript_logged_cost_usd, fastLedger.cost_usd);
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  const flashCost = 0.25;
  const shortUnlogged = round6(shortLedger.cost_usd - shortLedger.transcript_logged_cost_usd);
  const fix = mkRun({
    policy,
    manifest: { pass: "p", policy_name: "cli-invariant", started_at: T0, ended_at: T2, totals: { dispatched_cost_usd: round6(workerCost + fastLedger.cost_usd + shortLedger.cost_usd + flashCost), models_used: ["claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6", "gemini-3.5-flash"] } },
    // Each claude-cli event carries what ClaudeCliAdapter writes: cost_usd and the ledger's transcript_logged_cost_usd.
    telemetry: [
      { ts, pass: "p", phase: "codegen", model: "claude-sonnet-5", model_id: "worker", provenance: "vendor", cost_usd: workerCost, transcript_logged_cost_usd: workerLedger.transcript_logged_cost_usd },
      { ts, pass: "p", phase: "tests", model: "claude-opus-4-8", model_id: "fast-worker", provenance: "vendor", cost_usd: fastLedger.cost_usd, transcript_logged_cost_usd: fastLedger.transcript_logged_cost_usd },
      { ts, pass: "p", phase: "review", model: "claude-sonnet-4-6", model_id: "short-worker", provenance: "vendor", cost_usd: shortLedger.cost_usd, transcript_logged_cost_usd: shortLedger.transcript_logged_cost_usd },
      { ts, pass: "p", phase: "docs", model: "gemini-3.5-flash", model_id: "flash", provenance: "vendor", cost_usd: flashCost },
    ],
    transcripts: {
      "drv-1.jsonl": [JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "drv-1", message: { id: "d1", model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 }, output_tokens: 2_000, service_tier: "standard", speed: "standard", inference_geo: "not_available" } } })],
      "wrk-1.jsonl": workerLines,
      "wrk-2.jsonl": fastLines,
      "wrk-3.jsonl": shortLines,
    },
  });
  try {
    // The driver entry has no pricing block: the collector must still price it (from the list).
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = readJson(join(fix.passDir, "manifest.json"));
    const o = m.orchestrator_overhead;
    const worker = o.per_model.find((e) => e.model === "claude-sonnet-5");
    const fastWorker = o.per_model.find((e) => e.model === "claude-opus-4-8");
    const driver = o.per_model.find((e) => e.model === "claude-opus-5");
    assert.ok(worker && fastWorker && driver, JSON.stringify(o.per_model));
    assert.equal(worker.cost_usd, workerCost, "the ledger and the collector price the worker's tokens identically");
    assert.equal(fastWorker.applied_modifiers.speed, "fast");
    assert.equal(fastLedger.cost_usd, fastWorker.cost_usd, "a speed recorded only on the terminal line prices the same in the ledger and the collector");
    const shortWorker = o.per_model.find((e) => e.model === "claude-sonnet-4-6");
    assert.ok(shortWorker, JSON.stringify(o.per_model));
    assert.equal(shortWorker.cost_usd, shortLedger.transcript_logged_cost_usd, "the logged share is what the scan added for that worker");
    // Only each worker's logged share is inside the scan, so only that is subtracted.
    assert.equal(o.dispatched_in_session_cost_usd, round6(workerCost + fastLedger.cost_usd + shortLedger.transcript_logged_cost_usd));
    assert.equal(o.dispatched_in_session_events, 3);
    assert.equal(o.cost_usd, round6(worker.cost_usd + fastWorker.cost_usd + shortWorker.cost_usd + driver.cost_usd));
    // true total = dispatched − in-session + overhead = the Gemini call + every transcript message at the list
    // + what a worker's result billed that its transcript never logged (M4: the Haiku side call and the short tokens).
    assert.equal(shortUnlogged, 0.064903);
    assert.equal(m.true_total_cost_usd, round6(flashCost + o.cost_usd + shortUnlogged));
  } finally { fix.rm(); }
});
