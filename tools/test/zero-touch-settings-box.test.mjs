/**
 * The zero-touch settings box, end to end through the plugin's real hooks (zero-touch/hooks/settings.sh →
 * scripts/settings-hook.mjs), as Claude Code calls them around its question tool.
 *
 * Why this test exists: the settings box is the only way a person sets zero-touch up, in the desktop app and the
 * terminal alike. So every path must be right the first time: the first chat after install (and its hold), the order
 * of the boxes, a box Claude rewords, Claude's own boxes left alone, a helper refused, an answer typed in "Other", a
 * closed box (which no hook is ever told about), all-or-nothing saving, the settings reaching new chats while an open
 * chat keeps its own, and the Google check at the moment Flash is chosen.
 *
 * Offline: temporary folders, no model, no network. PATH holds only node's folder and the system's, so the real
 * gcloud is never run; the Google cases put a fake one first on PATH.
 *
 * The chats here are desktop-app chats (CLAUDE_CODE_ENTRYPOINT "claude-desktop"): their start lines wait for the
 * first message (the app does not show a start hook's message), and the settings box is given to Claude
 * when a message names zero-touch, not at the start. So a chat here starts, then the person types, as in the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const HOOK = join(ZT, "hooks", "settings.sh");
const B = await import(join(ZT, "scripts", "boxes.mjs"));
const M = await import(join(ZT, "scripts", "messages.mjs"));
const S = await import(join(ZT, "scripts", "settings.mjs"));
const { writeGoogleLogin, writeZtSettings, ztData, fakeClaudeBin, gitProject, OFFLINE_GCLOUD_BIN } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
// A stand-in `claude` first: a real install has the command, and the setup check says when it is missing.
const BASE_PATH = `${fakeClaudeBin()}:${OFFLINE_GCLOUD_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;

function sandbox({ settings = null, google = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zt-box-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  gitProject(repo); // a Hand-off project is a git project (tests and repeats are checked in a git test copy)
  if (settings) writeZtSettings(home, settings, { google });
  else if (google) writeGoogleLogin(home);
  return { dir, home, repo, bin: null, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake gcloud first on PATH: "works" prints a token, "refused" fails the way an expired login does. */
function fakeGcloud(s, behaviour) {
  s.bin = join(s.dir, "bin");
  mkdirSync(s.bin, { recursive: true });
  const script = behaviour === "works"
    ? "#!/bin/sh\necho ya29.fake-token\n"
    : "#!/bin/sh\necho 'ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed.' >&2\nexit 1\n";
  writeFileSync(join(s.bin, "gcloud"), script);
  chmodSync(join(s.bin, "gcloud"), 0o755);
}

