/**
 * What zero-touch shows at a chat's start, where, and how often; and what Claude is told when the person names
 * zero-touch.
 *
 * Why: the desktop app never shows a start hook's message. The welcome, the mode summary, "Google isn't connected",
 * "Node.js isn't installed" and every other start line would be invisible there, and a line marked as said there
 * would never be seen. The terminal has the opposite problem to avoid: the same long summary at every new chat, every
 * /clear, every compaction and every reopen, Off included, and the settings box given to Claude in every chat whether
 * or not anyone asked.
 *
 * The rules this test holds:
 *   - Where: the terminal shows the start lines at once; everywhere else (the desktop app, a screen this code does not
 *     know) they wait for the chat's first message and show with it, once. A notice Claude Code queues does not use
 *     them up.
 *   - How often: the summary of the saved settings once per save, recorded as shown only when it was; after that,
 *     only lines that need the person's action, in every chat; Off and a compaction or a reopened chat say nothing.
 *   - Claude gets the facts of this chat and the settings box when, and only when, the person names zero-touch; a
 *     plain message does not even start node.
 *   - Node.js older than zero-touch needs: the chat stays plain and the person is told, in every chat.
 *
 * Every case runs the plugin's real shell scripts, with its own home, data folder and project. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const HOOK = join(ZT, "hooks", "settings.sh");
const M = await import(join(ZT, "scripts", "messages.mjs"));
const B = await import(join(ZT, "scripts", "boxes.mjs"));
const S = await import(join(ZT, "scripts", "settings.mjs"));
const { writeGoogleLogin, writeZtSettings, ztData, fakeClaudeBin } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
// A stand-in `claude` first: a real install has the command, and the setup check says when it is missing.
const BASE_PATH = `${fakeClaudeBin()}:${dirname(process.execPath)}:/usr/bin:/bin`;
const DESKTOP = "claude-desktop";

function sandbox({ settings = { mode: "workflows" }, google = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zt-lines-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (settings) writeZtSettings(home, settings, { google });
  else if (google) writeGoogleLogin(home);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sh(s, script, args, payload, env = {}) {
  const r = spawnSync("sh", [script, ...args], {
    input: JSON.stringify(payload), encoding: "utf8", cwd: s.repo,
    env: { PATH: BASE_PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home), CLAUDE_PROJECT_DIR: s.repo, MMO_MANAGED_SETTINGS: join(s.dir, "managed.json"), ...env },
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* left null */ }
  return { code: r.status, stdout: r.stdout, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "", event: json?.hookSpecificOutput?.hookEventName ?? null };
}
// The chat-model line of a chat that starts on Opus 5, the model the workflow models plan with.
const ON_OPUS_5 = M.workflowModelLine("opus-plus-flash-v38", { model: "claude-opus-5" }).line;
/** A chat's start; `label` is Claude Code's CLAUDE_CODE_ENTRYPOINT (none: the terminal). */
const start = (s, sid, { label, source = "startup", env = {} } = {}) => sh(s, START, [], { session_id: sid, cwd: s.repo, source, model: "claude-opus-5" }, { ...(label ? { CLAUDE_CODE_ENTRYPOINT: label } : {}), ...env });
const prompt = (s, sid, text = "hi", { label, extra = {}, env = {} } = {}) => sh(s, HOOK, ["prompt"], { session_id: sid, prompt: text, ...extra }, { ...(label ? { CLAUDE_CODE_ENTRYPOINT: label } : {}), ...env });
const waiting = (s, sid) => join(s.home, "sessions", sid, "zt_say.json");
const NOTICE = "<task-notification>\n<task-id>b1</task-id> completed\n</task-notification>";

