/**
 * What mmo does with the person's zero-touch choices once a workflow runs, and when a conversation is cleared.
 *
 *   - A run zero-touch started has the person's policy stamped on every model-server call that takes one (load_policy,
 *     preflight_dispatch, execute_with_model, simulate_policy), as an explicit file, which the server and the
 *     workflow's run-start check put ahead of everything, a project's routing-policy.yaml included. Helpers make most
 *     of these calls, so theirs are stamped too. A run the person typed keeps its own rules: nothing is stamped.
 *   - /clear gives the conversation a new chat id, and Claude Code sends SessionEnd (reason "clear") for the old one
 *     first. A workflow abandoned that way is recorded as stopped and its project is freed. Other endings keep it:
 *     that chat can be reopened. Only the run the chat claimed (the run id in its orchestrator's logging calls) is
 *     stopped, never another chat's.
 *   - A command the person typed never carries zero-touch's models: not when it was queued, not when it follows a
 *     start zero-touch had pending. The run-start check of a run zero-touch started gets the person's policy file.
 *   - The line at a workflow's end fits the chat's mode.
 *   - The answer to "Queue it / Replace it" is shown to the person in a line of zero-touch's own.
 *   - A hand-off tool called for work the person keeps in the chat is refused.
 *   - Without a Google login, a kind of hand-off work set to Flash 3.8 is done by the chat's model: the line says so,
 *     its tool is refused before the server, and typing the file by hand passes. Other kinds are handed off as usual.
 *
 * Each case runs mmo's real hook through its shell script, with a chat started as the zero-touch plugin starts one.
 * Routing asks the workflows' own model check, which needs the built server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const POLICIES = join(ROOT, "plugin", "config", "policies");
const { startingChats, writeGoogleLogin, writeZtSettings, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
const SKIP = serverBuilt();

function sandbox(settings = { mode: "workflows" }, { google = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zt-stamp-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  writeZtSettings(home, settings, { google });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
let seq = 0;
const say = (s, sid, text) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++seq}` }, s);
/** A Skill call as Claude Code makes it: PreToolUse, then, when the call was not refused, PostToolUse (the moment a
 * routed workflow's start is recorded). Returns the PreToolUse answer. */
const skill = async (s, sid, name, args, ...rest) => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } };
  const pre = await run("pre-skill", input, s, ...rest);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s, ...rest);
  return pre;
};
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
/** The queued start a turn's end hands the model: the Stop hook's context, never a "block" reason the person reads. */
const queuedStart = (r) => (r.json?.hookSpecificOutput?.hookEventName === "Stop" ? r.json.hookSpecificOutput.additionalContext ?? "" : "");
const updated = (r) => r.json?.hookSpecificOutput?.updatedInput ?? null;
const dispatch = (s, sid, toolName, input, extra = {}) => run("pre-dispatch", { session_id: sid, cwd: s.repo, tool_name: `mcp__plugin_mmo_model-dispatch__${toolName}`, tool_input: input, ...extra }, s);
function workflowLog(s, runId, ...lines) {
  const dir = join(s.repo, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of lines) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}
const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const TESTS = "write unit tests for the pricing functions in src/cart.js";

/** A zero-touch-started bug fix, running: routed, its command started, its run logged. */
async function startedBugfix(s, sid) {
  const c = context(await say(s, sid, BUGFIX));
  const args = /args "([^"]*)"/.exec(c)?.[1];
  assert.equal((await skill(s, sid, "mmo:bugfix", args)).stdout, "");
  // The orchestrator's logging call, through this chat: it claims the run as this chat's.
  await run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", agent_id: "orchestrator-1", tool_input: { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --level=info --run-id=bf-${sid} --project-root "${s.repo}"` } }, s);
  workflowLog(s, `bf-${sid}`, ["run.start", { mode: "brownfield" }]);
  return args;
}

const r0 = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;

