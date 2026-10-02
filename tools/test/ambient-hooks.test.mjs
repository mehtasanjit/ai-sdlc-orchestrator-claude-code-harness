/**
 * End-to-end tests of zero-touch's hook contract: every case pipes the hook input
 * Claude Code would send through the real shell shim and reads the decision
 * JSON back, so the shim, the dispatcher and the libraries are tested together.
 *
 * Each test gets its own MMO_HOME, so nothing touches ~/.mmo-ambient and tests cannot
 * see each other's sessions. No network, no model call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// The installed copies these tests build are at the plugin's own version, as a real install is.
const VERSION = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
const { startingChats } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-ambient-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runOnce(event, payload, { home, repo, env = {}, pathOverride } = {}) {
  return new Promise((done) => {
    const childEnv = {
      PATH: pathOverride ?? process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo,
      MMO_AMBIENT: "on", ...env,
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null; the test will say so */ }
      done({ code, stdout, stderr, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

// Every chat these tests drive starts the way a real one does (tools/test/lib/chat-start.mjs).
const run = startingChats(runOnce, (o) => o?.home, { envOf: (o) => ({ MMO_AMBIENT: "on", ...(o?.env ?? {}) }) });

function events(home, sid) {
  const file = join(home, "sessions", sid, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("without the zero-touch plugin (no chat record, no MMO_AMBIENT) the shim exits 0 and writes nothing", async () => {
  const s = sandbox();
  try {
    // runOnce, not run: this chat starts WITHOUT the zero-touch plugin's start hook (tools/test/lib/chat-start.mjs).
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ mode: "on" })); // a mode in this file switches nothing
    const r = await runOnce("session-start", { session_id: "s1", cwd: s.repo }, { ...s, env: { MMO_AMBIENT: undefined } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.deepEqual(readdirSync(s.home), ["ambient.json"], "a chat without zero-touch must not create any state");
    const p = await runOnce("prompt", { session_id: "s1", cwd: s.repo, prompt: "todo api, typescript, express" }, { ...s, env: { MMO_AMBIENT: undefined } });
    assert.equal(p.stdout, "");
    assert.deepEqual(readdirSync(s.home), ["ambient.json"]);
  } finally { s.cleanup(); }
});

test("the shim exits 0 on garbage input, on an unknown event and when node is missing", async () => {
  const s = sandbox();
  try {
    assert.equal((await run("prompt", "{not json", s)).code, 0);
    assert.equal((await run("no-such-event", { session_id: "s1" }, s)).code, 0);
    const bin = join(s.dir, "bin");
    mkdirSync(bin);
    const missing = await run("session-start", { session_id: "s1", cwd: s.repo }, { ...s, pathOverride: bin + ":/bin:/usr/bin".split(":").filter((d) => !existsSync(join(d, "node"))).join(":") });
    assert.equal(missing.code, 0, "a machine without node must still get exit 0");
  } finally { s.cleanup(); }
});

test("a chat's start is logged, and its records are private to the account", async () => {
  const s = sandbox();
  try {
    await run("session-start", { session_id: "s1", cwd: s.repo, source: "startup", model: "claude-opus-5[1m]" }, s);
    const start = events(s.home, "s1").find((e) => e.type === "session.start");
    assert.equal(start.source, "startup");
    assert.equal(start.model, "claude-opus-5", "the model is recorded without the context-size suffix");
    assert.equal(start.routing, "on");
    // No control arm is drawn.
    assert.ok(!existsSync(join(s.home, "sessions", "s1", "arm.json")));
    assert.equal(statSync(join(s.home, "sessions", "s1")).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.home, "sessions", "s1", "events.jsonl")).mode & 0o777, 0o600);
  } finally { s.cleanup(); }
});

test("a prompt is stored as a length, never as text", async () => {
  const s = sandbox();
  try {
    const secret = "what does billing do with the password hunter2-XYZZY";
    await run("prompt", { session_id: "s1", cwd: s.repo, prompt: secret, prompt_id: "p-1" }, s);
    const raw = readFileSync(join(s.home, "sessions", "s1", "events.jsonl"), "utf8");
    assert.ok(!raw.includes("hunter2") && !raw.includes("billing"), "prompt text leaked into the event log");
    const prompts = events(s.home, "s1").filter((e) => e.type === "prompt");
    assert.deepEqual(prompts.map((e) => [e.prompt_id, e.chars, e.typed]), [["p-1", secret.length, true]]);
  } finally { s.cleanup(); }
});

test("a queued system notice is logged as a prompt nobody typed and is never judged as a request", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.repo, "package.json"), '{"name":"shop"}\n');
    const notice = "<task-notification>\n<summary>fix the /login endpoint returning 500 on missing password</summary>\n</task-notification>";
    const r = await run("prompt", { session_id: "s1", cwd: s.repo, prompt: notice, prompt_id: "p1" }, s);
    assert.equal(r.stdout, "", "a notice that reads like a job starts nothing");
    const prompts = events(s.home, "s1").filter((e) => e.type === "prompt");
    assert.deepEqual(prompts.map((e) => e.typed), [false]);
    assert.ok(!events(s.home, "s1").some((e) => e.type.startsWith("route.")), "the rules never read a notice");
  } finally { s.cleanup(); }
});

