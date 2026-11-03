/**
 * A telemetry file whose last line was cut short (a process stopped in the middle of an append: the kill rule now
 * stops workers, and a server can be stopped mid-write) is read without that line, with a warning; a malformed line
 * inside the file still fails the read, because that is not a cut and its events cannot be trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../dist/telemetry.js";

const ev = (id) => JSON.stringify({ ts: "2026-11-03T10:00:00.000Z", pass: "r", phase: "codegen", task_type: "x", task_id: id, module: "m", model: "gemini-3.8-flash", routed_by: "orchestrator", input_tokens: 10, input_tokens_cached: 0, output_tokens: 2, cost_usd: 0.0001, latency_ms: 5, success: true, retry_count: 0 });

// E-readevents-cut-tail: a tolerant reader.
test("readEvents skips a last line cut short with a warning, and still throws on a malformed line inside the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cut-tail-"));
  try {
    const cut = join(dir, "cut.jsonl");
    writeFileSync(cut, `${ev("a")}\n${ev("b")}\n${ev("c").slice(0, 57)}`);
    const original = process.stderr.write;
    let stderr = "";
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    let events;
    try { events = readEvents(cut); } finally { process.stderr.write = original; }
    assert.deepEqual(events.map((e) => e.task_id), ["a", "b"], "the whole lines, without the cut one");
    assert.match(stderr, /WARN\s+[a-z_]+\.[a-z_.]+/, "a warning in the engine's log");
    const inner = join(dir, "inner.jsonl");
    writeFileSync(inner, `${ev("a")}\n{"ts": "2026-11-03T10:\n${ev("b")}\n`);
    assert.throws(() => readEvents(inner), "a malformed line inside the file is not a cut");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
