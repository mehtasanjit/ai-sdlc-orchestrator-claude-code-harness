/**
 * Pins for the cache-write pricing bucket (src/pricing.ts) and its plumbing
 * through the compiled adapters and server (dist/). Before this bucket
 * existed, cache_creation_input_tokens was folded into fresh `input` and
 * priced at the base input rate — a systematic undercount, since Anthropic
 * bills cache writes at a premium (1.25× fresh input). These tests pin BOTH
 * directions: the new bucket prices at the premium, and the old three-bucket
 * call sites keep producing byte-identical dollars.
 *
 * Imports from dist/ (this suite runs via `npm run build && node --test`,
 * so dist is guaranteed fresh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { computeCostUsd, CACHE_WRITE_PREMIUM } from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");

const PRICING = { input: 1, input_cached: 0.1, output: 5 };

test("three-bucket calls (no cache-write field) price exactly as before the bucket existed", () => {
  // 1M fresh + 2M cached + 100k out @ the rates above:
  // 1×1 + 2×0.1 + 0.1×5 = 1.70 — the historical figure, unchanged.
  const cost = computeCostUsd({ input: 1_000_000, input_cached: 2_000_000, output: 100_000 }, PRICING);
  assert.equal(cost, 1.7);
});

test("the cache-write bucket defaults to the 1.25× premium over fresh input", () => {
  assert.equal(CACHE_WRITE_PREMIUM, 1.25);
  // 400k cache-write @ 1×1.25 adds exactly $0.50 to the three-bucket figure.
  const cost = computeCostUsd(
    { input: 1_000_000, input_cached: 2_000_000, input_cache_write: 400_000, output: 100_000 },
    PRICING
  );
  assert.equal(cost, 2.2);
});

test("an explicit per-model cache-write rate wins over the premium fallback", () => {
  const cost = computeCostUsd(
    { input: 0, input_cached: 0, input_cache_write: 1_000_000, output: 0 },
    { ...PRICING, input_cache_write: 3 }
  );
  assert.equal(cost, 3);
});

test("an explicit zero cache-write rate is honored, not treated as unset", () => {
  // `?? ` semantics: 0 is a real rate (a vendor that doesn't bill cache
  // writes), and must not fall through to input × 1.25.
  const cost = computeCostUsd(
    { input: 0, input_cached: 0, input_cache_write: 1_000_000, output: 0 },
    { ...PRICING, input_cache_write: 0 }
  );
  assert.equal(cost, 0);
});

// ── plumbing pins (compiled output) ─────────────────────────────────────
// The bucket is only honest if the adapters SPLIT cache-creation out of
// fresh input and the server carries the bucket into telemetry. Exercising
// the adapters end-to-end needs a live vendor client, so these pin the
// compiled source instead — cheap, offline, and they fail loudly if the
// unbundling or the telemetry field is ever dropped.

test("BuiltinAnthropicAdapter buckets cache_creation_input_tokens separately (not folded into input)", () => {
  const src = readFileSync(join(DIST, "adapters", "BuiltinAnthropicAdapter.js"), "utf-8");
  assert.match(src, /input_cache_write:\s*usage\?\.cache_creation_input_tokens \?\? 0/);
  // The old folding — input + cache_creation summed into one bucket — must not come back.
  assert.doesNotMatch(src, /input_tokens[^\n]*\+[^\n]*cache_creation_input_tokens/);
});

// Changed pin (v0.7.3): this test used to require that ClaudeCliAdapter copy
// `total_cost_usd` into cost verbatim. That figure is Claude Code's own price
// table (stale on 2026-08-24: Opus at 0.6x), so the worker is now priced from
// its token ledger (claudeCliLedger.ts) and the CLI figure is only a check.
// Behaviour is pinned in claudeCliPricing.test.mjs; this pins the wiring.
test("ClaudeCliAdapter prices from its ledger and keeps the CLI's figure only beside the cost", () => {
  const src = readFileSync(join(DIST, "adapters", "ClaudeCliAdapter.js"), "utf-8");
  assert.match(src, /priceClaudeCliResult\(/);
  assert.match(src, /cli_reported_cost_usd/);
  assert.doesNotMatch(src, /response\.total_cost_usd \?\? 0/, "the CLI's dollars must never become the cost again");
  const ledger = readFileSync(join(DIST, "adapters", "claudeCliLedger.js"), "utf-8");
  assert.match(ledger, /cacheCreationInputTokens/, "cache writes are read per model from modelUsage");
});

test("the server maps the bucket into telemetry events: the total written, plus the 1-hour share", async () => {
  const src = readFileSync(join(DIST, "server.js"), "utf-8");
  assert.match(src, /\.\.\.cacheWriteBuckets\(att\.tokens\)/);
  const { cacheWriteBuckets } = await import("../dist/telemetry.js");
  assert.deepEqual(cacheWriteBuckets({}), {}, "Gemini attempts carry no cache-write field, so their events gain none");
  assert.deepEqual(cacheWriteBuckets({ input_cache_write: 3000 }), { input_tokens_cache_write: 3000 }, "API attempts are unchanged");
  assert.deepEqual(
    cacheWriteBuckets({ input_cache_write: 12202, input_cache_write_1h: 8837 }),
    { input_tokens_cache_write: 21039, input_tokens_cache_write_1h: 8837 },
    "a claude-cli attempt's disjoint buckets become the total and its 1-hour share",
  );
});
