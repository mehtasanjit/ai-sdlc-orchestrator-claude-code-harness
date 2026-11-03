/**
 * An agent-door dispatch (execute_with_model with a non-apply packet routed to an antigravity-worker leaf) sends MCP
 * progress while its worker runs, as apply packets and batches already do, so a client's idle limit cannot cut a call
 * the server is still running. Through the real server, with a stand-in worker interpreter that runs past one
 * progress interval (30 s). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";
import { beat, fakeWorkerPython } from "./agyFakes.mjs";

// E-agent-progress.
test("an agent-door dispatch that runs past one progress interval sends progress before its reply", { timeout: 90_000 }, async () => {
  const beats = Array.from({ length: 38 }, (_, i) => ({ atMs: 1_000 * (i + 1), hb: beat({ work_s: i + 1 }) }));
  const fake = fakeWorkerPython({ runs: [{ beats, holdMs: 38_000, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: '{"ok":true}' }] });
  const bin = standInClaude([receipt({})]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: agy-only\nmodels:\n  - id: flash\n    adapter: antigravity-worker\n    model_name: gemini-3.8-flash\nrules:\n  - default: flash\n");
  const plain = { id: "tp_design_001", phase: "design", task_type: "design", module: "all", pass_id: "r1", instruction: "Design it.", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 8000, maxOutputTokens: 4000 } };
  try {
    await withServer({ bin, home: root, env: { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: fake.python } }, async (call) => {
      assert.equal((await call("preflight_dispatch", { auth_mode: "estimated", policy_path: join(root, "policy.yaml"), project_root: root })).json?.ok, true);
      const r = await call("execute_with_model", { packet: plain, policy_path: join(root, "policy.yaml"), project_root: root, work_dir: root }, { onprogress: () => {}, timeout: 80_000 });
      assert.notEqual(r.isError, true, r.text);
      assert.ok(r.progress.length >= 1, "no progress was sent during a 38 s agent dispatch");
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});
