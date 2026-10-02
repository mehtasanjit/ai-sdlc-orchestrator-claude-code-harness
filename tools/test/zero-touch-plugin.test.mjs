/**
 * Zero-touch is its own plugin, and its settings are the person's clicks in the settings box.
 *
 * A person never edits a file or types a command: they type "change zero-touch settings" (any wording) and pick in
 * Claude's question box (zero-touch/scripts/boxes.mjs, settings-hook.mjs), and the plugin keeps the choices in its own
 * data folder (settings.mjs). A mode file in the home folder and the hand-off settings in ambient.json are not read.
 *
 * The zero-touch plugin marks a chat at its start (a new chat, /clear, a fork), mmo acts only in a chat so marked
 * (plugin/scripts/ambient/lib/chat-mode.mjs), a chat keeps its marks for its whole life, and the plugin holds none of
 * mmo's code.
 *
 * No network, no model. Each case has its own home, plugin data folder and project folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// The installed copies these tests build are at the plugin's own version, as a real install is.
const VERSION = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
const { writeGoogleLogin, writeZtSettings, ztData, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const M = await import(join(ZT, "scripts", "messages.mjs"));
const B = await import(join(ZT, "scripts", "boxes.mjs"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function sandbox({ settings = { mode: "workflows" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-plugin-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n'); // an existing project, so a bug-fix message is a job
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  if (settings) writeZtSettings(home, settings);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A complete gcloud login file in the test home, so the Google check says "connected". */
function googleLogin(s, body = { type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "z", quota_project_id: "test-project" }) {
  mkdirSync(join(s.home, ".config", "gcloud"), { recursive: true });
  writeFileSync(join(s.home, ".config", "gcloud", "application_default_credentials.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function sh(script, event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PLUGIN_DATA: ztData(home), CLAUDE_PROJECT_DIR: repo, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const p = spawn("sh", event ? [script, event] : [script], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "" });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}
const ztStart = (s, sid, source = "startup", env) => sh(START, null, { session_id: sid, cwd: s.repo, source }, s, env);
const mmo = (s, event, payload, env) => sh(SHIM, event, payload, s, env);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
// What "zero-touch acts" shows (routing): a message the rules recognise as a job gets the instruction to start its
// workflow. Routing asks the workflows' own model check, which needs the built server.
const ROUTED = /"mmo:bugfix"/;
const JOB = "fix the /login endpoint returning 500 on missing password";
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();

test("the marketplace offers zero-touch as its own plugin: it needs mmo, and its hooks are the chat's start, the settings box, and the workflow and hand-off hooks it runs in mmo's folder", () => {
  const market = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
  const entries = Object.fromEntries(market.plugins.map((p) => [p.name, p]));
  assert.equal(entries.mmo?.source, "./plugin");
  assert.equal(entries["zero-touch"]?.source, "./zero-touch");
  const manifest = readJson(join(ZT, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "zero-touch");
  assert.ok((manifest.dependencies ?? []).includes("mmo"), "installing zero-touch brings mmo; mmo cannot be disabled under it");
  assert.equal(manifest.version, readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).version, "the two plugins ship together");
  assert.equal(entries["zero-touch"].version, manifest.version);
  assert.equal(manifest.userConfig, undefined, "no plugin settings form: the desktop app cannot show one; the box is the one place");
  assert.doesNotMatch(manifest.description, /~\/\.mmo-ambient|ambient\.json|\/mmo:/, "the description names no file and no command");
  const all = readJson(join(ZT, "hooks", "hooks.json")).hooks;
  // Its own five (the chat's start and the settings box); the sixteen workflow and hand-off hooks it runs in mmo's
  // folder through hooks/mmo-hook.sh are counted in tools/test/zero-touch-a-only.test.mjs.
  const hooks = {};
  for (const [ev, entries] of Object.entries(all)) {
    const own = entries.filter((e) => !e.hooks.some((h) => /mmo-hook\.sh/.test(h.command)));
    if (own.length) hooks[ev] = own;
  }
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "UserPromptSubmit"]);
  assert.match(JSON.stringify(hooks.SessionStart), /start-chat\.sh/);
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) assert.match(JSON.stringify(hooks[ev]), /settings\.sh/);
  assert.deepEqual(hooks.PreToolUse.map((h) => h.matcher).sort(), ["*", "AskUserQuestion"]);
  assert.deepEqual(hooks.PostToolUse.map((h) => h.matcher), ["AskUserQuestion"]);
  for (const entries of Object.values(all)) for (const e of entries) for (const h of e.hooks) assert.match(h.command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/(start-chat|settings|mmo-hook)\.sh"/);
  assert.equal(readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).dependencies, undefined, "mmo never needs zero-touch");
});

