/**
 * Zero-touch routing, hand-off half, end to end through the real shell shim: a chat message the rules recognise
 * starts that job's /mmo: workflow; everything else, an unclear request included, stays an ordinary chat with nothing
 * added. Every case pipes the hook input Claude Code sends and reads the decision back. Facts the design rests on: a
 * command start, typed or model-started, is a PreToolUse on the Skill tool ({skill, args}); only a typed one fires
 * UserPromptExpansion; a PreToolUse deny stops it and the model reads the reason.
 *
 * Each test has its own MMO_HOME and project folder. No network, no model call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
// The workflows' model check needs the built server; see tools/test/lib/server-built.mjs.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

/** A project folder: "existing" has a manifest (greenfield.md's signal), "new" is empty. */
function sandbox(kind = "existing", settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-route-hooks-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") gitProject(repo), writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on", ...settings }));
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = {
      // No CLAUDE_CODE_SUBAGENT_MODEL: every scenario here runs as a person with nothing set would. The workflows'
      // helpers then follow the chat's model, as mmo's do without zero-touch, and a chat whose model Claude Code has
      // not named yet is checked again later (the chat-model test below).
      PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo,
      ...env,
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
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

// Every chat these tests drive starts the way a real one does (tools/test/lib/chat-start.mjs).
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });

const prompt = (s, sid, text, env) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}` }, s, env);
/** A Skill call as Claude Code makes it: PreToolUse, then, when the call was not refused, PostToolUse (the moment a
 * routed workflow's start is recorded). Returns the PreToolUse answer. */
const skill = async (s, sid, name, args, ...rest) => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } };
  const pre = await run("pre-skill", input, s, ...rest);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s, ...rest);
  return pre;
};
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === "deny";
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const pipeline = (s, sid) => existsSync(join(s.home, "sessions", sid, "pipeline"));
const projectPolicy = (s) => { try { return JSON.parse(readFileSync(join(s.repo, ".sdlc", "project.json"), "utf8")).default_policy; } catch { return null; } };

// Routing works like the person typing the command, whenever the chat is idle. Two facts the hook
// reads, both written before the prompt hook runs: Claude Code's transcript records a message typed while Claude is
// still working as a "queued_command" attachment (a normal message is an ordinary user entry), and a workflow's own
// log (plugin/scripts/lib/log.mjs lines in <project>/.sdlc/runs/<run-id>/orchestrator.log) records its gates and end.
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
function transcript(s, sid, entries) {
  const path = join(s.dir, `${sid}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}
