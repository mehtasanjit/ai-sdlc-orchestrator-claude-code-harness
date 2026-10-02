/**
 * Zero-touch hand-off mode: the scratch copy a hand-off is checked in, and the record that lets a landed hand-off be
 * undone.
 *
 * Tests written by the hand-off model, and a change repeated across files, are RUN before they reach the project: in
 * a scratch copy of the project, with the project's own command. The copy holds the project's files as they are now
 * (uncommitted work included), as real copies, so nothing a test run writes lands in the project; installed
 * dependencies are linked in, not copied, so the command can run. A project that is not a
 * git repository has no way to tell its own files from installed dependencies, so no copy is made and the hand-off
 * is refused.
 *
 * Every hand-off that changes the project is recorded with what each file held before, so one call undoes it; a file
 * changed since is left alone and reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { makeScratchCopy, runInScratch } from "../dist/handoff/scratch.js";
import { recordLanding, undoLanding, landings } from "../dist/handoff/landing.js";

function project({ git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-scratch-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  writeFileSync(join(repo, "package.json"), '{"name":"shop","type":"module"}\n');
  writeFileSync(join(repo, "src", "cart.js"), "export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n");
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "export const dep = 1;\n");
  writeFileSync(join(repo, "debug.log"), "noise\n");
  if (git) {
    const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "first");
  }
  // Work since the last commit: a changed file and a new one. The copy must hold both.
  writeFileSync(join(repo, "src", "cart.js"), "export const total = (items) => items.reduce((n, i) => n + i.price, 0); // edited\n");
  writeFileSync(join(repo, "src", "new.js"), "export const fresh = true;\n");
  return { dir, repo, session: join(dir, "session"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the scratch copy holds the project as it is now, as real copies; installed dependencies are linked in", () => {
  const p = project();
  let copy;
  try {
    copy = makeScratchCopy(p.repo);
    assert.ok(copy.dir, copy.refused);
    assert.match(readFileSync(join(copy.dir, "src", "cart.js"), "utf8"), /\/\/ edited/, "uncommitted work is in the copy");
    assert.ok(existsSync(join(copy.dir, "src", "new.js")), "a new, untracked file is in the copy");
    assert.ok(!lstatSync(join(copy.dir, "src", "cart.js")).isSymbolicLink(), "the project's own files are copies");
    assert.ok(lstatSync(join(copy.dir, "node_modules")).isSymbolicLink(), "installed dependencies are linked, not copied");
    assert.equal(readlinkSync(join(copy.dir, "node_modules")), join(p.repo, "node_modules"));
    assert.ok(!existsSync(join(copy.dir, ".git")), "the repository's own records are not part of the copy");
    // Writing in the copy never reaches the project.
    writeFileSync(join(copy.dir, "src", "cart.js"), "changed in the copy\n");
    writeFileSync(join(copy.dir, "src", "extra.test.js"), "x\n");
    assert.match(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), /\/\/ edited/);
    assert.ok(!existsSync(join(p.repo, "src", "extra.test.js")));
    const where = copy.dir;
    copy.remove();
    assert.ok(!existsSync(where), "the copy is removed afterwards");
    assert.ok(existsSync(join(p.repo, "node_modules", "dep", "index.js")), "removing the copy removes the link, never what it points at");
  } finally { p.cleanup(); }
});

test("what git ignores never lets a command in the copy write into the project: only dependency folders are linked", async () => {
  // With every ignored entry linked, a failing build or test run in the copy would write into the real dist/ and
  // coverage/.
  const p = project();
  let copy;
  try {
    mkdirSync(join(p.repo, "dist"), { recursive: true });
    mkdirSync(join(p.repo, "coverage"), { recursive: true });
    writeFileSync(join(p.repo, "dist", "a.js"), "built\n");
    writeFileSync(join(p.repo, ".env.test"), "KEY=1\n");
    writeFileSync(join(p.repo, ".gitignore"), "node_modules/\n*.log\ndist/\ncoverage/\n.env.test\n");
    copy = makeScratchCopy(p.repo);
    assert.ok(copy.dir, copy.refused);
    assert.ok(lstatSync(join(copy.dir, "node_modules")).isSymbolicLink(), "installed dependencies: linked");
    assert.ok(!existsSync(join(copy.dir, "dist")), "build output: left out, never linked");
    assert.equal(readFileSync(join(copy.dir, ".env.test"), "utf8"), "KEY=1\n", "a small ignored file: copied");
    assert.ok(!lstatSync(join(copy.dir, ".env.test")).isSymbolicLink());
    const run = await runInScratch(copy.dir, "mkdir -p dist coverage && echo UNLANDED > dist/a.js && echo report > coverage/r.txt && echo X > .env.test", { timeoutMs: 10_000 });
    assert.equal(run.code, 0, run.output);
    assert.equal(readFileSync(join(p.repo, "dist", "a.js"), "utf8"), "built\n", "the real build output is untouched");
    assert.ok(!existsSync(join(p.repo, "coverage", "r.txt")), "no coverage report lands in the project");
    assert.equal(readFileSync(join(p.repo, ".env.test"), "utf8"), "KEY=1\n", "the real file is untouched");
  } finally { copy?.remove?.(); p.cleanup(); }
});

test("a package inside a monorepo: the copy is the whole repository, and the command runs in the package's folder", async () => {
  // A copy of the package alone has none of the workspace's dependencies, so every test would fail with "Cannot find
  // module".
  const p = project();
  let copy;
  try {
    mkdirSync(join(p.repo, "packages", "web", "src"), { recursive: true });
    writeFileSync(join(p.repo, "packages", "web", "src", "page.js"), "export const page = 1;\n");
    copy = makeScratchCopy(join(p.repo, "packages", "web"));
    assert.ok(copy.dir, copy.refused);
    assert.equal(copy.cwd, "packages/web");
    assert.ok(existsSync(join(copy.dir, "packages", "web", "src", "page.js")));
    assert.ok(lstatSync(join(copy.dir, "node_modules")).isSymbolicLink(), "the workspace's dependencies, at its top");
    const run = await runInScratch(copy.dir, "pwd && ls ../../node_modules/dep", { timeoutMs: 10_000, cwd: copy.cwd });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /packages\/web\n/);
    assert.match(run.output, /index\.js/);
  } finally { copy?.remove?.(); p.cleanup(); }
});

test("a project that is not a git repository gets no copy, with the reason", () => {
  const p = project({ git: false });
  try {
    const copy = makeScratchCopy(p.repo);
    assert.equal(copy.dir, undefined);
    assert.match(copy.refused, /not a git repository/);
  } finally { p.cleanup(); }
});

test("a command runs in the copy: its exit code and output come back, and one that hangs is stopped", async () => {
  const p = project();
  const copy = makeScratchCopy(p.repo);
  try {
    const ok = await runInScratch(copy.dir, "node -e \"import('./src/cart.js').then(m => console.log('total', m.total([{price:2},{price:3}])))\"", { timeoutMs: 20000 });
    assert.equal(ok.code, 0);
    assert.match(ok.output, /total 5/);
    const bad = await runInScratch(copy.dir, "echo before; echo problem >&2; exit 3", { timeoutMs: 20000 });
    assert.equal(bad.code, 3);
    assert.match(bad.output, /before[\s\S]*problem/, "both streams, in order");
    const hung = await runInScratch(copy.dir, "sleep 30", { timeoutMs: 300 });
    assert.equal(hung.timedOut, true);
    assert.notEqual(hung.code, 0);
    const env = await runInScratch(copy.dir, "echo CI=$CI", { timeoutMs: 20000 });
    assert.match(env.output, /CI=1/, "runners are told not to wait for a person");
    const long = await runInScratch(copy.dir, "node -e \"for (let i = 0; i < 5000; i++) console.log('line ' + i)\"", { timeoutMs: 20000 });
    assert.match(long.output, /line 4999/, "the end of a long output is kept");
    assert.doesNotMatch(long.output, /line 0\n/, "its start is cut");
    assert.match(long.output, /^\[earlier output cut\]/);
  } finally { copy.remove(); p.cleanup(); }
});

test("a landed hand-off is recorded with what each file held before, and one call undoes it", () => {
  const p = project();
  try {
    const before = readFileSync(join(p.repo, "src", "cart.js"), "utf8");
    // A hand-off changed one file and created another.
    const id = recordLanding(p.session, p.repo, { tool: "repeat_edit_across_files", files: [{ path: "src/cart.js", content: "new cart\n" }, { path: "tests/cart.test.js", content: "a test\n" }] });
    // An id unique among every chat's landings: "h" and four letters or digits nobody misreads.
    assert.match(id, /^h[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
    assert.equal(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), "new cart\n", "recording a landing writes its files");
    assert.equal(readFileSync(join(p.repo, "tests", "cart.test.js"), "utf8"), "a test\n");
    assert.deepEqual(landings(p.session).map((l) => [l.id, l.tool, l.undone ?? false, l.project]), [[id, "repeat_edit_across_files", false, resolve(p.repo)]]);

    const undone = undoLanding(p.session, p.repo, id);
    assert.deepEqual(undone.restored.sort(), ["src/cart.js", "tests/cart.test.js"]);
    assert.equal(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), before, "a changed file gets its earlier text back");
    assert.ok(!existsSync(join(p.repo, "tests", "cart.test.js")), "a created file is removed");
    assert.deepEqual(undoLanding(p.session, p.repo, id), { refused: `hand-off ${id} is already undone`, cause: "already-undone" });
    assert.deepEqual(undoLanding(p.session, p.repo, "h9999"), { refused: "there is no hand-off h9999 in this project", cause: "unknown-id" });
  } finally { p.cleanup(); }
});

test("undo leaves a file alone when it was changed after the hand-off, and says so", () => {
  const p = project();
  try {
    const a = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/a.md", content: "A\n" }, { path: "docs/b.md", content: "B\n" }] });
    const b = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/c.md", content: "C\n" }] });
    assert.notEqual(a, b, "every landing has its own id");
    writeFileSync(join(p.repo, "docs", "b.md"), "B, corrected by hand\n");
    const undone = undoLanding(p.session, p.repo, a);
    assert.deepEqual(undone.restored, ["docs/a.md"]);
    assert.deepEqual(undone.left_alone, ["docs/b.md"]);
    assert.equal(readFileSync(join(p.repo, "docs", "b.md"), "utf8"), "B, corrected by hand\n");
    assert.ok(existsSync(join(p.repo, "docs", "c.md")), "another hand-off's file is untouched");
  } finally { p.cleanup(); }
});

test("undo when every file changed since: nothing is undone and the landing stays, until the person agrees", () => {
  // The receipt tells Claude to correct a slip itself, so the landed file often changes; an undo that then does
  // nothing must not mark the landing undone.
  const p = project();
  try {
    const id = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/n.md", content: "N\n" }] });
    writeFileSync(join(p.repo, "docs", "n.md"), "N, corrected by Claude\n");
    assert.deepEqual(undoLanding(p.session, p.repo, id), { restored: [], left_alone: ["docs/n.md"], kept: true });
    assert.equal(landings(p.session)[0].undone, undefined, "not marked undone");
    // The person agreed: the file the hand-off created goes, correction and all.
    assert.deepEqual(undoLanding(p.session, p.repo, id, { includeChanged: true }), { restored: ["docs/n.md"], left_alone: [] });
    assert.ok(!existsSync(join(p.repo, "docs", "n.md")));
    assert.equal(landings(p.session)[0].undone, true);
  } finally { p.cleanup(); }
});

test("an undo asked in another chat, or after /clear, finds the landing by its id in the same project, never another project's", () => {
  const p = project();
  const q = project();
  try {
    const id = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/x.md", content: "X\n" }] });
    // Another chat of the same machine: a sibling records folder.
    const other = join(dirname(p.session), "other-chat");
    mkdirSync(other, { recursive: true });
    assert.deepEqual(undoLanding(other, p.repo, id), { restored: ["docs/x.md"], left_alone: [] }, "found in the chat that made it, and undone");
    assert.equal(landings(p.session)[0].undone, true, "marked in its own chat's record");
    // A second landing, then an undo asked from a chat working in another project.
    const id2 = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/y.md", content: "Y\n" }] });
    assert.equal(undoLanding(other, q.repo, id2).cause, "other-project");
    assert.ok(existsSync(join(p.repo, "docs", "y.md")), "nothing touched");
  } finally { p.cleanup(); q.cleanup(); }
});

test("a partial undo can be finished: the follow-up with include_changed restores the rest, never a file restored before", () => {
  // A landing with one file corrected since is partly undone; the follow-up the receipt asks for (include_changed, on
  // the person's yes) then takes back the file they agreed to, and is not refused as "already undone".
  const p = project();
  try {
    const id = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/a.md", content: "A\n" }, { path: "docs/b.md", content: "B\n" }] });
    writeFileSync(join(p.repo, "docs", "b.md"), "B, corrected by hand\n");
    assert.deepEqual(undoLanding(p.session, p.repo, id), { restored: ["docs/a.md"], left_alone: ["docs/b.md"] });
    assert.notEqual(landings(p.session)[0].undone, true, "not undone as a whole while a file remains");
    // The person writes docs/a.md again after the first undo: the follow-up must not take it back a second time.
    writeFileSync(join(p.repo, "docs", "a.md"), "A, the person's own\n");
    assert.deepEqual(undoLanding(p.session, p.repo, id, { includeChanged: true }), { restored: ["docs/b.md"], left_alone: [] });
    assert.ok(!existsSync(join(p.repo, "docs", "b.md")), "the file they agreed to take back is gone");
    assert.equal(readFileSync(join(p.repo, "docs", "a.md"), "utf8"), "A, the person's own\n", "a file undone before is never touched again");
    assert.equal(landings(p.session)[0].undone, true, "every file undone: the landing is undone");
    assert.equal(undoLanding(p.session, p.repo, id).cause, "already-undone");
  } finally { p.cleanup(); }
});