test("its start hook marks a chat at a fresh start only (a new chat, /clear, a fork), and mmo reads exactly that record", async () => {
  const s = sandbox();
  try {
    const env = { MMO_HOME: s.home };
    const r = await ztStart(s, "c1");
    assert.equal(r.code, 0);
    assert.ok(r.message, "the person sees the start message");
    assert.equal(chatMode("c1", env), "on");
    await ztStart(s, "c2", "resume");
    assert.equal(chatMode("c2", env), null, "a reopened chat that never started with zero-touch stays off");
    await ztStart(s, "c3", "compact");
    assert.equal(chatMode("c3", env), null);
    for (const source of ["clear", "fork"]) {
      await ztStart(s, `c-${source}`, source);
      assert.equal(chatMode(`c-${source}`, env), "on", `${source} is a new chat id: it is marked afresh`);
    }
    await ztStart(s, "c4", "startup", { MMO_AMBIENT: "observe" });
    assert.equal(chatMode("c4", env), "observe", "a measuring setup can still ask for observe");
    await ztStart(s, "c1", "clear", { MMO_AMBIENT: "off" });
    assert.equal(chatMode("c1", env), null, "an explicit off wins");
    await ztStart(s, "a/../../x y", "startup");
    assert.equal(chatMode("a/../../x y", env), "on", "an unusual chat id lands where mmo looks for it, never outside the records");
    assert.ok(!existsSync(join(s.dir, "x y")));
    assert.equal((await sh(START, null, "not json", s)).code, 0, "never fails the chat's start");
  } finally { s.cleanup(); }
});

test("the settings decide the chat: Workflows marks it with its models, Hand-off with its typists, Off marks nothing and says nothing", async () => {
  const s = sandbox();
  try {
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    await ztStart(s, "w");
    assert.equal(chatMode("w", { MMO_HOME: s.home }), "on");
    assert.equal(readJson(join(s.home, "sessions", "w", "workflow.json")).policy, "opus-plus-sonnet");
    writeZtSettings(s.home, { mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat" } });
    await ztStart(s, "h");
    assert.equal(chatMode("h", { MMO_HOME: s.home }), "b");
    const stamp = readJson(join(s.home, "sessions", "h", "handoff.json"));
    assert.deepEqual(stamp.typists, { documents: { typist: "flash", policy: "opus-plus-flash-v38" }, tests: { typist: "sonnet", policy: "opus-plus-sonnet" }, repeats: { typist: "chat", policy: null } });
    writeZtSettings(s.home, { mode: "off" });
    const off = await ztStart(s, "o");
    assert.equal(chatMode("o", { MMO_HOME: s.home }), null, "an Off chat is not marked: nothing of zero-touch's work acts in it");
    // Off is quiet: the saved line already confirmed it; no line, no note, no folder at every chat.
    assert.equal(off.stdout, "", "an Off chat says nothing and gives Claude nothing");
    assert.ok(!existsSync(join(s.home, "sessions", "o")), "and leaves nothing behind");
    const asked = await sh(join(ZT, "hooks", "settings.sh"), "prompt", { session_id: "o", prompt: "change zero-touch settings" }, s);
    assert.match(asked.note, /Zero-touch settings: if the person asks to change how zero-touch works/, "Off still listens for the settings, when the person names zero-touch");
    // A mode file in the home folder and ambient.json switch nothing.
    writeFileSync(join(s.home, "mode"), "b\n");
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ handoff: { policy: "opus-only-v5" }, routing_defaults: { policy: "opus-only-v5" } }));
    await ztStart(s, "o2");
    assert.equal(chatMode("o2", { MMO_HOME: s.home }), null, "the old mode file is not read");
  } finally { s.cleanup(); }
});

