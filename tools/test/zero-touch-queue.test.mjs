/**
 * A second job while a workflow runs: zero-touch chats only, mmo untouched.
 *
 * Why: a chat that types /mmo:bugfix, then /mmo:docs while the bug fix is running, would start docs and drop the bug
 * fix without a word. In a zero-touch chat a new job that arrives while a workflow runs is kept: plain words, or the
 * model starting one, are queued at once; a typed /mmo: workflow command is held, and the model asks the person one
 * question, "Queue it" or "Replace it", as a multiple-choice question whose answer the hook reads exactly:
 *   - Queue it: first-in-first-out; the job starts by itself at the end of the turn in which the running
 *     workflow's own log shows it ended; a duplicate is not added; the queue ends with the chat (or /clear).
 *   - Replace it: the running workflow is stopped the way mmo's own abort stops it (its run log records the abort,
 *     a brownfield write lock of that run is switched off), then the new one starts.
 * A message typed while a workflow's question is open (a gate, or its first questions) is that question's answer,
 * never a new job. A project lock stops two chats running workflows in one project.
 *
 * Platform facts these rest on, as Claude Code behaves through the desktop app's own transport (stream-json): a
 * /command sent while Claude works waits and runs as its own turn after the running one; plain words sent while
 * Claude works join the running turn; a UserPromptSubmit "block" keeps a typed command from the
 * model and shows the person the reason; UserPromptExpansion and UserPromptSubmit of one typed command carry the
 * same prompt_id; a multiple-choice answer reaches PostToolUse as tool_response.answers[question] = label.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
// Starting a workflow asks the workflows' own model check, which needs the built server.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-queue-"));
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

let promptSeq = 0;
const say = (s, sid, text, extra = {}) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: extra.prompt_id ?? `p-${++promptSeq}`, ...extra }, s);
/** A typed command: Claude Code fires the expansion hook, then the prompt hook, with one prompt_id. */
async function typed(s, sid, line) {
  const prompt_id = `t-${++promptSeq}`;
  const name = /^\/(\S+)/.exec(line)[1];
  const exp = await run("prompt-expansion", { session_id: sid, cwd: s.repo, prompt: line, prompt_id, command_name: name, expansion_type: "slash_command" }, s);
  const sub = await run("prompt", { session_id: sid, cwd: s.repo, prompt: line, prompt_id }, s);
  return { exp, sub, prompt_id };
}
/** A Skill call as Claude Code makes it: PreToolUse, then, when the call was not refused, PostToolUse (the moment a
 * routed workflow's start is recorded). Returns the PreToolUse answer. */
