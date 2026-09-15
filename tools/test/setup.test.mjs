/**
 * Guards the install path. Two things:
 *   1. verify-setup.mjs's decision table — wrong verdict either blocks a
 *      legit Claude-only user or clears a broken install to spend money.
 *   2. Marketplace catalogue + SETUP.md names — a rename in one place and
 *      not the other produces a silently broken install command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  nodeMajorFrom,
  mcpPaths,
  evaluate,
  adcPath,
  hasGeminiCredentials,
  vertexCredentialState,
  isUnexpandedPlaceholder,
  usableEnv,
  unexpandedDeclaredEnv,
  DECLARED_ENV,
} from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** A machine on which everything is in place. Tests vary one fact at a time. */
const healthy = {
  nodeMajor: 20,
  hasClaudeCli: true,
  hasNodeModules: true,
  hasDist: true,
  env: { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" },
};

const idsOf = (state) => state.problems.map((p) => p.id);

// ─── pure helpers ─────────────────────────────────────────────────────

test("nodeMajorFrom reads the major version, and refuses to guess", () => {
  assert.equal(nodeMajorFrom("20.11.1"), 20);
  assert.equal(nodeMajorFrom("22.0.0"), 22);
  assert.equal(nodeMajorFrom("not-a-version"), 0);
});

test("mcpPaths resolves the server paths under the plugin root", () => {
  const paths = mcpPaths("/plugins/orch");
  assert.equal(paths.serverDir, "/plugins/orch/mcp/model-dispatch");
  assert.equal(paths.distEntry, "/plugins/orch/mcp/model-dispatch/dist/server.js");
  assert.equal(paths.nodeModules, "/plugins/orch/mcp/model-dispatch/node_modules");
});

// ─── the decision table ───────────────────────────────────────────────

test("a fully prepared machine reports ready with nothing outstanding", () => {
  const state = evaluate(healthy);
  assert.equal(state.ok, true);
  assert.deepEqual(state.problems, []);
});

test("a missing server build blocks, and names the mid-run failure it prevents", () => {
  // The defect this whole script exists for: `/plugin install` succeeds while
  // dist/server.js is absent, and the run dies at the first dispatch.
  const state = evaluate({ ...healthy, hasDist: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["mcp-build"]);
  assert.match(state.problems[0].message, /dispatch/i);
  assert.match(state.problems[0].fix, /--fix/);
});

test("missing dependencies block, and both repairable faults are reported together", () => {
  // A fresh clone has neither. Reporting only the first would send the user
  // through two round trips to learn about the second.
  const state = evaluate({ ...healthy, hasNodeModules: false, hasDist: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["mcp-dependencies", "mcp-build"]);
});

test("Node older than 20 blocks and points at an upgrade, not at --fix", () => {
  const state = evaluate({ ...healthy, nodeMajor: 18 });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["node-version"]);
  assert.match(state.problems[0].fix, /nodejs\.org|nvm/);
});

test("a missing Claude Code CLI blocks with its install command", () => {
  const state = evaluate({ ...healthy, hasClaudeCli: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["claude-cli"]);
  assert.match(state.problems[0].fix, /@anthropic-ai\/claude-code/);
});

test("absent credentials warn but do not block — a Claude-only run is legitimate", () => {
  // Failing here would tell a user with a working subscription and no Gemini
  // account that their setup is broken. It is not.
  const state = evaluate({ ...healthy, env: {} });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), ["anthropic-key", "gemini-credentials"]);
  assert.ok(state.problems.every((p) => p.severity === "warning"));
});

test("a service-account file satisfies the Gemini requirement without an API key", () => {
  const state = evaluate({
    ...healthy,
    env: { ANTHROPIC_API_KEY: "x", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" },
  });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), []);
});

test("a plain `gcloud auth application-default login` satisfies it too", () => {
  // That command sets no environment variable — it writes a credentials file
  // and nothing else. Checking env vars alone told every ordinary Google
  // Cloud user they had no credentials, while offering Vertex AI as an
  // option two lines further down. Their runs worked; the report was wrong.
  const state = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" }, hasAdcFile: true });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), []);
});

