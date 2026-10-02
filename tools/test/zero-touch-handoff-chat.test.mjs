/**
 * Zero-touch hand-off mode, inside the chat: what each message a person types does, and what keeps the chat on its
 * model.
 *
 * In a hand-off chat (mode `b`, zero-touch/scripts/start-chat.mjs):
 *   - plain words never start a workflow. "Fix the login bug" or "build me a todo app" is the chat's own work. A
 *     workflow starts only when the person types its command, and then runs exactly as in any chat;
 *   - a message asking for a new document, spec, plan, tests or the same change across files is recognised by fixed
 *     rules (lib/handoff-route.mjs), and the chat's model is reminded to hand that work off;
 *   - the person sees one line after every message (the hook's `systemMessage`, never given to the model): where the
 *     work goes. The line names the models that really do it: the hand-off policy's model for that kind of work,
 *     asked of the workflows' own router once per chat, and the model the chat is on now;
 *   - the chat stays on its pinned model: a switch to another model is refused (Claude Code's PreModelSwitch hook),
 *     and while the chat is on another model anyway, every line says so and how to switch back.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings, zeroTouchStart, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
// Naming the hand-off policy's models asks the workflows' own router, which needs the built server.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

/**
 * A person who chose Hand-off ("b") or Workflows ("a") in the settings box. `typist` is who types all three kinds of
 * hand-off work ("flash", "sonnet" or "chat"); the chat model is Opus 5.
 */
