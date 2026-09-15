/**
 * Rename guard for the sdlc → mmo namespace change (MMO-D1). Two directions:
 *   - forward: no shipped, non-historical file uses a retired spelling as a
 *     path, command, or server name.
 *   - reverse: the state directory and the AI-SDLC methodology name, which
 *     the rename deliberately never touches (MMO-D6), are still there.
 *
 * EXCLUDED, and why:
 *   - docs/brownfield-v1-planning/**, docs/walkthroughs/** — historical
 *     records of the plugin as it was named when written (CLAUDE.md).
 *   - examples/*\/passes/** — shipped evidence of real runs; rewriting a
 *     recorded run's paths would be falsification.
 *   - docs/mmo-v1-planning/** — this ticket's own design doc. It names both
 *     the retired and the new spellings on purpose, as the record of the
 *     rename itself.
 *   - node_modules/, dist/, .git/, .sdlc/ — dependencies, build output, or
 *     runtime state, not shipped source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HISTORICAL_PREFIXES = [
  "docs/brownfield-v1-planning/",
  "docs/walkthroughs/",
  "docs/mmo-v1-planning/",
];

function isHistorical(path) {
  if (HISTORICAL_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (/^examples\/[^/]+\/passes\//.test(path)) return true;
  return false;
}

/** Every git-tracked file, minus historical records and this test itself. */
function shippedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isHistorical(p))
    .filter((p) => p !== "tools/test/namespace.test.mjs")
    .filter((p) => !p.includes("package-lock.json")); // dependency tree, not shipped source
}

const RETIRED_PATTERNS = [
  { name: "/sdlc:", pattern: /\/sdlc:/ },
  { name: "plugin_sdlc_", pattern: /plugin_sdlc_/ },
  { name: "run-ai-sdlc", pattern: /run-ai-sdlc/ },
  {
    // Bare gemini-flash-server used as a path or server id. The MMO-D8
    // compat-shim call sites are the one legitimate exception.
    name: "gemini-flash-server",
    pattern: /gemini-flash-server/,
    exceptions: [
      "plugin/mcp/model-dispatch/src/adapters/index.ts",
      "plugin/mcp/model-dispatch/src/server.ts",
      // v0.7.3 review fix: the what-if replay's endpoint rule must recognise the
      // alias the adapter registry still accepts, as server.ts does.
      "plugin/mcp/model-dispatch/src/adapters/geminiEndpoint.ts",
      "docs/architecture.md", // documents the MMO-D8 compat shim by name
      // Pins that the compat shim still validates; must name the alias to test it.
      "plugin/mcp/model-dispatch/test/policyResolution.test.mjs",
    ],
  },
];

test("no shipped file outside the historical record uses a retired sdlc-namespace spelling", () => {
  const files = shippedFiles();
  for (const path of files) {
    const text = readFileSync(resolve(ROOT, path), "utf8");
    for (const { name, pattern, exceptions } of RETIRED_PATTERNS) {
      if (exceptions?.includes(path)) continue;
      assert.ok(
        !pattern.test(text),
        `${path} still contains '${name}' — retired by the sdlc→mmo rename (MMO-D1)`,
      );
    }
  }
});

test("the state directory and the AI-SDLC methodology name were never renamed (MMO-D6)", () => {
  const files = shippedFiles();
  let sawSdlcDir = false;
  let sawAiSdlc = false;
  for (const path of files) {
    const text = readFileSync(resolve(ROOT, path), "utf8");
    if (text.includes(".sdlc/") || text.includes(".sdlc\"") || text.includes(".sdlc'")) sawSdlcDir = true;
    if (text.includes("AI-SDLC")) sawAiSdlc = true;
    assert.ok(
      !/\.mmo\//.test(text),
      `${path} references .mmo/ — the state directory is not renamed (MMO-D6)`,
    );
  }
  assert.ok(sawSdlcDir, "expected at least one shipped reference to .sdlc/ — did the guard break?");
  assert.ok(sawAiSdlc, "expected at least one shipped reference to AI-SDLC — did the guard break?");
});

test("OFF_LIMITS_DEFAULT still lists the state directory", () => {
  const src = readFileSync(resolve(ROOT, "plugin/scripts/lib/off-limits.mjs"), "utf8");
  assert.match(src, /\.sdlc\/\*\*/, "OFF_LIMITS_DEFAULT must keep guarding .sdlc/**");
});

test("both manifests agree on the plugin name and version", () => {
  const plugin = JSON.parse(readFileSync(resolve(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(resolve(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json has no entry named '${plugin.name}'`);
  assert.equal(plugin.name, "mmo", "the plugin's canonical name is mmo (MMO-D1)");
  assert.equal(entry.version, plugin.version, "marketplace and plugin manifest disagree on the version");
});

// The README badge and the repo guide said 0.6.0 through the whole 0.7.x line
// because nothing tied them to the manifest. A reader installing from the
// README should see the version the marketplace serves, and methodology.md's
// version notes should say what that version changed about the numbers.
test("the README badge, the repo guide and the methodology version notes name the plugin's version", () => {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8"));
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const badge = readme.match(/img\.shields\.io\/badge\/version-([0-9.]+)-/);
  assert.ok(badge, "README.md has no version badge");
  assert.equal(badge[1], version, "README.md's version badge disagrees with plugin.json");
  const guide = readFileSync(resolve(ROOT, "docs/repo-guide.md"), "utf8");
  assert.match(guide, new RegExp(`\\bv${version.replace(/\./g, "\\.")}\\b`), "docs/repo-guide.md does not name the plugin's version");
  const methodology = readFileSync(resolve(ROOT, "docs/methodology.md"), "utf8");
  assert.match(methodology, new RegExp(`^### v${version.replace(/\./g, "\\.")}\\b`, "m"), "docs/methodology.md has no version notes for this version");
});

test("the three moved paths exist under their new names, and not the old ones", () => {
  const moved = [
    ["plugin/commands/greenfield.md", "plugin/commands/run.md"],
    ["plugin/skills/pipeline", "plugin/skills/run-ai-sdlc"],
    ["plugin/mcp/model-dispatch", "plugin/mcp/gemini-flash-server"],
  ];
  const tracked = new Set(shippedFiles().map((p) => p) );
  const trackedPrefixes = (prefix) => [...tracked].some((p) => p === prefix || p.startsWith(`${prefix}/`));
  for (const [next, prev] of moved) {
    assert.ok(trackedPrefixes(next), `${next} should exist after the rename`);
    assert.ok(!trackedPrefixes(prev), `${prev} should no longer exist after the rename`);
  }
});
