/**
 * The brownfield copies of the plugin's agents (tools/build-agent-copies.mjs), and what keeps greenfield's text its
 * own.
 *
 *   - Each copy is exactly what the build makes from its original and its section (tools/agent-copies/), so a change
 *     to an original reaches its copy, and a hand edit of a copy is caught.
 *   - The agents and the pipeline skill greenfield reads carry none of the brownfield packet flow: it lives in the
 *     copies and in skills/pipeline/brownfield-runs.md.
 *   - Every brownfield run reaches its copies: the brownfield guide and /mmo:pass name brownfield-orchestrator
 *     whatever the job, and the copy reads the runs file and delegates the other copies.
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

// A copy holds every top-level section (`# ` heading) of its original word for word, except a section the copy drops
// (the architect copy drops greenfield's executor mode, which a brownfield run never uses).
test("every copy is exactly what the build makes from its original and its section", () => {
  assert.deepEqual(COPIES.map((c) => c.name).sort(), ["brownfield-architect", "brownfield-orchestrator", "brownfield-security-reviewer", "brownfield-senior-reviewer"]);
  for (const copy of COPIES) {
    assert.equal(read("agents", `${copy.name}.md`), buildCopy(copy), `${copy.name}.md is stale or hand-edited: run node tools/build-agent-copies.mjs`);
    const original = read("agents", `${copy.base}.md`);
    const body = original.slice(original.indexOf("\n---\n", 4) + 5).replace(/\s+$/, "");
    const sections = body.split(/\n(?=# )/);
    assert.ok(sections.length > 1, `${copy.base} has top-level sections`);
    for (const s of sections) {
      const kept = s.replace(/\n+---\s*$/, "").replace(/\s+$/, "");
      const dropped = (copy.dropSections ?? []).some((h) => s.startsWith(h));
      assert.equal(read("agents", `${copy.name}.md`).includes(kept), !dropped, `${copy.name}: ${dropped ? "drops" : "holds"} ${copy.base}'s "${s.split("\n")[0].slice(0, 60)}"`);
    }
  }
});

// A copy is chosen only by name (the guide and /mmo:pass name brownfield-orchestrator; it names the others), so its
// description must not advertise it for any command: the original orchestrator's "Use whenever the user invokes
// /mmo:greenfield …" in a copy would offer the brownfield flow to greenfield runs in every session's agent list.
test("each copy's description says it serves brownfield runs only, every job, and names no command", () => {
  for (const copy of COPIES) {
    const line = read("agents", `${copy.name}.md`).split("\n").find((l) => l.startsWith("description: "));
    assert.equal(line, `description: ${copy.description}`, copy.name);
    assert.match(line, /brownfield runs only, every job/, copy.name);
    assert.doesNotMatch(line, /\/mmo:|Use whenever|greenfield/i, copy.name);
  }
});

// The orchestrator copy's reviewer contract sends paths, the output path and a suite summary ("Nothing else"), so each
// reviewer copy reads the run's starting commit from the provenance file it is given.
test("the reviewer copies read git_head_before from provenance.json, which the orchestrator's contract does not send", () => {
  const contract = read("agents", "brownfield-orchestrator.md").replace(/\s+/g, " ").split("**Reviewer input contract (brownfield).**")[1];
  assert.match(contract, /the path to `provenance\.json`,[\s\S]*?\. Nothing else/);
  assert.doesNotMatch(contract.split("Nothing else")[0], /git_head_before/);
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

// The brownfield packet flow, by the names only it uses.
const BROWNFIELD_FLOW = /execute_batch|plan-to-packets|plan-lint|brownfield-runs\.md|brownfield-orchestrator|brownfield-architect|brownfield-senior-reviewer|brownfield-security-reviewer|Lean review/;

test("the agents and the pipeline skill greenfield reads carry none of the brownfield packet flow", () => {
  for (const file of [["agents", "orchestrator.md"], ["agents", "architect.md"], ["agents", "senior-reviewer.md"], ["agents", "security-reviewer.md"], ["agents", "discovery.md"], ["skills", "pipeline", "SKILL.md"]]) {
    assert.doesNotMatch(read(...file), BROWNFIELD_FLOW, file.join("/"));
  }
});

// The one-hour cache is for a helper that waits on long calls: its writes bill 2x input against 1.25x for five
// minutes. The orchestrator waits on gates, helpers and test suites, so its copy keeps the hour. The brownfield
// architect and reviewers run no build or test, so their copies keep Claude Code's default five minutes, and say why;
// greenfield's agents keep their own settings.
test("only the orchestrator copy has a one-hour prompt cache; the architect and reviewer copies keep the default", () => {
  const head = (name) => read("agents", `${name}.md`).split("\n---\n")[0];
  assert.match(head("brownfield-orchestrator"), /^experimental:\n {2}cacheTtl: 1h$/m);
  for (const name of ["brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer"]) {
    assert.doesNotMatch(head(name), /cacheTtl|experimental:|one-hour lifetime/i, name);
    assert.match(head(name), /^# This copy keeps Claude Code's default five-minute prompt cache/m, name);
  }
  assert.match(head("architect"), /^experimental:\n {2}cacheTtl: 1h$/m, "greenfield's architect keeps its hour");
  for (const name of ["senior-reviewer", "security-reviewer"]) assert.doesNotMatch(head(name), /cacheTtl/, name);
  // A copy that asks for the default over an original whose cache block it was not told how to drop is refused.
  const copy = { ...COPIES.find((c) => c.name === "brownfield-architect"), dropHeaderFrom: undefined };
  assert.throws(() => buildCopy(copy), /cacheTtl/);
});

// Executor mode is greenfield's: in the brownfield architect copy its text and its two tools would send the architect
// down the greenfield path (spec.sections/, submit_spec_section), which a brownfield spec cannot pass.
test("the brownfield architect copy carries neither greenfield's executor mode nor its spec tools", () => {
  const arch = read("agents", "brownfield-architect.md");
  const [head, ...rest] = arch.split("\n---\n");
  const body = rest.join("\n---\n");
  assert.doesNotMatch(head.match(/^tools: .*$/m)[0], /submit_spec_section|finalize_spec/);
  assert.doesNotMatch(body, /^# Executor mode/m);
  assert.doesNotMatch(body, /spec\.sections\/|submit_spec_section|finalize_spec/);
  assert.match(read("agents", "architect.md"), /^# Executor mode/m, "greenfield's architect keeps it");
  assert.throws(() => buildCopy({ ...COPIES.find((c) => c.name === "brownfield-architect"), dropSections: ["# No such section"] }), /No such section/);
});

// Every brownfield job runs the same packet flow, so no job reaches the greenfield orchestrator: the guide's step 6
// and /mmo:pass's brownfield mode name the copy for every job, and nothing else in the brownfield guide delegates.
test("every brownfield run reaches its copies: the guide and /mmo:pass name brownfield-orchestrator whatever the job", () => {
  const guide = read("skills", "brownfield-guide", "SKILL.md");
  const step6 = guide.slice(guide.indexOf("# 6. Run the pipeline"), guide.indexOf("# 7. Close out"));
  assert.match(step6, /Delegate the `brownfield-orchestrator` subagent, whatever the job/);
  assert.doesNotMatch(step6.replace(/never `orchestrator`, which runs\ngreenfield/, ""), /`orchestrator`/, "no job is sent to the greenfield orchestrator");
  assert.doesNotMatch(guide, /feature-extend` or `feature-new`, delegate/);
  // /mmo:pass runs the guide's steps itself and delegates the copy at step 6, after Gate 0's freeze (the server writes
  // no file of a run without it), whatever the job.
  assert.match(read("commands", "pass.md").replace(/\s+/g, " "), /Only then delegate `brownfield-orchestrator` \(step 6\), whatever the `--intent`, never `orchestrator`/);
  const orch = read("agents", "brownfield-orchestrator.md");
  assert.match(orch, /skills\/pipeline\/brownfield-runs\.md/, "the copy reads the runs file");
  assert.match(orch, /\*\*Every job runs every phase\.\*\* Instead of "Intent routing — brownfield only" skipping Phase 2/);
  for (const helper of ["brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer"]) assert.match(orch + read("skills", "pipeline", "brownfield-runs.md"), new RegExp(`\`${helper}\``), helper);
  // The greenfield orchestrator does not advertise itself for brownfield commands in the agent list.
  assert.doesNotMatch(read("agents", "orchestrator.md").split("\n").find((l) => l.startsWith("description: ")), /\/mmo:brownfield|per-job aliases/);
});

// Each job's rules, as the runs file states them for the orchestrator and the architect copy for the planner, match
// what plan-to-packets enforces (lib/change-spec.mjs jobRules; its tests prove the enforcement).
test("the runs file and the architect copy state every job, and which jobs open Gate 2", () => {
  const runs = read("skills", "pipeline", "brownfield-runs.md");
  const jobs = runs.slice(runs.indexOf("## The jobs"), runs.indexOf("## Phase 2"));
  const ids = JSON.parse(read("config", "intents.json")).intents.map((i) => i.id);
  // A bugfix opens Gate 2 when code finds it design-affecting (brownfield-runs-texts.test.mjs); the rest always or never.
  for (const id of ids) assert.match(jobs, new RegExp(`\\| [^|\\n]*\`${id}\`[^|\\n]* \\| (yes|no|when design-affecting) \\|`), id);
  const gate2 = (id) => jobs.match(new RegExp(`\\| [^|\\n]*\`${id}\`[^|\\n]* \\| (yes|no|when design-affecting) \\|`))[1];
  assert.deepEqual(ids.filter((id) => gate2(id) === "yes").sort(), ["deps", "feature-extend", "feature-new", "refactor"]);
  assert.deepEqual(ids.filter((id) => gate2(id) === "when design-affecting"), ["bugfix"]);
  const architect = read("agents", "brownfield-architect.md");
  const each = architect.slice(architect.indexOf("**What each job's spec holds.**"));
  for (const id of ids) assert.match(each, new RegExp(`^- (\`[a-z-]+\`, )?\`${id}\``, "m"), id);
  assert.match(architect, /`red_checks` \(a bugfix's reproducing test only\)/);
});

// The security review reads the final diff: it runs after the senior review's refinements and the tests, as greenfield
// orders them, never at the same time as the senior review. And the reviewer, who has read the diff, decides which
// checklist items apply ("n/a — not in the touched set"); no keyword table picks a lighter review for it.
test("brownfield runs review in order, and the security reviewer has one form", () => {
  const features = read("skills", "pipeline", "brownfield-runs.md");
  const security = read("agents", "brownfield-security-reviewer.md");
  assert.doesNotMatch(features, /can run at the same time|delegate both in one message/, "no parallel reviewers");
  assert.match(features, /security review runs after the senior review's refinements and the test run/);
  assert.doesNotMatch(features, /form: light|form: full|--form=/, "no light/full switch in the flow");
  assert.doesNotMatch(security, /form: light|form: full|Pick the form/, "no light/full switch in the reviewer");
  assert.match(security, /"n\/a — not in the touched set"/, "the per-item rule stays");
});

// The architect reads the change spec's shape in its own instructions, generated from the schema its sections are
// checked against (plan-lint --shape prints the same), so the two cannot drift.
test("the brownfield architect carries the change spec's shape exactly as plan-lint --shape prints it, and the check command", async () => {
  const { changeShape } = await import(join(ROOT, "plugin", "scripts", "lib", "change-spec.mjs"));
  const text = read("agents", "brownfield-architect.md");
  assert.ok(text.includes("```\n" + (await changeShape()) + "\n```"), "the shape, verbatim");
  assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/plan-lint\.mjs" --section <output_dir>\/change\.sections\/header\.json --run-id <run_id>/);
  assert.doesNotMatch(text.split("# Brownfield runs (every job)")[1], /\{\{[A-Z_]+\}\}/, "every placeholder filled");
  assert.throws(() => buildCopy(COPIES.find((c) => c.name === "brownfield-architect"), undefined, {}), /no fill for \{\{CHANGE_SPEC_SHAPE\}\}/);
});
