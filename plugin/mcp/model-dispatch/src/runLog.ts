/**
 * Whether a brownfield run has ended, read from its own log (`.sdlc/runs/<run-id>/orchestrator.log`, which the plugin's
 * own scripts write (mmo-log.mjs; write-contract.mjs's freeze record and an abandoned run's end; zero-touch's stop).
 * The server's copy of the write-contract hook's rule (plugin/scripts/lib/run-log.mjs), so the server's writer
 * (apply.ts checkWriteContract) frees a contract exactly when the hook does: a contract binds its run only while the
 * run is live. test/apply.test.mjs and test/runLogWhole.test.mjs run both on the same logs.
 *
 * Only an explicit, final record ends a run: a gate answered abort; a `run.end` aborted or failed; or a completed
 * `run.end` and Gate 4 (gate-4) answered accept or approved. Only the events after the latest `run.start` count. No
 * log, an unreadable one, or anything else: not ended, so the contract keeps binding.
 *
 * The whole log is read, as the scripts read it (ambient/lib/workflow-log.mjs readRunLogText): the pieces the logger
 * rotated out (orchestrator.log.<n>, the highest number the oldest), then orchestrator.log, since a run's start, its
 * gates and its freeze record may sit in a rotated piece. Each piece is read only when it is a regular file
 * (readRegularFile): a named pipe in its place would block the server's only thread until something wrote to it.
 */
import { closeSync, constants as FS, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** One log line as lib/log.mjs formats it: an optional prefix, an ISO timestamp, a level, the event, key=value fields. */
const LINE = /^(?:\S+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+[A-Z]+\s+(\S+)(.*)$/;
const FIELD = /([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
/** A run id as the workflows write it: a folder name under .sdlc/runs, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINAL_GATE = "gate-4";
const ACCEPTED = /^(?:approved|accept)/i;

interface LogEvent { ms: number; event: string; fields: Record<string, string> }

/**
 * A file's text, read only when it is a regular file, else null (ambient/lib/workflow-log.mjs readRegularFile): it is
 * opened without blocking and without following a link, and judged on what was opened, so a named pipe, a link, a
 * folder or a device is no file and never stalls the reader.
 */
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NONBLOCK ?? 0) | (FS.O_NOFOLLOW ?? 0);
function readRegularText(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at).toString("utf8");
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** A rotated piece of a run log: orchestrator.log.<n>, n a positive integer (ambient/lib/workflow-log.mjs). */
const ROTATED = /^orchestrator\.log\.([1-9]\d{0,5})$/;

/** The whole text of a run's own log, oldest first: its rotated pieces (highest number first), then orchestrator.log. */
function readRunLogText(runDir: string): string {
  let names: string[] = [];
  try { names = readdirSync(runDir); } catch { return ""; }
  const pieces = names
    .map((n) => ROTATED.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => m[0]);
  if (names.includes("orchestrator.log")) pieces.push("orchestrator.log");
  return pieces.map((n) => readRegularText(join(runDir, n)) ?? "").filter(Boolean).join("\n");
}

function parseRunLog(text: string): LogEvent[] {
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
    const ms = Date.parse(m[1]);
    if (Number.isFinite(ms)) events.push({ ms, event: m[2], fields });
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
  return eventsEnded(parseRunLog(readRunLogText(join(projectRoot, ".sdlc", "runs", runId))));
}

/** The run-log event write-contract.mjs records at Gate 0 (plugin/scripts/lib/contract-lock.mjs FREEZE_EVENT). */
export const FREEZE_EVENT = "contract.freeze";
const SHA256 = /^[0-9a-f]{64}$/;

/** A live freeze record: `{run_id, sha256}`, or, for records write-contract.mjs never writes, `sha256: null` and why. */
export interface LiveFreeze { run_id: string; sha256: string | null; forged?: string }

/**
 * The live freeze record of the project, or null when no run that froze a contract is live. The hook's rule
 * (plugin/scripts/lib/contract-lock.mjs frozenBy), mirrored: each run's whole log is read (readRunLogText); a run is
 * live when its latest record is followed by no end of the run (eventsEnded over the events after it, run.start lines
 * left out: Gate 0 freezes before the orchestrator logs run.start). write-contract.mjs freezes a run once and never
 * while another run's record is live, so records that break that rule were not written by it and come back with
 * `sha256: null` and `forged` saying why (apply.ts contractTampered then refuses every write): live records of more than
 * one run (named by the first run by name), or more than one record in the one live run's log.
 * tools/test/write-contract-lock.test.mjs and test/runLogWhole.test.mjs run the hook's reader and this one on the same
 * logs.
 */
export function liveFreeze(projectRoot: string): LiveFreeze | null {
  const runs = join(projectRoot, ".sdlc", "runs");
  let names: string[] = [];
  try { names = readdirSync(runs); } catch { return null; }
  const live: Array<{ run_id: string; sha256: string; records: number }> = [];
  for (const name of [...names].sort()) {
    if (!RUN_ID.test(name)) continue;
    const text = readRunLogText(join(runs, name));
    if (!text.includes(FREEZE_EVENT)) continue;
    const events = parseRunLog(text);
    let at = -1, records = 0;
    events.forEach((e, i) => { if (e.event === FREEZE_EVENT && SHA256.test(String(e.fields.sha256 ?? ""))) { at = i; records++; } });
    if (at < 0) continue;
    if (eventsEnded(events.slice(at + 1).filter((e) => e.event !== "run.start"))) continue;
    live.push({ run_id: name, sha256: events[at].fields.sha256, records });
  }
  if (live.length === 0) return null;
  if (live.length > 1) {
    return { run_id: live[0].run_id, sha256: null, forged: `freeze records of ${live.length} runs are live (${live.map((l) => l.run_id).join(", ")}), and only one run at a time holds a project's contract` };
  }
  const [one] = live;
  if (one.records > 1) return { run_id: one.run_id, sha256: null, forged: `run ${one.run_id}'s log holds ${one.records} freeze records, and a run freezes its contract once` };
  return { run_id: one.run_id, sha256: one.sha256 };
}
