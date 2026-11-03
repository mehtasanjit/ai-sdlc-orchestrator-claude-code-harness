/**
 * A thinking step is routed by the run its pre-flight recorded, never by its own call's arguments: a call with no
 * recorded run is refused, a call that leaves the job out is routed with the run's job, and a call that names another
 * job is refused. Review: either gap turned a step the route table gave Gemini into the session's, on Claude, silently.
 * Through the real server, with a stand-in worker interpreter. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";
import { fakeWorkerPython } from "./agyFakes.mjs";

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
  const step = (over) => ({ role: "requirements", prompt: "The brief is in brief.md.", project_root: root, output_dir: "out", policy_path, ...over });
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
      const otherJob = await call("run_thinking_step", step({ run_id: "r2", intent: "docs" }));
      assert.equal(otherJob.isError, true, `another job than the run's is refused: ${otherJob.text}`);
      assert.match(otherJob.text, /job/);
    });
  } finally {
    fake.cleanup();
    cleanup(bin, root);
  }
});
