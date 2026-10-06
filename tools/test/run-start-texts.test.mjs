/**
 * What the run-start texts tell the model about pre-flight, checked on the shipped text. Offline, $0.
 *
 * Pre-flight has a free part (it builds every adapter and prices every model) and, with `probe_typists`, which every
 * run passes, a paid part: one minimal call through every typist the run types with, the agent door's included
 * (typistProbe.ts). The texts must say both, order the free checks first, and never offer a separate paid probe
 * of what the run's own start check already tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const GREENFIELD = read("plugin", "commands", "greenfield.md");
const ORCH = read("plugin", "agents", "orchestrator.md");
const SKILL = read("plugin", "skills", "pipeline", "SKILL.md");
/** Rule 0 of the orchestrator's operating rules: from its heading to rule 1. */
const RULE0 = ORCH.slice(ORCH.indexOf("0. **Pre-flight"), ORCH.indexOf("\n1. **"));
/** The pipeline skill's Phase -1 section. */
const PHASE_MINUS_1 = SKILL.slice(SKILL.indexOf("## Phase -1"), SKILL.indexOf("\n---", SKILL.indexOf("## Phase -1")));

// With the agent door selected, the run's start check calls the agent (probe_typists), so a missing entitlement,
// a region that does not serve the model and expired credentials stop the run before anything else is paid.
// Offering a separate two-cent probe on top asks the person an extra question and pays twice for one answer.
test("/mmo:greenfield offers no separate agent probe: the run's start check calls the agent itself", () => {
  assert.doesNotMatch(GREENFIELD, /probe-agent-worker\.mjs/, "no separate paid probe is offered");
  assert.doesNotMatch(GREENFIELD, /never calls it/, "pre-flight does call the agent door now");
  assert.doesNotMatch(GREENFIELD, /two-cent/i);
  const door = flat(GREENFIELD.slice(GREENFIELD.indexOf("**Say which door the typing goes through"), GREENFIELD.indexOf("This command runs whatever")));
  assert.match(door, /start check sends one test call through the agent/, "the door paragraph says what the start check covers");
});

