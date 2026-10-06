/**
 * findings-to-packets.mjs: what a fix round may target and show, and how its packets are judged.
 *   - A fix packet is judged by the file's own checks with no new baseline (`apply.baseline: false`): the file it fixes
 *     fails them now, which is why it is being fixed. Only the checks set aside when the unit itself was applied (its
 *     receipt in the run's batches/) stay out.
 *   - A bugfix's reproducing test judges the fix, so no fix round targets it.
 *   - A file the run may not write, a file the package manager writes, and a context file that is off-limits are not
 *     routed, each with its reason.
 *   - A planned file that never landed is created, and a planned context file that is missing is shown as missing, as
 *     greenfield's repair round does.
 * Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const { repairPackets, main } = await import(join(SCRIPTS, "findings-to-packets.mjs"));
const { finalize } = await import(join(SCRIPTS, "plan-to-packets.mjs"));
const { HEADER, UNITS, BUG_HEADER, BUG_UNITS, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));

const HEADER2 = { ...HEADER, file_checks: [...HEADER.file_checks, { id: "size", run: "test -s {path}", timeout_s: 10 }] };
async function finalized(units = UNITS, header = HEADER2, intent = "feature-extend") {
  const p = project();
  assert.equal((await p.check("header.json", header)).ok, true);
  const u = await p.check("units-001.json", units);
  assert.equal(u.ok, true, u.lines.join("\n"));
  const f = await finalize({ projectRoot: p.root, runId: "r1", intent });
  assert.equal(f.code, 0, f.err.join("\n"));
  return p;
}
const repair = (p, failures, intent = "feature-extend", reviews = []) => repairPackets({ projectRoot: p.root, runId: "r1", intent, reviews, failures });
/** A receipt of execute_batch as the server writes it in the run's folder (server.ts: batches/<time>.json). */
function receipt(p, name, items) {
  const dir = join(p.root, ".sdlc", "runs", "r1", "batches");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ status: "applied", items }, null, 2));
}

test("a fix packet runs no new baseline: every check of the file judges the fix", async () => {
  const p = await finalized([{ ...UNITS[1], depends_on: [], checks: ["lint", "size"] }]);
  try {
    const [fix] = (await repair(p, [{ path: "src/a.ts", problem: "typecheck: TS2304" }])).packets;
    assert.equal(fix.apply.baseline, false);
    assert.deepEqual(fix.apply.checks.map((c) => c.id), ["lint", "size"], "no receipt: every check judges");
  } finally { p.done(); }
});

