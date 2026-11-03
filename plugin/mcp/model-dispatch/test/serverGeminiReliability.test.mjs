/**
 * What the server adds for the Antigravity doors, through the real server (dist/server.js over MCP stdio): pre-flight
 * asks the worker's own interpreter which google-antigravity it has and stops a run on a known different version;
 * pre-flight records the run's binding (project, locations, policy, versions) beside its telemetry and stops a later
 * pre-flight of the same run on another project; the agent door needs this server process's pre-flight; the run-start
 * probe calls every location of a failover leaf and every Antigravity leaf the run can reach, and names what is wrong
 * by Google's status; a refused login halts a batch on this door; every Gemini event carries the gemini record (and
 * a redirected endpoint), Claude events stay as they were; a stop reaches a running typist. Offline, $0: stand-ins
 * for `claude` and for the worker's interpreter, and the real typist worker against the scripted stand-in SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calledModels, cleanup, events, packet, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";
import { alive, beat, fakeWorkerPython, flagValue } from "./agyFakes.mjs";
import { NO_PYTHON, PYTHON, STANDIN, recorded } from "./agyStandin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOGLE = { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global" };
const AGY_CODEGEN = (extra = "") => `version: 1
name: agy-codegen
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: flash
    adapter: antigravity-worker
    model_name: gemini-3.8-flash
${extra}
rules:
  - when: { phase: codegen }
    use: flash
  - default: opus
`;
const AGY_ONLY = `version: 1
name: agy-only
models:
  - id: flash
    adapter: antigravity-worker
    model_name: gemini-3.8-flash
rules:
  - default: flash
`;
const ANSWER = (path = "src/a.txt") => ({ finish_output: JSON.stringify({ path, content: "x\n" }), text: "Finished", usage: { prompt_token_count: 1200, cached_content_token_count: 0, candidates_token_count: 300, thoughts_token_count: 40, total_token_count: 1540 }, sdk_version: "0.1.22", tool_calls: ["finish"], error: null, error_type: null, vertex_project: "test-project", vertex_location: "global" });
const preflight = (call, root, extra = {}) => call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", ...extra });
const batch = (call, root, packets, extra = {}) => call("execute_batch", { packets, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real typist worker's interpreter, with the scripted stand-in SDK in place of google-antigravity. */
function realWorkerPython(events) {
  const dir = mkdtempSync(join(tmpdir(), "real-worker-"));
  writeFileSync(join(dir, "script.json"), JSON.stringify({ sessions: [{ turns: [events] }] }));
  const python = join(dir, "python");
  writeFileSync(python, `#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(STANDIN)} AGY_STANDIN_SCRIPT=${JSON.stringify(join(dir, "script.json"))} AGY_STANDIN_LOG=${JSON.stringify(join(dir, "log.jsonl"))}\nexec ${JSON.stringify(PYTHON)} "$@"\n`);
  chmodSync(python, 0o755);
  const log = () => (existsSync(join(dir, "log.jsonl")) ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { python, dir, log };
}

// E-401-halts-agy: the status now reaches the engine, so the existing halt fires.
test("a refused login on the typist door halts the batch with HTTP 401 at the first call, through the real worker: no further attempt, no Claude call", { skip: NO_PYTHON }, async () => {
  const w = realWorkerPython(recorded("refused_401"));
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), AGY_CODEGEN());
  try {
    await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: w.python } }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const r = await batch(call, root, [packet("tp_codegen_U01", "src/a.txt"), packet("tp_codegen_U02", "src/b.txt")]);
      assert.match(String(r.json?.halted), /HTTP 401/, r.text);
      assert.deepEqual((r.json?.items ?? []).map((i) => [i.status, i.attempts]), [["dispatch_failed", 1], ["dispatch_failed", 1]], r.text);
    });
    // execute_batch starts both packets at once (four at a time), so each makes its one call before either 401 comes
    // back: one session per packet, in its own worker. A further attempt, a packet started after the halt or a hand-off
    // to another model would add a session.
    const sessions = w.log().filter((e) => e.ev === "agent");
    assert.equal(sessions.length, 2, "one call per packet, none after the halt");
    assert.equal(new Set(sessions.map((e) => e.pid)).size, 2, "each packet's call in its own worker");
    assert.deepEqual(calledModels(bin), [], "the refused login is never handed to Claude");
  } finally {
    cleanup(bin, root, w.dir);
  }
});

