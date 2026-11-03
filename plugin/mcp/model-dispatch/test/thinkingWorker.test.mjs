/**
 * The thinking worker (worker/thinking_worker.py) against the scripted stand-in SDK, the model's tool calls running
 * the step's real tools (scripts/thinking-tools.mjs). Pinned: the step's summary (done, what is owed, what was
 * accepted, the conversation's own id) is kept whatever the worker's exit, so a step whose every piece was accepted
 * is not lost to a stop on its last turn; and a nudge carries on the same conversation by the SDK's own id, never by
 * the newest file in the save folder. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

test("a revise through the worker: an unchanged section goes by its name alone, and finalize's drop removes a unit by id", { skip: NO_PYTHON, timeout: 60_000 }, async () => {
  const { loadServerLib } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "server-lib.mjs")).href);
  const { specStore } = await loadServerLib();
  const header = {
    stack: ["Python 3.13", "FastAPI", "pytest"],
    commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 600 }],
    no_audit_reason: "a test", decisions: [{ topic: "ids", choice: "integer", rejected: ["uuid"], reason: "simplest" }],
    shared: { conventions: ["snake_case"], data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }] }], api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }] },
  };
  const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }], behaviour: `writes ${path}`, depends_on: [], style_from: { reason: "first file of its kind" }, covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20 });
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
  const once = await runWorker("thinking", { script: refusedAgain, timeout: 30, limitMs: 45_000, args: BUSY });
  assert.notEqual(once.code, 0);
  assert.equal(once.sessions.length, 1, "no busy window given: the worker does not wait");
});
