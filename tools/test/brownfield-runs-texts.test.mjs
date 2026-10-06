/**
 * The texts a brownfield run's agents follow (skills/pipeline/brownfield-runs.md, the sections in tools/agent-copies/
 * and the copies tools/build-agent-copies.mjs makes from them), checked on the shipped text. Offline, $0.
 *
 *   - They give technical reasons, never one run's history, and every "instead of" names text that exists.
 *   - They say what code does: who types a file, what a receipt asks of the orchestrator, what is recorded, which
 *     review a touched file gets, which model makes the ladder's last attempt, what code checks at finalize.
 *   - They tell the orchestrator and its helpers the same flow the base texts would otherwise contradict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
/** Whitespace folded to single spaces, so a phrase matches across the texts' line wraps. */
const flat = (s) => s.replace(/\s+/g, " ");
/** The text from the line that starts with `from` up to the next line that starts with `to` (or the end). */
function part(text, from, to) {
  const lines = text.split("\n");
  const a = lines.findIndex((l) => l.startsWith(from));
  assert.ok(a >= 0, `no line starts with ${from}`);
  const b = to ? lines.findIndex((l, i) => i > a && l.startsWith(to)) : -1;
  return lines.slice(a, b < 0 ? undefined : b).join("\n");
}

const RUNS = read("plugin/skills/pipeline/brownfield-runs.md");
const SKILL = read("plugin/skills/pipeline/SKILL.md");
const SECTIONS = Object.fromEntries(readdirSync(join(ROOT, "tools", "agent-copies")).map((f) => [f.replace(/\.md$/, ""), read(`tools/agent-copies/${f}`)]));
const copy = (name) => read(`plugin/agents/${name}.md`);
const front = (text) => text.split("\n---\n")[0];
const base = (name) => read(`plugin/agents/${name}.md`);