test("a Google Cloud project named in the environment does not satisfy it", () => {
  // It used to. GOOGLE_CLOUD_PROJECT is a billing project ID — it says where to
  // charge the call, not who is making it — but it is the variable every Google
  // Cloud getting-started page mentions first, so setting only that is a common
  // way to arrive here believing you are done. The old check agreed with that
  // belief and reported a clean setup.
  const state = evaluate({
    ...healthy,
    env: { ANTHROPIC_API_KEY: "x", GOOGLE_CLOUD_PROJECT: "some-project" },
  });
  assert.deepEqual(idsOf(state), ["gemini-credentials"]);
  const problem = state.problems[0];
  // A warning, not a block: on a Compute Engine or Cloud Run instance the
  // credential comes from the metadata server and this setup genuinely works,
  // and there is no way to tell that apart from a laptop without a live call.
  assert.equal(problem.severity, "warning");
  assert.equal(state.ok, true);
  assert.match(problem.message, /some-project/);
  assert.match(problem.message, /where to bill, not who is asking/);
});

test("the missing-Gemini fix names both doors, the keyless one first", () => {
  // A field engineer at a company with Google Cloud should not be sent to
  // create a personal AI Studio key; the fix text is the only place that
  // steering happens.
  const state = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" } });
  const problem = state.problems.find((p) => p.id === "gemini-credentials");
  assert.ok(problem, "expected a gemini-credentials warning");
  assert.match(problem.fix, /gcloud auth application-default login/);
  assert.match(problem.fix, /aistudio\.google\.com/);
  assert.ok(
    problem.fix.indexOf("gcloud") < problem.fix.indexOf("aistudio"),
    "the keyless Google Cloud path should be offered before the API-key path",
  );
  // The platform is named the way Google names it now, with the old name kept
  // alongside so that everyone reading their own console recognises one of them.
  assert.match(problem.fix, /Gemini Enterprise Agent Platform \(formerly Vertex AI\)/);
  // And the key has to land somewhere a plugin can actually read it. A shell
  // export does not reach Claude Code launched from the desktop app, and three
  // fix strings in this file used to say `export NAME=...` regardless.
  assert.match(problem.fix, /settings\.json/);
  assert.ok(!/^\s*export /m.test(problem.fix), "no fix should tell the user to export a variable");
});

