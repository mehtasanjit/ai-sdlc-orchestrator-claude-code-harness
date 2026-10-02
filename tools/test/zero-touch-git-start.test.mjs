/**
 * Git and the workflows zero-touch starts.
 *
 * Why: every change workflow (bug fix, feature, refactor, tests, docs, library upgrade) refuses a folder git does not
 * track: its rollback points are git commits. A new app left without git would make the very next request, "fix this
 * bug in the app", start a workflow that stops with a git command for the person to type and holds the chat. So:
 *   - a change job in a project without git does not start; the person is told in plain words, and Claude can save
 *     the project with git when they ask (plugin/scripts/ambient/git-baseline.mjs, zero-touch's own script);
 *   - a new-app run zero-touch started ends by saving the new app with git: zero-touch's end-of-turn hook does it in
 *     code, and mmo's own command text is untouched (a typed run is left as mmo leaves it without zero-touch);
 *   - the script never writes a file of the person's (what must never be committed goes in git's own exclude list),
 *     never commits node_modules or a secret, and never runs git where there is none (no macOS install dialog).
 *
 * Offline: temporary folders and the computer's own git (the cases that need it are skipped without one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT = join(ROOT, "..", "plugin", "scripts", "ambient", "git-baseline.mjs");
const G = await import(SCRIPT);
const RF = await import(join(ROOT, "..", "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
const { forgetGitCheck } = await import(join(ROOT, "..", "plugin", "scripts", "lib", "git.mjs"));
const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const NO_GIT = HAS_GIT ? false : "no git on this computer";

/** git with no name or email of the person's and no system or global settings: the stand-in must be used. */
function bareGitEnv(home) {
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "no-gitconfig"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
}
const tracked = (dir, env) => spawnSync("git", ["ls-files"], { cwd: dir, env, encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();

test("a new app is saved with git: one commit of its files, never dependencies or secrets, and no file of the person's written", { skip: NO_GIT }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-git-"));
  try {
    const app = join(dir, "app");
    for (const f of ["src/index.js", "node_modules/left-pad/index.js", ".env", ".env.example", ".sdlc/local/write-contract.json", ".sdlc/runs/r1/manifest.json", "debug.log", "README.md"]) {
      mkdirSync(join(app, f, ".."), { recursive: true });
      writeFileSync(join(app, f), "x\n");
    }
    const before = readdirSync(app).sort();
    const env = bareGitEnv(dir);
    const r = G.baseline(app, { env });
    assert.deepEqual([r.code, r.line], [0, G.SAID.saved], r.detail);
    assert.deepEqual(tracked(app, env), [".env.example", ".sdlc/runs/r1/manifest.json", "README.md", "src/index.js"], "the app's own files only");
    assert.deepEqual(readdirSync(app).sort(), [...before, ".git"].sort(), "nothing of the person's written: only the .git folder is new");
    assert.match(readFileSync(join(app, ".git", "info", "exclude"), "utf8"), /node_modules\/\n\.env\n/);
    const log = spawnSync("git", ["log", "--format=%an|%s"], { cwd: app, env, encoding: "utf8" }).stdout.trim();
    assert.equal(log, "Zero-touch|Starting point, before any changes", "no identity set: a stand-in for this one commit");
    assert.equal(spawnSync("git", ["config", "user.name"], { cwd: app, env }).status, 1, "and nothing is configured");
    assert.deepEqual(G.baseline(app, { env }), { code: 0, line: G.SAID.already }, "twice: already saved, nothing changes");
    mkdirSync(join(app, "packages", "web"), { recursive: true });
    assert.deepEqual(G.baseline(join(app, "packages", "web"), { env }), { code: 0, line: G.SAID.already }, "a folder inside a git project is saved already");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no git on this computer: says so, changes nothing, never runs the macOS stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-git-"));
  try {
    const app = join(dir, "app");
    mkdirSync(app);
    forgetGitCheck();
    const r = G.baseline(app, { env: { PATH: join(dir, "empty-bin") } });
    assert.deepEqual([r.code, r.line], [3, G.SAID.noGit]);
    assert.ok(!existsSync(join(app, ".git")));
    // Run as a script: one plain line, the exit code.
    const cli = spawnSync(process.execPath, [SCRIPT, "--dir", app], { env: { PATH: join(dir, "empty-bin") }, encoding: "utf8" });
    assert.equal(cli.status, 3);
    assert.equal(cli.stdout.trim(), G.SAID.noGit);
  } finally { forgetGitCheck(); rmSync(dir, { recursive: true, force: true }); }
});

test("a change job in a project without git does not start, and says so in plain words; a new app needs no git", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-git-"));
  try {
    const project = join(dir, "shop");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), '{"name":"shop"}\n');
    forgetGitCheck();
    // vendor: the start check stops before the run-start model check, which is not what is tested here
    const ask = (job, env = process.env) => RF.startProblem({ projectDir: project, policy: "opus-only-v5", auth: "vendor", job, env }).problem;
    if (HAS_GIT) assert.deepEqual(ask("bugfix"), { cause: "no-git", projectDir: project });
    for (const job of ["docs", "feature-extend", "feature-new", "refactor", "test", "deps"]) assert.ok(["no-git", "git-missing"].includes(ask(job)?.cause), job);
    assert.equal(ask("greenfield"), null, "a new app needs no git");
    forgetGitCheck();
    assert.deepEqual(ask("bugfix", { PATH: join(dir, "empty-bin") }), { cause: "git-missing", projectDir: project });
    forgetGitCheck();
    mkdirSync(join(project, ".git"));
    assert.equal(ask("bugfix"), null, "a git project starts");
    const line = RF.PERSON_LINE.notStarted({ cause: "no-git", projectDir: project }, "bugfix");
    assert.equal(line, `Zero-touch: the bug-fix workflow didn't start, because this project isn't saved with git yet, and the workflow needs git so every change it makes can be undone. Ask Claude to "save this project with git", then ask again.`);
    const note = RF.cannotStartInstruction("bugfix", { cause: "no-git", projectDir: project });
    assert.ok(note.includes(`node "${RF.GIT_BASELINE}" --dir "${project}"`), "Claude is given the one exact command");
    assert.match(note, /ask whether they want you to save the project with git now, and wait for their answer/);
    assert.match(note, /Do not do the job yourself now and do not start the workflow yourself/);
  } finally { forgetGitCheck(); rmSync(dir, { recursive: true, force: true }); }
});

