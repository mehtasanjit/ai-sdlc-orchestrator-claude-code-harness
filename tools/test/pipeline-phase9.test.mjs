/**
 * Phase 9 of the pipeline playbook: the run's report, SUMMARY.md, is code's. Both orchestrators run as Claude Code
 * helpers (subagents), and Claude Code refuses a helper's Write of a report file (SUMMARY*.md), so asking the
 * orchestrator to write it paid for a refused call and then for the same report again, every run. write-manifest.mjs
 * renders it from the run's records and the collector rewrites it with the true total and code's acceptance table
 * (plugin/scripts/lib/acceptance-summary.mjs); the orchestrator's own account goes in its final message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const skill = readFileSync(join(ROOT, "plugin", "skills", "pipeline", "SKILL.md"), "utf8");
const phase9 = skill.slice(skill.indexOf("### Phase 9"), skill.indexOf("\n---", skill.indexOf("### Phase 9")));
/** A request to the orchestrator to write the report file itself. */
const SUMMARY_REQUEST = /[Ww]rite (a brief )?`?<output_dir>\/SUMMARY\.md`?/g;

test("Phase 9 never asks the orchestrator to write SUMMARY.md: code writes it, and the orchestrator reports in its final message", () => {
  assert.ok(phase9.startsWith("### Phase 9"), "Phase 9 was found");
  const f = phase9.replace(/\s+/g, " ");
  assert.equal([...phase9.matchAll(SUMMARY_REQUEST)].length, 0, "no request to write the report file");
  assert.match(f, /SUMMARY\.md is code's: do not write it yourself/);
  assert.match(f, /Claude Code refuses a helper's Write of a report file/, "the reason is said");
  assert.match(f, /`write-manifest\.mjs` writes `<output_dir>\/SUMMARY\.md` beside the manifest/);
  assert.match(f, /the collector rewrites it with the true total/);
  assert.match(f, /your final message/i, "the orchestrator's account goes in its final message");
  assert.doesNotMatch(f, /quote the \*\*true total\*\* in SUMMARY\.md|label every cost in SUMMARY\.md|in your final message and in SUMMARY\.md/, "nothing asks the orchestrator to edit the file either");
  const manifest = phase9.indexOf("write-manifest.mjs");
  const collector = phase9.indexOf("collect-orchestrator-usage.mjs");
  assert.ok(manifest >= 0 && collector > manifest, "the manifest step and the collector step are there, in that order");
});

// Only an executor run has a spec and acceptance.md, and the collector adds a table only when acceptance.md exists
// (lib/acceptance-summary.mjs). In executor mode the orchestrator makes no pass/fail statements of its own about the
// acceptance criteria: the verdict is code's.
test("executor mode's final message links code's acceptance table and makes no pass/fail statements of its own", () => {
  const exec = skill.slice(skill.indexOf("## Executor mode"), skill.indexOf("## Phase -1"));
  const bullet = exec.slice(exec.indexOf("- **Final report:**")).replace(/\s+/g, " ");
  assert.match(bullet, /the collector copies it into SUMMARY\.md/);
  assert.match(bullet, /In your final message, link it and do not write your own pass\/fail statements/);
  assert.doesNotMatch(bullet, /In SUMMARY\.md, link it/);
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

// The orchestrator's own rules say the same: the report file is written by code, and what it prints goes in its
// final message.
test("the orchestrator's rules leave SUMMARY.md to code and print the collector command in the final message", () => {
  const orch = readFileSync(join(ROOT, "plugin", "agents", "orchestrator.md"), "utf8").replace(/\s+/g, " ");
  assert.match(orch, /At Phase 9 the manifest and SUMMARY\.md are written by `scripts\/write-manifest\.mjs`, never by hand/);
  assert.match(orch, /In your final message, print the command above/);
  assert.doesNotMatch(orch, /in the final report, print the command/);
});

// Pre-flight's typist probe writes telemetry events (phase "preflight") before the run's own work. They count as
// spend but never set the run's start: buildManifest takes started_at from the first event after pre-flight, and the
// collector anchors the same way. The text says what started_at is.
test("Phase 9 says started_at is the first dispatched event after pre-flight, whose probe calls never open the window", () => {
  assert.match(flat9, /the first dispatched event after pre-flight \(its typist probe calls count as spend but never open the window\)/);
  assert.doesNotMatch(flat9, /is only the first dispatched event, after the driver's own setup work/);
  const telemetry = readFileSync(join(ROOT, "plugin", "mcp", "model-dispatch", "src", "telemetry.ts"), "utf8");
  assert.match(telemetry, /PREFLIGHT_PHASE = "preflight"/);
});

// The Phase 9 text tells both orchestrators never to write SUMMARY.md because write-manifest.mjs writes it. That holds
// only while the script does: without it, no run gets a SUMMARY.md, and the collector's acceptance table, which
// needs the file to exist (lib/acceptance-summary.mjs), is never added. This ties the text to the code.
test("the SUMMARY.md Phase 9 leaves to code is written by write-manifest.mjs", { skip: !existsSync(join(ROOT, "plugin", "mcp", "model-dispatch", "bundle", "lib.mjs")) && "server bundle not built" }, async () => {
  assert.match(flat9, /`write-manifest\.mjs` writes `<output_dir>\/SUMMARY\.md` beside the manifest/, "the premise");
  const { writeManifest } = await import("../../plugin/scripts/write-manifest.mjs");
  const root = mkdtempSync(join(tmpdir(), "mmo-phase9-summary-"));
  try {
    const out = join(root, ".sdlc", "runs", "r1");
    mkdirSync(out, { recursive: true });
    const event = { ts: "2026-09-29T08:10:00.000Z", pass: "r1", phase: "codegen", task_type: "codegen", task_id: "U01", module: "spec", model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor", input_tokens: 100, input_tokens_cached: 0, output_tokens: 50, cost_usd: 0.5, latency_ms: 1, success: true };
    writeFileSync(join(out, "telemetry.jsonl"), JSON.stringify(event) + "\n");
    await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root });
    assert.ok(existsSync(join(out, "manifest.json")), "the manifest is written");
    assert.ok(existsSync(join(out, "SUMMARY.md")), "write-manifest.mjs writes SUMMARY.md beside the manifest, as Phase 9 says");
    assert.ok(readFileSync(join(out, "SUMMARY.md"), "utf8").trim().length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