// E-agent-door-needs-preflight.
test("a fresh server refuses an agent-door dispatch until this process's pre-flight has checked the Google project and SDK, and dispatches it after", async () => {
  const fake = fakeWorkerPython({ runs: [{ sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: '{"ok":true}' }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), AGY_ONLY);
  const plain = { id: "tp_req_001", phase: "requirements_analysis", task_type: "analysis", module: "all", pass_id: "r1", instruction: "Analyse.", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 8000, maxOutputTokens: 4000 } };
  try {
    await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      const before = await call("execute_with_model", { packet: plain, policy_path: join(root, "policy.yaml"), project_root: root, work_dir: root });
      assert.equal(before.isError, true, `dispatched with no pre-flight: ${before.text}`);
      assert.match(before.text, /preflight_dispatch/);
      assert.equal(fake.runs().length, 0, "nothing was spent");
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path: join(root, "policy.yaml"), project_root: root })).json?.ok, true);
      const after = await call("execute_with_model", { packet: plain, policy_path: join(root, "policy.yaml"), project_root: root, work_dir: root });
      assert.notEqual(after.isError, true, after.text);
    });
    assert.equal(fake.runs().length, 1);
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-preflight-sdk-version: the version that runs is the version tested.
test("pre-flight asks the worker's interpreter for its google-antigravity version: a known different version stops the run with the setup fix, the pinned one passes and is reported, an unreadable one is a warning", async () => {
  const run = async (version) => {
    const fake = fakeWorkerPython({ version });
    const bin = standInClaude([receipt({})]);
    const root = project({ contract: false });
    writeFileSync(join(root, "policy.yaml"), AGY_ONLY);
    try {
      return await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python } }, (call) => call("preflight_dispatch", { auth_mode: "estimated", policy_path: join(root, "policy.yaml"), project_root: root }));
    } finally {
      fake.cleanup();
      cleanup(bin, root);
    }
  };
  const old = await run("0.1.16");
  assert.equal(old.json?.ok, false, old.text);
  assert.match(old.json.halt_reason, /0\.1\.16/);
  assert.match(old.json.halt_reason, /0\.1\.22/);
  assert.match(old.json.halt_reason, /\/mmo:setup/);
  const pinned = await run("0.1.22");
  assert.equal(pinned.json?.ok, true, pinned.text);
  assert.match(JSON.stringify(pinned.json.agsdk ?? null), /0\.1\.22/, "pre-flight reports the version that will run");
  const unknown = await run(null);
  assert.equal(unknown.json?.ok, true, `an unreadable version is no halt: ${unknown.text}`);
  assert.ok(unknown.json.warnings.some((w) => /google-antigravity|version/i.test(w)), unknown.text);
});