test("where the start lines go: at once in the terminal; with the first message everywhere else, once; a notice does not use them up", () => {
  const summary = M.workflowMessage({ policy: "opus-plus-flash-v38", modelLine: ON_OPUS_5 });
  // A script's run (sdk-cli) is left exactly as Claude Code alone: nothing marked, nothing said.
  { const s = sandbox(); try { assert.equal(start(s, "c0", { label: "sdk-cli" }).message, ""); } finally { s.cleanup(); } }
  for (const label of [undefined, "cli"]) {
    const s = sandbox();
    try {
      const r = start(s, "c1", { label });
      assert.equal(r.message, summary, `${label ?? "no label"}: shown at the start`);
      assert.ok(!existsSync(waiting(s, "c1")), `${label ?? "no label"}: nothing waits`);
      assert.equal(prompt(s, "c1", "hi", { label }).stdout, "", `${label ?? "no label"}: not again at the first message`);
    } finally { s.cleanup(); }
  }
  for (const label of [DESKTOP, "claude-vscode"]) {
    const s = sandbox();
    try {
      const r = start(s, "c1", { label });
      assert.equal(r.message, "", `${label}: nothing at the start, where it would not show`);
      assert.ok(existsSync(waiting(s, "c1")), `${label}: the lines wait`);
      assert.equal(prompt(s, "c1", NOTICE, { label }).stdout, "", `${label}: a notice shows nothing`);
      assert.ok(existsSync(waiting(s, "c1")), `${label}: and does not use them up`);
      const first = prompt(s, "c1", "hello", { label });
      assert.equal(first.message, summary, `${label}: the same words, with the first message`);
      assert.equal(first.event, null, "a line for the person only: no note for Claude");
      assert.ok(!existsSync(waiting(s, "c1")));
      assert.equal(prompt(s, "c1", "and again", { label }).stdout, "", `${label}: once`);
    } finally { s.cleanup(); }
  }
});

test("the summary shows once per save, and counts as shown only once a person could see it", () => {
  const s = sandbox();
  try {
    start(s, "a", { label: DESKTOP }); // opened, never typed in
    start(s, "b", { label: DESKTOP });
    assert.ok(existsSync(waiting(s, "b")), "a was never seen, so b still has the summary waiting");
    assert.match(prompt(s, "b", "hello", { label: DESKTOP }).message, /^Zero-touch is on in this chat: Workflows mode\./);
    start(s, "c", { label: DESKTOP });
    assert.ok(!existsSync(waiting(s, "c")), "seen in b: c has nothing waiting");
    assert.equal(prompt(s, "c", "hello", { label: DESKTOP }).stdout, "");
    assert.equal(start(s, "t").stdout, "", "a terminal chat after that: nothing");
    assert.equal(chatMode("t", { MMO_HOME: s.home }), "on", "and it is marked all the same");
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-only-v5" } });
    // The model line names the models chosen, so it is the new save's own.
    assert.equal(start(s, "t2").message, M.workflowMessage({ policy: "opus-only-v5", modelLine: M.workflowModelLine("opus-only-v5", { model: "claude-opus-5" }).line }), "a new save: shown once more");
    assert.equal(start(s, "t3").stdout, "");
  } finally { s.cleanup(); }
});

test("after the summary, only what needs the person's action, in every chat; Off, a compaction and a reopened chat say nothing", () => {
  const s = sandbox({ google: false });
  try {
    const first = start(s, "g1");
    assert.match(first.message, /^Zero-touch is on in this chat: Workflows mode\./);
    assert.match(first.message, /Google's Flash 3\.8 can't be used yet/);
    const later = start(s, "g2");
    const lines = later.message.split("\n");
    assert.equal(lines.length, 2, "the mode in one line, and the one thing to act on");
    assert.equal(lines[0], "Zero-touch is on in this chat: Workflows mode.");
    assert.match(lines[1], /^• Google's Flash 3\.8 can't be used yet, because this computer isn't connected to Google\. Until it is, workflows won't start\./);
    assert.equal(later.message, M.warningsMessage({ mode: "on" }, [lines[1]]));
    for (const source of ["compact", "resume"]) assert.equal(start(s, "g2", { source }).stdout, "", `${source}: nothing again`);
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    start(s, "n1");
    assert.equal(start(s, "n2").stdout, "", "models without Flash: nothing needs action, nothing is said");
  } finally { s.cleanup(); }
  const off = sandbox({ settings: { mode: "off" } });
  try {
    for (const label of [undefined, DESKTOP]) {
      const sid = `o-${label ?? "cli"}`;
      assert.equal(start(off, sid, { label }).stdout, "", `${label ?? "terminal"}: Off says nothing`);
      assert.equal(prompt(off, sid, "hello", { label }).stdout, "", `${label ?? "terminal"}: not at the first message either`);
      assert.equal(start(off, sid, { label, source: "compact" }).stdout, "");
      assert.ok(!existsSync(join(off.home, "sessions", sid)), "and an Off chat leaves nothing behind");
    }
  } finally { off.cleanup(); }
});

