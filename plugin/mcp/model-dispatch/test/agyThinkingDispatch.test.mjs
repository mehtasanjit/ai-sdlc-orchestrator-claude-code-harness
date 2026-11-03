/**
 * A thinking step's dispatch through the agent door (AntigravityWorkerAdapter with RunContext.thinking). Pinned: the
 * worker gets the step's system text (how it runs, the helper's instructions) in a file of its own, --system-file, for
 * the session's system instructions, and its task file holds the task alone; both are kept in the dispatch's evidence
 * folder and named in its delegation record. Offline, $0: a stand-in worker interpreter (agyFakes.mjs) that records
 * the arguments it was started with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeWorkerPython, flagValue, withEnv } from "./agyFakes.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));

const FLASH = { id: "flash", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
const SUMMARY = { done: true, missing: [], accepted: ["requirements"], conversation_id: "c1", text: "", reason: "done" };
const PACKET = { id: "r1-requirements", phase: "requirements_analysis", task_type: "judgment", module: "judgment", instruction: "SYSTEM\n\nTASK", inputs: [], outputSchema: { __free_text__: true }, acceptance: [], budget: { maxInputTokens: 0, maxOutputTokens: 0 }, pass_id: "r1" };

/**
 * One dispatch on `leaf`: a thinking step's when `thinking` is given (its other fields filled in), else an agent
 * packet's. Returns the worker's arguments, the files they name, and the dispatch's delegation record.
 */
async function dispatch(leaf, thinking) {
  const fake = fakeWorkerPython({ runs: [{ sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: JSON.stringify(SUMMARY), summary: SUMMARY }] });
  const dir = mkdtempSync(join(tmpdir(), "agy-thinking-dispatch-"));
  mkdirSync(join(dir, "work"));
  const step = thinking && { role: "requirements", toolsConfig: join(dir, "tools.json"), saveDir: join(dir, "save"), timeoutSec: 60, ...thinking };
  if (step) writeFileSync(step.toolsConfig, "{}");
  try {
    const result = await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global" }, () =>
      new AntigravityWorkerAdapter(leaf).execute(PACKET, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl"), ...(step ? { thinking: step } : {}) }));
    const [run] = fake.runs();
    const read = (flag) => (flagValue(run.args, flag) ? readFileSync(flagValue(run.args, flag), "utf8") : undefined);
    const record = JSON.parse(readFileSync(join(dir, "delegation", `worker-delegation-${PACKET.id}.json`), "utf8"));
    return { result, args: run.args, task: read("--task-file"), system: read("--system-file"), systemFile: flagValue(run.args, "--system-file"), record };
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

// E-thinking-system.
test("a thinking dispatch gives the worker its system text in a file of its own and the task alone as its task file, both in the evidence", { timeout: 60_000 }, async () => {
  const system = "## How this step runs\n\nRead the project with read_file.\n\n## The helper's instructions\n\nWrite requirements.md.";
  const task = "## This invocation\n\nThe brief is in brief.md.";
  const d = await dispatch(FLASH, { system, task });
  assert.equal(d.result.success, true, d.result.error);
  assert.equal(d.system, system, "--system-file holds the system text");
  assert.equal(d.task, task, "the task file holds the task alone");
  assert.equal(basename(d.systemFile), `worker-system-${PACKET.id}.md`, "kept beside the task file, in the evidence folder");
  assert.deepEqual(d.record.artifacts, { brief: `worker-task-${PACKET.id}.md`, usage: `worker-usage-${PACKET.id}.json`, system: `worker-system-${PACKET.id}.md` });
  // An agent packet has neither: its brief is the packet's own markdown, as before.
  const typing = await dispatch(FLASH, undefined);
  assert.equal(flagValue(typing.args, "--system-file"), undefined);
  assert.deepEqual(typing.record.artifacts, { brief: `worker-task-${PACKET.id}.md`, usage: `worker-usage-${PACKET.id}.json` });
});
