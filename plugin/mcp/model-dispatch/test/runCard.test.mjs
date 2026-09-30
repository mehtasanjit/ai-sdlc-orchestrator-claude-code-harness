/**
 * The run card pre-flight records, and the settings that would silently change
 * a run's prompt caching.
 *
 * Two runs are comparable only if they ran the same code under the same cache
 * rules. The orchestrator helper pins a one-hour cache and every typist a
 * five-minute one; Claude Code (2.1.280) lets four things override that:
 * FORCE_PROMPT_CACHING_5M, any DISABLE_PROMPT_CACHING* variable,
 * CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, and the subagentPromptCacheTtl
 * setting. Pre-flight names each one it finds (never a value) and records the
 * code and CLI version, so a comparison can refuse a run that differs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheOverrides, runCard, settingsFiles, runStateConflict } from "../dist/runCard.js";

test("every setting that overrides the pinned cache lifetimes is named, by name only, wherever it is set", () => {
  const env = { FORCE_PROMPT_CACHING_5M: "1", DISABLE_PROMPT_CACHING_OPUS: "1", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" };
  const settings = [
    { source: "/u/.claude/settings.json", json: { subagentPromptCacheTtl: "5m", env: { DISABLE_PROMPT_CACHING: "1", SECRET_TOKEN: "abc" } } },
    { source: "/p/.claude/settings.json", json: { model: "opus" } },
  ];
  assert.deepEqual(cacheOverrides(env, settings), [
    "environment: CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
    "environment: DISABLE_PROMPT_CACHING_OPUS",
    "environment: FORCE_PROMPT_CACHING_5M",
    "/u/.claude/settings.json: env.DISABLE_PROMPT_CACHING",
    "/u/.claude/settings.json: subagentPromptCacheTtl",
  ]);
  assert.deepEqual(cacheOverrides({ PATH: "/bin", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, []), [], "the main conversation's own lifetime changes no helper or typist");
});

test("the settings files Claude Code reads: the user's (or CLAUDE_CONFIG_DIR's), the project's, the project's local", () => {
  assert.deepEqual(settingsFiles({ HOME: "/h" }, "/p"), ["/h/.claude/settings.json", "/p/.claude/settings.json", "/p/.claude/settings.local.json"]);
  assert.deepEqual(settingsFiles({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" }, undefined), ["/cfg/settings.json"]);
});

test("the run card: plugin version, commit and whether the tree is clean, Claude Code's version, the overrides found, and a digest of the settings (never their contents)", () => {
  const home = mkdtempSync(join(tmpdir(), "card-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { API_TOKEN: "secret-value" }, subagentPromptCacheTtl: "5m" }));
  const exec = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    if (key === "claude --version") return "2.1.280 (Claude Code)\n";
    if (key.endsWith("rev-parse --show-toplevel")) return "/plug\n";
    if (key.endsWith("rev-parse HEAD")) return "abc123\n";
    if (key.endsWith("status --porcelain -- .")) return " M src/x.ts\n?? leftover/\n";
    return null;
  };
  const card = runCard({ pluginDir: "/plug", pluginVersion: "1.2.3", env: { HOME: home }, exec });
  assert.equal(card.plugin_version, "1.2.3");
  assert.equal(card.plugin_commit, "abc123");
  assert.equal(card.plugin_tree_dirty, true, "a tracked file changed");
  assert.equal(card.plugin_untracked, 1, "untracked files are counted apart: they are not the committed code");
  const onlyUntracked = runCard({ pluginDir: "/plug", pluginVersion: "1.2.3", env: { HOME: home }, exec: (c, a) => (a.includes("--porcelain") ? "?? leftover/\n" : exec(c, a)) });
  assert.equal(onlyUntracked.plugin_tree_dirty, false);
  assert.equal(card.claude_code_version, "2.1.280 (Claude Code)");
  assert.deepEqual(card.cache_overrides, [`${join(home, ".claude", "settings.json")}: subagentPromptCacheTtl`]);
  assert.match(card.settings_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(card).includes("secret-value"), "a settings value never appears on the card");
  const outside = runCard({ pluginDir: "/plug", pluginVersion: "1.2.3", env: { HOME: home }, exec: () => null });
  assert.equal(outside.plugin_commit, null, "not a git checkout: recorded as unknown, not guessed");
  assert.equal(outside.plugin_tree_dirty, null);
  assert.equal(outside.claude_code_version, null);
});

test("a run whose stages started under one auth mode or policy conflicts with a later pre-flight asking for another; the same values do not", () => {
  const first = { authMode: "estimated", policyName: "opus-only-v5", projectRoot: "/p" };
  assert.equal(runStateConflict(undefined, first), null);
  assert.equal(runStateConflict(first, { ...first }), null);
  assert.match(runStateConflict(first, { ...first, authMode: "vendor" }), /auth mode estimated.*vendor/);
  assert.match(runStateConflict(first, { ...first, policyName: "opus-plus-flash-v38" }), /policy/);
});

test("a settings file that cannot be read, or is not JSON, is named on the card; the card is still made", () => {
  const home = mkdtempSync(join(tmpdir(), "card-odd-"));
  const project = mkdtempSync(join(tmpdir(), "card-odd-project-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  mkdirSync(join(project, ".claude", "settings.json"), { recursive: true }); // a folder where the file should be
  const locked = join(project, ".claude", "settings.local.json");
  writeFileSync(locked, JSON.stringify({ env: { FORCE_PROMPT_CACHING_5M: "1" } }));
  chmodSync(locked, 0o000);
  const asRoot = process.getuid?.() === 0; // root reads a file whatever its mode
  try {
    const card = runCard({ pluginDir: "/plug", pluginVersion: "1", env: { HOME: home }, projectRoot: project, exec: () => null });
    const named = card.settings_problems.map((p) => p.slice(0, p.indexOf(": ")));
    assert.ok(named.includes(join(home, ".claude", "settings.json")), "not JSON");
    assert.ok(named.includes(join(project, ".claude", "settings.json")), "a folder");
    if (!asRoot) assert.ok(named.includes(locked), "no permission to read");
    assert.match(card.settings_sha256, /^[0-9a-f]{64}$/);
  } finally {
    chmodSync(locked, 0o644);
  }
  const clean = runCard({ pluginDir: "/plug", pluginVersion: "1", env: { HOME: mkdtempSync(join(tmpdir(), "card-clean-")) }, exec: () => null });
  assert.deepEqual(clean.settings_problems, []);
});

/** A git repository at `root` with one commit; `git` runs with a fixed identity and no user config. */
function gitRepo(root) {
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { git, head: git("rev-parse", "HEAD") };
}

