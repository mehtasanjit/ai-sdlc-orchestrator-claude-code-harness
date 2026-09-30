/**
 * A policy written before the executor existed still runs a new-app build. Every setting the executor reads has
 * a default, so a policy that leaves one out, or states one the executor cannot use, runs with the default instead
 * of stopping. The fixtures in test/fixtures/earlier-policies are the shipped policies of the release before the
 * executor, data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFromPath, getModel } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";
import { executorView, executeStage } from "../dist/executor/run.js";
import { fallbackLeaf, handleExecutorTool, typistDoorFor, typistForLeaf } from "../dist/executor/tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EARLIER = join(HERE, "fixtures", "earlier-policies");
const STAGES = ["codegen", "tests", "docs", "debug"];
/** How the notes name a rule: by its place in the file, counted from 1 (1st, 2nd, 3rd, 4th, ...). */
const nth = (n) => `${n}${[11, 12, 13].includes(n % 100) ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const route = (view, phase, retry = 0, overrides = {}) => pickModel({ phase, task_type: "", module: "spec", retry_count: retry }, view, overrides);

function policyFile(text) {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  const path = join(dir, "p.yaml");
  writeFileSync(path, text);
  return path;
}

const TWO_MODELS = (extraModel = "", extraTop = "") => `version: 1
name: custom
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
${extraModel}  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.8-flash
rules:
  - when: { phase: codegen }
    use: flash
  - default: opus
${extraTop}`;

test("every earlier shipped policy passes each check the executor makes before it types", () => {
  const names = readdirSync(EARLIER).filter((f) => f.endsWith(".yaml"));
  assert.equal(names.length, 8);
  for (const name of names) {
    const policy = loadPolicyFromPath(join(EARLIER, name));
    const { policy: view } = executorView(policy);
    const fb = fallbackLeaf(view);
    for (const stage of STAGES) {
      for (const retry of [0, 1, 2]) {
        const d = pickModel({ phase: stage, task_type: "", module: "spec", retry_count: retry }, view, {});
        // Only the adapter rule is the policy's: a model the executor has no typist for. Whether this machine
        // can run the typist (the claude CLI's flags, the agent door's Python) is pre-flight's check, so no
        // typist is built here and no machine's error can pass for a policy's.
        assert.ok(typistDoorFor(getModel(view, d.modelId)), `${name}: ${stage} attempt ${retry + 1}: ${d.modelId} has a typist`);
      }
    }
    if (fb) assert.equal(typistDoorFor(fb), "lean-opus", `${name}: the last attempt is a lean Opus typist`);
  }
});

test("a model whose adapter has no typist is refused by that rule alone, whatever this machine has installed", () => {
  const leaf = { id: "x", adapter: "some-other-adapter", model_name: "m" };
  assert.equal(typistDoorFor(leaf), null);
  assert.throws(() => typistForLeaf(leaf, "estimated"), /has no typist for adapter 'some-other-adapter'/);
  for (const [adapter, door] of [["builtin-anthropic", "lean-opus"], ["claude-cli", "lean-opus"], ["mcp:model-dispatch", "flash-completion"], ["antigravity-worker", "agy"]]) {
    assert.equal(typistDoorFor({ id: "y", adapter, model_name: "m" }), door, adapter);
  }
});

test("an earlier policy's file-type rule applies by its stage: code files go where the policy sent code, not to its default", () => {
  const policy = loadPolicyFromPath(join(EARLIER, "opus-plus-flash-v38.yaml"));
  const codegen = policy.rules.findIndex((r) => r.when?.phase === "codegen");
  assert.ok(codegen >= 0 && policy.rules[codegen].when.task_type, "the fixture routes codegen by file type");
  const { policy: view, notes } = executorView(policy);
  const d = pickModel({ phase: "codegen", task_type: "", module: "spec", retry_count: 0 }, view, {});
  assert.equal(d.ruleIndex, codegen, "code is routed by the policy's own code rule");
  assert.notEqual(d.modelId, "opus", "not by its default");
  assert.ok(notes.some((n) => n.includes(`${nth(codegen + 1)} rule`)), "the run record says which rules were read by stage alone, counted from 1");
  assert.equal(pickModel({ phase: "codegen", task_type: "", module: "spec", retry_count: 0 }, policy, {}).modelId, "opus", "read as written, the rule would never match and code would go to the default");
});

test("a rule that names only a file type or a module, no stage, is set aside for a new-app build instead of matching everything", () => {
  const policy = loadPolicyFromPath(policyFile(TWO_MODELS().replace("rules:\n", "rules:\n  - when: { task_type: [dto] }\n    use: opus\n")));
  const { policy: view, notes } = executorView(policy);
  assert.equal(pickModel({ phase: "codegen", task_type: "", module: "spec", retry_count: 0 }, view, {}).modelId, "flash");
  assert.equal(pickModel({ phase: "tests", task_type: "", module: "spec", retry_count: 0 }, view, {}).modelId, "opus", "the default still applies");
  assert.ok(notes.some((n) => n.includes("1st rule") && /set aside/.test(n)));
  assert.deepEqual(executorView(loadPolicyFromPath(policyFile(TWO_MODELS()))).notes, [], "a policy written for the executor gets no notes");
});

const CUSTOM = (rules, models = "  - id: opus\n    adapter: builtin-anthropic\n    model_name: claude-opus-5\n  - id: flash\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.8-flash\n", top = "") =>
  loadPolicyFromPath(policyFile(`version: 1\nname: custom\nmodels:\n${models}${top}rules:\n${rules}`));

test("a stage with a rule of its own is routed by it: the exceptions listed before it for a module or file type are set aside, and the notes say which rule routes the stage", () => {
  const policy = CUSTOM(`  - when: { phase: [codegen, tests], module: [auth, payments] }
    use: opus
  - when: { phase: [codegen, tests, docs] }
    use: flash
  - when: { phase: debug, task_type: [type_error, lint] }
    use: flash
  - when: { phase: debug }
    use: opus
  - default: opus