test("every model-server call of a run zero-touch started carries the person's policy as an explicit file, helpers' calls included", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n# a team's own file: not used by zero-touch\n");
    const args = await startedBugfix(s, "d1");
    assert.match(args, /^\[zero-touch policy=opus-plus-sonnet auth=estimated\] /, "the start carries the pick");
    const path = join(POLICIES, "opus-plus-sonnet.yaml");
    for (const toolName of ["load_policy", "preflight_dispatch", "execute_with_model", "simulate_policy"]) {
      const input = { policy_name: "opus-plus-flash", project_root: s.repo, auth_mode: "estimated" };
      const r = await dispatch(s, "d1", toolName, input);
      assert.deepEqual(updated(r), { ...input, policy_path: path }, `${toolName}: the rest of the call as it was, the policy file added`);
      const helper = await dispatch(s, "d1", toolName, input, { agent_id: "orchestrator-1" });
      assert.deepEqual(updated(helper), { ...input, policy_path: path }, `${toolName}: a helper's call too`);
    }
    // A call that already names it is left as it is; as a step of the person's own workflow it is allowed without a
    // permission prompt, like every stamped call (lib/own-steps.mjs).
    const named = await dispatch(s, "d1", "load_policy", { policy_path: path });
    assert.equal(named.json?.hookSpecificOutput?.updatedInput, undefined, "a call that already names it is left alone");
    assert.equal(named.json?.hookSpecificOutput?.permissionDecision, "allow");
    assert.equal(r0(await dispatch(s, "d1", "preflight_dispatch", { policy_name: "x" })), "allow", "a stamped call is allowed too");
    assert.ok(!existsSync(join(s.repo, ".sdlc", "project.json")), "nothing is written into the project");
  } finally { s.cleanup(); }
});

test("a run the person typed, or no run at all: nothing is stamped (the folder's own rules apply to what a person types)", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const input = { policy_name: "opus-plus-flash", project_root: s.repo };
    assert.equal((await dispatch(s, "n1", "load_policy", input)).stdout, "", "no workflow running");
    await run("prompt", { session_id: "n2", cwd: s.repo, prompt: "/mmo:bugfix the login 500", prompt_id: "t-1" }, s);
    assert.equal((await skill(s, "n2", "mmo:bugfix", "the login 500")).stdout, "");
    assert.equal((await dispatch(s, "n2", "load_policy", input)).stdout, "", "a typed run keeps its own rules");
  } finally { s.cleanup(); }
});

test("/clear ends the old chat id: a workflow it abandons is recorded as stopped and the project is free; an exit keeps it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startedBugfix(s, "old");
    const blocked = await say(s, "other", TESTS);
    assert.doesNotMatch(context(blocked), /"mmo:test"/, "while it runs, the project is held");
    // An exit (or /resume to another chat) keeps it: that chat can be reopened and carry on.
    await run("session-end", { session_id: "old", cwd: s.repo, reason: "prompt_input_exit" }, s);
    assert.doesNotMatch(context(await say(s, "other", TESTS)), /"mmo:test"/, "an exit keeps the project held");
    // /clear: Claude Code ends the OLD chat id, then starts the cleared conversation under a new one.
    await run("session-end", { session_id: "old", cwd: s.repo, reason: "clear" }, s);
    const log = readFileSync(join(s.repo, ".sdlc", "runs", "bf-old", "orchestrator.log"), "utf8");
    assert.match(log, /run\.end[\s\S]*aborted[\s\S]*cleared/, "the run is recorded as stopped, as Replace it stops one");
    assert.ok(!existsSync(join(s.home, "sessions", "old", "pipeline")), "the old chat is no longer a workflow run");
    assert.match(context(await say(s, "other", TESTS)), /"mmo:test"/, "the project is free again");
  } finally { s.cleanup(); }
});

