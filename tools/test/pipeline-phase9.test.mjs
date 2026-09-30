/**
 * Phase 9 of the pipeline playbook asks the orchestrator for the run's written report, SUMMARY.md, exactly once:
 * after the manifest is written and before the collector runs, because the collector puts code's acceptance table
 * into that file (plugin/scripts/lib/acceptance-summary.mjs). Without the file the report has no acceptance table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const skill = readFileSync(join(ROOT, "plugin", "skills", "pipeline", "SKILL.md"), "utf8");
const phase9 = skill.slice(skill.indexOf("### Phase 9"), skill.indexOf("\n---", skill.indexOf("### Phase 9")));
const SUMMARY_REQUEST = /[Ww]rite (a brief )?`?<output_dir>\/SUMMARY\.md`?/g;

test("Phase 9 tells the orchestrator to write SUMMARY.md, after the manifest and before the collector", () => {
  assert.ok(phase9.startsWith("### Phase 9"), "Phase 9 was found");
  const manifest = phase9.indexOf("write-manifest.mjs");
  const summary = phase9.search(SUMMARY_REQUEST);
  const collector = phase9.indexOf("collect-orchestrator-usage.mjs");
  assert.ok(manifest >= 0 && collector > manifest, "the manifest step and the collector step are there");
  assert.ok(summary > manifest, "SUMMARY.md is asked for after the manifest is written");
  assert.ok(summary < collector, "and before the collector, which puts code's acceptance table into it");
  assert.match(phase9, /total cost/i);
  assert.match(phase9, /acceptance table/i, "it says the acceptance table is code's, put in by the collector");
});

test("Phase 9 asks for SUMMARY.md once", () => {
  assert.equal([...phase9.matchAll(SUMMARY_REQUEST)].length, 1, "one request, not two");
});

// Brownfield reads the same Phase 9, but only an executor run has a spec and acceptance.md, and the collector
// adds a table only when acceptance.md exists (lib/acceptance-summary.mjs). So the acceptance links and the
// hand-off of pass/fail statements to code hold in executor mode only; other runs link what exists.
test("SUMMARY.md's acceptance table and links are executor-mode only; other runs link what exists", () => {
  const start = phase9.search(SUMMARY_REQUEST);
  const summary = phase9.slice(start, phase9.indexOf("\n\n", start)).replace(/\s+/g, " ");
  const sentences = summary.split(/(?<=\.) (?=[A-Z])/);
  assert.doesNotMatch(sentences[0], /acceptance|spec\b/, "the request every run reads names no spec and no acceptance.md");
  const executor = sentences.filter((s) => /^In executor mode\b/.test(s)).join(" ");
  assert.match(executor, /`acceptance\.md`/, "executor mode links acceptance.md");
  assert.match(executor, /\bspec\b/, "executor mode links the spec");
  assert.match(executor, /do not write your own pass\/fail statements/);
  assert.match(executor, /the collector below puts code's acceptance table into SUMMARY\.md/);
  const other = sentences.filter((s) => /^In every other run\b/.test(s)).join(" ");
  assert.match(other, /link only the files that exist/);
  assert.match(other, /no `acceptance\.md`/);
  for (const s of sentences) {
    if (/acceptance\.md|pass\/fail|acceptance table/.test(s)) assert.match(s, /^In (executor mode|every other run)\b/, `unqualified: ${s}`);
  }
});

const flat9 = phase9.replace(/\s+/g, " ");

// write-manifest counts every file under a new app's code folder, but in brownfield the code folder is the
// project itself, so it counts only the files the run's record lists, and none when there is no record.
test("Phase 9 says which files the manifest counts: the product for a new app, the run's record in brownfield", () => {
  assert.match(flat9, /for a new app, the product's files under `<code_dir>`; in brownfield, the files the run's record lists \(`provenance\.json`, `written-files\.json`\), left out when there is no record/);
  assert.doesNotMatch(flat9, /gate answers and the product's file and line counts/);
  const script = readFileSync(join(ROOT, "plugin", "scripts", "write-manifest.mjs"), "utf8");
  assert.match(script, /written-files\.json/);
  assert.match(script, /provenance\.json/);
  assert.match(script, /file counts left out/);
});

// A rewrite after the dispatched total changed (a Gate 4 reject round) drops the collector's figures and says so
// on a note: line; a true total quoted then would be stale, so the collector runs again first.
test("Phase 9 sends the orchestrator back to the collector when write-manifest notes that its figures were left out", () => {
  assert.match(flat9, /If write-manifest prints a `note:` line saying the collector's figures are left out/);
  assert.match(flat9, /run the collector again \(the note prints its command\) before you quote a true total/);
  const script = readFileSync(join(ROOT, "plugin", "scripts", "write-manifest.mjs"), "utf8");
  assert.match(script, /console\.log\(`note: \$\{n\}`\)/);
  assert.match(script, /are left out until it runs again: node /);
});

test("Gate 4 shows a dash for Files when the manifest has no file counts", () => {
  const gate4 = skill.slice(skill.indexOf("### Gate 4"), skill.indexOf("\n---", skill.indexOf("### Gate 4")));
  assert.match(gate4, /Files: N/);
  assert.match(gate4.replace(/\s+/g, " "), /`Files` is the manifest's `artifacts\.files`; show `—` when the manifest has none/);
});
