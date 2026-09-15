/**
 * Runs against dist/adapters/ClaudeCliAdapter.js — the adapter takes its
 * spawn function and its binary probe by injection so these tests never
 * actually invoke `claude`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCliAdapter } from "../dist/adapters/ClaudeCliAdapter.js";
import { computeCostUsd } from "../dist/pricing.js";

// The card equals Sonnet 5 on the price list (2 / 0.2 / 10), so no test here
// logs a policy-mismatch warning. Pricing itself is pinned in
// claudeCliPricing.test.mjs.
const BASE_CONFIG = {
  id: "sonnet-cli",
  adapter: "claude-cli",
  model_name: "claude-sonnet-5",
  pricing: { input: 2, input_cached: 0.2, output: 10 },
};

// The adapter looks up the worker session's transcript to split cache writes
// by TTL. Point it at an empty directory so these tests never read ~/.claude.
const NO_TRANSCRIPTS = mkdtempSync(join(tmpdir(), "claude-cli-adapter-test-"));

const PACKET = {
  id: "pkt-1",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["Responds with valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "test-pass",
};

/**
 * Build a fake `spawn` that returns a child-like object whose stdio can be
 * driven from the test. `behavior` returns what to emit on stdout/stderr and
 * an exit code (or leaves it running forever if `hang: true`).
 */
function fakeSpawn(behavior) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (_signal) => {
      child.killed = true;
      // No 'close' emitted for a hanging process — the adapter's timeout
      // fulfils the promise directly.
    };

    // Let the caller write to stdin, then react asynchronously.
    setImmediate(() => {
      const result = behavior();
      if (result.hang) return;
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", result.code ?? 0));
    });

    return child;
  };
}

/**
 * Shaped like the real `claude -p --output-format json` result object:
 * success is signaled by `type: "result"` + `subtype: "success"`. The old
 * fixture invented `terminal_reason: "completed"` — a field/value pair the
 * CLI never emits — which masked the adapter bug that classified every real
 * success as an error (the check compared against that invented field).
 */
const SUCCESS_RESPONSE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"ok":true}',
  total_cost_usd: 0.1219536,
  duration_ms: 3943,
  duration_api_ms: 2518,
  num_turns: 1,
  stop_reason: "end_turn",
  session_id: "sess-1",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 18765,
    cache_read_input_tokens: 30992,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: "standard",
  },
};

test("returns a successful ExecutionResult priced from its tokens, keeping the CLI's figure beside it", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(SUCCESS_RESPONSE), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.deepEqual(out.result, { ok: true });
  // Cache writes are their own bucket, never folded into `input`.
  assert.equal(out.tokens.input, 2);
  assert.equal(out.tokens.input_cache_write, 18765);
  assert.equal(out.tokens.input_cache_write_1h, 0);
  assert.equal(out.tokens.input_cached, 30992);
  assert.equal(out.tokens.output, 4);
  // Changed expectation (v0.7.3): cost_usd was total_cost_usd verbatim. It is
  // now the list price of the tokens. This payload has no modelUsage and no
  // cache_creation TTL split, so its writes are priced as 5-minute and the
  // split is flagged approximate; the CLI's own figure is kept as a check.
  // (Its 0.1219536 is these tokens at Sonnet 3/15 with 1-hour writes, the
  // card from before the Sonnet 5 price was confirmed at 2/10.)
  assert.equal(
    out.cost_usd,
    computeCostUsd({ input: 2, input_cached: 30992, input_cache_write: 18765, input_cache_write_1h: 0, output: 4 }, { input: 2, input_cached: 0.2, output: 10, input_cache_write: 2.5, input_cache_write_1h: 4 }),
  );
  assert.equal(out.attempts[0].cli_reported_cost_usd, 0.1219536, "the CLI's figure is kept, never used as the cost");
  assert.equal(out.attempts[0].ttl_split, "approximate");
  assert.equal(out.latency_ms, 2518, "latency comes from duration_api_ms, not duration_ms");
  assert.equal(out.cache_hit, true, "any cache_read_input_tokens > 0 flips cache_hit");
  assert.equal(out.attempts.length, 1, "no doubling loop — always one attempt");
});

test("classifies is_error responses as a vendor_error ExecutionResult", async () => {
  const errorResponse = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "quota exhausted",
    total_cost_usd: 0,
    stop_reason: "error",
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(errorResponse), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /quota exhausted/);
  assert.equal(out.result, null);
});

test("a non-success subtype is an error even when is_error is false", async () => {
  // error_max_turns arrives with is_error false on some CLI versions; the
  // subtype is the authoritative signal, so it must fail the call on its own.
  const maxTurns = {
    ...SUCCESS_RESPONSE,
    subtype: "error_max_turns",
    result: "hit the turn limit",
  };
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(maxTurns), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /turn limit/);
});

test("a payload with no subtype at all lands on the error side", async () => {
  // Absence of the success signal is not success — a truncated or foreign
  // payload must never be billed and parsed as a completed call.
  const noSubtype = { ...SUCCESS_RESPONSE };
  delete noSubtype.subtype;
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(noSubtype), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
});

test("garbage stdout is reported as a vendor_error, not thrown", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ stdout: "not JSON at all", code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /JSON parse failed/);
});

test("a hanging subprocess is killed after the configured timeout", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    projectsDir: NO_TRANSCRIPTS,
    spawnFn: fakeSpawn(() => ({ hang: true })),
    timeoutSec: 0.05,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /claude-cli timeout/);
});

test("constructor throws when the claude binary is missing (ENOENT)", () => {
  assert.throws(
    () =>
      new ClaudeCliAdapter(BASE_CONFIG, {
        probeBinary: () => {
          const err = new Error("spawn claude ENOENT");
          err.code = "ENOENT";
          throw err;
        },
        spawnFn: fakeSpawn(() => ({ stdout: "{}", code: 0 })),
      }),
    /needs the `claude` binary on PATH/,
  );
});