test("the first chat after install: a compaction gives Claude the note again and shows no welcome; with the mmo plugin off, the line waits like the rest", () => {
  const s = sandbox({ settings: null });
  try {
    assert.equal(start(s, "f1").message, M.welcomeMessage(), "the terminal: the welcome at the start");
    const compacted = start(s, "f1", { source: "compact" });
    assert.equal(compacted.message, "", "no welcome again");
    assert.equal(compacted.note, M.firstRunNote(B.modeBox(null, { first: true })), "the note again: a compaction dropped it");
  } finally { s.cleanup(); }
  const m = sandbox();
  try {
    const config = join(m.dir, "claude-config");
    mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@tilicho-ai-labs": false } }));
    const started = start(m, "m1", { label: DESKTOP, env: { CLAUDE_CONFIG_DIR: config } });
    assert.equal(started.message, "", "nothing shown at the start on the desktop app: it would not be seen");
    assert.equal(started.note, M.MMO_UNAVAILABLE_NOTE, "Claude is told zero-touch cannot act here");
    assert.equal(prompt(m, "m1", "hello", { label: DESKTOP }).message, M.mmoMissingMessage(), "said with the first message");
    assert.equal(chatMode("m1", { MMO_HOME: m.home }), null);
  } finally { m.cleanup(); }
});

/** The box a note gives Claude (the last "word for word: " in it), parsed back from the note's text. */
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

