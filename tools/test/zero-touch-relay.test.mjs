/**
 * Lines the person must read are said by Claude where the app folds them away (the desktop app shows such a line, the
 * reason a workflow did not start for one, only inside a folded "Claude Code notice").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const MMO_FILE = join(ROOT, "plugin", "scripts", "ambient", "lib", "relay.mjs");
const ZT_FILE = join(ROOT, "zero-touch", "scripts", "relay.mjs");
const R = await import(MMO_FILE);
const Z = await import(ZT_FILE);

const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
const TERMINAL = { CLAUDE_CODE_ENTRYPOINT: "cli" };
const LINE = "Zero-touch: the new-app workflow didn't start, because this chat is on Opus 5.5 …";

test("zero-touch's copy is mmo's, word for word below the header", () => {
  const body = (file) => { const s = readFileSync(file, "utf8"); return s.slice(s.indexOf("/** The labels of runs with no screen")); };
  assert.equal(body(ZT_FILE), body(MMO_FILE));
});

test("only the terminal shows a line as it is; every other app folds it; a run with no screen reads nothing", () => {
  for (const mod of [R, Z]) {
    assert.equal(mod.linesFolded(TERMINAL), false);
    assert.equal(mod.linesFolded({}), false, "no label at all: the terminal before it set one");
    for (const label of ["sdk-cli", "sdk-ts", "sdk-py"]) assert.equal(mod.linesFolded({ CLAUDE_CODE_ENTRYPOINT: label }), false, label);
    for (const label of ["claude-desktop", "claude-vscode", "something-new"]) assert.equal(mod.linesFolded({ CLAUDE_CODE_ENTRYPOINT: label }), true, label);
  }
});

test("Claude is told to start its reply with the line, word for word; Claude's own instructions follow", () => {
  const out = R.withRelay({ systemMessage: LINE, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "the start note" } }, "UserPromptSubmit", DESKTOP);
  assert.equal(out.systemMessage, LINE, "the line itself is still shown");
  assert.equal(out.hookSpecificOutput.additionalContext, `${R.relayNote(LINE)}\n\nthe start note`);
  assert.match(R.relayNote(LINE), /Start your reply with it, word for word/);
  assert.ok(R.relayNote(LINE).includes(LINE));
  const bare = R.withRelay({ systemMessage: LINE }, "PostToolUse", DESKTOP);
  assert.deepEqual(bare.hookSpecificOutput, { hookEventName: "PostToolUse", additionalContext: R.relayNote(LINE) }, "a line with no note gets one");
});

test("left alone: the terminal, a refusal (shown in red), an end-of-turn line on its own, a moment the model never reads", () => {
  const answer = { systemMessage: LINE, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "note" } };
  assert.deepEqual(R.withRelay(answer, "UserPromptSubmit", TERMINAL), answer);
  const deny = { systemMessage: LINE, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "why" } };
  assert.deepEqual(R.withRelay(deny, "PreToolUse", DESKTOP), deny);
  assert.deepEqual(R.withRelay({ systemMessage: LINE }, "Stop", DESKTOP), { systemMessage: LINE }, "never a new model turn just to repeat a line");
  const goingOn = R.withRelay({ systemMessage: LINE, hookSpecificOutput: { hookEventName: "Stop", additionalContext: "carry on" } }, "Stop", DESKTOP);
  assert.equal(goingOn.hookSpecificOutput.additionalContext, `${R.relayNote(LINE)}\n\ncarry on`, "a turn that goes on anyway says it");
  assert.deepEqual(R.withRelay({ systemMessage: LINE }, null, DESKTOP), { systemMessage: LINE });
  assert.deepEqual(R.withRelay({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } }, "UserPromptSubmit", DESKTOP), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } }, "no line, nothing to say");
});
