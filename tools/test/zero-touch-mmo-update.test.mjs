/**
 * Installing zero-touch is the whole job, even over an older mmo.
 *
 * Why: Claude Code installs zero-touch's dependency when it is missing, but leaves an already installed mmo at its old
 * version, with or without a version range in zero-touch's manifest. Everyone who had used mmo's typed commands would
 * then have to update mmo by hand. zero-touch/scripts/mmo-update.mjs starts Claude Code's own `claude plugin update`
 * of mmo from the first chat that finds it too old, once at a time, and says to start a new chat in a minute.
 *
 * Here: which install is updated (zero-touch's own marketplace first; the scope it was installed at; never one an
 * organisation manages); one attempt at a time; a failed or unhelpful attempt falls back to the manual words; and the
 * chat start, through the real shell script, starts the update and shows the new line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// The installed copies these tests build are at the plugin's own version, as a real install is.
const VERSION = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
const ZT = join(ROOT, "zero-touch");
const U = await import(join(ZT, "scripts", "mmo-update.mjs"));
const M = await import(join(ZT, "scripts", "messages.mjs"));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "zt-mmo-update-"));
  const config = join(dir, "claude");
  const data = join(dir, "zt-data");
  mkdirSync(join(config, "plugins"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: data, MMO_HOME: join(dir, "mmohome"), MMO_MANAGED_SETTINGS: join(dir, "managed.json"), PATH: process.env.PATH };
  /** An installed mmo: `api` null is one without zero-touch's hooks. */
  const mmoAt = (api) => { const p = mkdtempSync(join(dir, "mmo-")); mkdirSync(join(p, "scripts", "ambient"), { recursive: true }); mkdirSync(join(p, "hooks"), { recursive: true }); writeFileSync(join(p, "hooks", "ambient.sh"), ""); if (api !== null) writeFileSync(join(p, "scripts", "ambient", "api.json"), JSON.stringify({ zero_touch_api: api })); return p; };
  const installed = (plugins) => writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  return { dir, config, data, env, mmoAt, installed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A spawn that records its calls and starts nothing. */
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  return { calls, spawn };
}

test("the install updated is the mmo of zero-touch's own marketplace, at its own scope; never a managed one", () => {
  const s = sandbox();
  try {
    const project = join(s.dir, "proj");
    mkdirSync(project);
    s.installed({
      "zero-touch@ours": [{ scope: "user", installPath: ZT }],
      "mmo@other": [{ scope: "user", installPath: s.mmoAt(null) }],
      "mmo@ours": [{ scope: "project", projectPath: project, installPath: s.mmoAt(null) }],
    });
    assert.deepEqual(U.mmoUpdateTarget(s.env, ZT), { id: "mmo@ours", scope: "project", projectPath: project }, "zero-touch's own marketplace first, at its scope");
    s.installed({ "zero-touch@ours": [{ scope: "user", installPath: ZT }], "mmo@ours": [{ scope: "managed", installPath: s.mmoAt(null) }] });
    assert.equal(U.mmoUpdateTarget(s.env, ZT), null, "an organisation's install is the organisation's to update");
    s.installed({ "zero-touch@ours": [{ scope: "user", installPath: ZT }], "mmo@ours": [{ scope: "local", projectPath: join(s.dir, "gone"), installPath: s.mmoAt(null) }] });
    assert.equal(U.mmoUpdateTarget(s.env, ZT), null, "a project install whose folder is gone");
    s.installed({ "zero-touch@ours": [{ scope: "user", installPath: ZT }], "mmo@ours": [{ scope: "user", installPath: s.mmoAt(null) }] });
    assert.deepEqual(U.mmoUpdateTarget(s.env, ZT), { id: "mmo@ours", scope: "user", projectPath: null });
  } finally { s.cleanup(); }
});

test("one update at a time: started once, trusted while it runs, the manual words once it is over", () => {
  const s = sandbox();
  try {
    s.installed({ "zero-touch@ours": [{ scope: "user", installPath: ZT }], "mmo@ours": [{ scope: "user", installPath: s.mmoAt(null) }] });
    const f = fakeSpawn();
    const t0 = Date.parse("2026-10-01T20:00:00Z");
    assert.equal(U.updateMmo(s.env, { spawn: f.spawn, claude: "/bin/claude-here", now: t0, ztRoot: ZT }), "running");
    assert.equal(f.calls.length, 1);
    const [call] = f.calls;
    assert.equal(call.cmd, "sh");
    assert.deepEqual(call.args.slice(2, 5), ["/bin/claude-here", "mmo@ours", "user"], "Claude Code's own update, of that install, at its scope");
    assert.match(call.args[1], /"\$0" plugin update "\$1" --scope "\$2"/, "values travel as arguments, never inside the script");
    assert.equal(call.opts.detached, true, "it outlives the hook");
    assert.equal(U.updateMmo(s.env, { spawn: f.spawn, claude: "/bin/claude-here", now: t0 + 60_000, ztRoot: ZT }), "running", "another chat a minute later: still under way");
    assert.equal(f.calls.length, 1, "and no second update");
    writeFileSync(join(s.data, "mmo-update.exit"), "1\n");
    assert.equal(U.updateMmo(s.env, { spawn: f.spawn, claude: "/bin/claude-here", now: t0 + 120_000, ztRoot: ZT }), "failed", "over, and mmo still too old: the manual words");
    writeFileSync(join(s.data, "mmo-update.exit"), "0\n");
    assert.equal(U.updateMmo(s.env, { spawn: f.spawn, claude: "/bin/claude-here", now: t0 + 120_000, ztRoot: ZT }), "failed", "an update that ended well but left mmo too old did not help");
    assert.equal(U.updateMmo(s.env, { spawn: f.spawn, claude: "/bin/claude-here", now: t0 + U.ATTEMPT_MS + 1, ztRoot: ZT }), "running", "after ten minutes, a new attempt");
    assert.equal(f.calls.length, 2);
    assert.equal(existsSync(join(s.data, "mmo-update.exit")), false, "the old exit code is cleared for the new attempt");
    assert.equal(U.updateMmo({ ...s.env, CLAUDE_PLUGIN_DATA: join(s.dir, "fresh") }, { spawn: f.spawn, claude: null, now: t0, ztRoot: ZT }), "failed", "no `claude` program: the manual words");
  } finally { s.cleanup(); }
});

