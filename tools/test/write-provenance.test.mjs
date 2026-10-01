/**
 * A file written twice in one run (a retry, or two packets on the same file) keeps the run's first
 * snapshot, so /mmo:revert restores the original and not an earlier attempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "scripts", "write-provenance.mjs");
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--run-id=r1", `--project-root=${root}`], { cwd: root, encoding: "utf8" });

test("a second write in the same run keeps the first backup and sha_before, and records the final sha_after", () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "original\n");
    run(root, "--init");
    run(root, "--before", "--path=a.ts", "--packet-id=p1");
    writeFileSync(join(root, "a.ts"), "attempt 1\n");
    run(root, "--after", "--path=a.ts", "--packet-id=p1");
    run(root, "--before", "--path=a.ts", "--packet-id=p1");
    writeFileSync(join(root, "a.ts"), "attempt 2\n");
    run(root, "--after", "--path=a.ts", "--packet-id=p1");

    const prov = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "r1", "provenance.json"), "utf8"));
    const recs = prov.files_touched.filter((r) => r.path === "a.ts");
    assert.equal(recs.length, 1, "one record per path per run");
    assert.equal(readFileSync(join(root, recs[0].backup_path), "utf8"), "original\n", "backup is the original");
    assert.notEqual(recs[0].sha_after, null);
    assert.notEqual(recs[0].sha_after, recs[0].sha_before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
