/**
 * Whether a run has ended, read from its own log: `.sdlc/runs/<run-id>/orchestrator.log`, which only mmo-log.mjs
 * writes (write-contract-check.mjs refuses a Write or Edit of it while the run's contract binds).
 *
 * Why: a brownfield write contract (.sdlc/local/write-contract.json) binds the run that froze it at Gate 0. Once that
 * run is over it must bind nothing, or every later edit in the project outside the old run's allowlist is refused, in
 * every chat, the brownfield guide's own close-out and the next run's Gate 0 included. write-contract-check.mjs asks
 * this before it enforces a contract.
 *
 * Only an explicit, final record ends a run, as the workflow logs it (agents/orchestrator.md):
 *   - a gate answered abort;
 *   - a `run.end` whose outcome is aborted or failed;
 *   - a completed `run.end`, and the final acceptance gate, gate-4, answered accept or approved. Anything else at
 *     Gate 4 (revise, reject: …, in any case) sends the run back for changes, and it stays live.
 * Only the events after the log's latest `run.start` count: a run started again under the same id is live again.
 * No log, an unreadable one, or none of the above: not ended, so the contract keeps binding.
 *
 * The log is read with zero-touch's reader (plugin/scripts/ambient/lib/workflow-log.mjs, the same mmo plugin), which
 * also hands a chat back when a completed run stays quiet; a guard frees nothing on a timer, so that rule is not used
 * here. tools/test/run-log.test.mjs keeps the two in agreement on every explicit record.
 */
import { join } from "node:path";
import { readWorkflowLog, RUN_ID } from "../ambient/lib/workflow-log.mjs";

/** The final acceptance gate, which closes a completed run. */
const FINAL_GATE = "gate-4";
/** The answers that accept a completed run at its final gate (orchestrator.md logs approved; the gate offers accept). */
const ACCEPTED = /^(?:approved|accept)/i;

/** Whether these events, a run's log, record its end (the rules above). */
export function eventsEnded(events) {
  let from = 0;
  events.forEach((e, i) => { if (e.event === "run.start") from = i; });
  let completed = false, accepted = false;
  for (const e of events.slice(from)) {
    const gate = e.fields?.gate;
    if (e.event === "gate.resolved" && gate) {
      const response = String(e.fields.response ?? "");
      if (response.startsWith("abort")) return true;
      if (gate === FINAL_GATE) accepted = ACCEPTED.test(response);
    }
    if (e.event === "run.end") {
      const outcome = e.fields?.outcome ?? "completed";
      if (outcome === "aborted" || outcome === "failed") return true;
      if (outcome === "completed") completed = true;
    }
  }
  return completed && accepted;
}

/** Whether the run `runId` in the project at `repoRoot` has ended, by its own log. */
export function runEnded(repoRoot, runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return false;
  return eventsEnded(readWorkflowLog(join(repoRoot, ".sdlc", "runs", runId, "orchestrator.log")));
}
