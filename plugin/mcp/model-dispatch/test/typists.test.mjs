/**
 * The executor's typists, without calling any model: each typist's pinned
 * request, the environments built from allowlists, the strict answer contracts,
 * failures classified from the vendors' structured fields, which typist each
 * policy leaf gets, and the lean Opus leaf every policy falls back to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cliLists, leanOpusArgs, leanOpusEnv, leanOpusOutcome, agyEnv, agyWorkerArgs, agyOutcome, flashOutcome, parseAnswer, isTransient, TYPIST_WORKER, FlashCompletionTypist } from "../dist/executor/typists.js";
import * as typistsModule from "../dist/executor/typists.js";
import { FILE_ANSWER_SCHEMA, EDIT_ANSWER_SCHEMA } from "../dist/executor/brief.js";
import { typistForLeaf, fallbackLeaf, TYPIST_EFFORT, TYPIST_TIMEOUT_S, TRANSPORT } from "../dist/executor/tools.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const HELP = ["--tools <tools...>", "--append-system-prompt-file <f>", "--effort <level>", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"].map((l) => `  ${l}   x`).join("\n");

test("lean Opus: no tools, no MCP servers, safe mode, no transcript, low effort, the shared block as the system-prompt tail", () => {
  const args = leanOpusArgs("claude-opus-5", "low", "/run/shared-brief.txt", HELP);
  assert.deepEqual(args, ["-p", "--model", "claude-opus-5", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--effort", "low", "--append-system-prompt-file", "/run/shared-brief.txt"]);
  // Isolation flags are added only when the installed CLI lists them...
  assert.ok(!leanOpusArgs("m", "low", "/f", HELP.replace(/.*--safe-mode.*\n/, "")).includes("--safe-mode"));
  // ...but a CLI without the flags the route depends on refuses to run it at all.
  for (const needed of ["--tools", "--append-system-prompt-file", "--effort"]) {
    const help = HELP.split("\n").filter((l) => !l.includes(needed)).join("\n");
    assert.throws(() => leanOpusArgs("m", "low", "/f", help), new RegExp(`no ${needed} flag`));
  }
});

test("a flag the CLI's help folds into a sibling's (--name[-file]) counts as listed; a missing one does not", () => {
  // Claude Code 2.1.280's help: --append-system-prompt-file appears only inside --bare's description.
  const real = "  --append-system-prompt <prompt>       Append a system prompt\n                                        --append-system-prompt[-file], --add-dir\n  --tools <tools...>   x";
  assert.equal(cliLists(real, "--append-system-prompt-file"), true);
  assert.equal(cliLists(real, "--append-system-prompt"), true);
  assert.equal(cliLists(real, "--tools"), true);
  assert.equal(cliLists(real, "--system-prompt-file"), false);
  assert.equal(cliLists(real, "--effort"), false);
  assert.deepEqual(leanOpusArgs("m", "low", "/f", real + "\n  --effort <level>  x").slice(-4), ["--effort", "low", "--append-system-prompt-file", "/f"]);
});

test("lean Opus environment: built from an allowlist; the API key only under vendor auth; five-minute cache", () => {
  // A poisoned parent: every variable below changes how claude -p behaves, and none may reach a typist.
  // (Which login and provider pay for the call is not poison: see the next test.)
  const poison = {
    CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_ENTRYPOINT: "cli",
    MAX_THINKING_TOKENS: "32000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_EFFORT_LEVEL: "high",
    DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1", ANTHROPIC_MODEL: "claude-sonnet-5",
    CLAUDE_CODE_SUBAGENT_MODEL: "x", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2", MMO_SELECT: "gemini-flash=flash-agsdk-worker",
  };
  const base = { PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", LANG: "en_US.UTF-8", TERM: "xterm", TMPDIR: "/t", HTTPS_PROXY: "http://proxy", CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_API_KEY: "k", ...poison };
  const est = leanOpusEnv(base, "estimated");
  assert.deepEqual(Object.keys(est).sort(), ["CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "HTTPS_PROXY", "LANG", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER"]);
  assert.equal(est.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.equal(est.DISABLE_AUTOUPDATER, "1", "one CLI version for every typist call of a run");
  const vendor = leanOpusEnv(base, "vendor");
  assert.equal(vendor.ANTHROPIC_API_KEY, "k", "a vendor-auth run bills the API on purpose");
  for (const k of Object.keys(poison)) assert.equal(vendor[k], undefined, k);
});

test("the lean Opus child keeps what decides who pays and where the call goes: the policy's key under vendor, the OAuth login, a gateway, Bedrock, Vertex or Foundry", () => {
  const routing = {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_BASE_URL: "https://gw", ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_CUSTOM_HEADERS: "X-Team: a",
    CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t", AWS_BEARER_TOKEN_BEDROCK: "b", ANTHROPIC_BEDROCK_BASE_URL: "https://b", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "proj", CLOUD_ML_REGION: "us-east5", VERTEX_REGION_CLAUDE_OPUS_5: "europe-west1", ANTHROPIC_VERTEX_BASE_URL: "https://v",
    GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", CLOUDSDK_CONFIG: "/gcloud",
    CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "r", ANTHROPIC_FOUNDRY_API_KEY: "f",
    CLAUDE_CODE_CLIENT_CERT: "/c.pem", CLAUDE_CODE_CLIENT_KEY: "/k.pem",
  };
  const base = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "default-key", WORK_ANTHROPIC_KEY: "work-key", ...routing };
  for (const mode of ["estimated", "vendor"]) {
    const env = leanOpusEnv(base, mode, "WORK_ANTHROPIC_KEY");
    for (const [k, v] of Object.entries(routing)) assert.equal(env[k], v, `${mode}: ${k}`);
    assert.equal(env.WORK_ANTHROPIC_KEY, undefined, "the key travels only as ANTHROPIC_API_KEY");
  }
  assert.equal(leanOpusEnv(base, "vendor", "WORK_ANTHROPIC_KEY").ANTHROPIC_API_KEY, "work-key", "the key the policy names, not whichever key is set");
  assert.equal(leanOpusEnv(base, "vendor").ANTHROPIC_API_KEY, "default-key", "no auth.env: ANTHROPIC_API_KEY");
  assert.equal(leanOpusEnv(base, "estimated", "WORK_ANTHROPIC_KEY").ANTHROPIC_API_KEY, undefined, "an estimated run stays on the subscription");
  assert.equal(leanOpusEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "default-key" }, "vendor", "WORK_ANTHROPIC_KEY").ANTHROPIC_API_KEY, undefined, "never another key in place of the one the policy names");
});

/** A stand-in `claude` that records its working directory and environment, then answers with `receipt`. */
async function fakeClaude(receipt) {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt));
  writeFileSync(join(dir, "claude"), `#!/bin/sh\npwd > "${dir}/cwd.txt"\nenv > "${dir}/env.txt"\ncat > /dev/null\ncat "${dir}/receipt.json"\n`);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

