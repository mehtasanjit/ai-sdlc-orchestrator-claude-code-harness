/**
 * plugin/scripts/lib/run-log.mjs: whether a run has ended, by its own log. write-contract-check.mjs frees a write
 * contract once its run has ended; zero-touch's plugin/scripts/ambient/lib/workflow-log.mjs reads the same log, with
 * the same reader, to hand a chat back. They agree on every record below. They differ, on purpose, only where the
 * guard is stricter: it frees nothing on a timer (workflow-log ends a completed run that stays quiet), it ends a
 * completed run only on an affirmative Gate 4 answer (accept or approved, in any case), and it does not wait on a gate
 * the log opened and never resolved once Gate 4 is accepted. The last tests pin those differences.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts");
const { runEnded, eventsEnded } = await import(join(SCRIPTS, "lib", "run-log.mjs"));
const { workflowState, QUIET_MS } = await import(join(SCRIPTS, "ambient", "lib", "workflow-log.mjs"));
const { formatLine } = await import(join(SCRIPTS, "lib", "log.mjs"));

const RUN = "20261002-120000-bugfix-dates";
const START = ["run.start", { run_id: RUN }];
const COMPLETED = ["run.end", { run_id: RUN, outcome: "completed" }];
const open = (g) => ["gate.open", { run_id: RUN, gate: g }];
const gate = (g, response) => ["gate.resolved", { run_id: RUN, gate: g, response }];

function project(events) {
  const dir = mkdtempSync(join(tmpdir(), "run-log-test-"));
  mkdirSync(join(dir, ".sdlc", "runs", RUN), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "runs", RUN, "orchestrator.log"), events.map(([e, f]) => formatLine("info", e, f)).join("\n") + "\n");
  return dir;
}
// Read just after the log was written, so workflow-log's quiet-period rule cannot apply.
const zeroTouchEnded = (dir) => workflowState(dir, 0, RUN, Date.now()).state === "ended";

const CASES = [
  ["aborted at a gate", [START, open("gate-2"), gate("gate-2", "abort")], true],
  ["run.end failed", [START, ["run.end", { run_id: RUN, outcome: "failed" }]], true],
  ["run.end aborted (a zero-touch Replace)", [START, ["run.end", { run_id: RUN, outcome: "aborted", reason: "replaced" }]], true],
  ["completed, Gate 4 approved", [START, COMPLETED, open("gate-4"), gate("gate-4", "approved")], true],
  ["completed, Gate 4 accept", [START, COMPLETED, open("gate-4"), gate("gate-4", "accept")], true],
  ["completed, Gate 4 sent back", [START, COMPLETED, open("gate-4"), gate("gate-4", "revise")], false],
  ["completed, Gate 4 rejected", [START, COMPLETED, open("gate-4"), gate("gate-4", "reject: tests missing")], false],
  ["completed, Gate 4 open", [START, COMPLETED, open("gate-4")], false],
  ["an abort with no gate named", [START, ["gate.resolved", { run_id: RUN, response: "abort" }]], false],
  ["a run.end with an empty outcome, then Gate 4 approved", [START, ["run.end", { run_id: RUN, outcome: "" }], gate("gate-4", "approved")], false],
  ["an earlier gate approved", [START, open("gate-1"), gate("gate-1", "approved")], false],
  ["started again after an abort", [START, gate("gate-2", "abort"), START], false],
];

for (const [name, events, ended] of CASES) {
  test(`a run ${name}: ${ended ? "ended" : "not ended"}, and zero-touch's reader agrees`, () => {
    const dir = project(events);
    try {
      assert.equal(runEnded(dir, RUN), ended);
      assert.equal(zeroTouchEnded(dir), ended, "workflow-log.mjs reads the same log the same way");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("no log, an unreadable run id, or a log with no end: not ended", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-log-test-"));
  try {
    assert.equal(runEnded(dir, RUN), false);
    assert.equal(runEnded(dir, "../escape"), false);
    assert.equal(runEnded(dir, undefined), false);
    assert.equal(eventsEnded([]), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stricter than zero-touch, on purpose: a completed run that stays quiet still binds its contract", () => {
  const dir = project([START, COMPLETED]);
  try {
    assert.equal(workflowState(dir, 0, RUN, Date.now() + QUIET_MS + 1000).state, "ended", "zero-touch hands the chat back");
    assert.equal(runEnded(dir, RUN), false, "a guard frees nothing on a timer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stricter than zero-touch, on purpose: only an affirmative Gate 4 answer ends a completed run", () => {
  const dir = project([START, COMPLETED, open("gate-4"), gate("gate-4", "Revise: more tests")]);
  try {
    assert.equal(zeroTouchEnded(dir), true, "zero-touch reads any answer but revise or reject as the gate closing");
    assert.equal(runEnded(dir, RUN), false, "the guard keeps a capitalised send-back live");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an accepted Gate 4 ends the run even when the log left an earlier gate open", () => {
  const dir = project([START, open("gate-2"), COMPLETED, open("gate-4"), gate("gate-4", "approved")]);
  try {
    assert.equal(zeroTouchEnded(dir), false, "zero-touch waits on the open gate");
    assert.equal(runEnded(dir, RUN), true, "final acceptance is the run's last word");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The plugin's logger renames a run log that reached its size limit to orchestrator.log.1 and starts a new one. The
// rotated piece is still the run's own log: the guard reads it first, then the current file, so a run's end (and the
// contract's freeze record, lib/contract-lock.mjs) is found wherever the rotation left it.
test("a run's end is read across the log's rotated piece: the older piece first, then the current file", () => {
  const dir = project([START, open("gate-2"), gate("gate-2", "abort")]);
  try {
    const file = join(dir, ".sdlc", "runs", RUN, "orchestrator.log");
    renameSync(file, `${file}.1`);
    writeFileSync(file, formatLine("info", "phase.end", { run_id: RUN, phase: "design" }) + "\n");
    assert.equal(runEnded(dir, RUN), true, "the abort sits in the rotated piece");
    writeFileSync(file, formatLine("info", "run.start", { run_id: RUN }) + "\n");
    assert.equal(runEnded(dir, RUN), false, "a run started again after the rotation is live again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The run's log is written by the plugin's own scripts (mmo-log.mjs for the run's events, write-contract.mjs for the
// contract's freeze record and an abandoned run's end, zero-touch's stop for the abort it records), and the contract
// by write-contract.mjs (zero-touch's stop switches it off after logging the run's end). The modules that guard the
// contract say exactly that, and never that one script alone writes the log or that the orchestrator writes the contract.
test("the contract guard's modules say truthfully who writes the run log and the contract", async () => {
  const { readFileSync } = await import("node:fs");
  for (const rel of ["lib/run-log.mjs", "write-contract-check.mjs", "lib/contract-lock.mjs", "write-contract.mjs"]) {
    const text = readFileSync(join(SCRIPTS, rel), "utf8");
    assert.doesNotMatch(text, /only mmo-log\.mjs|mmo-log\.mjs only|which only mmo-log/, `${rel}: the log has more than one writer`);
    assert.doesNotMatch(text, /orchestrator writes\/updates this file/, `${rel}: the orchestrator never writes the contract`);
  }
});