const skill = async (s, sid, name, args, ...rest) => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } };
  const pre = await run("pre-skill", input, s, ...rest);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s, ...rest);
  return pre;
};
const tool = (s, sid, tool_name, tool_input = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name, tool_input }, s);
const agent = (s, sid, type) => run("pre-agent", { session_id: sid, cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: type, prompt: "x" } }, s);
const turnEnd = (s, sid, extra = {}) => run("turn-end", { session_id: sid, cwd: s.repo, stop_hook_active: false, ...extra }, s);
function answer(s, sid, label) {
  const q = choice(s, sid)?.question;
  return run("post-question", { session_id: sid, cwd: s.repo, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: q }] }, tool_response: { questions: [{ question: q }], answers: { [q]: label } } }, s);
}
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
/** The queued start a turn's end hands the model: the Stop hook's context, never a "block" reason (shown to the person as "Stop hook feedback"). */
const queuedStart = (r) => (r.json?.hookSpecificOutput?.hookEventName === "Stop" ? r.json.hookSpecificOutput.additionalContext ?? "" : "");
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === "deny";
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const read = (s, sid, name) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, name), "utf8")); } catch { return null; } };
const choice = (s, sid) => read(s, sid, "choice.json");
const queue = (s, sid) => read(s, sid, "queue.json") ?? [];
const pipelineJob = (s, sid) => read(s, sid, "pipeline")?.job ?? null;
const events = (s, sid) => readFileSync(join(s.home, "sessions", sid, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function workflowLog(s, runId, ...lines) {
  const dir = join(s.repo, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of lines) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}
const logText = (s, runId) => readFileSync(join(s.repo, ".sdlc", "runs", runId, "orchestrator.log"), "utf8");

const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const DOCS = "add jsdoc to every function in src/cart.js";
const TESTS = "write unit tests for the pricing functions in src/cart.js";

/** The orchestrator's own logging call, as agents/orchestrator.md writes it: through this chat, so it claims the run. */
const logCall = (s, sid, runId, event = "run.start") => tool(s, sid, "Bash", { command: `node "/plugin/scripts/mmo-log.mjs" --event=${event} --level=info \\\n  --run-id=${runId} --project-root "${s.repo}" --mode=brownfield` });

/** A routed bug-fix workflow, started and past its first gate: running, no question open. */
async function runningBugfix(s, sid, { gateOpen = false } = {}) {
  await say(s, sid, BUGFIX);
  assert.equal((await skill(s, sid, "mmo:bugfix", BUGFIX)).stdout, "", "the bug fix starts");
  assert.equal((await logCall(s, sid, `bf-${sid}`)).stdout, "", "the logging call runs untouched");
  workflowLog(s, `bf-${sid}`, ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0", title: "scope" }]);
  if (!gateOpen) workflowLog(s, `bf-${sid}`, ["gate.resolved", { gate: "gate-0", response: "approved" }]);
}
const endBugfix = (s, sid) => workflowLog(s, `bf-${sid}`, ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);

test("plain words for a new job while a workflow runs: queued at once and said at once; no box, nothing held", { skip: SKIP ?? false }, async () => {
  // The Queue-or-Replace box cannot show for plain words: a running workflow is either working, when the message joins
  // Claude's turn, or waiting at a step, when the message is its answer. The box is for a command the person types
  // (below); plain words are queued directly.
  const s = sandbox();
  try {
    await runningBugfix(s, "q1");
    const r = await say(s, "q1", DOCS);
    assert.equal(r.json?.systemMessage, "Zero-touch: noted. The documentation workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.");
    assert.match(context(r), /Zero-touch has queued it/);
    assert.doesNotMatch(context(r), /mmo:/, "no command name for the person to repeat");
    assert.equal(choice(s, "q1"), null, "no box");
    assert.deepEqual(queue(s, "q1").map((q) => [q.job, q.args]), [["docs", DOCS]]);
    for (const t of ["Write", "Bash", "Edit"]) assert.equal((await tool(s, "q1", t)).stdout, "", `${t} runs: nothing is held`);
    assert.equal((await agent(s, "q1", "mmo:orchestrator")).stdout, "", "the running workflow's helpers run");
  } finally { s.cleanup(); }
});

test("a message typed while the workflow's question is open is its answer, never a new job", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q2", { gateOpen: true });
    const r = await say(s, "q2", DOCS);
    assert.equal(context(r), "", "gate 0 is open: the message answers it, and nothing is added for the model");
    assert.equal(r.json?.hookSpecificOutput, undefined);
    assert.equal(choice(s, "q2"), null);
  } finally { s.cleanup(); }
});

test("Queue it: the job waits; it starts by itself at the end of the turn in which the running workflow ended", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q3");
    const a = await say(s, "q3", DOCS); // queued at once: no box to answer
    assert.match(context(a), /queued/i);
    assert.equal(choice(s, "q3"), null, "no question");
    assert.deepEqual(queue(s, "q3").map((q) => q.job), ["docs"]);
    assert.equal((await tool(s, "q3", "Bash")).stdout, "", "the running workflow carries on");
    assert.equal((await turnEnd(s, "q3")).stdout, "", "the bug fix is still running: nothing starts");
    endBugfix(s, "q3");
    const e = await turnEnd(s, "q3");
    assert.equal(e.json?.decision, undefined, "no block reason for the person to read");
    assert.match(queuedStart(e), /Skill tool/, "the turn continues with the queued job");
    assert.match(queuedStart(e), /"mmo:docs"/);
    assert.ok(denied(await tool(s, "q3", "Write")), "Guard A: nothing else first");
    assert.equal((await skill(s, "q3", "mmo:docs", DOCS)).stdout, "", "the queued workflow starts");
    assert.equal(pipelineJob(s, "q3"), "docs");
    assert.deepEqual(queue(s, "q3"), [], "it left the queue when it started");
  } finally { s.cleanup(); }
});

