/**
 * Whether a brownfield run has ended, read from its own log (`.sdlc/runs/<run-id>/orchestrator.log`, which only
 * mmo-log.mjs writes). The server's copy of the write-contract hook's rule (plugin/scripts/lib/run-log.mjs), so the
 * server's writer (apply.ts checkWriteContract) frees a contract exactly when the hook does: a contract binds its run
 * only while the run is live. test/apply.test.mjs runs both on the same logs.
 *
 * Only an explicit, final record ends a run: a gate answered abort; a `run.end` aborted or failed; or a completed
 * `run.end` and Gate 4 (gate-4) answered accept or approved. Only the events after the latest `run.start` count. No
 * log, an unreadable one, or anything else: not ended, so the contract keeps binding.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One log line as lib/log.mjs formats it: an optional prefix, an ISO timestamp, a level, the event, key=value fields. */
const LINE = /^(?:\S+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+[A-Z]+\s+(\S+)(.*)$/;
const FIELD = /([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
/** A run id as the workflows write it: a folder name under .sdlc/runs, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINAL_GATE = "gate-4";
const ACCEPTED = /^(?:approved|accept)/i;

interface LogEvent { event: string; fields: Record<string, string> }

function readRunLog(file: string): LogEvent[] {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const fields: Record<string, string> = {};
    for (const f of m[3].matchAll(FIELD)) {
      let v = f[2];
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
      fields[f[1]] = v;
    }
    events.push({ event: m[2], fields });
  }
  return events;
}

/** Whether these events, a run's log, record its end (the rules above). */
export function eventsEnded(events: LogEvent[]): boolean {
  let from = 0;
  events.forEach((e, i) => { if (e.event === "run.start") from = i; });
  let completed = false, accepted = false;
  for (const e of events.slice(from)) {
    const gate = e.fields.gate;
    if (e.event === "gate.resolved" && gate) {
      const response = String(e.fields.response ?? "");
      if (response.startsWith("abort")) return true;
      if (gate === FINAL_GATE) accepted = ACCEPTED.test(response);
    }
    if (e.event === "run.end") {
      const outcome = e.fields.outcome ?? "completed";
      if (outcome === "aborted" || outcome === "failed") return true;
      if (outcome === "completed") completed = true;
    }
  }
  return completed && accepted;
}

/** Whether the run `runId` in the project at `projectRoot` has ended, by its own log. */
export function runEnded(projectRoot: string, runId: unknown): boolean {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return false;
  return eventsEnded(readRunLog(join(projectRoot, ".sdlc", "runs", runId, "orchestrator.log")));
}
