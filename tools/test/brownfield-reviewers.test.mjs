/**
 * Brownfield delegates its own copies of the two reviewers so they can carry a one-hour prompt cache
 * without changing greenfield's reviewers. The copies must not drift: same body, and a frontmatter that
 * differs only in name, description and the cache lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "agents");
const split = (md) => {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "agent file has no frontmatter block");
  return { head: m[1], body: m[2] };
};

for (const name of ["senior-reviewer", "security-reviewer"]) {
  test(`brownfield-${name} is ${name} with a one-hour cache and nothing else changed`, () => {
    const shared = split(readFileSync(join(AGENTS, `${name}.md`), "utf-8"));
    const copy = split(readFileSync(join(AGENTS, `brownfield-${name}.md`), "utf-8"));
    assert.equal(copy.body, shared.body, `edit ${name}.md and brownfield-${name}.md together`);
    assert.match(copy.head, /^experimental:\n {2}cacheTtl: 1h$/m);
    assert.doesNotMatch(shared.head, /cacheTtl/, "greenfield's reviewer keeps Claude Code's default cache");
    const keep = (head) => head.split("\n").filter((l) => !/^(name|description):|^#|^experimental:|^ {2}cacheTtl:/.test(l));
    assert.deepEqual(keep(copy.head), keep(shared.head));
  });
}
