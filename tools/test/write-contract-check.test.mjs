/**
 * Unit tests for plugin/scripts/write-contract-check.mjs — the PreToolUse
 * hook that refuses off-limits or not-in-manifest writes during brownfield
 * runs (ticket §7.1, §10.1).
 *
 * Testing shape: subprocess-based, piping the Claude Code hook input shape
 * on stdin and asserting the exit code + stderr. Exit 0 = allow, 2 = deny
 * (Claude Code's blocking hook exit code — 1 is a NON-blocking hook error
 * that would let the write proceed, which is the bug these tests pin).
 * Fail-open: bad or missing contract → allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract-check.mjs");

/**
 * Run the hook with the given tool call payload from the given cwd.
 * Returns { code, stderr }.
 */
function runHook(cwd, payload) {
  return new Promise((resolvePromise) => {
    const p = spawn("node", [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", (code) => resolvePromise({ code, stderr }));
    p.stdin.end(JSON.stringify(payload));
  });
}

function makeRepo(contract) {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  if (contract !== undefined) {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("allows any write when no contract file exists (greenfield case)", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/anything.ts" } });
    assert.equal(r.code, 0, "must allow when no contract present");
  } finally { cleanup(dir); }
});

test("allows any write when contract.active is false", async () => {
  const dir = makeRepo({ schema_version: 1, active: false, allowlist: [], off_limits: [] });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/anything.ts" } });
    assert.equal(r.code, 0, "inactive contract must allow");
  } finally { cleanup(dir); }
});

test("allows a path that matches the allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/lib/foo.ts" } });
    assert.equal(r.code, 0, `expected allow; stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("denies a path that hits off_limits — even if it also matches allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-1",
    allowlist: ["**/*"], off_limits: [".env", ".env.*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env.production" } });
    assert.equal(r.code, 2, "off_limits must deny even when allowlist would match");
    assert.match(r.stderr, /off-limits/, "reason must name the rule class");
  } finally { cleanup(dir); }
});

test("denies a path that is not in the allowlist (allowlist-default-deny)", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-2",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "docs/README.md" } });
    assert.equal(r.code, 2, "not-in-allowlist must deny in strict mode");
    assert.match(r.stderr, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

test("strict=false downgrades an off_limits hit to WARN + allow", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: false,
    allowlist: [], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env" } });
    assert.equal(r.code, 0, "strict=false must allow even off-limits");
    assert.match(r.stderr, /WARN/, "must warn instead of denying");
  } finally { cleanup(dir); }
});

test("fails open when the contract file is not valid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), "this is not json {[}");
    const r = await runHook(dir, { tool_input: { file_path: "anything" } });
    assert.equal(r.code, 0, "corrupt contract must fail open, not block");
  } finally { cleanup(dir); }
});

test("fails open when the tool call has no file_path", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, { tool_input: {} });
    assert.equal(r.code, 0, "no file_path in payload → allow");
  } finally { cleanup(dir); }
});

// ── SiteNotes regression: cross-repo writes and pre-contract safety net ────

test("cross-repo write: denies an absolute path that resolves outside cwd's contract (SiteNotes bug)", async () => {
  // Reproduces the SiteNotes bug: session's cwd is repoA (with an active
  // contract), but the model issues an Edit whose file_path is an absolute
  // path in a completely different tree (repoB — here, the plugin's own
  // worktree). Old code found repoA's contract, computed the target
  // relative to repoA's root as "../../repoB/…", and either allowed (no
  // matching off_limits) or denied with "not in allowlist" — treating a
  // category error as merely out-of-scope. New code detects the escape
  // upfront and denies with a category-error message.
  const repoA = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "repo-a-run",
    allowlist: ["src/**"], off_limits: [],
  });
  const repoB = mkdtempSync(join(tmpdir(), "write-contract-repo-b-"));
  try {
    const absTargetInB = join(repoB, "plugin", "scripts", "verify-setup.mjs");
    mkdirSync(join(repoB, "plugin", "scripts"), { recursive: true });
    // cwd=repoA, target=absolute path in repoB. Upfront cwd-anchored escape
    // check fires: target is outside repoA's contracted tree → deny.
    const r = await runHook(repoA, { tool_input: { file_path: absTargetInB } });
    assert.equal(r.code, 2, `escape must deny; stderr=${r.stderr}`);
    assert.match(r.stderr, /OUTSIDE the calling session's contracted repo|Cross-project writes/,
      "must be labeled as a category error, not just out-of-scope");
  } finally { cleanup(repoA); cleanup(repoB); }
});

test("cross-repo write with contract on BOTH sides: escape from A's contract is denied", async () => {
  // Sharper case: both trees carry contracts. Session cwd = repoA. Target
  // resolves to an absolute path in repoB. Since target-anchored resolution
  // finds repoB's contract first, the write is checked against repoB's
  // contract (which may or may not allow it) — but critically, if the
  // caller manages to force cwd=repoA lookup via a relative path that
  // escapes A, the escape check fires.
  const repoA = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "repo-a",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    // Relative path that escapes repoA when resolved against repoA.
    const escapingRelative = "../../../../etc/passwd";
    const r = await runHook(repoA, { tool_input: { file_path: escapingRelative } });
    assert.equal(r.code, 2, `escape must deny; stderr=${r.stderr}`);
    assert.match(r.stderr, /OUTSIDE the contract's repo root|Cross-project writes/,
      "escape must be labeled as a category error, not just out-of-scope");
  } finally { cleanup(repoA); }
});

test("pre-contract safety net: denies .env write even when no contract exists", async () => {
  const dir = makeRepo(undefined); // no contract
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env" } });
    assert.equal(r.code, 2, "always-off-limits path must deny even without a contract");
    assert.match(r.stderr, /always-off-limits/, "must name the safety-net rule");
  } finally { cleanup(dir); }
});

test("pre-contract safety net: denies .mcp.json write even when no contract exists", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".mcp.json" } });
    assert.equal(r.code, 2, "MCP config write is refused pre-contract");
    assert.match(r.stderr, /always-off-limits/);
  } finally { cleanup(dir); }
});

test("pre-contract safety net: allows an ordinary src/ write when no contract exists", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/lib/foo.ts" } });
    assert.equal(r.code, 0, "pre-contract safety net only blocks the constant list, not everything");
  } finally { cleanup(dir); }
});

test("target-anchored contract resolution: absolute target inside a contracted repo hits its contract", async () => {
  // cwd is a neutral scratch dir with no contract. Target is an absolute
  // path inside a fully separate contracted repo. The hook must find the
  // repo's contract by walking up from the target file's parent, not from
  // cwd — otherwise it would fall through to the greenfield "allow" branch.
  const neutralCwd = mkdtempSync(join(tmpdir(), "write-contract-neutral-"));
  const contracted = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "target-anchored",
    allowlist: ["docs/**"], off_limits: [],
  });
  try {
    const absTarget = join(contracted, "src", "should-not-be-written.ts");
    mkdirSync(join(contracted, "src"), { recursive: true });
    const r = await runHook(neutralCwd, { tool_input: { file_path: absTarget } });
    assert.equal(r.code, 2, "target-anchored contract must be found and enforced");
    assert.match(r.stderr, /not in the confirmed allowlist/i,
      "allowlist-default-deny must trigger against the target's contract");
  } finally { cleanup(neutralCwd); cleanup(contracted); }
});

/*
 * The run's own output directory. `.sdlc/**` sits in OFF_LIMITS_DEFAULT to stop
 * the model hand-editing plugin state, and off-limits is evaluated before the
 * allowlist — so before the carve-out an active contract refused the run the
 * artifacts agents/orchestrator.md contractually requires it to write there.
 * Once denials became blocking (exit 2) that stopped being cosmetic: a
 * brownfield run failed at its first direct-tier write, and provenance.json —
 * the file /mmo:revert restores from — was refused with it.
 */
const RUN_DIR_CONTRACT = {
  schema_version: 1,
  active: true,
  strict: true,
  run_id: "run-1",
  allowlist: ["src/**"],
  off_limits: [".env", ".sdlc/**", "dist/**"],
};

for (const artifact of ["requirements.md", "change_plan.md", "provenance.json"]) {
  test(`the run's own .sdlc/runs/<run-id>/ artifact "${artifact}" is allowed under an active contract`, async () => {
    const dir = makeRepo(RUN_DIR_CONTRACT);
    try {
      const r = await runHook(dir, { tool_input: { file_path: `.sdlc/runs/run-1/${artifact}` } });
      assert.equal(r.code, 0, `${artifact} is auto-allowlisted; blocking it breaks the run that must write it`);
    } finally { cleanup(dir); }
  });
}

test("the carve-out is scoped to this run — another run's evidence directory stays denied", async () => {
  const dir = makeRepo(RUN_DIR_CONTRACT);
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".sdlc/runs/run-2/provenance.json" } });
    assert.equal(r.code, 2, "a run must never write another run's evidence");
  } finally { cleanup(dir); }
});

