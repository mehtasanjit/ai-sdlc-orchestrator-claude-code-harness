/**
 * `--enable-agent` writes the MMO_SELECT pair so nobody has to know its
 * shape. Pinned here: the command writes both files (settings + .mcp.json),
 * malformed specs are blocking, and agent-selection-without-Vertex-credentials
 * is blocking.
 *
 * Offline; writes to a temp dir, never touches real ~/.claude or repo settings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSelectSpec,
  selectSpecProblem,
  hasVertexCredentials,
  vertexCredentialState,
  inspectCredentialFile,
  agentPathAvailableHint,
  settingsPathFor,
  withAgentSelection,
  withMcpSelection,
  isBundledServerEntry,
  enableAgentPath,
  evaluate,
  AGENT_WORKER_MODEL_ID,
  AGENT_WORKER_SLOT,
  AGENT_WORKER_SELECT,
} from "../../plugin/scripts/verify-setup.mjs";

/** A scratch directory that cleans itself up, so no test can leak into $HOME. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-enable-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A machine on which everything unrelated to the selection is in place. */
const healthy = {
  nodeMajor: 20,
  hasClaudeCli: true,
  hasNodeModules: true,
  hasDist: true,
  hasBundle: true,
  hasAdcFile: false,
  env: {},
  // null, not an object with everything false — observeAgentWorker returns null
  // outright when MMO_SELECT does not name the agent worker, and a fixture that
  // invents a shape the real observer never produces tests nothing.
  agentWorker: null,
};

// ─── the spec, parsed ────────────────────────────────────────────────────