// E-run-binding-project-changed: run-binding.json.
test("pre-flight writes run-binding.json beside the run's telemetry, and a later pre-flight of the same run on another project stops; the same project passes", async () => {
  const fake = fakeWorkerPython({ version: "0.1.22" });
  const bin = standInClaude([receipt({})]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), AGY_CODEGEN());
  const telemetry_path = join(root, ".sdlc", "runs", "r1", "telemetry.jsonl");
  const pre = (projectId) => withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: projectId, GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, (call) => preflight(call, root, { telemetry_path, intent: "bugfix" }));
  try {
    const first = await pre("proj-a");
    assert.equal(first.json?.ok, true, first.text);
    const bindingFile = join(dirname(telemetry_path), "run-binding.json");
    assert.ok(existsSync(bindingFile), "run-binding.json beside telemetry.jsonl");
    const binding = JSON.parse(readFileSync(bindingFile, "utf8"));
    assert.equal(binding.project, "proj-a");
    assert.equal(binding.policy?.name ?? binding.policy, "agy-codegen");
    assert.equal(binding.auth_mode, "estimated");
    for (const k of ["plugin_version", "sdk_version"]) assert.ok(k in binding, `${k} in ${JSON.stringify(binding)}`);
    assert.match(JSON.stringify(binding), /global/, "the leaves' locations");
    const moved = await pre("proj-b");
    assert.equal(moved.json?.ok, false, `a restarted server on another project went on: ${moved.text}`);
    assert.match(moved.json.halt_reason, /proj-a/);
    assert.match(moved.json.halt_reason, /proj-b/);
    assert.equal((await pre("proj-a")).json?.ok, true, "the same project passes");
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

/** A probing pre-flight with the given policy, the worker stand-in and `claude` stand-in; returns the reply and the worker runs. */
async function probeWith(policyYaml, runs, env = {}) {
  const fake = fakeWorkerPython({ runs, version: "0.1.22" });
  const bin = standInClaude([receipt({ path: "probe.txt", content: "ok" })]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), policyYaml);
  try {
    const r = await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python, ...env } }, (call) => call("preflight_dispatch", { auth_mode: "estimated", policy_path: join(root, "policy.yaml"), project_root: root, probe_typists: true, run_id: "r1", telemetry_path: join(root, "t.jsonl") }));
    return { r, runs: fake.runs(), claude: calledModels(bin) };
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
}

// E-probe-failover-locations: a location that does not serve the model is found before the run.
test("the run-start probe of a leaf with failover_locations calls each of its locations once, each pinned to that one location", async () => {
  const { r, runs } = await probeWith(AGY_ONLY.replace("model_name: gemini-3.8-flash", "model_name: gemini-3.8-flash\n    failover_locations: [us, eu]"), [{ receipt: ANSWER("probe.txt") }]);
  assert.equal(r.json?.ok, true, r.text);
  const at = runs.filter((x) => x.args.some((a) => a.endsWith("typist_worker.py"))).map((x) => flagValue(x.args, "--locations") ?? flagValue(x.args, "--region"));
  assert.deepEqual([...at].sort(), ["eu", "global", "us"], `probe calls at ${JSON.stringify(at)}`);
  for (const x of runs) {
    const locs = flagValue(x.args, "--locations");
    if (locs !== undefined) assert.ok(!locs.includes(","), "each probe is pinned to one location, with failover off");
  }
});

// E-probe-judgment-leaf.
test("the run-start probe calls an antigravity-worker leaf the policy only judges with, through the typist worker", async () => {
  const policy = `version: 1
name: judge-on-gemini
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: argon
    adapter: antigravity-worker
    model_name: gemini-4-argon
rules:
  - when: { phase: requirements_analysis }
    use: argon
  - default: opus
`;
  const { r, runs, claude } = await probeWith(policy, [{ receipt: ANSWER("probe.txt") }]);
  assert.equal(r.json?.ok, true, r.text);
  const argon = runs.filter((x) => flagValue(x.args, "--model") === "gemini-4-argon");
  assert.equal(argon.length, 1, `the judgment leaf was not probed: ${JSON.stringify(runs.map((x) => x.args.slice(0, 3)))}`);
  assert.ok(argon[0].args[0].endsWith("typist_worker.py"), "probed with the typist worker, one cheap call");
  assert.deepEqual(r.json.typist_probe.map((p) => p.model_id).sort(), ["argon", "opus"]);
  assert.deepEqual(claude, ["claude-opus-5"], "the typing leaf is probed as before");
});