test("three failures in a chat open the breaker and later hooks do nothing", async () => {
  const s = sandbox();
  try {
    const dir = join(s.home, "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "failures.log"), "a\nb\nc\n");
    writeFileSync(join(s.repo, "package.json"), '{"name":"shop"}\n');
    // run, not runOnce: the chat starts with the zero-touch mark, so only the breaker can keep the hook quiet.
    const r = await run("prompt", { session_id: "s1", cwd: s.repo, prompt: "fix the /login endpoint returning 500 on missing password" }, s);
    assert.ok(existsSync(join(dir, "chat_mode")), "the chat has zero-touch on");
    assert.equal(r.stdout, "", "not even a recognised job is routed");
    assert.ok(!existsSync(join(dir, "events.jsonl")), "an open breaker must not even log");
  } finally { s.cleanup(); }
});

test("every zero-touch hook is registered by the zero-touch plugin, through its shim, with a short timeout; mmo's own hook list is the pipeline's alone", () => {
  // Zero-touch is a strict add-on: the workflow and hand-off hooks are in zero-touch's hook list, not mmo's, so a
  // person without zero-touch has none of them.
  const hooks = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks;
  const seen = new Set();
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        const m = /hooks\/mmo-hook\.sh" (\S+)$/.exec(h.command);
        if (!m) continue;
        // The pre-any hook runs on every tool call of a marked chat: it must fail fast (the platform default is 600 s).
        // The turn's end may save a finished new app with git, so it has 30 s.
        const limit = m[1] === "turn-end" ? 30 : 5;
        assert.ok(typeof h.timeout === "number" && h.timeout <= limit, `${event} ${m[1]}: a zero-touch hook sets a timeout of ${limit} s or less`);
        assert.match(h.command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/mmo-hook\.sh" /, "zero-touch hooks go through the POSIX shim, its path quoted");
        seen.add(m[1]);
      }
    }
  }
  const pipelineHooks = [];
  for (const [event, entries] of Object.entries(JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks)) {
    for (const entry of entries) for (const h of entry.hooks) pipelineHooks.push({ event, command: h.command, timeout: h.timeout });
  }
  assert.deepEqual(pipelineHooks.filter((h) => /ambient|mmo-hook/.test(h.command)), [], "mmo's own hook list has no zero-touch hook");
  // The typed pipeline's hooks keep mmo's own settings. Claude Code lets a tool call through when its PreToolUse hook
  // times out, so a short timeout on the write contract would let a slow start skip the guard.
  for (const name of ["write-contract-check.mjs", "foreground-helpers.mjs", "telemetry.sh"]) {
    const found = pipelineHooks.filter((h) => h.command.includes(name));
    assert.equal(found.length, 1, `${name} is registered once`);
    assert.equal(found[0].timeout, undefined, `${name} keeps mmo's own setting: no timeout of its own`);
  }
  // Every handler the dispatcher has is registered (tools/test/zero-touch-a-only.test.mjs pins the exact list).
  const handlers = [...readFileSync(join(ROOT, "plugin", "scripts", "ambient", "hook.mjs"), "utf8").matchAll(/^  (?:async )?"?([a-z-]+)"?\(ctx\) \{/gm)].map((m) => m[1]);
  assert.ok(handlers.length >= 7, "the handler list was read");
  for (const e of handlers) assert.ok(seen.has(e), `${e} is handled by the dispatcher but not registered`);
  for (const file of [SHIM, join(ROOT, "zero-touch", "hooks", "mmo-hook.sh")]) {
    const shim = readFileSync(file, "utf8").split("\n");
    assert.equal(shim[0], "#!/bin/sh");
    assert.equal(shim.find((l) => l.trim() && !l.startsWith("#")), 'trap "exit 0" EXIT', `${file}: the trap must be the first command`);
  }
});