test("the constants spell one valid pair, never assembled by hand", () => {
  assert.equal(AGENT_WORKER_SELECT, `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`);
  const { pairs, invalid } = parseSelectSpec(AGENT_WORKER_SELECT);
  assert.deepEqual(invalid, []);
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

test("an absent, empty or whitespace spec is no choices, not an error", () => {
  // These three have to behave identically: an unset variable, a variable the
  // wizard wrote as "", and one a shell expanded to spaces all mean the same
  // thing to a user who took the default.
  for (const spec of [undefined, null, "", "   "]) {
    assert.deepEqual(parseSelectSpec(spec), { pairs: {}, invalid: [] });
  }
});

test("several pairs parse independently, and stray whitespace is tolerated", () => {
  const { pairs, invalid } = parseSelectSpec(` a=1 , ${AGENT_WORKER_SELECT} `);
  assert.deepEqual(invalid, []);
  assert.equal(pairs.a, "1");
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

test("a piece with no usable '=' is collected as invalid, not silently dropped", () => {
  // Dropping was the old behaviour and it is what made the bare leaf survive
  // all the way to policy load.
  for (const bad of ["flash-agsdk-worker", "=x", "slot=", "just-words"]) {
    const { invalid } = parseSelectSpec(bad);
    assert.deepEqual(invalid, [bad], `'${bad}' must be reported, not ignored`);
  }
});

test("one bad piece does not discard the good ones alongside it", () => {
  const { pairs, invalid } = parseSelectSpec(`oops,${AGENT_WORKER_SELECT}`);
  assert.deepEqual(invalid, ["oops"]);
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

// ─── the malformed-spec finding ──────────────────────────────────────────

test("a valid spec produces no finding", () => {
  assert.equal(selectSpecProblem({ MMO_SELECT: AGENT_WORKER_SELECT }), null);
  assert.equal(selectSpecProblem({}), null);
  assert.equal(selectSpecProblem({ MMO_SELECT: "" }), null);
});

test("the bare leaf is named as the exact mistake it is", () => {
  const problem = selectSpecProblem({ MMO_SELECT: AGENT_WORKER_MODEL_ID });
  assert.ok(problem, "a bare leaf must be a finding");
  assert.equal(problem.severity, "blocking");
  // The message has to say WHICH half is missing. "Invalid value" sends the
  // reader back to the same file to make the same edit.
  assert.match(problem.message, /is the option, not the whole selection/);
  assert.match(problem.fix, new RegExp(AGENT_WORKER_SELECT));
  assert.match(problem.fix, /--enable-agent/);
});

test("any other malformed spec is blocking too, and quotes what it saw", () => {
  const problem = selectSpecProblem({ MMO_SELECT: "gibberish" });
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
  assert.match(problem.message, /'gibberish'/);
  // Only the bare-leaf case gets the extra sentence; a random typo does not
  // deserve a paragraph about a leaf the user never mentioned.
  assert.ok(!/is the option, not the whole selection/.test(problem.message));
});

test("evaluate surfaces the malformed spec as a blocking problem", () => {
  const { ok, problems } = evaluate({
    ...healthy,
    env: { MMO_SELECT: AGENT_WORKER_MODEL_ID },
  });
  assert.equal(ok, false, "a spec no policy can load must not report a runnable install");
  assert.ok(problems.some((p) => p.id === "select-spec"));
});

// ─── the credential door ─────────────────────────────────────────────────

/** A credential file that inspected cleanly, without writing one to a real disk. */
const goodFile = { present: true, usable: true, type: "authorized_user", detail: null };
/** One that is present and certainly unusable — the shape a truncated key has. */
const brokenFile = { present: true, usable: false, type: "service_account", detail: "/k.json is a 'service_account' credential but is missing private_key" };
const absentFile = { present: false, usable: false, type: null, detail: null };

test("a real credential is the only thing that counts as one", () => {
  const state = (opts) => vertexCredentialState(opts).state;

  assert.equal(state({ env: {}, adcFile: absentFile }), "none");
  assert.equal(state({ env: {}, adcFile: goodFile }), "credential");
  assert.equal(
    state({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }, serviceAccountFile: goodFile }),
    "credential",
  );

  // The false positive this replaced. GOOGLE_CLOUD_PROJECT names where to bill,
  // not who is asking — but it is truthy, it is the variable every Google Cloud
  // tutorial mentions first, and the old boolean counted it as a login. Someone
  // who set only that passed every offline check and failed at the first
  // delegated packet, after the premium phases were billed.
  assert.equal(state({ env: { GOOGLE_CLOUD_PROJECT: "proj" }, adcFile: absentFile }), "project-only");
  assert.equal(hasVertexCredentials({ state: "project-only" }), false);
  assert.equal(hasVertexCredentials({ state: "credential" }), true);
  assert.equal(hasVertexCredentials(null), false);
});

test("a credential that exists but cannot sign is broken, not missing", () => {
  // Existence was the whole of the old check. These two states look identical to
  // `existsSync` and could not be more different to the user: one person has not
  // started, the other believes they have finished.
  assert.equal(
    vertexCredentialState({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }, serviceAccountFile: brokenFile }).state,
    "broken",
  );
  assert.equal(vertexCredentialState({ env: {}, adcFile: brokenFile }).state, "broken");
});

test("an explicit service-account file that is broken does not fall back to gcloud's", () => {
  // google-auth does not fall back either: GOOGLE_APPLICATION_CREDENTIALS wins
  // outright. Reporting the healthy ADC file here would send someone hunting for
  // a fault in the wrong place while the variable that actually decides sits
  // untouched.
  const state = vertexCredentialState({
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" },
    serviceAccountFile: brokenFile,
    adcFile: goodFile,
  });
  assert.equal(state.state, "broken");
  assert.equal(state.source, "GOOGLE_APPLICATION_CREDENTIALS");
});

test("inspectCredentialFile only declares failure when it is certain", () => {
  const read = (contents) => () => contents;
  const yes = () => true;

  assert.equal(inspectCredentialFile("/x.json", { exists: () => false }).usable, false);
  assert.equal(inspectCredentialFile("/x.json", { exists: yes, read: read("not json") }).usable, false);
  assert.equal(inspectCredentialFile("/x.json", { exists: yes, read: read("{}") }).usable, false);

  const missingField = inspectCredentialFile("/x.json", {
    exists: yes,
    read: read(JSON.stringify({ type: "service_account", client_email: "a@b.c" })),
  });
  assert.equal(missingField.usable, false);
  assert.match(missingField.detail, /private_key/);

  const complete = inspectCredentialFile("/x.json", {
    exists: yes,
    read: read(JSON.stringify({ type: "authorized_user", client_id: "i", client_secret: "s", refresh_token: "r" })),
  });
  assert.equal(complete.usable, true);

  // A type this check has never heard of is USABLE. Inventing a failure is worse
  // than missing one: the value of this script is that a green light is trusted.
  const unknown = inspectCredentialFile("/x.json", {
    exists: yes,
    read: read(JSON.stringify({ type: "some_future_credential" })),
  });
  assert.equal(unknown.usable, true);
  assert.match(unknown.detail, /not one this check knows how to verify/);
});

test("an AI Studio key does not satisfy the agent path", () => {
  // gemini_worker.py constructs its client with vertex=True and has no
  // API-key branch, so a GEMINI_API_KEY is not a partial credential here — it
  // is the wrong door entirely, and saying so is the whole value of the check.
  const { ok, problems } = evaluate({
    ...healthy,
    env: { MMO_SELECT: AGENT_WORKER_SELECT, GEMINI_API_KEY: "AIza-x" },
    vertex: vertexCredentialState({ env: {}, adcFile: absentFile }),
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  });
  const problem = problems.find((p) => p.id === "agent-worker-credentials");
  assert.ok(problem, "selecting the agent path with no Vertex credentials must block");
  assert.equal(ok, false);
  assert.match(problem.message, /AI Studio path/);
  assert.match(problem.fix, /gcloud auth application-default login/);
  assert.match(problem.fix, /--disable-agent/);
});

test("a named project with no credential warns on the agent path, and does not block", () => {
  // The one state that cannot be settled offline. Inside Google Cloud the
  // credential lives on a metadata server and this state is a working install;
  // on a laptop it is a dead end. Failing the exit code would break every
  // legitimate Cloud Build install, so it is said out loud and pointed at the
  // two-cent probe that actually decides.
  const { ok, problems } = evaluate({
    ...healthy,
    env: { MMO_SELECT: AGENT_WORKER_SELECT, GOOGLE_CLOUD_PROJECT: "proj" },
    vertex: vertexCredentialState({ env: { GOOGLE_CLOUD_PROJECT: "proj" }, adcFile: absentFile }),
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  });
  assert.equal(ok, true, "a state that may well be correct must not fail the exit code");
  const problem = problems.find((p) => p.id === "agent-worker-credentials-unproven");
  assert.ok(problem, "an unproven credential must still be reported");
  assert.equal(problem.severity, "warning");
  assert.match(problem.message, /'proj'/);
  assert.match(problem.fix, /probe-agent-worker\.mjs/);
});

test("a broken credential blocks, and says it is present rather than missing", () => {
  const { ok, problems } = evaluate({
    ...healthy,
    env: { ANTHROPIC_API_KEY: "x", GOOGLE_APPLICATION_CREDENTIALS: "/k.json" },
    vertex: vertexCredentialState({
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" },
      serviceAccountFile: brokenFile,
    }),
  });
  assert.equal(ok, false);
  const problem = problems.find((p) => p.id === "gemini-credentials-broken");
  assert.ok(problem);
  assert.match(problem.message, /not a missing credential/);
  assert.match(problem.message, /private_key/);
  assert.match(problem.fix, /takes precedence/);

  // One cause, one finding. A broken credential is not a credential, so the
  // generic "no Gemini credentials found" warning would fire too if it were not
  // suppressed — and a report that says a credential is present and unusable on
  // one line and absent on the next teaches the reader to distrust both.
  assert.deepEqual(
    problems.filter((p) => p.id.startsWith("gemini-credentials")).map((p) => p.id),
    ["gemini-credentials-broken"],
  );
  // The suppressed warning was the only place the AI Studio alternative was
  // offered, so this problem has to carry it. Someone whose service-account file
  // is broken may well prefer the other door to repairing this one.
  assert.match(problem.fix, /aistudio\.google\.com/);
});

test("the gcloud advice says so when gcloud is not installed", () => {
  // Sending someone to run a command their machine does not have is the same
  // dead end as the export advice was: the instruction is followed, nothing
  // happens, and the report still says the same thing next time.
  const { problems } = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" }, hasGcloud: false });
  const problem = problems.find((p) => p.id === "gemini-credentials");
  assert.match(problem.fix, /not on this machine's PATH/);
  assert.match(problem.fix, /cloud\.google\.com\/sdk\/docs\/install/);

  const installed = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" } });
  assert.ok(
    !/not on this machine's PATH/.test(installed.problems.find((p) => p.id === "gemini-credentials").fix),
    "a machine that has gcloud must not be nagged about it",
  );
});

// ─── the door that opens after the wizard has already run ────────────────

test("an install on the model path is told when the agent door has opened", () => {
  // The gap: the wizard asks the agent question only when it can see Google
  // credentials, which is right at install time and wrong forever after. Someone
  // who runs `gcloud auth application-default login` a week later has the door
  // open and no reason ever to re-run the wizard — but they do re-run this check.
  const hint = agentPathAvailableHint("/plugins/orch", vertexCredentialState({ env: {}, adcFile: goodFile }), {});
  assert.ok(hint, "a model-path install with real credentials must be told");
  assert.match(hint, /--enable-agent/);
  // Information, not a nag. The model path is the cheaper default and most
  // installs should stay on it, so the line has to say so.
  assert.match(hint, /staying on it is fine/);
});

test("that hint is silent for everyone it would only be noise for", () => {
  const good = vertexCredentialState({ env: {}, adcFile: goodFile });
  // Already through the door.
  assert.equal(agentPathAvailableHint("/plugins/orch", good, { MMO_SELECT: AGENT_WORKER_SELECT }), null);
  // No door: an AI Studio key cannot reach the agent path at all.
  assert.equal(
    agentPathAvailableHint("/plugins/orch", vertexCredentialState({ env: {}, adcFile: absentFile }), { GEMINI_API_KEY: "k" }),
    null,
  );
  // A named project is not a credential, so it is not an open door either.
  assert.equal(
    agentPathAvailableHint("/plugins/orch", vertexCredentialState({ env: { GOOGLE_CLOUD_PROJECT: "p" }, adcFile: absentFile }), {}),
    null,
  );
});

test("the credential check is silent for anyone who did not select the agent path", () => {
  // The model path works with an AI Studio key and always has. A user on it
  // must never be told to run a gcloud command they do not need.
  const { problems } = evaluate({ ...healthy, env: { GEMINI_API_KEY: "AIza-x" } });
  assert.ok(!problems.some((p) => p.id === "agent-worker-credentials"));
});

test("Vertex credentials present means no credential finding", () => {
  const { problems } = evaluate({
    ...healthy,
    hasAdcFile: true,
    env: { MMO_SELECT: AGENT_WORKER_SELECT },
    agentWorker: { hasVenv: true, sdkImportable: true, detail: null },
  });
  assert.ok(!problems.some((p) => p.id === "agent-worker-credentials"));
});

// ─── which file gets written ─────────────────────────────────────────────

test("the default scope is this folder's local settings, not the machine's", () => {
  // A machine-wide default would silently change every other project the user
  // opens, and the agent path is a per-project decision.
  assert.equal(settingsPathFor("project", "/w", "/h"), join("/w", ".claude", "settings.local.json"));
  assert.equal(settingsPathFor("user", "/w", "/h"), join("/h", ".claude", "settings.json"));
});

test("the project target is the local file, which is not the committed one", () => {
  // .claude/settings.json is committed; whether the agent path works depends on
  // the machine, so a teammate must not inherit this selection from a clone.
  assert.ok(settingsPathFor("project", "/w", "/h").endsWith("settings.local.json"));
});

// ─── the merge rules ─────────────────────────────────────────────────────

test("enabling adds the pair and leaves every other key alone", () => {
  const next = withAgentSelection(
    { permissions: { allow: ["Bash"] }, env: { ANTHROPIC_API_KEY: "sk-x" } },
    true
  );
  assert.equal(next.env.MMO_SELECT, AGENT_WORKER_SELECT);
  assert.equal(next.env.ANTHROPIC_API_KEY, "sk-x", "the user's key must survive");
  assert.deepEqual(next.permissions, { allow: ["Bash"] });
});

test("enabling is idempotent, so running the command twice is harmless", () => {
  const once = withAgentSelection({}, true);
  assert.deepEqual(withAgentSelection(once, true), once);
});

test("disabling removes our pair and keeps anyone else's", () => {
  const next = withAgentSelection({ env: { MMO_SELECT: `other=x,${AGENT_WORKER_SELECT}` } }, false);
  assert.equal(next.env.MMO_SELECT, "other=x");
});

test("disabling deletes the variable rather than leaving an empty string", () => {
  // An empty spec and an absent one must behave identically at the parser, and
  // only one of the two looks like it was meant.
  const next = withAgentSelection({ env: { MMO_SELECT: AGENT_WORKER_SELECT } }, false);
  assert.ok(!("MMO_SELECT" in (next.env ?? {})));
});

test("an env block that becomes empty is removed, not left as {}", () => {
  const next = withAgentSelection({ env: { MMO_SELECT: AGENT_WORKER_SELECT } }, false);
  assert.ok(!("env" in next), "an empty env block is noise in a file the user reads");
});

test("disabling leaves a selection this command did not make", () => {
  // Someone who pinned the slot to the completion leaf on purpose said
  // something; --disable-agent means "not the agent", not "forget everything".
  const next = withAgentSelection(
    { env: { MMO_SELECT: `${AGENT_WORKER_SLOT}=flash-completion` } },
    false
  );
  assert.equal(next.env.MMO_SELECT, `${AGENT_WORKER_SLOT}=flash-completion`);
});

test("a malformed existing spec is repaired, not merged", () => {
  // This is the mistake the command exists to fix. Preserving the bad piece
  // would leave the policy unable to load and make the command useless.
  const next = withAgentSelection({ env: { MMO_SELECT: AGENT_WORKER_MODEL_ID } }, true);
  assert.equal(next.env.MMO_SELECT, AGENT_WORKER_SELECT);
});

test("withAgentSelection does not mutate what it was given", () => {
  const before = { env: { ANTHROPIC_API_KEY: "sk-x" } };
  withAgentSelection(before, true);
  assert.deepEqual(before, { env: { ANTHROPIC_API_KEY: "sk-x" } });
});

// ─── the clone route's .mcp.json ─────────────────────────────────────────

test("only the bundled server is recognised, and by its script not its key", () => {
  const ours = { command: "node", args: [join("/x", "model-dispatch", "dist", "server.js")] };
  assert.equal(isBundledServerEntry(ours), true);
  assert.equal(isBundledServerEntry({ command: "node", args: ["/x/other/dist/server.js"] }), false);
  assert.equal(isBundledServerEntry({ command: "uvx", args: ["some-mcp"] }), false);
  assert.equal(isBundledServerEntry({}), false);
});

test("the selection reaches the clone route's server entry", () => {
  // On that route the entry's env block is exhaustive — a stdio server does not
  // inherit the parent environment — so a settings-only write would be read by
  // Claude Code and then dropped at the server boundary.
  const doc = {
    mcpServers: {
      "model-dispatch": {
        command: "node",
        args: [join("/x", "model-dispatch", "dist", "server.js")],
        env: { GEMINI_API_KEY: "AIza-x" },
      },
      other: { command: "uvx", args: ["some-mcp"], env: { A: "1" } },
    },
  };
  const { config, updated } = withMcpSelection(doc, true);
  assert.deepEqual(updated, ["model-dispatch"]);
  assert.equal(config.mcpServers["model-dispatch"].env.MMO_SELECT, AGENT_WORKER_SELECT);
  assert.equal(config.mcpServers["model-dispatch"].env.GEMINI_API_KEY, "AIza-x");
  assert.deepEqual(config.mcpServers.other.env, { A: "1" }, "another server must be untouched");
});

test("a document with no bundled server is returned unchanged", () => {
  const doc = { mcpServers: { other: { command: "uvx", args: ["x"] } } };
  assert.deepEqual(withMcpSelection(doc, true), { config: doc, updated: [] });
  assert.deepEqual(withMcpSelection({}, true), { config: {}, updated: [] });
});

// ─── writing to disk ─────────────────────────────────────────────────────

test("the settings file is created when it does not exist", () =>
  withTempDir((cwd) => {
    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.spec, AGENT_WORKER_SELECT);
    assert.equal(result.mcpPath, null, "no .mcp.json here, so nothing to report");
    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), {
      env: { MMO_SELECT: AGENT_WORKER_SELECT },
    });
  }));

test("an existing settings file is merged, not replaced", () =>
  withTempDir((cwd) => {
    const path = join(cwd, ".claude", "settings.local.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-x" }, model: "opus" }));

    enableAgentPath({ cwd, enabled: true });
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.env.ANTHROPIC_API_KEY, "sk-x");
    assert.equal(after.env.MMO_SELECT, AGENT_WORKER_SELECT);
    assert.equal(after.model, "opus");
  }));

