/**
 * Edges the round-2 checks proved after the lanes were put together, each against the built server code. No model.
 *   - A command string another shell runs (sh -c, bash -c, eval) is a command no reading of its text can name before it
 *     runs: hidden, so the server refuses it while the person has any Bash deny rule, as it refuses a substitution.
 *   - The deny check reads every run of blanks as one space in a rule too, as zero-touch's hook does (bash-rules.mjs).
 *   - A site check never counts a final line end alone as a change outside the sites: appending after the last line of
 *     a file with no final line end, and a whole-file answer that adds that line end, keep to their sites.
 *   - A link that is the file itself and points nowhere yet is followed when the write is judged, as the hook follows it
 *     (write-contract-check.mjs realPath): the write lands where the link points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { shellCommands, commandUnchecked, commandDeniedBy, siteProblem, checkWriteContract } = await import(join(DIST, "apply.js"));

test("a command string run by another shell, or by eval, is hidden from the deny check", () => {
  for (const cmd of ["sh -c 'rm -rf x'", "bash -lc \"rm x\"", "/bin/zsh -c 'rm x'", "dash -ec 'rm x'", "eval 'rm x'", "true && sh -c 'rm x'"]) {
    assert.ok("hidden" in shellCommands(cmd), cmd);
    assert.ok(commandUnchecked(cmd), cmd);
  }
  for (const cmd of ["sh scripts/check.sh 'a b'", "grep -c x file.txt", "bash scripts/lint.sh"]) {
    assert.ok(!("hidden" in shellCommands(cmd)), `${cmd} runs no string: it stays readable`);
  }
});

test("a deny rule written with a run of blanks matches the command as the hook reads it", () => {
  const home = mkdtempSync(join(tmpdir(), "mmo-deny-blanks-"));
  const proj = join(home, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(npm  publish)", "Bash(rm:*)"] } }));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), MMO_MANAGED_SETTINGS: join(home, "none.json") };
  try {
    assert.equal(commandDeniedBy("npm publish", proj, env), "Bash(npm  publish)");
    assert.equal(commandDeniedBy("npm\tpublish", proj, env), "Bash(npm  publish)");
    assert.equal(commandDeniedBy("rm\t-rf x", proj, env), "Bash(rm:*)");
    assert.equal(commandDeniedBy("npm test", proj, env), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a final line end alone is no change outside the sites", () => {
  const before = "a\nb\nc"; // no final line end
  assert.equal(siteProblem(before, "a\nb\nc\nd\n", [{ id: "S1", at: "insert_after", from: 3, to: 3 }]), null, "an append after the last line");
  assert.equal(siteProblem(before, "a\nB\nc\n", [{ id: "S1", at: "replace", from: 2, to: 2 }]), null, "a whole-file answer that adds the final line end");
  assert.ok(siteProblem(before, "a\nB\nC\n", [{ id: "S1", at: "replace", from: 2, to: 2 }]), "a line outside the sites still counts");
});

test("a link that points nowhere yet is judged where it points: outside the project, or into an off-limits name", () => {
  const base = mkdtempSync(join(tmpdir(), "mmo-dangling-"));
  const proj = join(base, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  symlinkSync(join(base, "outside", "x.txt"), join(proj, "src", "out.txt"));
  symlinkSync("../.env", join(proj, "src", "env.txt"));
  try {
    const out = checkWriteContract(proj, "src/out.txt");
    assert.equal(out.allowed, false, out.reason);
    assert.match(out.reason, /through a link/);
    const env = checkWriteContract(proj, "src/env.txt");
    assert.equal(env.allowed, false, env.reason);
    assert.equal(checkWriteContract(proj, "src/plain.txt").allowed, true, "a plain new file is still allowed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
