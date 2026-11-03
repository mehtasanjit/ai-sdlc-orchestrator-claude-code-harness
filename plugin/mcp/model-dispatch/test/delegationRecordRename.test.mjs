/**
 * The agent door's delegation record (`delegation/worker-delegation-<packet>.json`) is never overwritten: when a
 * packet id is dispatched again, the older record is renamed `worker-delegation-<packet>.<n>.json` (n counting up)
 * before the new one is written, and the newest keeps the plain name, so a reader that opens the plain name sees the
 * latest dispatch and the earlier ones are kept. Offline: a stand-in worker interpreter writes each run's sidecar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { fakeWorkerPython, withEnv } from "./agyFakes.mjs";

const sidecar = (prompt) => ({ sdk_version: "0.1.16", usage: { prompt_token_count: prompt, candidates_token_count: 1 }, tool_call_count: 0, tool_calls: [] });

// E-delegation-record-rename.
test("a re-dispatched packet id keeps every delegation record: the newest under the plain name, the older ones as .1.json, .2.json", async () => {
  const fake = fakeWorkerPython({ runs: [100, 200, 300].map((p) => ({ sidecar: sidecar(p), stdout: '{"ok":true}' })) });
  const dir = mkdtempSync(join(tmpdir(), "rename-"));
  mkdirSync(join(dir, "work"));
  try {
    const packet = { id: "tp_codegen_007", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
      const adapter = new AntigravityWorkerAdapter({ id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" });
      for (let i = 0; i < 3; i++) {
        const out = await adapter.execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "run", "telemetry.jsonl") });
        assert.equal(out.success, true, out.error);
      }
    });
    const record = (name) => { const p = join(dir, "run", "delegation", name); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
    const prompt = (r) => r?.tokens?.input;
    assert.equal(prompt(record("worker-delegation-tp_codegen_007.json")), 300, "the plain name is the newest");
    assert.equal(prompt(record("worker-delegation-tp_codegen_007.1.json")), 100, "the first dispatch's record kept");
    assert.equal(prompt(record("worker-delegation-tp_codegen_007.2.json")), 200, "the second dispatch's record kept");
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// E-stale-sidecar: a re-dispatched packet (a restarted server sends the same packet id
// again) whose worker failed before writing its sidecar must not be billed the earlier dispatch's usage.
test("a dispatch whose worker writes no usage sidecar is never billed the usage an earlier dispatch of the same packet id left on disk", async () => {
  const fake = fakeWorkerPython({ runs: [{ sidecar: sidecar(1200), stdout: '{"ok":true}' }, { sidecar: null, exitCode: 1, stderr: "gemini_worker failed: AntigravityConnectionError: Error 403\n" }] });
  const dir = mkdtempSync(join(tmpdir(), "stale-sidecar-"));
  mkdirSync(join(dir, "work"));
  try {
    const packet = { id: "tp_codegen_022", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
    await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, async () => {
      const adapter = new AntigravityWorkerAdapter({ id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" });
      const first = await adapter.execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "run", "telemetry.jsonl") });
      assert.equal(first.tokens.input, 1200);
      const second = await adapter.execute(packet, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "run", "telemetry.jsonl") });
      assert.equal(second.success, false);
      assert.deepEqual([second.tokens.input, second.tokens.output, second.cost_usd], [0, 0, 0], "billed the first dispatch's usage again");
    });
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
