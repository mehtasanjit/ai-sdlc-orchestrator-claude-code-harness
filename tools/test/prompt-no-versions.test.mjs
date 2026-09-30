/**
 * The plugin's instruction files (its commands, skills and agents) name no plugin release and no calendar date.
 * They tell the model what to do; which release changed a step, and when, is history the model cannot act on and
 * that goes stale. It belongs in docs/methodology.md and in the commit history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// A plugin release: three numbers starting 0, optionally with a "v" (the plugin has only had 0.x.y releases).
const RELEASE = /\bv?0\.\d+\.\d+\b/g;
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*";
const DATE = new RegExp(`\\b\\d{1,2} ${MONTH}\\b|\\b${MONTH} \\d{1,2}\\b|\\b20\\d\\d-\\d\\d-\\d\\d\\b`, "g");

function findings(pattern) {
  const hits = [];
  for (const file of ["commands", "skills", "agents"].flatMap((d) => markdownFiles(join(PLUGIN, d)))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push(`${relative(ROOT, file)}:${line}: …${text.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\s+/g, " ")}…`);
    }
  }
  return hits;
}

test("the commands, skills and agents name no plugin release", () => {
  assert.deepEqual(findings(RELEASE), [], "these instruction files name a plugin release");
});

test("the commands, skills and agents carry no calendar date", () => {
  assert.deepEqual(findings(DATE), [], "these instruction files carry a date");
});

test("the patterns catch releases and dates and leave other numbers alone", () => {
  assert.equal("run by code (0.7.9)".match(RELEASE)?.length, 1);
  assert.equal("since v0.7.10".match(RELEASE)?.length, 1);
  assert.equal('"cost_usd": 0.00234, Phase 0.5, Node 20.11.1'.match(RELEASE), null);
  assert.equal("(since 24 Sep 2026)".match(DATE)?.length, 1);
  assert.equal("checked on 2026-09-29".match(DATE)?.length, 1);
  assert.equal("Sep 29".match(DATE)?.length, 1);
  assert.equal("a 2-week sprint, 30 days, step 7".match(DATE), null);
});
