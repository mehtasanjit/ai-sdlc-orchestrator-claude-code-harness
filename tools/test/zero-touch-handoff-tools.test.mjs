/**
 * Zero-touch hand-off mode, the hook around a hand-off tool call.
 *
 * The hand-off tools live in the mmo plugin's server, which never sees a chat. Two hook moments connect the two:
 *
 *   before the call (PreToolUse)  in a hand-off chat the hook adds a stamp to the call (`_mmo`): the chat's id, the
 *                                 project folder and who pays for a Claude typist. The server takes nothing else
 *                                 from the call about the chat: the chat's policy and models are read from the
 *                                 chat's own records, which the hook makes sure are resolved before it stamps.
 *                                 Anywhere else the call is refused: a chat in workflow mode, and a chat that is
 *                                 running a workflow (a workflow has its own steps and its own bill).
 *   after the call (PostToolUse)  the person sees one line, written by code from the tool's receipt: what was
 *                                 written, by which model, what it cost; or that the hand-off failed and the chat's
 *                                 model writes the file itself. The model reads the receipt; the line is never
 *                                 given to it.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const TOOL = "mcp__plugin_mmo_model-dispatch__write_document";

/**
 * A person who chose Hand-off ("b", Flash 3.8 typing every kind, the chat on Opus 5) or Workflows ("a") in the
 * settings box.
 */
function sandbox({ mode = "b", handoff = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-tools-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  writeZtSettings(home, { mode: mode === "a" ? "workflows" : "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash", ...handoff } });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The chat's stamp names a policy that no longer exists (a damaged install): nothing can be handed off. */
function breakPolicy(s, sid) {
  const file = join(s.home, "sessions", sid, "handoff.json");
  const st = JSON.parse(readFileSync(file, "utf8"));
  for (const k of Object.keys(st.typists)) st.typists[k].policy = "no-such-policy";
  writeFileSync(file, JSON.stringify(st));
  rmSync(join(s.home, "sessions", sid, "handoff_models.json"), { force: true });
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
const startOn = (s, sid, model = "claude-opus-5") => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", model }, s);
const FORM = { kind: "docs", file: "docs/setup.md", purpose: "p", readers: "r", sections: [{ heading: "Install", must_say: "how" }], facts: [{ statement: "Install with `npm ci`.", source: "chat" }] };
const before = (s, sid, input = FORM, extra = {}, tool = TOOL) => run("pre-handoff", { session_id: sid, cwd: s.repo, tool_name: tool, tool_input: input, ...extra }, s);
const after = (s, sid, receipt, shape = (r) => [{ type: "text", text: JSON.stringify(r) }]) => run("post-handoff", { session_id: sid, cwd: s.repo, tool_name: TOOL, tool_input: FORM, tool_response: shape(receipt) }, s);
/** A refusal's reason is the person's sentence and its additionalContext the model's instruction: `denied` is the instruction, `shown` what the person reads. */
const denied = (r) => (r.json?.hookSpecificOutput?.permissionDecision === "deny" ? r.json.hookSpecificOutput.additionalContext ?? "" : null);
const shown = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? null;
const line = (r) => r.json?.systemMessage ?? null;

test("in a hand-off chat the call is stamped with the chat, the project and who pays; the form is untouched", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "c1");
    const r = await before(s, "c1", { ...FORM, _mmo: { session_id: "someone-else", project_dir: "/", auth: "vendor" } });
    assert.equal(r.json.hookSpecificOutput.hookEventName, "PreToolUse");
    // Allowed without Claude Code's prompt: the person chose Hand-off, and the prompt would show the call's raw form,
    // stamp included.
    assert.equal(r.json.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(shown(r), "Zero-touch: handing this work off, as your Hand-off settings say. It is checked before anything reaches your project.");
    const sent = r.json.hookSpecificOutput.updatedInput;
    const { _mmo, ...form } = sent;
    assert.deepEqual(form, FORM, "every field of the form travels as the model wrote it");
    assert.deepEqual(_mmo, { session_id: "c1", project_dir: s.repo, auth: "estimated" }, "a stamp the model wrote is replaced, never kept");
    // The chat's models are resolved before the first hand-off, whether or not a message was recognised first.
    const kept = JSON.parse(readFileSync(join(s.home, "sessions", "c1", "handoff_models.json"), "utf8"));
    assert.equal(kept.routes.docs.model, "gemini-3.8-flash");
  } finally { s.cleanup(); }
});