test("hasGeminiCredentials accepts either door and rejects a project ID alone", () => {
  const vertexOf = (env, adcUsable = false) =>
    vertexCredentialState({
      env,
      serviceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS
        ? { present: true, usable: true, type: "service_account", detail: null }
        : null,
      adcFile: { present: adcUsable, usable: adcUsable, type: null, detail: null },
    });

  assert.equal(hasGeminiCredentials({ env: {}, vertex: vertexOf({}) }), false);
  assert.equal(hasGeminiCredentials({ env: { GEMINI_API_KEY: "k" }, vertex: vertexOf({}) }), true);
  assert.equal(hasGeminiCredentials({ env: {}, vertex: vertexOf({}, true) }), true);
  assert.equal(
    hasGeminiCredentials({ env: {}, vertex: vertexOf({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" }) }),
    true,
  );
  assert.equal(hasGeminiCredentials({ env: {}, vertex: vertexOf({ GOOGLE_CLOUD_PROJECT: "p" }) }), false);
});

test("every credential the check accepts is one the server actually honours", () => {
  // The two lists are written in different languages in different packages and
  // cannot import each other, so nothing but this test stops them drifting.
  // Drift is silent and expensive in one direction: a name accepted here but
  // ignored by the server clears the setup check, and the run then dies at the
  // first Gemini dispatch — after the premium phases have already been billed.
  // Both files, because the API key name arrives indirectly: the adapter reads
  // it from the policy's `auth.env` and only defaults to GEMINI_API_KEY, so it
  // never appears as a literal `env.GEMINI_API_KEY` in the transport.
  // Comments are stripped first — a name that survives only in prose after its
  // handling was deleted would otherwise still pass.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // geminiEndpoint.ts holds the door precedence since the v0.7.3 review fix.
  const source = ["geminiTransports.ts", "geminiEndpoint.ts", "GeminiFlashAdapter.ts"]
    .map((f) =>
      stripComments(
        readFileSync(join(ROOT, "plugin/mcp/model-dispatch/src/adapters", f), "utf8"),
      ),
    )
    .join("\n");

  const candidates = [
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT_ID",
  ];
  for (const name of candidates) {
    if (!hasGeminiCredentials({ env: { [name]: "x" } })) continue;
    assert.ok(
      source.includes(name),
      `${name} clears the setup check but no adapter code reads it`,
    );
  }
});

/**
 * Server source, not a hardcoded array, is the list this test checks against.
 * Before this fix (ticket §5.3), the list here was six names typed by hand —
 * plugin.json already forwarded SDLC_SELECT and GEMINI_WORKER_PYTHON, neither
 * of which that list mentioned, so adding a variable to the server and
 * forgetting one of the two forwarding sites passed green. Reading
 * PLUGIN_DECLARED_ENV out of env.ts (text, not import — this file runs
 * before `npm ci` in plugin/mcp/model-dispatch, same constraint as
 * verify-setup.mjs's DECLARED_ENV) closes that gap: every name the server
 * actually declares is checked, not just the ones someone remembered.
 */
function serverDeclaredEnvNames() {
  const envTs = readFileSync(join(ROOT, "plugin/mcp/model-dispatch/src/env.ts"), "utf8");
  const start = envTs.indexOf("PLUGIN_DECLARED_ENV");
  const block = envTs.slice(start, envTs.indexOf("];", start) + 1);
  return [...block.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
}

test("both env-forwarding sites carry every name the server reads", () => {
  // A stdio MCP server does not inherit the parent environment. Anything the
  // server reads has to be forwarded explicitly, in both places that spawn it:
  // the plugin manifest (install path) and tools/setup.mjs (clone path).
  // Miss one and that path alone fails, which is the hardest kind to notice.
  const names = serverDeclaredEnvNames();
  assert.ok(names.length > 0, "could not parse PLUGIN_DECLARED_ENV out of env.ts — regex drifted from the source shape");
  // Read whichever server the manifest declares rather than a hardcoded key,
  // so renaming the server does not turn this into a false pass.
  const servers = Object.values(readJson("plugin/.claude-plugin/plugin.json").mcpServers ?? {});
  assert.equal(servers.length, 1, "expected exactly one bundled MCP server");
  const manifestEnv = servers[0].env ?? {};
  const setupSource = readFileSync(join(ROOT, "tools/setup.mjs"), "utf8");
  for (const name of names) {
    assert.ok(name in manifestEnv, `plugin.json does not forward ${name} to the MCP server`);
    assert.ok(setupSource.includes(name), `tools/setup.mjs does not forward ${name}`);
  }
});

test("plugin.json does not re-declare a hooks file Claude Code already auto-loads", () => {
  // Claude Code discovers `hooks/hooks.json` inside a plugin on its own. A
  // manifest that ALSO names that path registers the same hook twice, and the
  // CLI rejects the whole plugin — every command, agent and the MCP server
  // included — with a bare "failed to load".
  //
  // This cost a real install. The manifest read fine, the hook file read fine,
  // and nothing in this suite touched the pair, because the fault does not
  // exist in either file alone: it only appears where our manifest meets the
  // installed CLI. Caught on 2026-08-04 by a first-time install against Claude
  // Code 2.1.215, after the plugin had already been published.
  //
  // Both halves are asserted. Dropping the declaration is only correct while
  // the file still sits at the auto-loaded path — move or rename it with the
  // declaration gone and the hook silently stops registering, which is a worse
  // failure than the loud one, since a run then completes with no telemetry.
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  assert.ok(
    !("hooks" in manifest),
    "plugin.json must not declare `hooks` — Claude Code auto-loads hooks/hooks.json, " +
      "and declaring it as well registers it twice and fails the whole plugin load",
  );
  assert.ok(
    existsSync(join(ROOT, "plugin/hooks/hooks.json")),
    "plugin/hooks/hooks.json must exist at the path Claude Code auto-loads — " +
      "with no manifest declaration, this path is the only thing registering the hook",
  );
});

test("adcPath matches where gcloud writes credentials", () => {
  // Kept in step by hand with defaultAdcPath() in the server and ADC_FILE in
  // tools/setup.mjs — three copies, because none of the three files can
  // import the others.
  assert.equal(
    adcPath("/home/someone"),
    "/home/someone/.config/gcloud/application_default_credentials.json",
  );
});

// ─── the catalogue a first install reads ──────────────────────────────

test("marketplace.json carries the fields Claude Code requires", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.match(mkt.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "marketplace name must be kebab-case");
  assert.ok(mkt.owner?.name, "owner.name is required");
  assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length > 0);
  for (const p of mkt.plugins) {
    assert.ok(p.name, "every plugin entry needs a name");
    assert.equal(typeof p.source, "string");
    assert.match(p.source, /^\.\//, "a relative plugin source must start with ./");
  }
});

test("the marketplace name is not one Anthropic reserves", () => {
  // A reserved name stops loading on every launch, which would break the
  // install for every user at once with no change on our side.
  const reserved = new Set([
    "claude-code-marketplace", "claude-code-plugins", "claude-plugins-official",
    "claude-plugins-community", "claude-community", "anthropic-marketplace",
    "anthropic-plugins", "agent-skills", "anthropic-agent-skills",
    "knowledge-work-plugins", "life-sciences", "claude-for-legal",
    "claude-for-financial-services", "financial-services-plugins",
    "first-party-plugins", "healthcare",
  ]);
  const { name } = readJson(".claude-plugin/marketplace.json");
  assert.equal(reserved.has(name), false, `${name} is reserved for Anthropic use`);
  assert.equal(/anthropic|official.*claude/i.test(name), false, "name must not imitate an official source");
});

test("every plugin source resolves to a directory holding a plugin manifest", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  for (const p of mkt.plugins) {
    const manifest = join(ROOT, p.source, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(manifest), `${p.source} has no .claude-plugin/plugin.json`);
    assert.equal(
      JSON.parse(readFileSync(manifest, "utf8")).name,
      p.name,
      "the catalogue name and the plugin manifest name must match, or install resolves nothing"
    );
  }
});

test("the setup script ships inside the plugin, where an install can reach it", () => {
  // It lives under plugin/ on purpose: the plugin directory is what gets
  // copied into the plugin cache, so the script is present after an install
  // even when the user never cloned the repo.
  const { plugins } = readJson(".claude-plugin/marketplace.json");
  for (const p of plugins) {
    assert.ok(existsSync(join(ROOT, p.source, "scripts", "verify-setup.mjs")));
  }
});

test("SETUP.md quotes the names the catalogue actually publishes", () => {
  const setup = readFileSync(join(ROOT, "SETUP.md"), "utf8");
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.ok(
    setup.includes(`${mkt.plugins[0].name}@${mkt.name}`),
    "the install command in SETUP.md must match the published names"
  );
  // The path is wrapped in a shell expansion that resolves the versioned
  // cache directory, so assert on the script and the repair flag separately
  // rather than on one literal command string.
  assert.ok(setup.includes("verify-setup.mjs"), "SETUP.md must invoke the setup script");
  assert.ok(
    setup.includes("--fix"),
    "SETUP.md must tell Claude Code to run the build step, not just the check"
  );
  assert.ok(
    /marketplace add https:\/\/github\.com\/.*\.git/.test(setup),
    "the marketplace must be added over HTTPS; the owner/repo shorthand clones over SSH"
  );
});

test("every document that hands a fresh install to /mmo:greenfield says to open a new session", () => {
  // Claude Code builds its slash-command list when a session starts, and
  // nothing written to disk afterwards can add a command to a session that is
  // already running. So a successful install leaves `/mmo:greenfield` genuinely
  // absent from the very session that performed it. The plugin is fine; the
  // command arrives one session late.
  //
  // Caught on 2026-08-04 during the first end-to-end install: setup reported
  // success, the documented next prompt was `/mmo:greenfield`, and it was not in the
  // menu. The install session then offered `/reload-plugins`, which the
  // desktop app does not have — leaving a working install and no way forward.
  //
  // Both halves are asserted for every document that points at prompt 2,
  // because the dead end is reachable from any one of them on its own.
  for (const file of ["SETUP.md", "README.md", "docs/running.md"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(
      text,
      /new session/i,
      `${file} sends the user to /mmo:greenfield without saying it needs a session opened ` +
        `after the install — the command will not be in the menu of the one that installed it`,
    );
    // These documents put every command the reader is meant to type inside a
    // fenced block, and refer to commands in prose with inline backticks. So
    // the fences are the surface that matters: SETUP.md names
    // `/reload-plugins` on purpose, to tell the installing session not to
    // offer it, and that sentence must not be mistaken for the offence.
    const fenced = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");
    assert.ok(
      !fenced.includes("/reload-plugins"),
      `${file} presents /reload-plugins as a command to type — the desktop app has no such ` +
        `command, and a dead end is worse than the restart it was meant to avoid`,
    );
  }
});

test("the README documents the install a first-time user is given, with the real names", () => {
  // The README is the first thing anyone reads, and it is the one place the
  // repair command can be copied from without an install already working.
  // A rename that misses it hands users a command that silently finds nothing.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.ok(readme.includes("SETUP.md"), "the README must point at the instructions Claude Code follows");
  assert.ok(
    readme.includes(`cache/${mkt.name}/${mkt.plugins[0].name}/`),
    "the repair command in the README must use the published marketplace and plugin names"
  );
});

// ─── unexpanded environment placeholders ──────────────────────────────
//
// plugin.json declares the MCP server's environment as `"${VAR}"` pass-throughs.
// When the host never exported the variable, the literal placeholder is handed
// through instead of an empty value — verified against a live server process on
// 2026-08-04. The literal is truthy, so before this check every credential probe
// below saw a "set" variable and gave the run a green light while no door into
// Gemini was actually open. The run then spent its premium phases and died at the
// first mechanical dispatch.

test("isUnexpandedPlaceholder recognises a placeholder and nothing else", () => {
  assert.equal(isUnexpandedPlaceholder("${GOOGLE_CLOUD_PROJECT}"), true);
  assert.equal(isUnexpandedPlaceholder("  ${GEMINI_BACKEND}  "), true);
  // Anchored on both ends, so a real value containing a dollar sign survives.
  assert.equal(isUnexpandedPlaceholder("ai-studies-console"), false);
  assert.equal(isUnexpandedPlaceholder("prefix-${VAR}"), false);
  assert.equal(isUnexpandedPlaceholder("${VAR}-suffix"), false);
  assert.equal(isUnexpandedPlaceholder("$VAR"), false);
  assert.equal(isUnexpandedPlaceholder(undefined), false);
});

test("usableEnv drops placeholders and empties, keeps real values", () => {
  const out = usableEnv({
    GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}",
    GOOGLE_CLOUD_LOCATION: "",
    GEMINI_API_KEY: "   ",
    ANTHROPIC_API_KEY: "sk-real",
  });
  assert.deepEqual(out, { ANTHROPIC_API_KEY: "sk-real" });
});

test("usableEnv does not mutate its input", () => {
  // This script only reports; the in-place stripping is the server's job
  // (mcp/model-dispatch/src/envBootstrap.ts).
  const env = { GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}" };
  usableEnv(env);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, "${GOOGLE_CLOUD_PROJECT}");
});

test("a placeholder no longer counts as a Gemini credential", () => {
  // THE REGRESSION. Every one of these was reported as "credentials present"
  // before the fix, because the literal is truthy.
  const poisoned = {
    GEMINI_API_KEY: "${GEMINI_API_KEY}",
    GOOGLE_APPLICATION_CREDENTIALS: "${GOOGLE_APPLICATION_CREDENTIALS}",
    GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}",
  };
  assert.equal(hasGeminiCredentials({ env: poisoned }), true, "the raw env still fools it, by design");
  assert.equal(
    hasGeminiCredentials({ env: usableEnv(poisoned) }),
    false,
    "once cleaned, no door is open and the user must be told so",
  );
});

test("evaluate reports no Gemini credentials when every value is a placeholder", () => {
  const { problems } = evaluate({
    nodeMajor: 20,
    hasClaudeCli: true,
    hasNodeModules: true,
    hasDist: true,
    hasAdcFile: false,
    env: {
      GEMINI_API_KEY: "${GEMINI_API_KEY}",
      GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}",
      GEMINI_BACKEND: "${GEMINI_BACKEND}",
    },
  });
  assert.ok(
    problems.some((p) => p.id === "gemini-credentials"),
    "a false green light here is what caused the 2026-08-04 all-premium run",
  );
  const placeholders = problems.find((p) => p.id === "env-placeholders");
  assert.ok(placeholders, "the user must be told their variables are not reaching the plugin");
  assert.equal(placeholders.severity, "warning", "the server self-heals, so this alone must not block");
  assert.match(placeholders.fix, /settings\.json/, "the fix must name where Claude Code actually reads env");
});