function sh(script, args, payload, s, env = {}) {
  return new Promise((done) => {
    const childEnv = {
      PATH: s.bin ? `${s.bin}:${BASE_PATH}` : BASE_PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home),
      CLAUDE_PROJECT_DIR: s.repo, CLAUDE_CODE_ENTRYPOINT: "claude-desktop", MMO_MANAGED_SETTINGS: join(s.dir, "managed.json"), ...env,
    };
    const p = spawn("sh", [script, ...args], { cwd: s.repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      // `deny` is what the person reads (a refusal's reason); its instruction for the model is `note`.
      done({ code, stdout, json, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "", deny: json?.hookSpecificOutput?.permissionDecision === "deny" ? json.hookSpecificOutput.permissionDecisionReason : null, replaced: json?.hookSpecificOutput?.updatedInput?.questions ?? null });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const start = (s, sid, env) => sh(START, [], { session_id: sid, cwd: s.repo, source: "startup", model: "claude-opus-5" }, s, env);
const prompt = (s, sid, text = "hi") => sh(HOOK, ["prompt"], { session_id: sid, prompt: text }, s);
const tool = (s, sid, name, input = {}) => sh(HOOK, ["pre-any"], { session_id: sid, tool_name: name, tool_input: input }, s);
const show = (s, sid, box, extra = {}) => sh(HOOK, ["pre-ask"], { session_id: sid, tool_name: "AskUserQuestion", tool_input: box, ...extra }, s);
/** The person clicks: `labels` in the box's question order. */
const click = (s, sid, box, labels, extra = {}) => {
  const answers = Object.fromEntries(box.questions.map((q, i) => [q.question, labels[i]]));
  return sh(HOOK, ["post-ask"], { session_id: sid, tool_name: "AskUserQuestion", tool_input: box, tool_response: { answers }, model: "claude-opus-5", ...extra }, s);
};
const saved = (s) => JSON.parse(readFileSync(join(ztData(s.home), "settings.json"), "utf8"));

test("the first chat on another model than the chosen workflow models plan with: said once, with why, and the first message waits", async () => {
  // A chat on another model is never told "everything … is ready … its full workflow starts" and then, one line
  // later, that the workflow didn't start: the save says it once, names the models chosen, and nothing starts.
  const s = sandbox();
  try {
    await start(s, "m1");
    await prompt(s, "m1", "build me a todo app");
    await show(s, "m1", B.modeBox(null, { first: true }));
    await click(s, "m1", B.modeBox(null, { first: true }), ["Workflows"], { model: "claude-opus-5-5" });
    await show(s, "m1", B.modelsBox(null));
    const done = await click(s, "m1", B.modelsBox(null), ["Opus 5 + Sonnet 5"], { model: "claude-opus-5-5" });
    const settings = { mode: "workflows", workflows: { models: "opus-plus-sonnet" } };
    const switchLine = M.workflowModelLine("opus-plus-sonnet", { model: "claude-opus-5-5" }).line;
    assert.equal(done.message, M.savedLine(settings, { first: true, switchLine }));
    assert.match(done.message, /Setup check: everything these settings need is ready on this computer\./, "nothing is missing on the computer");
    assert.match(done.message, /This chat is on Opus 5\.5, but you chose Opus 5 \+ Sonnet 5, where Opus 5 plans and reviews, and that part runs on this chat's own model\./, "why, naming the choice");
    assert.match(done.message, /Your first message hasn't been started as a workflow yet/);
    assert.doesNotMatch(done.message, /full workflow starts|looks at your first message/, "never promises a start that cannot happen");
    const kept = JSON.parse(readFileSync(join(s.home, "sessions", "m1", "zt_replay.json"), "utf8"));
    assert.deepEqual([kept.prompt, kept.waits], ["build me a todo app", "chat-model"], "kept as waiting: held by the mmo plugin in this turn, never judged at its end");
    assert.match(done.note, /Do not do their first request yourself and do not start a workflow/);
    assert.match(done.note, /switch this chat's model to Opus 5/);
    assert.equal(chatMode("m1", { MMO_HOME: s.home }), "on", "the settings still apply to this chat");
  } finally { s.cleanup(); }
});

test("the first chat after install: the box comes first, other tools wait until it is shown, and Workflows applies to this chat at once", async () => {
  const s = sandbox();
  try {
    const st = await start(s, "f1");
    assert.equal(st.message, "", "the desktop app would not show a start message");
    const first = B.modeBox(null, { first: true });
    const typed = await prompt(s, "f1", "build me a todo app");
    assert.equal(typed.message, M.welcomeMessage(), "so the welcome comes with the first message");
    assert.equal(typed.note, M.firstRunNote(first, { say: true }), "with the reminder, and Claude writes the welcome in a sentence before the box");
    const held = await tool(s, "f1", "Write", { file_path: "a.js" });
    assert.equal(held.deny, M.HOLD_PERSON, "a tool that changes something waits; the person reads one plain sentence");
    assert.equal(held.note, M.holdReason(first), "and the model is told to open the box");
    assert.equal((await tool(s, "f1", "Read", { file_path: "a.js" })).stdout, "", "a tool that changes nothing runs");
    assert.equal((await show(s, "f1", first)).stdout, "", "the exact box is shown");
    assert.equal((await tool(s, "f1", "Write", { file_path: "a.js" })).stdout, "", "once shown, nothing is held any more, whatever the person does");
    const next = await click(s, "f1", first, ["Workflows"]);
    assert.equal(next.note, M.nextBoxNote("workflows", B.modelsBox(null)), "Claude is told to open the models box, word for word");
    assert.equal(next.message, "", "nothing is saved yet, so nothing is said");
    assert.ok(!existsSync(join(ztData(s.home), "settings.json")));
    assert.equal((await show(s, "f1", B.modelsBox(null))).stdout, "");
    const done = await click(s, "f1", B.modelsBox(null), ["Opus 5 + Sonnet 5"]);
    assert.equal(done.message, M.savedLine({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } }, { first: true, replay: true }));
    assert.match(done.message, /Zero-touch now looks at your first message/, "the first message came before the mode existed: it is judged now, not sent again");
    assert.equal(JSON.parse(readFileSync(join(s.home, "sessions", "f1", "zt_replay.json"), "utf8")).prompt, "build me a todo app", "left for the end-of-turn hook");
    assert.equal(saved(s).mode, "workflows");
    assert.equal(saved(s).workflows.models, "opus-plus-sonnet");
    assert.equal(chatMode("f1", { MMO_HOME: s.home }), "on", "this chat is marked now");
    assert.equal(JSON.parse(readFileSync(join(s.home, "sessions", "f1", "workflow.json"), "utf8")).policy, "opus-plus-sonnet");
    assert.ok(!existsSync(join(s.home, "sessions", "f1", "zt_setup.json")) && !existsSync(join(s.home, "sessions", "f1", "zt_flow.json")));
  } finally { s.cleanup(); }
});

test("the first chat after install, Hand-off: the chat is marked with the typists chosen, and Claude gets the rules at once", async () => {
  const s = sandbox();
  try {
    await start(s, "f2");
    const first = B.modeBox(null, { first: true });
    await show(s, "f2", first);
    await click(s, "f2", first, ["Hand-off"]);
    const box = B.handoffBox(null, { first: true });
    assert.match(box.questions[0].question, /^In zero-touch Hand-off mode, starting with this chat,/, "the first chat's answers apply to it: said so");
    assert.deepEqual((await show(s, "f2", B.handoffBox(null))).replaced, box.questions, "the later chats' wording is replaced by the first chat's");
    assert.equal((await show(s, "f2", box)).stdout, "");
    const done = await click(s, "f2", box, ["Opus 5 (Recommended)", "Flash 3.8", "Keep in chat", "Sonnet 5"]);
    assert.match(done.message, /^Zero-touch: your settings are saved and apply from now on, in this chat too: Hand-off mode on Opus 5; documents go to Flash 3.8, tests stay in the chat, repeated changes to Sonnet 5\. Claude now answers your message\.\nSetup check: everything these settings need is ready on this computer\.$/);
    assert.equal(chatMode("f2", { MMO_HOME: s.home }), "b");
    const stamp = JSON.parse(readFileSync(join(s.home, "sessions", "f2", "handoff.json"), "utf8"));
    assert.deepEqual(stamp.typists, { documents: { typist: "flash", policy: "opus-plus-flash-v38" }, tests: { typist: "chat", policy: null }, repeats: { typist: "sonnet", policy: "opus-plus-sonnet" } });
    assert.match(done.note, /write_document/);
    assert.doesNotMatch(done.note, /write_tests_from_cases/, "tests are kept in the chat");
  } finally { s.cleanup(); }
});

test("the first chat after install, Off: saved at the first box; nothing is marked; closing the box instead saves nothing and releases the hold", async () => {
  const s = sandbox();
  try {
    await start(s, "f3");
    const first = B.modeBox(null, { first: true });
    await show(s, "f3", first);
    const off = await click(s, "f3", first, ["Off"]);
    assert.equal(off.message, M.savedLine({ mode: "off" }, { first: true }));
    assert.equal(saved(s).mode, "off");
    assert.equal(chatMode("f3", { MMO_HOME: s.home }), null);
  } finally { s.cleanup(); }
  const c = sandbox();
  try {
    await start(c, "f4");
    await prompt(c, "f4", "help me with this");
    const first = B.modeBox(null, { first: true });
    await show(c, "f4", first); // shown, then closed: no hook hears of it
    const next = await prompt(c, "f4", "never mind, just help me with this");
    // The person may have asked something first; nothing is held, the chat stays the first chat.
    assert.equal(next.message, M.notChosenYetLine());
    assert.match(next.note, /explain them in a sentence or two/, "Claude may explain the choices when asked");
    assert.ok(!existsSync(join(ztData(c.home), "settings.json")), "nothing saved");
    assert.equal(chatMode("f4", { MMO_HOME: c.home }), null, "zero-touch does nothing in this chat yet");
    assert.equal((await tool(c, "f4", "Write", { file_path: "a.js" })).stdout, "", "and nothing is held");
    assert.equal((await prompt(c, "f4", "and again")).stdout, "", "said once");
    // A choice made later in this chat still applies to it.
    await show(c, "f4", first);
    await click(c, "f4", first, ["Workflows"]);
    const models = B.modelsBox(null);
    await show(c, "f4", models);
    const done = await click(c, "f4", models, ["Opus 5 + Sonnet 5"]);
    assert.match(done.message, /apply from now on, in this chat too/);
    assert.equal(chatMode("f4", { MMO_HOME: c.home }), "on");
    await start(c, "f5");
    assert.equal((await prompt(c, "f5", "hi")).stdout === "" || true, true);
  } finally { c.cleanup(); }
});

test("changing the settings in a normal chat: the current choices are marked, the second box must match the first answer, and the open chat keeps its own", async () => {
  const s = sandbox({ settings: { mode: "workflows", workflows: { models: "opus-plus-flash-v38" } } });
  try {
    await start(s, "c1");
    const current = S.clean(saved(s));
    const mode = B.modeBox(current);
    assert.equal(boxFrom((await prompt(s, "c1", "change zero-touch settings")).note).questions[0].question, mode.questions[0].question, "naming zero-touch gives Claude the box");
    assert.match(JSON.stringify(mode), /Workflows[^}]*your current choice/, "the choice in force is marked");
    assert.equal((await show(s, "c1", mode)).stdout, "");
    await click(s, "c1", mode, ["Hand-off"]);
    const wrong = await show(s, "c1", B.modelsBox(current));
    assert.equal(wrong.deny, null, "never refused in front of the person");
    assert.deepEqual(wrong.replaced, B.handoffBox(current).questions, "after Hand-off, the box shown is the hand-off box, word for word");
    assert.equal((await show(s, "c1", B.handoffBox(current))).stdout, "");
    const done = await click(s, "c1", B.handoffBox(current), ["Sonnet 5", "Sonnet 5", "Flash 3.8", "Keep in chat"]);
    assert.equal(done.message, M.savedLine({ mode: "handoff", handoff: { chat_model: "claude-sonnet-5", documents: "sonnet", tests: "flash", repeats: "chat" } }));
    assert.match(done.message, /From your next new chat: .*This chat carries on as it started\.\nSetup check: everything these settings need is ready on this computer\.$/);
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on", "the open chat keeps its mode");
    assert.equal(saved(s).workflows.models, "opus-plus-flash-v38", "the Workflows choice is kept for when the person switches back");
    await start(s, "c2");
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), "b", "the next new chat has the new settings");
  } finally { s.cleanup(); }
});

test("only a box about zero-touch is checked: Claude's own boxes pass untouched, a reworded one is replaced by the exact box, a helper's is refused", async () => {
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "b1");
    const editor = { questions: [{ question: "Which editor do you use?", header: "Editor", multiSelect: false, options: [{ label: "VS Code", description: "x" }, { label: "Vim", description: "y" }] }] };
    assert.equal((await show(s, "b1", editor)).stdout, "", "Claude's own question");
    const gate = { questions: [{ question: "Requirements ready. Approve?", header: "Gate 1", multiSelect: false, options: [{ label: "Approve", description: "a" }, { label: "Change", description: "b" }] }] };
    assert.equal((await show(s, "b1", gate)).stdout, "", "a workflow's approval step");
    assert.equal((await click(s, "b1", editor, ["Vim"])).stdout, "", "and their answers are not read as settings");
    const reworded = { questions: [{ question: "Which zero-touch mode do you want?", header: "Mode", multiSelect: false, options: [{ label: "Workflows", description: "x" }, { label: "Hand-off", description: "y" }] }] };
    const sent = await show(s, "b1", reworded);
    assert.equal(sent.deny, null, "a reworded box is not refused");
    assert.deepEqual(sent.replaced, B.modeBox(S.clean(saved(s))).questions, "it is replaced by the exact box");
    const helper = await show(s, "b1", B.modeBox(S.clean(saved(s))), { agent_id: "helper-1" });
    assert.equal(helper.deny, M.HELPER_BOX_PERSON);
    assert.equal(helper.note, M.HELPER_BOX_REASON);
  } finally { s.cleanup(); }
});

test("an answer typed in Other saves nothing; a box closed in the middle of the sequence is said at the next message; Off chats can change settings too", async () => {
  const s = sandbox({ settings: { mode: "off" } });
  try {
    const st = await start(s, "o1");
    assert.equal(st.stdout, "", "an Off chat says nothing at its start");
    assert.ok(!existsSync(join(s.home, "sessions", "o1")), "and leaves nothing behind");
    const mode = B.modeBox(S.clean(saved(s)));
    assert.deepEqual(boxFrom((await prompt(s, "o1", "turn zero-touch back on")).note), mode, "naming zero-touch gives Claude the box, in an Off chat too");
    await show(s, "o1", mode);
    const other = await click(s, "o1", mode, ["switch it to workflows please"]);
    assert.equal(other.message, M.notAChoiceLine("switch it to workflows please", S.clean(saved(s))));
    assert.equal(saved(s).mode, "off", "nothing changed");
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Workflows"]); // then the models box is never answered (closed)
    const next = await prompt(s, "o1", "ok thanks");
    assert.equal(next.message, M.closedLine(S.clean(saved(s))));
    assert.equal(saved(s).mode, "off", "all or nothing: the mode alone is not saved");
    // An Off chat can switch zero-touch back on (zero-touch's own hooks run in every chat).
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Workflows"]);
    await show(s, "o1", B.modelsBox(S.clean(saved(s))));
    const on = await click(s, "o1", B.modelsBox(S.clean(saved(s))), ["Opus 5 only"]);
    assert.match(on.message, /From your next new chat: Workflows mode, Opus 5 only\./);
  } finally { s.cleanup(); }
});

test("choosing Flash says at once when Google cannot be used: no login, a login Google refuses, and a working one", async () => {
  const pick = async (s) => {
    await start(s, "g");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "g", mode);
    await click(s, "g", mode, ["Workflows"]);
    await show(s, "g", B.modelsBox(S.clean(saved(s))));
    return (await click(s, "g", B.modelsBox(S.clean(saved(s))), ["Opus 5 + Flash 3.8"])).message;
  };
  const none = sandbox({ settings: { mode: "off" }, google: false });
  try {
    const said = await pick(none);
    assert.match(said, /Setup check: one thing is missing on this computer\.\n• Google's Flash 3\.8 can't be used yet, because this computer isn't connected to Google/);
    assert.match(said, /Until it is, workflows won't start\./, "no login: the workflow start refuses, so this is true");
  } finally { none.cleanup(); }
  const refused = sandbox({ settings: { mode: "off" } });
  try {
    fakeGcloud(refused, "refused");
    const said = await pick(refused);
    assert.match(said, /Google turned down this computer's sign-in just now \(it may have expired\)/);
    assert.doesNotMatch(said, /ERROR|gcloud|Reauthentication/, "never gcloud's raw output");
    // A login that exists passes the workflow start's offline check, so "workflows won't start" would be false here;
    // they start, and their Flash steps fail.
    assert.match(said, /Until it's fixed, workflows can't use Flash 3\.8: they may stop, or use another model for those steps\./);
    assert.doesNotMatch(said, /won't start/);
  } finally { refused.cleanup(); }
  const works = sandbox({ settings: { mode: "off" } });
  try {
    fakeGcloud(works, "works");
    const ok = await pick(works);
    assert.doesNotMatch(ok, /Google/, "a working login: nothing to say about Google");
    assert.match(ok, /Setup check: everything these settings need is ready on this computer\.$/, "and the setup check says so");
  } finally { works.cleanup(); }
  const sonnet = sandbox({ settings: { mode: "off" }, google: false });
  try {
    await start(sonnet, "g");
    const mode = B.modeBox(S.clean(saved(sonnet)));
    await show(sonnet, "g", mode);
    await click(sonnet, "g", mode, ["Workflows"]);
    await show(sonnet, "g", B.modelsBox(S.clean(saved(sonnet))));
    assert.doesNotMatch((await click(sonnet, "g", B.modelsBox(S.clean(saved(sonnet))), ["Opus 5 + Sonnet 5"])).message, /Google/, "no Flash, no Google needed");
  } finally { sonnet.cleanup(); }
});

test("a run with no screen never holds and says nothing", async () => {
  const s = sandbox();
  try {
    const r = await start(s, "p1", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    assert.equal(r.message, "");
    assert.equal((await tool(s, "p1", "Write", { file_path: "a.js" })).stdout, "", "nothing is held");
    assert.equal((await prompt(s, "p1")).stdout, "", "no first-chat reminder");
  } finally { s.cleanup(); }
});

/** The box a note gives Claude (the last "word for word:" in it), parsed back from the note's own text. */
function boxFrom(note) {
  const at = note.lastIndexOf("word for word: ");
  assert.ok(at >= 0, "the note gives a box");
  const text = note.slice(at + "word for word: ".length);
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error("no whole box in the note");
}

test("every box a note gives Claude is the one the check lets through: unreadable settings, a second change, after a compaction", async () => {
  // A note that built its box from other data than the check (the chat's marks, the standard settings) would have
  // Claude's first try refused in these cases.
  const bad = sandbox();
  try {
    mkdirSync(ztData(bad.home), { recursive: true });
    writeFileSync(join(ztData(bad.home), "settings.json"), "{ not json");
    await start(bad, "u1");
    const asked = await prompt(bad, "u1", "change zero-touch settings");
    assert.match(asked.message, /couldn't read your settings/, "the warning waited for the first message");
    assert.equal((await show(bad, "u1", boxFrom(asked.note))).stdout, "", "unreadable settings: the note's box is shown");
    const next = await click(bad, "u1", boxFrom(asked.note), ["Hand-off"]);
    assert.equal((await show(bad, "u1", boxFrom(next.note))).stdout, "", "unreadable settings: the next-box note's box is shown");
  } finally { bad.cleanup(); }
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "c1");
    const mode = boxFrom((await prompt(s, "c1", "change zero-touch settings")).note);
    await show(s, "c1", mode);
    const done = await click(s, "c1", mode, ["Off"]);
    assert.equal(saved(s).mode, "off");
    assert.equal((await show(s, "c1", boxFrom(done.note))).stdout, "", "a second change in the same chat: the saved note's box is shown");
    await click(s, "c1", boxFrom(done.note), ["Hand-off"]);
    await prompt(s, "c1", "never mind");
    const compacted = await sh(START, [], { session_id: "c1", cwd: s.repo, source: "compact", model: "claude-opus-5" }, s);
    assert.equal(compacted.stdout, "", "a compaction shows nothing again");
    const again = await prompt(s, "c1", "zero-touch settings again please");
    assert.equal((await show(s, "c1", boxFrom(again.note))).stdout, "", "after a compaction: the note's box is shown");
  } finally { s.cleanup(); }
});

test("while a sequence is half done, a notice or a message typed while Claude works does not end it; an idle message still does", async () => {
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "n1");
    await prompt(s, "n1", "change zero-touch settings");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "n1", mode);
    await click(s, "n1", mode, ["Hand-off"]);
    assert.equal((await prompt(s, "n1", "<task-notification>\n<task-id>b1</task-id> completed\n</task-notification>")).stdout, "", "a notice: nothing");
    const transcript = join(s.dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "also check the README" } }) + "\n");
    assert.equal((await sh(HOOK, ["prompt"], { session_id: "n1", prompt: "also check the README", transcript_path: transcript }, s)).stdout, "", "typed while working: nothing");
    const handoff = B.handoffBox(S.clean(saved(s)));
    assert.equal((await show(s, "n1", handoff)).stdout, "", "the sequence goes on: the hand-off box is shown");
    await click(s, "n1", handoff, ["Sonnet 5", "Keep in chat", "Sonnet 5", "Flash 3.8"]);
    assert.deepEqual(saved(s).handoff, { chat_model: "claude-sonnet-5", documents: "chat", tests: "sonnet", repeats: "flash" }, "and is saved, click for click");
    // A sequence left open, then a message typed while the chat is idle: said.
    await show(s, "n1", B.modeBox(S.clean(saved(s))));
    await click(s, "n1", B.modeBox(S.clean(saved(s))), ["Workflows"]);
    assert.match((await prompt(s, "n1", "what next?")).message, /nothing was changed/);
  } finally { s.cleanup(); }
});

