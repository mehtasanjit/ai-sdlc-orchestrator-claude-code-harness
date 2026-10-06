/**
 * buildManifest (telemetry.ts) and the run-start typist probe's events (phase "preflight"): pre-flight runs before the
 * orchestrator logs run.start, so a probe event never sets the run's start — the window and the collector's anchor
 * come from the first dispatched event — while its dollars stay in the run's spend. A probe event that names another
 * run (a halted pre-flight under another run id, in the same telemetry file) is that run's, not this one's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { buildManifest } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "telemetry.js"));

const ev = (over = {}) => ({
  ts: "2026-09-05T10:20:00.000Z", pass: "r1", phase: "codegen", task_type: "", task_id: "tp_1", module: "spec",
  model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor",
  input_tokens: 100, input_tokens_cached: 0, output_tokens: 10, cost_usd: 0.01, latency_ms: 1, success: true, ...over,
});
const probe = (over = {}) => ev({ ts: "2026-09-05T10:00:30.000Z", phase: "preflight", task_type: "typist_probe", task_id: "typist_probe_opus", model: "claude-opus-5", cost_usd: 0.04, ...over });

test("a pre-flight probe event never sets started_at; its cost still counts", () => {
  const m = buildManifest([probe(), ev(), ev({ ts: "2026-09-05T10:40:00.000Z", task_id: "tp_2" })], { pass: "r1", policy_name: "p" });
  assert.equal(m.started_at, "2026-09-05T10:20:00.000Z", "the first dispatched event, as the collector's anchor reads it");
  assert.equal(m.ended_at, "2026-09-05T10:40:00.000Z");
  assert.equal(m.duration_sec, 1200);
  assert.equal(m.total_cost_usd, 0.06);
  assert.equal(m.phase_breakdown.preflight.calls, 1);
});

test("a run with only pre-flight events still has a window", () => {
  const m = buildManifest([probe()], { pass: "r1", policy_name: "p" });
  assert.equal(m.started_at, "2026-09-05T10:00:30.000Z");
  assert.equal(m.total_cost_usd, 0.04);
});

test("a halted pre-flight's events under another run id stay out of this run's manifest", () => {
  const halted = [probe({ pass: "gf-run-1", ts: "2026-09-05T09:00:00.000Z" }), probe({ pass: "gf-run-1", ts: "2026-09-05T09:00:01.000Z", task_id: "typist_probe_flash", model: "gemini-3.8-flash", cost_usd: 0.0004 })];
  const own = [probe({ pass: "gf-run-2", ts: "2026-09-05T12:00:00.000Z" }), ev({ pass: "gf-run-2", ts: "2026-09-05T12:01:00.000Z" }), ev({ pass: "gf-run-2", ts: "2026-09-05T12:40:00.000Z", task_id: "tp_2" })];
  const m = buildManifest([...halted, ...own], { pass: "gf-run-2", policy_name: "p" });
  assert.equal(m.started_at, "2026-09-05T12:01:00.000Z");
  assert.equal(m.phase_breakdown.preflight.calls, 1, "only this run's own probe");
  assert.equal(m.total_cost_usd, 0.06);
  // A probe event with no run id (pre-flight called without run_id) cannot be told apart: it is kept.
  const unnamed = buildManifest([probe({ pass: "" }), ...own], { pass: "gf-run-2", policy_name: "p" });
  assert.equal(unnamed.phase_breakdown.preflight.calls, 2);
});
