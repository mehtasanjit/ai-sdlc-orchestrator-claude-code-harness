/**
 * How the brownfield writer runs a packet's commands (apply.ts runShell, runVerify, runRed, runFormat): each one in
 * its own process group, asynchronously, so a batch's checks run side by side and the server keeps answering (its
 * progress heartbeat, its cancel signal) while they run; at its time limit the whole group is killed, so nothing a
 * check started outlives it; it never sees the vendor credentials the server holds; and its verdict is its exit
 * status, reported with its true cause (an exit code, a signal, the time limit). Offline, temp folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runVerify, runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA } = await import(join(DIST, "apply.js"));

const tmpRoot = () => mkdtempSync(join(tmpdir(), "mmo-apply-checks-"));
const silent = () => {};
const route = () => ({ modelId: "flash", reason: "stub", ruleIndex: 0 });
const packet = (over = {}) => ({
  id: "tp_codegen_001", phase: "codegen", task_type: "", module: "spec", pass_id: "r", instruction: "Write the file.",
  inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/out.ts", ...over,
});
const answer = (content) => async (p) => ({
  decision: route(p),
  result: { success: true, result: { path: p.artifact_path, content }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0.001, terminal_reason: "success" },
  events: [],
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The server has one thread. A check run with spawnSync froze it for the check's whole run: four packets' checks ran
// one after another, and no progress message, timer or cancel could be handled meanwhile.
test("four packets' checks run side by side, and the server's event loop keeps turning while they run", async () => {
  const roots = [1, 2, 3, 4].map(() => tmpRoot());
  const SLOW = "node -e \"setTimeout(() => {}, 1500)\" {path}";
  let last = Date.now(), maxGap = 0;
  const ticker = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
  const t0 = Date.now();
  try {
    const outs = await Promise.all(roots.map((root, i) => runApplyLoop({
      packet: packet({ id: `tp_${i}` }), apply: normalizeApply({ write: true, verify: [SLOW] }), projectRoot: root, keepEvents: true,
      route, dispatch: answer("x\n"), log: silent,
    })));
    const wall = Date.now() - t0;
    assert.deepEqual(outs.map((o) => o.status), ["applied", "applied", "applied", "applied"]);
    // One after another the four take at least 6 s; side by side about 1.5 s (bounds left wide for a busy machine).
    assert.ok(wall < 4500, `the four checks ran one after another: ${wall} ms`);
    assert.ok(maxGap < 1000, `the event loop stood still for ${maxGap} ms while a check ran`);
  } finally {
    clearInterval(ticker);
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

// A check that starts other processes (a compound command, a test runner's workers) and passes its time limit: only
// the shell was stopped, and what it started kept running, and writing to the project, after the verdict.
test("at its time limit a check's whole process group is killed: nothing it started keeps running", async () => {
  const root = tmpRoot();
  let pid = null;
  try {
    const r = await runVerify(["sleep 30 & echo $! > bg.pid; wait"], root, "x", 1);
    assert.equal(r.ok, false);
    assert.match(r.output_tail, /timed out after 1s/);
    pid = Number(readFileSync(join(root, "bg.pid"), "utf8").trim());
    // The killed process is reaped by the system; give it a moment before calling it alive.
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(alive(pid), false, "the background process the check started is still running");
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

// The server holds the vendors' credentials (plugin.json passes them in). A check runs the project's own commands,
// and its failing output goes into the next attempt's prompt, which may go to another vendor: it never sees them,
// as greenfield's product commands never do (executor/acceptance.ts commandEnv).
test("a check never sees the vendor credentials the server holds; the rest of the environment passes through", async () => {
  const root = tmpRoot();
  const names = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_OAUTH_TOKEN"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = `probe-${n}`;
  process.env.MMO_CHECK_ENV_PROBE = "kept";
  try {
    const leak = `node -e "const k=${JSON.stringify(names).replace(/"/g, "'")}.filter((n)=>process.env[n]);if(k.length){console.log('seen:'+k.join(','));process.exit(1)}process.exit(process.env.MMO_CHECK_ENV_PROBE==='kept'?0:2)"`;
    const r = await runVerify([leak], root, "x");
    assert.equal(r.ok, true, r.output_tail);
  } finally {
    for (const n of names) if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    delete process.env.MMO_CHECK_ENV_PROBE;
    rmSync(root, { recursive: true, force: true });
  }
});

// A check's verdict is its exit status, and its cause is reported as it was: a check ended by a signal is not a
// timeout, and a check that passes while printing a lot passes (its output is tailed as it streams, never a reason
// to stop it).
test("a check ended by a signal is reported as that signal, never as a timeout", async () => {
  const root = tmpRoot();
  try {
    const r = await runVerify(["kill -KILL $$"], root, "x", 30);
    assert.equal(r.ok, false);
    assert.equal(r.signal, "SIGKILL");
    assert.doesNotMatch(r.output_tail ?? "", /timed out/);
    const out = await runApplyLoop({
      packet: packet(), apply: normalizeApply({ write: true, verify: ["kill -KILL $$"], max_retries: 0 }), projectRoot: root, keepEvents: true,
      route, dispatch: answer("x\n"), log: silent,
    });
    assert.equal(out.status, "verify_failed");
    assert.match(out.attempts[0].failure, /\(signal SIGKILL\)/);
    assert.doesNotMatch(out.attempts[0].failure, /timeout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check that passes while printing more than any bound passes, and its output is tailed", async () => {
  const root = tmpRoot();
  try {
    const r = await runVerify(["node -e \"process.stdout.write('x'.repeat(9*1024*1024))\""], root, "x", 60);
    assert.equal(r.ok, true);
    const f = await runVerify(["node -e \"process.stdout.write('y'.repeat(9*1024*1024)+'END');process.exitCode=3\""], root, "x", 60);
    assert.equal(f.ok, false);
    assert.equal(f.exit_code, 3);
    assert.match(f.output_tail, /END$/, "the end of the output, where the failure is");
    assert.ok(f.output_tail.length <= 2048);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a format command runs in the same way: its time limit stops its whole group", async () => {
  const { applyContent } = await import(join(DIST, "apply.js"));
  const root = tmpRoot();
  let pid = null;
  try {
    const t0 = Date.now();
    await applyContent(root, "src/f.ts", "a\n", { packetId: "tp_f", format: ["sleep 30 & echo $! > fmt.pid; wait"], timeoutSec: 1 });
    assert.ok(Date.now() - t0 < 10_000);
    pid = Number(readFileSync(join(root, "fmt.pid"), "utf8").trim());
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(alive(pid), false);
    assert.equal(existsSync(join(root, "src", "f.ts")), true);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