test("the queue is first-in-first-out and a duplicate is not added", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q4");
    await say(s, "q4", DOCS); // queued at once
    await say(s, "q4", TESTS);
    const dup = await say(s, "q4", DOCS);
    assert.match(dup.json?.systemMessage ?? "", /already queued/i);
    assert.deepEqual(queue(s, "q4").map((q) => q.job), ["docs", "test"]);
    endBugfix(s, "q4");
    assert.match(queuedStart(await turnEnd(s, "q4")), /"mmo:docs"/, "first in, first out");
    await skill(s, "q4", "mmo:docs", DOCS);
    workflowLog(s, "docs-1", ["run.start", {}], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.match(queuedStart(await turnEnd(s, "q4")), /"mmo:test"/, "then the next one");
  } finally { s.cleanup(); }
});

test("a queued start the model does not make is not pushed again in a loop; the person is told, and \"yes\" starts it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q5");
    await say(s, "q5", DOCS);
    endBugfix(s, "q5");
    assert.match(queuedStart(await turnEnd(s, "q5")), /"mmo:docs"/);
    const again = await turnEnd(s, "q5", { stop_hook_active: true });
    assert.equal(queuedStart(again), "", "not pushed again: the turn is allowed to end");
    assert.match(again.json?.systemMessage ?? "", /the documentation workflow didn't start\. Say "yes" to start it now/, "never dropped silently (the outcome contract)");
    assert.deepEqual(queue(s, "q5"), [], "it left the queue");
    assert.equal((await tool(s, "q5", "Write")).stdout, "", "nothing stays blocked");
    assert.match(context(await say(s, "q5", "yes")), /"mmo:docs"/, "the person's yes starts it");
  } finally { s.cleanup(); }
});

// "abort" at an approval step (mmo's own stop), a failed run, or a run that stopped before it began never starts the
// queued job, and no line says the workflow "has finished".
const DROPPED = (what) => `Zero-touch: the bug-fix workflow ${what}. From here, asking for another job starts a new workflow; anything else gets a normal answer. The documentation workflow you queued was not started; ask for it again when you want it.`;

test("a queued job starts only after the running workflow finished: aborted at an approval step or failed, the queue is dropped and said", { skip: SKIP ?? false }, async () => {
  for (const [sid, end, what] of [
    ["qa", [["gate.open", { gate: "gate-1" }], ["gate.resolved", { gate: "gate-1", response: "abort" }]], "was stopped"],
    ["qf", [["run.end", { outcome: "failed" }]], "stopped because of a problem; Claude's last reply says what happened"],
  ]) {
    const s = sandbox();
    try {
      await runningBugfix(s, sid);
      await say(s, sid, DOCS);
      assert.deepEqual(queue(s, sid).map((q) => q.job), ["docs"]);
      if (sid === "qa") {
        workflowLog(s, `bf-${sid}`, end[0]);
        assert.equal((await say(s, sid, "abort")).stdout, "", "at an approval step \"abort\" is the workflow's own answer");
        workflowLog(s, `bf-${sid}`, end[1]);
      } else workflowLog(s, `bf-${sid}`, ...end);
      const r = await turnEnd(s, sid);
      assert.equal(r.json?.systemMessage, DROPPED(what), sid);
      assert.equal(queuedStart(r), "", "nothing is started after a workflow that did not finish");
      assert.deepEqual(queue(s, sid), []);
      assert.equal(read(s, sid, "route.json"), null);
      assert.equal((await turnEnd(s, sid)).stdout, "", "said once");
    } finally { s.cleanup(); }
  }
});

