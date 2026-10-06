#!/usr/bin/env node
/**
 * findings-to-packets — a brownfield run's review findings and check failures, turned into fix packets by
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
 * What a fix may target and show, and how it is judged:
 *   - A fix packet carries `apply.baseline: false`: the server takes no new baseline, since the file it fixes fails
 *     its checks now — that is why it is being fixed — and a baseline would set them aside. The baseline was taken once,
 *     when the unit itself was applied: the checks set aside then (its receipt in the run's batches/) stay out.
 *   - A bugfix's reproducing test judges the fix, so no fix targets it: a problem in it goes back to the architect.
 *   - A file a tooling step writes (a lockfile: the tooling unit's path, or a file the run's provenance records under the
 *     step's packet id) is the step's to write again, never typed, unless a typed unit owns it.
 *   - Paths are compared as files, not as text: two spellings of one file (other letters on a case-insensitive disk, a
 *     link) are one file, matched to the spec's unit and merged into one packet under the unit's own path.
 *   - The writer's rule holds for the target and the read rule for every file shown beside it (lib/change-spec.mjs
 *     writeRefusal, readRefusal): nothing off-limits is typed or sent to a model.
 *   - A planned file that never landed is created, and a planned file shown beside a failure is shown as missing, as
 *     greenfield's repair round does (executor/run.ts repairJob).
 *
 * Usage: node findings-to-packets.mjs --run-id <id> --intent <job> [--project-root <dir>]
 *          [--review <review.json>]... [--failures <failures.json>]
 *   review.json: the senior reviewer's file, {findings: [{severity, file, line?, issue, fix}]}.
 *   failures.json: [{path, problem, context_paths?, new_file?}] — a test or check failure: the file to change, the
 *   failure verbatim, files to show beside it, and new_file when the fix creates the file.
 *
 * Writes <project>/.sdlc/runs/<id>/repairs/round-<n>.json and prints its path and what was not routed.
 * Exit 0 = written (or nothing to route, said so). 2 = usage, or an --intent that is not the job Gate 0 recorded.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";
import { BRIEFS_DIR, BUDGET, JOBS, MAX_RETRIES, activeContract, editAnswerLines, liveContract, readRefusal, runFolder, runJob, wholeFileInputs, writeRefusal } from "./lib/change-spec.mjs";


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
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The outcome statuses the server reaches only after it took a packet's baseline (apply.ts runApplyLoop: every refusal
 * before a typist call comes before it), and already_applied, which carries the set-aside of the call that applied
 * the packet (server.ts, from its applied record).
 */
const BASELINE_TAKEN = new Set(["applied", "already_applied", "verify_failed", "escalate", "no_content", "dispatch_failed"]);

/**
 * The checks set aside when a unit's packet was applied: the latest receipt of it in the run's batches/ (the server
 * writes one file per execute_batch call, named by its time, with every packet's outcome whole) in which the server
 * took its baseline (BASELINE_TAKEN). A blocked, stopped or errored item has no outcome and a refusal comes before the
 * baseline, so none of them says what the baseline found and none overrides an earlier receipt. A unit that did not
 * apply (verify_failed, escalate) is the fix round's usual target, and its set-aside is still the file before the
 * change. Returns the ids and, for a check without an id, the commands; empty when there is no such receipt, so every
 * check judges.
 */
function setAsideAtApply(runDir, packetId) {
  const out = { ids: new Set(), runs: new Set() };
  const dir = join(runDir, "batches");
  if (!packetId || !existsSync(dir)) return out;
  let latest = null;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const items = readJson(join(dir, f))?.items;
    const item = Array.isArray(items) ? items.find((i) => i?.id === packetId && BASELINE_TAKEN.has(i.outcome?.status)) : undefined;
    if (item) latest = item;
  }
  for (const c of Array.isArray(latest?.outcome?.set_aside) ? latest.outcome.set_aside : []) {
    if (typeof c?.id === "string") out.ids.add(c.id);
    else if (typeof c?.run === "string") out.runs.add(c.run);
  }
  return out;
}

