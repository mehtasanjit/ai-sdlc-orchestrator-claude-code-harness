/**
 * Unit tests for plugin/scripts/session-hydrate.mjs — reads project state
 * for the orchestrator + commands to hand off (ticket §7.14, §10.1).
 *
 * Verifies: null-safe when no .sdlc/ present; reads project.json fields
 * (including default_policy); detects mid-setup resume from setup-status.json;
 * emits the one-line marker via --marker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "session-hydrate.mjs");

function run(cwd, args = []) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeRepo({ project, setupStatus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  const sdlc = join(dir, ".sdlc");
  if (project !== undefined) {
    mkdirSync(sdlc, { recursive: true });
    writeFileSync(join(sdlc, "project.json"), JSON.stringify(project));
  }
  if (setupStatus !== undefined) {
    mkdirSync(join(sdlc, "local"), { recursive: true });
    writeFileSync(join(sdlc, "local", "setup-status.json"), JSON.stringify(setupStatus));
  }
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("returns a well-formed empty payload when no .sdlc/ exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    const r = run(dir);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "project must be null when no .sdlc/");
    assert.equal(payload.baseline, null);
    assert.deepEqual(payload.recent_runs, []);
    assert.equal(payload.resume, null);
  } finally { cleanup(dir); }
});

test("exposes default_policy from project.json in the payload", async () => {
  const dir = makeRepo({ project: { schema_version: 1, default_policy: "my-custom" } });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project.default_policy, "my-custom", "default_policy must round-trip");
  } finally { cleanup(dir); }
});

test("exposes stacks and test_command when project.json has them", async () => {
  const dir = makeRepo({
    project: { schema_version: 1, stacks: ["nest"], test_command: "npm test" },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(payload.project.stacks, ["nest"]);
    assert.equal(payload.project.test_command, "npm test");
    assert.equal(payload.project.default_policy, null, "unset default_policy → null, not undefined");
  } finally { cleanup(dir); }
});

test("detects a pending setup from setup-status.json and returns a resume hint", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install"],
      sections_pending: [{ number: 2, name: "environment" }, { number: 3, name: "credentials" }],
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.ok(payload.resume, "resume hint must be present when sections_pending non-empty");
    assert.equal(payload.resume.pending, true);
    assert.equal(payload.resume.kind, "setup");
  } finally { cleanup(dir); }
});

test("no resume hint when setup-status.json shows all sections done", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install", "environment"],
      sections_pending: [],
      status: "complete",
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.resume, null, "no pending sections → no resume");
  } finally { cleanup(dir); }
});

test("--marker prints a single-line human summary", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    const r = run(dir, ["--marker"]);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "--marker must produce a single line");
    assert.match(lines[0], /SDLC/, "marker must be recognisable");
  } finally { cleanup(dir); }
});

test("tolerates corrupt project.json — treats it as absent, does not crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), "this is not json {[}");
    const r = run(dir);
    assert.equal(r.code, 0, "must not crash on corrupt project.json");
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "corrupt project.json → project null");
  } finally { cleanup(dir); }
});

// ── A run that never ended, found from its contract's freeze record ─────────────────────────────────────────────────
// A brownfield run writes no .sdlc/local/state.json (its write contract refuses every write under .sdlc/ outside its own
// folder): the record of a run that never ended is its contract's live freeze record, in the run's own log. The
// brownfield guide's step 1 reads it here to find a dead run before anything is written. A greenfield state.json is
// not a brownfield run.
const CONTRACT_SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract.mjs");
const contract = (cwd, ...args) => spawnSync("node", [CONTRACT_SCRIPT, ...args], { cwd, encoding: "utf8" });
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

test("a run whose Gate 0 froze its contract and that never ended is a pending run, until it is abandoned", async () => {
  const dir = gitRepo();
  try {
    const frozen = contract(dir, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]");
    assert.equal(frozen.status, 0, frozen.stderr);
    let payload = JSON.parse(run(dir).stdout);
    assert.equal(payload.resume?.pending, true);
    assert.equal(payload.resume.kind, "run");
    assert.equal(payload.resume.run_id, "r1");
    assert.equal(payload.resume.phase, null, "no phase logged yet");
    assert.equal(payload.resume.status, "live");
    assert.match(payload.marker, /run r1 never ended/);
    // Its phase, from the run's own log.
    const log = join(dir, ".sdlc", "runs", "r1", "orchestrator.log");
    writeFileSync(log, `${readFileSync(log, "utf8")}MMO: 2026-10-06T10:00:00.000Z INFO   run.start run_id=r1\nMMO: 2026-10-06T10:05:00.000Z INFO   phase.start run_id=r1 phase=codegen\n`);
    payload = JSON.parse(run(dir).stdout);
    assert.equal(payload.resume.phase, "codegen");
    assert.equal(payload.resume.at, "2026-10-06T10:05:00.000Z");
    // Ended on purpose: nothing pending.
    const ended = contract(dir, "--abandon", "--run-id", "r1");
    assert.equal(ended.status, 0, ended.stderr);
    payload = JSON.parse(run(dir).stdout);
    assert.equal(payload.resume, null);
    assert.match(payload.marker, /no open resume checkpoint/);
  } finally { cleanup(dir); }
});

test("a state.json that says in progress, with no live freeze record, is no pending run", async () => {
  const dir = gitRepo();
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "state.json"), JSON.stringify({ run_id: "g1", status: "in_progress", phase: "codegen" }));
    const payload = JSON.parse(run(dir).stdout);
    assert.equal(payload.resume, null);
  } finally { cleanup(dir); }
});