test("zero-touch's shim finds mmo's folder in every layout, and passes the hook's input and name through unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-shim-"));
  try {
    // A stand-in mmo whose hook script prints what it was given. It says it carries zero-touch's hooks
    // (scripts/ambient/api.json), which the shim requires (tools/test/zero-touch-mmo-update.test.mjs).
    const fakeMmo = (at) => {
      mkdirSync(join(at, "hooks"), { recursive: true });
      mkdirSync(join(at, "scripts", "ambient"), { recursive: true });
      writeFileSync(join(at, "hooks", "ambient.sh"), '#!/bin/sh\nprintf "%s|%s|%s" "$CLAUDE_PLUGIN_ROOT" "$1" "$(cat)"\n');
      writeFileSync(join(at, "scripts", "ambient", "api.json"), '{"zero_touch_api": 1}\n');
      return at;
    };
    const ztIn = (at) => {
      mkdirSync(join(at, "hooks"), { recursive: true });
      writeFileSync(join(at, "hooks", "mmo-hook.sh"), readFileSync(join(ROOT, "zero-touch", "hooks", "mmo-hook.sh")));
      return join(at, "hooks", "mmo-hook.sh");
    };
    const shim = (script, env = {}) => spawnSync("sh", [script, "pre-any"], { input: '{"session_id":"a"}', encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    // Installed: <cache>/<marketplace>/zero-touch/<version> beside <cache>/<marketplace>/mmo/<version>.
    const cache = join(dir, "cache", "mkt");
    const mmo = fakeMmo(join(cache, "mmo", VERSION));
    const installed = ztIn(join(cache, "zero-touch", VERSION));
    let r = shim(installed);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${mmo}|pre-any|{"session_id":"a"}`);
    // Another mmo version installed (an older build): the one Claude Code's record names (kept by the start hook) wins.
    const other = fakeMmo(join(cache, "mmo", "0.8.4"));
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "mmo-root"), `${other}\n`);
    assert.equal(shim(installed, { CLAUDE_PLUGIN_DATA: data }).stdout.split("|")[0], other);
    // A kept folder that is gone: the one beside is used.
    writeFileSync(join(data, "mmo-root"), `${join(dir, "gone")}\n`);
    assert.equal(shim(installed, { CLAUDE_PLUGIN_DATA: data }).stdout.split("|")[0], mmo);
    // This repository's layout: zero-touch/ beside plugin/.
    const repo = join(dir, "repo");
    fakeMmo(join(repo, "plugin"));
    assert.equal(shim(ztIn(join(repo, "zero-touch"))).stdout.split("|")[0], join(repo, "plugin"));
    // No mmo anywhere: nothing runs, nothing is said.
    r = shim(ztIn(join(dir, "alone", "zero-touch")));
    assert.deepEqual([r.status, r.stdout], [0, ""]);
    // The real shim in this repository reaches mmo's real hook script.
    const real = spawnSync("sh", [join(ROOT, "zero-touch", "hooks", "mmo-hook.sh"), "pre-any"], { input: '{"session_id":"no-such-chat"}', encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, MMO_HOME: join(dir, "h") } });
    assert.deepEqual([real.status, real.stdout], [0, ""], "a chat without zero-touch: nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a crafted session id cannot leave the sessions directory", async () => {
  const s = sandbox();
  try {
    await run("session-start", { session_id: "../../escape", cwd: s.repo }, s);
    assert.ok(!existsSync(join(s.dir, "escape")), "the id must not be used as a path");
    const names = readdirSync(join(s.home, "sessions"));
    assert.equal(names.length, 1);
    assert.match(names[0], /^x[0-9a-f]{24}$/);
  } finally { s.cleanup(); }
});

test("the mmo agents are refused in ordinary chat and allowed inside a typed pipeline session", async () => {
  const s = sandbox();
  try {
    const call = (sid, type) => ({ session_id: sid, cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: type } });
    assert.equal((await run("pre-agent", call("chat", "mmo:orchestrator"), s)).json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal((await run("pre-agent", call("chat", "general-purpose"), s)).stdout, "");
    await run("prompt", { session_id: "typed", cwd: s.repo, prompt: "/mmo:bugfix the login page returns 500", prompt_id: "t1" }, s);
    assert.equal((await run("pre-agent", call("typed", "mmo:orchestrator"), s)).stdout, "");
  } finally { s.cleanup(); }
});

test("a prompt is a machine notice only when it starts with one of the app's own notice tags; a person pasting HTML is still a person", async () => {
  const s = sandbox();
  try {
    await run("prompt", { session_id: "s1", cwd: s.repo, prompt: "<div class=\"hero\">Welcome</div> make this the landing page" }, s);
    await run("prompt", { session_id: "s1", cwd: s.repo, prompt: "<task-notification>\n<task-type>bash</task-type>\n</task-notification>" }, s);
    await run("prompt", { session_id: "s1", cwd: s.repo, prompt: "<system-reminder>x</system-reminder>" }, s);
    const typed = events(s.home, "s1").filter((e) => e.type === "prompt").map((e) => e.typed !== false);
    assert.deepEqual(typed, [true, false, false]);
  } finally { s.cleanup(); }
});

test("the daily sweep removes a chat's records by the newest file in them, so a chat used every day is kept", async () => {
  const s = sandbox();
  try {
    const { utimesSync } = await import("node:fs");
    const sessions = join(s.home, "sessions");
    const old = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    // A chat whose folder was made 40 days ago but whose log was written today, and one untouched for 40 days.
    for (const [name, fresh] of [["daily", true], ["stale", false]]) {
      const dir = join(sessions, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "{}\n");
      writeFileSync(join(dir, "chat_mode"), "b");
      if (!fresh) utimesSync(join(dir, "events.jsonl"), old, old);
      utimesSync(join(dir, "chat_mode"), old, old);
      utimesSync(dir, old, old);
    }
    await run("session-start", { session_id: "sweeper", cwd: s.repo, source: "startup" }, s);
    assert.ok(existsSync(join(sessions, "daily")), "a chat with a file written today is kept");
    assert.ok(!existsSync(join(sessions, "stale")), "a chat untouched for longer than the retention is removed");
  } finally { s.cleanup(); }
});
