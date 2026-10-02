/**
 * Which `claude` program the server runs.
 *
 * Why: a new-app workflow types with Claude's models through Claude Code's own command-line program (the last attempt
 * at every step, whatever models were chosen), and so do a Claude typist and the last attempt of every hand-off. A Mac
 * with only the Claude app has no `claude` on PATH: the app keeps its own copy at
 * ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude. The rule: the first
 * `claude` on PATH; else the app's newest copy; else "claude" (the callers' own "not found" answers stand).
 *
 * zero-touch's setup check (zero-touch/scripts/readiness.mjs) applies the same rule, and
 * tools/test/zero-touch-readiness.test.mjs runs both.
 */
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const executable = (file: string): boolean => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** Newest first: "2.1.284" before "2.1.39". */
function byVersionDesc(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** The `claude` program's full path, or null when there is none. */
export function findClaude(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | null {
  for (const dir of String(env.PATH ?? "").split(delimiter)) if (dir && executable(join(dir, "claude"))) return join(dir, "claude");
  if (platform !== "darwin") return null;
  const base = join(env.HOME?.trim() || homedir(), "Library", "Application Support", "Claude", "claude-code");
  let versions: string[] = [];
  try { versions = readdirSync(base).filter((v) => /^\d+(\.\d+)*$/.test(v)); } catch { return null; }
  for (const v of versions.sort(byVersionDesc)) {
    const file = join(base, v, "claude.app", "Contents", "MacOS", "claude");
    if (executable(file)) return file;
  }
  return null;
}

/** What to run: the program found, else "claude", so a machine without one fails with the callers' own words. */
export function claudeCommand(env: Record<string, string | undefined> = process.env): string {
  return findClaude(env) ?? "claude";
}
