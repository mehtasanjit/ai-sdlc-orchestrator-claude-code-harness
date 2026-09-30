/**
 * The architect and package versions: no rule tells it how to choose them; code checks the result.
 *
 * A version rule such as "pin what the registry answers" does not keep a fresh install free of
 * warnings, and as an always-rule it can override a version the brief fixes. So there is no version
 * rule: the architect takes the fixed stack from the brief and chooses the rest itself, and code
 * decides whether the result meets the brief. Its acceptance list names every command that checks the
 * finished project, with a pass rule in the brief's own words; the acceptance stage runs it, and an
 * install or audit failure comes back to the architect. The acceptance stage is the trial, so the
 * architect's shell is for looking up versions only: an instruction that allows trial runs leads it
 * to build and test a trial copy of the app before handing in its plan.
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const md = readFileSync(join(REPO, "plugin", "agents", "architect.md"), "utf-8");
const front = md.match(/^---\n([\s\S]*?)\n---/)[1];
// Line breaks in the markdown are not meaning: the section is read with runs of whitespace as one space.
const executor = md.slice(md.indexOf("# Executor mode"), md.indexOf("# Brownfield mode")).replace(/\s+/g, " ");

test("the architect keeps a shell for looking things up only: no trial runs, no installs, never the code directory", () => {
  const tools = front.match(/^tools:\s*(.*)$/m)[1].split(",").map((t) => t.trim());
  assert.ok(tools.includes("Bash"), `tools: ${tools.join(", ")}`);
  assert.match(executor, /The shell\*\* is for looking things up/);
  assert.doesNotMatch(md, /trial run/i, "no instruction or comment invites trial runs");
  assert.doesNotMatch(md, /scratch folder/i);
  assert.match(executor, /never write into the code directory with it, and never install anything\./);
});

test("no rule tells the architect how to choose versions: the brief's fixed stack stands and code checks the result", () => {
  assert.doesNotMatch(executor, /\*\*Versions\.\*\*/);
  assert.doesNotMatch(executor, /pin what the registry answers/);
  assert.doesNotMatch(executor, /current release of every package/);
  assert.match(executor, /the fixed `stack` from the brief/);
});

test("the acceptance list: every command that checks the finished project, what it is for, what it proves, and how it passes", () => {
  for (const s of ['`role: "install"`', '`role: "audit"`', '`role: "check"`', "`checks`", "`pass`", "`forbid_lines_starting_with`", "`timeout_s`", "`unchecked`", "`no_audit_reason`"]) {
    assert.ok(executor.includes(s), `names ${s}`);
  }
  assert.match(executor, /the brief's own words/, "a pass rule comes from the brief, not from a tool's defaults");
  assert.match(executor, /Every command must finish by itself/);
  assert.match(executor, /Every AC\s+id must be checked by some command\./, "no criterion is left out because a tool might be absent");
  assert.match(executor, /A check whose tool may be missing on this machine is still a command: code finds out when it runs/);
  assert.match(executor, /Only a\s+criterion that no command could check by running[^.]*goes in `unchecked`/);
  assert.match(executor, /`timeout_s`, how long it may run before code stops\s+it/, "the plan states each command's time limit");
});

test("sent back after a failed install or audit, the architect reads the whole output and replies with exact changes, writing no file itself", () => {
  assert.match(executor, /\*\*Acceptance fix\.\*\*/);
  assert.match(executor, /package registry/);
  assert.match(executor, /`failures`/);
  assert.match(executor, /within the fixed stack from the brief/);
  assert.match(executor, /You write no file yourself/);
});

test("the executor-mode instructions name no language, framework, package manager or registry", () => {
  const named = executor.match(/\b(npm|npx|pip|pipx|yarn|pnpm|cargo|crates|gem|bundler|maven|mvn|gradle|go list|go get|poetry|uv|composer|nuget|dotnet|PyPI|NestJS|Prisma|Django|FastAPI|Express|React|Python|TypeScript|JavaScript|Node\.js|Rust|Golang|Java)\b/g);
  assert.equal(named, null, `executor mode names: ${named}`);
});