const said = (text) => ({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
const queued = (text) => ({ type: "attachment", attachment: { type: "queued_command", prompt: text, origin: { kind: "human" }, humanTurn: true } });
const interrupted = () => ({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
const promptIn = (s, sid, text, path) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}`, transcript_path: path }, s);
/** Appends lines to a workflow run's log exactly as mmo-log.mjs writes them. */
function workflowLog(s, runId, ...lines) {
  const dir = join(s.repo, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of lines) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}
const JOB = "fix the /login endpoint returning 500 on missing password";

test("a clear job starts its workflow: Opus is told which one, in plain words for the person, and nothing else may run first", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const r = await prompt(s, "c1", "fix the /login endpoint returning 500 on missing password");
    assert.equal(r.json?.hookSpecificOutput?.hookEventName, "UserPromptSubmit", r.stdout);
    const c = context(r);
    assert.match(c, /Skill tool/);
    assert.match(c, /"mmo:bugfix"/);
    assert.match(c, /fix the \/login endpoint returning 500 on missing password/, "the message goes to the workflow as its description");
    assert.match(c, /args "\[zero-touch policy=opus-plus-flash-v38 auth=estimated\] fix the \/login endpoint/, "the person's models travel in the start arguments");
    assert.match(c, /Running this as a full bug-fix workflow\./, "the one plain line the person sees");
    assert.match(c, /estimated/, "the cost-recording mode is chosen, so the person is not asked");
    assert.match(c, /Keep the plugin, command names and model names out of what you say to the person/);
    assert.doesNotMatch(c, /ToolSearch/, "the instruction alone: nothing else is added to the message");
    // Guard A (the catch-all pre-any hook): until the workflow starts, nothing that changes files or starts a helper may run.
    const write = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s);
    // The person reads one plain sentence (Claude Code shows a refusal's reason to them); the model's instruction
    // travels as the refusal's additionalContext.
    assert.ok(denied(write) && /Start the workflow first/.test(context(write)), write.stdout);
    assert.equal(reason(write), "Zero-touch: Claude starts the bug-fix workflow first.");
    const bash = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" } }, s);
    assert.ok(denied(bash), bash.stdout);
    const agent = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "x" } }, s);
    assert.ok(denied(agent), agent.stdout);
    // Guard B: only the routed workflow may start.
    assert.ok(denied(await skill(s, "c1", "mmo:refactor", "x")), "another workflow is refused");
    const start = await skill(s, "c1", "mmo:bugfix", "fix the /login endpoint returning 500 on missing password");
    assert.equal(start.stdout, "", "the routed workflow starts");
    assert.ok(pipeline(s, "c1"), "from here the chat is a workflow run: zero-touch stands down");
    assert.equal(projectPolicy(s), null, "nothing is written into the project: the run's models travel in its start arguments");
    assert.equal((await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "b.js"), content: "x" } }, s)).stdout, "", "Guard A ends when the workflow starts");
  } finally { s.cleanup(); }
});

test("a new app in an empty folder starts the new-app workflow with only the zero-touch tag; the project's saved choice is neither used nor changed", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    mkdirSync(join(s.repo, ".sdlc"));
    writeFileSync(join(s.repo, ".sdlc", "project.json"), JSON.stringify({ schema_version: 2, default_policy: "opus-plus-sonnet" }));
    const c = context(await prompt(s, "g1", "build me a todo app with a React frontend and a Node backend"));
    assert.match(c, /"mmo:greenfield"/);
    assert.match(c, /Running this as a full new-app build\./);
    assert.match(c, /args "\[zero-touch policy=opus-plus-flash-v38 auth=estimated\]"/, "the new-app command gets the tag and nothing else; the person's pick, not the folder's saved choice");
    assert.equal((await skill(s, "g1", "mmo:greenfield", "[zero-touch policy=opus-plus-flash-v38 auth=estimated]")).stdout, "");
    assert.equal(projectPolicy(s), "opus-plus-sonnet", "the project's own file is left exactly as it was");
  } finally { s.cleanup(); }
});

test("a typed command is never touched: it starts as mmo does without zero-touch, and nothing is routed around it", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.equal((await run("prompt-expansion", { session_id: "t1", cwd: s.repo, command_name: "mmo:refactor", expansion_type: "slash_command" }, s)).stdout, "");
    assert.equal(context(await prompt(s, "t1", "/mmo:refactor extract the date helpers")), "", "no route, no note");
    assert.equal((await skill(s, "t1", "mmo:refactor", "extract the date helpers")).stdout, "", "a typed command runs as a Skill call, and it is allowed");
    assert.equal((await run("pre-any", { session_id: "t1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

// ─── Requests the rules cannot place ───

test("a request the rules cannot place is Claude's to judge; its start is checked, and the run's tag is zero-touch's", { skip: SKIP ?? false }, async () => {
  // Model-judged recognition (lib/route-flow.mjs judgeable).
  const s = sandbox("existing");
  try {
    const judged = await prompt(s, "a1", "teh logn page 500s sort it out");
    assert.doesNotMatch(context(judged), /"mmo:bugfix", args/, "the rules did not place it");
    assert.match(context(judged), /you judge whether it asks for one of the jobs/);
    assert.match(context(judged), /"mmo:bugfix": fix something broken/);
    assert.doesNotMatch(context(judged), /"mmo:greenfield"/, "a new app is not a job in a project");
    assert.equal(judged.json?.systemMessage, undefined, "the person is told nothing: Claude answers or starts");
    const tried = await skill(s, "a1", "mmo:bugfix", "the login page returns 500");
    assert.ok(!denied(tried), "Claude's start passes zero-touch's checks");
    assert.equal(tried.json?.hookSpecificOutput?.updatedInput?.args, "[zero-touch policy=opus-plus-flash-v38 auth=estimated] the login page returns 500", "the tag is zero-touch's, never Claude's copy");
    // The command ran (the helper sends PostToolUse too): the workflow is recorded as started, as a recognised one is.
    assert.ok(pipeline(s, "a1"), "the judged workflow is running");
    assert.match(readFileSync(join(s.home, "sessions", "a1", "events.jsonl"), "utf8"), /"type":"route.decided","job":"bugfix","via":"judge"/);
  } finally { s.cleanup(); }
});

test("Claude's judgement is checked: a job the folder does not allow, no judgement at all, a question, a reply, or a later turn start nothing", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "b1", "teh logn page 500s sort it out");
    const wrongFolder = await skill(s, "b1", "mmo:greenfield", "");
    assert.ok(denied(wrongFolder), "a new app in a project folder is refused");
    assert.equal(reason(wrongFolder), "Zero-touch: a full workflow starts only for a request zero-touch recognises, so Claude carries on in the chat.");
    assert.ok(!existsSync(join(s.home, "sessions", "b1", "route.json")), "and the judgement is used up");
    for (const text of ["how do I fix the login bug?", "yes", "ok go ahead", "fix it"]) {
      const r = await prompt(s, "b2", text);
      assert.doesNotMatch(context(r), /you judge whether/, `${text}: never Claude's to judge`);
      assert.ok(denied(await skill(s, "b2", "mmo:bugfix", "x")), `${text}: Claude may not start one on its own`);
    }
    await prompt(s, "b3", "teh logn page 500s sort it out");
    await run("turn-end", { session_id: "b3", cwd: s.repo }, s);
    assert.ok(!existsSync(join(s.home, "sessions", "b3", "route.json")), "answered without a start: the judgement ends with the turn");
    assert.ok(denied(await skill(s, "b3", "mmo:bugfix", "x")), "a later start is refused");
    assert.ok(!pipeline(s, "b1") && !pipeline(s, "b2") && !pipeline(s, "b3"));
  } finally { s.cleanup(); }
});