test("a queue dropped while the turn was cut off (no Stop hook) is said at the person's next message, once", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "qc");
    await say(s, "qc", DOCS);
    workflowLog(s, "bf-qc", ["gate.open", { gate: "gate-1" }], ["gate.resolved", { gate: "gate-1", response: "abort" }]);
    // No turn-end: the person pressed Esc. Their next message ends the run and says what was dropped.
    const r = await say(s, "qc", "what does the cart total function return?");
    assert.equal(r.json?.systemMessage, DROPPED("was stopped"));
    assert.deepEqual(queue(s, "qc"), []);
    assert.equal((await turnEnd(s, "qc")).stdout, "", "nothing starts at the turn's end");
    assert.equal((await say(s, "qc", "and the tax function?")).stdout, "", "said once");
  } finally { s.cleanup(); }
});

test("a typed command queued with Queue it is pushed again exactly as typed: no zero-touch tag, no \"do not ask\"", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "qt", { gateOpen: true });
    await typed(s, "qt", `/mmo:docs ${DOCS}`);
    await answer(s, "qt", "Queue it");
    await turnEnd(s, "qt");
    workflowLog(s, "bf-qt", ["gate.resolved", { gate: "gate-0", response: "approved" }]);
    endBugfix(s, "qt");
    const first = queuedStart(await turnEnd(s, "qt"));
    assert.ok(first.includes(`skill "mmo:docs", args ${JSON.stringify(DOCS)}`), first);
    // Claude did not make the call, and Claude Code did not mark the next stop as a hook's: the one retry.
    const again = queuedStart(await turnEnd(s, "qt"));
    assert.ok(again.includes(`skill "mmo:docs", args ${JSON.stringify(DOCS)}, exactly as they typed it`), again);
    assert.doesNotMatch(again, /\[zero-touch|do not ask|chose a full workflow/i);
  } finally { s.cleanup(); }
});

// mmo logs run.end right before its final report and opens its final acceptance gate after the report, often from a
// helper working in the background while the chat's own turns end. A queued job waits for that final answer.
test("a queued job waits through the running workflow's final report and final approval, in mmo's own order of log lines", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "qr");
    await say(s, "qr", DOCS);
    assert.deepEqual(queue(s, "qr").map((q) => q.job), ["docs"]);
    workflowLog(s, "bf-qr", ["gate.open", { gate: "gate-3" }], ["gate.resolved", { gate: "gate-3", response: "approved" }],
      ["phase.start", { phase: "generate_final_report" }], ["run.end", { outcome: "completed", total_cost_usd: 0.65 }]);
    const mid = await turnEnd(s, "qr");
    assert.equal(mid.stdout, "", "still writing its final report: nothing starts, nothing is said");
    assert.equal(pipelineJob(s, "qr"), "bugfix");
    workflowLog(s, "bf-qr", ["phase.end", { phase: "generate_final_report" }], ["gate.open", { gate: "gate-4", title: "Final Acceptance" }]);
    assert.equal((await turnEnd(s, "qr")).stdout, "", "waiting for the final answer: nothing starts");
    assert.deepEqual(queue(s, "qr").map((q) => q.job), ["docs"]);
    workflowLog(s, "bf-qr", ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    const end = await turnEnd(s, "qr");
    assert.match(end.json?.systemMessage ?? "", /the bug-fix workflow has finished, so the documentation workflow you queued is starting now/);
    assert.match(queuedStart(end), /"mmo:docs"/);
  } finally { s.cleanup(); }
});

test("a finished workflow's late log lines are never taken for the next workflow's run; the next run's own start is", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "qn");
    await say(s, "qn", DOCS);
    endBugfix(s, "qn");
    assert.match(queuedStart(await turnEnd(s, "qn")), /"mmo:docs"/);
    assert.equal((await skill(s, "qn", "mmo:docs", DOCS)).stdout, "", "the queued documentation workflow starts");
    // The bug fix's run, which started before this workflow, logs one more line (its close-out, from a helper).
    await logCall(s, "qn", "bf-qn", "phase.end");
    assert.equal(read(s, "qn", "pipeline")?.run_id, undefined, "not claimed: an earlier workflow's run");
    await logCall(s, "qn", "docs-qn", "run.start");
    assert.equal(read(s, "qn", "pipeline")?.run_id, "docs-qn", "the documentation workflow's own run is claimed");
  } finally { s.cleanup(); }
});