// E-probe-status-texts.
test("a probe refused by Google names what is wrong: 401/403 name the project and give Google's message; 400/404 name the model or location and not the login", async () => {
  const fail = (status, message) => ({ receipt: { finish_output: null, text: "", usage: { prompt_token_count: 0, candidates_token_count: 0 }, sdk_version: "0.1.22", tool_calls: [], error: `AntigravityConnectionError: Agent execution terminated due to error. ("agent executor error: Error ${status}, Message: ${message}")`, error_type: "AntigravityConnectionError", error_status: status } });
  for (const status of [401, 403]) {
    const { r } = await probeWith(AGY_ONLY, [fail(status, "The caller does not have permission")], { GOOGLE_CLOUD_PROJECT: "probe-proj-7" });
    assert.equal(r.json?.ok, false, r.text);
    assert.match(r.json.halt_reason, /probe-proj-7/, `${status}: names the project`);
    assert.match(r.json.halt_reason, /The caller does not have permission/, `${status}: Google's message`);
  }
  for (const status of [400, 404]) {
    const { r } = await probeWith(AGY_ONLY, [fail(status, "Publisher Model was not found or your project does not have access to it.")]);
    assert.equal(r.json?.ok, false, r.text);
    assert.match(r.json.halt_reason, /model|location/i);
    assert.match(r.json.halt_reason, /gemini-3\.8-flash|global/);
    assert.doesNotMatch(r.json.halt_reason, /application-default login/, `${status}: a wrong model or location is not a login problem`);
  }
});

// E-endpoint-override: a redirected run can never pass for a Google run.
test("with GOOGLE_VERTEX_BASE_URL in the server's environment, pre-flight warns and every Gemini event records the override", async () => {
  const fake = fakeWorkerPython({ runs: [{ receipt: ANSWER() }] });
  const bin = standInClaude([receipt({})]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), AGY_CODEGEN());
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python, GOOGLE_VERTEX_BASE_URL: "http://127.0.0.1:9/" } }, async (call) => {
      const pre = await preflight(call, root);
      assert.ok(pre.json?.warnings?.some((w) => w.includes("GOOGLE_VERTEX_BASE_URL")), pre.text);
      const r = await batch(call, root, [packet("tp_codegen_U01", "src/a.txt")], { telemetry_path });
      assert.equal(r.json?.counts?.applied, 1, r.text);
    });
    const [ev] = events(telemetry_path).filter((e) => e.door === "agy");
    assert.equal(ev?.gemini?.endpoint_override, "http://127.0.0.1:9/", JSON.stringify(ev));
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

/** The lean Opus event of a brownfield packet as the engine wrote it before the gemini record, without its clock fields. */
const CLAUDE_EVENT_GOLDEN = JSON.parse(readFileSync(join(HERE, "fixtures", "claude-event-golden.json"), "utf8"));
const unclocked = (e) => { const { ts, latency_ms, ...rest } = e; return rest; };

