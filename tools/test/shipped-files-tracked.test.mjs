/**
 * Every file the plugins ship, and every test, is known to git.
 *
 * Why: a runtime file left untracked while the code that loads it is tracked is left out of a commit of the tracked
 * changes alone (`git commit -a`), and a GitHub install then ships code that cannot load it. A new file must be
 * added (or marked with `git add -N`) before this passes. Skipped where there is no git checkout (an installed copy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
const SKIP = !existsSync(join(ROOT, ".git")) || git(["--version"]).status !== 0 ? "not a git checkout" : false;

test("no shipped file or test is unknown to git", { skip: SKIP }, () => {
  const r = git(["ls-files", "--others", "--exclude-standard", "--", "plugin", "zero-touch", "tools", ".claude-plugin"]);
  assert.equal(r.status, 0, r.stderr);
  const untracked = r.stdout.split("\n").filter(Boolean);
  assert.deepEqual(untracked, [], `add these to git (or git add -N) so a commit cannot leave them out:\n${untracked.join("\n")}`);
});