test("evaluate stays quiet about placeholders when there are none", () => {
  const { problems } = evaluate({
    nodeMajor: 20,
    hasClaudeCli: true,
    hasNodeModules: true,
    hasDist: true,
    hasAdcFile: true,
    env: { ANTHROPIC_API_KEY: "sk-real" },
  });
  assert.equal(problems.some((p) => p.id === "env-placeholders"), false);
  assert.equal(problems.some((p) => p.id === "gemini-credentials"), false);
});

test("unexpandedDeclaredEnv reports only declared names, in declaration order", () => {
  const found = unexpandedDeclaredEnv({
    GEMINI_BACKEND: "${GEMINI_BACKEND}",
    GEMINI_API_KEY: "${GEMINI_API_KEY}",
    UNRELATED_VAR: "${UNRELATED_VAR}",
  });
  assert.deepEqual(found, ["GEMINI_API_KEY", "GEMINI_BACKEND"]);
});

test("the declared list matches what plugin.json actually forwards", () => {
  // Two files, no import between them. If a pass-through is added to plugin.json
  // and not here, its placeholder silently keeps the old broken behaviour.
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8"),
  );
  const forwarded = Object.keys(manifest.mcpServers["model-dispatch"].env);
  assert.deepEqual([...DECLARED_ENV].sort(), forwarded.sort());
});

