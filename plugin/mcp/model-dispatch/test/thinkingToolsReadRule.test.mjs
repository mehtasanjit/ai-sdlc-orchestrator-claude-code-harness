/**
 * The read rule against every way a Gemini thinking step's tools could reach a file it refuses: git's own path
 * patterns, folders and an unscoped diff; credential files, a private key under any name, a hard link to a refused
 * file, and other spellings of a refused name on a disk that opens them as that file. Each case was a leak found in
 * review; each test failed before its fix. Real temp folders and real git; no model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { ThinkingTools } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs")).href);

const SECRET = "NEW-SECRET-VALUE";
const text = (r) => r.result ?? r.error;

/** A git project with a refused file and two source files changed since the run's starting commit (one deleted). */
function changedProject() {
  const root = mkdtempSync(join(tmpdir(), "mmo-readrule-"));
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  writeFileSync(join(root, ".mcp.json"), '{"env":{"TOKEN":"old"}}\n');
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "gone.js"), "export const g = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(root, ".mcp.json"), `{"env":{"TOKEN":"${SECRET}"}}\n`);
  writeFileSync(join(root, "src", "a.js"), "export const a = 2;\n");
  rmSync(join(root, "src", "gone.js"));
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  return { root, head };
}
const provenance = (root, head, touched) =>
  writeFileSync(join(root, ".sdlc", "runs", "r1", "provenance.json"), JSON.stringify({ git_head_before: head, files_touched: touched }));
const reviewer = (root) =>
  new ThinkingTools({ role: "brownfield-senior-reviewer", project_root: root, run_id: "r1", output_dir: ".sdlc/runs/r1", outputs: { review: ".sdlc/runs/r1/review.json" } });

test("git_diff gives git only files the read rule allows: no pattern, no refused file, no unscoped diff", async () => {
  const { root, head } = changedProject();
  provenance(root, head, ["src/a.js", "src/gone.js", ".mcp.json"]);
  const t = reviewer(root);
  // A pattern git would expand, and a refused file: refused, and the secret never shows.
  for (const path of ["*", ":(glob)**", ".mcp.json"]) {
    const r = await t.call("git_diff", { path });
    assert.ok(r.error, `git_diff "${path}" should be refused: ${text(r)}`);
    assert.doesNotMatch(text(r), new RegExp(SECRET));
  }
  // A folder is its changed files that the rule allows; the project root the same.
  for (const path of [".", "src"]) {
    const shown = text(await t.call("git_diff", { path }));
    assert.match(shown, /\+export const a = 2;/, `git_diff "${path}"`);
    assert.doesNotMatch(shown, new RegExp(SECRET), `git_diff "${path}"`);
  }
  // One allowed file, and one the run deleted.
  assert.match((await t.call("git_diff", { path: "src/a.js" })).result, /\+export const a = 2;/);
  assert.match((await t.call("git_diff", { path: "src/gone.js" })).result, /-export const g = 1;/);
  // The whole change: every touched file the rule allows, never the refused one.
  const all = (await t.call("git_diff", {})).result;
  assert.match(all, /a = 2/);
  assert.doesNotMatch(all, new RegExp(SECRET));
  // When no touched file may be shown, nothing is: never the unscoped diff of the whole project.
  provenance(root, head, [".mcp.json"]);
  const none = text(await reviewer(root).call("git_diff", {}));
  assert.doesNotMatch(none, new RegExp(SECRET));
  assert.doesNotMatch(none, /a = 2/);
});

/** A project holding credentials in the places they really live, and other names for a refused file. */
function credentialProject() {
  const root = mkdtempSync(join(tmpdir(), "mmo-creds-"));
  const put = (rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
  put(".env", `STRIPE_KEY=${SECRET}\n`);
  put(".mcp.json", `{"env":{"TOKEN":"${SECRET}"}}\n`);
  put(".claude/settings.json", `{"env":{"ANTHROPIC_API_KEY":"${SECRET}"}}\n`);
  put(".npmrc", `//registry.npmjs.org/:_authToken=${SECRET}\n`);
  put("deploy/server.pem", `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`);
  put(".aws/credentials", `[default]\naws_secret_access_key = ${SECRET}\n`);
  put("keys/gcp-service-account.json", `{"type":"service_account","private_key":"${SECRET}"}\n`);
  put("notes/ops.txt", `-----BEGIN RSA PRIVATE KEY-----\n${SECRET}\n-----END RSA PRIVATE KEY-----\n`);
  put("src/a.js", "export const a = 1;\n");
  linkSync(join(root, ".env"), join(root, "notes.txt"));
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  return root;
}
const architect = (root) =>
  new ThinkingTools({ role: "brownfield-architect", project_root: root, run_id: "r1", output_dir: ".sdlc/runs/r1", outputs: { sections_dir: ".sdlc/runs/r1/sections" } });

test("credential files, a private key under any name and a hard link to a refused file are never read or searched", async () => {
  const root = credentialProject();
  const t = architect(root);
  for (const path of [".env", ".mcp.json", ".claude/settings.json", ".npmrc", "deploy/server.pem", ".aws/credentials", "keys/gcp-service-account.json", "notes/ops.txt", "notes.txt"]) {
    const r = await t.call("read_file", { path });
    assert.ok(r.error, `read_file "${path}" should be refused: ${text(r)}`);
    assert.doesNotMatch(text(r), new RegExp(SECRET));
  }
  assert.match((await t.call("read_file", { path: "src/a.js" })).result, /export const a = 1;/);
  const found = text(await t.call("search_files", { pattern: SECRET }));
  assert.doesNotMatch(found, new RegExp(SECRET), `search_files found a secret: ${found}`);
});

// macOS's disk opens another spelling of a name as the same file; Linux's does not, so there it is another file.
test("another spelling of a refused file's name is refused on a disk that opens it as that file", { skip: process.platform !== "darwin" && "this disk keeps other spellings apart" }, async () => {
  const root = credentialProject();
  const t = architect(root);
  for (const path of [".MCP.JSON", ".mcp.jſon", ".claude/ſettings.json", ".ENV"]) {
    const r = await t.call("read_file", { path });
    assert.ok(r.error, `read_file "${path}" should be refused: ${text(r)}`);
    assert.doesNotMatch(text(r), new RegExp(SECRET));
  }
});
