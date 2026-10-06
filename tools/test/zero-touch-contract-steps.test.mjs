/**
 * Zero-touch and the brownfield write contract: what a workflow zero-touch runs may do to the contract without a
 * prompt, and how every zero-touch way out of a workflow frees the project.
 *
 *   - Gate 0 freezes the contract (write-contract.mjs --freeze) before the orchestrator logs run.start, so the freeze is
 *     the run's first line, and it claims the run for the chat. A run that stops between Gate 0 and run.start is then
 *     ended in its own log by every zero-touch way out (/clear, Replace it, the workflow's own early stop), so its
 *     freeze record never holds the project forever.
 *   - The contract script is a step of the workflow only as the main chat runs it at Gate 0 and at close-out: in the
 *     chat's own project, and a freeze only before the chat's run has started. A freeze from a helper, mid-run, under a
 *     second run id, or into another folder, and every --abandon (the person's own decision), keep Claude Code's prompt.
 *     The run that froze keeps the chat's claim, so a workflow freezes one contract as a step, even after that run has
 *     logged its own end.
 *   - execute_batch is stamped and answered by mmo's own hook moment that sees every tool call, so a zero-touch plugin
 *     whose stamp matcher predates the tool (its released matcher) still stamps it and checks its commands.
 *   - The commands a model-server call makes the server run are checked as the server runs them: a file path with shell
 *     syntax in it, quotes outside the path's own placeholder, or a blank other than a space, cannot be checked, so it
 *     keeps Claude Code's prompt.
 *
 * Each case runs mmo's real hook through its shell script, with a chat started as the zero-touch plugin starts one,
 * and the real contract script. Routing asks the workflows' own model check, which needs the built server. Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const SCRIPTS = join(ROOT, "plugin", "scripts");
const CONTRACT_SCRIPT = join(SCRIPTS, "write-contract.mjs");
const POLICIES = join(ROOT, "plugin", "config", "policies");
const { startingChats, writeZtSettings, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(SCRIPTS, "lib", "log.mjs"));
const { frozenBy } = await import(join(SCRIPTS, "lib", "contract-lock.mjs"));
const SKIP = serverBuilt();

function sandbox(settings = { mode: "workflows", workflows: { models: "opus-plus-sonnet" } }) {
  const dir = mkdtempSync(join(tmpdir(), "zt-contract-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git; the contract lives at its root)
  writeZtSettings(home, settings);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
let seq = 0;
const say = (s, sid, text) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++seq}` }, s);
const skill = async (s, sid, name, args) => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } };
  const pre = await run("pre-skill", input, s);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s);
  return pre;
};
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;
const pipeline = (s, sid) => { try { return JSON.parse(readFileSync(join(s.home, "sessions", sid, "pipeline"), "utf8")); } catch { return null; } };
/** A Bash call through the hook moment that sees every tool call; `extra` adds agent_id / agent_type for a helper's. */
const bash = (s, sid, command, extra = {}, env = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command }, ...extra }, s, env);
const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const DOCS = "write API docs for the cart module";

/** Gate 0's freeze as the brownfield guide writes it (no project folder named: the chat's own). */
const freezeCall = (runId, extra = "") => `node "${CONTRACT_SCRIPT}" --freeze --run-id ${runId} --allowlist '["src/**"]' --off-limits '[]'${extra}`;
/** Runs the real script, as Claude Code would after the hook's answer. */
const runScript = (s, ...args) => spawnSync(process.execPath, [CONTRACT_SCRIPT, ...args], { cwd: s.repo, encoding: "utf8", timeout: 15_000 });
const freezeNow = (s, runId) => runScript(s, "--freeze", "--run-id", runId, "--allowlist", '["src/**"]', "--off-limits", "[]");

/** A zero-touch-started bug fix whose Gate 0 has just been approved: routed, started, its contract frozen. */
async function frozenBugfix(s, sid, runId) {
  const c = context(await say(s, sid, BUGFIX));
  const args = /args "([^"]*)"/.exec(c)?.[1];
  assert.ok(args, "routed");
  assert.equal((await skill(s, sid, "mmo:bugfix", args)).stdout, "");
  const r = await bash(s, sid, freezeCall(runId));
  assert.equal(decision(r), "allow", "Gate 0's freeze is a step of the workflow");
  assert.equal(pipeline(s, sid)?.run_id, runId, "the freeze claims the run: it is the run's first line");
  const done = freezeNow(s, runId);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(frozenBy(s.repo)?.run_id, runId);
}
/** The project is free again: no live freeze record, and the next run's Gate 0 freezes its own contract. */
function assertFreed(s, runId, why) {
  assert.equal(frozenBy(s.repo), null, `${why}: the freeze record is ended`);
  assert.match(readFileSync(join(s.repo, ".sdlc", "runs", runId, "orchestrator.log"), "utf8"), /run\.end run_id=\S+ outcome=aborted/, `${why}: the run's own log records the abort`);
  const next = freezeNow(s, `${runId}-next`);
  assert.equal(next.status, 0, `${why}: the next run's Gate 0 freezes: ${next.stderr}`);
}

