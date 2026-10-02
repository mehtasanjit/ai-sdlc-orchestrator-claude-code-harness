/**
 * Unit tests for zero-touch's libraries under plugin/scripts/ambient/lib: settings layering, the typed-command
 * reader, the folder's kind, the event log, the transcript reader and the workflow-log reader. Pure functions, no
 * network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LIB = join(ROOT, "plugin", "scripts", "ambient", "lib");
const { loadConfig } = await import(join(LIB, "config.mjs"));
const { isPipelineCommand, isPluginCommandName } = await import(join(LIB, "commands.mjs"));
const { repoKind } = await import(join(LIB, "repo-kind.mjs"));
const { parseEvents } = await import(join(LIB, "events.mjs"));

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-ambient-lib-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------- settings ----------

test("the shipped default: routing on, cost recording estimated; no file sets the mode, and no file sets zero-touch's models", () => {
  const t = tmp();
  try {
    const { config, sources } = loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } });
    assert.equal(config.mode, "off", "only the chat's own record (the zero-touch plugin) or MMO_AMBIENT switches zero-touch");
    assert.equal(config.routing, "on");
    // The models are the person's choice in the settings box (zero-touch/scripts/settings.mjs), stamped on each chat;
    // nothing here names a policy, and hand-off's settings are there too.
    assert.deepEqual(config.routing_defaults, { auth: "estimated" });
    assert.equal(config.handoff, undefined);
    assert.equal(config.retention_days, 30);
    assert.deepEqual(sources, ["defaults"]);
  } finally { t.cleanup(); }
});

test("the person's file sets routing and its defaults; a project file can only switch routing off, never on or elsewhere", () => {
  const t = tmp();
  try {
    const home = join(t.dir, "home");
    const repo = join(t.dir, "repo");
    mkdirSync(home);
    mkdirSync(join(repo, ".sdlc"), { recursive: true });
    writeFileSync(join(home, "ambient.json"), JSON.stringify({ routing_defaults: { policy: "opus-plus-sonnet", auth: "vendor" }, handoff: { policy: "opus-only-v5" }, retention_days: 7, mode: "on" }));
    const mine = loadConfig({ projectDir: repo, env: { MMO_HOME: home } });
    assert.deepEqual(mine.config.routing_defaults, { auth: "vendor" }, "the person's file may set the cost recording; a policy in it is ignored");
    assert.equal(mine.config.handoff, undefined, "hand-off settings in the file are ignored");
    assert.equal(mine.config.retention_days, 7);
    assert.equal(mine.config.mode, "off", "a mode key in a file is ignored");

    // A repository's file is anyone's input: it may switch routing off, and nothing else.
    writeFileSync(join(repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "on", routing_defaults: { policy: "attacker-policy", auth: "vendor" }, mode: "on", retention_days: 1 }));
    const hostile = loadConfig({ projectDir: repo, env: { MMO_HOME: home } });
    assert.deepEqual(hostile.config.routing_defaults, { auth: "vendor" }, "the project file changes nothing but routing off");
    assert.equal(hostile.config.retention_days, 7);
    assert.equal(hostile.config.mode, "off");
    writeFileSync(join(home, "ambient.json"), JSON.stringify({ routing: "off" }));
    assert.equal(loadConfig({ projectDir: repo, env: { MMO_HOME: home } }).config.routing, "off", "a project file cannot switch routing back on");
    writeFileSync(join(home, "ambient.json"), "{}");
    writeFileSync(join(repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "off" }));
    const off = loadConfig({ projectDir: repo, env: { MMO_HOME: home } });
    assert.equal(off.config.routing, "off");
    assert.ok(off.sources.includes("project"));
    assert.equal(loadConfig({ projectDir: repo, env: { MMO_HOME: home, MMO_AMBIENT: "observe" } }).config.mode, "observe", "only the one-run override sets a mode");
  } finally { t.cleanup(); }
});

test("unreadable, oversized or wrongly typed settings fall back instead of throwing", () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, "ambient.json"), "{ not json");
    assert.equal(loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } }).config.routing, "on");
    writeFileSync(join(t.dir, "ambient.json"), JSON.stringify({ routing: 7, routing_defaults: "all", retention_days: "long" }));
    const { config } = loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } });
    assert.equal(config.routing, "on", "a value of the wrong type is ignored");
    assert.deepEqual(config.routing_defaults, { auth: "estimated" });
    assert.equal(config.retention_days, 30);
    writeFileSync(join(t.dir, "ambient.json"), JSON.stringify({ routing: "maybe", routing_defaults: { policy: "../../etc/passwd", auth: "free" } }));
    const odd = loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } }).config;
    assert.equal(odd.routing, "off", "an unknown routing value means the safe default");
    assert.deepEqual(odd.routing_defaults, { auth: "estimated" }, "an unknown cost-recording value means the standard one; a policy name in the file is never read");
    writeFileSync(join(t.dir, "ambient.json"), "x".repeat(70 * 1024));
    assert.equal(loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } }).config.routing, "on", "an oversized file is skipped");
  } finally { t.cleanup(); }
});

test("the shipped settings file is valid JSON", () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(ROOT, "plugin", "config", "ambient.default.json"), "utf8")));
});

// ---------- typed commands, the folder's kind ----------

test("a typed /mmo: command is recognised at the start of a prompt only, with or without the prefix where Claude Code allows it", () => {
  assert.equal(isPipelineCommand("  /mmo:bugfix the date parser"), true);
  assert.equal(isPipelineCommand("what does /mmo:bugfix do"), false);
  assert.equal(isPipelineCommand("/mmo:not-a-command"), false);
  assert.equal(isPluginCommandName("mmo:greenfield"), true);
  assert.equal(isPluginCommandName("/bugfix"), true);
  assert.equal(isPluginCommandName("other:thing"), false);
});

test("a folder is brownfield once it holds one source file of its own; dependencies, build output and docs do not count", () => {
  const t = tmp();
  try {
    assert.equal(repoKind(t.dir), "greenfield");
    writeFileSync(join(t.dir, "README.md"), "# x\n");
    writeFileSync(join(t.dir, "NOTES.MD"), "# y\n");
    mkdirSync(join(t.dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(t.dir, "node_modules", "dep", "index.js"), "x\n");
    mkdirSync(join(t.dir, "dist"));
    writeFileSync(join(t.dir, "dist", "app.js"), "x\n");
    assert.equal(repoKind(t.dir), "greenfield", "docs, installed packages and build output are not the project's code");
    mkdirSync(join(t.dir, "src"));
    writeFileSync(join(t.dir, "src", "Main.PY"), "print(1)\n");
    assert.equal(repoKind(t.dir), "brownfield", "a source file counts whatever the case of its extension");
  } finally { t.cleanup(); }
});

// ---------- records ----------

test("a torn record never damages its neighbours", () => {
  const text = '\n{"ts":"t","type":"a"}\n\n{"ts":"t","type":"b","x":\n{"ts":"t","type":"c"}\n';
  assert.deepEqual(parseEvents(text).map((e) => e.type), ["a", "c"]);
});

test("sentWhileWorking: the latest transcript entry carrying the message decides; a queued message is 'while working'", async () => {
  const { sentWhileWorking } = await import(join(LIB, "transcript.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "mmo-busy-"));
  try {
    const t = (name, entries) => { const p = join(dir, name); writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); return p; };
    const user = (content) => ({ type: "user", message: { role: "user", content } });
    const queued = (prompt) => ({ type: "attachment", attachment: { type: "queued_command", prompt } });
    assert.equal(sentWhileWorking(t("a", [user("read all"), queued("fix the bug")]), "fix the bug"), true);
    assert.equal(sentWhileWorking(t("b", [user("read all"), user("fix the bug")]), "fix the bug"), false);
    assert.equal(sentWhileWorking(t("c", [user([{ type: "text", text: "fix the bug" }])]), "fix the bug"), false, "content as a list of parts");
    assert.equal(sentWhileWorking(t("d", [queued("fix the bug"), user("fix the bug")]), "fix the bug"), false, "sent again later when idle: the newest entry wins");
    assert.equal(sentWhileWorking(t("e", [{ type: "user", isSidechain: true, message: { content: "fix the bug" } }]), "fix the bug"), null, "a helper's entry is not the person's");
    assert.equal(sentWhileWorking(join(dir, "missing.jsonl"), "fix the bug"), null);
    assert.equal(sentWhileWorking(undefined, "fix the bug"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflowState: ended on the last gate answered, an abort, or a failed end; running otherwise; not-started without a run after the chat's start", async () => {
  const { workflowState } = await import(join(LIB, "workflow-log.mjs"));
  const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "mmo-wflog-"));
  try {
    const log = (runId, ...lines) => {
      const d = join(dir, ".sdlc", "runs", runId);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "orchestrator.log"), lines.map(([ev, f]) => formatLine("info", ev, { run_id: runId, ...f })).join("\n") + "\n", { flag: "a" });
    };
    const since = Date.now() - 1000;
    assert.deepEqual(workflowState(dir, since), { state: "not-started" });
    log("g1", ["run.start", {}], ["gate.open", { gate: "gate-1", title: "Requirements Approval" }]);
    assert.equal(workflowState(dir, since).state, "running", "a gate waits for its answer");
    log("g1", ["gate.resolved", { gate: "gate-1", response: "approved" }], ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4", title: "final acceptance" }]);
    assert.equal(workflowState(dir, since).state, "running", "greenfield logs run.end before its final gate");
    log("g1", ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.deepEqual(workflowState(dir, since), { state: "ended", runId: "g1", outcome: "completed" });
    const d2 = mkdtempSync(join(tmpdir(), "mmo-wflog-"));
    try {
      const log2 = (runId, ...lines) => { const d = join(d2, ".sdlc", "runs", runId); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "orchestrator.log"), lines.map(([ev, f]) => formatLine("info", ev, { run_id: runId, ...f })).join("\n") + "\n", { flag: "a" }); };
      log2("f1", ["run.start", {}], ["gate.open", { gate: "gate-2" }], ["run.end", { outcome: "failed" }]);
      assert.equal(workflowState(d2, since).state, "ended", "a failed end is an end, even with a gate open");
      // f2 starts after f1, as two real runs always do: without this wait both run.start lines could carry the same
      // millisecond, and "the latest run" would be a tie.
      await new Promise((r) => setTimeout(r, 5));
      log2("f2", ["run.start", {}], ["gate.open", { gate: "gate-0" }], ["gate.resolved", { gate: "gate-0", response: "abort" }]);
      assert.deepEqual(workflowState(d2, since), { state: "ended", runId: "f2", outcome: "aborted" }, "the latest run is the chat's");
      assert.deepEqual(workflowState(d2, Date.now() + 60_000), { state: "not-started" }, "runs started before the chat's workflow do not count");
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a completed run is over at its answered final acceptance; one that never logs that gate, after a quiet stretch with nothing open", async () => {
  const { workflowState, QUIET_MS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "workflow-log.mjs"));
  const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "mmo-wflog-"));
  try {
    const log = (runId, ...lines) => {
      const d = join(dir, ".sdlc", "runs", runId);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "orchestrator.log"), lines.map(([ev, f]) => formatLine("info", ev, { run_id: runId, ...f })).join("\n") + "\n", { flag: "a" });
    };
    const since = Date.now() - 1000;
    // mmo's own order: run.end right before the final report, then the final acceptance gate.
    log("d1", ["run.start", {}], ["gate.open", { gate: "gate-3" }], ["gate.resolved", { gate: "gate-3", response: "approved" }],
      ["phase.start", { phase: "generate_final_report" }], ["run.end", { outcome: "completed" }]);
    assert.equal(workflowState(dir, since).state, "running", "still writing its final report: not over at run.end");
    assert.equal(workflowState(dir, since, null, Date.now() + QUIET_MS * 2).state, "running", "a phase still open is never over, however quiet");
    log("d1", ["phase.end", { phase: "generate_final_report" }], ["gate.open", { gate: "gate-4" }]);
    assert.deepEqual(workflowState(dir, since), { state: "running", runId: "d1", outcome: "completed", waiting: true }, "waiting for the final answer");
    log("d1", ["gate.resolved", { gate: "gate-4", response: "approved" }]);
    assert.deepEqual(workflowState(dir, since), { state: "ended", runId: "d1", outcome: "completed" });
    // A run that never logs its final gate: over once nothing is open and its log has been quiet long enough.
    const d2 = mkdtempSync(join(tmpdir(), "mmo-wflog-"));
    try {
      const d = join(d2, ".sdlc", "runs", "q1");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "orchestrator.log"), [["run.start", {}], ["run.end", { outcome: "completed" }]].map(([ev, f]) => formatLine("info", ev, { run_id: "q1", ...f })).join("\n") + "\n");
      assert.equal(workflowState(d2, since).state, "running", "just ended: its final gate may still come");
      assert.equal(workflowState(d2, since, null, Date.now() + QUIET_MS + 1000).state, "ended", "quiet with nothing open: over");
    } finally { rmSync(d2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