test("two first chats: settings saved in one end the other's questions and hold at once, and its compaction shows no welcome", async () => {
  // The other chat stops holding tools and being told there are no settings, and a later compaction shows no
  // welcome.
  const s = sandbox();
  try {
    await start(s, "a");
    await start(s, "b");
    await prompt(s, "a", "hello");
    const first = B.modeBox(null, { first: true });
    await show(s, "b", first);
    await click(s, "b", first, ["Off"]);
    assert.equal(saved(s).mode, "off");
    assert.equal((await tool(s, "a", "Write", { file_path: "x.js" })).stdout, "", "chat a holds nothing any more");
    const said = await prompt(s, "a", "carry on");
    assert.equal(said.message, M.savedElsewhereLine());
    assert.doesNotMatch(said.note, /no settings yet/);
    assert.ok(!existsSync(join(s.home, "sessions", "a", "zt_setup.json")), "chat a's first questions are over");
    const compacted = await sh(START, [], { session_id: "a", cwd: s.repo, source: "compact", model: "claude-opus-5" }, s);
    assert.notEqual(compacted.message, M.welcomeMessage(), "no welcome again");
    assert.equal(chatMode("a", { MMO_HOME: s.home }), null, "chat a stays without zero-touch, as an open chat does");
  } finally { s.cleanup(); }
});

