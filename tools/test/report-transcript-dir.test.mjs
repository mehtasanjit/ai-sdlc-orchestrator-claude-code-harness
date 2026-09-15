/**
 * tools/report.mjs lists a run's Claude Code transcripts (its Artifacts
 * section) from <root>/projects/<dir>, where <root> is $CLAUDE_CONFIG_DIR when
 * set and non-empty, else ~/.claude, and <dir> is Claude Code's own name for
 * the project root: every character that is not a letter or digit becomes "-".
 * Both are the rules the collector's transcriptsDirFor uses and
 * docs/methodology.md states.
 *
 * The report kept an older rule that replaced only "/" and whitespace. For any
 * project path holding a dot or an underscore (`my_app.v0.6.0`) it looked in a
 * directory that never exists and silently listed no session or subagent
 * transcript at all. This test fails on that rule.
 *
 * HOME points at a temp home, so nothing is read from the machine's own
 * ~/.claude. The files' mtimes are set inside the run's manifest window,
 * because the report lists only transcripts written during the run.
 * $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const RUN = join(ROOT, "tools", "test", "fixtures", "receivables-ops", "pass1");

/**
 * Writes a run under `<tmp>/work/my_app.v0.6.0`, puts one session and one
 * helper transcript under `<claude root>/projects/<dir>` (the claude root is
 * `configDir` when given, else `<tmp>/home/.claude`), and returns the report's
 * text. HOME is the temp home either way; CLAUDE_CONFIG_DIR is set to
 * `configDir` or removed, so the machine's own value never leaks in.
 */
function reportWithTranscripts({ configDir } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "report-transcript-dir-"));
  try {
    // The report takes the project root as four levels above the pass directory.
    const projectRoot = join(tmp, "work", "my_app.v0.6.0");
    const passDir = join(projectRoot, "examples", "study", "passes", "pass1");
    mkdirSync(passDir, { recursive: true });
    const manifest = readFileSync(join(RUN, "manifest.json"), "utf8");
    writeFileSync(join(passDir, "manifest.json"), manifest);
    writeFileSync(join(passDir, "telemetry.jsonl"), readFileSync(join(RUN, "telemetry.jsonl")));

    const home = join(tmp, "home");
    const claudeRoot = configDir ? join(tmp, configDir) : join(home, ".claude");
    const claudeDir = join(claudeRoot, "projects", projectRoot.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(join(claudeDir, "sess-1", "subagents"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const session = join(claudeDir, "sess-1.jsonl");
    const helper = join(claudeDir, "sess-1", "subagents", "agent-a1.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(helper, "{}\n");
    const started = Date.parse(JSON.parse(manifest).started_at ?? "");
    if (Number.isFinite(started)) {
      const t = (started + 60_000) / 1000;
      utimesSync(session, t, t);
    }

    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    if (configDir) env.CLAUDE_CONFIG_DIR = claudeRoot;
    return execFileSync(process.execPath, [REPORT, passDir], { encoding: "utf8", env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("report Artifacts: a project root with a dot and an underscore finds its transcripts under Claude Code's directory name", () => {
  const out = reportWithTranscripts();
  assert.match(out, /Claude Code session log\s+\S*sess-1\.jsonl/);
  assert.match(out, /Subagent transcript\s+\S*agent-a1\.jsonl/);
});

// Claude Code writes transcripts under $CLAUDE_CONFIG_DIR/projects when that
// variable is set; the collector and the claude-cli worker ledger read them
// there. The report looked only under ~/.claude/projects, so such a run listed
// no session or subagent transcript.
test("report Artifacts: with CLAUDE_CONFIG_DIR set, transcripts are listed from $CLAUDE_CONFIG_DIR/projects", () => {
  const out = reportWithTranscripts({ configDir: "claude-config" });
  assert.match(out, /Claude Code session log\s+\S*claude-config\/projects\/\S*sess-1\.jsonl/);
  assert.match(out, /Subagent transcript\s+\S*claude-config\/projects\/\S*agent-a1\.jsonl/);
});
