/**
 * A chat's start in these cases:
 *   - Off chosen: nothing at all, mmo included: no line about mmo, and mmo is never updated unasked;
 *   - a run with no person at a screen (a script's `claude -p`, or one Claude Code marks unattended, such as a
 *     `claude -p` started from inside a chat): exactly as Claude Code alone, nothing marked and nothing said;
 *   - a person whose workflows may bill an API key: no promise about the chat's model, which their runs do not follow.
 * Each case runs zero-touch's real start hook through its shell script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const { writeZtSettings, writeGoogleLogin, gitProject, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));

function sandbox(settings, { oldMmo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zt-start-cases-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const config = join(dir, "claude");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(join(config, "plugins"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo);
  if (settings) writeZtSettings(home, settings, { google: true });
  writeGoogleLogin(home);
  if (oldMmo) {
    const mmo = join(dir, "mmo-old");
    mkdirSync(join(mmo, "hooks"), { recursive: true });
    writeFileSync(join(mmo, "hooks", "ambient.sh"), "");
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "zero-touch@m": [{ scope: "user", installPath: ZT }], "mmo@m": [{ scope: "user", installPath: mmo }] } }));
  }
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A stand-in `claude` that would record an update, should one ever be started.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${join(dir, "claude-calls")}"\n`, { mode: 0o755 });
  return { dir, home, repo, config, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function start(s, sid, env = {}) {
  const r = spawnSync("sh", [join(ZT, "hooks", "start-chat.sh")], {
    input: JSON.stringify({ session_id: sid, cwd: s.repo, source: "startup", model: "claude-opus-5" }),
    env: { PATH: `${s.bin}:${process.env.PATH}`, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home), CLAUDE_PROJECT_DIR: s.repo, CLAUDE_CONFIG_DIR: s.config, CLAUDE_PLUGIN_ROOT: ZT, CLAUDE_CODE_ENTRYPOINT: "cli", MMO_MANAGED_SETTINGS: join(s.dir, "managed.json"), ...env },
    encoding: "utf8",
  });
  const json = r.stdout ? JSON.parse(r.stdout) : null;
  return { message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "", marked: existsSync(join(s.home, "sessions", sid, "chat_mode")) };
}

test("Off chosen and an old mmo: nothing is said and mmo is never updated", () => {
  const s = sandbox({ mode: "off" }, { oldMmo: true });
  try {
    const r = start(s, "o1");
    assert.deepEqual([r.message, r.note, r.marked], ["", "", false]);
    assert.equal(existsSync(join(s.dir, "claude-calls")), false, "no `claude plugin update` started");
    assert.equal(existsSync(join(ztData(s.home), "mmo-update.json")), false);
  } finally { s.cleanup(); }
});

test("a run with no person at a screen is left exactly as Claude Code alone would leave it", () => {
  const s = sandbox({ mode: "workflows" });
  try {
    for (const [sid, env] of [["n1", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }], ["n2", { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }], ["n3", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ATTENDED: "0" }]]) {
      const r = start(s, sid, env);
      assert.deepEqual([r.message, r.note, r.marked], ["", "", false], JSON.stringify(env));
    }
    const chat = start(s, "n4", { CLAUDE_CODE_SESSION_ATTENDED: "1" });
    assert.equal(chat.marked, true, "a chat with a person is marked as before");
  } finally { s.cleanup(); }
});

test("a person whose workflows may bill an API key gets no promise about the chat's model", () => {
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    const plain = start(s, "k1", { CLAUDE_CODE_SESSION_ATTENDED: "1" });
    assert.match(plain.message, /This chat is on Opus 5, which workflows need/, "a plan login: the line, as before");
  } finally { s.cleanup(); }
  const t = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    const keyed = start(t, "k2", { ANTHROPIC_API_KEY: "sk-test" });
    assert.match(keyed.message, /^Zero-touch is on in this chat: Workflows mode\./);
    assert.doesNotMatch(keyed.message, /Workflows need this chat|which workflows need|switching this chat to another model is blocked/);
  } finally { t.cleanup(); }
});