test("the server sanitizes exactly the names this script declares", () => {
  // verify-setup.mjs runs before `npm ci` and cannot import the server's
  // TypeScript, so the two lists are hand-synced. This is the only thing
  // stopping them drifting apart.
  const envTs = readFileSync(
    join(ROOT, "plugin/mcp/model-dispatch/src/env.ts"),
    "utf8",
  );
  const block = envTs.slice(envTs.indexOf("PLUGIN_DECLARED_ENV"));
  for (const name of DECLARED_ENV) {
    assert.ok(block.includes(name), `${name} is declared here but the server never strips it`);
  }
});

/**
 * The credential matrix in docs/setup.md, checked row by row against the
 * checker it describes.
 *
 * That table is what the field team walks when an install misbehaves, and three
 * of its rows exist because those combinations used to report green on a broken
 * install. A table that drifts from the code is worse than no table: it is a
 * confident wrong answer, and the person reading it has no way to know. So each
 * row's scenario is spelled out here in fixture form, run through the real
 * `evaluate()`, and the finding it produces is compared against the finding the
 * document claims — in the document's own notation.
 */

/** Every row of the matrix, in the document's order, as observable facts. */
const MATRIX_SCENARIOS = {
  1: { env: {} },
  2: { env: { GEMINI_API_KEY: "AIza-test" } },
  3: { adcFile: { present: true, usable: true, type: "authorized_user", detail: null } },
  4: {
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/svc.json" },
    serviceAccountFile: { present: true, usable: true, type: "service_account", detail: null },
  },
  5: { env: { GOOGLE_CLOUD_PROJECT: "some-project" } },
  6: {
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/svc.json" },
    serviceAccountFile: {
      present: true,
      usable: false,
      type: "service_account",
      detail: "/svc.json is a 'service_account' credential but is missing private_key",
    },
  },
  7: {
    env: { GEMINI_API_KEY: "AIza-test" },
    adcFile: { present: true, usable: true, type: "authorized_user", detail: null },
  },
  8: {
    env: { GEMINI_API_KEY: "AIza-test", MMO_SELECT: "gemini-flash=flash-agsdk-worker" },
    // A fully built worker environment, so the only thing left to fail is the
    // credential — which is the row's whole point. Without this the row would
    // also report a missing venv, and the table would look wrong for a reason
    // that has nothing to do with credentials.
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  },
};