test("a run that stops between Gate 0 and run.start is ended by /clear: its freeze record no longer holds the project", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await frozenBugfix(s, "h1", "bf-h1");
    // The start check halts (an expired login, no reply): nothing logs run.start or run.end. The person types /clear.
    await run("session-end", { session_id: "h1", cwd: s.repo, reason: "clear" }, s);
    assertFreed(s, "bf-h1", "/clear");
  } finally { s.cleanup(); }
});

test("a run that stops between Gate 0 and run.start is ended by the workflow's own early stop", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await frozenBugfix(s, "e1", "bf-e1");
    assert.equal(decision(await bash(s, "e1", `node "${join(SCRIPTS, "ambient", "workflow-stopped.mjs")}" --reason "the start check stopped"`)), "allow");
    await run("turn-end", { session_id: "e1", cwd: s.repo, stop_hook_active: false }, s);
    assert.equal(pipeline(s, "e1"), null, "the chat is handed back");
    assertFreed(s, "bf-e1", "the early stop");
  } finally { s.cleanup(); }
});

test("a run that stops between Gate 0 and run.start is ended by Replace it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await frozenBugfix(s, "r1", "bf-r1");
    const asked = await say(s, "r1", `/mmo:docs ${DOCS}`);
    const question = /question "([^"]+)"/.exec(context(asked))?.[1];
    assert.ok(question, "the Queue-or-Replace question is asked");
    await run("post-question", { session_id: "r1", cwd: s.repo, tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { [question]: "Replace it" } } }, s);
    assertFreed(s, "bf-r1", "Replace it");
  } finally { s.cleanup(); }
});