// The driver-model check is free and stops a run whose subagent model is not the policy's; the typist probe costs
// cents. The server probes only once its own free checks pass (server.ts, preflight_dispatch), and the
// orchestrator's free check comes first for the same reason: a run a free check stops needs no paid call.
test("rule 0 runs the free driver-model check before the pre-flight call that probes the typists", () => {
  assert.ok(RULE0.startsWith("0. **Pre-flight"), "rule 0 was found");
  const check = RULE0.indexOf("driver-model-check.mjs");
  const probe = RULE0.indexOf("probe_typists: true");
  assert.ok(check > 0 && probe > 0, "rule 0 names both");
  assert.ok(check < probe, "the driver-model check is given before the call that probes the typists");
  assert.match(flat(RULE0), /Under `estimated`, run the driver-model check first, before you call `preflight_dispatch`/);
  assert.match(flat(RULE0), /print the script's output verbatim and STOP/i, "the check still stops the run");
});

test("the pipeline skill orders pre-flight the same way and never calls it free", () => {
  const machine = SKILL.split("\n").find((l) => /^-1\. preflight_dispatch/.test(l));
  assert.ok(machine, "the state machine's pre-flight line");
  assert.doesNotMatch(machine, /free, no API call/, "pre-flight is not free: it probes every typist");
  assert.match(machine, /one test call through each typist/);
  assert.match(flat(PHASE_MINUS_1), /Under `estimated`, the orchestrator's driver-model check \(rule 0\) runs first/);
  assert.doesNotMatch(flat(PHASE_MINUS_1), /still free to stop/, "the probe calls are paid by then");
});

// A refusal says what was refused and why; a scope change is the person's decision. A text that names a way past
// the refusal (strict = false, --strict-write=off, re-opening Gate 0) teaches the run to get around it, and under a
// frozen contract either one locks every later write.
test("no instruction text names a way past a write-contract refusal", () => {
  const texts = {
    "agents/orchestrator.md": ORCH,
    "skills/pipeline/SKILL.md": SKILL,
    "skills/brownfield-guide/SKILL.md": read("plugin", "skills", "brownfield-guide", "SKILL.md"),
    "commands/pass.md": read("plugin", "commands", "pass.md"),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /escape hatch is `contract\.strict = false`/, name);
    assert.doesNotMatch(text, /strict = false/, name);
    assert.doesNotMatch(text, /re-?open Gate 0/i, name);
  }
  const gate = flat(ORCH.slice(ORCH.indexOf("# Write gate"), ORCH.indexOf("**Merge semantics")));
  // A wider scope is a new run's (one freeze per run id), and the run never edits its contract: a frozen contract
  // changed mid-run refuses every write after it. The person's start flag is described in person-facing docs only.
  assert.match(gate, /When a write is refused, stop and tell the person which path the run needs and why: a wider scope is the person's decision, for a new run with its own Gate 0/);
  assert.match(gate, /Never edit the contract yourself: a contract changed after Gate 0 froze it refuses every write after that/);
  assert.doesNotMatch(gate, /--strict-write/, "the orchestrator is not told about the person's start flag");
});

// A policy rule may route a job's files to another typist (a rule matching on `intent`). The start check probes the
// typists the run will type with only when it knows the job: preflight_dispatch takes the run's `intent`
// (server.ts, runTypingLeaves(policy, overrides, intent)). Rule 0 and the skill's Phase -1 are what a brownfield
// run reads for its pre-flight call (its copy of rule 0, and brownfield-runs.md's list of skill sections).
test("a brownfield run's pre-flight call carries the run's intent, so the probe covers a job-scoped typist", () => {
  assert.match(flat(RULE0), /On a brownfield run, also pass the run's `intent` \(its job\)/);
  assert.match(flat(PHASE_MINUS_1), /On a brownfield run, also pass the run's `intent` \(its job\)/);
  const server = read("plugin", "mcp", "model-dispatch", "src", "server.ts");
  assert.match(server, /probeTypists\(runTypingLeaves\(policy, selectOverrides\(\), intent\)/, "the server probes the job's typists");
});

// What /mmo:greenfield's step 1 shows the model is verify-setup.mjs's output. On the agent path it must not offer a
// separate paid probe either: the run's start check (preflight_dispatch with probe_typists) calls the agent before
// any paid phase, so the offer is one more question and a second payment for one answer, and it contradicts the
// door paragraph above. Covers the hint printed after every passing check and the fix lines of the two
// credential-unproven problems.
test("the setup check /mmo:greenfield runs offers no separate paid probe of what the start check tests", async () => {
  const vs = await import("../../plugin/scripts/verify-setup.mjs");
  const PAID_PROBE = /probe-agent-worker\.mjs|two cents/i;
  const hint = vs.agentProbeHint("/plug", { MMO_SELECT: vs.AGENT_WORKER_SELECT }, true);
  assert.ok(hint === null || !PAID_PROBE.test(hint), `the passing check's hint offers a paid probe: ${hint}`);
  const absent = { present: false, usable: false, type: null, detail: null };
  const machine = { nodeMajor: 20, hasClaudeCli: true, hasNodeModules: true, hasDist: true, hasBundle: true, agentWorker: { hasVenv: true, sdkImportable: true, detail: null } };
  for (const env of [{ GOOGLE_CLOUD_PROJECT: "p" }, { GOOGLE_CLOUD_PROJECT: "p", MMO_SELECT: vs.AGENT_WORKER_SELECT }]) {
    const { problems } = vs.evaluate({ ...machine, env, vertex: vs.vertexCredentialState({ env, adcFile: absent }) });
    assert.ok(problems.length > 0, "the project-only state is reported");
    for (const p of problems) assert.doesNotMatch(`${p.message} ${p.fix}`, PAID_PROBE, p.id);
  }
});
