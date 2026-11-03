/**
 * A thinking step (run_thinking_step on an antigravity-worker leaf) sends MCP progress while its worker runs, as an
 * agent-door dispatch does, so a client's idle limit cannot cut a step the server is still running: Claude Code aborts
 * a local server's call that sends no reply and no progress for 30 minutes, and a thinking step may run for hours.
 * Through the real server, with a stand-in worker interpreter that runs past one progress interval (30 s). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";
import { beat, fakeWorkerPython } from "./agyFakes.mjs";

// E-thinking-progress.
test("a thinking step that runs past one progress interval sends progress before its reply", { timeout: 90_000 }, async () => {
  const beats = Array.from({ length: 38 }, (_, i) => ({ atMs: 1_000 * (i + 1), hb: beat({ work_s: i + 1 }) }));
  const summary = { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1", text: "ok" };
  const fake = fakeWorkerPython({ runs: [{ beats, holdMs: 38_000, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: JSON.stringify(summary) }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: agy-think\nmodels:\n  - id: flash\n    adapter: antigravity-worker\n    model_name: gemini-3.8-flash\nrules:\n  - default: flash\n");
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r1" })).json?.ok, true);
      const r = await call("run_thinking_step", { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, output_dir: "out", run_id: "r1", policy_path }, { onprogress: () => {}, timeout: 80_000 });
      assert.notEqual(r.isError, true, r.text);
      assert.equal(r.json?.route, "done", r.text);
      assert.ok(r.progress.length >= 1, "no progress was sent during a 38 s thinking step");
      assert.match(r.progress[0].message, /thinking/, `the heartbeat says a thinking step is running: ${r.progress[0].message}`);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});

// E-thinking-summary.
test("a thinking step's summary is read whatever its worker's exit: all accepted is done, pieces owed is stopped with them", { timeout: 60_000 }, async () => {
  const sidecar = { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } };
  const fake = fakeWorkerPython({ runs: [
    { holdMs: 100, sidecar, exitCode: 1, stderr: "thinking_worker failed: Interrupted\n", summary: { done: true, missing: [], accepted: ["requirements"], conversation_id: "conv-1", text: "" } },
    { holdMs: 100, sidecar, exitCode: 1, stderr: "thinking_worker failed: budget\n", summary: { done: false, missing: ["requirements"], accepted: [], conversation_id: "conv-2", text: "" } },
  ] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: agy-think\nmodels:\n  - id: flash\n    adapter: antigravity-worker\n    model_name: gemini-3.8-flash\nrules:\n  - default: flash\n");
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path, project_root: root, run_id: "r1" })).json?.ok, true);
      const step = { role: "requirements", prompt: "The brief is in brief.md.", project_root: root, output_dir: "out", run_id: "r1", policy_path };
      const done = await call("run_thinking_step", step);
      assert.equal(done.json?.route, "done", done.text);
      const owed = await call("run_thinking_step", step);
      assert.equal(owed.json?.route, "stopped", owed.text);
      assert.deepEqual(owed.json?.missing, ["requirements"]);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});