// E-gemini-block-events and E-claude-events-identical.
test("a Gemini event carries the gemini record with every try, its top-level tokens are the tries' sums, no heartbeat text reaches its error; a Claude event is unchanged, byte for byte", async () => {
  const tries = [
    { location: "global", ended_by: "refused", http_codes: [429, 429], s: 2.1, start_s: 0, end_s: 2.1, usage: { prompt_token_count: 0, cached_content_token_count: 0, candidates_token_count: 0, thoughts_token_count: 0 }, served_tier: null },
    { location: "us", ended_by: "answer", http_codes: [], s: 9.8, start_s: 2.1, end_s: 11.9, usage: { prompt_token_count: 6914, cached_content_token_count: 0, candidates_token_count: 1542, thoughts_token_count: 0 }, served_tier: "standard" },
  ];
  const fake = fakeWorkerPython({ runs: [
    { receipt: { ...ANSWER("src/a.txt"), usage: tries[1].usage, vertex_location: "us", tries, stall_cuts: 0, failovers: 1, cut_calls: 0, google_wait_s: 2.1, work_s: 9.8, slept_s: 0, served_tier: "standard" } },
    { beats: [{ atMs: 10, hb: beat() }, { atMs: 60, hb: beat() }], stderr: "Traceback (most recent call last):\nRuntimeError: the worker crashed\n", holdMs: 150, exitCode: 1 },
  ] });
  const bin = standInClaude([receipt({ path: "src/c.txt", content: "from claude\n" }, { usage: { input_tokens: 100, output_tokens: 20 } })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), AGY_CODEGEN().replace("  - when: { phase: codegen }\n    use: flash", "  - when: { phase: codegen, intent: feature-new }\n    use: flash"));
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await preflight(call, root, { intent: "feature-new" })).json?.ok, true);
      const r = await batch(call, root, [packet("tp_codegen_U01", "src/a.txt", { apply: { write: true, max_retries: 0 } })], { telemetry_path });
      assert.equal(r.json?.counts?.applied, 1, r.text);
      await batch(call, root, [packet("tp_codegen_U02", "src/b.txt", { apply: { write: true, max_retries: 0 } })], { telemetry_path });
      const c = await batch(call, root, [packet("tp_docs_U03", "src/c.txt", { phase: "docs", intent: "docs" })], { telemetry_path });
      assert.equal(c.json?.counts?.applied, 1, c.text);
    });
    const evs = events(telemetry_path);
    const [moved, crashed] = evs.filter((e) => e.door === "agy");
    assert.ok(moved?.gemini, `no gemini record: ${JSON.stringify(moved)}`);
    assert.deepEqual(moved.gemini.tries.map((t) => t.location), ["global", "us"]);
    assert.equal(moved.input_tokens, moved.gemini.tries.reduce((a, t) => a + t.input_tokens, 0));
    assert.equal(moved.output_tokens, moved.gemini.tries.reduce((a, t) => a + t.output_tokens, 0));
    assert.ok(Math.abs(moved.cost_usd - moved.gemini.tries.reduce((a, t) => a + t.cost_usd, 0)) < 1e-9);
    assert.doesNotMatch(String(crashed?.error), /@mmo-heartbeat/, "heartbeat lines are kept out of error texts");
    assert.match(String(crashed?.error), /the worker crashed/, "the real error is still there");
    const claude = evs.find((e) => e.door === "lean-opus");
    assert.equal(claude?.gemini, undefined);
    assert.equal(JSON.stringify(unclocked(claude)), JSON.stringify(CLAUDE_EVENT_GOLDEN), "a Claude event serializes byte for byte as before");
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-stop-signal-typist: the Stop signal reaches a running typist.
test("stopping a batch while an agent typist runs kills the worker's process group at once and records the attempt", async () => {
  const fake = fakeWorkerPython({ runs: [{ beats: [{ atMs: 100, hb: beat() }], holdMs: 30_000, receipt: ANSWER() }] });
  const bin = standInClaude([receipt({})]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), AGY_CODEGEN());
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root, env: { ...GOOGLE, GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const stop = new AbortController();
      const running = call("execute_batch", { packets: [packet("tp_codegen_U01", "src/a.txt")], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path }, { signal: stop.signal }).catch((e) => e);
      for (let i = 0; i < 50 && !fake.runs().length; i++) await sleep(100);
      const [run] = fake.runs();
      assert.ok(run, "the worker started");
      stop.abort();
      await running;
      let dead = false;
      for (let i = 0; i < 30 && !dead; i++) { dead = !alive(run.pid); if (!dead) await sleep(100); }
      assert.ok(dead, "the running worker keeps billing for 30 s after the stop");
      let evs = [];
      for (let i = 0; i < 50 && !evs.length; i++) { evs = events(telemetry_path).filter((e) => e.door === "agy"); if (!evs.length) await sleep(100); }
      assert.equal(evs.length, 1, "the stopped call's attempt is recorded");
      assert.equal(evs[0].success, false);
    });
  } finally {
    for (const r of fake.runs()) if (alive(r.pid)) { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-stop-signal-typist, the seam: the apply form's typist adapter hands the request's signal to the typist.
test("the apply form's typist adapter passes the run's stop signal to the typist it calls", async () => {
  const { TypistApplyAdapter } = await import(join(HERE, "..", "dist", "applyTypist.js"));
  let seen;
  const typist = { door: "agy", modelId: "flash", modelName: "gemini-3.8-flash", type: async (req) => { seen = req.signal; return { answer: { path: "src/a.txt", content: "x\n" }, transport: false, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0, latency_ms: 1 }; } };
  const adapter = new TypistApplyAdapter({ id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" }, typist);
  const stop = new AbortController();
  await adapter.execute(packet("tp_codegen_U01", "src/a.txt"), undefined, { project_root: "/tmp", work_dir: "/tmp", signal: stop.signal });
  assert.equal(seen, stop.signal);
});
