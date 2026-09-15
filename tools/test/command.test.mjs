/**
 * Guards the two-prompt user surface: `/mmo:greenfield` takes no arguments (a
 * required flag turns "type this" into "read the docs first"). Contract
 * tests over command + agent definitions — catches regressions cheaply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const WIZARD = "plugin/commands/greenfield.md";
const FULL = "plugin/commands/pass.md";
const AGENT = "plugin/agents/orchestrator.md";

/** Split a command/agent markdown file into its YAML frontmatter and body. */
function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "command files must open with a YAML frontmatter block");
  return { head: match[1], body: match[2] };
}

test("both commands ship, and the wizard is the one prompt 2 names", () => {
  assert.ok(existsSync(join(ROOT, WIZARD)), `${WIZARD} is missing — prompt 2 has nothing to invoke`);
  assert.ok(existsSync(join(ROOT, FULL)), `${FULL} is missing — the flag surface is documented as still available`);
});

test("/mmo:greenfield declares no arguments", () => {
  const { head } = frontmatter(read(WIZARD));

  // An empty argument-hint is what tells Claude Code, and the reader of
  // /help, that there is nothing to supply. A populated hint would put the
  // burden back on the user that this command exists to remove.
  assert.match(head, /argument-hint:\s*""/, "argument-hint must be empty — the wizard takes no arguments");
  assert.match(head, /description:\s*\S/, "a description is what the user sees in /help");
});

test("/mmo:greenfield keeps the run-record flags off the user surface", () => {
  const body = frontmatter(read(WIZARD)).body;

  // --study and --run-id name an internal layout that meant something when
  // this repo held recorded study passes. To someone building their own
  // project they are noise, and asking for them implies the run belongs to
  // some catalogue rather than to the user's folder.
  for (const flag of ["--study", "--run-id", "--auth=", "--policy="]) {
    assert.ok(
      !body.includes(flag),
      `${flag} must not appear in the wizard — it is resolved by asking, not by flag`
    );
    }
});

test("/mmo:greenfield checks the install before it can spend anything", () => {
  const body = frontmatter(read(WIZARD)).body;

  // The bundled model server is built at setup time, not committed. If that
  // build is missing the run still starts, bills the judgment phases, and
  // dies at the first mechanical dispatch. The check has to come first.
  assert.match(body, /verify-setup\.mjs/, "the wizard must run the setup check");
  const verifyAt = body.indexOf("verify-setup.mjs");
  const runAt = body.indexOf("orchestrator");
  assert.ok(verifyAt < runAt, "the setup check must come before the orchestrator is invoked");
  assert.ok(existsSync(join(ROOT, "plugin", "scripts", "verify-setup.mjs")), "the script the wizard calls must exist");
});

test("/mmo:greenfield offers every brief the repo actually ships, by its installed path", () => {
  const body = frontmatter(read(WIZARD)).body;

  // The wizard runs from wherever the user is standing — normally an empty
  // folder with no repository anywhere near it. A bare `examples/<name>/brief.md`
  // resolves against that folder and finds nothing, so every brief the wizard
  // offers has to be named by its location inside the installed plugin.
  const shipped = readdirSync(join(ROOT, "examples"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "examples", e.name, "brief.md")))
    .map((e) => e.name);

  assert.ok(shipped.length > 0, "examples/ must contain at least one <name>/brief.md to offer");

  for (const name of shipped) {
    const offered = `\${CLAUDE_PLUGIN_ROOT}/examples/${name}/brief.md`;
    assert.ok(
      body.includes(offered),
      `the wizard must offer ${offered} — a brief named by a repo-relative path is unreachable from an empty folder`,
    );
    assert.ok(
      existsSync(join(ROOT, "plugin", "examples", name, "brief.md")),
      `plugin/examples/${name}/brief.md is missing — only plugin/ is copied on install, ` +
        `so a brief left at the repo root ships to nobody`,
    );
  }
});

