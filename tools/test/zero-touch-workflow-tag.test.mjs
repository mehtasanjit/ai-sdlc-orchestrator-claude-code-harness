/**
 * How a workflow zero-touch starts learns the person's models, with mmo's own texts unchanged.
 *
 * Zero-touch starts a workflow the way a person typing its command would, with one tag at the front of the command's
 * arguments: `[zero-touch policy=<name> auth=<vendor|estimated>]`, then the person's own words for the job. Zero-touch
 * is a strict add-on: mmo's command, skill and agent texts are mmo's own, so they say nothing about the tag. What
 * differs in a run zero-touch started is said beside the command instead, the moment it loads, and only in a zero-touch
 * chat (route-flow.mjs runNote, given by hook.mjs "post-skill"): the tag's policy wins over the project's saved choice
 * and over a repo-local routing-policy.yaml, as an explicit file (the rule /mmo:pass already follows), and the cost
 * recording is not asked. The model-server calls and the run-start check are stamped with the same file whatever
 * Claude passes (tools/test/zero-touch-routing-stamp.test.mjs).
 *
 * This test holds the two sides to one format, what zero-touch sends and what Claude is told it means, and holds mmo's
 * texts free of zero-touch.
 *
 * Offline: files of this repository only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const R = await import(join(PLUGIN, "scripts", "ambient", "lib", "route-flow.mjs"));
const ALIASES = ["bugfix", "deps", "docs", "feature-extend", "feature-new", "refactor", "test"];

test("what zero-touch sends is exactly the documented tag, then the person's words", () => {
  assert.equal(R.startArgs({ policy: "opus-plus-sonnet", auth: "estimated" }), "[zero-touch policy=opus-plus-sonnet auth=estimated]");
  assert.equal(R.startArgs({ policy: "opus-only-v5", auth: "vendor", args: "fix the login bug" }), "[zero-touch policy=opus-only-v5 auth=vendor] fix the login bug");
  assert.equal(R.startArgs({ policy: "../../etc/passwd", auth: "free" }), "[zero-touch policy=opus-plus-flash-v38 auth=estimated]", "anything odd becomes the standard pick and the standard recording");
  const shape = /^\[zero-touch policy=[A-Za-z0-9][A-Za-z0-9._-]* auth=(vendor|estimated)\]( .+)?$/;
  for (const args of ["", "x"]) assert.match(R.startArgs({ policy: "opus-plus-flash-v38", auth: "estimated", args }), shape);
  // The instruction Claude gets names the Skill call with that tag, and tells it not to ask about the two choices.
  const line = R.startInstruction({ job: "bugfix", args: "fix it", auth: "estimated", policy: "opus-plus-sonnet" });
  assert.match(line, /skill "mmo:bugfix", args "\[zero-touch policy=opus-plus-sonnet auth=estimated\] fix it"/);
  assert.match(line, /do not ask about either/);
});

test("mmo's own command, skill and agent texts say nothing about zero-touch", () => {
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".md")) files.push(p); } };
  for (const d of ["commands", "skills", "agents"]) walk(join(PLUGIN, d));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /zero[\s-]?touch|workflow-stopped|git-baseline|\/ambient\//i, f);
  }
});

test("the note given when a workflow zero-touch started loads: the tag's two choices, and how to hand the chat back", () => {
  const path = join(PLUGIN, "config", "policies", "opus-plus-sonnet.yaml");
  for (const job of Object.keys(R.PLAIN)) {
    const note = R.runNote({ job, policy: "opus-plus-sonnet", auth: "estimated" });
    assert.ok(note.includes("[zero-touch policy=opus-plus-sonnet auth=estimated]"), job);
    assert.ok(note.includes(`policy_path "${path}"`), `${job}: the explicit file`);
    assert.match(note, /do not stop because none is saved/);
    assert.match(note, /show "opus-plus-sonnet \(chosen for this run\)"/);
    assert.match(note, /Cost recording: estimated\. Show it where the command shows it, and do not ask\./);
    assert.match(note, /Do not ask the person to set CLAUDE_CODE_SUBAGENT_MODEL/, "the helpers follow the chat's model, which zero-touch checked");
    assert.ok(note.includes(R.STOP_NOTE), `${job}: how to hand the chat back`);
    assert.match(note, job === "greenfield" ? /is the brief to build from/ : /The job's description is the text after the tag\./, job);
    assert.match(note, /Keep the plugin, command names and model names out of what you say to the person\./);
  }
  assert.doesNotMatch(R.runNote({ job: "bugfix", policy: "opus-plus-sonnet", auth: "vendor" }), /CLAUDE_CODE_SUBAGENT_MODEL/, "under vendor no helper model is checked");
  // The early-stop script is zero-touch's own, and exists.
  assert.ok(R.STOP_NOTE.includes(`node "${R.WORKFLOW_STOPPED}"`));
  assert.ok(existsSync(R.WORKFLOW_STOPPED) && R.WORKFLOW_STOPPED.includes(join("scripts", "ambient")));
});

test("every job zero-touch starts is a workflow command", async () => {
  const { WORKFLOW_COMMANDS } = await import(join(PLUGIN, "scripts", "ambient", "lib", "commands.mjs"));
  for (const job of Object.keys(R.PLAIN)) {
    assert.ok(WORKFLOW_COMMANDS.has(job), `${job} is a workflow command`);
    assert.ok(job === "greenfield" || ALIASES.includes(job), job);
  }
});
