/**
 * The completion door must send the thinking level the policy leaf asks for.
 *
 * The executor's typists all type at LOW effort: lean Opus with --effort low,
 * the agent typist with thinking LOW, and the completion door with Gemini's
 * thinkingLevel "low". Without the tier on the request Gemini thinks at its
 * default level, which spends several times the output tokens per file and can
 * run a file past the leaf's output ceiling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";

const LEAF = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 }, max_output_tokens_absolute: 8192 };
const PACKET = { id: "p1", phase: "codegen", task_type: "dto", module: "m", instruction: "Return {ok:true}.", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 512 }, pass_id: "t" };
const TODAY = () => new Date("2026-09-24T12:00:00Z");

/** The generationConfig the adapter sends for a leaf, captured by a recording transport. */
async function sentConfig(leaf) {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const adapter = new GeminiFlashAdapter(leaf, { now: TODAY });
    const calls = [];
    adapter.transport = {
      backend: "api-key", location: "",
      createCache: async () => undefined,
      generate: async (args) => { calls.push(args); return { text: '{"ok":true}', usage: { promptTokenCount: 10, candidatesTokenCount: 2 }, finishReason: "STOP" }; },
    };
    await adapter.execute(PACKET);
    return calls[0].generationConfig;
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
}

test("the leaf's reasoning tier becomes Gemini's thinkingLevel on the request", async () => {
  assert.deepEqual((await sentConfig({ ...LEAF, reasoning: { tier: "low" } })).thinkingConfig, { thinkingLevel: "low" });
  assert.deepEqual((await sentConfig({ ...LEAF, reasoning: { tier: "medium" } })).thinkingConfig, { thinkingLevel: "medium" });
  assert.deepEqual((await sentConfig({ ...LEAF, reasoning: { tier: "high" } })).thinkingConfig, { thinkingLevel: "high" });
  // "minimal" is its own level in the vendor's ThinkingLevel enum (@google/genai), so it is sent
  // as written, the same as the agent door sends it; whether a model accepts it is the vendor's call.
  assert.deepEqual((await sentConfig({ ...LEAF, reasoning: { tier: "minimal" } })).thinkingConfig, { thinkingLevel: "minimal" });
});

test("a leaf with no tier sends no thinking setting, so existing policies keep Google's default", async () => {
  assert.equal((await sentConfig(LEAF)).thinkingConfig, undefined);
  assert.equal((await sentConfig(LEAF)).httpOptions, undefined, "no request time limit unless the caller states one");
});
