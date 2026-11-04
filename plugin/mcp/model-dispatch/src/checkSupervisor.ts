/**
 * A command run under the plugin's check supervisor (scripts/lib/check-supervisor.mjs): the one way the server and the
 * plugin's scripts run a command in a project (a packet's checks, an acceptance command, a hand-off's test run, a
 * reviewer's file check), so the command's time limit, and its end with whoever asked for it, never depend on that
 * process staying alive.
 *
 * Why: each runner kept the limit as a timer in its own process, and a server killed mid-command (a restart, a closed
 * chat) left the command running in its own process group with no limit. The supervisor is a process of its own, in a
 * group of its own, that owns the command's group and its limit, and watches the pipe this process holds to it: when
 * the pipe ends, however this process ended, the command's group is killed at once.
 *
 * Each runner keeps its own reading of how a command ended (an exit code, a signal, the limit, a failed start): the
 * supervisor reports what happened and when, and the runner says it as before.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./paths.js";

export const CHECK_SUPERVISOR = join(PLUGIN_ROOT, "scripts", "lib", "check-supervisor.mjs");

/** How a supervised command ended. */
export interface SupervisedEnd {
  /** The shell's exit code once its output closed: null when a signal ended it, a negative errno when it could not start. */
  code: number | null;
  /** The signal that ended the shell, or null. */
  signal: string | null;
  /** The shell ended by itself before its time limit passed. */
  exited: boolean;
  /** The time limit passed before the command's output closed: its process group was killed. */
  timedOut: boolean;
  /** Why the shell could not start, or the supervisor could not, in Node's words. */
  error?: string;
}

export interface SupervisedCommand {
  /** The shell the command runs with, as `<shell> -c <command>`. */
  shell: string;
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  limitMs: number;
  /** Each chunk of the command's output, both streams as they arrive. */
  onOutput?: (chunk: Buffer) => void;
  /** A file the caller opened, which the command writes its output into itself (onOutput is not called). */
  logFd?: number;
  /** Once the shell ends, whatever it left running in its group is stopped too. */
  stopGroupOnExit?: boolean;
  /** At the limit the group is killed, and the output is still read until it closes. */
  keepOutputAtLimit?: boolean;
  /** A stop asked for while the command runs: its whole process group is killed at once. */
  signal?: AbortSignal;
}

export function runSupervised(c: SupervisedCommand): Promise<SupervisedEnd> {
  return new Promise((done) => {
    const flags = [
      ...(c.stopGroupOnExit ? ["--stop-group-on-exit"] : []),
      ...(c.keepOutputAtLimit ? ["--keep-output-at-limit"] : []),
      ...(c.logFd !== undefined ? ["--log"] : []),
    ];
    let child: ChildProcess;
    try {
      // --no-warnings: nothing of Node's own reaches the command's output, which the supervisor's stderr carries.
      child = spawn(process.execPath, ["--no-warnings", CHECK_SUPERVISOR, ...flags, String(c.limitMs), c.shell, c.cwd, c.command], {
        env: c.env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["pipe", "pipe", c.logFd ?? "pipe"],
      });
    } catch (e: any) {
      done({ code: null, signal: null, exited: false, timedOut: false, error: e?.message ?? String(e) });
      return;
    }
    let settled = false;
    const settle = (r: SupervisedEnd) => {
      if (settled) return;
      settled = true;
      c.signal?.removeEventListener("abort", stop);
      done(r);
    };
    // The supervisor's stdin is this process's pipe, held open and never ended, so its end is this process's own.
    const stop = () => { child.stdin?.write("stop\n"); };
    // A stop asked for after the supervisor has ended finds the pipe closed: there is nothing left to stop.
    child.stdin?.on("error", () => {});
    if (c.signal?.aborted) stop(); else c.signal?.addEventListener("abort", stop, { once: true });
    let verdict = "";
    child.stdout?.on("data", (d) => { verdict += d; });
    if (c.logFd === undefined) child.stderr?.on("data", (d: Buffer) => c.onOutput?.(d));
    child.on("error", (e) => settle({ code: null, signal: null, exited: false, timedOut: false, error: e.message }));
    child.on("close", () => {
      let v: any = null;
      try { v = JSON.parse(verdict.trim().split("\n").pop() ?? ""); } catch { /* no verdict */ }
      if (!v || typeof v !== "object") {
        settle({ code: null, signal: null, exited: false, timedOut: false, error: "the command's supervisor ended without saying how the command ended" });
        return;
      }
      settle({
        code: Number.isInteger(v.code) ? v.code : null,
        signal: typeof v.signal === "string" ? v.signal : null,
        exited: v.exited === true,
        timedOut: v.timedOut === true,
        ...(typeof v.error === "string" ? { error: v.error } : {}),
      });
    });
  });
}
