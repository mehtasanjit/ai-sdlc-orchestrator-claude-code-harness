/**
 * Zero-touch's four hand-off tools are listed only where a Hand-off chat can use them (src/handoff/listing.ts).
 *
 * Why: their descriptions are about 1,600 tokens, given to the model with every message in every chat where the mmo
 * plugin is on, also for people who never installed zero-touch. Claude Code does not tell a server which chat it
 * serves, so the rule reads what Claude Code and zero-touch keep on disk; when in doubt it lists them. A saved mode
 * that later becomes Hand-off adds them while the server runs, and Claude Code is told
 * (notifications/tools/list_changed; Claude Code then lists the tools again at once).
 *
 * Offline: temporary folders; the last test runs the built server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { handoffListing, dataFolderName } = await import(join(ROOT, "dist", "handoff", "listing.js"));
const HANDOFF = ["repeat_edit_across_files", "undo_hand_off", "write_document", "write_tests_from_cases"];

/** A machine: Claude Code's folder, a project, and what is installed, switched on and saved. */
function machine({ installed = { "mmo@m": [{}], "zero-touch@m": [{}] }, user = {}, project = null, local = null, managed = null, saved, raw } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-listing-"));
  const config = join(dir, "claude");
  const repo = join(dir, "repo");
  mkdirSync(join(config, "plugins"), { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  if (installed !== "none") writeFileSync(join(config, "plugins", "installed_plugins.json"), installed === "garbage" ? "{ nope" : JSON.stringify({ version: 2, plugins: installed }));
  writeFileSync(join(config, "settings.json"), JSON.stringify(user));
  if (project) writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(project));
  if (local) writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify(local));
  const managedFile = join(dir, "managed.json");
  if (managed) writeFileSync(managedFile, JSON.stringify(managed));
  const data = join(config, "plugins", "data", dataFolderName("zero-touch@m"));
  const settingsFile = join(data, "settings.json");
  const save = (value) => { mkdirSync(data, { recursive: true }); const tmp = settingsFile + ".tmp"; writeFileSync(tmp, typeof value === "string" ? value : JSON.stringify(value)); renameSync(tmp, settingsFile); };
  if (saved !== undefined) save(saved);
  if (raw !== undefined) save(raw);
  // MMO_HOME inside the sandbox: the listing reads the chats' hand-off records, so it reads these, never the real ones.
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: repo, MMO_MANAGED_SETTINGS: managedFile, MMO_HOME: join(dir, ".mmo-ambient") };
  return { dir, env, save, settingsFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function decide(opts) {
  const m = machine(opts);
  try { return handoffListing(m.env); } finally { m.cleanup(); }
}

test("not listed where a Hand-off chat cannot exist: zero-touch not installed, or switched off at the scope that decides", () => {
  assert.deepEqual(decide({ installed: { "mmo@m": [{}] } }), { list: false, reason: "no-zero-touch", watch: [] }, "mmo alone: never");
  assert.equal(decide({ user: { enabledPlugins: { "zero-touch@m": false } } }).reason, "zero-touch-off");
  // The project's own files, then the organisation's, decide before the user's.
  assert.equal(decide({ user: { enabledPlugins: { "zero-touch@m": true } }, local: { enabledPlugins: { "zero-touch@m": false } } }).list, false, "switched off for this project");
  assert.equal(decide({ user: { enabledPlugins: { "zero-touch@m": false } }, project: { enabledPlugins: { "zero-touch@m": true } } }).list, true, "switched on for this project");
  assert.equal(decide({ project: { enabledPlugins: { "zero-touch@m": true } }, managed: { enabledPlugins: { "zero-touch@m": false } } }).list, false, "the organisation decides first");
});

test("listed where a Hand-off chat may be: Hand-off saved, or nothing chosen yet (the first chat may choose it)", () => {
  assert.deepEqual(decide({ saved: { version: 1, mode: "handoff" } }), { list: true, reason: "handoff", watch: [] });
  assert.equal(decide({}).reason, "not-chosen", "installed, switched on, nothing saved");
  assert.equal(decide({ user: { enabledPlugins: { "zero-touch@m": true } } }).list, true);
});

test("Workflows or Off saved: not listed, and the settings file is watched for a change to Hand-off", () => {
  for (const mode of ["workflows", "off"]) {
    const m = machine({ saved: { version: 1, mode } });
    try {
      assert.deepEqual(handoffListing(m.env), { list: false, reason: "other-mode", watch: [m.settingsFile] }, mode);
    } finally { m.cleanup(); }
  }
});

test("when in doubt about the install, listed where zero-touch has run; a setup without it lists nothing", () => {
  // A developer's clone or --plugin-dir setup without zero-touch lists none of the four tools.
  assert.deepEqual(decide({ installed: "none" }), { list: false, reason: "no-zero-touch", watch: [] }, "no record and no zero-touch data folder");
  assert.equal(decide({ installed: "garbage" }).list, false);
  // Zero-touch has a data folder here (it has run): when in doubt, listed.
  assert.equal(decide({ installed: "none", saved: { version: 1, mode: "workflows" } }).reason, "unreadable", "no record of installed plugins");
  assert.equal(decide({ installed: "garbage", saved: { version: 1, mode: "workflows" } }).list, true);
  assert.deepEqual(handoffListing({ MMO_HANDOFF_TOOLS: "on" }), { list: true, reason: "override", watch: [] });
  assert.deepEqual(handoffListing({ MMO_HANDOFF_TOOLS: "off" }), { list: false, reason: "override", watch: [] });
  assert.equal(dataFolderName("zero-touch@tilicho-ai-labs"), "zero-touch-tilicho-ai-labs", "the folder name Claude Code uses (seen on disk)");
});

test("the real server: hidden while Workflows is saved; saving Hand-off adds them and tells the client the list changed", async () => {
  const m = machine({ saved: { version: 1, mode: "workflows" } });
  const p = spawn(process.execPath, [join(ROOT, "dist", "server.js")], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, ...m.env } });
  try {
    const waiting = new Map();
    let changed = false;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "notifications/tools/list_changed") changed = true;
        if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      }
    });
    let next = 1;
    const ask = (method, params = {}) => new Promise((done) => { const id = next++; waiting.set(id, done); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.capabilities.tools.listChanged, true, "the server says its list can change");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const names = async () => (await ask("tools/list")).result.tools.map((t) => t.name);
    const before = await names();
    assert.ok(before.includes("execute_stage"), "the workflows' tools are there");
    assert.deepEqual(HANDOFF.filter((t) => before.includes(t)), [], "no hand-off tool while Workflows is saved");
    m.save({ version: 1, mode: "handoff" });
    const deadline = Date.now() + 10_000;
    while (!changed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(changed, "the client is told the list changed");
    const after = await names();
    assert.deepEqual(HANDOFF.filter((t) => after.includes(t)), HANDOFF, "now all four are listed");
  } finally { p.kill(); m.cleanup(); }
});

