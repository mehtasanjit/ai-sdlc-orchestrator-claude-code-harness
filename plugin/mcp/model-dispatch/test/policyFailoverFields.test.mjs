/**
 * The two policy leaf fields a study sets for the Antigravity doors: `failover_locations` (the other Vertex locations
 * a refused or held call moves to, in order) and `stall_sec` (the most a call may go without receiving anything
 * before it is cut and sent again). Both are allowed only on an `antigravity-worker` leaf; a location list is a
 * non-empty list of distinct lowercase location ids (Vertex answers 400 to `GLOBAL` or `US`); a stall limit is a
 * whole number of seconds from 30 to 1,800. A policy that breaks a rule fails to load, with the reason, before
 * anything is spent; every shipped policy loads unchanged and sets neither field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFromPath } from "../dist/policy.js";

const POLICIES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");

function load(leafExtra, adapter = "antigravity-worker") {
  const dir = mkdtempSync(join(tmpdir(), "policy-fields-"));
  const extra = Object.entries(leafExtra).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n");
  writeFileSync(join(dir, "p.yaml"), `version: 1
name: fields
models:
  - id: flash
    adapter: ${adapter}
    model_name: gemini-3.8-flash
${extra}
rules:
  - default: flash
`);
  try {
    return loadPolicyFromPath(join(dir, "p.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// E-policy-new-fields: failover is a setting a policy opts into, checked at load.
test("failover_locations and stall_sec load on an antigravity-worker leaf, and are refused with the reason on another adapter, with an upper-case or repeated location, as an empty list, or out of range; shipped policies load, failover only on their antigravity-worker leaves", () => {
  const p = load({ failover_locations: ["us", "eu"], stall_sec: 240 });
  assert.deepEqual(p.models[0].failover_locations, ["us", "eu"]);
  assert.equal(p.models[0].stall_sec, 240);
  const refused = [
    [{ failover_locations: ["us"] }, "mcp:model-dispatch", /failover_locations/],
    [{ stall_sec: 120 }, "builtin-anthropic", /stall_sec/],
    [{ failover_locations: ["US"] }, undefined, /lower/i],
    [{ failover_locations: ["GLOBAL"] }, undefined, /lower/i],
    [{ failover_locations: ["us", "us"] }, undefined, /distinct|duplicate|twice/i],
    [{ failover_locations: [] }, undefined, /empty|at least one/i],
    [{ failover_locations: "us" }, undefined, /list/i],
    [{ stall_sec: 29 }, undefined, /30/],
    [{ stall_sec: 1801 }, undefined, /1,?800/],
    [{ stall_sec: 90.5 }, undefined, /whole|integer/i],
  ];
  for (const [fields, adapter, why] of refused) {
    assert.throws(() => load(fields, adapter), why, `${JSON.stringify(fields)} on ${adapter ?? "antigravity-worker"} must not load`);
  }
  // Every shipped policy that uses the Antigravity SDK opts its leaves into failover (shippedPolicyFailover.test.mjs).
  for (const name of readdirSync(POLICIES).filter((f) => f.endsWith(".yaml"))) {
    for (const m of loadPolicyFromPath(join(POLICIES, name)).models) {
      assert.deepEqual(m.failover_locations, m.adapter === "antigravity-worker" ? ["us", "eu"] : undefined, `${name}/${m.id}`);
      assert.equal(m.stall_sec, undefined, `${name}/${m.id}`);
    }
  }
});
