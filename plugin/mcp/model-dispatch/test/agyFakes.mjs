/**
 * A stand-in for the Antigravity worker's Python interpreter (GEMINI_WORKER_PYTHON) for the engine's tests: no SDK,
 * no Google, $0. Not a test file itself.
 *
 * The engine runs `<python> <worker.py> <flags...>`; this stand-in is a small Node program in that place. Each run
 * follows the next entry of a plan: it prints heartbeat lines on stderr at the given times, then writes the receipt
 * (the typist's --out) or the usage sidecar (the agent's --usage-file) and its stdout, and exits; or it hangs until
 * it is killed. A SIGTERM is logged and either ignored or answered with a receipt, as the plan says. Asked for the
 * installed google-antigravity version (an `importlib.metadata` one-liner), it prints the plan's version. Every run
 * is logged with its arguments, process id and process group, so a test can read the flags the engine passed and
 * whether the process is still alive.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROGRAM = String.raw`
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const dir = __FAKE_DIR_DEFAULT;
const cfg = JSON.parse(readFileSync(dir + "/plan.json", "utf8"));
const args = process.argv.slice(2);
const log = (ev, extra = {}) => appendFileSync(dir + "/calls.jsonl", JSON.stringify({ ev, pid: process.pid, t: Date.now(), ...extra }) + "\n");
const code = args[args.indexOf("-c") + 1] || "";
if (args.includes("-c") && /importlib|metadata|version/.test(code) && !/^import google\.antigravity$/.test(code.trim())) {
  log("version", { args });
  if (cfg.version === null) { process.stderr.write("PackageNotFoundError: No package metadata was found for google-antigravity\n"); process.exit(1); }
  process.stdout.write(String(cfg.version ?? "0.1.22") + "\n");
  process.exit(0);
}
if (args.includes("-c")) { log("import", { args }); process.exit(0); }
const counter = dir + "/count";
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(n));
const plan = cfg.runs[Math.min(n, cfg.runs.length) - 1] || {};
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// A thinking run's tools config as the run found it (the server rewrites it between dispatches).
const toolsConfig = flag("--tools-config") && existsSync(flag("--tools-config")) ? JSON.parse(readFileSync(flag("--tools-config"), "utf8")) : undefined;
log("start", { n, args, toolsConfig });
const outPath = flag("--out") || flag("--usage-file");
// Files the worker writes while it runs, before it exits or hangs: a thinking worker keeps its summary after every status.
for (const w of plan.writes || []) setTimeout(() => {
  if (w.sidecar !== undefined && outPath) writeFileSync(outPath, JSON.stringify(w.sidecar));
  if (w.summary !== undefined && flag("--summary-file")) writeFileSync(flag("--summary-file"), JSON.stringify(w.summary));
}, w.atMs || 0);
const finish = (which) => {
  const body = which === "term" ? plan.onTerm : plan;
  // A thinking run that changes project files (touchProject: paths relative to the tools config's project_root).
  if (body && Array.isArray(body.touchProject) && flag("--tools-config")) {
    const root = JSON.parse(readFileSync(flag("--tools-config"), "utf8")).project_root;
    for (const f of body.touchProject) writeFileSync(root + "/" + f, "changed by the run\n");
  }
  if (body && body.receipt !== undefined && outPath && body.receipt !== null) writeFileSync(outPath, JSON.stringify(body.receipt));
  if (body && body.sidecar !== undefined && outPath && body.sidecar !== null) writeFileSync(outPath, JSON.stringify(body.sidecar));
  if (body && body.summary !== undefined && body.summary !== null && flag("--summary-file")) writeFileSync(flag("--summary-file"), JSON.stringify(body.summary));
  if (body && body.stdout) process.stdout.write(body.stdout);
  if (body && body.stderr) process.stderr.write(body.stderr);
  log("exit", { which, code: body && body.exitCode !== undefined ? body.exitCode : 0 });
  process.exit(body && body.exitCode !== undefined ? body.exitCode : (which === "term" ? 143 : 0));
};
process.on("SIGTERM", () => {
  log("term");
  if (plan.ignoreTerm) return;
  if (plan.onTerm) return finish("term");
  process.exit(143);
});
for (const b of plan.beats || []) setTimeout(() => process.stderr.write("@mmo-heartbeat " + JSON.stringify(b.hb) + "\n"), b.atMs);
if (plan.holdMs === "forever") setInterval(() => {}, 1 << 30);
else setTimeout(() => finish("done"), plan.holdMs || 0);
`;

/**
 * Makes the stand-in. `runs[i]` is the i-th run's plan: {beats: [{atMs, hb}], holdMs (number or "forever"),
 * receipt, sidecar, summary (a thinking worker's --summary-file), touchProject (project files a thinking run changes),
 * writes: [{atMs, sidecar?, summary?}] (files written while it runs, as a thinking worker keeps its summary after every
 * status), stdout, stderr, exitCode, ignoreTerm,
 * onTerm: {receipt|sidecar, exitCode}}; the last plan
 * repeats. `version` is what the version query prints (null: the SDK is not installed). A thinking run's start is
 * logged with the tools config it found.
 */
export function fakeWorkerPython({ runs = [{}], version = "0.1.22" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agy-fake-python-"));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ runs, version }));
  // A .cjs program, started by exec so the process the engine signals is the program itself.
  writeFileSync(join(dir, "fake.cjs"), PROGRAM.replace("__FAKE_DIR_DEFAULT", JSON.stringify(dir)));
  const python = join(dir, "python");
  writeFileSync(python, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "fake.cjs"))} "$@"\n`);
  chmodSync(python, 0o755);
  return {
    python,
    dir,
    /** Every logged event of every run: start (with its args), term, exit, version, import. */
    events: () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    /** The worker runs (not the version or import queries), each with its argument list. */
    runs: function () { return this.events().filter((e) => e.ev === "start"); },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The value after `name` in an argument list, or undefined. */
export const flagValue = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** Whether a process id is alive (signal 0 probes without signalling). */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Whether any process is left in a process group (a worker leads its own). */
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Runs `fn` with the given process environment variables set, then puts every one back. */
export async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A heartbeat line's body, in the worker contract's shape (version 1). */
export const beat = (over = {}) => ({ v: 1, state: "wait", work_s: 1, wait_s: 0, call_wait_s: 1, slept_s: 0, try: 1, location: "global", usage: {}, ...over });