test("the Workflows start message: the jobs, the approval steps, the cost, the models, how to change; nothing to edit, no command; once per save", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    const r = await ztStart(s, "i-1", "startup");
    // Claude Code did not say which model the chat starts on: the line says which model workflows need.
    const needs = M.workflowModelLine("opus-plus-flash-v38", {}).line;
    assert.equal(r.message, M.workflowMessage({ policy: "opus-plus-flash-v38", modelLine: needs }));
    assert.match(r.message, /^Zero-touch is on in this chat: Workflows mode\./);
    assert.match(r.message, /waits for your approval/);
    assert.match(r.message, /far more usage than a normal chat\. The report at the end shows an estimate of what it cost\./);
    assert.doesNotMatch(r.message, /cheapest|expensive|costs less/, "no price ranking");
    assert.match(r.message, /Opus 5 plans and reviews; Google's Flash 3\.8 writes the code/);
    assert.match(r.message, /type "change zero-touch settings"/);
    assert.doesNotMatch(r.message, /\/mmo:|~\/\.mmo-ambient|ambient\.json|policy file|opus-plus/, "no command, no file, no policy code");
    assert.equal(r.note, "", "Claude is given nothing at a Workflows chat's start: the box comes when the person names zero-touch");
    // Quiet by default: the summary once per save; later chats, /clear included, say nothing when all is well.
    for (const [sid, source] of [["i-2", "startup"], ["i-3", "clear"]]) {
      const later = await ztStart(s, sid, source);
      assert.equal(later.stdout, "", `${source}: the summary was shown already, and nothing needs the person's action`);
      assert.equal(chatMode(sid, { MMO_HOME: s.home }), "on", `${source}: the chat is marked all the same`);
    }
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    // The model line names the models chosen, so it is the new save's own.
    assert.equal((await ztStart(s, "i-4")).message, M.workflowMessage({ policy: "opus-plus-sonnet", modelLine: M.workflowModelLine("opus-plus-sonnet").line }), "a new save: its summary shows once more");
    assert.equal((await ztStart(s, "i-5")).stdout, "");
    assert.equal((await ztStart(s, "i-off", "startup", { MMO_AMBIENT: "off" })).stdout, "", "switched off for one run: nothing is shown");
    assert.equal((await ztStart(s, "i-obs", "startup", { MMO_AMBIENT: "observe" })).stdout, "", "a measuring run that only records: nothing is shown");
  } finally { s.cleanup(); }
});

test("a project's own routing-policy.yaml and saved choice are not used by zero-touch; the start message says the file is there", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-only-v5" } });
    mkdirSync(join(s.repo, ".sdlc"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "project.json"), JSON.stringify({ default_policy: "opus-plus-flash-v37" }));
    const saved = await ztStart(s, "p-saved");
    assert.match(saved.message, /Your models: Opus 5 does everything\./, "the person's pick, not the folder's saved choice");
    assert.equal(readJson(join(s.home, "sessions", "p-saved", "workflow.json")).policy, "opus-only-v5");
    assert.doesNotMatch(saved.message, /routing-policy\.yaml/);
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n");
    const file = await ztStart(s, "p-file");
    assert.equal(readJson(join(s.home, "sessions", "p-file", "workflow.json")).policy, "opus-only-v5", "still the person's pick");
    assert.equal(file.message, M.warningsMessage({ mode: "on" }, [M.folderPolicyLine()]), "after the summary, one line says the folder's file is not followed, in every chat there");
  } finally { s.cleanup(); }
});

