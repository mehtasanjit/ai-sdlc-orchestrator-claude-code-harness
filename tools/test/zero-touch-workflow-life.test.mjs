/**
 * A workflow's life in a zero-touch chat always ends, and two chats never run one in the same folder.
 *
 * Why: a workflow stopped before its run began (the person said no to the plan, a check failed, the folder was wrong)
 * must not hold its chat and its project folder for good, with every later message "taken as your answer" and every
 * other chat's workflow there refused until a 30-day cleanup. Likewise: the start is recorded only after Claude Code's
 * own permission check (a refused Skill call marks nothing), two chats starting at once cannot both run, a job typed
 * while the workflow works does not freeze its helpers, a project's own /test command is not read as mmo's, "Replace
 * it" never stops a workflow for one that cannot start, a turn ending in an error leaves no hold behind, and an
 * aborted run is never said to have "finished".
 * Each case below runs the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
const { acquire, heldByOther, release, NOT_STARTED_IDLE_MS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "project-lock.mjs"));
const { workflowState, abortRun } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "workflow-log.mjs"));
const { isStopRequest } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));
const { typedCommand } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "commands.mjs"));
const { PERSON_LINE: L } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-life-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => { let json = null; try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ } done({ code, stdout, json }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
let seq = 0;
const say = (s, sid, text, extra = {}) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: extra.prompt_id ?? `p-${++seq}`, ...extra }, s);
const preSkill = (s, sid, name, args) => run("pre-skill", { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } }, s);
const postSkill = (s, sid, name, args) => run("post-skill", { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) }, tool_use_id: `tu-${++seq}` }, s);
const skill = async (s, sid, name, args) => { const pre = await preSkill(s, sid, name, args); if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") return postSkill(s, sid, name, args); return pre; };
const tool = (s, sid, tool_name, tool_input = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name, tool_input }, s);
const turnEnd = (s, sid, extra = {}) => run("turn-end", { session_id: sid, cwd: s.repo, stop_hook_active: false, ...extra }, s);
const line = (r) => r.json?.systemMessage ?? "";
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const read = (s, sid, name) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, name), "utf8")); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
const pipeline = (s, sid) => read(s, sid, "pipeline");
function workflowLog(s, runId, ...lines) {
  const dir = join(s.repo, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of lines) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}
const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const DOCS = "add jsdoc to every function in src/cart.js";

test("a Skill call that Claude Code then refuses leaves nothing behind: the start is recorded only once the call ran", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "a1", BUGFIX);
    assert.equal((await preSkill(s, "a1", "mmo:bugfix", BUGFIX)).stdout, "", "allowed");
    assert.equal(pipeline(s, "a1"), null, "not marked at PreToolUse");
    // No PostToolUse: a permission rule, another hook or an interrupt stopped the call. The turn ends: Claude is told
    // once more to start it (the outcome contract), and when that turn ends without the start too, the
    // person is told.
    const end = await turnEnd(s, "a1");
    assert.match(end.json?.hookSpecificOutput?.additionalContext ?? "", /^You were told to start the person's bug-fix workflow and did not\./);
    const again = await turnEnd(s, "a1", { stop_hook_active: true });
    assert.equal(line(again), L.didntStart("bugfix"), "the person is told the start they were promised did not happen");
    // The folder is free for another chat, and this chat's next job is routed again.
    assert.equal(heldByOther(s.repo, "a2", { ...process.env, MMO_HOME: s.home }), null);
    assert.match(line(await say(s, "a1", BUGFIX)), /starting the bug-fix workflow/);
  } finally { s.cleanup(); }
});

test("the folder is taken atomically: the second chat's start is not carried out, and it is told why", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "b1", BUGFIX);
    await say(s, "b2", DOCS);
    // Both were recognised while the folder was free; b1's command runs first.
    assert.match(context(await skill(s, "b1", "mmo:bugfix", BUGFIX)), /^Zero-touch started this workflow/, "b1 starts, and Claude gets zero-touch's note beside the command");
    const late = await skill(s, "b2", "mmo:docs", DOCS);
    assert.match(line(late), /didn't start, because another chat in this project folder is already running a bug-fix workflow/);
    assert.match(context(late), /^Do not carry out the workflow you just loaded\./);
    assert.equal(pipeline(s, "b2"), null, "b2 runs no workflow");
    assert.equal(pipeline(s, "b1").job, "bugfix");
  } finally { s.cleanup(); }
});

test("acquire: exactly one chat holds a folder; a stale holder is replaced", () => {
  const s = sandbox();
  const env = { ...process.env, MMO_HOME: s.home };
  try {
    mkdirSync(join(s.home, "sessions", "c1"), { recursive: true });
    writeFileSync(join(s.home, "sessions", "c1", "pipeline"), JSON.stringify({ since: new Date().toISOString(), job: "bugfix" }));
    assert.deepEqual(acquire(s.repo, "c1", "bugfix", env), { ok: true });
    const second = acquire(s.repo, "c2", "docs", env);
    assert.equal(second.ok, false);
    assert.equal(second.owner.sid, "c1");
    // c1's workflow ends (its record goes): c2 can take the folder.
    rmSync(join(s.home, "sessions", "c1", "pipeline"));
    assert.deepEqual(acquire(s.repo, "c2", "docs", env), { ok: true });
    release(s.repo, "c2", env);
    assert.equal(heldByOther(s.repo, "c3", env), null);
  } finally { s.cleanup(); }
});

test("a workflow that reports an early stop hands the chat and the folder back at the end of that turn", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "d1", BUGFIX);
    await skill(s, "d1", "mmo:bugfix", BUGFIX);
    assert.equal(pipeline(s, "d1").job, "bugfix");
    // The brownfield manual stops at a prerequisite and runs the stop script, as zero-touch's note told Claude.
    assert.equal((await tool(s, "d1", "Bash", { command: `node "/plugin/scripts/ambient/workflow-stopped.mjs" --reason "not a git repository"` })).stdout, "", "the call runs untouched");
    const end = await turnEnd(s, "d1");
    assert.equal(line(end), L.ended("bugfix", "a", "stopped"));
    assert.equal(pipeline(s, "d1"), null, "the chat is ordinary again");
    assert.equal(heldByOther(s.repo, "d2", { ...process.env, MMO_HOME: s.home }), null, "and the folder is free");
    assert.match(line(await say(s, "d1", DOCS)), /starting the documentation workflow/, "a new job starts its own workflow");
  } finally { s.cleanup(); }
});

test("\"stop\" while a workflow runs stops it the way its own abort does, frees the folder and drops the queue", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "e1", BUGFIX);
    await skill(s, "e1", "mmo:bugfix", BUGFIX);
    await tool(s, "e1", "Bash", { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --run-id=bf-e1 --project-root "${s.repo}"` });
    // Working, not waiting at a gate (at a gate the words are the workflow's answer, below).
    workflowLog(s, "bf-e1", ["run.start", { mode: "brownfield" }]);
    writeFileSync(join(s.home, "sessions", "e1", "queue.json"), JSON.stringify([{ job: "docs", args: DOCS, via: "words" }]));
    const r = await say(s, "e1", "cancel");
    assert.equal(line(r), L.stopped("bugfix", true));
    assert.match(context(r), /Do not carry on with any of its steps/);
    assert.match(readFileSync(join(s.repo, ".sdlc", "runs", "bf-e1", "orchestrator.log"), "utf8"), /run\.end.*outcome=aborted/, "its log records the stop");
    assert.equal(pipeline(s, "e1"), null);
    assert.equal(read(s, "e1", "queue.json"), null, "the queued job is dropped too, and said");
    assert.equal(heldByOther(s.repo, "e2", { ...process.env, MMO_HOME: s.home }), null);
    // Only a short stop message counts.
    for (const t of ["stop", "Stop!", "cancel it", "please stop the workflow", "never mind", "forget it", "abort the run"]) assert.ok(isStopRequest(t), t);
    for (const t of ["stop the dev server", "stop using lodash in src/cart.js", "cancel the order flow when payment fails", "don't stop at the first error"]) assert.ok(!isStopRequest(t), t);
  } finally { s.cleanup(); }
});

test("at a gate, and in a workflow the person typed, \"stop\" or \"abort\" is the workflow's own answer: zero-touch leaves it", { skip: SKIP ?? false }, async () => {
  // mmo's documented gate reply "abort" is left to mmo, so mmo's own abort (its log, manifest and final report) runs;
  // in a typed workflow zero-touch does not act at all.
  const s = sandbox();
  try {
    await say(s, "g1", BUGFIX);
    await skill(s, "g1", "mmo:bugfix", BUGFIX);
    await tool(s, "g1", "Bash", { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --run-id=bf-g1 --project-root "${s.repo}"` });
    workflowLog(s, "bf-g1", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }]);
    const r = await say(s, "g1", "abort");
    assert.equal(line(r), "", "zero-touch says nothing: the answer is the workflow's");
    assert.ok(pipeline(s, "g1") !== null, "and does not stop it itself");
    assert.doesNotMatch(readFileSync(join(s.repo, ".sdlc", "runs", "bf-g1", "orchestrator.log"), "utf8"), /run\.end/);
    // A workflow the person typed: never intercepted, at a gate or not.
    const t = sandbox();
    try {
      await say(t, "g2", "/mmo:bugfix the login page returns 500");
      await skill(t, "g2", "mmo:bugfix", "the login page returns 500");
      await tool(t, "g2", "Bash", { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --run-id=bf-g2 --project-root "${t.repo}"` });
      workflowLog(t, "bf-g2", ["run.start", { mode: "brownfield" }]);
      const typedStop = await say(t, "g2", "stop");
      assert.equal(line(typedStop), "");
      assert.ok(pipeline(t, "g2") !== null);
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test("a workflow that never began and sat idle stops holding the folder; its chat is told once", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  const transcript = join(s.dir, "f1.jsonl");
  writeFileSync(transcript, "{}\n");
  try {
    await say(s, "f1", BUGFIX, { transcript_path: transcript });
    await run("pre-skill", { session_id: "f1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX } }, s);
    await run("post-skill", { session_id: "f1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX }, tool_use_id: "tu-f1", transcript_path: transcript }, s);
    assert.equal(pipeline(s, "f1").transcript, transcript, "the record names the chat's own file");
    // Still asking its first questions: the folder is held, and f2 is told so when it asks.
    assert.match(line(await say(s, "f2", DOCS)), /another chat in this project folder is already running/);
    // 31 minutes later, with nothing happening in f1, the folder is free.
    const old = (Date.now() - NOT_STARTED_IDLE_MS - 60_000) / 1000;
    utimesSync(transcript, old, old);
    const rec = pipeline(s, "f1");
    writeFileSync(join(s.home, "sessions", "f1", "pipeline"), JSON.stringify({ ...rec, since: new Date(Date.now() - NOT_STARTED_IDLE_MS - 60_000).toISOString() }));
    await say(s, "f2", DOCS);
    assert.match(context(await skill(s, "f2", "mmo:docs", DOCS)), /^Zero-touch started this workflow/, "f2's workflow starts");
    // f1's next message: told once that its workflow is over.
    const back = await say(s, "f1", "the brief is in brief.md");
    assert.equal(line(back), L.lostFolder("bugfix"));
    assert.equal(pipeline(s, "f1"), null);
  } finally { s.cleanup(); }
});

test("a lock whose chat no longer exists does not hold the folder", () => {
  const s = sandbox();
  const env = { ...process.env, MMO_HOME: s.home };
  try {
    mkdirSync(join(s.home, "sessions", "g1"), { recursive: true });
    writeFileSync(join(s.home, "sessions", "g1", "pipeline"), JSON.stringify({ since: new Date().toISOString(), job: "bugfix", transcript: join(s.dir, "deleted.jsonl") }));
    assert.equal(acquire(s.repo, "g1", "bugfix", env).ok, true);
    assert.equal(heldByOther(s.repo, "g2", env), null, "its transcript is gone: the chat was deleted");
  } finally { s.cleanup(); }
});

test("a gate answered \"revise\" keeps the run going, even after its run.end (Gate 4 reject)", () => {
  const s = sandbox();
  try {
    const since = Date.now() - 1000;
    workflowLog(s, "gf1", ["run.start", { mode: "greenfield" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "revise" }]);
    assert.equal(workflowState(s.repo, since, "gf1").state, "running", "the revision is under way");
    workflowLog(s, "gf1", ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.equal(workflowState(s.repo, since, "gf1").state, "ended");
  } finally { s.cleanup(); }
});

test("a stopped run's resume record is marked aborted, so the next run does not offer to resume it", () => {
  const s = sandbox();
  try {
    workflowLog(s, "r1", ["run.start", { mode: "brownfield" }]);
    mkdirSync(join(s.repo, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "local", "state.json"), JSON.stringify({ run_id: "r1", status: "in_progress", phase: "codegen" }));
    const done = abortRun(s.repo, "r1", "replaced");
    assert.equal(done.resumable, true);
    assert.equal(JSON.parse(readFileSync(join(s.repo, ".sdlc", "local", "state.json"), "utf8")).status, "aborted");
    writeFileSync(join(s.repo, ".sdlc", "local", "state.json"), JSON.stringify({ run_id: "other", status: "in_progress" }));
    abortRun(s.repo, "r1", "replaced");
    assert.equal(JSON.parse(readFileSync(join(s.repo, ".sdlc", "local", "state.json"), "utf8")).status, "in_progress", "another run's record is left alone");
  } finally { s.cleanup(); }
});

test("a project's own /test command is not mmo's: typing it marks nothing", () => {
  const s = sandbox();
  try {
    assert.equal(typedCommand("/test", { projectDir: s.repo, env: { HOME: s.home } })?.name, "test", "with no other /test, it is mmo's");
    mkdirSync(join(s.repo, ".claude", "commands"), { recursive: true });
    writeFileSync(join(s.repo, ".claude", "commands", "test.md"), "Run the suite.\n");
    assert.equal(typedCommand("/test", { projectDir: s.repo, env: { HOME: s.home } }), null, "the project's own wins");
    assert.equal(typedCommand("/mmo:test", { projectDir: s.repo, env: { HOME: s.home } })?.name, "test", "the prefixed name is always mmo's");
  } finally { s.cleanup(); }
});

test("a job typed while the workflow is working is queued and said at once: no question, nothing held", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  const transcript = join(s.dir, "h1.jsonl");
  try {
    await say(s, "h1", BUGFIX);
    await skill(s, "h1", "mmo:bugfix", BUGFIX);
    await tool(s, "h1", "Bash", { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --run-id=bf-h1 --project-root "${s.repo}"` });
    workflowLog(s, "h1run", ["run.start", { mode: "brownfield" }]);
    // Claude Code records a message typed mid-turn as a queued command in the transcript.
    writeFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: DOCS } }) + "\n");
    const r = await say(s, "h1", DOCS, { transcript_path: transcript });
    assert.match(r.json?.systemMessage ?? "", /^Zero-touch: noted\. The documentation workflow will start by itself when the bug-fix workflow finishes/, "said at once");
    assert.equal(read(s, "h1", "choice.json"), null, "nothing is asked mid-turn, and nothing holds the workflow's helpers");
    assert.deepEqual((read(s, "h1", "queue.json") ?? []).map((q) => q.job), ["docs"]);
    assert.equal((await tool(s, "h1", "Bash", { command: "npm test" })).stdout, "", "the workflow's own steps run");
  } finally { s.cleanup(); }
});

test("a turn that ends in an error drops a queued command's hold", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "i1", BUGFIX);
    await skill(s, "i1", "mmo:bugfix", BUGFIX);
    writeFileSync(join(s.home, "sessions", "i1", "hold"), JSON.stringify({ at: new Date().toISOString() }));
    await run("turn-failed", { session_id: "i1", cwd: s.repo }, s);
    assert.equal(existsSync(join(s.home, "sessions", "i1", "hold")), false);
  } finally { s.cleanup(); }
});

test("the end line says how the workflow ended", () => {
  assert.match(L.ended("bugfix", "a"), /has finished/);
  assert.match(L.ended("bugfix", "a", "aborted"), /was stopped/);
  assert.match(L.ended("bugfix", "a", "failed"), /stopped because of a problem/);
  assert.match(L.ended("bugfix", "a", "stopped"), /stopped before it began/);
  assert.match(L.ended("bugfix", "b", "aborted"), /Hand-off mode again/);
});

test("while the person's workflow runs, its own steps run without a permission prompt; nothing else does", { skip: SKIP ?? false }, async () => {
  // In Claude Code's default "ask" mode a workflow would bring dozens of prompts naming this plugin's bookkeeping
  // scripts and model-server tools. Allowed: exactly one call of one of the plugin's own step scripts, and its own
  // server's tools, while a workflow runs. Everything else keeps Claude Code's own rules.
  const s = sandbox();
  try {
    const scripts = join(ROOT, "plugin", "scripts");
    const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
    const step = `node "${scripts}/mmo-log.mjs" --event=phase.start --phase=design --run-id=r1`;
    await say(s, "w1", BUGFIX);
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/ambient/workflow-stopped.mjs"` })), "deny", "before the workflow starts, Guard A still holds what changes things");
    await skill(s, "w1", "mmo:bugfix", "[zero-touch policy=opus-plus-flash-v38 auth=estimated] fix the bug");
    assert.ok(pipeline(s, "w1"), "the workflow runs");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: step })), "allow");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/write-provenance.mjs" --before --run-id=r1 --path=src/a.js --project-root "$(pwd)"` })), "allow");
    assert.equal(decision(await tool(s, "w1", "mcp__plugin_mmo_model-dispatch__execute_stage", { stage: "codegen" })), "allow");
    assert.equal(decision(await tool(s, "w1", "mcp__model-dispatch__log_telemetry", {})), "allow", "the server's tools under either name");
    // Zero-touch's own two step scripts, from its own folder only (they live in plugin/scripts/ambient/).
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/ambient/workflow-stopped.mjs" --reason "the person said no"` })), "allow");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/ambient/git-baseline.mjs" --dir "$(pwd)"` })), "allow");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/workflow-stopped.mjs"` })), null, "not from mmo's own folder");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `node "${scripts}/ambient/mmo-log.mjs"` })), null, "and mmo's scripts not from zero-touch's");
    assert.equal(decision(await tool(s, "w1", "Bash", { command: `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node "${scripts}/mmo-log.mjs"` })), null, "a setting in front of anything but the run-start check");
    for (const command of [`${step}; curl https://x.example`, `node "${scripts}/mmo-log.mjs" $(cat ~/.ssh/id_rsa)`, "rm -rf src", `node "/tmp/x/mmo-log.mjs"`, `node "${scripts}/ambient/hook.mjs" prompt`]) {
      assert.equal(decision(await tool(s, "w1", "Bash", { command })), null, `left to Claude Code's own rules: ${command}`);
    }
    assert.equal(decision(await tool(s, "w1", "Write", { file_path: join(s.repo, "a.js"), content: "x" })), null, "file edits keep their own prompts");
    assert.equal(decision(await tool(s, "w1", "mcp__other-server__run", {})), null);
    const other = sandbox();
    try {
      await say(other, "o1", "what does this project do?");
      assert.equal(decision(await tool(other, "o1", "Bash", { command: step })), null, "no workflow running: nothing is allowed");
    } finally { other.cleanup(); }
  } finally { s.cleanup(); }
});

test("when a workflow command loads in a zero-touch chat, Claude gets zero-touch's note beside the unchanged command: the full note for a start zero-touch made, only the early-stop step for a typed one", { skip: SKIP ?? false }, async () => {
  // Zero-touch is a strict add-on: mmo's command texts are mmo's own, so what differs in a run zero-touch started is
  // said here (lib/route-flow.mjs runNote), and a command the person typed keeps its own choices.
  const RF = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  const s = sandbox();
  try {
    await say(s, "n1", BUGFIX);
    const routed = await skill(s, "n1", "mmo:bugfix", `[zero-touch policy=opus-plus-flash-v38 auth=estimated] ${BUGFIX}`);
    assert.equal(context(routed), RF.runNote({ job: "bugfix", policy: "opus-plus-flash-v38", auth: "estimated" }));
    assert.equal(line(routed), "", "nothing for the person to read: the start line was shown with their message");
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    await say(t, "n2", `/mmo:bugfix ${BUGFIX}`);
    const typed = await skill(t, "n2", "mmo:bugfix", BUGFIX);
    assert.equal(context(typed), `${RF.STOP_NOTE}.`, "a typed command: only how to hand the chat back if it stops early");
    // Another skill of the plugin: nothing.
    assert.equal((await postSkill(t, "n2", "mmo:policy", "")).stdout, "");
  } finally { t.cleanup(); }
});

test("a conversation rewound to before its workflow started lets the workflow go, says so once, and frees the folder", { skip: SKIP ?? false }, async () => {
  const { onActiveChain } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));
  const s = sandbox();
  try {
    const transcript = join(s.dir, "r1.jsonl");
    const t0 = Date.now() - 60_000;
    const at = (ms) => new Date(t0 + ms).toISOString();
    const entries = [
      { uuid: "u1", parentUuid: null, type: "user", timestamp: at(0), message: { role: "user", content: BUGFIX } },
      { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: at(1000), message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "tu-r1", name: "Skill", input: { skill: "mmo:bugfix" } }] } },
      { uuid: "u2", parentUuid: "a1", type: "user", timestamp: at(2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-r1", content: "Launching skill" }] } },
    ];
    writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await say(s, "r1", BUGFIX, { transcript_path: transcript });
    await run("pre-skill", { session_id: "r1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX }, transcript_path: transcript }, s);
    await run("post-skill", { session_id: "r1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX }, tool_use_id: "tu-r1", transcript_path: transcript }, s);
    const since = Date.parse(pipeline(s, "r1").since);
    assert.equal(onActiveChain(transcript, "tu-r1", since), true, "the start is in the conversation");
    // A message after the start, on the same chain: the workflow carries on.
    appendFileSync(transcript, JSON.stringify({ uuid: "u3", parentUuid: "u2", type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "the brief is in brief.md" } }) + "\n");
    const ongoing = await say(s, "r1", "the brief is in brief.md", { transcript_path: transcript });
    assert.notEqual(ongoing.json?.systemMessage, L.rewound("bugfix"));
    assert.ok(pipeline(s, "r1"), "still running");
    // Rewound: the new message hangs from the first one, before the start.
    appendFileSync(transcript, JSON.stringify({ uuid: "u4", parentUuid: "u1", type: "user", timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: "user", content: "actually, explain the login code" } }) + "\n");
    assert.equal(onActiveChain(transcript, "tu-r1", since), false);
    const back = await say(s, "r1", "actually, explain the login code", { transcript_path: transcript });
    assert.equal(back.json?.systemMessage, L.rewound("bugfix"));
    assert.equal(pipeline(s, "r1"), null, "the chat is ordinary again");
    assert.equal(heldByOther(s.repo, "r2", { ...process.env, MMO_HOME: s.home }), null, "and the folder is free");
    // Unknown is never a rewind: no call id, no file, or a chain that leaves what was read.
    assert.equal(onActiveChain(join(s.dir, "none.jsonl"), "tu-r1", since), null);
    assert.equal(onActiveChain(transcript, "", since), null);
  } finally { s.cleanup(); }
});

test("a /branch of a chat whose workflow runs: the branch is told once that the workflow carries on only in the original", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "p1", BUGFIX);
    await skill(s, "p1", "mmo:bugfix", BUGFIX);
    // The branch: Claude Code starts it with source "fork"; the zero-touch plugin marks it as a branch.
    await run("session-start", { session_id: "b1", cwd: s.repo, source: "fork" }, s);
    assert.ok(existsSync(join(s.home, "sessions", "b1", "zt_forked")));
    const first = await say(s, "b1", "approved");
    assert.equal(first.json?.systemMessage, L.forkedDuringWorkflow("bugfix"));
    assert.match(first.json?.hookSpecificOutput?.additionalContext ?? "", /do not carry on any of that workflow's steps here/);
    assert.equal((await say(s, "b1", "thanks")).stdout, "", "said once");
  } finally { s.cleanup(); }
  // With no workflow running in the folder, a branch says nothing.
  const q = sandbox();
  try {
    await run("session-start", { session_id: "b2", cwd: q.repo, source: "fork" }, q);
    assert.equal((await say(q, "b2", "hello")).stdout, "");
  } finally { q.cleanup(); }
});

// In a real Claude Code transcript the entries written right after a Skill call (the skill's own text, its permissions
// attachment) carry EARLIER timestamps than the call's result, and the start is recorded later still (post-skill). A
// check that walked back and stopped at the first entry older than the start would take every workflow zero-touch
// started as "rewound" at the person's first reply. Timestamps along the chain are not ordered, so the check does not
// read them; a compaction (a boundary whose parent is empty and whose logicalParentUuid points back) is followed,
// never taken for a rewind.
test("the rewind check follows the chain, never timestamps: Claude Code's real order and a compaction are not a rewind", async () => {
  const { onActiveChain } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "zt-chain-"));
  try {
    const file = join(dir, "t.jsonl");
    const t0 = Date.parse("2026-10-01T14:07:58.000Z");
    const at = (ms) => new Date(t0 + ms).toISOString();
    const since = t0 + 900; // post-skill records the start after the call's result was written
    const real = [
      { uuid: "u1", parentUuid: null, type: "user", timestamp: at(0), message: { role: "user", content: "fix the login bug" } },
      { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: at(750), message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "mmo:bugfix" } }] } },
      { uuid: "r1", parentUuid: "a1", type: "user", timestamp: at(894), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "Launching skill" }] } },
      { uuid: "s1", parentUuid: "r1", type: "user", timestamp: at(873), message: { role: "user", content: "the skill's own text" } },
      { uuid: "s2", parentUuid: "s1", type: "user", timestamp: at(871), message: { role: "user", content: [{ type: "text", text: "args" }] } },
      { uuid: "p1", parentUuid: "s2", type: "attachment", timestamp: at(871), attachment: { type: "command_permissions" } },
      { uuid: "a2", parentUuid: "p1", type: "assistant", timestamp: at(5000), message: { role: "assistant", content: [{ type: "text", text: "What is the login bug?" }] } },
      { uuid: "u2", parentUuid: "a2", type: "user", timestamp: at(9000), message: { role: "user", content: "it returns 500" } },
    ];
    writeFileSync(file, real.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(onActiveChain(file, "tu-1", since), true, "the person's first reply: still the same conversation");
    // A compaction: a boundary with no parent, pointing back to the last entry before it.
    appendFileSync(file, [
      { uuid: "c1", parentUuid: null, logicalParentUuid: "u2", type: "system", subtype: "compact_boundary", timestamp: at(20000) },
      { uuid: "u3", parentUuid: "c1", type: "user", timestamp: at(20001), message: { role: "user", content: "summary" } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(onActiveChain(file, "tu-1", since), true, "a compaction is not a rewind");
    // A rewind: the next message hangs off an entry before the start.
    appendFileSync(file, JSON.stringify({ uuid: "u4", parentUuid: "u1", type: "user", timestamp: at(30000), message: { role: "user", content: "never mind, explain the code" } }) + "\n");
    assert.equal(onActiveChain(file, "tu-1", since), false, "rewound to before the start");
    // A chain that runs past what was read cannot be judged.
    writeFileSync(file, JSON.stringify({ uuid: "x9", parentUuid: "not-in-file", type: "user", timestamp: at(1), message: { role: "user", content: "hi" } }) + "\n");
    assert.equal(onActiveChain(file, "tu-1", since), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A chat closed in the middle of its workflow, or cleared in the desktop app (the app ends that chat's Claude Code
// process; only the terminal's own /clear sends SessionEnd "clear"), must not keep the folder locked until the 30-day
// cleanup, refusing every workflow there, typed /mmo: commands included. The lock records the owner's Claude Code
// process (CLAUDE_PID, which both builds give every hook) and stops holding when that process is gone; a chat reopened
// mid-workflow takes the lock back at its next moment.
test("the folder lock holds while the owning chat's process lives, and not after; a reopened chat takes it back", { skip: SKIP ?? false }, async () => {
  const { spawn: spawnProcess } = await import("node:child_process");
  const s = sandbox();
  const owner = spawnProcess("sleep", ["60"], { stdio: "ignore" });
  const reopened = spawnProcess("sleep", ["60"], { stdio: "ignore" });
  const as = (proc) => ({ CLAUDE_PID: String(proc.pid) });
  const prompt = (sid, text, env = {}) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++seq}` }, s, env);
  try {
    await prompt("k1", BUGFIX, as(owner));
    await run("pre-skill", { session_id: "k1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX } }, s, as(owner));
    await run("post-skill", { session_id: "k1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: BUGFIX }, tool_use_id: "tu-k1" }, s, as(owner));
    const lockFile = readdirSync(join(s.home, "projects")).map((k) => join(s.home, "projects", k, "workflow.lock", "owner.json")).find((f) => existsSync(f));
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, owner.pid, "the lock records the owner's Claude Code process");
    assert.match(line(await prompt("k2", DOCS)), /another chat in this project folder is already running a bug-fix workflow/, "held while that chat's process lives");
    assert.match(String((await prompt("k2", "/mmo:docs add jsdoc to src/cart.js")).json?.reason ?? ""), /already running a bug-fix workflow/, "a typed command waits too, while the owner lives");
    // The chat is reopened (a new process) and acts once: the lock is its own again.
    await run("pre-any", { session_id: "k1", cwd: s.repo, tool_name: "Read", tool_input: { file_path: join(s.repo, "package.json") } }, s, as(reopened));
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, reopened.pid, "a reopened chat takes its lock back");
    owner.kill();
    assert.match(line(await prompt("k3", DOCS)), /another chat in this project folder is already running a bug-fix workflow/, "the reopened process holds it");
    reopened.kill();
    await new Promise((ok) => setTimeout(ok, 200));
    assert.match(line(await prompt("k5", DOCS)), /you asked for documentation, so Claude is starting the documentation workflow/, "the chat's process is gone: a job starts its workflow");
    const typed = await prompt("k4", "/mmo:docs add jsdoc to src/cart.js");
    assert.equal(typed.json?.decision, undefined, "and a typed command runs as without zero-touch");
  } finally { owner.kill(); reopened.kill(); s.cleanup(); }
});

// In the terminal the prompt hook runs at Enter while Claude is still working, when the text is only enqueued (no user
// entry, no queued_command attachment yet). Judged as if the chat were idle, a job typed mid-turn would be misread, and
// "stop" typed mid-turn would stop the workflow at once while its helper kept writing.
test("a message still in Claude Code's input queue was typed mid-turn; an idle one was enqueued and dequeued at once", async () => {
  const { sentWhileWorking } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "zt-queue-"));
  try {
    const file = join(dir, "t.jsonl");
    const q = (operation, content) => JSON.stringify({ type: "queue-operation", operation, timestamp: new Date().toISOString(), sessionId: "s", ...(content !== undefined ? { content } : {}) });
    const user = (text) => JSON.stringify({ uuid: `u-${text.length}`, type: "user", message: { role: "user", content: text } });
    writeFileSync(file, [q("enqueue", "okay"), q("dequeue"), user("okay")].join("\n") + "\n");
    assert.equal(sentWhileWorking(file, "okay"), false, "idle: enqueued, dequeued at once, then its user entry");
    writeFileSync(file, [user("stop"), q("enqueue", "fix the login bug")].join("\n") + "\n");
    assert.equal(sentWhileWorking(file, "fix the login bug"), true, "typed at Enter mid-turn: only enqueued");
    writeFileSync(file, [q("enqueue", "stop"), q("dequeue"), user("stop"), q("enqueue", "stop")].join("\n") + "\n");
    assert.equal(sentWhileWorking(file, "stop"), true, "the same words typed idle before and mid-turn now: the queue decides");
    writeFileSync(file, [q("enqueue", "a"), q("enqueue", "b"), q("remove", "b"), q("dequeue")].join("\n") + "\n");
    assert.notEqual(sentWhileWorking(file, "b"), true, "a message removed from the queue is no longer waiting");
    assert.notEqual(sentWhileWorking(file, "a"), true, "nor one dequeued");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("\"stop\" typed while the workflow is working is carried out when the turn ends, never at once", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "m1", BUGFIX);
    await skill(s, "m1", "mmo:bugfix", BUGFIX);
    const transcript = join(s.dir, "m1.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "m1", content: "stop" }) + "\n");
    const mid = await say(s, "m1", "stop", { transcript_path: transcript });
    assert.equal(line(mid), L.stopping("bugfix"));
    assert.match(context(mid), /Do not start any more of its steps or helpers/);
    assert.ok(pipeline(s, "m1"), "not stopped yet: its helper may still be writing");
    const end = await turnEnd(s, "m1");
    assert.equal(line(end), L.stopped("bugfix", false), "stopped when the turn ends");
    assert.equal(pipeline(s, "m1"), null);
    // A job typed mid-turn in an ordinary chat joins the running task: no route, no line.
    writeFileSync(transcript, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "m2", content: DOCS }) + "\n");
    const job = await say(s, "m2", DOCS, { transcript_path: transcript });
    assert.equal(line(job), "", "typed while Claude works: not judged as a new job");
  } finally { s.cleanup(); }
});