test("in an empty folder only a new app can be judged, and it takes no words but the tag", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    const judged = await prompt(s, "c1", "my bakery needs something online where people can order cakes");
    assert.match(context(judged), /"mmo:greenfield": build a whole new app/);
    assert.doesNotMatch(context(judged), /"mmo:bugfix"/);
    const tried = await skill(s, "c1", "mmo:greenfield", "[zero-touch policy=opus-plus-flash-v38 auth=estimated]");
    assert.ok(!denied(tried));
    assert.equal(tried.stdout, "", "Claude's args were already zero-touch's tag: nothing to change");
  } finally { s.cleanup(); }
});

test("a routing_unsure setting is ignored: auto starts nothing", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing_unsure: "auto" });
  try {
    // The setting changes nothing (such a message is Claude's to judge, with or without it): no start is made for
    // Claude, and nothing is written to the project.
    const r = await prompt(s, "u1", "teh logn page 500s sort it out");
    assert.doesNotMatch(context(r), /Start it now with the Skill tool/);
    assert.match(context(r), /you judge whether it asks/);
    assert.equal(JSON.parse(readFileSync(join(s.home, "sessions", "u1", "route.json"), "utf8")).status, "judge");
    assert.ok(!pipeline(s, "u1"));
    assert.equal(projectPolicy(s), null, "nothing was written");
  } finally { s.cleanup(); }
});

test("workflows off: nothing is routed and Opus may not start one; the person is told why once", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing: "off" });
  try {
    const r = await prompt(s, "o1", "fix the /login endpoint returning 500 on missing password");
    assert.doesNotMatch(context(r), /"mmo:bugfix"/, "no start instruction");
    // Not silent: a person who asked for a job learns why no workflow started.
    assert.equal(r.json?.systemMessage, "Zero-touch: the bug-fix workflow didn't start, because workflows from plain words are switched off by a zero-touch setting file on this computer, so Claude answers it normally.");
    assert.equal((await prompt(s, "o1", "fix the /login endpoint returning 500 on missing password")).stdout, "", "said once per chat");
    assert.equal((await prompt(s, "o1", "thanks")).stdout, "", "ordinary chat: nothing");
    assert.ok(denied(await skill(s, "o1", "mmo:bugfix", "x")));
  } finally { s.cleanup(); }
});

test("a project folder can switch workflows off, never on", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    mkdirSync(join(s.repo, ".sdlc"));
    writeFileSync(join(s.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "off" }));
    const r = await prompt(s, "p2", "fix the /login endpoint returning 500 on missing password");
    assert.doesNotMatch(context(r), /"mmo:bugfix"/);
    assert.match(r.json?.systemMessage ?? "", /switched off for this project by a setting file in it/);
  } finally { s.cleanup(); }
  const t = sandbox("existing", { routing: "off" });
  try {
    mkdirSync(join(t.repo, ".sdlc"));
    writeFileSync(join(t.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "on" }));
    assert.doesNotMatch(context(await prompt(t, "p3", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/, "a folder cannot switch workflows on");
  } finally { t.cleanup(); }
});

