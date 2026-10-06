/**
 * The documents a person reads about brownfield runs say what the code does.
 *
 * Why: a change to the code can leave a sentence behind in a document the change does not reopen, and a reader acts on
 * that sentence: approves a run on a regulated repository from the privacy page, picks a policy from the cost table,
 * frees a project from the write-contract page, or follows a shipped example. So each claim below is checked against
 * what it describes: a number is computed from the code, or from the measured table the documents publish; the write
 * contract's behaviour is checked by running its hook; and each shipped brownfield example's documented scope is run
 * through plan-lint. A number a page quotes from the server (a time limit, a wait) is read from the server's own
 * constants; an event a page indexes is one the server logs; a rule a page repeats from the text a run follows (the
 * jobs table in brownfield-runs.md, the pipeline skill, an agent's front matter) is compared with that text.
 *
 * Offline, $0: files of this repository are read, the server's compiled modules are imported (no model is called), and
 * the contract scripts and plan-lint run on temporary copies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
const PLUGIN = join(ROOT, "plugin");
const SRC = join(PLUGIN, "mcp", "model-dispatch", "src");

const README = read("README.md");
const PRIVACY = read("docs", "brownfield-privacy.md");
const ROUTING = read("docs", "brownfield-routing.md");
const CONTRACT_DOC = read("docs", "brownfield-write-contract.md");
const MANUAL = read("docs", "ambient-mode.md");
const NOTES = read("docs", "methodology.md");
const LOGGING = read("docs", "logging.md");
const APPLY = read("plugin", "mcp", "model-dispatch", "src", "apply.ts");
const BROWNFIELD = read("docs", "brownfield.md");
const RUNNING = read("docs", "running.md");
const REPO_GUIDE = read("docs", "repo-guide.md");
const ARCH = read("docs", "architecture.md");
const TROUBLE = read("docs", "troubleshooting.md");
/** The text a brownfield run follows: its jobs table is what every page's list of jobs repeats. */
const RUNS = read("plugin", "skills", "pipeline", "brownfield-runs.md");

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const numberOf = (w) => (/^\d+$/.test(w) ? Number(w) : WORDS.indexOf(String(w).toLowerCase()));

/** Every file under `dir`, recursively. */
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The text of a Markdown section: from its heading line to the next heading of the same or a higher level. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `a "${heading}" section`);
  const level = /^#+/.exec(heading)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// The measured table the documents publish (docs/brownfield-routing.md, "What the runs measured")
// ---------------------------------------------------------------------------

/** The studies, one row each: `| feature-extend 1 | $3.89 | $2.92 | $6.28 |` (opus-only, completion door, agent door). */
function studies() {
  return [...ROUTING.matchAll(/^\| ((?:feature-extend|refactor|bugfix|docs|test|deps|feature-new)[^|]*?) \| \$([\d.]+) \| \$([\d.]+) \| \$([\d.]+) \|$/gm)]
    .map((m) => ({ name: m[1], opus: Number(m[2]), completion: Number(m[3]), agent: Number(m[4]) }));
}
const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// Privacy: what a packet sends, and what checks it
// ---------------------------------------------------------------------------

test("the privacy page says what a typist's packet carries: an edited file whole, up to the server's bound on one input", () => {
  const bound = Number(/export const MAX_SLICE_BYTES = ([\d_]+);/.exec(APPLY)?.[1].replace(/_/g, ""));
  assert.ok(bound > 0, "apply.ts states its bound on one input");
  assert.doesNotMatch(PRIVACY, /\| Codegen packets \|[^\n]*Slices only/, "a code packet is not sent slices only: derivePackets sends the edited file whole");
  assert.match(PRIVACY, /file being edited, whole|edited file, whole|edited file whole/i);
  assert.ok(PRIVACY.includes(`${bound.toLocaleString("en-US")} bytes`), `the page names the server's bound on one input, ${bound.toLocaleString("en-US")} bytes`);
  // The one read rule for everything sent to a model: off-limits files are never read into a prompt, whatever the case.
  assert.match(PRIVACY, /never read into a model's prompt/);
  assert.match(PRIVACY, /letter case/);
});

test("no document says the secret sweep runs on dispatch inputs unless the server runs it, and its pattern count is the script's", async () => {
  // Wired = some server source other than the log redactor (log.ts, redact.ts) uses the pattern registry.
  const users = walk(SRC).filter((f) => f.endsWith(".ts") && !/[\\/](redact|log)\.ts$/.test(f))
    .filter((f) => /findPatternNames|redactText|dispatch-sanitize/.test(readFileSync(f, "utf8")));
  const claims = [/regex sweep on \*\*every\*\* dispatch/i, /Detected patterns → dispatch is refused/i, /uses to block a dispatch/i, /already have been refused before dispatch/i];
  if (users.length === 0) {
    for (const [name, text] of [["docs/brownfield-privacy.md", PRIVACY], ["docs/logging.md", LOGGING]]) {
      for (const re of claims) assert.doesNotMatch(text, re, `${name} claims the sanitizer checks dispatch inputs, but no server code runs it`);
    }
  }
  const { PATTERNS } = await import(join(PLUGIN, "scripts", "dispatch-sanitize.mjs"));
  for (const m of PRIVACY.matchAll(/\b(\d+) patterns\b/g)) assert.equal(Number(m[1]), PATTERNS.length, `"${m[0]}": the script has ${PATTERNS.length}`);
});

test("the brownfield pages say which commands the server runs, outside Claude Code's Bash rules and sandbox", () => {
  // The server runs a file's checks itself (a shell in the project folder), so Claude Code's Bash rules never see them.
  const runsCommands = walk(SRC).some((f) => f.endsWith(".ts") && /shell:\s*true|["']\/bin\/sh["']/.test(readFileSync(f, "utf8")));
  assert.ok(runsCommands, "the server runs shell commands (a file's checks)");
  assert.doesNotMatch(PRIVACY, /\*\*Nothing\.\*\* `Bash` runs your test command locally/, "not every command runs through Bash");
  const commands = section(PRIVACY, "## Commands the run executes on your machine");
  for (const word of ["red check", "`fix`", "`verify_deferred`", "sandbox", "deny rules", "credentials", "tooling"]) {
    assert.ok(commands.includes(word), `the privacy page's commands section names ${word}`);
  }
  const writer = section(CONTRACT_DOC, "## The server's writer (apply form and `execute_batch`)");
  assert.match(writer, /Bash rules/);
  assert.match(writer, /sandbox/);
});

// ---------------------------------------------------------------------------
// Policies and cost (README, brownfield-routing)
// ---------------------------------------------------------------------------

test("every count of shipped policies is the policies folder's, and every policy table has the rows its lead-in counts", () => {
  const shipped = readdirSync(join(PLUGIN, "config", "policies")).filter((f) => f.endsWith(".yaml")).length;
  for (const [name, text] of [["README.md", README], ["docs/brownfield-routing.md", ROUTING]]) {
    for (const m of text.matchAll(/\b(\w+) (?:shipped )?policies (?:ship|cover)\b/gi)) {
      assert.equal(numberOf(m[1]), shipped, `${name}: "${m[0]}", but plugin/config/policies holds ${shipped}`);
    }
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("| Policy |"));
    assert.ok(at > 0, `${name} has a policy table`);
    const lead = lines.slice(0, at).reverse().find((l) => l.trim() !== "");
    const rows = lines.slice(at + 2).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("| `"))).length;
    const counted = [...lead.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine)\b/gi)].map((m) => numberOf(m[1]));
    assert.equal(counted.length, 1, `${name}: the table's lead-in ("${lead}") counts its rows`);
    assert.equal(counted[0], rows, `${name}: "${lead}" over a table of ${rows} rows`);
  }
});

