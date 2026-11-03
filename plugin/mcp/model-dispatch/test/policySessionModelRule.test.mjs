/**
 * `use: session_model`: a rule may give a thinking phase back to the session's own Claude model (the policy's
 * `session_model`), so routing a thinking phase back to Claude is one line in the policy. Review: the only way was to
 * add a Claude leaf, and a policy's first Claude leaf also becomes every typed file's last attempt (fallbackLeaf), and
 * in argon4-plus-sonnet55 the Sonnet leaf clashed with session_model ("2 Claude models").
 *
 * The target is for the four thinking phases only: the loader refuses it for any other phase and as a default rule;
 * the route table gives the phase to the session; pickModel never returns it as a model; typing is unchanged.
 * Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { loadPolicyFromPath } from "../dist/policy.js";
import { pickModel, simulatePolicyCost } from "../dist/routing.js";
import { routeTable } from "../dist/routeTable.js";
import { fallbackLeaf } from "../dist/executor/tools.js";

const POLICIES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const THINKING = ["requirements_analysis", "architecture_design", "senior_code_review", "security_review"];

function loadText(text) {
  const dir = mkdtempSync(join(tmpdir(), "policy-session-rule-"));
  try {
    const path = join(dir, "p.yaml");
    writeFileSync(path, text);
    return loadPolicyFromPath(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A shipped policy with `rule` (YAML lines) put first in its rules, so it is the rule that matches. */
function shippedWith(name, rule) {
  const text = readFileSync(join(POLICIES, `${name}.yaml`), "utf8").replace(/^rules:\n/m, `rules:\n${rule}`);
  return loadText(text);
}

const ARCHITECT_BACK = "  - when: { phase: architecture_design }\n    use: session_model\n";
const context = (phase, extra = {}) => ({ phase, task_type: "judgment", module: "judgment", retry_count: 0, ...extra });

test("a rule gives a thinking phase to session_model: the route table gives that phase to the session, the rest as before", () => {
  const plain = routeTable(shippedWith("argon4-plus-sonnet55", ""), {});
  const { rows, problems } = routeTable(shippedWith("argon4-plus-sonnet55", ARCHITECT_BACK), {});
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.find((r) => r.phase === "architecture_design"), { phase: "architecture_design", model: "claude-opus-5-5", model_id: null, who: "session", reason: "the policy's rule" });
  for (const r of rows.filter((x) => x.phase !== "architecture_design")) {
    assert.deepEqual(r, plain.rows.find((x) => x.phase === r.phase), r.phase);
  }
  // A list of thinking phases, and a rule's own reason, read the same way.
  const two = routeTable(shippedWith("argon4-agsdk-only", "  - when: { phase: [senior_code_review, security_review] }\n    use: session_model\n    reason: \"reviews on Claude while the study runs\"\n"), {});
  for (const p of ["senior_code_review", "security_review"]) {
    assert.deepEqual([two.rows.find((r) => r.phase === p).who, two.rows.find((r) => r.phase === p).reason], ["session", "reviews on Claude while the study runs"], p);
  }
  assert.equal(two.rows.find((r) => r.phase === "requirements_analysis").who, "engine, thinking");
});

test("typing is untouched: the last attempt (fallbackLeaf) and the typing routes are the same with the rule", () => {
  for (const name of ["argon4-agsdk-only", "argon4-plus-sonnet55", "argon4-plus-flash38", "flash-agsdk-only", "flash-agsdk-only-v38"]) {
    const plain = shippedWith(name, "");
    const back = shippedWith(name, ARCHITECT_BACK);
    assert.deepEqual(fallbackLeaf(back)?.id ?? null, fallbackLeaf(plain)?.id ?? null, name);
    for (const phase of ["codegen", "tests", "docs", "debug"]) {
      for (const retry of [0, 1, 2]) {
        const ctx = { phase, task_type: "", module: "spec", retry_count: retry };
        assert.equal(pickModel(ctx, back).modelId, pickModel(ctx, plain).modelId, `${name} ${phase} retry ${retry}`);
      }
    }
  }
});

test("pickModel never returns session_model as a model: a context its rule matches is refused, naming the session", () => {
  const policy = shippedWith("argon4-agsdk-only", ARCHITECT_BACK);
  assert.throws(() => pickModel(context("architecture_design"), policy), /rule 0 gives architecture_design to the session \(use: session_model\)/);
  assert.equal(pickModel(context("requirements_analysis"), policy).modelId, "argon");
});