test("work done earlier in the chat does not hold a job back: once Claude is idle, a clear job starts its workflow, as typing the command would", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "w1", "hi");
    await run("post-write", { session_id: "w1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "notes.md"), content: "x" }, tool_response: { type: "create" } }, s);
    writeFileSync(join(s.repo, "edited-by-hand.js"), "x"); // the project changed during the chat
    assert.match(context(await prompt(s, "w1", JOB)), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
});

test("a message typed while Claude is still working joins the running task: no workflow starts, and a pending start is not dropped", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const t = transcript(s, "b1", [said("read every file and explain each one"), queued(JOB)]);
    const r = await promptIn(s, "b1", JOB, t);
    assert.doesNotMatch(context(r), /"mmo:bugfix"/, "sent while busy: part of the running task");
    const events = readFileSync(join(s.home, "sessions", "b1", "events.jsonl"), "utf8");
    assert.match(events, /"type":"route\.none".*while Claude was working/, "the log says why");
    assert.ok(!pipeline(s, "b1"));
    // The same words sent when Claude is idle (an ordinary message in the transcript) start the workflow.
    const idle = transcript(s, "b1", [said("read every file and explain each one"), said(JOB)]);
    assert.match(context(await promptIn(s, "b1", JOB, idle)), /"mmo:bugfix"/);
    // A route pending in a running task is not dropped by a message queued into that task.
    const t2 = transcript(s, "b1", [said(JOB), queued("also look at the tests")]);
    await promptIn(s, "b1", "also look at the tests", t2);
    assert.ok(denied(await run("pre-any", { session_id: "b1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)), "the workflow still has to start first");
  } finally { s.cleanup(); }
});

test("after Esc the next message is an ordinary one: a clear job starts its workflow", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const t = transcript(s, "e1", [said("read every file and explain each one"), interrupted(), said(JOB)]);
    assert.match(context(await promptIn(s, "e1", JOB, t)), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
});

test("while a workflow runs zero-touch is quiet; once its own log shows the last gate answered, jobs start again", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "g1", JOB);
    assert.equal((await skill(s, "g1", "mmo:bugfix", JOB)).stdout, "");
    assert.ok(pipeline(s, "g1"));
    const NEXT = "write unit tests for the pricing functions in src/cart.js";
    workflowLog(s, "bf-1", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0", title: "scope" }]);
    assert.doesNotMatch(context(await prompt(s, "g1", NEXT)), /"mmo:test"/, "gate 0 open: the reply belongs to the workflow");
    workflowLog(s, "bf-1", ["gate.resolved", { gate: "gate-0", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4", title: "final-acceptance" }]);
    assert.doesNotMatch(context(await prompt(s, "g1", NEXT)), /"mmo:test"/, "the run logged its end but its final gate is still open");
    workflowLog(s, "bf-1", ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.match(context(await prompt(s, "g1", NEXT)), /"mmo:test"/, "the workflow is over: the next job starts its own");
    assert.ok(!pipeline(s, "g1"), "the ended workflow no longer marks the chat; the new route is pending until its command starts");
    const events = readFileSync(join(s.home, "sessions", "g1", "events.jsonl"), "utf8");
    assert.match(events, /"type":"session\.pipeline_ended"/);
    // A non-job message after a finished workflow is an ordinary one: nothing is added.
    const t = sandbox("existing");
    try {
      await prompt(t, "g2", JOB);
      await skill(t, "g2", "mmo:bugfix", JOB);
      workflowLog(t, "bf-2", ["run.start", {}], ["gate.open", { gate: "gate-1" }], ["gate.resolved", { gate: "gate-1", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
      const r = await prompt(t, "g2", "what does the pricing module do?");
      assert.equal(context(r), "", "an ordinary message after the workflow gets nothing added for the model");
      assert.equal(r.stdout, "", "and nothing is shown: a question is ordinary chat (quiet by default)");
      assert.ok(!pipeline(t, "g2"), "the chat is back to ordinary");
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("an abort at any gate ends the workflow; a typed command's run ends the same way", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "a1", JOB);
    await skill(s, "a1", "mmo:bugfix", JOB);
    workflowLog(s, "bf-a", ["run.start", {}], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "abort" }]);
    assert.match(context(await prompt(s, "a1", "write unit tests for the pricing functions in src/cart.js")), /"mmo:test"/);
    // The typed line itself (the prompt hook alone decides a typed command; the expansion hook is not zero-touch's).
    await prompt(s, "a2", "/mmo:refactor extract the date helpers");
    assert.ok(pipeline(s, "a2"));
    workflowLog(s, "rf-1", ["run.start", {}], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.match(context(await prompt(s, "a2", JOB)), /"mmo:bugfix"/, "after a typed run has ended, routing works in that chat too");
  } finally { s.cleanup(); }
});

test("a workflow stopped before its run began keeps the chat quiet, and a run that ended before this chat's workflow started does not count", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    workflowLog(s, "old-1", ["run.start", {}], ["gate.open", { gate: "gate-1" }], ["gate.resolved", { gate: "gate-1", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    await new Promise((r) => setTimeout(r, 20));
    await prompt(s, "n1", JOB);
    await skill(s, "n1", "mmo:bugfix", JOB);
    assert.doesNotMatch(context(await prompt(s, "n1", "write unit tests for the pricing functions in src/cart.js")), /"mmo:test"/,
      "no run of this chat's workflow was logged: its early questions may still be waiting, so the reply belongs to it");
  } finally { s.cleanup(); }
});

test("a route not taken ends with its prompt: the next message is judged afresh and nothing stays blocked", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.match(context(await prompt(s, "s1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    await prompt(s, "s1", "actually, what does the login controller do?");
    assert.equal((await run("pre-any", { session_id: "s1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
    assert.ok(denied(await skill(s, "s1", "mmo:bugfix", "x")), "the old route is gone");
  } finally { s.cleanup(); }
});

test("with no helper setting at all, a clear job starts: nothing needs setting up first", { skip: SKIP ?? false }, async () => {
  // The workflows' helpers follow the chat's model, so a person with nothing set starts at once: no one-time setting
  // and no new chat are asked for.
  const s = sandbox("existing");
  try {
    const c = context(await prompt(s, "m1", "fix the /login endpoint returning 500 on missing password"));
    assert.match(c, /"mmo:bugfix"/, "nothing set, the chat's model not named yet: it starts, and is checked again later");
    assert.doesNotMatch(c, /one-time setting|--apply=routing|new chat/);
  } finally { s.cleanup(); }
});

test("the workflows' helpers follow the chat's model: a chat on another model than the person's models plan with does not start one, and is told how to switch", { skip: SKIP ?? false }, async () => {
  // mmo's helper agents name no model, so with no helper setting Claude Code runs them on the chat's model, and the
  // workflow's own check needs the policy's planning model.
  const start = (s, sid, model, env) => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", ...(model ? { model } : {}) }, s, env);
  const wrong = sandbox("existing");
  try {
    await start(wrong, "w1", "claude-opus-5-5[1m]");
    const r = await prompt(wrong, "w1", JOB);
    assert.doesNotMatch(context(r), /"mmo:bugfix"/);
    // Says why, naming the models chosen.
    assert.equal(r.json?.systemMessage, "Zero-touch: the bug-fix workflow didn't start, because this chat is on Opus 5.5, but you chose Opus 5 + Flash 3.8, where Opus 5 plans and reviews, and that part runs on this chat's own model. Switch this chat to Opus 5 with the model menu next to the message box (in the terminal, type /model claude-opus-5), then ask again.");
    assert.match(context(r), /helpers run on the chat's own model, claude-opus-5-5/);
    assert.match(context(r), /Do not do the job yourself now and do not start the workflow yourself/);
    // The person switches: Claude Code reports it (PostModelSwitch), and the next ask starts.
    await run("post-model-switch", { session_id: "w1", cwd: wrong.repo, from_model: "claude-opus-5-5", to_model: "claude-opus-5" }, wrong);
    assert.match(context(await prompt(wrong, "w1", JOB)), /"mmo:bugfix"/);
  } finally { wrong.cleanup(); }
  const right = sandbox("existing");
  try {
    await start(right, "w2", "claude-opus-5");
    assert.match(context(await prompt(right, "w2", JOB)), /"mmo:bugfix"/, "on the planning model: it starts");
  } finally { right.cleanup(); }
  // The person's own helper setting decides the helpers' model instead of the chat: then it is the setting that must
  // match, and the chat may be on any model.
  const setting = sandbox("existing");
  try {
    await start(setting, "w3", "claude-opus-5-5", { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" });
    assert.match(context(await prompt(setting, "w3", JOB, { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" })), /"mmo:bugfix"/, "the setting matches: the chat's own model does not matter");
    const r = await prompt(setting, "w3", JOB, { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.doesNotMatch(context(r), /"mmo:bugfix"/);
    assert.equal(r.json?.systemMessage, `Zero-touch: the bug-fix workflow didn't start, because a setting on this computer makes workflow helpers run on Opus 4.8, but you chose Opus 5 + Flash 3.8, where Opus 5 plans and reviews. Ask Claude to help you change that setting.`);
    assert.match(context(r), /CLAUDE_CODE_SUBAGENT_MODEL setting/, "Claude is told which setting");
    assert.doesNotMatch(r.json?.systemMessage ?? "", /CLAUDE_CODE|settings\.json/, "the person never reads a variable name or a file path");
  } finally { setting.cleanup(); }
  // A new chat's first message can come before Claude Code names the chat's model: the start goes ahead, and the chat's
  // model is checked again at the workflow's own command, by when the chat has answered (its transcript says).
  const late = sandbox("existing");
  try {
    const path = transcript(late, "w4", [said(JOB)]);
    const r = await promptIn(late, "w4", JOB, path);
    assert.match(context(r), /"mmo:bugfix"/);
    appendFileSync(path, JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Running this as a full bug-fix workflow." }] } }) + "\n");
    const call = await run("pre-skill", { session_id: "w4", cwd: late.repo, tool_name: "Skill", transcript_path: path, tool_input: { skill: "mmo:bugfix", args: "x" } }, late);
    assert.ok(denied(call), "refused before anything runs");
    assert.match(reason(call), /^Zero-touch: the bug-fix workflow didn't start, because this chat is on Opus 5\.5, but you chose Opus 5 \+ Flash 3\.8, where Opus 5 plans and reviews/);
    assert.ok(!pipeline(late, "w4"), "no workflow is marked as running");
    const write = () => run("pre-any", { session_id: "w4", cwd: late.repo, tool_name: "Write", tool_input: { file_path: join(late.repo, "a.js"), content: "x" } }, late);
    assert.match(reason(await write()), /^Zero-touch: the bug-fix workflow didn't start, because this chat is on Opus 5\.5/, "the job is not done by hand in that turn");
    await run("turn-end", { session_id: "w4", cwd: late.repo, transcript_path: path }, late);
    assert.equal((await write()).stdout, "", "the start it was waiting for is dropped at the turn's end: nothing stays blocked");
  } finally { late.cleanup(); }
});

test("while a workflow zero-touch started runs, the chat stays on the model its helpers follow; a typed run and other chats are left alone", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await run("session-start", { session_id: "l1", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    await prompt(s, "l1", JOB);
    assert.equal((await skill(s, "l1", "mmo:bugfix", "x")).stdout, "");
    const away = await run("pre-model-switch", { session_id: "l1", cwd: s.repo, from_model: "claude-opus-5", to_model: "claude-opus-5-5" }, s);
    assert.equal(away.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(away.json.hookSpecificOutput.permissionDecisionReason, "Zero-touch: this chat stays on Opus 5 until the bug-fix workflow ends, because the workflow's helpers use this chat's model. You can switch once it has finished.");
    assert.equal((await run("pre-model-switch", { session_id: "l1", cwd: s.repo, from_model: "claude-opus-5", to_model: "claude-opus-5" }, s)).stdout, "", "to the same model: allowed");
    assert.equal((await run("pre-model-switch", { session_id: "l1", cwd: s.repo, from_model: "claude-opus-5", to_model: "claude-opus-5-5" }, s, { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" })).stdout, "", "the person's own helper setting decides the helpers: no lock");
  } finally { s.cleanup(); }
  const idle = sandbox("existing");
  try {
    await prompt(idle, "l2", "hello");
    assert.equal((await run("pre-model-switch", { session_id: "l2", cwd: idle.repo, from_model: "claude-opus-5", to_model: "claude-opus-5-5" }, idle)).stdout, "", "no workflow running: the chat switches freely");
  } finally { idle.cleanup(); }
});

test("setup, policy, revert, pass and the generic brownfield command are never started by the model", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "n1", "hello");
    for (const name of ["mmo:setup", "mmo:policy", "mmo:revert", "mmo:pass", "mmo:brownfield"]) {
      assert.ok(denied(await skill(s, "n1", name)), name);
    }
    assert.equal((await skill(s, "n1", "some-other-plugin:thing")).stdout, "", "other plugins' skills are not ours to judge");
  } finally { s.cleanup(); }
});

test("a workflow that cannot start says the real cause and the fix that works for it; a project's saved choice does not decide", { skip: SKIP ?? false }, async () => {
  // Zero-touch runs the person's own pick: a project's saved choice (here an Opus 4.7 policy) and a saved file that
  // cannot be read are not read at all.
  const other = sandbox("existing");
  try {
    mkdirSync(join(other.repo, ".sdlc"));
    writeFileSync(join(other.repo, ".sdlc", "project.json"), JSON.stringify({ schema_version: 2, default_policy: "opus-plus-flash" }));
    const c = context(await prompt(other, "k2", "fix the /login endpoint returning 500 on missing password"));
    assert.match(c, /"mmo:bugfix", args "\[zero-touch policy=opus-plus-flash-v38 auth=estimated\]/, "the person's pick starts, whatever the folder saved");
  } finally { other.cleanup(); }
  const broken = sandbox("existing");
  try {
    mkdirSync(join(broken.repo, ".sdlc"));
    writeFileSync(join(broken.repo, ".sdlc", "project.json"), "{not json");
    assert.match(context(await prompt(broken, "k3", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/, "a saved file that cannot be read is not read at all");
  } finally { broken.cleanup(); }
  // No Google login, and the person's models use Flash: the workflow does not start, and both are told why.
  const google = sandbox("existing");
  try {
    const r = await prompt(google, "k6", "fix the /login endpoint returning 500 on missing password");
    rmSync(join(google.home, ".config"), { recursive: true, force: true });
    const g = await prompt(google, "k6", "fix the /login endpoint returning 500 on missing password");
    assert.match(context(r), /"mmo:bugfix"/, "with a login it starts");
    assert.doesNotMatch(context(g), /"mmo:bugfix"/);
    assert.match(context(g), /not connected to Google/);
    assert.match(g.json?.systemMessage ?? "", /because your models include Google's Flash 3\.8 and this computer isn't connected to Google/);
  } finally { google.cleanup(); }
  const vendor = sandbox("existing", { routing_defaults: { auth: "vendor" } });
  try {
    const c = context(await prompt(vendor, "k4", "fix the /login endpoint returning 500 on missing password"));
    assert.match(c, /"mmo:bugfix"/, "under vendor the workflow skips its helpers'-model check, so routing does too");
    assert.match(c, /auth=vendor\]/);
  } finally { vendor.cleanup(); }
});

test("a folder inside another project: the job starts with the person's pick, and nothing is written into either project", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    execFileSync("git", ["init", "-q"], { cwd: s.repo });
    writeFileSync(join(s.repo, "notes.txt"), "x");
    execFileSync("git", ["add", "notes.txt"], { cwd: s.repo });
    const app = join(s.repo, "app");
    mkdirSync(app);
    const inner = { home: s.home, repo: app };
    const c = context(await run("prompt", { session_id: "e1", cwd: app, prompt: "build me a todo app with a React frontend" }, inner));
    assert.match(c, /"mmo:greenfield"/, "zero-touch writes no saved choice any more, so there is nothing to put in the wrong project");
    assert.ok(!existsSync(join(s.repo, ".sdlc")) && !existsSync(join(app, ".sdlc")), "nothing written anywhere");
  } finally { s.cleanup(); }
});

test("a start is confirmed after the command ran even if the start hook never finished: the workflow is never left blocked", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "q1", "fix the /login endpoint returning 500 on missing password");
    // pre-skill timed out (Claude Code lets the call run); only the after-hook sees the command start.
    await run("post-skill", { session_id: "q1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: "x" }, tool_response: { success: true } }, s);
    assert.ok(pipeline(s, "q1"));
    // The workflow's own agent runs, exactly as launched: mmo's own helper, as mmo runs it without zero-touch.
    const launched = await run("pre-agent", { session_id: "q1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "mmo:orchestrator", prompt: "x" } }, s);
    assert.equal(launched.stdout, "", "the workflow's own agent runs, unchanged");
    assert.equal((await run("pre-any", { session_id: "q1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

test("Guard A covers every tool that can change something, helpers included; tools that change nothing still run", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "h1", "fix the /login endpoint returning 500 on missing password");
    const any = (payload) => run("pre-any", { session_id: "h1", cwd: s.repo, ...payload }, s);
    for (const tool_name of ["Write", "Edit", "Bash", "NotebookEdit", "Agent", "mcp__github__create_or_update_file", "mcp__plugin_mmo_model-dispatch__execute_stage"]) {
      assert.ok(denied(await any({ tool_name, tool_input: {} })), `${tool_name} while the workflow waits to start`);
    }
    assert.ok(denied(await any({ tool_name: "Write", agent_id: "helper-1", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } })), "a helper that was already running too");
    for (const tool_name of ["Read", "Glob", "Grep", "ToolSearch", "TodoWrite", "Skill"]) {
      assert.equal((await any({ tool_name, tool_input: {} })).stdout, "", `${tool_name} changes nothing`);
    }
    // Guard B: a helper cannot start the workflow for the chat, and a leading slash is the same command.
    assert.ok(denied(await run("pre-skill", { session_id: "h1", cwd: s.repo, agent_id: "helper-1", tool_name: "Skill", tool_input: { skill: "mmo:bugfix" } }, s)));
    assert.ok(!pipeline(s, "h1"));
    assert.ok(denied(await skill(s, "h1", "/mmo:refactor", "x")), "/mmo:refactor is mmo:refactor");
    assert.equal((await skill(s, "h1", "/mmo:bugfix", "x")).stdout, "", "and /mmo:bugfix starts the routed workflow");
    assert.ok(pipeline(s, "h1"));
  } finally { s.cleanup(); }
});

test("the chat's own starts are refused in any folder, even where the job would fit", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "f1", "hello");
    assert.ok(denied(await skill(s, "f1", "mmo:bugfix", "x")), "a project job in a project: still not the chat's call");
    assert.ok(denied(await skill(s, "f1", "mmo:greenfield")), "a new-app build in a project");
    assert.ok(!pipeline(s, "f1"));
  } finally { s.cleanup(); }
  const n = sandbox("new");
  try {
    await prompt(n, "f2", "hello");
    assert.ok(denied(await skill(n, "f2", "mmo:greenfield")), "a new-app build in an empty folder: still not the chat's call");
    assert.ok(!pipeline(n, "f2"));
  } finally { n.cleanup(); }
});

test("there is no offer machinery: nothing asks, keeps or accepts an offer", async () => {
  const flow = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  for (const name of ["isPlainYes", "askReason", "declinedInstruction", "readOffer", "writeOffer", "dropOffer"]) {
    assert.equal(flow[name], undefined, name);
  }
  const { ROUTING_UNSURE } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "config.mjs"));
  assert.equal(ROUTING_UNSURE, undefined, "no routing_unsure switch");
});

test("a typed command without the plugin's prefix is still a typed run: zero-touch stands down, nothing is routed or noted", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.equal(context(await prompt(s, "sf1", "/bugfix the login page returns 500")), "");
    assert.ok(pipeline(s, "sf1"));
    // Its own project: one workflow at a time in one project (lib/project-lock.mjs).
    const t = sandbox("existing");
    try {
      assert.equal(context(await prompt(t, "sf2", "/refactor extract the date helpers")), "", "the typed line alone is enough");
      assert.ok(pipeline(t, "sf2"));
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("/clear starts a fresh conversation: an earlier run, route or started work no longer counts", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await run("prompt-expansion", { session_id: "cl1", cwd: s.repo, command_name: "mmo:refactor", expansion_type: "slash_command" }, s);
    await run("post-write", { session_id: "cl1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" }, tool_response: { type: "create" } }, s);
    await run("session-start", { session_id: "cl1", cwd: s.repo, source: "clear" }, s);
    assert.ok(!pipeline(s, "cl1"));
    assert.match(context(await prompt(s, "cl1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
});

test("what the person can see never names the plugin, a command, a settings path or a model the chat is not already on", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const shim = readFileSync(SHIM, "utf8");
    assert.doesNotMatch(shim.match(/systemMessage[^}]*/)?.[0] ?? "", /mmo|ambient/i, "the start-up line when Node.js is missing");
    // The instruction Opus gets tells it the one plain line to say, and carries the wording rule.
    const c = context(await prompt(s, "pn1", JOB));
    const line = /tell the person this one plain line: "([^"]+)"/.exec(c)?.[1] ?? "";
    assert.ok(line.length > 0, c);
    assert.doesNotMatch(line, /mmo|ambient|\.json|claude-|\/[a-z]/i, "the line the person hears names no plugin, command, file or model");
    assert.match(c, /Keep the plugin, command names and model names out of what you say to the person/);
  } finally { s.cleanup(); }
});

test("every start Claude is told to make says the person chose a full workflow, small jobs included", async () => {
  // Told to start a workflow for a small job, Claude must not question its size or offer to do the job in the chat.
  const F = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  const Q = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "queue.mjs"));
  const texts = [
    F.startInstruction({ job: "greenfield", args: "", auth: "estimated", policy: "opus-plus-flash-v38" }),
    F.startInstruction({ job: "bugfix", args: "fix x", auth: "estimated", policy: "opus-plus-flash-v38" }),
    F.judgeInstruction({ folder: "existing", auth: "estimated", policy: "opus-plus-flash-v38" }),
    Q.queuedStartInstruction({ job: "docs", args: "write a README" }, { auth: "estimated", policy: "opus-plus-flash-v38" }),
  ];
  for (const t of texts) {
    assert.ok(t.includes(F.CHOSEN_FULL), t.slice(0, 80));
    assert.match(t, /do not question its size, cost or need, and do not offer to do the job in the chat instead/);
  }
  // A command the person typed and queued keeps its own questions: nothing is said for them.
  assert.ok(!Q.queuedStartInstruction({ job: "docs", args: "" }, {}).includes(F.CHOSEN_FULL));
});
