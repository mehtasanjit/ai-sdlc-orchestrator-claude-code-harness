/**
 * End-to-end pins for plugin/scripts/driver-model-check.mjs — the estimated-mode
 * run-start check that the model the driver subagents will execute on
 * (CLAUDE_CODE_SUBAGENT_MODEL, set at launch) is the model the policy prices.
 *
 * The script lives in plugin/scripts/ but its tests live HERE, in the MCP
 * package's suite, because it imports the compiled routing from this package's
 * dist/ — the same pickModel/loadPolicy the dispatch server runs, so the check
 * can never disagree with real routing. This suite runs via `npm run build &&
 * node --test`, so dist/ is guaranteed fresh; the root tools/test suite runs
 * before any build and could see a stale or absent dist.
 *
 * Every case spawns the real CLI (exit codes and the printed export line ARE
 * the contract the orchestrator's rule 0 acts on). Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "driver-model-check.mjs");

/** Run the script with a clean env: the two vars under test never leak in from the host shell. */
function run(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  delete env.MMO_SELECT;
  if (!("CLAUDE_CODE_SUBAGENT_MODEL" in envOverrides)) delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf-8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A policy whose judgment tier is one model and whose mechanical tier is another. */
const UNIFIED_POLICY = `
version: 1
name: check-unified
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: worker
    adapter: mcp:model-dispatch
    model_name: gemini-3.5-flash
    pricing: { input: 0.1, input_cached: 0.01, output: 0.4 }
rules:
  - when: { phase: codegen }
    use: worker
  - default: driver
`;

/** security_review lands on a different model than every other judgment phase. */
const SPLIT_POLICY = `
version: 1
name: check-split
models:
  - id: driver-a
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: driver-b
    adapter: builtin-anthropic
    model_name: claude-opus-5
    pricing: { input: 2, input_cached: 0.2, output: 10 }
rules:
  - when: { phase: security_review }
    use: driver-b
  - default: driver-a
`;

/** Judgment tier routed somewhere Claude Code cannot execute in-session. */
const NON_ANTHROPIC_POLICY = `
version: 1
name: check-agentic
models:
  - id: worker
    adapter: antigravity-worker
    model_name: gemini-3.5-flash
    pricing: { input: 0.1, input_cached: 0.01, output: 0.4 }
rules:
  - default: worker
`;

function withPolicy(yaml, fn) {
  const root = mkdtempSync(join(tmpdir(), "mmo-dmc-"));
  try {
    writeFileSync(join(root, "routing-policy.yaml"), yaml);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--print-only derives the driver model from the judgment phases, ignoring mechanical routing", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root, "--print-only"]);
    assert.equal(r.code, 0, r.stderr);
    // codegen routes to gemini, but only judgment phases decide the driver model.
    assert.equal(r.stdout.trim(), "claude-opus-4-8");
  });
});

test("a matching CLAUDE_CODE_SUBAGENT_MODEL exits 0", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /driver-model-check ok/);
  });
});

test("an unset env var fails with the exact export remediation line", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /export CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8/);
    // The line the orchestrator must relay: the fix happens before launch, not in-session.
    assert.match(r.stderr, /BEFORE claude launches/);
  });
});

test("a mismatched env var fails and names both models", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5/);
    assert.match(r.stderr, /claude-opus-4-8/);
  });
});

test("a policy that splits the judgment tier across models is an error, not a vote", () => {
  withPolicy(SPLIT_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /splits the judgment tier/);
    // The per-phase table names the odd one out so the user can see the split.
    assert.match(r.stderr, /security_review → claude-opus-5/);
  });
});

test("a judgment tier no Claude Code subagent can execute is an error directing to vendor mode", () => {
  withPolicy(NON_ANTHROPIC_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "gemini-3.5-flash" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a model Claude Code can run in-session/);
    assert.match(r.stderr, /--auth=vendor/);
  });
});

test("the shipped opus-plus-flash preset derives claude-opus-4-7 (the model its pricing block prices)", () => {
  const r = run(["--policy", "opus-plus-flash", "--print-only"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "claude-opus-4-7");
});

/*
 * The remediation has to be followable in the environment the reader is in.
 * A shell export never reaches Claude Code started from the desktop app, which
 * has no login shell — the repo states that rule for credentials in
 * verify-setup.mjs, but the driver-model check shipped without it, so an app
 * user hit the halt and could not act on what it printed.
 */
test("the failure remediation covers the desktop app, not just a shell export", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /export CLAUDE_CODE_SUBAGENT_MODEL=/, "the terminal route must still be given");
    assert.match(r.stderr, /~\/\.claude\/settings\.json/, "the desktop-app route must name the user file");
    assert.match(r.stderr, /login shell/, "and why an export cannot work there");
    // Changed expectation (Fix F, v0.7.3): this used to require the blanket claim that
    // "an env block in a project's .claude/settings.json is not applied". That is true of the
    // desktop app and wrong for the terminal, so the claim is now scoped to the app.
    assert.match(
      r.stderr,
      /Desktop app:[\s\S]*ignores the "env" block of\s+a project's \.claude\/settings\.json and\s+\.claude\/settings\.local\.json/,
      "and must say the app ignores the project settings files, since that is the instinctive place to put it",
    );
  });
});

/*
 * Measured on 2026-09-02: the value was set correctly in a project's
 * .claude/settings.json and three full app restarts still reported it unset,
 * because Claude Code reads `env` only from the user file. Generic advice does
 * not rescue a reader already in that state — the check has to name it.
 */
test("a value stranded in the project settings file is diagnosed by name", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" } }),
    );

    const r = run(["--project-root", root]);
    assert.equal(r.code, 1, "the value is stranded, so the check must still fail");
    assert.match(r.stderr, /already declares CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8/);
    assert.match(r.stderr, /has not taken effect/);
    assert.match(r.stderr, /Move the entry there/);
  });
});

