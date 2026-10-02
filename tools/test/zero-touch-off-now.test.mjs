/**
 * Turning zero-touch off reaches every chat, and zero-touch says when it cannot act.
 *
 *   - A chat keeps the mode it started with, so other changes of the settings reach new chats only; but Off
 *     reaches an open or reopened chat at its next message: the chat lets go of everything zero-touch held for it and
 *     the person reads one line. Not while one of its workflows runs (that run ends as it would).
 *   - Disabling or uninstalling the zero-touch plugin: its hooks (the workflow and hand-off hooks included, since they
 *     are registered in zero-touch's own list) are then not run at all, so nothing acts in any chat.
 *   - An mmo switched off at the scope that decides, gone, or older than zero-touch needs: no chat is
 *     marked, the person is told, Claude is told not to offer the settings, and a save says what is missing.
 *   - The old-records sweep runs from zero-touch's own start hook too, Off included.
 *   - Zero-touch stopping in a chat after repeated errors is said once.
 *   - The mode in force is read by one rule in mmo's hooks and in the model server's listing.
 *
 * Offline: temporary homes; mmo's real hooks through the shell shims.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings, gitProject, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { modeInForce, savedMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "zt-saved.mjs"));
const { PERSON_LINE: L } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
const MK = await import(join(ROOT, "zero-touch", "scripts", "mark.mjs"));
const CF = await import(join(ROOT, "zero-touch", "scripts", "chat-files.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "zero-touch", "hooks", "mmo-hook.sh");

function sandbox(settings = { mode: "workflows" }) {
  const dir = mkdtempSync(join(tmpdir(), "zt-off-now-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo);
  writeZtSettings(home, settings);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: ztData(home), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => { let json = null; try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ } done({ stdout, json }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
let n = 0;
const say = (s, sid, text) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++n}` }, s);
const mode = (s, sid) => { try { return readFileSync(join(s.home, "sessions", sid, "chat_mode"), "utf8"); } catch { return null; } };
const JOB = "fix the /login endpoint returning 500 on missing password";

test("Off reaches an open Workflows chat at its next message: no workflow, one line, and the chat is plain from then on", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    assert.match((await say(s, "c1", JOB)).json?.systemMessage ?? "", /starting the bug-fix workflow/, "on before");
    writeZtSettings(s.home, { mode: "off" });
    const r = await say(s, "c1", JOB);
    assert.equal(r.json?.systemMessage, L.turnedOff());
    assert.equal(r.json?.hookSpecificOutput, undefined, "no instruction to start anything");
    assert.equal(mode(s, "c1"), null, "the chat's mark is gone");
    assert.equal((await say(s, "c1", JOB)).stdout, "", "plain from then on: said once");
  } finally { s.cleanup(); }
});

test("Off reaches a reopened Hand-off chat: no model lock, no hand-off rules on reopen", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ mode: "handoff" });
  try {
    await run("session-start", { session_id: "h1", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    writeZtSettings(s.home, { mode: "off" });
    const switched = await run("pre-model-switch", { session_id: "h1", cwd: s.repo, from_model: "claude-opus-5", to_model: "claude-sonnet-5" }, s);
    assert.equal(switched.stdout, "", "a model switch is no longer refused");
    assert.equal((await say(s, "h1", "write a README for the shop")).json?.systemMessage, L.turnedOff());
  } finally { s.cleanup(); }
});

test("a workflow already running keeps running until it ends; the chat lets go after it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "w1", JOB);
    await run("pre-skill", { session_id: "w1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: "x" } }, s);
    await run("post-skill", { session_id: "w1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: "x" }, tool_use_id: "tu-w1" }, s);
    writeZtSettings(s.home, { mode: "off" });
    const during = await say(s, "w1", "approved");
    assert.notEqual(during.json?.systemMessage, L.turnedOff(), "the running workflow is not cut off mid-run");
    assert.equal(mode(s, "w1"), "on");
  } finally { s.cleanup(); }
});

test("other changes of the settings reach new chats only: a Workflows chat stays Workflows when Hand-off is saved", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await say(s, "k1", "hello");
    writeZtSettings(s.home, { mode: "handoff" });
    assert.match((await say(s, "k1", JOB)).json?.systemMessage ?? "", /starting the bug-fix workflow/);
  } finally { s.cleanup(); }
});

test("the mode in force: mmo's hooks and the model server's listing read zero-touch's settings by one rule", async () => {
  const { handoffListing } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "handoff", "listing.js"));
  const dir = mkdtempSync(join(tmpdir(), "zt-mode-rule-"));
  try {
    const config = join(dir, "claude");
    const data = join(config, "plugins", "data", "zero-touch-m");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "zero-touch@m": [{}] } }));
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: data, MMO_MANAGED_SETTINGS: join(dir, "none.json"), MMO_HOME: join(dir, "mmohome") };
    const cases = [
      ["handoff", null, "handoff", true], ["workflows", null, "workflows", false], ["off", null, "off", false],
      ["{ broken", { mode: "handoff" }, "handoff", true], ["{ broken", { mode: "workflows" }, "workflows", false], ["{ broken", null, "off", false],
      [{ mode: "SOMETHING" }, null, "off", false],
      // A valid mode beside one value that is not a choice: unusable in all three readers, so the last good save
      // decides everywhere.
      [{ mode: "off", workflows: { models: "opus-cheap" } }, { mode: "workflows" }, "workflows", false],
      [{ mode: "workflows", handoff: { documents: "gpt-5" } }, { mode: "handoff" }, "handoff", true],
      [{ mode: "handoff", handoff: "all" }, null, "off", false],
      [{ mode: "workflows", pad: "x".repeat(17 * 1024) }, { mode: "handoff" }, "handoff", true],
    ];
    const ZS = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
    for (const [saved, lastGood, want, listed] of cases) {
      const write = (file, v) => { const tmp = file + ".tmp"; writeFileSync(tmp, typeof v === "string" && v.startsWith("{ ") ? v : JSON.stringify(typeof v === "string" ? { mode: v } : v)); renameSync(tmp, file); };
      write(join(data, "settings.json"), saved);
      rmSync(join(data, "settings.last-good.json"), { force: true });
      if (lastGood) write(join(data, "settings.last-good.json"), lastGood);
      assert.equal(modeInForce(env), want, JSON.stringify([saved, lastGood]));
      const zt = ZS.readSettings(env);
      assert.equal(zt.state === "unreadable" ? "off" : zt.settings.mode, want, `zero-touch's own reader agrees: ${JSON.stringify([saved, lastGood])}`);
      assert.equal(handoffListing(env).list, listed, `the listing agrees: ${JSON.stringify([saved, lastGood])}`);
    }
    rmSync(join(data, "settings.json"));
    assert.equal(modeInForce(env), "none");
    assert.equal(savedMode(join(dir, "nothing.json")), "none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mmo switched off at the scope that decides, gone, or too old: told, and nothing marked", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-mmo-state-"));
  try {
    const config = join(dir, "claude");
    const project = join(dir, "project");
    mkdirSync(join(config, "plugins"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: config, MMO_MANAGED_SETTINGS: join(dir, "managed.json") };
    const mmoAt = (api) => { const p = mkdtempSync(join(dir, "mmo-")); mkdirSync(join(p, "scripts", "ambient"), { recursive: true }); if (api !== null) writeFileSync(join(p, "scripts", "ambient", "api.json"), JSON.stringify({ zero_touch_api: api })); return p; };
    const installed = (p) => writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "mmo@m": [{ installPath: p }] } }));
    installed(mmoAt(1));
    assert.equal(MK.mmoState(env, project), "ok");
    installed(mmoAt(null));
    assert.equal(MK.mmoState(env, project), "too-old", "an mmo without zero-touch's hooks");
    installed(join(dir, "gone"));
    assert.equal(MK.mmoState(env, project), "missing");
    installed(mmoAt(1));
    // Switched off for this project only: the project's local file decides first.
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@m": true } }));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "mmo@m": false } }));
    assert.equal(MK.mmoState(env, project), "off");
    // On for this project although off for the user: on.
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@m": false } }));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "mmo@m": true } }));
    assert.equal(MK.mmoState(env, project), "ok");
    // The real mmo of this repository is current.
    assert.equal(JSON.parse(readFileSync(join(ROOT, "plugin", "scripts", "ambient", "api.json"), "utf8")).zero_touch_api >= MK.MMO_API_NEEDED, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the old-records sweep runs from zero-touch's start too, Off included, once a day", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-sweep-"));
  try {
    const home = join(dir, "home");
    const old = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    for (const name of ["kept", "gone"]) {
      const d = join(home, "sessions", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "zt_say.json"), "{}");
      if (name === "gone") utimesSync(join(d, "zt_say.json"), old, old);
      utimesSync(d, old, old);
    }
    CF.sweepOldChats({ MMO_HOME: home });
    assert.ok(existsSync(join(home, "sessions", "kept")));
    assert.ok(!existsSync(join(home, "sessions", "gone")));
    // Once a day: a second call the same day does nothing.
    const again = join(home, "sessions", "again");
    mkdirSync(again, { recursive: true });
    utimesSync(again, old, old);
    CF.sweepOldChats({ MMO_HOME: home });
    assert.ok(existsSync(again));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the line for zero-touch stopping in a chat after repeated errors is a plain, labelled sentence", () => {
  // The moment itself (a third failure in one chat) is not forced here; hook.mjs emits this line then, once.
  assert.match(L.breaker(), /^Zero-touch: zero-touch stopped working in this chat after repeated errors, so Claude carries on as normal here\. A new chat starts fresh\.$/);
});

test("the choice lists copied into mmo's reader are zero-touch's own", async () => {
  const { CHOICES } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "zt-saved.mjs"));
  const ZS = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
  assert.deepEqual([...CHOICES.modes].sort(), Object.keys(ZS.MODES).sort());
  assert.deepEqual([...CHOICES.workflowModels].sort(), Object.keys(ZS.WORKFLOW_MODELS).sort());
  assert.deepEqual([...CHOICES.chatModels].sort(), Object.keys(ZS.CHAT_MODELS).sort());
  assert.deepEqual([...CHOICES.typists].sort(), Object.keys(ZS.TYPISTS).sort());
  assert.deepEqual([...CHOICES.kinds], [...ZS.KINDS]);
  const listing = readFileSync(join(ROOT, "plugin", "mcp", "model-dispatch", "src", "handoff", "listing.ts"), "utf8");
  for (const v of [...CHOICES.modes, ...CHOICES.workflowModels, ...CHOICES.chatModels, ...CHOICES.typists, ...CHOICES.kinds]) assert.ok(listing.includes(`"${v}"`), `the server's copy names ${v}`);
});
