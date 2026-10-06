/**
 * Greenfield's acceptance commands are held to the person's Bash deny rules, as a brownfield packet's checks are
 * (apply.ts commandDeniedBy): the server runs them itself, where Claude Code's own permission check for its Bash tool
 * never sees them. A denied command never runs; it is reported as not run with the rule, and its criteria are not
 * checked. Temp folders, short local commands; no model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAcceptance } from "../dist/executor/acceptance.js";

const plan = (commands) => ({ spec_version: "1", stack: [], commands, decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: [], no_audit_reason: "test" });
const cmd = (name, run, over = {}) => ({ name, run, cwd: ".", role: "check", checks: [], pass: { exit_code: 0 }, timeout_s: 60, ...over });
/** A HOME with the given user-level deny rules, and no managed settings file. */
function home(deny = []) {
  const h = mkdtempSync(join(tmpdir(), "acc-deny-home-"));
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ permissions: { deny } }));
  return { HOME: h, CLAUDE_CONFIG_DIR: "", MMO_MANAGED_SETTINGS: join(h, "no-managed-settings.json") };
}

test("an acceptance command the person's settings deny never runs: it is not run, with the rule, and its criteria are not checked", async () => {
  const code = mkdtempSync(join(tmpdir(), "acc-deny-code-"));
  writeFileSync(join(code, "victim.txt"), "keep me\n");
  const r = await runAcceptance(plan([
    cmd("tests", "rm -f victim.txt && true", { checks: ["AC-1"] }),
    cmd("lint", "true", { checks: ["AC-2"] }),
  ]), { codeDir: code, outDir: mkdtempSync(join(tmpdir(), "acc-deny-out-")), env: { ...process.env, ...home(["Bash(rm:*)"]) } });
  assert.equal(existsSync(join(code, "victim.txt")), true, "the denied command did not run");
  assert.deepEqual(r.not_run, [{ command: "tests", reason: "not run: the person's Claude settings deny it (Bash(rm:*))" }]);
  assert.deepEqual(r.not_checked, ["AC-1"]);
  assert.equal(r.passed, 1, "a command no rule denies still runs");
  assert.deepEqual(r.failed, [], "a denied command is the person's decision, not a failure to repair");
});

test("the project's own settings in the code directory deny too, and an install they deny stops what needs it", async () => {
  const code = mkdtempSync(join(tmpdir(), "acc-deny-code-"));
  mkdirSync(join(code, ".claude"), { recursive: true });
  // A program no machine has, so nothing could reach the network even if the rule were not read.
  writeFileSync(join(code, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(mmo-test-fetch:*)"] } }));
  const r = await runAcceptance(plan([
    cmd("install", "mmo-test-fetch --all", { role: "install" }),
    cmd("tests", "true", { checks: ["AC-1"] }),
  ]), { codeDir: code, outDir: mkdtempSync(join(tmpdir(), "acc-deny-out-")), env: { ...process.env, ...home() } });
  assert.match(r.not_run[0].reason, /the person's Claude settings deny it \(Bash\(mmo-test-fetch:\*\)\)/);
  assert.equal(r.not_run[1].command, "tests");
  assert.deepEqual(r.not_checked, ["AC-1"]);
});
