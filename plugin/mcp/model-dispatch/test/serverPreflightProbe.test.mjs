/**
 * preflight_dispatch with probe_typists through the real server (dist/server.js over MCP stdio): the probe runs only
 * once the free checks pass, a typist that cannot answer stops the run with what to fix, a busy vendor passes with a
 * warning, every probe call is a telemetry event of the run with all its tokens, and a brownfield run's probe covers
 * the typists its own job routes to. A stand-in `claude` answers and records each call: no model, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { calledModels, cleanup, events, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";

const policy = (model = "claude-opus-5") => `version: 1
name: solo
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: ${model}
rules:
  - default: opus
`;
const PROBE_OK = receipt({ path: "probe.txt", content: "ok" }, { usage: { input_tokens: 3, cache_creation_input_tokens: 6000, output_tokens: 12 } });

async function probe(answer, policyYaml, args = {}) {
  const bin = standInClaude([answer]);
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), policyYaml);
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    const r = await withServer({ bin, home: root }, (call) => call("preflight_dispatch", { auth_mode: "estimated", policy_path: join(root, "policy.yaml"), project_root: root, probe_typists: true, telemetry_path, run_id: "r1", ...args }));
    return { r, events: events(telemetry_path), models: calledModels(bin) };
  } finally {
    cleanup(bin, root);
  }
}

test("a typist that answers: the run starts, and the probe call is a preflight event of the run with its cache writes", async () => {
  const { r, events: evs, models } = await probe(PROBE_OK, policy());
  assert.equal(r.json?.ok, true, r.text);
  assert.deepEqual(r.json.typist_probe.map((p) => [p.model_id, p.door, p.ok]), [["opus", "lean-opus", true]]);
  assert.deepEqual(models, ["claude-opus-5"]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].phase, "preflight");
  assert.equal(evs[0].pass, "r1");
  assert.equal(evs[0].door, "lean-opus");
  assert.equal(evs[0].input_tokens_cache_write, 6000, "the tokens explain the dollars, as every typist event's do");
  assert.ok(evs[0].cost_usd > 0);
});

test("a login the CLI cannot use stops the run with what to fix; the call's spend is still recorded", async () => {
  const refused = receipt(null, { error: { message: "Invalid API key · Please run /login" }, usage: { input_tokens: 0, output_tokens: 0 } });
  const { r, events: evs } = await probe(refused, policy());
  assert.equal(r.json?.ok, false, r.text);
  assert.match(r.json.halt_reason, /could not answer a one-line test call/);
  assert.match(r.json.halt_reason, /\/login/);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].success, false);
});

test("a busy vendor passes with a warning", async () => {
  const busy = receipt(null, { error: { status: 429, message: "rate limited" }, usage: { input_tokens: 0, output_tokens: 0 } });
  const { r } = await probe(busy, policy());
  assert.equal(r.json?.ok, true, r.text);
  assert.ok(r.json.warnings.some((w) => /busy/.test(w)), r.text);
});

test("a run the free checks already stop sends no probe call and writes no event", async () => {
  // Vendor auth with no ANTHROPIC_API_KEY in the server's environment: the free checks halt.
  const { r, events: evs, models } = await probe(PROBE_OK, policy(), { auth_mode: "vendor" });
  assert.equal(r.json?.ok, false, r.text);
  assert.equal(r.json.typist_probe, undefined);
  assert.deepEqual(models, []);
  assert.deepEqual(evs, []);
});

// A brownfield job routes its packets with the job's intent (change-spec.mjs derivePackets): a rule scoped to that
// intent types its files, so the run's probe tests that typist too, and only for the job the run does.
test("with the run's intent, the probe covers the typist an intent-scoped rule routes the job to", async () => {
  const scoped = `version: 1
name: docs-on-sonnet
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: son
    adapter: builtin-anthropic
    model_name: claude-sonnet-4-5
rules:
  - when: { phase: docs, intent: docs }
    use: son
  - default: opus
`;
  const docs = await probe(PROBE_OK, scoped, { executor: false, intent: "docs" });
  assert.equal(docs.r.json?.ok, true, docs.r.text);
  assert.deepEqual(docs.r.json.typist_probe.map((p) => p.model_id).sort(), ["opus", "son"]);
  const bugfix = await probe(PROBE_OK, scoped, { executor: false, intent: "bugfix" });
  assert.deepEqual(bugfix.r.json.typist_probe.map((p) => p.model_id), ["opus"], "a job the rule does not name never uses that typist");
});

// Brownfield packets are routed by greenfield's reading of the policy (executorView), so the notes on how that reading
// treats the policy are the brownfield run's too.
test("a brownfield run's pre-flight lists how its packets read the policy", async () => {
  const narrowed = `version: 1
name: narrowed
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: son
    adapter: builtin-anthropic
    model_name: claude-sonnet-4-5
rules:
  - when: { phase: codegen, task_type: [dto] }
    use: son
  - default: opus
`;
  const { r } = await probe(PROBE_OK, narrowed, { executor: false, probe_typists: false });
  assert.equal(r.json?.ok, true, r.text);
  assert.ok(r.json.policy_notes.some((n) => /task_type|by its stage/.test(n)), r.text);
});

// A typist that cannot be built on this machine is a machine problem, not a login problem: the lean Opus typist needs
// flags this claude CLI does not list, so the fix is the CLI's own remedy (update Claude Code), never the /login text a
// refused login gets.
test("a lean Opus typist this machine's claude CLI cannot run stops the run with the CLI's own remedy, not the login's", async () => {
  const bin = standInClaude([PROBE_OK]);
  writeFileSync(join(bin, "help.txt"), "--tools --append-system-prompt-file --strict-mcp-config\n");
  const root = project({ contract: false });
  writeFileSync(join(root, "policy.yaml"), policy());
  try {
    const r = await withServer({ bin, home: root }, (call) => call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, probe_typists: true, run_id: "r1" }));
    assert.equal(r.json?.ok, false, r.text);
    const [p] = r.json.typist_probe;
    assert.equal(p.ok, false);
    assert.match(p.fix, /claude update/, JSON.stringify(p));
    assert.doesNotMatch(p.fix, /\/login/);
    assert.match(r.json.halt_reason, /claude update/);
    assert.doesNotMatch(r.json.halt_reason, /\/login/);
    assert.deepEqual(calledModels(bin), [], "nothing was sent");
  } finally {
    cleanup(bin, root);
  }
});
