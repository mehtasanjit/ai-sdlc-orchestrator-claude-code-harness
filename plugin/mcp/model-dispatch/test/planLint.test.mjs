/**
 * Pins for plugin/scripts/plan-lint.mjs — the Phase 2 gate that refuses a
 * brownfield change_plan.md carrying the program instead of the spec (cost
 * plan Row 4). Pure-function cases through lintPlan(); two spawn cases for the
 * exit-code contract the orchestrator acts on. No dist/ dependency, kept in
 * this suite so it runs with the other script pins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "plan-lint.mjs");
const { lintPlan, formatReport, DEFAULTS } = await import(pathToFileURL(SCRIPT).href);

const fence = (n, lang = "ts") => ["```" + lang, ...Array.from({ length: n }, (_, i) => `line ${i + 1}`), "```"].join("\n");

const SPEC = `# Change plan
## House style
- Biome, 2-space, double quotes, width 80.
## A1 — apps/api/src/user/public-profile.ts
File: \`apps/api/src/user/public-profile.ts\` · Action: new_file
Exports:
${fence(3)}
Behavior:
1. trim; empty → DEFAULT.
2. matches \`^/api/user/avatar/[A-Za-z0-9_-]+$\` → as-is.
Mirror: apps/api/src/user/avatar.ts:1-20
Verify: npx biome check {path}
`;

test("a spec-shaped plan passes with stats", () => {
  const r = lintPlan(SPEC);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.stats, { fencedBlocks: 1, fencedLines: 3, sections: 3, planLines: 16 });
});

test("a fenced block longer than the limit fails and names its section", () => {
  const r = lintPlan(`## A1 — x.ts\nContract:\n${fence(13)}\n`);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, "block_too_long");
  assert.equal(r.violations[0].section, "A1 — x.ts");
  assert.equal(r.violations[0].line, 3);
  assert.equal(lintPlan(`## A1\n${fence(12)}\n`).ok, true, "12 lines is the limit, inclusive");
});

test("a 'Content:' body is refused even when its block is short", () => {
  for (const heading of ["Content:", "**Content:**", "Full file", "Complete file:", "File contents"]) {
    const r = lintPlan(`## A2 — y.ts\n${heading}\n${fence(4)}\n`);
    assert.equal(r.ok, false, heading);
    assert.equal(r.violations[0].kind, "literal_body", heading);
  }
  // A heading is a heading, not a body marker; and prose mentioning content is fine.
  assert.equal(lintPlan("## Content model\nThe content field is text.\n").ok, true);
});

test("many short blocks that add up past the total limit fail once, at the whole-plan level", () => {
  const blocks = Array.from({ length: 20 }, (_, i) => `## A${i}\n${fence(10)}`).join("\n");
  const r = lintPlan(blocks);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations.map((v) => v.kind), ["too_much_fenced_text"]);
  assert.equal(r.stats.fencedLines, 200);
  assert.equal(lintPlan(blocks, { maxFencedLines: 200 }).ok, true, "limits are configurable");
});

test("an unterminated fence is a violation, not a silent pass", () => {
  const r = lintPlan("## A1\n```ts\nconst x = 1;\n");
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "unterminated_fence");
});

test("defaults are the documented ones", () => {
  assert.deepEqual(DEFAULTS, { maxBlockLines: 12, maxFencedLines: 150 });
});

test("CLI: exit 0 on a clean plan, 1 with the report on stderr for a literal plan, 2 for a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-lint-"));
  try {
    const good = join(dir, "good.md");
    writeFileSync(good, SPEC);
    const ok = spawnSync(process.execPath, [SCRIPT, good], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /plan-lint ok/);

    const bad = join(dir, "bad.md");
    writeFileSync(bad, `## A1 — x.ts\nContent:\n${fence(40)}\n`);
    const fail = spawnSync(process.execPath, [SCRIPT, bad], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /plan-lint FAILED/);
    assert.match(fail.stderr, /L2 \[A1 — x\.ts\] literal_body/);
    assert.match(fail.stderr, /L3 \[A1 — x\.ts\] block_too_long: fenced block of 40 lines/);
    assert.match(fail.stderr, /Re-delegate the architect/);

    const json = spawnSync(process.execPath, [SCRIPT, bad, "--json"], { encoding: "utf8" });
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).violations.length, 2);

    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, "nope.md")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notes (advisory, never failing): `### Edits` form and a plan past the line budget", () => {
  const units = Array.from({ length: 70 }, (_, i) => `## A${i + 1} — f${i}.ts\n\n- **File** \`f${i}.ts\` · **Action** \`new_file\`\n- **Behavior**\n  1. a\n  2. b\n  3. c\n  4. d\n  5. e\n`).join("\n");
  const r = lintPlan(`# Plan\n\n## A0 — x.ts\n\n### Edits\n\n- **L3** \`x\` → after\n\n${units}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.map((n) => n.kind), ["edit_sites_form", "long_plan"]);
  assert.ok(r.stats.planLines > 500);
  assert.match(formatReport("p.md", r), /^plan-lint ok: .*\n  note L5 \[Edits\] edit_sites_form/);
  assert.deepEqual(lintPlan("## A1 — a.ts\n\n- **Edit anchor**\n  - after `:3` `x`\n").notes, []);
});
