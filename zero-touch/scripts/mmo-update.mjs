/**
 * Brings the mmo plugin up to the version zero-touch needs, by itself.
 *
 * Why: zero-touch needs mmo, its dependency, at the version shipped beside it. Claude Code installs a missing
 * dependency with zero-touch, but leaves one that is already installed at its old version, even with a version range
 * in zero-touch's manifest ("mmo@^0.8.5"); only `claude plugin update mmo@…` moves it (checked on Claude Code 2.1.286,
 * installing zero-touch over an older mmo). So the first chat that finds mmo too old
 * (mark.mjs mmoState) starts Claude Code's own update of mmo, from the marketplace the person installed it from, at
 * the scope it was installed at, in the background, and says to start a new chat in a minute (plugins load when a
 * chat starts). A mmo the person switched off is "off", never "too-old", so it is never overruled; nothing else is
 * changed.
 *
 * One attempt at a time: zero-touch's data folder keeps the attempt (`mmo-update.json`, `mmo-update.exit` with the
 * update's exit code, `mmo-update.log` with its output). A chat within ten minutes of an attempt starts no second one:
 * while it runs, it says the update is under way; once it is over and mmo is still too old, it says what to do by
 * hand. After ten minutes a new attempt may start.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCommand } from "./readiness.mjs";
import { dataDir } from "./settings.mjs";

const ZT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** How long one attempt counts: no second update starts before, and a running one is trusted until then. */
export const ATTEMPT_MS = 10 * 60 * 1000;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const configDir = (env) => (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude"));

/**
 * The mmo install to update, from Claude Code's record of installed plugins: the one from zero-touch's own
 * marketplace first (the copy zero-touch runs with, as mark.mjs mmoRoot prefers it), at the scope it was installed
 * at. { id, scope, projectPath } or null (none recorded, or only one an organisation manages).
 */
export function mmoUpdateTarget(env = process.env, ztRoot = ZT_ROOT) {
  const installed = readJson(join(configDir(env), "plugins", "installed_plugins.json"))?.plugins;
  if (!installed || typeof installed !== "object") return null;
  const entries = (key) => (Array.isArray(installed[key]) ? installed[key] : []);
  const own = Object.keys(installed).find((key) => /^zero-touch@/.test(key) && entries(key).some((e) => typeof e?.installPath === "string" && realOr(e.installPath) === realOr(ztRoot)));
  const market = own ? own.slice("zero-touch@".length) : null;
  const keys = Object.keys(installed).filter((key) => /^mmo@[A-Za-z0-9][-A-Za-z0-9._]*$/.test(key)).sort((a, b) => Number(b === `mmo@${market}`) - Number(a === `mmo@${market}`));
  for (const id of keys) {
    for (const e of entries(id)) {
      const scope = e?.scope;
      if (scope === "user") return { id, scope, projectPath: null };
      if ((scope === "project" || scope === "local") && typeof e.projectPath === "string" && existsSync(e.projectPath)) return { id, scope, projectPath: e.projectPath };
    }
  }
  return null;
}

/** The attempt kept in zero-touch's data folder: { started, finished, ok } or null. */
export function lastAttempt(env = process.env) {
  const dir = dataDir(env);
  const rec = readJson(join(dir, "mmo-update.json"));
  if (!rec || typeof rec.started_at !== "string") return null;
  let exit = null;
  try { exit = readFileSync(join(dir, "mmo-update.exit"), "utf8").trim(); } catch { /* still running, or never ended */ }
  return { started: Date.parse(rec.started_at) || 0, finished: exit !== null && exit !== "", ok: exit === "0" };
}

/**
 * For a chat that found mmo too old: "running" when an update is under way (started now, or by another chat within
 * ATTEMPT_MS), or "failed" when it cannot be started or an attempt within ATTEMPT_MS is over (mmo is still too old,
 * so it did not help). `spawn`, `claude` and `now` are for tests.
 */
export function updateMmo(env = process.env, { spawn = nodeSpawn, claude = claudeCommand(env), now = Date.now(), ztRoot = ZT_ROOT } = {}) {
  const last = lastAttempt(env);
  if (last && now - last.started < ATTEMPT_MS) return last.finished ? "failed" : "running";
  const target = mmoUpdateTarget(env, ztRoot);
  if (!target || !claude) return "failed";
  const dir = dataDir(env);
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "mmo-update.exit"), { force: true });
    writeFileSync(join(dir, "mmo-update.json"), JSON.stringify({ started_at: new Date(now).toISOString(), id: target.id, scope: target.scope }), { mode: 0o600 });
    // The update, then its exit code: a shell keeps the two together after this hook has ended. Every value travels as
    // an argument, never inside the script text.
    const script = '"$0" plugin update "$1" --scope "$2" >"$3" 2>&1; echo $? >"$4"';
    const child = spawn("sh", ["-c", script, claude, target.id, target.scope, join(dir, "mmo-update.log"), join(dir, "mmo-update.exit")], {
      cwd: target.projectPath ?? homedir(),
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on?.("error", () => {});
    child.unref?.();
    return "running";
  } catch {
    return "failed";
  }
}
