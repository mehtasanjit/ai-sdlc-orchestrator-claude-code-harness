/**
 * Runs against dist/preflight.js — server.ts opens a stdio transport at
 * import and would hang the test runner. Adapter factory is injected so
 * "this model cannot be constructed" is expressed by a throwing stub, not
 * by an unset env var.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as preflightModule from "../dist/preflight.js";
import {
  IN_SESSION_ADAPTER,
  assessModels,
  parseAuthMode,
  requiresServerDispatch,
} from "../dist/preflight.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The two models of the shipped opus-plus-flash policy, in policy-file order. */
const MODELS = [
  { id: "opus", model_name: "claude-opus-4-7", adapter: "builtin-anthropic" },
  { id: "gemini-flash", model_name: "gemini-3.5-flash", adapter: "mcp:model-dispatch" },
];

/** An adapter factory where the named model ids throw and every other id succeeds. */
function factoryFailing(...failingIds) {
  return (modelId) => {
    if (failingIds.includes(modelId)) {
      throw new Error(`ANTHROPIC_API_KEY not set for BuiltinAnthropicAdapter (model ${modelId})`);
    }
    return { id: modelId };
  };
}

test("parseAuthMode accepts exactly the two documented modes", () => {
  assert.equal(parseAuthMode("vendor"), "vendor");
  assert.equal(parseAuthMode("estimated"), "estimated");
});

