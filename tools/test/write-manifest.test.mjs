/**
 * write-manifest.mjs: manifest.json is written by code from the run's records — the telemetry
 * log through the server's own buildManifest (the shape the collector reads), the run log's gate answers,
 * the product's file and line counts — never typed by the orchestrator. A generated code folder is
 * counted on disk (links never followed, unreadable entries skipped); a code folder that is the project
 * itself is counted from the run's record, or left out. The collector's own fields on an existing
 * manifest survive a rewrite while the dispatched total they were computed from is unchanged, and
 * --status finalises it at Gate 4. $0, offline; needs the server's dist (npm run build --prefix
 * plugin/mcp/model-dispatch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, chmodSync, copyFileSync, cpSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { writeManifest, gatesFromLog, countProduct } from "../../plugin/scripts/write-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "..", "plugin", "scripts", "write-manifest.mjs");
const DIST = resolve(HERE, "..", "..", "plugin", "mcp", "model-dispatch", "dist", "telemetry.js");
const AT = (hms) => `2026-09-29T${hms}.000Z`;
const ev = (over) => JSON.stringify({ ts: AT("08:10:00"), pass: "r1", phase: "codegen", task_type: "codegen", task_id: "U01", module: "spec", model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor", input_tokens: 100, input_tokens_cached: 0, output_tokens: 50, cost_usd: 0.5, latency_ms: 1, success: true, ...over });

function run() {
  const root = mkdtempSync(join(tmpdir(), "wm-"));
  const out = join(root, ".sdlc"), code = join(root, "src");
  mkdirSync(join(out, "runs", "r1"), { recursive: true });
  mkdirSync(join(code, "app", "node_modules", "x"), { recursive: true });
  writeFileSync(join(code, "app", "main.py"), "a\nb\nc\n");
  writeFileSync(join(code, "app", "node_modules", "x", "index.js"), "installed\n");
  writeFileSync(join(out, "telemetry.jsonl"), [ev({}), ev({ task_id: "U02", ts: AT("08:20:00"), cost_usd: 0.25 }), ev({ tier: "orchestrator", model: "claude-opus-5", cost_usd: 9, ts: AT("09:00:00") })].join("\n") + "\n");
  writeFileSync(join(out, "runs", "r1", "orchestrator.log"), [
    `MMO: ${AT("08:00:00")} INFO   run.start run_id=r1 mode=greenfield`,
    `MMO: ${AT("08:05:00")} INFO   gate.open run_id=r1 gate=gate-1 title="Requirements"`,
    `MMO: ${AT("08:06:00")} INFO   gate.resolved run_id=r1 gate=gate-1 response=approved`,
    `MMO: ${AT("09:00:00")} INFO   run.end run_id=r1 outcome=completed`,
  ].join("\n") + "\n");
  return { root, out, code };
}

test("the manifest is built from telemetry.jsonl with buildManifest: the collector's fields (pass, policy_name, total_cost_usd as dispatched work) and never the orchestrator event", { skip: !existsSync(DIST) && "server dist not built" }, async () => {
  const { root, out, code } = run();
  const r = await writeManifest({ outDir: out, pass: "r1", policy: "opus-plus-flash-v38", projectRoot: root, codeDir: code });
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(m.pass, "r1");
  assert.equal(m.run_id, "r1");
  assert.equal(m.policy_name, "opus-plus-flash-v38");
  assert.equal(m.total_cost_usd, 0.75, "dispatched work only: the tier: orchestrator event is partitioned out");
  assert.equal(r.dispatched, 0.75);
  assert.deepEqual(m.gates, [{ gate: "gate-1", response: "approved", at: AT("08:06:00") }]);
  assert.equal(m.status, "provisional");
  assert.deepEqual(m.artifacts, { files: 1, loc: 4 }, "the product's files counted on disk, installed packages left out; no test figures it did not measure");
  assert.equal(m.written_by, "plugin/scripts/write-manifest.mjs");
  assert.ok(m.model_breakdown["gemini-3.8-flash"]);
});

test("a rewrite keeps the collector's fields and --status finalises the run", { skip: !existsSync(DIST) && "server dist not built" }, async () => {
  const { root, out } = run();
  await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root });
  const path = join(out, "manifest.json");
  const patched = { ...JSON.parse(readFileSync(path, "utf8")), orchestrator_overhead: { cost_usd: 9, provenance: "transcript" }, true_total_cost_usd: 9.75 };
  writeFileSync(path, JSON.stringify(patched));
  const r = await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root, status: "accepted" });
  const m = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(m.status, "accepted");
  assert.equal(r.status, "accepted");
  assert.deepEqual(m.orchestrator_overhead, { cost_usd: 9, provenance: "transcript" }, "the collector's figure survives");
  assert.equal(m.true_total_cost_usd, 9.75);
});

test("the command line: usage is refused without --pass and --policy; a run prints the dispatched total", { skip: !existsSync(DIST) && "server dist not built" }, () => {
  const { root, out } = run();
  const bad = spawnSync(process.execPath, [SCRIPT, out], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: write-manifest\.mjs/);
  const ok = spawnSync(process.execPath, [SCRIPT, out, "--pass", "r1", "--policy", "p", "--project-root", root], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /manifest written: .*manifest\.json — dispatched \$0\.75 over 3 event\(s\), 1 gate answer\(s\) recorded, status provisional/);
});

test("gatesFromLog reads every gate.resolved line; countProduct skips installed packages and build output", () => {
  const { root, out, code } = run();
  assert.deepEqual(gatesFromLog(join(out, "runs", "r1", "orchestrator.log")).map((g) => g.response), ["approved"]);
  assert.deepEqual(gatesFromLog(join(root, "none.log")), []);
  assert.deepEqual(countProduct(code), { files: 1, loc: 4 });
});

const HAS_DIST = !existsSync(DIST) && "server dist not built";
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
/** What the awkward tree counts: its one source file, plus pgdata/PG_VERSION where chmod cannot hide it (root). */
const AWKWARD = asRoot ? { files: 2, loc: 6 } : { files: 1, loc: 4 };