test("Google: not connected, a broken login, and a working one, read exactly as mmo's own setup check reads them", async () => {
  const s = sandbox();
  try {
    rmSync(join(s.home, ".config"), { recursive: true, force: true }); // this person has not connected Google
    const none = await ztStart(s, "g-none");
    assert.match(none.message, /Google's Flash 3\.8 can't be used yet, because this computer isn't connected to Google\. Until it is, workflows won't start\./);
    googleLogin(s, { type: "authorized_user", client_id: "x" }); // missing the secret and the refresh token
    const broken = await ztStart(s, "g-broken");
    assert.match(broken.message, /This computer's Google sign-in is damaged or incomplete/);
    assert.match(broken.message, /ask Claude: "help me connect Google for zero-touch"/);
    assert.doesNotMatch(broken.message, /gcloud|application_default_credentials|\.json|missing client_secret/, "no command, no file path, no raw detail");
    googleLogin(s);
    const WARN = /can't be used|isn't connected to Google/;
    assert.doesNotMatch((await ztStart(s, "g-ok")).message, WARN, "a complete login: nothing to say");
    // A project name alone is not a login (mmo's rule); an API key is one.
    rmSync(join(s.home, ".config"), { recursive: true, force: true });
    assert.match((await ztStart(s, "g-project", "startup", { GOOGLE_CLOUD_PROJECT: "p1" })).message, /isn't connected to Google/);
    assert.doesNotMatch((await ztStart(s, "g-key", "startup", { GEMINI_API_KEY: "k" })).message, WARN);
    // Models without Flash need no Google.
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    assert.doesNotMatch((await ztStart(s, "g-sonnet")).message, WARN);
  } finally { s.cleanup(); }
});

test("the first chat after install asks first; a run with no screen does nothing until settings exist; an unreadable file switches nothing on", async () => {
  const s = sandbox({ settings: null });
  try {
    writeGoogleLogin(s.home);
    const first = await ztStart(s, "f1");
    assert.equal(first.message, M.welcomeMessage());
    assert.equal(first.note, M.firstRunNote(B.modeBox(null, { first: true })));
    assert.equal(chatMode("f1", { MMO_HOME: s.home }), null, "nothing acts until the settings are chosen");
    assert.ok(existsSync(join(s.home, "sessions", "f1", "zt_setup.json")), "the chat waits for its settings box");
    const script = await ztStart(s, "f2", "startup", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    assert.equal(script.message, "", "a run with no screen is left exactly as Claude Code alone: nothing said");
    assert.ok(!existsSync(join(s.home, "sessions", "f2", "zt_setup.json")), "no hold in a run with no screen");
    assert.equal(chatMode("f2", { MMO_HOME: s.home }), null);
    mkdirSync(ztData(s.home), { recursive: true });
    writeFileSync(join(ztData(s.home), "settings.json"), "{ not json");
    const bad = await ztStart(s, "f3");
    assert.equal(chatMode("f3", { MMO_HOME: s.home }), null, "fail safe: no zero-touch in this chat");
    assert.equal(bad.message, M.unreadableMessage(), "and the person is told, in every chat");
    assert.equal((await ztStart(s, "f4")).message, M.unreadableMessage());
  } finally { s.cleanup(); }
});

test("after a compaction or when a chat is reopened, nothing is shown again and the chat keeps its mode, whatever was saved since", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    await ztStart(s, "c-on", "startup");
    writeZtSettings(s.home, { mode: "off" });
    for (const source of ["compact", "resume"]) {
      const r = await ztStart(s, "c-on", source);
      assert.equal(r.stdout, "", `${source}: nothing again`);
      assert.equal(chatMode("c-on", { MMO_HOME: s.home }), "on", `${source}: the mode the chat started with, not the new settings`);
    }
    await ztStart(s, "c-off", "startup");
    assert.equal((await ztStart(s, "c-off", "compact")).stdout, "", "an Off chat: nothing");
    const never = await ztStart(s, "c-never", "compact");
    assert.equal(never.stdout, "", "a chat that started without zero-touch shows nothing");
  } finally { s.cleanup(); }
});

test("a backstop, never an alarm: mmo switched off or its folder gone says so; anything unreadable, or a setup without mmo listed, is fine", async () => {
  const s = sandbox();
  try {
    const claudeDir = join(s.home, ".claude");
    mkdirSync(join(claudeDir, "plugins"), { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@tilicho-ai-labs": false, "zero-touch@tilicho-ai-labs": true } }));
    const off = await ztStart(s, "b1");
    assert.equal(off.message, M.mmoMissingMessage());
    assert.equal(chatMode("b1", { MMO_HOME: s.home }), null);
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@old-market": false, "mmo@tilicho-ai-labs": true } }));
    assert.equal(chatMode("b1", { MMO_HOME: s.home }), null);
    await ztStart(s, "b2");
    assert.equal(chatMode("b2", { MMO_HOME: s.home }), "on", "one mmo on is enough: an old entry switched off is not an alarm");
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "mmo@m": [{ installPath: join(s.dir, "gone") }] } }));
    assert.equal((await ztStart(s, "b3")).message, M.mmoMissingMessage(), "installed at a folder that no longer exists");
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "zero-touch@m": [{ installPath: s.dir }] } }));
    await ztStart(s, "b4");
    assert.equal(chatMode("b4", { MMO_HOME: s.home }), "on", "mmo not listed at all (a developer's --plugin-dir): fine");
  } finally { s.cleanup(); }
});

