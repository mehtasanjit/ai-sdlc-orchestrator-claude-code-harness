#!/usr/bin/env node
/**
 * findings-to-packets — a brownfield feature run's review findings and check failures, turned into fix packets by
 * code, ready for one execute_batch call.
 *
 * Why: the orchestrator hand-wrote a refinement or debug packet for every finding and failure — Opus turns spent
 * typing paths, inputs and verify commands it already had — and the reviewer typed refinement packets of its own.
 * Greenfield's repair round builds its jobs by code from the reviewer's findings and the failures the orchestrator
 * names (executor/tools.ts reviewRepairs, failureRepairs), placing each file as the executor places it
 * (executor/run.ts placeFixPath, placeNewFile, loaded from the server's bundle). This does the same for a change: one
 * packet per file with its problems merged, phase `debug` (the policies' own rule for fixes), the file whole as
 * input, and the file's own briefs and typed checks from the change spec (packets.json), so the server's apply loop
 * checks the fix as it checked the file. The orchestrator still runs the checks and reads their failures (greenfield's
 * settled rule); it names the failing files and writes no packet.
 *
 * Usage: node findings-to-packets.mjs --run-id <id> --intent <intent> [--project-root <dir>]
 *          [--review <review.json>]... [--failures <failures.json>]
 *   review.json: the senior reviewer's file, {findings: [{severity, file, line?, issue, fix}]}.
 *   failures.json: [{path, problem, context_paths?, new_file?}] — a test or check failure: the file to change, the
 *   failure verbatim, files to show beside it, and new_file when the fix creates the file.
 *
 * Writes <project>/.sdlc/runs/<id>/repairs/round-<n>.json and prints its path and what was not routed.
 * Exit 0 = written (or nothing to route, said so). 2 = usage.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";
import { BRIEFS_DIR, BUDGET, MAX_RETRIES, activeContract, editAnswerLines, matchGlob, runFolder, wholeFileInputs } from "./lib/change-spec.mjs";


/** Greenfield's reviewRepairs (executor/tools.ts): every finding that names a file is a problem for that file. */
function reviewRepairs(reviewPaths) {
  const items = [];
  const notRouted = [];
  for (const rp of reviewPaths) {
    let review;
    try { review = JSON.parse(readFileSync(rp, "utf8")); } catch (e) { notRouted.push({ file: rp, reason: `unreadable review: ${e?.message ?? e}` }); continue; }
    for (const f of review?.findings ?? []) {
      if (typeof f?.file !== "string" || !f.file) { notRouted.push({ file: rp, reason: "a finding with no file" }); continue; }
      const where = Number.isInteger(f.line) ? ` (line ${f.line})` : "";
      items.push({ path: f.file, problems: [`${f.severity ?? "finding"}${where}: ${f.issue ?? ""}${f.fix ? ` — fix: ${f.fix}` : ""}`] });
    }
  }
  return { items, notRouted };
}

