/**
 * typistProbe.ts, door by door: the probe event carries every token the typist reports (its dollars include them), a
 * busy vendor passes on any door that reports the vendor's status, the agent door's probe gives its worker a time
 * limit that covers the SDK's own retry waits, and a brownfield run's probe covers the typists of its own job.
 * Offline: stand-in typists, and a stand-in for the agent worker's Python.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runTypingLeaves, probeTypists, probeEvents, PROBE_TIMEOUT_S } = await import(join(DIST, "typistProbe.js"));

const stand = (r, door) => (leaf) => ({ door, modelId: leaf.id, modelName: leaf.model_name, type: async () => r });

test("the probe event carries the typist's cache writes and reasoning tokens, which its cost includes", async () => {
  const tokens = { input: 12, input_cached: 0, input_cache_write: 9000, input_cache_write_1h: 1000, output: 20, output_reasoning: 8 };
  const [o] = await probeTypists([{ id: "opus", adapter: "claude-cli", model_name: "claude-opus-5" }], "estimated", stand({ answer: { path: "probe.txt", content: "ok" }, transport: false, tokens, cost_usd: 0.06681, latency_ms: 900 }, "lean-opus"));
  assert.deepEqual(o.tokens, tokens);
  const [e] = probeEvents([o], { pass: "r1", policy: { name: "p", version: 1 } });
  assert.equal(e.input_tokens, 12);
  assert.equal(e.input_tokens_cache_write, 10000, "the total written, as every dispatched event stores it (cacheWriteBuckets)");
  assert.equal(e.input_tokens_cache_write_1h, 1000);
  assert.equal(e.output_tokens, 20);
  assert.equal(e.output_tokens_reasoning, 8);
  assert.equal(e.cost_usd, 0.06681);
});

// The agent door's SDK raises errors with no transport flag the typist can set (its own retries already ran); when the
// typist reports the vendor's status, a 429 or 5xx is a busy vendor like on any other door: the run waits it out, so
// it is no reason to stop the run at its start.
test("a busy vendor reported by status alone passes with a note on any door", async () => {
  const leaf = { id: "agy", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
  const busy = { answer: null, transport: false, error_status: 429, error: "ClientError: 429 RESOURCE_EXHAUSTED.", tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 60_000 };
  const [o] = await probeTypists([leaf], "estimated", stand(busy, "agy"));
  assert.equal(o.ok, true);
  assert.equal(o.busy, true);
  const [refused] = await probeTypists([leaf], "estimated", stand({ ...busy, error_status: 403, error: "ClientError: 403 PERMISSION_DENIED." }, "agy"));
  assert.equal(refused.ok, false, "a refused login still stops the run");
});

// The worker's SDK waits out transient errors itself before it gives up: 2 s doubling, TRANSPORT.maxWaits times
// (typist_worker.py exponential_multiplier=2.0). A probe whose limit is shorter than those waits is cut off while the
// SDK is still backing off, and a busy vendor reads as a typist that cannot answer.
test("the agent door's probe gives its worker a time limit that covers the SDK's retry waits", async () => {
  const fake = mkdtempSync(join(tmpdir(), "agy-probe-"));
  const saved = { p: process.env.GEMINI_WORKER_PYTHON, g: process.env.GOOGLE_CLOUD_PROJECT, l: process.env.GOOGLE_CLOUD_LOCATION };
  try {
    const py = join(fake, "python");
    writeFileSync(py, `#!/bin/sh
printf '%s\\n' "$@" > "${fake}/args.txt"
out=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
printf '%s' '{"finish_output":"{\\"path\\":\\"probe.txt\\",\\"content\\":\\"ok\\"}","usage":{"prompt_tokens":10,"cached_tokens":0,"completion_tokens":5},"sdk_version":"0.1.16","tool_calls":[]}' > "$out"
`);
    chmodSync(py, 0o755);
    process.env.GEMINI_WORKER_PYTHON = py;
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.GOOGLE_CLOUD_LOCATION = "global";
    const [o] = await probeTypists([{ id: "agy", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" }], "estimated");
    assert.equal(o.ok, true, o.reason);
    assert.ok(existsSync(join(fake, "args.txt")));
    const args = readFileSync(join(fake, "args.txt"), "utf8").split("\n");
    const arg = (flag) => Number(args[args.indexOf(flag) + 1]);
    const retries = arg("--api-retries"), firstMs = arg("--api-retry-initial-ms"), limitS = arg("--timeout");
    const waitsMs = firstMs * (2 ** retries - 1);
    assert.ok(limitS * 1000 >= waitsMs + PROBE_TIMEOUT_S * 1000, `limit ${limitS} s against ${waitsMs} ms of SDK waits plus the ${PROBE_TIMEOUT_S} s start bound`);
  } finally {
    for (const [k, v] of [["GEMINI_WORKER_PYTHON", saved.p], ["GOOGLE_CLOUD_PROJECT", saved.g], ["GOOGLE_CLOUD_LOCATION", saved.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(fake, { recursive: true, force: true });
  }
});

test("with a brownfield run's intent, the typing models include the ones an intent-scoped rule routes that job to", () => {
  const policy = {
    name: "p", version: 1,
    models: [
      { id: "opus", adapter: "claude-cli", model_name: "claude-opus-5" },
      { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" },
      { id: "agy", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" },
    ],
    rules: [
      { when: { phase: "docs", intent: "docs" }, use: "agy" },
      { when: { phase: "codegen" }, use: "flash" },
      { default: "opus" },
    ],
  };
  assert.deepEqual(runTypingLeaves(policy, {}).map((m) => m.id).sort(), ["flash", "opus"]);
  assert.deepEqual(runTypingLeaves(policy, {}, "docs").map((m) => m.id).sort(), ["agy", "flash", "opus"]);
  assert.deepEqual(runTypingLeaves(policy, {}, "bugfix").map((m) => m.id).sort(), ["flash", "opus"]);
});
