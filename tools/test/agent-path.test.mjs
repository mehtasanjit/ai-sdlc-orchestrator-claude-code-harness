/**
 * Invariant: agent-path checks stay silent unless the install opted in
 * (no false alarms for model-path users). Also pins agreement between the
 * three copies of the interpreter path + agent-leaf spec (verify-setup,
 * policy YAML, wizard — none can import the others).
 *
 * Offline; injected `spawn` fakes the Python probe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  selectsAgentWorker,
  workerPaths,
  findWorkerPython,
  AGENT_WORKER_MODEL_ID,
  MIN_PYTHON,
  DECLARED_ENV,
} from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A machine on which everything unrelated to the agent path is in place. */
const healthy = {
  nodeMajor: 20,
  hasClaudeCli: true,
  hasNodeModules: true,
  hasDist: true,
  hasBundle: true,
  env: { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" },
};

const idsOf = (state) => state.problems.map((p) => p.id);

// ─── who gets asked about Python ──────────────────────────────────────

test("the agent path is off unless something says otherwise", () => {
  assert.equal(selectsAgentWorker({}), false);
  assert.equal(selectsAgentWorker({ MMO_SELECT: "" }), false);
  assert.equal(selectsAgentWorker({ MMO_SELECT: "   " }), false);
  // The unexpanded-placeholder case is the realistic one: plugin.json declares
  // MMO_SELECT as a pass-through, and a host that never set it hands the
  // literal through. Reading that as a selection would demand a virtualenv of
  // every single plugin user.
  assert.equal(selectsAgentWorker({ MMO_SELECT: "${MMO_SELECT}" }), false);
});

test("the agent path is on only when a slot actually resolves to the worker", () => {
  assert.equal(selectsAgentWorker({ MMO_SELECT: `gemini-flash=${AGENT_WORKER_MODEL_ID}` }), true);
  // One pair among several, in either position.
  assert.equal(
    selectsAgentWorker({ MMO_SELECT: `other=x, gemini-flash=${AGENT_WORKER_MODEL_ID}` }),
    true,
  );

  // Selecting the completion leaf is not selecting the agent.
  assert.equal(selectsAgentWorker({ MMO_SELECT: "gemini-flash=flash-completion" }), false);
  // A slot NAMED after the worker is not a selection OF it. A substring test
  // would get this backwards and demand Python from someone who explicitly
  // chose the other leaf.
  assert.equal(
    selectsAgentWorker({ MMO_SELECT: `${AGENT_WORKER_MODEL_ID}=flash-completion` }),
    false,
  );
  // Near-misses are near-misses, not matches.
  assert.equal(selectsAgentWorker({ MMO_SELECT: `gemini-flash=${AGENT_WORKER_MODEL_ID}-v2` }), false);
});

// ─── the decision table, agent half ───────────────────────────────────

test("someone on the model path is never told about Python", () => {
  // `agentWorker: null` is what observe() produces when selectsAgentWorker()
  // said no — nothing was probed, so nothing can be reported.
  const state = evaluate({ ...healthy, agentWorker: null });
  assert.deepEqual(idsOf(state), []);
  assert.equal(state.ok, true);
});

test("a missing worker environment blocks, and says how to leave the agent path", () => {
  const state = evaluate({
    ...healthy,
    agentWorker: { hasVenv: false, sdkImportable: false, detail: null },
  });
  assert.deepEqual(idsOf(state), ["agent-worker-python"]);
  const problem = state.problems[0];
  assert.equal(problem.severity, "blocking");
  assert.equal(state.ok, false);
  // Both exits have to be on the page: build the environment, or stop asking
  // for the tier that needs it. Someone who turned this on to try it must not
  // have to guess how to turn it off.
  //
  // --fix specifically, not `node tools/setup.mjs`: an installed plugin has no
  // tools/ directory, so a repair named only in clone terms is a dead end for
  // half the audience. This assertion is what keeps that from regressing.
  assert.match(problem.fix, /--fix/);
  assert.match(problem.fix, /MMO_SELECT/);
});

test("an environment that exists but cannot import the SDK blocks, quoting the error", () => {
  const state = evaluate({
    ...healthy,
    agentWorker: {
      hasVenv: true,
      sdkImportable: false,
      detail: "ModuleNotFoundError: No module named 'google.antigravity'",
    },
  });
  assert.deepEqual(idsOf(state), ["agent-worker-sdk"]);
  assert.equal(state.problems[0].severity, "blocking");
  // The interpreter's own words. Without them this is indistinguishable from
  // the previous case, and the two have different repairs.
  assert.match(state.problems[0].message, /ModuleNotFoundError/);
  // And the repair is the same one command, on both install routes.
  assert.match(state.problems[0].fix, /--fix/);
});

test("the repair replaces a broken environment rather than adding to it", () => {
  // The reason both agent-worker problems can name the same one-line repair:
  // buildWorkerEnvironment builds with `venv --clear`, which empties an
  // existing .venv before rebuilding. Drop the flag and the commonest breakage
  // — a virtualenv whose interpreter was upgraded or removed underneath it —
  // survives its own repair, because `venv` over an existing directory leaves
  // site-packages in place. The check would then report the identical problem
  // immediately after "repairing" it. Pinned as source text because the
  // function shells out to a real interpreter, and this suite is offline.
  const source = readFileSync(join(ROOT, "plugin", "scripts", "verify-setup.mjs"), "utf8");
  const match = source.match(/\["-m", "venv"[^\]]*\]/);
  assert.ok(match, "the venv invocation in buildWorkerEnvironment no longer looks like a literal array");
  assert.match(match[0], /"--clear"/);
});