test("every plugin file the wizard names is inside the part of the repo that ships", () => {
  const body = frontmatter(read(WIZARD)).body;

  // The general form of the bug above, and of the duplicate-hooks bug before
  // it: the repository is not the installation. `plugin/` is copied to the
  // plugin cache and nothing else is, so a wizard instruction that reaches for
  // a repo-root file is a promise the installed plugin cannot keep. Every path
  // the wizard hands the user is checked here against what actually ships.
  //
  // Caught on 2026-08-04, when a first install offered two example briefs that
  // existed only at the repo root and could not be opened from an empty folder.
  const referenced = [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[\w./-]+)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, "the wizard must reference at least one shipped path");

  for (const rel of new Set(referenced)) {
    assert.ok(
      existsSync(join(ROOT, "plugin", rel)),
      `the wizard points at \${CLAUDE_PLUGIN_ROOT}${rel}, which does not exist under plugin/ — ` +
        `it would resolve to a missing file on every install`,
    );
  }
});

test("the briefs shipped inside the plugin are the briefs kept at the repo root", () => {
  // Two copies exist because they serve two entry points: `/mmo:pass` is
  // run from a clone and reads `examples/<name>/brief.md`, while `/mmo:greenfield` is
  // run from an empty folder and can only read what the install copied. Neither
  // location can be dropped, so this asserts they never drift — editing one and
  // forgetting the other fails here rather than shipping a stale brief to the
  // only users who cannot see the repository.
  const names = readdirSync(join(ROOT, "examples"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "examples", e.name, "brief.md")))
    .map((e) => e.name);

  for (const name of names) {
    const canonical = read("examples", name, "brief.md");
    const shipped = read("plugin", "examples", name, "brief.md");
    assert.equal(
      shipped,
      canonical,
      `plugin/examples/${name}/brief.md has drifted from examples/${name}/brief.md — ` +
        `copy the root file over the plugin one`,
    );
  }
});