test("the matching tool name is read with or without the plugin prefix; another tool is not touched", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "n1");
    assert.ok((await before(s, "n1", FORM, {}, "mcp__model-dispatch__write_document")).json.hookSpecificOutput.updatedInput._mmo);
    assert.equal((await before(s, "n1", FORM, {}, "mcp__plugin_mmo_model-dispatch__execute_stage")).stdout, "", "not a hand-off tool");
    assert.equal((await before(s, "n1", FORM, {}, "Write")).stdout, "");
  } finally { s.cleanup(); }
});

test("outside a hand-off chat, and while a workflow runs, a hand-off tool is refused with the reason", { skip: SKIP ?? false }, async () => {
  const a = sandbox({ mode: "a" });
  try {
    await startOn(a, "w1");
    const w = await before(a, "w1");
    assert.match(denied(w) ?? "", /work only in a chat that started in zero-touch hand-off mode/);
    assert.equal(shown(w), "Zero-touch: hand-offs work only in a Hand-off chat, so Claude does this itself.");
  } finally { a.cleanup(); }
  const s = sandbox();
  try {
    await startOn(s, "p1");
    await run("prompt", { session_id: "p1", cwd: s.repo, prompt: "/mmo:bugfix the login 500", prompt_id: "p1-1" }, s);
    assert.ok(existsSync(join(s.home, "sessions", "p1", "pipeline")));
    const p = await before(s, "p1");
    assert.match(denied(p) ?? "", /not available inside a workflow run/);
    assert.equal(shown(p), "Zero-touch: hand-offs don't run inside a workflow, so the workflow carries on with its own steps.");
  } finally { s.cleanup(); }
});

test("when the chat's hand-off policy cannot be read, the call is refused and the model is told to do the work itself", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "x1");
    breakPolicy(s, "x1");
    const r = await before(s, "x1");
    const why = denied(r) ?? "";
    assert.match(why, /Hand-off cannot run in this chat: the models for this work can't be read/);
    assert.match(why, /Do this work yourself/);
    assert.equal(shown(r), "Zero-touch: this can't be handed off here, because the models for this work can't be read, so Claude does it in the chat.");
  } finally { s.cleanup(); }
});