/** A code folder holding what ordinary repositories hold: a dangling link, a folder nobody can read, a link to a parent, a link to a folder outside. */
function awkwardTree() {
  const root = mkdtempSync(join(tmpdir(), "wm-odd-tree-"));
  const out = join(root, ".sdlc"), code = join(root, "src");
  mkdirSync(join(out, "runs", "r1"), { recursive: true });
  writeFileSync(join(out, "telemetry.jsonl"), ev({}) + "\n");
  mkdirSync(join(code, "app"), { recursive: true });
  writeFileSync(join(code, "app", "main.py"), "a\nb\nc\n");
  symlinkSync(join(root, "does-not-exist"), join(code, "app", "dangling"));
  symlinkSync("..", join(code, "app", "up"));
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, "big.txt"), "x\n".repeat(50));
  symlinkSync(outside, join(code, "linked"));
  mkdirSync(join(code, "pgdata"));
  writeFileSync(join(code, "pgdata", "PG_VERSION"), "16\n");
  chmodSync(join(code, "pgdata"), 0o000);
  return { root, out, code, restore: () => chmodSync(join(code, "pgdata"), 0o755) };
}

test("countProduct never throws: symlinks are not followed, an unreadable folder is skipped and reported, a link to a parent never loops", () => {
  const t = awkwardTree();
  try {
    const skipped = [];
    const r = countProduct(t.code, { onSkip: (path, why) => skipped.push({ path, why }) });
    assert.deepEqual(r, AWKWARD, "only the one regular file; links and the unreadable folder add nothing");
    if (!asRoot) assert.ok(skipped.some((s) => s.path.endsWith("pgdata")), `the unreadable folder is reported: ${JSON.stringify(skipped)}`);
  } finally { t.restore(); }
});

test("a code folder with a dangling link, an unreadable folder and a loop still gets its manifest, from the command line too", { skip: HAS_DIST }, async () => {
  const t = awkwardTree();
  try {
    const r = await writeManifest({ outDir: t.out, pass: "r1", policy: "p", projectRoot: t.root, codeDir: t.code });
    const m = JSON.parse(readFileSync(r.manifestPath, "utf8"));
    assert.equal(m.total_cost_usd, 0.5);
    assert.deepEqual(m.artifacts, AWKWARD);
    const cli = spawnSync(process.execPath, [SCRIPT, t.out, "--pass", "r1", "--policy", "p", "--project-root", t.root, "--code-dir", t.code], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /manifest written: /);
  } finally { t.restore(); }
});

