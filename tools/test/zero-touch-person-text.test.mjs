/**
 * Everything zero-touch shows a person is written for the person.
 *
 * Why: Claude Code shows a refusal's reason (in red, as "PreToolUse:Skill hook error: ..."), a Stop hook's block
 * reason and every systemMessage to the person. Tool names, JSON, policy and script names, "/clear", raw error output
 * and a doubled full stop must never be among them. So every such string is built here from the code, with every
 * cause and kind, and checked against words a person must never be shown.
 * Instructions for Claude travel separately (a refusal's additionalContext) and are not checked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const lib = (f) => import(join(ROOT, "plugin", "scripts", "ambient", "lib", f));
const RF = await lib("route-flow.mjs");
const H = await lib("handoff.mjs");

/** Words a person must never read: plugin internals, tools, files, commands, raw output. */
const FORBIDDEN = [
  [/\bmmo\b|\/mmo|mmo:/i, "the plugin's internal name or a command"],
  [/\bSkill tool\b|AskUserQuestion|additionalContext/, "a Claude Code tool or field"],
  [/write_document|write_tests_from_cases|repeat_edit_across_files|undo_hand_off|execute_stage|execute_with_model/, "a hand-off or server tool"],
  [/\bMCP\b|model-dispatch/i, "the server"],
  [/[{}]/, "JSON"],
  [/opus-plus|opus-only|-v38\b|routing-policy|\bpolicy\b/i, "a policy name"],
  [/verify-setup|driver-model-check|\.mjs\b|npm |gcloud/, "a script or command"],
  [/\/clear\b|\/reload-plugins|\/model\b(?! claude)/, "a slash command"],
  [/CLAUDE_CODE|GEMINI_API_KEY|GOOGLE_[A-Z_]+/, "an environment variable"],
  [/\.\.(?!\.)/, "a doubled full stop"],
];

function check(label, text) {
  assert.equal(typeof text, "string", `${label}: a string`);
  for (const [re, what] of FORBIDDEN) assert.doesNotMatch(text, re, `${label} shows ${what}: ${JSON.stringify(text)}`);
  assert.match(text, /^Zero-touch[: ]/, `${label} starts with the label, so the person can tell it from Claude's reply`);
}

const JOBS = ["greenfield", "bugfix", "feature-extend", "feature-new", "refactor", "test", "docs", "deps"];
const PROBLEMS = [
  { cause: "busy", job: "bugfix" }, { cause: "busy", job: null }, { cause: "google" }, { cause: "not-built" },
  { cause: "chat-model", have: "claude-opus-5-5", needed: "claude-opus-5", via: "chat" },
  { cause: "chat-model", have: "claude-opus-4-8", needed: "claude-opus-5", via: "setting" },
  { cause: "chat-model", have: "opus", needed: "claude-opus-5", via: "setting" },
  { cause: "check", why: "driver-model-check FAILED: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, restart the run." },
  { cause: "check", why: "spawnSync node ETIMEDOUT" }, { cause: "check", why: "something else at /Users/x/plugin.mjs." },
  { cause: "no-git", projectDir: "/Users/x/shop" }, { cause: "git-missing", projectDir: "/Users/x/shop" },
];

test("workflow-mode lines, for every job, cause and outcome", () => {
  const L = RF.PERSON_LINE;
  for (const job of JOBS) {
    check(`starting(${job})`, L.starting(job));
    check(`startingQueued(${job})`, L.startingQueued(job, "bugfix"));
    check(`startingQueued(${job}, none)`, L.startingQueued(job, null));
    check(`alreadyRunning(${job})`, L.alreadyRunning("bugfix", job));
    for (const p of PROBLEMS) check(`notStarted(${job}, ${p.cause})`, L.notStarted(p, job));
    for (const mode of ["a", "b"]) for (const outcome of ["completed", "aborted", "failed", "stopped"]) check(`ended(${job}, ${mode}, ${outcome})`, L.ended(job, mode, outcome));
    check(`queued(${job})`, L.queued(job, "bugfix"));
    check(`queuedTwice(${job})`, L.queuedTwice(job));
    check(`replaced(${job})`, L.replaced(job, "bugfix"));
    check(`stopped(${job})`, L.stopped(job, true));
    check(`lostFolder(${job})`, L.lostFolder(job));
    check(`didntStart(${job})`, L.didntStart(job));
    check(`switchDuringWorkflow(${job})`, L.switchDuringWorkflow(job, "claude-opus-5"));
  }
  check("neither", L.neither("bugfix"));
  check("turnedOff", L.turnedOff());
  check("breaker", L.breaker());
  check("notAJob", L.notAJob());
  check("typedBusyReason", RF.typedBusyReason({ job: "docs" }));
  check("typedBusyReason(no job)", RF.typedBusyReason({}));
});