/** Read one scenario the way the real script reads a machine, and evaluate it. */
function findingFor(scenario) {
  const env = scenario.env ?? {};
  const state = vertexCredentialState({
    env,
    serviceAccountFile: scenario.serviceAccountFile ?? null,
    adcFile: scenario.adcFile ?? null,
  });
  const { problems } = evaluate({
    nodeMajor: 20,
    hasClaudeCli: true,
    hasNodeModules: true,
    hasDist: true,
    env,
    vertex: state,
    agentWorker: scenario.agentWorker ?? null,
  });
  // Only the credential findings. The table's third column is about Gemini
  // credentials, and every scenario above leaves ANTHROPIC_API_KEY unset, which
  // is its own unrelated warning on every row.
  const credential = problems.filter(
    (p) => p.id.startsWith("gemini-credentials") || p.id.startsWith("agent-worker-credentials"),
  );
  if (credential.length === 0) return "—";
  return credential.map((p) => `\`${p.id}\` (${p.severity})`).join(", ");
}

/** Pull the matrix out of the prose, as a { rowNumber: findingCell } map. */
function matrixFromDoc() {
  const doc = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
  const heading = "### Every credential combination";
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, "the credential matrix section is gone from docs/setup.md");
  const section = doc.slice(start, doc.indexOf("\n## ", start));

  const rows = {};
  for (const line of section.split("\n")) {
    // Table rows only: a leading pipe, a bare number in the first cell. The
    // header and its `|---|` separator both fail that.
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4 || !/^\d+$/.test(cells[0])) continue;
    rows[Number(cells[0])] = cells[2];
  }
  return rows;
}