/** A repository with 30 source files, a lockfile, tool settings and a run record, where the run touched one file and created one. */
function brownfield({ git = true, provenance = true, written } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "wm-bf-"));
  if (git) { mkdirSync(join(repo, ".git")); writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n"); }
  mkdirSync(join(repo, "src"));
  for (let i = 1; i <= 30; i++) writeFileSync(join(repo, "src", `f${i}.ts`), "x\n".repeat(i));
  writeFileSync(join(repo, "src", "new.ts"), "a\nb\nc");
  writeFileSync(join(repo, "package-lock.json"), "{\n}\n".repeat(2000));
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.json"), "{}\n");
  const out = join(repo, ".sdlc", "runs", "r1");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "telemetry.jsonl"), ev({}) + "\n");
  writeFileSync(join(out, "requirements.md"), "# r\n");
  if (provenance) {
    const touched = (path, existed) => ({ path, existed_before: existed, sha_before: null, sha_after: "sha256:x", tracked_in_git: existed, backup_path: null, packet_id: "tp_1", written_at: AT("08:30:00") });
    writeFileSync(join(out, "provenance.json"), JSON.stringify({ schema_version: 1, run_id: "r1", intent: "bugfix", git_head_before: null, git_head_after: null, commits: [],
      files_touched: [touched("src/f1.ts", true), touched("src/f1.ts", true), touched("src/new.ts", false), touched("src/gone.ts", true), touched("package-lock.json", true)] }, null, 2));
  }
  if (written) writeFileSync(join(out, "written-files.json"), JSON.stringify(written));
  return { repo, out };
}

test("brownfield: the counts are the files the run touched (provenance.json), never the whole repository, its lockfile or the run's own records", { skip: HAS_DIST }, async () => {
  for (const git of [true, false]) {
    const { repo, out } = brownfield({ git });
    await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: repo, codeDir: repo });
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.deepEqual(m.artifacts, { files: 2, loc: 5 }, `git=${git}: src/f1.ts (2 lines) and src/new.ts (3); a removed file and the lockfile are not counted`);
  }
  // The project root and the code directory naming one folder two ways (a link, /tmp beside /private/tmp).
  const { repo, out } = brownfield();
  symlinkSync(repo, `${repo}-link`);
  await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: `${repo}-link`, codeDir: repo });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).artifacts, { files: 2, loc: 5 });
});

test("brownfield: the executor's written-files.json names the run's files when there is no provenance record", { skip: HAS_DIST }, async () => {
  const { repo, out } = brownfield({ provenance: false, written: ["src/f2.ts", "src/f3.ts", "src/f3.ts"] });
  await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: repo, codeDir: repo });
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(m.artifacts, { files: 2, loc: 7 });
});

test("brownfield with no record of what the run wrote: the counts are left out and the output says so", { skip: HAS_DIST }, async () => {
  const { repo, out } = brownfield({ provenance: false });
  const r = await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: repo, codeDir: repo });
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(m.artifacts, undefined, "no whole-repository figure stated as the run's product");
  assert.equal(m.total_cost_usd, 0.5);
  assert.ok(r.notes.some((n) => /file counts left out/.test(n)), JSON.stringify(r.notes));
  const cli = spawnSync(process.execPath, [SCRIPT, out, "--pass", "r1", "--policy", "p", "--project-root", repo, "--code-dir", repo], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /file counts left out/);
});

