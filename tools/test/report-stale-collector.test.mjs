/**
 * write-manifest.mjs rebuilds manifest.json from telemetry.jsonl and keeps the collector's figures only
 * while the dispatched total they were computed from is unchanged; when it changed (a revise round after
 * the collector ran), it leaves them out and says to run the collector again. The collector's
 * `tier: "orchestrator"` event is still in telemetry.jsonl then. The report must not add that old
 * overhead to the new dispatched total: it names the figures as out of date and gives the command.
 * A manifest the collector has not patched yet (no write-manifest rewrite) still sums the event, as before.
 * The report runs as a real subprocess: what a person sees is what is tested. $0, offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const WRITE_MANIFEST = join(ROOT, "plugin", "scripts", "write-manifest.mjs");
const DIST = join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "telemetry.js");

const event = (task_id, phase, cost) => ({ task_id, phase, model: "m", input_tokens: 1000, output_tokens: 500, cost_usd: cost, provenance: "vendor", success: true });
const orchEvent = (cost) => ({ task_id: "orchestrator-overhead-p1", phase: "orchestrator_overhead", model: "driver", input_tokens: 100, input_tokens_cached: 9000, output_tokens: 50, cost_usd: cost, provenance: "transcript", tier: "orchestrator", success: true });

function report({ events, manifest, markdown = false }) {
  const dir = mkdtempSync(join(tmpdir(), "report-stale-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ policy_name: "p", started_at: "2026-09-29T09:00:00Z", ...manifest }));
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return execFileSync("node", markdown ? [REPORT, dir, "--markdown"] : [REPORT, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// After a revise round: dispatched is now $0.40 (was $0.10 when the collector ran), and write-manifest left the figures out.
const rewritten = { total_cost_usd: 0.4, written_by: "plugin/scripts/write-manifest.mjs", status: "provisional" };
const events = [event("tp_1", "codegen", 0.1), event("tp_2", "codegen", 0.3), orchEvent(2)];

test("figures write-manifest left out are named out of date, never added to the new dispatched total", () => {
  const out = report({ events, manifest: rewritten });
  assert.doesNotMatch(out, /True total/);
  assert.doesNotMatch(out, /Orchestrator overhead \(/);
  assert.doesNotMatch(out, /\$2\.4000/);
  assert.match(out, /Scope: dispatched work only — the collector's figures are out of date/);
  assert.match(out, /— dispatched work only\s+\$0\.4000/);
  assert.match(out, /COLLECTOR FIGURES OUT OF DATE/);
  assert.match(out, /collect-orchestrator-usage\.mjs/);
  assert.doesNotMatch(out, /EXCLUDES ORCHESTRATOR OVERHEAD/, "the collector did run: the reader is told to run it again, not that it never ran");
});

test("the Markdown branch says the same", () => {
  const out = report({ events, manifest: rewritten, markdown: true });
  assert.doesNotMatch(out, /True total/);
  assert.match(out, /\*\*Scope: dispatched work only — the collector's figures are out of date\*\*/);
  assert.match(out, /Collector figures out of date/);
  assert.match(out, /collect-orchestrator-usage\.mjs/);
});

test("a rewritten manifest that kept the collector's figures, and one the collector has not patched yet, render the true total as before", () => {
  const kept = report({
    events: [event("tp_1", "codegen", 0.1), orchEvent(2)],
    manifest: { ...rewritten, total_cost_usd: 0.1, orchestrator_overhead: { cost_usd: 2, events: 1, provenance: "transcript" }, true_total_cost_usd: 2.1 },
  });
  assert.match(kept, /True total \(dispatched \+ orchestrator\)\s+\$2\.1000/);
  assert.doesNotMatch(kept, /out of date/i);
  const unpatched = report({ events: [event("tp_1", "codegen", 0.1), orchEvent(2)], manifest: {} });
  assert.match(unpatched, /True total \(dispatched \+ orchestrator\)\s+\$2\.1000/);
  assert.doesNotMatch(unpatched, /out of date/i);
});

test("through the real write-manifest: a revise round after the collector ran leaves the report saying so", { skip: !existsSync(DIST) && "server dist not built" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "report-stale-wm-"));
  try {
    // The collector's patch on a $0.10 run, then $0.30 more dispatched work.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ pass: "p1", policy_name: "p", total_cost_usd: 0.1, orchestrator_overhead: { cost_usd: 2, events: 1, provenance: "transcript", dispatched_in_session_cost_usd: 0 }, true_total_cost_usd: 2.1 }));
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify({ ts: "2026-09-29T09:00:00Z", ...e })).join("\n") + "\n");
    const wm = execFileSync("node", [WRITE_MANIFEST, dir, "--pass", "p1", "--policy", "p", "--project-root", dir], { encoding: "utf8" });
    assert.match(wm, /note: the dispatched total changed since the collector ran/);
    const out = execFileSync("node", [REPORT, dir], { encoding: "utf8" });
    assert.doesNotMatch(out, /True total/);
    assert.match(out, /COLLECTOR FIGURES OUT OF DATE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
