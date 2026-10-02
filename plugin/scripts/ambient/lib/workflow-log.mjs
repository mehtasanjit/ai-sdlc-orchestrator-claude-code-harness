/**
 * Has the workflow this chat started ended? Read from the workflow's own log.
 *
 * Every /mmo: workflow logs its life through plugin/scripts/mmo-log.mjs into <project>/.sdlc/runs/<run-id>/
 * orchestrator.log, one line per event as plugin/scripts/lib/log.mjs renders it: `run.start`, each `gate.open`
 * and `gate.resolved` (response approved | revise | abort), and `run.end` (outcome completed | aborted | failed).
 * A run logs `run.end` right before its final report, and its final acceptance gate (gate-4) after that report
 * (agents/orchestrator.md), so "ended" is: an abort at any gate, a `run.end` that says aborted or failed, or a
 * completed `run.end` whose final acceptance is answered. A completed run that never logs its final gate is over
 * once nothing in it is open (no gate, no phase) and its log has been quiet for QUIET_MS, so a chat never waits on
 * a gate line that will not come. Between `run.end` and the final gate the run is still writing its report, often
 * from a helper working in the background while the chat's own turns end: it is running, not over.
 *
 * The run is found by time: the latest run whose `run.start` is not earlier than the moment the chat started its
 * workflow (the chat's `pipeline` record holds that moment). No such run means the workflow never reached its run
 * (it was stopped at its first questions, or is still asking them): the chat stays the workflow's, so an answer to
 * one of its questions is never taken for a new job. Two chats running workflows in one project at once could see
 * each other's run by time alone; so a chat claims its run by the run id its own orchestrator logs with (hook.mjs
 * claimRun), and once claimed only that run is read.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatLine } from "../../lib/log.mjs";

/** One log line: an optional prefix, an ISO timestamp, a level, the event, then key=value fields (log.mjs). */
const LINE = /^(?:\S+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+[A-Z]+\s+(\S+)(.*)$/;
const FIELD = /([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
/** A run id as the workflows write it: a folder name under .sdlc/runs, never a path. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A log file older than the chat's start by more than this cannot hold its run (its file time is only a first filter). */
const SLACK_MS = 2_000;
/** The final acceptance gate, which closes a completed run. */
const FINAL_GATE = "gate-4";
/** How long a completed run that never logged its final gate stays quiet, with nothing open, before it counts as over. */
export const QUIET_MS = 10 * 60 * 1000;

function fields(rest) {
  const out = {};
  for (const m of rest.matchAll(FIELD)) {
    let v = m[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    out[m[1]] = v;
  }
  return out;
}

/** The events of one log file, oldest first: { ms, event, fields }. */
export function readWorkflowLog(file) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const events = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (Number.isFinite(ms)) events.push({ ms, event: m[2], fields: fields(m[3]) });
  }
  return events;
}

/**
 * "ended", "running" (a run of this workflow is logged and not over), or "not-started" (none logged yet). A running
 * run also says `waiting: true` while one of its gates is open: the workflow has asked the person something, so the
 * person's next message is its answer. `runId`, when the chat has claimed its
 * run, limits the reading to that run's own log; without it the latest run since the chat's start is taken.
 */
export function workflowState(projectDir, sinceMs, runId = null, nowMs = Date.now()) {
  const root = join(projectDir, ".sdlc", "runs");
  if (!Number.isFinite(sinceMs) || !existsSync(root)) return { state: "not-started" };
  let best = null;
  let names = [];
  if (runId && RUN_ID.test(runId)) names = [runId];
  else try { names = readdirSync(root); } catch { return { state: "not-started" }; }
  for (const name of names) {
    const file = join(root, name, "orchestrator.log");
    try { if (statSync(file).mtimeMs < sinceMs - SLACK_MS) continue; } catch { continue; }
    const events = readWorkflowLog(file);
    // A run id can be reused; the run is the part of the log from its latest run.start at or after the chat's start.
    let start = -1;
    // The chat records its workflow's start before the workflow logs run.start (the command runs first), so a
    // run.start earlier than that moment belongs to an earlier run, however close.
    events.forEach((e, i) => { if (e.event === "run.start" && e.ms >= sinceMs) start = i; });
    if (start < 0) continue;
    if (!best || events[start].ms > best.startMs) best = { runId: name, startMs: events[start].ms, events: events.slice(start) };
  }
  if (!best) return { state: "not-started" };
  const open = new Set();
  const phases = new Set();
  let ended = false, outcome = null, finalOpened = false, finalAnswered = false, lastMs = best.startMs;
  for (const e of best.events) {
    lastMs = e.ms;
    const gate = e.fields.gate;
    if (e.event === "phase.start" && e.fields.phase) phases.add(e.fields.phase);
    if ((e.event === "phase.end" || e.event === "phase.skip") && e.fields.phase) phases.delete(e.fields.phase);
    if (e.event === "gate.open" && gate) { open.add(gate); if (gate === FINAL_GATE) finalOpened = true; }
    if (e.event === "gate.resolved" && gate) {
      const response = String(e.fields.response ?? "");
      if (response.startsWith("abort")) { ended = true; outcome = "aborted"; }
      // A gate answered "revise" (Gate 4's "reject: …" is logged as revise) stays open until the revision is
      // approved: the run is not over, even when a turn ends between a Gate 4 reject and the gate opening again.
      if (!response.startsWith("revise") && !response.startsWith("reject")) {
        open.delete(gate);
        if (gate === FINAL_GATE) finalAnswered = true;
      }
    }
    if (e.event === "run.end") {
      outcome = e.fields.outcome ?? "completed";
      if (outcome === "aborted" || outcome === "failed") ended = true;
    }
  }
  // A completed run: over once its final acceptance is answered; one that never logs that gate, once nothing in it
  // is open and its log has been quiet for QUIET_MS.
  if (!ended && outcome && open.size === 0) {
    if (finalAnswered) ended = true;
    else if (!finalOpened && phases.size === 0 && nowMs - lastMs >= QUIET_MS) ended = true;
  }
  return ended ? { state: "ended", runId: best.runId, outcome } : { state: "running", runId: best.runId, outcome, waiting: open.size > 0 };
}

/**
 * When a run's latest `run.start` was logged (ms), or null when its log has none yet (its run.start call is the one
 * being made). Lets a chat claim only a run that belongs to its current workflow (hook.mjs claimRun).
 */
export function runStartMs(projectDir, runId) {
  if (!runId || !RUN_ID.test(runId)) return null;
  const starts = readWorkflowLog(join(projectDir, ".sdlc", "runs", runId, "orchestrator.log")).filter((e) => e.event === "run.start");
  return starts.length ? starts[starts.length - 1].ms : null;
}

/**
 * Stops a run the way the workflow's own abort does ("Replace it" in a zero-touch chat): the run's log
 * records `run.end outcome=aborted`, in the format mmo-log.mjs writes, so workflowState and the collector read it as
 * ended; and a brownfield write lock (`.sdlc/local/write-contract.json`) that belongs to this run is switched off,
 * as the brownfield manual's abort step does (active: false, the file and the run folder kept). A lock of another
 * run is left alone. The run's resume record (`.sdlc/local/state.json`) is marked aborted when it is this run's, so
 * the next brownfield run does not offer to resume a run stopped by "Replace it" or /clear. Returns what was done.
 */
export function abortRun(projectDir, runId, why) {
  const done = { logged: false, unlocked: false, resumable: false };
  if (!runId) return done;
  const log = join(projectDir, ".sdlc", "runs", runId, "orchestrator.log");
  if (existsSync(log)) {
    appendFileSync(log, formatLine("info", "run.end", { run_id: runId, outcome: "aborted", reason: why }) + "\n");
    done.logged = true;
  }
  const contractFile = join(projectDir, ".sdlc", "local", "write-contract.json");
  try {
    const contract = JSON.parse(readFileSync(contractFile, "utf8"));
    if (contract && contract.active === true && contract.run_id === runId) {
      writeFileSync(contractFile, JSON.stringify({ ...contract, active: false }, null, 2) + "\n");
      done.unlocked = true;
    }
  } catch { /* no lock, or not this run's */ }
  const stateFile = join(projectDir, ".sdlc", "local", "state.json");
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state && typeof state === "object" && state.run_id === runId && state.status !== "complete" && state.status !== "aborted") {
      writeFileSync(stateFile, JSON.stringify({ ...state, status: "aborted" }, null, 2) + "\n");
      done.resumable = true;
    }
  } catch { /* no resume record, or not this run's */ }
  return done;
}
