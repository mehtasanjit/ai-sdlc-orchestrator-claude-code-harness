/**
 * The architect's tools list is one list for every mode, so it carries Bash (executor mode's registry lookups)
 * into brownfield and the design.md flow too. There the brownfield write contract checks only the tools its
 * hook matches (Write and Edit); a shell write is not checked. The instructions for those flows therefore say
 * to write only with the tools the contract checks, and to leave the shell alone.
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const md = readFileSync(join(REPO, "plugin", "agents", "architect.md"), "utf-8");
const flat = (s) => s.replace(/\s+/g, " ");
const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
const designFlow = flat(body.slice(0, body.indexOf("# Executor mode")));
const executor = flat(body.slice(body.indexOf("# Executor mode"), body.indexOf("# Brownfield mode")));
const brownfield = flat(body.slice(body.indexOf("# Brownfield mode")));

// The tools the brownfield write-contract hook checks, read from its matcher.
const hooks = JSON.parse(readFileSync(join(REPO, "plugin", "hooks", "hooks.json"), "utf-8"));
const contract = hooks.hooks.PreToolUse.find((h) => h.hooks.some((c) => /write-contract-check\.mjs/.test(c.command)));
const checked = new RegExp(`^(?:${contract.matcher})$`);

test("the architect keeps Bash in its tools for executor mode's lookups", () => {
  const tools = md.match(/^tools:\s*(.*)$/m)[1].split(",").map((t) => t.trim());
  assert.ok(tools.includes("Bash") && tools.includes("Write") && tools.includes("Edit"), `tools: ${tools.join(", ")}`);
  assert.match(executor, /The shell\*\* is for looking things up/);
});

test("in brownfield the architect writes only with Write or Edit, which the write contract checks, and never with Bash", () => {
  assert.match(brownfield, /write `change_plan\.md` only with Write or Edit/i);
  assert.match(brownfield, /[Tt]he write contract checks every Write and Edit/);
  assert.match(brownfield, /Do not use Bash in brownfield mode/);
  for (const tool of ["Write", "Edit"]) assert.ok(checked.test(tool), `the write-contract hook checks ${tool}`);
});

test("outside executor mode the design.md flow writes only with Write or Edit and never with Bash", () => {
  assert.match(designFlow, /Outside executor mode, write only with Write or Edit, never with Bash/);
  assert.match(designFlow, /Bash is for executor mode's registry lookups only/);
});
