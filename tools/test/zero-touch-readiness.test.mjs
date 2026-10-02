/**
 * The setup check: what the chosen settings need, checked the moment they are chosen and at every chat's
 * start, so the person hears "ready" or exactly what is missing, never later from a workflow that fails.
 *
 * Covered here: Claude Code's command-line program (on PATH, else the Claude app's own copy; the model server and
 * zero-touch must agree, since one decides what runs and the other what is said), Google (a sign-in Google turned
 * down vs one it could not be reached for; settings only the terminal sees), and the saved line's result.
 *
 * Offline: temporary folders, stand-in programs; no network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const R = await import(join(ROOT, "zero-touch", "scripts", "readiness.mjs"));
const G = await import(join(ROOT, "zero-touch", "scripts", "google.mjs"));
const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
const { findClaude } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "claudeCommand.js"));
const VS = await import(join(ROOT, "plugin", "scripts", "verify-setup.mjs"));

const program = (file) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o755); return file; };

test("Claude Code's program: on PATH first, else the Claude app's newest copy, else none; the server and zero-touch agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-ready-"));
  try {
    const home = join(dir, "home");
    const app = (v) => join(home, "Library", "Application Support", "Claude", "claude-code", v, "claude.app", "Contents", "MacOS", "claude");
    const both = (env, platform) => {
      const z = R.claudeCommand(env, { platform });
      assert.equal(findClaude(env, platform), z, "the server and zero-touch find the same program");
      assert.equal(VS.findClaude(env, platform), z, "and so does mmo's own setup check");
      return z;
    };
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "darwin"), null, "nothing anywhere");
    program(app("2.1.39"));
    program(app("2.1.284"));
    mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.300"), { recursive: true }); // a newer folder without the program
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "darwin"), app("2.1.284"), "the newest copy that is really there");
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "linux"), null, "the app's copy is a macOS place only");
    const onPath = program(join(dir, "bin", "claude"));
    assert.equal(both({ PATH: `${join(dir, "none")}:${join(dir, "bin")}`, HOME: home }, "darwin"), onPath, "PATH first, as before");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("which settings need it: every workflow; Hand-off only when something is handed off", () => {
  assert.equal(R.needsClaudeCommand({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } }), true);
  assert.equal(R.needsClaudeCommand({ mode: "handoff", handoff: { documents: "flash", tests: "chat", repeats: "chat" } }), true);
  assert.equal(R.needsClaudeCommand({ mode: "handoff", handoff: { documents: "chat", tests: "chat", repeats: "chat" } }), false);
  assert.equal(R.needsClaudeCommand({ mode: "off" }), false);
});

test("Google: turned down is said as such, not reached is not called refused, and the person never reads raw output", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-ready-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
    writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c", quota_project_id: "p1" }));
    const answer = (stderr) => G.onlineCheck({ HOME: home }, { run: () => ({ status: 1, stdout: "", stderr }) });
    for (const e of ["ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed.", "invalid_grant: Token has been expired or revoked.", "ERROR: Please run:\n  $ gcloud auth application-default login"]) assert.equal(answer(e).result, "refused", e);
    for (const e of ["ERROR: There was a problem refreshing your current auth tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded", "Could not resolve host", "ERROR: gcloud crashed (ProxyError)"]) assert.equal(answer(e).result, "unknown", `not reached is not refused: ${e}`);
    const line = M.googleLine({ mode: "workflows" }, { online: "refused", detail: "ERROR: Reauthentication failed." });
    assert.doesNotMatch(line, /ERROR|Reauthentication|gcloud|\//, "no raw output, command or path");
    const broken = M.googleLine({ mode: "workflows" }, { state: "broken", detail: "/Users/x/.config/gcloud/application_default_credentials.json is not valid JSON" });
    assert.doesNotMatch(broken, /\.json|\/Users|not valid JSON/);
    // Signed in, no project: its own plain line.
    assert.equal(M.googleLine({ mode: "workflows" }, { state: "no-project" }), `• This computer is signed in to Google Cloud, but no Google Cloud project is chosen for it, so Google's Flash 3.8 can't be used yet. Until one is, workflows won't start. To fix it, ask Claude: "help me connect Google for zero-touch". Or type "change zero-touch settings" and choose models without Flash.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Google set up for the terminal only: names found in the shell's start-up files, never values; the line says why the app can't see it", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-ready-"));
  try {
    writeFileSync(join(dir, ".zshrc"), "export PATH=$PATH:/x\nexport GEMINI_API_KEY=AIza-secret\n# export GOOGLE_CLOUD_PROJECT=commented\n");
    writeFileSync(join(dir, ".bash_profile"), "GOOGLE_CLOUD_PROJECT=my-proj\n");
    const r = G.googleReadiness({ HOME: dir, PATH: "/usr/bin" });
    assert.equal(r.connected, false);
    assert.deepEqual(r.shellOnly.sort(), ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]);
    assert.doesNotMatch(JSON.stringify(r), /AIza-secret|my-proj/, "values are never read into the answer");
    assert.equal(G.googleReadiness({ HOME: dir, GEMINI_API_KEY: "k" }).connected, true, "set where this process sees it: connected, nothing to say");
    const line = M.googleLine({ mode: "workflows" }, r);
    assert.match(line, /set up for the terminal only, and the Claude app doesn't read the terminal's settings/);
    const note = M.connectGoogleNote(r);
    assert.match(note, /GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_PROJECT, GEMINI_API_KEY/);
    assert.match(note, /~\/\.claude\/settings\.json, inside its "env" block/);
    assert.match(note, /Never ask for, read, write or repeat a key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the saved line ends with the setup check: ready, or what is missing; the first chat never says to resend when something is", () => {
  const ready = M.savedLine({ mode: "workflows" }, { first: true });
  assert.match(ready, /Send your request again/);
  assert.match(ready, /\nSetup check: everything these settings need is ready on this computer\.$/);
  const noGoogle = M.savedLine({ mode: "workflows" }, { first: true, google: { state: "none" } });
  assert.doesNotMatch(noGoogle, /Send your request again/, "never both: resend AND workflows won't start");
  assert.match(noGoogle, /Once the missing piece below is fixed, ask again in a new chat\.\nSetup check: one thing is missing on this computer\.\n• Google's Flash 3\.8 can't be used yet/);
  const two = M.savedLine({ mode: "workflows" }, { google: { state: "none" }, claudeMissing: true });
  assert.match(two, /Setup check: two things are missing on this computer\.\n• Google[^\n]+\n• Claude Code's command-line program wasn't found on this computer, so new-app workflows can't run yet\./);
  assert.doesNotMatch(M.savedLine({ mode: "off" }), /Setup check/, "Off needs nothing");
  assert.match(M.savedNote({ mode: "workflows" }, { first: true, missing: true }), /Do not ask them to send their request again now/);
  // The first message is judged even when something is missing: a plain question is answered, and the person is not
  // sent to a new chat.
  const judged = M.savedLine({ mode: "workflows" }, { first: true, google: { state: "none" }, replay: true });
  assert.match(judged, /Zero-touch now looks at your first message: if it asks for one of these jobs, its full workflow can start in a new chat once the missing piece below is fixed; anything else gets a normal answer\.\nSetup check: one thing is missing/);
  assert.match(M.savedNote({ mode: "workflows" }, { first: true, missing: true, replay: true }), /zero-touch judges the person's first message itself: it either starts that message's workflow, says why it cannot start, or hands the message back/);
  // Workflows switched off by a setting file, or mmo not usable here: Claude answers the first message now.
  assert.match(M.savedLine({ mode: "workflows" }, { first: true, routingOff: "user" }), /Claude now answers your message\.[\s\S]*Workflows from plain words are switched off by a zero-touch setting file/);
  assert.match(M.savedNote({ mode: "workflows" }, { first: true, answersNow: true }), /Now answer the person's first message\./);
  // Off chosen in an open chat: said as it happens.
  assert.equal(M.savedLine({ mode: "off" }), "Zero-touch: your settings are saved: Off. Zero-touch stops in this chat from your next message (a workflow already running here finishes first), and new chats start without it.");
  assert.doesNotMatch(M.savedNote({ mode: "workflows" }, { first: true }), /missing/);
});

test("through the real hook: asking for help connecting Google gives Claude the fixed steps; a chat start says when the program is missing", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeZtSettings, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "zt-ready-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    writeZtSettings(home, { mode: "workflows" }, { google: false });
    const env = { PATH: `${join(dir, "none")}:/usr/bin:/bin:${resolve(process.execPath, "..")}`, HOME: home, MMO_HOME: home, CLAUDE_PLUGIN_DATA: ztData(home) };
    const sh = (script, args, payload) => spawnSync("sh", [join(ROOT, "zero-touch", "hooks", script), ...args], { input: JSON.stringify(payload), env, encoding: "utf8" });
    const start = JSON.parse(sh("start-chat.sh", [], { session_id: "c1", source: "startup" }).stdout);
    assert.match(start.systemMessage, /• Google's Flash 3\.8 can't be used yet/);
    assert.match(start.systemMessage, /• Claude Code's command-line program wasn't found on this computer, so new-app workflows can't run yet\./);
    const help = JSON.parse(sh("settings.sh", ["prompt"], { session_id: "c1", prompt: `${M.CONNECT_GOOGLE}` }).stdout);
    assert.ok(help.hookSpecificOutput.additionalContext.includes(M.connectGoogleNote(G.googleReadiness(env))), "the fixed steps, for this computer");
    const other = JSON.parse(sh("settings.sh", ["prompt"], { session_id: "c1", prompt: "is zero-touch on?" }).stdout);
    assert.doesNotMatch(other.hookSpecificOutput.additionalContext, /aistudio/, "only when the message is about Google");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
