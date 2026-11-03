/**
 * The thinking worker (worker/thinking_worker.py) against the scripted stand-in SDK, the model's tool calls running
 * the step's real tools (scripts/thinking-tools.mjs). Pinned: the step's summary (done, what is owed, what was
 * accepted, the conversation's own id) is kept whatever the worker's exit, so a step whose every piece was accepted
 * is not lost to a stop on its last turn; and a nudge carries on the same conversation by the SDK's own id, never by
 * the newest file in the save folder. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NO_PYTHON, RAISE_429_UNREACHABLE, TEXT_429_RETRY, TEXT_429_UNREACHABLE, runWorker, step, tail, textAnswer } from "./agyStandin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const REQUIREMENTS = { content: "# Requirements\n\n- FR-1: answer ping with pong.\n" };

test("a step whose every piece was accepted keeps its summary when its worker stops on its own budget", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // The model hands its requirements in, then its next call is out and never answered: the worker stops at its time.
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w1") },
    { at: 0, usage: { prompt_token_count: 10, candidates_token_count: 5 } },
    { at: 0, hold: true },
  ]] }] };
  const r = await runWorker("thinking", { script, timeout: 3, args: ["--stall-sec", "2", "--stall-tries", "1", "--busy-budget-sec", "1"], limitMs: 45_000 });
  assert.notEqual(r.code, 0, `the worker reports its stop: ${tail(r)}`);
  assert.ok(r.summary, `the summary is kept whatever the exit: ${tail(r)}`);
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.deepEqual(r.summary.accepted, ["requirements"]);
  assert.equal(r.summary.conversation_id, "standin-1", "the conversation, by the SDK's own id");
  assert.ok(r.log.some((e) => e.ev === "tool_run" && e.name === "write_requirements"), "the model's call ran the step's real tool");
  assert.equal(r.summary.reason, "done", "every piece was accepted: the step is done, whatever ended its last turn");
  // The same stop with the piece still owed: the step stopped on its own work time, and its summary and its failed
  // line say so (review: the stop did not say which limit was hit).
  const owed = await runWorker("thinking", { script: { sessions: [{ turns: [[
    { at: 0, step: step.tool("read_file", "ACTIVE", { path: "brief.md" }, "r1") },
    { at: 0, usage: { prompt_token_count: 10, candidates_token_count: 5 } },
    { at: 0, hold: true },
  ]] }] }, timeout: 3, args: ["--stall-sec", "2", "--stall-tries", "1", "--busy-budget-sec", "1"], limitMs: 45_000 });
  assert.notEqual(owed.code, 0, tail(owed));
  assert.equal(owed.summary.done, false, JSON.stringify(owed.summary));
  assert.equal(owed.summary.reason, "budget", JSON.stringify(owed.summary));
  assert.match(owed.stderr, /thinking_worker failed: the step's own work time reached its limit, 3 s \(thinking_timeout_sec\); still owed: requirements\.md \(write_requirements\)/);
});

test("a nudge carries on the same conversation, by the SDK's own id", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // The first turn hands nothing in; the worker nudges it in the same conversation, and the second turn hands it in.
  const script = { sessions: [
    { turns: [textAnswer(0, "I have read the brief.", { prompt_token_count: 10 })] },
    { turns: [[
      { at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w2") },
      ...textAnswer(0, "Handed in.", { prompt_token_count: 10 }),
    ]] },
  ] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000 });
  assert.equal(r.code, 0, tail(r));
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.equal(r.sessions.length, 2, "one nudge");
  assert.equal(r.sessions[1].conversation_id, "standin-1", "the nudge resumed the first conversation by its id");
  assert.match(r.chats[1].message, /Not done yet\. Still owed: /);
});

// A greenfield architect's build-spec sections, as the spec store takes them.
const header = {
  stack: ["Python 3.13", "FastAPI", "pytest"],
  commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
  no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
  shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
};
const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour: `writes ${path}`, depends_on: [], style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });

// E-thinking-no-cap. Review: a fixed cap of 8 reminders stopped a step that still had budget, and the stop did not say
// which limit was hit. There is no fixed number of turns, as there is none for the Claude helper (design 7.5).
test("a step that answers three reminders in a row with nothing stops there: four turns, and its summary says why", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // Every turn answers text and hands nothing in.
  const script = { sessions: [{ turns: [textAnswer(0, "I have read the brief.", { prompt_token_count: 10 })] }] };
  const r = await runWorker("thinking", { script, timeout: 60, limitMs: 45_000 });
  assert.notEqual(r.code, 0, `the worker reports the stop: ${tail(r)}`);
  assert.equal(r.sessions.length, 4, "the first turn, then three reminders answered without progress");
  assert.equal(r.summary.done, false);
  assert.equal(r.summary.reason, "no_progress", JSON.stringify(r.summary));
  assert.deepEqual(r.summary.missing, ["requirements.md (write_requirements)"]);
  assert.match(r.stderr, /thinking_worker failed: the step made no progress for 3 turns in a row; still owed: requirements\.md \(write_requirements\)/);
});

test("a step that makes progress on every turn is not stopped by a count of turns: eleven turns, then done", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // A Gemini architect that hands one piece in per turn: the header, nine units files, then finalize.
  const turn = (call, id) => ({ turns: [[{ at: 0, step: step.tool(call.name, "ACTIVE", call.args, id) }, ...textAnswer(0, `Handed in ${id}.`, { prompt_token_count: 10 })]] });
  const sessions = [
    turn({ name: "submit_section", args: { name: "header.json", section_json: JSON.stringify(header) } }, "h"),
    ...Array.from({ length: 9 }, (_, i) => turn({ name: "submit_section", args: { name: `units-00${i + 1}.json`, section_json: JSON.stringify([unit(`U0${i + 1}`, `backend/app/m${i + 1}.py`)]) } }, `u${i + 1}`)),
    turn({ name: "finalize", args: {} }, "f"),
  ];
  const r = await runWorker("thinking", { script: { sessions }, timeout: 120, limitMs: 50_000, role: "architect", outputs: { sections_dir: "out/spec.sections" }, config: { spec_dir: "out", run_token: "run-1" } });
  assert.equal(r.code, 0, tail(r));
  assert.equal(r.sessions.length, 11, "each turn handed a piece in, so none was a turn without progress");
  assert.deepEqual(r.log.filter((e) => e.ev === "tool_run").map((e) => e.result.split(":")[0]), ["accepted header.json", ...Array.from({ length: 9 }, (_, i) => `accepted units-00${i + 1}.json`), "finalized"]);
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.equal(r.summary.reason, "done");
});

test("a step the engine stops, and one whose call ends with an error Google's busy window does not cover, each say so", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // A call that is out and never answered, then the engine's SIGTERM.
  const stopped = await runWorker("thinking", { script: { sessions: [{ turns: [[{ at: 0, hold: true }]] }] }, timeout: 30, limitMs: 45_000, killAfterMs: 1500 });
  assert.notEqual(stopped.code, 0, tail(stopped));
  assert.equal(stopped.summary?.reason, "stopped", JSON.stringify(stopped.summary));
  assert.match(stopped.stderr, /thinking_worker failed: the worker was stopped; still owed: requirements\.md \(write_requirements\)/);
  const refused = await runWorker("thinking", { script: { sessions: [{ turns: [[{ at: 0, step: step.error(400, "Error 400: the request is invalid") }, { at: 0.01, raise: "AntigravityConnectionError", message: "400: the request is invalid" }]] }] }, timeout: 30, limitMs: 45_000, args: ["--busy-window-sec", "30"] });
  assert.notEqual(refused.code, 0, tail(refused));
  assert.equal(refused.sessions.length, 1, "not a wait for Google: the step ends at once");
  assert.equal(refused.summary?.reason, "error", JSON.stringify(refused.summary));
  assert.match(refused.stderr, /thinking_worker failed: the model's call ended with an error: .*the request is invalid.*; still owed: requirements\.md/);
});

test("a revise through the worker: an unchanged section goes by its name alone, and finalize's drop removes a unit by id", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const { loadServerLib } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "server-lib.mjs")).href);
  const { specStore } = await loadServerLib();
  // The spec the person reviewed: this run's first call handed in two units files and finalized.
  const approved = (work) => {
    const specDir = join(work, "out");
    assert.equal(specStore.submitSpecSection(specDir, { section: "header", header }, { run: "run-1" }).ok, true);
    assert.equal(specStore.submitSpecSection(specDir, { section: "units", units: [unit("U01", "backend/app/models.py")] }, { run: "run-1" }).ok, true);
    assert.equal(specStore.submitSpecSection(specDir, { section: "units", units: [unit("U02", "backend/app/api.py")] }, { run: "run-1" }).ok, true);
    assert.equal(specStore.finalizeSpec(specDir).ok, true);
    mkdirSync(join(specDir, "spec.sections"));
    writeFileSync(join(specDir, "spec.sections", "units-001.json"), JSON.stringify([unit("U01", "backend/app/models.py")]));
  };
  // The revise removes U02: the header again, U01's file by its name alone, then finalize naming U02.
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("submit_section", "ACTIVE", { name: "header.json", section_json: JSON.stringify(header) }, "s1") },
    { at: 0, step: step.tool("submit_section", "ACTIVE", { name: "units-001.json" }, "s2") },
    { at: 0, step: step.tool("finalize", "ACTIVE", { drop: ["U02"] }, "f1") },
    ...textAnswer(0, "Revised.", { prompt_token_count: 10 }),
  ]] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, role: "architect", outputs: { sections_dir: "out/spec.sections" }, config: { spec_dir: "out", run_token: "run-1", revise: true }, setup: approved });
  assert.equal(r.code, 0, tail(r));
  const ran = r.log.filter((e) => e.ev === "tool_run");
  assert.deepEqual(ran.map((e) => e.name), ["submit_section", "submit_section", "finalize"]);
  assert.match(ran[1].result, /accepted units-001\.json: 1 unit/, "the file went as it stands");
  assert.match(ran[2].result, /finalized: 1 unit.*removed from the approved spec: U02/);
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
});

test("an acceptance fix through the worker: the failures entries go in as one hand-in, and the step is done", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const entries = [{ path: "package.json", problem: "set overrides.semver to 7.6.3: the audit's high advisory" }];
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("write_acceptance_fix", "ACTIVE", { failures_json: JSON.stringify(entries) }, "a1") },
    ...textAnswer(0, "Handed in.", { prompt_token_count: 10 }),
  ]] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, role: "architect", outputs: { acceptance_fix: "out/acceptance-fix.json" }, config: { spec_dir: "out", run_token: "run-1", acceptance_fix: true } });
  assert.equal(r.code, 0, tail(r));
  const ran = r.log.filter((e) => e.ev === "tool_run");
  assert.deepEqual(ran.map((e) => e.name), ["write_acceptance_fix"]);
  assert.match(ran[0].result, /accepted: 1 failures entr/);
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.deepEqual(r.summary.accepted, ["acceptance_fix"]);
});

// E-thinking-busy. As a batch waits out a busy model for a typing call (busyLedger.ts), a thinking step waits and carries
// on its own conversation, in the same worker and with its tools' state, while the run's busy window is open.
const READ_THEN_REFUSED = [
  { at: 0, step: step.tool("read_file", "ACTIVE", { path: "brief.md" }, "r1") },
  { at: 0.02, usage: { prompt_token_count: 10, candidates_token_count: 2 } },
  { at: 0.05, step: step.tool("read_file", "DONE", { path: "brief.md" }, "r1") },
  { at: 0.1, step: step.error(429, TEXT_429_RETRY) },
  { at: 0.15, step: step.error(429, TEXT_429_UNREACHABLE) },
  { at: 0.16, raise: RAISE_429_UNREACHABLE.raise, message: RAISE_429_UNREACHABLE.message },
];
const BUSY = ["--busy-budget-sec", "1", "--api-retries", "1", "--api-retry-initial-ms", "1000"];

test("a call Google could not serve is waited out: the step carries on its own conversation while the run's busy window is open", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const script = { sessions: [
    { turns: [READ_THEN_REFUSED] },
    { turns: [[{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w1") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })]] },
  ] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, args: [...BUSY, "--busy-window-sec", "30"] });
  assert.equal(r.code, 0, tail(r));
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[1].conversation_id, "standin-1", "the step's own conversation, carried on");
  assert.equal(r.chats[1].message, "Please continue the task you were working on.");
  assert.deepEqual(r.sidecar.tries.map((t) => t.ended_by), ["refused", "answer"]);
  assert.equal(r.sidecar.unavailable, undefined, "served again: the step answered");
});

test("past the run's busy window the step ends unavailable, naming when its unserved stretch began; without a window it ends at once", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const refusedAgain = { sessions: [{ turns: [READ_THEN_REFUSED] }, { turns: [READ_THEN_REFUSED.slice(3)] }, { turns: [READ_THEN_REFUSED.slice(3)] }] };
  const r = await runWorker("thinking", { script: refusedAgain, timeout: 30, limitMs: 45_000, args: [...BUSY, "--busy-window-sec", "1"] });
  assert.notEqual(r.code, 0, tail(r));
  assert.equal(r.sessions.length, 2, "one wait, one carry-on, then the window had passed");
  const sc = r.sidecar;
  assert.match(String(sc.unavailable), /refused/);
  const since = Date.parse(sc.unserved_since);
  assert.ok(since >= Date.parse(sc.tries[0].started_at) && since < Date.parse(sc.tries[1].started_at), `the stretch began with the first refused call: ${sc.unserved_since} ${JSON.stringify(sc.tries.map((t) => t.started_at))}`);
  assert.equal(r.summary.done, false);
  assert.equal(r.summary.reason, "busy");
  const once = await runWorker("thinking", { script: refusedAgain, timeout: 30, limitMs: 45_000, args: BUSY });
  assert.notEqual(once.code, 0);
  assert.equal(once.sessions.length, 1, "no busy window given: the worker does not wait");
  assert.equal(once.summary.reason, "busy");
});

// E-thinking-no-conversation-id. Review: when the SDK reports no conversation id after a turn, the next session opens a
// new conversation, and a reminder sent there held only "Not done yet. Still owed: …", with no task.
test("without the SDK's conversation id a later turn opens a new conversation, so it carries the task, then what is owed", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const brief = "Write requirements.md for a ping service.";
  const handIn = [{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w3") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })];
  // A reminder after a turn that handed nothing in.
  const reminded = await runWorker("thinking", { brief, timeout: 30, limitMs: 45_000, script: { sessions: [
    { no_conversation_id: true, turns: [textAnswer(0, "I have read the brief.", { prompt_token_count: 10 })] },
    { no_conversation_id: true, turns: [handIn] },
  ] } });
  assert.equal(reminded.code, 0, tail(reminded));
  assert.equal(reminded.summary.done, true, JSON.stringify(reminded.summary));
  assert.equal(reminded.sessions.length, 2);
  assert.equal(reminded.sessions[1].conversation_id, null, "no id to carry on: a new conversation");
  assert.ok(reminded.chats[1].message.startsWith(`${brief}\n\n`), `the task first: ${reminded.chats[1].message}`);
  assert.match(reminded.chats[1].message, /Not done yet\. Still owed: requirements\.md \(write_requirements\)/);
  // A carry-on after Google could not serve a turn: the same, never "continue" in a conversation that has no task.
  const waited = await runWorker("thinking", { brief, timeout: 30, limitMs: 45_000, args: [...BUSY, "--busy-window-sec", "30"], script: { sessions: [
    { no_conversation_id: true, turns: [READ_THEN_REFUSED] },
    { no_conversation_id: true, turns: [handIn] },
  ] } });
  assert.equal(waited.code, 0, tail(waited));
  assert.equal(waited.sessions.length, 2);
  assert.ok(waited.chats[1].message.startsWith(`${brief}\n\n`), `the task first: ${waited.chats[1].message}`);
  assert.match(waited.chats[1].message, /Still owed: requirements\.md \(write_requirements\)/);
});

// E-thinking-config. Review: the step's SDK configuration was a model_copy(update=) of the agent worker's, which runs
// none of the SDK's validation (google-antigravity 0.1.22, offline: a copy takes capabilities its constructor refuses).
test("a step's SDK configuration is built by its constructor: finish alone of the SDK's own tools, and the role's own tools", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const script = { sessions: [{ turns: [[{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w4") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })]] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000 });
  assert.equal(r.code, 0, tail(r));
  const [agent] = r.sessions;
  assert.equal(agent.validated, true, "built by LocalAgentConfig's constructor, which validates it, never copied");
  assert.deepEqual(agent.capabilities, { enable_subagents: false, enabled_tools: ["finish"] });
  assert.deepEqual(agent.tools, ["read_file", "list_files", "search_files", "write_requirements"]);
  // Each role gets its own tools.
  const reviewer = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, role: "brownfield-security-reviewer", outputs: { security_review: "out/security_review.md" } });
  assert.equal(reviewer.sessions[0].validated, true);
  assert.deepEqual(reviewer.sessions[0].tools, ["read_file", "list_files", "search_files", "git_diff", "read_provenance", "run_file_check", "run_dependency_audit", "env_keys", "write_review"]);
});

// E-thinking-system. Review: the helper's instructions were the first user message, which a long step's trimmed history
// can drop; the design gives them to the session as its system instructions, which are never trimmed.
test("the helper's instructions are the session's system instructions, and its first message is the task alone", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "thinking-system-"));
  const system = "## How this step runs\n\nRead the project with read_file.\n\n## The helper's instructions\n\nWrite requirements.md from the brief.";
  writeFileSync(join(dir, "system.md"), system);
  const brief = "## This invocation\n\nThe brief is in brief.md.";
  const script = { sessions: [
    { turns: [textAnswer(0, "I have read the brief.", { prompt_token_count: 10 })] },
    { turns: [[{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w5") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })]] },
  ] };
  try {
    const r = await runWorker("thinking", { script, brief, timeout: 30, limitMs: 45_000, args: ["--system-file", join(dir, "system.md")] });
    assert.equal(r.code, 0, tail(r));
    assert.equal(r.chats[0].message, brief, "the first message is the task alone");
    assert.deepEqual(r.sessions.map((s) => s.system_instructions), [system, system], "every session has them, the reminder's included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// E-thinking-high. The engine starts every thinking step with --thinking HIGH (agyThinkingDispatch.test): the level
// reaches the SDK's model options in every session, and the usage sidecar records it.
test("a step started at HIGH thinks at high in every session, and its sidecar says HIGH", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const script = { sessions: [
    { turns: [textAnswer(0, "I have read the brief.", { prompt_token_count: 10 })] },
    { turns: [[{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w6") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })]] },
  ] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, args: ["--thinking", "HIGH"] });
  assert.equal(r.code, 0, tail(r));
  assert.deepEqual(r.sessions.map((s) => s.thinking_level), ["high", "high"]);
  assert.equal(r.sidecar.thinking, "HIGH");
});

// E-thinking-tool-limits. Review: no tool call had a time limit, and a tool process that died at start was found only
// after Gemini had been paid.
test("a tool call that never answers ends the step with its reason, at the call's limit", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // Tools that answer the start-up status, then never answer again.
  const dir = mkdtempSync(join(tmpdir(), "stuck-tools-"));
  const stuck = join(dir, "stuck-tools.mjs");
  writeFileSync(stuck, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (l) => { const m = JSON.parse(l); if (n++ === 0) process.stdout.write(JSON.stringify({ id: m.id, ok: true, result: JSON.stringify({ done: false, missing: ["requirements.md (write_requirements)"], accepted: [] }) }) + "\\n"); });
`);
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("read_file", "ACTIVE", { path: "brief.md" }, "r1") },
    ...textAnswer(0.1, "Read.", { prompt_token_count: 10 }),
  ]] }] };
  const started = Date.now();
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, toolsScript: stuck, args: ["--tool-call-timeout-sec", "2"] });
  assert.notEqual(r.code, 0, tail(r));
  assert.ok(Date.now() - started < 30_000, "ended at the call's limit, not the step's budget");
  assert.match(String(r.sidecar?.error), /read_file gave no answer in 2 s/);
  assert.equal(r.summary?.reason, "tool_dead", JSON.stringify(r.summary));
  // The status call after a turn has the same limit: a turn that calls no tool ends there, saying so.
  const quiet = await runWorker("thinking", { script: { sessions: [{ turns: [textAnswer(0, "Read.", { prompt_token_count: 10 })] }] }, timeout: 30, limitMs: 45_000, toolsScript: stuck, args: ["--tool-call-timeout-sec", "2"] });
  assert.notEqual(quiet.code, 0, tail(quiet));
  assert.equal(quiet.summary?.reason, "tool_dead", JSON.stringify(quiet.summary));
  assert.match(quiet.stderr, /thinking_worker failed: the step's tool status gave no answer in 2 s; the step stopped there/);
  rmSync(dir, { recursive: true, force: true });
});

test("tools that answer the status with an error, or print a stray line, end the step with the tools' own reason", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // Review: a status answered with an error (not a hang) made the worker fail on reading it as JSON, and a line the
  // tools printed that is not an answer would have been read as the next call's answer.
  const dir = mkdtempSync(join(tmpdir(), "erring-tools-"));
  const erring = join(dir, "erring-tools.mjs");
  writeFileSync(erring, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let n = 0;
rl.on("line", (l) => {
  const m = JSON.parse(l);
  process.stdout.write("a stray line the tools printed\\n");
  if (n++ === 0) process.stdout.write(JSON.stringify({ id: m.id, ok: true, result: JSON.stringify({ done: false, missing: ["requirements.md (write_requirements)"], accepted: [] }) }) + "\\n");
  else process.stdout.write(JSON.stringify({ id: m.id, ok: false, error: "the spec store could not be read" }) + "\\n");
});
`);
  try {
    const r = await runWorker("thinking", { script: { sessions: [{ turns: [textAnswer(0, "Read.", { prompt_token_count: 10 })] }] }, timeout: 30, limitMs: 45_000, toolsScript: erring });
    assert.notEqual(r.code, 0, tail(r));
    assert.equal(r.summary?.reason, "tool_dead", JSON.stringify(r.summary));
    assert.match(r.stderr, /thinking_worker failed: the step's tools could not report its status: the spec store could not be read/);
    assert.doesNotMatch(r.stderr, /JSONDecodeError/);
    assert.equal(r.sessions.length, 1, "no further model turn once the status cannot be read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// E-thinking-slow-tool. Review: the step's tools are blocking functions, and a tool call on the SDK's event loop would
// stop the heartbeat, so a long one (a dependency audit may take 300 s) would end the worker by the kill rule (60 s
// with no heartbeat, then 20 s). google-antigravity 0.1.22 runs a synchronous tool in a worker thread
// (ToolRunner._execute_fn: asyncio.to_thread), and so does the stand-in: the loop, and the heartbeat, go on.
test("a tool call longer than the heartbeat interval leaves no gap in the heartbeat", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // Tools whose dependency audit answers after 4 s; every other call answers at once, and the step is done once its
  // review is in.
  const dir = mkdtempSync(join(tmpdir(), "slow-tools-"));
  const slow = join(dir, "slow-tools.mjs");
  writeFileSync(slow, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let reviewed = false;
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\\n");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.op === "run_dependency_audit") setTimeout(() => answer(m.id, "exit 0\\n{}"), 4000);
  else if (m.op === "write_review") { reviewed = true; answer(m.id, "wrote out/security_review.md"); }
  else answer(m.id, JSON.stringify({ done: reviewed, missing: reviewed ? [] : ["the review (write_review)"], accepted: reviewed ? ["review"] : [] }));
});
`);
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("run_dependency_audit", "ACTIVE", { kind: "npm-audit" }, "a1") },
    { at: 0, step: step.tool("write_review", "ACTIVE", { content: "# Security review\n\nNo finding.\n" }, "w1") },
    ...textAnswer(0, "Reviewed.", { prompt_token_count: 10 }),
  ]] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, toolsScript: slow, role: "security-reviewer", outputs: { security_review: "out/security_review.md" }, args: ["--heartbeat-sec", "1"] });
  assert.equal(r.code, 0, tail(r));
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  // The audit's call, on the worker's own clock (the stand-in's log), and every heartbeat as the worker wrote it.
  const start = r.log.find((e) => e.ev === "tool_start" && e.name === "run_dependency_audit");
  const end = r.log.find((e) => e.ev === "tool_run" && e.name === "run_dependency_audit");
  assert.ok(start && end, `the audit ran: ${JSON.stringify(r.log.filter((e) => e.ev.startsWith("tool_")))}`);
  assert.ok(end.mono - start.mono >= 3.5, `the audit took its 4 s: ${(end.mono - start.mono).toFixed(2)} s`);
  const beats = r.sent.map((b) => b.mono);
  // No gap between two heartbeats around the audit is much longer than the interval (1 s, on the worker's own clock);
  // a call on the event loop leaves one as long as the call.
  const gaps = beats.slice(1).map((t, i) => ({ from: beats[i], gap: t - beats[i] })).filter((g) => g.from < end.mono && g.from + g.gap > start.mono);
  const longest = Math.max(...gaps.map((g) => g.gap));
  assert.ok(longest < 2.5, `the longest gap in the heartbeat while the audit ran: ${longest.toFixed(2)} s`);
  const during = beats.filter((t) => t > start.mono && t < end.mono);
  assert.ok(during.length >= 2, `heartbeats while the audit ran: ${during.length}`);
});

test("tools that cannot start stop the step before any model call", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const script = { sessions: [{ turns: [[...textAnswer(0, "Hello.", { prompt_token_count: 10 })]] }] };
  // The tools' project folder does not exist: the tool process fails as it starts.
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, config: { project_root: join(tmpdir(), "no-such-project-folder") } });
  assert.notEqual(r.code, 0, tail(r));
  assert.equal(r.sessions.length, 0, "no session was opened, so nothing was paid");
  assert.match(r.stderr, /the step's tools could not start/);
});

// E-thinking-setup. Review: a check that could not run for the step's own setup (plan-lint's usage errors: a wrong run
// id, a job that is not the run's, a section outside the run's folder) came back to Gemini as a refusal it cannot fix.
test("a hand-in whose check cannot run for the step's setup stops the step at once, with that reason, and no further model turn", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  // Gate 0 recorded a bugfix; the step's tools were set up for a docs job.
  const setup = (work) => {
    mkdirSync(join(work, ".sdlc", "runs", "r1"), { recursive: true });
    writeFileSync(join(work, ".sdlc", "runs", "r1", "intent_brief.md"), "# Intent Brief — bugfix — the ping route answers 500\n");
  };
  const header = { conventions: [], file_checks: [], project_checks: [] };
  const script = { sessions: [{ turns: [[
    { at: 0, step: step.tool("write_section", "ACTIVE", { name: "header.json", section_json: JSON.stringify(header) }, "w1") },
    { at: 0, usage: { prompt_token_count: 10, candidates_token_count: 5 } },
    // The model's next call, had the turn gone on: its answer to the tool's reply.
    ...textAnswer(1, "I will fix the header.", { prompt_token_count: 12, candidates_token_count: 4 }),
  ]] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, role: "brownfield-architect", outputs: { sections_dir: ".sdlc/runs/r1/change.sections" }, config: { output_dir: ".sdlc/runs/r1", intent: "docs" }, setup });
  assert.notEqual(r.code, 0, tail(r));
  assert.equal(r.summary?.reason, "setup", JSON.stringify(r.summary));
  assert.match(String(r.summary.setup_error), /^plan-lint could not check \.sdlc\/runs\/r1\/change\.sections\/header\.json: --intent docs is not this run's job: Gate 0 recorded bugfix/);
  assert.equal(r.sidecar?.error, r.summary.setup_error, "the worker's own error is the setup reason");
  assert.equal(r.chats.length, 1, "no further model turn");
  assert.ok(r.cancels.length >= 1, "the turn in flight was cut");
  assert.equal(r.log.filter((e) => e.ev === "usage").length, 1, "the model's next call was never answered");
  assert.deepEqual(r.summary.missing, ["header.json, accepted", "at least one units file, accepted"], "no refusal is owed for it");
});

// E-thinking-carry-on. A worker the engine's kill rule stopped is carried on by thinking.ts: its saved conversation
// already holds the task and everything since, so the new worker continues it as the harness continues a conversation
// it interrupted, and its tools start from what the killed worker's tools had accepted (their state file).
test("a carried-on worker continues its saved conversation with the harness's words, its tools holding what was accepted; a revise sends its task", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const state = join(mkdtempSync(join(tmpdir(), "carry-on-state-")), "requirements.state.json");
  // The first worker's real tools accept the requirements and keep that in the step's state file.
  const handIn = { sessions: [{ turns: [[{ at: 0, step: step.tool("write_requirements", "ACTIVE", REQUIREMENTS, "w1") }, ...textAnswer(0, "Handed in.", { prompt_token_count: 10 })]] }] };
  const first = await runWorker("thinking", { script: handIn, timeout: 30, limitMs: 45_000, config: { state_file: state } });
  assert.equal(first.code, 0, tail(first));
  // Carried on: the resumed turn hands nothing in, and the step is done by what the tools kept.
  const script = { sessions: [{ turns: [textAnswer(0, "Everything is handed in.", { prompt_token_count: 10 })] }] };
  const r = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, brief: "THE TASK", args: ["--resume-id", "standin-earlier", "--carry-on"], config: { state_file: state, carry_on: true } });
  assert.equal(r.code, 0, tail(r));
  assert.equal(r.sessions[0].conversation_id, "standin-earlier", "the saved conversation, resumed");
  assert.equal(r.chats[0].message, "Please continue the task you were working on.", "not the task again");
  assert.equal(r.summary.done, true, JSON.stringify(r.summary));
  assert.deepEqual(r.summary.accepted, ["requirements"]);
  assert.equal(r.chats.length, 1, "no nudge: nothing was owed");
  // A revise resumes its conversation too, and sends its task: the changes asked for.
  const revise = await runWorker("thinking", { script: handIn, timeout: 30, limitMs: 45_000, brief: "Changes asked for this step: add FR-2.", args: ["--resume-id", "standin-earlier"] });
  assert.equal(revise.code, 0, tail(revise));
  assert.equal(revise.chats[0].message, "Changes asked for this step: add FR-2.");
  // A carry-on continues a saved conversation: without one nothing is sent.
  const none = await runWorker("thinking", { script, timeout: 30, limitMs: 45_000, args: ["--carry-on"], config: { state_file: state, carry_on: true } });
  assert.notEqual(none.code, 0);
  assert.equal(none.sessions.length, 0, "no session was opened");
  assert.match(none.stderr, /--carry-on[^\n]*--resume-id/);
});
