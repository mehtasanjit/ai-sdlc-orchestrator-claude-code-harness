/**
 * Containment test for the two shared off-limits lists.
 *
 * HARDCODED_OFF_LIMITS is the pre-contract safety net: it is enforced with no
 * run to give a path context, and since the write hook began exiting 2 every
 * entry hard-refuses a write. OFF_LIMITS_DEFAULT is the wider list a
 * contracted run enforces from Gate 0. The first must stay a strict subset of
 * the second, and must not re-acquire the build-output or plugin-state entries
 * whose unconditional refusal broke ordinary editing in every installed repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFF_LIMITS_DEFAULT, HARDCODED_OFF_LIMITS } from "../../plugin/scripts/lib/off-limits.mjs";

test("HARDCODED_OFF_LIMITS is a strict subset of OFF_LIMITS_DEFAULT", () => {
  for (const p of HARDCODED_OFF_LIMITS) {
    assert.ok(OFF_LIMITS_DEFAULT.includes(p), `${p} is in the pre-contract net but not in the project default`);
  }
  assert.ok(
    HARDCODED_OFF_LIMITS.length < OFF_LIMITS_DEFAULT.length,
    "the pre-contract net must be narrower than the contracted list — aliasing the two is what made build output unwritable",
  );
});

test("the pre-contract net carries every credential and machine-config pattern", () => {
  for (const p of [".env", ".env.*", ".mcp.json", ".claude/settings.local.json", ".cursor/rules/**", ".git/**"]) {
    assert.ok(HARDCODED_OFF_LIMITS.includes(p), `${p} must be refused even with no contract`);
  }
});

test("the pre-contract net carries no build-output or plugin-state pattern", () => {
  for (const p of ["node_modules/**", "dist/**", "build/**", ".next/**", ".sdlc/**"]) {
    assert.ok(!HARDCODED_OFF_LIMITS.includes(p), `${p} must not be hard-blocked without a contract to scope it`);
  }
});

// One read rule and one write rule for every script that plans a change (lib/change-spec.mjs, findings-to-packets):
// the hardcoded list at any depth, as the server's writer and the hook match it, then the contract's own off_limits as
// written, both without regard to case, since macOS and Windows disks treat `.ENV` and `.env` as one file.
test("offLimitsMatch: the hardcoded list at any depth, then the contract's off_limits, case-insensitive", async () => {
  const { offLimitsMatch, matchesAtAnyDepth } = await import("../../plugin/scripts/lib/off-limits.mjs");
  assert.deepEqual(offLimitsMatch(".env"), { pattern: ".env", source: "hardcoded" });
  assert.deepEqual(offLimitsMatch("config/.env.local"), { pattern: ".env.*", source: "hardcoded" }, "at any depth");
  assert.deepEqual(offLimitsMatch("sub/.git/config"), { pattern: ".git/**", source: "hardcoded" });
  assert.deepEqual(offLimitsMatch(".ENV"), { pattern: ".env", source: "hardcoded" }, "case does not matter");
  assert.deepEqual(offLimitsMatch("Config/Secrets.yml", ["config/secrets.yml"]), { pattern: "config/secrets.yml", source: "contract" });
  assert.deepEqual(offLimitsMatch("secrets/prod.yml", ["secrets/**"]), { pattern: "secrets/**", source: "contract" });
  assert.equal(offLimitsMatch("deep/secrets/prod.yml", ["secrets/**"]), null, "a contract pattern matches as written, as the writer's does");
  assert.equal(offLimitsMatch("src/a.ts", ["secrets/**"]), null);
  assert.equal(offLimitsMatch("src/a.ts", "not a list"), null);
  assert.equal(matchesAtAnyDepth("a/b/.mcp.json", ".mcp.json"), true);
  assert.equal(matchesAtAnyDepth("a/b/x.json", ".mcp.json"), false);
});