`);
  const { policy: view, notes } = executorView(policy);
  for (const stage of ["codegen", "tests", "docs"]) assert.equal(route(view, stage).modelId, "flash", `${stage}: the stage's own rule, not the auth exception`);
  assert.equal(route(view, "debug").modelId, "opus", "debug: the stage's own rule, not the type_error exception");
  const first = notes.find((n) => n.includes("1st rule"));
  assert.ok(first, JSON.stringify(notes));
  assert.match(first, /set aside/);
  assert.match(first, /2nd rule/, "names the rule that routes those stages");
  const third = notes.find((n) => n.includes("3rd rule"));
  assert.match(third, /set aside/);
  assert.match(third, /4th rule/);
  assert.ok(!notes.some((n) => /every (file|job)/.test(n) && /1st rule|3rd rule/.test(n) && !/set aside/.test(n)), "no note says a set-aside rule types every file");
  assert.deepEqual(executorView(view).notes, [], "reading the view again changes nothing");
});

test("a stage routed only by exception rules: the first one listed types every job of that stage, and the notes name it and each rule it shadows", () => {
  const policy = CUSTOM(`  - when: { phase: [requirements_analysis, architecture_design] }
    use: opus
  - when: { phase: codegen, task_type: [guard, migration] }
    use: opus
    reason: security-sensitive kinds stay premium
  - when: { phase: codegen, task_type: [controller_handler, dto] }
    use: flash
  - when: { phase: [tests, docs, debug] }
    use: flash
  - default: flash
`);
  const { policy: view, notes } = executorView(policy);
  assert.equal(route(view, "codegen").modelId, "opus", "first match, read by stage alone");
  const winner = notes.find((n) => n.includes("2nd rule") && !n.includes("3rd rule"));
  assert.ok(winner, JSON.stringify(notes));
  assert.match(winner, /every codegen job/);
  const shadowed = notes.find((n) => n.includes("3rd rule"));
  assert.match(shadowed, /shadowed by the 2nd rule/);
  assert.match(shadowed, /never applies/);
  assert.ok(!/every codegen job/.test(shadowed), "the shadowed rule is not said to type every file");
});

test("an exception with a retry condition names the retries it wins at", () => {
  const policy = CUSTOM(`  - when: { phase: debug, task_type: [runtime_error], retry_count: { gte: 2 } }
    use: opus
  - when: { phase: debug, task_type: [runtime_error, test_failure] }
    use: flash
  - when: { phase: [codegen, tests, docs] }
    use: flash
  - default: opus
`);
  const { policy: view, notes } = executorView(policy);
  assert.deepEqual([0, 1, 2, 5].map((k) => route(view, "debug", k).modelId), ["flash", "flash", "opus", "opus"]);
  assert.match(notes.find((n) => n.includes("1st rule")), /retry_count 2 and above/);
  assert.match(notes.find((n) => n.includes("2nd rule")), /retry_count 0.1/);
});

