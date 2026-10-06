/**
 * SUMMARY.md is code's (plugin/scripts/lib/run-summary.mjs). Both orchestrators run as Claude Code helpers, and
 * Claude Code refuses a helper's Write of a report file (SUMMARY*.md), so a run whose orchestrator was asked to write
 * it paid for a refused call and then for the report again, and some runs ended with no SUMMARY.md at all.
 * write-manifest.mjs renders it from the manifest it has just written and the run's own files; the collector renders
 * it again once it has patched the manifest with the true total. What it holds:
 *   - the run id, policy and status;
 *   - the dispatched total, cost by phase and by model from the manifest's rollups, and, once the collector has run,
 *     the orchestrator's overhead and the true total; until then every cost says it is dispatched work only;
 *   - the collector command with the run's folder and project root written out, under "Provisional — re-run after
 *     closing this session";
 *   - links to the run's files that exist;
 *   - in brownfield, the checks set aside per file (the latest batch receipt of each packet);
 *   - the acceptance table code wrote, kept across every re-render.
 * $0, offline; needs the server's bundle (npm run build --prefix plugin/mcp/model-dispatch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..", "plugin", "scripts");
const WRITE_MANIFEST = join(SCRIPTS, "write-manifest.mjs");
const COLLECTOR = join(SCRIPTS, "collect-orchestrator-usage.mjs");
const HAS_BUNDLE = existsSync(resolve(HERE, "..", "..", "plugin", "mcp", "model-dispatch", "bundle", "lib.mjs"));
const skip = !HAS_BUNDLE && "server bundle not built";

const AT = (hms) => `2026-10-05T${hms}.000Z`;
const ev = (over) => JSON.stringify({ ts: AT("10:10:00"), pass: "r-sum", phase: "codegen", task_type: "codegen", task_id: "tp_codegen_U01", module: "app", model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor", input_tokens: 100, input_tokens_cached: 0, output_tokens: 50, cost_usd: 0.5, latency_ms: 1, success: true, ...over });

/** A brownfield run folder: <root>/.sdlc/runs/r-sum, holding its telemetry, log, records and batch receipts. */
function brownfieldRun() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "run-summary-")));
  const out = join(root, ".sdlc", "runs", "r-sum");
  mkdirSync(join(out, "batches"), { recursive: true });
  writeFileSync(join(out, "telemetry.jsonl"), [
    ev({}),
    ev({ ts: AT("10:12:00"), phase: "tests", task_id: "tp_tests_U02", cost_usd: 0.25 }),
    ev({ ts: AT("10:05:00"), phase: "architecture_design", task_id: "tp_arch_001", model: "claude-opus-5", provenance: "estimated", cost_usd: 1.0199 }),
  ].join("\n") + "\n");
  writeFileSync(join(out, "orchestrator.log"), [
    `MMO: ${AT("10:00:00")} INFO   run.start run_id=r-sum mode=brownfield`,
    `MMO: ${AT("10:30:00")} INFO   run.end run_id=r-sum outcome=completed`,
  ].join("\n") + "\n");
  for (const f of ["requirements.md", "change_plan.md", "review-dashboard.json", "security_review.md", "provenance.json"]) writeFileSync(join(out, f), f === "provenance.json" ? "{}" : `# ${f}\n`);
  // Two receipts for tp_codegen_U01: the later one wins. A third, later, blocked it (no outcome) and says nothing.
  const item = (id, path, setAside) => ({ id, status: "applied", artifact_path: path, cost_usd: 0.01, attempts: 1, outcome: { status: "applied", ...(setAside ? { set_aside: setAside } : {}) } });
  writeFileSync(join(out, "batches", "2026-10-05T10-10-00-000Z.json"), JSON.stringify({ items: [
    item("tp_codegen_U01", "src/date.ts", [{ id: "old-check", run: "npm run lint:old" }]),
    item("tp_tests_U02", "test/date.test.ts", [{ run: "npx tsc --noEmit" }]),
  ] }));
  writeFileSync(join(out, "batches", "2026-10-05T10-20-00-000Z.json"), JSON.stringify({ items: [item("tp_codegen_U01", "src/date.ts", [{ id: "types", run: "npx tsc --noEmit", output: "error TS2304" }])] }));
  writeFileSync(join(out, "batches", "2026-10-05T10-25-00-000Z.json"), JSON.stringify({ items: [{ id: "tp_codegen_U01", status: "blocked", artifact_path: "src/date.ts" }] }));
  return { root, out };
}

const writeManifest = (out, root, ...extra) =>
  spawnSync(process.execPath, [WRITE_MANIFEST, out, "--pass", "r-sum", "--policy", "opus-plus-flash", "--project-root", root, ...extra], { encoding: "utf8" });

