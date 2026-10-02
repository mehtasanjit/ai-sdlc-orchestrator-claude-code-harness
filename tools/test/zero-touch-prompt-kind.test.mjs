/**
 * "Did the person type this message while the chat was idle?" is answered in two plugins, and the answers must never
 * disagree:
 *   - the mmo plugin's routing (plugin/scripts/ambient/hook.mjs NOTICE_TAG, lib/transcript.mjs sentWhileWorking), the
 *     original;
 *   - the zero-touch plugin's settings box (zero-touch/scripts/prompt-kind.mjs), a copy, because Claude Code gives each
 *     plugin its own files.
 * If they disagreed, one message could end a settings sequence in one plugin while the other took it as part of the
 * running task. This test runs both on the same cases.
 *
 * Offline: files in a temporary folder only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const Z = await import(join(ROOT, "zero-touch", "scripts", "prompt-kind.mjs"));
const T = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));

test("the notice tags are the mmo plugin's, character for character", () => {
  const hook = readFileSync(join(ROOT, "plugin", "scripts", "ambient", "hook.mjs"), "utf8");
  const original = /const NOTICE_TAG = (\/.+\/[a-z]*);/.exec(hook)?.[1];
  assert.ok(original, "the original is found in hook.mjs");
  assert.equal(String(Z.NOTICE_TAG), original);
  for (const text of ["<task-notification>\n<task-id>1</task-id>", "  <system-reminder>x", "<p>my own html</p>", "fix the bug"]) {
    const notice = new RegExp(original.slice(1, original.lastIndexOf("/")), "i").test(text);
    assert.equal(Z.promptKind({ prompt: text }), notice ? "notice" : "idle", text);
  }
});

test("sent while Claude was working: both copies give the same answer on every case", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-prompt-kind-"));
  try {
    const cases = [
      ["an idle message", [{ type: "user", message: { content: "hello" } }], "hello", false],
      ["typed while working", [{ type: "attachment", attachment: { type: "queued_command", prompt: "also this" } }], "also this", true],
      ["the latest entry decides", [{ type: "attachment", attachment: { type: "queued_command", prompt: "again" } }, { type: "user", message: { content: [{ type: "text", text: "again" }] } }], "again", false],
      ["a helper's entry is not the chat's", [{ type: "user", isSidechain: true, message: { content: "x" } }], "x", null],
      ["not in the transcript", [{ type: "user", message: { content: "other" } }], "missing", null],
      // Typed while working, still in Claude Code's input queue (the terminal runs the hook at Enter).
      ["still in the input queue", [{ type: "queue-operation", operation: "enqueue", content: "fix it now" }], "fix it now", true],
      ["enqueued and dequeued at once (idle)", [{ type: "queue-operation", operation: "enqueue", content: "hi" }, { type: "queue-operation", operation: "dequeue" }, { type: "user", message: { content: "hi" } }], "hi", false],
      ["removed from the queue", [{ type: "queue-operation", operation: "enqueue", content: "b" }, { type: "queue-operation", operation: "remove", content: "b" }], "b", null],
    ];
    for (const [name, entries, text, expected] of cases) {
      const file = join(dir, `${name.replace(/\W+/g, "-")}.jsonl`);
      writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
      assert.equal(T.sentWhileWorking(file, text), expected, `${name}: the original`);
      assert.equal(Z.sentWhileWorking(file, text), expected, `${name}: the copy agrees`);
    }
    assert.equal(Z.sentWhileWorking(join(dir, "none.jsonl"), "x"), null, "no transcript");
    assert.equal(Z.promptKind({ prompt: "also this", transcript_path: join(dir, "typed-while-working.jsonl") }), "working");
    assert.equal(Z.promptKind({ prompt: "hello", transcript_path: join(dir, "an-idle-message.jsonl") }), "idle");
    assert.equal(Z.promptKind({ prompt: "not written yet", transcript_path: join(dir, "an-idle-message.jsonl") }), "unknown", "a transcript that does not show it yet");
    assert.equal(Z.promptKind({ prompt: "hello" }), "idle", "no transcript to tell: as mmo's routing assumes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("'this message names zero-touch' is the mmo plugin's rule, character for character, and the settings hook's quick shell filter never misses one", () => {
  // The mmo plugin leaves a message naming zero-touch alone (no workflow, never a gate's answer), and zero-touch's
  // settings hook gives Claude the facts and the box for exactly those messages. Two copies, one rule.
  const route = readFileSync(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"), "utf8");
  const original = /const ABOUT_ZERO_TOUCH = (\/.+\/[a-z]*);/.exec(route)?.[1];
  assert.ok(original, "the original is found in route.mjs");
  assert.equal(String(Z.ABOUT_ZERO_TOUCH), original);
  const named = ["change zero-touch settings", "Is Zero Touch on?", "turn off zerotouch", "ZERO-TOUCH models", "zero\ttouch", "zero\ntouch please", "about zero\u2028touch"];
  const plain = ["fix the login bug", "the touchscreen is zero-indexed", "zero touchscreen", "build me a todo app"];
  for (const t of named) assert.ok(Z.mentionsZeroTouch(t), JSON.stringify(t));
  for (const t of plain) assert.ok(!Z.mentionsZeroTouch(t), JSON.stringify(t));
  // The filter in zero-touch/hooks/settings.sh runs on the hook's whole input, as JSON: it may let more through (node
  // decides), never less.
  const filter = /grep -qiE '([^']+)'/.exec(readFileSync(join(ROOT, "zero-touch", "hooks", "settings.sh"), "utf8"))?.[1];
  assert.ok(filter, "the filter is found in settings.sh");
  for (const t of named) {
    const r = spawnSync("sh", ["-c", `grep -qiE '${filter}'`], { input: JSON.stringify({ session_id: "s1", prompt: t }), env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    assert.equal(r.status, 0, `the shell filter lets ${JSON.stringify(t)} through`);
  }
});
