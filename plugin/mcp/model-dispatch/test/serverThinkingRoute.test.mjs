/**
 * A thinking step is routed by the run its pre-flight recorded, never by its own call's arguments: a call with no
 * recorded run is refused, a call that leaves the job out is routed with the run's job, and a call that names another
 * job is refused. Review: either gap turned a step the route table gave Gemini into the session's, on Claude, silently.
 * Through the real server, with a stand-in worker interpreter. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { cleanup, events, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";
import { fakeWorkerPython, flagValue } from "./agyFakes.mjs";

// E-thinking-route.
test("a thinking step is routed by its run's pre-flight: no recorded run, or another job, is refused", { timeout: 60_000 }, async () => {
  const summary = { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1", text: "" };
  const fake = fakeWorkerPython({ runs: [{ holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: JSON.stringify(summary), summary }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  // Requirements go to Gemini for a bugfix job only; every other step stays on the session's Claude model.
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: job-think", "models:",
    "  - id: opus", "    adapter: builtin-anthropic", "    model_name: claude-opus-5",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: requirements_analysis, intent: bugfix }", "    use: flash", "  - default: opus", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  const step = (over) => ({ role: "requirements", prompt: "The brief is in brief.md.", project_root: root, output_dir: "out", policy_path, telemetry_path: "out/telemetry.jsonl", ...over });
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      const pf = await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r2", intent: "bugfix" });
      assert.equal(pf.json?.ok, true, pf.text);
      const unrecorded = await call("run_thinking_step", step({}));
      assert.equal(unrecorded.isError, true, `a step with no recorded run is refused: ${unrecorded.text}`);
      assert.match(unrecorded.text, /pre-flight/);
      const routed = await call("run_thinking_step", step({ run_id: "r2" }));
      assert.equal(routed.json?.route, "done", `routed with the run's job (bugfix), on Gemini: ${routed.text}`);
      assert.equal(routed.json?.model, "gemini-3.8-flash");
      // The step waits out a busy model for the run's whole busy window, as a batch does (busyLedger.ts).
      assert.equal(flagValue(fake.runs()[0].args, "--busy-window-sec"), "300");
      const otherJob = await call("run_thinking_step", step({ run_id: "r2", intent: "docs" }));
      assert.equal(otherJob.isError, true, `another job than the run's is refused: ${otherJob.text}`);
      assert.match(otherJob.text, /job/);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-spec-run. Review: the Gemini architect handed its sections in with no run, so an earlier run's
// unfinalized units joined its spec; the server's submit_spec_section names the run.
test("a Gemini architect's step carries its run's spec token, the one submit_spec_section uses; a new pre-flight gets a new one", { timeout: 60_000 }, async () => {
  const summary = { done: true, missing: [], accepted: ["header.json", "units-001.json", "finalize"], conversation_id: "c1", text: "" };
  const one = { holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: JSON.stringify(summary), summary };
  const fake = fakeWorkerPython({ runs: [one, one] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: plan-think", "models:",
    "  - id: opus", "    adapter: builtin-anthropic", "    model_name: claude-opus-5",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: architecture_design }", "    use: flash", "  - default: opus", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  const step = { role: "architect", prompt: "Design from requirements.md.", project_root: root, run_id: "r3", output_dir: "out", policy_path, telemetry_path: "out/telemetry.jsonl" };
  // The run's requirements, which its requirements step hands in: the architect checks coverage against them.
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", "requirements.md"), "# R\n- FR-1: ping.\n");
  const tokenOfStep = () => JSON.parse(readFileSync(join(root, "out", "thinking", "architect.tools.json"), "utf8")).run_token;
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r3" })).json?.ok, true);
      const done = await call("run_thinking_step", step);
      assert.equal(done.json?.route, "done", done.text);
      const first = tokenOfStep();
      assert.equal(typeof first, "string");
      assert.ok(first.length > 0);
      // The Claude architect's hand-in, in the same run, opens the spec under the same token.
      mkdirSync(join(root, "out", "spec.sections"), { recursive: true });
      writeFileSync(join(root, "out", "spec.sections", "header.json"), JSON.stringify({
        stack: ["Python 3.13"], commands: [{ name: "tests", run: "pytest -q", cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
        no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", reason: "simplest" }], shared: { conventions: [], data_model: [], api: [] },
      }));
      const header = await call("submit_spec_section", { spec_dir: join(root, "out"), section: "header", file: "spec.sections/header.json" });
      assert.equal(header.json?.ok, true, header.text);
      assert.equal(JSON.parse(readFileSync(join(root, "out", "spec.parts", "opened.json"), "utf8")).run, first, "one run, one token, on both paths");
      // The same run id pre-flighted again is a new run: its step gets a new token.
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r3" })).json?.ok, true);
      assert.equal((await call("run_thinking_step", step)).json?.route, "done");
      assert.notEqual(tokenOfStep(), first);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-workspace. Review: the SDK session had the real project as its workspace under an allow-all policy, so
// switching its own tools off was all that kept them off the project.
test("a thinking step's Gemini session works in an empty folder of its own; a project file changed while it runs still stops it", { timeout: 60_000 }, async () => {
  const summary = { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1", text: "" };
  const one = { holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: JSON.stringify(summary), summary };
  const fake = fakeWorkerPython({ runs: [one, { ...one, touchProject: ["src/sneaky.ts"] }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: think-flash", "models:",
    "  - id: opus", "    adapter: builtin-anthropic", "    model_name: claude-opus-5",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: requirements_analysis }", "    use: flash", "  - default: opus", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  const step = { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, run_id: "r5", output_dir: "out", policy_path, telemetry_path: "out/telemetry.jsonl" };
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r5" })).json?.ok, true);
      const done = await call("run_thinking_step", step);
      assert.equal(done.json?.route, "done", done.text);
      const workdir = resolve(flagValue(fake.runs()[0].args, "--workdir"));
      assert.notEqual(workdir, resolve(root), "not the project");
      assert.ok(!workdir.startsWith(resolve(root) + sep), `not inside the project: ${workdir}`);
      assert.match(basename(workdir), /^mmo-agy-thinking-/, "a folder of its own");
      assert.equal(existsSync(workdir), false, "removed once the step is done");
      const touched = await call("run_thinking_step", step);
      assert.equal(touched.json?.route, "stopped", touched.text);
      assert.match(touched.json?.reason ?? "", /src\/sneaky\.ts/, "the real project is still the one checked");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-setup. Review: a check that could not run for the step's own setup came back to Gemini as a refusal.
test("a step whose own setup kept a hand-in from being checked stops, saying what was wrong and where, as a setup error", { timeout: 60_000 }, async () => {
  // The worker's summary as thinking_worker.py writes it when a tool answers a setup error (thinkingWorker.test.mjs).
  const setupError = "plan-lint could not check .sdlc/runs/r6/change.sections/header.json: --intent docs is not this run's job: Gate 0 recorded bugfix (intent_brief.md)";
  const summary = { done: false, missing: ["header.json, accepted", "at least one units file, accepted"], accepted: [], conversation_id: "c1", text: "", reason: "setup", setup_error: setupError };
  const fake = fakeWorkerPython({ runs: [{ holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 }, error: setupError, error_type: "Stopped" }, summary, stdout: JSON.stringify(summary), stderr: `thinking_worker failed: ${setupError}\n`, exitCode: 1 }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: plan-think", "models:",
    "  - id: opus", "    adapter: builtin-anthropic", "    model_name: claude-opus-5",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: architecture_design }", "    use: flash", "  - default: opus", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r6", intent: "bugfix" })).json?.ok, true);
      const r = await call("run_thinking_step", { role: "brownfield-architect", prompt: "Plan the fix.", project_root: root, run_id: "r6", output_dir: ".sdlc/runs/r6", policy_path, telemetry_path: ".sdlc/runs/r6/telemetry.jsonl" });
      assert.equal(r.json?.route, "stopped", r.text);
      assert.equal(r.json.reason, `the gemini-3.8-flash step stopped on its own setup, which no hand-in can fix: ${setupError}`);
      assert.deepEqual(r.json.missing, summary.missing);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-telemetry. Review: a Gemini step's spend reached the run's telemetry only when the call passed
// telemetry_path, which the tool did not require: a step that reported $2.625 left nothing in the run's records.
test("a thinking step's spend is always recorded: a call without telemetry_path is refused, and with it the step's events are appended there", { timeout: 60_000 }, async () => {
  const summary = { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1", text: "" };
  const fake = fakeWorkerPython({ runs: [{ holdMs: 50, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 1000, candidates_token_count: 100 } }, stdout: JSON.stringify(summary), summary }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: think-flash", "models:",
    "  - id: opus", "    adapter: builtin-anthropic", "    model_name: claude-opus-5",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: requirements_analysis }", "    use: flash", "  - default: opus", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  const step = { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, run_id: "r6", output_dir: "out", policy_path };
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r6" })).json?.ok, true);
      const refused = await call("run_thinking_step", step);
      assert.equal(refused.isError, true, `a step with nowhere to record its spend is refused: ${refused.text}`);
      assert.match(refused.text, /telemetry_path is required/);
      assert.equal(fake.runs().length, 0, "nothing was sent");
      // Relative to project_root, as the run's other calls give it.
      const done = await call("run_thinking_step", { ...step, telemetry_path: "out/telemetry.jsonl" });
      assert.equal(done.json?.route, "done", done.text);
      const recorded = events(join(root, "out", "telemetry.jsonl"));
      assert.ok(recorded.length >= 1, "the step's events are in the run's telemetry");
      for (const ev of recorded) {
        assert.equal(ev.judgment_role, "requirements");
        assert.equal(ev.phase, "requirements_analysis");
      }
      assert.ok(recorded.reduce((sum, ev) => sum + (ev.cost_usd ?? 0), 0) > 0, "with the step's cost");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-discovery. Discovery is the session's Claude helper in every run: it runs before Gate 0, and so before the
// pre-flight every thinking step needs. Review: the step still offered a discovery role, routed by the policy (Gemini
// under argon4-agsdk-only) while the route table said "session", with two tools nothing called.
test("discovery is not a thinking step: the tool refuses the role, and the step's roles and tools hold no discovery", { timeout: 60_000 }, async () => {
  const { THINKING_ROLES } = await import("../dist/thinking.js");
  const { ROLE_TOOLS, ThinkingTools } = await import(new URL("../../../scripts/thinking-tools.mjs", import.meta.url).href);
  const worker = readFileSync(new URL("../worker/thinking_worker.py", import.meta.url), "utf8");
  assert.equal("discovery" in THINKING_ROLES, false, "no discovery role");
  assert.deepEqual(Object.keys(ROLE_TOOLS).sort(), Object.keys(THINKING_ROLES).sort(), "the tools serve exactly the step's roles");
  for (const tool of ["baseline_status", "write_discovery"]) {
    assert.equal(typeof ThinkingTools.prototype[tool], "undefined", `the tool process has no ${tool}`);
    assert.doesNotMatch(worker, new RegExp(`\\b${tool}\\b`), `the worker offers no ${tool}`);
  }
  assert.doesNotMatch(worker.match(/^ROLE_TOOLS = \{[\s\S]*?^\}/m)?.[0] ?? "", /discovery/, "the worker's role table has no discovery");

  // A policy that names an agent leaf for discovery, as the Gemini policies do: the call is refused before anything
  // is sent, and the route table still gives discovery to the session.
  const fake = fakeWorkerPython({ runs: [{}] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: discovery-flash", "session_model: claude-opus-5-5", "models:",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: discovery }", "    use: flash", "  - default: flash", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      const pf = await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r7", intent: "bugfix" });
      assert.equal(pf.json?.ok, true, pf.text);
      assert.equal(pf.json.route_table.find((r) => r.phase === "discovery")?.who, "session");
      const r = await call("run_thinking_step", { role: "discovery", prompt: "Read the repository.", project_root: root, output_dir: ".sdlc/runs/r7", run_id: "r7", intent: "bugfix", policy_path, telemetry_path: ".sdlc/runs/r7/telemetry.jsonl" });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /unknown role 'discovery'/);
      assert.equal(fake.runs().length, 0, "nothing was sent");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-no-rule. Review: a policy with no default rule and no rule for a thinking phase failed pre-flight with the
// routing's raw "no rule matching" exception, though before thinking steps followed the policy the session ran them.
test("a policy with no rule for a thinking phase passes pre-flight, and its table and the step both give the phase to the session", { timeout: 60_000 }, async () => {
  const fake = fakeWorkerPython({ runs: [{}] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: typing-only", "models:",
    "  - id: flash", "    adapter: antigravity-worker", "    model_name: gemini-3.8-flash",
    "rules:", "  - when: { phase: [codegen, tests, docs, debug] }", "    use: flash", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      const pf = await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r8" });
      assert.equal(pf.isError, false, pf.text);
      assert.equal(pf.json?.ok, true, pf.text);
      for (const phase of ["requirements_analysis", "architecture_design", "senior_code_review", "security_review"]) {
        const r = pf.json.route_table.find((x) => x.phase === phase);
        assert.deepEqual([r?.who, r?.reason], ["session", "no rule names this phase; the session's helper runs it as before"], phase);
      }
      const step = await call("run_thinking_step", { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, run_id: "r8", output_dir: "out", policy_path, telemetry_path: "out/telemetry.jsonl" });
      assert.equal(step.json?.route, "session", step.text);
      assert.equal(fake.runs().length, 0, "nothing was sent");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-session-model. A rule `use: session_model` gives a thinking phase back to the session's own Claude model,
// in one line: pre-flight's table and the step both say "session", and nothing is sent to Gemini.
test("a thinking phase its rule gives to session_model: pre-flight's table and the step give it to the session", { timeout: 60_000 }, async () => {
  const fake = fakeWorkerPython({ runs: [{}] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), [
    "version: 1", "name: argon-but-requirements", "session_model: claude-opus-5-5", "models:",
    "  - id: argon", "    adapter: antigravity-worker", "    model_name: gemini-4-argon",
    "rules:", "  - when: { phase: requirements_analysis }", "    use: session_model", "  - default: argon", "",
  ].join("\n"));
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      const pf = await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r9" });
      assert.equal(pf.json?.ok, true, pf.text);
      const rows = Object.fromEntries(pf.json.route_table.map((r) => [r.phase, r]));
      assert.deepEqual([rows.requirements_analysis.who, rows.requirements_analysis.model, rows.requirements_analysis.reason], ["session", "claude-opus-5-5", "the policy's rule"]);
      assert.equal(rows.architecture_design.who, "engine, thinking");
      const step = await call("run_thinking_step", { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, run_id: "r9", output_dir: "out", policy_path, telemetry_path: "out/telemetry.jsonl" });
      assert.equal(step.json?.route, "session", step.text);
      assert.equal(step.json?.model, "claude-opus-5-5");
      assert.equal(fake.runs().length, 0, "nothing was sent");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});
