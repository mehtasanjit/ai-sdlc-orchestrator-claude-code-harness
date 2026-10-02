/**
 * The setup check reads `claude --help` for the flags the greenfield executor's lean Opus typist passes
 * to `claude -p` (--tools, --append-system-prompt-file, --effort), not only whether `claude` exists. An
 * older CLI types nothing with Claude in a new-app build; a brownfield run never uses those flags, so
 * the finding is a warning with what to update, never a block. The rule is the server's own
 * (leanOpusCliProblem in executor/typists.ts), checked against it here when the server is built.
 * $0, offline: a fake `claude` on PATH stands in for the real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluate, missingLeanOpusFlags, LEAN_OPUS_FLAGS } from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TYPISTS = join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "executor", "typists.js");

const healthy = { nodeMajor: 20, hasClaudeCli: true, hasNodeModules: true, hasDist: true, hasBundle: true, env: { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" } };

/** A `claude --help` text listing the given options, one per line as Claude Code prints them. */
const help = (...flags) => ["Usage: claude [options] [command] [prompt]", "", "Options:", ...flags.map((f) => `  ${f} <value>   what it does`), "  -h, --help   display help for command"].join("\n");
const CURRENT = help("--model", "--tools", "--append-system-prompt-file", "--effort", "--output-format");
// The form one Claude Code release uses: --append-system-prompt-file folded into a sibling's description.
const FOLDED = help("--model", "--tools", "--effort", "--bare   uses --append-system-prompt[-file] only");
const NO_EFFORT = help("--model", "--tools", "--append-system-prompt-file");
const OLD = help("--model", "--allowedTools", "--append-system-prompt");

const flagFinding = (state) => state.problems.find((p) => p.id === "claude-cli-flags");

test("a CLI whose help lists every flag the lean Opus typist needs adds nothing", () => {
  for (const text of [CURRENT, FOLDED]) {
    const state = evaluate({ ...healthy, claudeHelp: { text } });
    assert.equal(state.ok, true);
    assert.deepEqual(state.problems, []);
  }
});

test("a CLI missing one of them is a warning that names it and says to update Claude Code", () => {
  const state = evaluate({ ...healthy, claudeHelp: { text: NO_EFFORT } });
  assert.equal(state.ok, true, "a brownfield run works without it, so the check still passes");
  const f = flagFinding(state);
  assert.ok(f, "no finding for a CLI without --effort");
  assert.equal(f.severity, "warning");
  assert.match(f.message, /claude CLI lists no --effort flag\b/);
  assert.match(f.message, /new-app build/);
  assert.match(f.message, /brownfield run does not use/);
  assert.equal(f.fix, "Update Claude Code (`claude update`) until `claude --help` lists --tools, --append-system-prompt-file, --effort.");
});

test("an older CLI missing all three names all three at once", () => {
  const f = flagFinding(evaluate({ ...healthy, claudeHelp: { text: OLD } }));
  assert.match(f.message, /lists no --tools, --append-system-prompt-file, --effort flags\b/);
});

test("a `claude --help` that fails is named as such; an absent CLI keeps its one blocking finding; no help read adds nothing", () => {
  const failed = flagFinding(evaluate({ ...healthy, claudeHelp: { error: "timed out" } }));
  assert.equal(failed.severity, "warning");
  assert.match(failed.message, /`claude --help` failed \(timed out\)/);
  assert.match(failed.fix, /claude update/);
  const absent = evaluate({ ...healthy, hasClaudeCli: false, claudeHelp: { error: "spawnSync claude ENOENT" } });
  assert.deepEqual(absent.problems.map((p) => p.id), ["claude-cli"]);
  assert.deepEqual(evaluate(healthy).problems, []);
});

test("the flags and the reading of the help text are the server's own", { skip: !existsSync(TYPISTS) && "server dist not built" }, async () => {
  const { leanOpusCliProblem } = await import(pathToFileURL(TYPISTS).href);
  assert.equal(leanOpusCliProblem(() => CURRENT), null);
  for (const text of [CURRENT, FOLDED, NO_EFFORT, OLD, help("--tools,", "--effort", "--append-system-prompt-file"), ""]) {
    const server = leanOpusCliProblem(() => text);
    const missing = missingLeanOpusFlags(text);
    assert.equal(server === null, missing.length === 0, text);
    if (server) {
      assert.match(server, new RegExp(`lists no ${missing.join(", ")} flag`), text);
      assert.ok(server.endsWith(`lists ${LEAN_OPUS_FLAGS.join(", ")}`), server);
    }
  }
});

test("the setup check reads the installed CLI's help and prints the finding", () => {
  const bin = mkdtempSync(join(tmpdir(), "claude-bin-"));
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  const run = (text) => {
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncat <<'HELP'\n${text}\nHELP\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "verify-setup.mjs"), "--project-root", home], {
      encoding: "utf8", cwd: home, timeout: 60_000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" },
    });
  };
  const old = run(NO_EFFORT);
  assert.match(old.stdout, /! This machine's claude CLI lists no --effort flag/, old.stdout + old.stderr);
  assert.match(old.stdout, /fix: Update Claude Code \(`claude update`\)/);
  const current = run(CURRENT);
  assert.doesNotMatch(current.stdout, /claude CLI lists no/);
  assert.equal(current.status, old.status, "the finding never changes the exit code");
});