test("a policy with no default rule and no rule for a stage the executor runs still runs: those jobs go to its first Claude model, and the notes say so", () => {
  const policy = CUSTOM(`  - when: { phase: [requirements_analysis, architecture_design] }
    use: opus
  - when: { phase: [codegen, tests, docs] }
    use: flash
`, "  - id: flash\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.8-flash\n  - id: opus\n    adapter: builtin-anthropic\n    model_name: claude-opus-5\n");
  assert.throws(() => route(policy, "debug"), /no default rule/, "read as written, debug has no route");
  const { policy: view, notes } = executorView(policy);
  for (const k of [0, 1, 2]) assert.equal(route(view, "debug", k).modelId, "opus", "the first Claude model, not the first model");
  assert.equal(route(view, "codegen").modelId, "flash", "a routed stage keeps its rule");
  assert.ok(notes.some((n) => /debug/.test(n) && /no default rule/.test(n) && /opus/.test(n)), JSON.stringify(notes));
  assert.deepEqual(executorView(view).notes, [], "reading the view again changes nothing");
});

test("with no Claude model and no default rule, those jobs go to the policy's first model, through the run's choice when a slot offers it", () => {
  const models = "  - id: flash-a\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.8-flash\n  - id: flash-b\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.5-flash\n";
  const plain = CUSTOM("  - when: { phase: [codegen, tests, docs] }\n    use: flash-b\n", models);
  assert.equal(route(executorView(plain).policy, "debug").modelId, "flash-a");
  const slotted = CUSTOM("  - when: { phase: [codegen, tests, docs] }\n    use: gemini-flash\n", models,
    "select:\n  gemini-flash: { default: flash-b, options: [flash-a, flash-b] }\n");
  const view = executorView(slotted).policy;
  assert.equal(route(view, "debug").modelId, "flash-b", "the slot's own choice, so a model the run did not select is never used");
  assert.equal(route(view, "debug", 0, { "gemini-flash": "flash-a" }).modelId, "flash-a");
});

test("execute_stage's first call under a policy with no default rule and no debug rule runs, and its notes say where debugging goes", async () => {
  const policy = CUSTOM("  - when: { phase: [codegen, tests, docs] }\n    use: flash\n", "  - id: flash\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.8-flash\n");
  const dir = mkdtempSync(join(tmpdir(), "no-default-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] },
    units: [{ id: "U01", path: "app/a.py", phase: "codegen", import_line: "", exports: [], behaviour: "b", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 1 }],
  }));
  const r = await handleExecutorTool("execute_stage", { spec_path: specPath, stage: "docs", code_dir: dir, telemetry_path: join(dir, "t.jsonl") },
    { run: () => ({ authMode: "estimated", policyName: "custom" }), policy: () => policy, overrides: {} });
  assert.notEqual(r.isError, true, r.content[0].text);
  const receipt = JSON.parse(r.content[0].text);
  assert.ok(receipt.policy_notes.some((n) => /debug/.test(n) && /flash/.test(n)), JSON.stringify(receipt.policy_notes));
});

test("a policy with no Claude model types with its own models only: no Claude last attempt, and the stage runs", async () => {
  const policy = loadPolicyFromPath(join(EARLIER, "flash-agsdk-only.yaml"));
  assert.equal(fallbackLeaf(policy), null);
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const calls = [];
  const flash = {
    door: "agy", modelId: "flash",
    async type(req) { calls.push(req.unit.path); return { answer: { path: req.unit.path, content: "x = 1\n" }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0, latency_ms: 1 }; },
  };
  const spec = {
    spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] },
    units: [{ id: "U01", path: "app/a.py", phase: "codegen", import_line: "", exports: [{ name: "a", params: [], returns: "int" }], behaviour: "returns one", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 2 }],
  };
  const r = await executeStage(spec, { stage: "codegen", codeDir: dir, passId: "p", policy, concurrency: 1, routedAttempts: 2, transport: { maxWaits: 0, baseMs: 1, capMs: 1 } },
    { typistFor: () => flash, fallback: null, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: () => ({ ok: true }) });
  assert.equal(r.written, 1);
  assert.deepEqual(calls, ["app/a.py"]);
});

// A policy written before the figure was dropped still loads. The loader sets its hard_cost_cap_usd aside with a
// warning, so no tool reply (load_policy returns the loaded policy) shows a chat a figure it would read as a limit.
test("a policy that declares hard_cost_cap_usd loads, with the figure set aside and a warning naming it", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const file = join(EARLIER, "opus-only-v5.yaml");
  const dist = pathToFileURL(join(HERE, "..", "dist", "policy.js")).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadPolicyFromPath } from ${JSON.stringify(dist)}; const p = loadPolicyFromPath(${JSON.stringify(file)}); console.log(JSON.stringify({ has: "hard_cost_cap_usd" in p, models: p.models.length }));`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { has: false, models: 1 });
  assert.match(r.stderr, /policy\.setting_ignored[^\n]*key=hard_cost_cap_usd/);
});
