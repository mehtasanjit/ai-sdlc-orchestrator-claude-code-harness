/**
 * The greenfield executor needs these tools on the agents' `tools:` lines. A merge that takes the
 * other side of the frontmatter drops them silently, and nothing else would notice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "agents");
const tools = (name) =>
  new Set(readFileSync(join(AGENTS, `${name}.md`), "utf-8").match(/^tools:\s*(.*)$/m)[1].split(",").map((t) => t.trim()));

const NEEDED = {
  orchestrator: ["execute_stage", "finalize_spec"],
  architect: ["submit_spec_section", "finalize_spec"],
  // The orchestrator copy brownfield runs use (tools/build-agent-copies.mjs): its original's tools, and the batch. The
  // brownfield architect copy drops the spec tools with greenfield's executor mode (agent-copies.test.mjs).
  "brownfield-orchestrator": ["execute_stage", "finalize_spec", "execute_batch"],
};

for (const [agent, names] of Object.entries(NEEDED)) {
  test(`${agent} carries ${names.join(", ")} under both server names`, () => {
    const have = tools(agent);
    for (const n of names) {
      for (const prefix of ["mcp__model-dispatch__", "mcp__plugin_mmo_model-dispatch__"]) {
        assert.ok(have.has(prefix + n), `${agent} is missing ${prefix}${n}`);
      }
    }
  });
}

test("greenfield's orchestrator is not given the brownfield batch tool: only the brownfield copy has it", () => {
  const have = tools("orchestrator");
  for (const prefix of ["mcp__model-dispatch__", "mcp__plugin_mmo_model-dispatch__"]) assert.ok(!have.has(prefix + "execute_batch"), prefix);
});
