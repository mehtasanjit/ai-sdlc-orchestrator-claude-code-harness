/**
 * Zero-touch reads a call of the contract script with the shell's own word splitting: only a space or a tab separates
 * words (lib/own-steps.mjs contractStepCall). Another blank (a no-break space, a vertical tab, a form feed) is part of
 * a word to the shell, so a call holding one cannot be read the way the script will read it, and is no step: it keeps
 * Claude Code's prompt. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(resolve(fileURLToPath(import.meta.url), "..", "..", ".."), "plugin", "scripts");
const { contractStepCall } = await import(join(SCRIPTS, "ambient", "lib", "own-steps.mjs"));
const call = (sep) => `node "${SCRIPTS}/write-contract.mjs" --freeze${sep}--run-id A --allowlist '["src/**"]' --off-limits '[]'`;

test("a blank the shell does not split on makes the call no step", () => {
  assert.ok(contractStepCall(call(" "), SCRIPTS), "the plain call is a step");
  for (const blank of [" ", "\v", "\f", " "]) assert.equal(contractStepCall(call(blank), SCRIPTS), null, JSON.stringify(blank));
});