test("a working agent environment adds nothing to the report", () => {
  const state = evaluate({
    ...healthy,
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  });
  assert.deepEqual(idsOf(state), []);
  assert.equal(state.ok, true);
});

// ─── choosing an interpreter ──────────────────────────────────────────

/** A fake `which` + `spawnSync` pair over a machine's declared interpreters. */
const fakePython = (versions) => ({
  resolve: (name) => name in versions,
  run: (name) => ({ status: 0, stdout: `${versions[name]}\n` }),
});

test("the newest usable interpreter wins, and the system 3.9 never does", () => {
  // The exact shape of a stock macOS with one Homebrew Python: `python3`
  // resolves to 3.9, which installs google-antigravity cleanly and then dies
  // at import time inside a subprocess. Picking it would move a setup failure
  // into the middle of a paid run.
  const { resolve, run } = fakePython({ python3: "3.9", "python3.12": "3.12" });
  assert.deepEqual(findWorkerPython(run, resolve), { command: "python3.12", version: "3.12" });
});

test("no usable interpreter is reported as none, not as the closest thing", () => {
  const { resolve, run } = fakePython({ python3: "3.9" });
  assert.equal(findWorkerPython(run, resolve), null);
});

test("an interpreter that will not answer is skipped rather than trusted by name", () => {
  // `python3.12` on PATH can be a broken symlink or a shim that exits non-zero.
  // The name is a claim; the version it prints is the evidence.
  const resolve = (name) => ["python3.12", "python3.11"].includes(name);
  const run = (name) =>
    name === "python3.12" ? { status: 1, stdout: "" } : { status: 0, stdout: "3.11\n" };
  assert.deepEqual(findWorkerPython(run, resolve), { command: "python3.11", version: "3.11" });
});

test("the declared minimum is the SDK's own, not a preference", () => {
  // google-antigravity declares requires-python >= 3.10. Written down as a
  // constant so a future bump is one edit rather than a hunt through branches.
  assert.deepEqual(MIN_PYTHON, [3, 10]);
});

// ─── the copies that cannot import each other ─────────────────────────

test("the venv this script builds is the one the adapter looks for", () => {
  // workerProcess.ts is the authority — it is what actually launches the
  // interpreter. verify-setup.mjs cannot import it (this script runs before
  // the server is built), so the two agree only by hand, and only this
  // assertion notices when they stop.
  const pluginRoot = join(ROOT, "plugin");
  const { venvPython } = workerPaths(pluginRoot);
  const source = readFileSync(
    join(pluginRoot, "mcp", "model-dispatch", "src", "delegation", "workerProcess.ts"),
    "utf8",
  );
  const match = source.match(/return join\(workerDir, ([^)]*)\);/);
  assert.ok(match, "workerVenvPython() no longer looks like a join() of literals");
  const segments = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.equal(
    venvPython,
    join(pluginRoot, "mcp", "model-dispatch", "worker", ...segments),
    "verify-setup.mjs and workerProcess.ts disagree about where the worker's Python lives",
  );
});

test("the interpreter override the worker honours is a declared pass-through", () => {
  // GEMINI_WORKER_PYTHON reaches the server the same way every other setting
  // does — through plugin.json's env block. Left off that list it is invisible
  // to a plugin-route install, and the override silently does nothing.
  const source = readFileSync(
    join(ROOT, "plugin", "mcp", "model-dispatch", "src", "delegation", "workerProcess.ts"),
    "utf8",
  );
  const declared = source.match(/WORKER_PYTHON_ENV\s*=\s*"([^"]+)"/);
  assert.ok(declared, "workerProcess.ts no longer names its override variable as a literal");
  assert.ok(
    DECLARED_ENV.includes(declared[1]),
    `${declared[1]} is read by the worker but not declared as a plugin pass-through`,
  );
});

test("the selection string the wizard writes is the one the policy declares", () => {
  // The wizard writes a literal into .mcp.json; the policy declares the slot
  // and its options. If either is renamed, the file the wizard produces routes
  // to nothing and the failure surfaces at the first dispatch.
  const wizard = readFileSync(join(ROOT, "tools", "setup.mjs"), "utf8");
  const written = wizard.match(/MMO_SELECT:\s*"([^"]+)"/);
  assert.ok(written, "setup.mjs no longer writes MMO_SELECT as a literal");

  const [slot, option] = written[1].split("=");
  const policy = readFileSync(
    join(ROOT, "plugin", "config", "policies", "opus-plus-flash.yaml"),
    "utf8",
  );
  assert.match(policy, new RegExp(`^select:\\s*\\n\\s+${slot}:`, "m"), `policy declares slot '${slot}'`);
  assert.match(policy, new RegExp(`^\\s+- id: ${option}$`, "m"), `policy declares leaf '${option}'`);
  assert.equal(option, AGENT_WORKER_MODEL_ID, "the wizard selects the leaf this script checks for");
});
