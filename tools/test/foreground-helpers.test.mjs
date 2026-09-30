/**
 * The PreToolUse hook that keeps the pipeline's own helpers in the foreground
 * (plugin/scripts/foreground-helpers.mjs), and its registration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, PIPELINE_AGENTS } from "../../plugin/scripts/foreground-helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "plugin", "scripts", "foreground-helpers.mjs");
const launch = (subagent_type, run_in_background, tool_name = "Agent", caller = {}) => ({ tool_name, tool_input: { description: "d", prompt: "p", subagent_type, run_in_background }, ...caller });
const fromAgent = (agent_type) => ({ agent_id: "a1", agent_type });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("a background launch of one of the pipeline's helpers is refused with the way to launch it again", () => {
  for (const t of ["mmo:architect", "mmo:senior-reviewer", "mmo:security-reviewer", "mmo:orchestrator", "mmo:discovery"]) {
    const out = decide(launch(t, true));
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", t);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /run_in_background set to false/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /during an mmo run/, "no run is known to the hook");
  }
  assert.equal(decide(launch("mmo:architect", true, "Task"))?.hookSpecificOutput?.permissionDecision, "deny", "the older Task tool name too");
});

test("a prefixed name spelled the way Claude Code still resolves to the plugin's agent is refused too", () => {
  for (const t of ["mmo:Architect", "mmo:senior_reviewer", "mmo:Security Reviewer", "MMO:orchestrator"]) assert.ok(denied(decide(launch(t, true))), t);
});

test("every other launch is allowed untouched: foreground launches, other agents, other tools", () => {
  assert.equal(decide(launch("mmo:architect", false)), null);
  assert.equal(decide(launch("mmo:architect", undefined)), null);
  for (const t of ["general-purpose", "Explore", "other-plugin:architect", "my-architect"]) assert.equal(decide(launch(t, true)), null, t);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "ls", run_in_background: true } }), null);
  assert.equal(decide(null), null);
});

test("a user's own agent that shares a helper's bare name runs in the background from the main chat and from the user's own agents", () => {
  const project = mkdtempSync(join(tmpdir(), "fg-"));
  for (const t of ["architect", "orchestrator", "discovery", "senior-reviewer", "security-reviewer"]) {
    assert.equal(decide(launch(t, true), project), null, `main chat: ${t}`);
    assert.equal(decide(launch(t, true, "Task"), project), null, `main chat, Task: ${t}`);
    assert.equal(decide(launch(t, true, "Agent", fromAgent("architect")), project), null, `the user's own architect agent: ${t}`);
    assert.equal(decide(launch(t, true, "Agent", fromAgent("my-team:lead")), project), null, `another plugin's agent: ${t}`);
    assert.equal(decide(launch(t, true, "Agent", fromAgent("orchestrator")), project), null, `the user's own orchestrator (not the plugin's copy): ${t}`);
  }
  // A project orchestrator of the user's own, with no access to this plugin's dispatch server.
  mkdirSync(join(project, ".claude", "agents"), { recursive: true });
  writeFileSync(join(project, ".claude", "agents", "orchestrator.md"), "---\nname: orchestrator\ndescription: my own\ntools: Read, Agent\n---\nPlan things.\n");
  assert.equal(decide(launch("architect", true, "Agent", fromAgent("orchestrator")), project), null);
});

test("inside the plugin's own orchestrator a bare helper name is the pipeline's helper and stays in the foreground", () => {
  const project = mkdtempSync(join(tmpdir(), "fg-"));
  for (const t of ["architect", "senior-reviewer", "security-reviewer", "discovery", "Architect"]) {
    assert.ok(denied(decide(launch(t, true, "Agent", fromAgent("mmo:orchestrator")), project)), `mmo:orchestrator launching ${t}`);
  }
  assert.equal(decide(launch("general-purpose", true, "Agent", fromAgent("mmo:orchestrator")), project), null, "only the pipeline's helpers");
  assert.equal(decide(launch("architect", false, "Agent", fromAgent("mmo:orchestrator")), project), null, "a foreground launch passes");
  // The clone route copies the plugin's orchestrator into the project's .claude/agents, where it is named without the prefix.
  mkdirSync(join(project, ".claude", "agents"), { recursive: true });
  copyFileSync(join(ROOT, "plugin", "agents", "orchestrator.md"), join(project, ".claude", "agents", "orchestrator.md"));
  assert.ok(denied(decide(launch("architect", true, "Agent", fromAgent("orchestrator")), project)), "the clone route's orchestrator");
  // The hook reads the project folder from the payload's cwd when it is not handed one.
  assert.ok(denied(decide({ ...launch("architect", true, "Agent", fromAgent("orchestrator")), cwd: project })), "project from the payload's cwd");
});

test("the list of pipeline helpers matches the plugin's agent files", () => {
  const names = readdirSync(join(ROOT, "plugin", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual([...PIPELINE_AGENTS].sort(), names);
});

test("the script speaks the hook protocol: deny JSON on stdout for a refused launch, nothing otherwise; registered for Agent|Task", () => {
  const deny = spawnSync("node", [SCRIPT], { input: JSON.stringify(launch("mmo:architect", true)), encoding: "utf8" });
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allow = spawnSync("node", [SCRIPT], { input: JSON.stringify(launch("general-purpose", true)), encoding: "utf8" });
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout, "");
  const garbage = spawnSync("node", [SCRIPT], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 0, "a payload it cannot read is allowed, never an error");
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"));
  const entry = hooks.hooks.PreToolUse.find((h) => h.matcher === "Agent|Task");
  assert.ok(entry, "registered in hooks.json");
  assert.match(entry.hooks[0].command, /scripts\/foreground-helpers\.mjs/);
});


test("the hook answers when the plugin sits under a path with a space or behind a symlink", async () => {
  const { mkdtempSync, copyFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "scripts", "foreground-helpers.mjs");
  const base = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(base, "with space"));
  copyFileSync(src, join(base, "with space", "foreground-helpers.mjs"));
  symlinkSync(join(base, "with space"), join(base, "link"));
  const payload = JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "mmo:architect", run_in_background: true } });
  for (const p of [join(base, "with space", "foreground-helpers.mjs"), join(base, "link", "foreground-helpers.mjs")]) {
    const r = spawnSync(process.execPath, [p], { input: payload, encoding: "utf8" });
    assert.match(r.stdout, /"permissionDecision":"deny"/, p);
  }
});
