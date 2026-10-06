/**
 * Where the collector opens (and closes) a run's cost window, for the cases a single typed command does not cover:
 *
 *   - Which turns are this plugin's run commands. Only the plugin's own namespace counts (`/mmo:<name>` typed, a
 *     Skill call to `mmo:<name>`, and the orchestration runner's `ai-sdlc-*`), plus the clone route's typed `/pass`,
 *     the project command tools/setup.mjs installs. A project's own `/test`, another plugin's `/x:docs`, or a Skill
 *     call to another plugin's `docs` skill is not a run's command turn: read as one, it became "the latest command
 *     turn before run.start", opened the window late and dropped the run's intake while still calling the window exact.
 *   - A queued run (zero-touch starts the next job from the Stop hook, in the same invocation, with no person's turn
 *     of its own). The last person's turn before its Skill call belongs to the run before it, so the queued run's
 *     window opens at the Skill call itself, and the run before it closes there. Crediting that turn to the queued run
 *     opened its window inside the earlier run (counting the earlier run's messages twice) and took a typed Gate 4
 *     answer away from the earlier run.
 *   - Zero-touch's "Replace it": the replaced run's `run.end reason=replaced` is written inside the person's request's
 *     own invocation, so it is no queued boundary. The request opens the replacing run, and the replaced run closes
 *     at it instead of running on over the replacing run's messages.
 *   - A run command typed while another run is going, which zero-touch queues: it starts nothing where it is typed,
 *     so it is neither the running run's command turn (that opened the window late) nor a gate's answer.
 *   - Helper transcripts that finished between the command turn and run.start (the discovery helper that runs before
 *     Gate 0). The file prune now reaches back to the window's real opening, or their messages were dropped.
 *   - A pre-flight telemetry event (phase "preflight", the run-start typist probe) is spend, never the run's anchor:
 *     run.start is looked for at or before the first event that is not pre-flight.
 *
 * The end-to-end cases spawn the real CLI on a temp tree (--dry-run, except where a case reads the run's written
 * record). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { humanTurns } from "../../../scripts/collect-orchestrator-usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const ENV = { ...process.env, MMO_SELECT: "" };

// $10 per 1,000,000 output tokens, so every message below is a hand-checkable $10.
const POLICY = `
version: 1
name: check-window
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 10 }
    pricing_override: true
rules:
  - default: driver
`;
const M = 1_000_000;

/** An assistant message as the CLI writes it. */
const msg = (id, ts, out = M) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-8", stop_reason: "end_turn", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
/** A person's turn. */
const uLine = (ts, text) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text } });
/** A typed slash command, as Claude Code records it. */
const typed = (ts, name, args = "") => uLine(ts, `<command-message>${name.replace(/^\//, "")} is running…</command-message>\n<command-name>${name}</command-name>${args ? `\n<command-args>${args}</command-args>` : ""}`);
/** A Skill tool call Claude made, carrying `out` output tokens (the message that makes the call is billed too). */
const skillCall = (ts, skill, { args = "", out = 0, id = `m_skill_${ts}` } = {}) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-8", stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${ts}`, name: "Skill", input: { skill, args } }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
/** A question-box call (AskUserQuestion) Claude made, carrying `out` output tokens. */
const askCall = (ts, { out = M, id = `m_ask_${ts}` } = {}) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-8", stop_reason: "tool_use", content: [{ type: "tool_use", id: `tu_${ts}`, name: "AskUserQuestion", input: { questions: [] } }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
/** The person's pick in a question box: a tool result handed back to the model, never a person's turn. */
const toolResult = (ts, text) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${ts}`, content: text }] } });
/** The Stop hook's context, as Claude Code records it: an attachment line, never a person's turn. */
const stopHookContext = (ts, text) => JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "hook_additional_context", hookName: "Stop", hookEvent: "Stop", content: [text] } });
const logLine = (iso, event, fields) => `MMO: ${iso} INFO   ${event} ${fields}`;

/**
 * A project with one session transcript and any number of runs. Each run: { id, log: [lines], started_at, ended_at,
 * telemetry?, receipt? }. Returns run(id) → the collector's dry-run result for that run.
 */
function project({ session, helpers = {}, runs, mtimes = {} }) {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-window-"));
  const tDir = join(root, "transcripts");
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), POLICY);
  writeFileSync(join(tDir, "sess-q.jsonl"), session.join("\n") + "\n");
  for (const [name, lines] of Object.entries(helpers)) {
    const p = join(tDir, "sess-q", "subagents", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.join("\n") + "\n");
  }
  for (const [rel, iso] of Object.entries(mtimes)) {
    const t = new Date(iso);
    utimesSync(join(tDir, rel), t, t);
  }
  for (const r of runs) {
    const logDir = join(root, ".sdlc", "runs", r.id);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "orchestrator.log"), r.log.join("\n") + "\n");
    const passDir = join(root, "passes", r.id);
    mkdirSync(passDir, { recursive: true });
    const telemetry = r.telemetry ?? [{ ts: r.started_at, pass: r.id, phase: "codegen", task_id: "t-1", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.5 }];
    const dispatched = telemetry.reduce((s, e) => s + e.cost_usd, 0);
    writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: r.id, policy_name: "check-window", started_at: r.started_at, ended_at: r.ended_at, totals: { dispatched_cost_usd: dispatched, models_used: ["gemini-3.5-flash"] } }));
    writeFileSync(join(passDir, "telemetry.jsonl"), telemetry.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (r.receipt) writeFileSync(join(passDir, "claude-session.json"), JSON.stringify(r.receipt));
  }
  const exec = (id, dry) => spawnSync(process.execPath, [SCRIPT, join(root, "passes", id), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir, ...(dry ? ["--dry-run"] : [])], { encoding: "utf-8", env: ENV });
  const run = (id) => exec(id, true);
  // Writes the run's telemetry event and manifest block, then returns the manifest's window record.
  const write = (id) => {
    const r = exec(id, false);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(root, "passes", id, "manifest.json"), "utf-8")).orchestrator_overhead.window;
  };
  return { root, tDir, run, write, rm: () => rmSync(root, { recursive: true, force: true }) };
}
const overhead = (stdout) => Number(/= \$([0-9.]+) \[transcript/.exec(stdout)?.[1]);
const counted = (stdout) => Number(/counted (\d+) unique API message/.exec(stdout)?.[1]);

// ── Only this plugin's commands are run commands ────────────────────────────

test("a run command is the plugin's own: /mmo:<name>, a Skill call to mmo:<name>, the runner's ai-sdlc-*, or the clone route's typed /pass; a project's /test, another plugin's command or skill, and any other bare name are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-turns-ns-"));
  try {
    const f = join(dir, "s.jsonl");
    writeFileSync(f, [
      typed("2026-10-06T10:00:00.000Z", "/mmo:greenfield"),
      typed("2026-10-06T10:01:00.000Z", "/test"),                                  // the project's own /test
      uLine("2026-10-06T10:02:00.000Z", "/test the export again"),                 // typed on an older CLI, bare
      typed("2026-10-06T10:03:00.000Z", "/jest:test"),                             // another plugin's test command
      uLine("2026-10-06T10:04:00.000Z", "/other-plugin:refactor the parser"),
      typed("2026-10-06T10:05:00.000Z", "/other:pass", "brief.md"),                // another plugin's pass
      uLine("2026-10-06T10:06:00.000Z", "what does the docs folder hold?"),
      skillCall("2026-10-06T10:06:05.000Z", "anthropic-skills:docs"),              // another plugin's docs skill
      uLine("2026-10-06T10:07:00.000Z", "run the tests"),
      skillCall("2026-10-06T10:07:05.000Z", "test"),                               // a bare skill name
      uLine("2026-10-06T10:08:00.000Z", "/pass brief.md"),                         // the clone route's /pass, typed on an older CLI
      typed("2026-10-06T10:09:00.000Z", "/mmo:test", "backfill unit tests for src/payments"),
      uLine("2026-10-06T10:10:00.000Z", "write the API docs"),
      skillCall("2026-10-06T10:10:05.000Z", "mmo:docs", { args: "write the API docs" }),
      typed("2026-10-06T10:11:00.000Z", "/ai-sdlc-measured", "--run-id=v37-x"),    // the orchestration runner's command
      uLine("2026-10-06T10:12:00.000Z", "/mmo:bugfix the date parser accepts 30 February"),
      // The clone route (tools/setup.mjs) installs plugin/commands/pass.md as the project command /pass, the one bare
      // name that is this plugin's own; Claude Code records it as <command-name>/pass</command-name>.
      typed("2026-10-06T10:13:00.000Z", "/pass", "--auth=vendor brief.md"),
      uLine("2026-10-06T10:14:00.000Z", "run the pass"),
      skillCall("2026-10-06T10:14:05.000Z", "pass"),                               // a Skill call by a bare name: not the plugin's
      typed("2026-10-06T10:15:00.000Z", "/passport"),                              // only the exact name
      typed("2026-10-06T10:16:00.000Z", "/greenfield"),                            // a bare job name the clone route does not install
    ].join("\n") + "\n");
    assert.deepEqual(humanTurns(f).map((t) => [t.iso.slice(11, 19), t.command]), [
      ["10:00:00", true], ["10:01:00", false], ["10:02:00", false], ["10:03:00", false], ["10:04:00", false],
      ["10:05:00", false], ["10:06:00", false], ["10:07:00", false], ["10:08:00", true], ["10:09:00", true],
      ["10:10:00", true], ["10:11:00", true], ["10:12:00", true], ["10:13:00", true], ["10:14:00", false],
      ["10:15:00", false], ["10:16:00", false],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a project's own /test, or another plugin's docs skill, typed during a run's intake does not move the run's window: it opens at /mmo:greenfield", () => {
  const log = [logLine("2026-09-05T18:53:03.107Z", "run.start", "run_id=r-g mode=greenfield"), logLine("2026-09-05T19:06:30.000Z", "run.end", "run_id=r-g outcome=completed")];
  // [the foreign turn's lines, the messages the run's window counts]: the intake, m_pre, m_in, plus the foreign Skill
  // call's own message (0 tokens), which is inside the window too.
  for (const [foreign, messages] of [
    [[typed("2026-09-05T18:52:10.000Z", "/test")], 3],
    [[uLine("2026-09-05T18:52:10.000Z", "and what is in docs/?"), skillCall("2026-09-05T18:52:15.000Z", "anthropic-skills:docs")], 4],
  ]) {
    const p = project({
      session: [
        typed("2026-09-05T18:51:15.673Z", "/mmo:greenfield"),
        msg("m_intake", "2026-09-05T18:51:30.000Z"), // the run's own intake, before run.start
        ...foreign,
        msg("m_pre", "2026-09-05T18:56:00.000Z"),
        msg("m_in", "2026-09-05T19:05:30.000Z"),
      ],
      runs: [{ id: "r-g", log, started_at: "2026-09-05T19:05:00.000Z", ended_at: "2026-09-05T19:06:00.000Z" }],
    });
    try {
      const r = p.run("r-g");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:51:15\.673Z/);
      assert.equal(counted(r.stdout), messages, r.stdout);
      assert.equal(overhead(r.stdout), 30, r.stdout); // the intake's $10 is the run's
    } finally { p.rm(); }
  }
});

test("a clone-route run typed as /pass opens exactly at that command turn, so its intake is the run's", () => {
  // tools/setup.mjs copies plugin/commands/pass.md to ./.claude/commands/pass.md: a project command, recorded as
  // <command-name>/pass</command-name>. Read as no command turn, the window fell back to run.start − 5 minutes
  // (approximate) and dropped the intake.
  const p = project({
    session: [
      typed("2026-09-05T18:51:15.673Z", "/pass", "--auth=vendor --run-id=r-c examples/workforce-ops/brief.md"),
      msg("m_intake", "2026-09-05T18:51:30.000Z"),
      msg("m_pre", "2026-09-05T18:56:00.000Z"),
      msg("m_in", "2026-09-05T19:05:30.000Z"),
    ],
    runs: [{ id: "r-c", log: [logLine("2026-09-05T18:58:03.107Z", "run.start", "run_id=r-c mode=greenfield"), logLine("2026-09-05T19:06:30.000Z", "run.end", "run_id=r-c outcome=completed")], started_at: "2026-09-05T19:05:00.000Z", ended_at: "2026-09-05T19:06:00.000Z" }],
  });
  try {
    const r = p.run("r-c");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:51:15\.673Z/);
    assert.doesNotMatch(r.stdout, /approximate/);
    assert.equal(counted(r.stdout), 3, r.stdout);
    assert.equal(overhead(r.stdout), 30);
  } finally { p.rm(); }
});

// ── A queued run opens at its own Skill call ────────────────────────────────

test("a queued run (started by the Stop hook, no person's turn of its own) opens at its Skill call; the run before it closes there; the two windows do not overlap", () => {
  // Run one: a bugfix started from the person's request at 18:00. At 18:20 the person asks for a docs job, which waits
  // in the queue. Run one ends at 18:30, and the Stop hook starts the docs job with a Skill call at 18:30:10.
  const p = project({
    session: [
      uLine("2026-09-05T18:00:00.000Z", "fix the bug where parseDate accepts 30 February"),
      skillCall("2026-09-05T18:00:05.000Z", "mmo:bugfix", { args: "fix the bug where parseDate accepts 30 February", out: M }),
      msg("r1_a", "2026-09-05T18:05:00.000Z"),
      uLine("2026-09-05T18:20:00.000Z", "also write the API docs for parseDate"),
      msg("r1_b", "2026-09-05T18:21:00.000Z"),
      msg("r1_close", "2026-09-05T18:30:05.000Z"), // run one's closing summary, after its run.end
      stopHookContext("2026-09-05T18:30:08.000Z", "The queued job is next. Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T18:30:10.000Z", "mmo:docs", { args: "write the API docs for parseDate", out: M }),
      msg("r2_a", "2026-09-05T18:31:00.000Z"),
      msg("r2_b", "2026-09-05T18:40:00.000Z"),
    ],
    runs: [
      { id: "r-one", log: [logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-one"), logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-one outcome=completed")], started_at: "2026-09-05T18:10:00.000Z", ended_at: "2026-09-05T18:25:00.000Z" },
      { id: "r-two", log: [logLine("2026-09-05T18:30:20.000Z", "run.start", "run_id=r-two"), logLine("2026-09-05T18:45:00.000Z", "run.end", "run_id=r-two outcome=completed")], started_at: "2026-09-05T18:35:00.000Z", ended_at: "2026-09-05T18:41:00.000Z" },
    ],
  });
  try {
    const two = p.run("r-two");
    assert.equal(two.status, 0, two.stderr);
    assert.match(two.stdout, /window 2026-09-05T18:30:10\.000Z → end of session/);
    assert.match(two.stdout, /opens at the Skill call that started this queued run 2026-09-05T18:30:10\.000Z/);
    assert.equal(counted(two.stdout), 3, two.stdout); // its Skill call, r2_a, r2_b
    assert.equal(overhead(two.stdout), 30);

    const one = p.run("r-one");
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:30:10\.000Z/);
    assert.match(one.stdout, /closes at the Skill call that started the next queued run 2026-09-05T18:30:10\.000Z/);
    assert.equal(counted(one.stdout), 4, one.stdout); // its Skill call, r1_a, r1_b, r1_close
    assert.equal(overhead(one.stdout), 40);
    assert.equal(overhead(one.stdout) + overhead(two.stdout), 70, "every message is counted once, by one run");
    // The runs' own records name the anchors as they are.
    assert.deepEqual(p.write("r-two"), { start: "2026-09-05T18:30:10.000Z", end: null, start_anchor: "queued run's Skill call", end_anchor: "end of session", exact: true, session_id: "sess-q", source: "manifest", lower_bound: false });
    assert.deepEqual(p.write("r-one"), { start: "2026-09-05T18:00:00.000Z", end: "2026-09-05T18:30:10.000Z", start_anchor: "command turn", end_anchor: "next queued run's Skill call", exact: true, session_id: "sess-q", source: "manifest", lower_bound: false });
  } finally { p.rm(); }
});

test("a queued run's Skill call written as two lines (a text block first) is one boundary: its message is counted by the queued run alone", () => {
  const textFirst = JSON.stringify({ type: "assistant", timestamp: "2026-09-05T18:30:09.000Z", message: { id: "m_queued", model: "claude-opus-4-8", content: [{ type: "text", text: "Starting the queued docs job." }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 } } });
  const p = project({
    session: [
      uLine("2026-09-05T18:00:00.000Z", "fix the bug where parseDate accepts 30 February"),
      skillCall("2026-09-05T18:00:05.000Z", "mmo:bugfix", { out: M }),
      msg("r1_a", "2026-09-05T18:05:00.000Z"),
      stopHookContext("2026-09-05T18:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      textFirst,
      skillCall("2026-09-05T18:30:10.000Z", "mmo:docs", { out: M, id: "m_queued" }),
      msg("r2_a", "2026-09-05T18:31:00.000Z"),
    ],
    runs: [
      { id: "r-one", log: [logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-one"), logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-one outcome=completed")], started_at: "2026-09-05T18:04:00.000Z", ended_at: "2026-09-05T18:06:00.000Z" },
      { id: "r-two", log: [logLine("2026-09-05T18:30:20.000Z", "run.start", "run_id=r-two"), logLine("2026-09-05T18:45:00.000Z", "run.end", "run_id=r-two outcome=completed")], started_at: "2026-09-05T18:31:00.000Z", ended_at: "2026-09-05T18:32:00.000Z" },
    ],
  });
  try {
    const one = p.run("r-one");
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:30:09\.000Z/);
    assert.equal(counted(one.stdout), 2, one.stdout); // its Skill call and r1_a; not a line of the queued run's call
    const two = p.run("r-two");
    assert.equal(two.status, 0, two.stderr);
    assert.match(two.stdout, /window 2026-09-05T18:30:09\.000Z → end of session/);
    assert.equal(counted(two.stdout), 2, two.stdout); // the call's message (booked once, at its terminal line) and r2_a
    assert.equal(overhead(two.stdout), 20);
  } finally { p.rm(); }
});

test("a receipt for the invocation that holds a queued run proves neither run's window: both are refused, nothing is booked as billed but not logged", () => {
  // The person queued the docs job from a question box, so the session has one person's turn: one invocation, billed
  // by one receipt for all seven messages. Run one's window holds four of them and run two's three; a receipt above
  // either is the other run's spend, never Claude Code's unlogged calls.
  const receipt = { session_id: "sess-q", total_cost_usd: 70, modelUsage: { "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 7 * M, costUSD: 70 } } };
  const p = project({
    session: [
      uLine("2026-09-05T18:00:00.000Z", "fix the bug where parseDate accepts 30 February"),
      skillCall("2026-09-05T18:00:05.000Z", "mmo:bugfix", { out: M }),
      msg("r1_a", "2026-09-05T18:05:00.000Z"),
      msg("r1_b", "2026-09-05T18:21:00.000Z"),
      msg("r1_close", "2026-09-05T18:30:05.000Z"),
      stopHookContext("2026-09-05T18:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T18:30:10.000Z", "mmo:docs", { out: M }),
      msg("r2_a", "2026-09-05T18:31:00.000Z"),
      msg("r2_b", "2026-09-05T18:40:00.000Z"),
    ],
    runs: [
      { id: "r-one", receipt, log: [logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-one"), logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-one outcome=completed")], started_at: "2026-09-05T18:10:00.000Z", ended_at: "2026-09-05T18:25:00.000Z" },
      { id: "r-two", receipt, log: [logLine("2026-09-05T18:30:20.000Z", "run.start", "run_id=r-two"), logLine("2026-09-05T18:45:00.000Z", "run.end", "run_id=r-two outcome=completed")], started_at: "2026-09-05T18:35:00.000Z", ended_at: "2026-09-05T18:41:00.000Z" },
    ],
  });
  try {
    const one = p.run("r-one");
    assert.equal(one.status, 3, one.stdout + one.stderr);
    assert.match(one.stderr, /cannot be proven to be the receipt's invocation: a queued run starts at 2026-09-05T18:30:10\.000Z in the same invocation, so the receipt bills that run too/);
    const two = p.run("r-two");
    assert.equal(two.status, 3, two.stdout + two.stderr);
    assert.match(two.stderr, /cannot be proven to be the receipt's invocation: the window opens at queued run's Skill call, not at the run's command turn/);
  } finally { p.rm(); }
});

test("a typed Gate 4 answer after run.end stays the earlier run's answer when the Stop hook starts a queued run next", () => {
  const p = project({
    session: [
      uLine("2026-09-05T10:00:00.000Z", "fix the /login endpoint returning 500 on a missing password"),
      skillCall("2026-09-05T10:00:05.000Z", "mmo:bugfix", { out: M }),
      msg("a1", "2026-09-05T10:05:00.000Z"),
      uLine("2026-09-05T10:25:00.000Z", "approved"), // Gate 4, typed, after run A's run.end
      msg("a_close", "2026-09-05T10:26:00.000Z"),
      stopHookContext("2026-09-05T10:26:50.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T10:27:00.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T10:30:00.000Z"),
      msg("b2", "2026-09-05T10:35:00.000Z"),
    ],
    runs: [
      {
        id: "r-a",
        log: [
          logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-a"),
          logLine("2026-09-05T10:20:00.000Z", "run.end", "run_id=r-a outcome=completed"),
          logLine("2026-09-05T10:21:00.000Z", "gate.open", "run_id=r-a gate=gate-4 title=\"Accept\""),
          logLine("2026-09-05T10:25:30.000Z", "gate.resolved", "run_id=r-a gate=gate-4 response=approved"),
        ],
        started_at: "2026-09-05T10:04:00.000Z",
        ended_at: "2026-09-05T10:06:00.000Z",
      },
      { id: "r-b", log: [logLine("2026-09-05T10:28:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T10:31:00.000Z", ended_at: "2026-09-05T10:33:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /gates: 1 in the run log; 1 answered by a typed message \(gate-4 at 2026-09-05T10:25:00\.000Z\)/);
    assert.match(a.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:27:00\.000Z/);
    assert.equal(counted(a.stdout), 3, a.stdout); // its Skill call, a1, a_close
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /window 2026-09-05T10:27:00\.000Z → end of session/);
    assert.equal(counted(b.stdout), 3, b.stdout); // its Skill call, b1, b2
    assert.equal(overhead(a.stdout) + overhead(b.stdout), 60);
  } finally { p.rm(); }
});

test("a Skill call answering the person's own turn still opens at that turn: no other run's record lies between them", () => {
  const p = project({
    session: [
      uLine("2026-09-05T18:00:00.000Z", "fix the bug where parseDate accepts 30 February"),
      msg("m_think", "2026-09-05T18:00:02.000Z"),
      skillCall("2026-09-05T18:00:05.000Z", "mmo:bugfix", { out: M }),
      msg("r1_a", "2026-09-05T18:05:00.000Z"),
    ],
    runs: [{ id: "r-one", log: [logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-one"), logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-one outcome=completed")], started_at: "2026-09-05T18:04:00.000Z", ended_at: "2026-09-05T18:06:00.000Z" }],
  });
  try {
    const r = p.run("r-one");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:00:00\.000Z .*\(exact: the invocation the CLI bills begins there\)/);
    assert.equal(counted(r.stdout), 3, r.stdout);
  } finally { p.rm(); }
});

// ── "Replace it": the replacing run opens at the person's request ───────────

// Zero-touch's "Replace it" (hook.mjs settle → lib/workflow-log.mjs abortRun) logs the running run's
// `run.end outcome=aborted reason=replaced` after the person's request, inside the request's own invocation. That
// record is not a queued run's boundary: the request is the replacing run's command turn, and the replaced run's
// messages end there.
const replacedRunA = { id: "r-a", log: [logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-a"), logLine("2026-09-05T18:15:00.000Z", "gate.open", "run_id=r-a gate=gate-2 title=\"Design\""), logLine("2026-09-05T18:20:30.500Z", "run.end", "run_id=r-a outcome=aborted reason=replaced")], started_at: "2026-09-05T18:04:00.000Z", ended_at: "2026-09-05T18:06:00.000Z" };

test("'Replace it' in the question box: the person's request opens the replacing run, is not the replaced run's gate answer, and closes the replaced run", () => {
  const p = project({
    session: [
      uLine("2026-09-05T18:00:00.000Z", "fix the bug where parseDate accepts 30 February"),
      skillCall("2026-09-05T18:00:05.000Z", "mmo:bugfix", { out: M }),
      msg("a1", "2026-09-05T18:05:00.000Z"),
      msg("a_gate", "2026-09-05T18:15:05.000Z"), // run A shows Gate 2 and waits
      uLine("2026-09-05T18:20:00.000Z", "also write the API docs for parseDate"),
      askCall("2026-09-05T18:20:05.000Z"), // zero-touch's Queue it / Replace it question
      toolResult("2026-09-05T18:20:30.000Z", "Replace it"),
      skillCall("2026-09-05T18:20:35.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T18:25:00.000Z"),
      msg("b2", "2026-09-05T18:30:00.000Z"),
    ],
    runs: [
      replacedRunA,
      { id: "r-b", log: [logLine("2026-09-05T18:21:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T18:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T18:24:00.000Z", ended_at: "2026-09-05T18:31:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /gates: 1 in the run log; 0 answered by a typed message/, "the request is not run A's answer to Gate 2");
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:20:00\.000Z\n/);
    assert.match(a.stdout, /closes at the person's turn 2026-09-05T18:20:00\.000Z that asked for the job which replaced this run/);
    assert.equal(counted(a.stdout), 3, a.stdout); // its Skill call, a1, a_gate
    assert.equal(overhead(a.stdout), 30);
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /window 2026-09-05T18:20:00\.000Z → end of session/);
    assert.match(b.stdout, /opens at the run's command turn 2026-09-05T18:20:00\.000Z/);
    assert.doesNotMatch(b.stdout, /queued run/);
    assert.equal(counted(b.stdout), 4, b.stdout); // the question box, its Skill call, b1, b2
    assert.equal(overhead(b.stdout), 40);
    assert.equal(overhead(a.stdout) + overhead(b.stdout), 70, "every message is counted once, by one run");
    assert.deepEqual(p.write("r-a"), { start: "2026-09-05T18:00:00.000Z", end: "2026-09-05T18:20:00.000Z", start_anchor: "command turn", end_anchor: "replacing request's turn", exact: true, session_id: "sess-q", source: "manifest", lower_bound: false });
  } finally { p.rm(); }
});

test("'Replace it' after a typed command: the typed command opens the replacing run, and the replaced run closes there instead of running to the end of the session", () => {
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a1", "2026-09-05T18:05:00.000Z"),
      msg("a_gate", "2026-09-05T18:15:05.000Z"),
      typed("2026-09-05T18:20:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      askCall("2026-09-05T18:20:05.000Z"),
      toolResult("2026-09-05T18:20:30.000Z", "Replace it"),
      msg("b0", "2026-09-05T18:20:35.000Z"), // "carry on with the command the person typed"
      msg("b1", "2026-09-05T18:25:00.000Z"),
    ],
    runs: [
      { ...replacedRunA, started_at: "2026-09-05T18:04:00.000Z" },
      { id: "r-b", log: [logLine("2026-09-05T18:21:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T18:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T18:24:00.000Z", ended_at: "2026-09-05T18:26:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:20:00\.000Z\n/);
    assert.equal(counted(a.stdout), 2, a.stdout); // a1, a_gate
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /opens at the run's command turn 2026-09-05T18:20:00\.000Z/);
    assert.equal(counted(b.stdout), 3, b.stdout); // the question box, b0, b1
    assert.equal(overhead(a.stdout) + overhead(b.stdout), 50, "every message is counted once, by one run");
  } finally { p.rm(); }
});

// ── A typed command that zero-touch queued is not a command turn ───────────

test("a run command typed while another run waits at Gate 0, and queued, does not open that run's window: it opens at its own command turn", () => {
  // Brownfield run A typed /mmo:bugfix at 18:00; while its Gate 0 waits the person types /mmo:docs, which zero-touch
  // queues (it tells Claude not to run the typed command now). A's run.start comes at 18:15. A ends at 18:30 and the
  // Stop hook starts the queued docs job with a Skill call at 18:30:10.
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a_intake", "2026-09-05T18:01:00.000Z"),
      msg("a_gate0", "2026-09-05T18:05:00.000Z"),
      typed("2026-09-05T18:10:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("a_queued_ack", "2026-09-05T18:10:05.000Z"),
      msg("a_run", "2026-09-05T18:20:00.000Z"),
      stopHookContext("2026-09-05T18:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T18:30:10.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T18:35:00.000Z"),
    ],
    runs: [
      { id: "r-a", log: [logLine("2026-09-05T18:15:00.000Z", "run.start", "run_id=r-a"), logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-a outcome=completed")], started_at: "2026-09-05T18:19:00.000Z", ended_at: "2026-09-05T18:21:00.000Z" },
      { id: "r-b", log: [logLine("2026-09-05T18:31:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T18:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T18:34:00.000Z", ended_at: "2026-09-05T18:36:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:30:10\.000Z/);
    assert.match(a.stdout, /opens at the run's command turn 2026-09-05T18:00:00\.000Z/);
    assert.equal(counted(a.stdout), 4, a.stdout); // a_intake, a_gate0, a_queued_ack, a_run
    assert.equal(overhead(a.stdout), 40);
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /window 2026-09-05T18:30:10\.000Z → end of session/);
    assert.equal(overhead(b.stdout), 20);
  } finally { p.rm(); }
});

test("a run command queued while Gate 4 waits after run.end keeps the run's window open to the queued run's Skill call, and the typed Gate 4 answer stays the run's", () => {
  const p = project({
    session: [
      typed("2026-09-05T10:00:00.000Z", "/mmo:bugfix", "the /login endpoint returns 500 on a missing password"),
      msg("a1", "2026-09-05T10:05:00.000Z"),
      msg("a_gate4", "2026-09-05T10:20:40.000Z"), // run A shows Gate 4 after its run.end
      typed("2026-09-05T10:22:00.000Z", "/mmo:docs", "write the API docs for /login"),
      msg("a_ack", "2026-09-05T10:22:05.000Z"),
      uLine("2026-09-05T10:25:00.000Z", "approved"), // Gate 4, typed
      msg("a_close", "2026-09-05T10:26:00.000Z"),
      stopHookContext("2026-09-05T10:26:50.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T10:27:00.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T10:30:00.000Z"),
    ],
    runs: [
      {
        id: "r-a",
        log: [
          logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-a"),
          logLine("2026-09-05T10:20:00.000Z", "run.end", "run_id=r-a outcome=completed"),
          logLine("2026-09-05T10:20:30.000Z", "gate.open", "run_id=r-a gate=gate-4 title=\"Accept\""),
          logLine("2026-09-05T10:25:30.000Z", "gate.resolved", "run_id=r-a gate=gate-4 response=approved"),
        ],
        started_at: "2026-09-05T10:04:00.000Z",
        ended_at: "2026-09-05T10:06:00.000Z",
      },
      { id: "r-b", log: [logLine("2026-09-05T10:28:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T10:31:00.000Z", ended_at: "2026-09-05T10:33:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /gates: 1 in the run log; 1 answered by a typed message \(gate-4 at 2026-09-05T10:25:00\.000Z\)/);
    assert.match(a.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:27:00\.000Z/);
    assert.equal(counted(a.stdout), 4, a.stdout); // a1, a_gate4, a_ack, a_close
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /window 2026-09-05T10:27:00\.000Z → end of session/);
    assert.equal(overhead(a.stdout) + overhead(b.stdout), 60, "every message is counted once, by one run");
  } finally { p.rm(); }
});

test("a run command queued while a gate is open is not that gate's answer: the typed answer after it still is", () => {
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a1", "2026-09-05T18:05:00.000Z"),
      msg("a_gate2", "2026-09-05T18:15:05.000Z"),
      typed("2026-09-05T18:16:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("a_ack", "2026-09-05T18:16:05.000Z"),
      uLine("2026-09-05T18:17:00.000Z", "approved"),
      msg("a2", "2026-09-05T18:20:00.000Z"),
      stopHookContext("2026-09-05T18:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T18:30:10.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T18:35:00.000Z"),
    ],
    runs: [
      {
        id: "r-a",
        log: [
          logLine("2026-09-05T18:01:00.000Z", "run.start", "run_id=r-a"),
          logLine("2026-09-05T18:15:00.000Z", "gate.open", "run_id=r-a gate=gate-2 title=\"Design\""),
          logLine("2026-09-05T18:17:30.000Z", "gate.resolved", "run_id=r-a gate=gate-2 response=approved"),
          logLine("2026-09-05T18:30:00.000Z", "run.end", "run_id=r-a outcome=completed"),
        ],
        started_at: "2026-09-05T18:04:00.000Z",
        ended_at: "2026-09-05T18:21:00.000Z",
      },
      { id: "r-b", log: [logLine("2026-09-05T18:31:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T18:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T18:34:00.000Z", ended_at: "2026-09-05T18:36:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /gates: 1 in the run log; 1 answered by a typed message \(gate-2 at 2026-09-05T18:17:00\.000Z\)/);
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:30:10\.000Z/);
    assert.equal(counted(a.stdout), 4, a.stdout); // a1, a_gate2, a_ack, a2
  } finally { p.rm(); }
});

test("a typed run command that started its own run stays its command turn when a later request for the same job is queued", () => {
  for (const [label, before, firstRunLog] of [
    // No run was going when the person typed /mmo:docs, so it started run X directly.
    ["no run in progress", [], []],
    // /mmo:docs replaced the running bugfix run ("Replace it"); the person then asked for more docs in plain words,
    // which zero-touch queued.
    ["it replaced the running run", [
      typed("2026-09-05T09:50:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("w1", "2026-09-05T09:55:00.000Z"),
    ], [logLine("2026-09-05T09:51:00.000Z", "run.start", "run_id=r-w"), logLine("2026-09-05T10:00:30.000Z", "run.end", "run_id=r-w outcome=aborted reason=replaced")]],
  ]) {
    const p = project({
      session: [
        ...before,
        typed("2026-09-05T10:00:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
        ...(before.length ? [askCall("2026-09-05T10:00:05.000Z"), toolResult("2026-09-05T10:00:25.000Z", "Replace it")] : [msg("x0", "2026-09-05T10:00:05.000Z")]),
        msg("x1", "2026-09-05T10:05:00.000Z"),
        uLine("2026-09-05T10:20:00.000Z", "and the API docs for formatDate too"), // queued in plain words
        msg("x_ack", "2026-09-05T10:20:05.000Z"),
        msg("x2", "2026-09-05T10:25:00.000Z"),
        stopHookContext("2026-09-05T10:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
        skillCall("2026-09-05T10:30:10.000Z", "mmo:docs", { out: M }),
        msg("y1", "2026-09-05T10:35:00.000Z"),
      ],
      runs: [
        ...(firstRunLog.length ? [{ id: "r-w", log: firstRunLog, started_at: "2026-09-05T09:54:00.000Z", ended_at: "2026-09-05T09:56:00.000Z" }] : []),
        { id: "r-x", log: [logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-x"), logLine("2026-09-05T10:30:00.000Z", "run.end", "run_id=r-x outcome=completed")], started_at: "2026-09-05T10:04:00.000Z", ended_at: "2026-09-05T10:26:00.000Z" },
        { id: "r-y", log: [logLine("2026-09-05T10:31:00.000Z", "run.start", "run_id=r-y"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-y outcome=completed")], started_at: "2026-09-05T10:34:00.000Z", ended_at: "2026-09-05T10:36:00.000Z" },
      ],
    });
    try {
      const x = p.run("r-x");
      assert.equal(x.status, 0, `${label}: ${x.stderr}`);
      assert.match(x.stdout, /opens at the run's command turn 2026-09-05T10:00:00\.000Z/, label);
      assert.match(x.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:30:10\.000Z/, label);
      assert.equal(counted(x.stdout), 4, `${label}: ${x.stdout}`); // x0 or the question box, x1, x_ack, x2
      const y = p.run("r-y");
      assert.equal(y.status, 0, `${label}: ${y.stderr}`);
      assert.match(y.stdout, /window 2026-09-05T10:30:10\.000Z → end of session/, label);
    } finally { p.rm(); }
  }
});

// ── Helper files are pruned against the window's real opening ───────────────

test("a helper that finished between the command turn and run.start is counted: the file prune reaches back to the command turn", () => {
  // Brownfield: the command turn at 09:40, the discovery helper 09:41-09:45, Gate 0, then run.start at 10:05.
  const p = project({
    session: [
      typed("2026-10-05T09:40:00.000Z", "/mmo:feature-extend", "add a ?filter param to /users"),
      msg("m_intake", "2026-10-05T09:40:20.000Z"),
      msg("m_run", "2026-10-05T10:12:00.000Z"),
    ],
    helpers: { "agent-disc.jsonl": [msg("h1", "2026-10-05T09:41:00.000Z"), msg("h2", "2026-10-05T09:45:00.000Z")] },
    // The helper file's last write is when it finished; the session file is written until after run.end.
    mtimes: { "sess-q/subagents/agent-disc.jsonl": "2026-10-05T09:45:00.000Z", "sess-q.jsonl": "2026-10-05T10:31:00.000Z" },
    runs: [{ id: "r-f", log: [logLine("2026-10-05T10:05:00.000Z", "run.start", "run_id=r-f"), logLine("2026-10-05T10:30:00.000Z", "run.end", "run_id=r-f outcome=completed")], started_at: "2026-10-05T10:10:00.000Z", ended_at: "2026-10-05T10:14:00.000Z" }],
  });
  try {
    const r = p.run("r-f");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at the run's command turn 2026-10-05T09:40:00\.000Z/);
    assert.match(r.stdout, /scanned 2 file\(s\)/, r.stdout);
    assert.equal(counted(r.stdout), 4, r.stdout); // m_intake, h1, h2, m_run
    assert.equal(overhead(r.stdout), 40);
  } finally { p.rm(); }
});

// ── A pre-flight event never anchors the run ────────────────────────────────

test("a pre-flight event before run.start does not hide run.start: the window stays exact and the typed gate answer is the run's", () => {
  // The run-start typist probe logs its event 10 s before run.start; a manifest built with it as started_at put the
  // first "dispatch" before run.start, so run.start (looked for at or before it) was never found.
  const p = project({
    session: [
      typed("2026-09-05T18:51:15.673Z", "/mmo:pass", "--auth=vendor --policy=check-window --run-id=r-p brief.md"),
      msg("m_setup", "2026-09-05T18:51:30.000Z"),
      msg("m_pre", "2026-09-05T18:56:00.000Z"),
      uLine("2026-09-05T18:58:00.000Z", "approved"),
      msg("m_in", "2026-09-05T19:05:30.000Z"),
      uLine("2026-09-05T19:20:00.000Z", "thanks, now summarise what you did"),
      msg("m_after", "2026-09-05T19:21:00.000Z"),
    ],
    runs: [{
      id: "r-p",
      log: [
        logLine("2026-09-05T18:53:03.107Z", "run.start", "run_id=r-p mode=greenfield"),
        logLine("2026-09-05T18:57:00.000Z", "gate.open", "run_id=r-p gate=gate-1 title=\"Requirements\""),
        logLine("2026-09-05T18:59:00.000Z", "gate.resolved", "run_id=r-p gate=gate-1 response=approved"),
        logLine("2026-09-05T19:06:30.000Z", "run.end", "run_id=r-p outcome=completed"),
      ],
      started_at: "2026-09-05T18:52:53.107Z", // the probe's event, as a builder that counted it wrote it
      ended_at: "2026-09-05T19:06:00.000Z",
      telemetry: [
        { ts: "2026-09-05T18:52:53.107Z", pass: "r-p", phase: "preflight", task_id: "typist-probe", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.01 },
        { ts: "2026-09-05T19:05:00.000Z", pass: "r-p", phase: "codegen", task_id: "t-1", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.5 },
      ],
    }],
  });
  try {
    const r = p.run("r-p");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gates: 1 in the run log; 1 answered by a typed message \(gate-1 at 2026-09-05T18:58:00\.000Z\)/);
    assert.match(r.stdout, /window 2026-09-05T18:51:15\.673Z → 2026-09-05T19:20:00\.000Z\n/);
    assert.doesNotMatch(r.stdout, /approximate/);
    assert.equal(counted(r.stdout), 3, r.stdout);
    assert.equal(overhead(r.stdout), 30);
    assert.match(r.stdout, /→ true total \$30\.51\b/, "the probe's dollars are still spend");
  } finally { p.rm(); }
});

test("the run-start typist probe 10 s before run.start: whichever way the manifest was built, the window stays exact, both typed gate answers are the run's, and the overhead is the whole $50", () => {
  // The probe's event (phase "preflight") is stamped before the orchestrator logs run.start. A manifest whose
  // started_at was that event put the "first dispatch" before run.start, so run.start was never found, both typed gate
  // answers read as new invocations and the window closed at ended_at + 5 minutes ($20 of $50, approximate).
  const WRITE_MANIFEST = join(HERE, "..", "..", "..", "scripts", "write-manifest.mjs");
  const telemetry = [
    { ts: "2026-09-05T10:00:30.000Z", pass: "r-d", phase: "preflight", task_id: "typist-probe", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.01, input_tokens: 10, input_tokens_cached: 0, output_tokens: 1, module: "preflight", task_type: "typist_probe", success: true },
    { ts: "2026-09-05T10:10:00.000Z", pass: "r-d", phase: "codegen", task_id: "t-1", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.25, input_tokens: 100, input_tokens_cached: 0, output_tokens: 10, module: "app", task_type: "service_method", success: true },
    { ts: "2026-09-05T10:20:00.000Z", pass: "r-d", phase: "tests", task_id: "t-2", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.25, input_tokens: 100, input_tokens_cached: 0, output_tokens: 10, module: "app", task_type: "unit_test", success: true },
  ];
  // How the manifest got its window: written by write-manifest.mjs (buildManifest), absent (the collector rebuilds it
  // with buildManifest), or written by a builder that counted the probe (started_at = the probe's event).
  for (const how of ["write-manifest", "rebuilt", "probe as started_at"]) {
    const p = project({
      session: [
        typed("2026-09-05T10:00:00.000Z", "/mmo:pass", "--auth=vendor --run-id=r-d brief.md"),
        msg("m1", "2026-09-05T10:00:10.000Z"),
        uLine("2026-09-05T10:06:00.000Z", "approved"),     // Gate 1, typed
        msg("m2", "2026-09-05T10:08:00.000Z"),
        msg("m3", "2026-09-05T10:30:00.000Z"),
        msg("m4", "2026-09-05T10:47:00.000Z"),
        uLine("2026-09-05T10:50:00.000Z", "accept"),       // Gate 4, typed, after run.end
        msg("m5", "2026-09-05T10:55:00.000Z"),
        uLine("2026-09-05T11:00:00.000Z", "thanks, now summarise what you did"),
        msg("m6", "2026-09-05T11:01:00.000Z"),
      ],
      runs: [{
        id: "r-d",
        log: [
          logLine("2026-09-05T10:00:40.000Z", "run.start", "run_id=r-d mode=greenfield"),
          logLine("2026-09-05T10:05:00.000Z", "gate.open", "run_id=r-d gate=gate-1 title=\"Requirements\""),
          logLine("2026-09-05T10:06:30.000Z", "gate.resolved", "run_id=r-d gate=gate-1 response=approved"),
          logLine("2026-09-05T10:45:00.000Z", "run.end", "run_id=r-d outcome=completed"),
          logLine("2026-09-05T10:46:00.000Z", "gate.open", "run_id=r-d gate=gate-4 title=\"Accept\""),
          logLine("2026-09-05T10:50:30.000Z", "gate.resolved", "run_id=r-d gate=gate-4 response=accept"),
        ],
        started_at: "2026-09-05T10:00:30.000Z",
        ended_at: "2026-09-05T10:20:00.000Z",
        telemetry,
      }],
    });
    try {
      const passDir = join(p.root, "passes", "r-d");
      if (how === "write-manifest") {
        const w = spawnSync(process.execPath, [WRITE_MANIFEST, passDir, "--pass", "r-d", "--policy", "check-window", "--project-root", p.root], { encoding: "utf-8", env: ENV });
        assert.equal(w.status, 0, w.stderr);
        const m = JSON.parse(readFileSync(join(passDir, "manifest.json"), "utf-8"));
        assert.equal(m.started_at, "2026-09-05T10:10:00.000Z", "started_at is the first dispatched event after pre-flight");
        assert.equal(m.total_cost_usd, 0.51, "the probe's dollars are still spend");
      } else if (how === "rebuilt") {
        writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "r-d", policy_name: "check-window" }));
      }
      const r = p.run("r-d");
      assert.equal(r.status, 0, `${how}: ${r.stderr}`);
      assert.match(r.stdout, /gates: 2 in the run log; 2 answered by a typed message \(gate-1 at 2026-09-05T10:06:00\.000Z, gate-4 at 2026-09-05T10:50:00\.000Z\)/, how);
      assert.match(r.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T11:00:00\.000Z\n/, how);
      assert.doesNotMatch(r.stdout, /approximate/, how);
      assert.equal(counted(r.stdout), 5, `${how}: ${r.stdout}`);
      assert.equal(overhead(r.stdout), 50, how);
      assert.match(r.stdout, /→ true total \$50\.51\b/, `${how}: the probe's dollars stay in the dispatched total`);
    } finally { p.rm(); }
  }
});

