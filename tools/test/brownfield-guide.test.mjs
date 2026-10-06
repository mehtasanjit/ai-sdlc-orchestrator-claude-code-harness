/**
 * The brownfield guide (skills/brownfield-guide/SKILL.md) and the pipeline skill's Gate 0 template: rules that hold
 * for every brownfield job, checked on the shipped text. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const GUIDE = read("plugin/skills/brownfield-guide/SKILL.md");
const SKILL = read("plugin/skills/pipeline/SKILL.md");
/** The Gate 0 template of the pipeline skill: from its heading to the next gate's. */
const GATE0 = SKILL.slice(SKILL.indexOf("### Gate 0"), SKILL.indexOf("### Gate 1"));

// Gate 0 used to print "Typical cost for a <intent> run on a repo this size: $X–$Y" from "a rough per-intent ×
// baseline-size table" that never existed, so the chat model invented the range. A number shown to the person comes
// from prices or measured runs, or is not shown.
test("Gate 0 shows no cost range: there is no measured table to read one from", () => {
  for (const [name, text] of [["the brownfield guide", GUIDE], ["the Gate 0 template", GATE0]]) {
    assert.doesNotMatch(text, /Typical cost/i, `${name} still asks for a typical cost`);
    assert.doesNotMatch(text, /\$X/, `${name} still carries a cost placeholder`);
  }
  assert.ok(GATE0.includes("Reply: `approved`"), "the template itself is intact");
});

// The pre-check used to send its own test packet to "each policy tier" before Gate 0, when the run's auth mode is not
// chosen yet, so under a subscription it dispatched the Claude tier through the API and asked for an API key. The
// run's start check (preflight_dispatch with probe_typists) tests the models that type the run, with the run's auth
// mode; the pre-check records its dispatch step as tested there.
test("the pre-check sends no test packet of its own: the run's start check tests the typists", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mmo-precheck-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "pre-check.mjs"), "--report", "--json", "--sdlc", join(dir, ".sdlc")], { encoding: "utf8", cwd: dir });
    const status = JSON.parse(r.stdout);
    assert.equal(status.steps.dispatch_smoke.status, "skip");
    assert.match(status.steps.dispatch_smoke.note, /probe_typists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(GUIDE, /--record dispatch/, "the guide no longer posts a dispatch smoke");
  assert.doesNotMatch(GUIDE, /dispatch via\s+`execute_with_model` to each policy tier/);
  assert.match(SKILL, /`probe_typists: true`/, "the run's start check is told to test the typists");
});

/** One step of the guide: from its `# <n>.` heading to the next top-level heading (a `# ` line inside a code block,
 * such as the brief's own title, is not one: the next heading is the next step or the flag surface). */
