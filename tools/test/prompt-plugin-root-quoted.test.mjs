/**
 * A command in the plugin's instruction files that runs one of the plugin's scripts quotes the plugin path, so a
 * plugin installed under a folder whose name has a space still runs it. Offline: reads repo files and runs one
 * command against a stub script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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

test("every command in the commands, skills and agents quotes the plugin path", () => {
  const hits = [];
  for (const file of ["commands", "skills", "agents"].flatMap((d) => markdownFiles(join(PLUGIN, d)))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\b(?:node|bash|sh|python3?)\s+\$\{?CLAUDE_PLUGIN_ROOT/.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("discovery's refresh command runs from a plugin folder whose path has a space", () => {
  const md = readFileSync(join(PLUGIN, "agents", "discovery.md"), "utf8");
  const command = md.match(/^node .*discovery-refresh\.mjs.*$/m)?.[0];
  assert.ok(command, "discovery.md runs discovery-refresh.mjs");
  const root = join(mkdtempSync(join(tmpdir(), "mmo-quoted-")), "plugin root");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "discovery-refresh.mjs"), 'console.log("ran");\n');
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ran");
  } finally {
    rmSync(resolve(root, ".."), { recursive: true, force: true });
  }
});