test("the section layout the wizard dictates is the one the brief template documents", () => {
  const body = frontmatter(read(WIZARD)).body;
  const template = read("docs", "brief-template.md");

  // The wizard spells the layout out inline rather than pointing at
  // docs/brief-template.md, because that file documents the clone workflow —
  // it opens with `/mmo:pass` usage and repo-relative output paths that
  // mean nothing in an empty folder, and it does not ship with the plugin
  // either. Inlining removes the dependency; this test removes the drift it
  // would otherwise allow, in both directions.
  const headings = template
    .slice(template.indexOf("## Section set"))
    .split("\n")
    .filter((l) => /^## /.test(l) && l.trim() !== "## Section set")
    .map((l) => l.trim());

  assert.ok(headings.length >= 8, "the template's section set must still list the brief's headings");

  for (const heading of headings) {
    assert.ok(
      body.includes(heading),
      `the wizard's inline layout is missing ${heading} — a brief written without it loses a ` +
        `section the requirements phase and the architect subagent read by name`,
    );
  }
});

test("/mmo:greenfield writes generated code to src/, and the run record beside it", () => {
  const body = frontmatter(read(WIZARD)).body;
  assert.match(body, /`\.\/src`/, "generated code goes to ./src — an ordinary directory the user can run and commit");
  assert.match(body, /`\.\/\.sdlc\/?`/, "the run record goes to ./.sdlc, out of the way of the code");
});

test("the orchestrator accepts the settings the wizard resolves", () => {
  const agent = read(AGENT);

  // The wizard hands over a resolved set. If the agent still expects to read
  // flags, the handover silently loses settings the user was just asked for.
  for (const setting of ["brief_path", "auth_mode", "policy", "code_dir", "output_dir"]) {
    assert.ok(agent.includes(setting), `the orchestrator must name ${setting} — the wizard passes it`);
  }
  assert.match(agent, /\/mmo:greenfield/, "the orchestrator must know which command invokes it");
});

test("the orchestrator runs the generated tests where the generated code is", () => {
  const agent = read(AGENT);

  // Code and run record now live in different directories. Running the
  // application's test suite from the run-record directory finds no
  // package.json and reports a failure that has nothing to do with the code.
  const testStep = agent.split("**Run tests.**")[1];
  assert.ok(testStep, "the orchestrator must still run the generated test suite");
  const npmLine = testStep.split("\n").find((l) => l.includes("npm install && npm test"));
  assert.ok(npmLine, "the test step must state the command it runs");
  assert.match(npmLine, /<code_dir>/, "tests run from code_dir, not from the run-record directory");
});

// The orchestrator's granted tools, parsed into an exact set. Substring checks
// are not good enough here: `mcp__model-dispatch__execute_with_model` and
// `mcp__plugin_mmo_model-dispatch__execute_with_model`
// share a long tail, and the whole point of these tests is to tell them apart.
function grantedTools() {
  const { head } = frontmatter(read(AGENT));
  const line = head.split("\n").find((l) => l.startsWith("tools:"));
  assert.ok(line, "the orchestrator frontmatter must declare a tools: line");
  return new Set(
    line
      .slice("tools:".length)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

test("the agent frontmatter grants the MCP tools under BOTH install-route names", () => {
  // The bundled server's tool names are not fixed — they depend on how the user
  // installed the plugin, and the repo supports two routes:
  //
  //   /plugin install      → Claude Code namespaces a plugin-provided MCP server
  //                          with the plugin's own name, giving
  //                          mcp__plugin_mmo_model-dispatch__*
  //   clone + setup.mjs    → registers the server in a project .mcp.json under a
  //                          bare key, giving mcp__model-dispatch__*
  //
  // Only one resolves in any given session; the other is silently absent, which
  // is exactly why both must be granted. Naming a tool that does not exist is
  // harmless — Claude Code ignores it rather than erroring.
  //
  // Caught on 2026-08-04 on the first plugin-route run: the frontmatter listed
  // only the bare (clone-route) names, so nothing bound, and the orchestrator
  // fell back to driving the plugin's compiled modules over Bash. The old
  // version of this test asserted the bare names alone, so it passed green
  // through the entire failure.
  const tools = grantedTools();
  for (const short of ["execute_with_model", "log_telemetry", "load_policy"]) {
    for (const full of [
      `mcp__model-dispatch__${short}`,
      `mcp__plugin_mmo_model-dispatch__${short}`,
    ]) {
      assert.ok(
        tools.has(full),
        `the orchestrator cannot dispatch without ${full} — one install route ` +
          `produces exactly this name, and an ungranted tool never binds`,
      );
    }
  }
});

test("Q3: estimate rates come from load_policy's effective_price, the price the server bills, never from a policy file's pricing block", () => {
  // The orchestrator is a model reading this text: rule 6 IS the pricing code for
  // estimated events. It told it to read the policy YAML's `pricing:` block, and
  // even to keep reading the block when pre-flight warned that the block differs
  // from the list, so estimates and billing could disagree on the same run.
  const agent = read(AGENT);
  const start = agent.indexOf("6. **Telemetry");
  const end = agent.indexOf("7. **Stateless workers");
  assert.ok(start > 0 && end > start, "rule 6 and rule 7 headings must exist");
  const rule6 = agent.slice(start, end);
  assert.match(rule6, /load_policy/);
  assert.match(rule6, /effective_price/);
  assert.doesNotMatch(rule6, /source rates from the loaded policy YAML's `pricing` block/);
  assert.doesNotMatch(rule6, /come ONLY from the loaded policy YAML's `pricing` block/);
  assert.doesNotMatch(rule6, /take your estimate rates from the block/);
  // Rule 0 no longer describes a halt for an in-session model with no block.
  assert.doesNotMatch(agent, /no pricing block under/);

  const skill = read("plugin/skills/pipeline/SKILL.md");
  assert.match(skill, /effective_price/);
  assert.doesNotMatch(skill, /source pricing constants from the loaded policy's `pricing:` block/);
  assert.doesNotMatch(skill, /Pricing constants come from the loaded policy YAML's `pricing:` block/);
  assert.doesNotMatch(skill, /no pricing block under `estimated`/);
});

test("the orchestrator can spawn every subagent the workflow tells it to invoke", () => {
  // SKILL.md delegates three phases to dedicated subagents. Delegation needs a
  // subagent-spawning tool, and TaskCreate/TaskUpdate/TaskList are not it —
  // those are the to-do list. The spawning tool is Agent (Task on older
  // builds); both are granted so the plugin works either way.
  //
  // Caught on 2026-08-04: the orchestrator held the Task* to-do tools and no
  // spawn tool at all, so architect.md, senior-reviewer.md and
  // security-reviewer.md were unreachable files and every phase collapsed into
  // the orchestrator itself — while the shipped docs described a four-agent
  // pipeline.
  const tools = grantedTools();
  assert.ok(
    tools.has("Agent") || tools.has("Task"),
    "the orchestrator delegates phases to subagents but holds no tool that can spawn one " +
      "(TaskCreate/TaskUpdate/TaskList are the to-do list, not delegation)",
  );

  const skill = read("plugin", "skills", "pipeline", "SKILL.md");
  for (const sub of ["architect", "senior-reviewer", "security-reviewer"]) {
    assert.match(
      skill,
      new RegExp(`\\b${sub}\\b`),
      `SKILL.md no longer mentions the ${sub} subagent — if a phase stopped being ` +
        `delegated, delete its agent file rather than leaving it unreachable`,
    );
    assert.ok(
      existsSync(join(ROOT, "plugin", "agents", `${sub}.md`)),
      `SKILL.md delegates a phase to ${sub}, which has no agent file`,
    );
  }
});

test("every agent that must find files on its own can actually search", () => {
  // Glob and Grep are not present on every Claude Code build — the desktop app
  // in use on 2026-08-04 has neither — and an unresolvable tool name is dropped
  // from an agent's surface silently. An agent left holding only Read cannot
  // even list the directory it was handed, and Read-only blindness looks
  // exactly like a clean review.
  //
  // Bash is the search path that exists everywhere, so any agent whose job
  // starts from a directory rather than a named file must hold it.
  const needsSearch = ["senior-reviewer", "security-reviewer"];
  for (const name of needsSearch) {
    const { head } = frontmatter(read("plugin", "agents", `${name}.md`));
    const line = head.split("\n").find((l) => l.startsWith("tools:")) ?? "";
    const tools = new Set(line.slice("tools:".length).split(",").map((t) => t.trim()));
    assert.ok(
      tools.has("Bash"),
      `${name} is handed a directory to review but has no Bash — if this build drops ` +
        `Glob and Grep it is left with Read, which cannot enumerate a directory`,
    );
  }
});

test("the telemetry hook matches the dispatch tool under both install routes", () => {
  // The hook fires on the MCP dispatch call, so its matcher carries the same
  // two-name problem as the frontmatter. A matcher that matches nothing fails
  // silently — indistinguishable from a hook with nothing to do — so the only
  // way to catch it is here.
  const hooks = JSON.parse(read("plugin", "hooks", "hooks.json"));
  const entries = hooks.hooks?.PostToolUse ?? [];
  assert.ok(entries.length > 0, "the telemetry hook must still be registered on PostToolUse");

  for (const name of [
    "mcp__model-dispatch__execute_with_model",
    "mcp__plugin_mmo_model-dispatch__execute_with_model",
  ]) {
    assert.ok(
      entries.some((e) => new RegExp(e.matcher).test(name)),
      `no PostToolUse matcher fires on ${name} — telemetry would be lost for that install route`,
    );
  }
});

test("every policy the wizard names exists on disk", () => {
  const body = frontmatter(read(WIZARD)).body;
  for (const policy of body.match(/`(opus-only|opus-plus-flash)`/g) ?? []) {
    const name = policy.replace(/`/g, "");
    assert.ok(
      existsSync(join(ROOT, "plugin", "config", "policies", `${name}.yaml`)),
      `the wizard names policy ${name}, which has no YAML file`
    );
  }
});