const step = (n) => {
  const start = GUIDE.indexOf(`\n# ${n}. `);
  const rest = GUIDE.slice(start + 1);
  const end = rest.search(/\n# (\d+\. |Flag surface)/);
  return end < 0 ? rest : rest.slice(0, end);
};
const flat = (s) => s.replace(/\s+/g, " ");
/** The guide's one-line calls of the contract script's --abandon, as the guide writes them. */
const abandonCalls = (text) => text.split("\n").map((l) => l.trim()).filter((l) => /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/write-contract\.mjs" --abandon\b/.test(l));

// A run that dies (a closed chat, a crash, a login limit) leaves its Gate 0 freeze live with no end record, and a
// run freezes once, so it cannot be resumed under its frozen scope: the next run's Gate 0 is refused, and every
// write outside the dead run's allowlist with it. Ending it is the person's decision, through the one documented
// way, write-contract.mjs --abandon; the guide never points at a resume path that does not exist and never
// pretends that clearing a state file ends the run.
test("step 1: a run that never ended is ended with --abandon on the person's answer, never resumed", () => {
  const s1 = step(1);
  assert.doesNotMatch(GUIDE, /resume path/, "no pointer to a resume path that no text holds");
  assert.doesNotMatch(SKILL, /resume path/);
  assert.doesNotMatch(s1, /clear `\.sdlc\/local\/state\.json`/, "clearing a state file does not end a run");
  const calls = abandonCalls(s1);
  assert.equal(calls.length, 1, "discard runs the contract script's --abandon");
  assert.match(calls[0], /--run-id <run_id>/);
  assert.match(flat(s1), /Accept `discard` or `abort`/);
  assert.match(flat(s1), /ending a run is the person's decision/);
  assert.match(flat(s1), /never run it on your own/);
  assert.match(flat(s1), /On `abort`, stop here and change nothing/);
  assert.match(flat(s1), /cannot be resumed/);
});

// Gate 0 freezes the contract before the orchestrator logs its start, so an orchestrator that halts (its start
// check stopped it) or stops before Gate 4 leaves the project held by a run that will never end by itself.
test("step 6: a run that stops before it ends by its own log is ended with --abandon on the person's yes", () => {
  const s6 = step(6);
  const calls = abandonCalls(s6);
  assert.equal(calls.length, 1, "the halted run is ended through --abandon");
  assert.match(calls[0], /--run-id <run-id>/);
  // The trigger is a return without a gate prompt: a gate's return is a pause (the next test).
  assert.match(flat(s6), /Only a return without a gate prompt, before the run has ended by its own log/);
  assert.match(flat(s6), /on their yes/);
});

// The other refusal a dead run causes: the next Gate 0's freeze names it. The guide handles it the same way.
test("step 5: a freeze refused because another run holds the project goes to the person, as in step 1", () => {
  assert.match(flat(step(5)), /If the freeze is refused because another run is live and holds this project's contract, ask the person as in step 1/);
});

// Run end-to-end on a scratch project, once the contract script has --abandon: the run the guide's discard ends
// releases the project, and the next run's Gate 0 freezes. Before the script has it (a lane that has not got it
// yet), the check is skipped and says why.
test("the guide's discard command frees the project for the next run's Gate 0", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const script = join(ROOT, "plugin", "scripts", "write-contract.mjs");
  if (!readFileSync(script, "utf8").includes('"--abandon"')) { t.skip("write-contract.mjs has no --abandon yet"); return; }
  const dir = mkdtempSync(join(tmpdir(), "mmo-guide-abandon-"));
  try {
    mkdirSync(join(dir, ".git"));
    const run = (args) => spawnSync(process.execPath, [script, ...args, "--project-root", dir], { encoding: "utf8" });
    assert.equal(run(["--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]"]).status, 0, "the dead run froze");
    assert.equal(run(["--freeze", "--run-id", "r2", "--allowlist", '["docs/**"]', "--off-limits", "[]"]).status, 2, "it holds the project");
    // The guide's own call, its placeholders filled the way the model fills them.
    const [call] = abandonCalls(step(1));
    const words = call.replace(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/write-contract\.mjs" /, "").replace("<run_id>", "r1").match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, ""));
    const ended = run(words);
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(run(["--freeze", "--run-id", "r2", "--allowlist", '["docs/**"]', "--off-limits", "[]"]).status, 0, "the next run freezes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The rule that proposes companion files (a spec generated from the code, a catalogue of the surface) holds for
// every job that changes a surface others list or generate: a bugfix can change an endpoint's response, a deps
// upgrade a generated spec, a refactor an export a README lists. Its examples name kinds of file, never the files
// of one project.
test("step 4: the companion-files rule holds for every job, in general terms", () => {
  const s4 = flat(step(4));
  assert.doesNotMatch(s4, /For `feature-extend` and `feature-new` only/);
  assert.doesNotMatch(s4, /openapi\.json|MCP tool list/, "no example taken from one project's files");
  assert.match(s4, /For every job: include the \*\*companion files\*\*/);
  assert.match(s4, /Left out, they become review findings the run cannot act on/);
});

// A docs run's packets take their label from their unit (an edited file is doc_update, a new one doc_addition),
// and the interview already asks whether docs are updated or written fresh; a separate task-type question adds a
// turn and reaches no packet. Packets route by their stage, and by the run's intent when a policy rule names one
// (executorView keeps intent rules).
test("step 4: no task-type question, and routing is said as it is: stage, and intent when a rule names one", () => {
  const s4 = flat(step(4));
  assert.doesNotMatch(s4, /## Task type/);
  assert.doesNotMatch(s4, /Which kind of/);
  assert.doesNotMatch(s4, /route by their stage alone/);
  assert.match(s4, /by their stage, and by the run's intent when a policy rule names one/);
});

// --adaptive-profile and --refresh-profile reach discovery as its inputs, so the flags /mmo:pass advertises do
// something.
test("step 3 passes the profile flags to discovery as its inputs", () => {
  const s3 = flat(step(3));
  assert.match(s3, /`adaptive_profile: true` when the run was started with `--adaptive-profile`/);
  assert.match(s3, /`refresh_profile: true` when it was started with `--refresh-profile`/);
});

// Discovery takes the profile inputs from whichever step runs it. Step 3 runs only when step 2's smoke did not, and
// the smoke always runs on a project's first run and under --refresh-profile (which implies --recheck), so inputs
// named in step 3 alone are dropped in exactly the runs the flags exist for.
test("step 2's discovery smoke passes the profile flags too, so they reach discovery whichever step runs it", () => {
  const s2 = flat(step(2));
  assert.match(s2, /`adaptive_profile: true` when the run was started with `--adaptive-profile`/);
  assert.match(s2, /`refresh_profile: true` when it was started with `--refresh-profile`/);
  // /mmo:pass's flag rows point at the step that runs discovery, not at step 3 alone.
  const pass = flat(read("plugin/commands/pass.md"));
  assert.match(pass, /Discovery's `adaptive_profile` input \(guide step 2's smoke or step 3, whichever runs discovery\)/);
  assert.match(pass, /Discovery's `refresh_profile` input \(guide step 2's smoke or step 3, whichever runs discovery\)/);
});

// Every HITL gate is delivered by the orchestrator returning a message that carries the gate's block (the pipeline
// skill's gate section), so "returned before the run ended" is also true at Gates 1-3. Asking at every gate whether
// to end the run adds a question per gate, and a yes abandons a live run in the middle of the pipeline.
test("step 6: a return that carries a gate prompt is a pause, never a reason to ask about ending the run", () => {
  const s6 = flat(step(6));
  assert.match(flat(SKILL), /Every gate is delivered by the subagent returning a message/, "the premise: gates arrive as returns");
  assert.match(s6, /A return that carries a HITL gate block is a pause, not a stop: relay the gate and re-invoke the orchestrator with the person's answer/);
  assert.match(s6, /Only a return without a gate prompt, before the run has ended by its own log/);
  const pause = s6.indexOf("A return that carries a HITL gate block is a pause");
  const ask = s6.indexOf("ask whether to end it");
  assert.ok(pause >= 0 && ask > pause, "the pause rule comes before the end-the-run question it limits");
});

// A bugfix proves its fix with a test that fails on the bug first (red_checks), and finalize refuses a bugfix spec
// with no reproducing test (lib/change-spec.mjs jobRules): a run whose allowlist holds no test file it may write
// cannot be planned, after requirements and design are paid for. Gate 0 is where the scope is the person's to set.
test("step 4: a bugfix run proposes the test file its reproducing test needs, and stops at Gate 0 without one", () => {
  const s4 = flat(step(4));
  assert.match(s4, /For `bugfix`, propose the test file \(or the test folder's glob\) the reproducing test needs in the allowlist/);
  assert.match(s4, /the run proves the fix by a test that fails on the bug first/);
  assert.match(s4, /If the person keeps tests out, stop at Gate 0 with one line: a bugfix run needs a test file it may write/);
  // The rule it rests on is code's: a bugfix spec without a reproducing test does not finalize.
  const spec = read("plugin/scripts/lib/change-spec.mjs");
  assert.match(spec, /a bugfix run starts with the test that reproduces the bug/);
});

// What step 5 says about the freeze holds against the contract's script: it refuses any folder but the git project's
// root, a run id that already froze, and a run id that has ended (one freeze per run id).
test("step 5: the freeze runs from the git project's root, once per run id, and a refusal goes to the person", async () => {
  const s5 = flat(step(5));
  assert.match(s5, /Run it from the git project's root \(the script refuses any other folder\)/);
  assert.match(s5, /It refuses a run id that already froze or ended/);
  assert.match(s5, /on any other refusal, stop and tell the person what it said/);
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const script = join(ROOT, "plugin", "scripts", "write-contract.mjs");
  const dir = mkdtempSync(join(tmpdir(), "mmo-guide-freeze-"));
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "pkg"));
    const freeze = (id, root = dir) => spawnSync(process.execPath, [script, "--freeze", "--run-id", id, "--allowlist", '["src/**"]', "--off-limits", "[]", "--project-root", root], { encoding: "utf8" });
    assert.equal(freeze("r1", join(dir, "pkg")).status, 2, "a folder below the git root is refused");
    assert.equal(freeze("r1").status, 0, "the root freezes");
    const ab = spawnSync(process.execPath, [script, "--abandon", "--run-id", "r1", "--project-root", dir], { encoding: "utf8" });
    assert.equal(ab.status, 0, ab.stderr);
    assert.equal(freeze("r1").status, 2, "a run id that froze, and ended, never freezes again");
    assert.equal(freeze("r2").status, 0, "a new run freezes");
    assert.equal(freeze("r2").status, 2, "a live run id never freezes twice");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The start check covers the typists a policy rule scoped to the run's job routes to only when it is given the job
// (preflight_dispatch's `intent`); the guide hands the orchestrator the job, and says what the start check covers.
test("step 2 says the start check is given the run's job, so it tests the typists a rule for that job routes to", () => {
  assert.match(flat(step(2)), /`preflight_dispatch` with `probe_typists` and the run's `intent`/);
});

// Step 1's case for a run that never ended fires only when session-hydrate reports it. A brownfield run writes no
// state.json (its contract refuses that Write), so hydrate must find the run from the project's live freeze record:
// a frozen run with no end is reported as a pending run, and one ended with --abandon is not. Without that, step 1
// never fires and the next run's Gate 0 freeze is refused instead.
test("step 1's dead-run case is reachable: session-hydrate reports a frozen run that never ended, and not once it is ended", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "mmo-guide-hydrate-"));
  try {
    mkdirSync(join(dir, ".git"));
    const contract = (args) => spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "write-contract.mjs"), ...args, "--project-root", dir], { encoding: "utf8" });
    const resume = () => JSON.parse(spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "session-hydrate.mjs"), "--sdlc", join(dir, ".sdlc"), "--json"], { encoding: "utf8" }).stdout).resume;
    assert.equal(contract(["--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]"]).status, 0);
    const live = resume();
    assert.equal(live?.pending, true, "a frozen run with no end is reported");
    assert.equal(live?.kind, "run");
    assert.equal(live?.run_id, "r1");
    assert.equal(contract(["--abandon", "--run-id", "r1"]).status, 0);
    assert.equal(resume(), null, "an ended run is not");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