test("after the call the person sees one line from the receipt: what was written, by which model, what it cost", async () => {
  const s = sandbox();
  try {
    await startOn(s, "r1");
    const written = { status: "written", file: "docs/setup.md", kind: "docs", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004123 };
    const r = await after(s, "r1", written);
    assert.equal(line(r), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Estimated cost: $0.0041.");
    assert.equal(r.json.hookSpecificOutput, undefined, "the model reads the receipt itself; the line is the person's");
    // Claude Code hands a hook the reply as a content list, as a string or as the object: each reads the same.
    assert.equal(line(await after(s, "r1", written, (x) => JSON.stringify(x))), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Estimated cost: $0.0041.");
    assert.equal(line(await after(s, "r1", written, (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }))), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Estimated cost: $0.0041.");
    assert.equal(line(await after(s, "r1", { ...written, cost_usd: 1.5 })), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Estimated cost: $1.50.");
  } finally { s.cleanup(); }
});

test("the line says when the routed model failed and another wrote it, when the hand-off failed, and when the form was refused", async () => {
  const s = sandbox();
  try {
    await startOn(s, "f1");
    const byOpus = { status: "written", file: "docs/setup.md", written_by: "claude-opus-5", routed_model: "gemini-3.8-flash", attempts: 3, cost_usd: 0.098, note: "gemini-3.8-flash failed twice (…); done by claude-opus-5" };
    assert.equal(line(await after(s, "f1", byOpus)), "Zero-touch: Flash 3.8 couldn't write docs/setup.md, so Opus 5 wrote it. It was checked automatically. Estimated cost: $0.10.");
    const failed = { status: "failed", file: "docs/setup.md", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the document is empty", cost_usd: 0.012 };
    assert.equal(line(await after(s, "f1", failed)), "Zero-touch: the hand-off of docs/setup.md didn't work (estimated cost so far: $0.01), and nothing was added to your project. Opus 5 will write it directly now.");
    // A Claude typist whose sign-in on this computer has expired: the cause and the one step that fixes it.
    const signIn = { status: "failed", file: "docs/overview.md", routed_model: "claude-sonnet-5", attempts: 3, reason: "success: Failed to authenticate: OAuth session expired and could not be refreshed", cost_usd: 0 };
    assert.equal(line(await after(s, "f1", signIn)), "Zero-touch: the hand-off of docs/overview.md didn't run: the Claude sign-in this computer uses for Sonnet 5 has expired, so nothing was added (estimated cost: $0.0000). To fix it, sign in again: in a terminal, run claude and type /login. Opus 5 will write it directly now.");
    assert.match(line(await after(s, "f1", { ...signIn, file: undefined, changed_meanwhile: [] })), /^Zero-touch: the repeated change didn't run: the Claude sign-in this computer uses for Sonnet 5 has expired/);
    const form = { status: "refused", problems: ["purpose is empty", "facts needs at least one fact"] };
    assert.equal(line(await after(s, "f1", form)), "Zero-touch: Opus 5's instructions for the hand-off were missing 2 things, so nothing was sent and nothing was charged. Opus 5 is fixing them and will try again.");
    // Any other refusal: plain words only, never the server's own reason (Claude reads that in the reply).
    assert.equal(line(await after(s, "f1", { status: "refused", reason: "this chat's hand-off models are not resolved" })), "Zero-touch: this couldn't be handed off here, so nothing was sent and nothing was charged. Opus 5 does it directly.");
    assert.equal((await after(s, "f1", "not a receipt", (x) => x)).stdout, "", "a reply that is no receipt shows nothing");
  } finally { s.cleanup(); }
});

test("the line for tests, for a repeated change and for an undo", async () => {
  const s = sandbox();
  try {
    await startOn(s, "t1");
    const tests = { status: "written", id: "h1", file: "tests/cart.test.js", kind: "tests", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004 };
    assert.equal(line(await after(s, "t1", tests)), "Zero-touch: tests/cart.test.js was written by Flash 3.8 and checked automatically. Estimated cost: $0.0040. To undo it, ask Claude to undo the hand-off of tests/cart.test.js (going back in the chat doesn't undo it).");
    const red = { status: "failed", file: "tests/cart.test.js", kind: "tests", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the test command failed in a scratch copy of the project (exit 1). Its output:", output: "5 !== 6", cost_usd: 0.098 };
    assert.equal(line(await after(s, "t1", red)), "Zero-touch: the new tests in tests/cart.test.js didn't pass in the test copy (estimated cost: $0.10), so nothing was added. Opus 5 will look at why: if a test was wrong, it fixes the test; if the code has a real bug, it tells you.");

    const landed = { status: "landed", id: "h2", changed: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], routed_model: "gemini-3.8-flash", check: "`npm test` passed in a scratch copy (3.2 s)", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", landed)), "Zero-touch: Flash 3.8 made the change in 3 files, and your project's check passed on a test copy. Estimated cost: $0.01. To undo it, ask Claude to undo the hand-off of a.js; all 3 files are taken back together (going back in the chat doesn't undo it).");
    assert.equal(line(await after(s, "t1", { ...landed, changed: ["a.js"], failed: [{ file: "b.js", reason: "x" }, { file: "c.js", reason: "y" }], check: "not run (no check_command was given)" })), "Zero-touch: Flash 3.8 made the change in 1 file, and no automatic check was available. Estimated cost: $0.01. To undo it, ask Claude to undo the hand-off of a.js (going back in the chat doesn't undo it). 2 files still need the change, and Opus 5 will do them.");
    assert.equal(line(await after(s, "t1", { ...landed, by_fallback: 1, fallback_model: "claude-opus-5" })), "Zero-touch: Flash 3.8 made the change in 3 files (1 file by Opus 5 after Flash 3.8 failed), and your project's check passed on a test copy. Estimated cost: $0.01. To undo it, ask Claude to undo the hand-off of a.js; all 3 files are taken back together (going back in the chat doesn't undo it).");
    assert.equal(line(await after(s, "t1", { ...landed, id: undefined, changed: [], unchanged: ["a.js"] })), "Zero-touch: no file needed the change. Estimated cost: $0.01.");
    const broke = { status: "failed", reason: "the check command failed in a scratch copy with the 3 changed files (exit 1)", routed_model: "gemini-3.8-flash", would_change: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], output: "boom", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", broke)), "Zero-touch: the change couldn't be repeated safely (your project's check failed on the test copy; estimated cost: $0.01), so nothing was changed. Opus 5 will make the change directly.");
    const none = { status: "failed", reason: "no target's edits passed the checks", routed_model: "gemini-3.8-flash", changed: [], unchanged: [], failed: [{ file: "a.js", reason: "x" }], cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", none)), "Zero-touch: the change couldn't be repeated safely (it couldn't be handed off; estimated cost: $0.01), so nothing was changed. Opus 5 will make the change directly.");

    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js", "b.js"], left_alone: [] })), "Zero-touch: the hand-off of a.js was undone: 2 files are back as they were.");
    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js"], left_alone: ["b.js"] })), "Zero-touch: the hand-off of a.js was undone: 1 file is back as it was. (1 file had been changed again since, so it was left as it is.)");
  } finally { s.cleanup(); }
});

test("the lines for a stopped hand-off, a file that appeared meanwhile, a regression test, an undo that asks first, a file handed back", async () => {
  const s = sandbox();
  try {
    await startOn(s, "n1");
    assert.equal(line(await after(s, "n1", { status: "stopped", files: ["docs/setup.md"], cost_usd: 0.02 })), "Zero-touch: the hand-off of docs/setup.md was stopped, as you asked, and nothing was added to your project (estimated cost so far: $0.02).");
    assert.equal(line(await after(s, "n1", { status: "failed", cause: "appeared", file: "tests/cart.test.js", kind: "tests", cost_usd: 0.02 })), "Zero-touch: tests/cart.test.js was created by someone else while the hand-off was running, so nothing was written over it (estimated cost: $0.02). Opus 5 will ask you what to do.");
    assert.equal(line(await after(s, "n1", { status: "written", id: "hab12", file: "tests/login.test.js", kind: "tests", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", fails_until_fixed: true, cost_usd: 0.004 })), "Zero-touch: tests/login.test.js was written by Flash 3.8 and checked automatically. Its tests fail for now, as expected, until Opus 5 fixes the bug. Estimated cost: $0.0040. To undo it, ask Claude to undo the hand-off of tests/login.test.js (going back in the chat doesn't undo it).");
    assert.equal(line(await after(s, "n1", { status: "kept", id: "hab12", changed_since: ["docs/n.md"] })), "Zero-touch: the hand-off of docs/n.md wasn't undone, because its file has been changed since. Opus 5 will ask you whether to undo it anyway.");
    assert.equal(line(await after(s, "n1", { status: "refused", problems: ["x", "y"], handed_back: "docs/x.md" })), "Zero-touch: docs/x.md couldn't be handed off, so nothing was sent and nothing was charged. Opus 5 will write it directly.");
    assert.equal(line(await after(s, "n1", { status: "refused", cause: "unknown-id", id: "h9999" })), "Zero-touch: there's no hand-off h9999 in this project, so nothing was undone.");
    assert.equal(line(await after(s, "n1", { status: "refused", cause: "already-undone", id: "hab12" })), "Zero-touch: hand-off hab12 was already undone, so nothing changed.");
  } finally { s.cleanup(); }
});

test("an undo needs no model: it is stamped even when the chat's hand-off policy cannot be read", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "u1");
    breakPolicy(s, "u1");
    const undo = await before(s, "u1", { id: "h1" }, { tool_use_id: "tu-u1" }, "mcp__plugin_mmo_model-dispatch__undo_hand_off");
    // The call's own id travels in the stamp: an interrupted call is never landed.
    assert.deepEqual(undo.json.hookSpecificOutput.updatedInput, { id: "h1", _mmo: { session_id: "u1", project_dir: s.repo, auth: "estimated", tool_use_id: "tu-u1" } });
  } finally { s.cleanup(); }
});

test("every tool the hooks match, the start note names and the reminders name is a tool the server lists", { skip: SKIP ?? false }, async () => {
  const { HANDOFF_TOOLS } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "handoff", "tools.js"));
  const listed = HANDOFF_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(listed, ["repeat_edit_across_files", "undo_hand_off", "write_document", "write_tests_from_cases"]);
  const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
  for (const tool of listed) assert.equal(H.handoffToolName(`mcp__plugin_mmo_model-dispatch__${tool}`), tool, `the hook knows ${tool}`);
  for (const tool of new Set(Object.values(H.HANDOFF_TOOL))) assert.ok(listed.includes(tool), `the reminders name ${tool}, which the server lists`);
  const note = readFileSync(join(ROOT, "zero-touch", "scripts", "messages.mjs"), "utf8"); // the rules note lives there
  for (const tool of listed) assert.match(note, new RegExp(`\\b${tool}\\b`), `the start note names ${tool}`);
  const hooks = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["PreToolUse", "PostToolUse"]) {
    const entry = hooks[event].find((e) => e.hooks.some((h) => /(pre|post)-handoff$/.test(h.command)));
    for (const tool of listed) assert.ok(new RegExp(`^(?:${entry.matcher})$`).test(`mcp__plugin_mmo_model-dispatch__${tool}`), `${event} matches ${tool}`);
  }
});

test("zero-touch registers both moments for the hand-off tools, through the same shim as its other hooks", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks;
  for (const [event, moment] of [["PreToolUse", "pre-handoff"], ["PostToolUse", "post-handoff"]]) {
    const entry = (hooks[event] ?? []).find((e) => e.hooks.some((h) => h.command.endsWith(` ${moment}`)));
    assert.ok(entry, `${event} has the ${moment} hook`);
    assert.equal(entry.hooks[0].command, `sh "\${CLAUDE_PLUGIN_ROOT}/hooks/mmo-hook.sh" ${moment}`);
    const matcher = new RegExp(`^(?:${entry.matcher})$`);
    for (const tool of ["write_document", "write_tests_from_cases", "repeat_edit_across_files", "undo_hand_off"]) {
      assert.ok(matcher.test(`mcp__plugin_mmo_model-dispatch__${tool}`), `${tool}, installed as a plugin`);
      assert.ok(matcher.test(`mcp__model-dispatch__${tool}`), `${tool}, from a clone`);
    }
    assert.ok(!matcher.test("mcp__plugin_mmo_model-dispatch__execute_stage"), "the workflow's own tools are not touched");
  }
});

test("a project not set up with git: the person reads the plain line, not the server's reason", async () => {
  // The server's reason is technical and does not say who does the work now: the approved words are shown instead,
  // the documents sentence only when documents hand off.
  const reason = "the project is not a git repository, so a scratch copy cannot tell its own files from installed dependencies and the hand-off cannot be checked";
  const refused = { status: "refused", reason, cause: "no-git", next: "Nothing was sent. Write tests/cart.test.js yourself." };
  const s = sandbox();
  try {
    await startOn(s, "g1");
    assert.equal(line(await after(s, "g1", refused)), "Zero-touch: this can't be handed off here, because the test copy it needs only works in a project set up with git. So Opus 5 does it directly. (New documents can still be handed off.)");
    // Any other refusal: plain words, never the server's reason.
    assert.equal(line(await after(s, "g1", { status: "refused", reason: "something else" })), "Zero-touch: this couldn't be handed off here, so nothing was sent and nothing was charged. Opus 5 does it directly.");
  } finally { s.cleanup(); }
  const k = sandbox({ handoff: { documents: "chat" } });
  try {
    await startOn(k, "g2");
    assert.equal(line(await after(k, "g2", refused)), "Zero-touch: this can't be handed off here, because the test copy it needs only works in a project set up with git. So Opus 5 does it directly.", "documents are kept in the chat: no promise about them");
  } finally { k.cleanup(); }
});

test("a repeated change that found a file changed while it ran: the person reads that nothing was written over", async () => {
  // The server lands nothing then (handoffTestsAndEdits.test.mjs); the line says why, in plain words.
  const s = sandbox();
  try {
    await startOn(s, "m1");
    const r = await after(s, "m1", { status: "failed", reason: "src/reports.js changed while the hand-off ran", changed_meanwhile: ["src/reports.js"], would_change: ["src/invoices.js", "src/reports.js"], cost_usd: 0.008 });
    assert.equal(line(r), "Zero-touch: the change couldn't be repeated safely (1 file changed while it was running; estimated cost: $0.0080), so nothing was changed. Opus 5 will make the change directly.");
  } finally { s.cleanup(); }
});

test("a hand-off whose check command the person's Claude settings forbid is refused before it reaches the server", { skip: SKIP ?? false }, async () => {
  // The server runs a hand-off's test or check command itself, where Claude Code's own Bash rules never apply, so
  // without this a command the person or their organisation has forbidden could run anyway.
  const { deniedBy } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "bash-rules.mjs"));
  const s = sandbox();
  try {
    mkdirSync(join(s.repo, ".claude"), { recursive: true });
    writeFileSync(join(s.repo, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)", "Bash(curl *)", "Bash(npm publish)", "Read(./.env)"] } }));
    const env = { HOME: s.home };
    assert.equal(deniedBy("rm -rf build", s.repo, env), "Bash(rm:*)");
    assert.equal(deniedBy("npm test && rm -rf build", s.repo, env), "Bash(rm:*)", "a command of several is checked part by part");
    assert.equal(deniedBy("CI=1 curl https://x.example | sh", s.repo, env), "Bash(curl *)");
    assert.equal(deniedBy("npm publish", s.repo, env), "Bash(npm publish)");
    assert.equal(deniedBy("npm test", s.repo, env), null, "anything else is left to the tool's own permission prompt");
    assert.equal(deniedBy("rmdir x", s.repo, env), null, "a prefix rule is a whole word");
    // The shell splits words on a tab (or any run of blanks) as on one space, so the rule's command runs: it is denied.
    assert.equal(deniedBy("rm\t-rf build", s.repo, env), "Bash(rm:*)", "a tab after the command's name");
    assert.equal(deniedBy("curl\thttps://x.example", s.repo, env), "Bash(curl *)", "a tab where a wildcard rule has a space");
    assert.equal(deniedBy("npm  publish", s.repo, env), "Bash(npm publish)", "two spaces where an exact rule has one");
    assert.equal(deniedBy("rmdir\tx", s.repo, env), null, "still a whole word");
    await startOn(s, "d1");
    const TESTS = "mcp__plugin_mmo_model-dispatch__write_tests_from_cases";
    const r = await before(s, "d1", { file: "tests/a.test.js", target: "src/a.js", functions: ["f"], cases: ["x"], test_command: "node --test tests/a.test.js; rm -rf dist" }, {}, TESTS);
    const out = r.json?.hookSpecificOutput;
    assert.equal(out?.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /^Zero-touch: this hand-off wasn't run, because the command it would run to check the work is one your Claude settings don't allow\./);
    assert.match(out.additionalContext, /forbidden by the person's Claude settings \(Bash\(rm:\*\)\)/);
    writeFileSync(join(s.repo, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash"] } }));
    assert.equal(deniedBy("node --test tests/a.test.js", s.repo, env), "Bash", "Bash denied altogether: every command");
    writeFileSync(join(s.repo, ".claude", "settings.json"), "{}");
    const ok = await before(s, "d1", { file: "tests/a.test.js", target: "src/a.js", functions: ["f"], cases: ["x"], test_command: "node --test tests/a.test.js" }, {}, TESTS);
    assert.notEqual(ok.json?.hookSpecificOutput?.permissionDecision, "deny", "nothing forbidden: the call goes on");
  } finally { s.cleanup(); }
});

test("a deny or ask rule in the person's settings that names a hand-off tool keeps Claude Code's own decision", { skip: SKIP ?? false }, async () => {
  const { toolRuleFor } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "bash-rules.mjs"));
  const s = sandbox();
  try {
    await startOn(s, "r1");
    const settings = join(s.repo, ".claude", "settings.json");
    mkdirSync(join(s.repo, ".claude"), { recursive: true });
    for (const [where, rule] of [["deny", "mcp__plugin_mmo_model-dispatch"], ["ask", "mcp__plugin_mmo_model-dispatch__write_document"], ["deny", "mcp__plugin_mmo_*"]]) {
      writeFileSync(settings, JSON.stringify({ permissions: { [where]: [rule] } }));
      const r = await before(s, "r1", FORM);
      assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined, `${where} ${rule}: Claude Code decides`);
      assert.ok(r.json.hookSpecificOutput.updatedInput._mmo, "still stamped");
    }
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ["mcp__other-server", "Bash(rm:*)", "mcp__plugin_mmo_model-dispatch__execute_stage"] } }));
    assert.equal((await before(s, "r1", FORM)).json.hookSpecificOutput.permissionDecision, "allow", "rules about other tools change nothing");
    // The two tools that run a command keep Claude Code's prompt, which shows that command.
    for (const tool of ["write_tests_from_cases", "repeat_edit_across_files"]) {
      const r = await before(s, "r1", { file: "x", test_command: "npm test", check_command: "npm test" }, {}, `mcp__plugin_mmo_model-dispatch__${tool}`);
      assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, "allow", tool);
    }
    assert.equal(toolRuleFor("mcp__plugin_mmo_model-dispatch__write_document", s.repo, { HOME: s.home }), null);
  } finally { s.cleanup(); }
});
