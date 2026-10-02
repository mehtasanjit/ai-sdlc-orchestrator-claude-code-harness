/**
 * The setup check's other piece: Claude Code's own command-line program.
 *
 * Why: a new-app workflow types with Claude's models through that program (the last attempt at every step, whatever
 * models were chosen), and so do a Claude typist and the last attempt of every hand-off. A Mac with only the Claude
 * app has no `claude` command on PATH; the model server also finds the app's own copy
 * (plugin/mcp/model-dispatch/src/claudeCommand.ts, the same rule as here), so this is said only when neither exists.
 * Zero-touch carries no mmo code, so the rule is copied; tools/test/zero-touch-readiness.test.mjs runs both.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { KINDS, clean, mmoHome } from "./settings.mjs";

const executable = (file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** The `claude` program: the first on PATH, else the Claude app's own newest copy (macOS), else null. */
export function claudeCommand(env = process.env, { platform = process.platform } = {}) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) if (dir && executable(join(dir, "claude"))) return join(dir, "claude");
  if (platform !== "darwin") return null;
  const base = join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), "Library", "Application Support", "Claude", "claude-code");
  let versions = [];
  try { versions = readdirSync(base).filter((v) => /^\d+(\.\d+)*$/.test(v)); } catch { return null; }
  versions.sort((a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  for (const v of versions) {
    const file = join(base, v, "claude.app", "Contents", "MacOS", "claude");
    if (executable(file)) return file;
  }
  return null;
}

/** Whether these settings run Claude Code's command-line program: every workflow; a hand-off of any kind. */
/**
 * Whether a folder is inside a git project: a `.git` folder or file in it or above it. Read from the file system
 * only, so no git runs (on a Mac without the developer tools, git opens an install dialog).
 */
export function gitProject(dir) {
  if (typeof dir !== "string" || !dir) return false;
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** Hand-off settings that hand tests or repeated changes off: those are checked in a git test copy. */
export function needsGitHere(settings) {
  const s = clean(settings);
  return s.mode === "handoff" && (s.handoff.tests !== "chat" || s.handoff.repeats !== "chat");
}

export function needsClaudeCommand(settings) {
  const s = clean(settings);
  if (s.mode === "workflows") return true;
  if (s.mode === "handoff") return KINDS.some((k) => s.handoff[k] !== "chat");
  return false;
}

const readJsonQuiet = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/**
 * Workflows from plain words switched off by a setting file: "project" (the project's .sdlc/ambient.json) or "user"
 * (<MMO_HOME>/ambient.json), the files mmo's routing reads (plugin/scripts/ambient/lib/config.mjs), or null.
 */
export function routingOffBy(projectDir, env = process.env) {
  const off = (file) => readJsonQuiet(file)?.routing === "off";
  return off(join(projectDir, ".sdlc", "ambient.json")) ? "project" : off(join(mmoHome(env), "ambient.json")) ? "user" : null;
}

/**
 * Whether this person's workflows may run with auth=vendor (the mmo plugin's lib/claude-login.mjs and config.mjs): the
 * cost recording set to vendor in <MMO_HOME>/ambient.json or the project's .sdlc/ambient.json, or an API key set (a
 * key-only person gets vendor). Under vendor a run's helpers do not follow the chat's model, so no line promises that.
 * No program is run: unsure is no promise.
 */
export function mayBillKey(projectDir, env = process.env) {
  if (String(env.ANTHROPIC_API_KEY ?? "").trim()) return true;
  const vendor = (file) => readJsonQuiet(file)?.routing_defaults?.auth === "vendor";
  return vendor(join(mmoHome(env), "ambient.json")) || vendor(join(projectDir, ".sdlc", "ambient.json"));
}