test("a vendor-auth lean Opus call reaches claude -p with the key the policy names and the session's gateway, and leaves no scratch folder behind", async () => {
  const { readFileSync } = await import("node:fs");
  const { LeanOpusTypist } = await import("../dist/executor/typists.js");
  const bin = await fakeClaude({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ path: "a.py", content: "x = 1\n" }), usage: { input_tokens: 3, output_tokens: 2 } });
  const leaf = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", auth: { env: "WORK_ANTHROPIC_KEY" }, pricing: { input: 5, input_cached: 0.5, output: 25 } };
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp", WORK_ANTHROPIC_KEY: "work-key", ANTHROPIC_BASE_URL: "https://gw.example", CLAUDE_CODE_OAUTH_TOKEN: "oauth" };
  const t = new LeanOpusTypist(leaf, { authMode: "vendor", effort: "low", timeoutMs: 10_000, help: HELP, env });
  const packet = { id: "U01", phase: "codegen", task_type: "other", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
  const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "job", shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
  assert.deepEqual(r.answer, { path: "a.py", content: "x = 1\n" });
  const seen = Object.fromEntries(readFileSync(join(bin, "env.txt"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(seen.ANTHROPIC_API_KEY, "work-key");
  assert.equal(seen.ANTHROPIC_BASE_URL, "https://gw.example");
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
  const cwd = readFileSync(join(bin, "cwd.txt"), "utf8").trim();
  assert.match(cwd, /mmo-typist-/);
  assert.equal(existsSync(cwd), false, "the typist's scratch working directory is removed after the call");
});

test("the agent typist's worker keeps the Python and Google settings the agent door passes: where Python finds the SDK, its native libraries, the credentials and the metadata server", () => {
  const kept = {
    PYTHONPATH: "/venv/site-packages", PYTHONHOME: "/py", PYTHONUSERBASE: "/u", VIRTUAL_ENV: "/venv", CONDA_PREFIX: "/conda", LD_LIBRARY_PATH: "/lib",
    GCE_METADATA_HOST: "169.254.169.254", GOOGLE_CLOUD_UNIVERSE_DOMAIN: "googleapis.com", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", CLOUDSDK_CONFIG: "/gcloud",
  };
  const env = agyEnv({ PATH: "/bin", ...kept, GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2", CLAUDECODE: "1" }, "proj", "global");
  for (const [k, v] of Object.entries(kept)) assert.equal(env[k], v, k);
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDECODE"]) assert.equal(env[k], undefined, `${k} never reaches the worker`);
});

test("the claude CLI check names every flag the lean Opus typist needs that this CLI lacks, or that there is no claude at all", () => {
  const { leanOpusCliProblem } = typistsModule;
  assert.equal(leanOpusCliProblem(() => HELP), null);
  const old = "  -p, --print  x\n  --output-format <f>  x\n  --model <m>  x\n  --append-system-prompt <p>  x";
  const p = leanOpusCliProblem(() => old);
  for (const f of ["--tools", "--append-system-prompt-file", "--effort"]) assert.ok(p.includes(f), `${f} named: ${p}`);
  assert.match(p, /update Claude Code/);
  assert.match(leanOpusCliProblem(() => HELP.replace(/.*--effort.*\n/, "")), /--effort/);
  const enoent = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
  assert.match(leanOpusCliProblem(() => { throw enoent; }), /no `claude` command on this server's PATH/);
});

test("agent typist environment: an allowlist plus the Vertex project and region; no API key can route it elsewhere", () => {
  const env = agyEnv({ PATH: "/bin", HOME: "/h", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2", CLAUDECODE: "1", GOOGLE_CLOUD_LOCATION: "us-central1" }, "proj", "global");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "global", PYTHONUNBUFFERED: "1" });
});

test("agent typist request: the shared block as the system prompt, the brief, FINISH with the answer schema, LOW thinking, three model calls — and the executor's wait rule for rate limits", () => {
  const args = agyWorkerArgs({ briefFile: "/s/brief.md", sharedFile: "/run/shared.txt", schemaFile: "/s/schema.json", model: "gemini-3.8-flash", region: "global", workdir: "/s", receiptFile: "/s/r.json", thinking: "low", maxModelCalls: 3, timeoutSec: 540, apiRetries: 6, apiRetryInitialMs: 2000 });
  assert.deepEqual(args, [TYPIST_WORKER, "--brief-file", "/s/brief.md", "--system-file", "/run/shared.txt", "--answer-schema-file", "/s/schema.json", "--model", "gemini-3.8-flash", "--region", "global", "--workdir", "/s", "--out", "/s/r.json", "--thinking", "LOW", "--max-model-calls", "3", "--timeout", "540", "--api-retries", "6", "--api-retry-initial-ms", "2000"]);
});

test("every typist gets the same stated time limit and the agent door waits out rate limits with the executor's rule", () => {
  const policy = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const byId = (id) => policy.models.find((m) => m.id === id);
  assert.equal(TYPIST_TIMEOUT_S, 540);
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: process.execPath });
  try {
    // A leaf's own worker_timeout_sec is for whole agent jobs; a typist types one file, so the executor's bound applies.
    const agy = typistForLeaf({ ...byId("flash-agsdk-worker"), worker_timeout_sec: 1800 }, "estimated");
    assert.equal(agy.opts.timeoutSec, 540);
    assert.equal(agy.opts.apiRetries, TRANSPORT.maxWaits);
    assert.equal(agy.opts.apiRetryInitialMs, TRANSPORT.baseMs);
    const flash = typistForLeaf(byId("flash-completion"), "estimated");
    assert.equal(flash.requestTimeoutMs, 540_000);
    // A hand-authored policy may name the completion door by its legacy id; the registry accepts it, so the executor does too.
    assert.equal(typistForLeaf({ ...byId("flash-completion"), adapter: "mcp:gemini" + "-flash-server" }, "estimated").door, "flash-completion");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("completion typist request: the shared block first, thinking low, the answer schema as the response schema", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const leaf = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 }, max_output_tokens_absolute: 8192 };
    const t = new FlashCompletionTypist(leaf, "low", 540_000);
    const sent = [];
    t.adapter.transport = { backend: "api-key", location: "", createCache: async () => undefined, generate: async (a) => { sent.push(a); return { text: '{"path":"a.py","content":"x = 1\\n"}', usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, finishReason: "STOP" }; } };
    const packet = { id: "U01", phase: "codegen", task_type: "dto", module: "spec", instruction: "WRITE", inputs: [], outputSchema: FILE_ANSWER_SCHEMA, acceptance: [], budget: { maxInputTokens: 400000, maxOutputTokens: 0 }, pass_id: "p" };
    const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, shared: "SHARED BLOCK", sharedFile: "/dev/null", framed: "", contract: "file", passId: "p" });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].prompt.startsWith("## Project header (inlined; cache miss)\nSHARED BLOCK\n"), "the shared block comes first");
    assert.deepEqual(sent[0].generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.deepEqual(sent[0].generationConfig.responseSchema, FILE_ANSWER_SCHEMA);
    assert.equal(sent[0].generationConfig.maxOutputTokens, 8192, "the leaf's own output cap");
    assert.deepEqual(sent[0].generationConfig.httpOptions, { timeout: 540_000 }, "the stated time limit, on the request itself");
    assert.deepEqual(r.answer, { path: "a.py", content: "x = 1\n" });
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

test("the answer contract is read strictly: one JSON object with string path and content, nothing repaired", () => {
  assert.deepEqual(parseAnswer('{"path":"a.py","content":"x=1\\n"}', "file"), { path: "a.py", content: "x=1\n" });
  assert.deepEqual(parseAnswer({ path: "a.py", content: "" }, "file"), { path: "a.py", content: "" });
  for (const bad of ['```json\n{"path":"a.py","content":"x"}\n```', 'Here it is: {"path":"a.py","content":"x"}', '{"path":"a.py"}', '{"path":1,"content":"x"}', "", null, '{"path":"a.py","edits":[{"search":"a","replace":"b"}]}']) {
    assert.equal(parseAnswer(bad, "file"), null, String(bad));
  }
});

test("the fix contract: exact edits, or the whole file, never both and never neither", () => {
  assert.deepEqual(parseAnswer('{"path":"a.py","edits":[{"search":"x = 1","replace":"x = 2"}]}', "edit"), { path: "a.py", edits: [{ search: "x = 1", replace: "x = 2" }] });
  assert.deepEqual(parseAnswer({ path: "a.py", content: "x = 2\n" }, "edit"), { path: "a.py", content: "x = 2\n" });
  for (const bad of ['{"path":"a.py"}', '{"path":"a.py","edits":[]}', '{"path":"a.py","edits":[{"search":"","replace":"b"}]}', '{"path":"a.py","edits":[{"search":"a"}]}', '{"path":"a.py","content":"x","edits":[{"search":"a","replace":"b"}]}']) {
    assert.equal(parseAnswer(bad, "edit"), null, bad);
  }
  assert.deepEqual(EDIT_ANSWER_SCHEMA.required, ["path"]);
  assert.deepEqual(FILE_ANSWER_SCHEMA.required, ["path", "content"]);
});

test("vendor and network failures are told apart from bad answers by the vendor's own fields, never by its wording", () => {
  // HTTP semantics (RFC 9110: 408, 429, 5xx) and Anthropic's 529; Node/undici transit codes.
  for (const s of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isTransient(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422, null, undefined]) assert.equal(isTransient(s), false, String(s));
  for (const c of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) assert.equal(isTransient(undefined, c), true, c);
  assert.equal(isTransient(undefined, "ENOENT"), false);
  for (const c of ["ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]) assert.equal(isTransient(undefined, c), true, `${c}: no connection, so wait`);

  // claude -p: its JSON result carries is_error, subtype and api_error_status.
  const opus = (o) => leanOpusOutcome(o);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 429, result: "API Error: 429" }).transport, true);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 529, result: "Overloaded" }).transport, true);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 401, result: "rate limit" }).transport, false, "the words do not decide");
  assert.equal(opus({ is_error: true, subtype: "error_max_turns", api_error_status: null, result: "Overloaded" }).transport, false);

  // The completion door: the HTTP status, network code and RetryInfo delay the adapter recorded on the attempt.
  assert.deepEqual(flashOutcome({ error_status: 429, retry_after_ms: 12000 }), { transport: true, retry_after_ms: 12000, cut_off: false });
  assert.deepEqual(flashOutcome({ error_code: "ECONNRESET" }), { transport: true, retry_after_ms: undefined, cut_off: false });
  assert.deepEqual(flashOutcome({ error_status: 400 }), { transport: false, retry_after_ms: undefined, cut_off: false });
  assert.deepEqual(flashOutcome(undefined), { transport: false, retry_after_ms: undefined, cut_off: false });

  // The agent door: the SDK retries transient API errors itself, so any error that reaches the receipt is an attempt
  // (fail closed), whatever its message says; the status it carries is reported (typistWorkerStatus.test.mjs).
  assert.equal(agyOutcome({ error: "AntigravityExecutionError: executor run failed: Resource exhausted", error_type: "AntigravityExecutionError" }).transport, false);
});