test("Replace it: the running workflow is stopped as mmo's own abort stops it, then the new one starts", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q6");
    mkdirSync(join(s.repo, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: "bf-q6", strict: true, allowlist: ["src/**"], off_limits: [] }));
    // The box is raised by a command the person types (plain words are queued directly).
    await typed(s, "q6", `/mmo:docs ${DOCS}`);
    const a = await answer(s, "q6", "Replace it");
    assert.match(logText(s, "bf-q6"), /run\.end run_id=bf-q6 outcome=aborted/, "the run's own log records the abort");
    assert.equal(JSON.parse(readFileSync(join(s.repo, ".sdlc", "local", "write-contract.json"), "utf8")).active, false, "its write lock is switched off, as mmo's abort does");
    assert.match(context(a), /Carry on with the command the person typed/, "the typed command carries on as the new workflow");
    assert.equal(pipelineJob(s, "q6"), "docs");
    assert.ok(events(s, "q6").some((e) => e.type === "route.replaced"));
  } finally { s.cleanup(); }
});

test("a write lock of another run is left alone by a replace", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q7");
    mkdirSync(join(s.repo, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "someone-else", allowlist: [], off_limits: [] }));
    await typed(s, "q7", `/mmo:docs ${DOCS}`);
    await answer(s, "q7", "Replace it");
    assert.equal(JSON.parse(readFileSync(join(s.repo, ".sdlc", "local", "write-contract.json"), "utf8")).active, true);
  } finally { s.cleanup(); }
});

test("a typed /mmo: workflow command while one runs gets the same question; its text stays with the model", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q8", { gateOpen: true });
    const { exp, sub } = await typed(s, "q8", `/mmo:docs ${DOCS}`);
    assert.equal(exp.stdout, "", "the expansion hook is not zero-touch's any more: the prompt hook decides");
    assert.match(context(sub), /"Queue it"/, "a typed command is never a gate's answer: the question is asked");
    assert.equal(choice(s, "q8").via, "typed");
    assert.equal(events(s, "q8").filter((e) => e.type === "route.ask").length, 1, "one typed command, one question");
    assert.ok(denied(await tool(s, "q8", "Bash")));
  } finally { s.cleanup(); }
});

test("typed, then Queue it: nothing of the typed command runs this turn; the hold ends with the turn", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q9", { gateOpen: true });
    await typed(s, "q9", `/mmo:docs ${DOCS}`);
    const a = await answer(s, "q9", "Queue it");
    assert.match(context(a), /Do not run the command/i);
    const b = await tool(s, "q9", "Bash");
    assert.ok(denied(b) && /queued/i.test(reason(b)), "the command's own steps may not run now");
    assert.ok(denied(await agent(s, "q9", "mmo:orchestrator")));
    await turnEnd(s, "q9");
    assert.equal((await tool(s, "q9", "Bash")).stdout, "", "the hold ended with the turn");
    assert.deepEqual(queue(s, "q9").map((q) => [q.job, q.args]), [["docs", DOCS]]);
  } finally { s.cleanup(); }
});

test("typed, then Replace it: the old run is aborted and the typed command carries on as the chat's workflow", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q10", { gateOpen: true });
    await typed(s, "q10", `/mmo:docs ${DOCS}`);
    const a = await answer(s, "q10", "Replace it");
    assert.match(logText(s, "bf-q10"), /outcome=aborted/);
    assert.match(context(a), /Carry on with the command the person typed/);
    assert.equal(pipelineJob(s, "q10"), "docs");
    assert.equal((await agent(s, "q10", "mmo:orchestrator")).stdout, "", "the new workflow's helpers run");
    assert.equal((await tool(s, "q10", "Bash")).stdout, "");
  } finally { s.cleanup(); }
});

test("the model starting a second workflow by itself mid-run is refused, and the job is queued (no box)", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q11");
    const r = await skill(s, "q11", "mmo:docs", DOCS);
    assert.ok(denied(r));
    assert.match(context(r), /Zero-touch has queued it/);
    assert.equal(reason(r), "Zero-touch: noted. The documentation workflow will start by itself when the bug-fix workflow finishes, and it will wait for your approval at its first main step.", "the person reads the plain line");
    assert.deepEqual(queue(s, "q11").map((q) => q.job), ["docs"]);
    assert.equal((await skill(s, "q11", "mmo:brownfield-guide")).stdout, "", "the workflow's own manual still loads");
  } finally { s.cleanup(); }
});