test("with the zero-touch plugin disabled, nothing acts in a chat, whatever ambient.json says",{ skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ mode: "on" })); // ambient.json's mode: not a switch
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" });
    assert.equal(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" })), "", "nothing is routed");
    const skill = await mmo(s, "pre-skill", { session_id: "c1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix" } });
    assert.equal(skill.stdout, "", "nothing is refused: the chat may start a workflow as it does without zero-touch");
  } finally { s.cleanup(); }
});

test("with it enabled the chat acts even when mmo's start hook ran first (both start hooks run at once): mmo's start work runs at the first prompt", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" }); // mmo first: no record yet
    await ztStart(s, "c1");                                                                // then zero-touch marks the chat
    assert.match(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" })), ROUTED);
    const events = readFileSync(join(s.home, "sessions", "c1", "events.jsonl"), "utf8");
    assert.match(events, /"type":"session\.start"/, "the chat's start is logged once, late");
  } finally { s.cleanup(); }
});

test("a developer or measuring setup can still switch it for one run with MMO_AMBIENT, without the zero-touch plugin", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" }, { MMO_AMBIENT: "on" });
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on");
    assert.match(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" }, { MMO_AMBIENT: "on" })), ROUTED);
    // Both plugins' hooks run in the chat's one environment, so an explicit off reaches the zero-touch hook too.
    await ztStart(s, "c2", "startup", { MMO_AMBIENT: "off" });
    await mmo(s, "session-start", { session_id: "c2", cwd: s.repo, source: "startup" }, { MMO_AMBIENT: "off" });
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), null, "an explicit off wins over the plugin");
    assert.equal(context(await mmo(s, "prompt", { session_id: "c2", cwd: s.repo, prompt: JOB, prompt_id: "p2" }, { MMO_AMBIENT: "off" })), "");
  } finally { s.cleanup(); }
});

/** A folder of links to the shell tools the hook scripts use, and no node: a computer without Node.js. */
function noNodeBin(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["sh", "mkdir", "dirname", "printf", "cat", "head", "sed", "grep"]) {
    const found = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find((f) => existsSync(f));
    if (found) symlinkSync(found, join(bin, tool));
  }
  return bin;
}

