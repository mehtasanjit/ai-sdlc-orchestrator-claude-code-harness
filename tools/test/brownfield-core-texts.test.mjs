/**
 * The shared texts a brownfield run reads besides its own (the pipeline skill, /mmo:pass, the discovery agent, the
 * stack adapters), checked against the flow the code runs: the architect's change spec, packets derived from it by
 * code (lib/change-spec.mjs derivePackets), and the write contract Gate 0 freezes. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const SKILL = read("plugin", "skills", "pipeline", "SKILL.md");
const PASS = read("plugin", "commands", "pass.md");
const DISCOVERY = read("plugin", "agents", "discovery.md");
const STACKS = Object.fromEntries(readdirSync(join(ROOT, "plugin", "skills", "pipeline", "stacks")).map((f) => [f, read("plugin", "skills", "pipeline", "stacks", f)]));
/** /mmo:pass's brownfield section: from its heading to the end. */
const PASS_BF = PASS.slice(PASS.indexOf("## Brownfield-mode flags"));

// /mmo:pass --mode=brownfield must not delegate brownfield-orchestrator before Gate 0: the orchestrator is invoked
// after Gate 0 (orchestrator.md), and the server writes no file without the contract Gate 0 freezes, so a run
// delegated first gets every packet back as an error, after the premium phases are paid for. The session runs the
// guide's steps itself, the flags answering its questions, and delegates only after the freeze.
test("/mmo:pass --mode=brownfield runs the brownfield guide's steps, Gate 0's freeze included, before it delegates", () => {
  assert.ok(PASS_BF.length > 0, "the brownfield section was found");
  const f = flat(PASS_BF);
  assert.match(f, /follow the brownfield guide \(`\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/brownfield-guide\/SKILL\.md`\) yourself, in this session, from step 1 to step 7/);
  const freeze = PASS_BF.indexOf("write-contract.mjs --freeze");
  const delegate = PASS_BF.indexOf("delegate `brownfield-orchestrator`");
  assert.ok(freeze > 0, "the freeze is named as a step");
  assert.ok(delegate > freeze, "the orchestrator is delegated only after the freeze");
  assert.match(f, /`--brief` is step 4's "bring your own file"/, "a written brief replaces the interview");
  assert.match(f, /`--gates` decides Gate 0 as it decides the other gates/);
  assert.doesNotMatch(PASS_BF, /Invoke `brownfield-orchestrator` instead of\s+`orchestrator`, whatever the `--intent`\. Additional/, "the old direct delegation is gone");
});

// Every brownfield job's packets are derived by code from the change spec: task_type is empty, subtype is the
// unit's label (create or edit), every packet carries the run id as pass_id, and a wiring edit is its own unit
// that waits for the file it registers. The old planner's section — task-type primitives resolved by an adapter,
// paired packets rolled back together, the brief's task type on every packet — described a flow no run takes.
test("the pipeline skill carries no planning rules of the old brownfield packet planner", () => {
  for (const stale of [
    /Brownfield-mode task types/,
    /paired packets/i,
    /roll back the new-file packet/,
    /uses that exact\s+`task_type`/,
    /Do not infer `doc_addition` vs `doc_update`/,
    /resolves to concrete codegen guidance/,
  ]) assert.doesNotMatch(SKILL, stale, String(stale));
  const phase4 = flat(SKILL.slice(SKILL.indexOf("### Phase 4"), SKILL.indexOf("### TaskPacket initial")));
  assert.match(phase4, /In brownfield, code derives every packet from the architect's change spec\*\*, one per unit, and nothing in this section applies/);
  assert.match(phase4, /the policy routes it by its stage, and by the run's `intent` when a rule names one/);
  // The labels it names are the ones code sets (lib/change-spec.mjs SUBTYPE).
  const spec = read("plugin", "scripts", "lib", "change-spec.mjs");
  assert.match(spec, /docs: "doc_update"/);
  assert.match(spec, /docs: "doc_addition"/);
  assert.match(phase4, /an edited doc is `doc_update`, a new one `doc_addition`/);
});

// The stack adapters are read by whoever plans a brownfield change: the architect, in its change spec. Their
// guidance is said in the spec's terms; the old planner's packets, subtypes, instructions and rollback are not.
test("the stack adapters speak the change spec: the architect plans, wiring is a unit that waits for its file", () => {
  for (const [name, text] of Object.entries(STACKS)) {
    assert.doesNotMatch(text, /packet planner/i, `${name}: no packet planner plans any more`);
    assert.doesNotMatch(text, /paired packet/i, `${name}`);
    assert.doesNotMatch(text, /roll ?back/i, `${name}`);
    assert.doesNotMatch(text, /in (the packet's )?`instruction`/, `${name}: the spec carries the guidance, not an instruction`);
    assert.match(text, /\barchitect\b/, `${name} is read by the architect`);
  }
  for (const name of ["nest.md", "python.md", "generic.md"]) {
    assert.match(flat(STACKS[name]), /`depends_on`/, `${name}: wiring waits for the file it registers`);
  }
});

// Tier 2b's profile reaches typists only through what the architect carries into the spec (conventions,
// decisions, style files): a packet carries the shared brief, the unit's brief, its style and uses files and the
// edited file, and plan-lint refuses a path under .sdlc/ as a unit's input.
test("the discovery agent says who reads the stack profile now, and takes the profile flags as inputs", () => {
  const f = flat(DISCOVERY);
  assert.doesNotMatch(f, /codegen packets receive this profile verbatim/);
  assert.doesNotMatch(f, /appended to codegen packet inputs/);
  assert.doesNotMatch(f, /The packet planner \(phase 4\)/);
  assert.match(f, /The architect reads this profile while it writes the change spec/);
  assert.match(f, /typists never read the profile itself/);
  const inputs = flat(DISCOVERY.slice(DISCOVERY.indexOf("# Inputs"), DISCOVERY.indexOf("# Precondition")));
  assert.match(inputs, /`adaptive_profile` \(optional\)/);
  assert.match(inputs, /`refresh_profile` \(optional\)/);
  assert.match(f, /The caller passed `adaptive_profile: true`/);
  assert.match(f, /`refresh_profile: true`/);
  assert.doesNotMatch(f, /forced `--refresh-profile`|passed `--refresh-profile`|passed `--adaptive-profile`/, "discovery reads its inputs, not the command's flags");
  // /mmo:pass's flags say what they reach.
  assert.match(flat(PASS_BF), /\| `--adaptive-profile` \| Discovery's `adaptive_profile` input/);
  assert.match(flat(PASS_BF), /\| `--refresh-profile` \| Discovery's `refresh_profile` input/);
});

// The gate-pending record the skill asked for is a Write of .sdlc/local/state.json, which a brownfield run's write
// contract refuses (.sdlc/** is off-limits outside the run's own folder): every gate paid for a refused call. In
// brownfield the run's own log already records each gate.
test("the gate section asks a brownfield run for no write the contract refuses", () => {
  const hitl = flat(SKILL.slice(SKILL.indexOf("## HITL gate prompt templates"), SKILL.indexOf("### Gate 0")));
  assert.match(hitl, /Persist the gate-pending state to `\.sdlc\/local\/state\.json` before emitting the message\*\* — except in brownfield/);
  assert.match(hitl, /the run's own log \(`gate\.open`, `gate\.resolved`\) is the record/);
  assert.doesNotMatch(hitl, /session-hydrate detects a\s*non-terminal state and re-prompts/);
});

// Ending a run that never ended is the person's decision (write-contract.mjs --abandon); a flag that approves gates
// does not approve it.
test("/mmo:pass's --gates does not answer the guide's question about a run that never ended", () => {
  assert.match(flat(PASS_BF), /Step 1's question about a run that never ended is not a gate: ending a run is the person's decision, so `--gates` does not answer it/);
  // Step 6 asks the same question about a run that stopped after Gate 0 froze its contract (D5's other case).
  assert.match(flat(PASS_BF), /nor step 6's question about a run that stopped before its end/);
});

// No packet planner exists, and nothing on the dispatch path runs dispatch-sanitize.mjs: a typist's packet is built
// by code from the change spec, and the server's hydrateInputs refuses to read an off-limits file into any packet.
test("the discovery agent names no packet planner and no sanitizer the dispatch path does not run", () => {
  assert.doesNotMatch(DISCOVERY, /packet planner/i);
  assert.doesNotMatch(DISCOVERY, /dispatch-sanitize/);
  assert.match(flat(DISCOVERY), /a typist's packet is built later by code from the change spec, and the server never reads an off-limits file into it/);
  const apply = read("plugin", "mcp", "model-dispatch", "src", "apply.ts");
  assert.match(apply, /export function hydrateInputs/);
  assert.match(apply, /is never sent to a model/, "the server's read rule is what guards dispatch");
});

// A bugfix run writes the test that reproduces the bug before the fix (red_checks, judged first); "diagnose it ...
// add a regression test" describes another flow, in the description every session lists.
test("/mmo:bugfix's description says the flow it runs: a test that reproduces the bug first, then the fix", () => {
  const desc = read("plugin", "commands", "bugfix.md").match(/^description:\s*"([^"]*)"/m)?.[1] ?? "";
  assert.doesNotMatch(desc, /diagnose it|add a regression test/);
  assert.match(desc, /write a test that reproduces it first, then fix it/);
});

// An apply-form packet that names no job is refused by the server before any model is called (it would otherwise
// fall back to adapters that differ by policy); the schema text must not call a missing intent a harmless fallback.
test("the TaskPacket schema says a brownfield packet without its job is refused, not quietly re-routed", () => {
  const schema = flat(SKILL.slice(SKILL.indexOf("## TaskPacket schema"), SKILL.indexOf("## Intent matrix")));
  assert.doesNotMatch(schema, /Omitting `intent` silently drops the packet/);
  assert.doesNotMatch(schema, /safe to skip/);
  assert.match(schema, /the server refuses an apply-form packet that names no job before any model is called/);
  assert.match(schema, /Greenfield packets carry no `intent`/);
});

// --strict-write=off is the person's flag at the start. What it leaves refused is the hook's rule: the always-off-limits
// list under every contract, and, once Gate 0 froze it, the run's own contract and log. Checked end to end.
test("/mmo:pass says what --strict-write=off never opens, and the hook holds to it", async () => {
  const row = flat(PASS_BF.split("\n").find((l) => l.startsWith("| `--strict-write=off`")) ?? "");
  // The row names the list's real entries (lib/off-limits.mjs HARDCODED_OFF_LIMITS), not a summary of them.
  const { HARDCODED_OFF_LIMITS } = await import(join(ROOT, "plugin", "scripts", "lib", "off-limits.mjs"));
  for (const entry of HARDCODED_OFF_LIMITS) assert.ok(row.includes(`\`${entry}\``), `the row names ${entry}`);
  assert.match(row, /and never the run's own contract or log once Gate 0 froze it/);
  assert.match(row, /It is the person's flag at the start; a run never edits the contract/);
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mmo-pass-strict-"));
  try {
    mkdirSync(join(dir, ".git"));
    const fr = spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "write-contract.mjs"), "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", '["docs/**"]', "--strict-write=off", "--project-root", dir], { encoding: "utf8" });
    assert.equal(fr.status, 0, fr.stderr);
    const hook = (file_path) => spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "write-contract-check.mjs")], { cwd: dir, input: JSON.stringify({ tool_input: { file_path } }), encoding: "utf8" }).status;
    assert.equal(hook("lib/outside.ts"), 0, "outside the allowlist: a warning, under --strict-write=off");
    assert.equal(hook("docs/guide.md"), 0, "the contract's own off-limits: a warning");
    assert.equal(hook(".env"), 2, "the always-off-limits list stays refused");
    assert.equal(hook(".sdlc/local/write-contract.json"), 2, "the frozen contract stays refused");
    assert.equal(hook(".sdlc/runs/r1/orchestrator.log"), 2, "the run's own log stays refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