test("the plugin commit is recorded only for the plugin's own checkout, never for a repository that merely contains the plugin folder", () => {
  // An installed copy inside a git-tracked home folder: the home repository's commit says nothing about the plugin.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "card-dotfiles-")));
  const installed = join(home, ".claude", "plugins", "cache", "mkt", "mmo", "1.0.0");
  mkdirSync(join(installed, ".claude-plugin"), { recursive: true });
  writeFileSync(join(installed, ".claude-plugin", "plugin.json"), "{}");
  writeFileSync(join(home, ".zshrc"), "a\n");
  const dotfiles = gitRepo(home);
  writeFileSync(join(home, ".zshrc"), "b\n");
  writeFileSync(join(home, "stray.txt"), "x");
  const card = runCard({ pluginDir: installed, pluginVersion: "1.0.0", env: { HOME: home } });
  assert.deepEqual([card.plugin_commit, card.plugin_tree_dirty, card.plugin_untracked], [null, null, null], `not the home repository's ${dotfiles.head}`);

  // The plugin folder is its own repository.
  const own = realpathSync(mkdtempSync(join(tmpdir(), "card-own-")));
  writeFileSync(join(own, "a.txt"), "a");
  const repo = gitRepo(own);
  assert.equal(runCard({ pluginDir: own, pluginVersion: "1", env: { HOME: own } }).plugin_commit, repo.head);

  // The clone route: the plugin is the folder its repository's marketplace names; changes elsewhere in the repository are not the plugin's.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "card-clone-")));
  mkdirSync(join(clone, ".claude-plugin"));
  writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "m", plugins: [{ name: "mmo", source: "./plugin" }] }));
  mkdirSync(join(clone, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(clone, "plugin", ".claude-plugin", "plugin.json"), "{}");
  writeFileSync(join(clone, "README.md"), "a");
  const cloned = gitRepo(clone);
  writeFileSync(join(clone, "README.md"), "b");
  writeFileSync(join(clone, "notes.txt"), "x");
  const fromClone = runCard({ pluginDir: join(clone, "plugin"), pluginVersion: "1", env: { HOME: clone } });
  assert.deepEqual([fromClone.plugin_commit, fromClone.plugin_tree_dirty, fromClone.plugin_untracked], [cloned.head, false, 0]);
  writeFileSync(join(clone, "plugin", ".claude-plugin", "plugin.json"), "{\"v\":1}");
  assert.equal(runCard({ pluginDir: join(clone, "plugin"), pluginVersion: "1", env: { HOME: clone } }).plugin_tree_dirty, true, "a change inside the plugin is");
});
