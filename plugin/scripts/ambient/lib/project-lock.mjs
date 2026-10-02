/**
 * One workflow at a time in one project (zero-touch chats only).
 *
 * Why: two chats in the same folder, each running a workflow, write into the same `.sdlc/runs/`, and each chat's
 * reading of "has my workflow ended?" (lib/workflow-log.mjs) could then see the other's run. The lock is one per
 * project under MMO_HOME, keyed by a hash of the project's real path, taken when a zero-touch chat starts a workflow
 * and removed when it ends there.
 *
 * Whether a lock still holds is decided from facts each time (ownerStillRunning): the owning chat must still be
 * running a workflow (its `sessions/<id>/pipeline` record exists; /clear, a workflow's end, "stop", and the workflow
 * reporting an early stop remove or mark it), its chat must still exist, and that workflow's own log must not show
 * it ended. The one age rule: a workflow that never reached its run stops holding the project after
 * NOT_STARTED_IDLE_MS idle. A lock that fails a test is stale and is replaced. The lock is a folder,
 * `projects/<key>/workflow.lock/owner.json`, taken atomically (acquire); a `projects/<key>/workflow.json` lock file,
 * the format an older build wrote, is still honoured while its owner runs, for compatibility only.
 *
 * The owner's Claude Code process: a chat closed in the middle of a workflow (the terminal exited, the desktop window
 * or app closed) and a desktop /clear (the app ends the chat's Claude Code process and starts a new chat; Claude
 * Code's own /clear, which sends SessionEnd "clear", runs only in the terminal) would leave the lock held until the
 * 30-day cleanup, refusing every workflow in the folder, typed /mmo: commands included. Every hook gets CLAUDE_PID,
 * the chat's Claude Code process (both the terminal and the desktop build set it), so the lock records it, and a lock
 * whose process is gone does not hold. A chat reopened in the middle of its workflow takes its lock back at its next
 * moment (refreshOwner). A lock written without a process id is judged by the other facts alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, mmoHome, safeId, sessionDir } from "./paths.mjs";
import { RUN_ID, workflowState } from "./workflow-log.mjs";

/** The Claude Code process this hook runs for (CLAUDE_PID), or null. */
function chatPid(env) {
  const pid = Number.parseInt(String(env.CLAUDE_PID ?? ""), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** Whether a process exists (one of another user counts: it exists, it only may not be signalled). */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

function key(projectDir) {
  let real = String(projectDir ?? "");
  try { real = realpathSync(real); } catch { /* keep the given path */ }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}
function lockFile(projectDir, env) {
  return join(mmoHome(env), "projects", key(projectDir), "workflow.json");
}
function readLock(projectDir, env) {
  try { return JSON.parse(readFileSync(lockFile(projectDir, env), "utf8")); } catch { return null; }
}

/** When the chat's workflow started, from its `pipeline` record (JSON, or the bare time an older build wrote). */
export function pipelineSinceOf(sid, env = process.env) {
  const file = join(sessionDir(sid, env), "pipeline");
  try {
    const text = readFileSync(file, "utf8").trim();
    let since = text;
    try { const rec = JSON.parse(text); if (rec && typeof rec === "object") since = rec.since; } catch { /* a bare time */ }
    const ms = Date.parse(since);
    return Number.isFinite(ms) ? ms : NaN;
  } catch { return NaN; }
}

/** The run the chat has claimed as its workflow's own (hook.mjs claimRun), or null before it has. */
export function pipelineRunOf(sid, env = process.env) {
  try {
    const rec = JSON.parse(readFileSync(join(sessionDir(sid, env), "pipeline"), "utf8"));
    return rec && typeof rec.run_id === "string" && RUN_ID.test(rec.run_id) ? rec.run_id : null;
  } catch { return null; }
}

/**
 * Whether another chat has claimed this run as its own (its pipeline record names it). Read only when a run is about
 * to be stopped without a claim of this chat's (hook.mjs, "Replace it"), so a run another chat owns is never stopped.
 */
export function runClaimedByOther(runId, sid, env = process.env) {
  if (!runId || !RUN_ID.test(runId)) return false;
  const root = join(mmoHome(env), "sessions");
  let names = [];
  try { names = readdirSync(root); } catch { return false; }
  for (const name of names) {
    if (name === safeId(sid)) continue;
    if (pipelineRunOf(name, env) === runId) return true;
  }
  return false;
}

/**
 * How long a workflow that has not reached its run yet (it is asking its first questions) may sit idle and still hold
 * the project: 30 minutes since its chat last changed. A stated bound, so a workflow stopped before its run (the
 * person said no to the plan, a check failed) does not hold the project until a 30-day cleanup, refusing every other
 * chat's workflow there. A started run is never released for being idle: it may be waiting at a gate.
 */
export const NOT_STARTED_IDLE_MS = 30 * 60_000;

/** The pipeline record of a chat: { since, job, args, policy?, run_id?, transcript?, stopped? }, or null. */
export function pipelineRecordOf(sid, env = process.env) {
  try {
    const rec = JSON.parse(readFileSync(join(sessionDir(sid, env), "pipeline"), "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch { return existsSync(join(sessionDir(sid, env), "pipeline")) ? {} : null; }
}

/**
 * Whether the chat that owns a lock still runs a workflow in this project, decided from facts:
 * its pipeline record exists and its workflow did not report stopping; its chat still exists (its transcript, when
 * recorded); its workflow's log does not show it ended; and a workflow that has not reached its run yet has not sat
 * idle longer than NOT_STARTED_IDLE_MS.
 */
export function ownerStillRunning(projectDir, owner, env = process.env, now = Date.now()) {
  if (!owner?.sid) return false;
  if (Number.isInteger(owner.pid) && owner.pid > 1 && !processAlive(owner.pid)) return false;
  const rec = pipelineRecordOf(owner.sid, env);
  if (!rec || rec.stopped) return false;
  if (typeof rec.transcript === "string" && rec.transcript && !existsSync(rec.transcript)) return false;
  const since = pipelineSinceOf(owner.sid, env);
  const state = workflowState(projectDir, since, pipelineRunOf(owner.sid, env)).state;
  if (state === "ended") return false;
  if (state === "not-started") {
    let last = since;
    try { if (typeof rec.transcript === "string" && rec.transcript) last = Math.max(last, statSync(rec.transcript).mtimeMs); } catch { /* the transcript check above */ }
    if (Number.isFinite(last) && now - last > NOT_STARTED_IDLE_MS) return false;
  }
  return true;
}

/** The lock's owner, whoever it is: { sid, job, since } (the lock folder first, then an older build's lock file). */
export function lockOwner(projectDir, env = process.env) {
  try { return JSON.parse(readFileSync(join(lockDir(projectDir, env), "owner.json"), "utf8")); } catch { /* none, or being written */ }
  return readLock(projectDir, env);
}

/** The chat that holds this project, when it is another chat whose workflow is still running; else null. */
export function heldByOther(projectDir, sid, env = process.env) {
  const owner = lockOwner(projectDir, env);
  if (!owner || owner.sid === sid) return null;
  return ownerStillRunning(projectDir, owner, env) ? owner : null;
}

function lockDir(projectDir, env) {
  return join(mmoHome(env), "projects", key(projectDir), "workflow.lock");
}

/**
 * Takes the project for this chat's workflow, atomically, so two chats starting at once cannot both check the lock,
 * both write it, and both run. The lock is a folder (creating one is atomic: exactly one
 * creator wins), holding owner.json. A stale lock (its owner no longer running a workflow here) is first renamed
 * away, which also only one chat can do. Returns { ok: true } or { ok: false, owner } when another chat's workflow
 * holds the project.
 */
export function acquire(projectDir, sid, job, env = process.env) {
  const dir = lockDir(projectDir, env);
  ensureDir(join(mmoHome(env), "projects"));
  ensureDir(join(mmoHome(env), "projects", key(projectDir)));
  // An older build's lock file (workflow.json): honoured while its owner still runs, removed once stale.
  const legacy = readLock(projectDir, env);
  if (legacy && legacy.sid !== sid) {
    if (ownerStillRunning(projectDir, legacy, env)) return { ok: false, owner: legacy };
    try { rmSync(lockFile(projectDir, env), { force: true }); } catch { /* already gone */ }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner.json"), JSON.stringify({ sid, job, since: new Date().toISOString(), pid: chatPid(env) }), { mode: 0o600 });
      return { ok: true };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    let owner = null;
    try { owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { /* just created by another chat */ }
    if (!owner) {
      // The folder exists but its owner is not written yet: a chat is taking it this instant, unless it is old.
      let age = 0;
      try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
      if (age < 5_000) return { ok: false, owner: { sid: null, job: null } };
    } else if (owner.sid === sid) {
      writeFileSync(join(dir, "owner.json"), JSON.stringify({ sid, job, since: new Date().toISOString(), pid: chatPid(env) }), { mode: 0o600 });
      return { ok: true };
    } else if (ownerStillRunning(projectDir, owner, env)) {
      return { ok: false, owner };
    }
    // Stale: move it out of the way (only one chat's rename succeeds), then try again.
    const aside = `${dir}.stale-${process.pid}-${attempt}`;
    try { renameSync(dir, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* another chat moved it first */ }
  }
  const owner = lockOwner(projectDir, env);
  return { ok: false, owner: owner ?? { sid: null, job: null } };
}

/**
 * A chat reopened in the middle of its workflow runs in a new Claude Code process: its lock names the old one, which
 * is gone. Called at every moment of a chat with a running workflow, it puts this process in the lock (only when this
 * chat holds it and the process differs), so the lock holds again.
 */
export function refreshOwner(projectDir, sid, env = process.env) {
  const pid = chatPid(env);
  if (!pid) return;
  const dir = lockDir(projectDir, env);
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { return; }
  if (!owner || owner.sid !== sid || owner.pid === pid) return;
  try { writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...owner, pid }), { mode: 0o600 }); } catch { /* asked again next moment */ }
}

/** Removes the lock when this chat holds it. */
export function release(projectDir, sid, env = process.env) {
  const dir = lockDir(projectDir, env);
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { /* no lock folder */ }
  if (owner && owner.sid === sid) {
    const aside = `${dir}.released-${process.pid}`;
    try { renameSync(dir, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  const legacy = readLock(projectDir, env);
  if (legacy && legacy.sid === sid) { try { rmSync(lockFile(projectDir, env), { force: true }); } catch { /* already gone */ } }
}