test("the loader accepts use: session_model for each thinking phase, and refuses it for any other phase or as a default", () => {
  const policy = (rule) => `version: 1\nname: p\nsession_model: claude-opus-5-5\nmodels:\n  - id: argon\n    adapter: antigravity-worker\n    model_name: gemini-4-argon\nrules:\n${rule}  - default: argon\n`;
  for (const phase of [...THINKING, `[${THINKING.join(", ")}]`]) {
    assert.doesNotThrow(() => loadText(policy(`  - when: { phase: ${phase} }\n    use: session_model\n`)), phase);
  }
  // Scoped to a job too: the phase is still a thinking phase.
  assert.doesNotThrow(() => loadText(policy("  - when: { phase: architecture_design, intent: refactor }\n    use: session_model\n")));
  const NAMES = /requirements_analysis, architecture_design, senior_code_review, security_review/;
  for (const [rule, what] of [
    ["  - when: { phase: codegen }\n    use: session_model\n", /names codegen/],
    ["  - when: { phase: [architecture_design, debug] }\n    use: session_model\n", /names debug/],
    ["  - when: { phase: discovery }\n    use: session_model\n", /names discovery/],
    ["  - when: { task_type: judgment }\n    use: session_model\n", /names no phase/],
  ]) {
    assert.throws(() => loadText(policy(rule)), (e) => { assert.match(e.message, /^Policy rule 0: use: session_model /); assert.match(e.message, NAMES); assert.match(e.message, what); return true; }, rule);
  }
  assert.throws(() => loadText(`version: 1\nname: p\nmodels:\n  - id: argon\n    adapter: antigravity-worker\n    model_name: gemini-4-argon\nrules:\n  - default: session_model\n`),
    (e) => { assert.match(e.message, /^Policy rule 0: 'default: session_model' /); assert.match(e.message, NAMES); return true; });
});

test("session_model is not a name a model or a slot may take: a rule naming it would be ambiguous", () => {
  assert.throws(() => loadText("version: 1\nname: p\nmodels:\n  - id: session_model\n    adapter: builtin-anthropic\n    model_name: claude-opus-5-5\nrules:\n  - default: session_model\n"),
    /Policy model 'session_model': the id session_model is the rule target for the session's own model/);
  assert.throws(() => loadText("version: 1\nname: p\nmodels:\n  - id: argon\n    adapter: antigravity-worker\n    model_name: gemini-4-argon\nselect:\n  session_model: { default: argon, options: [argon] }\nrules:\n  - default: argon\n"),
    /Policy select 'session_model': the name session_model is the rule target for the session's own model/);
});

test("a what-if replay prices a phase its rule gives to the session at session_model", () => {
  const policy = shippedWith("argon4-agsdk-only", ARCHITECT_BACK);
  const ev = { ...context("architecture_design"), input_tokens: 1_000_000, input_tokens_cached: 0, output_tokens: 0, ts: "2026-11-02T10:00:00Z" };
  const out = simulatePolicyCost([ev], policy, {}, { env: {}, adcFileExists: false });
  assert.deepEqual(Object.keys(out.per_model), ["session_model"]);
  assert.ok(out.total_cost_usd > 0);
  // With no session_model the session's own model is not known: listed, never priced at a guess.
  const unpinned = { ...policy, session_model: undefined };
  const none = simulatePolicyCost([ev], unpinned, {}, { env: {}, adcFileExists: false });
  assert.equal(none.total_cost_usd, 0);
  assert.deepEqual(none.unpriced.map((u) => [u.model_id, u.events]), [["session_model", 1]]);
});

test("the shipped Gemini-thinking policies say how to give a thinking phase back to the session, in one line", () => {
  for (const name of ["argon4-agsdk-only", "argon4-plus-flash38", "argon4-plus-sonnet55", "flash-agsdk-only", "flash-agsdk-only-v38"]) {
    const text = readFileSync(join(POLICIES, `${name}.yaml`), "utf8");
    assert.match(text, /^# .*use: session_model/m, name);
    assert.equal(parseYaml(text).rules.some((r) => r.use === "session_model"), false, `${name} routes as before`);
  }
});
