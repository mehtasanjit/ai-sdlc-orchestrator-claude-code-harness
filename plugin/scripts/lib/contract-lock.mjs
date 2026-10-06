/**
 * The write contract's freeze record: what proves a contract is the one write-contract.mjs froze at Gate 0.
 *
 * Why: the PreToolUse hook refuses a live run's Write or Edit of its own contract, but a shell command can rewrite the
 * file. So the contract is written by one script, write-contract.mjs, which records the SHA-256 of the exact bytes it
 * froze in the freezing run's own log (`.sdlc/runs/<run-id>/orchestrator.log`, a `contract.freeze run_id=… sha256=…`
 * line). Before every write the hook and the server's writer (model-dispatch apply.ts checkWriteContract, which mirrors
 * these rules) find the live freeze record and compare: a contract whose bytes no longer match — widened, switched
 * off, deleted, or rewritten to name another run — refuses every write while that run is live.
 *
 * The record is read from the run logs, never from the contract or a file beside it: a fingerprint kept beside the
 * contract was undone by deleting it, and a contract rewritten to name an ended run would point the check at that run.
 * What the record does not protect, said exactly: it lives only in the run's own log.
 * Deleting or emptying that log, or the run folder, frees the run (so does putting anything but a regular file there,
 * which is read as no log). That is destruction of the run's own record, not a cleanup. A shell can do it, as a shell
 * can write any record: an end record in the run's log frees the run too.
 *
 * A freeze record binds until an end record of its run follows it (the run's own rules, lib/run-log.mjs eventsEnded:
 * an abort, a failed run, or a completed run whose Gate 4 is accepted), whatever run.start lines come between: Gate 0
 * freezes before the orchestrator logs run.start. The whole log is read, the pieces the logger rotated out included
 * (ambient/lib/workflow-log.mjs readRunLogText), so a long run's record survives the log's rotation.
 *
 * write-contract.mjs freezes a run once (never again under the same id, not even after its end) and never while
 * another run's record is live. So records that break that rule were not written by it, and are read as a change to
 * the contract: a second record in one run's log, or live records of two runs, refuse every write while live (a
 * record logged by hand cannot re-bless a widened contract). A project with no freeze record (greenfield, or a
 * contract frozen before the record existed) keeps the rules it had.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { eventsEnded } from "./run-log.mjs";
import { parseWorkflowLog, readRegularFile, readRunLogText, RUN_ID } from "../ambient/lib/workflow-log.mjs";

export const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
/** The hook's bound on a contract it trusts: larger is not one of ours. */
export const CONTRACT_MAX_BYTES = 128 * 1024;
/** The run-log event write-contract.mjs records at Gate 0. */
export const FREEZE_EVENT = "contract.freeze";
const SHA256 = /^[0-9a-f]{64}$/;

export const fingerprint = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A freeze record as write-contract.mjs writes it: the event, with a SHA-256. */
const isFreeze = (e) => e.event === FREEZE_EVENT && SHA256.test(String(e.fields?.sha256 ?? ""));

/**
 * An end record of a run, whatever follows it: a `run.end` of any outcome, or a gate answered abort. A run whose log
 * holds one never freezes again under its id (write-contract.mjs), even when a later run.start made it live.
 */
export const isEndRecord = (e) => e.event === "run.end" || (e.event === "gate.resolved" && !!e.fields?.gate && String(e.fields?.response ?? "").startsWith("abort"));

/** The events of one run's whole log, rotated pieces included, oldest first ([] for an id that is not a run's). */
export function runEvents(repoRoot, runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return [];
  return parseWorkflowLog(readRunLogText(join(repoRoot, ".sdlc", "runs", runId)));
}

/**
 * One run's freeze state, from its own whole log: `{ events, records, live }`. `records` counts its freeze records;
 * `live` is true when its latest record is followed by no end of the run (run.start lines between reset nothing).
 * A log whose text never names the event holds no record and is not parsed (`events` is then empty): frozenBy calls
 * this for every run in the project before every Write and Edit, greenfield included, and most logs hold no record.
 * A caller that needs every event of a run reads them with runEvents.
 */
export function runFreeze(repoRoot, runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return { events: [], records: 0, live: false };
  const text = readRunLogText(join(repoRoot, ".sdlc", "runs", runId));
  if (!text.includes(FREEZE_EVENT)) return { events: [], records: 0, live: false };
  const events = parseWorkflowLog(text);
  let last = -1, records = 0;
  events.forEach((e, i) => { if (isFreeze(e)) { last = i; records++; } });
  if (last < 0) return { events, records: 0, live: false };
  const live = !eventsEnded(events.slice(last + 1).filter((e) => e.event !== "run.start"));
  return { events, records, live, sha256: events[last].fields.sha256 };
}

/**
 * The live freeze record of the project at `repoRoot`: `{run_id, sha256}`, or null when no run that froze a contract is
 * live. Records write-contract.mjs never writes (above) come back as `{run_id, sha256: null, forged: "<why>"}`, which
 * contractTampered refuses.
 */
export function frozenBy(repoRoot) {
  let names = [];
  try { names = readdirSync(join(repoRoot, ".sdlc", "runs")); } catch { return null; }
  const live = [];
  for (const name of names.sort()) {
    if (!RUN_ID.test(name)) continue;
    const r = runFreeze(repoRoot, name);
    if (r.live) live.push({ run_id: name, sha256: r.sha256, records: r.records });
  }
  if (live.length === 0) return null;
  if (live.length > 1) {
    return { run_id: live[0].run_id, sha256: null, forged: `freeze records of ${live.length} runs are live (${live.map((l) => l.run_id).join(", ")}), and only one run at a time holds a project's contract` };
  }
  const [one] = live;
  if (one.records > 1) return { run_id: one.run_id, sha256: null, forged: `run ${one.run_id}'s log holds ${one.records} freeze records, and a run freezes its contract once` };
  return { run_id: one.run_id, sha256: one.sha256 };
}

/**
 * Why the project's contract can no longer be trusted, or null: a run that froze a contract is live, and the contract
 * file is missing (or no regular file) or its bytes no longer match the freeze record, or the records themselves were
 * not written by write-contract.mjs. `live` is frozenBy's answer when the caller has it. The reason says what was
 * refused and why, and that the person decides what happens next; it names no way past it.
 */
export function contractTampered(repoRoot, live = frozenBy(repoRoot)) {
  if (!live) return null;
  if (live.forged) {
    return `the write contract's freeze record cannot be trusted: ${live.forged}, so one was not written by write-contract.mjs. Every write is refused while that record is live. Stop and tell the person.`;
  }
  const bytes = readRegularFile(join(repoRoot, CONTRACT_REL_PATH), { maxBytes: CONTRACT_MAX_BYTES });
  if (bytes !== null && fingerprint(bytes) === live.sha256) return null;
  return (
    `the write contract changed after it was frozen for run ${live.run_id} (${bytes === null ? "the file is gone, or is not a readable file" : "its bytes no longer match the freeze record in the run's log"}): ` +
    `every write is refused while that run is live. A contract is written only by write-contract.mjs, at Gate 0. Stop and tell the person what changed it.`
  );
}