test("the carve-out does not open the rest of .sdlc — the contract file itself stays denied", async () => {
  const dir = makeRepo(RUN_DIR_CONTRACT);
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".sdlc/local/write-contract.json" } });
    assert.equal(r.code, 2, "the contract must not be rewritable by the run it governs");
  } finally { cleanup(dir); }
});

test("a contract with no run_id gets no carve-out", async () => {
  const dir = makeRepo({ ...RUN_DIR_CONTRACT, run_id: undefined });
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".sdlc/runs/run-1/requirements.md" } });
    assert.equal(r.code, 2, "without a run_id there is no run directory to auto-allowlist");
  } finally { cleanup(dir); }
});

/*
 * The pre-contract safety net fires with no run context at all — in greenfield
 * and in any repository that merely has the plugin installed. Since denials
 * became blocking it must hold only paths that are unsafe to write anywhere;
 * build output is not.
 */
for (const secret of [".env", ".env.production", ".mcp.json", ".git/config", ".claude/settings.local.json"]) {
  test(`pre-contract safety net still denies "${secret}"`, async () => {
    const dir = makeRepo(undefined);
    try {
      const r = await runHook(dir, { tool_input: { file_path: secret } });
      assert.equal(r.code, 2, `${secret} is unsafe to write with no contract to scope it`);
    } finally { cleanup(dir); }
  });
}

