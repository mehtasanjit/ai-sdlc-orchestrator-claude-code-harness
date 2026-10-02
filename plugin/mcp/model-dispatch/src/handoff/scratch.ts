/**
 * The scratch copy a hand-off is checked in (zero-touch hand-off mode).
 *
 * Tests written by the hand-off model, and a change repeated across files, are RUN before they reach the project, in
 * a copy of the project, with a command the chat's model named. The project itself is never the place a hand-off is
 * tried out: a test file that does not pass, or an edit that breaks the build, must leave no trace in it.
 *
 * The copy holds the repository's own files as they are on disk now (tracked files and new ones, uncommitted work
 * included), as real copies, so whatever the command writes over them stays in the copy. It is the WHOLE repository,
 * from its top folder, and the command runs in the copy of the chat's folder (`cwd`): a package inside a monorepo
 * finds its workspace's dependencies and configuration as it does in the project (a copy of the package alone would
 * fail every test with "Cannot find module").
 *
 * What git ignores is never linked as a whole: a build or test command run in the copy would write into the real
 * project's dist/ and coverage/ through such links. Only installed-dependency folders are linked (DEPENDENCY_DIRS:
 * large, and the command needs them; a tool's cache inside one may still be written, as it would be by the person's
 * own run); an ignored file of up to 1 MB is copied
 * (a local .env, a generated config); anything else ignored (build output, coverage, caches) is left out, and the
 * command rebuilds it in the copy if it needs it. Git is what tells the kinds apart, so a project that is not a git
 * repository gets no copy and the hand-off is refused with that reason; the chat's model then does the work itself.
 *
 * Nothing is written into the repository to make the copy (no commit, no worktree): the file lists come from
 * `git ls-files`, and the copy lives under the system's temp folder until `remove()`.
 */
import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gitInstalled, gitRoot } from "../git.js";

// `cause: "no-git"`: the one refusal the person is told about in their own words (the hook's receipt
// line), so it travels as a fixed code beside the reason the model reads.
// `cause: "git-missing"`: git itself is not installed (on a Mac, the developer tools are missing), told
// apart from a project that does not use git, so the person is told the true reason.
export type ScratchCopy = { dir: string; cwd: string; remove(): void; refused?: undefined } | { refused: string; cause?: "no-git" | "git-missing"; dir?: undefined };

/** Ignored folders that hold installed dependencies: linked into the copy, never copied (see above). */
export const DEPENDENCY_DIRS = new Set(["node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn", ".venv", "venv", "__pypackages__", "vendor", "Pods", ".bundle", "elm-stuff", "deps"]);
/** The largest ignored file copied into the copy. */
export const IGNORED_FILE_COPIED_MAX_BYTES = 1 << 20;

function gitList(projectDir: string, args: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", ...args], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 256 << 20 }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

/**
 * Why no scratch copy can be made of this project, before anything is done (the repeated change asks it first), or
 * null when git can make one. Never starts git where it cannot help (src/git.ts): no real git
 * installed, or no git project here. On a Mac without the developer tools, starting git would open an install dialog.
 */
export function gitProblem(projectDir: string): { refused: string; cause: "no-git" | "git-missing" } | null {
  if (!gitInstalled()) {
    return { refused: "git is not installed on this computer, so a scratch copy cannot tell the project's own files from installed dependencies and the hand-off cannot be checked", cause: "git-missing" };
  }
  if (!gitRoot(resolve(projectDir))) {
    return { refused: "the project is not a git repository, so a scratch copy cannot tell its own files from installed dependencies and the hand-off cannot be checked", cause: "no-git" };
  }
  return null;
}

/** A copy of the project folder to run a command in, or why there is none. */
export function makeScratchCopy(projectDir: string): ScratchCopy {
  const folder = resolve(projectDir);
  const problem = gitProblem(folder);
  if (problem) return problem;
  const root = gitRoot(folder)!;
  // The chat's folder inside the repository ("" at its top): where the command runs in the copy.
  const cwd = relative(root, folder).split(sep).join("/");
  let own: string[];
  let ignored: string[];
  try {
    // The project's own files: tracked ones and new ones git does not ignore, from the project folder down.
    own = gitList(root, ["--cached", "--others", "--exclude-standard"]);
    // What git ignores, a wholly ignored folder as one entry ("node_modules/").
    ignored = gitList(root, ["--others", "--ignored", "--exclude-standard", "--directory"]);
  } catch {
    return { refused: "the project is not a git repository, so a scratch copy cannot tell its own files from installed dependencies and the hand-off cannot be checked", cause: "no-git" };
  }
  const dir = mkdtempSync(join(tmpdir(), "mmo-handoff-scratch-"));
  const remove = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ } };
  try {
    for (const rel of new Set(own)) {
      const from = join(root, rel);
      let stat;
      try { stat = lstatSync(from); } catch { continue; } // deleted since it was tracked
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      // Copy-on-write where the file system has it, so a large project costs no time and no disk until written to.
      else if (stat.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE);
      // A directory here is another repository inside this one (a submodule): not the project's own files.
    }
    for (const entry of ignored) {
      const rel = entry.replace(/\/$/, "");
      if (!rel || rel === ".git" || rel.startsWith(".git/")) continue;
      const from = join(root, rel);
      const to = join(dir, rel);
      try {
        const stat = lstatSync(from);
        if (stat.isDirectory() && DEPENDENCY_DIRS.has(basename(rel))) {
          mkdirSync(dirname(to), { recursive: true });
          symlinkSync(from, to);
        } else if (stat.isFile() && stat.size <= IGNORED_FILE_COPIED_MAX_BYTES) {
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to, constants.COPYFILE_FICLONE);
        }
        // Anything else ignored (build output, coverage, caches, a large file) stays out of the copy.
      } catch { /* gone since it was listed, already there, or a link this system will not make: the command runs without it */ }
    }
  } catch (e: any) {
    remove();
    return { refused: `a scratch copy of the project could not be made: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { dir, cwd, remove };
}

/**
 * How much of a command's output is kept: its end. One test file's or one build's failure report is far shorter;
 * a longer output is a runner's progress noise, which comes first. A stated bound, so a runaway command cannot fill
 * the server's memory or a typist's brief.
 */
export const RUN_OUTPUT_KEPT_CHARS = 8000;

export interface ScratchRun { code: number | null; output: string; timedOut: boolean; ms: number }

/**
 * Runs the person's own command in the copy (through `sh -c`, as they would type it), both output streams together.
 * CI=1 tells test runners not to wait for a person (no watch mode, no prompts). A command past its time limit is
 * stopped, its whole process group with it.
 */
export function runInScratch(dir: string, command: string, opts: { timeoutMs: number; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<ScratchRun> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd ? join(dir, opts.cwd) : dir, env: { ...(opts.env ?? process.env), CI: "1" } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let cut = false;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > RUN_OUTPUT_KEPT_CHARS * 2) { output = output.slice(-RUN_OUTPUT_KEPT_CHARS); cut = true; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, opts.timeoutMs);
    // The person stopped the hand-off: the command's whole process group ends at once.
    const onAbort = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => { output += String(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (output.length > RUN_OUTPUT_KEPT_CHARS) { output = output.slice(-RUN_OUTPUT_KEPT_CHARS); cut = true; }
      // A cut never starts in the middle of a line.
      if (cut) output = "[earlier output cut]\n" + output.slice(output.indexOf("\n") + 1);
      done({ code: timedOut ? (code ?? 124) : code, output, timedOut, ms: Date.now() - started });
    });
  });
}