test("the README's cost columns are the measured feature-extend studies, and the session share and savings are computed from the published figures", () => {
  const all = studies();
  const fe = all.filter((s) => s.name.startsWith("feature-extend"));
  assert.ok(fe.length >= 1 && all.length > fe.length, "the routing page's table has the feature-extend studies and others");
  const range = (k) => [round1(Math.min(...fe.map((s) => s[k]))), round1(Math.max(...fe.map((s) => s[k])))];
  const header = README.split("\n").find((l) => l.startsWith("| Policy |"));
  const label = /\| Policy \| Uses \| ([^|]+) \|/.exec(header)[1];
  const m = /\b(\w+) feature-extend studies\b/.exec(label);
  assert.ok(m && numberOf(m[1]) === fe.length, `the column says it holds the ${fe.length} feature-extend studies ("${label}")`);
  for (const [policy, k] of [["opus-only", "opus"], ["opus-plus-flash", "completion"]]) {
    const row = new RegExp(`^\\| \`${policy}\`[^|]*\\|[^|]*\\| \\$([\\d.]+) – ([\\d.]+) \\|`, "m").exec(README);
    assert.ok(row, `the README has a ${policy} row with a dispatched range`);
    assert.deepEqual([Number(row[1]), Number(row[2])], range(k), `${policy}: the feature-extend studies give $${range(k).join(" – ")}`);
  }
  // The session's share of the measured run's true total, from the routing page's own figures.
  const session = Number(/\$(\d+(?:\.\d+)?) of session/.exec(ROUTING)?.[1]);
  const total = Number(/true total \$(\d+(?:\.\d+)?)/.exec(ROUTING)?.[1]);
  assert.ok(session > 0 && total >= session, "the routing page gives the session and the true total");
  const share = Math.round((100 * session) / total);
  for (const [name, text] of [["README.md", README], ["docs/brownfield-routing.md", ROUTING]]) {
    const stated = [...text.matchAll(/(\d+)% of (?:the bill|a run|the true total|the run)/g)];
    assert.ok(stated.length > 0, `${name} states the session's share`);
    for (const s of stated) assert.equal(Number(s[1]), share, `${name}: "${s[0]}", but $${session} of $${total} is ${share}%`);
  }
  // What the completion door saved on each study, against opus-only.
  const saved = all.map((s) => 100 * (1 - s.completion / s.opus));
  const want = [Math.round(Math.min(...saved)), Math.round(Math.max(...saved))];
  for (const [name, text] of [["README.md", README], ["docs/brownfield-routing.md", ROUTING]]) {
    const stated = [...text.matchAll(/(?:saves?|saved) (\d+)–(\d+)%|(\d+)–(\d+)% (?:less|under|below)/g)];
    assert.ok(stated.length > 0, `${name} states what the completion door saved`);
    for (const s of stated) assert.deepEqual([Number(s[1] ?? s[3]), Number(s[2] ?? s[4])], want, `${name}: "${s[0]}", but the studies give ${want.join("–")}%`);
  }
});

test("no document claims a cost multiple larger than the measured studies show", () => {
  const max = Math.max(...studies().map((s) => s.opus / s.completion));
  const docs = ["README.md", "docs/README.md", "docs/brownfield-routing.md", "docs/tutorial-first-run.md", "docs/methodology.md", "docs/running.md", "docs/assets/hero.svg"];
  const claim = /(\d+(?:\.\d+)?)\s*×\s*(?:cheaper|more per run|cost drop|less)|(?:drops? cost|cost drop|cheaper)\s*(?:by\s*)?~?\s*(\d+(?:\.\d+)?)\s*×|not (\d+(?:\.\d+)?)\s*×|\b(\w+) times (?:lower|cheaper|less)/gi;
  for (const name of docs) {
    for (const m of read(...name.split("/")).matchAll(claim)) {
      const n = m[4] !== undefined ? numberOf(m[4]) : Number(m[1] ?? m[2] ?? m[3]);
      assert.ok(n <= max, `${name}: "${m[0]}", but the measured studies show at most ${max.toFixed(2)}× (opus-only over opus-plus-flash)`);
    }
  }
});