for (const buildPath of ["dist/bundle.js", "build/out.css", ".next/server/page.js", "node_modules/react/index.js", ".sdlc/runs/run-1/manifest.json"]) {
  test(`pre-contract safety net allows "${buildPath}" — build output and plugin state are not secrets`, async () => {
    const dir = makeRepo(undefined);
    try {
      const r = await runHook(dir, { tool_input: { file_path: buildPath } });
      assert.equal(r.code, 0, `${buildPath} must not be hard-blocked in every repo the plugin is installed in`);
    } finally { cleanup(dir); }
  });
}

test("a project reached through a linked folder: writes inside it are judged inside, whichever form the path takes", async () => {
  // The session's folder comes from process.cwd(), which the system gives with every link resolved
  // (/private/var/... on macOS), while a write's path arrives as written (/var/...). Compared as text, every write in
  // a project under a linked folder (macOS's /tmp and /var, a linked code folder) would be refused as "OUTSIDE the
  // calling session's contracted repo".
  const base = realpathSync(mkdtempSync(join(tmpdir(), "write-contract-link-")));
  const real = join(base, "real", "proj");
  const link = join(base, "link");
  const outside = join(base, "elsewhere");
  try {
    mkdirSync(join(real, ".sdlc", "local"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(join(base, "real"), link);
    writeFileSync(join(real, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, strict: true, run_id: "r1", allowlist: ["src/**"], off_limits: [".env"] }));
    const viaLink = join(link, "proj");
    const cases = [
      [viaLink, join(viaLink, "src", "a.ts"), 0, "session in the linked form, path in the linked form"],
      [viaLink, join(real, "src", "a.ts"), 0, "session in the linked form, path in the real form"],
      [real, join(viaLink, "src", "a.ts"), 0, "session in the real form, path in the linked form"],
      [viaLink, "src/a.ts", 0, "a relative path"],
    ];
    for (const [cwd, file, code, what] of cases) {
      const r = await runHook(cwd, { tool_input: { file_path: file } });
      assert.equal(r.code, code, `${what}: ${r.stderr}`);
    }
    // The rules still hold, in either form: not in the allowlist, off-limits, and truly outside.
    const notListed = await runHook(viaLink, { tool_input: { file_path: join(viaLink, "docs", "x.md") } });
    assert.equal(notListed.code, 2);
    assert.match(notListed.stderr, /docs\/x\.md is not in the confirmed allowlist/, "judged by the allowlist, not as a write outside the project");
    const off = await runHook(viaLink, { tool_input: { file_path: join(viaLink, ".env") } });
    assert.equal(off.code, 2);
    assert.match(off.stderr, /matches off-limits pattern "\.env"/);
    const away = await runHook(viaLink, { tool_input: { file_path: join(outside, "x.ts") } });
    assert.equal(away.code, 2);
    assert.match(away.stderr, /resolves OUTSIDE the calling session's contracted repo/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/*
 * The run's end. A contract binds its own run, only while that run is live by its own log
 * (.sdlc/runs/<run-id>/orchestrator.log, written by mmo-log.mjs). Before, nothing ever ended it: the brownfield guide's
 * close-out writes under the off-limits `.sdlc/**` and was refused, so after a normal finish the contract stayed on
 * and refused every later edit in the project outside that run's allowlist, in every chat, the next run's Gate 0
 * included. And while the run is live, it may not change its own contract or write its own log by hand: either
 * would let it out of the contract.
 */
const { formatLine } = await import(resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "lib", "log.mjs"));
const CONTRACT_FILE = ".sdlc/local/write-contract.json";
const RUN_LOG = ".sdlc/runs/run-1/orchestrator.log";

/** Writes the run's orchestrator.log, one line per [event, fields], in mmo-log.mjs's format. */
function writeRunLog(dir, runId, events) {
  mkdirSync(join(dir, ".sdlc", "runs", runId), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "runs", runId, "orchestrator.log"), events.map(([e, f]) => formatLine("info", e, f)).join("\n") + "\n");
}
const START = ["run.start", { run_id: "run-1" }];
const COMPLETED = ["run.end", { run_id: "run-1", outcome: "completed" }];
const gate = (g, response) => ["gate.resolved", { run_id: "run-1", gate: g, response }];
const ACCEPTED = [START, COMPLETED, gate("gate-4", "approved")];
const switchOff = { tool_name: "Edit", tool_input: { file_path: CONTRACT_FILE, old_string: '"active":true', new_string: '"active":false' } };

for (const [name, events] of [
  ["its Gate 4 was accepted", ACCEPTED],
  ["its Gate 4 was answered accept", [START, COMPLETED, gate("gate-4", "accept")]],
  ["it was aborted at a gate", [START, gate("gate-2", "abort")]],
  ["its run.end says it failed", [START, ["run.end", { run_id: "run-1", outcome: "failed" }]]],
  ["its run.end says it was aborted (a zero-touch Replace)", [START, ["run.end", { run_id: "run-1", outcome: "aborted", reason: "replaced" }]]],
]) {
  test(`a contract whose run has ended (${name}) binds nothing, exactly as one switched off`, async () => {
    const dir = makeRepo(RUN_DIR_CONTRACT);
    const off = makeRepo({ ...RUN_DIR_CONTRACT, active: false });
    try {
      writeRunLog(dir, "run-1", events);
      for (const path of ["lib/other.ts", ".sdlc/ledger.md", ".sdlc/CLAUDE-SDLC.md", CONTRACT_FILE, ".env"]) {
        const [a, b] = [await runHook(dir, { tool_input: { file_path: path } }), await runHook(off, { tool_input: { file_path: path } })];
        assert.equal(a.code, b.code, `${path}: an ended run's contract answers as a switched-off one; stderr=${a.stderr}`);
      }
      assert.equal((await runHook(dir, { tool_input: { file_path: "lib/other.ts" } })).code, 0, "the project is free again");
      assert.equal((await runHook(dir, switchOff)).code, 0, "the close-out switches the contract off");
      assert.equal((await runHook(dir, { tool_name: "Write", tool_input: { file_path: CONTRACT_FILE, content: JSON.stringify({ ...RUN_DIR_CONTRACT, run_id: "run-2" }) } })).code, 0, "the next run's Gate 0 writes its own contract");
    } finally { cleanup(dir); cleanup(off); }
  });
}

for (const [name, events] of [
  ["no log yet", null],
  ["completed, Gate 4 not answered yet (the close-out comes after it)", [START, COMPLETED]],
  ["Gate 4 sent back for changes", [START, COMPLETED, gate("gate-4", "revise")]],
  ["Gate 4 rejected", [START, COMPLETED, gate("gate-4", "reject: tests missing")]],
  ["Gate 4 answered Revise, capitalised", [START, COMPLETED, gate("gate-4", "Revise: more tests")]],
  ["Gate 4 accepted, then sent back", [START, COMPLETED, gate("gate-4", "approved"), gate("gate-4", "revise")]],
  ["Gate 4 accepted, but no run.end", [START, gate("gate-4", "approved")]],
  ["a run.end with an empty outcome", [START, ["run.end", { run_id: "run-1", outcome: "" }], gate("gate-4", "approved")]],
  ["an abort with no gate named", [START, ["gate.resolved", { run_id: "run-1", response: "abort" }]]],
  ["an earlier gate approved", [START, gate("gate-1", "approved")]],
  ["ended, then started again", [START, gate("gate-2", "abort"), START]],
]) {
  test(`a contract whose run has not ended (${name}) still binds, its records and switch-off included`, async () => {
    const dir = makeRepo(RUN_DIR_CONTRACT);
    try {
      if (events) writeRunLog(dir, "run-1", events);
      for (const input of [{ tool_input: { file_path: "lib/other.ts" } }, { tool_input: { file_path: ".sdlc/ledger.md" } }, switchOff]) {
        const r = await runHook(dir, input);
        assert.equal(r.code, 2, `${input.tool_input.file_path}: only an explicit end in the run's own log frees the project`);
      }
    } finally { cleanup(dir); }
  });
}

test("a live run cannot get out of its contract in two steps: switching it off is refused, so nothing after it lands", async () => {
  const dir = makeRepo(RUN_DIR_CONTRACT);
  try {
    writeRunLog(dir, "run-1", [START, ["gate.open", { run_id: "run-1", gate: "gate-2" }]]);
    assert.equal((await runHook(dir, switchOff)).code, 2, "the run may not switch its own contract off");
    assert.equal((await runHook(dir, { tool_name: "Write", tool_input: { file_path: CONTRACT_FILE, content: JSON.stringify({ ...RUN_DIR_CONTRACT, active: false }) } })).code, 2);
    assert.equal((await runHook(dir, { tool_input: { file_path: "lib/other.ts" } })).code, 2, "so the next write is still bound");
  } finally { cleanup(dir); }
});

for (const path of [RUN_LOG, `${RUN_LOG}.1`, ".SDLC/runs/RUN-1/Orchestrator.log"]) {
  test(`a live run cannot log its own end by hand: a Write or Edit of "${path}" is refused`, async () => {
    const dir = makeRepo(RUN_DIR_CONTRACT);
    try {
      writeRunLog(dir, "run-1", [START]);
      const forged = formatLine("info", "run.end", { run_id: "run-1", outcome: "aborted" });
      assert.equal((await runHook(dir, { tool_name: "Edit", tool_input: { file_path: path, old_string: "run.start", new_string: forged } })).code, 2);
      assert.equal((await runHook(dir, { tool_name: "Write", tool_input: { file_path: path, content: forged + "\n" } })).code, 2);
      assert.equal((await runHook(dir, { tool_input: { file_path: "lib/other.ts" } })).code, 2, "the contract still binds");
    } finally { cleanup(dir); }
  });
}

test("the contract file is refused to a live run even when its allowlist covers it and its off-limits leave .sdlc out", async () => {
  const dir = makeRepo({ ...RUN_DIR_CONTRACT, allowlist: ["**"], off_limits: [".env"] });
  try {
    writeRunLog(dir, "run-1", [START]);
    const r = await runHook(dir, { tool_name: "Write", tool_input: { file_path: CONTRACT_FILE, content: JSON.stringify({ ...RUN_DIR_CONTRACT, allowlist: ["**"], off_limits: [] }) } });
    assert.equal(r.code, 2, "a run must never widen its own contract");
    assert.equal((await runHook(dir, { tool_input: { file_path: ".sdlc/runs/run-1/notes.md" } })).code, 0, "the rest of the run's own folder stays writable");
  } finally { cleanup(dir); }
});

test("another run's ended log does not free this run's contract", async () => {
  const dir = makeRepo(RUN_DIR_CONTRACT);
  try {
    writeRunLog(dir, "run-2", [["run.start", { run_id: "run-2" }], ["gate.resolved", { run_id: "run-2", gate: "gate-2", response: "abort" }]]);
    const r = await runHook(dir, { tool_input: { file_path: "lib/other.ts" } });
    assert.equal(r.code, 2);
  } finally { cleanup(dir); }
});

test("an ended run's contract in the session's folder does not refuse a write in another project", async () => {
  const contracted = makeRepo(RUN_DIR_CONTRACT);
  const other = mkdtempSync(join(tmpdir(), "write-contract-other-"));
  try {
    writeRunLog(contracted, "run-1", ACCEPTED);
    const r = await runHook(contracted, { tool_input: { file_path: join(other, "notes.md") } });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
  } finally { cleanup(contracted); cleanup(other); }
});
