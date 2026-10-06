/**
 * runLog.ts, the server's copy of the plugin scripts' run-log rules (plugin/scripts/lib/run-log.mjs runEnded,
 * lib/contract-lock.mjs frozenBy): the server reads a run's whole log, the pieces the logger rotated out included, only
 * from regular files, and reads freeze records write-contract.mjs never writes as a change to the contract. Each case
 * runs the server's reader and the scripts' on the same project, so the two decide alike. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const server = await import(join(DIST, "runLog.js"));
const { checkWriteContract } = await import(join(DIST, "apply.js"));
const lock = await import(join(SCRIPTS, "lib", "contract-lock.mjs"));
const runLog = await import(join(SCRIPTS, "lib", "run-log.mjs"));

const sha = (text) => createHash("sha256").update(text).digest("hex");
let clock = Date.parse("2026-10-01T10:00:00Z");
/** One run-log line as the plugin's logger writes it, each a second after the last. */
const line = (event, fields) => `MMO: ${new Date((clock += 1000)).toISOString()} INFO ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`;
const CONTRACT = { schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**"] };

/** A project whose run r1 froze CONTRACT (the record in its log), with the contract on disk as frozen. */
function frozen() {
  const root = mkdtempSync(join(tmpdir(), "runlog-whole-"));
  const text = JSON.stringify(CONTRACT);
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), text);
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  writeFileSync(log(root), line("contract.freeze", { run_id: "r1", sha256: sha(text) }) + line("run.start", { run_id: "r1" }));
  return { root, text };
}
const log = (root, run = "r1") => join(root, ".sdlc", "runs", run, "orchestrator.log");
const widen = (root) => writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ ...CONTRACT, allowlist: ["**"] }));
/** The server's answer and the scripts' answer, which must be the same. */
function both(root) {
  const s = server.liveFreeze(root), l = lock.frozenBy(root);
  assert.deepEqual(s, l, "the server reads the freeze records as the scripts do");
  return s;
}

test("a freeze record in the log's rotated piece still binds, and an end in the newer piece ends it", () => {
  const { root } = frozen();
  try {
    renameSync(log(root), `${log(root)}.1`);
    writeFileSync(log(root), line("phase.start", { run_id: "r1", phase: "design" }));
    assert.equal(both(root)?.run_id, "r1");
    widen(root);
    assert.equal(checkWriteContract(root, "docs/x.md").allowed, false, "a shell-widened contract stays refused after a rotation");
    assert.match(checkWriteContract(root, "src/a.ts").reason, /changed after it was frozen/);
    writeFileSync(log(root), line("run.end", { run_id: "r1", outcome: "aborted" }), { flag: "a" });
    assert.equal(both(root), null);
    assert.equal(server.runEnded(root, "r1"), true);
    assert.equal(server.runEnded(root, "r1"), runLog.runEnded(root, "r1"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a run's end in a rotated piece ends the run, as the scripts read it; the pieces are read oldest (highest number) first", () => {
  const { root } = frozen();
  try {
    writeFileSync(log(root), line("run.end", { run_id: "r1", outcome: "aborted" }), { flag: "a" });
    renameSync(log(root), `${log(root)}.2`);
    writeFileSync(`${log(root)}.1`, line("phase.start", { run_id: "r1", phase: "review" }));
    writeFileSync(log(root), line("phase.start", { run_id: "r1", phase: "docs" }));
    assert.equal(server.runEnded(root, "r1"), true);
    assert.equal(runLog.runEnded(root, "r1"), true);
    // A later start in the newest piece makes the run live again: the pieces are read in order.
    writeFileSync(log(root), line("run.start", { run_id: "r1" }), { flag: "a" });
    assert.equal(server.runEnded(root, "r1"), false);
    assert.equal(runLog.runEnded(root, "r1"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("freeze records write-contract.mjs never writes are a change to the contract: two in one run's log, or two live runs", () => {
  const { root, text } = frozen();
  try {
    writeFileSync(log(root), line("contract.freeze", { run_id: "r1", sha256: sha(text) }), { flag: "a" });
    const twice = both(root);
    assert.equal(twice.sha256, null);
    assert.match(twice.forged, /holds 2 freeze records/);
    assert.equal(checkWriteContract(root, "src/a.ts").allowed, false, "even a path the contract allows");
  } finally { rmSync(root, { recursive: true, force: true }); }
  const two = frozen();
  try {
    mkdirSync(join(two.root, ".sdlc", "runs", "r9"), { recursive: true });
    writeFileSync(log(two.root, "r9"), line("contract.freeze", { run_id: "r9", sha256: sha(two.text) }));
    const live = both(two.root);
    assert.equal(live.sha256, null);
    assert.match(live.forged, /freeze records of 2 runs are live \(r1, r9\)/);
    assert.equal(checkWriteContract(two.root, "src/a.ts").allowed, false);
  } finally { rmSync(two.root, { recursive: true, force: true }); }
});

test("a run log that is no regular file is no log: a link is not followed", () => {
  const { root } = frozen();
  try {
    renameSync(log(root), join(root, "elsewhere.log"));
    symlinkSync(join(root, "elsewhere.log"), log(root));
    assert.equal(both(root), null);
    assert.equal(server.runEnded(root, "r1"), runLog.runEnded(root, "r1"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Reading a named pipe blocks until something writes to it, and the server reads the run logs before every write it
// makes: one pipe where a log should be must never stall it.
const HAS_MKFIFO = spawnSync("mkfifo", ["--version"], { stdio: "ignore" }).error === undefined;
test("a named pipe where a run log should be never stalls the server's reader", { skip: HAS_MKFIFO ? false : "no mkfifo on this computer" }, () => {
  const { root } = frozen();
  try {
    mkdirSync(join(root, ".sdlc", "runs", "zz"), { recursive: true });
    assert.equal(spawnSync("mkfifo", [log(root, "zz")]).status, 0);
    assert.equal(spawnSync("mkfifo", [`${log(root, "r1")}.1`]).status, 0);
    const code = `import { liveFreeze, runEnded } from ${JSON.stringify(pathToFileURL(join(DIST, "runLog.js")).href)}; console.log(JSON.stringify([liveFreeze(process.argv[1])?.run_id ?? null, runEnded(process.argv[1], "zz"), runEnded(process.argv[1], "r1")]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, root], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.error, undefined, "the reader returned within 5 s");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["r1", false, false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