test("Node.js missing: zero-touch says it once per chat where the person sees it, in the same words, exactly as printed", () => {
  // Run, not read: the scripts print the text inside single quotes, where an apostrophe ("can't") would end the
  // quoting and the person would see "cantrunonthiscomputer"; a source-text check cannot catch that, the printed text
  // can. And once per CHAT, at a moment each screen shows: the desktop app never shows a chat's start message, so a
  // line said only there would be used up unseen.
  const dir = mkdtempSync(join(tmpdir(), "zt-no-node-"));
  try {
    const bin = noNodeBin(dir);
    const SETTINGS = join(ZT, "hooks", "settings.sh");
    const run = (home, script, arg, payload, extra = {}) => spawnSync("/bin/sh", [script, ...arg], { input: JSON.stringify(payload), env: { PATH: bin, HOME: home, MMO_HOME: home, ...extra }, encoding: "utf8" });
    const at = (event) => ({ systemMessage: M.NODE_MISSING, hookSpecificOutput: { hookEventName: event, additionalContext: M.NODE_MISSING_NOTE } });

    // The terminal shows a start hook's message: said at the start, and not again at the first message.
    const term = join(dir, "terminal");
    mkdirSync(term);
    const t1 = run(term, START, [], { session_id: "t1", source: "startup" });
    assert.equal(t1.status, 0);
    assert.deepEqual(JSON.parse(t1.stdout), at("SessionStart"), "terminal: the words, exactly, at the start");
    assert.equal(run(term, START, [], { session_id: "t1", source: "compact" }).stdout, "", "terminal: a compaction says nothing again");
    assert.equal(run(term, SETTINGS, ["prompt"], { session_id: "t1", prompt: "hi" }).stdout, "", "terminal: not again at the first message");
    assert.deepEqual(JSON.parse(run(term, START, [], { session_id: "t2", source: "startup" }).stdout), at("SessionStart"), "terminal: the next chat hears it too");

    // The desktop app shows no start message: said at the chat's first message, once.
    const desk = join(dir, "desktop");
    mkdirSync(desk);
    const app = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
    assert.equal(run(desk, START, [], { session_id: "d1", source: "startup" }, app).stdout, "", "desktop: nothing at the start, where it would not show");
    const d1 = run(desk, SETTINGS, ["prompt"], { session_id: "d1", prompt: "build me a todo app" }, app);
    assert.equal(d1.status, 0);
    assert.deepEqual(JSON.parse(d1.stdout), at("UserPromptSubmit"), "desktop: the words, exactly, with the first message");
    assert.equal(run(desk, SETTINGS, ["prompt"], { session_id: "d1", prompt: "and again" }, app).stdout, "", "desktop: once per chat");
    assert.deepEqual(JSON.parse(run(desk, SETTINGS, ["prompt"], { session_id: "d2", prompt: "hi" }, app).stdout), at("UserPromptSubmit"), "desktop: the next chat hears it too");
    for (const event of ["pre-any", "pre-ask", "post-ask"]) assert.equal(run(desk, SETTINGS, [event], { session_id: "d1", tool_name: "Write" }, app).stdout, "", `${event}: silent`);
    assert.equal(run(desk, SETTINGS, ["prompt"], { prompt: "no chat id" }, app).stdout, "", "a chat that cannot be told apart is not told at every message");

    // mmo's own start script (it reaches this only for a marked chat, or a developer's one-run switch): unchanged.
    const home = join(dir, "mmo");
    mkdirSync(home);
    const first = spawnSync("/bin/sh", [SHIM, "session-start"], { input: "{}", env: { PATH: bin, HOME: home, MMO_HOME: home }, encoding: "utf8" });
    assert.equal(first.status, 0);
    assert.deepEqual(JSON.parse(first.stdout), { systemMessage: M.NODE_MISSING }, "mmo's script: the same words");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(readFileSync(START, "utf8") + readFileSync(SHIM, "utf8"), /Cost-saving mode|Starting workflows from plain requests is on/, "the old names are gone");
  assert.doesNotMatch(M.NODE_MISSING_NOTE, /'/, "no apostrophe in the note: the scripts print it inside single quotes");
});

test("the first chat after install: once Workflows is saved, its first message is judged without being sent again", { skip: SKIP ?? false }, async () => {
  // The person never sends their first message again, a question included: the settings box leaves the message for
  // mmo's end-of-turn hook, which judges it with the same rules as a typed one.
  const B2 = await import(join(ZT, "scripts", "boxes.mjs"));
  const SETTINGS = join(ZT, "hooks", "settings.sh");
  const RF = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  for (const [first, isJob] of [["build a small to-do app with a list and a done button", true], ["what can you do?", false]]) {
    const s = sandbox({ settings: null });
    try {
      writeGoogleLogin(s.home);
      const app = join(s.dir, "empty");
      mkdirSync(app);
      const at = { ...s, repo: app };
      await ztStart(at, "f1");
      await sh(SETTINGS, "prompt", { session_id: "f1", prompt: first }, at);
      const mode = B2.modeBox(null, { first: true });
      await sh(SETTINGS, "pre-ask", { session_id: "f1", tool_name: "AskUserQuestion", tool_input: mode }, at);
      await sh(SETTINGS, "post-ask", { session_id: "f1", tool_name: "AskUserQuestion", tool_input: mode, tool_response: { answers: { [mode.questions[0].question]: "Workflows" } } }, at);
      const models = B2.modelsBox(null);
      await sh(SETTINGS, "pre-ask", { session_id: "f1", tool_name: "AskUserQuestion", tool_input: models }, at);
      const saved = await sh(SETTINGS, "post-ask", { session_id: "f1", tool_name: "AskUserQuestion", tool_input: models, tool_response: { answers: { [models.questions[0].question]: "Opus 5 + Sonnet 5" } }, model: "claude-opus-5" }, at);
      assert.match(saved.message, /Zero-touch now looks at your first message/, "no resend asked");
      assert.doesNotMatch(saved.message, /Send your request again/);
      assert.match(saved.note, /As soon as you end this turn, zero-touch judges the person's first message itself/);
      assert.equal(chatMode("f1", { MMO_HOME: s.home }), "on");
      const end = await mmo(at, "turn-end", { session_id: "f1", cwd: app, stop_hook_active: false });
      const note = context(end);
      assert.ok(note.includes(first), "Claude is given the first message");
      if (isJob) {
        assert.equal(end.message, RF.PERSON_LINE.starting("greenfield"), "the person sees the workflow start");
        assert.match(note, /mmo:greenfield/, "Claude is told to start it");
        assert.equal(end.json.hookSpecificOutput.hookEventName, "Stop", "the turn continues with it, as a queued job does");
      } else {
        assert.equal(end.message, "", "ordinary chat: nothing shown");
        assert.match(note, /It is not a workflow job: answer it now/);
      }
      assert.ok(!existsSync(join(s.home, "sessions", "f1", "zt_replay.json")), "judged once: the message is not left behind");
      // The turn went on; Claude ends it again (Claude Code marks that end stop_hook_active).
      const again = await mmo(at, "turn-end", { session_id: "f1", cwd: app, stop_hook_active: true });
      if (isJob) assert.equal(again.message, RF.PERSON_LINE.didntStart("greenfield"), "told to start it and did not: said, and nothing stays held");
      else assert.equal(again.stdout, "", "nothing more");
    } finally { s.cleanup(); }
  }
  assert.ok(readFileSync(join(ROOT, "plugin", "scripts", "ambient", "hook.mjs"), "utf8").includes('const REPLAY_FILE = "zt_replay.json";'), "mmo reads the file zero-touch writes");
  const files = await import(join(ZT, "scripts", "chat-files.mjs"));
  assert.equal(files.FILES.replay, "zt_replay.json");
});

test("where mmo is installed, for the hooks this plugin runs in mmo's folder: Claude Code's record, the same marketplace first, kept only when it changed", async () => {
  // Zero-touch's workflow and hand-off hooks are registered here and run in mmo's folder (hooks/mmo-hook.sh); the
  // start hook keeps where mmo is in this plugin's data folder.
  const MK = await import(join(ZT, "scripts", "mark.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "zt-mmo-root-"));
  try {
    const home = join(dir, "home");
    const plugins = join(home, ".claude", "plugins");
    const mmo = (mkt, v, { api = 1 } = {}) => {
      const p = join(plugins, "cache", mkt, "mmo", v);
      mkdirSync(join(p, "hooks"), { recursive: true });
      mkdirSync(join(p, "scripts", "ambient"), { recursive: true });
      writeFileSync(join(p, "hooks", "ambient.sh"), "#!/bin/sh\n");
      if (api !== null) writeFileSync(join(p, "scripts", "ambient", "api.json"), JSON.stringify({ zero_touch_api: api }));
      return p;
    };
    const ztHere = join(plugins, "cache", "ours", "zero-touch", VERSION);
    mkdirSync(ztHere, { recursive: true });
    const theirs = mmo("theirs", "0.9.0");
    const ours = mmo("ours", VERSION);
    const record = (plugs) => writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: plugs }));
    const env = { HOME: home, CLAUDE_PLUGIN_DATA: join(dir, "data") };
    record({ "mmo@theirs": [{ installPath: theirs }], "mmo@ours": [{ installPath: ours }], "zero-touch@ours": [{ installPath: ztHere }] });
    assert.equal(MK.mmoRoot(env, ztHere), ours, "the mmo from zero-touch's own marketplace first");
    assert.equal(MK.rememberMmoRoot(env, ztHere), ours);
    assert.equal(readFileSync(join(dir, "data", "mmo-root"), "utf8"), `${ours}\n`);
    record({ "mmo@theirs": [{ installPath: theirs }], "zero-touch@ours": [{ installPath: ztHere }] });
    assert.equal(MK.mmoRoot(env, ztHere), theirs, "any installed mmo otherwise");
    // An mmo in the cache with the hook script but no api.json is never named.
    record({ "mmo@ours": [{ installPath: mmo("ours", "0.8.4", { api: null }) }], "zero-touch@ours": [{ installPath: ztHere }] });
    assert.equal(MK.mmoRoot(env, ztHere), null, "an mmo without zero-touch's hooks is never the one to run");
    record({ "mmo@ours": [{ installPath: join(dir, "gone") }] });
    assert.equal(MK.mmoRoot(env, ztHere), null, "a folder without mmo's hook script is never named");
    assert.equal(MK.rememberMmoRoot(env, ztHere), null);
    assert.equal(readFileSync(join(dir, "data", "mmo-root"), "utf8"), `${ours}\n`, "nothing found: the kept answer stays (the shell script checks it exists)");
    writeFileSync(join(plugins, "installed_plugins.json"), "{not json");
    assert.equal(MK.mmoRoot(env, ztHere), null, "an unreadable record: none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
