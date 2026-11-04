#!/usr/bin/env node
/**
 * One file check under a process of its own, which owns the check's process group and its time limit
 * (lib/change-spec.mjs runCheck starts it), so a check never runs on past the process that asked for it. That process,
 * a thinking step's tools (thinking-tools.mjs) or plan-lint, can end at any moment: the tools end with their worker's
 * process group when the kill rule or the person's Stop stops it. While the limit was a timer in that process, a check
 * whose caller ended ran on with no limit (review: a check with a 5 s limit still ran 8 s after its caller was gone).
 * This process leads a group of its own, out of reach of a signal to its caller's group. It stops the check's whole
 * group at the limit, and at once when its caller's end of this process's stdin closes, however the caller ended.
 *
 * Usage: check-supervisor.mjs <time limit, seconds> <folder> <command>. The command runs with a shell in the folder,
 * with this process's environment, in a process group of its own. Its output, both streams as they arrive, comes out
 * on this process's stderr. When it ends, one JSON line on this process's stdout says how: {code, timedOut}, its exit
 * code as Node reports it (null when a signal ended it) and whether its limit stopped it.
 */
import { spawn } from "node:child_process";

const [limit, cwd, cmd] = process.argv.slice(2);
let check = null;
let timer = null;
let timedOut = false;
let ended = false;
const stopGroup = () => { try { process.kill(-check.pid, "SIGKILL"); } catch { /* already gone */ } };

/** How the check ended, said once; this process then ends as soon as the check's output is passed on. */
function verdict(code) {
  if (ended) return;
  ended = true;
  clearTimeout(timer);
  process.stdin.destroy();
  process.stdout.write(JSON.stringify({ code, timedOut }) + "\n");
}

// The caller holds this process's stdin open while it waits on the check, so the pipe's end is the caller's own; a
// caller that can no longer be written to is gone too.
const callerGone = () => {
  if (ended) return;
  ended = true;
  if (check?.pid) stopGroup();
  process.exit(1);
};
process.stdin.on("end", callerGone).on("error", callerGone).resume();
process.stdout.on("error", callerGone);
process.stderr.on("error", callerGone);

try {
  check = spawn(cmd, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  process.stderr.write(String(e?.message ?? e));
  verdict(null);
}
if (check) {
  check.stdout.pipe(process.stderr, { end: false });
  check.stderr.pipe(process.stderr, { end: false });
  timer = setTimeout(() => {
    timedOut = true;
    stopGroup();
    check.stdout.destroy();
    check.stderr.destroy();
  }, Number(limit) * 1000);
  check.on("error", (e) => { process.stderr.write(String(e?.message ?? e)); verdict(null); });
  check.on("close", (code) => verdict(code));
}
