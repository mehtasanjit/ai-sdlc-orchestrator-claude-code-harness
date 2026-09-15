/**
 * No tracked source, doc or config file under plugin/ or tools/ may contain a
 * raw NUL (0x00) byte.
 *
 * Why: v0.7.3 briefly used a literal NUL as a grouping-key separator in
 * plugin/scripts/collect-orchestrator-usage.mjs (priceMessages) and
 * plugin/mcp/model-dispatch/src/routing.ts (simulatePolicyCost). One NUL makes
 * ripgrep, and any grep that skips binary files, treat the whole file as binary
 * and skip it WITHOUT a warning. The repo's rule is to grep for every stale
 * passage before calling a change done, and that check silently could not see
 * the release's two core pricing files. A separator written as the six-character
 * escape (backslash, u, 0000) produces the same string at run time and keeps the
 * file text.
 *
 * Files come from `git ls-files` (tracked files only, so node_modules and dist
 * are never read); a checkout without git walks the two trees instead, skipping
 * node_modules and dist, so the check never passes by reading nothing.
 * $0, offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEXT = /\.(?:ts|mts|mjs|cjs|js|md|ya?ml|jsonl?|sh)$/;

function listFiles() {
  const git = spawnSync("git", ["ls-files", "-z", "--", "plugin", "tools"], { cwd: ROOT, encoding: "utf-8" });
  if (git.status === 0 && git.stdout) return git.stdout.split("\0").filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "plugin"));
  walk(join(ROOT, "tools"));
  return out;
}

test("no tracked text file under plugin/ or tools/ contains a raw NUL byte, so search tools never skip it as binary", () => {
  const files = listFiles().filter((f) => TEXT.test(f));
  assert.ok(files.length > 100, `expected the repo's source files, found ${files.length}`);
  assert.ok(files.includes("plugin/scripts/collect-orchestrator-usage.mjs"), "the collector must be among the files checked");
  const offenders = [];
  for (const f of files) {
    const bytes = readFileSync(join(ROOT, f));
    if (!bytes.includes(0)) continue;
    const lines = bytes.toString("latin1").split("\n").flatMap((l, i) => (l.includes("\0") ? [i + 1] : []));
    offenders.push(`${f} (line ${lines.join(", ")})`);
  }
  assert.deepEqual(offenders, [], `raw NUL bytes make ripgrep skip these files as binary; write the separator as an escape instead: ${offenders.join("; ")}`);
});