test("/clear stops only the run this chat claimed: a run another chat started later in the folder is left alone", { skip: SKIP ?? false }, async () => {
  // Picking the run by time would make /clear in one chat stop a newer run of a chat without zero-touch in the same
  // folder (and switch off its write lock), leaving its own run open.
  const s = sandbox();
  try {
    await startedBugfix(s, "mine");
    await new Promise((r) => setTimeout(r, 20));
    workflowLog(s, "theirs", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }]);
    mkdirSync(join(s.repo, ".sdlc", "local"), { recursive: true });
    const contract = join(s.repo, ".sdlc", "local", "write-contract.json");
    writeFileSync(contract, JSON.stringify({ schema_version: 1, active: true, run_id: "theirs", allowlist: [], off_limits: [] }));
    await run("session-end", { session_id: "mine", cwd: s.repo, reason: "clear" }, s);
    assert.match(readFileSync(join(s.repo, ".sdlc", "runs", "bf-mine", "orchestrator.log"), "utf8"), /run\.end[\s\S]*cleared/, "this chat's run is stopped");
    assert.doesNotMatch(readFileSync(join(s.repo, ".sdlc", "runs", "theirs", "orchestrator.log"), "utf8"), /run\.end/, "the other chat's run is untouched");
    assert.equal(JSON.parse(readFileSync(contract, "utf8")).active, true, "and so is its write lock");
  } finally { s.cleanup(); }
});

test("a job asked for while a workflow runs is said at once, and starts with the person's pick when that one ends", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startedBugfix(s, "q1");
    const asked = await say(s, "q1", TESTS);
    assert.equal(asked.json?.systemMessage, "Zero-touch: noted. The test-writing workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.");
    workflowLog(s, "bf-q1", ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    const end = await run("turn-end", { session_id: "q1", cwd: s.repo, stop_hook_active: false }, s);
    assert.match(end.json?.systemMessage ?? "", /the bug-fix workflow has finished, so the test-writing workflow you queued is starting now/);
    assert.match(end.json?.hookSpecificOutput?.additionalContext ?? "", /"mmo:test", args "\[zero-touch policy=opus-plus-flash-v38 auth=estimated\]/, "the queued workflow carries the person's pick");
  } finally { s.cleanup(); }
});

