/**
 * The premium phases a helper agent of the session runs (the architect and the two reviewers) are priced from that
 * helper's own transcript, under the phase, in manifest.phase_breakdown. The orchestrator logged each of them as a
 * hand estimate (a character count at an assumed split), which the per-phase table then showed in place of the
 * measured cost. The collector already reads every helper file, and Claude Code writes each one's agent type beside it
 * (`agent-<id>.meta.json`), so each phase gets the measured figure in place of the estimate. The true total is
 * unchanged: the helpers were always inside the overhead, and the estimates were always taken out once.
 *
 * Agent types are this plugin's: `mmo:<name>` (the plugin route) or the bare `<name>` the clone route installs under
 * ./.claude/agents. Another plugin's `x:architect`, the orchestrator itself, and a helper with no meta file belong to
 * no phase; their cost stays in the overhead only.
 *
 * Every run is end to end: write-manifest.mjs writes the manifest, the real collector patches it, write-manifest runs
 * again at Gate 4. Offline, $0; needs the server's bundle (npm run build).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { phaseOfAgentType } from "../../../scripts/lib/helper-phases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const COLLECTOR = join(SCRIPTS, "collect-orchestrator-usage.mjs");
const WRITE_MANIFEST = join(SCRIPTS, "write-manifest.mjs");
const ENV = { ...process.env, MMO_SELECT: "" };
const M = 1_000_000;
// $10 per 1,000,000 output tokens: every message below is a hand-checkable $10.
const POLICY = `
version: 1
name: check-phases
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 10 }
    pricing_override: true
rules:
  - default: driver
`;
const AT = (hms) => `2026-10-05T${hms}.000Z`;
const msg = (id, ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-8", stop_reason: "end_turn", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: M } } });
const typed = (ts, name, args) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: `<command-message>${name.slice(1)} is running…</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>` } });
const ev = (over) => ({ pass: "r-h", task_type: "x", module: "app", routed_by: "orchestrator", input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, latency_ms: 1, success: true, ...over });

/** helpers: { name: { agentType?, messages } }. Returns paths and runners. */
function run({ helpers, estimates }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmo-helper-phases-")));
  const tDir = join(root, "transcripts");
  const out = join(root, ".sdlc", "runs", "r-h");
  mkdirSync(join(tDir, "sess-h", "subagents"), { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), POLICY);
  writeFileSync(join(tDir, "sess-h.jsonl"), [
    typed(AT("10:00:00"), "/mmo:feature-extend", "add a ?filter param to /users"),
    msg("s1", AT("10:00:30")),
    msg("s2", AT("10:40:00")),
  ].join("\n") + "\n");
  let n = 0;
  for (const [name, h] of Object.entries(helpers)) {
    writeFileSync(join(tDir, "sess-h", "subagents", `agent-${name}.jsonl`), h.messages.map(() => msg(`${name}_${n++}`, AT(`10:${String(10 + n).padStart(2, "0")}:00`))).join("\n") + "\n");
    if (h.agentType) writeFileSync(join(tDir, "sess-h", "subagents", `agent-${name}.meta.json`), JSON.stringify({ agentType: h.agentType, description: "x", spawnDepth: 2 }));
  }
  writeFileSync(join(out, "orchestrator.log"), [`MMO: ${AT("10:01:00")} INFO   run.start run_id=r-h mode=brownfield`, `MMO: ${AT("10:50:00")} INFO   run.end run_id=r-h outcome=completed`].join("\n") + "\n");
  writeFileSync(join(out, "telemetry.jsonl"), [
    ev({ ts: AT("10:20:00"), phase: "codegen", task_id: "tp_codegen_U01", model: "gemini-3.5-flash", provenance: "vendor", cost_usd: 0.5 }),
    ...estimates.map(([phase, cost], i) => ev({ ts: AT(`10:3${i}:00`), phase, task_id: `tp_${phase}`, model: "claude-opus-4-8", provenance: "estimated", cost_usd: cost })),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const writeManifest = (...extra) => {
    const r = spawnSync(process.execPath, [WRITE_MANIFEST, out, "--pass", "r-h", "--policy", "check-phases", "--project-root", root, ...extra], { encoding: "utf-8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const collect = (...extra) => spawnSync(process.execPath, [COLLECTOR, out, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir, ...extra], { encoding: "utf-8", env: ENV });
  const manifest = () => JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8"));
  const summary = () => readFileSync(join(out, "SUMMARY.md"), "utf-8");
  return { root, out, writeManifest, collect, manifest, summary, rm: () => rmSync(root, { recursive: true, force: true }) };
}

const HELPERS = {
  arch: { agentType: "mmo:brownfield-architect", messages: [1, 2, 3] },   // $30
  rev: { agentType: "mmo:senior-reviewer", messages: [1, 2] },             // $20, greenfield's reviewer
  sec: { agentType: "security-reviewer", messages: [1] },                  // $10, the clone route's bare agent
  orch: { agentType: "mmo:brownfield-orchestrator", messages: [1, 2] },    // $20, the driver itself: no phase
  other: { agentType: "other-plugin:architect", messages: [1] },           // $10, another plugin's agent: no phase
  bare: { messages: [1] },                                                 // $10, no meta file: no phase
};

test("phaseOfAgentType: this plugin's architect and reviewers, by namespace or the clone route's bare name; nothing else", () => {
  for (const [type, phase] of [
    ["mmo:architect", "architecture_design"], ["mmo:brownfield-architect", "architecture_design"], ["architect", "architecture_design"],
    ["mmo:senior-reviewer", "senior_code_review"], ["brownfield-senior-reviewer", "senior_code_review"],
    ["mmo:security-reviewer", "security_review"], ["mmo:brownfield-security-reviewer", "security_review"],
    ["mmo:orchestrator", null], ["mmo:discovery", null], ["other-plugin:architect", null], ["x:mmo:architect", null], ["", null], [undefined, null],
  ]) assert.equal(phaseOfAgentType(type), phase, String(type));
});

test("each helper phase is priced from its helper's transcript in phase_breakdown, in place of the orchestrator's estimate; the true total does not move", () => {
  const p = run({ helpers: HELPERS, estimates: [["architecture_design", 1], ["senior_code_review", 0.6], ["security_review", 0.4]] });
  try {
    p.writeManifest();
    assert.equal(p.manifest().phase_breakdown.architecture_design.cost_usd, 1, "before the collector: the estimate");
    const dry = p.collect("--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /helper phases: architecture_design \$30 \(1 helper file, 3 messages; replaces an estimate of \$1\); senior_code_review \$20 \(1 helper file, 2 messages; replaces an estimate of \$0\.6\); security_review \$10 \(1 helper file, 1 message; replaces an estimate of \$0\.4\)/);
    assert.match(dry.stdout, /3 helper file\(s\) belong to no phase/);
    assert.equal(p.manifest().phase_breakdown.architecture_design.cost_usd, 1, "a dry run writes nothing");

    const r = p.collect();
    assert.equal(r.status, 0, r.stderr);
    const m = p.manifest();
    assert.equal(m.orchestrator_overhead.cost_usd, 120, "session $20 + helpers $100");
    assert.equal(m.true_total_cost_usd, 120.5, "dispatched $2.5 − estimates $2 + overhead $120: unchanged by the phase prices");
    assert.equal(m.total_cost_usd, 2.5, "the dispatched total is the dispatched total");
    const arch = m.phase_breakdown.architecture_design;
    assert.equal(arch.cost_usd, 30);
    assert.equal(arch.calls, 3);
    assert.deepEqual(arch.models, ["claude-opus-4-8"]);
    assert.deepEqual(arch.measured, {
      source: "helper transcripts", cost_usd: 30, messages: 3, files: 1, agent_types: ["mmo:brownfield-architect"],
      per_model: { "claude-opus-4-8": { messages: 3, cost_usd: 30, input_tokens: 0, input_tokens_cached: 0, input_tokens_cache_write: 0, output_tokens: 3 * M } },
      pricing_complete: true, replaced_estimate_usd: 1, replaced_estimate_events: 1,
    });
    assert.equal(m.phase_breakdown.senior_code_review.cost_usd, 20);
    assert.equal(m.phase_breakdown.security_review.cost_usd, 10);
    assert.deepEqual(m.phase_breakdown.security_review.measured.agent_types, ["security-reviewer"]);
    assert.equal(m.phase_breakdown.codegen.cost_usd, 0.5, "a dispatched phase is untouched");
    assert.ok(!m.phase_breakdown.codegen.measured);
    assert.equal(m.orchestrator_overhead.helper_phases, undefined, "the collector's block carries no key its type does not declare");
    // The report shows the measured figures, with the true total.
    const s = p.summary();
    assert.match(s, /\| architecture_design \(measured: the helper's own transcript\) \| 3 \| claude-opus-4-8 \| \$30\.0000 \|/);
    assert.match(s, /\| \*\*True total\*\* \| \*\*\$120\.5000\*\* \|/);

    // Gate 4: write-manifest rebuilds the manifest from telemetry; the measured phases stay.
    p.writeManifest("--status", "accepted");
    const again = p.manifest();
    assert.equal(again.status, "accepted");
    assert.equal(again.phase_breakdown.architecture_design.cost_usd, 30);
    assert.equal(again.phase_breakdown.architecture_design.measured.replaced_estimate_usd, 1);
    assert.equal(again.true_total_cost_usd, 120.5);
    assert.match(p.summary(), /\| architecture_design \(measured: the helper's own transcript\) \| 3 \| claude-opus-4-8 \| \$30\.0000 \|/);
  } finally { p.rm(); }
});

test("a helper phase the orchestrator logged no estimate for is added with its measured figure", () => {
  const p = run({ helpers: { arch: HELPERS.arch, sec: HELPERS.sec }, estimates: [["architecture_design", 1]] });
  try {
    p.writeManifest();
    assert.equal(p.manifest().phase_breakdown.security_review, undefined);
    const r = p.collect();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /security_review \$10 \(1 helper file, 1 message; no estimate was logged\)/);
    const m = p.manifest();
    assert.equal(m.phase_breakdown.security_review.cost_usd, 10);
    assert.equal(m.phase_breakdown.security_review.measured.replaced_estimate_usd, 0);
    assert.equal(m.true_total_cost_usd, 0.5 + 60, "dispatched $1.5 − estimate $1 + overhead $60");
  } finally { p.rm(); }
});

test("a rewrite after more dispatched work drops the collector's figures, and the measured phases with them, until it runs again", () => {
  const p = run({ helpers: { arch: HELPERS.arch }, estimates: [["architecture_design", 1]] });
  try {
    p.writeManifest();
    assert.equal(p.collect().status, 0);
    assert.equal(p.manifest().phase_breakdown.architecture_design.cost_usd, 30);
    // A Gate 4 reject round dispatched more work: the collector's figures no longer match the dispatched total.
    writeFileSync(join(p.out, "telemetry.jsonl"), readFileSync(join(p.out, "telemetry.jsonl"), "utf-8") + JSON.stringify(ev({ ts: AT("11:00:00"), phase: "debug", task_id: "tp_debug_1", model: "gemini-3.5-flash", provenance: "vendor", cost_usd: 0.25 })) + "\n");
    const r = p.writeManifest();
    assert.match(r.stdout, /left out until it runs again/);
    const m = p.manifest();
    assert.equal(m.true_total_cost_usd, undefined);
    assert.equal(m.phase_breakdown.architecture_design.cost_usd, 1, "back to the dispatched figure, labelled so in SUMMARY.md");
    assert.match(p.summary(), /### By phase — dispatched work only — excludes orchestrator overhead/);
  } finally { p.rm(); }
});

test("a real session (tools/test/fixtures/fable-session-opus-helpers): its two reviewers are priced under their phases from their own transcripts; the orchestrators belong to no phase", () => {
  // Claude Code wrote each helper's agent type beside its transcript: three mmo:orchestrator helpers, one
  // mmo:senior-reviewer, one mmo:security-reviewer. The overhead is the fixture's own $13.933431.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mmo-helper-phases-real-")));
  try {
    cpSync(join(HERE, "..", "..", "..", "..", "tools", "test", "fixtures", "fable-session-opus-helpers"), root, { recursive: true });
    const r = spawnSync(process.execPath, [COLLECTOR, root, "--project-root", root, "--transcripts-dir", join(root, "transcripts"), "--dry-run"], { encoding: "utf-8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /helper phases: senior_code_review \$0\.981831 \(1 helper file, 9 messages; no estimate was logged\); security_review \$1\.417667 \(1 helper file, 19 messages; no estimate was logged\)/);
    assert.match(r.stdout, /3 helper file\(s\) belong to no phase/);
    assert.match(r.stdout, /= \$13\.933431 \[transcript/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
