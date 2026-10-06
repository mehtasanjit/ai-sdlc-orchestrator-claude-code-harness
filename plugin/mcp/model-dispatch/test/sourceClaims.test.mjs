/**
 * Comments that state what the code does, held to the code. The secret-pattern registry (scripts/dispatch-sanitize.mjs)
 * and its server port (src/redact.ts) redact log lines; no dispatch path runs either on a model's inputs (the read rule
 * keeps off-limits files out of a prompt), so neither comment may claim it blocks a dispatch. And the reason an input
 * is cached by the API adapter is the rule itself, not a pointer to a rule that does not exist. Reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(SERVER, "..", "..");
const read = (...p) => readFileSync(join(...p), "utf8");
/** The header comment of a source file (everything before its first import or code line), as one line of prose. */
const header = (text) => text.slice(0, text.search(/^(?:import|const|export|function)\b/m)).replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", "bundle"].includes(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(?:mjs|ts)$/.test(p) ? [p] : [];
  });
}

test("only the log writer imports the secret-pattern registry: nothing on a dispatch path runs it", () => {
  const importers = sources(PLUGIN).filter((f) => /^\s*import\b[^;]*?from\s+["'][^"']*dispatch-sanitize\.mjs["']/m.test(read(f))).map((f) => relative(PLUGIN, f));
  assert.deepEqual(importers, ["scripts/lib/log.mjs"]);
});

test("the registry's and the port's headers say what they do: redact log lines, never block a dispatch", () => {
  const sanitize = header(read(PLUGIN, "scripts", "dispatch-sanitize.mjs"));
  assert.doesNotMatch(sanitize, /Runs on every dispatch input|imported by MCP adapters/);
  assert.match(sanitize, /No dispatch path runs it on a model's inputs/);
  const redact = header(read(SERVER, "src", "redact.ts"));
  assert.doesNotMatch(redact, /blocks a dispatch/);
  assert.match(redact, /no dispatch path runs either on a model's inputs/);
});

test("the API adapter states its caching rule instead of pointing at a rule that does not exist", () => {
  const adapter = read(SERVER, "src", "adapters", "BuiltinAnthropicAdapter.ts");
  assert.doesNotMatch(adapter, /orchestrator\.md rule 6/);
  assert.match(adapter, /reason contains the word stable/);
});