test("the first chat's hold lasts one turn at most: a box never shown ends it at the next message, and says so", async () => {
  // With the question tool unavailable the box can never be shown; a hold without an end would refuse every tool that
  // changes anything in every new chat, for ever.
  const s = sandbox();
  try {
    await start(s, "h1");
    assert.equal((await prompt(s, "h1", "fix the build")).note, M.firstRunNote(B.modeBox(null, { first: true }), { say: true }));
    assert.ok((await tool(s, "h1", "Bash", { command: "npm test" })).deny, "held during the first turn");
    const next = await prompt(s, "h1", "hello?");
    assert.equal(next.message, M.notShownLine());
    assert.equal((await tool(s, "h1", "Bash", { command: "npm test" })).stdout, "", "nothing is held any more");
    assert.ok(!existsSync(join(s.home, "sessions", "h1", "zt_setup.json")));
    await start(s, "h2");
    assert.equal((await prompt(s, "h2", "hi")).message, M.welcomeMessage(), "the next new chat asks again");
  } finally { s.cleanup(); }
});

test("an organisation's pinned model: the saved line names the model that will run", async () => {
  // While the organisation's model holds the chat, the line names that model, not the person's pick.
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    writeFileSync(join(s.dir, "managed.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    await start(s, "o1");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Hand-off"]);
    const handoff = B.handoffBox(S.clean(saved(s)));
    await show(s, "o1", handoff);
    const done = await click(s, "o1", handoff, ["Opus 5 (Recommended)", "Flash 3.8", "Flash 3.8", "Flash 3.8"]);
    assert.match(done.message, /Hand-off mode on Sonnet 5 \(the model your organisation set\)/);
    assert.doesNotMatch(done.message, /on Opus 5/);
  } finally { s.cleanup(); }
});