test("settings zero-touch cannot use follow zero-touch's fail-safe rule: the last good save decides, else Off, not listed", () => {
  // zero-touch switches nothing on from a file it cannot use (a damaged file, a mode it does not know); it falls back
  // to its last good save, else it is Off, so listing the tools there would cost every chat their 1,600 tokens for a
  // mode no chat can be in.
  for (const [what, opts] of [["a file that cannot be read", { raw: "{ half" }], ["a mode zero-touch does not know", { saved: { mode: "OFF" } }]]) {
    const m = machine(opts);
    try {
      const d = handoffListing(m.env);
      assert.deepEqual([d.list, d.reason], [false, "unreadable-off"], `${what}, no last good save: Off`);
      assert.deepEqual(d.watch, [m.settingsFile], `${what}: watched, so choosing Hand-off later adds the tools`);
      writeFileSync(join(dirname(m.settingsFile), "settings.last-good.json"), JSON.stringify({ mode: "handoff" }));
      assert.deepEqual([handoffListing(m.env).list, handoffListing(m.env).reason], [true, "handoff"], `${what}, last good save Hand-off: listed`);
      writeFileSync(join(dirname(m.settingsFile), "settings.last-good.json"), JSON.stringify({ mode: "workflows" }));
      assert.equal(handoffListing(m.env).list, false, `${what}, last good save Workflows: not listed`);
    } finally { m.cleanup(); }
  }
});

test("Hand-off saved with every kind of work kept in the chat: the undo alone is listed, and handing a kind off lists all four", () => {
  const kept = { documents: "chat", tests: "chat", repeats: "chat" };
  const m = machine({ saved: { version: 1, mode: "handoff", handoff: kept } });
  try {
    assert.deepEqual(handoffListing(m.env), { list: true, only: ["undo_hand_off"], reason: "handoff-all-kept", watch: [m.settingsFile] });
    m.save({ version: 1, mode: "handoff", handoff: { ...kept, tests: "flash" } });
    assert.deepEqual(handoffListing(m.env), { list: true, reason: "handoff", watch: [] });
  } finally { m.cleanup(); }
  // A value left out takes zero-touch's standard typist (Flash 3.8), so it is not kept in the chat.
  assert.deepEqual(decide({ saved: { version: 1, mode: "handoff", handoff: { documents: "chat", tests: "chat" } } }), { list: true, reason: "handoff", watch: [] });
});

// "To undo it, ask Claude to undo hand-off h…" keeps working after the person leaves Hand-off mode: the undo is listed
// and accepted outside a Hand-off chat.
test("after leaving Hand-off mode the undo alone is listed while a hand-off is not undone, and the server accepts it from any chat", async () => {
  const { readChatHandoff } = await import(join(ROOT, "dist", "handoff", "chat.js"));
  const m = machine({ saved: { version: 1, mode: "workflows" } });
  try {
    assert.equal(handoffListing(m.env).reason, "other-mode", "no hand-off was ever made: nothing listed");
    const chat = join(m.dir, ".mmo-ambient", "sessions", "c1");
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, "handoff_landings.json"), JSON.stringify([{ id: "habcd", tool: "write_document", files: [{ path: "docs/x.md", existed: false, sha256: "x" }] }]));
    assert.deepEqual(handoffListing(m.env), { list: true, only: ["undo_hand_off"], reason: "undo-after-handoff", watch: [join(m.env.CLAUDE_CONFIG_DIR, "plugins", "data", dataFolderName("zero-touch@m"), "settings.json")] });
    writeFileSync(join(chat, "handoff_landings.json"), JSON.stringify([{ id: "habcd", tool: "write_document", undone: true, files: [] }]));
    assert.equal(handoffListing(m.env).list, false, "every hand-off undone: nothing listed");
    // A chat that is not a Hand-off chat (no record at all): an undo is accepted, a hand-off is not.
    const repo = m.env.CLAUDE_PROJECT_DIR;
    const stamp = { session_id: "w9", project_dir: repo, auth: "estimated" };
    const undo = readChatHandoff(stamp, m.env, { needRoutes: false });
    assert.equal(undo.refused, undefined, `an undo from any chat: ${undo.refused}`);
    assert.equal(undo.projectDir, repo);
    assert.match(readChatHandoff(stamp, m.env).refused ?? "", /not a hand-off chat/, "a hand-off still needs a Hand-off chat");
  } finally { m.cleanup(); }
});