test("every row of the credential matrix says what the checker actually does", () => {
  const documented = matrixFromDoc();
  assert.deepEqual(
    Object.keys(documented).map(Number).sort((a, b) => a - b),
    Object.keys(MATRIX_SCENARIOS).map(Number).sort((a, b) => a - b),
    "the table and this test disagree about which rows exist — a new row needs a scenario here",
  );

  for (const [row, scenario] of Object.entries(MATRIX_SCENARIOS)) {
    assert.equal(
      // The document bolds the three rows that were once false greens, and bold
      // markers are not part of the finding.
      documented[row].replaceAll("**", ""),
      findingFor(scenario),
      `row ${row} of the matrix in docs/setup.md no longer matches evaluate()`,
    );
  }
});

test("the three rows called out as former false greens are the ones that are not clean", () => {
  // The section's opening sentence names rows 5, 6 and 8 by number. If a fix or a
  // regression moves which rows are interesting, that sentence is the thing most
  // likely to be left behind, because nothing about it looks stale.
  const flagged = Object.entries(MATRIX_SCENARIOS)
    .filter(([, scenario]) => findingFor(scenario) !== "—")
    .map(([row]) => Number(row))
    .sort((a, b) => a - b);
  assert.deepEqual(flagged, [1, 5, 6, 8]);

  const doc = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
  // Row 1 is "nothing is set", which is not a false green — it is the honest
  // report of a fresh machine. The other three are the ones worth naming.
  assert.match(doc, /Rows 5, 6 and 8 are the ones worth knowing by name/);
});

test("the findings named in the matrix prose are ones the checker can produce", () => {
  // The paragraph under the table names two IDs that deliberately have no row of
  // their own. They are still IDs, and still have to exist.
  const { problems: placeholders } = evaluate({
    nodeMajor: 20,
    hasClaudeCli: true,
    hasNodeModules: true,
    hasDist: true,
    env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
  });
  assert.ok(placeholders.some((p) => p.id === "env-placeholders"));

  const { problems: unproven } = evaluate({
    nodeMajor: 20,
    hasClaudeCli: true,
    hasNodeModules: true,
    hasDist: true,
    env: { GOOGLE_CLOUD_PROJECT: "some-project", MMO_SELECT: "gemini-flash=flash-agsdk-worker" },
    vertex: vertexCredentialState({ env: { GOOGLE_CLOUD_PROJECT: "some-project" } }),
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  });
  const found = unproven.find((p) => p.id === "agent-worker-credentials-unproven");
  assert.ok(found, "the unproven variant named in the prose is unreachable");
  assert.equal(found.severity, "warning");
});
