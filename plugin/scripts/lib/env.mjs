/**
 * Central env reader for the script layer (docs/brownfield-v1-planning/plan.md
 * D4 — specified, never built until now). Consolidates the reads that used
 * to be copy-pasted per script: project-root resolution, and the MMO_*
 * logging env vars' precedence. Importable freely within plugin/scripts/**
 * (one ESM layer) — the MCP server cannot import this (§3), so
 * plugin/mcp/model-dispatch/src/log.ts re-implements resolveLogLevel's
 * precedence independently.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitInstalled, gitRoot } from "./git.mjs";

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);

/**
 * The command layer resolves the project root once and passes it down
 * (--project-root <abs-path>), and should always pass it. Without it, inside
 * a git repository: the nearest folder holding `.sdlc/` (never above the git
 * root), then the git root, so a call from inside a project that sits in a
 * subfolder of a larger repository finds that project's `.sdlc/`. Outside
 * any git repository: cwd. Nothing there marks where a project ends, so an
 * ancestor's `.sdlc/` (the home folder's, or a parent folder's own project)
 * cannot be told apart from this project's.
 */
export function resolveProjectRoot(explicit, cwd = process.cwd()) {
  if (explicit) return explicit;
  // No git project here, or no real git: cwd, without starting git (lib/git.mjs: on a Mac without the developer
  // tools the git stub opens an install dialog).
  if (!gitRoot(cwd) || !gitInstalled()) return cwd;
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd });
  const top = r.status === 0 ? r.stdout.trim() : null;
  if (!top) return cwd;
  return nearestSdlc(cwd, top) ?? top;
}

function nearestSdlc(from, stopAt) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const stop = real(stopAt);
  let d = real(from);
  for (;;) {
    if (existsSync(join(d, ".sdlc"))) return d;
    if (d === stop) return null;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Highest precedence first: a per-call argument (passed explicitly by the
 * caller, since the MCP server process starts once per session and cannot
 * re-read its env mid-session), MMO_LOG_LEVEL, MMO_VERBOSE, MMO_DEBUG, the
 * legacy SDLC_DEBUG (warns once), default info.
 */
export function resolveLogLevel(env = process.env, explicit) {
  if (explicit && LEVELS.has(explicit)) return { level: explicit, legacyUsed: false };
  const named = env.MMO_LOG_LEVEL?.trim().toLowerCase();
  if (named && LEVELS.has(named)) return { level: named, legacyUsed: false };
  if (env.MMO_VERBOSE === "1") return { level: "debug", legacyUsed: false };
  if (env.MMO_DEBUG === "1") return { level: "debug", legacyUsed: false };
  if (env.SDLC_DEBUG === "1") return { level: "debug", legacyUsed: true };
  return { level: "info", legacyUsed: false };
}
