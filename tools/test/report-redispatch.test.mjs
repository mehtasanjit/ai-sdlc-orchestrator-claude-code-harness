/**
 * A packet id dispatched again on the agent door keeps its earlier delegation records as
 * worker-delegation-<packet>.<n>.json beside the newest, plain-named one. The report's delegation table shows the
 * packet once (its newest record), with the cost of every attempt from telemetry, so the delegated and the other
 * calls still add up to the run.
 *
 * The report runs as a real subprocess against a fixture directory. $0, offline.
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

const event = (task_id, cost) => ({ task_id, phase: "codegen", model: "m", input_tokens: 1000, output_tokens: 500, cost_usd: cost, provenance: "vendor", success: true });
const record = (task_id, started_at) => ({
  schema: "delegation-record/1", task_id, phase: "codegen", model_id: "flash-agsdk-worker", model_name: "gemini-3.5-flash",
  cable: { sdk: "google-antigravity", sdk_version: "0.1.22", vertex_project: "p", vertex_location: "global" },
  workdir: "/w", started_at, duration_ms: 90_000, success: true, cost_usd: 0.01, tokens: {},
  tool_calls: { count: 7, truncated: false, sample: [] },
  files: { added: ["a.ts"], modified: [], removed: [], unchanged: 9, scanned: 10, truncated: false, unreadable: [] },
});

test("a re-dispatched packet is one row of the delegation table, and the two sides still add up to the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-redispatch-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ policy_name: "p", started_at: "2026-08-05T09:00:00Z" }));
    writeFileSync(join(dir, "telemetry.jsonl"), [event("tp_2", 0.03), event("tp_2", 0.04), event("tp_1", 0.25)].map((e) => JSON.stringify(e)).join("\n") + "\n");
    mkdirSync(join(dir, "delegation"));
    writeFileSync(join(dir, "delegation", "worker-delegation-tp_2.1.json"), JSON.stringify(record("tp_2", "2026-08-05T09:00:00.000Z")));
    writeFileSync(join(dir, "delegation", "worker-delegation-tp_2.json"), JSON.stringify(record("tp_2", "2026-08-05T09:10:00.000Z")));
    const out = execFileSync("node", [REPORT, dir], { encoding: "utf8" });
    assert.equal(out.match(/^\s*\[G\]\s+codegen\s+tp_2/gm)?.length, 1, out);
    assert.match(out, /1 delegation\b.*\$0\.0700/);
    assert.match(out, /everything else in this run.*\b1 calls.*\$0\.2500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
