/**
 * The write contract cannot be changed by the run it binds, whatever tool the change comes through.
 *
 * The PreToolUse hook (write-contract-check.mjs) refuses a live run's Write or Edit of its own contract, but a shell
 * command can rewrite the file, and the hook never sees a shell command. So the contract is written by one script,
 * write-contract.mjs, which records the SHA-256 of the exact bytes it
 * froze in the run's own log (a `contract.freeze` line); the hook and the server's writer (apply.ts
 * checkWriteContract) compare the two before every write. A contract changed any other way while its run is live
 * refuses every write, with the reason — also when the contract is deleted, or rewritten to name another run, since
 * the record is found from the run logs, not from the contract. The script switches a contract off only after its run
 * has ended by its own log. A contract with no freeze record (written before this) is enforced as before. Offline, $0.
 *
 * Also pinned here: a run freezes once (a second freeze under the same id, or after its end, is refused); a run that
 * will never end by itself (it stopped after Gate 0 froze its contract) is ended on purpose with `--abandon`; a forged
 * freeze record never re-blesses a widened contract; the record survives the log's rotation; a run log or contract
 * that is not a regular file (a named pipe) never stalls the hook or the script; and what destroying the run's own log
 * does is said truthfully.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin");
const HOOK = join(PLUGIN, "scripts", "write-contract-check.mjs");
const SCRIPT = join(PLUGIN, "scripts", "write-contract.mjs");
const LOCK_LIB = join(PLUGIN, "scripts", "lib", "contract-lock.mjs");
const { checkWriteContract } = await import(join(PLUGIN, "mcp", "model-dispatch", "dist", "apply.js"));
const { contractTampered, fingerprint, frozenBy } = await import(LOCK_LIB);
const { formatLine } = await import(join(PLUGIN, "scripts", "lib", "log.mjs"));

/** Runs the hook on one Write; a hook still running after `ms` is killed and reported (`killed: true`). */
function runHook(cwd, file, { ms = 15_000 } = {}) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, ms);
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", (code) => { clearTimeout(timer); done({ code, stderr, killed }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify({ tool_input: { file_path: file } }));
  });
}
const script = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--project-root", cwd], { cwd, encoding: "utf8", timeout: 15_000 });
const LOG = (dir, run = "r1") => join(dir, ".sdlc", "runs", run, "orchestrator.log");
const line = (event, fields) => `MMO: 2026-10-06T10:00:00.000Z INFO   ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`;
/**
 * A brownfield project at Gate 0 of run r1: discovery made its folder; the orchestrator has not logged run.start yet.
 * A git project, as every brownfield project is: the contract lives at the git project's root, where the hook reads it.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-contract-lock-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".sdlc", "runs", "r1"), { recursive: true });
  return dir;
}
/** The run's own end as the orchestrator logs it: Gate 4 accepted after a completed run.end. */
const endRun = (dir, run = "r1") => appendFileSync(LOG(dir, run), line("run.end", { run_id: run, outcome: "completed" }) + line("gate.resolved", { run_id: run, gate: "gate-4", response: "approved" }));
const CONTRACT = (dir) => join(dir, ".sdlc", "local", "write-contract.json");
const freeze = (dir, allow = ["src/**"], run = "r1") => script(dir, "--freeze", "--run-id", run, "--allowlist", JSON.stringify(allow), "--off-limits", JSON.stringify([".env*"]));
async function refusedEverywhere(dir, files, why) {
  for (const f of files) {
    const h = await runHook(dir, f);
    assert.equal(h.code, 2, `the hook refuses ${f}`);
    assert.match(h.stderr, why);
    const s = checkWriteContract(dir, f);
    assert.equal(s.allowed, false, `the server refuses ${f}`);
    assert.match(s.reason, why);
  }
}

