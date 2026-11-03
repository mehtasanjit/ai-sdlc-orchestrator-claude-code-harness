/**
 * The policy's two settings for thinking steps, `session_model` and `thinking_timeout_sec`, are read at the policy's top
 * level only. Written on a model entry (beside `worker_timeout_sec`, the natural place for a per-model budget) or on a
 * rule, nothing reads them, so the loader refuses them there and says where they belong, instead of loading a policy
 * that silently runs with the default (review: a leaf's `thinking_timeout_sec: 600` ran as four hours). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPolicyFromPath } from "../dist/policy.js";

/** A Gemini-thinking policy: `top` goes at its top level, `leaf` on its agent leaf, `rule` on its requirements rule. */
const POLICY = ({ top = "", leaf = "", rule = "" } = {}) => `version: 1
name: argon-think
${top}models:
  - id: argon
    adapter: antigravity-worker
    model_name: gemini-4-argon
    worker_timeout_sec: 540
${leaf}rules:
  - when: { phase: requirements_analysis }
    use: argon
${rule}  - default: argon
`;

function load(text) {
  const dir = mkdtempSync(join(tmpdir(), "policy-settings-"));
  try {
    const path = join(dir, "p.yaml");
    writeFileSync(path, text);
    return loadPolicyFromPath(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WHERE = /is a setting of the whole policy, read only at its top level \(beside 'name' and 'models'\).*Move it to the top level/;

test("thinking_timeout_sec or session_model on a model entry is refused, naming the model and where the setting belongs", () => {
  assert.throws(() => load(POLICY({ leaf: "    thinking_timeout_sec: 600\n" })), (e) => {
    assert.match(e.message, /^Policy model 'argon': thinking_timeout_sec /);
    assert.match(e.message, WHERE);
    return true;
  });
  assert.throws(() => load(POLICY({ leaf: "    session_model: claude-opus-5-5\n" })), (e) => {
    assert.match(e.message, /^Policy model 'argon': session_model /);
    assert.match(e.message, WHERE);
    return true;
  });
});

test("session_model or thinking_timeout_sec on a rule is refused, naming the rule and where the setting belongs", () => {
  assert.throws(() => load(POLICY({ rule: "    session_model: claude-opus-5-5\n" })), (e) => {
    assert.match(e.message, /^Policy rule 0: session_model /);
    assert.match(e.message, WHERE);
    return true;
  });
  assert.throws(() => load(POLICY({ rule: "    thinking_timeout_sec: 600\n" })), (e) => {
    assert.match(e.message, /^Policy rule 0: thinking_timeout_sec /);
    assert.match(e.message, WHERE);
    return true;
  });
  // Inside the rule's matcher too: nothing reads it there either.
  assert.throws(() => load(POLICY().replace("{ phase: requirements_analysis }", "{ phase: requirements_analysis, thinking_timeout_sec: 600 }")), /^Error: Policy rule 0: thinking_timeout_sec /);
});

test("the top-level form still loads, and the policy carries both values", () => {
  const p = load(POLICY({ top: "session_model: claude-opus-5-5\nthinking_timeout_sec: 28800\n" }));
  assert.equal(p.session_model, "claude-opus-5-5");
  assert.equal(p.thinking_timeout_sec, 28800);
});