test("declined messages: a line for each kind that gets one, nothing for ordinary chat", () => {
  for (const kind of ["instruction", "folder-new-app", "folder-no-project", "two-jobs", "brief-in-project"]) check(`declined(${kind})`, RF.declinedLine(kind));
  for (const kind of ["chat", undefined]) assert.equal(RF.declinedLine(kind), null, `${kind}: nothing is said`);
});

test("refusals the person reads", () => {
  for (const job of JOBS) check(`REFUSAL.startFirst(${job})`, RF.REFUSAL.startFirst(job));
  for (const k of ["notNow", "typedOnly", "waitAnswer", "hold", "helperOutside"]) check(`REFUSAL.${k}`, RF.REFUSAL[k]);
  for (const k of ["notHandoffChat", "inWorkflow", "keptInChat", "noGoogle", "commandDenied"]) check(`HANDOFF_REFUSAL.${k}`, H.HANDOFF_REFUSAL[k]);
  check("HANDOFF_ALLOWED", H.HANDOFF_ALLOWED);
  for (const error of ["google", "not-built", "policy", "busy", "other"]) check(`HANDOFF_REFUSAL.unavailable(${error})`, H.HANDOFF_REFUSAL.unavailable({ error }));
  const chat = { name: "Opus 5", reminder: "" };
  for (const kind of ["document", "tests"]) check(`byHandLine(${kind})`, H.byHandLine(kind === "document" ? "docs/setup.md" : "tests/a.test.js", kind, chat, "gemini-3.8-flash"));
});

test("hand-off lines", () => {
  const chat = { name: "Opus 5", reminder: "" };
  const routes = { docs: { model: "gemini-3.8-flash" }, tests: { model: "claude-sonnet-5" }, repeat: { model: "gemini-3.8-flash" } };
  check("handoff(docs, tests, repeat)", H.HANDOFF_LINE.handoff({ kinds: ["docs", "tests", "repeat"], rest: true }, routes, chat));
  check("handoff(no google)", H.HANDOFF_LINE.handoff({ kinds: ["docs"], rest: false }, { docs: { noGoogle: true } }, chat));
  for (const error of ["google", "not-built", "policy", "busy", "other"]) check(`unavailable(${error})`, H.HANDOFF_LINE.unavailable({ error }, chat));
});

test("lines for routing switched off and for a policy this version lacks", () => {
  for (const job of JOBS) {
    check(`routingOff(${job}, project)`, RF.PERSON_LINE.routingOff(job, "project"));
    check(`routingOff(${job}, user)`, RF.PERSON_LINE.routingOff(job, "user"));
    check(`notStarted(${job}, policy-missing)`, RF.PERSON_LINE.notStarted({ cause: "policy-missing" }, job));
  }
});

// The job names are the approved word list. No line names a job with a word the start message never uses (it says
// "clean up code" and "upgrade a library"), such as "refactor workflow" or "dependency-upgrade workflow".
test("job names in every line are the approved ones", () => {
  const approved = {
    greenfield: "new-app build", bugfix: "bug-fix workflow", "feature-extend": "feature workflow", "feature-new": "new-feature workflow",
    refactor: "code-cleanup workflow", test: "test-writing workflow", docs: "documentation workflow", deps: "library-upgrade workflow",
  };
  for (const [job, name] of Object.entries(approved)) assert.equal(RF.plainName(job), name, job);
  for (const job of JOBS) {
    for (const line of [RF.PERSON_LINE.starting(job), RF.PERSON_LINE.ended(job, "on"), RF.PERSON_LINE.stopped(job, false)]) {
      assert.doesNotMatch(line, /\brefactor workflow|dependency-upgrade/, line);
    }
  }
});
