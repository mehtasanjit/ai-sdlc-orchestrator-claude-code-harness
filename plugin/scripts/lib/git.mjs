/**
 * When it is safe to run git.
 *
 * Why: on a Mac without Apple's command-line developer tools, /usr/bin/git is a stub that opens a system dialog
 * offering to install them every time it runs. The plugin asks on every typed message whether a folder is a project
 * (to tell a new folder from an existing project), so to keep that dialog from appearing after each message, git is
 * run only where a git project exists, and only when a real git is installed.
 *
 * Exports: gitRoot(dir) (the nearest folder at or above `dir` holding `.git`, or null; no process is started),
 * gitInstalled() (a real git is on PATH; on macOS the /usr/bin stub counts only when the developer tools are
 * installed, checked with `xcode-select -p`, which never opens a dialog).
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** The nearest folder at or above `dir` that holds `.git` (a folder, or a file for a worktree), or null. */
export function gitRoot(dir) {
  let d = resolve(String(dir ?? "."));
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The first `git` on PATH, or null. */
function gitOnPath(env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* not here */ }
  }
  return null;
}

const cache = new Map();
/**
 * Whether a real git can run on this computer without side effects. `platform`, `env` and `run` are for tests.
 * Cached per PATH, so a hook asks the system at most once.
 */
export function gitInstalled({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const key = `${platform}\0${env.PATH ?? ""}`;
  if (cache.has(key)) return cache.get(key);
  const found = gitOnPath(env);
  let ok = found !== null;
  if (ok && platform === "darwin" && found === "/usr/bin/git") {
    // The system stub: real only when the developer tools are installed. xcode-select -p prints their folder and
    // exits 0 when they are; it never opens the install dialog.
    const r = run("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 2000 });
    ok = r.status === 0;
  }
  cache.set(key, ok);
  return ok;
}

/** For tests: forget what gitInstalled() found. */
export function forgetGitCheck() { cache.clear(); }