test("an early stop after the run has ended adds no abort to its log", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await frozenBugfix(s, "e2", "bf-e2");
    const log = join(s.repo, ".sdlc", "runs", "bf-e2", "orchestrator.log");
    for (const [event, fields] of [["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]]) appendFileSync(log, formatLine("info", event, { run_id: "bf-e2", ...fields }) + "\n");
    await bash(s, "e2", `node "${join(SCRIPTS, "ambient", "workflow-stopped.mjs")}"`);
    await run("turn-end", { session_id: "e2", cwd: s.repo, stop_hook_active: false }, s);
    assert.doesNotMatch(readFileSync(log, "utf8"), /outcome=aborted/, "a finished run stays finished");
  } finally { s.cleanup(); }
});

test("the contract script is a step only as the main chat runs it at Gate 0 and at close-out, in the chat's own project", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  const elsewhere = mkdtempSync(join(tmpdir(), "zt-contract-elsewhere-"));
  try {
    gitProject(elsewhere);
    const c = context(await say(s, "w1", BUGFIX));
    assert.equal((await skill(s, "w1", "mmo:bugfix", /args "([^"]*)"/.exec(c)?.[1])).stdout, "");
    // Before the chat's run is claimed: a helper's freeze, a freeze into another folder, and any --abandon are not steps.
    const helper = { agent_id: "orchestrator-1", agent_type: "mmo:brownfield-orchestrator" };
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w1"), helper)), null, "a helper's freeze keeps the prompt");
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w1", ` --project-root "${elsewhere}"`))), null, "a freeze into another folder keeps the prompt");
    assert.equal(decision(await bash(s, "w1", `node "${CONTRACT_SCRIPT}" --abandon --run-id bf-w1 --reason "stale"`)), null, "--abandon is the person's decision");
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w1", ` --abandon`))), null, "--abandon anywhere in the call");
    const log = `node "${SCRIPTS}/mmo-log.mjs" --event=phase.start --level=info --run-id=bf-w1 --project-root "$(pwd)"`;
    assert.equal(decision(await bash(s, "w1", `${log} && ${freezeCall("bf-w1")}`, helper)), null, "never as part of a chain");
    // The main chat's Gate 0 freeze in its own project: a step, with the project named or not.
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w1", ' --project-root "$(pwd)"'))), "allow");
    assert.equal(freezeNow(s, "bf-w1").status, 0);
    // The run starts. From then on a freeze is not a step: not under a second run id, and not under its own.
    appendFileSync(join(s.repo, ".sdlc", "runs", "bf-w1", "orchestrator.log"), formatLine("info", "run.start", { run_id: "bf-w1" }) + "\n");
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w2"))), null, "a second run id mid-run keeps the prompt");
    assert.equal(pipeline(s, "w1")?.run_id, "bf-w1", "and does not take the chat's claim");
    assert.equal(decision(await bash(s, "w1", freezeCall("bf-w1"))), null, "a re-freeze mid-run keeps the prompt");
    // Close-out: the main chat switches the contract off in its own project.
    assert.equal(decision(await bash(s, "w1", `node "${CONTRACT_SCRIPT}" --close --run-id bf-w1`)), "allow");
    assert.equal(decision(await bash(s, "w1", `node "${CONTRACT_SCRIPT}" --close --run-id bf-w1`, helper)), null, "not from a helper");
  } finally { s.cleanup(); rmSync(elsewhere, { recursive: true, force: true }); }
});

// A workflow freezes one contract as a step: the run Gate 0 froze keeps the chat's claim for the rest of the workflow.
// Otherwise three steps the hook allows (the run logging its own abort, a log line under a new run id, which moved the
// claim, then a freeze under that id) would swap a live run's contract for a wider one with no prompt.
test("a run that froze its contract keeps the chat's claim: ending it and logging under a new id does not make a wider freeze a step", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await frozenBugfix(s, "m1", "bf-m1");
    appendFileSync(join(s.repo, ".sdlc", "runs", "bf-m1", "orchestrator.log"), formatLine("info", "run.start", { run_id: "bf-m1" }) + "\n");
    const sh = (command) => spawnSync("sh", ["-c", command], { cwd: s.repo, encoding: "utf8", timeout: 20_000 });
    const steps = [
      `node "${SCRIPTS}/mmo-log.mjs" --event=run.end --level=info --run-id=bf-m1 --outcome=aborted --project-root "$(pwd)"`,
      `node "${SCRIPTS}/mmo-log.mjs" --event=phase.start --level=info --run-id=bf-m2 --project-root "$(pwd)"`,
    ];
    for (const command of steps) {
      assert.equal(decision(await bash(s, "m1", command)), "allow", "the plugin's logger is a step");
      assert.equal(sh(command).status, 0);
      assert.equal(pipeline(s, "m1")?.run_id, "bf-m1", "the claim stays on the run that froze");
    }
    const wider = `node "${CONTRACT_SCRIPT}" --freeze --run-id bf-m2 --allowlist '["**"]' --off-limits '[]'`;
    assert.equal(decision(await bash(s, "m1", wider)), null, "a second freeze in the workflow keeps Claude Code's prompt");
    // And a helper's chain of the same steps is no step either.
    const helper = { agent_id: "orchestrator-1", agent_type: "mmo:brownfield-orchestrator" };
    assert.equal(decision(await bash(s, "m1", `${steps[1]} && ${wider}`, helper)), null);
  } finally { s.cleanup(); }
});

