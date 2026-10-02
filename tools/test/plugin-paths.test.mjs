/**
 * Every file the plugin's own instructions (its commands, skills and agents) tell the model to open is named by
 * the installed plugin's path, `${CLAUDE_PLUGIN_ROOT}/...`, never by this repository's layout.
 *
 * Why: a path such as [plugin/skills/brownfield-guide/SKILL.md](/plugin/skills/brownfield-guide/SKILL.md) exists
 * only in a clone of this repository. On an installed plugin a model that follows it literally finds nothing, and
 * works without its manual. Claude Code fills `${CLAUDE_PLUGIN_ROOT}` in with the plugin's real folder inside
 * commands, skills and agents, so the path the model reads is the installed copy's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}
const INSTRUCTIONS = ["commands", "skills", "agents"].flatMap((d) => markdownFiles(join(PLUGIN, d)));

test("no command, skill or agent names a plugin file by this repository's layout", () => {
  const found = [];
  for (const file of INSTRUCTIONS) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\bplugin\/(?:skills|agents|config|commands|scripts|hooks|mcp)\//.test(line)) found.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      // A link relative to the instruction file's own folder resolves against the project the model works in.
      if (/\]\((?!https?:|#|\$\{CLAUDE_PLUGIN_ROOT\})[^)\s]+\.(?:md|json|mjs|yaml)\)/.test(line)) found.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], "every such path must start with ${CLAUDE_PLUGIN_ROOT}/");
});

test("every ${CLAUDE_PLUGIN_ROOT} path the instructions name exists in the plugin", () => {
  const missing = [];
  let named = 0;
  for (const file of INSTRUCTIONS) {
    for (const m of readFileSync(file, "utf8").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./*<>-]+)/g)) {
      named++;
      // A placeholder or a pattern (<name>.yaml, stacks/*.md) names its folder; the folder must exist.
      let rel = m[1].replace(/[.,;:]+$/, "");
      if (/[<*]/.test(rel)) rel = dirname(rel.split(/[<*]/)[0] + "x");
      if (!existsSync(join(PLUGIN, rel))) missing.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.ok(named >= 20, `the installed-path references were read (${named})`);
  assert.deepEqual(missing, []);
});

test("the brownfield manual, the pipeline skill and the policy folder are named by the installed path", () => {
  const bugfix = readFileSync(join(PLUGIN, "commands", "bugfix.md"), "utf8");
  assert.match(bugfix, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/brownfield-guide\/SKILL\.md/);
  const orchestrator = readFileSync(join(PLUGIN, "agents", "orchestrator.md"), "utf8");
  assert.match(orchestrator, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pipeline\/SKILL\.md/);
  const policy = readFileSync(join(PLUGIN, "commands", "policy.md"), "utf8");
  assert.match(policy, /\$\{CLAUDE_PLUGIN_ROOT\}\/config\/policies\//);
});
