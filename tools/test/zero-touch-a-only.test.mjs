/**
 * In workflow mode, zero-touch is its workflow routing and nothing else. (Hand-off mode, the plugin's other mode, is
 * chosen in the settings box and has its own tests: zero-touch-handoff-*.test.mjs. Everything below is about a chat
 * in workflow mode, the default.)
 *
 * A zero-touch chat whose message is not a recognised job is plain Claude Code: nothing is added to what the model
 * reads, no tool is refused or rewritten, and the plugin keeps no settings for it. The generic orchestrator (a
 * start-of-chat note, big Reads turned into outlines, by-hand typing handed to a worker, a savings board) is not part
 * of zero-touch.
 *
 * These tests drive the real shell shim with the hook input Claude Code sends, in a chat the zero-touch plugin marked
 * at its start (tools/test/lib/chat-start.mjs). Each test has its own MMO_HOME and project folder; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const AMBIENT = join(PLUGIN, "scripts", "ambient");
const SHIM = join(PLUGIN, "hooks", "ambient.sh");
const { startingChats, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-a-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runOnce(event, payload, { home, repo }) {
  return new Promise((done) => {
    const env = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => done({ code, stdout }));
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home);
/** The matcher of the two hooks around hand-off mode's own tools. */
const HANDOFF_TOOLS = "mcp__(plugin_mmo_)?model-dispatch__(write_document|write_tests_from_cases|repeat_edit_across_files|undo_hand_off)";

test("zero-touch hooks only the moments it needs: eleven for workflow routing, five for hand-off mode (its model pin, and around its own tools); no Read, Bash, Write or Edit hook", () => {
  // Registered by the zero-touch plugin, run through its shim into mmo's hook script.
  const hooks = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks;
  const moments = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const e of entries) {
      for (const h of e.hooks) {
        const m = /mmo-hook\.sh" (\S+)$/.exec(h.command);
        if (m) moments.push(`${event}:${e.matcher ?? ""}:${m[1]}`);
      }
    }
  }
  assert.deepEqual(moments.sort(), [
    "PostToolUse:Skill:post-skill",
    "PostToolUse:AskUserQuestion:post-question",
    "Stop::turn-end",
    // A turn that ends in an error (StopFailure) gets turn-end's clean-up (zero-touch-workflow-life tests).
    "StopFailure::turn-failed",
    "PreToolUse:*:pre-any",
    "PreToolUse:Agent|Task:pre-agent",
    "PreToolUse:Skill:pre-skill",
    "SessionStart::session-start",
    "UserPromptSubmit::prompt",
    // A run zero-touch started has the person's policy stamped on every model-server call that takes one,
    // and /clear releases a workflow it abandons (zero-touch-routing tests).
    "PreToolUse:mcp__(plugin_mmo_)?model-dispatch__(load_policy|preflight_dispatch|execute_with_model|execute_batch|simulate_policy):pre-dispatch",
    "SessionEnd:clear:session-end",
    // Hand-off mode keeps a chat on its pinned model (zero-touch-handoff-chat.test.mjs), and a workflow zero-touch
    // started keeps the chat on the model its helpers follow (ambient-routing-hooks.test.mjs).
    "PreModelSwitch::pre-model-switch",
    "PostModelSwitch::post-model-switch",
    // Around a hand-off tool call (zero-touch-handoff-tools.test.mjs): matched on those tools only.
    `PreToolUse:${HANDOFF_TOOLS}:pre-handoff`,
    `PostToolUse:${HANDOFF_TOOLS}:post-handoff`,
    // A hand-off call that failed or was interrupted: its file handed back, an interrupt marked.
    `PostToolUseFailure:${HANDOFF_TOOLS}:handoff-failed`,
  ].sort());
});

