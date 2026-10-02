/**
 * A person whose only Claude login is an API key gets Claude typists that can log in.
 *
 * Why: zero-touch starts workflows and hand-offs with auth=estimated, where the model server's Claude typist (a
 * `claude -p` child) is given no ANTHROPIC_API_KEY. With no subscription login on the computer, that typist has no
 * login at all. lib/claude-login.mjs checks, at no cost (`claude auth status --json`, no model call), whether a typist
 * would be logged in, and only when a key is set and it would not be, the chat's starts carry auth=vendor.
 *
 * Here: the check's environment is exactly the typist's (compared with the server's own leanOpusEnv); the `claude`
 * it runs is the server's; the check runs only with a key, once per chat; a check that cannot answer changes nothing;
 * and end to end, a routed workflow and a hand-off carry auth=vendor only for the key-only person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const L = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "claude-login.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();

/** A stand-in `claude`: answers `auth status --json` with `status`, and counts its runs in `<dir>/runs`. */
function fakeClaude(dir, status, { exit = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude");
  const body = typeof status === "string" ? status : JSON.stringify(status);
  writeFileSync(file, `#!/bin/sh\necho run >> "${join(dir, "runs")}"\n[ -n "$ANTHROPIC_API_KEY" ] && echo key >> "${join(dir, "saw-key")}"\nprintf '%s' '${body}'\nexit ${exit}\n`);
  chmodSync(file, 0o755);
  return file;
}
const runs = (dir) => { try { return readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

test("the check runs with exactly the environment the server's Claude typist gets in estimated mode", { skip: SKIP ?? false }, async () => {
  const { leanOpusEnv } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "executor", "typists.js"));
  const env = {
    HOME: "/h", PATH: "/bin", USER: "u", TMPDIR: "/t", LANG: "en", HTTPS_PROXY: "p", NODE_EXTRA_CA_CERTS: "c",
    CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_AUTH_TOKEN: "a", ANTHROPIC_BASE_URL: "b",
    CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "r", AWS_PROFILE: "p", VERTEX_REGION_CLAUDE_X: "v", ANTHROPIC_FOUNDRY_RESOURCE: "f",
    CLAUDE_CODE_USE_VERTEX: "1", CLOUDSDK_CONFIG: "/g", GOOGLE_APPLICATION_CREDENTIALS: "/c.json",
    ANTHROPIC_API_KEY: "sk-test", GEMINI_API_KEY: "g", SECRET_THING: "s", MMO_HOME: "/m", CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  const server = leanOpusEnv(env, "estimated");
  delete server.CLAUDE_CODE_PROMPT_CACHE_TTL; // the typist's own two settings, not from the environment
  delete server.DISABLE_AUTOUPDATER;
  assert.deepEqual(L.typistEnv(env), server);
  assert.equal(L.typistEnv(env).ANTHROPIC_API_KEY, undefined, "estimated mode: no key");
});

test("the check runs the `claude` the server runs", { skip: SKIP ?? false }, async () => {
  const { findClaude } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "claudeCommand.js"));
  const dir = mkdtempSync(join(tmpdir(), "zt-login-find-"));
  try {
    const home = join(dir, "home");
    const app = (v) => join(home, "Library", "Application Support", "Claude", "claude-code", v, "claude.app", "Contents", "MacOS", "claude");
    const both = (env, platform) => { const z = L.findClaude(env, platform); assert.equal(findClaude(env, platform), z); return z; };
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "darwin"), null);
    for (const v of ["2.1.39", "2.1.284"]) { mkdirSync(join(app(v), ".."), { recursive: true }); writeFileSync(app(v), "#!/bin/sh\n"); chmodSync(app(v), 0o755); }
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "darwin"), app("2.1.284"));
    assert.equal(both({ PATH: join(dir, "none"), HOME: home }, "linux"), null);
    const bin = fakeClaude(join(dir, "bin"), { loggedIn: true });
    assert.equal(both({ PATH: `${join(dir, "none")}:${join(dir, "bin")}`, HOME: home }, "darwin"), bin);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("typistLogin reads loggedIn from `claude auth status --json`, and says nothing when it cannot tell", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-login-"));
  try {
    const env = { PATH: "/bin", HOME: dir, ANTHROPIC_API_KEY: "sk-test" };
    assert.deepEqual(L.typistLogin(env, { claude: fakeClaude(join(dir, "a"), { loggedIn: false, authMethod: "none" }) }), { loggedIn: false, method: "none" });
    assert.equal(existsSync(join(dir, "a", "saw-key")), false, "the check never hands the typist's check the key");
    assert.deepEqual(L.typistLogin(env, { claude: fakeClaude(join(dir, "b"), { loggedIn: true, authMethod: "claude.ai" }) }), { loggedIn: true, method: "claude.ai" });
    assert.deepEqual(L.typistLogin(env, { claude: fakeClaude(join(dir, "c"), "not json") }), { loggedIn: null, method: null });
    assert.deepEqual(L.typistLogin(env, { claude: fakeClaude(join(dir, "d"), { authMethod: "x" }) }), { loggedIn: null, method: null }, "no loggedIn field");
    assert.deepEqual(L.typistLogin(env, { claude: null }), { loggedIn: null, method: null }, "no claude on this computer");
    assert.deepEqual(L.typistLogin(env, { claude: join(dir, "missing", "claude") }), { loggedIn: null, method: null }, "a path that does not run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chatAuth: vendor only for a key with no typist login; the check runs only with a key, once per chat", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-login-chat-"));
  try {
    const home = join(dir, "home");
    const noLogin = join(dir, "no-login");
    const claude = fakeClaude(noLogin, { loggedIn: false, authMethod: "none" });
    const base = { MMO_HOME: home, PATH: "/bin", HOME: dir };
    assert.equal(L.chatAuth("c1", "estimated", base, { claude }), "estimated", "no key: nothing else to use");
    assert.equal(runs(noLogin), 0, "and no check runs");
    assert.equal(L.chatAuth("c1", "estimated", { ...base, ANTHROPIC_API_KEY: "  " }, { claude }), "estimated", "a blank key is no key");
    assert.equal(runs(noLogin), 0);
    const key = { ...base, ANTHROPIC_API_KEY: "sk-test" };
    assert.equal(L.chatAuth("c2", "estimated", key, { claude }), "vendor", "a key and no typist login: the key is used");
    assert.equal(L.chatAuth("c2", "estimated", key, { claude }), "vendor");
    assert.equal(runs(noLogin), 1, "checked once for the chat");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "sessions", "c2", "claude_login.json"), "utf8"))).sort(), ["at", "logged_in", "method"]);
    const loggedIn = join(dir, "logged-in");
    assert.equal(L.chatAuth("c3", "estimated", key, { claude: fakeClaude(loggedIn, { loggedIn: true, authMethod: "claude.ai" }) }), "estimated", "a key beside a plan login: the plan, as before");
    assert.equal(L.chatAuth("c4", "vendor", base, { claude }), "vendor", "configured vendor stays vendor");
    const unsure = join(dir, "unsure");
    assert.equal(L.chatAuth("c5", "estimated", key, { claude: fakeClaude(unsure, "oops") }), "estimated", "cannot tell: nothing changes");
    assert.equal(existsSync(join(home, "sessions", "c5", "claude_login.json")), false, "and nothing is kept, so it is asked again");
    assert.equal(L.chatAuth("c5", "estimated", key, { claude: fakeClaude(unsure, "oops") }), "estimated");
    assert.equal(runs(unsure), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// End to end, through mmo's hook as zero-touch runs it.
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { startingChats, writeZtSettings, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));

