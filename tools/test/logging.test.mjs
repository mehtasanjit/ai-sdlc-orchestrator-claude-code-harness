/**
 * Cross-cutting guard for the MMO: log stream (docs/logging.md, ticket
 * §5.3/§10.1). Covers what a single-implementation test can't:
 *   - the TS server logger (dist/log.js) and the ESM script logger
 *     (plugin/scripts/lib/log.mjs) produce byte-identical lines for the
 *     same input, proving the "cannot import each other" split didn't drift
 *   - same for the two redaction copies (dist/redact.js vs
 *     dispatch-sanitize.mjs's PATTERNS)
 *   - rotation shifts the earlier pieces of a log and keeps every one (both loggers)
 *   - a real subprocess never writes a byte to stdout while logging
 *   - mmo-log.mjs is fail-open end to end
 *   - env.mjs's level-resolution precedence
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIST = join(ROOT, "plugin", "mcp", "model-dispatch", "dist");
const SERVER_BUILT = existsSync(join(SERVER_DIST, "log.js"));

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mmo-logging-test-"));
}

// ─── format parity: TS vs ESM ──────────────────────────────────────────

const FIXTURES = [
  ["info", "dispatch.end", { packet: "tp1", model_id: "flash-completion", ok: true, n: 3, cost_usd: 0.0031 }],
  ["error", "dispatch.error", { message: 'multi\nline\ttabbed "quoted" back\\slash', packet_id: "p1" }],
  ["warn", "env.legacy_name", { names: "SDLC_SELECT,SDLC_DEBUG" }],
  ["info", "run.start", { run_id: "r1", mode: "brownfield", intent: null, policy: undefined }],
  ["debug", "adapter.construct", { model_id: "x", cache_hit: false }],
];

/** Strip the ISO timestamp so two separate process calls can be compared. */
function stripTimestamp(line) {
  return line.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "<ts>");
}

test("the TS and ESM loggers emit byte-identical lines for the same input", { skip: !SERVER_BUILT && "server not built" }, () => {
  for (const [level, event, fields] of FIXTURES) {
    const tsOut = spawnSync(
      "node",
      ["--input-type=module", "-e", `
        import { formatLine } from ${JSON.stringify(join(SERVER_DIST, "log.js"))};
        process.stdout.write(formatLine(${JSON.stringify(level)}, ${JSON.stringify(event)}, ${JSON.stringify(fields)}));
      `],
      { encoding: "utf8" },
    );
    const jsOut = spawnSync(
      "node",
      ["--input-type=module", "-e", `
        import { formatLine } from ${JSON.stringify(join(ROOT, "plugin", "scripts", "lib", "log.mjs"))};
        process.stdout.write(formatLine(${JSON.stringify(level)}, ${JSON.stringify(event)}, ${JSON.stringify(fields)}));
      `],
      { encoding: "utf8" },
    );
    assert.equal(tsOut.status, 0, tsOut.stderr);
    assert.equal(jsOut.status, 0, jsOut.stderr);
    assert.equal(
      stripTimestamp(tsOut.stdout),
      stripTimestamp(jsOut.stdout),
      `mismatch for ${event}: ts="${tsOut.stdout}" js="${jsOut.stdout}"`,
    );
  }
});

// ─── redaction parity: TS redact.ts vs dispatch-sanitize.mjs ──────────

const SECRET_FIXTURES = [
  "key AKIAIOSFODNN7EXAMPLE leaked in a log line",
  "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ01234567890",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----",
  "nothing secret in this line at all",
  "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
];

