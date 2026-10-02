/**
 * git runs only inside a git project, and only when a real git is installed (plugin/scripts/lib/git.mjs and its
 * server twin plugin/mcp/model-dispatch/src/git.ts).
 *
 * Why: on a Mac without Apple's developer tools, /usr/bin/git is a stub that opens an install dialog every time it
 * runs, and zero-touch looks at the folder on every typed message, the server on every hand-off and run card. A fake
 * `git` on PATH that leaves a mark when run shows here whether git was started at all. Offline, free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const lib = await import(join(ROOT, "plugin", "scripts", "lib", "git.mjs"));
const { folderKind } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));
const { resolveProjectRoot } = await import(join(ROOT, "plugin", "scripts", "lib", "env.mjs"));
const SERVER_DIST = join(ROOT, "plugin", "mcp", "model-dispatch", "dist");
const server = existsSync(join(SERVER_DIST, "git.js")) ? await import(pathToFileURL(join(SERVER_DIST, "git.js")).href) : null;

/** A folder with a fake `git` that writes a mark and prints `out`; returns { bin, ran() }. */
function fakeGit(out = "") {
  const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
  const mark = join(bin, "ran");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${mark}"\nprintf '%s' "${out}"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return { bin, ran: () => existsSync(mark), cleanup: () => rmSync(bin, { recursive: true, force: true }) };
}

/** Run `fn` with PATH = the fake git's folder first, then the system's (so node and sh are still found). */
function withPath(bin, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved}`;
  lib.forgetGitCheck();
  try { return fn(); } finally { process.env.PATH = saved; lib.forgetGitCheck(); }
}

test("gitRoot finds the nearest .git at or above a folder, and starts no process", () => {
  const top = mkdtempSync(join(tmpdir(), "git-root-"));
  try {
    mkdirSync(join(top, "repo", ".git"), { recursive: true });
    mkdirSync(join(top, "repo", "packages", "web"), { recursive: true });
    mkdirSync(join(top, "plain"), { recursive: true });
    assert.equal(lib.gitRoot(join(top, "repo", "packages", "web")), join(top, "repo"));
    assert.equal(lib.gitRoot(join(top, "plain")), null);
    writeFileSync(join(top, "plain", ".git"), "gitdir: elsewhere\n"); // a worktree's .git is a file
    assert.equal(lib.gitRoot(join(top, "plain")), join(top, "plain"));
    if (server) assert.equal(server.gitRoot(join(top, "repo", "packages", "web")), join(top, "repo"), "the server's twin agrees");
  } finally { rmSync(top, { recursive: true, force: true }); }
});

test("gitInstalled: none on PATH is false; on a Mac the /usr/bin stub counts only with the developer tools", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-git-path-"));
  try {
    for (const g of [lib, server].filter(Boolean)) {
      g.forgetGitCheck();
      assert.equal(g.gitInstalled({ platform: "darwin", env: { PATH: empty } }), false, "no git at all");
      if (existsSync("/usr/bin/git")) {
        g.forgetGitCheck();
        assert.equal(g.gitInstalled({ platform: "darwin", env: { PATH: "/usr/bin" }, run: () => ({ status: 2 }) }), false, "the stub without the developer tools");
        g.forgetGitCheck();
        assert.equal(g.gitInstalled({ platform: "darwin", env: { PATH: "/usr/bin" }, run: () => ({ status: 0 }) }), true, "the stub with them");
      }
      const f = fakeGit();
      g.forgetGitCheck();
      let asked = false;
      assert.equal(g.gitInstalled({ platform: "darwin", env: { PATH: f.bin }, run: () => { asked = true; return { status: 2 }; } }), true, "any other git is real");
      assert.equal(asked, false, "and xcode-select is not asked about it");
      f.cleanup();
      g.forgetGitCheck();
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("zero-touch's folder check never starts git in a folder that is not a git project", () => {
  const f = fakeGit("a.txt");
  const dir = mkdtempSync(join(tmpdir(), "new-folder-"));
  try {
    assert.equal(withPath(f.bin, () => folderKind(dir)), "new");
    assert.equal(f.ran(), false, "git was not started for an empty folder (on a fresh Mac that opens a dialog)");
    // Inside a git project it is still used: a tracked file makes the folder an existing project.
    mkdirSync(join(dir, ".git"));
    assert.equal(withPath(f.bin, () => folderKind(dir)), "existing");
    assert.equal(f.ran(), true, "git is used inside a git project");
  } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("the scripts' project-root lookup starts no git outside a git project", () => {
  const f = fakeGit("/somewhere");
  const dir = mkdtempSync(join(tmpdir(), "no-repo-"));
  try {
    assert.equal(withPath(f.bin, () => resolveProjectRoot(undefined, dir)), dir);
    assert.equal(f.ran(), false);
  } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("the hand-off test copy tells 'git isn't installed' from 'not a git project', and starts no git for either", { skip: server ? false : "NOT RUN: the server is not compiled (npm run build in plugin/mcp/model-dispatch)" }, async () => {
  const { makeScratchCopy } = await import(pathToFileURL(join(SERVER_DIST, "handoff", "scratch.js")).href);
  const f = fakeGit("");
  const dir = mkdtempSync(join(tmpdir(), "scratch-src-"));
  const empty = mkdtempSync(join(tmpdir(), "no-git-path-"));
  const saved = process.env.PATH;
  try {
    writeFileSync(join(dir, "a.js"), "x\n");
    process.env.PATH = `${f.bin}${delimiter}${saved}`;
    server.forgetGitCheck();
    assert.equal(makeScratchCopy(dir).cause, "no-git", "a folder that is not a git project");
    assert.equal(f.ran(), false, "and git was not started");
    process.env.PATH = empty;
    server.forgetGitCheck();
    assert.equal(makeScratchCopy(dir).cause, "git-missing", "no git on this computer");
  } finally { process.env.PATH = saved; server.forgetGitCheck(); f.cleanup(); rmSync(dir, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});
