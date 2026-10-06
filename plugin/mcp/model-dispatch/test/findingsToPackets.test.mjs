/**
 * findings-to-packets.mjs: review findings and the failures of a check run become fix packets by code, as greenfield's
 * repair round builds its jobs (executor/tools.ts reviewRepairs, failureRepairs; executor/run.ts placeFixPath): one
 * packet per file, its problems merged, the file's own brief and checks from the change spec, ready for one
 * execute_batch call. The orchestrator names failures; it writes no packet. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const { repairPackets, main } = await import(join(SCRIPTS, "findings-to-packets.mjs"));
const { finalize } = await import(join(SCRIPTS, "plan-to-packets.mjs"));
const { HEADER, UNITS, BUG_HEADER, BUG_UNITS, project } = await import(join(HERE, "fixtures", "change-spec.mjs"));
const { executorRun } = await (await import(join(SCRIPTS, "lib", "server-lib.mjs"))).loadServerLib();

/** The fixture project with its change spec finalized (briefs and packets.json written). */
async function finalized() {
  const p = project();
  assert.equal((await p.check("header.json", HEADER)).ok, true);
  assert.equal((await p.check("units-001.json", UNITS)).ok, true);
  assert.equal((await finalize({ projectRoot: p.root, runId: "r1", intent: "feature-extend" })).code, 0);
  return p;
}
const runDir = (p) => join(p.root, ".sdlc", "runs", "r1");

