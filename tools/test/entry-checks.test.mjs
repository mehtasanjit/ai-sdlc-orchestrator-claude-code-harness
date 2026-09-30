/**
 * A script run directly must run however its path is spelled. Node gives a module its real path as
 * import.meta.url, while process.argv[1] keeps the spelling the caller used: a plugin folder reached
 * through a symlink, or a temp folder such as /var against /private/var on macOS. A script that compared
 * the two as written did nothing and exited 0, which reads as success.
 *
 * Each script is run with an argument it refuses, so a run that reaches the script's own code fails
 * loudly and a skipped one exits 0 silently. $0, offline: nothing is read or written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(ROOT, "plugin", "scripts");

/** The scripts folder and one script, each reached through a symlink in a temp folder (itself a symlink on macOS). */
function spellings(script) {
  const base = mkdtempSync(join(tmpdir(), "entry-"));
  symlinkSync(SCRIPTS, join(base, "scripts"));
  symlinkSync(join(SCRIPTS, script), join(base, script));
  return [join(SCRIPTS, script), join(base, "scripts", script), join(base, script), join(base, "scripts", "..", "scripts", script)];
}

const run = (path, args) => spawnSync(process.execPath, [path, ...args], { encoding: "utf8", cwd: tmpdir(), timeout: 60_000 });

for (const [script, args, says] of [
  ["collect-orchestrator-usage.mjs", ["--no-such-flag"], /collect-orchestrator-usage FAILED: unknown argument '--no-such-flag'/],
  ["driver-model-check.mjs", ["--no-such-flag"], /driver-model-check FAILED: unknown argument '--no-such-flag'/],
  ["verify-setup.mjs", ["--enable-agent", "--disable-agent"], /--enable-agent and --disable-agent contradict each other/],
]) {
  test(`${script} runs when started through a symlinked or differently spelled path`, () => {
    for (const path of spellings(script)) {
      const r = run(path, args);
      assert.equal(r.status, 1, `${path}: exit ${r.status}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout + r.stderr, says, path);
    }
  });
}