test("a generated code folder: run records, lockfiles, tool folders and a virtualenv under any name are not counted", () => {
  const { code } = run();
  mkdirSync(join(code, ".sdlc", "runs", "r0"), { recursive: true });
  writeFileSync(join(code, ".sdlc", "runs", "r0", "telemetry.jsonl"), "{}\n");
  writeFileSync(join(code, "app", "package-lock.json"), "{\n}\n");
  writeFileSync(join(code, "app", "yarn.lock"), "x\n");
  mkdirSync(join(code, "env", "lib"), { recursive: true });
  writeFileSync(join(code, "env", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(code, "env", "lib", "site.py"), "x\n");
  for (const d of [".tox", ".claude", ".terraform", ".gradle"]) { mkdirSync(join(code, d)); writeFileSync(join(code, d, "f"), "x\n"); }
  assert.deepEqual(countProduct(code), { files: 1, loc: 4 });
});

test("a rewrite after more dispatched work drops the collector's figures instead of keeping a true total below the new dispatched total, and says so", { skip: HAS_DIST }, async () => {
  const { root, out } = run();
  await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root });
  const path = join(out, "manifest.json");
  const patched = { ...JSON.parse(readFileSync(path, "utf8")), orchestrator_overhead: { cost_usd: 9, dispatched_in_session_cost_usd: 0.25, provenance: "transcript" }, true_total_cost_usd: 9.5 };
  writeFileSync(path, JSON.stringify(patched));
  appendFileSync(join(out, "telemetry.jsonl"), ev({ task_id: "U03", ts: AT("09:30:00"), cost_usd: 5 }) + "\n");
  const cli = spawnSync(process.execPath, [SCRIPT, out, "--pass", "r1", "--policy", "p", "--project-root", root, "--status", "accepted"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const m = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(m.total_cost_usd, 5.75);
  assert.equal(m.status, "accepted");
  assert.equal(m.true_total_cost_usd, undefined, "no true total from before the new work");
  assert.equal(m.orchestrator_overhead, undefined);
  assert.match(cli.stdout, /dispatched total changed .*\$0\.75 .*\$5\.75/);
  assert.match(cli.stdout, /collect-orchestrator-usage\.mjs/, "the output names the command that writes them again");
});

test("the collector's figures are checked against the total they were computed from, even when total_cost_usd was already rewritten beside them", { skip: HAS_DIST }, async () => {
  const { root, out } = run();
  appendFileSync(join(out, "telemetry.jsonl"), ev({ task_id: "U03", ts: AT("09:30:00"), cost_usd: 5 }) + "\n");
  await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root });
  const path = join(out, "manifest.json");
  // total 5.75 on disk, but a true total the collector computed for 0.75: 0.75 − 0.25 in-session + 9 overhead.
  const stale = { ...JSON.parse(readFileSync(path, "utf8")), orchestrator_overhead: { cost_usd: 9, dispatched_in_session_cost_usd: 0.25, provenance: "transcript" }, true_total_cost_usd: 9.5 };
  writeFileSync(path, JSON.stringify(stale));
  const r = await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root, status: "accepted" });
  const m = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(m.true_total_cost_usd, undefined);
  assert.ok(r.notes.some((n) => /\$0\.75 → \$5\.75/.test(n)), JSON.stringify(r.notes));
  // Consistent figures (5.75 − 0.25 + 9 = 14.5) are kept.
  writeFileSync(path, JSON.stringify({ ...stale, true_total_cost_usd: 14.5 }));
  const kept = await writeManifest({ outDir: out, pass: "r1", policy: "p", projectRoot: root, status: "accepted" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).true_total_cost_usd, 14.5);
  assert.deepEqual(kept.notes, []);
});

/** A copy of the plugin's scripts under <base>/<dir>/plugin, with the server's dist linked in. */
function placePlugin(base, dir) {
  const plugin = join(base, dir, "plugin");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(plugin, "scripts", "write-manifest.mjs"));
  cpSync(join(dirname(SCRIPT), "lib"), join(plugin, "scripts", "lib"), { recursive: true });
  mkdirSync(join(plugin, "mcp", "model-dispatch"), { recursive: true });
  symlinkSync(dirname(DIST), join(plugin, "mcp", "model-dispatch", "dist"));
  return plugin;
}

function writesFrom(plugin, name) {
  const { root, out } = run();
  const r = spawnSync(process.execPath, [join(plugin, "scripts", "write-manifest.mjs"), out, "--pass", "r1", "--policy", "p", "--project-root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  assert.match(r.stdout, /manifest written: /, `${name}: ${r.stdout}${r.stderr}`);
  assert.ok(existsSync(join(out, "manifest.json")), name);
}

test("the script runs from a plugin folder whose path holds '#', '%' or a space", { skip: HAS_DIST }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wm-plugin-path-")));
  for (const dir of ["h#sh", "p%41ct", "sp ace"]) writesFrom(placePlugin(base, dir), dir);
});

test("the script runs when its plugin folder is reached through a symlink, instead of exiting 0 without a manifest", { skip: HAS_DIST }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wm-plugin-link-")));
  symlinkSync(placePlugin(base, "real"), join(base, "linked"));
  writesFrom(join(base, "linked"), "a symlinked plugin folder");
});