test("the TS and ESM redaction layers agree on which strings are secret-shaped", { skip: !SERVER_BUILT && "server not built" }, () => {
  for (const text of SECRET_FIXTURES) {
    const tsFound = spawnSync(
      "node",
      ["--input-type=module", "-e", `
        import { findPatternNames } from ${JSON.stringify(join(SERVER_DIST, "redact.js"))};
        process.stdout.write(JSON.stringify(findPatternNames(${JSON.stringify(text)}).sort()));
      `],
      { encoding: "utf8" },
    );
    const jsFound = spawnSync(
      "node",
      ["--input-type=module", "-e", `
        import { PATTERNS } from ${JSON.stringify(join(ROOT, "plugin", "scripts", "dispatch-sanitize.mjs"))};
        const text = ${JSON.stringify(text)};
        const names = [];
        for (const { name, re } of PATTERNS) { re.lastIndex = 0; if (re.test(text)) names.push(name); }
        process.stdout.write(JSON.stringify(names.sort()));
      `],
      { encoding: "utf8" },
    );
    assert.equal(tsFound.status, 0, tsFound.stderr);
    assert.equal(jsFound.status, 0, jsFound.stderr);
    assert.equal(tsFound.stdout, jsFound.stdout, `pattern-name mismatch for: ${text}`);
  }
});

// ─── rotation ───────────────────────────────────────────────────────────

/**
 * A run's log is its record: its start, its gates and its contract's freeze record sit in its oldest lines. So a
 * rotation shifts the pieces it made before (.1 to .2, and so on) and keeps every one; overwriting .1 at the second
 * rotation dropped the piece that holds the run's first lines. Both loggers rotate alike (the server writes the same
 * run log as mmo-log.mjs). The readers read every piece, the highest number the oldest (workflow-log.mjs
 * readRunLogText).
 */