test("write-manifest writes SUMMARY.md: run, policy and status; dispatched costs by phase and model, each labelled; the collector command; the run's files; the checks set aside", { skip }, () => {
  const { root, out } = brownfieldRun();
  try {
    const r = writeManifest(out, root);
    assert.equal(r.status, 0, r.stderr);
    const s = readFileSync(join(out, "SUMMARY.md"), "utf8");
    assert.match(s, /^# Run r-sum — policy opus-plus-flash\n/);
    assert.match(s, /Status: \*\*provisional\*\*/);
    // No collector figures yet: every cost says what it leaves out.
    assert.match(s, /\| Dispatched work \(dispatched work only — excludes orchestrator overhead\) \| \$1\.7699 \|/);
    assert.match(s, /### By phase — dispatched work only — excludes orchestrator overhead/);
    assert.match(s, /\| codegen \| 1 \| gemini-3\.8-flash \| \$0\.5000 \|/);
    assert.match(s, /\| architecture_design \| 1 \| claude-opus-5 \| \$1\.0199 \|/);
    assert.match(s, /### By model — dispatched work only — excludes orchestrator overhead/);
    assert.match(s, /\| gemini-3\.8-flash \| 2 \| \$0\.7500 \|/);
    assert.doesNotMatch(s, /True total/);
    // The collector command, written out for this run.
    assert.match(s, /## Provisional — re-run after closing this session/);
    assert.ok(s.includes(`node "${COLLECTOR}" "${out}" --project-root "${root}"`), s);
    // Links to the files that exist, relative to the run folder; none to a file that does not.
    for (const f of ["requirements.md", "change_plan.md", "review-dashboard.json", "security_review.md", "manifest.json", "provenance.json"]) assert.ok(s.includes(`[${f}](${f})`), f);
    for (const f of ["design.md", "spec.json", "acceptance.md"]) assert.ok(!s.includes(`(${f})`), f);
    // The checks set aside, per file, from each packet's latest receipt that applied it.
    assert.match(s, /## Checks set aside/);
    assert.match(s, /- `src\/date\.ts`: `types` \(`npx tsc --noEmit`\)/);
    assert.doesNotMatch(s, /old-check/, "an earlier receipt of the same packet is superseded");
    assert.match(s, /- `test\/date\.test\.ts`: `npx tsc --noEmit`/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a greenfield run with no batch receipts has no set-aside section; its spec and acceptance table are linked, and the acceptance table is in SUMMARY.md", { skip }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "run-summary-gf-")));
  const out = join(root, ".sdlc");
  try {
    mkdirSync(join(out, "runs", "r-sum"), { recursive: true });
    writeFileSync(join(out, "telemetry.jsonl"), ev({}) + "\n");
    for (const f of ["requirements.md", "design.md", "spec.json"]) writeFileSync(join(out, f), "x\n");
    writeFileSync(join(out, "acceptance.md"), "| Criterion | Verdict |\n|---|---|\n| AC-1 | pass |\n");
    const r = writeManifest(out, root);
    assert.equal(r.status, 0, r.stderr);
    const s = readFileSync(join(out, "SUMMARY.md"), "utf8");
    for (const f of ["requirements.md", "design.md", "spec.json", "acceptance.md", "manifest.json"]) assert.ok(s.includes(`[${f}](${f})`), f);
    assert.doesNotMatch(s, /Checks set aside/);
    assert.match(s, /<!-- acceptance:start -->\n\| Criterion \| Verdict \|\n\|---\|---\|\n\| AC-1 \| pass \|\n<!-- acceptance:end -->/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a re-render keeps the acceptance block, and a rewrite that keeps the collector's figures shows the overhead and the true total", { skip }, () => {
  const { root, out } = brownfieldRun();
  try {
    assert.equal(writeManifest(out, root).status, 0);
    const path = join(out, "SUMMARY.md");
    // The acceptance block as the collector wrote it, and the collector's figures on the manifest.
    writeFileSync(path, readFileSync(path, "utf8") + "\n<!-- acceptance:start -->\n| AC-1 | pass |\n<!-- acceptance:end -->\n");
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    m.orchestrator_overhead = { cost_usd: 12.5, dispatched_in_session_cost_usd: 1.0199, cost_source: "transcript (no receipt; unverified)", per_model: [{ model: "claude-opus-5", role: "session", messages: 40, cost_usd: 8 }, { model: "claude-opus-5", role: "helper", messages: 20, cost_usd: 4.5 }] };
    m.true_total_cost_usd = 13.25; // 1.7699 − 1.0199 + 12.5
    writeFileSync(join(out, "manifest.json"), JSON.stringify(m));
    const r = writeManifest(out, root, "--status", "accepted");
    assert.equal(r.status, 0, r.stderr);
    const s = readFileSync(path, "utf8");
    assert.match(s, /Status: \*\*accepted\*\*/);
    assert.match(s, /<!-- acceptance:start -->\n\| AC-1 \| pass \|\n<!-- acceptance:end -->/, "the acceptance block survives the re-render");
    assert.equal(s.split("<!-- acceptance:start -->").length, 2, "once");
    assert.match(s, /\| Orchestrator overhead \(this session's own loop, priced from its transcripts\) \| \$12\.5000 \|/);
    assert.match(s, /\| In-session work already inside the overhead, counted once \| −\$1\.0199 \|/);
    assert.match(s, /\| \*\*True total\*\* \| \*\*\$13\.2500\*\* \|/);
    assert.match(s, /How the overhead was measured: transcript \(no receipt; unverified\)/);
    assert.doesNotMatch(s, /dispatched work only — excludes orchestrator overhead/);
    assert.match(s, /### Orchestrator overhead by model/);
    assert.match(s, /\| claude-opus-5 \| helper \| 20 \| \$4\.5000 \|/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SUMMARY.md never stops the manifest: a run folder SUMMARY.md cannot be written to still gets its manifest, and says why", { skip }, () => {
  const { root, out } = brownfieldRun();
  try {
    mkdirSync(join(out, "SUMMARY.md")); // a folder in the file's place
    const r = writeManifest(out, root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(out, "manifest.json")));
    assert.match(r.stdout, /note: SUMMARY\.md was not written: /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
