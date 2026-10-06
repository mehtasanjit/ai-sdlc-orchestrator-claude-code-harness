/**
 * plugin/scripts/pre-check.mjs on a project whose status file an earlier plugin wrote. The pre-check no longer runs
 * a dispatch smoke (the run's start check tests the models that type the run, with the run's auth mode), so its
 * step 3 is always `skip`. A status file left by the earlier flow can hold step 3 as `fail` (the smoke asked a
 * subscription user for an API key) or `pending` (nothing posted it); `--run` reloads that file, and kept the old value
 * unless it reset the step, so the project stayed "not ready" for good and the guide stopped before Gate 0.
 * Offline, $0: the test command probed is `node --version`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRE_CHECK = join(ROOT, "plugin", "scripts", "pre-check.mjs");

/** A status file in the shape the earlier pre-check wrote, with step 3 set to `dispatch`. */
function oldStatus(dispatch) {
  return {
    schema_version: 1,
    updated_at: "2026-10-01T09:00:00.000Z",
    steps: {
      discovery_smoke: { status: "pass", note: "Tier 1 completed cleanly" },
      test_command_probe: { status: "pass", probe: "node --version", exit_code: 0 },
      dispatch_smoke: dispatch,
      write_contract_smoke: { status: "pass" },
      rollback_smoke: { status: "pass" },
      report_finalized: { status: "pass", note: "Script-side steps recorded." },
    },
    ok: false,
  };
}

for (const [label, dispatch] of [
  ["failed", { status: "fail", error: "no ANTHROPIC_API_KEY for the opus tier" }],
  ["pending", { status: "pending", note: "Orchestrator posts via --record dispatch" }],
]) {
  test(`--run on a status file whose dispatch smoke the earlier flow left ${label}: step 3 is reset to skip and the project is ready`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-precheck-old-"));
    try {
      const sdlc = join(dir, ".sdlc");
      mkdirSync(sdlc, { recursive: true });
      writeFileSync(join(sdlc, "pre-check-status.json"), JSON.stringify(oldStatus(dispatch), null, 2));
      const r = spawnSync(process.execPath, [PRE_CHECK, "--run", "--json", "--test-cmd", `${process.execPath} --version`, "--sdlc", sdlc], { encoding: "utf8", cwd: dir });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const status = JSON.parse(r.stdout);
      assert.equal(status.ok, true);
      assert.equal(status.steps.dispatch_smoke.status, "skip");
      assert.match(status.steps.dispatch_smoke.note, /probe_typists/);
      assert.equal(status.steps.dispatch_smoke.error, undefined, "the earlier flow's error is not carried over");
      // The report note names only the step the orchestrator posts (discovery); step 3 is not posted here any more.
      assert.doesNotMatch(status.steps.report_finalized.note, /and 3 \(dispatch\)|--record dispatch/);
      assert.match(status.steps.report_finalized.note, /Step 1 \(discovery\)[^.;]*--record discovery; step 3 \(dispatch\) is tested at each run's start/);
      const onDisk = JSON.parse(readFileSync(join(sdlc, "pre-check-status.json"), "utf8"));
      assert.equal(onDisk.steps.dispatch_smoke.status, "skip", "the reset is written, so --report agrees");
      assert.equal(onDisk.ok, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("a fresh pre-check and one run over an old status file record the same step 3", () => {
  const fresh = mkdtempSync(join(tmpdir(), "mmo-precheck-fresh-"));
  const old = mkdtempSync(join(tmpdir(), "mmo-precheck-old-"));
  try {
    mkdirSync(join(old, ".sdlc"), { recursive: true });
    writeFileSync(join(old, ".sdlc", "pre-check-status.json"), JSON.stringify(oldStatus({ status: "fail", error: "x" })));
    const step3 = (dir) => {
      const r = spawnSync(process.execPath, [PRE_CHECK, "--run", "--json", "--test-cmd", `${process.execPath} --version`, "--sdlc", join(dir, ".sdlc")], { encoding: "utf8", cwd: dir });
      return JSON.parse(r.stdout).steps.dispatch_smoke;
    };
    assert.deepEqual(step3(old), step3(fresh));
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});