// zero-touch drops its queue when the running run ends without completing (an abort), so a run command typed during
// that run and queued never starts a run of its own. It is still a queued request, not the run's command turn: the run
// it was typed during keeps its window to the person's next turn after its end.
test("a run command queued during a run that then aborts never starts, and does not cut the aborted run's window", () => {
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a_intake", "2026-09-05T18:01:00.000Z"),
      typed("2026-09-05T18:10:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("a_queued_ack", "2026-09-05T18:10:05.000Z"),
      msg("a_run", "2026-09-05T18:15:00.000Z"),
      uLine("2026-09-05T18:25:00.000Z", "thanks, leave it there"),
      msg("after", "2026-09-05T18:25:05.000Z"),
    ],
    runs: [
      { id: "r-a", log: [logLine("2026-09-05T18:02:00.000Z", "run.start", "run_id=r-a"), logLine("2026-09-05T18:20:00.000Z", "run.end", "run_id=r-a outcome=aborted")], started_at: "2026-09-05T18:14:00.000Z", ended_at: "2026-09-05T18:16:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → 2026-09-05T18:25:00\.000Z/, a.stdout);
    assert.equal(counted(a.stdout), 3, a.stdout); // a_intake, a_queued_ack, a_run
  } finally { p.rm(); }
});

// A run that aborted is over whatever gate it left open: a command typed after the abort is the person's next run, not
// a queued request, so it opens its own window.
test("a gate left open by a run that aborted does not make a later typed command a queued request", () => {
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a1", "2026-09-05T18:01:00.000Z"),
      typed("2026-09-05T18:30:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("b1", "2026-09-05T18:31:00.000Z"),
    ],
    runs: [
      { id: "r-a", log: [logLine("2026-09-05T18:02:00.000Z", "run.start", "run_id=r-a"), logLine("2026-09-05T18:05:00.000Z", "gate.open", "run_id=r-a gate=gate-1"), logLine("2026-09-05T18:10:00.000Z", "run.end", "run_id=r-a outcome=aborted")], started_at: "2026-09-05T18:01:00.000Z", ended_at: "2026-09-05T18:02:00.000Z" },
      { id: "r-b", log: [logLine("2026-09-05T18:30:30.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T18:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T18:31:00.000Z", ended_at: "2026-09-05T18:32:00.000Z" },
    ],
  });
  try {
    const b = p.run("r-b");
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /opens at the run's command turn 2026-09-05T18:30:00\.000Z/, b.stdout);
  } finally { p.rm(); }
});

// Whether a run was going when a run command was typed follows zero-touch's own rule (workflow-log.mjs workflowState):
// a run that logged an abort or a failure is over whatever gate it left open, a gate answered revise or reject stays
// open, and a run command typed during a run that never started a run of its own job is a queued request even when
// zero-touch later dropped its queue.
test("a run zero-touch stopped at an open gate is over: the command typed after it starts its own run, which keeps its own window", () => {
  const p = project({
    session: [
      typed("2026-09-05T09:40:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("w1", "2026-09-05T09:45:00.000Z"),
      msg("w_gate2", "2026-09-05T09:50:05.000Z"),
      uLine("2026-09-05T09:55:00.000Z", "stop the workflow"),
      msg("w_stopped", "2026-09-05T09:55:05.000Z"),
      typed("2026-09-05T10:00:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("x0", "2026-09-05T10:00:05.000Z"),
      msg("x1", "2026-09-05T10:05:00.000Z"),
      uLine("2026-09-05T10:20:00.000Z", "and the API docs for formatDate too"),
      msg("x_ack", "2026-09-05T10:20:05.000Z"),
      msg("x2", "2026-09-05T10:25:00.000Z"),
      stopHookContext("2026-09-05T10:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T10:30:10.000Z", "mmo:docs", { out: M }),
      msg("y1", "2026-09-05T10:35:00.000Z"),
    ],
    runs: [
      { id: "r-w", log: [
        logLine("2026-09-05T09:41:00.000Z", "run.start", "run_id=r-w"),
        logLine("2026-09-05T09:50:00.000Z", "gate.open", "run_id=r-w gate=gate-2 title=\"Design\""),
        logLine("2026-09-05T09:55:01.000Z", "run.end", "run_id=r-w outcome=aborted reason=stopped"),
      ], started_at: "2026-09-05T09:44:00.000Z", ended_at: "2026-09-05T09:46:00.000Z" },
      { id: "r-x", log: [logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-x"), logLine("2026-09-05T10:30:00.000Z", "run.end", "run_id=r-x outcome=completed")], started_at: "2026-09-05T10:04:00.000Z", ended_at: "2026-09-05T10:26:00.000Z" },
      { id: "r-y", log: [logLine("2026-09-05T10:31:00.000Z", "run.start", "run_id=r-y"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-y outcome=completed")], started_at: "2026-09-05T10:34:00.000Z", ended_at: "2026-09-05T10:36:00.000Z" },
    ],
  });
  try {
    const w = p.run("r-w"), x = p.run("r-x"), y = p.run("r-y");
    for (const r of [w, x, y]) assert.equal(r.status, 0, r.stderr);
    assert.equal(overhead(w.stdout), 30, w.stdout);
    assert.match(x.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:30:10\.000Z/, x.stdout);
    assert.equal(overhead(x.stdout), 40);
    assert.equal(overhead(y.stdout), 20);
  } finally { p.rm(); }
});

test("a run command queued and then dropped (its run aborted) is still a queued request: the running run keeps its own command turn", () => {
  const p = project({
    session: [
      typed("2026-09-05T18:00:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("a_intake", "2026-09-05T18:01:00.000Z"),
      msg("a_gate0", "2026-09-05T18:05:00.000Z"),
      typed("2026-09-05T18:10:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("a_queued_ack", "2026-09-05T18:10:05.000Z"),
      uLine("2026-09-05T18:12:00.000Z", "approved"),
      msg("a_run", "2026-09-05T18:20:00.000Z"),
      uLine("2026-09-05T18:25:00.000Z", "abort"),
      msg("a_end", "2026-09-05T18:25:30.000Z"),
    ],
    runs: [
      { id: "r-a", log: [
        logLine("2026-09-05T18:04:00.000Z", "gate.open", "run_id=r-a gate=gate-0 title=\"Scope\""),
        logLine("2026-09-05T18:12:10.000Z", "gate.resolved", "run_id=r-a gate=gate-0 response=approved"),
        logLine("2026-09-05T18:15:00.000Z", "run.start", "run_id=r-a"),
        logLine("2026-09-05T18:20:30.000Z", "gate.open", "run_id=r-a gate=gate-2 title=\"Design\""),
        logLine("2026-09-05T18:25:10.000Z", "gate.resolved", "run_id=r-a gate=gate-2 response=abort"),
        logLine("2026-09-05T18:25:20.000Z", "run.end", "run_id=r-a outcome=aborted"),
      ], started_at: "2026-09-05T18:19:00.000Z", ended_at: "2026-09-05T18:21:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /window 2026-09-05T18:00:00\.000Z → end of session/, a.stdout);
    assert.equal(counted(a.stdout), 5);
    assert.equal(overhead(a.stdout), 50);
  } finally { p.rm(); }
});

test("a gate answered revise stays open: a command queued during the revision does not close the run before its queued start", () => {
  const p = project({
    session: [
      typed("2026-09-05T10:00:00.000Z", "/mmo:bugfix", "the /login endpoint returns 500 on a missing password"),
      msg("a1", "2026-09-05T10:05:00.000Z"),
      msg("a_gate4", "2026-09-05T10:20:40.000Z"),
      uLine("2026-09-05T10:21:00.000Z", "reject: the test name is wrong"),
      msg("a_rev1", "2026-09-05T10:21:30.000Z"),
      typed("2026-09-05T10:22:00.000Z", "/mmo:docs", "write the API docs for /login"),
      msg("a_ack", "2026-09-05T10:22:05.000Z"),
      msg("a_rev2", "2026-09-05T10:23:00.000Z"),
      msg("a_gate4b", "2026-09-05T10:24:00.000Z"),
      uLine("2026-09-05T10:25:00.000Z", "approved"),
      msg("a_close", "2026-09-05T10:26:00.000Z"),
      stopHookContext("2026-09-05T10:26:50.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T10:27:00.000Z", "mmo:docs", { out: M }),
      msg("b1", "2026-09-05T10:30:00.000Z"),
    ],
    runs: [
      { id: "r-a", log: [
        logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-a"),
        logLine("2026-09-05T10:20:00.000Z", "run.end", "run_id=r-a outcome=completed"),
        logLine("2026-09-05T10:20:30.000Z", "gate.open", "run_id=r-a gate=gate-4 title=\"Accept\""),
        logLine("2026-09-05T10:21:10.000Z", "gate.resolved", "run_id=r-a gate=gate-4 response=revise"),
        logLine("2026-09-05T10:23:50.000Z", "gate.open", "run_id=r-a gate=gate-4 title=\"Accept\""),
        logLine("2026-09-05T10:25:30.000Z", "gate.resolved", "run_id=r-a gate=gate-4 response=approved"),
      ], started_at: "2026-09-05T10:04:00.000Z", ended_at: "2026-09-05T10:23:00.000Z" },
      { id: "r-b", log: [logLine("2026-09-05T10:28:00.000Z", "run.start", "run_id=r-b"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-b outcome=completed")], started_at: "2026-09-05T10:31:00.000Z", ended_at: "2026-09-05T10:33:00.000Z" },
    ],
  });
  try {
    const a = p.run("r-a"), b = p.run("r-b");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:27:00\.000Z/, a.stdout);
    assert.equal(overhead(a.stdout), 70);
    assert.equal(overhead(b.stdout), 20);
  } finally { p.rm(); }
});

test("a run that ended with its gates answered is over: the next typed command starts its own run, not a queued one", () => {
  const p = project({
    session: [
      typed("2026-09-05T09:40:00.000Z", "/mmo:bugfix", "the date parser accepts 30 February"),
      msg("w1", "2026-09-05T09:45:00.000Z"),
      msg("w_gate4", "2026-09-05T09:50:05.000Z"),
      uLine("2026-09-05T09:55:00.000Z", "approved"),
      msg("w_close", "2026-09-05T09:55:05.000Z"),
      typed("2026-09-05T10:00:00.000Z", "/mmo:docs", "write the API docs for parseDate"),
      msg("x0", "2026-09-05T10:00:05.000Z"),
      msg("x1", "2026-09-05T10:05:00.000Z"),
      uLine("2026-09-05T10:20:00.000Z", "and the API docs for formatDate too"),
      msg("x_ack", "2026-09-05T10:20:05.000Z"),
      msg("x2", "2026-09-05T10:25:00.000Z"),
      stopHookContext("2026-09-05T10:30:08.000Z", "Start it now with the Skill tool: skill \"mmo:docs\""),
      skillCall("2026-09-05T10:30:10.000Z", "mmo:docs", { out: M }),
      msg("y1", "2026-09-05T10:35:00.000Z"),
    ],
    runs: [
      { id: "r-w", log: [
        logLine("2026-09-05T09:41:00.000Z", "run.start", "run_id=r-w"),
        logLine("2026-09-05T09:50:00.000Z", "run.end", "run_id=r-w outcome=completed"),
        logLine("2026-09-05T09:50:01.000Z", "gate.open", "run_id=r-w gate=gate-4 title=\"Accept\""),
        logLine("2026-09-05T09:55:01.000Z", "gate.resolved", "run_id=r-w gate=gate-4 response=approved"),
      ], started_at: "2026-09-05T09:44:00.000Z", ended_at: "2026-09-05T09:46:00.000Z" },
      { id: "r-x", log: [logLine("2026-09-05T10:01:00.000Z", "run.start", "run_id=r-x"), logLine("2026-09-05T10:30:00.000Z", "run.end", "run_id=r-x outcome=completed")], started_at: "2026-09-05T10:04:00.000Z", ended_at: "2026-09-05T10:26:00.000Z" },
      { id: "r-y", log: [logLine("2026-09-05T10:31:00.000Z", "run.start", "run_id=r-y"), logLine("2026-09-05T10:40:00.000Z", "run.end", "run_id=r-y outcome=completed")], started_at: "2026-09-05T10:34:00.000Z", ended_at: "2026-09-05T10:36:00.000Z" },
    ],
  });
  try {
    const w = p.run("r-w"), x = p.run("r-x"), y = p.run("r-y");
    for (const r of [w, x, y]) assert.equal(r.status, 0, r.stderr);
    assert.equal(overhead(w.stdout), 30);
    assert.match(x.stdout, /window 2026-09-05T10:00:00\.000Z → 2026-09-05T10:30:10\.000Z/, x.stdout);
    assert.equal(overhead(x.stdout), 40);
    assert.equal(overhead(y.stdout), 20);
  } finally { p.rm(); }
});
