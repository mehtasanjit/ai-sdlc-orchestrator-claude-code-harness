/**
 * src/applyTypist.ts: greenfield's typists (executor/typists.ts) typing a brownfield run's apply packets, one
 * machine for both flows. The adapter sends a packet to a typist in greenfield's answer contract for its mode, the
 * batch's shared inputs as the typist's shared block, with greenfield's warm gate for the lean Opus typist, and reports
 * the call the way the apply loop reads any adapter. Stand-in typists and a recording Gemini transport: no model is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { TypistApplyAdapter, usesServerTypist, typistResult, contractFor, splitShared, BROWNFIELD_INTENTS } = await import(join(DIST, "applyTypist.js"));
const { EDIT_ANSWER_SCHEMA, FILE_ANSWER_SCHEMA } = await import(join(DIST, "executor", "brief.js"));
const { FlashCompletionTypist } = await import(join(DIST, "executor", "typists.js"));
const { LEAN_OPUS_CACHE_TTL_MS } = await import(join(DIST, "executor", "run.js"));

const OPUS = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5" };
const FLASH = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };
const AGY = { id: "flash-agsdk-worker", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const SHARED = { path: "briefs/shared.md", content: "SHARED-TEXT", reason: "shared brief", shared: true };
const packet = (over = {}) => ({ id: "tp_codegen_U01", phase: "codegen", task_type: "", module: "spec", pass_id: "r", intent: "feature-new", instruction: "Implement src/a.ts.", inputs: [SHARED, { path: "briefs/U01.md", content: "UNIT-ONE", reason: "unit brief" }], acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 8000 }, artifact_path: "src/a.ts", apply: { write: true, mode: "content" }, ...over });
const TOK = { input: 100, input_cached: 0, output: 20 };

/** A stand-in typist: records each request (and the shared file's text) and answers from `results`. */
function fakeTypist(door, results) {
  const reqs = [];
  return { reqs, door, modelId: "m", modelName: "m", type: async (req) => { reqs.push({ ...req, sharedFileText: readFileSync(req.sharedFile, "utf8") }); return results.shift() ?? { answer: { path: "src/a.ts", content: "x\n" }, transport: false, tokens: TOK, cost_usd: 0.01, latency_ms: 5 }; } };
}

// Every brownfield job runs the same packet flow (skills/pipeline/brownfield-runs.md), so every job's packets are typed by
// greenfield's typists; a packet with no brownfield intent (greenfield's, or one naming no job) is dispatched as before.
test("usesServerTypist: any leaf greenfield has a typist for, in a brownfield run of any job whose start check recorded the billing", () => {
  const ids = JSON.parse(readFileSync(join(DIST, "..", "..", "..", "config", "intents.json"), "utf8")).intents.map((i) => i.id);
  assert.deepEqual([...BROWNFIELD_INTENTS].sort(), [...ids].sort(), "the server's list is the job list of config/intents.json");
  for (const leaf of [OPUS, FLASH, AGY]) assert.equal(usesServerTypist(leaf, packet(), { authMode: "estimated" }), true, leaf.id);
  for (const intent of ids) assert.equal(usesServerTypist(OPUS, packet({ intent }), { authMode: "estimated" }), true, intent);
  assert.equal(usesServerTypist(OPUS, packet({ intent: "greenfield" }), { authMode: "estimated" }), false, "not a brownfield job");
  assert.equal(usesServerTypist(OPUS, packet({ intent: undefined }), { authMode: "estimated" }), false);
  assert.equal(usesServerTypist(OPUS, packet(), undefined), false, "no run state: as before");
  assert.equal(usesServerTypist({ adapter: "something-else" }, packet(), { authMode: "estimated" }), false);
});

test("the adapter asks in greenfield's contract for the packet's mode, with the shared inputs as the typist's shared block", async () => {
  const t = fakeTypist("flash-completion", []);
  const ad = new TypistApplyAdapter(FLASH, t);
  const r = await ad.execute(packet());
  assert.equal(r.success, true);
  assert.deepEqual(r.result, { path: "src/a.ts", content: "x\n" });
  const req = t.reqs[0];
  assert.equal(req.contract, "file");
  assert.deepEqual(req.packet.outputSchema, FILE_ANSWER_SCHEMA);
  assert.match(req.shared, /SHARED-TEXT/);
  assert.equal(req.sharedFileText, req.shared, "the same block on disk for the doors that read it from a file");
  assert.doesNotMatch(req.framed, /SHARED-TEXT/, "sent once, in the shared block");
  assert.match(req.framed, /UNIT-ONE/);
  await ad.execute(packet({ apply: { write: true, mode: "edits" } }));
  assert.equal(t.reqs[1].contract, "edit");
  assert.deepEqual(t.reqs[1].packet.outputSchema, EDIT_ANSWER_SCHEMA);
  assert.equal(contractFor(packet({ apply: { write: true, mode: "edits" } })), "edit");
  assert.equal(ad.door, "flash-completion");
});

