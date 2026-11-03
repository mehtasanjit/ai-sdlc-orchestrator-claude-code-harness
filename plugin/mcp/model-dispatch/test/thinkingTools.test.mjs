/**
 * The Gemini thinking step's tools (plugin/scripts/thinking-tools.mjs). Pinned: every read goes through the engine's
 * read rule (credentials and links out of the project never reach the model), hand-ins write only their own fixed
 * paths and never through a link, a review is checked against the shape the repair stage reads, a role gets only its
 * own tools, and the step is done only when every piece it owes is accepted. Real temp folders; no model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { ThinkingTools } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs")).href);

function project() {
  const root = mkdtempSync(join(tmpdir(), "mmo-tools-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nconst token = 'x';\n");
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  return root;
}
const tools = (root, role, over = {}) => new ThinkingTools({ role, project_root: root, run_id: "r1", output_dir: ".sdlc/runs/r1", outputs: { requirements: ".sdlc/runs/r1/requirements.md", review: ".sdlc/runs/r1/review.json", security_review: ".sdlc/runs/r1/security_review.md", sections_dir: ".sdlc/runs/r1/change.sections" }, ...over });

test("credentials, paths outside the project and links out of it are never read", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "mmo-outside-"));
  writeFileSync(join(outside, "key"), "PRIVATE");
  symlinkSync(join(outside, "key"), join(root, "src", "link"));
  const t = tools(root, "requirements");
  assert.match((await t.call("read_file", { path: ".env" })).error, /off-limits/);
  assert.match((await t.call("read_file", { path: "../x" })).error, /outside the project/);
  assert.match((await t.call("read_file", { path: "src/link" })).error, /leads outside the project/);
  assert.match((await t.call("read_file", { path: "src/a.ts" })).result, /1\texport const a = 1;/);
});

test("search never reads the files the read rule keeps from models; a listing names them, marked, with nothing of theirs", async () => {
  const root = project();
  const t = tools(root, "requirements");
  const hits = (await t.call("search_files", { pattern: "SECRET|token" })).result;
  assert.match(hits, /src\/a\.ts:2/);
  assert.doesNotMatch(hits, /SECRET/);
  const listed = (await t.call("list_files", { path: "." })).result;
  assert.match(listed, /^\.env  \(kept from you by the read rule\)$/m);
  assert.doesNotMatch(listed, /hunter2/);
});

test("a role gets only its own tools", async () => {
  const root = project();
  const t = tools(root, "requirements");
  assert.match((await t.call("write_review", { content: "{}" })).error, /not a tool of the requirements step/);
  assert.match((await t.call("run_dependency_audit", { kind: "npm-audit" })).error, /not a tool/);
});

test("a hand-in writes its own fixed path, and never through a link", async () => {
  const root = project();
  const t = tools(root, "requirements");
  assert.match((await t.call("write_requirements", { content: "# Requirements\n" })).result, /wrote \.sdlc\/runs\/r1\/requirements\.md/);
  assert.equal(readFileSync(join(root, ".sdlc/runs/r1/requirements.md"), "utf8"), "# Requirements\n");
  const linked = project();
  symlinkSync(join(linked, "src"), join(linked, ".sdlc", "runs", "r2"));
  // The step's own folder is the link: its hand-in is refused, not written through it into src/.
  const t2 = tools(linked, "requirements", { run_id: "r2", output_dir: ".sdlc/runs/r2", outputs: { requirements: ".sdlc/runs/r2/requirements.md" } });
  assert.match((await t2.call("write_requirements", { content: "x" })).error, /is a link/);
  assert.equal(existsSync(join(linked, "src", "requirements.md")), false);
});

test("the senior review is checked against the findings shape the repair stage reads", async () => {
  const root = project();
  const t = tools(root, "brownfield-senior-reviewer");
  assert.match((await t.call("write_review", { content: "not json" })).error, /is JSON/);
  assert.match((await t.call("write_review", { content: '{"verdict":"ok"}' })).error, /findings array/);
  assert.match((await t.call("write_review", { content: '{"findings":[{"issue":"x"}]}' })).error, /findings\[0\] needs file and issue/);
  assert.match((await t.call("write_review", { content: '{"findings":[{"file":"src/a.ts","issue":"x","fix":"y"}]}' })).result, /wrote/);
});

test("the step is done only when every piece it owes is accepted", async () => {
  const root = project();
  const t = tools(root, "brownfield-architect");
  let s = JSON.parse((await t.call("status", {})).result);
  assert.equal(s.done, false);
  assert.deepEqual(s.missing, ["header.json, accepted", "at least one units file, accepted"]);
  assert.match((await t.call("write_section", { name: "notes.json", json: "{}" })).error, /name the section header\.json/);
  assert.match((await t.call("write_section", { name: "header.json", json: "{nope" })).error, /not valid JSON/);
  const r = tools(root, "requirements");
  await r.call("write_requirements", { content: "# R" });
  assert.equal(JSON.parse((await r.call("status", {})).result).done, true);
});

test("a dependency audit runs only its named commands", async () => {
  const root = project();
  const t = tools(root, "security-reviewer");
  assert.match((await t.call("run_dependency_audit", { kind: "rm -rf /" })).error, /kind is one of npm-audit, npm-outdated, pip-outdated/);
});
