#!/usr/bin/env node
/**
 * One command the plugin runs in a project, under a process of its own that owns the command's process group and its
 * time limit, so a command never runs on past the process that asked for it: the server (a packet's checks, an
 * acceptance command, a hand-off's test run: src/checkSupervisor.ts) or a script (a reviewer's file check, plan-lint:
 * lib/change-spec.mjs runCheck). That process can end at any moment: a thinking step's tools end with their worker's
 * process group when the kill rule or the person's Stop stops it, and the server ends with a restart or a closed chat.
 * While the limit was a timer in that process, a command whose caller ended ran on with no limit (review: a check with
 * a 5 s limit still ran 8 s after its caller was gone). This process leads a group of its own, out of reach of a
 * signal to its caller's group. It stops the command's whole group at the limit, and at once when its caller's end of
 * this process's stdin closes, however the caller ended.
 *
 * Usage: check-supervisor.mjs [--stop-group-on-exit] [--keep-output-at-limit] [--log] <time limit, ms> <shell> <folder>
 * <command>. The command runs as `<shell> -c <command>` in the folder, with this process's environment, in a process
 * group of its own.
 *   - Its output, both streams as they arrive, comes out on this process's stderr; with --log, this process's stderr is
 *     a file the caller opened, and the command writes its output there itself.
 *   - --stop-group-on-exit: once the shell ends, whatever it left running in its group is stopped too.
 *   - At the limit the group is killed, and its output is no longer waited for, unless --keep-output-at-limit.
 *   - stdin: a pipe the caller holds open; a line on it asks for a stop (the group is killed at once, and the command
 *     ends as killed); its end is the caller's own (the group is killed, and this process ends).
 *   - When the command's output has closed, one JSON line on stdout says how it ended: {code, signal, exited,
 *     timedOut, error?}: its exit code as Node reports it then (null when a signal ended it, a negative errno when the
 *     shell could not start), the signal that ended it, whether it ended by itself before the limit, whether the
 *     limit came first, and why the shell could not start.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flags = new Set();
while (args[0]?.startsWith("--")) flags.add(args.shift());
const [limitMs, shell, cwd, command] = args;
const log = flags.has("--log");
let check = null;
let timer = null;
let exited = false;
let timedOut = false;
let signal = null;
let error;
let ended = false;
const stopGroup = () => { try { process.kill(-check.pid, "SIGKILL"); } catch { /* already gone */ } };

/** How the command ended, said once; this process then ends as soon as the command's output is passed on. */
function verdict(code) {
  if (ended) return;
  ended = true;
  clearTimeout(timer);
  process.stdin.destroy();
  process.stdout.write(JSON.stringify({ code, signal, exited, timedOut, ...(error !== undefined ? { error } : {}) }) + "\n");
}

// The caller holds this process's stdin open while it waits on the command, so the pipe's end is the caller's own; a
// caller that can no longer be written to is gone too.
const callerGone = () => {
  if (ended) return;
  ended = true;
  if (check?.pid) stopGroup();
  process.exit(1);
};
process.stdin.on("data", () => { if (check?.pid) stopGroup(); }).on("end", callerGone).on("error", callerGone);
process.stdout.on("error", callerGone);
process.stderr.on("error", callerGone);

try {
  check = spawn(shell, ["-c", command], { cwd, detached: true, stdio: ["ignore", log ? 2 : "pipe", log ? 2 : "pipe"] });
} catch (e) {
  error = String(e?.message ?? e);
  verdict(null);
}
if (check) {
  if (!log) {
    check.stdout.pipe(process.stderr, { end: false });
    check.stderr.pipe(process.stderr, { end: false });
  }
  timer = setTimeout(() => {
    timedOut = true;
    stopGroup();
    // Whatever still holds the output open (something that left the group) no longer delays the verdict.
    if (!log && !flags.has("--keep-output-at-limit")) {
      check.stdout.destroy();
      check.stderr.destroy();
    }
  }, Number(limitMs));
  check.on("exit", (code, sig) => {
    if (!timedOut) exited = true;
    signal = sig;
    if (flags.has("--stop-group-on-exit")) stopGroup();
  });
  check.on("error", (e) => { error = String(e?.message ?? e); });
  check.on("close", (code) => verdict(code));
}
