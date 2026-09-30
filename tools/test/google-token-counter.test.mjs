/**
 * tools/google-token-counter.mjs: the sums it compares. No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { telemetryTotals, counterTotals } from "../google-token-counter.mjs";

test("telemetry totals: fresh + cached input and output for the model only, and the window they span", () => {
  const lines = [
    JSON.stringify({ ts: "2026-09-24T01:00:00Z", model: "gemini-3.8-flash", input_tokens: 100, input_tokens_cached: 50, output_tokens: 10 }),
    JSON.stringify({ ts: "2026-09-24T01:05:00Z", model: "gemini-3.8-flash", input_tokens: 200, input_tokens_cached: 0, output_tokens: 20 }),
    JSON.stringify({ ts: "2026-09-24T01:03:00Z", model: "claude-opus-5", input_tokens: 999, output_tokens: 999 }),
    JSON.stringify({ ts: "2026-09-24T01:04:00Z", model: "gemini-3.8-flash", tier: "orchestrator", input_tokens: 999, output_tokens: 999 }),
    "", "not json",
  ];
  const t = telemetryTotals(lines, "gemini-3.8-flash");
  assert.deepEqual({ input: t.input, output: t.output, events: t.events }, { input: 350, output: 30, events: 2 });
  assert.equal(new Date(t.first).toISOString(), "2026-09-24T01:00:00.000Z");
  assert.equal(new Date(t.last).toISOString(), "2026-09-24T01:05:00.000Z");
});

test("counter totals: input and output points for the model, other models ignored", () => {
  const series = [
    { metric: { labels: { type: "input" } }, resource: { labels: { model_user_id: "gemini-3.8-flash" } }, points: [{ value: { int64Value: "113" } }, { value: { int64Value: "444" } }] },
    { metric: { labels: { type: "output" } }, resource: { labels: { model_user_id: "gemini-3.8-flash" } }, points: [{ value: { int64Value: "217" } }] },
    { metric: { labels: { type: "input" } }, resource: { labels: { model_user_id: "gemini-2.5-flash" } }, points: [{ value: { int64Value: "9999" } }] },
  ];
  assert.deepEqual(counterTotals(series, "gemini-3.8-flash"), { input: 557, output: 217 });
  assert.deepEqual(counterTotals(undefined, "gemini-3.8-flash"), { input: 0, output: 0 });
});
