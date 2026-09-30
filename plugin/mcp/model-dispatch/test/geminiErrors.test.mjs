/**
 * A failed completion-door call is described by the vendor's own fields, and a
 * call Google answered with an error costs nothing.
 *
 * Google's error carries its HTTP status (`ApiError.status`) and, when it asks
 * for a pause, a `google.rpc.RetryInfo` entry in the JSON error body; a
 * connection that failed in transit carries a Node/undici code. The adapter
 * records all three on the attempt, so callers decide from fields rather than
 * from the error's wording.
 *
 * A call Google answered with an error status is billed $0. Google's own words:
 * Vertex AI "You're charged only for requests that return a 200 response code.
 * Requests returning any other response codes, such as 4xx and 5xx codes,
 * aren't charged for the input or output." (cloud.google.com/vertex-ai/
 * generative-ai/pricing); the Gemini API "If your request fails with a 400 or
 * 500 error, you won't be charged for the tokens used." (ai.google.dev/
 * gemini-api/docs/billing). A connection that failed with no response keeps
 * the stated bound: the prompt billed as input, since the request may have
 * been answered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";

const LEAF = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 }, max_output_tokens_absolute: 8192 };
const PACKET = { id: "p1", phase: "codegen", task_type: "dto", module: "m", instruction: "Return {ok:true}.", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 512 }, pass_id: "t" };
const TODAY = () => new Date("2026-09-24T12:00:00Z");

/** The adapter's result when its transport throws `err`. */
async function failWith(err) {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const adapter = new GeminiFlashAdapter(LEAF, { now: TODAY });
    adapter.transport = { backend: "api-key", location: "", createCache: async () => undefined, generate: async () => { throw err; } };
    return await adapter.execute(PACKET);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
}

/** An error shaped like @google/genai's ApiError: `status` plus the JSON error body as the message. */
const apiError = (status, body) => Object.assign(new Error(JSON.stringify(body)), { name: "ApiError", status });

test("a 429 is recorded with its status and billed nothing", async () => {
  const r = await failWith(apiError(429, { error: { code: 429, message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" } }));
  const a = r.attempts.at(-1);
  assert.equal(r.success, false);
  assert.equal(a.error_status, 429);
  assert.deepEqual(a.tokens, { input: 0, input_cached: 0, output: 0 });
  assert.equal(a.cost_usd, 0);
  assert.equal(r.cost_usd, 0);
});

test("a delay the vendor asks for is read from its RetryInfo entry", async () => {
  const r = await failWith(apiError(503, { error: { code: 503, status: "UNAVAILABLE", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } }));
  const a = r.attempts.at(-1);
  assert.equal(a.error_status, 503);
  assert.equal(a.retry_after_ms, 7000);
  assert.equal(a.cost_usd, 0, "any error status Google returned is not charged");
});

test("a connection that failed in transit is recorded with its code", async () => {
  const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  const a = (await failWith(err)).attempts.at(-1);
  assert.equal(a.error_code, "ECONNRESET");
  assert.equal(a.error_status, undefined);
  assert.ok(a.cost_usd > 0, "no response came back, so the request may have been answered: the prompt is billed as input");
});

test("a request that never reached Google (no address, no route) is billed nothing", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]) {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
    const a = (await failWith(err)).attempts.at(-1);
    assert.equal(a.cost_usd, 0, code);
  }
});
