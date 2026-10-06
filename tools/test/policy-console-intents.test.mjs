/**
 * The policy console's per-job grid says which phases a brownfield job runs. Every job now runs the same flow
 * (skills/pipeline/brownfield-runs.md "The jobs"): the architect hands over a change spec for every job, a bugfix
 * included, and code decides from that spec whether a bugfix opens Gate 2. So no job skips the design phase, and the
 * console neither shows it as skipped nor refuses a job's override there as one that "can never fire".
 *
 * Offline, reads repo files only. It parses the tables out of the source text instead of importing policy-server.mjs,
 * which starts an HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = readFileSync(join(REPO, "plugin", "policy-console", "policy-server.mjs"), "utf-8");
/** A `const NAME = { … };` object literal of the source, evaluated (plain data: strings and arrays). */
const table = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  assert.ok(m, `${name} not found in policy-server.mjs`);
  return Function(`"use strict"; return (${m[1]});`)();
};

test("no brownfield job skips a phase in the console: the architect runs for every job, a bugfix's included", () => {
  const skipped = table("INTENT_SKIPPED_PHASES");
  for (const [job, phases] of Object.entries(skipped)) assert.deepEqual(phases, [], `${job} skips ${phases.join(", ")}`);
  const notes = table("CONDITIONAL_SKIP_NOTE");
  assert.deepEqual(Object.keys(notes), [], "a note on a skip that no longer exists");
  assert.doesNotMatch(SRC, /Skipped unless the fix is design-affecting/);
});