/**
 * One file however a path spells it: its identity on disk (device and inode), so other letters on a case-insensitive
 * disk (macOS's) and a link reach the same key; for a file not on disk yet, its text up to case, as the server's
 * writer compares a reproducing test's path (apply.ts reproducingTestPaths).
 */
function fileKey(root, p) {
  try {
    const st = statSync(resolve(root, p));
    return `file:${st.dev}:${st.ino}`;
  } catch {
    return `path:${String(p).toLowerCase()}`;
  }
}

/** A file's path under the project root as the disk spells it (its real name, links resolved), or the path given. */
function diskSpelling(root, p) {
  try {
    const rel = relative(realpathSync.native(root), realpathSync.native(resolve(root, p))).split(sep).join("/");
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  } catch {
    return p;
  }
}

/**
 * The files the run's provenance records as last written by one of these tooling packets (write-provenance.mjs
 * --packet-id tooling_<unit>, around the step: brownfield-runs.md, Phase 5), as [path, packet id] pairs.
 */
function toolingWrites(runDir, toolingIds) {
  const files = readJson(join(runDir, "provenance.json"))?.files_touched;
  return Array.isArray(files) ? files.filter((f) => typeof f?.path === "string" && toolingIds.has(f.packet_id)).map((f) => [f.path, f.packet_id]) : [];
}

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
  // Every lookup is by file (fileKey), so a finding that spells a file in other letters, or through a link, finds the
  // spec's unit for it: its checks, and the integrity rule below.
  const typed = specPackets.filter((p) => p.apply && typeof p.artifact_path === "string");
  const unitByKey = new Map(typed.map((p) => [fileKey(root, p.artifact_path), p]));
  const tooling = specPackets.filter((p) => !p.apply && typeof p.artifact_path === "string");
  const toolingByKey = new Map([
    ...toolingWrites(run.dir, new Set(tooling.map((p) => p.id))).map(([path, id]) => [fileKey(root, path), id]),
    ...tooling.map((p) => [fileKey(root, p.artifact_path), p.id]),
  ]);
  // A bugfix's reproducing test: the unit whose checks include one typed `expect: "fail"`.
  const redByKey = new Map(typed.filter((p) => p.apply.checks?.some((c) => c?.expect === "fail")).map((p) => [fileKey(root, p.artifact_path), p.artifact_path]));
  const unitPaths = new Set(typed.map((p) => p.artifact_path));
  const contract = activeContract(root, runId);
  const offLimits = liveContract(root)?.off_limits ?? [];
  const refuse = (file, reason) => { if (!notRouted.some((n) => n.file === file && n.reason === reason)) notRouted.push({ file, reason }); };

  // Placed and merged per file, in the order the problems came; each file shown beside a problem is held to the read
  // rule as it comes.
  const byFile = new Map();
  for (const it of items) {
    const placed = it.new_file ? executorRun.placeNewFile(it.path, root) : executorRun.placeFixPath(it.path, root, unitPaths);
    if (placed.reason) { refuse(it.path, `${it.path} ${placed.reason}`); continue; }
    const key = fileKey(root, placed.path);
    const red = redByKey.get(key);
    if (red) { refuse(red, `${red}: the reproducing test judges the fix; a problem in it goes back to the architect`); continue; }
    const own = unitByKey.get(key);
    // A spec file goes under its unit's own spelling, so the server's records of the run (provenance, applied
    // packets, its own reproducing-test rule) see one file. Any other file goes under the spelling it already has in
    // this round, else the disk's own (realpathSync.native: on a case-insensitive disk the letters the file was made
    // with), so the writer's rule below judges it as the server will write it, and two spellings merge into one packet.
    const path = own?.artifact_path ?? byFile.get(key)?.path ?? diskSpelling(root, placed.path);
    if (toolingByKey.has(key) && !own) { refuse(path, `${path} is written by ${toolingByKey.get(key)}, a shell step no model types: run that step again`); continue; }
    const unwritable = writeRefusal(root, path, contract, offLimits);
    if (unwritable) { refuse(path, `${path} is ${unwritable}; the run may not write it`); continue; }
    const cur = byFile.get(key) ?? { path, own, problems: [], context: [], contextKeys: new Set([key]) };
    cur.problems.push(...it.problems);
    for (const c of it.context_paths ?? []) {
      const at = executorRun.placeFixPath(c, root, unitPaths);
      if (!at.path) continue;
      const ck = fileKey(root, at.path);
      if (cur.contextKeys.has(ck)) continue;
      const shown = unitByKey.get(ck)?.artifact_path ?? at.path;
      const unreadable = readRefusal(root, runId, shown, offLimits);
      if (unreadable) { refuse(shown, `${unreadable}: its text is never sent to a model`); continue; }
      cur.contextKeys.add(ck);
      cur.context.push(shown);
    }
    byFile.set(key, cur);
  }

  const packets = [];
  const shared = `${run.rel}/${BRIEFS_DIR}/shared.md`;
  for (const f of byFile.values()) {
    const own = f.own;
    const inputs = [];
    if (existsSync(resolve(root, shared))) inputs.push({ path: shared, reason: "shared brief: conventions, decisions, the files of this change (stable run record)" });
    if (own) inputs.push(...own.inputs.filter((i) => i.path === `${run.rel}/${BRIEFS_DIR}/${own.unit}.md`));
    // A planned file that is not there yet is shown as missing, as greenfield's repair round shows it, so the typist
    // knows it is not there (the server reads only a file that exists).
    for (const c of f.context) {
      inputs.push(isFile(resolve(root, c)) ? { path: c, reason: "named beside the failure" } : { path: c, reason: "named beside the failure: the file does not exist yet", content: "(missing)" });
    }
    const problems = f.problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
    // A file that is not there — asked for as new, or a planned unit's file its packet never wrote — is created whole.
    const create = !isFile(resolve(root, f.path));
    let instruction;
    if (create) {
      instruction = `Create \`${f.path}\` so that these problems are solved, following the conventions in the shared brief:\n${problems}\nReturn JSON {path, content} with the complete file.`;
    } else {
      inputs.push(...wholeFileInputs(root, f.path, "current text"));
      instruction = [`Fix \`${f.path}\` for these problems, changing only what they need, following the conventions in the shared brief:`, problems, "", ...editAnswerLines(f.path)].join("\n");
    }
    // The file's own typed checks from the spec, less those set aside when the unit was applied; a file outside the
    // spec has none, and the project checks run at the end. A check typed `expect: "fail"` judges this packet as one
    // that must pass (no fix targets a reproducing test, so a unit here has none).
    const aside = setAsideAtApply(run.dir, own?.id);
    const checks = (own?.apply?.checks ?? []).filter((c) => !(c.id ? aside.ids.has(c.id) : aside.runs.has(c.run))).map(({ expect, ...c }) => c);
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
      // No new baseline: the checks judge the fix (the server's normalizeApply keeps `baseline: false`).
      apply: { write: true, mode: create ? "content" : "edits", checks, baseline: false, ...(own?.apply?.verify_timeout_sec ? { verify_timeout_sec: own.apply.verify_timeout_sec } : {}), max_retries: MAX_RETRIES },
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
  // The job is required: the packets carry it, and a packet without one is not typed by greenfield's typists.
  if (!args.runId || !JOBS.includes(args.intent) || (!args.reviews.length && !args.failures)) {
    process.stderr.write(`usage: findings-to-packets.mjs --run-id <id> --intent <${JOBS.join("|")}> [--project-root <dir>] [--review <review.json>]... [--failures <failures.json>]\n`);
    return 2;
  }
  const root = resolve(args.projectRoot);
  const run = runFolder(root, args.runId);
  if (run.error) { process.stderr.write(`findings-to-packets: ${run.error}\n`); return 2; }
  // The packets carry the job: the one Gate 0 recorded, when there is that record.
  const { error: jobError } = runJob(run.dir, args.intent);
  if (jobError) { process.stderr.write(`findings-to-packets: ${jobError}\n`); return 2; }
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