test("each policy leaf gets the typist of its door; every shipped policy has a lean Opus leaf to fall back to", (t) => {
  // Building a lean Opus typist reads `claude --help` (claudeHelp), so the test puts a fake claude that lists the
  // lean route's flags first on PATH: its result then never depends on whether the machine running it has
  // Claude Code installed (a test machine without it would fail with spawnSync claude ENOENT).
  const bin = mkdtempSync(join(tmpdir(), "fakeclaude-help-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncat <<'HELPTEXT'\n${HELP}\nHELPTEXT\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const orch = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const solo = loadPolicyFromPath(join(POLICIES, "opus-only-v5.yaml"));
  const byId = (p, id) => p.models.find((m) => m.id === id);
  assert.equal(typistForLeaf(byId(orch, "opus"), "estimated").door, "lean-opus");
  assert.equal(typistForLeaf(byId(solo, "opus"), "estimated").door, "lean-opus");
  assert.equal(fallbackLeaf(orch).id, "opus");
  assert.equal(fallbackLeaf(solo).model_name, "claude-opus-5", "solo's fallback is the same Opus as its typist");
  assert.equal(fallbackLeaf(orch).model_name, fallbackLeaf(solo).model_name, "both policies fall back to the same model");
  assert.equal(TYPIST_EFFORT, "low");
  assert.ok(existsSync(TYPIST_WORKER), "the agent typist's worker ships with the plugin");
  assert.throws(() => typistForLeaf({ id: "x", adapter: "nope", model_name: "m" }, "estimated"), /no typist for adapter 'nope'/);
});

test("a typist process that exits before reading its brief is a failed attempt, never a crashed server", async () => {
  // A brief over the pipe's 64 KB buffer, written to a child that has already exited, raises EPIPE; left
  // unhandled, it takes the MCP server down.
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fakebin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 3\n");
  chmodSync(join(bin, "claude"), 0o755);
  const { LeanOpusTypist } = await import("../dist/executor/typists.js");
  const leaf = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", pricing: { input: 5, input_cached: 0.5, output: 25 } };
  const t = new LeanOpusTypist(leaf, { authMode: "estimated", effort: "low", timeoutMs: 10_000, help: HELP, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp" } });
  const packet = { id: "U01", phase: "debug", task_type: "other", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
  const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "y".repeat(300_000), shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
  assert.equal(r.answer, null);
  assert.equal(r.transport, false);
  assert.match(r.error, /no JSON receipt/);
});

test("an agent worker whose receipt is damaged is a failed attempt, never a thrown error", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fakepy-"));
  // A stand-in for the worker's Python: writes half a receipt to --out and exits.
  writeFileSync(join(bin, "python"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then printf \'{"finish_output": "{\\"pa\' > "$2"; fi; shift; done\nexit 0\n');
  chmodSync(join(bin, "python"), 0o755);
  const policy = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: join(bin, "python") });
  try {
    const t = typistForLeaf(policy.models.find((m) => m.id === "flash-agsdk-worker"), "estimated");
    const packet = { id: "U01", phase: "codegen", task_type: "dto", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
    const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "y", shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
    assert.equal(r.answer, null);
    assert.equal(r.transport, false);
    assert.match(r.error, /unreadable receipt/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("each door says when an answer stopped at its output limit, from the vendor's own stop reason", () => {
  // The executor sends a cut-off file to the typist with a larger limit instead of retrying the same one.
  // Only the vendor's stop reason decides, never a length guess.
  assert.equal(flashOutcome({ stop_reason: "MAX_TOKENS" }).cut_off, true, "Gemini finishReason MAX_TOKENS");
  assert.equal(flashOutcome({ stop_reason: "STOP" }).cut_off, false);
  assert.equal(flashOutcome(undefined).cut_off, false);
  assert.equal(leanOpusOutcome({ stop_reason: "max_tokens" }).cut_off, true, "Anthropic stop_reason max_tokens");
  assert.equal(leanOpusOutcome({ stop_reason: "end_turn" }).cut_off, false);
});

/** A policy file with two Claude models in a `premium` slot (sonnet by default) and a completion Flash. */
async function slotPolicy(defaultRule) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "slot-policy-"));
  writeFileSync(join(dir, "p.yaml"), `version: 1
name: slots
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: sonnet
    adapter: builtin-anthropic
    model_name: claude-sonnet-5
  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.8-flash
select:
  premium: { default: sonnet, options: [opus, sonnet] }
rules:
  - when: { phase: requirements_analysis }
    use: premium
  - when: { phase: [codegen, tests, docs, debug] }
    use: flash
  - default: ${defaultRule}
`);
  return loadPolicyFromPath(join(dir, "p.yaml"));
}

test("the last attempt goes to the Claude model the run selected: a default rule that names a slot is resolved by the run's choice, and a de-selected model is never used", async () => {
  const bySlot = await slotPolicy("premium");
  assert.equal(fallbackLeaf(bySlot).id, "sonnet", "the slot's own default");
  assert.equal(fallbackLeaf(bySlot, { premium: "sonnet" }).id, "sonnet");
  assert.equal(fallbackLeaf(bySlot, { premium: "opus" }).id, "opus");
  // A default that is not a Claude model: the first Claude model the run can reach, never one its slot choice ruled out.
  const flashDefault = await slotPolicy("flash");
  assert.equal(fallbackLeaf(flashDefault).id, "sonnet");
  assert.equal(fallbackLeaf(flashDefault, { premium: "opus" }).id, "opus");
});

test("an agent typist call leaves no scratch folder behind", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fakepy-"));
  writeFileSync(join(bin, "receipt.json"), JSON.stringify({ finish_output: JSON.stringify({ path: "a.py", content: "x = 1\n" }) }));
  // A stand-in for the worker's Python: records its --workdir and writes a whole receipt to --out.
  writeFileSync(join(bin, "python"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--workdir" ]; then echo "$2" > "${bin}/workdir.txt"; fi\n  if [ "$1" = "--out" ]; then cp "${bin}/receipt.json" "$2"; fi\n  shift\ndone\nexit 0\n`);
  chmodSync(join(bin, "python"), 0o755);
  const policy = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: join(bin, "python") });
  try {
    const t = typistForLeaf(policy.models.find((m) => m.id === "flash-agsdk-worker"), "estimated");
    const packet = { id: "U01", phase: "codegen", task_type: "dto", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
    const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "y", shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
    assert.deepEqual(r.answer, { path: "a.py", content: "x = 1\n" }, "the receipt is read before the folder goes");
    const workdir = readFileSync(join(bin, "workdir.txt"), "utf8").trim();
    assert.match(workdir, /mmo-agy-typist-/);
    assert.equal(existsSync(workdir), false, "brief, schema, receipt and the SDK's own files are removed after the call");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
