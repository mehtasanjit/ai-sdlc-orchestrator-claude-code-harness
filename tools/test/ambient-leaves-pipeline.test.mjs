/**
 * Zero-touch (ambient mode) changes nothing mmo does without it. Its router
 * starts a recognised task's /mmo: command through the model, so no command or
 * skill is typed-only (`disable-model-invocation`) and no agent's description
 * says it runs only inside a typed /mmo: command; with zero-touch on, its hooks
 * decide which /mmo: command the model may start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
  assert.ok(m, `${file} must open with a frontmatter block`);
  return m[1];
}

test("commands and skills carry no zero-touch switch: the model can start them exactly as mmo does without zero-touch", () => {
  const dir = join(ROOT, "plugin", "commands");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 13, "a new command must be added to this count on purpose");
  for (const f of files) assert.doesNotMatch(frontmatter(join(dir, f)), /disable-model-invocation/, f);
  const skills = join(ROOT, "plugin", "skills");
  for (const name of readdirSync(skills)) assert.doesNotMatch(frontmatter(join(skills, name, "SKILL.md")), /disable-model-invocation/, `skill ${name}`);
  const refactor = readFileSync(join(dir, "refactor.md"), "utf8");
  // By the installed plugin's own path (tools/test/plugin-paths.test.mjs): a repository path exists only in a clone.
  assert.match(refactor, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/brownfield-guide\/SKILL\.md/, "commands keep reaching the guide by file path");
});

test("agent descriptions carry no zero-touch sentence", () => {
  const dir = join(ROOT, "plugin", "agents");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    assert.doesNotMatch(frontmatter(join(dir, f)), /Runs only inside a typed|never start it from ordinary chat/, f);
  }
});
