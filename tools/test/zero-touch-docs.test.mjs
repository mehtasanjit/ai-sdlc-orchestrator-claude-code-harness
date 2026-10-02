/**
 * The documents that describe zero-touch agree with the code, and with each other.
 *
 * Why: a change to the code can leave a sentence behind in a document the change does not reopen. So the numbers a
 * document states are counted from the code here, and the names it uses are the code's:
 *   - the hook count, from plugin/hooks/hooks.json;
 *   - the hand-off tools, from the server's own list (its source file, so this test needs no build);
 *   - the settings, from the shipped settings file;
 *   - one zero-touch note in the version notes, under the plugin's own version.
 *
 * All offline: files of this repository are read, nothing is run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const MANUAL = read("docs", "ambient-mode.md");
const NOTES = read("docs", "methodology.md");
const GUIDE = read("docs", "repo-guide.md");

/** The moments zero-touch hooks: every hooks.json command that goes through its shim. */
function zeroTouchHooks() {
  // Registered by the zero-touch plugin, run through its shim into mmo's hook script.
  const hooks = JSON.parse(read("zero-touch", "hooks", "hooks.json")).hooks;
  const names = [];
  for (const entries of Object.values(hooks)) {
    for (const e of entries) for (const h of e.hooks) {
      const m = /mmo-hook\.sh" (\S+)$/.exec(h.command);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/** The hand-off tools, as the server's source names them (handoff/tools.ts, `name: "..."` inside HANDOFF_TOOLS). */
function handoffTools() {
  const src = read("plugin", "mcp", "model-dispatch", "src", "handoff", "tools.ts");
  const list = src.slice(src.indexOf("export const HANDOFF_TOOLS"));
  return [...list.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

/**
 * The version note that introduced zero-touch: the one "### v…" section of docs/methodology.md that says it "adds
 * **zero-touch**". A later release keeps it where it is and adds its own section, so this finds it by what it says,
 * not by the current version (which must still have a section of its own).
 */
function zeroTouchNote() {
  const version = JSON.parse(read("plugin", ".claude-plugin", "plugin.json")).version;
  assert.ok(NOTES.includes(`### v${version}\n`), `docs/methodology.md has a "### v${version}" section`);
  const sections = NOTES.split(/\n(?=### v)/).filter((s) => s.startsWith("### v"));
  const notes = sections.filter((s) => /^\d+\.\d+\.\d+ adds \*\*zero-touch\*\*/m.test(s));
  assert.equal(notes.length, 1, "one version note introduces zero-touch");
  return notes[0];
}

test("every document that counts zero-touch's hooks states the number hooks.json registers", () => {
  const hooks = zeroTouchHooks();
  const word = WORDS[hooks.length];
  assert.ok(word, `a number word for ${hooks.length} hooks`);
  // The manual's heading and its table: one row per hook, no row for a hook that is not registered.
  assert.match(MANUAL, new RegExp(`^## The ${word} hooks$`, "m"), `the manual's heading counts ${hooks.length}`);
  const table = MANUAL.slice(MANUAL.indexOf(`## The ${word} hooks`), MANUAL.indexOf("## What is stored"));
  const rows = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.slice().sort(), hooks.slice().sort(), "the manual's hook table lists exactly the registered hooks");
  // Every other count in the documents: "zero-touch's <number> ... hooks", "<number> zero-touch hooks".
  for (const [name, text] of [["docs/repo-guide.md", GUIDE], ["docs/methodology.md", NOTES], ["docs/ambient-mode.md", MANUAL], ["zero-touch/README.md", read("zero-touch", "README.md")]]) {
    for (const m of text.matchAll(/\b(?:zero-touch's (\w+)(?: \w+)? hooks|(\w+) zero-touch hooks)\b/gi)) {
      const stated = (m[1] ?? m[2]).toLowerCase();
      if (!WORDS.includes(stated) && !/^\d+$/.test(stated)) continue; // "its own zero-touch hooks": no number
      assert.ok(stated === word || stated === String(hooks.length), `${name} says "${m[0]}"; hooks.json registers ${hooks.length}`);
    }
  }
  assert.match(GUIDE, new RegExp(`zero-touch's ${word} hooks`), "the repo guide's hooks row counts zero-touch's hooks");
});

test("the hand-off tools the server lists are the ones the documents name, all of them", () => {
  const tools = handoffTools();
  assert.equal(tools.length, 4, `four hand-off tools in handoff/tools.ts (found ${tools.join(", ")})`);
  const note = zeroTouchNote();
  for (const tool of tools) {
    assert.ok(MANUAL.includes("`" + tool + "`"), `the manual names ${tool}`);
    assert.ok(note.includes("`" + tool + "`"), `the version note names ${tool}`);
  }
  // The architecture page counts the server's tools and lists them: the hand-off tools are four of them.
  const architecture = read("docs", "architecture.md");
  for (const tool of tools) assert.ok(architecture.includes("`" + tool + "`"), `docs/architecture.md names ${tool}`);
  assert.doesNotMatch(architecture, /exposes eight tools/, "the architecture page's tool count includes the hand-off tools");
  // No document may say the server lists the pipeline's and the executor's tools only.
  for (const [name, text] of [["docs/ambient-mode.md", MANUAL], ["docs/methodology.md", note]]) {
    assert.doesNotMatch(text, /tool list is the pipeline's and the executor's again|The pipeline's and the executor's only/, name);
  }
});

test("the documents' settings table is the shipped settings file, and the settings box's choices are named where a person chooses", async () => {
  const shipped = JSON.parse(read("plugin", "config", "ambient.default.json"));
  const section = MANUAL.slice(MANUAL.indexOf("## Settings and who may change them"), MANUAL.indexOf("## Routing a recognised task"));
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.slice().sort(), Object.keys(shipped).filter((k) => k !== "schema_version").sort());
  assert.ok(section.includes("`" + shipped.routing_defaults.auth + "`"), "the cost recording's default is the shipped one");
  // The person's zero-touch choices are not here: they are the settings box's (zero-touch/scripts/settings.mjs).
  assert.equal(shipped.handoff, undefined);
  assert.equal(shipped.routing_defaults.policy, undefined);
  const { DEFAULTS, WORKFLOW_MODELS } = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
  const choosing = MANUAL.slice(MANUAL.indexOf("## Choosing: the settings box, in the chat"), MANUAL.indexOf("## Turn it on and off"));
  for (const p of Object.keys(WORKFLOW_MODELS)) assert.ok(choosing.includes("`" + p + "`"), `the manual names the offered policy ${p}`);
  assert.ok(MANUAL.includes("`" + DEFAULTS.handoff.chat_model + "`"), "the manual names the standard chat model");
});

test("the version notes hold one note that introduced zero-touch, every version has its own section, and the note covers both modes", () => {
  const note = zeroTouchNote();
  // Builds that were never released have no section of their own.
  for (const old of ["v0.8.0", "v0.8.1", "v0.8.2", "v0.8.3"]) {
    assert.doesNotMatch(NOTES, new RegExp(`^### ${old.replace(/\./g, "\\.")}\\b`, "m"), `no separate ${old} section`);
  }
  assert.match(note, /workflow mode/i);
  assert.match(note, /hand-off mode/i);
  assert.match(note, /\]\(ambient-mode\.md\)/, "the note links the manual");
  // What a reader of cost numbers must find here: where a hand-off's bill is written, and that nothing is claimed.
  assert.match(note, /handoff-telemetry\.jsonl/);
  assert.match(note, /No dispatched event is priced differently/);
});

test("no document points a reader at a build that was never released", () => {
  const docs = {
    "README.md": read("README.md"), "SETUP.md": read("SETUP.md"), "docs/README.md": read("docs", "README.md"),
    "docs/setup.md": read("docs", "setup.md"), "docs/running.md": read("docs", "running.md"), "docs/repo-guide.md": GUIDE,
    "docs/ambient-mode.md": MANUAL, "docs/methodology.md": NOTES, "zero-touch/README.md": read("zero-touch", "README.md"),
  };
  for (const [name, text] of Object.entries(docs)) {
    // The archive's tag carries a version in its own name; it is a git name, not a pointer to a section.
    // No document names a zero-touch build other than the released one.
    const hits = text.replace(/generic-orchestrator-0\.8\.3/g, "").match(/\bv?0\.8\.[0-4]\b/g) ?? [];
    assert.deepEqual(hits, [], `${name} names a version before the plugin's first zero-touch release`);
  }
});

// Off, the third mode, changes nothing, so a document need not name it; the two that act must be named.
test("every document that introduces zero-touch names workflow mode and hand-off mode", () => {
  for (const name of ["README.md", "SETUP.md", "docs/README.md", "docs/repo-guide.md", "docs/architecture.md", "zero-touch/README.md"]) {
    const text = read(...name.split("/"));
    assert.match(text, /workflow mode/i, `${name} names workflow mode`);
    assert.match(text, /hand-off mode/i, `${name} names hand-off mode`);
  }
  // The repo guide is the map of the repository: the switch plugin's folder, the server's hand-off folder and the
  // shipped settings file are on it.
  for (const path of ["`zero-touch/`", "`plugin/mcp/model-dispatch/src/handoff/`", "`config/ambient.default.json`"]) {
    assert.ok(GUIDE.includes(path), `docs/repo-guide.md has a row for ${path}`);
  }
  // In the manual, "the hand-off" means hand-off mode's own act, never the step that starts a recognised job's
  // workflow: one meaning for one word in one page.
  assert.doesNotMatch(MANUAL, /^### The hand-off \(/m, "workflow mode's start step is not called the hand-off");
});

// The MCP server ships pre-built: no document may say an update removes its build or that setup rebuilds it.
test("no document says the MCP server must be rebuilt after an install or update", () => {
  for (const name of ["README.md", "SETUP.md", "docs/troubleshooting.md", "docs/architecture.md"]) {
    const text = read(...name.split("/"));
    assert.doesNotMatch(text, /[Rr]ebuilds the MCP server|removes the build|removes the `dist\/` and `node_modules\/`|`--fix` builds them\. \|/, `${name} says the server must be rebuilt`);
  }
});

// Every command that runs a script of the installed plugin finds it through Claude Code's own record of the install:
// `ls -d …/mmo/*/… | tail -1` takes the last folder in text order, which is not always the newest version (0.8.10
// sorts before 0.8.9), and an older copy left in the cache would then run.
test("no document finds the installed plugin by sorting cache folders", () => {
  for (const name of ["README.md", "SETUP.md", "docs/setup.md", "docs/troubleshooting.md", "docs/tutorial-first-run.md", "docs/two-gemini-paths.md"]) {
    assert.doesNotMatch(read(...name.split("/")), /ls -d ~\/\.claude\/plugins\/cache\/[^\n]*tail -1/, `${name} sorts cache folders to find the plugin`);
  }
});

// A zero-touch install ends with "start a new chat" and the guide's address: the setup guide Claude follows for an
// install tells the person nothing about an unset API key or a marketplace refresh command. The address is the one the
// first chat's welcome shows (zero-touch/scripts/messages.mjs GUIDE_URL).
test("the setup guide ends a zero-touch install at 'start a new chat', with no commands or setup checks for the person", async () => {
  const setup = read("SETUP.md");
  const { GUIDE_URL } = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
  assert.match(setup, /When the person asked to install zero-touch, the install ends here\./);
  assert.match(setup, /Do not run steps 3 to 6/);
  // The exact four lines, and nothing else.
  assert.match(setup, /reply with exactly\s+these four lines and nothing else/);
  assert.ok(setup.includes(`> Zero-touch is installed.\n> Start a new chat: plugins load when a chat starts.\n> That chat will ask you how zero-touch should work.\n> The guide, with what to type and what you'll see: ${GUIDE_URL}`));
});
