/**
 * The policy console's SHIPPED_PRESETS list names exactly the policy YAMLs
 * the plugin ships.
 *
 * The console labels each policy "preset" or "custom" by name alone, because
 * console-saved custom policies land in the same plugin/config/policies/
 * directory as the shipped files. A shipped YAML missing from the list shows
 * as "custom" (five presets once did, when the list named two), and a name
 * left on the list after its file is removed would label a user's own policy
 * of that name "preset". Nothing else fails in either case, so this pins it:
 * adding opus-plus-flash-v38 in v0.7.3 without the list entry fails here.
 *
 * Offline, reads repo files only. It parses the array out of the source text
 * instead of importing policy-server.mjs, which starts an HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("policy console SHIPPED_PRESETS equals the shipped policy YAMLs", () => {
  const src = readFileSync(join(REPO, "plugin", "policy-console", "policy-server.mjs"), "utf-8");
  const m = src.match(/const SHIPPED_PRESETS = \[([\s\S]*?)\];/);
  assert.ok(m, "SHIPPED_PRESETS array not found in policy-server.mjs");
  const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  const shipped = readdirSync(join(REPO, "plugin", "config", "policies"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
  assert.deepEqual(listed, shipped);
});

/**
 * The console's readers, builder and save handler, evaluated from the source text (policy-server.mjs starts an HTTP
 * server when imported), with its policies folder pointed at `dir`. Everything else is the console's own code.
 */
function consoleIn(dir) {
  const src = readFileSync(join(REPO, "plugin", "policy-console", "policy-server.mjs"), "utf-8");
  const from = src.indexOf("// ── schema");
  const to = src.indexOf("// ── http server");
  assert.ok(from > 0 && to > from, "the console's sections are where this test reads them");
  const body = `${src.slice(from, to)}\nreturn { summarizePolicy, savePolicy };`;
  const intents = join(REPO, "plugin", "config", "intents.json");
  return new Function("readFileSync", "writeFileSync", "existsSync", "readdirSync", "join", "parseYaml", "stringifyYaml", "POLICIES_DIR", "INTENTS_PATH", body)(
    readFileSync, writeFileSync, existsSync, readdirSync, join, parseYaml, stringifyYaml, dir, intents
  );
}

// Review: a policy customised from a Gemini preset lost session_model (and thinking_timeout_sec), so its run-start
// check pinned nothing and the session ran on whatever model it was on.
test("a custom policy saved from a Gemini preset keeps session_model and thinking_timeout_sec, and its summary shows both", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-console-"));
  try {
    // A team's own Gemini-thinking base: argon4-agsdk-only as shipped, with a thinking-step budget of its own.
    const preset = readFileSync(join(REPO, "plugin", "config", "policies", "argon4-agsdk-only.yaml"), "utf-8");
    assert.match(preset, /^session_model: claude-opus-5-5$/m);
    const baseText = preset.replace(/^session_model: claude-opus-5-5$/m, "session_model: claude-opus-5-5\nthinking_timeout_sec: 28800");
    writeFileSync(join(dir, "team-argon.yaml"), baseText);
    const { summarizePolicy, savePolicy } = consoleIn(dir);

    const summary = summarizePolicy("team-argon", parseYaml(baseText), "");
    assert.equal(summary.session_model, "claude-opus-5-5", "the summary shows the base's session_model");
    assert.equal(summary.thinking_timeout_sec, 28800, "the summary shows the base's thinking_timeout_sec");

    const saved = savePolicy({
      baseId: "team-argon", name: "team-argon-custom",
      models: summary.models, routing: summary.routing, thinking: summary.thinking, intentOverrides: summary.intentOverrides,
    });
    assert.deepEqual(saved.errors, [], JSON.stringify(saved.errors));
    const policy = parseYaml(readFileSync(join(dir, "team-argon-custom.yaml"), "utf-8"));
    assert.equal(policy.session_model, "claude-opus-5-5", "the saved policy still pins the session");
    assert.equal(policy.thinking_timeout_sec, 28800, "the saved policy keeps the step's budget");

    // A base that sets neither gets neither: nothing is invented.
    writeFileSync(join(dir, "opus.yaml"), readFileSync(join(REPO, "plugin", "config", "policies", "opus-only.yaml"), "utf-8"));
    const plain = summarizePolicy("opus", parseYaml(readFileSync(join(dir, "opus.yaml"), "utf-8")), "");
    assert.equal(plain.session_model, null);
    assert.equal(plain.thinking_timeout_sec, null);
    const savedPlain = savePolicy({ baseId: "opus", name: "opus-custom", models: plain.models, routing: plain.routing, thinking: plain.thinking, intentOverrides: plain.intentOverrides });
    assert.deepEqual(savedPlain.errors, []);
    const plainPolicy = parseYaml(readFileSync(join(dir, "opus-custom.yaml"), "utf-8"));
    assert.ok(!("session_model" in plainPolicy) && !("thinking_timeout_sec" in plainPolicy), Object.keys(plainPolicy).join(", "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the console builds every custom policy, saved or previewed, from the same base parts", () => {
  const src = readFileSync(join(REPO, "plugin", "policy-console", "policy-server.mjs"), "utf-8");
  // Every call (the save handler's and the preview's), not the function's own definition.
  const calls = [...src.matchAll(/(?<!function )buildCustomPolicy\(\s*([A-Za-z]*)/g)].map((m) => m[1]);
  assert.equal(calls.length, 2, "the save handler and the preview each build a policy");
  assert.deepEqual(calls, ["customBase", "customBase"], "each starts from the base policy's parts the console keeps (customBase)");
});
