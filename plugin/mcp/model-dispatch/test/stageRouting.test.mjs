/**
 * Who types a file depends on the pipeline stage and the policy — never on the
 * file's language, name or type label.
 *
 * A rule that matches on task type knows only the labels its author listed
 * (controller_handler, dto, react_component, ...); any other label, and the
 * catch-all "other", falls to the default rule, so on a Go, Rust or Python
 * project a two-model policy quietly sends every file to the default model.
 * A greenfield project can be in any language, so routing must not know about
 * file types at all: the same stage routes the same way whatever the task
 * type says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFromPath } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const files = readdirSync(POLICIES).filter((f) => f.endsWith(".yaml"));

// NestJS/React labels, the catch-all, and labels no list names.
const LABELS = ["controller_handler", "react_component", "other", "config", "go_handler", "rust_module", "anything"];
const STAGES = [
  ["codegen", [0]],
  ["tests", [0]],
  ["docs", [0]],
  ["debug", [0, 1, 2, 3]],
];

test("every shipped policy routes the code, tests, docs and fix stages by stage alone — the task type never changes the model", () => {
  assert.ok(files.length >= 5, "the shipped policies are found");
  for (const f of files) {
    const policy = loadPolicyFromPath(join(POLICIES, f));
    for (const [phase, retries] of STAGES) {
      for (const retry of retries) {
        const models = new Set(LABELS.map((task_type) => pickModel({ phase, task_type, module: "spec", retry_count: retry }, policy).modelId));
        assert.equal(models.size, 1, `${f}: ${phase}@retry${retry} routes to ${[...models].join(" / ")} depending on the task type`);
      }
    }
  }
});

test("no shipped policy has a rule that matches on task type", () => {
  for (const f of files) {
    const policy = loadPolicyFromPath(join(POLICIES, f));
    for (const [i, rule] of policy.rules.entries()) {
      if ("default" in rule) continue;
      assert.equal(rule.when.task_type, undefined, `${f}: rule ${i} matches on task_type`);
    }
  }
});
