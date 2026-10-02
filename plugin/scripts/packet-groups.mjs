#!/usr/bin/env node
/**
 * packet-groups — split a derived packets.json into packet-worker groups for a
 * single-model run, and print selected packets for a worker to read.
 *
 * Under a single-model policy nothing is dispatched: every apply-form packet is
 * written by the policy's own model. Written in the orchestrator's conversation,
 * each file re-reads the whole run's context (Large2-J: 119 turns, 20.6M cached
 * tokens, $13.50 of a $20.19 run). A `packet-worker` subagent starts empty and
 * writes a handful of files, so the per-turn context stays small.
 *
 * Groups follow packet order, moved only where a dependency needs it, never
 * exceed --size, and are balanced inside each segment. A tooling packet (no
 * model) is held back until a later apply packet depends on it, or the end, so
 * it splits a segment only when it must. Chunk packets of one file
 * (`tp_codegen_004-a`, `-b`) stay in one group.
 *
 * Usage:
 *   node packet-groups.mjs <packets.json> [--size 6]          → JSON plan of steps
 *   node packet-groups.mjs <packets.json> --show id1,id2,...  → those packets, JSON
 *
 * Exit 0 = ok. 1 = a dependency names an unknown packet, or a cycle. 2 = usage.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_SIZE = 6;

const isTooling = (p) => p.task_type === "tooling";
const chunkBase = (id) => id.replace(/-[a-z]$/, "");

function balance(ids, size) {
  if (ids.length === 0) return [];
  const units = [];
  for (const id of ids) {
    const last = units[units.length - 1];
    if (last && chunkBase(last[0]) === chunkBase(id) && /-[a-z]$/.test(id)) last.push(id);
    else units.push([id]);
  }
  let groupsLeft = Math.ceil(ids.length / size);
  let left = ids.length;
  let target = Math.ceil(left / groupsLeft);
  const groups = [];
  let cur = [];
  for (const u of units) {
    if (cur.length && cur.length + u.length > target) {
      groups.push(cur);
      left -= cur.length;
      groupsLeft = Math.max(1, groupsLeft - 1);
      target = Math.ceil(left / groupsLeft);
      cur = [];
    }
    cur.push(...u);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Stable topological order: packet order wherever the dependencies allow it.
// Derived plans are not always ordered (a unit may depend on a later one), and
// hand-written packets may name a plan unit (`A3`) instead of a packet id.
export function orderPackets(input) {
  const errors = [];
  const ids = new Set(input.map((p) => p.id));
  const byUnit = new Map(input.filter((p) => p.unit).map((p) => [p.unit, p.id]));
  const packets = input.map((p) => ({
    ...p,
    depends_on: (p.depends_on ?? []).map((d) => {
      if (ids.has(d)) return d;
      if (byUnit.has(d)) return byUnit.get(d);
      errors.push(`${p.id}: depends on unknown packet ${d}`);
      return null;
    }).filter((d) => d && d !== p.id),
  }));
  if (errors.length) return { packets: [], errors };
  const done = new Set();
  const out = [];
  while (out.length < packets.length) {
    const next = packets.find((p) => !done.has(p.id) && p.depends_on.every((d) => done.has(d)));
    if (!next) {
      errors.push(`dependency cycle among: ${packets.filter((p) => !done.has(p.id)).map((p) => p.id).join(", ")}`);
      return { packets: [], errors };
    }
    done.add(next.id);
    out.push(next);
  }
  return { packets: out, errors };
}

export function planGroups(input, { size = DEFAULT_SIZE } = {}) {
  const { packets, errors } = orderPackets(input);
  if (errors.length) return { steps: [], errors };

  const byId = new Map(packets.map((p) => [p.id, p]));
  const steps = [];
  let segment = [];
  let pending = [];
  const pendingIds = () => new Set(pending.map((p) => p.id));
  const needsPending = (p, held) => {
    const seen = new Set();
    const stack = [...(p.depends_on ?? [])];
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      if (held.has(d)) return true;
      stack.push(...(byId.get(d)?.depends_on ?? []));
    }
    return false;
  };
  const flush = () => {
    for (const g of balance(segment, size)) steps.push({ kind: "worker", packet_ids: g });
    segment = [];
    for (const t of pending) steps.push({ kind: "tooling", packet_id: t.id });
    pending = [];
  };

  for (const p of packets) {
    if (isTooling(p)) { pending.push(p); continue; }
    if (pending.length && needsPending(p, pendingIds())) flush();
    segment.push(p.id);
  }
  flush();
  return { steps, errors };
}

function parseArgs(argv) {
  const out = { file: null, size: DEFAULT_SIZE, show: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a.startsWith("--size")) out.size = Number(val());
    else if (a.startsWith("--show")) out.show = String(val() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith("--") && !out.file) out.file = a;
  }
  return out;
}

export function main(argv = process.argv.slice(2), write = (s) => process.stdout.write(s)) {
  const args = parseArgs(argv);
  if (!args.file || !(args.size >= 1)) {
    process.stderr.write("usage: packet-groups.mjs <packets.json> [--size N] [--show id1,id2]\n");
    return 2;
  }
  let packets;
  try { packets = JSON.parse(readFileSync(args.file, "utf8")); } catch (e) { process.stderr.write(`packet-groups: cannot read ${args.file}: ${e.message}\n`); return 2; }
  if (!Array.isArray(packets)) { process.stderr.write("packet-groups: packets.json is not an array\n"); return 2; }

  if (args.show) {
    const byId = new Map(packets.map((p) => [p.id, p]));
    const missing = args.show.filter((id) => !byId.has(id));
    if (missing.length) { process.stderr.write(`packet-groups: unknown packet id(s): ${missing.join(", ")}\n`); return 1; }
    write(JSON.stringify(args.show.map((id) => byId.get(id)), null, 1) + "\n");
    return 0;
  }

  const { steps, errors } = planGroups(packets, { size: args.size });
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  if (errors.length) return 1;
  const workers = steps.filter((s) => s.kind === "worker");
  write(JSON.stringify({ workers: workers.length, packets: workers.reduce((n, s) => n + s.packet_ids.length, 0), tooling: steps.length - workers.length, steps }) + "\n");
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