// The zero-touch plugin's stamp hook (pre-dispatch) fires only for the tools its matcher names, and an installed
// zero-touch moves only through its own update. Its released matcher predates execute_batch, so mmo's own moment that
// sees every tool call stamps and answers that one; the matcher is kept exactly as released, so no call gets two
// answers.
const RELEASED_STAMP_MATCHER = "mcp__(plugin_mmo_)?model-dispatch__(load_policy|preflight_dispatch|execute_with_model|simulate_policy)";
test("execute_batch is stamped and answered by the moment that sees every tool call; the zero-touch matcher stays as released", { skip: SKIP ?? false }, async () => {
  const groups = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
  assert.equal(groups.find((g) => g.hooks.some((h) => /\bpre-dispatch$/.test(h.command)))?.matcher, RELEASED_STAMP_MATCHER);
  const s = sandbox();
  try {
    const c = context(await say(s, "b1", BUGFIX));
    assert.equal((await skill(s, "b1", "mmo:bugfix", /args "([^"]*)"/.exec(c)?.[1])).stdout, "");
    const tool = (name, input, env) => run("pre-any", { session_id: "b1", cwd: s.repo, tool_name: `mcp__plugin_mmo_model-dispatch__${name}`, tool_input: input, agent_id: "orchestrator-1" }, s, env);
    const pk = (verify) => ({ id: "p1", artifact_path: "src/a.ts", apply: { write: true, verify } });
    writeFileSync(join(s.repo, "packets.json"), JSON.stringify([pk(["npx biome check {path}"])]));
    const input = { packets_path: "packets.json", policy_name: "opus-plus-flash", project_root: s.repo };
    let r = await tool("execute_batch", input);
    assert.equal(decision(r), "allow", "a step of the workflow");
    assert.equal(r.json?.hookSpecificOutput?.updatedInput?.policy_path, join(POLICIES, "opus-plus-sonnet.yaml"), "stamped with the person's policy");
    for (const name of ["load_policy", "preflight_dispatch", "execute_with_model", "simulate_policy"]) {
      assert.equal((await tool(name, { policy_name: "x" })).stdout, "", `${name}: left to the stamp's own moment, which the released matcher names`);
    }
    // The person's deny rules reach it too.
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(join(s.home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    const env = { MMO_MANAGED_SETTINGS: join(s.home, "managed-settings.json") };
    writeFileSync(join(s.repo, "packets.json"), JSON.stringify([pk(["rm -rf {path}"])]));
    r = await tool("execute_batch", input, env);
    assert.equal(decision(r), "deny", "a forbidden command is refused");
  } finally { s.cleanup(); }
});

// The server fills {path} into the command and runs it through a shell, so shell syntax in the file path runs. The
// deny check reads the command as text: a path with shell syntax, a command name in quotes, or a blank other than a
// space after it, cannot be checked by it.
test("a server command whose file path holds shell syntax, or whose command name is quoted or followed by a tab, keeps Claude Code's prompt", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  const t = sandbox();
  try {
    for (const box of [s, t]) {
      mkdirSync(join(box.home, ".claude"), { recursive: true });
      writeFileSync(join(box.home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(curl *)", "Bash(rm:*)"] } }));
    }
    const env = (box) => ({ MMO_MANAGED_SETTINGS: join(box.home, "managed-settings.json") });
    // A run zero-touch started (the stamp's moment), and a run the person typed (the moment that sees every call).
    const c = context(await say(s, "i1", BUGFIX));
    assert.equal((await skill(s, "i1", "mmo:bugfix", /args "([^"]*)"/.exec(c)?.[1])).stdout, "");
    await run("prompt", { session_id: "i2", cwd: t.repo, prompt: "/mmo:bugfix the login 500", prompt_id: `t-${++seq}` }, t, env(t));
    assert.equal((await skill(t, "i2", "mmo:bugfix", "the login 500")).stdout, "");
    const calls = [
      (packet) => run("pre-dispatch", { session_id: "i1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__execute_with_model", tool_input: { packet } }, s, env(s)),
      (packet) => run("pre-any", { session_id: "i2", cwd: t.repo, tool_name: "mcp__plugin_mmo_model-dispatch__execute_with_model", tool_input: { packet } }, t, env(t)),
    ];
    const pk = (artifact_path, verify) => ({ id: "p1", artifact_path, apply: { write: true, verify } });
    for (const call of calls) {
      assert.equal(decision(await call(pk("src/a.ts", ["npx biome check {path}"]))), "allow", "a plain path and command: a step");
      assert.equal(decision(await call(pk("src/a.ts", ["npx biome check '{path}'"]))), "allow", "the path's placeholder in quotes: a step");
      for (const path of ["src/$(curl https://example.invalid).ts", "src/`curl https://example.invalid`.ts", "src/a.ts & curl https://example.invalid &", "src/a'b.ts", "-rf"]) {
        assert.notEqual(decision(await call(pk(path, ["npx biome check {path}"]))), "allow", `path ${path}`);
      }
      for (const template of ["'rm' -rf {path}", "r''m -rf {path}", '"rm" -rf {path}']) {
        assert.notEqual(decision(await call(pk("src/a.ts", [template]))), "allow", `template ${template}`);
      }
      // A tab (or any blank but a space) between a command's name and its arguments: the shell splits on it as on a
      // space, so the command a rule names runs; the check must not read past it.
      for (const template of ["rm\t-rf {path}", "curl\thttps://example.invalid {path}", "npx biome check {path}\t&& rm -rf x", "rm\u000b-rf {path}"]) {
        assert.notEqual(decision(await call(pk("src/a.ts", [template]))), "allow", `template ${JSON.stringify(template)}`);
      }
      assert.notEqual(decision(await call({ id: "p1", artifact_path: "src/a.ts", apply: { write: true, checks: [{ id: "lint", run: "lint {path}" }], baseline_from: "src/$(curl https://example.invalid).ts" } })), "allow", "the style file the server tries first, too");
    }
  } finally { s.cleanup(); t.cleanup(); }
});