test("a new chat over an old mmo: the update starts by itself and the person is told to start a new chat", async () => {
  const s = sandbox();
  try {
    s.installed({ "zero-touch@ours": [{ scope: "user", installPath: ZT }], "mmo@ours": [{ scope: "user", installPath: s.mmoAt(null) }] });
    const bin = join(s.dir, "bin");
    mkdirSync(bin);
    const argsFile = join(s.dir, "claude-args");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s ' "$@" > "${argsFile}"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const env = { ...s.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PLUGIN_ROOT: ZT, CLAUDE_CODE_ENTRYPOINT: "cli" };
    const r = spawnSync("sh", [join(ZT, "hooks", "start-chat.sh")], { input: JSON.stringify({ session_id: "u1", source: "startup", cwd: s.dir, hook_event_name: "SessionStart" }), env, encoding: "utf8" });
    const out = JSON.parse(r.stdout);
    assert.equal(out.systemMessage, M.mmoUpdatingMessage());
    assert.match(out.systemMessage, /^Zero-touch is updating mmo, a plugin it needs, which is an older version\. Claude works as normal in this chat\. Start a new chat in a minute to use zero-touch\.$/);
    assert.equal(out.hookSpecificOutput.additionalContext, M.MMO_UNAVAILABLE_NOTE, "Claude answers normally and opens no box");
    for (let i = 0; i < 50 && !existsSync(join(s.data, "mmo-update.exit")); i++) await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(readFileSync(argsFile, "utf8").trim(), "plugin update mmo@ours --scope user");
    assert.equal(readFileSync(join(s.data, "mmo-update.exit"), "utf8").trim(), "0");
    // The update ran but changed nothing (this stand-in does nothing): the next chat gets the manual words, not a loop.
    const again = spawnSync("sh", [join(ZT, "hooks", "start-chat.sh")], { input: JSON.stringify({ session_id: "u2", source: "startup", cwd: s.dir, hook_event_name: "SessionStart" }), env, encoding: "utf8" });
    assert.equal(JSON.parse(again.stdout).systemMessage, M.mmoTooOldMessage());
  } finally { s.cleanup(); }
});

test("the saved line says the update is under way, never asks for it by hand while it runs", () => {
  const line = M.savedLine({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } }, { mmo: "updating" });
  assert.match(line, /• mmo, a plugin zero-touch needs, is an older version; zero-touch is updating it now\. Start a new chat in a minute\./);
  assert.doesNotMatch(line, /Update it in your plugins list/);
});

test("the hook shim never runs an mmo without zero-touch's hooks, even when the kept answer still names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-shim-"));
  try {
    const cache = join(dir, "cache", "m");
    const ztHere = join(cache, "zero-touch", VERSION);
    mkdirSync(join(ztHere, "hooks"), { recursive: true });
    writeFileSync(join(ztHere, "hooks", "mmo-hook.sh"), readFileSync(join(ZT, "hooks", "mmo-hook.sh")));
    const ran = join(dir, "ran");
    const mmo = (v, api) => {
      const p = join(cache, "mmo", v);
      mkdirSync(join(p, "hooks"), { recursive: true });
      mkdirSync(join(p, "scripts", "ambient"), { recursive: true });
      writeFileSync(join(p, "hooks", "ambient.sh"), `#!/bin/sh\necho ${v} > "${ran}"\n`);
      if (api !== null) writeFileSync(join(p, "scripts", "ambient", "api.json"), JSON.stringify({ zero_touch_api: api }));
      return p;
    };
    const stale = mmo("0.8.4", null);
    mmo(VERSION, 1);
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "mmo-root"), `${stale}\n`);
    const run = () => { rmSync(ran, { force: true }); spawnSync("sh", [join(ztHere, "hooks", "mmo-hook.sh"), "session-start"], { input: "{}", env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: data } }); return existsSync(ran) ? readFileSync(ran, "utf8").trim() : null; };
    assert.equal(run(), VERSION, "the kept answer names an early build: the current mmo beside zero-touch runs instead");
    writeFileSync(join(cache, "mmo", VERSION, "scripts", "ambient", "api.json"), JSON.stringify({ zero_touch_api: 0 }));
    assert.equal(run(), null, "no mmo with zero-touch's hooks: nothing runs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