// A model reads these texts on every brownfield run. A run it never saw ("on the run this rule comes from", "today",
// "as before", a figure from one run) tells it nothing it can act on and goes stale; the technical reason beside it is
// what it needs.
test("the brownfield texts give technical reasons, never one run's history", () => {
  const HISTORY = [
    [/this (rule|contract) comes from/i, "the run a rule came from"],
    [/\bon the run\b/i, "a single run"],
    [/\(measured:/i, "a one-run measurement as a reason"],
    [/~\s?\d+ turns/i, "one run's turn count"],
    [/\d+k\b/, "one run's token figure"],
    [/\btoday\b/i, "wording relative to an earlier version"],
    [/\bas before\b/i, "wording relative to an earlier version"],
    [/packets before\./, "wording relative to an earlier version"],
    [/\bhistorically\b/i, "history as a reason"],
    [/\bthe previous form\b/i, "wording relative to an earlier version"],
  ];
  for (const [name, text] of [["brownfield-runs.md", RUNS], ...Object.entries(SECTIONS).map(([n, t]) => [`agent-copies/${n}.md`, t])]) {
    for (const [pattern, what] of HISTORY) assert.doesNotMatch(flat(text), pattern, `${name}: ${what}`);
  }
});

// An "instead of" that names text the base does not hold replaces nothing, and the base rule it meant stays in force.
test("every quoted \"instead of\" in the brownfield texts names text the base it replaces holds", () => {
  const targets = {
    "brownfield-runs.md": [RUNS, [SKILL, base("orchestrator")]],
    "agent-copies/brownfield-orchestrator.md": [SECTIONS["brownfield-orchestrator"], [base("orchestrator"), SKILL]],
    "agent-copies/brownfield-architect.md": [SECTIONS["brownfield-architect"], [base("architect")]],
    "agent-copies/brownfield-senior-reviewer.md": [SECTIONS["brownfield-senior-reviewer"], [base("senior-reviewer")]],
    "agent-copies/brownfield-security-reviewer.md": [SECTIONS["brownfield-security-reviewer"], [base("security-reviewer")]],
  };
  let quotes = 0;
  for (const [name, [text, bases]] of Object.entries(targets)) {
    const where = bases.map(flat).join("\n");
    // The quoted texts of one override: from "instead of" to the colon that opens its replacement or the end of its
    // sentence (a colon or a period before a space, outside quotes).
    for (const m of flat(text).matchAll(/[Ii]nstead of ((?:[^.:"]|[.:](?!\s|$)|"[^"]*")*)/g)) {
      for (const q of m[1].matchAll(/"([^"]+)"/g)) {
        quotes++;
        assert.ok(where.includes(q[1]), `${name}: "instead of" names "${q[1]}", which its base does not hold`);
      }
    }
  }
  assert.ok(quotes >= 15, `the overrides are found (${quotes})`);
  // Overrides that pointed at nothing: rule 6 marks no input, and the security reviewer writes no packets.
  assert.doesNotMatch(SECTIONS["brownfield-orchestrator"], /rule 6's marking/);
  assert.doesNotMatch(SECTIONS["brownfield-security-reviewer"], /Instead of writing refinement packets/);
});

// A test or docs run may hold source files ("source files only where the brief asks for them"), so the security
// review is scoped by what each touched file is, not by the job: a source change gets the full checklist in every job.
test("the security review covers every touched file by its kind, whatever the job", () => {
  const sec = flat(SECTIONS["brownfield-security-reviewer"]);
  assert.match(sec, /Instead of "Intent-specific scoping"/);
  assert.match(sec, /whatever the job/);
  assert.match(sec, /not a test or a doc gets the full checklist/);
  assert.match(flat(copy("brownfield-security-reviewer")), /not a test or a doc gets the full checklist/);
  for (const [name, text] of [["brownfield-runs.md", RUNS], ["orchestrator section", SECTIONS["brownfield-orchestrator"]]]) {
    assert.doesNotMatch(flat(text), /Phase 1, 7 and 8 columns still apply/, name);
    assert.match(flat(text), /Phase 1 and 7 columns still apply/, name);
  }
  assert.match(flat(part(RUNS, "## Phase 8")), /instead of the Intent matrix's Phase 8 column/i);
});

// The server writes every apply packet inside execute_batch with no preview, so the inherited diff-preview mini-gate
// cannot happen; the copy says what protects an existing file instead, and the senior reviewer checks the merge rules.
test("the orchestrator copy replaces the diff-preview mini-gate with what actually protects an existing file", () => {
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /Instead of the Write gate's "Diff-preview mini-gate" and its "with a diff shown to the user at a mini-gate before the write"/);
  assert.match(orch, /no diff is shown before a packet's write/);
  for (const guard of [/change_plan\.md/, /search\/replace/, /provenance/, /both reviewers read its diff/, /the server does not check them/]) assert.match(orch, guard);
  assert.match(flat(SECTIONS["brownfield-senior-reviewer"]), /removed or downgraded dependency or script/);
});

// A deps run's tooling step writes the lockfile through Bash, which neither the server nor the provenance steps for a
// Write/Edit see; /mmo:revert restores only what provenance.json lists, and both reviewers read their touched set there.
// What it changed outside the record is reported in the orchestrator's final message: SUMMARY.md is code's, and Claude
// Code refuses a helper's Write of it (the pipeline skill's Phase 9).
test("a tooling step runs under provenance, and what it changed outside the record is reported", () => {
  const tooling = flat(part(RUNS, "`tooling` packets (no model)", "Every packet is typed"));
  for (const step of ["write-provenance.mjs --before", "--after", "lockfile", "git status --porcelain", "your final message"]) assert.ok(tooling.includes(step), step);
  assert.match(flat(SECTIONS["brownfield-orchestrator"]), /around every tooling step/);
  assert.match(flat(SECTIONS["brownfield-architect"]), /`tooling`: [^.]*its `path` is the file the step writes/);
});

// A failed file goes to one fix round by code and what still fails is reported, as greenfield does: no file is typed in
// the orchestrator's own conversation, no packet is edited or written by hand, and a refusal is never worked around.
test("the receipt table sends every failed file to a fix round by code, never back to the orchestrator's hands", () => {
  const receipts = flat(part(RUNS, "Read the receipt's `status`", "The receipt is small"));
  assert.doesNotMatch(receipts, /in your own conversation|Rewrite the instruction|As today|allowlist decision/);
  const row = (status) => receipts.match(new RegExp(`\\| \`${status}\` \\|[^|]*\\|([^|]*)\\|`))[1];
  assert.match(row("verify_failed"), /failures\.json[^|]*Fix packets by code/);
  assert.match(row("verify_failed"), /reported at the next gate/);
  assert.match(row("verify_failed"), /Never type the file in this session/);
  for (const s of ["escalate", "no_content"]) assert.match(row(s), /Same as `verify_failed`/, s);
  assert.match(row("refused"), /a scope change is the person's decision/);
  assert.match(row("refused"), /goes back to the architect/);
  assert.match(row("dispatch_failed"), /reported at the next gate|report it at the next gate/);
  const runs = flat(RUNS);
  assert.doesNotMatch(runs, /a packet you write by hand|A packet you write carries|handle those yourself/);
  assert.match(runs, /you never write or edit one/);
  // The base's own hand-written-packet rules (rule 7's refined packet, rule 8's debug packet) are replaced too.
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /Instead of rule 7's "Construct a refined TaskPacket from scratch[^"]*"/);
  assert.match(orch, /rule 8's "run `npm install && npm test` via Bash from `<code_dir>`", its env-fixture copy and its debug packet/);
  // A fix round is judged by every check that was not set aside, and never changes the bugfix's reproducing test.
  const fixes = flat(part(RUNS, "**Fix packets by code.**", "In brownfield the delegation"));
  assert.match(fixes, /no new baseline is taken/);
  assert.match(fixes, /a bugfix's reproducing test, which judges the fix/);
  assert.doesNotMatch(fixes, /red checks as checks that must pass/);
});

// Under every policy and auth mode the server types every derived and fix packet, the solo run's own-tier packets
// included; the base text's in-session rules would send only the solo run back to typing files itself.
test("the orchestrator copy and the runs file say the server types every packet, under every policy and auth mode", () => {
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /Instead of "Under an all-Opus policy \(`opus-only`\) every phase runs directly", rule 0's "under `estimated` only the mechanical tier" and rule 6's "This applies to escalations too"/);
  assert.match(orch, /You never type a project file or handle an escalated packet in this conversation/);
  const pre = flat(part(RUNS, "## Phase -1", "## The jobs"));
  assert.match(pre, /Instead of "Escalation to the direct tier under `estimated` stays in-session"/);
  assert.match(pre, /nothing in a brownfield run is typed in this session/);
});

// Every brownfield packet is typed by greenfield's typists, the lean Opus typist through the claude CLI included, so
// pre-flight's free CLI check (and its "update Claude Code" fix) must run for brownfield too.
test("a brownfield run passes executor: true, so pre-flight checks the claude CLI its typists use", () => {
  assert.match(flat(SECTIONS["brownfield-orchestrator"]), /Instead of rule 0's "`executor: false` on a brownfield run": pass `executor: true`/);
  assert.match(flat(part(RUNS, "## Phase -1", "## The jobs")), /Instead of "`executor: false` on a brownfield run": pass `executor: true`/);
});

// Rule 8's npm-from-code_dir and env copy, rule 4's pre-check smoke packet and rule 5's hand-written packets.json are
// greenfield's; the brownfield copy replaces each.
test("the orchestrator copy replaces the base's greenfield-only test, smoke and packet-plan rules", () => {
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /Instead of rule 8's "run `npm install && npm test` via Bash from `<code_dir>`"/);
  assert.match(orch, /`baseline\.test_command`/);
  assert.match(orch, /never copied/);
  assert.match(orch, /Instead of rule 4's smoke-test example \("used at pre-check dispatch step"\)/);
  assert.match(orch, /"Write the full list to `<output_dir>\/packets\.json`/);
});

// The orchestrator reads the pipeline skill's parts this run follows, never its greenfield executor mode or the Gate 0
// the main session already ran: the whole file stays in the cached context on every later turn.
test("the runs file names the pipeline skill sections a brownfield run reads, and each exists", () => {
  const head = flat(part(RUNS, "# Brownfield runs", "## The jobs"));
  const m = head.match(/Read only these sections of SKILL\.md[^:]*: (.*?)\. Never read/);
  assert.ok(m, "the sections are named");
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]);
  assert.ok(names.length >= 8, names.join(", "));
  const headings = SKILL.split("\n").filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, ""));
  for (const n of names) assert.ok(headings.some((h) => h.startsWith(n)), `SKILL.md has no section "${n}"`);
  assert.ok(!names.some((n) => /Executor mode|Gate 0/.test(n)), "never executor mode or Gate 0");
  assert.match(head, /Never read the whole file/);
  assert.match(flat(SECTIONS["brownfield-orchestrator"]), /read only those/);
});

// The reviewers write where findings-to-packets reads, and get the suite summary so they do not re-run the suites.
test("the reviewer contract carries the output path and the suite summary, and one senior review covers the change", () => {
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  const contract = orch.slice(orch.indexOf("**Reviewer input contract (brownfield).**"));
  assert.match(contract, /`<output_dir>\/review\.json` for the senior reviewer/);
  assert.match(contract, /`<output_dir>\/security_review\.md` for the security reviewer/);
  assert.match(contract, /one-line-per-suite summary/);
  const runs = flat(RUNS);
  assert.doesNotMatch(runs, /review-<module>|for each module/);
  assert.match(runs, /--review <output_dir>\/review\.json/);
  for (const name of ["brownfield-senior-reviewer", "brownfield-security-reviewer"]) assert.doesNotMatch(flat(SECTIONS[name]), /sends paths only/, name);
});

// Every job runs the architecture phase, so nothing the copy reads may describe a skipped one.
test("no brownfield text describes a skipped architecture phase", () => {
  assert.doesNotMatch(flat(SECTIONS["brownfield-orchestrator"]), /when the architecture phase was skipped/);
  assert.doesNotMatch(flat(RUNS), /\(or `requirements\.md`\)/);
  const jobs = flat(part(RUNS, "## The jobs", "| Job |"));
  assert.match(jobs, /"Skip semantics"/);
  assert.match(jobs, /no `phase\.skip` event is logged/);
  assert.match(flat(SECTIONS["brownfield-orchestrator"]), /Run logging's "gets `phase\.skip` instead of the pair above"/);
});

// jobRules checks only that project_checks is not empty; the table says what code checks, and the architect's
// instruction (the full suite) is stated as an instruction.
test("the jobs table claims only what code checks at finalize", () => {
  const table = part(RUNS, "| Job |", "A job with no Gate 2");
  assert.doesNotMatch(table, /`project_checks` names the full suite/);
  assert.match(table, /`project_checks` holds at least one command/);
  assert.match(flat(RUNS), /code checks that the list is not empty/);
});

// A design-affecting bugfix needs the person to see its plan before it is typed; code decides it from the spec,
// never the orchestrator from the plan's wording.
test("a design-affecting bugfix opens Gate 2, decided by code from the spec", () => {
  const table = part(RUNS, "| Job |", "A job with no Gate 2");
  assert.match(table, /\| `bugfix` \| when design-affecting \|/);
  const rule = flat(part(RUNS, "A job with no Gate 2", "**A bugfix proves itself"));
  assert.match(rule, /plan-to-packets' summary says `Gate 2: yes`/);
  for (const reason of [/a decision/, /creates a file outside the `tests` phase/, /replaces or deletes lines of an existing test file/]) assert.match(rule, reason);
});

// Project checks get no baseline from the server; the orchestrator takes one before the first packet, so a failure that
// was there before the run is reported, not fixed or re-proved turn by turn.
test("the project checks run once before the first packet, and only new failures are fixed", () => {
  const deferred = flat(part(RUNS, "- The spec's project checks", "- `task_type` is empty"));
  assert.match(deferred, /Before the first batch, run the project checks once on the project as it is/);
  assert.match(deferred, /new against that first run/);
  assert.match(deferred, /already there before the run[^.]*reported/);
});

// fallbackLeaf (executor/tools.ts) reads the policy's default leaf, then its first reachable Claude leaf; it never reads
// the chat's model.
test("the runs file names the ladder's last-attempt model as code picks it", () => {
  const runs = flat(RUNS);
  assert.doesNotMatch(runs, /the chat's model/);
  assert.match(runs, /on the policy's default model when that is a Claude model, else on its first Claude model the run can reach/);
});

// Greenfield bounds its fix rounds and reports what still fails at the next gate; brownfield's rounds say the same.
test("fix rounds are bounded as greenfield's are, and what still fails is reported at the next gate", () => {
  const deferred = flat(part(RUNS, "- The spec's project checks", "- `task_type` is empty"));
  assert.match(deferred, /repeat while the number of failures goes down, at most three fix rounds/);
  assert.match(deferred, /still fails after the rounds[^.]*reported at the next gate/);
  // After the senior review greenfield runs the checks once more with one repair round; the test run here is that run.
  const p7 = flat(part(RUNS, "## Phase 7", "## Phase 8"));
  assert.match(p7, /Then run the failing tests once more: one fix round, as greenfield allows after its senior review/);
  assert.match(p7, /What still fails is reported at the next gate/);
});

// The architect is the only planner, so it is the one the stack adapters' wiring, migration and placement rules must
// reach, in the spec's own terms.
test("the architect copy reads the stack guidance and turns its wiring into units", () => {
  const arch = flat(SECTIONS["brownfield-architect"]);
  assert.match(arch, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pipeline\/stacks\//);
  for (const f of ["nest.md", "python.md", "generic.md", "stack-profile.md"]) assert.ok(arch.includes(f), f);
  assert.match(arch, /an `edit` unit of the wiring file that `depends_on` the unit it registers/);
  assert.match(arch, /Instead of section 6's "the paired-packet edits per §7\.9"/);
});

// The reproducing test's rules code enforces: a red verdict is an exit code only, so the file also has a check that
// proves it loads; no formatter rewrites the judge; and an existing test file that already fails proves nothing.
test("the architect copy states the red-check rules code enforces", () => {
  const arch = flat(SECTIONS["brownfield-architect"]);
  assert.match(arch, /at least one check in `checks` that proves the file is well-formed/);
  assert.match(arch, /A red check has no `fix`/);
  assert.match(arch, /already fails before the change/);
});

// ---------------------------------------------------------------------------
// The texts against the code they describe: the apply loop (apply.ts), the batch (batch.ts), the busy-vendor bounds
// (executor/tools.ts), plan-lint and finalize (lib/change-spec.mjs) and the fix rounds (findings-to-packets.mjs).
// Where a text states a number or a rule, the test reads it from the code, so the two cannot drift apart.
// ---------------------------------------------------------------------------

const SRC = (p) => read(`plugin/mcp/model-dispatch/src/${p}`);
const SPEC_LIB = read("plugin/scripts/lib/change-spec.mjs");
const F2P = read("plugin/scripts/findings-to-packets.mjs");
/** A row of the runs file's receipt table: [what happened, what you do]. */
function receiptRow(status) {
  const receipts = flat(part(RUNS, "Read the receipt's `status`", "The receipt is small"));
  const m = receipts.match(new RegExp(`\\| \`${status}\` \\|([^|]*)\\|([^|]*)\\|`));
  assert.ok(m, `the receipt table has a ${status} row`);
  return { what: m[1], todo: m[2], all: m[1] + m[2] };
}
/** Greenfield's busy-vendor bounds, as the server states them (executor/tools.ts TRANSPORT). */
function transportBounds() {
  const m = SRC("executor/tools.ts").match(/export const TRANSPORT = \{ maxWaits: (\d+), baseMs: [\d_]+, capMs: ([\d_]+) \}/);
  assert.ok(m, "executor/tools.ts states TRANSPORT");
  return { maxWaits: Number(m[1]), capMs: Number(m[2].replace(/_/g, "")) };
}

// runApplyLoop refuses a packet before any call when its answer could not stand whatever it said: its file is outside
// the write contract, it is a fix round aimed at the reproducing test, the person's settings deny one of its commands,
// or it adds the reproducing case to a test file that already fails. Each refusal has its own next step.
test("the refused row names every refusal the server makes before a typist is paid, and what the orchestrator does", () => {
  const loop = SRC("apply.ts");
  for (const reason of ["the reproducing test judges the fix; a problem in it goes back to the architect", "the person's Claude settings deny it", "the test file already fails before the change", "stop and tell the person which command the plan needs and why"]) {
    assert.ok(loop.includes(reason), `apply.ts refuses: ${reason}`);
  }
  const { what, todo } = receiptRow("refused");
  assert.match(what, /before any typist is paid/);
  for (const r of [/write contract/, /a fix round aimed at a bugfix's reproducing test/, /the person's Claude settings deny/, /already fails before the change/]) assert.match(what, r);
  assert.match(todo, /a scope change is the person's decision/);
  assert.match(todo, /stop and tell the person which command the plan needs and why/);
  assert.match(todo, /goes back to the architect/);
  const bug = flat(part(RUNS, "**A bugfix proves itself", "## Phase 2"));
  assert.match(bug, /refuses that packet before any typist is paid/);
  assert.match(bug, /point the red check at the new case only, or put the case in a new test file/);
});

// The loop counts a busy vendor's waits apart from attempts (greenfield's TRANSPORT bounds), and puts the file back when
// a packet ends with no answer standing; only the statuses in KEEPS_ITS_WRITE keep the last attempt, and only when that
// attempt was written.
test("the dispatch_failed, no_content and escalate rows say what the loop counts and what it leaves on disk", () => {
  const { maxWaits, capMs } = transportBounds();
  const keeps = SRC("apply.ts").match(/const KEEPS_ITS_WRITE = new Set<ApplyStatus>\(\[([^\]]*)\]\)/);
  assert.ok(keeps, "apply.ts names the statuses that keep their write");
  const kept = [...keeps[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const df = receiptRow("dispatch_failed").what;
  assert.match(df, new RegExp(`up to ${maxWaits} waits for each attempt`));
  assert.match(df, /`transport_waits`/);
  assert.match(df, /every other vendor failure is an attempt on the ladder/);
  assert.equal(capMs, 60_000, "the texts say a minute");
  assert.match(df, /a pause longer than a minute is an attempt, and the next attempt waits a minute first/);
  for (const s of ["dispatch_failed", "no_content"]) {
    assert.ok(!kept.includes(s), `${s} puts the file back`);
    assert.match(receiptRow(s).what, /[Nn]othing of the packet stays on disk/, s);
  }
  const nc = receiptRow("no_content").what;
  for (const r of [/outside the contract/, /edits that do not apply/, /an answer naming another file/, /an empty file/]) assert.match(nc, r);
  assert.ok(kept.includes("escalate"), "escalate keeps its last write");
  const esc = receiptRow("escalate").all;
  assert.match(esc, /on disk only when it was written/);
  assert.doesNotMatch(esc, /In `content` mode the last attempt is on disk at `artifact_path`/);
});

// The server runs a packet's commands itself (apply.ts runShell, packetCommands), where Claude Code's own Bash check
// does not reach: the texts say how, once, so the orchestrator neither re-runs them nor expects a denied one to run.
test("Phase 4 says how the server runs a packet's commands, how plan-lint tries them first, and what a fix round's packets take", () => {
  const shell = SRC("apply.ts");
  assert.match(shell, /spawn\("\/bin\/sh", \["-c", cmd\], \{ cwd, env: commandEnv\(process\.env\), stdio: \[[^\]]*\], detached: true \}\)/);
  const checks = flat(part(RUNS, "- `apply.checks`", "- The spec's project checks"));
  for (const r of [/in its own process group/, /without the vendor credentials the server holds/, /killed whole at its time limit/, /refused when the person's Claude settings deny it/]) assert.match(checks, r);
  assert.match(checks, /a reproducing check's write form never runs/);
  assert.match(checks, /A fix round's packets \(`apply\.baseline: false`\) take no baseline: every check judges the fix/);
  // plan-lint runs each unit's checks on its file as it is (lib/change-spec.mjs baselineErrors); dispatch's baseline is the backstop.
  assert.match(SPEC_LIB, /export async function baselineErrors/);
  assert.match(checks, /plan-lint runs each unit's checks on its file as it is[^.]*and refuses one that fails there/);
  assert.match(checks, /The server's baseline at dispatch stays as the backstop/);
  assert.match(checks, /the red verdict is the exit code alone/);
});

// A hand-written packet is not this run's, but the table says what code fills, so the fields that change how the server
// types and judges a packet are named: the run's job (typed by greenfield's typists only with it) and a fix's baseline.
test("the apply form and the orchestrator copy name every field code fills, the run's job and a fix round's baseline among them", () => {
  assert.match(SRC("applyTypist.ts"), /BROWNFIELD_INTENTS\.has\(String\(packet\.intent/);
  assert.match(F2P, /baseline: false/);
  const form = flat(part(RUNS, "**Apply form", "Read the receipt's `status`"));
  assert.match(form, /\| `intent` \|/);
  assert.match(form, /"baseline"\?: false/);
  assert.match(form, /expect\?: "fail"/);
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /\| `intent` \|/);
  assert.match(orch, /baseline\?: false/);
});

// change-spec.mjs jobRules and unitJobErrors: what each job may hold. Only a job with a Gate 2 for every run holds a
// tooling unit (GATE2_JOBS), a docs run holds documentation units only, a bugfix its reproducing tests and its fixes.
test("the jobs table states every rule code checks for a job, and which jobs hold no tooling unit, as code decides", async () => {
  const { GATE2_JOBS, JOBS } = await import(join(ROOT, "plugin", "scripts", "lib", "change-spec.mjs"));
  const table = part(RUNS, "| Job |", "For refactor");
  const row = (job) => flat(table.split("\n").find((l) => new RegExp(`^\\| [^|]*\`${job}\``).test(l)) ?? "");
  for (const job of JOBS) {
    if (GATE2_JOBS.includes(job)) assert.doesNotMatch(row(job), /no `tooling` unit/, job);
    else assert.match(row(job), /no `tooling` unit|only those units/, job);
  }
  assert.match(row("deps"), /every other unit is typed before the install \(the manifest edit, which the install waits for\) or waits for it/);
  assert.match(row("bugfix"), /plus a check that must pass; a red check has no `fix`/);
  assert.match(row("bugfix"), /only those units/);
  assert.match(row("test"), /at least one tests unit/);
  assert.match(row("docs"), /documentation units only \(`phase: docs`\)/);
  assert.match(SPEC_LIB, /a docs run holds documentation units only/);
  assert.match(SPEC_LIB, /a test run adds to the suite: the spec holds at least one tests unit/);
});

// plan-to-packets names the allowlist when a bugfix cannot be planned inside it: re-delegating cannot change what the
// run may write, so the line goes to the person, as does an architect that returns saying it cannot meet a rule.
test("a finalize line that names the allowlist, or an architect that cannot meet a printed rule, goes to the person", () => {
  assert.match(SPEC_LIB, /the allowlist is the person's decision/);
  const p2 = flat(part(RUNS, "## Phase 2", "## Phase 4"));
  assert.match(p2, /A line that names the write contract's allowlist is not fixed by re-delegating, and neither is an architect that returns saying it cannot meet a printed rule/);
  assert.match(p2, /stop and tell the person what the run needs and why \(the allowlist is the person's decision\)/);
});

// findings-to-packets never routes a fix to the reproducing test (D1), so a failing reproducing test after the fixes is
// sent as a failure of the source it exercises, with the test beside it.
test("a failing reproducing test is named as a failure of the source file it exercises, with the test beside it", () => {
  for (const [where, text] of [["Phase 4", flat(part(RUNS, "- The spec's project checks", "- `task_type` is empty"))], ["Phase 7", flat(part(RUNS, "## Phase 7", "## Phase 8"))]]) {
    assert.match(text, /except a bugfix's reproducing test: name the source file the failing test exercises, with the test in `context_paths`/, where);
  }
});

// Each reason findings-to-packets prints for what it does not route is in the runs file, so the orchestrator knows what
// each one asks of it.
test("Phase 6 says what a fix packet carries and lists everything findings-to-packets does not route", () => {
  for (const s of ["a finding with no file", "the reproducing test judges the fix", "a shell step no model types: run that step again", "its text is never sent to a model", "the run may not write it"]) assert.ok(F2P.includes(s), s);
  const fixes = flat(part(RUNS, "**Fix packets by code.**", "In brownfield the delegation"));
  assert.match(fixes, /`apply\.baseline: false`/);
  assert.match(fixes, /the unit's checks less those set aside when it was applied/);
  for (const r of [/a finding with no file/, /outside the project or the write contract/, /an off-limits file shown beside the failure/, /a bugfix's reproducing test/, /a tooling step's file \(run that step again, under provenance/]) assert.match(fixes, r);
});

// Claude Code refuses a helper's Write of a report file, and write-manifest and the collector write SUMMARY.md (the
// pipeline skill's Phase 9); the orchestrator's own account goes in its final message.
test("the runs file never asks the orchestrator to write or report in SUMMARY.md: what it reports goes in its final message", () => {
  assert.match(SKILL, /SUMMARY\.md is code's: do not write it yourself/);
  assert.doesNotMatch(RUNS, /SUMMARY\.md/);
  assert.match(flat(part(RUNS, "- `apply.checks`", "- The spec's project checks")), /in your final message/);
  assert.match(flat(part(RUNS, "- The spec's project checks", "- `task_type` is empty")), /reported at the next gate and in your final message/);
  assert.match(flat(part(RUNS, "**Fix packets by code.**", "In brownfield the delegation")), /list them in your final message and at the next gate/);
  assert.match(flat(part(RUNS, "`tooling` packets", "Every packet is typed")), /in your final message and at the next gate/);
});

// executorView keeps a rule that names an intent as written, and derived packets carry the run's intent, so a policy
// can route one job's stage apart from another's.
test("a derived packet is routed by its stage, and by the run's intent when a policy rule names one", () => {
  assert.match(SRC("executor/run.ts"), /if \(!narrowed\.length \|\| w\.intent !== undefined\) return rule;/);
  assert.match(SPEC_LIB, /^\s+intent,$/m);
  const b = flat(part(RUNS, "- `task_type` is empty", "## Output ceilings"));
  assert.doesNotMatch(b, /stage alone/);
  assert.match(b, /the policy routes a file by its stage, and by the run's intent when a policy rule names one/);
});

// The orchestrator plans nothing: the architect reads the stack profile while it writes the spec.
test("the orchestrator copy reads no stack profile; the architect copy does", () => {
  assert.doesNotMatch(SECTIONS["brownfield-orchestrator"], /stack-profile\.md/);
  assert.match(SECTIONS["brownfield-architect"], /stack-profile\.md/);
});

// The stack adapters are written in the change spec's terms, so the architect reads them as they are; the base's
// user-run makemigrations is replaced by the adapters' tooling unit, in the jobs code lets hold one.
test("the architect reads the stack adapters as written, and a generator the stack runs is a tooling unit only where code allows one", async () => {
  const { GATE2_JOBS, JOBS } = await import(join(ROOT, "plugin", "scripts", "lib", "change-spec.mjs"));
  for (const f of ["nest.md", "python.md", "generic.md"]) {
    assert.doesNotMatch(read(`plugin/skills/pipeline/stacks/${f}`), /paired packet|roll ?back|bug_reproduce|bug_fix_apply|packet's instruction/i, f);
  }
  assert.match(read("plugin/skills/pipeline/stacks/python.md"), /`tooling` unit that runs `python manage\.py makemigrations <app>`/);
  const arch = flat(SECTIONS["brownfield-architect"]);
  assert.doesNotMatch(arch, /Their words are a packet planner's/);
  assert.doesNotMatch(arch, /paired packets and rollback have no place/);
  assert.match(arch, /Instead of section 4's "note that `makemigrations` is a user-run step, not a plugin write"/);
  const tooling = flat(part(SECTIONS["brownfield-architect"], "- `tooling`:", "**What each job"));
  for (const job of JOBS) assert.equal(tooling.includes(`\`${job}\``), GATE2_JOBS.includes(job), `the tooling bullet names ${job} only if it may hold one`);
  assert.match(tooling, /plan-lint refuses one in any other job/);
});

// With `&&` a failed step skips the `--after` that follows it, so the files it wrote keep sha_after empty and
// /mmo:revert reads them as changed after the run instead of restoring them.
test("a tooling step's provenance calls are never chained to the step with &&: --after runs whether the step succeeded or not", () => {
  for (const [name, text] of [["orchestrator section", SECTIONS["brownfield-orchestrator"]], ["brownfield-runs.md", RUNS]]) {
    // Every sentence that chains calls with `&&` names no tooling step or provenance call ("never `&&`" is the rule itself).
    for (const s of flat(text).split(/(?<=[.:])\s+(?=[A-Z*])/)) {
      if (s.replaceAll("never `&&`", "").includes("&&")) assert.doesNotMatch(s, /tooling|provenance/i, `${name}: ${s.slice(0, 160)}`);
    }
    assert.match(flat(text), /joined with `;` and never `&&`/, name);
    assert.match(flat(text), /`<the --before calls>; <step>; rc=\$\?; <the --after calls>; echo "step exit: \$rc"`/, name);
  }
  // The base's step 3 runs --after "after every Write/Edit succeeds"; around a tooling step it runs either way.
  assert.match(flat(part(SECTIONS["brownfield-orchestrator"], "**Provenance in this run.**")), /then `--after` for each whether the step succeeded or not/);
});

// The base orchestrator points at the whole pipeline skill twice; the runs file names the sections this run reads.
test("the orchestrator copy replaces the base's pointers to the whole pipeline skill with the sections the runs file names", () => {
  const orch = flat(SECTIONS["brownfield-orchestrator"]);
  assert.match(orch, /Instead of "See `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pipeline\/SKILL\.md` for canonical examples per phase" and "See `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pipeline\/SKILL\.md` for the full state machine, TaskPacket examples, and HITL prompt templates"/);
  assert.match(orch, /the SKILL\.md sections brownfield-runs\.md names, and nothing else/);
});

// `.env.example` is on the always-off-limits list (`.env.*`, lib/off-limits.mjs), so no unit, fix round or write of
// the run can change it: the new keys are listed for the person at the mini-gate.
test("Phase 7 replaces the base's own write of .env.example: the file is always off-limits, so the new keys are listed for the person", async () => {
  const p7 = flat(part(RUNS, "## Phase 7", "## Phase 8"));
  assert.match(p7, /Instead of step 1's "Append the new keys to `\.env\.example`/);
  assert.match(p7, /always-off-limits list \(`\.env\.\*`\), so no unit, fix round or write of this run changes it/);
  assert.match(p7, /steps 2 and 3/);
  const { HARDCODED_OFF_LIMITS } = await import(join(ROOT, "plugin", "scripts", "lib", "off-limits.mjs"));
  assert.ok(HARDCODED_OFF_LIMITS.includes(".env.*"), "the text holds while .env.* is on the list");
});

// execute_batch (batch.ts): a skipped tooling step blocks what waits for it, the receipt lists each step with its
// instruction, a packet the run already applied settles at $0, and the end-of-run checks ride in the receipt.
test("one batch carries the phase: what waits for a tooling step comes back blocked by it, and the receipt says what to run", () => {
  const b = SRC("batch.ts");
  for (const f of ["tooling_steps", "already_applied", "verify_deferred", "transport_waits", "blocked_by"]) assert.ok(b.includes(f), f);
  assert.match(SRC("server.ts"), /and this call names/);
  const batch = flat(part(RUNS, "**Batch the phase", "Every packet is typed"));
  assert.doesNotMatch(batch, /batch everything before the tooling step, run it, batch the rest/);
  assert.match(batch, /`tooling_steps`/);
  assert.match(batch, /run the step, then send the blocked ids in one more `execute_batch` with `packet_ids`/);
  const row = batch.match(/\| `already_applied` \|([^|]*)\|/);
  assert.ok(row, "already_applied has a row");
  assert.match(row[1], /\$0/);
  assert.match(batch, /`items\[\]\.attempts` counts attempts only: a busy vendor's waits are in `transport_waits`/);
  assert.match(batch, /naming another policy is refused/);
  assert.match(flat(part(RUNS, "- The spec's project checks", "- `task_type` is empty")), /the batch receipt's `verify_deferred`/);
});

// plan-lint checks the rules the architect copy states (lib/change-spec.mjs checkUnits, baselineErrors, headerErrors).
test("the architect copy states each rule plan-lint checks on a section, as code checks it", () => {
  for (const s of ['code puts the path in single quotes itself, so ./{path} works and "./{path}" does not', "a test file names at least one file check that runs or loads it", "narrow it with lines", "its text is never sent to a model", "point the red check at the new case only, or put the case in a new test file"]) assert.ok(SPEC_LIB.includes(s), s);
  const arch = flat(SECTIONS["brownfield-architect"]);
  assert.doesNotMatch(arch, /no probing: before the change, code runs each check/);
  assert.match(arch, /`\{path\}` outside quotes \(code quotes the path itself: `\.\/\{path\}` works, `"\.\/\{path\}"` does not\)/);
  assert.match(arch, /When you check a units section, plan-lint runs each unit's checks on its file as it is \(a new file's style file\) and refuses one that fails there, with its output/);
  assert.match(arch, /Give each plan-lint Bash call a timeout of 600000 ms/);
  assert.match(arch, /a tests unit names at least one check that runs or loads its file/);
  assert.match(arch, /its red checks must pass before the change \(plan-lint runs them\)/);
  assert.match(arch, /plan-lint checks these on each section \(it reads the job from `intent_brief\.md`\)/);
  assert.match(arch, /the exception to the import-edge rule/);
  assert.match(arch, /if the test file the bug needs is outside the allowlist, return and say which file and why/);
  assert.match(arch, /never name an off-limits file \(plan-lint refuses it\)/);
  assert.match(arch, /over the server's bound on one input is refused: narrow it with lines/);
});