test("an answer that is neither drops the question and starts nothing; so does a new message", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q12");
    await typed(s, "q12", `/mmo:docs ${DOCS}`);
    const a = await answer(s, "q12", "hmm, not now");
    assert.match(context(a), /neither/i);
    assert.equal(choice(s, "q12"), null);
    assert.deepEqual(queue(s, "q12"), []);
    await typed(s, "q12", `/mmo:docs ${DOCS}`);
    await turnEnd(s, "q12");
    await say(s, "q12", "what does the checkout do?");
    assert.equal(choice(s, "q12"), null, "a question belongs to one message");
    assert.equal((await tool(s, "q12", "Bash")).stdout, "");
  } finally { s.cleanup(); }
});

test("a person who types the answer instead of clicking it is understood only when they type an option exactly", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q13");
    await typed(s, "q13", `/mmo:docs ${DOCS}`);
    await turnEnd(s, "q13");
    const r = await say(s, "q13", "Queue it.");
    assert.match(context(r), /queued/i);
    assert.deepEqual(queue(s, "q13").map((q) => q.job), ["docs"]);
  } finally { s.cleanup(); }
});

test("/clear ends the queue and any open question with the conversation", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q14");
    await say(s, "q14", DOCS);
    await answer(s, "q14", "Queue it");
    await say(s, "q14", TESTS);
    await run("session-start", { session_id: "q14", cwd: s.repo, source: "clear" }, s);
    assert.deepEqual(queue(s, "q14"), []);
    assert.equal(choice(s, "q14"), null);
  } finally { s.cleanup(); }
});

test("a project lock: a second chat cannot start a workflow in a project where another chat runs one", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "owner");
    const c = context(await say(s, "other", TESTS));
    assert.doesNotMatch(c, /"mmo:test"/, "not started");
    assert.match(c, /another chat/i);
    const t = await typed(s, "other", `/mmo:docs ${DOCS}`);
    assert.equal(t.sub.json?.decision, "block", "a typed command is kept from the model");
    assert.match(t.sub.json?.reason ?? "", /another chat/i);
    endBugfix(s, "owner");
    assert.match(context(await say(s, "other", TESTS)), /"mmo:test"/, "once that workflow has ended, the project is free");
  } finally { s.cleanup(); }
});

test("a lock left by a chat that was cleared does not hold the project", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "gone");
    await run("session-start", { session_id: "gone", cwd: s.repo, source: "clear" }, s);
    assert.match(context(await say(s, "next", TESTS)), /"mmo:test"/);
  } finally { s.cleanup(); }
});

test("a typed non-workflow command (setup, policy, revert) never makes the chat a workflow run", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await typed(s, "q15", "/mmo:setup");
    assert.equal(pipelineJob(s, "q15"), null);
    assert.equal((await skill(s, "q15", "mmo:setup")).stdout, "", "the typed command itself runs");
    assert.match(context(await say(s, "q15", TESTS)), /"mmo:test"/, "the next job message routes as usual");
  } finally { s.cleanup(); }
});

test("a chat without zero-touch is untouched: a second typed command gets no question and no lock", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const off = (event, payload) => runOnce(event, payload, s);
    assert.equal((await off("prompt", { session_id: "plain", cwd: s.repo, prompt: "/mmo:bugfix x", prompt_id: "a" })).stdout, "");
    assert.equal((await off("prompt", { session_id: "plain", cwd: s.repo, prompt: "/mmo:docs y", prompt_id: "b" })).stdout, "");
    assert.ok(!existsSync(join(s.home, "sessions", "plain")));
  } finally { s.cleanup(); }
});