test("a clone's .mcp.json is updated alongside the settings file", () =>
  withTempDir((cwd) => {
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "model-dispatch": {
            command: "node",
            args: [join(cwd, "plugin", "mcp", "model-dispatch", "dist", "server.js")],
            env: { GEMINI_API_KEY: "AIza-x" },
          },
        },
      })
    );

    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.mcpPath, mcpPath, "the caller must be able to name the file it changed");
    const after = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.equal(after.mcpServers["model-dispatch"].env.MMO_SELECT, AGENT_WORKER_SELECT);
    assert.equal(after.mcpServers["model-dispatch"].env.GEMINI_API_KEY, "AIza-x");
  }));

test("no .mcp.json is created where there was none", () =>
  withTempDir((cwd) => {
    enableAgentPath({ cwd, enabled: true });
    assert.equal(
      existsSync(join(cwd, ".mcp.json")),
      false,
      "a routing flag must not register a server at a path it guessed"
    );
  }));

test("disabling clears the selection from both files", () =>
  withTempDir((cwd) => {
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "model-dispatch": {
            command: "node",
            args: [join(cwd, "model-dispatch", "dist", "server.js")],
            env: { MMO_SELECT: AGENT_WORKER_SELECT, GEMINI_API_KEY: "AIza-x" },
          },
        },
      })
    );
    enableAgentPath({ cwd, enabled: true });
    const result = enableAgentPath({ cwd, enabled: false });

    assert.equal(result.spec, null);
    assert.ok(!("MMO_SELECT" in (JSON.parse(readFileSync(result.path, "utf8")).env ?? {})));
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.ok(!("MMO_SELECT" in mcp.mcpServers["model-dispatch"].env));
    assert.equal(mcp.mcpServers["model-dispatch"].env.GEMINI_API_KEY, "AIza-x");
  }));

test("an unreadable settings file is refused, and nothing at all is written", () =>
  withTempDir((cwd) => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const path = join(cwd, ".claude", "settings.local.json");
    writeFileSync(path, "{ not json");
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          s: { command: "node", args: [join(cwd, "model-dispatch", "dist", "server.js")] },
        },
      })
    );

    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json", "the user's file must be left alone");
    // The refusal happens before any write, so the install is not half-changed.
    assert.ok(!/MMO_SELECT/.test(readFileSync(mcpPath, "utf8")));
  }));

test("an unreadable .mcp.json is refused before the settings file is touched", () =>
  withTempDir((cwd) => {
    writeFileSync(join(cwd, ".mcp.json"), "{ not json");
    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, false);
    assert.equal(
      existsSync(join(cwd, ".claude", "settings.local.json")),
      false,
      "a half-applied selection is worse than none"
    );
  }));