test("a typist's failures reach the loop as greenfield's runner treats them: cut off, wait, halt, or an attempt to retry", () => {
  const p = packet();
  const cut = typistResult(p, { answer: null, cut_off: true, transport: false, tokens: TOK, cost_usd: 0.02, latency_ms: 1, error: "cut off" });
  assert.equal(cut.success, false);
  assert.equal(cut.terminal_reason, "output_cap_at_model_absolute", "the loop sends it to the next model");
  const busy = typistResult(p, { answer: null, transport: true, error_status: 429, retry_after_ms: 2000, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 1, error: "rate limited" });
  assert.equal(busy.success, false);
  assert.equal(busy.attempts[0].transient, true, "a wait, not an attempt");
  assert.equal(busy.attempts[0].retry_after_ms, 2000);
  const refused = typistResult(p, { answer: null, transport: false, error_status: 401, tokens: TOK, cost_usd: 0, latency_ms: 1, error: "unauthorized" });
  assert.equal(refused.attempts[0].error_status, 401, "the loop halts the batch");
  // A reply in no contract is a failed attempt, recorded as failed (greenfield's runner logs it `success: false`), which
  // the loop retries with the reason.
  const garbled = typistResult(p, { answer: null, transport: false, tokens: TOK, cost_usd: 0.01, latency_ms: 1, error: "the reply was not an object in the {path, content} contract" });
  assert.equal(garbled.success, false, "no usable answer: the attempt failed");
  assert.equal(garbled.attempts[0].success, false, "the telemetry event says so");
  assert.equal(garbled.terminal_reason, "invalid_answer", "the model replied, outside the contract");
  assert.equal(garbled.result, null);
  assert.equal(garbled.cost_usd, 0.01, "billed");
  // A call that produced no reply at all (a crash, a timeout, a login the CLI could not use, reported with no HTTP
  // status) is a failed attempt too, never a success with an empty answer.
  const noLogin = typistResult(p, { answer: null, transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 1, error: "success: Failed to authenticate: OAuth session expired and could not be refreshed" });
  assert.equal(noLogin.success, false);
  assert.equal(noLogin.attempts[0].success, false);
  assert.equal(noLogin.terminal_reason, "no_answer", "no reply reached the loop");
  assert.match(noLogin.attempts[0].error, /Failed to authenticate/, "the typist's own reason is kept");
});

test("Flash through greenfield's own typist: two packets of a batch reach Gemini with the same leading bytes", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const typist = new FlashCompletionTypist(FLASH, "low");
    const prompts = [];
    typist.adapter.transport = { backend: "api-key", location: "", createCache: async () => undefined, generate: async (a) => { prompts.push(a.prompt); return { text: '{"path":"src/a.ts","content":"x"}', usage: { promptTokenCount: 10, candidatesTokenCount: 2 }, finishReason: "STOP" }; } };
    const ad = new TypistApplyAdapter(FLASH, typist);
    await ad.execute(packet({ id: "tp_1" }));
    await ad.execute(packet({ id: "tp_2", inputs: [SHARED, { path: "briefs/U02.md", content: "UNIT-TWO", reason: "unit brief" }] }));
    const lead = prompts[0].slice(0, prompts[0].indexOf("## Task"));
    assert.match(lead, /SHARED-TEXT/);
    assert.ok(prompts[1].startsWith(lead), "the same leading bytes: Gemini's implicit cache reuses them");
    assert.equal(prompts[0].split("SHARED-TEXT").length, 2, "the shared text is sent once");
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

test("greenfield's warm gate for the lean Opus typist: cold, one call alone; warm, together; a call that never reached the model does not warm", async () => {
  let clock = 1_000_000;
  const started = [], gates = [];
  const typist = { door: "lean-opus", modelId: "opus", modelName: "claude-opus-5", type: () => { started.push(clock); let open; const p = new Promise((r) => (open = r)); gates.push(open); return p; } };
  const ad = new TypistApplyAdapter(OPUS, typist, { now: () => clock });
  const ok = { answer: { path: "src/a.ts", content: "x" }, transport: false, tokens: TOK, cost_usd: 0.05, latency_ms: 1 };
  const calls = [1, 2, 3].map((n) => ad.execute(packet({ id: `tp_${n}` })));
  await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 1, "cold: one call alone");
  gates[0](ok); await calls[0]; await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 3, "warm: the others start together");
  gates[1](ok); gates[2](ok); await Promise.all(calls);
  clock += LEAN_OPUS_CACHE_TTL_MS + 1;
  const later = [4, 5].map((n) => ad.execute(packet({ id: `tp_${n}` })));
  await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 4, "cold again after the cache lifetime");
  gates[3]({ answer: null, transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 1, error: "spawn failed" });
  await later[0]; await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 5, "the failed call reached no model, so the next one warms alone");
  gates[4](ok); await Promise.all(later);
  // A Flash typist is never gated: greenfield's Gemini doors have no cache the caller controls.
  const flashStarted = [];
  const flash = new TypistApplyAdapter(FLASH, { door: "flash-completion", modelId: "f", modelName: "f", type: () => { flashStarted.push(1); return new Promise(() => {}); } });
  [1, 2, 3].forEach((n) => flash.execute(packet({ id: `f_${n}` })));
  await new Promise((r) => setImmediate(r));
  assert.equal(flashStarted.length, 3);
});

test("splitShared: the batch's shared inputs in one order for every packet, whatever order each lists them", () => {
  const a = { path: "a.md", content: "A", reason: "a", shared: true }, b = { path: "b.md", content: "B", reason: "b", shared: true };
  const x = splitShared(packet({ inputs: [a, { path: "u.md", content: "U", reason: "u" }, b] }));
  const y = splitShared(packet({ inputs: [b, a] }));
  assert.equal(x.shared, y.shared);
  assert.deepEqual(x.packet.inputs.map((i) => i.path), ["u.md"]);
  assert.equal(splitShared(packet({ inputs: [{ path: "u.md", content: "U", reason: "u" }] })).shared, "");
});