test("the checks set aside when the unit was applied stay out of its fix; the latest receipt of the unit wins", async () => {
  const p = await finalized([{ ...UNITS[1], depends_on: [], checks: ["lint", "size"] }]);
  try {
    receipt(p, "2026-10-06T10-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "applied", outcome: { status: "applied", set_aside: [{ id: "lint", run: "x", output: "exit 1" }, { id: "size", run: "y" }] } }]);
    receipt(p, "2026-10-06T11-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "applied", outcome: { status: "applied", set_aside: [{ id: "size", run: "test -s '{path}'", output: "exit 1" }] } }, { id: "tp_codegen_U09", status: "blocked" }]);
    receipt(p, "2026-10-06T12-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "blocked", blocked_by: ["x"] }]);
    const [fix] = (await repair(p, [{ path: "src/a.ts", problem: "x" }])).packets;
    assert.deepEqual(fix.apply.checks.map((c) => c.id), ["lint"], "the latest receipt that applied the unit set aside size only");
  } finally { p.done(); }
});

test("a bugfix's reproducing test is never a fix target: it judges the fix, and a problem in it goes back to the architect", async () => {
  const p = await finalized(BUG_UNITS, BUG_HEADER, "bugfix");
  try {
    p.file("test/a.test.ts", "it('a', () => {});\n");
    const r = await repair(p, [{ path: "test/a.test.ts", problem: "AssertionError: 500 !== 400 at test/a.test.ts:3" }, { path: "src/a.ts", problem: "returns 500" }], "bugfix");
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"]);
    assert.deepEqual(r.not_routed, [{ file: "test/a.test.ts", reason: "test/a.test.ts: the reproducing test judges the fix; a problem in it goes back to the architect" }]);
  } finally { p.done(); }
});

// A receipt counts only when the server took the unit's baseline in it: an outcome it reaches after the baseline
// (applied, verify_failed, escalate, no_content, dispatch_failed), or already_applied, which carries the set-aside of
// the call that applied the unit. A refusal comes before any baseline, and a blocked or stopped item has no outcome:
// none of them says what the baseline found, so none overrides an earlier receipt. A unit that did not apply is the fix
// round's usual target, and its receipt's set-aside is still the file before the change.
test("only a receipt that took the unit's baseline counts: a refusal or a stop never overrides one; a failed apply does", async () => {
  const p = await finalized([{ ...UNITS[1], depends_on: [], checks: ["lint", "size"] }]);
  try {
    receipt(p, "2026-10-06T10-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "verify_failed", outcome: { status: "verify_failed", set_aside: [{ id: "size", run: "test -s '{path}'", output: "exit 1" }] } }]);
    receipt(p, "2026-10-06T11-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "refused", outcome: { status: "refused", refusal: "a deny rule" } }]);
    receipt(p, "2026-10-06T12-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "stopped", artifact_path: "src/a.ts", cost_usd: 0, attempts: 0 }]);
    const [fix] = (await repair(p, [{ path: "src/a.ts", problem: "x" }])).packets;
    assert.deepEqual(fix.apply.checks.map((c) => c.id), ["lint"], "the verify_failed receipt's set-aside holds; the refusal and the stop say nothing");
    receipt(p, "2026-10-06T13-00-00-000Z.json", [{ id: "tp_codegen_U02", status: "already_applied", outcome: { status: "already_applied", set_aside: [{ id: "lint", run: "test -s '{path}'" }] } }]);
    const [again] = (await repair(p, [{ path: "src/a.ts", problem: "x" }])).packets;
    assert.deepEqual(again.apply.checks.map((c) => c.id), ["size"], "already_applied carries the applying call's set-aside");
  } finally { p.done(); }
});

// The integrity rule and the unit lookup compare files, not spellings: on a case-insensitive disk (macOS's), a finding
// that names the reproducing test in other letters names the same file, and so does one that names a unit's file so.
test("a finding that spells the reproducing test or a unit's file in other letters is matched to the same file", async () => {
  const p = await finalized(BUG_UNITS, BUG_HEADER, "bugfix");
  try {
    p.file("test/a.test.ts", "it('a', () => {});\n");
    const caseBlind = existsSync(join(p.root, "Test", "a.test.ts"));
    const r = await repair(p, [
      { path: "Test/a.test.ts", problem: "AssertionError at Test/a.test.ts:3" },
      { path: "test/A.test.ts", problem: "AssertionError" },
      { path: "SRC/a.ts", problem: "returns 500" },
      { path: "src/a.ts", problem: "unused import" },
    ], "bugfix");
    if (caseBlind) {
      assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"], "one packet for one file, under the unit's own path");
      assert.equal(r.packets[0].instruction.includes("1. returns 500") && r.packets[0].instruction.includes("2. unused import"), true, "both problems merged");
      assert.deepEqual(r.packets[0].apply.checks.map((c) => c.id), ["lint"], "the unit's checks judge the fix");
      assert.deepEqual(r.not_routed, [{ file: "test/a.test.ts", reason: "test/a.test.ts: the reproducing test judges the fix; a problem in it goes back to the architect" }]);
    } else {
      // A case-sensitive disk holds no such files: other letters name files that do not exist.
      assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"]);
      assert.equal(r.not_routed.some((n) => n.reason.includes("the reproducing test judges the fix")), false);
    }
  } finally { p.done(); }
});

test("a planned file that never landed is created by the fix, not read: one finding cannot sink the round", async () => {
  const p = await finalized();
  try {
    // src/b.ts is U01's file; its packet never wrote it.
    const r = await repair(p, [], "feature-extend", []);
    assert.equal(r.packets.length, 0);
    const review = join(p.root, ".sdlc", "runs", "r1", "review.json");
    writeFileSync(review, JSON.stringify({ findings: [{ severity: "blocker", file: "src/b.ts", issue: "missing its export" }, { severity: "minor", file: "src/a.ts", issue: "unused import" }] }));
    const both = await repair(p, [], "feature-extend", [review]);
    assert.deepEqual(both.packets.map((k) => k.artifact_path), ["src/b.ts", "src/a.ts"]);
    const [b] = both.packets;
    assert.equal(b.apply.mode, "content");
    assert.match(b.instruction, /^Create `src\/b\.ts`/);
    assert.equal(b.inputs.some((i) => i.path === "src/b.ts"), false, "nothing to read: the file does not exist");
  } finally { p.done(); }
});

test("a planned context file that is missing is shown as missing, as greenfield's repair round shows it", async () => {
  const p = await finalized();
  try {
    const [a] = (await repair(p, [{ path: "src/a.ts", problem: "TS2307: Cannot find module './b'", context_paths: ["src/b.ts"] }])).packets;
    assert.deepEqual(a.inputs.find((i) => i.path === "src/b.ts"), { path: "src/b.ts", reason: "named beside the failure: the file does not exist yet", content: "(missing)" });
  } finally { p.done(); }
});

// One deps spec under the one convention for a tooling unit's path (the file its step writes): finalize accepts it only
// in order (the manifest edit, the install waiting for it, the code waiting for the install), and a fix round sends a
// failure on the lockfile back to the step, a failure on the manifest to the manifest's typist with its checks, and a
// failure on any other file the run's provenance records the step as writing back to the step too.
test("a file the package manager writes is not typed: on the ordered deps spec, a failure on it goes back to its tooling step", async () => {
  const p = project();
  try {
    p.file("package.json", '{\n  "dependencies": {}\n}\n');
    p.file("package-lock.json", "{}\n");
    p.file("packages/web/package-lock.json", "{}\n");
    p.file("src/use.ts", "export const u = 1;\n");
    const manifest = { id: "U01", path: "package.json", action: "edit", phase: "codegen", behaviour: "lib 2", sites: [{ id: "S1", at: "insert_after", from: 2, to: 2, first_line: '"dependencies": {}', rule: "r" }], depends_on: [], checks: ["lint"] };
    const install = { id: "U02", path: "package-lock.json", action: "tooling", phase: "codegen", behaviour: "install", run: "npm install", depends_on: ["U01"] };
    const code = { id: "U03", path: "src/use.ts", action: "edit", phase: "codegen", behaviour: "new API", sites: [{ id: "S1", at: "replace", from: 1, to: 1, first_line: "export const u = 1;", rule: "r" }], depends_on: ["U02"], checks: ["lint"] };
    assert.equal((await p.check("header.json", HEADER)).ok, true);
    // Out of order first: the install before the manifest edit is refused at finalize.
    assert.equal((await p.check("units-001.json", [{ ...install, id: "U01", depends_on: [] }, { ...manifest, id: "U02", depends_on: ["U01"] }, { ...code, depends_on: ["U01"] }])).ok, true);
    const wrong = await finalize({ projectRoot: p.root, runId: "r1", intent: "deps" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err.join("\n"), /U01 \(package-lock\.json\): the install waits for no typed unit/);
    assert.equal((await p.check("units-001.json", [manifest, install, code])).ok, true);
    const f = await finalize({ projectRoot: p.root, runId: "r1", intent: "deps" });
    assert.equal(f.code, 0, f.err.join("\n"));
    // The orchestrator records what the step wrote, under the step's packet id (brownfield-runs.md, Phase 5).
    const prov = join(p.root, ".sdlc", "runs", "r1", "provenance.json");
    writeFileSync(prov, JSON.stringify({ run_id: "r1", files_touched: [
      { path: "package.json", packet_id: "tooling_U02" },
      { path: "package-lock.json", packet_id: "tooling_U02" },
      { path: "packages/web/package-lock.json", packet_id: "tooling_U02" },
    ] }));
    const r = await repair(p, [
      { path: "package-lock.json", problem: "npm ci: lockfile out of sync" },
      { path: "packages/web/package-lock.json", problem: "npm ci: lockfile out of sync" },
      { path: "package.json", problem: "invalid JSON" },
    ], "deps");
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["package.json"], "the manifest is typed: its unit owns it");
    assert.deepEqual(r.packets[0].apply.checks.map((c) => c.id), ["lint"]);
    assert.deepEqual(r.not_routed, [
      { file: "package-lock.json", reason: "package-lock.json is written by tooling_U02, a shell step no model types: run that step again" },
      { file: "packages/web/package-lock.json", reason: "packages/web/package-lock.json is written by tooling_U02, a shell step no model types: run that step again" },
    ]);
  } finally { p.done(); }
});

// One read rule for everything sent to a model, and the writer's rule for what a fix may target.
test("an off-limits context file is not sent, and an off-limits target is not routed, each with its reason", async () => {
  const p = await finalized();
  try {
    p.file(".env", "DATABASE_PASSWORD=hunter2\n");
    p.file("secrets/prod.yml", "password: x\n");
    p.file("config/secrets.yml", "password: y\n");
    p.contract({ allowlist: ["src/**", "config/**"], off_limits: ["secrets/**", "config/secrets.yml"] });
    const r = await repair(p, [
      { path: "src/a.ts", problem: "db test fails", context_paths: [".env", "secrets/prod.yml", "src/x.ts"] },
      { path: "config/secrets.yml", problem: "a key is missing" },
    ]);
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"]);
    const paths = r.packets[0].inputs.map((i) => i.path);
    assert.ok(!paths.includes(".env") && !paths.includes("secrets/prod.yml"), paths.join(", "));
    assert.ok(paths.includes("src/x.ts"));
    assert.deepEqual(r.not_routed, [
      { file: ".env", reason: ".env is off-limits (always: .env): its text is never sent to a model" },
      { file: "secrets/prod.yml", reason: "secrets/prod.yml is off-limits (the write contract: secrets/**): its text is never sent to a model" },
      { file: "config/secrets.yml", reason: "config/secrets.yml is off-limits (the write contract: config/secrets.yml); the run may not write it" },
    ]);
  } finally { p.done(); }
});

test("--intent is checked against the run's job as Gate 0 recorded it", async () => {
  const p = await finalized();
  try {
    p.brief("feature-extend");
    const failures = join(p.root, ".sdlc", "runs", "r1", "failures.json");
    writeFileSync(failures, JSON.stringify([{ path: "src/a.ts", problem: "x" }]));
    const errs = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { errs.push(String(s)); return true; };
    let code;
    try { code = await main(["--run-id", "r1", "--intent", "bugfix", "--project-root", p.root, "--failures", failures]); } finally { process.stderr.write = write; }
    assert.equal(code, 2);
    assert.match(errs.join(""), /--intent bugfix is not this run's job: Gate 0 recorded feature-extend \(intent_brief\.md\)/);
  } finally { p.done(); }
});

// A file outside the spec, named in other letters (a case-insensitive disk, macOS's), is one file: it is judged and
// routed under the disk's own spelling, so the writer's rule and the merge see the file as the server will write it.
test("a fix target outside the spec, spelled in other letters, is routed under the disk's own spelling", async () => {
  const p = await finalized();
  try {
    p.file("config/app.yml", "key: 1\n");
    p.contract({ allowlist: ["src/**", "config/**"], off_limits: [] });
    const r = await repair(p, [{ path: "CONFIG/app.yml", problem: "a key is missing" }, { path: "config/APP.yml", problem: "another key" }]);
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["config/app.yml"], JSON.stringify(r.not_routed));
    assert.match(r.packets[0].instruction, /a key is missing[\s\S]*another key/);
  } finally { p.done(); }
});
