/**
 * The commands in plugin/hooks/hooks.json, run the way Claude Code runs them: the plugin root
 * put in place of ${CLAUDE_PLUGIN_ROOT} as plain text, the command handed to /bin/sh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

const allCommands = () => Object.entries(HOOKS).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, command: h.command }))));

/** A plugin root whose path holds a space, as under a home or config folder with one. */
function spacedPluginRoot() {
  const base = mkdtempSync(join(tmpdir(), "hook-cmd-"));
  mkdirSync(join(base, "plugins cache"));
  const root = join(base, "plugins cache", "mmo");
  symlinkSync(join(ROOT, "plugin"), root);
  return root;
}

function run(command, root, payload, projectDir, { expandInShell = false } = {}) {
  const line = expandInShell ? command : command.replaceAll(PLACEHOLDER, root);
  return spawnSync("/bin/sh", ["-c", line], {
    input: JSON.stringify({ cwd: projectDir, ...payload }),
    encoding: "utf8",
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...(expandInShell ? { CLAUDE_PLUGIN_ROOT: root } : {}) },
  });
}

test("every hook command quotes the plugin root, so a path with a space stays one word", () => {
  const cmds = allCommands();
  assert.ok(cmds.length >= 5);
  for (const { command } of cmds) {
    const uses = command.split(PLACEHOLDER).length - 1;
    assert.ok(uses > 0, `${command} names its script through the plugin root`);
    assert.equal((command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}[^"\s]*"/g) ?? []).length, uses, `unquoted plugin root in: ${command}`);
  }
});

test("every hook runs and answers from a plugin root with a space in its path", () => {
  for (const expandInShell of [false, true]) {
    const root = spacedPluginRoot();
    const project = mkdtempSync(join(tmpdir(), "hook-proj-"));
    const how = expandInShell ? "placeholder expanded by the shell" : "placeholder replaced as text";
    for (const { event, matcher, command } of allCommands()) {
      const r = run(command, root, { hook_event_name: event, tool_name: "Read", tool_input: {} }, project, { expandInShell });
      assert.equal(r.status, 0, `${how}: ${matcher}: ${command}\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Cannot find module|No such file|not found/, `${how}: ${command}`);
    }
    const byScript = (name) => allCommands().find((c) => c.command.includes(name)).command;

    const fg = run(byScript("foreground-helpers.mjs"), root, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "mmo:architect", run_in_background: true } }, project, { expandInShell });
    assert.equal(JSON.parse(fg.stdout).hookSpecificOutput.permissionDecision, "deny", `${how}: the foreground rule answers`);

    const post = allCommands().find((c) => c.command.includes("executor-guard.mjs") && c.event === "PostToolUse").command;
    const pre = allCommands().find((c) => c.command.includes("executor-guard.mjs") && c.event === "PreToolUse").command;
    run(post, root, { hook_event_name: "PostToolUse", tool_name: "mcp__plugin_mmo_model-dispatch__execute_stage", tool_input: { stage: "codegen", spec_path: ".sdlc/spec.json" }, agent_id: "o1", agent_type: "mmo:orchestrator" }, project, { expandInShell });
    assert.ok(existsSync(join(project, ".sdlc", "local", "executor-agents.json")), `${how}: the executor guard records its orchestrator`);
    const guard = run(pre, root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(project, "src", "a.ts"), content: "x" }, agent_id: "o1", agent_type: "mmo:orchestrator" }, project, { expandInShell });
    assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, "deny", `${how}: the executor guard answers`);

    assert.ok(existsSync(join(project, ".hook-logs", "hook.jsonl")), `${how}: the telemetry heartbeat writes its line`);
  }
});

test("the hooks that run a script with node go through hooks/node.sh: without Node.js they stay silent, with it every answer and exit code passes through", () => {
  // A bare `node …` hook command fails on a computer without Node.js (the desktop app needs none) with
  // "node: command not found" on every file write, edit and helper launch, shown as a hook error.
  const viaShim = allCommands().filter((c) => c.command.includes("/hooks/node.sh"));
  assert.deepEqual(viaShim.map((c) => c.command.split("node.sh\" ")[1]).sort(), ["executor-guard.mjs post", "executor-guard.mjs pre", "foreground-helpers.mjs", "write-contract-check.mjs"]);
  assert.deepEqual(allCommands().filter((c) => /^node\b/.test(c.command)), [], "no hook starts node directly");
  const root = spacedPluginRoot();
  // macOS's temporary folder sits behind a link (/var is /private/var): the paths below are in the linked form, while
  // the hook's own folder reads in the real one; the write contract judges both alike.
  const project = mkdtempSync(join(tmpdir(), "hook-proj-"));
  const bin = mkdtempSync(join(tmpdir(), "no-node-bin-"));
  try {
    // A computer without Node.js: the shell's own tools only.
    for (const tool of ["sh", "dirname"]) {
      const found = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find((f) => existsSync(f));
      if (found) symlinkSync(found, join(bin, tool));
    }
    for (const { event, command } of viaShim) {
      const r = spawnSync("/bin/sh", ["-c", command.replaceAll(PLACEHOLDER, root)], { input: JSON.stringify({ hook_event_name: event, tool_name: "Write", tool_input: { file_path: "src/a.ts", content: "x" } }), encoding: "utf8", cwd: project, env: { PATH: bin, CLAUDE_PROJECT_DIR: project } });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], `without node: ${command}`);
    }
    // With node: the write contract's refusal is an exit code (2), and it must still reach Claude Code. The project is a
    // git project, as every brownfield project is: the hook reads only the contract at a git project's root.
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(project, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, strict: true, run_id: "t1", allowlist: ["src/**"], off_limits: [] }));
    const write = viaShim.find((c) => c.command.includes("write-contract-check.mjs")).command;
    const refused = run(write, root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(project, "docs", "x.md"), content: "x" } }, project);
    assert.equal(refused.status, 2, `the refusal's exit code passes through the shim\n${refused.stderr}`);
    const allowed = run(write, root, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(project, "src", "a.ts"), content: "x" } }, project);
    assert.equal(allowed.status, 0);
  } finally {
    for (const d of [project, bin]) rmSync(d, { recursive: true, force: true });
  }
});