test("naming zero-touch gives Claude this chat's facts and the settings box; a plain message gives nothing and does not even start node", () => {
  const s = sandbox();
  try {
    // A node that leaves a mark each time it starts, then runs the real one: how often the message hook needs node.
    const bin = join(s.dir, "bin");
    mkdirSync(bin);
    const marks = join(s.dir, "node-starts");
    writeFileSync(join(bin, "node"), `#!/bin/sh\necho x >> "${marks}"\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(bin, "node"), 0o755);
    const counted = { PATH: `${bin}:/usr/bin:/bin` };
    start(s, "w1");
    const starts = () => (existsSync(marks) ? readFileSync(marks, "utf8").split("\n").filter(Boolean).length : 0);
    const before = starts();
    assert.equal(prompt(s, "w1", "fix the login bug", { env: counted }).stdout, "", "a plain message: nothing");
    assert.equal(starts(), before, "and node never started for it");

    const asked = prompt(s, "w1", "Is Zero Touch on here? which models?", { env: counted });
    assert.equal(starts(), before + 1, "a message naming zero-touch starts node once");
    assert.match(asked.note, /^In this chat zero-touch is on, set when the chat started: Workflows mode, Opus 5 \+ Flash 3\.8\. A request for one of these jobs starts a full workflow: build a new app, /);
    assert.match(asked.note, /The saved zero-touch settings, which apply from the person's next new chat: Workflows mode, Opus 5 \+ Flash 3\.8\./);
    assert.deepEqual(boxFrom(asked.note), B.modeBox(S.clean({ mode: "workflows" })), "the box the check lets through");
    assert.equal(asked.message, "", "nothing shown to the person: Claude answers");

    writeZtSettings(s.home, { mode: "off" });
    assert.match(prompt(s, "w1", "turn off zerotouch").note, /set when the chat started: Workflows mode.*apply from the person's next new chat: Off\./s, "this chat and new chats told apart");
    start(s, "o1");
    assert.match(prompt(s, "o1", "is zero-touch on?").note, /^Zero-touch is not active in this chat: it was off, or had no settings yet, when the chat started\. The saved zero-touch settings, which apply from the person's next new chat: Off\./);

    const transcript = join(s.dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "change zero-touch settings" } }) + "\n");
    assert.match(prompt(s, "w1", "change zero-touch settings", { extra: { transcript_path: transcript } }).note, /Zero-touch settings: if the person asks/, "typed while Claude works: still given");
    assert.equal(prompt(s, "w1", `${NOTICE}\nzero-touch`).stdout, "", "a notice that happens to name it: nothing");
    assert.equal(prompt(s, "w1", "the zero touchscreen driver is broken").stdout, "", "a word that only starts the same way: nothing");
  } finally { s.cleanup(); }
  const f = sandbox({ settings: null });
  try {
    start(f, "f1");
    const first = prompt(f, "f1", "change zero-touch settings");
    assert.equal(first.note, M.firstRunNote(B.modeBox(null, { first: true })), "the first chat after install: its own note only, so Claude is given one box");
  } finally { f.cleanup(); }
});

test("Node.js older than zero-touch needs: the chat stays plain and the person is told in every chat, where they can see it", () => {
  const s = sandbox({ settings: null });
  try {
    // An old Node.js, as the scripts see it: the version they read is the one this preload reports.
    const preload = join(s.dir, "old-node.mjs");
    writeFileSync(preload, 'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.19.0" } });\n');
    const old = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    const r = start(s, "n1", { env: old });
    assert.equal(r.message, M.nodeOldMessage("18.19.0", 20));
    assert.equal(r.note, M.nodeOldNote("18.19.0", 20));
    assert.match(r.message, /too old \(version 18\.19\.0; zero-touch needs version 20 or newer\)/);
    assert.ok(!existsSync(join(s.home, "sessions", "n1", "zt_setup.json")), "no first-chat questions: they could not be acted on");
    writeZtSettings(s.home, { mode: "workflows" });
    start(s, "n2", { env: old });
    assert.equal(chatMode("n2", { MMO_HOME: s.home }), null, "settings or not, the chat is not marked");
    const desk = start(s, "n3", { label: DESKTOP, env: old });
    assert.equal(desk.message, "", "the desktop app: nothing for the person at the start, where it would not show");
    assert.equal(desk.note, M.nodeOldNote("18.19.0", 20), "Claude's note goes at the start on every screen");
    assert.equal(prompt(s, "n3", "hello", { label: DESKTOP, env: old }).message, M.nodeOldMessage("18.19.0", 20), "the desktop app: with the first message");
    assert.equal(start(s, "n4").message, M.workflowMessage({ policy: "opus-plus-flash-v38", modelLine: ON_OPUS_5 }), "with a new enough Node.js, the next chat is marked as usual");
  } finally { s.cleanup(); }
});

test("settings that cannot be used: the last good save is used and said in every chat; with none, zero-touch is off and says so", () => {
  // Such a file never switches a chat to paid Workflows, Off included.
  const s = sandbox({ settings: { mode: "off" } });
  try {
    S.writeSettings({ mode: "handoff", handoff: { documents: "sonnet", tests: "chat", repeats: "chat" } }, { CLAUDE_PLUGIN_DATA: ztData(s.home), MMO_HOME: s.home });
    writeFileSync(join(ztData(s.home), "settings.json"), "{ damaged");
    const r = start(s, "r1");
    assert.equal(chatMode("r1", { MMO_HOME: s.home }), "b", "the last good save: Hand-off");
    const restored = M.restoredLine(S.readSettings({ CLAUDE_PLUGIN_DATA: ztData(s.home) }).settings);
    assert.match(restored, /using the last settings you saved: Hand-off mode on Opus 5; documents go to Sonnet 5, tests stay in the chat, repeated changes stay in the chat\./);
    assert.equal(r.message, M.warningsMessage({ mode: "b" }, [restored]));
    assert.equal(start(s, "r2").message, r.message, "every chat, until the person chooses again");
    S.writeSettings({ mode: "off" }, { CLAUDE_PLUGIN_DATA: ztData(s.home), MMO_HOME: s.home });
    writeFileSync(join(ztData(s.home), "settings.json"), JSON.stringify({ mode: "none" }));
    assert.equal(start(s, "r3").message, M.warningsMessage({ mode: "off" }, [M.restoredLine({ mode: "off" })]), "Off from the last good save: said too");
    assert.equal(chatMode("r3", { MMO_HOME: s.home }), null);
    rmSync(join(ztData(s.home), "settings.last-good.json"));
    assert.equal(start(s, "r4").message, M.unreadableMessage(), "no last good save: off, and said");
    assert.equal(chatMode("r4", { MMO_HOME: s.home }), null);
  } finally { s.cleanup(); }
});
