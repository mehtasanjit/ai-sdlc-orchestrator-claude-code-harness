/**
 * packet-groups.mjs: a single-model run's derived packets become packet-worker
 * groups (dependency order, at most --size each, balanced) with tooling steps
 * held back until a later packet needs them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { planGroups, orderPackets, main } = await import(join(HERE, "..", "..", "..", "scripts", "packet-groups.mjs"));

const pkt = (id, depends_on = [], extra = {}) => ({ id, depends_on, task_type: "service_method", apply: { write: true, mode: "content", verify: [] }, ...extra });
const tool = (id, depends_on = []) => ({ id, depends_on, task_type: "tooling" });
const workerIds = (steps) => steps.filter((s) => s.kind === "worker").map((s) => s.packet_ids);

test("groups are balanced and never exceed the size", () => {
  const packets = Array.from({ length: 26 }, (_, i) => pkt(`p${i}`, i ? [`p${i - 1}`] : []));
  const { steps, errors } = planGroups(packets, { size: 6 });
  assert.deepEqual(errors, []);
  assert.deepEqual(workerIds(steps).map((g) => g.length), [6, 5, 5, 5, 5]);
  assert.deepEqual(workerIds(steps).flat(), packets.map((p) => p.id));
});

test("a tooling step waits until the end when nothing depends on it", () => {
  const packets = [pkt("a"), tool("t1", ["a"]), pkt("b", ["a"]), pkt("c")];
  const { steps } = planGroups(packets, { size: 6 });
  assert.deepEqual(steps, [{ kind: "worker", packet_ids: ["a", "b", "c"] }, { kind: "tooling", packet_id: "t1" }]);
});

test("a tooling step splits the segment when a later packet needs it, directly or through a dependency", () => {
  const packets = [pkt("a"), tool("gen", ["a"]), pkt("b"), pkt("c", ["gen"]), pkt("d", ["c"])];
  const { steps } = planGroups(packets, { size: 6 });
  assert.deepEqual(steps, [
    { kind: "worker", packet_ids: ["a", "b"] },
    { kind: "tooling", packet_id: "gen" },
    { kind: "worker", packet_ids: ["c", "d"] },
  ]);
});

test("packets that depend on a later packet are moved after it, otherwise order is kept", () => {
  const { packets, errors } = orderPackets([pkt("a", ["c"]), pkt("b"), pkt("c")]);
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.id), ["b", "c", "a"]);
});

test("a dependency named by plan unit resolves to that unit's packet", () => {
  const { packets, errors } = orderPackets([pkt("x2", ["A1"], { unit: "A2" }), pkt("x1", [], { unit: "A1" })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.id), ["x1", "x2"]);
  assert.deepEqual(packets[1].depends_on, ["x1"]);
});

test("unknown dependencies and cycles are errors", () => {
  assert.match(planGroups([pkt("a", ["nope"])]).errors[0], /unknown packet nope/);
  assert.match(planGroups([pkt("a", ["b"]), pkt("b", ["a"])]).errors[0], /cycle/);
});

test("chunk packets of one file stay in one group", () => {
  const packets = [pkt("p1"), pkt("p2"), pkt("p3"), pkt("e-a"), pkt("e-b", ["e-a"]), pkt("p4")];
  const { steps } = planGroups(packets, { size: 4 });
  for (const g of workerIds(steps)) assert.ok(!(g.includes("e-a") ^ g.includes("e-b")), JSON.stringify(g));
});

test("--show prints only the named packets; the CLI plan matches planGroups", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const file = join(dir, "packets.json");
    const packets = [pkt("a"), pkt("b", ["a"]), tool("t", ["b"])];
    writeFileSync(file, JSON.stringify(packets));
    let out = "";
    assert.equal(main([file, "--show", "b"], (s) => { out += s; }), 0);
    assert.deepEqual(JSON.parse(out).map((p) => p.id), ["b"]);
    out = "";
    assert.equal(main([file], (s) => { out += s; }), 0);
    const plan = JSON.parse(out);
    assert.equal(plan.workers, 1);
    assert.equal(plan.tooling, 1);
    assert.deepEqual(plan.steps, planGroups(packets).steps);
    assert.equal(main([file, "--show", "zzz"], () => {}), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
