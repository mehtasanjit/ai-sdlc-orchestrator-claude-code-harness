/**
 * The run-start check's command, with the person's policy file added (plugin/scripts/ambient/lib/run-check.mjs).
 *
 * Why: a run zero-touch started must be checked against the person's policy, never a project's own
 * routing-policy.yaml, and the orchestrator runs that check as a shell command. A rule that rewrote any command that
 * mentions the script would remove every --policy-path in a command with two check calls (the second one then reads
 * the project's file and fails), put the flag into `sed` and `grep` commands that only name the script, and trim
 * trailing spaces off every line. So the rule touches only one plain call of the check that names no file yet, and
 * changes nothing else in it.
 *
 * Zero-touch is a strict add-on: the run's helpers follow the chat's model, as mmo does without zero-touch, so when the
 * hook knows that model and the person has no helper setting, the command is also told it, as
 * `CLAUDE_CODE_SUBAGENT_MODEL=<model>` in front: a fact mmo's own check then judges itself.
 *
 * Offline: string in, string out; one case runs the rewritten command through a real shell to prove it still parses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { stampedRunCheck, plainWords } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "run-check.mjs"));
const FILE = "/plug/config/policies/opus-plus-sonnet.yaml";
const FLAG = `--policy-path "${FILE}"`;

test("one plain call of the check gets the file, right after the script, and nothing else changes", () => {
  const cases = [
    ['node "${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" --project-root "$(pwd)"', `node "\${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" ${FLAG} --project-root "$(pwd)"`],
    ["node /p/scripts/driver-model-check.mjs --project-root . --policy=opus-plus-flash", `node /p/scripts/driver-model-check.mjs ${FLAG} --project-root . --policy=opus-plus-flash`],
    ["  node '/p/scripts/driver-model-check.mjs' \\\n    --project-root \"$(pwd)\"  ", `  node '/p/scripts/driver-model-check.mjs' ${FLAG} \\\n    --project-root "$(pwd)"  `],
    ["/usr/local/bin/node /p/driver-model-check.mjs --print-only --project-root .", `/usr/local/bin/node /p/driver-model-check.mjs ${FLAG} --print-only --project-root .`],
  ];
  for (const [command, expected] of cases) assert.equal(stampedRunCheck(command, FILE), expected, command);
});

test("the chat's model, when given, goes in front as the helpers' model; a model id the shell could misread never does", () => {
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" --project-root "$(pwd)"';
  assert.equal(stampedRunCheck(command, FILE, { helperModel: "claude-opus-5" }), `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node "\${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" ${FLAG} --project-root "$(pwd)"`);
  // Leading spaces stay where they were.
  assert.equal(stampedRunCheck("  node /p/driver-model-check.mjs", FILE, { helperModel: "claude-opus-5" }), `  CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node /p/driver-model-check.mjs ${FLAG}`);
  // A file already named: only the model is added.
  assert.equal(stampedRunCheck("node /p/driver-model-check.mjs --policy-path /tmp/theirs.yaml", FILE, { helperModel: "claude-opus-5" }), "CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node /p/driver-model-check.mjs --policy-path /tmp/theirs.yaml");
  for (const bad of ["opus 5", "x;rm -rf /", "$(id)", "-claude", "", null, 5]) {
    assert.equal(stampedRunCheck("node /p/driver-model-check.mjs", FILE, { helperModel: bad }), `node /p/driver-model-check.mjs ${FLAG}`, String(bad));
  }
  // A command that already starts with a setting of its own is left as it is.
  assert.equal(stampedRunCheck("CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node /p/driver-model-check.mjs", FILE, { helperModel: "claude-opus-5" }), null);
  // The stamped command runs the check with exactly that setting (a real shell, without node).
  const stamped = stampedRunCheck('node "/p/driver-model-check.mjs"', FILE, { helperModel: "claude-opus-5" });
  const r = spawnSync("/bin/sh", ["-c", stamped.replace(/ node /, " /usr/bin/env ").replace(/"\/p\/driver-model-check.mjs".*$/, "")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(r.stdout, /^CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5$/m);
});

test("everything else is left exactly as written: more than one command, another program, a file already named", () => {
  const untouched = [
    // Two calls in one command, both already right: the second must stay as it is too.
    `node /p/driver-model-check.mjs --project-root . --policy-path "${FILE}" --print-only && node /p/driver-model-check.mjs --project-root . --policy-path "${FILE}"`,
    // Commands that only name the script.
    'sed -n 1,80p "/p/scripts/driver-model-check.mjs"',
    "grep -n policy /p/scripts/driver-model-check.mjs | head",
    "cat /p/scripts/driver-model-check.mjs",
    // The script named twice, inside a substitution or a here-document, or a quote left open.
    "node /p/driver-model-check.mjs --project-root .\nnode /p/driver-model-check.mjs --project-root .",
    "echo $(node /p/driver-model-check.mjs --print-only)",
    "cat <<EOF\nnode /p/driver-model-check.mjs\nEOF",
    "x=`date` && node /p/driver-model-check.mjs",
    "node /p/driver-model-check.mjs --project-root 'unclosed",
    // A file already named, in either spelling, and no model given: nothing to add.
    "node /p/driver-model-check.mjs --project-root . --policy-path /tmp/theirs.yaml",
    "node /p/driver-model-check.mjs --policy-path=/tmp/theirs.yaml",
    // Another script, or not node.
    "node /p/verify-setup.mjs --fix",
    "bun /p/driver-model-check.mjs --project-root .",
    "",
  ];
  for (const command of untouched) assert.equal(stampedRunCheck(command, FILE), null, JSON.stringify(command));
  assert.equal(stampedRunCheck("node /p/driver-model-check.mjs", 'bad"path'), null, "a file the shell could misread is never added");
  assert.equal(stampedRunCheck(null, FILE), null);
});

test("the rewritten command is still one valid shell command, with the file as its own word", () => {
  const stamped = stampedRunCheck('node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"', "/plug/with space/policy.yaml");
  // Print each word the shell sees, one per line, without running node.
  const r = spawnSync("/bin/sh", ["-c", `set -- ${stamped.replace(/^node /, "")}; for w in "$@"; do printf '%s\\n' "$w"; done`], { encoding: "utf8", cwd: "/tmp" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n").slice(0, 3), ["/p/scripts/driver-model-check.mjs", "--policy-path", "/plug/with space/policy.yaml"]);
  assert.deepEqual(plainWords("a 'b c' \"d\\\"e\" f\\ g").map((w) => w.text), ["a", "b c", 'd"e', "f g"]);
});

test("the shapes the orchestrator usually writes are stamped too, the file right after the script", () => {
  // A leading cd, a trailing redirect or echo, or an unquoted $(pwd) must not leave the check unstamped, where a
  // project's routing-policy.yaml would decide it.
  const cases = [
    ["cd /x && node /p/driver-model-check.mjs --project-root .", `cd /x && node /p/driver-model-check.mjs ${FLAG} --project-root .`],
    ["node /p/driver-model-check.mjs --project-root . ; echo done", `node /p/driver-model-check.mjs ${FLAG} --project-root . ; echo done`],
    ["node /p/driver-model-check.mjs --project-root . > out.txt 2>&1", `node /p/driver-model-check.mjs ${FLAG} --project-root . > out.txt 2>&1`],
    ["node /p/driver-model-check.mjs --project-root $(pwd)", `node /p/driver-model-check.mjs ${FLAG} --project-root $(pwd)`],
    ["node /p/driver-model-check.mjs --project-root `pwd`", `node /p/driver-model-check.mjs ${FLAG} --project-root \`pwd\``],
  ];
  for (const [command, expected] of cases) assert.equal(stampedRunCheck(command, FILE), expected, command);
  assert.equal(stampedRunCheck("cd /x && node /p/driver-model-check.mjs --project-root . 2>&1", FILE, { helperModel: "claude-opus-5" }), `cd /x && CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5 node /p/driver-model-check.mjs ${FLAG} --project-root . 2>&1`, "the model in front of node, after the cd");
  assert.equal(stampedRunCheck("node /p/driver-model-check.mjs --policy-path=/t.yaml 2>&1", FILE), null, "a file already named and no model: nothing to add");
  // The stamped command still runs as one valid shell command (a real shell, without node).
  const stamped = stampedRunCheck('cd /tmp && node "/p/driver-model-check.mjs" --project-root "$(pwd)" 2>&1; echo done', "/plug/with space/policy.yaml");
  const r = spawnSync("/bin/sh", ["-c", stamped.replace("node ", "printf '%s\\n' ")], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n").slice(0, 3), ["/p/driver-model-check.mjs", "--policy-path", "/plug/with space/policy.yaml"]);
});
