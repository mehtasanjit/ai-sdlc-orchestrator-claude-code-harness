/**
 * The outcome contract. Zero-touch cannot start a workflow itself: a hook on the person's message can only add a
 * note, set the title, or block it, so every start is Claude choosing to call the workflow. Instead of patching each
 * way Claude strays, every message in a Workflows chat must end in exactly one of:
 *   A  the workflow starts, with the person's models;
 *   B  Claude answers normally;
 *   C  one clear line says why nothing started, and what to do.
 * This file is the table: what zero-touch decided about a message (rows) × what Claude then does (columns), each cell
 * driven through the real hook with no model call. Hand-off's rows are in zero-touch-handoff-net.test.mjs (a new file
 * set to hand off is refused every time until handed off; "write it yourself" lets it through; an existing file is
 * Claude's own edit), and a message while a workflow runs is in ambient-routing-hooks.test.mjs (Queue it / Replace it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const F = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

function sandbox(kind = "existing") {
  const dir = mkdtempSync(join(tmpdir(), "zt-outcomes-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") gitProject(repo), writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on" }));
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => { let json = null; try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ } done({ stdout, json }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
const prompt = (s, sid, text) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}` }, s);
const skill = async (s, sid, name, args = "x") => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, args } };
  const pre = await run("pre-skill", input, s);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s);
  return pre;
};
const write = (s, sid, file) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, file), content: "x\n" } }, s);
const turnEnd = (s, sid, active = false) => run("turn-end", { session_id: sid, cwd: s.repo, ...(active ? { stop_hook_active: true } : {}) }, s);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const line = (r) => r.json?.systemMessage ?? null;
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === "deny";
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const started = (s, sid) => existsSync(join(s.home, "sessions", sid, "pipeline"));
const route = (s, sid) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, "route.json"), "utf8")); } catch { return null; } };
const carried = (s, sid) => existsSync(join(s.home, "sessions", sid, "zt_carry"));

const JOB = "fix the /login endpoint returning 500 on missing password";
const JUDGED = "teh logn page 500s sort it out";
const CHAT = "what does the cart total function return when the cart is empty?";
const NOT_NOW = "Zero-touch: a full workflow starts only for a request zero-touch recognises, so Claude carries on in the chat.";

// ─── Row 1: a job the rules recognise ────────────────────────────────────────────────────────────────────────────────

test("recognised job × Claude calls the right workflow → A", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const r = await prompt(s, "r1a", JOB);
    assert.match(line(r), /^Zero-touch: you asked for a bug fix, so Claude is starting the bug-fix workflow\./);
    assert.ok(context(r).includes(F.CHOSEN_FULL), "Claude is told the person chose a full workflow, small jobs included");
    assert.ok(!denied(await skill(s, "r1a", "mmo:bugfix")));
    assert.ok(started(s, "r1a"), "A");
  } finally { s.cleanup(); }
});

test("recognised job × Claude writes a file or calls another workflow first → refused, the start still waits", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r1b", JOB);
    assert.ok(denied(await write(s, "r1b", "src/fix.js")), "no file changes until the workflow starts");
    assert.ok(denied(await skill(s, "r1b", "mmo:docs")), "not another workflow");
    assert.equal(route(s, "r1b")?.status, "pending", "the start is still owed");
    assert.ok(!denied(await skill(s, "r1b", "mmo:bugfix")));
    assert.ok(started(s, "r1b"), "A");
  } finally { s.cleanup(); }
});

test("recognised job × Claude only replies → told once more to start it; starts → A", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r1c", JOB);
    const end = await turnEnd(s, "r1c");
    assert.match(context(end), /^You were told to start the person's bug-fix workflow and did not\./);
    assert.ok(context(end).includes(F.CHOSEN_FULL));
    assert.equal(line(end), null, "nothing shown yet: Claude gets one more go");
    assert.equal(route(s, "r1c")?.retried, true);
    assert.ok(!denied(await skill(s, "r1c", "mmo:bugfix")));
    assert.ok(started(s, "r1c"), "A");
  } finally { s.cleanup(); }
});

test("recognised job × Claude replies twice → C, and the person's next \"yes\" starts it → A", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r1d", JOB);
    await turnEnd(s, "r1d");
    const gaveUp = await turnEnd(s, "r1d", true);
    assert.equal(line(gaveUp), 'Zero-touch: the bug-fix workflow didn\'t start. Say "yes" to start it now, or ask for something else.', "C");
    assert.equal(context(gaveUp), "", "never a third push: no loop");
    assert.equal(route(s, "r1d"), null);
    assert.ok(carried(s, "r1d"));
    const yes = await prompt(s, "r1d", "yes");
    assert.match(line(yes), /so Claude is starting the bug-fix workflow/);
    assert.ok(!carried(s, "r1d"), "used once");
    assert.ok(!denied(await skill(s, "r1d", "mmo:bugfix")));
    assert.ok(started(s, "r1d"), "A");
  } finally { s.cleanup(); }
});

test("the retry is given once even when Claude Code does not mark the next stop as a hook's (route.retried) → C", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r1e", JOB);
    await turnEnd(s, "r1e");
    const second = await turnEnd(s, "r1e", false);
    assert.match(line(second) ?? "", /didn't start\. Say "yes"/);
    assert.equal(context(second), "");
  } finally { s.cleanup(); }
});

test("after C, anything but a plain yes is judged as usual and the kept job is dropped → B", { skip: SKIP ?? false }, async () => {
  for (const [sid, text] of [["r1f", "no, just write it here"], ["r1g", "why didn't it start?"], ["r1h", "thanks"]]) {
    const s = sandbox();
    try {
      await prompt(s, sid, JOB);
      await turnEnd(s, sid);
      await turnEnd(s, sid, true);
      const r = await prompt(s, sid, text);
      assert.doesNotMatch(line(r) ?? "", /is starting/, text);
      assert.ok(!carried(s, sid), `${text}: the kept job is gone`);
      assert.equal(route(s, sid), null, text);
      assert.doesNotMatch(line(await prompt(s, sid, "yes")) ?? "", /is starting/, `${text}: a later yes starts nothing`);
      assert.ok(!started(s, sid), "B");
    } finally { s.cleanup(); }
  }
});

test("after C in a new-app folder that now holds files, \"yes\" is refused by the folder rule → C", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    await prompt(s, "r1i", "build a small to-do app");
    await turnEnd(s, "r1i");
    await turnEnd(s, "r1i", true);
    writeFileSync(join(s.repo, "index.html"), "<h1>Hello</h1>\n".repeat(30)); // Claude wrote the app itself meanwhile
    writeFileSync(join(s.repo, "package.json"), '{"name":"todo"}\n');
    const r = await prompt(s, "r1i", "yes");
    assert.match(line(r) ?? "", /this looks like a new app, but this folder already holds a project/);
    assert.ok(!started(s, "r1i"), "C");
  } finally { s.cleanup(); }
});

// ─── Row 2: a message the rules cannot place, judged by Claude ──────────────────────────────────────────────────────

test("judged message × Claude starts an allowed job → A; a job this folder does not allow → C", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r2a", JUDGED);
    assert.ok(!denied(await skill(s, "r2a", "mmo:bugfix")));
    assert.ok(started(s, "r2a"), "A");
    const t = sandbox();
    try {
      await prompt(t, "r2b", JUDGED);
      const r = await skill(t, "r2b", "mmo:greenfield", "");
      assert.ok(denied(r));
      assert.equal(reason(r), NOT_NOW, "C");
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("judged message while another chat's workflow holds the folder × Claude starts it → C with the busy line, never \"not recognised\"", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    // Chat A runs a bug fix in this folder (the same steps as Row 4's running(), defined below).
    await prompt(s, "ba", JOB);
    assert.ok(!denied(await skill(s, "ba", "mmo:bugfix", JOB)));
    for (const [sid, text] of [["bb1", "make the checkout page remember the last used address"], ["bb2", JUDGED]]) {
      const r = await prompt(s, sid, text);
      assert.equal(line(r), null, `${sid}: no false "wasn't recognised" line`);
      assert.equal(route(s, sid)?.status, "judge", `${sid}: left to Claude's judgement, as in a free folder`);
      const k = await skill(s, sid, "mmo:bugfix", text);
      assert.ok(denied(k), sid);
      assert.match(reason(k), /didn't start, because another chat in this project folder is already running a bug-fix workflow/, sid);
      assert.match(context(k), /Do not do the job yourself now/, sid);
      assert.ok(!started(s, sid), "C");
      assert.ok(denied(await write(s, sid, "src/cart.js")), `${sid}: and not done by hand in that turn`);
    }
  } finally { s.cleanup(); }
});

// A new chat's first message comes before the chat has answered, and Claude Code passes hooks no model, so a start
// can be allowed with the model unknown. At the workflow's first step that does anything, Claude's earlier reply,
// which names the model, is in the transcript: the model is confirmed there.
function chatTranscript(s, sid, model) {
  const file = join(s.dir, `${sid}.jsonl`);
  writeFileSync(file, [
    { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: JOB } },
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", model, content: [{ type: "text", text: "Running this as a full bug-fix workflow." }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}
const step = (s, sid, transcript, tool = "Bash", tool_input = { command: "git status" }) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: tool, tool_input, transcript_path: transcript }, s);

test("first message of a new chat on another model × the workflow starts with the model unknown → stopped at its first step, C for the turn", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "mw", JOB);
    assert.ok(!denied(await skill(s, "mw", "mmo:bugfix", JOB)), "allowed: nothing tells the model yet");
    assert.ok(started(s, "mw"));
    const t = chatTranscript(s, "mw", "claude-sonnet-5-5");
    assert.ok(!denied(await step(s, "mw", t, "Read", { file_path: join(s.repo, "package.json") })), "reading changes nothing");
    const first = await step(s, "mw", t);
    assert.ok(denied(first), "the first step that does anything is refused");
    assert.match(reason(first), /^Zero-touch: the bug-fix workflow didn't start, because this chat is on Sonnet 5\.5/);
    assert.match(context(first), /Do not do the job yourself now/);
    assert.ok(!started(s, "mw"), "the workflow is stopped, before any of its work");
    assert.ok(denied(await write(s, "mw", "src/fix.js")), "and nothing is done by hand in that turn");
    await turnEnd(s, "mw");
    assert.ok(!denied(await write(s, "mw", "src/fix.js")), "the next turn is free again");
  } finally { s.cleanup(); }
});

test("first message of a new chat on the planning model × the first step confirms it once, and the workflow carries on", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "mr", JOB);
    assert.ok(!denied(await skill(s, "mr", "mmo:bugfix", JOB)));
    const t = chatTranscript(s, "mr", "claude-opus-5");
    assert.ok(!denied(await step(s, "mr", t)));
    assert.ok(started(s, "mr"));
    assert.equal(JSON.parse(readFileSync(join(s.home, "sessions", "mr", "pipeline"), "utf8")).model_ok, true, "confirmed once");
  } finally { s.cleanup(); }
});

// A job that cannot start is outcome C for its whole turn: Claude cannot do the job by hand instead, whatever it makes
// of zero-touch's note (a model may take the note for an instruction slipped into a tool's output and ignore it).
test("recognised job that cannot start × Claude writes files or calls a workflow → refused with the same line, for that turn only", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "ra", JOB);
    assert.ok(!denied(await skill(s, "ra", "mmo:bugfix", JOB)), "another chat's workflow now holds the folder");
    const r = await prompt(s, "rb", JOB);
    assert.match(line(r) ?? "", /didn't start, because another chat in this project folder is already running a bug-fix workflow/);
    const w = await write(s, "rb", "src/fix.js");
    assert.ok(denied(w), "no file changes: the job is not done by hand");
    assert.equal(reason(w), line(r), "the person reads the same reason");
    assert.match(context(w), /Do not do the job yourself now/);
    const k = await skill(s, "rb", "mmo:docs", "x");
    assert.ok(denied(k));
    assert.equal(reason(k), line(r), "a workflow call gets the same reason");
    assert.equal((await turnEnd(s, "rb")).stdout, "");
    assert.ok(!denied(await write(s, "rb", "src/fix.js")), "the next turn is free again");
  } finally { s.cleanup(); }
});

test("the first chat's first message waiting for a model switch → no file changes in that turn, never judged at its end", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    await run("session-start", { session_id: "fw", cwd: s.repo, source: "startup", model: "claude-sonnet-5" }, s);
    // What the settings box leaves when Workflows is saved on another model than the choice plans with.
    const hello = "build a smallest hello world app: one HTML file that shows Hello, world. No server, no build step, no libraries.";
    writeFileSync(join(s.home, "sessions", "fw", "zt_replay.json"), JSON.stringify({ prompt: hello, waits: "chat-model", at: new Date().toISOString() }));
    const w = await write(s, "fw", "index.html");
    assert.ok(denied(w), "Claude cannot build it by hand");
    assert.match(reason(w), /^Zero-touch: the new-app workflow didn't start, because this chat is on Sonnet 5/);
    assert.ok(!existsSync(join(s.home, "sessions", "fw", "zt_replay.json")), "read once");
    const end = await turnEnd(s, "fw");
    assert.equal(context(end), "", "never judged at the turn's end: the person sends it again after switching");
    assert.ok(!denied(await write(s, "fw", "index.html")), "the next turn is free again");
  } finally { s.cleanup(); }
});

test("judged message × Claude answers or edits files itself → B: no retry, no line, nothing kept", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "r2c", JUDGED);
    assert.equal((await write(s, "r2c", "src/login.js")).stdout, "", "Claude judged it no job: its own edits are normal chat");
    const end = await turnEnd(s, "r2c");
    assert.equal(end.stdout, "", "no retry and no line for a judgement");
    assert.equal(route(s, "r2c"), null);
    assert.ok(!carried(s, "r2c"));
  } finally { s.cleanup(); }
});

// ─── Row 3: not a job ───────────────────────────────────────────────────────────────────────────────────────────────

test("not a job × Claude answers, edits, or tries a workflow on its own → B, or C for the workflow", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const r = await prompt(s, "r3a", CHAT);
    assert.equal(r.stdout, "", "nothing added, nothing shown");
    assert.equal((await write(s, "r3a", "notes.md")).stdout, "", "B");
    const tried = await skill(s, "r3a", "mmo:bugfix");
    assert.ok(denied(tried));
    assert.equal(reason(tried), NOT_NOW, "C");
    assert.equal((await turnEnd(s, "r3a")).stdout, "", "B");
    assert.ok(!started(s, "r3a"));
  } finally { s.cleanup(); }
});

// ─── The words a plain yes may take ─────────────────────────────────────────────────────────────────────────────────

test("what counts as a plain yes to the job that did not start", () => {
  for (const t of ["yes", "Yes!", "ok go", "go ahead", "full build", "run the full build anyway", "start it", "yes please start it"]) assert.equal(F.carryYes(t), true, t);
  for (const t of ["no", "no, just write it here", "just write the file", "yes but in the chat instead", "why didn't it start?", "ok, wait", "", "please explain what the workflow will do and how long it will take first"]) assert.equal(F.carryYes(t), false, t);
});

// ─── Every new message ends the previous one's state ────────────────────────────────────────────────────────────────

test("a start abandoned with Esc never blocks the next message: a typed one-off command or a message about zero-touch runs → B", { skip: SKIP ?? false }, async () => {
  for (const next of ["/mmo:setup", "help me connect Google for zero-touch"]) {
    const s = sandbox();
    try {
      await prompt(s, "e1", JOB); // the person then presses Esc: no turn end
      assert.equal(route(s, "e1")?.status, "pending");
      await prompt(s, "e1", next);
      assert.equal(route(s, "e1"), null, `${next}: the abandoned start ended with the new message`);
      assert.ok(!denied(await run("pre-any", { session_id: "e1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "git status" } }, s)), `${next}: its steps run`);
      assert.equal((await turnEnd(s, "e1")).stdout, "", `${next}: no retry of the abandoned start`);
    } finally { s.cleanup(); }
  }
});

test("the kept job lives exactly one message: a typed workflow or a message about zero-touch in between drops it → B", { skip: SKIP ?? false }, async () => {
  for (const between of ["/mmo:docs write the API docs for the auth module", "why did zero-touch not start it?"]) {
    const s = sandbox();
    try {
      await prompt(s, "k1", JOB);
      await turnEnd(s, "k1");
      await turnEnd(s, "k1", true);
      assert.ok(carried(s, "k1"));
      await prompt(s, "k1", between);
      assert.ok(!carried(s, "k1"), `${between}: the kept job is gone`);
      await turnEnd(s, "k1");
      assert.doesNotMatch(line(await prompt(s, "k1", "ok thanks")) ?? "", /is starting/, `${between}: a later "ok thanks" starts nothing`);
    } finally { s.cleanup(); }
  }
});

test("a typed workflow command runs as typed even when its words name zero-touch → its own run, as mmo runs it without zero-touch", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "t1", "/mmo:docs document the zero-touch settings box");
    const r = await skill(s, "t1", "mmo:docs", "document the zero-touch settings box");
    assert.ok(!denied(r), reason(r));
    assert.ok(started(s, "t1"));
  } finally { s.cleanup(); }
});

// ─── Row 4: a job asked for in plain words while a workflow runs ────────────────────────────────────────────────────
// Queued at once and said at once (A, later), never at a step the workflow waits on (its answer: B), and started by
// itself when the running workflow ends.

const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
const { appendFileSync } = await import("node:fs");
async function running(s, sid, { gate = false } = {}) {
  await prompt(s, sid, JOB);
  await skill(s, sid, "mmo:bugfix", JOB);
  await run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --run-id=bf-${sid} --project-root "${s.repo}"` } }, s);
  const dir = join(s.repo, ".sdlc", "runs", `bf-${sid}`);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "orchestrator.log"), formatLine("info", "run.start", { run_id: `bf-${sid}`, mode: "brownfield" }) + "\n");
  if (gate) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", "gate.open", { run_id: `bf-${sid}`, gate: "gate-1" }) + "\n");
  return dir;
}
const midTurn = (s, sid, text) => {
  const t = join(s.dir, `${sid}-mid.jsonl`);
  writeFileSync(t, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: sid, content: text }) + "\n");
  return run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}`, transcript_path: t }, s);
};
const queue = (s, sid) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, "queue.json"), "utf8")); } catch { return []; } };
const README = "write a README for the shop";

test("a job typed while the workflow works → queued and said at once, no box, nothing held", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "q1");
    const r = await midTurn(s, "q1", README);
    assert.equal(line(r), "Zero-touch: noted. The documentation workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.");
    assert.match(context(r), /Zero-touch has queued it: it starts by itself when this workflow ends/);
    assert.deepEqual(queue(s, "q1").map((q) => q.job), ["docs"]);
    assert.ok(!existsSync(join(s.home, "sessions", "q1", "choice.json")), "no Queue-or-Replace box");
    assert.ok(!denied(await write(s, "q1", "src/fix.js")), "the running workflow's own steps are never held");
    assert.equal(line(await midTurn(s, "q1", README)), "Zero-touch: the documentation workflow is already queued, so it wasn't added twice.");
  } finally { s.cleanup(); }
});

test("a job typed while the workflow waits at an approval step → the workflow's answer, nothing queued → B", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "q2", { gate: true });
    const r = await prompt(s, "q2", "add a due date to the order form");
    assert.equal(r.stdout, "", "a revision of the running work at its approval step");
    assert.deepEqual(queue(s, "q2"), []);
  } finally { s.cleanup(); }
});

// The app's Send on a message waiting while the workflow works cuts Claude off mid-step, and the message arrives as a
// new one before the run has begun: it is a new job to queue, not the workflow's answer to its first questions.
test("a job sent as a new message that cut off the workflow's step before its run began → queued and said, never its answer", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "cx", JOB);
    assert.ok(!denied(await skill(s, "cx", "mmo:bugfix", JOB)));
    // The workflow's pre-flight step starts; the person's Send cuts it off, so no turn-end runs.
    await run("pre-any", { session_id: "cx", cwd: s.repo, tool_name: "Bash", tool_input: { command: "git rev-parse --show-toplevel" } }, s);
    const r = await prompt(s, "cx", README);
    assert.equal(line(r), "Zero-touch: noted. The documentation workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.");
    assert.match(context(r), /cut off the workflow's last step: run that step again and carry on/);
    assert.deepEqual(queue(s, "cx").map((q) => q.job), ["docs"]);
  } finally { s.cleanup(); }
});

test("before its run began, a turn that ended normally, or was cut off at a question box, is waiting: the message is its answer", { skip: SKIP ?? false }, async () => {
  for (const [sid, cut] of [["fe", null], ["fq", "AskUserQuestion"]]) {
    const s = sandbox();
    try {
      await prompt(s, sid, JOB);
      assert.ok(!denied(await skill(s, sid, "mmo:bugfix", JOB)));
      await run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command: "ls" } }, s);
      if (cut) await run("pre-any", { session_id: sid, cwd: s.repo, tool_name: cut, tool_input: { questions: [] } }, s);
      else await turnEnd(s, sid); // it asked its first question in words and ended its turn
      const r = await prompt(s, sid, "add a due date to the order form too");
      assert.equal(r.stdout, "", `${sid}: its answer`);
      assert.deepEqual(queue(s, sid), [], sid);
    } finally { s.cleanup(); }
  }
});

// A request the rules cannot place, sent while the workflow runs, is left to Claude's judgement, as when no workflow
// runs: part of the running work, or a clearly separate job, which Claude's Skill call turns into a queued job.
const UNPLACED_DOCS = "write API documentation for the date helpers in docs/dates.md";

test("unplaced request mid-run × Claude judges it a separate job → its Skill call is queued and said, nothing starts", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "j1");
    const r = await midTurn(s, "j1", UNPLACED_DOCS);
    assert.equal(line(r), null, "nothing is said before Claude judges it");
    assert.match(context(r), /quick rules did not place it, so you judge it/);
    assert.match(context(r), /part of that work/);
    assert.match(context(r), /"mmo:docs"/);
    assert.doesNotMatch(context(r), /"mmo:greenfield"/, "a new app is never offered in a project");
    assert.deepEqual(queue(s, "j1"), []);
    const k = await run("pre-skill", { session_id: "j1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:docs", args: "write API documentation for the date helpers" } }, s);
    assert.ok(denied(k), "nothing starts while the workflow runs");
    assert.equal(reason(k), "Zero-touch: noted. The documentation workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.");
    assert.deepEqual(queue(s, "j1").map((q) => [q.job, q.args]), [["docs", "write API documentation for the date helpers"]]);
  } finally { s.cleanup(); }
});

test("unplaced request mid-run × Claude judges it part of the running work → no call, nothing queued or said", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "j2");
    await midTurn(s, "j2", "the parser should also handle leap years properly");
    assert.equal((await turnEnd(s, "j2")).stdout, "", "the workflow carries on: nothing starts, nothing is said");
    assert.deepEqual(queue(s, "j2"), []);
    assert.equal((await midTurn(s, "j2", "thanks, looks good")).stdout, "", "ordinary chat mid-run gets nothing added");
  } finally { s.cleanup(); }
});

test("mid-run, Claude starting a workflow this folder does not allow → refused, never queued", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "j3");
    const k = await run("pre-skill", { session_id: "j3", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:greenfield", args: "" } }, s);
    assert.ok(denied(k));
    assert.equal(reason(k), NOT_NOW);
    assert.deepEqual(queue(s, "j3"), []);
  } finally { s.cleanup(); }
});

test("an unplaced request that cut off the workflow's step is judged, and Claude is told to run the step again", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await prompt(s, "j4", JOB);
    assert.ok(!denied(await skill(s, "j4", "mmo:bugfix", JOB)));
    await run("pre-any", { session_id: "j4", cwd: s.repo, tool_name: "Bash", tool_input: { command: "git status" } }, s);
    const r = await prompt(s, "j4", UNPLACED_DOCS);
    assert.match(context(r), /quick rules did not place it, so you judge it/);
    assert.match(context(r), /cut off the workflow's last step: run that step again and carry on/);
  } finally { s.cleanup(); }
});

test("Claude starting a second workflow by itself mid-run → refused and queued, no box", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await running(s, "q3");
    const r = await run("pre-skill", { session_id: "q3", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:docs", args: README } }, s);
    assert.ok(denied(r));
    assert.match(reason(r), /^Zero-touch: noted\. The documentation workflow will start by itself/);
    assert.deepEqual(queue(s, "q3").map((q) => q.job), ["docs"]);
  } finally { s.cleanup(); }
});

test("the queued job starts when the running workflow ends; not started even when told again → C, and \"yes\" starts it → A", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const dir = await running(s, "q4");
    await midTurn(s, "q4", README);
    // As mmo logs a finished run: run.end before its final report, then its final acceptance gate, answered.
    for (const [event, fields] of [["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]]) {
      appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: "bf-q4", ...fields }) + "\n");
    }
    const end = await turnEnd(s, "q4");
    assert.match(line(end) ?? "", /the bug-fix workflow has finished, so the documentation workflow you queued is starting now/);
    assert.match(context(end), /Start it now with the Skill tool: skill "mmo:docs"/);
    assert.equal(route(s, "q4")?.via, "queue");
    const gaveUp = await turnEnd(s, "q4", true); // Claude did not start it in the turn the Stop hook continued
    assert.match(line(gaveUp) ?? "", /the documentation workflow didn't start\. Say "yes" to start it now/, "never dropped silently");
    assert.deepEqual(queue(s, "q4"), [], "it left the queue");
    const yes = await prompt(s, "q4", "yes");
    assert.match(line(yes) ?? "", /so Claude is starting the documentation workflow/);
    assert.ok(!denied(await skill(s, "q4", "mmo:docs", README)));
  } finally { s.cleanup(); }
});