test("an ordinary message in a zero-touch chat gets nothing added for the model: no start-of-chat note, no instruction, first message or later", async () => {
  const s = sandbox();
  try {
    for (const text of ["what does the checkout function return when the cart is empty?", "thanks, that makes sense", "rename the variable x to total in cart.js"]) {
      const r = await run("prompt", { session_id: "plain1", cwd: s.repo, prompt: text, prompt_id: `p-${text.length}` }, s);
      // Quiet by default: ordinary chat gets nothing, for the person or for the model.
      assert.equal(r.stdout, "", `nothing is shown and nothing is added: ${text}`);
    }
  } finally {
    s.cleanup();
  }
});

test("in an ordinary zero-touch chat every tool runs untouched: nothing is refused, rewritten or outlined", async () => {
  const s = sandbox();
  try {
    await run("prompt", { session_id: "plain2", cwd: s.repo, prompt: "explain how the cart total is computed", prompt_id: "p1" }, s);
    const big = join(s.repo, "big.js");
    writeFileSync(big, Array.from({ length: 3000 }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n"));
    const calls = [
      ["pre-any", { tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x".repeat(20000) } }],
      ["pre-any", { tool_name: "Bash", tool_input: { command: `cat ${big}` } }],
      ["pre-any", { tool_name: "Edit", tool_input: { file_path: big, old_string: "f1()", new_string: "g1()" } }],
      ["pre-agent", { tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "look around" } }],
    ];
    for (const [event, payload] of calls) {
      const r = await run(event, { session_id: "plain2", cwd: s.repo, ...payload }, s);
      assert.equal(r.stdout, "", `${event} ${payload.tool_name} passes untouched`);
    }
    // Read, Write and Bash moments have no handler: even called directly, the hook program answers nothing.
    const hook = join(AMBIENT, "hook.mjs");
    for (const [event, payload] of [
      ["post-read", { tool_name: "Read", tool_input: { file_path: big }, tool_response: { type: "text", file: { filePath: big, content: readFileSync(big, "utf8"), numLines: 3000, startLine: 1, totalLines: 3000 } } }],
      ["pre-write", { tool_name: "Write", tool_input: { file_path: join(s.repo, "b.js"), content: "y".repeat(20000) } }],
      ["pre-bash", { tool_name: "Bash", tool_input: { command: `cat ${big}` } }],
    ]) {
      const out = await new Promise((done) => {
        const p = spawn(process.execPath, [hook, event], { cwd: s.repo, env: { PATH: process.env.PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PROJECT_DIR: s.repo }, stdio: ["pipe", "pipe", "pipe"] });
        let o = "";
        p.stdout.on("data", (c) => (o += c));
        p.on("close", () => done(o));
        // The hook exits at once for a moment it has no handler for, so the pipe may close before all input is sent.
        p.stdin.on("error", () => {});
        p.stdin.end(JSON.stringify({ session_id: "plain2", cwd: s.repo, ...payload }));
      });
      assert.equal(out, "", `${event} has no handler any more`);
    }
  } finally {
    s.cleanup();
  }
});

test("the shipped settings hold only routing's keys (the person's choices live in the zero-touch plugin), and a settings file's other keys are ignored", async () => {
  const shipped = JSON.parse(readFileSync(join(PLUGIN, "config", "ambient.default.json"), "utf8"));
  assert.deepEqual(Object.keys(shipped).sort(), ["retention_days", "routing", "routing_defaults", "schema_version"]);
  assert.deepEqual(Object.keys(shipped.routing_defaults), ["auth"]);
  const { loadConfig } = await import(join(AMBIENT, "lib", "config.mjs"));
  const s = sandbox();
  try {
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ routing: "off", delegation: "off", valves: { read: { enabled: false } }, jobs: { max_parallel: 9 }, thinker: "claude-sonnet-5", lock_model: true }));
    const { config } = loadConfig({ projectDir: s.repo, env: { MMO_HOME: s.home, HOME: s.home } });
    assert.equal(config.routing, "off", "routing's own key is still read");
    for (const gone of ["delegation", "valves", "jobs", "thinker", "lock_model", "cost", "offers", "control", "workers"]) {
      assert.equal(config[gone], undefined, `${gone} is not a setting any more`);
    }
  } finally {
    s.cleanup();
  }
});