test("a hand-off tool called for work the person keeps in the chat is refused, and Claude is told to do it itself", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "chat", repeats: "flash" } });
  try {
    await run("session-start", { session_id: "k1", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    const r = await run("pre-handoff", { session_id: "k1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_tests_from_cases", tool_input: { file: "tests/a.test.js" } }, s);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(context(r), /keeps this kind of work in the chat/, "the model is told to do it itself");
    assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, "Zero-touch: you keep this kind of work in the chat, so Claude does it itself.", "the person reads one plain sentence");
    const doc = await run("pre-handoff", { session_id: "k1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_input: { file: "docs/a.md" } }, s);
    assert.ok(doc.json?.hookSpecificOutput?.updatedInput?._mmo, "documents are handed off: the call is stamped");
  } finally { s.cleanup(); }
});

test("without a Google login, hand-off work set to Flash 3.8 is done by the chat's model, and said; other kinds are handed off; a login mid-chat counts at once", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "flash" } }, { google: false });
  try {
    await run("session-start", { session_id: "g1", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    const tool = (name, input) => run("pre-handoff", { session_id: "g1", cwd: s.repo, tool_name: `mcp__plugin_mmo_model-dispatch__${name}`, tool_input: input }, s);
    const byHand = (path) => run("pre-any", { session_id: "g1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, path), content: "text\n" } }, s);
    // The line after the message, and what Claude reads.
    const asked = await say(s, "g1", "write a README for this project and write unit tests for the pricing functions in src/cart.js");
    assert.match(asked.json?.systemMessage ?? "", /the new document can't be handed off right now, because this computer isn't connected to Google, so Opus 5 writes it directly\./);
    assert.match(asked.json?.systemMessage ?? "", /Sonnet 5 will write the tests/, "tests go to Sonnet 5, which needs no Google");
    assert.match(context(asked), /not connected to Google, so this work cannot be handed off .*: do it yourself, with your own tools: the new document/);
    assert.match(context(asked), /write_tests_from_cases/);
    // The tools: the Google kind is refused before the server; the Sonnet kind is stamped.
    const doc = await tool("write_document", { file: "README.md" });
    assert.equal(doc.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(doc.json.hookSpecificOutput.permissionDecisionReason, /^Zero-touch: this can't be handed off, because this computer isn't connected to Google/);
    assert.match(context(doc), /not connected to Google/);
    assert.ok((await tool("write_tests_from_cases", { file: "tests/cart.test.js" })).json?.hookSpecificOutput?.updatedInput?._mmo, "tests are handed off");
    assert.equal((await tool("repeat_edit_across_files", {})).json?.hookSpecificOutput?.permissionDecision, "deny", "repeats are set to Flash too");
    // Typing by hand: the Google kind must pass (its tool is refused); the handed-off kind is still pointed at its tool.
    assert.equal((await byHand("docs/guide.md")).stdout, "", "a new document typed by hand passes");
    assert.equal((await byHand("tests/cart.test.js")).json?.hookSpecificOutput?.permissionDecision, "deny", "a new test file typed by hand is refused");
    // Only Google kinds asked for: the approved "can't be handed off" line, whole.
    assert.equal((await say(s, "g1", "write a README for this project")).json?.systemMessage, "Zero-touch: this can't be handed off right now, because this computer isn't connected to Google. So Opus 5 does it directly.");
    // The person connects Google in the middle of the chat: the next use hands off again (the check is never kept).
    writeGoogleLogin(s.home);
    assert.match((await say(s, "g1", "write a README for this project")).json?.systemMessage ?? "", /give Flash 3\.8 instructions to write the new document/);
    assert.ok((await tool("write_document", { file: "README.md" })).json?.hookSpecificOutput?.updatedInput?._mmo, "documents are handed off now");
  } finally { s.cleanup(); }
});

/** Answers the Queue-it / Replace-it question the hook asked in `r` (its question text is in Claude's note). */
async function answerQuestion(s, sid, r, label) {
  const question = /question "([^"]+)"/.exec(context(r))?.[1];
  assert.ok(question, "the question was asked");
  return run("post-question", { session_id: sid, cwd: s.repo, tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { [question]: label } } }, s);
}
/** A typed command's run, running: the typed line, its Skill call, the orchestrator's logging call, its log. */
async function typedRun(s, sid, job, args, runId) {
  await run("prompt", { session_id: sid, cwd: s.repo, prompt: `/mmo:${job} ${args}`, prompt_id: `t-${++seq}` }, s);
  assert.equal((await skill(s, sid, `mmo:${job}`, args)).stdout, "");
  await run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", agent_id: "orchestrator-1", tool_input: { command: `node "/p/scripts/mmo-log.mjs" --event=run.start --run-id=${runId} --project-root "${s.repo}"` } }, s);
  workflowLog(s, runId, ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "approved" }]);
}
const pipeline = (s, sid) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, "pipeline"), "utf8")); } catch { return null; } };
const endRun = (s, runId) => workflowLog(s, runId, ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);

test("a command the person typed and queued starts exactly as typed: no zero-touch models, no zero-touch checks, nothing stamped", { skip: SKIP ?? false }, async () => {
  // The queue remembers that a command was typed: otherwise it would start with zero-touch's tag and its policy
  // stamped on every call, and in a Hand-off chat be checked against a Flash policy the person never chose, and
  // refused without a Google login.
  for (const settings of [
    { mode: "workflows", workflows: { models: "opus-plus-sonnet" } },
    { mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "sonnet", tests: "sonnet", repeats: "chat" } },
  ]) {
    const s = sandbox(settings, { google: false });
    try {
      writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n# the project's own rules, which a typed command follows\n");
      await typedRun(s, "tq", "docs", "document the cart module", "docs-run");
      const asked = await run("prompt", { session_id: "tq", cwd: s.repo, prompt: "/mmo:test cover src/auth.js", prompt_id: `t-${++seq}` }, s);
      await answerQuestion(s, "tq", asked, "Queue it");
      await run("turn-end", { session_id: "tq", cwd: s.repo, stop_hook_active: false }, s);
      endRun(s, "docs-run");
      const next = await run("turn-end", { session_id: "tq", cwd: s.repo, stop_hook_active: false }, s);
      assert.match(queuedStart(next), /skill "mmo:test"/, `${settings.mode}: the queued command starts`);
      assert.match(queuedStart(next), /skill "mmo:test", args "cover src\/auth\.js"/, `${settings.mode}: exactly as typed`);
      assert.doesNotMatch(queuedStart(next), /\[zero-touch|chosen by zero-touch/, `${settings.mode}: no zero-touch tag`);
      assert.doesNotMatch(next.json.systemMessage ?? "", /Google/, `${settings.mode}: no zero-touch Google check`);
      assert.equal((await skill(s, "tq", "mmo:test", "cover src/auth.js")).stdout, "");
      assert.equal(pipeline(s, "tq")?.job, "test");
      assert.equal(pipeline(s, "tq")?.policy, undefined, `${settings.mode}: the typed run has no zero-touch policy`);
      assert.equal((await dispatch(s, "tq", "load_policy", { policy_name: "opus-plus-flash", project_root: s.repo })).stdout, "", `${settings.mode}: nothing stamped`);
    } finally { s.cleanup(); }
  }
});

