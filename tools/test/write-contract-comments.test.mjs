/**
 * The comments around the write contract and zero-touch's steps say what the code does now.
 *
 * Why: these comments are where a reader learns when the contract binds, how a run is ended on purpose and which
 * steps run without a prompt; each one below once described an older rule. Each check reads the comment and the fact
 * it states (the code or the files it describes), so a comment that drifts from the code fails here. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const flat = (t) => t.replace(/\s*\n\s*\*?\s*/g, " ");

test("the write-contract hook's header and its hooks.json entry say a live freeze record binds without an active contract", () => {
  const header = flat(read("plugin", "scripts", "write-contract-check.mjs").split("*/")[0]);
  assert.doesNotMatch(header, /Silent no-op when no active contract file exists/);
  assert.match(header, /Silent no-op when no contract binds, unless a live freeze record says one should \(a missing or switched-off contract under a live record refuses every write\)/);
  const entry = JSON.parse(read("plugin", "hooks", "hooks.json")).hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("write-contract-check.mjs")));
  assert.doesNotMatch(entry._comment, /absent or its active flag is false/);
  assert.match(entry._comment, /every write while a live run's contract no longer matches its freeze record/);
  assert.match(entry._comment, /always-off-limits list/);
});

test("zero-touch's stop says it ends a run as write-contract.mjs --abandon does", () => {
  const text = read("plugin", "scripts", "ambient", "lib", "workflow-log.mjs");
  const doc = flat(text.slice(text.lastIndexOf("/**", text.indexOf("export function abortRun")), text.indexOf("export function abortRun")));
  assert.doesNotMatch(doc, /brownfield manual's abort step/);
  assert.match(doc, /as `write-contract\.mjs --abandon` does: the run's end logged, then its contract switched off/);
});

test("the comments on mmo's agents name no count: plugin/agents holds more than the five drivers", () => {
  const agents = readdirSync(join(ROOT, "plugin", "agents")).filter((f) => f.endsWith(".md"));
  assert.ok(agents.length > 5, `plugin/agents holds ${agents.length}`);
  assert.doesNotMatch(read("plugin", "scripts", "ambient", "hook.mjs"), /five mmo agents/i);
  assert.doesNotMatch(read("zero-touch", "hooks", "hooks.json"), /five mmo agents/i);
  assert.match(read("plugin", "scripts", "ambient", "hook.mjs"), /The mmo agents belong to a workflow run/);
});

test("the own-steps list says that allowing plan-lint allows the change spec's file checks it runs", async () => {
  const { OWN_SCRIPTS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "own-steps.mjs"));
  assert.ok(OWN_SCRIPTS.has("plan-lint.mjs"));
  // The fact the comment states: plan-lint runs the header's file checks (lib/change-spec.mjs baselineErrors).
  assert.match(read("plugin", "scripts", "plan-lint.mjs"), /baselineErrors/);
  const text = read("plugin", "scripts", "ambient", "lib", "own-steps.mjs");
  const doc = flat(text.slice(text.lastIndexOf("/**", text.indexOf("export const OWN_SCRIPTS")), text.indexOf("export const OWN_SCRIPTS")));
  assert.match(doc, /plan-lint\.mjs also runs the change spec's file checks/);
  assert.match(doc, /Allowing plan-lint without a prompt allows those commands too/);
});

test("mmo-log.mjs says why it refuses the contract's freeze record", () => {
  const header = flat(read("plugin", "scripts", "mmo-log.mjs").split("*/")[0]);
  assert.match(header, /One refusal \(exit 2\): the write contract's freeze record/);
  assert.match(header, /only write-contract\.mjs writes it/);
});