test("parseAuthMode throws on anything else, using the message operating rule 6 specifies", () => {
  for (const bad of [undefined, null, "", "VENDOR", "estimate", "subscription", 1, {}]) {
    assert.throws(
      () => parseAuthMode(bad),
      /this run requires auth_mode=vendor\|estimated/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("vendor mode dispatches every model through this server", () => {
  assert.equal(requiresServerDispatch(IN_SESSION_ADAPTER, "vendor"), true);
  assert.equal(requiresServerDispatch("mcp:model-dispatch", "vendor"), true);
});

test("estimated mode dispatches everything except the in-session adapter", () => {
  assert.equal(requiresServerDispatch(IN_SESSION_ADAPTER, "estimated"), false);
  assert.equal(requiresServerDispatch("mcp:model-dispatch", "estimated"), true);
  // An unknown adapter is dispatched, and so must work. Defaulting the other way
  // would let a typo'd adapter name skip the check entirely.
  assert.equal(requiresServerDispatch("mcp:some-future-server", "estimated"), true);
});

test("a healthy setup passes in both modes with no warnings", () => {
  for (const mode of ["vendor", "estimated"]) {
    const out = assessModels(MODELS, mode, factoryFailing());
    assert.equal(out.ok, true, mode);
    assert.equal(out.halt_reason, null, mode);
    assert.deepEqual(out.warnings, [], mode);
    assert.ok(out.models.every((m) => m.ok), mode);
  }
});

/**
 * The regression. This is the exact shape of the 2026-08-04 false positive: an
 * estimated-mode run with no ANTHROPIC_API_KEY, halted on an adapter it was never
 * going to construct.
 */
test("a missing Anthropic key does not halt an estimated run", () => {
  const out = assessModels(MODELS, "estimated", factoryFailing("opus"));

  assert.equal(out.ok, true, "the run must be allowed to start");
  assert.equal(out.halt_reason, null);

  const opus = out.models.find((m) => m.id === "opus");
  assert.equal(opus.ok, false, "the failure is still recorded truthfully");
  assert.equal(opus.required, false);
  assert.equal(opus.severity, "warning");

  assert.equal(out.warnings.length, 1, "and it is still surfaced to the operator");
  assert.match(out.warnings[0], /does not dispatch to it/);
  assert.match(out.warnings[0], /would block a vendor-mode run/);
});

test("the same missing key does halt a vendor run", () => {
  const out = assessModels(MODELS, "vendor", factoryFailing("opus"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /Cannot dispatch to 1 of 2 models/);
  assert.match(out.halt_reason, /opus \(ANTHROPIC_API_KEY not set/);
  assert.deepEqual(out.warnings, [], "a blocking failure is not also a warning");

  const opus = out.models.find((m) => m.id === "opus");
  assert.equal(opus.required, true);
  assert.equal(opus.severity, "blocking");
});

test("an unreachable mechanical tier halts an estimated run", () => {
  // The failure this gate was built for: without Gemini every mechanical packet
  // falls back to the premium tier and the run costs more than the baseline.
  const out = assessModels(MODELS, "estimated", factoryFailing("gemini-flash"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /gemini-flash/);
  assert.match(out.halt_reason, /costs more than a single-model baseline/);
  assert.deepEqual(out.warnings, []);
});

test("an all-in-session policy needs nothing from this server under estimated", () => {
  // opus-only in estimated mode: every phase runs in the Claude Code session, so
  // there is nothing for pre-flight to block on even with every adapter broken.
  const opusOnly = [MODELS[0]];
  const out = assessModels(opusOnly, "estimated", factoryFailing("opus"));

  assert.equal(out.ok, true);
  assert.equal(out.halt_reason, null);
  assert.equal(out.warnings.length, 1);
});

test("both models failing in vendor mode are named in one halt_reason", () => {
  const out = assessModels(MODELS, "vendor", factoryFailing("opus", "gemini-flash"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /Cannot dispatch to 2 of 2 models/);
  assert.match(out.halt_reason, /opus \(/);
  assert.match(out.halt_reason, /gemini-flash \(/);
});

test("results preserve policy order and carry the fields the orchestrator prints", () => {
  const out = assessModels(MODELS, "estimated", factoryFailing());
  assert.deepEqual(
    out.models.map((m) => m.id),
    ["opus", "gemini-flash"],
  );
  for (const m of out.models) {
    assert.equal(typeof m.model_name, "string");
    assert.equal(typeof m.adapter, "string");
    assert.equal(typeof m.required, "boolean");
    assert.equal(m.error, undefined, "a passing model carries no error");
    assert.equal(m.severity, undefined, "and no severity");
  }
});

test("every model is constructed, so the cache is warm and non-required failures are seen", () => {
  const built = [];
  assessModels(MODELS, "estimated", (id) => {
    built.push(id);
    return {};
  });
  assert.deepEqual(built, ["opus", "gemini-flash"]);
});

test("the claude-cli adapter dispatches through the server in both auth modes", () => {
  // It IS Anthropic, but it goes through a subprocess — the in-session
  // shortcut does not apply. Both modes must construct and probe it.
  assert.equal(requiresServerDispatch("claude-cli", "vendor"), true);
  assert.equal(requiresServerDispatch("claude-cli", "estimated"), true);
});

test("a missing claude binary halts an estimated run that names the claude-cli adapter", () => {
  const MIXED = [
    { id: "opus", model_name: "claude-opus-5", adapter: "builtin-anthropic" },
    { id: "sonnet-cli", model_name: "claude-sonnet-5", adapter: "claude-cli" },
  ];
  const factory = (modelId) => {
    if (modelId === "sonnet-cli") {
      throw new Error("ClaudeCliAdapter needs the `claude` binary on PATH");
    }
    return { id: modelId };
  };
  const out = assessModels(MIXED, "estimated", factory);
  assert.equal(out.ok, false, "an unreachable claude-cli leaf must halt even under estimated");
  assert.match(out.halt_reason, /sonnet-cli/);
  const sonnet = out.models.find((m) => m.id === "sonnet-cli");
  assert.equal(sonnet.required, true);
  assert.equal(sonnet.severity, "blocking");
});

// ─── The executor's checks: the claude CLI its Claude typists need, the key a vendor run bills ───

// Every run whose files the typists type (a new-app build's units, a brownfield run's packets) types its Claude
// attempts with the lean Opus typist through this machine's claude CLI, so executor: true halts on a CLI that cannot
// run it. Not told, pre-flight warns, and the warning never claims a brownfield run does without the CLI.
test("the claude CLI check halts a run the typists type, only warns when pre-flight is not told, and is skipped for a run that types nothing", () => {
  const { executorCliCheck } = preflightModule;
  const problem = "this machine's claude CLI lists no --tools, --effort flags: update Claude Code";
  let asked = 0;
  const cliProblem = () => { asked++; return problem; };
  const halt = executorCliCheck({ executor: true, claudeTypists: ["opus"], cliProblem });
  assert.match(halt.halt, /opus/);
  assert.ok(halt.halt.includes(problem));
  assert.equal(halt.warning, null);
  const unknown = executorCliCheck({ executor: undefined, claudeTypists: ["opus"], cliProblem });
  assert.equal(unknown.halt, null, "pre-flight was not told whether the typists type this run, so it is not stopped");
  assert.ok(unknown.warning.includes(problem));
  assert.match(unknown.warning, /pass executor: true/);
  assert.doesNotMatch(unknown.warning, /brownfield run does not use/i, "a brownfield run's packets are typed through the same CLI");
  assert.doesNotMatch(halt.halt + unknown.warning, /^execute_stage types/, "the typists of both flows, not only execute_stage's");
  asked = 0;
  const packet = executorCliCheck({ executor: false, claudeTypists: ["opus"], cliProblem });
  assert.deepEqual([packet.halt, packet.warning, packet.check.claude_cli, asked], [null, null, "not checked", 0]);
  const noClaude = executorCliCheck({ executor: true, claudeTypists: [], cliProblem });
  assert.deepEqual([noClaude.halt, noClaude.check.claude_cli], [null, "not checked"], "a policy with no Claude typist needs no claude CLI");
  assert.equal(executorCliCheck({ executor: true, claudeTypists: ["opus"], cliProblem: () => null }).check.claude_cli, "ok");
});

test("under vendor auth a Claude model whose key variable is unset cannot be billed as the policy says", () => {
  const { claudeKeyProblem } = preflightModule;
  const named = { id: "sonnet", adapter: "claude-cli", auth: { env: "WORK_ANTHROPIC_KEY" } };
  assert.match(claudeKeyProblem(named, "vendor", {}), /WORK_ANTHROPIC_KEY not set/);
  assert.equal(claudeKeyProblem(named, "vendor", { WORK_ANTHROPIC_KEY: "k" }), null);
  assert.equal(claudeKeyProblem(named, "estimated", {}), null, "an estimated run is on the subscription");
  assert.match(claudeKeyProblem({ id: "opus", adapter: "builtin-anthropic" }, "vendor", {}), /ANTHROPIC_API_KEY not set/);
  assert.equal(claudeKeyProblem({ id: "sonnet", adapter: "claude-cli" }, "vendor", {}), null, "a claude-cli model that names no key runs on the CLI's own login, as it always has");
  assert.equal(claudeKeyProblem({ id: "flash", adapter: "mcp:model-dispatch", auth: { env: "GEMINI_API_KEY" } }, "vendor", {}), null, "not a Claude model");
});

// The real server over stdio. Only a stand-in claude's folder and the system folders are on its PATH.

const FULL_HELP = ["-p, --print", "--output-format <format>", "--model <model>", "--tools <tools...>", "--append-system-prompt-file <file>", "--effort <level>", "--strict-mcp-config", "--safe-mode"].map((l) => `  ${l}  x`).join("\n");
const OLD_HELP = ["-p, --print", "--output-format <format>", "--model <model>", "--append-system-prompt <prompt>"].map((l) => `  ${l}  x`).join("\n");

function standInClaude(version, help) {
  const bin = mkdtempSync(join(tmpdir(), "standin-claude-"));
  writeFileSync(join(bin, "help.txt"), help + "\n");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in\n  --version) echo "${version} (Claude Code)"; exit 0;;\n  --help) cat "${bin}/help.txt"; exit 0;;\nesac\nexit 1\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

function policyFile(text) {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  writeFileSync(join(dir, "p.yaml"), text);
  return join(dir, "p.yaml");
}

async function preflightWith(bin, args, extraEnv = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "preflight-home-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MMO_LOG_LEVEL: "error", ...extraEnv }, stderr: "ignore" });
  const client = new Client({ name: "preflight-test", version: "0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "preflight_dispatch", arguments: { project_root: home, ...args } });
    assert.notEqual(r.isError, true, r.content[0].text);
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

test("a new-app build whose claude CLI cannot run the lean Opus typist halts at pre-flight, naming the missing flags and how to update", async () => {
  const old = standInClaude("1.0.99", OLD_HELP);
  const out = await preflightWith(old, { auth_mode: "estimated", policy_name: "opus-only-v5", executor: true });
  assert.equal(out.ok, false);
  for (const f of ["--tools", "--append-system-prompt-file", "--effort"]) assert.ok(out.halt_reason.includes(f), `${f}: ${out.halt_reason}`);
  assert.match(out.halt_reason, /update Claude Code/);
  assert.deepEqual(out.executor.claude_typists, ["opus"]);
  // Not told whether the typists type this run's files: reported, not a halt.
  const unknown = await preflightWith(old, { auth_mode: "estimated", policy_name: "opus-only-v5" });
  assert.equal(unknown.ok, true, unknown.halt_reason);
  assert.ok(unknown.warnings.some((w) => w.includes("--tools")), JSON.stringify(unknown.warnings));
  // A run whose files no typist types (executor: false) has nothing for the CLI to do.
  const typesNothing = await preflightWith(old, { auth_mode: "estimated", policy_name: "opus-only-v5", executor: false });
  assert.equal(typesNothing.ok, true);
  assert.ok(!typesNothing.warnings.some((w) => w.includes("--tools")));
  // No claude on the server's PATH at all.
  const none = await preflightWith(mkdtempSync(join(tmpdir(), "no-claude-")), { auth_mode: "estimated", policy_name: "opus-only-v5", executor: true });
  assert.equal(none.ok, false);
  assert.match(none.halt_reason, /no `claude` command on this server's PATH/);
  // A current CLI passes.
  const current = await preflightWith(standInClaude("2.1.283", FULL_HELP), { auth_mode: "estimated", policy_name: "opus-only-v5", executor: true });
  assert.equal(current.ok, true, current.halt_reason);
  assert.equal(current.executor.claude_cli, "ok");
});

test("pre-flight checks the Claude model the run's last attempt really uses: the default slot as the run chose it", async () => {
  const bin = standInClaude("2.1.283", FULL_HELP);
  const policy_path = policyFile(`version: 1
name: slots-default
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: sonnet
    adapter: builtin-anthropic
    model_name: claude-sonnet-5
  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.8-flash
select:
  premium: { default: sonnet, options: [opus, sonnet] }
rules:
  - when: { phase: [codegen, tests, docs, debug] }
    use: flash
  - default: premium
`);
  const out = await preflightWith(bin, { auth_mode: "estimated", policy_path, executor: true }, { GEMINI_API_KEY: "fake-not-real", GEMINI_BACKEND: "api-key", MMO_SELECT: "premium=sonnet" });
  assert.deepEqual(out.not_selected, ["opus"]);
  assert.ok(out.models.some((m) => m.id === "sonnet"), "the last attempt's model is checked and priced");
  assert.deepEqual(out.executor.claude_typists, ["sonnet"], "never the de-selected opus");
});

test("a vendor run whose Claude model's key variable is unset halts at pre-flight", async () => {
  const bin = standInClaude("2.1.283", FULL_HELP);
  const policy_path = policyFile(`version: 1
name: cli-key
models:
  - id: sonnet
    adapter: claude-cli
    model_name: claude-sonnet-5
    auth: { env: WORK_ANTHROPIC_KEY }
rules:
  - default: sonnet
`);
  const unset = await preflightWith(bin, { auth_mode: "vendor", policy_path });
  assert.equal(unset.ok, false);
  assert.match(unset.halt_reason, /WORK_ANTHROPIC_KEY not set/);
  const set = await preflightWith(bin, { auth_mode: "vendor", policy_path }, { WORK_ANTHROPIC_KEY: "k" });
  assert.equal(set.ok, true, set.halt_reason);
});

test("pre-flight shows how the executor reads the policy before anything is spent", async () => {
  const bin = standInClaude("2.1.283", FULL_HELP);
  const out = await preflightWith(bin, { auth_mode: "estimated", policy_path: join(HERE, "fixtures", "earlier-policies", "opus-plus-flash-v38.yaml") }, { GEMINI_API_KEY: "fake-not-real", GEMINI_BACKEND: "api-key" });
  assert.equal(out.ok, true, out.halt_reason);
  assert.ok(out.policy_notes.some((n) => /read by its stage alone/.test(n)), JSON.stringify(out.policy_notes));
});

test("an unreadable or odd settings file never stops pre-flight: the run card reports it", async () => {
  const bin = standInClaude("2.1.283", FULL_HELP);
  const project = mkdtempSync(join(tmpdir(), "odd-settings-"));
  mkdirSync(join(project, ".claude", "settings.local.json"), { recursive: true });
  const out = await preflightWith(bin, { auth_mode: "estimated", policy_name: "opus-only-v5", project_root: project });
  assert.equal(out.ok, true, out.halt_reason);
  assert.deepEqual(out.run_card.settings_problems.map((p) => p.split(":")[0]), [join(project, ".claude", "settings.local.json")]);
});

// preflight_dispatch's own definition is what an orchestrator reads: it asks executor: true of every run the typists
// type, a brownfield run included (its packets go through the same lean Opus typist and claude CLI).
test("preflight_dispatch asks executor: true of every run the typists type, brownfield included", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "preflight-home-"));
  const client = new Client({ name: "preflight-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: "/usr/bin:/bin", HOME: home, MMO_LOG_LEVEL: "error" }, stderr: "ignore" }));
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "preflight_dispatch");
    assert.match(tool.description, /Pass executor: true for every run whose files the typists type \(every new-app build and every brownfield run\)/);
    const executor = tool.inputSchema.properties.executor.description;
    assert.doesNotMatch(executor, /false for a brownfield run/);
    assert.match(executor, /brownfield/);
  } finally {
    await client.close();
  }
});

// Under estimated a Claude model's API adapter is not used, but the lean Opus typist types that same model's files on
// this computer's Claude login. Pre-flight's note on the adapter says so, instead of claiming the run never dispatches
// to the model.
test("under estimated, a Claude model the typists type is not called undispatched: its API adapter is what goes unused", () => {
  const out = assessModels(MODELS, "estimated", factoryFailing("opus"), undefined, ["opus"]);
  assert.equal(out.ok, true);
  assert.equal(out.warnings.length, 1);
  assert.doesNotMatch(out.warnings[0], /does not dispatch to it/);
  assert.match(out.warnings[0], /lean Opus typist/);
  assert.match(out.warnings[0], /probe_typists/);
  // A model no typist types keeps the old note.
  assert.match(assessModels(MODELS, "estimated", factoryFailing("opus")).warnings[0], /does not dispatch to it/);
});