// ─── The end of a new-app workflow, through mmo's real hook ─────────────────────────────────────────────────────
const SHIM = join(ROOT, "..", "plugin", "hooks", "ambient.sh");
const { startingChats } = await import(join(ROOT, "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "..", "plugin", "scripts", "lib", "log.mjs"));
const SKIP = serverBuilt() ?? NO_GIT;
function runOnce(event, payload, { home, repo }) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "no-gitconfig") }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => { let json = null; try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ } done({ stdout, json }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const hook = startingChats(runOnce, (s) => s.home);
/** A new-app workflow in an empty folder, as far as its end: the app's files written, its log closed as `outcome`. */
async function newAppRun(s, sid, { typed = false, outcome = "completed" } = {}) {
  if (typed) await hook("prompt", { session_id: sid, cwd: s.repo, prompt: "/mmo:greenfield", prompt_id: `t-${sid}` }, s);
  else await hook("prompt", { session_id: sid, cwd: s.repo, prompt: "build me a todo app with a React frontend", prompt_id: `p-${sid}` }, s);
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:greenfield", args: typed ? "" : "[zero-touch policy=opus-plus-flash-v38 auth=estimated]" } };
  await hook("pre-skill", input, s);
  await hook("post-skill", { ...input, tool_use_id: `tu-${sid}` }, s);
  await hook("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", agent_id: "orchestrator-1", tool_input: { command: `node "/plugin/scripts/mmo-log.mjs" --event=run.start --level=info --run-id=gf-${sid} --project-root "${s.repo}"` } }, s);
  for (const f of ["src/index.js", "node_modules/react/index.js", "brief.md"]) {
    mkdirSync(join(s.repo, f, ".."), { recursive: true });
    writeFileSync(join(s.repo, f), "x\n");
  }
  const dir = join(s.repo, ".sdlc", "runs", `gf-${sid}`);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of [["run.start", { mode: "greenfield" }], ["run.end", { outcome }], ...(outcome === "completed" ? [["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]] : [])]) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: `gf-${sid}`, ...fields }) + "\n");
  return hook("turn-end", { session_id: sid, cwd: s.repo, stop_hook_active: false }, s);
}
function emptyFolder() {
  const dir = mkdtempSync(join(tmpdir(), "zt-git-end-"));
  const home = join(dir, "home");
  const repo = join(dir, "app");
  mkdirSync(home);
  mkdirSync(repo);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a new-app workflow zero-touch started ends by saving the app with git, in code; a typed run is left as it was", { skip: SKIP ?? false }, async () => {
  const s = emptyFolder();
  try {
    const end = await newAppRun(s, "g1");
    assert.equal(end.json?.systemMessage, `${RF.PERSON_LINE.ended("greenfield", "on", "completed")} ${RF.SAVED_WITH_GIT.saved}`);
    const env = bareGitEnv(s.home);
    assert.deepEqual(tracked(s.repo, env).filter((f) => !f.startsWith(".sdlc/")), ["brief.md", "src/index.js"], "the app's own files, never its dependencies");
    assert.ok(existsSync(join(s.repo, ".git")));
  } finally { s.cleanup(); }
  const typed = emptyFolder();
  try {
    const end = await newAppRun(typed, "g2", { typed: true });
    assert.equal(end.json?.systemMessage, RF.PERSON_LINE.ended("greenfield", "on", "completed"), "the end line alone");
    assert.ok(!existsSync(join(typed.repo, ".git")), "a run the person typed is left exactly as mmo leaves it without zero-touch");
  } finally { typed.cleanup(); }
  const failed = emptyFolder();
  try {
    await newAppRun(failed, "g3", { outcome: "failed" });
    assert.ok(!existsSync(join(failed.repo, ".git")), "only a finished app is saved");
  } finally { failed.cleanup(); }
});

test("a chat whose chosen models this version of mmo does not ship: no workflow on other models, a plain reason", () => {
  // The chat's record names a policy this mmo lacks: the standard one never runs in its place.
  const dir = mkdtempSync(join(tmpdir(), "zt-policy-missing-"));
  try {
    const project = join(dir, "shop");
    mkdirSync(project);
    const r = RF.startProblem({ projectDir: project, policy: "opus-plus-tomorrow", auth: "vendor", job: "greenfield" });
    assert.deepEqual(r.problem, { cause: "policy-missing" });
    assert.match(RF.PERSON_LINE.notStarted(r.problem, "greenfield"), /the models you chose aren't available in this version of zero-touch/);
    const home = join(dir, "home");
    mkdirSync(join(home, "sessions", "c1"), { recursive: true });
    writeFileSync(join(home, "sessions", "c1", "workflow.json"), JSON.stringify({ policy: "opus-plus-tomorrow" }));
    assert.equal(RF.chatPolicy("c1", { MMO_HOME: home }), "opus-plus-tomorrow", "kept as chosen, never swapped");
    writeFileSync(join(home, "sessions", "c1", "workflow.json"), JSON.stringify({ policy: "../../etc" }));
    assert.equal(RF.chatPolicy("c1", { MMO_HOME: home }), RF.STANDARD_POLICY, "a name that is not a policy name: the standard pick");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
