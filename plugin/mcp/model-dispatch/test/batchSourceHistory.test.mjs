/**
 * The server's source states technical reasons only. A study's run id (the word Run or Runs and the run's number, as
 * RUN_ID below spells it) means something only inside that study's own notes, and one run's dollar figures (a sum "of
 * a" run's total, ONE_RUN_DOLLARS) are that run's numbers, not a reason a maintainer can check: neither belongs in a
 * comment. Reads every .ts file under src/, and the server's own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const RUN_ID = /\bRuns? \d+[a-z]?(?:\/\d+[a-z]?)*\b/;
const ONE_RUN_DOLLARS = /\$\d+(?:\.\d+)? of a \$\d+(?:\.\d+)? run\b/;

test("no comment in the server's source cites a run id or one run's dollar figures as its reason", () => {
  const hits = [];
  for (const file of tsFiles(SRC)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (RUN_ID.test(line) || ONE_RUN_DOLLARS.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// The server's tests are in the repository too, this guard included: none of them carries a study's run id or one
// run's dollar figures either.
test("no test of the server cites a run id or one run's dollar figures", () => {
  const TEST = dirname(fileURLToPath(import.meta.url));
  const mjs = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? mjs(p) : /\.m?js$/.test(p) ? [p] : [];
  });
  const hits = [];
  for (const file of mjs(TEST)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (RUN_ID.test(line) || ONE_RUN_DOLLARS.test(line)) hits.push(`${relative(TEST, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
