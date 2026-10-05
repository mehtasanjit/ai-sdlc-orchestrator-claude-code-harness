#!/usr/bin/env node
/**
 * plan-to-packets — finalize a brownfield feature run's change spec and derive its packets, with no model call.
 *
 * Why: the packets used to be parsed out of a free-text change_plan.md, with a tolerance for every wording an
 * architect had once used; a unit the parser could not read cost a re-delegation or a whole-file fallback. Now the
 * architect hands over a typed change spec whose sections were each checked on arrival (plan-lint.mjs --section),
 * and this step does what greenfield's finalize does (spec/store.ts finalizeSpec): it checks the spec as a whole —
 * every reference resolves, every file a section pointed into is unchanged since that section was accepted, every
 * requirement id is covered by a unit — then renders change_plan.md by code for Gate 2 and the reviewers, writes
 * the typists' briefs, and writes packets.json (lib/change-spec.mjs derivePackets): one packet per unit, every
 * input a path, every check typed with its own write form.
 *
 * Usage: node plan-to-packets.mjs --spec --run-id <id> --intent <feature-extend|feature-new> [--project-root <dir>] [--json]
 *
 * Writes into <project>/.sdlc/runs/<id>/ only: change-spec.json, change_plan.md, briefs/, packets.json.
 * Exit 0 = written (one summary line; warnings on stderr). 1 = the spec is not complete or no longer matches the
 * files (one line per problem, naming the unit or section to fix). 2 = usage.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";
import { assembleSpec, derivePackets, runFolder, uncovered, writeOutputs } from "./lib/change-spec.mjs";

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
  const run = runFolder(root, runId);
  if (run.error) return { code: 2, out: [], err: [run.error] };
  const { specStore } = await loadServerLib();
  const { spec, errors } = assembleSpec(run.dir, root, runId);
  const requirements = join(run.dir, "requirements.md");
  if (spec && existsSync(requirements)) {
    const missing = uncovered(spec, readFileSync(requirements, "utf8"), specStore.requiredIds);
    if (missing.length) errors.push(`no unit covers ${missing.join(", ")} (requirements.md): add the id to the covers of the unit that implements it, and check that section again`);
  }
  if (errors.length) return { code: 1, out: [], err: errors.map((e) => `error: ${e}`) };
  const { packets, warnings } = derivePackets(spec, { runId, intent, projectRoot: root, runRel: run.rel });
  const paths = writeOutputs(run.dir, spec, runId, packets);
  const apply = packets.filter((p) => p.apply);
  const summary = {
    packets: packets.length,
    codegen: apply.filter((p) => p.phase === "codegen").length,
    tests: apply.filter((p) => p.phase === "tests").length,
    docs: apply.filter((p) => p.phase === "docs").length,
    tooling: packets.filter((p) => !p.apply).length,
    edits: apply.filter((p) => p.apply.mode === "edits").length,
    deferred: (apply[apply.length - 1]?.verify_deferred ?? []).length,
    warnings: warnings.length,
    plan: paths.planPath,
    out: paths.packetsPath,
  };
  return {
    code: 0,
    out: [summary],
    err: warnings.map((w) => `warning: ${w}`),
    text: `plan-to-packets: ${summary.packets} packets (${summary.codegen} codegen, ${summary.tests} tests, ${summary.docs} docs, ${summary.tooling} tooling; ${summary.edits} edit lists; ${summary.deferred} end-of-run checks) → ${paths.packetsPath}; change_plan.md rendered${warnings.length ? ` · ${warnings.length} warning(s)` : ""}`,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.spec || !args.runId) {
    process.stderr.write("usage: plan-to-packets.mjs --spec --run-id <id> --intent <intent> [--project-root <dir>] [--json]\n");
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