/*
 * T12 (Fix F, v0.7.3). Verified 2026-09-14 on Claude Code 2.1.270: the terminal
 * CLI, headless and interactive, applies the `env` block of
 * <project>/.claude/settings.local.json; the desktop app applies no project
 * settings file's `env`, only ~/.claude/settings.json. The message used to say a
 * project settings file never applies, which sent terminal users to the
 * machine-wide user file for a per-project value, and the stranded-value note
 * never looked at settings.local.json at all. The check's pass/fail logic is
 * unchanged: only the text it prints and the files the note reads.
 */
const settingsFile = (root, name, value) => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", name), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: value } }));
  return join(root, ".claude", name);
};
/** The part of the failure text between two route labels. */
const route = (stderr, from, to) => stderr.slice(stderr.indexOf(from), to ? stderr.indexOf(to) : undefined);

test("T12: the terminal route offers an export or this project's .claude/settings.local.json; the desktop route is ~/.claude/settings.json alone", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root]);
    assert.equal(r.code, 1);
    const terminal = route(r.stderr, "Terminal:", "Desktop app:");
    const desktop = route(r.stderr, "Desktop app:");
    assert.match(terminal, /export CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8/);
    assert.ok(terminal.includes(join(root, ".claude", "settings.local.json")), `the terminal route must name this project's settings.local.json by path:\n${terminal}`);
    assert.match(terminal, /"CLAUDE_CODE_SUBAGENT_MODEL": "claude-opus-4-8"/, "with the exact entry to add");
    assert.match(desktop, /~\/\.claude\/settings\.json — the only place the\s+app reads it/);
    assert.doesNotMatch(desktop, /settings\.local\.json"? block|add .* to .*settings\.local\.json/, "the desktop route must never send the reader to a project file");
    // The old blanket claim is gone: it is false for the terminal.
    assert.doesNotMatch(r.stderr, /Claude Code does not apply an "env" block from a project settings file/);
  });
});

test("T12: without --project-root the terminal route names <project>/.claude/settings.local.json", () => {
  const r = run(["--policy", "opus-plus-flash"]);
  assert.equal(r.code, 1);
  assert.match(route(r.stderr, "Terminal:", "Desktop app:"), /<project>\/\.claude\/settings\.local\.json/);
});

test("T12: a value stranded in .claude/settings.local.json is diagnosed by name, with the terminal relaunch and the desktop route", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const local = settingsFile(root, "settings.local.json", "claude-opus-4-8");
    const r = run(["--project-root", root]);
    assert.equal(r.code, 1, "the session does not see the value, so the check still fails");
    assert.ok(r.stderr.includes(`NOTE: ${local} already declares CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8`), r.stderr);
    assert.match(r.stderr, /has not taken effect in this session/);
    assert.match(r.stderr, /The terminal CLI applies this file's "env" block when claude launches in this folder/);
    assert.match(r.stderr, /The desktop app ignores it: from the app, move the entry to ~\/\.claude\/settings\.json/);
  });
});

test("T12: both project settings files are read, and each one declaring a value is named", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const shared = settingsFile(root, "settings.json", "claude-opus-5");
    const local = settingsFile(root, "settings.local.json", "claude-opus-4-8");
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`${local} already declares CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8`), r.stderr);
    assert.ok(r.stderr.includes(`${shared} already declares CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5`), r.stderr);
  });
});

test("T12: a project file declaring the very value the session sees is named as the source of the wrong model, not as stranded", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const local = settingsFile(root, "settings.local.json", "claude-opus-5");
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`NOTE: ${local} declares CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5, the value this session sees`), r.stderr);
    assert.match(r.stderr, /change it to claude-opus-4-8 there/);
    assert.doesNotMatch(r.stderr, /has not taken effect/);
  });
});

test("T12: no logic change — the check reads the environment the session sees, never the settings files", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    settingsFile(root, "settings.local.json", "claude-opus-4-8");
    assert.equal(run(["--project-root", root]).code, 1, "a matching file value alone does not pass");
  });
  withPolicy(UNIFIED_POLICY, (root) => {
    settingsFile(root, "settings.local.json", "claude-opus-5");
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 0, "a matching environment passes whatever a file says");
    assert.doesNotMatch(r.stderr + r.stdout, /NOTE:/);
  });
});

test("T12: projectSettingsDeclarations lists settings.local.json before settings.json, and skips unreadable or empty entries", async () => {
  const { projectSettingsDeclarations, declaredInProjectSettings } = await import(pathToFileURL(SCRIPT).href);
  withPolicy(UNIFIED_POLICY, (root) => {
    assert.deepEqual(projectSettingsDeclarations(root), []);
    settingsFile(root, "settings.json", "claude-opus-5");
    writeFileSync(join(root, ".claude", "settings.local.json"), "{ not json");
    assert.deepEqual(projectSettingsDeclarations(root), [{ path: join(root, ".claude", "settings.json"), file: "settings.json", value: "claude-opus-5" }]);
    settingsFile(root, "settings.local.json", "claude-opus-4-8");
    assert.deepEqual(projectSettingsDeclarations(root).map((d) => d.file), ["settings.local.json", "settings.json"]);
    // Back-compat export: the first declared value, in Claude Code's precedence (local over shared).
    assert.equal(declaredInProjectSettings(root), "claude-opus-4-8");
    assert.deepEqual(projectSettingsDeclarations(undefined), []);
  });
});

test("no stranded-value note appears when the project has no settings file", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, /already declares/, "nothing is stranded, so nothing to report");
  });
});