test("review findings: one packet per file, its problems merged, with the file's own brief and checks from the spec", async () => {
  const p = await finalized();
  try {
    writeFileSync(join(p.root, "src", "b.ts"), "export const b = 3;\n");
    const review = join(runDir(p), "review-api.json");
    writeFileSync(review, JSON.stringify({ module: "api", verdict: "needs_changes", findings: [
      { severity: "blocker", file: "src/b.ts", line: 1, issue: "b returns 3", fix: "return 2" },
      { severity: "minor", file: "src/b.ts", issue: "no doc comment", fix: "add one" },
      { severity: "major", file: "src/a.ts", issue: "unused import" },
      { severity: "minor", issue: "naming in general" },
      { severity: "minor", file: "src/elsewhere.ts", issue: "x" },
    ] }));
    const r = await repairPackets({ projectRoot: p.root, runId: "r1", intent: "feature-extend", reviews: [review], failures: [] });
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/b.ts", "src/a.ts"]);
    const [b, a] = r.packets;
    assert.equal(b.phase, "debug", "routed by the policies' own rule for fixes");
    assert.equal(b.apply.mode, "edits");
    assert.match(b.instruction, /1\. blocker \(line 1\): b returns 3 — fix: return 2\n2\. minor: no doc comment — fix: add one/);
    assert.deepEqual(b.inputs.map((i) => i.path), [".sdlc/runs/r1/briefs/shared.md", ".sdlc/runs/r1/briefs/U01.md", "src/b.ts"]);
    assert.equal(b.inputs.at(-1).reason, "current text");
    assert.match(b.instruction, /## Answer\nReturn ONLY a JSON object \{"path": "src\/b\.ts", "edits": \[/, "greenfield's answer wording");
    const spec = JSON.parse(readFileSync(join(runDir(p), "packets.json"), "utf8"));
    assert.deepEqual(b.apply.checks, spec.find((k) => k.artifact_path === "src/b.ts").apply.checks, "the file's own checks, with their write forms");
    assert.deepEqual(a.inputs.map((i) => i.path).at(-1), "src/a.ts");
    assert.deepEqual(r.not_routed.map((n) => n.reason), ["a finding with no file", `src/elsewhere.ts ${executorRun.NOT_PLACED}`]);
  } finally { p.done(); }
});

test("a path written from above the project is placed under it, as greenfield places a fix; a file outside it is not", async () => {
  const p = await finalized();
  try {
    const above = `${basename(p.root)}/src/a.ts`;
    const r = await repairPackets({ projectRoot: p.root, runId: "r1", intent: "feature-extend", reviews: [], failures: [
      { path: above, problem: "test a fails: expected 2" },
      { path: "../outside.ts", problem: "x" },
    ] });
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"]);
    assert.equal(r.not_routed.length, 1);
  } finally { p.done(); }
});

test("a check failure that needs a new file is typed whole, beside the files it names", async () => {
  const p = await finalized();
  try {
    const r = await repairPackets({ projectRoot: p.root, runId: "r1", intent: "feature-extend", reviews: [], failures: [
      { path: "src/c.ts", problem: "test c: module ./c not found", new_file: true, context_paths: ["src/x.ts"] },
    ] });
    const [c] = r.packets;
    assert.equal(c.apply.mode, "content");
    assert.match(c.instruction, /Create `src\/c\.ts`/);
    assert.deepEqual(c.inputs.map((i) => i.path), [".sdlc/runs/r1/briefs/shared.md", "src/x.ts"]);
    assert.deepEqual(c.apply.checks, [], "a file outside the spec has no checks of its own; the project checks run at the end");
  } finally { p.done(); }
});

test("a file outside the run's write contract is not routed: the server would refuse it", async () => {
  const p = await finalized();
  try {
    mkdirSync(join(p.root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(p.root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, run_id: "r1", allowlist: ["src/b.ts"] }));
    const r = await repairPackets({ projectRoot: p.root, runId: "r1", intent: "feature-extend", reviews: [], failures: [{ path: "src/a.ts", problem: "x" }] });
    assert.equal(r.packets.length, 0);
    assert.match(r.not_routed[0].reason, /outside the write contract's allowlist/);
  } finally { p.done(); }
});

test("each round is written to the run's repairs folder for one execute_batch call; usage errors exit 2", async () => {
  const p = await finalized();
  try {
    const failures = join(runDir(p), "failures.json");
    writeFileSync(failures, JSON.stringify([{ path: "src/a.ts", problem: "typecheck: TS2304 cannot find name y" }]));
    const out = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    let code1, code2;
    try {
      code1 = await main(["--run-id", "r1", "--intent", "feature-extend", "--project-root", p.root, "--failures", failures]);
      code2 = await main(["--run-id", "r1", "--intent", "feature-extend", "--project-root", p.root, "--failures", failures]);
    } finally { process.stdout.write = write; }
    assert.equal(code1, 0);
    assert.equal(code2, 0);
    assert.match(out.join(""), /1 fix packet\(s\) → .*repairs\/round-1\.json/);
    assert.match(out.join(""), /repairs\/round-2\.json/);
    const round = JSON.parse(readFileSync(join(runDir(p), "repairs", "round-2.json"), "utf8"));
    assert.equal(round[0].id, "tp_debug_r2_001");
    assert.equal(await main(["--run-id", "r1", "--intent", "feature-extend", "--project-root", p.root]), 2, "nothing to route");
    // The packets carry the job, which is what has the server type them with greenfield's typists.
    assert.equal(await main(["--run-id", "r1", "--project-root", p.root, "--failures", failures]), 2, "no job");
    assert.equal(await main(["--run-id", "r1", "--intent", "feature", "--project-root", p.root, "--failures", failures]), 2, "not a job");
  } finally { p.done(); }
});

// A fix round runs after every file of the change is in, the fix included. A bugfix's reproducing test judges the fix,
// so a failure it reports goes to the code under fault, never to the test: a typist that edited the test until it
// passed would ship the bug green.
test("a fix round after a bugfix's fix: the fix is judged, and the reproducing test is not a target", async () => {
  const p = project();
  try {
    assert.equal((await p.check("header.json", BUG_HEADER)).ok, true);
    assert.equal((await p.check("units-001.json", BUG_UNITS)).ok, true);
    assert.equal((await finalize({ projectRoot: p.root, runId: "r1", intent: "bugfix" })).code, 0);
    mkdirSync(join(p.root, "test"), { recursive: true });
    writeFileSync(join(p.root, "test", "a.test.ts"), "it('a', () => {});\n");
    const r = await repairPackets({ projectRoot: p.root, runId: "r1", intent: "bugfix", reviews: [], failures: [
      { path: "test/a.test.ts", problem: "the assertion compares the wrong value" },
      { path: "src/a.ts", problem: "a() still returns 1", context_paths: ["test/a.test.ts"] },
    ] });
    assert.deepEqual(r.packets.map((k) => k.artifact_path), ["src/a.ts"]);
    assert.match(r.not_routed[0].reason, /the reproducing test judges the fix/);
    assert.deepEqual(r.packets[0].apply.checks, [{ id: "lint", run: "test -s '{path}'", fix: "touch '{path}'" }]);
    assert.ok(r.packets[0].inputs.some((i) => i.path === "test/a.test.ts"), "the test is shown beside the fix");
  } finally { p.done(); }
});