test("the generic orchestrator's files are absent, and every file in the hook's folder is used by the hook", async () => {
  for (const gone of [
    "plugin/scripts/ambient/jobs.mjs", "plugin/scripts/ambient/apply.mjs", "plugin/scripts/ambient/lookup.mjs",
    "plugin/scripts/ambient/write-files.mjs", "plugin/scripts/ambient/census.mjs", "plugin/scripts/ambient/setup.mjs",
    "plugin/scripts/ambient/board", "plugin/config/ambient-labels.json", "plugin/mcp/model-dispatch/src/ambient",
    "tools/ambient-preflight.mjs",
    // Also the generic orchestrator's: the seed evidence for its worker-picking rule, and the no-tools worker launch
    // for its chat jobs (hand-off mode types through the executor's own typists).
    "plugin/config/ambient-seeds.json", "plugin/mcp/model-dispatch/test/claudeWorkerLaunch.test.mjs",
  ]) {
    assert.ok(!existsSync(join(ROOT, gone)), `${gone} is removed`);
  }
  // Zero-touch ships one settings file. Any other ambient* file in the plugin's config folder is read by nothing.
  assert.deepEqual(readdirSync(join(PLUGIN, "config")).filter((n) => /^ambient/.test(n)), ["ambient.default.json"]);
  // The typed pipeline's `claude` worker starts with the pipeline's own arguments and nothing of zero-touch's: a
  // launch option no caller sets is a change to the pipeline's file that does nothing.
  assert.doesNotMatch(readFileSync(join(PLUGIN, "mcp", "model-dispatch", "src", "adapters", "ClaudeCliAdapter.ts"), "utf8"), /noTools|--tools/);
  // The modules reachable from hook.mjs through its imports, static or dynamic.
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)"(\.{1,2}\/[^"]+)"/g)) {
      const next = resolve(dirname(file), m[1]);
      if (next.startsWith(AMBIENT)) visit(next);
    }
  };
  visit(join(AMBIENT, "hook.mjs"));
  // Zero-touch's own step scripts, which Claude runs when the hook's notes tell it to: used by path.
  const { ZERO_TOUCH_SCRIPTS } = await import(join(AMBIENT, "lib", "own-steps.mjs"));
  const RF = await import(join(AMBIENT, "lib", "route-flow.mjs"));
  assert.deepEqual([RF.WORKFLOW_STOPPED, RF.GIT_BASELINE].map((p) => relative(AMBIENT, p)).sort(), [...ZERO_TOUCH_SCRIPTS].sort());
  for (const p of [RF.WORKFLOW_STOPPED, RF.GIT_BASELINE]) visit(p);
  // The version of these hooks, which the zero-touch plugin reads to tell an mmo too old for it.
  reached.add(join(AMBIENT, "api.json"));
  const present = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else present.push(full);
    }
  };
  walk(AMBIENT);
  const unused = present.filter((f) => !reached.has(f)).map((f) => relative(ROOT, f));
  assert.deepEqual(unused, [], "no file in plugin/scripts/ambient that the hook does not use");
});

test("the plugins describe both of zero-touch's modes, and promise no saving: none has been measured", () => {
  const zt = JSON.parse(readFileSync(join(ROOT, "zero-touch", ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = market.plugins.find((p) => p.name === "zero-touch");
  for (const text of [zt.description, entry?.description ?? ""]) {
    assert.doesNotMatch(text, /cheaper|savings|worker/i, text);
    // Workflow mode: a plain-words request starts its workflow. Hand-off mode: the chat's own model develops and
    // some typing is handed off. A person choosing the plugin in the list must learn of both, and where to choose.
    assert.match(text, /workflow mode/i, text);
    assert.match(text, /hand-off mode/i, text);
    // Where to choose: in the chat, never a file or a command.
    assert.match(text, /change zero-touch settings/, text);
    assert.doesNotMatch(text, /~\/\.mmo-ambient|ambient\.json|\/mmo:/, text);
    assert.match(text, /new chats/i, text);
  }
});