function sandbox({ mode = "b", kind = "existing", typist = "flash" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-chat-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") gitProject(repo), writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeZtSettings(home, { mode: mode === "a" ? "workflows" : "handoff", handoff: { chat_model: "claude-opus-5", documents: typist, tests: typist, repeats: typist } });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const NOT_HANDED = "this isn't the kind of work zero-touch hands off (new documents, specs, plans, tests, or one change repeated in many files)";
const DOC = (typist, n = "document") => `Opus 5 will collect the facts and give ${typist} instructions to write the new ${n}. It's checked automatically before it's added to your project.`;
const TESTS = (typist) => `Opus 5 will decide what to test, and ${typist} will write the tests. They're run in a test copy of your project first, and only added if the result is the expected one.`;
const REPEAT = (typist) => `Opus 5 will make the change in one file, and ${typist} will repeat it in the others. If your project has an automatic check (such as its tests), it's run on a test copy first, and nothing is changed unless it passes.`;

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
const say = (s, sid, text, extra = {}, env) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++seq}`, ...extra }, s, env);
/** A Skill call as Claude Code makes it: PreToolUse, then, when the call was not refused, PostToolUse (the moment a
 * routed workflow's start is recorded). Returns the PreToolUse answer. */
const skill = async (s, sid, name, args, ...rest) => {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } };
  const pre = await run("pre-skill", input, s, ...rest);
  if (pre.json?.hookSpecificOutput?.permissionDecision !== "deny") await run("post-skill", { ...input, tool_use_id: `tu-${sid}-${name}` }, s, ...rest);
  return pre;
};
const line = (r) => r.json?.systemMessage ?? null;
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const denied = (r) => (r.json?.hookSpecificOutput?.permissionDecision === "deny" ? r.json.hookSpecificOutput.permissionDecisionReason : null);
/** A chat that starts on a known model: Claude Code names it at the start moment. */
const startOn = (s, sid, model) => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", model }, s);
const switchTo = (s, sid, to, event = "pre-model-switch") => run(event, { session_id: sid, cwd: s.repo, from_model: "claude-opus-5", to_model: to, requested_model: to }, s);

const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const NEW_APP = "build me a todo app with a React frontend and a Node backend";
const QUESTION = "what does the cart module do?";
const README = "write a README for this project";

test("plain words start no workflow: a bug fix or a new app is the chat's own work, and nothing waits or is blocked", async () => {
  for (const [kind, text] of [["existing", BUGFIX], ["new", NEW_APP], ["existing", QUESTION]]) {
    const s = sandbox({ kind });
    try {
      await startOn(s, "w1", "claude-opus-5");
      const r = await say(s, "w1", text);
      // Quiet by default: a message that is no hand-off work gets nothing, for the person or the model.
      assert.equal(r.stdout, "", text);
      assert.ok(!existsSync(join(s.home, "sessions", "w1", "route.json")), "no workflow is waiting for its start");
      const write = await run("pre-any", { session_id: "w1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s);
      assert.equal(write.stdout, "", "the chat's own tools run untouched");
    } finally { s.cleanup(); }
  }
});

test("a chat whose model is not known says so without naming one", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    assert.match(line(await say(s, "u1", README)) ?? "", /^Zero-touch: the chat's model will collect the facts/, "a model Claude Code has not named is never guessed");
  } finally { s.cleanup(); }
});

test("hand-off work is recognised: the person sees where it goes, and the model is reminded which tool takes it", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "h1", "claude-opus-5");
    const cases = [
      [README, `Zero-touch: ${DOC("Flash 3.8")}`, /write_document/],
      ["draft a design doc for the cache layer", `Zero-touch: ${DOC("Flash 3.8")}`, /write_document/],
      ["draft release notes for v2.3", `Zero-touch: ${DOC("Flash 3.8")}`, /write_document/],
      ["write unit tests for parseCart in src/cart.js", `Zero-touch: ${TESTS("Flash 3.8")}`, /write_tests_from_cases/],
      ["rename getUser to fetchUser everywhere", `Zero-touch: ${REPEAT("Flash 3.8")}`, /repeat_edit_across_files/],
      ["write a README and add tests for the parser", `Zero-touch: ${DOC("Flash 3.8")} ${TESTS("Flash 3.8")}`, /write_document[\s\S]*write_tests_from_cases/],
      ["draft the design doc, then write a migration plan", `Zero-touch: ${DOC("Flash 3.8", "documents")}`, /write_document/],
      ["fix the login bug and write tests for it", `Zero-touch: ${TESTS("Flash 3.8")} Opus 5 does the rest directly.`, /The rest of the message is yours/],
    ];
    for (const [text, expected, reminder] of cases) {
      const r = await say(s, "h1", text);
      assert.equal(line(r), expected, text);
      assert.match(context(r), reminder, `the model is reminded: ${text}`);
      assert.match(context(r), /every field/, "the form is filled in completely");
      assert.doesNotMatch(context(r), /mmo:/, "no workflow is named");
    }
    assert.ok(!existsSync(join(s.home, "sessions", "h1", "route.json")), "no workflow is started for any of them");
  } finally { s.cleanup(); }
});

test("the line names the models that really do the work: each kind's own choice, asked once per chat", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ typist: "sonnet" });
  try {
    await startOn(s, "n1", "claude-opus-5");
    assert.equal(line(await say(s, "n1", README)), `Zero-touch: ${DOC("Sonnet 5")}`);
    const kept = JSON.parse(readFileSync(join(s.home, "sessions", "n1", "handoff_models.json"), "utf8"));
    assert.equal(kept.routes.docs.model, "claude-sonnet-5");
    assert.equal(kept.routes.docs.policy, "opus-plus-sonnet", "each kind carries the shipped policy it is routed by");
    assert.equal(kept.routes.tests.model, "claude-sonnet-5");
    assert.ok(kept.routes.repeat.model, "the repeated change has a model too");
    // The chat keeps what it resolved: a settings change reaches the next new chat only.
    writeZtSettings(s.home, { mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "chat", repeats: "flash" } });
    assert.equal(line(await say(s, "n1", README)), `Zero-touch: ${DOC("Sonnet 5")}`);
    await startOn(s, "n2", "claude-opus-5");
    assert.equal(line(await say(s, "n2", README)), `Zero-touch: ${DOC("Flash 3.8")}`);
    const tests = await say(s, "n2", "write unit tests for parseCart in src/cart.js");
    assert.equal(line(tests), "Zero-touch: new tests are set to stay in this chat (your setting), so Opus 5 writes them directly.", "work kept in the chat is said so");
    assert.match(context(tests), /The person keeps this work in the chat: do it yourself/);
    assert.doesNotMatch(context(tests), /write_tests_from_cases/, "and its tool is not named");
  } finally { s.cleanup(); }
});

test("a hand-off policy that cannot be read: the person is told, and the model is told to do the work itself", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "x1", "claude-opus-5");
    // The box offers shipped policies only; a stamp naming one that no longer exists (a damaged install) is the case.
    const stampFile = join(s.home, "sessions", "x1", "handoff.json");
    const st = JSON.parse(readFileSync(stampFile, "utf8"));
    st.typists.documents.policy = "no-such-policy";
    writeFileSync(stampFile, JSON.stringify(st));
    const r = await say(s, "x1", README);
    assert.equal(line(r), "Zero-touch: this can't be handed off right now, because the models for this work can't be read. So Opus 5 does it directly.");
    assert.match(context(r), /Hand-off cannot run in this chat/);
    assert.match(context(r), /do this work yourself/i);
    assert.ok(!existsSync(join(s.home, "sessions", "x1", "handoff_models.json")), "a failure is not kept: a repaired setup works at the next message");
  } finally { s.cleanup(); }
});

test("a typed workflow command still runs in a hand-off chat; the chat starting one by itself is refused", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "t1", "claude-opus-5");
    const byItself = await skill(s, "t1", "mmo:bugfix", BUGFIX);
    assert.equal(denied(byItself), "Zero-touch: in Hand-off mode no full workflow starts by itself, so Claude carries on in the chat.", "the person reads one plain sentence");
    assert.match(byItself.json?.hookSpecificOutput?.additionalContext ?? "", /no full workflow starts from the person's plain words/, "the model is told to do the work itself");

    const typed = await say(s, "t1", "/mmo:bugfix the login 500");
    assert.equal(line(typed), null, "a typed command shows no line: the person named the workflow");
    assert.ok(existsSync(join(s.home, "sessions", "t1", "pipeline")), "the chat is that workflow's run");
    assert.equal((await skill(s, "t1", "mmo:bugfix", "the login 500")).stdout, "", "its Skill call passes");

    // While the workflow runs the chat is the workflow's: no hand-off is recognised and no second workflow is offered.
    const dirRun = join(s.repo, ".sdlc", "runs", "bf-t1");
    mkdirSync(dirRun, { recursive: true });
    const log = (event, fields) => appendFileSync(join(dirRun, "orchestrator.log"), formatLine("info", event, { run_id: "bf-t1", ...fields }) + "\n");
    log("run.start", { mode: "brownfield" });
    log("gate.open", { gate: "gate-0", title: "scope" });
    assert.equal((await say(s, "t1", README)).stdout, "", "an answer to the open gate: no hand-off, no line");
    log("gate.resolved", { gate: "gate-0", response: "approved" });
    const during = await say(s, "t1", BUGFIX);
    assert.equal(during.stdout, "", "plain words never raise the queue-or-replace question here, and get no line");
  } finally { s.cleanup(); }
});

test("the chat stays on its pinned model: a switch to another model is refused, a switch to the pinned one is not", async () => {
  const s = sandbox();
  try {
    await startOn(s, "g1", "claude-opus-5");
    const refused = await switchTo(s, "g1", "claude-sonnet-5");
    assert.equal(refused.json?.hookSpecificOutput?.hookEventName, "PreModelSwitch");
    assert.equal(denied(refused), 'Zero-touch keeps this Hand-off chat on Opus 5, the chat model you chose, because it does the development and decides the hand-offs. To use a different model, type "change zero-touch settings", then start a new chat.');
    assert.equal((await switchTo(s, "g1", "claude-opus-5[1m]")).stdout, "", "the 1M-context tag is the same model");
    assert.equal((await run("pre-model-switch", { session_id: "g1", cwd: s.repo }, s)).stdout, "", "a switch whose target cannot be read is never refused");
  } finally { s.cleanup(); }
  const a = sandbox({ mode: "a" });
  try {
    assert.equal((await switchTo(a, "g2", "claude-sonnet-5")).stdout, "", "workflow mode never pins the chat");
  } finally { a.cleanup(); }
});

test("while the chat is on another model, nothing is handed off: the line says so and how to switch back", { skip: SKIP ?? false }, async () => {
  // The same model rule as in Workflows mode: a chat on another model hands nothing off.
  const s = sandbox();
  try {
    await startOn(s, "o1", "claude-opus-5");
    // A switch that happened anyway (an older Claude Code has no switch hooks to refuse it) is recorded when seen.
    await switchTo(s, "o1", "claude-sonnet-5", "post-model-switch");
    assert.equal(line(await say(s, "o1", QUESTION)), "Zero-touch: this chat is on Sonnet 5, but you chose Opus 5 to do the development in Hand-off mode. Switch it with the model menu next to the message box (in the terminal, type /model claude-opus-5); until then, nothing is handed off.", "the first ordinary message on the other model: said once");
    assert.equal(line(await say(s, "o1", README)), "Zero-touch: this chat is on Sonnet 5, but you chose Opus 5 to do the development in Hand-off mode, so nothing is handed off until you switch this chat to Opus 5 with the model menu next to the message box (in the terminal, type /model claude-opus-5). Then ask again.");
    await switchTo(s, "o1", "claude-opus-5", "post-model-switch");
    assert.equal(line(await say(s, "o1", README)), `Zero-touch: ${DOC("Flash 3.8")}`, "back on Opus 5: handed off");
  } finally { s.cleanup(); }
});

test("with no switch hook ever seen, the chat's own transcript says which model it is on", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const transcript = join(s.dir, "chat.jsonl");
    const entry = (model, text, at) => JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", model, content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) + "\n" + entry("claude-opus-5", "hi", "2026-09-30T10:00:00.000Z"));
    assert.equal(line(await say(s, "tr1", README, { transcript_path: transcript })), `Zero-touch: ${DOC("Flash 3.8")}`);
    // A helper's reply and a made-up entry are not the chat's model; the newest real reply is.
    appendFileSync(transcript, entry("claude-sonnet-5", "later", "2026-09-30T10:05:00.000Z"));
    appendFileSync(transcript, JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-09-30T10:06:00.000Z", message: { model: "claude-haiku-4-5", content: [] } }) + "\n");
    appendFileSync(transcript, entry("<synthetic>", "note", "2026-09-30T10:07:00.000Z"));
    assert.match(line(await say(s, "tr1", README, { transcript_path: transcript })), /^Zero-touch: this chat is on Sonnet 5, but you chose Opus 5/);
  } finally { s.cleanup(); }
});

test("nothing is shown for what nobody typed, for a helper's call, or in a run that only records", async () => {
  const s = sandbox();
  try {
    assert.equal((await say(s, "q1", "<task-notification>done</task-notification>")).stdout, "", "a machine notice");
    assert.equal((await say(s, "q2", README, { agent_id: "helper-1" })).stdout, "", "a helper's call");
    assert.equal(line(await say(s, "q3", README, {}, { MMO_AMBIENT: "observe" })), null, "a measuring run only records");
  } finally { s.cleanup(); }
});

test("zero-touch registers the two model-switch moments through the same shim as its other hooks; mmo registers none", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks;
  const mmo = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
  for (const [event, moment] of [["PreModelSwitch", "pre-model-switch"], ["PostModelSwitch", "post-model-switch"]]) {
    const commands = (hooks[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(commands, [`sh "\${CLAUDE_PLUGIN_ROOT}/hooks/mmo-hook.sh" ${moment}`], event);
    assert.equal(mmo[event], undefined, `mmo: no ${event} hook, as without zero-touch`);
  }
});

test("a hand-off chat started by the zero-touch hook alone is found by mmo at its first message", { skip: SKIP ?? false }, async () => {
  // Both plugins' start hooks run at once; mmo's may run before the chat is marked. The first prompt still acts.
  const s = sandbox();
  try {
    await runOnce("session-start", { session_id: "late1", cwd: s.repo, source: "startup" }, s);
    zeroTouchStart({ home: s.home, sid: "late1", cwd: s.repo, model: "claude-opus-5" });
    const r = await runOnce("prompt", { session_id: "late1", cwd: s.repo, prompt: README, prompt_id: "late-p1" }, s);
    assert.equal(line(r), `Zero-touch: ${DOC("Flash 3.8")}`);
  } finally { s.cleanup(); }
});

test("a machine too busy to answer in time is not reported as a broken policy, and nothing is kept", { skip: SKIP ?? false }, async () => {
  const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
  const s = sandbox();
  try {
    const env = { MMO_HOME: s.home, HOME: s.home, PATH: process.env.PATH };
    const flash = { typist: "flash", policy: "opus-plus-flash-v38" };
    const stamp = { chat_model: "claude-opus-5", pin: "setting", typists: { documents: flash, tests: flash, repeats: flash } };
    // One millisecond is never enough to start the router: the same outcome as a machine under heavy load.
    const busy = H.handoffRoutes("busy1", stamp, env, { timeoutMs: 1 });
    assert.equal(busy.error, "busy");
    assert.equal(H.HANDOFF_LINE.unavailable(busy, { name: "Opus 5", reminder: "" }), "Zero-touch: this can't be handed off right now, because the computer was too busy to check; ask again. So Opus 5 does it directly.");
    assert.ok(!existsSync(join(s.home, "sessions", "busy1", "handoff_models.json")));
    assert.equal(H.handoffRoutes("busy1", stamp, env).routes.docs.model, "gemini-3.8-flash", "the next ask, with time to answer, works");
  } finally { s.cleanup(); }
});