function sandbox(settings) {
  const dir = mkdtempSync(join(tmpdir(), "zt-login-e2e-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo);
  writeZtSettings(home, settings, { google: true });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => { let json = null; try { json = stdout ? JSON.parse(stdout) : null; } catch { /* null */ } done({ code, stdout, json }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

test("a routed workflow and a hand-off carry auth=vendor only for a person whose only Claude login is a key", { skip: SKIP ?? false }, async () => {
  for (const [name, status, key, want] of [
    ["key only", { loggedIn: false, authMethod: "none" }, "sk-test", "vendor"],
    ["key beside a plan login", { loggedIn: true, authMethod: "claude.ai" }, "sk-test", "estimated"],
    ["plan login, no key", { loggedIn: true, authMethod: "claude.ai" }, null, "estimated"],
  ]) {
    const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    try {
      const bin = join(s.dir, "bin");
      fakeClaude(bin, status);
      const env = { PATH: `${bin}:${process.env.PATH}`, ...(key ? { ANTHROPIC_API_KEY: key } : {}) };
      const r = await run("prompt", { session_id: "w1", cwd: s.repo, prompt: "fix the /login endpoint returning 500 on missing password", prompt_id: "p1" }, s, env);
      assert.match(context(r), new RegExp(`\\[zero-touch policy=opus-plus-sonnet auth=${want}\\]`), `${name}: ${context(r)}`);
      assert.equal(runs(bin), key ? 1 : 0, `${name}: the check ran ${key ? "once" : "not at all"}`);
    } finally { s.cleanup(); }
    const h = sandbox({ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "sonnet", tests: "sonnet", repeats: "sonnet" } });
    try {
      const bin = join(h.dir, "bin");
      fakeClaude(bin, status);
      const env = { PATH: `${bin}:${process.env.PATH}`, ...(key ? { ANTHROPIC_API_KEY: key } : {}) };
      const r = await run("pre-handoff", { session_id: "h1", cwd: h.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_use_id: "tu-1", tool_input: { kind: "docs", file: "docs/setup.md" } }, h, env);
      assert.equal(r.json?.hookSpecificOutput?.updatedInput?._mmo?.auth, want, `${name} (hand-off): ${r.stdout}`);
    } finally { h.cleanup(); }
  }
});