test("the routing page offers no lever the code does not have, and lists only the packet labels code derives", () => {
  // Apply packets ask for the routed model's documented output limit, so no fixed codegen ceiling is a lever.
  if (/max_output_tokens_absolute/.test(APPLY)) assert.doesNotMatch(ROUTING, /output ceiling \d+ instead of \d+/i);
  // No agent or skill text has a light security review.
  const texts = [...walk(join(PLUGIN, "agents")), ...walk(join(PLUGIN, "skills"))].filter((f) => f.endsWith(".md")).map((f) => readFileSync(f, "utf8"));
  if (!texts.some((t) => /form: light|--form=light|`light` security review/.test(t))) {
    for (const [name, text] of [["docs/brownfield-routing.md", ROUTING], ["README.md", README]]) assert.doesNotMatch(text, /`light` security review/, name);
  }
  // The labels a derived packet carries (lib/change-spec.mjs SUBTYPE, and bug_reproduce for a reproducing test).
  const spec = read("plugin", "scripts", "lib", "change-spec.mjs");
  const labels = new Set([...(/const SUBTYPE = (\{[^\n]*\});/.exec(spec)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  if (/"bug_reproduce"/.test(spec)) labels.add("bug_reproduce");
  assert.ok(labels.size >= 5, "change-spec.mjs names its packet labels");
  const perJob = section(ROUTING, "## Per job");
  for (const m of perJob.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(labels.has(m[1]), `the per-job section names ${m[1]}, a label code never derives`);
  assert.match(perJob, /brownfield-runs\.md#the-jobs/, "the per-job section points at the jobs table the run follows");
  // Every job runs the architect: no job is listed with its judgment phases but without the change spec.
  assert.doesNotMatch(perJob, /^\| `(?:docs|bugfix|test)` \|(?![^\n]*change spec)[^\n]*requirements/m, "docs, bugfix and test are listed without the change spec");
  assert.match(perJob, /change spec/);
});

// ---------------------------------------------------------------------------
// Zero-touch manual
// ---------------------------------------------------------------------------

test("the zero-touch manual names write-contract.mjs among the own steps, counts no agents, and says what abortRun does", async () => {
  // Zero-touch lets the contract's own script through as a step (lib/own-steps.mjs), in some form.
  const ownSteps = read("plugin", "scripts", "ambient", "lib", "own-steps.mjs");
  const steps = MANUAL.slice(MANUAL.indexOf("**The workflow's own steps run without permission prompts**"));
  const paragraph = steps.slice(0, steps.indexOf("\n\n"));
  if (/write-contract\.mjs/.test(ownSteps)) {
    assert.match(paragraph, /`write-contract\.mjs`/, "the own-steps paragraph names write-contract.mjs");
    assert.match(paragraph, /`\.sdlc\/local\/write-contract\.json`/, "and what it writes outside the run's folder");
    assert.match(paragraph, /`--abandon`[^.]*(?:never|not)/, "and that its --abandon is the person's to approve, never an own step");
  }
  const agents = readdirSync(join(PLUGIN, "agents")).filter((f) => f.endsWith(".md")).length;
  for (const m of MANUAL.matchAll(/\b(\w+) mmo agents\b/gi)) {
    assert.equal(numberOf(m[1]), agents, `"${m[0]}", but plugin/agents holds ${agents}`);
  }
  const replace = MANUAL.slice(MANUAL.indexOf("**Replace it.**"));
  const sentence = replace.slice(0, replace.indexOf("\n\n"));
  assert.doesNotMatch(sentence, /as the brownfield manual's abort step does/, "the manual's abort step freezes and switches off nothing");
  assert.match(sentence, /`write-contract\.mjs --abandon`/, "abortRun ends the run and switches its contract off, as --abandon does");
});

// ---------------------------------------------------------------------------
// The write contract, checked by running its hook
// ---------------------------------------------------------------------------

const HOOK = join(PLUGIN, "scripts", "write-contract-check.mjs");
const WRITE_CONTRACT = join(PLUGIN, "scripts", "write-contract.mjs");
/** A git project with one source file, its run r1 frozen at Gate 0 with allowlist src/** (and `extra` flags). */
function frozenProject(extra = []) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mmo-docs-contract-")));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".sdlc", "runs", "r1"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  const r = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", '[".env*"]', "--project-root", dir, ...extra], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}
const hook = (dir, rel) => spawnSync(process.execPath, [HOOK], { cwd: dir, encoding: "utf8", input: JSON.stringify({ tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, rel), content: "x" } }) });
const CONTRACT = (dir) => join(dir, ".sdlc", "local", "write-contract.json");

test("a deleted contract under a live freeze record refuses every write, and the page's steps say so", () => {
  const dir = frozenProject();
  try {
    unlinkSync(CONTRACT(dir));
    assert.equal(hook(dir, "src/a.js").status, 2, "inside the allowlist too");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(CONTRACT_DOC, /If the file is missing or `active:false` → allow/, "a missing contract under a live freeze record is not 'allow'");
  assert.doesNotMatch(CONTRACT_DOC, /Denials only happen when the contract parses cleanly AND is active/);
  // The tamper rule comes before the rule that lets a switched-off contract through.
  const steps = section(CONTRACT_DOC, "## The hook").replace(/\s+/g, " ");
  const tamper = steps.search(/no longer matches[^.]*refuses every write/);
  const off = steps.indexOf("`active:false`");
  assert.ok(tamper >= 0 && off >= 0 && tamper < off, "the hook's steps put the freeze record's check before the switched-off case");
});

test("deleting the run's own log frees the run, and the page says exactly that", () => {
  const dir = frozenProject();
  try {
    unlinkSync(join(dir, ".sdlc", "runs", "r1", "orchestrator.log"));
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, allowlist: ["**"] }, null, 2) + "\n");
    assert.equal(hook(dir, "docs/x.md").status, 0, "the widened contract binds once the record is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(CONTRACT_DOC, /freeing a live run takes a forged end/);
  assert.match(CONTRACT_DOC, /lives only in the run's own log/);
  assert.match(CONTRACT_DOC, /[Dd]eleting or emptying that log, or the run folder, frees the run/);
  assert.match(CONTRACT_DOC, /destruction of the run's own record, not a cleanup/);
  // The person's way to end a run that will never end by itself (a crash, a closed chat, a halted start check).
  assert.match(CONTRACT_DOC, /write-contract\.mjs --abandon --run-id/);
});

test("the server's writer table says when an agent-door packet is typed and when it is refused", () => {
  const typist = read("plugin", "mcp", "model-dispatch", "src", "applyTypist.ts");
  assert.match(typist, /typistDoorFor/, "the agent door has a typist on the brownfield path");
  const row = section(CONTRACT_DOC, "## The server's writer (apply form and `execute_batch`)").split("\n").find((l) => l.includes("`antigravity-worker`"));
  assert.ok(row, "the table has an agent-door row");
  assert.doesNotMatch(row, /\| Refuses the packet\. An agent-door worker edits the folder itself, outside this check\. \|/);
  assert.match(row, /scratch folder/);
  assert.match(row, /`preflight_dispatch`/);
});

/** The hook's numbered steps (docs/brownfield-write-contract.md, "The hook"), each as one line of text. */
function hookSteps() {
  const text = section(CONTRACT_DOC, "## The hook");
  return text.split(/\n(?=\d+\. )/).filter((s) => /^\d+\. /.test(s)).map((s) => s.replace(/\s+/g, " "));
}
const stepWith = (label) => {
  const found = hookSteps().find((s) => s.includes(label));
  assert.ok(found, `a hook step with ${label}`);
  return found;
};

test("the always-off-limits list stays refused under a switched-off contract and under strict = false, and the pages say so", () => {
  // A run ended on purpose (--abandon): its contract is switched off, and .env is still refused.
  const ended = frozenProject();
  try {
    const r = spawnSync(process.execPath, [WRITE_CONTRACT, "--abandon", "--run-id", "r1", "--project-root", ended], { cwd: ended, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(CONTRACT(ended), "utf8")).active, false);
    assert.equal(hook(ended, "docs/x.md").status, 0, "a switched-off contract binds nothing");
    assert.equal(hook(ended, ".env").status, 2, ".env is refused under a switched-off contract");
  } finally { rmSync(ended, { recursive: true, force: true }); }
  // A live run frozen with --strict-write=off: its off-limits and allowlist refusals are warnings, nothing more.
  const loose = frozenProject(["--strict-write=off"]);
  try {
    assert.equal(hook(loose, "docs/x.md").status, 0, "outside the allowlist: a warning under strict = false");
    assert.equal(hook(loose, ".env").status, 2, "the always-off-limits list is refused under strict = false");
    assert.equal(hook(loose, ".sdlc/local/write-contract.json").status, 2, "the run's contract, while its freeze record is live");
    assert.equal(hook(loose, ".sdlc/runs/r1/orchestrator.log").status, 2, "the run's own log, while its freeze record is live");
  } finally { rmSync(loose, { recursive: true, force: true }); }
  // The page's steps: a contract that binds nothing still refuses the always-off-limits list, and strict = false
  // never opens it.
  assert.match(stepWith("**A contract that binds nothing**"), /except the always-off-limits list/);
  const strict = stepWith("`--strict-write=off`");
  assert.match(strict, /never opens the always-off-limits list/);
  assert.match(strict, /never the run's own contract or log while its freeze record is live/);
  assert.doesNotMatch(strict, /turns each refusal of step \d+ into a warning, except the contract/);
  // The FAQ's escape hatch, and the flag's row in running.md.
  const faq = CONTRACT_DOC.split("\n").find((l) => l.startsWith("| Can the AI bypass the contract?"));
  assert.match(faq, /`--strict-write=off`, passed by you at the start\. Mid-run: none; a wider scope is a new run with its own Gate 0\./);
  const flag = RUNNING.split("\n").find((l) => l.startsWith("| `--strict-write=off`"));
  assert.doesNotMatch(flag, /Every off-limits or not-in-allowlist write is logged but not refused/);
  assert.match(flag, /always-off-limits list/);
  assert.match(flag, /while its freeze record is live/);
});

test("the session's project contract decides a target in a nested git project, and the page says so", () => {
  const dir = frozenProject();
  try {
    mkdirSync(join(dir, "vendor", "lib", ".git"), { recursive: true });
    assert.equal(hook(dir, "vendor/lib/x.js").status, 2, "a nested git project inside the session's project is held to its allowlist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(stepWith("**Which contract.**"), /The session's own project contract also decides targets inside its project, nested git projects included/);
});

test("--freeze refuses a folder that is not a git project's root, and a run's log is written only by the plugin's code; the page says both", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mmo-docs-nogit-")));
  try {
    const r = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--project-root", dir], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2, "no .git: no contract is written");
    assert.match(r.stderr, /not the root of a git project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const record = section(CONTRACT_DOC, "## The freeze record, said exactly").replace(/\s+/g, " ");
  assert.match(record, /a project root that is not a git project's root/);
  // Who writes a run's own log: the plugin's code, never a Write or Edit of the run (the hook's deny message says so).
  assert.match(read("plugin", "scripts", "write-contract-check.mjs"), /the log is written by the plugin's scripts only/);
  const binds = stepWith("**A live run's contract binds:**");
  for (const writer of ["`mmo-log.mjs`", "`write-contract.mjs`", "zero-touch's stop"]) assert.ok(binds.includes(writer), `the binding step names ${writer} as a writer of the run's log`);
  assert.match(CONTRACT_DOC, /a frozen contract never changes mid-run/);
  const abandon = CONTRACT_DOC.split("\n").find((l) => l.startsWith("| A run stopped after Gate 0"));
  assert.ok(abandon, "the FAQ has a row for a run that stopped after Gate 0");
  assert.match(abandon, /--abandon --run-id <run-id>/);
  assert.match(abandon, /zero-touch never runs it on its own/);
  assert.match(CONTRACT_DOC, /abort it and start a new run with the wider scope/);
});

test("the contract page names every place a planned write or read is refused before a model is paid", () => {
  // plan-lint refuses a unit on a path the run may not write, and findings-to-packets routes no fix to one.
  const spec = read("plugin", "scripts", "lib", "change-spec.mjs");
  const findings = read("plugin", "scripts", "findings-to-packets.mjs");
  assert.match(spec, /writeRefusal\(projectRoot, u\.path/);
  assert.match(findings, /writeRefusal\(root, /, "findings-to-packets holds each fix target to the writer's rule");
  const layers = section(CONTRACT_DOC, "## Four enforcement layers").replace(/\s+/g, " ");
  assert.match(layers, /`findings-to-packets\.mjs`/);
  // The server's own read rule is applied in hydrateInputs, on the path as written and through links.
  const hydrate = APPLY.slice(APPLY.indexOf("export function hydrateInputs"), APPLY.indexOf("\nexport ", APPLY.indexOf("export function hydrateInputs") + 1));
  assert.match(hydrate, /realpathSync/);
  assert.match(hydrate, /readOffLimits\(/);
  const writer = section(CONTRACT_DOC, "## The server's writer (apply form and `execute_batch`)").replace(/\s+/g, " ");
  assert.match(writer, /`hydrateInputs`/);
  assert.match(writer, /through links|by the file it reaches/);
  assert.match(writer, /in any letter case/);
});

test("the contract page promises no diff before a write, and says what protects an existing file, a tooling step included", () => {
  // No step of a run shows a diff before the server writes (brownfield-orchestrator.md says so in its own overlay).
  assert.match(read("plugin", "agents", "brownfield-orchestrator.md"), /no diff is shown before a packet's write/);
  assert.doesNotMatch(CONTRACT_DOC, /mini-gate|diff preview|Diff-preview|Approve → write/);
  const protects = section(CONTRACT_DOC, "## What protects a file that existed before the run").replace(/\s+/g, " ");
  assert.match(protects, /`change_plan\.md`/);
  assert.match(protects, /senior reviewer/);
  // A tooling step's writes are recorded around it, as brownfield-runs.md tells the orchestrator.
  assert.match(RUNS, /`write-provenance\.mjs --before`[\s\S]*--after/);
  assert.match(protects, /`write-provenance\.mjs --before`[^.]*`--after`/);
  assert.match(protects, /provenance does not list is reported/);
  // Nothing in the plugin checks a packet's file against CODEOWNERS (discovery reads it only for regulated-repo
  // signals), so no page promises a gate for it.
  const owners = [...walk(join(PLUGIN, "scripts")), ...walk(join(PLUGIN, "agents")), ...walk(join(PLUGIN, "skills"))]
    .filter((f) => /\.(mjs|md)$/.test(f) && !f.endsWith("discovery.md") && /CODEOWNERS/.test(readFileSync(f, "utf8")));
  if (owners.length === 0) assert.doesNotMatch(read("docs", "brownfield-coexistence.md"), /mini-gate raises before the write/);
});

/** The jobs table's Gate 2 cell for each job (brownfield-runs.md, "The jobs"). */
function gate2Cells() {
  const cells = new Map();
  for (const m of section(RUNS, "## The jobs").matchAll(/^\| ((?:`[a-z-]+`(?:, )?)+) \| ([^|]+) \|/gm)) {
    for (const j of m[1].matchAll(/`([a-z-]+)`/g)) cells.set(j[1], m[2].trim());
  }
  return cells;
}

test("every page that lists which jobs open Gate 2 lists what the jobs table the run follows says", () => {
  const cells = gate2Cells();
  assert.equal(cells.size, 7, "the jobs table has a Gate 2 cell for each of the seven jobs");
  const designAffecting = /design-affecting/.test(cells.get("bugfix") ?? "");
  const lists = [
    ["docs/brownfield.md", BROWNFIELD.split("\n").find((l) => l.startsWith("| 6 | Pipeline |"))],
    ["docs/brownfield-write-contract.md", section(CONTRACT_DOC, "## What protects a file that existed before the run").replace(/\s+/g, " ")],
    ["docs/brownfield-privacy.md", section(PRIVACY, "## Commands the run executes on your machine").replace(/\s+/g, " ")],
    ["docs/methodology.md", NOTES.split("\n").find((l) => l.startsWith("| Every job, one flow |"))],
    ["docs/brownfield-routing.md", section(ROUTING, "## Per job").split("\n").find((l) => l.startsWith("| `bugfix` |"))],
    ["README.md", README.split("\n").find((l) => l.startsWith("Four HITL gates fire"))],
  ];
  for (const [name, text] of lists) {
    assert.ok(text, `${name} lists the jobs that open Gate 2`);
    if (designAffecting) assert.match(text, /design-affecting/, `${name}: a bugfix opens Gate 2 when code finds it design-affecting (brownfield-runs.md, "The jobs")`);
  }
  // The routing page's own Gate 2 column is the jobs table's, job by job.
  for (const [job, cell] of cells) {
    const row = section(ROUTING, "## Per job").split("\n").find((l) => l.startsWith(`| \`${job}\` |`));
    assert.ok(row, `the routing page has a ${job} row`);
    assert.equal(row.split("|")[2].trim(), cell, `the routing page's Gate 2 for ${job} is the jobs table's`);
  }
});

test("the pages say what code checks of a whole-project job: at least one project check, which the architect is told to make the full suite", () => {
  // Code checks that the list is not empty; which commands make the full suite is the architect's to name.
  assert.match(read("plugin", "scripts", "lib", "change-spec.mjs"), /WHOLE_PROJECT_JOBS\.includes\(intent\) && !\(header\?\.project_checks \?\? \[\]\)\.length/);
  for (const job of ["refactor", "test", "deps"]) {
    const row = README.split("\n").find((l) => l.startsWith(`| \`${job}\` |`));
    assert.match(row, /at least one/, `README: the ${job} row says code requires at least one project check`);
    assert.doesNotMatch(row, /The full test suite passes/);
  }
  const flow = BROWNFIELD.slice(BROWNFIELD.indexOf("**Every job runs one flow.**")).split("\n\n")[0].replace(/\s+/g, " ");
  assert.match(flow, /at least one/);
  const notes = NOTES.split("\n").find((l) => l.startsWith("| Whole-project checks |"));
  assert.match(notes, /`project_checks` holds at least one command \(the architect names the full suite\)/);
});

// ---------------------------------------------------------------------------
// The privacy page's commands
// ---------------------------------------------------------------------------

test("the privacy page gives the server's time limit for a file's commands as the packet carries it", async () => {
  const { derivePackets } = await import(join(PLUGIN, "scripts", "lib", "change-spec.mjs"));
  const spec = {
    header: { conventions: ["x"], file_checks: [{ id: "quick", run: "test -f {path}", timeout_s: 1 }, { id: "slow", run: "node --check {path}", timeout_s: 10 }], project_checks: [{ id: "suite", run: "npm test" }] },
    units: [{ id: "U01", path: "src/a.js", action: "create", phase: "codegen", behaviour: "b", depends_on: [], checks: ["quick", "slow"], style_from: { reason: "none" } }],
  };
  const { packets } = derivePackets(spec, { runId: "r1", intent: "feature-new", projectRoot: ROOT, runRel: ".sdlc/runs/r1" });
  const apply = packets[0].apply;
  const perCheck = apply.checks.every((c) => typeof c.timeout_s === "number");
  const commands = section(PRIVACY, "## Commands the run executes on your machine").replace(/\s+/g, " ");
  if (perCheck) {
    assert.match(commands, /each (?:command|check) at its own time limit/);
  } else {
    // One limit per packet: the largest of its checks' (verify_timeout_sec), for every command the server runs for it.
    assert.equal(apply.verify_timeout_sec, 10);
    assert.doesNotMatch(commands, /at the command's time limit \(the spec's `timeout_s`\)/);
    assert.match(commands, /the largest `timeout_s`/);
  }
  // plan-lint runs each check under that check's own limit.
  assert.match(read("plugin", "scripts", "lib", "change-spec.mjs"), /runCheck\(cmd, projectRoot, check\.timeout_s/);
  assert.match(commands, /`plan-lint\.mjs` stops each at its own `timeout_s`/);
});

test("the privacy page says whether plan-lint holds the checks it runs to the person's Bash deny rules, as the code does", () => {
  const holds = /bashDenyRules/.test(read("plugin", "scripts", "lib", "change-spec.mjs"));
  const row = section(PRIVACY, "## Commands the run executes on your machine").split("\n").find((l) => l.startsWith("| The same file checks"));
  assert.ok(row, "the commands table has plan-lint's row");
  if (holds) {
    assert.doesNotMatch(row, /not matched against your deny rules/, "plan-lint checks each command against the deny rules before it runs it");
    assert.match(row, /deny rules/);
  } else {
    assert.match(row, /not matched against your deny rules/, "plan-lint runs the checks without the deny-rule check the server applies");
  }
});

test("the privacy page names each of the three places the read rule is applied", () => {
  const rule = PRIVACY.slice(PRIVACY.indexOf("**What the server never reads into a model's prompt.**")).split("\n\n")[0].replace(/\s+/g, " ");
  for (const word of ["`style_from`", "`uses`", "`findings-to-packets.mjs`", "`hydrateInputs`", "letter case", "the file it reaches"]) {
    assert.ok(rule.includes(word), `the read rule names ${word}`);
  }
});

// ---------------------------------------------------------------------------
// The logging index, the architecture and troubleshooting pages
// ---------------------------------------------------------------------------

test("every event the model server logs is in the logging page's index, and apply.refused covers the refusals before dispatch", () => {
  const missing = [];
  for (const f of walk(SRC).filter((x) => x.endsWith(".ts"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/\blog\(\s*(?:"(?:error|warn|info|debug|trace)"|[^,()]+?)\s*,\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) {
      if (!LOGGING.includes("`" + m[1] + "`")) missing.push(`${m[1]} (${f.slice(SRC.length + 1)})`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "events the server logs that the index does not name");
  // apply.ts refuses before any typist call (a contract, a reproducing test, a deny rule, a test file that already
  // fails) through one refuse(), which logs apply.refused.
  assert.match(APPLY, /const refuse = [^\n]*\n\s*log\("warn", "apply\.refused"/);
  const row = LOGGING.split("\n").find((l) => l.startsWith("| Apply form and batches"));
  assert.doesNotMatch(row, /`apply\.refused` \(WARN: the write contract refused the path\)/);
  assert.match(row, /`apply\.refused` \(WARN:[^)]*before any typist call/);
  // The collector reads every run's lifecycle lines, to tell a queued run's Skill call from a person's turn.
  const sink = LOGGING.split("\n").find((l) => l.startsWith("| Run log — orchestrator prompt"));
  assert.match(sink, /queued run's Skill call/);
});

test("the architecture page's pre-flight and batch rows quote the server's own limits and fields", async () => {
  const { PROBE_TIMEOUT_S, AGY_SDK_WAITS_MS } = await import(join(PLUGIN, "mcp", "model-dispatch", "dist", "typistProbe.js"));
  const preflight = ARCH.split("\n").find((l) => l.startsWith("| `preflight_dispatch` |"));
  assert.ok(preflight.includes(`${PROBE_TIMEOUT_S} s`), `the probe's limit, ${PROBE_TIMEOUT_S} s`);
  assert.ok(preflight.includes(`${AGY_SDK_WAITS_MS / 1000} s`), `the agent door's SDK waits, ${AGY_SDK_WAITS_MS / 1000} s`);
  assert.doesNotMatch(preflight, /two minutes at most/);
  for (const word of ["`intent`", "429", "`run_id`", "`policy_notes`"]) assert.ok(preflight.includes(word), `the pre-flight row names ${word}`);
  const batch = ARCH.split("\n").find((l) => l.startsWith("| `execute_batch` |"));
  for (const word of ["`tooling_steps`", "`already_applied`", "applied.jsonl`", "`verify_deferred`", "`transport_waits`"]) assert.ok(batch.includes(word), `the execute_batch row names ${word}`);
  const attempts = ARCH.split("\n").find((l) => l.startsWith("| `attempt_number`"));
  assert.match(attempts, /brownfield/);
  const manifest = ARCH.split("\n").find((l) => l.startsWith("`buildManifest` sorts"));
  assert.match(manifest, /another run/);
  // SUMMARY.md is code's (the pipeline skill tells the orchestrator so).
  assert.match(read("plugin", "skills", "pipeline", "SKILL.md"), /SUMMARY\.md is code's/);
  const summary = ARCH.split("\n").find((l) => l.includes("SUMMARY.md") && l.startsWith("- "));
  assert.match(summary, /`write-manifest\.mjs` writes SUMMARY\.md/);
  assert.match(REPO_GUIDE.split("\n").find((l) => l.startsWith("| `plugin/scripts/write-manifest.mjs`")), /SUMMARY\.md/);
  const acceptance = ARCH.split("\n").find((l) => l.startsWith("- Code runs every command of the spec's acceptance list"));
  assert.match(acceptance, /brownfield/);
});

test("the troubleshooting page has the typist probe's halt, and its pre-flight rows say what is billed", () => {
  const server = read("plugin", "mcp", "model-dispatch", "src", "server.ts");
  assert.match(server, /could not answer a one-line test call/);
  const preflight = section(TROUBLE, "## Pre-flight (`preflight_dispatch`)");
  assert.match(preflight, /could not answer a one-line test call/);
  assert.doesNotMatch(preflight, /Constructions run offline; nothing was billed\./);
  const forbidden = TROUBLE.split("\n").find((l) => l.startsWith("| Delegated packet dies with a 403"));
  assert.match(forbidden, /start check/);
  const notes = TROUBLE.split("\n").find((l) => l.includes("carry `policy_notes`"));
  assert.match(notes, /brownfield/);
  const exit3 = TROUBLE.split("\n").find((l) => l.startsWith("| Exits 3 with `the transcript is BELOW"));
  assert.match(exit3, /a queued run's start in the same invocation/);
});

// ---------------------------------------------------------------------------
// The zero-touch manual
// ---------------------------------------------------------------------------

test("the zero-touch manual names the stamp hook's matcher as released, the unchecked commands, and the server's own refusal", () => {
  const own = read("plugin", "scripts", "ambient", "lib", "own-steps.mjs");
  const released = /export const PRE_DISPATCH_TOOLS = \/__\(\?:([a-z_|]+)\)\$\//.exec(own)[1].split("|");
  const row = MANUAL.split("\n").find((l) => l.startsWith("| `pre-dispatch` |"));
  const matcher = row.split("|")[2];
  assert.deepEqual([...matcher.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]), released, "the matcher the row lists is the released one");
  assert.match(row, /`execute_batch`/);
  // A command the check cannot read: shell syntax outside the path's placeholder, or a file path that is not plain.
  assert.match(own, /const PLAIN_PATH = /);
  assert.match(row, /quotes outside the path's own placeholder/);
  assert.match(row, /file path is not a plain path/);
  assert.match(row, /with or without zero-touch/);
  const preAny = MANUAL.split("\n").find((l) => l.startsWith("| `pre-any` |"));
  assert.match(preAny, /stamps and answers `execute_batch` as `pre-dispatch` does/);
  const steps = MANUAL.slice(MANUAL.indexOf("**The workflow's own steps run without permission prompts**")).split("\n\n")[0];
  assert.match(steps, /in the chat's own project folder/);
  assert.match(steps, /with or without zero-touch/);
  const early = MANUAL.split("\n").find((l) => l.trim().startsWith("- the workflow stopped before its run began"));
  assert.match(early, /`run\.end`[^;]*aborted/);
  const handoff = MANUAL.slice(MANUAL.indexOf("**A hand-off's command and the person's Bash rules.**")).split("\n\n")[0];
  assert.match(handoff, /with or without zero-touch/);
});

// ---------------------------------------------------------------------------
// Brownfield pages: resume, flags, the stacks folder
// ---------------------------------------------------------------------------

test("the brownfield pages never promise to resume a run, and name what reads the profile flags and the stacks folder", () => {
  const step1 = BROWNFIELD.split("\n").find((l) => l.startsWith("| 1 | Session-hydrate |"));
  assert.doesNotMatch(step1, /checks for resume state/);
  assert.match(step1, /--abandon/);
  const command = README.split("\n").find((l) => l.startsWith("| [`/mmo:brownfield`]"));
  assert.doesNotMatch(command, /\(or resumes\)/);
  assert.doesNotMatch(BROWNFIELD, /state\.json +— live state machine/);
  for (const flag of ["adaptive", "refresh"]) {
    const row = RUNNING.split("\n").find((l) => l.startsWith(`| \`--${flag}-profile\``));
    assert.match(row, new RegExp(`\`${flag}_profile\``), `--${flag}-profile reaches discovery as its ${flag}_profile input`);
  }
  // The brownfield architect reads the stacks folder while it writes the change spec.
  assert.match(read("plugin", "agents", "brownfield-architect.md"), /skills\/pipeline\/stacks\//);
  const skills = REPO_GUIDE.split("\n").find((l) => l.startsWith("| `skills/` |"));
  assert.match(skills, /stacks\/`[^|]*brownfield architect/);
  // Routing by stage, and by the job when a policy rule names one.
  assert.match(read("plugin", "mcp", "model-dispatch", "src", "routing.ts"), /matcher\.intent !== undefined/);
  assert.match(section(ROUTING, "## Per job").replace(/\s+/g, " "), /by its job \(`intent`\) when a policy rule names one/);
});

test("the agent-door walkthrough does not leave pre-flight's old blind spot standing", () => {
  const html = read("docs", "walkthroughs", "agent-path.html");
  const server = read("plugin", "mcp", "model-dispatch", "src", "server.ts");
  if (/probe_typists/.test(server)) {
    const note = html.slice(html.indexOf("One thing pre-flight cannot check."), html.indexOf("</div>", html.indexOf("One thing pre-flight cannot check.")));
    assert.match(note, /probe_typists/, "the note says pre-flight now calls every typist, the agent door's included");
  }
});

// ---------------------------------------------------------------------------
// Version notes
// ---------------------------------------------------------------------------

/** Builds that were never released: each became part of the next release's note. */
const NEVER_RELEASED = ["0.9.0", "0.9.1", "0.9.2"];

test("the version notes have no section for a build that was never released, and no document names one", () => {
  for (const v of NEVER_RELEASED) {
    assert.doesNotMatch(NOTES, new RegExp(`^### v${v.replace(/\./g, "\\.")}\\b`, "m"), `no separate v${v} section`);
  }
  const docs = ["README.md", "SETUP.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  for (const name of docs) {
    for (const v of NEVER_RELEASED) {
      assert.doesNotMatch(read(...name.split("/")), new RegExp(`\\bv?${v.replace(/\./g, "\\.")}\\b`), `${name} names ${v}, a build that was never released`);
    }
  }
});

test("the current version's note carries no run names, says how pre-flight events count, and which turns are command turns", () => {
  const version = JSON.parse(read("plugin", ".claude-plugin", "plugin.json")).version;
  const note = NOTES.slice(NOTES.indexOf(`### v${version}\n`)).split(/\n(?=### v)/)[0];
  assert.ok(note.length > 100, `a v${version} note`);
  assert.doesNotMatch(note, /\bLarge\d|\bRun \d+\b|first try/, "no run names or session history");
  assert.match(note, /`preflight`[^|]*`started_at`|`started_at`[^|]*`preflight`/, "pre-flight events never anchor a run's window");
  assert.match(note, /`\/?mmo:<name>`[^|]*another plugin/, "only the plugin's own commands are command turns");
  // An inputs[] slice without content is read from disk for a brownfield packet only.
  assert.doesNotMatch(NOTES, /in every run that sends one/);
  assert.match(APPLY, /export function readsSlicesFromDisk/);
  assert.match(note, /read from disk[^|]*brownfield packet/);
});

/** A row of the current version's note, by its first cell. */
function noteRow(area) {
  const version = JSON.parse(read("plugin", ".claude-plugin", "plugin.json")).version;
  const note = NOTES.slice(NOTES.indexOf(`### v${version}\n`)).split(/\n(?=### v)/)[0];
  const row = note.split("\n").find((l) => l.startsWith(`| ${area} |`));
  assert.ok(row, `the v${version} note has a "${area}" row`);
  return row;
}
/** An agent's prompt-cache lifetime from its front matter: "1h", or "5m" (Claude Code's default) when it sets none. */
function cacheTtl(agent) {
  const text = read("plugin", "agents", `${agent}.md`);
  const front = text.slice(0, text.indexOf("\n---", 4));
  return /^\s*cacheTtl:\s*(\S+)/m.exec(front)?.[1] ?? "5m";
}

test("the current version's note says each change as the code does it", async () => {
  // Waits: a stated number per attempt; past them a failure is the attempt's (apply.ts runApplyLoop).
  assert.match(APPLY, /waits < transport\.maxWaits/);
  assert.match(APPLY, /waits = 0;/, "each attempt starts its own waits");
  assert.match(noteRow("Who types"), /per attempt/);
  // One task per file, its attempts numbered by the ladder's slot (applyTypist.ts typistResult).
  assert.match(read("plugin", "mcp", "model-dispatch", "src", "applyTypist.ts"), /attempt_number: \(packet\.retry_count \?\? 0\) \+ 1/);
  assert.match(noteRow("Typist telemetry"), /`task_id`[^|]*`attempt_number`/);
  // The helpers' prompt-cache lifetimes, read from their front matter.
  assert.equal(cacheTtl("brownfield-orchestrator"), "1h");
  for (const a of ["brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer", "senior-reviewer", "security-reviewer"]) assert.equal(cacheTtl(a), "5m", `${a} keeps the default`);
  assert.equal(cacheTtl("architect"), "1h");
  const cache = noteRow("Helper prompt cache");
  assert.match(cache, /brownfield architect and reviewer copies keep Claude Code's default five minutes/);
  assert.match(cache, /Greenfield's architect keeps its hour; its reviewers keep the default/);
  assert.doesNotMatch(cache, /they wait on nothing/);
  // The collector: queued runs, the prune anchor, the window's start.
  const collector = read("plugin", "scripts", "collect-orchestrator-usage.mjs");
  const queued = /export const QUEUED_START_ANCHOR = "([^"]+)"/.exec(collector)[1];
  const nextQueued = /export const NEXT_QUEUED_START_ANCHOR = "([^"]+)"/.exec(collector)[1];
  const anchor = NOTES.split("\n").find((l) => l.startsWith("- **Window anchor.**"));
  assert.ok(anchor.includes(`\`${queued}\``) && anchor.includes(`\`${nextQueued}\``), "the window bullet names the collector's own anchor labels");
  assert.match(anchor, /taken where the window opens/);
  assert.match(anchor, /`anthropic-skills:docs`/);
  const turn = noteRow("Collector command turn");
  assert.match(turn, /Helper transcripts are pruned against the command turn/);
  assert.match(turn, /A pre-flight event never anchors the window/);
  // The pre-check writes its dispatch step as skipped on every --run.
  assert.match(read("plugin", "scripts", "pre-check.mjs"), /status\.steps\.dispatch_smoke = \{ \.\.\.DISPATCH_SKIP \}/);
  const probe = noteRow("Run-start typist probe");
  assert.match(probe, /Every `pre-check\.mjs --run` writes the pre-check's dispatch step as skipped/);
  const { PROBE_TIMEOUT_S, AGY_SDK_WAITS_MS } = await import(join(PLUGIN, "mcp", "model-dispatch", "dist", "typistProbe.js"));
  assert.ok(probe.includes(`${PROBE_TIMEOUT_S} s + ${AGY_SDK_WAITS_MS / 1000} s`), "the agent door's probe limit, from the server's constants");
  assert.match(probe, /`intent`/);
  const batch = noteRow("Apply form and `execute_batch`");
  for (const word of ["`tooling_steps`", "`already_applied`", "applied.jsonl`", "`verify_deferred`", "`transport_waits`"]) assert.ok(batch.includes(word), `the batch row names ${word}`);
  // The write contract and zero-touch rows.
  const contract = noteRow("Write contract");
  assert.match(contract, /rotated pieces included/);
  assert.match(contract, /destruction of the run's own record, not a cleanup/);
  assert.match(contract, /git project's root/);
  const zt = noteRow("Zero-touch");
  assert.match(zt, /`pre-any`/);
  assert.match(zt, /kept as released/);
  assert.match(zt, /not a plain path/);
  assert.match(zt, /quotes outside the path's placeholder/);
  assert.match(noteRow("Gate 0"), /in every job/);
  // SUMMARY.md is written by code, never by the orchestrator.
  assert.doesNotMatch(NOTES, /The orchestrator writes SUMMARY\.md/);
  assert.match(NOTES.split("\n").find((l) => l.startsWith("| manifest.json at Phase 9 |")), /`write-manifest\.mjs`[^|]*SUMMARY\.md/);
});

test("no document a person reads refers to a person by a pronoun", () => {
  const files = ["README.md", "SETUP.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  for (const d of readdirSync(join(PLUGIN, "examples"))) {
    for (const f of ["README.md", "intent_brief.md"]) if (existsSync(join(PLUGIN, "examples", d, f))) files.push(`plugin/examples/${d}/${f}`);
  }
  for (const name of files) assert.doesNotMatch(read(...name.split("/")), /\b(?:[Hh]er|[Hh]is|[Ss]he|[Hh]im)\b/, `${name} refers to a person`);
});

// ---------------------------------------------------------------------------
// The shipped brownfield examples
// ---------------------------------------------------------------------------

const EXAMPLES = readdirSync(join(PLUGIN, "examples")).filter((d) => d.startsWith("brownfield-"));

/** The brief's scope: `- \`path\` (create|edit …)` bullets of "## Files in scope". */
function briefScope(dir) {
  const brief = readFileSync(join(dir, "intent_brief.md"), "utf8");
  const scope = section(brief, "## Files in scope");
  return new Map([...scope.matchAll(/^- `([^`]+)` \((create|edit)\b/gm)].map((m) => [m[1], m[2]]));
}
/** The README's expected outputs: `- \`path\` — new|edited|unchanged …` bullets of "## Expected outputs". */
function expected(dir) {
  const text = section(readFileSync(join(dir, "README.md"), "utf8"), "## Expected outputs");
  return [...text.matchAll(/^- `([^`]+)` — (new|edited|unchanged)\b/gm)].map((m) => ({ path: m[1], what: m[2] }));
}

test("each shipped brownfield example's scope and expected outputs fit the files it ships", () => {
  assert.equal(EXAMPLES.length, 6, "six brownfield examples");
  for (const ex of EXAMPLES) {
    const dir = join(PLUGIN, "examples", ex);
    const scope = briefScope(dir);
    const outs = expected(dir);
    assert.ok(scope.size > 0, `${ex}: the brief's scope is a list of files, each (create) or (edit)`);
    assert.ok(outs.length > 0, `${ex}: the README lists its expected outputs, each new, edited or unchanged`);
    for (const [path, action] of scope) {
      assert.equal(existsSync(join(dir, path)), action === "edit", `${ex}: ${path} is "${action}" but it ${existsSync(join(dir, path)) ? "exists" : "does not exist"}`);
    }
    for (const o of outs) {
      assert.equal(existsSync(join(dir, o.path)), o.what !== "new", `${ex}: ${o.path} is "${o.what}"`);
      if (o.what !== "unchanged") assert.equal(scope.get(o.path), o.what === "new" ? "create" : "edit", `${ex}: ${o.path} (${o.what}) is in the brief's scope as ${o.what === "new" ? "create" : "edit"}`);
    }
    for (const path of scope.keys()) assert.ok(outs.some((o) => o.path === path), `${ex}: ${path} is in scope, so the README says what happens to it`);
    // A Gate 0 line in the README names the same scope.
    const gate = /Confirm scope at Gate 0: ([^\n]+)/.exec(readFileSync(join(dir, "README.md"), "utf8"));
    if (gate) for (const path of scope.keys()) assert.ok(gate[1].includes(path), `${ex}: the README's Gate 0 line names ${path}`);
    // A file the brief keeps to reading is not off-limits: an off-limits file is never read into a model's prompt.
    const brief = readFileSync(join(dir, "intent_brief.md"), "utf8");
    const off = section(brief, "## Files off-limits");
    for (const m of brief.matchAll(/^Read, not written: (.+)$/gm)) {
      for (const p of m[1].matchAll(/`([^`]+)`/g)) {
        assert.ok(existsSync(join(dir, p[1])), `${ex}: ${p[1]} is read, so it exists`);
        assert.ok(!off.includes("`" + p[1] + "`"), `${ex}: ${p[1]} is read for the change, so it cannot be off-limits`);
      }
    }
    // The contract lives at the root of the git project that holds the run: the example runs as its own project.
    assert.match(section(readFileSync(join(dir, "README.md"), "utf8"), "## Try it"), /git init/, `${ex}: Try it makes the example a git project of its own`);
  }
});

test("the bugfix example starts with the reproducing test, and its scope holds every file the fix needs", () => {
  const dir = join(PLUGIN, "examples", "brownfield-bugfix");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const brief = readFileSync(join(dir, "intent_brief.md"), "utf8");
  assert.doesNotMatch(readme, /→ diagnose →/, "no diagnose step: the run types the reproducing test, then the fix");
  assert.doesNotMatch(readme, /no changes needed/);
  assert.doesNotMatch(brief, /should pass unchanged/);
  // The route maps every error the handler throws to 500, so a 400 needs the route too.
  if (/catch \(e\) \{\s*res\.status\(500\)/.test(readFileSync(join(dir, "src", "index.js"), "utf8"))) {
    assert.equal(briefScope(dir).get("src/index.js"), "edit", "src/index.js is in the bugfix's scope");
  }
  // The reproducing test comes first in the expected outputs.
  assert.equal(expected(dir)[0].path, "src/auth.spec.js");
});

test("each shipped brownfield example's documented scope passes plan-lint", () => {
  const LINT = join(PLUGIN, "scripts", "plan-lint.mjs");
  for (const ex of EXAMPLES) {
    const src = join(PLUGIN, "examples", ex);
    const scope = briefScope(src);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `mmo-docs-${ex}-`)));
    try {
      cpSync(src, dir, { recursive: true });
      mkdirSync(join(dir, ".git"));
      const run = join(dir, ".sdlc", "runs", "r1");
      mkdirSync(join(run, "change.sections"), { recursive: true });
      const frozen = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id", "r1", "--allowlist", JSON.stringify([...scope.keys()]), "--off-limits", '[".env*"]', "--project-root", dir], { cwd: dir, encoding: "utf8" });
      assert.equal(frozen.status, 0, `${ex}: ${frozen.stderr}`);
      const header = { conventions: ["the repo's own style"], file_checks: [{ id: "exists", run: "test -f {path}", timeout_s: 10 }], project_checks: [{ id: "suite", run: "npm test" }] };
      // One unit per file of the documented scope: what plan-lint checks against the files and the contract.
      const phase = (p) => (/\.spec\.|\.test\./.test(p) ? "tests" : p.endsWith(".md") ? "docs" : "codegen");
      const units = [...scope].map(([path, action], i) => {
        const u = { id: `U0${i + 1}`, path, action, phase: phase(path), behaviour: "As the brief says.", depends_on: [], checks: ["exists"] };
        if (action === "edit") {
          const first = readFileSync(join(dir, path), "utf8").split("\n")[0].replace(/\r$/, "").trim();
          u.sites = [{ id: "S1", at: "insert_after", from: 1, to: 1, first_line: first, rule: "As the brief says." }];
        } else {
          u.style_from = { reason: "the brief names none" };
        }
        return u;
      });
      writeFileSync(join(run, "change.sections", "header.json"), JSON.stringify(header));
      writeFileSync(join(run, "change.sections", "units-001.json"), JSON.stringify(units));
      for (const file of ["header.json", "units-001.json"]) {
        const r = spawnSync(process.execPath, [LINT, "--section", `.sdlc/runs/r1/change.sections/${file}`, "--run-id", "r1", "--project-root", dir], { cwd: dir, encoding: "utf8" });
        assert.equal(r.status, 0, `${ex}: plan-lint refuses the documented scope (${file}):\n${r.stderr}${r.stdout}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
