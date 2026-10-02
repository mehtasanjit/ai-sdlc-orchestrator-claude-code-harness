/**
 * The brownfield feature-run copies of the plugin's agents (tools/build-agent-copies.mjs), and what keeps every
 * other run's text its own.
 *
 *   - Each copy is exactly what the build makes from its original and its section (tools/agent-copies/), so a change
 *     to an original reaches its copy, and a hand edit of a copy is caught.
 *   - The agents and the pipeline skill every other run reads (greenfield, and the brownfield jobs bugfix, docs,
 *     test, refactor and deps) carry none of the feature-run flow: it lives in the copies and in
 *     skills/pipeline/brownfield-features.md.
 *   - A feature run reaches its copies: the brownfield guide and /mmo:pass name brownfield-orchestrator for
 *     feature-extend and feature-new, and the copy reads the features file and delegates the other copies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const read = (...p) => readFileSync(join(PLUGIN, ...p), "utf8");
const { COPIES, buildCopy } = await import(join(ROOT, "tools", "build-agent-copies.mjs"));

test("every copy is exactly what the build makes from its original and its section", () => {
  assert.deepEqual(COPIES.map((c) => c.name).sort(), ["brownfield-architect", "brownfield-orchestrator", "brownfield-security-reviewer", "brownfield-senior-reviewer"]);
  for (const copy of COPIES) {
    assert.equal(read("agents", `${copy.name}.md`), buildCopy(copy), `${copy.name}.md is stale or hand-edited: run node tools/build-agent-copies.mjs`);
    const original = read("agents", `${copy.base}.md`);
    const body = original.slice(original.indexOf("\n---\n", 4) + 5).replace(/\s+$/, "");
    assert.ok(read("agents", `${copy.name}.md`).includes(body), `${copy.name} holds ${copy.base}'s whole text`);
  }
});

// A copy is chosen only by name (the guide and /mmo:pass name brownfield-orchestrator; it names the others), so its
// description must not advertise it for any command: the original orchestrator's "Use whenever the user invokes
// /mmo:greenfield …" in a copy would offer the feature-run flow to greenfield runs in every session's agent list.
test("each copy's description says it serves feature-extend and feature-new runs only and names no command", () => {
  for (const copy of COPIES) {
    const line = read("agents", `${copy.name}.md`).split("\n").find((l) => l.startsWith("description: "));
    assert.equal(line, `description: ${copy.description}`, copy.name);
    assert.match(line, /brownfield feature-extend and feature-new runs only/, copy.name);
    assert.doesNotMatch(line, /\/mmo:|Use whenever|greenfield/i, copy.name);
  }
});

// The orchestrator copy's reviewer contract sends paths only ("Nothing else"), so each reviewer copy reads the run's
// starting commit from the provenance file it is given, as the reviewers did before the copies existed.
test("the reviewer copies read git_head_before from provenance.json, which the orchestrator's contract does not send", () => {
  assert.match(read("agents", "brownfield-orchestrator.md"), /and the path to `provenance\.json`\. Nothing else/);
  for (const name of ["brownfield-senior-reviewer", "brownfield-security-reviewer"]) {
    const text = read("agents", `${name}.md`);
    assert.match(text, /read `git_head_before` from `provenance\.json`/, name);
    assert.doesNotMatch(text, /orchestrator also passes `git_head_before`/, name);
  }
});

test("a change to an original reaches its copy on the next build", () => {
  const copy = COPIES.find((c) => c.name === "brownfield-senior-reviewer");
  const changed = (p) => (p.endsWith("senior-reviewer.md") && !p.includes("brownfield") ? readFileSync(p, "utf8").replace("You are a senior code reviewer.", "You are a careful senior code reviewer.") : readFileSync(p, "utf8"));
  assert.match(buildCopy(copy, changed), /You are a careful senior code reviewer\./);
});

// The feature-run flow, by the names only it uses.
const FEATURE_FLOW = /execute_batch|plan-to-packets|plan-lint|packet-groups|packet-worker|brownfield-features\.md|brownfield-orchestrator|brownfield-architect|brownfield-senior-reviewer|brownfield-security-reviewer|Lean review/;

test("the agents and the pipeline skill every other run reads carry none of the feature-run flow", () => {
  for (const file of [["agents", "orchestrator.md"], ["agents", "architect.md"], ["agents", "senior-reviewer.md"], ["agents", "security-reviewer.md"], ["agents", "discovery.md"], ["skills", "pipeline", "SKILL.md"]]) {
    assert.doesNotMatch(read(...file), FEATURE_FLOW, file.join("/"));
  }
  // Greenfield's reviewers keep Claude Code's default prompt cache; the copies have an hour.
  for (const name of ["senior-reviewer", "security-reviewer"]) {
    assert.doesNotMatch(read("agents", `${name}.md`).split("\n---\n")[0], /cacheTtl/, name);
    assert.match(read("agents", `brownfield-${name}.md`).split("\n---\n")[0], /^experimental:\n {2}cacheTtl: 1h$/m, `brownfield-${name}`);
  }
});

test("a feature run reaches its copies: the guide and /mmo:pass name brownfield-orchestrator for feature-extend and feature-new only", () => {
  const guide = read("skills", "brownfield-guide", "SKILL.md");
  assert.match(guide, /for intent\n`feature-extend` or `feature-new`, delegate `brownfield-orchestrator` instead/);
  assert.match(read("commands", "pass.md"), /With `--intent=feature-extend` or\n`--intent=feature-new`, invoke `brownfield-orchestrator` instead of `orchestrator`\./);
  const orch = read("agents", "brownfield-orchestrator.md");
  assert.match(orch, /skills\/pipeline\/brownfield-features\.md/, "the copy reads the features file");
  for (const helper of ["brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer", "packet-worker"]) assert.match(orch + read("skills", "pipeline", "brownfield-features.md"), new RegExp(`\`${helper}\``), helper);
});