const LOGGERS = [
  ["the script logger", join(ROOT, "plugin", "scripts", "lib", "log.mjs")],
  ...(SERVER_BUILT ? [["the server logger", join(SERVER_DIST, "log.js")]] : []),
];
for (const [which, module] of LOGGERS) {
  test(`rotation shifts the earlier pieces and keeps every one once the active log crosses 5MB (${which})`, () => {
    const dir = tmpDir();
    try {
      const logPath = join(dir, "orchestrator.log");
      const logOnce = (fields) => {
        const r = spawnSync(
          "node",
          ["--input-type=module", "-e", `
            import { log, configureSinks } from ${JSON.stringify(module)};
            configureSinks({ runLogPath: ${JSON.stringify(logPath)} });
            log("info", "phase.start", ${JSON.stringify(fields)});
          `],
          { encoding: "utf8" },
        );
        assert.equal(r.status, 0, r.stderr);
      };
      writeFileSync(logPath, "first " + "x".repeat(5 * 1024 * 1024 + 10));
      logOnce({ run_id: "r1", n: 1 });
      assert.ok(readFileSync(`${logPath}.1`, "utf8").startsWith("first "), "the first rotation's piece is .1");
      assert.match(readFileSync(logPath, "utf8"), /phase\.start run_id=r1 n=1/, "the new line lands in a fresh active file");
      writeFileSync(logPath, "second " + "y".repeat(5 * 1024 * 1024 + 10));
      logOnce({ run_id: "r1", n: 2 });
      assert.ok(readFileSync(`${logPath}.2`, "utf8").startsWith("first "), "the second rotation shifts the first piece to .2, never drops it");
      assert.ok(readFileSync(`${logPath}.1`, "utf8").startsWith("second "), "the newest piece is .1");
      assert.match(readFileSync(logPath, "utf8"), /phase\.start run_id=r1 n=2/);
      assert.equal(existsSync(`${logPath}.rotating`), false, "the rotation lock is released");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ─── stdout purity, in a real subprocess ───────────────────────────────

test("logging never writes a byte to stdout, verified across a real process boundary", () => {
  const dir = tmpDir();
  try {
    const r = spawnSync(
      "node",
      ["--input-type=module", "-e", `
        import { log, configureSinks } from ${JSON.stringify(join(ROOT, "plugin", "scripts", "lib", "log.mjs"))};
        configureSinks({ projectRoot: ${JSON.stringify(dir)} });
        log("trace", "agsdk.worker.stderr", { packet_id: "p1", line: "some worker output" });
        log("info", "dispatch.start", { packet_id: "p1" });
      `],
      { encoding: "utf8", env: { ...process.env, MMO_LOG_LEVEL: "trace" } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "stdout must be completely empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── mmo-log.mjs CLI: fail-open, correct sink resolution ───────────────

test("mmo-log.mjs writes to the per-run log when --run-id is given", () => {
  const dir = tmpDir();
  try {
    const r = spawnSync(
      "node",
      [join(ROOT, "plugin", "scripts", "mmo-log.mjs"),
        "--event=phase.start", "--level=info",
        "--run-id=20260818-110000-bugfix-a7f3", "--phase=codegen",
        `--project-root=${dir}`],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const logPath = join(dir, ".sdlc", "runs", "20260818-110000-bugfix-a7f3", "orchestrator.log");
    assert.ok(existsSync(logPath), "expected a per-run orchestrator.log");
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /phase\.start/);
    assert.match(content, /run_id=20260818-110000-bugfix-a7f3/);
    assert.match(content, /phase=codegen/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mmo-log.mjs falls back to .sdlc/local/debug.log when there is no run yet", () => {
  const dir = tmpDir();
  try {
    const r = spawnSync(
      "node",
      [join(ROOT, "plugin", "scripts", "mmo-log.mjs"),
        "--event=policy.load", "--level=info", "--policy-name=opus-plus-flash",
        `--project-root=${dir}`],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const logPath = join(dir, ".sdlc", "local", "debug.log");
    assert.ok(existsSync(logPath));
    assert.match(readFileSync(logPath, "utf8"), /policy\.load/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mmo-log.mjs is fail-open: a missing --event warns and still exits 0", () => {
  const r = spawnSync("node", [join(ROOT, "plugin", "scripts", "mmo-log.mjs"), "--level=info"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /--event is required/);
});

test("mmo-log.mjs redacts secret-shaped field values before they hit disk", () => {
  const dir = tmpDir();
  try {
    const r = spawnSync(
      "node",
      [join(ROOT, "plugin", "scripts", "mmo-log.mjs"),
        "--event=dispatch.error", "--level=error",
        "--message=leaked AKIAIOSFODNN7EXAMPLE here",
        `--project-root=${dir}`],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(r.stderr.includes("[redacted:aws-access-key-id]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── env.mjs level-resolution precedence ───────────────────────────────

test("env.mjs resolves the log level in the documented precedence order", async () => {
  const { resolveLogLevel } = await import(join(ROOT, "plugin", "scripts", "lib", "env.mjs"));

  assert.equal(resolveLogLevel({}, "debug").level, "debug", "an explicit per-call argument wins over everything");
  assert.equal(resolveLogLevel({ MMO_LOG_LEVEL: "warn" }).level, "warn");
  assert.equal(resolveLogLevel({ MMO_LOG_LEVEL: "warn" }, "trace").level, "trace", "explicit still outranks MMO_LOG_LEVEL");
  assert.equal(resolveLogLevel({ MMO_VERBOSE: "1" }).level, "debug");
  assert.equal(resolveLogLevel({ MMO_DEBUG: "1" }).level, "debug");
  const legacy = resolveLogLevel({ SDLC_DEBUG: "1" });
  assert.equal(legacy.level, "debug");
  assert.equal(legacy.legacyUsed, true, "the legacy SDLC_DEBUG path must be flagged so the caller can warn");
  assert.equal(resolveLogLevel({}).level, "info", "default is info");
  // Precedence: MMO_LOG_LEVEL beats MMO_VERBOSE beats MMO_DEBUG beats legacy SDLC_DEBUG.
  assert.equal(resolveLogLevel({ MMO_LOG_LEVEL: "error", MMO_VERBOSE: "1" }).level, "error");
  assert.equal(resolveLogLevel({ MMO_VERBOSE: "1", MMO_DEBUG: "1" }).level, "debug");
});

// ─── where mmo-log.mjs writes when no --project-root is given ──────────

test("mmo-log.mjs called from inside the product folder of a git project with no --project-root writes to the project's .sdlc, never a new one in the product", () => {
  const dir = tmpDir();
  try {
    spawnSync("mkdir", ["-p", join(dir, ".sdlc"), join(dir, "src", "api")]);
    assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
    const r = spawnSync("node", [join(ROOT, "plugin", "scripts", "mmo-log.mjs"), "--event=phase.start", "--level=info", "--run-id=r1"], { encoding: "utf8", cwd: join(dir, "src", "api") });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, ".sdlc", "runs", "r1", "orchestrator.log")), "the project's own log");
    assert.equal(existsSync(join(dir, "src", "api", ".sdlc")), false, "no .sdlc written inside the product");
    assert.equal(existsSync(join(dir, "src", ".sdlc")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env.mjs finds the nearest folder holding .sdlc, never above the git root; an explicit root still wins", async () => {
  const { resolveProjectRoot } = await import(join(ROOT, "plugin", "scripts", "lib", "env.mjs"));
  const { realpathSync } = await import("node:fs");
  const outer = realpathSync(tmpDir());
  try {
    const repo = join(outer, "repo");
    spawnSync("mkdir", ["-p", join(outer, ".sdlc"), join(repo, "pkg", ".sdlc"), join(repo, "pkg", "src"), join(repo, "other", "src")]);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    assert.equal(resolveProjectRoot("/explicit/root", join(repo, "pkg", "src")), "/explicit/root", "an explicit root wins");
    assert.equal(resolveProjectRoot(undefined, join(repo, "pkg", "src")), join(repo, "pkg"), "the nearest .sdlc, inside the repository");
    assert.equal(resolveProjectRoot(undefined, join(repo, "other", "src")), repo, "no .sdlc inside the repository: its root, never the .sdlc above it");
    const loose = join(outer, "loose", "src");
    spawnSync("mkdir", ["-p", loose]);
    assert.equal(resolveProjectRoot(undefined, loose), loose, "outside any repository: the folder itself, never the .sdlc above it");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("mmo-log.mjs takes --project-root in both forms, and the explicit root wins over the folder it runs in", () => {
  const project = tmpDir();
  const elsewhere = tmpDir();
  try {
    spawnSync("mkdir", ["-p", join(elsewhere, ".sdlc")]);
    const script = join(ROOT, "plugin", "scripts", "mmo-log.mjs");
    for (const [runId, args] of [["r-space", ["--project-root", project]], ["r-equals", [`--project-root=${project}`]]]) {
      const r = spawnSync("node", [script, "--event=run.start", "--level=info", `--run-id=${runId}`, ...args, "--mode=greenfield"], { encoding: "utf8", cwd: elsewhere });
      assert.equal(r.status, 0, r.stderr);
      const log = join(project, ".sdlc", "runs", runId, "orchestrator.log");
      assert.ok(existsSync(log), `${args.join(" ")}: the log is under the named root`);
      assert.match(readFileSync(log, "utf8"), /mode=greenfield/, "the field after the root is still a field");
      assert.doesNotMatch(readFileSync(log, "utf8"), /project_root|mmo-logging-test/, "the root is control, never a field");
      assert.equal(existsSync(join(elsewhere, ".sdlc", "runs", runId)), false, "nothing under the folder it ran in");
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("mmo-log.mjs run from a folder outside any git repository logs there, never to a .sdlc above it such as the home folder's", () => {
  const home = tmpDir();
  try {
    const project = join(home, "Desktop", "newproj");
    const nested = join(home, "Desktop", "workspace", "run-1");
    spawnSync("mkdir", ["-p", join(home, ".sdlc", "local"), project, join(home, "Desktop", "workspace", ".sdlc"), nested]);
    const script = join(ROOT, "plugin", "scripts", "mmo-log.mjs");
    for (const cwd of [project, nested]) {
      const r = spawnSync("node", [script, "--event=run.start", "--level=info", "--run-id=r1", "--mode=greenfield"], { encoding: "utf8", cwd, env: { ...process.env, HOME: home } });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(cwd, ".sdlc", "runs", "r1", "orchestrator.log")), `the run's own folder: ${cwd}`);
    }
    assert.equal(existsSync(join(home, ".sdlc", "runs")), false, "nothing under the home folder's .sdlc");
    assert.equal(existsSync(join(home, "Desktop", "workspace", ".sdlc", "runs")), false, "nothing under a parent folder's .sdlc");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
