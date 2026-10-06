/**
 * The shell commands the server runs for a packet (apply.ts runApplyLoop, runShell): the person's Bash deny rules hold
 * for every command inside a check, however the shell would reach it (a lone &, a subshell, a group, a quoted or
 * escaped command name, a compound command), and a check whose command the server cannot read before it runs (a
 * substitution or an expansion) is not run while any rule forbids a command; the file's path is pasted so the shell
 * reads it as it is ('{path}' with each quote written '\''), and a path the shell would read as syntax is refused
 * before anything runs when a check pastes it outside single quotes. Stub models and temp folders: no model is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA, commandDeniedBy, commandUnchecked } = await import(join(DIST, "apply.js"));
const bashRules = await import(join(HERE, "..", "..", "..", "scripts", "ambient", "lib", "bash-rules.mjs"));

process.env.MMO_MANAGED_SETTINGS = join(tmpdir(), "mmo-no-managed-settings.json");
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mmo-apply-shell-config-"));

const FLASH = { modelId: "flash", reason: "policy", ruleIndex: 0 };
const packet = (over = {}) => ({
  id: "tp_codegen_001", phase: "codegen", task_type: "", module: "spec", pass_id: "r", instruction: "Write the file.",
  inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/out.ts", ...over,
});
function stub(replies) {
  const calls = [];
  const dispatch = async (p) => {
    calls.push(p);
    const r = replies.shift() ?? { content: "fallback\n" };
    return { decision: FLASH, events: [{ task_id: p.id, success: true }], result: { success: true, result: { path: p.artifact_path, ...r }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0.01, terminal_reason: "success" } };
  };
  return { calls, dispatch };
}
const loop = (over) => runApplyLoop({ projectRoot: over.root, keepEvents: true, route: () => FLASH, log: () => {}, ...over });
function project(deny) {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-shell-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny } }));
  writeFileSync(join(root, "victim.txt"), "keep\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "a\n");
  return root;
}

test("a denied command is found wherever the shell would run it: after a lone &, in a subshell or a group, quoted, escaped, or inside a compound command", async () => {
  const forms = [
    "true & rm -f victim.txt; test -f {path}",
    "(rm -f victim.txt); test -f {path}",
    "{ rm -f victim.txt; }; test -f {path}",
    "'rm' -f victim.txt; test -f {path}",
    "r''m -f victim.txt; test -f {path}",
    "r\\m -f victim.txt; test -f {path}",
    "if true; then rm -f victim.txt; fi; test -f {path}",
    "test -f {path} && ! rm -f victim.txt",
    "FOO='a b' rm -f victim.txt; test -f {path}",
  ];
  for (const run of forms) {
    const root = project(["Bash(rm:*)"]);
    const m = stub([{ edits: [{ search: "a", replace: "b" }] }]);
    const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "c", run }] }), dispatch: m.dispatch });
    assert.equal(out.status, "refused", run);
    assert.match(out.refusal, /Bash\(rm:\*\)/, run);
    assert.equal(readFileSync(join(root, "victim.txt"), "utf8"), "keep\n", `${run}: not even the baseline ran it`);
    assert.equal(m.calls.length, 0, run);
    rmSync(root, { recursive: true, force: true });
  }
});

test("while any rule forbids a command, a check that runs a command the server cannot read first (a substitution or an expansion) is refused before anything runs", async () => {
  const forms = [
    "echo $(rm -f victim.txt) > /dev/null; test -f {path}",
    "echo `rm -f victim.txt`; test -f {path}",
    'echo "$(rm -f victim.txt)"; test -f {path}',
    "cat <(rm -f victim.txt); test -f {path}",
    "$CMD -f victim.txt; test -f {path}",
    "{rm,-f,victim.txt}; test -f {path}",
  ];
  for (const run of forms) {
    const root = project(["Bash(curl:*)"]);
    const m = stub([{ edits: [{ search: "a", replace: "b" }] }]);
    const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "c", run }] }), dispatch: m.dispatch });
    assert.equal(out.status, "refused", run);
    assert.match(out.refusal, /cannot read/, run);
    assert.doesNotMatch(out.refusal, /strict|re-open|Gate 0/, "a refusal names no way around it");
    assert.equal(readFileSync(join(root, "victim.txt"), "utf8"), "keep\n", run);
    assert.equal(m.calls.length, 0, run);
    rmSync(root, { recursive: true, force: true });
  }
  // With no deny rule at all nothing is forbidden, so nothing needs reading first: the check runs.
  const root = project([]);
  const ok = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "c", run: "test -n \"$(cat {path})\"" }] }), dispatch: stub([{ edits: [{ search: "a", replace: "b" }] }]).dispatch });
  assert.equal(ok.status, "applied");
  rmSync(root, { recursive: true, force: true });
});

test("quotes that hide nothing are read as the shell reads them: such checks run under deny rules", async () => {
  const root = project(["Bash(rm:*)"]);
  const runs = ["grep -q '^b$' {path}", "node -e \"process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('b')?0:1)\" '{path}'", "test -f {path} 2>&1 >/dev/null"];
  const out = await loop({ root, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", baseline: false, checks: runs.map((run, i) => ({ id: `c${i}`, run })) }), dispatch: stub([{ edits: [{ search: "a", replace: "b" }] }]).dispatch });
  assert.equal(out.status, "applied", JSON.stringify(out.attempts));
  assert.equal(out.verify.ran, 3);
  assert.equal(commandUnchecked("grep -q 'a$(b)' x"), null, "inside single quotes nothing runs");
  assert.match(commandUnchecked("grep -q \"a$(b)\" x"), /\$\(/, "inside double quotes a substitution runs");
  rmSync(root, { recursive: true, force: true });
});

test("the server still decides a plain command exactly as zero-touch's hook does (lib/bash-rules.mjs)", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-shell-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)", "Bash(curl *)", "Bash(npm test)"] } }));
  const cases = ["rm -rf x", "rmdir x", "echo a && rm x", "FOO=1 rm x", "curl -s https://example.invalid", "npm test", "npm test -- -u", "true | rm x", "ls; cat x", "a || rm x", ""];
  for (const c of cases) assert.equal(commandDeniedBy(c, root, process.env), bashRules.deniedBy(c, root, process.env), c);
  rmSync(root, { recursive: true, force: true });
});

test("a path with a quote or a space is pasted inside its single quotes as the shell reads it: the baseline and the checks judge the real file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-shell-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "What's new.md"), "# What's new\n\nOld line.\n");
  const m = stub([{ edits: [{ search: "Old line.", replace: "New line." }] }]);
  const out = await loop({ root, packet: packet({ phase: "docs", artifact_path: "docs/What's new.md" }), apply: normalizeApply({ write: true, mode: "edits", checks: [{ id: "heading", run: "grep -q '^# ' '{path}'" }] }), dispatch: m.dispatch });
  assert.equal(out.status, "applied", JSON.stringify(out));
  assert.equal(out.set_aside, undefined, "the check ran on the real file before the change and passed, so it judges the answer");
  assert.equal(out.verify.ran, 1);
  assert.equal(readFileSync(join(root, "docs", "What's new.md"), "utf8"), "# What's new\n\nNew line.\n");
  rmSync(root, { recursive: true, force: true });
});

test("a path the shell would read as syntax is refused before anything runs when a check pastes it outside single quotes; inside them it is only a name", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-shell-"));
  const bad = "src/$(touch pwned).ts";
  for (const [run, field] of [["test -f {path}", "artifact_path"], ['test -f "{path}"', "artifact_path"]]) {
    const m = stub([{ content: "x\n" }]);
    const out = await loop({ root, packet: packet({ artifact_path: bad }), apply: normalizeApply({ write: true, checks: [{ id: "c", run }] }), dispatch: m.dispatch });
    assert.equal(out.status, "refused", `${field} in ${run}`);
    assert.match(out.refusal, /pasted into a shell command/);
    assert.equal(m.calls.length, 0);
    assert.equal(existsSync(join(root, "pwned")), false);
  }
  // A path inside a longer single-quoted string is pasted into text another shell may read again (sh -c '… {path}'):
  // only a whole single-quoted word, '{path}', keeps a path that is not plain a name.
  for (const run of ["sh -c 'test -f {path}'", "test -f 'x{path}'"]) {
    const m = stub([{ content: "x\n" }]);
    const out = await loop({ root, packet: packet({ artifact_path: bad }), apply: normalizeApply({ write: true, checks: [{ id: "c", run }] }), dispatch: m.dispatch });
    assert.equal(out.status, "refused", run);
    assert.equal(m.calls.length, 0);
    assert.equal(existsSync(join(root, "pwned")), false);
  }
  // The same path in single quotes is only a file name: the packet runs and nothing else does.
  const m = stub([{ content: "x\n" }]);
  const out = await loop({ root, packet: packet({ artifact_path: bad }), apply: normalizeApply({ write: true, checks: [{ id: "c", run: "test -f '{path}'" }] }), dispatch: m.dispatch });
  assert.equal(out.status, "applied", JSON.stringify(out));
  assert.equal(existsSync(join(root, bad)), true);
  assert.equal(existsSync(join(root, "pwned")), false);
  // A new file's style file is pasted into the same checks for its baseline: the same rule holds for it.
  const s = stub([{ content: "x\n" }]);
  const o2 = await loop({ root, packet: packet({ artifact_path: "src/plain.ts" }), apply: normalizeApply({ write: true, baseline_from: "src/`touch pwned2`.ts", checks: [{ id: "c", run: "test -f {path}" }] }), dispatch: s.dispatch });
  assert.equal(o2.status, "refused");
  assert.equal(s.calls.length, 0);
  // A path that starts with "-" is read as an option, quoted or not.
  const d = stub([{ content: "x\n" }]);
  const o3 = await loop({ root, packet: packet({ artifact_path: "-n.ts" }), apply: normalizeApply({ write: true, checks: [{ id: "c", run: "grep -q x '{path}'" }] }), dispatch: d.dispatch });
  assert.equal(o3.status, "refused");
  assert.equal(d.calls.length, 0);
  rmSync(root, { recursive: true, force: true });
});
