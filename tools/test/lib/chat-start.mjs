/**
 * A real chat always begins with Claude Code's start moment (SessionStart, source "startup"), and zero-touch acts
 * only in a chat whose start the zero-touch plugin marked (zero-touch/scripts/start-chat.mjs writes the chat's record,
 * plugin/scripts/ambient/lib/chat-mode.mjs reads it). So a test chat starts the way a real chat with the zero-touch
 * plugin enabled does: the zero-touch plugin's start hook, then mmo's, once per chat and with the same
 * settings. A test that sends a chat's later moments straight to the hook gets that start first; a test that sends
 * the start moment itself (any source) gets the zero-touch hook run beside it, as Claude Code runs both plugins' start
 * hooks at the same moment. A test about a chat WITHOUT the plugin passes `zeroTouch: false`, or runs its own start.
 *
 * runOnce(event, payload, ...rest) sends one hook moment; keyOf(...rest) names the test's own home folder (MMO_HOME),
 * so two tests that reuse a chat id in different homes are two chats; envOf(...rest) gives that call's extra
 * environment, so a test's MMO_AMBIENT reaches the zero-touch hook too.
 *
 * Settings: a person sets zero-touch up in the settings box, and the plugin keeps the choices in its own
 * data folder (zero-touch/scripts/settings.mjs). A test person is one who has already chosen: each test home gets
 * `<home>/zt-data/settings.json`, Workflows on the standard models, unless the test wrote its own settings first
 * (writeZtSettings) or asks for the first chat after install (`firstRun: true`, no settings at all). A person who has
 * chosen models with Google's Flash 3.8 has connected Google, so the test home also gets a complete gcloud login file
 * (the file `gcloud auth application-default login` writes; nothing is ever sent anywhere); `google: false` leaves it out.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ZT_START = join(ROOT, "zero-touch", "hooks", "start-chat.sh");

/** The zero-touch plugin's data folder for a test home (Claude Code's ${CLAUDE_PLUGIN_DATA}). */
export const ztData = (home) => join(home, "zt-data");

/**
 * Saves a test person's zero-touch settings, as the settings box does: mode "workflows" | "handoff" | "off", and the
 * choices (workflows.models; handoff.chat_model / documents / tests / repeats: "flash" | "sonnet" | "chat").
 */
export function writeZtSettings(home, settings = {}, { google = true } = {}) {
  const dir = ztData(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, mode: "workflows", ...settings }));
  if (google) writeGoogleLogin(home);
}

/** A complete gcloud login file in a test home (its shape only: the Google check reads it offline). */
export function writeGoogleLogin(home) {
  const dir = join(home, ".config", "gcloud");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "application_default_credentials.json");
  // With its project: a sign-in with no Google Cloud project is not connected for zero-touch.
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "test", client_secret: "test", refresh_token: "test", quota_project_id: "test-project" }));
}

/**
 * Runs the zero-touch plugin's start hook for one chat, as Claude Code does at SessionStart while it is enabled.
 * `model` is the model Claude Code says the chat starts on, when it says so. The organisation settings file is one
 * inside the test's own home (absent unless the test writes it), never this machine's real one.
 */
export function zeroTouchStart({ home, sid, source = "startup", cwd, env = {}, model, firstRun = false }) {
  if (!firstRun && !existsSync(join(ztData(home), "settings.json"))) writeZtSettings(home);
  const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PLUGIN_DATA: ztData(home), MMO_MANAGED_SETTINGS: join(home, "managed-settings.json"), ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  spawnSync("sh", [ZT_START], { input: JSON.stringify({ session_id: sid, cwd, source, ...(model ? { model } : {}) }), env: childEnv, cwd });
}

export function startingChats(runOnce, keyOf, { envOf = () => ({}), zeroTouch = true } = {}) {
  const started = new Set();
  return async (event, payload, ...rest) => {
    const sid = payload && typeof payload === "object" ? payload.session_id : null;
    if (typeof sid === "string" && sid) {
      const key = `${keyOf(...rest)}\0${sid}`;
      const plugin = (source) => { if (zeroTouch) zeroTouchStart({ home: keyOf(...rest), sid, source, cwd: payload.cwd, env: envOf(...rest) ?? {}, model: event === "session-start" ? payload.model : undefined }); };
      if (event === "session-start") {
        started.add(key);
        plugin(payload.source);
      } else if (!started.has(key)) {
        started.add(key);
        plugin("startup");
        await runOnce("session-start", { session_id: sid, cwd: payload.cwd, source: "startup" }, ...rest);
      }
    }
    return runOnce(event, payload, ...rest);
  };
}

/**
 * Makes a test project a git project, as a real project being changed is: a change workflow zero-touch starts needs
 * git to undo what it changes, so a project folder without git gets "isn't saved with git yet" instead of a start. A
 * real `git init`; where git cannot run, a bare `.git` folder, which is all the start check looks for.
 */
export function gitProject(dir) {
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  if (r.status !== 0) mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

let claudeBin = null;
/**
 * A folder holding a stand-in `claude` command, for a test PATH: zero-touch's setup check says when
 * Claude Code's command-line program is missing, as it is on a test PATH of node and the system folders only. A real
 * install has it; tests about something else put this folder first.
 */
export function fakeClaudeBin() {
  if (claudeBin) return claudeBin;
  claudeBin = mkdtempSync(join(tmpdir(), "zt-claude-bin-"));
  writeFileSync(join(claudeBin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(claudeBin, "claude"), 0o755);
  return claudeBin;
}
