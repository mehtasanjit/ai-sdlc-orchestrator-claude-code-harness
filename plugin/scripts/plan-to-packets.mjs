#!/usr/bin/env node
/**
 * plan-to-packets — finalize a brownfield run's change spec and derive its packets, with no model call.
 *
 * Why: the packets used to be parsed out of a free-text change_plan.md, with a tolerance for every wording an
 * architect had once used; a unit the parser could not read cost a re-delegation or a whole-file fallback. Now the
 * architect hands over a typed change spec whose sections were each checked on arrival (plan-lint.mjs --section),
 * and this step does what greenfield's finalize does (spec/store.ts finalizeSpec): it checks the spec as a whole —
 * every reference resolves, every file a section pointed into is unchanged since that section was accepted, every
 * requirement id is covered by a unit, and the job's own rules hold (lib/change-spec.mjs jobRules: what each job's
 * spec holds, a bugfix's reproducing test first and its fix after it, whole-project checks for refactor, test and
 * deps, a deps run's install step waiting for the manifest edit with every unit ordered around it) — then renders
 * change_plan.md by code for Gate 2 and the reviewers, writes the typists' briefs, and writes packets.json
 * (lib/change-spec.mjs derivePackets): one packet per unit, every input a path, every check typed with its own write
 * form. Every packet names the job, which is what has the server type it with greenfield's typists. The summary says
 * whether Gate 2 opens (lib/change-spec.mjs gate2): always for feature-extend, feature-new, refactor and deps, never
 * for docs and test, and for a bugfix only when code finds its spec design-affecting — the orchestrator opens it only
 * when the summary says `Gate 2: yes`.
 *
 * Usage: node plan-to-packets.mjs --spec --run-id <id> --intent <job> [--project-root <dir>] [--json]
 *   <job>: one of the ids in config/intents.json (docs, bugfix, feature-extend, feature-new, refactor, test, deps), and
 *   the job Gate 0 recorded for the run (the first line of its intent_brief.md) when there is that record.
 *
 * Writes into <project>/.sdlc/runs/<id>/ only: change-spec.json, change_plan.md, briefs/, packets.json.
 * Exit 0 = written (one summary line; warnings on stderr). 1 = the spec is not complete or no longer matches the
 * files (one line per problem, naming the unit or section to fix). 2 = usage, or an --intent that is not the run's job.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";
import { JOBS, activeContract, assembleSpec, derivePackets, gate2, jobRules, runFolder, runJob, uncovered, writeOutputs } from "./lib/change-spec.mjs";

export { MAX_SLICE_BYTES, BUDGET, MAX_RETRIES } from "./lib/change-spec.mjs";

function parseArgs(argv) {
  const out = { spec: false, runId: null, intent: undefined, projectRoot: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--spec") out.spec = true;
    else if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--intent")) out.intent = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
    else if (a === "--json") out.json = true;
  }
  return out;
}

/** Finalize and derive. Returns { code, out: string[], err: string[] }. */
export async function finalize({ projectRoot, runId, intent }) {
  const root = resolve(projectRoot);
  // The job is required: the packets carry it, and a packet without one is not typed by greenfield's typists.
  if (!JOBS.includes(intent)) return { code: 2, out: [], err: [`--intent must be one of ${JOBS.join(", ")} (the run's job, from Gate 0)`] };
  const run = runFolder(root, runId);
  if (run.error) return { code: 2, out: [], err: [run.error] };
  // The checked party does not name its own rules: the job is the one Gate 0 recorded, when there is that record.
  const { error: jobError } = runJob(run.dir, intent);
  if (jobError) return { code: 2, out: [], err: [jobError] };
  const { specStore } = await loadServerLib();
  const { spec, errors } = assembleSpec(run.dir, root, runId);
  const requirements = join(run.dir, "requirements.md");
  if (spec && existsSync(requirements)) {
    const missing = uncovered(spec, readFileSync(requirements, "utf8"), specStore.requiredIds);
    if (missing.length) errors.push(`no unit covers ${missing.join(", ")} (requirements.md): add the id to the covers of the unit that implements it, and check that section again`);
  }
  if (spec) errors.push(...jobRules(spec, intent, { allowlist: activeContract(root, runId)?.allowlist }));
  if (errors.length) return { code: 1, out: [], err: errors.map((e) => `error: ${e}`) };
  const { packets, warnings } = derivePackets(spec, { runId, intent, projectRoot: root, runRel: run.rel });
  const paths = writeOutputs(run.dir, spec, runId, packets);
  const apply = packets.filter((p) => p.apply);
  // Whether Gate 2 opens, decided by code from the spec: the orchestrator opens it for a bugfix only when this says so.
  const gate = gate2(spec, intent);
  const summary = {
    packets: packets.length,
    codegen: apply.filter((p) => p.phase === "codegen").length,
    tests: apply.filter((p) => p.phase === "tests").length,
    docs: apply.filter((p) => p.phase === "docs").length,
    tooling: packets.filter((p) => !p.apply).length,
    edits: apply.filter((p) => p.apply.mode === "edits").length,
    deferred: (apply[apply.length - 1]?.verify_deferred ?? []).length,
    warnings: warnings.length,
    gate2: gate.open,
    gate2_reason: gate.reason,
    plan: paths.planPath,
    out: paths.packetsPath,
  };
  return {
    code: 0,
    out: [summary],
    err: warnings.map((w) => `warning: ${w}`),
    text: `plan-to-packets: ${summary.packets} packets (${summary.codegen} codegen, ${summary.tests} tests, ${summary.docs} docs, ${summary.tooling} tooling; ${summary.edits} edit lists; ${summary.deferred} end-of-run checks) → ${paths.packetsPath}; change_plan.md rendered${warnings.length ? ` · ${warnings.length} warning(s)` : ""} · Gate 2: ${gate.open ? `yes (${gate.reason})` : "no"}`,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.spec || !args.runId || !args.intent) {
    process.stderr.write(`usage: plan-to-packets.mjs --spec --run-id <id> --intent <${JOBS.join("|")}> [--project-root <dir>] [--json]\n`);
    return 2;
  }
  const r = await finalize(args);
  for (const e of r.err) process.stderr.write(e + "\n");
  if (r.code === 0) process.stdout.write((args.json ? JSON.stringify(r.out[0]) : r.text) + "\n");
  return r.code;
}

// Run directly, also through a linked folder (real paths compared, as handoff-models.mjs does). exitCode, not
// exit(): the process ends once its output has drained, which a pipe on macOS needs.
const isDirectRun = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`plan-to-packets: ${e?.message ?? e}\n`); process.exitCode = 2; });
}
