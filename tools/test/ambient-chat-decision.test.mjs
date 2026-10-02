/**
 * Each chat is decided once, when it starts. Read at different moments, an on/off setting changed
 * mid-chat would leave a chat half on and half off. So the decision is the chat's record, written once at its start by
 * the zero-touch plugin (enabled in Claude Code's plugin list: every new chat gets it; disabled: none does), and it
 * holds for the whole chat; a change reaches new chats only. A chat with no record is off. No settings file takes
 * part. What "on" shows here: a message the rules recognise as a job gets the instruction to start its workflow.
 *
 * Every hook case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
// Routing asks the workflows' own model check, which needs the built server; see tools/test/lib/server-built.mjs.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { chatMode } = await import(join(A, "lib", "chat-mode.mjs"));
const { zeroTouchStart, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));

/** A project folder with no git: "existing" has a manifest, "new" is empty. `plugin` says whether zero-touch is enabled. */
function sandbox(kind) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-chat-decision-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") gitProject(repo), writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  // A mode in ambient.json is ignored: a file saying "on" must not turn a chat on, nor "off" turn one off.
  const setFile = (m) => writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: m }));
  return { dir, home, repo, setFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(event, payload, { home, repo }) {
  return new Promise((done) => {
    const env = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}

/** The chat's start moment: with the zero-touch plugin enabled, its start hook runs beside mmo's, as in Claude Code. */
const start = async (s, sid, source = "startup", { plugin = true } = {}) => {
  if (plugin) zeroTouchStart({ home: s.home, sid, source, cwd: s.repo });
  return run("session-start", { session_id: sid, cwd: s.repo, source }, s);
};
const prompt = (s, sid, text) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}` }, s);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const ROUTED = /"mmo:bugfix"/;
const JOB = "fix the /login endpoint returning 500 on missing password"; // a bug-fix job the rules recognise

test("a chat that started with the zero-touch plugin disabled stays off for its whole life, even after it is enabled", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    s.setFile("on");
    await start(s, "c1", "startup", { plugin: false });
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), null, "no start record: the chat is off, whatever the old file says");
    // Enabling the plugin now writes nothing into this chat: its start hook runs only when a chat starts.
    assert.equal(context(await prompt(s, "c1", JOB)), "", "nothing is routed: the chat did not start with zero-touch on");
    await start(s, "c2");
    assert.match(context(await prompt(s, "c2", JOB)), ROUTED, "a new chat started with the plugin enabled gets zero-touch");
  } finally { s.cleanup(); }
});

test("a chat that started with zero-touch on keeps it until it ends, even after the plugin is disabled", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await start(s, "c1");
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on");
    s.setFile("off"); // the file's mode: ignored
    assert.match(context(await prompt(s, "c1", JOB)), ROUTED, "the chat was decided at its start");
    await start(s, "c2", "startup", { plugin: false }); // the plugin is disabled now
    assert.equal(context(await prompt(s, "c2", JOB)), "", "the next chat is off");
  } finally { s.cleanup(); }
});

test("a reopened chat with no start record stays off; /clear is a new start and decides again", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await start(s, "c1", "resume");
    assert.equal(context(await prompt(s, "c1", JOB)), "", "a chat older than the setting (or than the plugin) is off");
    await start(s, "c1", "clear");
    assert.match(context(await prompt(s, "c1", JOB)), ROUTED, "after /clear the fresh conversation is decided anew");
    await start(s, "c1", "compact");
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on", "a compaction keeps the chat's decision");
  } finally { s.cleanup(); }
});

test("a change to the project during the chat does not hold a job back: routing depends on the chat being idle, not on untouched files", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await start(s, "c1");
    mkdirSync(join(s.repo, "src"));
    writeFileSync(join(s.repo, "src", "a.js"), "export const a = 1;\n"); // a change the hook did not see (an editor, a formatter)
    assert.match(context(await prompt(s, "c1", JOB)), /"mmo:bugfix"/, "like typing the command: the job starts");
    assert.ok(!existsSync(join(s.home, "sessions", "c1", "git_baseline")), "no record of the project is taken any more");
  } finally { s.cleanup(); }
});
