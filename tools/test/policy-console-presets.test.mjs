/**
 * The policy console's SHIPPED_PRESETS list names exactly the policy YAMLs
 * the plugin ships.
 *
 * The console labels each policy "preset" or "custom" by name alone, because
 * console-saved custom policies land in the same plugin/config/policies/
 * directory as the shipped files. A shipped YAML missing from the list shows
 * as "custom" (five presets once did, when the list named two), and a name
 * left on the list after its file is removed would label a user's own policy
 * of that name "preset". Nothing else fails in either case, so this pins it:
 * adding opus-plus-flash-v38 in v0.7.3 without the list entry fails here.
 *
 * Offline, reads repo files only. It parses the array out of the source text
 * instead of importing policy-server.mjs, which starts an HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("policy console SHIPPED_PRESETS equals the shipped policy YAMLs", () => {
  const src = readFileSync(join(REPO, "plugin", "policy-console", "policy-server.mjs"), "utf-8");
  const m = src.match(/const SHIPPED_PRESETS = \[([\s\S]*?)\];/);
  assert.ok(m, "SHIPPED_PRESETS array not found in policy-server.mjs");
  const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  const shipped = readdirSync(join(REPO, "plugin", "config", "policies"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
  assert.deepEqual(listed, shipped);
});
