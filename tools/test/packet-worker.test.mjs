/**
 * Single-model brownfield runs hand their packets to packet-worker subagents
 * (fresh context per group) instead of writing every file in the orchestrator's
 * conversation, and format before they verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

test("a feature run's packet flow sends single-model packets to packet workers via packet-groups.mjs", () => {
  const skill = read("plugin", "skills", "pipeline", "brownfield-features.md");
  assert.match(skill, /Hand the phase to packet workers \(brownfield, single-model policies\)/);
  assert.match(skill, /scripts\/packet-groups\.mjs/);
  assert.match(skill, /`packet-worker` agent in the foreground/);
  assert.match(skill, /Format before verify \(single-model\)/);
});

test("the feature-run orchestrator carries the packet-worker input contract", () => {
  assert.match(read("plugin", "agents", "brownfield-orchestrator.md"), /Packet-worker input contract \(brownfield, single-model\)/);
});

test("the packet worker formats before it verifies and records provenance after the format", () => {
  const md = read("plugin", "agents", "packet-worker.md");
  const front = md.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(front, /^name: packet-worker$/m);
  assert.match(front, /log_telemetry/);
  assert.doesNotMatch(front, /\bAgent\b|\bTask\b/, "a worker does not delegate");
  const format = md.indexOf("`apply.format` commands first");
  const after = md.indexOf("--after");
  assert.ok(format > 0 && after > format, "format runs before verify and before provenance --after");
  assert.match(md, /packet-groups\.mjs" "<packets_path>" --show/);
  assert.match(md, /STOP ON PASS/);
});