test("freeze writes the contract and records its fingerprint in the run's own log; the contract binds as before", async () => {
  const dir = repo();
  try {
    const r = freeze(dir);
    assert.equal(r.status, 0, r.stderr);
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    assert.deepEqual([c.active, c.run_id, c.strict, c.allowlist, c.off_limits], [true, "r1", true, ["src/**"], [".env*"]]);
    assert.match(readFileSync(LOG(dir), "utf8"), /INFO\s+contract\.freeze run_id=r1 sha256=[0-9a-f]{64}\n$/);
    assert.equal(frozenBy(dir)?.run_id, "r1");
    assert.equal((await runHook(dir, "src/a.ts")).code, 0, "allowlisted");
    assert.equal((await runHook(dir, "docs/x.md")).code, 2, "not allowlisted");
    assert.equal(checkWriteContract(dir, "src/a.ts").allowed, true);
    assert.equal(checkWriteContract(dir, "docs/x.md").allowed, false);
    // The record binds from Gate 0 on: the orchestrator's run.start comes after it.
    appendFileSync(LOG(dir), line("run.start", { run_id: "r1", mode: "brownfield" }));
    assert.equal(frozenBy(dir)?.run_id, "r1", "a run.start after the freeze does not end it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a contract changed by any other means while its run is live refuses every write, the server's too", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    // What a shell command can do: widen the allowlist in place.
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, allowlist: ["src/**", "docs/**"] }));
    await refusedEverywhere(dir, ["src/a.ts", "docs/x.md"], /changed after it was frozen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("switching the contract off by other means is a change too: it does not free the run", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, active: false }));
    await refusedEverywhere(dir, ["docs/x.md"], /changed after it was frozen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The record is in the run's log, so clearing the contract's folder (what a stale lock file invites) frees nothing,
// and neither does a contract rewritten to name another run: the record is found from the run logs, not the contract.
test("deleting the contract, or writing a new one that names another run, does not free a live run", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    rmSync(join(dir, ".sdlc", "local"), { recursive: true, force: true });
    await refusedEverywhere(dir, ["docs/x.md", "src/a.ts"], /the file is gone/);
    mkdirSync(join(dir, ".sdlc", "runs", "old"), { recursive: true });
    endRun(dir, "old");
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(CONTRACT(dir), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: "old", strict: true, allowlist: ["**"], off_limits: [] }));
    await refusedEverywhere(dir, ["docs/x.md"], /changed after it was frozen for run r1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a live run cannot switch its own contract off with the script; once it has ended by its own log, close does", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const early = script(dir, "--close", "--run-id", "r1");
    assert.equal(early.status, 2, "refused while the run is live");
    assert.match(early.stderr, /run r1 is live by its own log/);
    assert.equal(JSON.parse(readFileSync(CONTRACT(dir), "utf8")).active, true, "unchanged");
    assert.equal((await runHook(dir, "docs/x.md")).code, 2, "still bound");
    endRun(dir);
    const r = script(dir, "--close", "--run-id", "r1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(CONTRACT(dir), "utf8")).active, false);
    assert.equal((await runHook(dir, "docs/x.md")).code, 0);
    assert.equal(checkWriteContract(dir, "docs/x.md").allowed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a live run's contract is frozen once: the script refuses to freeze over it, and the hook refuses the contract and the log to Write", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const again = freeze(dir, ["**"]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already frozen/);
    assert.equal(JSON.parse(readFileSync(CONTRACT(dir), "utf8")).allowlist.join(","), "src/**", "unchanged");
    const other = freeze(dir, ["**"], "r2");
    assert.equal(other.status, 2, "another run cannot freeze over a live one");
    assert.match(other.stderr, /run r1 is live and holds this project's contract/);
    assert.equal((await runHook(dir, ".sdlc/local/write-contract.json")).code, 2);
    assert.equal((await runHook(dir, ".sdlc/runs/r1/orchestrator.log")).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("once the run has ended by its own log, its contract binds nothing, changed or not; a later run freezes its own", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, allowlist: [] }));
    appendFileSync(LOG(dir), line("run.start", { run_id: "r1" }) + line("run.end", { run_id: "r1", outcome: "aborted" }));
    assert.equal(frozenBy(dir), null);
    assert.equal((await runHook(dir, "docs/x.md")).code, 0);
    assert.equal(checkWriteContract(dir, "docs/x.md").allowed, true);
    mkdirSync(join(dir, ".sdlc", "runs", "r2"), { recursive: true });
    assert.equal(freeze(dir, ["docs/**"], "r2").status, 0, "the next run's Gate 0");
    assert.equal(frozenBy(dir)?.run_id, "r2");
    assert.equal((await runHook(dir, "docs/x.md")).code, 0);
    assert.equal((await runHook(dir, "src/a.ts")).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Projects with run logs and no freeze record — greenfield's, and brownfield runs frozen before the record existed —
// keep the rules they had: the pre-contract net, or the contract as it is.
test("no freeze record: a project's writes follow the rules they had", async () => {
  const dir = repo();
  try {
    writeFileSync(LOG(dir), line("run.start", { run_id: "r1", mode: "greenfield" }));
    assert.equal(contractTampered(dir), null);
    assert.equal((await runHook(dir, "src/a.ts")).code, 0, "no contract: allowed");
    assert.equal((await runHook(dir, ".env")).code, 2, "the pre-contract net still refuses .env");
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(CONTRACT(dir), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: "r1", strict: true, allowlist: ["src/**"], off_limits: [] }));
    assert.equal((await runHook(dir, "src/a.ts")).code, 0, "a contract with no record binds as before");
    assert.equal((await runHook(dir, "docs/x.md")).code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage: freeze needs a run id and an allowlist; close needs the run the contract belongs to (exit 2)", () => {
  const dir = repo();
  try {
    assert.equal(script(dir, "--freeze", "--run-id", "r1").status, 2);
    assert.equal(script(dir, "--freeze", "--allowlist", "[]").status, 2);
    assert.equal(freeze(dir).status, 0);
    assert.equal(script(dir, "--close", "--run-id", "r2").status, 2, "another run's contract is not this one's to close");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── A run that will never end by itself is ended on purpose, by the person ─────────────────────────────────────────
// Gate 0 freezes the contract before the orchestrator logs run.start, so a run that stops in between (its start check
// halts on an expired login, its chat is closed, it crashes) leaves a live freeze record that nothing in the run will
// ever end: every write outside its allowlist, the next run's Gate 0 and --close stay refused. --abandon is the one
// documented way out: it logs the run's end (aborted, with the reason) in its own log, then switches its contract off.
test("--abandon ends a run that stopped after Gate 0 froze its contract, and frees the project; a second call adds nothing", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    assert.equal((await runHook(dir, "docs/x.md")).code, 2, "the stopped run still holds the project");
    assert.equal(freeze(dir, ["docs/**"], "r2").status, 2, "and the next run's Gate 0");
    const r = script(dir, "--abandon", "--run-id", "r1", "--reason", "the start check stopped");
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(LOG(dir), "utf8"), /INFO\s+run\.end run_id=r1 outcome=aborted reason="the start check stopped"\n$/);
    assert.equal(JSON.parse(readFileSync(CONTRACT(dir), "utf8")).active, false, "its contract is switched off");
    assert.equal(frozenBy(dir), null);
    assert.equal((await runHook(dir, "docs/x.md")).code, 0);
    assert.equal(checkWriteContract(dir, "docs/x.md").allowed, true);
    const again = script(dir, "--abandon", "--run-id", "r1");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(LOG(dir), "utf8").match(/run\.end/g).length, 1, "an ended run's log is not written again");
    mkdirSync(join(dir, ".sdlc", "runs", "r2"), { recursive: true });
    assert.equal(freeze(dir, ["docs/**"], "r2").status, 0, "the next run's Gate 0 freezes its own");
    const none = script(dir, "--abandon", "--run-id", "nope");
    assert.equal(none.status, 2, "a run the project has no record of is not abandoned");
    assert.match(none.stderr, /no run nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── One freeze per run id ──────────────────────────────────────────────────────────────────────────────────────────
// A run that froze, or ended, never freezes again under the same id: "end my run, then freeze a wider contract" fails.
// The refusal says what was refused and that a wider scope is the person's decision; it never names a way past it.
test("a run freezes once: a second freeze under its id is refused, also after its end, and the refusal names no way around it", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const again = freeze(dir, ["**"]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already frozen/);
    assert.match(again.stderr, /person/);
    assert.doesNotMatch(again.stderr, /re-open Gate 0|aborting and starting again|strict/i);
    appendFileSync(LOG(dir), line("gate.resolved", { run_id: "r1", gate: "gate-1", response: "abort" }));
    assert.equal(frozenBy(dir), null, "the run has ended");
    const afterEnd = freeze(dir, ["**"]);
    assert.equal(afterEnd.status, 2, "a run that ended never freezes again under its id");
    assert.equal(JSON.parse(readFileSync(CONTRACT(dir), "utf8")).allowlist.join(","), "src/**", "unchanged");
    // A run id whose log holds only an end record (it never froze) cannot freeze either.
    mkdirSync(join(dir, ".sdlc", "runs", "r3"), { recursive: true });
    writeFileSync(LOG(dir, "r3"), line("run.start", { run_id: "r3" }) + line("run.end", { run_id: "r3", outcome: "aborted" }));
    const ended = freeze(dir, ["**"], "r3");
    assert.equal(ended.status, 2);
    assert.match(ended.stderr, /has ended/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── A forged freeze record never re-blesses a widened contract ─────────────────────────────────────────────────────
// write-contract.mjs freezes a run once and never while another run's record is live, so a second record in one log,
// or two runs' records live at once, were not written by it: every write is refused, as for any other change.
test("a forged freeze record does not re-bless a widened contract: a second record in the run's log, or another run's live record, refuses every write", async () => {
  const dir = repo();
  const other = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    const wide = JSON.stringify({ ...c, allowlist: ["**"] }, null, 2) + "\n";
    writeFileSync(CONTRACT(dir), wide);
    appendFileSync(LOG(dir), formatLine("info", "contract.freeze", { run_id: "r1", sha256: fingerprint(Buffer.from(wide)) }) + "\n");
    for (const f of ["docs/x.md", "src/a.ts"]) {
      const h = await runHook(dir, f);
      assert.equal(h.code, 2, `the hook refuses ${f}`);
      assert.match(h.stderr, /freeze record/);
    }
    assert.ok(contractTampered(dir), "the forged record is itself the change");
    // The same with a record logged for a made-up run, and the contract rewritten to name it: r1's record is still live.
    assert.equal(freeze(other).status, 0);
    const named = JSON.stringify({ ...c, run_id: "r9", allowlist: ["**"] }, null, 2) + "\n";
    mkdirSync(join(other, ".sdlc", "runs", "r9"), { recursive: true });
    writeFileSync(LOG(other, "r9"), formatLine("info", "contract.freeze", { run_id: "r9", sha256: fingerprint(Buffer.from(named)) }) + "\n");
    writeFileSync(CONTRACT(other), named);
    const h = await runHook(other, "docs/x.md");
    assert.equal(h.code, 2);
    assert.match(h.stderr, /freeze record/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

// ── The record survives the log's rotation ─────────────────────────────────────────────────────────────────────────
// The plugin's logger renames a run log that reached its size limit to orchestrator.log.1 and starts a new one: the
// record then sits in the rotated piece, which is still the run's own log.
test("the freeze record is read from the run log's rotated piece too: a shell-widened contract stays refused after a rotation", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    renameSync(LOG(dir), `${LOG(dir)}.1`);
    writeFileSync(LOG(dir), line("phase.start", { run_id: "r1", phase: "design" }));
    assert.equal(frozenBy(dir)?.run_id, "r1");
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, allowlist: ["**"] }));
    const h = await runHook(dir, "docs/x.md");
    assert.equal(h.code, 2);
    assert.match(h.stderr, /changed after it was frozen/);
    // An end in the newer piece ends the record in the older one.
    appendFileSync(LOG(dir), line("run.end", { run_id: "r1", outcome: "aborted" }));
    assert.equal(frozenBy(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The logger itself rotates the log (plugin/scripts/lib/log.mjs, at 5 MB): a long run's second rotation must not drop
// the piece that holds its first line, Gate 0's freeze record.
test("two rotations by the run's own logger keep the freeze record: a shell-widened contract stays refused", async () => {
  const dir = repo();
  const mmoLog = (n) => spawnSync(process.execPath, [join(PLUGIN, "scripts", "mmo-log.mjs"), "--event=phase.start", "--run-id=r1", `--n=${n}`, "--project-root", dir], { cwd: dir, encoding: "utf8", timeout: 15_000 });
  try {
    assert.equal(freeze(dir).status, 0);
    for (const n of [1, 2]) {
      appendFileSync(LOG(dir), `${"x".repeat(5 * 1024 * 1024)}\n`);
      assert.equal(mmoLog(n).status, 0);
    }
    assert.ok(existsSync(`${LOG(dir)}.2`), "two rotations made two pieces");
    assert.match(readFileSync(`${LOG(dir)}.2`, "utf8"), /contract\.freeze run_id=r1/, "the oldest piece holds the freeze record");
    assert.equal(frozenBy(dir)?.run_id, "r1");
    const c = JSON.parse(readFileSync(CONTRACT(dir), "utf8"));
    writeFileSync(CONTRACT(dir), JSON.stringify({ ...c, allowlist: ["**"] }));
    // The hook's answer; the server's writer reads the rotated pieces once its mirror (runLog.ts liveFreeze) does.
    const h = await runHook(dir, "docs/x.md");
    assert.equal(h.code, 2, h.stderr);
    assert.match(h.stderr, /changed after it was frozen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The freeze record is written by write-contract.mjs only. The plugin's own logger, which a run calls many times, is
// not a second way to write one (the readers also refuse a second record, or two live runs' records, as forged).
test("mmo-log.mjs refuses to write a contract freeze record, under any spelling of the event", () => {
  const dir = repo();
  try {
    for (const event of ["contract.freeze", "Contract.Freeze", " contract.freeze"]) {
      const r = spawnSync(process.execPath, [join(PLUGIN, "scripts", "mmo-log.mjs"), `--event=${event}`, "--run-id=r9", `--sha256=${"a".repeat(64)}`, "--project-root", dir], { cwd: dir, encoding: "utf8", timeout: 15_000 });
      assert.equal(r.status, 2, `${JSON.stringify(event)}: ${r.stderr}`);
      assert.match(r.stderr, /written only by write-contract\.mjs/);
    }
    assert.equal(existsSync(LOG(dir, "r9")), false, "nothing is logged");
    assert.equal(frozenBy(dir), null);
    const ok = spawnSync(process.execPath, [join(PLUGIN, "scripts", "mmo-log.mjs"), "--event=phase.start", "--run-id=r9", "--project-root", dir], { cwd: dir, encoding: "utf8", timeout: 15_000 });
    assert.equal(ok.status, 0, "every other event is logged as before");
    assert.match(readFileSync(LOG(dir, "r9"), "utf8"), /phase\.start run_id=r9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// frozenBy runs before every Write and Edit the hook sees, greenfield included, over every run log in the project: a
// log that never names the freeze event cannot hold a record, so its text is not parsed (a project with many long run
// logs and no contract pays for one text search per log, not a parse). The script's own checks still read every event.
test("a run log that never names the freeze event is not parsed by the freeze reader; the script still reads its end", async () => {
  const { runFreeze } = await import(LOCK_LIB);
  const dir = repo();
  try {
    writeFileSync(LOG(dir), line("run.start", { run_id: "r1" }) + line("phase.start", { run_id: "r1", phase: "design" }) + line("run.end", { run_id: "r1", outcome: "aborted" }));
    assert.deepEqual(runFreeze(dir, "r1"), { events: [], records: 0, live: false }, "no record: nothing parsed");
    assert.equal(frozenBy(dir), null);
    const ended = freeze(dir, ["**"], "r1");
    assert.equal(ended.status, 2, "a run that ended never freezes, read from the events the script parses itself");
    assert.match(ended.stderr, /has ended/);
    const none = script(dir, "--abandon", "--run-id", "r1");
    assert.equal(none.status, 0, `a run with a log but no record is still found: ${none.stderr}`);
    assert.match(none.stdout, /had already ended/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A brownfield run started in a subfolder of a git project (a package of a monorepo) anchors its files at that
// subfolder, but the hook reads only the contract at the git project's root: a contract there would bind nothing. Gate
// 0's freeze refuses, writes nothing (no contract, no record anywhere), and names the folder the run must start from.
test("a run started in a subfolder of a git project is refused at Gate 0, names the project's root, and freezes nothing", async () => {
  const dir = repo();
  const plain = mkdtempSync(join(tmpdir(), "mmo-contract-nogit-"));
  try {
    const sub = join(dir, "packages", "api");
    mkdirSync(join(sub, ".sdlc", "runs", "r1"), { recursive: true });
    const r = script(sub, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]");
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(`git project at ${dir}`), r.stderr);
    assert.match(r.stderr, /starts from the project's root folder/);
    assert.match(r.stderr, /Nothing is written/);
    for (const where of [sub, dir]) {
      assert.equal(existsSync(join(where, ".sdlc", "local", "write-contract.json")), false, `no contract in ${where}`);
      assert.equal(frozenBy(where), null, `no freeze record in ${where}`);
    }
    assert.equal(existsSync(LOG(sub)), false, "no line in the run's log");
    const none = script(plain, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]");
    assert.equal(none.status, 2);
    assert.match(none.stderr, /not in a git project/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

// ── What destroying the run's own record does, said truthfully ─────────────────────────────────────────────────────
test("deleting the run's own log or its folder destroys the freeze record and frees the run, and the module says exactly that", () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    rmSync(join(dir, ".sdlc", "runs", "r1"), { recursive: true, force: true });
    assert.equal(frozenBy(dir), null, "the record lives only in the run's own log");
    const text = readFileSync(LOCK_LIB, "utf8");
    assert.match(text, /Deleting or emptying (?:that|the run's own) log, or the run folder, frees the run/);
    assert.match(text, /destruction of the run's own record, not a cleanup/);
    assert.doesNotMatch(text, /never a cleanup of the contract's folder/, "no claim stronger than the record gives");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── A run log or contract that is not a regular file never stalls anything ─────────────────────────────────────────
// Reading a named pipe blocks until something writes to it. The hook reads every run log in the project before each
// Write or Edit, greenfield's included, and the script and the server read them too: one pipe where a log should be
// would hang every write. Only regular files are read; anything else is no record.
const HAS_MKFIFO = spawnSync("mkfifo", ["--version"], { stdio: "ignore" }).error === undefined;
test("a named pipe where a run log or the contract should be never stalls the hook, the script or the reader", { skip: HAS_MKFIFO ? false : "no mkfifo on this computer" }, async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, ".sdlc", "runs", "zz"), { recursive: true });
    assert.equal(spawnSync("mkfifo", [LOG(dir, "zz")]).status, 0);
    const greenfield = await runHook(dir, "src/a.ts", { ms: 5000 });
    assert.equal(greenfield.killed, false, "no contract: the hook answers at once");
    assert.equal(greenfield.code, 0);
    const reader = spawnSync(process.execPath, ["--input-type=module", "-e", `import { frozenBy } from ${JSON.stringify(pathToFileURL(LOCK_LIB).href)}; console.log(JSON.stringify(frozenBy(process.argv[1])));`, dir], { encoding: "utf8", timeout: 5000 });
    assert.equal(reader.signal, null, "the reader answers at once");
    assert.equal(reader.stdout.trim(), "null");
    const r = script(dir, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", "[]");
    assert.equal(r.signal, null, "the script answers at once");
    assert.equal(r.status, 0, r.stderr);
    const bound = await runHook(dir, "docs/x.md", { ms: 5000 });
    assert.equal(bound.killed, false);
    assert.equal(bound.code, 2, "the live run's contract still binds");
    // The contract itself replaced by a pipe while its run is live: refused (its bytes cannot match), at once.
    rmSync(CONTRACT(dir));
    assert.equal(spawnSync("mkfifo", [CONTRACT(dir)]).status, 0);
    const piped = await runHook(dir, "src/a.ts", { ms: 5000 });
    assert.equal(piped.killed, false);
    assert.equal(piped.code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The freezing run's own log a pipe: the record cannot be written, so nothing is frozen (no contract is left
  // binding without its record), at once.
  const fresh = repo();
  try {
    assert.equal(spawnSync("mkfifo", [LOG(fresh)]).status, 0);
    const r = freeze(fresh);
    assert.equal(r.signal, null);
    assert.equal(r.status, 2);
    assert.throws(() => readFileSync(CONTRACT(fresh)), /ENOENT/, "no contract is left behind");
  } finally { rmSync(fresh, { recursive: true, force: true }); }
});

// ── --strict-write=off never lets the run change what judges it ────────────────────────────────────────────────────
// Under strict = false every other refusal is a warning. But a frozen contract changed mid-run refuses every write
// after it, so a Write of the run's own contract or log allowed "with a warning" would wedge the run: both stay
// refused while the record is live.
test("under strict = false a frozen run's own contract and log stay refused; everything else is a warning", async () => {
  const dir = repo();
  try {
    assert.equal(script(dir, "--freeze", "--run-id", "r1", "--allowlist", '["src/**"]', "--off-limits", '["secrets/**"]', "--strict-write=off").status, 0);
    for (const f of [".sdlc/local/write-contract.json", ".sdlc/runs/r1/orchestrator.log"]) {
      const h = await runHook(dir, f);
      assert.equal(h.code, 2, `${f}: ${h.stderr}`);
    }
    for (const f of ["docs/x.md", "secrets/key.pem", "src/a.ts"]) {
      const h = await runHook(dir, f);
      assert.equal(h.code, 0, `${f}: ${h.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── The contract lives at the git project's root ───────────────────────────────────────────────────────────────────
// The hook reads only the contract at the root of the git project that holds a write, so the script writes it only
// there: a freeze into a subfolder would bind nothing, and would only hold that folder for other runs.
test("the script freezes only at a git project's root: a freeze into a subfolder is refused, also while a run is live at the root", async () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    mkdirSync(join(dir, "docs"));
    const nested = script(join(dir, "docs"), "--freeze", "--run-id", "r5", "--allowlist", '["**"]', "--off-limits", "[]");
    assert.equal(nested.status, 2);
    assert.match(nested.stderr, /not the root of a git project/);
    assert.throws(() => readFileSync(join(dir, "docs", ".sdlc", "local", "write-contract.json")), /ENOENT/);
    assert.equal((await runHook(dir, "docs/x.md")).code, 2, "the root's live contract still decides");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
