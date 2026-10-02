/**
 * When the server may run git. The server's twin of plugin/scripts/lib/git.mjs (the two packages cannot import each
 * other; tools/test/git-safety.test.mjs runs both on the same cases).
 *
 * Why: on a Mac without Apple's command-line developer tools, /usr/bin/git is a stub that opens an install dialog
 * whenever it runs. The server runs git for every hand-off's test copy and every run card, so to keep that dialog from
 * appearing from a background process, git runs only inside a git project, and only when a real git is installed.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** The nearest folder at or above `dir` that holds `.git` (a folder, or a file for a worktree), or null. */
export function gitRoot(dir: string): string | null {
  let d = resolve(String(dir ?? "."));
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function gitOnPath(env: Record<string, string | undefined>): string | null {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* not here */ }
  }
  return null;
}

const cache = new Map<string, boolean>();
type Run = (cmd: string, args: string[], opts: { stdio: "ignore"; timeout: number }) => { status: number | null };

/** Whether a real git can run here without side effects; on macOS the /usr/bin stub counts only with the developer tools. Cached per PATH. */
export function gitInstalled(opts: { platform?: string; env?: Record<string, string | undefined>; run?: Run } = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const key = `${platform}\0${env.PATH ?? ""}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const found = gitOnPath(env);
  let ok = found !== null;
  if (ok && platform === "darwin" && found === "/usr/bin/git") {
    // `xcode-select -p` exits 0 when the developer tools are installed and never opens the install dialog.
    const r = (opts.run ?? (spawnSync as unknown as Run))("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 2000 });
    ok = r.status === 0;
  }
  cache.set(key, ok);
  return ok;
}

/** For tests: forget what gitInstalled() found. */
export function forgetGitCheck(): void { cache.clear(); }
