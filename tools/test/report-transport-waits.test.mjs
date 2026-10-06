/**
 * A busy vendor's reply that the run waited out (telemetry `retry_reason: "transport"`) is not an attempt. Both flows
 * write one event per wait with the packet's task_id and attempt_number 1: greenfield's stage runner
 * (executor/run.ts) and brownfield's apply loop (server.ts withVerdicts). Counted as an attempt, a packet whose
 * vendor was busy once was listed under "Packets that needed output-ceiling doublings" (Att 2, 8192 → 8192) although
 * nothing was doubled, and a delegated packet was marked as retried. A wait's dollars, if any, stay in the packet's
 * cost.
 *
 * The report runs as a real subprocess over a temp pass directory. $0, offline.
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

const event = (task_id, cost, over = {}) => ({
  task_id, phase: "codegen", module: "app", model: "gemini-3.5-flash", input_tokens: 1000, output_tokens: 500, cost_usd: cost, provenance: "vendor", success: true, ...over,
});

function report(events, { receipts = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "report-waits-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ policy_name: "p", started_at: "2026-10-05T09:00:00Z" }));
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (receipts.length) mkdirSync(join(dir, "delegation"), { recursive: true });
    for (const r of receipts) writeFileSync(join(dir, "delegation", `worker-delegation-${r.task_id}.json`), JSON.stringify(r));
    return execFileSync("node", [REPORT, dir, "--markdown"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a packet whose vendor was busy, then answered, needed no output-ceiling doubling (brownfield's apply loop)", () => {
  const out = report([
    event("tp_codegen_U01-r1", 0, { attempt_number: 1, ceiling_used: 8192, retry_reason: "transport", success: false }),
    event("tp_codegen_U01-r1", 0.01, { attempt_number: 1, ceiling_used: 8192 }),
  ]);
  assert.doesNotMatch(out, /Packets that needed output-ceiling doublings/);
});

test("greenfield's waits are not attempts either: two waits and one answer list no doubling", () => {
  const out = report([
    event("U01", 0, { attempt_number: 1, retry_reason: "transport", success: false }),
    event("U01", 0, { attempt_number: 1, retry_reason: "transport", success: false }),
    event("U01", 0.02, { attempt_number: 1 }),
  ]);
  assert.doesNotMatch(out, /Packets that needed output-ceiling doublings/);
});

test("a real doubling with a wait between its attempts counts two attempts, and the wait's dollars stay in its cost", () => {
  const out = report([
    event("tp_codegen_U02", 0.01, { attempt_number: 1, ceiling_used: 4096, success: false }),
    event("tp_codegen_U02", 0.005, { attempt_number: 2, ceiling_used: 8192, retry_reason: "transport", success: false }),
    event("tp_codegen_U02", 0.02, { attempt_number: 2, ceiling_used: 8192, retry_reason: "output_cap" }),
  ]);
  assert.match(out, /\| `tp_codegen_U02` \| codegen \| gemini-3\.5-flash \| 2 \| 4096 → 8192 \| \$0\.0350 \| converged \|/);
});

test("a delegated packet whose vendor was busy once is not marked as retried; its cost still covers the wait", () => {
  const receipt = {
    schema: "delegation-record/1", task_id: "tp_2", phase: "codegen", model_id: "flash-agsdk-worker", model_name: "gemini-3.5-flash",
    workdir: "/w", started_at: "2026-10-05T09:00:00.000Z", duration_ms: 90_000, success: true, cost_usd: 0.01, tokens: {},
    tool_calls: { count: 3, truncated: false, sample: [] },
    files: { added: ["a.ts"], modified: [], removed: [], unchanged: 9, scanned: 10, truncated: false, unreadable: [] },
  };
  const out = report([
    event("tp_2", 0.001, { attempt_number: 1, retry_reason: "transport", success: false }),
    event("tp_2", 0.04, { attempt_number: 1 }),
  ], { receipts: [receipt] });
  assert.match(out, /Delegated to an agent worker/);
  assert.match(out, /\| `tp_2` \| /, "the packet's row, with no marker after its id");
  assert.doesNotMatch(out, /`tp_2`\\\*/, "a wait is not a retry");
  assert.doesNotMatch(out, /\* retried/);
  assert.match(out, /\$0\.0410/, "the wait's dollars stay in the packet's cost");
  assert.match(out, /2 of this run's 2 model calls were delegations/, "both calls are the delegated packet's, and the two sides still add up");
});

// A typist attempt after a failed check, a refused answer or a cut-off keeps the packet's task_id and is numbered by
// the ladder (retry_reason verify, refused, error, cut_off), as greenfield's attempts are: those are retries, not
// output-ceiling doublings. Only the adapters' own doubling loop writes retry_reason "output_cap".
test("a packet retried after a failed check, a refused answer or a cut-off needed no output-ceiling doubling", () => {
  const out = report([
    event("tp_codegen_U03", 0.01, { attempt_number: 1, success: false, error: "verify failed: lint" }),
    event("tp_codegen_U03", 0.01, { attempt_number: 2, retry_reason: "verify", success: false }),
    event("tp_codegen_U03", 0.01, { attempt_number: 3, retry_reason: "refused" }),
  ]);
  assert.doesNotMatch(out, /Packets that needed output-ceiling doublings/);
});