/** Greenfield's failureRepairs (executor/tools.ts): one per entry, new_file carried through. */
function failureRepairs(failures) {
  return failures.map((f) => ({
    path: String(f.path), problems: [String(f.problem)], context_paths: (f.context_paths ?? []).map(String),
    ...(f.new_file === true ? { new_file: true } : {}),
  }));
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/**
 * The fix packets for these reviews and failures. Returns { packets, not_routed: [{file, reason}] }.
 * Each file is placed under the project root (a path written from above it is found; one that names no file of the
 * project or the spec is not routed), and a file the run's write contract does not allow is not routed either.
 */
export async function repairPackets({ projectRoot, runId, intent, reviews, failures }) {
  const root = resolve(projectRoot);
  const run = runFolder(root, runId);
  if (run.error) throw new Error(run.error);
  const { executorRun } = await loadServerLib();
  const fromReview = reviewRepairs(reviews);
  const items = [...fromReview.items, ...failureRepairs(failures)];
  const notRouted = fromReview.notRouted.map((n) => ({ file: n.file, reason: n.reason }));
  const specPackets = readJson(join(run.dir, "packets.json")) ?? [];
  const unitByPath = new Map(specPackets.filter((p) => p.apply).map((p) => [p.artifact_path, p]));
  const unitPaths = new Set(unitByPath.keys());
  const contract = activeContract(root, runId);

  // Placed and merged per file, in the order the problems came.
  const byFile = new Map();
  for (const it of items) {
    const placed = it.new_file ? executorRun.placeNewFile(it.path, root) : executorRun.placeFixPath(it.path, root, unitPaths);
    if (placed.reason) { notRouted.push({ file: it.path, reason: `${it.path} ${placed.reason}` }); continue; }
    if (contract && !contract.allowlist.some((g) => matchGlob(placed.path, g))) { notRouted.push({ file: placed.path, reason: `${placed.path} is outside the write contract's allowlist` }); continue; }
    const cur = byFile.get(placed.path) ?? { path: placed.path, problems: [], context: [], new_file: false };
    cur.problems.push(...it.problems);
    for (const c of it.context_paths ?? []) if (!cur.context.includes(c)) cur.context.push(c);
    cur.new_file ||= Boolean(it.new_file) && !existsSync(resolve(root, placed.path));
    byFile.set(placed.path, cur);
  }

  const packets = [];
  const shared = `${run.rel}/${BRIEFS_DIR}/shared.md`;
  for (const f of byFile.values()) {
    const own = unitByPath.get(f.path);
    const inputs = [];
    if (existsSync(resolve(root, shared))) inputs.push({ path: shared, reason: "shared brief: conventions, decisions, the files of this change (stable run record)" });
    if (own) inputs.push(...own.inputs.filter((i) => i.path === `${run.rel}/${BRIEFS_DIR}/${own.unit}.md`));
    for (const c of f.context) {
      const placed = executorRun.placeFixPath(c, root, unitPaths);
      if (placed.path && placed.path !== f.path) inputs.push({ path: placed.path, reason: "named beside the failure" });
    }
    const problems = f.problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
    let instruction;
    if (f.new_file) {
      instruction = `Create \`${f.path}\` so that these problems are solved, following the conventions in the shared brief:\n${problems}\nReturn JSON {path, content} with the complete file.`;
    } else {
      inputs.push(...wholeFileInputs(root, f.path, "current text"));
      instruction = [`Fix \`${f.path}\` for these problems, changing only what they need, following the conventions in the shared brief:`, problems, "", ...editAnswerLines(f.path)].join("\n");
    }
    // The file's own typed checks from the spec; a file outside it has none, and the project checks run at the end.
    const checks = own?.apply?.checks ?? [];
    packets.push({
      id: "",
      phase: "debug",
      task_type: "",
      module: "spec",
      intent,
      pass_id: runId,
      artifact_path: f.path,
      instruction,
      inputs,
      acceptance: [],
      budget: { ...BUDGET },
      retry_count: 0,
      apply: { write: true, mode: f.new_file ? "content" : "edits", checks, ...(own?.apply?.baseline_from && f.new_file ? { baseline_from: own.apply.baseline_from } : {}), ...(own?.apply?.verify_timeout_sec ? { verify_timeout_sec: own.apply.verify_timeout_sec } : {}), max_retries: MAX_RETRIES },
    });
  }
  return { packets, not_routed: notRouted };
}

function parseArgs(argv) {
  const out = { runId: null, intent: undefined, projectRoot: process.cwd(), reviews: [], failures: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--intent")) out.intent = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
    else if (a.startsWith("--review")) out.reviews.push(val());
    else if (a.startsWith("--failures")) out.failures = val();
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.runId || (!args.reviews.length && !args.failures)) {
    process.stderr.write("usage: findings-to-packets.mjs --run-id <id> --intent <intent> [--project-root <dir>] [--review <review.json>]... [--failures <failures.json>]\n");
    return 2;
  }
  const root = resolve(args.projectRoot);
  const run = runFolder(root, args.runId);
  if (run.error) { process.stderr.write(`findings-to-packets: ${run.error}\n`); return 2; }
  let failures = [];
  if (args.failures) {
    failures = readJson(resolve(root, args.failures));
    if (!Array.isArray(failures)) { process.stderr.write(`findings-to-packets: ${args.failures} must hold a JSON array of {path, problem, context_paths?, new_file?}\n`); return 2; }
  }
  const { packets, not_routed } = await repairPackets({ projectRoot: root, runId: args.runId, intent: args.intent, reviews: args.reviews.map((r) => resolve(root, r)), failures });
  for (const n of not_routed) process.stderr.write(`not routed: ${n.reason}\n`);
  if (!packets.length) { process.stdout.write("findings-to-packets: nothing to fix by packet\n"); return 0; }
  const dir = join(run.dir, "repairs");
  mkdirSync(dir, { recursive: true });
  const round = readdirSync(dir).filter((f) => /^round-\d+\.json$/.test(f)).length + 1;
  packets.forEach((p, i) => { p.id = `tp_debug_r${round}_${String(i + 1).padStart(3, "0")}`; });
  const file = join(dir, `round-${round}.json`);
  writeFileSync(file, JSON.stringify(packets, null, 2) + "\n");
  process.stdout.write(`findings-to-packets: ${packets.length} fix packet(s) → ${file}${not_routed.length ? ` · ${not_routed.length} not routed` : ""}\n`);
  return 0;
}

const isDirectRun = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`findings-to-packets: ${e?.message ?? e}\n`); process.exitCode = 2; });
}