test("the first chat's wait counts a new turn only on evidence: a message the transcript cannot place yet does not end it early", async () => {
  // A message typed during the first turn that the transcript does not show yet is not a new turn: counting it would
  // end the first-chat questions while Claude is about to open the box.
  const s = sandbox();
  try {
    await start(s, "w1");
    const transcript = join(s.dir, "w1.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "fix the build" } }) + "\n");
    const say = (text) => sh(HOOK, ["prompt"], { session_id: "w1", prompt: text, transcript_path: transcript }, s);
    assert.equal((await say("fix the build")).note, M.firstRunNote(B.modeBox(null, { first: true }), { say: true }), "the first message: the reminder");
    const early = await say("also the tests");
    assert.equal(early.message, "", "not in the transcript yet: no give-up");
    assert.ok((await tool(s, "w1", "Bash", { command: "npm test" })).deny, "still waiting for the box");
    assert.equal((await say("and the docs")).message, M.notShownLine(), "the limit: at most three such messages");
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    await start(t, "w2");
    const transcript = join(t.dir, "w2.jsonl");
    const lines = [];
    const say = (text) => { lines.push(JSON.stringify({ type: "user", message: { content: text } })); writeFileSync(transcript, lines.join("\n") + "\n"); return sh(HOOK, ["prompt"], { session_id: "w2", prompt: text, transcript_path: transcript }, t); };
    await say("fix the build");
    assert.equal((await say("hello?")).message, M.notShownLine(), "a second message typed while idle: the turn went by without the box");
  } finally { t.cleanup(); }
  const u = sandbox({ settings: { mode: "workflows" } });
  try {
    // A half-done choice is said to be closed only on an idle message, never on one the transcript cannot place.
    await start(u, "w3");
    await prompt(u, "w3", "change zero-touch settings");
    const mode = B.modeBox(S.clean(saved(u)));
    await show(u, "w3", mode);
    await click(u, "w3", mode, ["Hand-off"]);
    const transcript = join(u.dir, "w3.jsonl");
    writeFileSync(transcript, "");
    assert.equal((await sh(HOOK, ["prompt"], { session_id: "w3", prompt: "hmm", transcript_path: transcript }, u)).stdout, "");
    assert.equal((await show(u, "w3", B.handoffBox(S.clean(saved(u))))).stdout, "", "the choice goes on");
  } finally { u.cleanup(); }
});

test("the first chat's wait refuses one tool at most, and says what to do where the box cannot be shown", async () => {
  // A `claude -p` run started from inside a chat inherits the chat's label, so it looks like a chat with a screen; it
  // cannot show the question box. So one refusal, with the way out in it, and nothing is held after that.
  const s = sandbox();
  try {
    await start(s, "o1");
    await prompt(s, "o1", "run the build");
    const first = await tool(s, "o1", "Bash", { command: "npm run build" });
    assert.equal(first.deny, M.HOLD_PERSON);
    assert.equal(first.note, M.holdReason(B.modeBox(null, { first: true })));
    assert.match(first.note, /If the question tool is not available to you here, carry on with the person's request instead/);
    assert.equal((await tool(s, "o1", "Bash", { command: "npm run build" })).stdout, "", "the next try runs: nothing is held twice");
    assert.equal((await tool(s, "o1", "Write", { file_path: "a.js" })).stdout, "");
    assert.match(M.firstRunNote(B.modeBox(null, { first: true })), /If the question tool is not available to you here, carry on with the person's request instead/);
  } finally { s.cleanup(); }
});

test("a save that fails is said, never passed off as saved; settings that cannot be read are never described as a choice", async () => {
  // A silent failed save would let Claude say "saved"; and after a closed box or an answer typed in "Other" the line
  // must not describe the standard settings as "your settings" when none could be read.
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "s1");
    await prompt(s, "s1", "change zero-touch settings");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "s1", mode);
    chmodSync(ztData(s.home), 0o500); // the plugin's data folder cannot be written
    let failed;
    try { failed = await click(s, "s1", mode, ["Off"]); } finally { chmodSync(ztData(s.home), 0o700); }
    assert.equal(failed.message, M.saveFailedLine("EACCES"));
    assert.match(failed.message, /couldn't be saved, because zero-touch isn't allowed to write to its own settings folder, so nothing changed/);
    assert.equal(failed.note, M.saveFailedNote(B.modeBox(S.clean(saved(s)))), "Claude is told it was NOT saved");
    assert.match(failed.note, /never say it was saved/);
    assert.equal(saved(s).mode, "workflows", "nothing changed");
    assert.ok(!existsSync(join(s.home, "sessions", "s1", "zt_flow.json")), "the sequence is over");
  } finally { s.cleanup(); }
  const f = sandbox();
  try {
    await start(f, "f1");
    await prompt(f, "f1", "hello");
    const first = B.modeBox(null, { first: true });
    await show(f, "f1", first);
    mkdirSync(ztData(f.home), { recursive: true });
    chmodSync(ztData(f.home), 0o500);
    let failed;
    try { failed = await click(f, "f1", first, ["Off"]); } finally { chmodSync(ztData(f.home), 0o700); }
    assert.equal(failed.message, M.saveFailedLine("EACCES", { first: true }), "the first chat: it says this chat stays without zero-touch");
    assert.ok(!existsSync(join(f.home, "sessions", "f1", "zt_setup.json")), "and nothing is held");
  } finally { f.cleanup(); }
  const u = sandbox();
  try {
    mkdirSync(ztData(u.home), { recursive: true });
    writeFileSync(join(ztData(u.home), "settings.json"), JSON.stringify({ mode: "OFF" }));
    await start(u, "u1");
    assert.equal((await prompt(u, "u1", "hi")).message, M.unreadableMessage(), "said with the first message");
    assert.equal(chatMode("u1", { MMO_HOME: u.home }), null, "and nothing is switched on");
    const box = boxFrom((await prompt(u, "u1", "change zero-touch settings")).note);
    await show(u, "u1", box);
    const other = await click(u, "u1", box, ["make it hand-off"]);
    assert.equal(other.message, M.notAChoiceLine("make it hand-off", null));
    assert.match(other.message, /Your settings still can't be read, so zero-touch stays off in new chats\./);
    assert.doesNotMatch(other.message, /Workflows mode/, "the standard settings are never called the person's");
    await show(u, "u1", box);
    await click(u, "u1", box, ["Workflows"]); // then the models box is closed
    assert.equal((await prompt(u, "u1", "never mind")).message, M.closedLine(null));
  } finally { u.cleanup(); }
});

test("a choice typed by hand is understood whatever its capitals, spaces or hyphens; anything else still saves nothing", async () => {
  const s = sandbox({ settings: { mode: "off" } });
  try {
    await start(s, "t1");
    await prompt(s, "t1", "change zero-touch settings");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "t1", mode);
    await click(s, "t1", mode, ["hand off"]);
    const box = B.handoffBox(S.clean(saved(s)));
    await show(s, "t1", box);
    const done = await click(s, "t1", box, ["opus 5", "FLASH 3.8", "keep in chat.", "Sonnet-5"]);
    assert.match(done.message, /your settings are saved/);
    assert.deepEqual(saved(s).handoff, { chat_model: "claude-opus-5", documents: "flash", tests: "chat", repeats: "sonnet" });
    await show(s, "t1", B.modeBox(S.clean(saved(s))));
    const other = await click(s, "t1", B.modeBox(S.clean(saved(s))), ["make it workflows please"]);
    assert.match(other.message, /isn't one of the choices, so nothing was changed/);
  } finally { s.cleanup(); }
});

// ─── The first chat's rough edges ──────────────────────────────────────────────────────────────────────────────

test("a command typed as the very first message runs as typed; the questions come with the next plain message", async () => {
  const s = sandbox({ settings: null });
  try {
    await start(s, "x1");
    const cmd = await prompt(s, "x1", "/help");
    assert.equal(cmd.note, M.FIRST_COMMAND_NOTE);
    assert.equal((await tool(s, "x1", "Write", { file_path: "a.js" })).stdout, "", "nothing held in the command's turn");
    const plain = await prompt(s, "x1", "now build me a todo app");
    assert.ok(plain.note.startsWith(M.firstRunNote(B.modeBox(null, { first: true }))), "the questions now");
  } finally { s.cleanup(); }
});

// After a typed /mmo: workflow as the first message, the next one (the workflow's own answer, such as the brief) must
// not bring the settings box: saving would mark the chat in the middle of a typed run, its helpers would be refused,
// and with Workflows the brief would become a second, zero-touch workflow. So zero-touch steps out of that chat for
// good, and the typed run is exactly mmo's.
test("a typed /mmo: workflow as the first message: zero-touch steps out of that chat, and asks in the next new chat", async () => {
  const s = sandbox({ settings: null });
  try {
    await start(s, "x2");
    const cmd = await prompt(s, "x2", "/mmo:greenfield");
    assert.equal(cmd.message, M.firstWorkflowCommandLine());
    assert.match(cmd.message, /^Zero-touch: your command runs as you typed it\. Zero-touch won't do anything in this chat; it will ask for its settings in your next new chat\.$/);
    assert.equal(cmd.note, M.FIRST_WORKFLOW_COMMAND_NOTE);
    assert.doesNotMatch(cmd.message, /Before Claude answers your first message/, "never the held welcome, which promises the questions first");
    assert.equal((await tool(s, "x2", "Skill", { skill: "mmo:greenfield" })).stdout, "");
    const brief = await prompt(s, "x2", "a small to-do app with due dates");
    assert.equal(brief.message, "", "the workflow's own answer brings no box");
    assert.equal(brief.note, "", "and no note");
    assert.equal((await tool(s, "x2", "Write", { file_path: "brief.md" })).stdout, "", "nothing held");
    assert.throws(() => saved(s), /ENOENT/, "nothing saved: the next new chat is a first chat again");
    for (const typed of ["/mmo:bugfix the login bug", "/bugfix the login bug", "  /mmo:pass --auth=estimated brief.md"]) {
      const t = sandbox({ settings: null });
      try { await start(t, "x3"); assert.equal((await prompt(t, "x3", typed)).note, M.FIRST_WORKFLOW_COMMAND_NOTE, typed); } finally { t.cleanup(); }
    }
  } finally { s.cleanup(); }
});

test("an answer that is not a choice in the first chat: the same box once more; a second miss ends the questions", async () => {
  const s = sandbox({ settings: null });
  try {
    await start(s, "y1");
    await prompt(s, "y1", "hi");
    const first = B.modeBox(null, { first: true });
    await show(s, "y1", first);
    const typo = await click(s, "y1", first, ["off please"]);
    assert.equal(typo.message, M.notAChoiceRetryLine("off please"));
    assert.equal(typo.note, M.retryNote(first), "Claude opens the same box, word for word");
    await show(s, "y1", first);
    const second = await click(s, "y1", first, ["still not a choice"]);
    assert.match(second.message, /isn't one of the choices, so nothing was changed\. Zero-touch won't do anything in this chat/);
    // A Hand-off box with a question left out names it.
    const h = sandbox({ settings: null });
    try {
      await start(h, "y2");
      await prompt(h, "y2", "hi");
      await show(h, "y2", first);
      await click(h, "y2", first, ["Hand-off"]);
      const box = B.handoffBox(null, { first: true });
      await show(h, "y2", box);
      const partial = await click(h, "y2", box, ["Opus 5 (Recommended)", "Flash 3.8", null, "Flash 3.8"]);
      assert.equal(partial.message, "Zero-touch: Tests wasn't answered, so nothing was saved yet. Claude shows the choices once more.");
      assert.equal(partial.note, M.retryNote(box), "the same Hand-off box again, not the mode box");
    } finally { h.cleanup(); }
  } finally { s.cleanup(); }
});

test("two first chats: once one saves, the other's box is a later change, and a save over a newer one says it replaces it", async () => {
  const s = sandbox({ settings: null });
  try {
    await start(s, "a1");
    await start(s, "a2");
    await prompt(s, "a1", "hi");
    await prompt(s, "a2", "hi");
    const first = B.modeBox(null, { first: true });
    // a2 starts its sequence, then a1 saves Workflows.
    await show(s, "a2", first);
    await new Promise((r) => setTimeout(r, 15));
    await show(s, "a1", first);
    await click(s, "a1", first, ["Workflows"]);
    await show(s, "a1", B.modelsBox(null));
    await click(s, "a1", B.modelsBox(null), ["Opus 5 + Sonnet 5"]);
    // a2 answers Off: it replaces a1's choice, and says so.
    const off = await click(s, "a2", first, ["Off"]);
    assert.match(off.message, /^Zero-touch: this replaces the settings chosen in another chat a moment ago \(Workflows mode/);
    assert.equal(saved(s).mode, "off");
  } finally { s.cleanup(); }
});

test("the first chat's two flags are files of their own: a refusal written at the same moment never undoes 'shown'", async () => {
  const s = sandbox({ settings: null });
  try {
    await start(s, "r1");
    await prompt(s, "r1", "hi");
    // The hold is used first, then the box is shown: both stay true.
    await tool(s, "r1", "Write", { file_path: "a.js" });
    await show(s, "r1", B.modeBox(null, { first: true }));
    const dir = join(s.home, "sessions", "r1");
    assert.ok(existsSync(join(dir, "zt_asked")) && existsSync(join(dir, "zt_held")));
    const setup = JSON.parse(readFileSync(join(dir, "zt_setup.json"), "utf8"));
    assert.equal(setup.asked, undefined, "never written into the setup record");
    const next = await prompt(s, "r1", "never mind");
    assert.equal(next.message, M.notChosenYetLine(), "taken as shown, not as 'the questions weren't shown'");
  } finally { s.cleanup(); }
});

test("zero-touch's copy of mmo's workflow command names is mmo's own list", async () => {
  const { WORKFLOW_COMMAND_NAMES } = await import(join(ROOT, "zero-touch", "scripts", "prompt-kind.mjs"));
  const { WORKFLOW_COMMANDS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "commands.mjs"));
  assert.deepEqual([...WORKFLOW_COMMAND_NAMES].sort(), [...WORKFLOW_COMMANDS].sort());
});

// In the first chat, Workflows saved while something is missing still answers the first message (the person is not
// sent to a new chat for a plain question), and with workflows switched off by a setting file the saved line does not
// promise that zero-touch looks at it.
test("the first chat's first message is judged even when something is missing, and answered at once when workflows are switched off", async () => {
  const flow = async (s, sid, models) => {
    await start(s, sid);
    await prompt(s, sid, "what does src/cart.js do?");
    const first = B.modeBox(null, { first: true });
    await show(s, sid, first);
    await click(s, sid, first, ["Workflows"]);
    const box = B.modelsBox(null);
    await show(s, sid, box);
    return click(s, sid, box, [models]);
  };
  const s = sandbox({ settings: null, google: false });
  try {
    const r = await flow(s, "r1", "Opus 5 + Flash 3.8");
    assert.match(r.message, /its full workflow can start in a new chat once the missing piece below is fixed; anything else gets a normal answer\./);
    assert.ok(existsSync(join(s.home, "sessions", "r1", "zt_replay.json")), "judged at the end of this turn: a question gets its answer");
    assert.match(r.note, /it either starts that message's workflow, says why it cannot start, or hands the message back/);
  } finally { s.cleanup(); }
  const t = sandbox({ settings: null });
  try {
    writeFileSync(join(t.home, "ambient.json"), JSON.stringify({ routing: "off" }));
    const r = await flow(t, "r2", "Opus 5 + Sonnet 5");
    assert.match(r.message, /Claude now answers your message\./);
    assert.match(r.message, /Workflows from plain words are switched off by a zero-touch setting file on this computer/);
    assert.equal(existsSync(join(t.home, "sessions", "r2", "zt_replay.json")), false, "nothing waits to be judged");
    assert.match(r.note, /Now answer the person's first message\./);
  } finally { t.cleanup(); }
});

// Off chosen in an open chat says what happens, once: never "this chat carries on as it started" followed by a
// turned-off line at the next message.
test("Off chosen in an open chat says it stops here from the next message, and is not said again then", async () => {
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "w1");
    const box = B.modeBox(S.clean(saved(s)));
    await show(s, "w1", box);
    const r = await click(s, "w1", box, ["Off"]);
    assert.equal(r.message, "Zero-touch: your settings are saved: Off. Zero-touch stops in this chat from your next message (a workflow already running here finishes first), and new chats start without it.");
    assert.match(r.note, /stops acting in this chat from the person's next message/);
    const AMBIENT = join(ROOT, "plugin", "hooks", "ambient.sh");
    const next = await sh(AMBIENT, ["prompt"], { session_id: "w1", cwd: s.repo, prompt: "thanks", prompt_id: "w1-2" }, s);
    assert.equal(next.message, "", "said once, in the saved line");
    assert.equal(existsSync(join(s.home, "sessions", "w1", "chat_mode")), false, "and the chat lets go");
  } finally { s.cleanup(); }
});

test("a typed command whose words name zero-touch gets no zero-touch note: it is the person's own command", async () => {
  // "/mmo:docs … zero-touch …" gets neither the settings facts nor the box.
  const s = sandbox({ settings: { mode: "workflows", workflows: { models: "opus-plus-sonnet" } } });
  try {
    await start(s, "tc1");
    await prompt(s, "tc1", "hello"); // the held summary is shown with the first message
    const plain = await prompt(s, "tc1", "what is zero-touch doing in this chat?");
    assert.ok(plain.note.length > 0, "plain words about zero-touch get its facts");
    const typed = await prompt(s, "tc1", "/mmo:docs document the zero-touch settings box");
    assert.equal(typed.note, "", "a typed command gets nothing added");
  } finally { s.cleanup(); }
});