test("every command the plugin ships is either a workflow or a one-off tool", async () => {
  const { readdirSync } = await import("node:fs");
  const { WORKFLOW_COMMANDS, ONE_OFF_COMMANDS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "commands.mjs"));
  const shipped = readdirSync(join(ROOT, "plugin", "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual([...WORKFLOW_COMMANDS, ...ONE_OFF_COMMANDS].sort(), shipped, "a new command must be classified before it ships");
});

test("Replace it stops only the run this chat claimed: another chat's run, started later in the same folder, is left alone", { skip: SKIP ?? false }, async () => {
  // Picking the run by time (the latest since the chat's start) would stop a run another chat started later in the
  // folder (a chat without zero-touch takes no project lock).
  const s = sandbox();
  try {
    await runningBugfix(s, "q11");
    await new Promise((r) => setTimeout(r, 20));
    workflowLog(s, "other-chat-run", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }]);
    await typed(s, "q11", `/mmo:docs ${DOCS}`);
    await answer(s, "q11", "Replace it");
    assert.match(logText(s, "bf-q11"), /outcome=aborted/, "this chat's own run is stopped");
    assert.doesNotMatch(logText(s, "other-chat-run"), /run\.end/, "the other chat's run is untouched");
  } finally { s.cleanup(); }
});

test("Replace it with no claim (a run id left as a shell variable): the run found by time is stopped unless another chat claimed it", { skip: SKIP ?? false }, async () => {
  // Stopping only a claimed run would leave such a run's log open and its write lock on, while the person reads that
  // it was stopped. So with no claim of its own, "Replace it" takes the run found by time, but never a run another
  // chat has claimed as its own.
  const s = sandbox();
  try {
    await say(s, "q12", BUGFIX);
    await skill(s, "q12", "mmo:bugfix", BUGFIX);
    assert.equal((await tool(s, "q12", "Bash", { command: 'node /p/scripts/mmo-log.mjs --event=run.start --run-id="$RUN_ID"' })).stdout, "", "not claimed");
    workflowLog(s, "unclaimed", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "approved" }]);
    mkdirSync(join(s.repo, ".sdlc", "local"), { recursive: true });
    const contract = join(s.repo, ".sdlc", "local", "write-contract.json");
    writeFileSync(contract, JSON.stringify({ schema_version: 1, active: true, run_id: "unclaimed", allowlist: ["src/**"], off_limits: [] }));
    await typed(s, "q12", `/mmo:docs ${DOCS}`);
    const a = await answer(s, "q12", "Replace it");
    assert.match(logText(s, "unclaimed"), /run\.end run_id=unclaimed outcome=aborted/, "stopped, as before");
    assert.equal(JSON.parse(readFileSync(contract, "utf8")).active, false, "its write lock is off");
    assert.match(context(a), /Carry on with the command the person typed/, "the new workflow carries on");
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    // This chat's run is unclaimed, and the newest run in the folder is one another chat's record names as its own
    // (built directly: the project lock keeps two zero-touch chats from running at once, so this is the rare case of a
    // record another chat has not yet cleaned up). With no claim of its own, this chat stops nothing.
    await say(t, "q13b", BUGFIX);
    await skill(t, "q13b", "mmo:bugfix", BUGFIX);
    await new Promise((r) => setTimeout(r, 20));
    workflowLog(t, "theirs", ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "approved" }]);
    mkdirSync(join(t.home, "sessions", "other"), { recursive: true });
    writeFileSync(join(t.home, "sessions", "other", "pipeline"), JSON.stringify({ since: new Date().toISOString(), job: "docs", args: "", run_id: "theirs" }));
    await typed(t, "q13b", `/mmo:docs ${DOCS}`);
    await answer(t, "q13b", "Replace it");
    assert.doesNotMatch(logText(t, "theirs"), /run\.end/, "the other chat's claimed run is untouched");
  } finally { t.cleanup(); }
});

test("the chat's workflow is read from its claimed run: another run in the folder ending does not end it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "q13");
    await new Promise((r) => setTimeout(r, 20));
    workflowLog(s, "later-run", ["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    await turnEnd(s, "q13");
    assert.equal(pipelineJob(s, "q13"), "bugfix", "this chat's workflow still runs");
    endBugfix(s, "q13");
    await turnEnd(s, "q13");
    assert.equal(pipelineJob(s, "q13"), null, "its own run's end ends it");
  } finally { s.cleanup(); }
});