test("a typed command after a plain-words start that never happened runs as typed: the stale start ends, nothing is stamped", { skip: SKIP ?? false }, async () => {
  // The person's words are routed, they stop Claude before it starts the workflow, then type the command themselves:
  // the typed run must not take the stale start over, with zero-touch's policy stamped.
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    assert.match(context(await say(s, "st", BUGFIX)), /"mmo:bugfix"/, "routed, never started");
    await run("prompt", { session_id: "st", cwd: s.repo, prompt: "/mmo:bugfix the login 500", prompt_id: `t-${++seq}` }, s);
    assert.equal((await skill(s, "st", "mmo:bugfix", "the login 500")).stdout, "", "the typed command runs");
    assert.equal(pipeline(s, "st")?.policy, undefined, "no zero-touch policy on the typed run");
    assert.equal((await dispatch(s, "st", "load_policy", { policy_name: "opus-plus-flash", project_root: s.repo })).stdout, "", "nothing stamped");
    // A typed command for ANOTHER job after such a start is not refused either.
    const t = sandbox({ mode: "workflows" });
    try {
      await say(t, "st2", BUGFIX);
      await run("prompt", { session_id: "st2", cwd: t.repo, prompt: "/mmo:docs document the cart module", prompt_id: `t-${++seq}` }, t);
      assert.equal((await skill(t, "st2", "mmo:docs", "document the cart module")).stdout, "", "the typed command for another job runs");
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("the line at a workflow's end says what happens next in this chat's mode", { skip: SKIP ?? false }, async () => {
  // A Hand-off chat is never told "asking for a job in your own words starts a new workflow", which Hand-off mode
  // never does.
  for (const [settings, line] of [
    [{ mode: "workflows" }, "Zero-touch: the documentation workflow has finished. From here, asking for another job starts a new workflow; anything else gets a normal answer."],
    [{ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" } }, "Zero-touch: the documentation workflow has finished. From here, Claude works in this chat in Hand-off mode again."],
  ]) {
    const s = sandbox(settings);
    try {
      await typedRun(s, "e1", "docs", "document the cart module", "docs-e1");
      endRun(s, "docs-e1");
      assert.equal((await run("turn-end", { session_id: "e1", cwd: s.repo, stop_hook_active: false }, s)).json?.systemMessage, line, settings.mode);
    } finally { s.cleanup(); }
  }
});

test("the run-start check of a run zero-touch started reads the person's policy file too; a typed run's check is left alone", { skip: SKIP ?? false }, async () => {
  // The orchestrator runs the check as a shell command, which the model-server stamp does not reach; if the model did
  // not pass the file on, a project's routing-policy.yaml would decide the check.
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    await startedBugfix(s, "rc");
    const path = join(POLICIES, "opus-plus-sonnet.yaml");
    const check = (command) => run("pre-any", { session_id: "rc", cwd: s.repo, tool_name: "Bash", agent_id: "orchestrator-1", tool_input: { command, description: "run-start check" } }, s);
    const plain = await check('node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"');
    // Claude Code has not said which model the chat is on: the file only, and the check judges the person's setting.
    assert.deepEqual(updated(plain), { command: `node "/p/scripts/driver-model-check.mjs" --policy-path "${path}" --project-root "$(pwd)"`, description: "run-start check" });
    // Anything but one plain call that names no file is left exactly as written (lib/run-check.mjs; its own test has
    // every case).
    assert.equal((await check('node /p/scripts/driver-model-check.mjs --project-root . --policy-path /tmp/theirs.yaml')).stdout, "", "a file the model named is kept, and nothing else to add");
    assert.equal((await check('sed -n 1,80p "/p/scripts/driver-model-check.mjs"')).stdout, "", "a command that only names the script: untouched");
    assert.equal((await check("npm test")).stdout, "", "any other command: untouched");
    // The chat's model known (zero-touch as a strict add-on): the helpers follow it, as mmo does without zero-touch,
    // so the check is told it, and allowed without a prompt as one of the workflow's own steps.
    writeFileSync(join(s.home, "sessions", "rc", "model_now"), "claude-opus-5");
    const told = await check('node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"');
    assert.equal(updated(told).command, `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node "/p/scripts/driver-model-check.mjs" --policy-path "${path}" --project-root "$(pwd)"`);
    // The person's own helper setting decides the helpers' model instead: the check reads that, and is told nothing.
    const own = await run("pre-any", { session_id: "rc", cwd: s.repo, tool_name: "Bash", agent_id: "orchestrator-1", tool_input: { command: 'node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"' } }, s, { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" });
    assert.equal(updated(own).command, `node "/p/scripts/driver-model-check.mjs" --policy-path "${path}" --project-root "$(pwd)"`);
    // End to end, with mmo's own real check script: the folder's own file names a judgment model the
    // helpers do not run on (the shipped Opus 4.7 policy), so on its own it stops the run; with the stamp, the
    // person's policy decides, and the chat's model must be the one it plans with.
    writeFileSync(join(s.repo, "routing-policy.yaml"), readFileSync(join(POLICIES, "opus-plus-flash.yaml"), "utf8"));
    const script = join(ROOT, "plugin", "scripts", "driver-model-check.mjs");
    const real = (extra, model) => spawnSync(process.execPath, [script, "--project-root", s.repo, ...extra], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: s.home, ...(model ? { CLAUDE_CODE_SUBAGENT_MODEL: model } : {}) } }).status;
    assert.notEqual(real([], "claude-opus-5"), 0, "unstamped, the folder's file decides and the check stops the run");
    assert.equal(real(["--policy-path", path], "claude-opus-5"), 0, "stamped, on the model the person's policy plans with: the check passes");
    assert.notEqual(real(["--policy-path", path], "claude-opus-5-5"), 0, "a chat on another model: the run's own check stops it");
    assert.notEqual(real(["--policy-path", path]), 0, "no model at all: stopped, as a typed run is");
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    await typedRun(t, "rt", "bugfix", "the login 500", "bf-typed");
    const r = await run("pre-any", { session_id: "rt", cwd: t.repo, tool_name: "Bash", tool_input: { command: 'node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"' } }, t);
    assert.equal(r.stdout, "", "a typed run's check follows its own rules");
  } finally { t.cleanup(); }
});

test("the same job queued from words, then typed by the person: it starts as typed", { skip: SKIP ?? false }, async () => {
  // The typed command is not a duplicate of the queued one, and never starts with zero-touch's models.
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    await typedRun(s, "dq", "docs", "document the cart module", "docs-dq");
    await say(s, "dq", TESTS); // queued at once from words (no box for plain words)
    await run("turn-end", { session_id: "dq", cwd: s.repo, stop_hook_active: false }, s);
    const typed = await run("prompt", { session_id: "dq", cwd: s.repo, prompt: `/mmo:test ${TESTS}`, prompt_id: `t-${++seq}` }, s);
    await answerQuestion(s, "dq", typed, "Queue it");
    await run("turn-end", { session_id: "dq", cwd: s.repo, stop_hook_active: false }, s);
    endRun(s, "docs-dq");
    const next = await run("turn-end", { session_id: "dq", cwd: s.repo, stop_hook_active: false }, s);
    assert.match(queuedStart(next), /skill "mmo:test", args "write unit tests for the pricing functions in src\/cart\.js"/, "exactly as typed");
    assert.doesNotMatch(queuedStart(next), /\[zero-touch/);
  } finally { s.cleanup(); }
});
