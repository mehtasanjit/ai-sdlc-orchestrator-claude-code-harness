/**
 * Guards the seven per-job brownfield commands (MMO-D9, §5.2 of
 * docs/mmo-v1-planning/MMO-V1-TICKET.md): plugin/config/intents.json, the
 * Intent matrix in pipeline/SKILL.md, the seven command files, and the
 * README table all have to agree on the same seven ids, or they drift with
 * nothing to catch it — exactly the problem this registry replaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const INTENTS = JSON.parse(read("plugin", "config", "intents.json"));
const REGISTRY_IDS = INTENTS.intents.map((i) => i.id);

// Command file for each intent id. Not a straight `${id}.md` — feature-* and
// bugfix/docs/refactor/test/deps all happen to match, so this is really the
// identity map, kept explicit so a future rename doesn't silently break it.
const COMMAND_FILE = Object.fromEntries(REGISTRY_IDS.map((id) => [id, `${id}.md`]));

test("intents.json is well-formed: six required string fields, interview has 2-4 entries, ids are kebab-case", () => {
  assert.equal(INTENTS.schema_version, 1);
  assert.ok(Array.isArray(INTENTS.intents) && INTENTS.intents.length > 0);
  for (const intent of INTENTS.intents) {
    for (const field of ["id", "title", "example", "argument_hint", "summary"]) {
      assert.equal(typeof intent[field], "string", `intent '${intent.id}' is missing '${field}'`);
      assert.ok(intent[field].length > 0, `intent '${intent.id}'.${field} is empty`);
    }
    assert.match(intent.id, /^[a-z][a-z-]*$/, `intent id '${intent.id}' must be kebab-case`);
    assert.ok(Array.isArray(intent.interview), `intent '${intent.id}'.interview must be an array`);
    assert.ok(
      intent.interview.length >= 2 && intent.interview.length <= 4,
      `intent '${intent.id}'.interview must have 2-4 entries, has ${intent.interview.length}`,
    );
  }
  for (const intent of INTENTS.intents) {
    if (intent.task_types === undefined) continue; // optional — only `docs` declares it today
    assert.ok(Array.isArray(intent.task_types) && intent.task_types.length >= 2, `intent '${intent.id}'.task_types must be an array of 2+ options when present`);
    const taskTypeIds = new Set();
    for (const opt of intent.task_types) {
      assert.match(opt.id, /^[a-z][a-z_]*$/, `intent '${intent.id}'.task_types has a non-snake_case id '${opt.id}'`);
      assert.ok(typeof opt.label === "string" && opt.label.length > 0, `intent '${intent.id}'.task_types.${opt.id} is missing a label`);
      taskTypeIds.add(opt.id);
    }
    assert.equal(taskTypeIds.size, intent.task_types.length, `intent '${intent.id}'.task_types has a duplicate id`);
  }

  const ids = new Set(REGISTRY_IDS);
  assert.equal(ids.size, REGISTRY_IDS.length, "duplicate intent id in intents.json");
});

test("the registry ids match the Intent matrix rows in pipeline/SKILL.md", () => {
  const skill = read("plugin", "skills", "pipeline", "SKILL.md");
  const matrixIds = [...skill.matchAll(/^\| \*\*([a-z-]+)\*\* \|/gm)].map((m) => m[1]);
  assert.ok(matrixIds.length > 0, "could not find the Intent matrix rows in pipeline/SKILL.md");
  assert.deepEqual(
    [...REGISTRY_IDS].sort(),
    [...matrixIds].sort(),
    "intents.json ids and the Intent matrix rows have drifted apart",
  );
});

test("every intent has a command file, and the file names its own intent and no other", () => {
  for (const id of REGISTRY_IDS) {
    const file = COMMAND_FILE[id];
    const body = read("plugin", "commands", file);
    assert.match(
      body,
      new RegExp(`\`intent: ${id}\``),
      `${file} must contain an 'intent: ${id}' line`,
    );
    for (const other of REGISTRY_IDS) {
      if (other === id) continue;
      assert.ok(
        !body.includes(`\`intent: ${other}\``),
        `${file} names intent '${other}' as well as its own — a job command must carry exactly one intent`,
      );
    }
  }
});

test("every job command's argument-hint and description match the registry", () => {
  for (const intent of INTENTS.intents) {
    const body = read("plugin", "commands", COMMAND_FILE[intent.id]);
    const hintLine = body.match(/^argument-hint:\s*"([^"]*)"/m);
    assert.ok(hintLine, `${COMMAND_FILE[intent.id]} has no argument-hint`);
    assert.equal(
      hintLine[1],
      intent.argument_hint,
      `${COMMAND_FILE[intent.id]}'s argument-hint does not match intents.json`,
    );
  }
});

test("plugin/commands/brownfield.md sets neither intent nor seed_description", () => {
  const body = read("plugin", "commands", "brownfield.md");
  assert.ok(!/`intent: [a-z-]+`/.test(body), "brownfield.md must not pre-select an intent");
});

test("the seven job commands all point at the shared brownfield-guide skill", () => {
  for (const id of REGISTRY_IDS) {
    const body = read("plugin", "commands", COMMAND_FILE[id]);
    assert.match(
      body,
      // The installed plugin's own copy: a repository path exists only in a clone (tools/test/plugin-paths.test.mjs).
      /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/brownfield-guide\/SKILL\.md/,
      `${COMMAND_FILE[id]} must delegate to brownfield-guide/SKILL.md, not duplicate its own manual`,
    );
  }
});

test("README documents all seven job commands with their intent id", () => {
  const readme = read("README.md");
  for (const id of REGISTRY_IDS) {
    assert.ok(readme.includes(`/mmo:${id}`), `README does not mention /mmo:${id}`);
  }
  assert.match(readme, /Thirteen commands/, "README's command count was not updated for the seven new commands");
});

test("docs's task_types match the doc_addition/doc_update ids pipeline/SKILL.md's planner expects", () => {
  const docs = INTENTS.intents.find((i) => i.id === "docs");
  assert.ok(docs?.task_types, "the docs intent should declare task_types");
  const ids = docs.task_types.map((t) => t.id).sort();
  assert.deepEqual(ids, ["doc_addition", "doc_update"]);

  const skill = read("plugin", "skills", "pipeline", "SKILL.md");
  for (const id of ids) {
    assert.match(skill, new RegExp("`" + id + "`"), `pipeline/SKILL.md no longer mentions task_type '${id}'`);
  }
});
