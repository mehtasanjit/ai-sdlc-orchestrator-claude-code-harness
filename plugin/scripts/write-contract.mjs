#!/usr/bin/env node
/**
 * write-contract — writes a brownfield run's write contract by code, and records what it froze in the run's own log.
 *
 * Why: the contract (`.sdlc/local/write-contract.json`) decides what a run may write. The model used to Write it at
 * Gate 0, and a live run could rewrite it through the shell. Now this script writes it at Gate 0 (`--freeze`) and
 * records the SHA-256 of the exact bytes in the run's own log (a `contract.freeze` line, lib/contract-lock.mjs); the
 * hook and the server's writer refuse every write while a live run's contract no longer matches that record.
 * `--close` switches the contract off at close-out, only once the run has ended by its own log: a run that could
 * switch its own contract off mid-run would not be bound by it.
 *
 * `--abandon` ends, on purpose, a run that will never end by itself: Gate 0 freezes the contract before the
 * orchestrator logs run.start, so a run that stops in between (its start check halts, its chat is closed, it crashes)
 * leaves a live record nothing in the run will ever end, and the project stays held: every write outside its
 * allowlist, the next run's Gate 0 and --close are refused. It is the person's decision (the brownfield guide asks
 * first; zero-touch never runs it without the person's approval), and the only documented way to free such a project.
 *
 * Usage:
 *   node write-contract.mjs --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>']
 *                           [--strict-write=off] [--project-root <dir>]
 *   node write-contract.mjs --close --run-id <id> [--project-root <dir>]
 *   node write-contract.mjs --abandon --run-id <id> [--reason "<text>"] [--project-root <dir>]
 *
 * The project root is the root of its git project (a folder holding `.git`): the write-contract hook reads only the
 * contract there, so a contract written anywhere else would bind nothing. A run started anywhere else (a subfolder of
 * a git project, or a folder in none) is refused by every mode, its freeze included, with nothing written, and told
 * where a run starts.
 * --freeze freezes a run once: never under a run id whose log already holds a freeze record or an end record (a run
 * that froze, or ended, never freezes again; a wider scope is a new run with its own Gate 0), and never while another
 * run's contract binds the project.
 * --close switches off the contract of the run it names, only, and only after that run's end is in its log.
 * --abandon logs `run.end outcome=aborted reason=<text>` in the run's own log (unless the run has already ended), then
 * switches its contract off.
 * Exit 0 = written, 2 = refused or usage.
 */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_MAX_BYTES, CONTRACT_REL_PATH, FREEZE_EVENT, fingerprint, frozenBy, isEndRecord, runEvents, runFreeze } from "./lib/contract-lock.mjs";
import { formatLine } from "./lib/log.mjs";
import { gitRoot } from "./lib/git.mjs";
import { runEnded } from "./lib/run-log.mjs";
import { appendRegularFile, readRegularFile, RUN_ID } from "./ambient/lib/workflow-log.mjs";

function parseArgs(argv) {
  const out = { mode: null, runId: null, allowlist: null, offLimits: [], strict: true, reason: null, projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--freeze") out.mode = "freeze";
    else if (a === "--close") out.mode = "close";
    else if (a === "--abandon") out.mode = "abandon";
    else if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--allowlist")) out.allowlist = val();
    else if (a.startsWith("--off-limits")) out.offLimits = val();
    else if (a === "--strict-write=off") out.strict = false;
    else if (a.startsWith("--reason")) out.reason = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
  }
  return out;
}

const fail = (msg) => { process.stderr.write(`write-contract: ${msg}\n`); return 2; };
/** What every refusal of a scope change says: the scope is the person's, never the run's, to change. */
const PERSON_DECIDES = "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

/** A JSON array of path globs, or null. */
function globs(text) {
  try {
    const v = typeof text === "string" ? JSON.parse(text) : text;
    return Array.isArray(v) && v.every((g) => typeof g === "string" && g.length > 0) ? v : null;
  } catch {
    return null;
  }
}

/** Writes a file whole or not at all: a reader never sees half a contract. */
function writeWhole(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/** Writes the contract; returns the SHA-256 of the exact bytes written. */
function writeContract(root, contract) {
  const bytes = Buffer.from(JSON.stringify(contract, null, 2) + "\n", "utf8");
  writeWhole(join(root, CONTRACT_REL_PATH), bytes);
  return fingerprint(bytes);
}

/** The project's contract, read as a regular file only (a pipe in its place never stalls the script), or null. */
function readContract(root) {
  try { return JSON.parse(readRegularFile(join(root, CONTRACT_REL_PATH), { maxBytes: CONTRACT_MAX_BYTES })?.toString("utf8") ?? "null"); } catch { return null; }
}

/** Appends one line to the run's own log, as the plugin's logger formats it; false when the log is no regular file. */
function logLine(root, runId, event, fields) {
  const runDir = join(root, ".sdlc", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  return appendRegularFile(join(runDir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const root = resolve(a.projectRoot);
  if (!a.mode) return fail("usage: --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>'] [--strict-write=off], --close --run-id <id>, or --abandon --run-id <id> [--reason \"<text>\"]");
  if (typeof a.runId !== "string" || !RUN_ID.test(a.runId)) return fail("--run-id must be the run's id");
  // The hook reads only the contract at the root of the git project that holds a write, so the contract lives there.
  // A run started in a subfolder (a package of a monorepo) anchors its contract, its log and the server's writer at
  // that subfolder, where the hook would never read the contract: refused before anything is written, naming the
  // folder a run starts from. Whether a subfolder run is anchored at its git root instead is not this script's call.
  if (!existsSync(join(root, ".git"))) {
    const top = gitRoot(root);
    const where = top
      ? `${root} is not the root of a git project: it is a folder inside the git project at ${top}`
      : `${root} is not the root of a git project: it is not in a git project at all`;
    return fail(`${where}. A brownfield run's contract lives at its git project's root, the only place the write-contract hook reads it. Nothing is written. Stop and tell the person: a brownfield run starts from the project's root folder${top ? ` (${top})` : ", in a git project"}.`);
  }
  const current = readContract(root);
  // The run that holds the project's contract: the live freeze record, else (a contract frozen before the record
  // existed) the contract itself while its run is live.
  const frozen = frozenBy(root);
  const holder = frozen?.run_id ?? (current?.active === true && typeof current.run_id === "string" && !runEnded(root, current.run_id) ? current.run_id : null);
  if (a.mode === "freeze") {
    const allowlist = globs(a.allowlist);
    const offLimits = globs(a.offLimits);
    if (!allowlist) return fail("--allowlist must be a JSON array of path globs");
    if (!offLimits) return fail("--off-limits must be a JSON array of path globs");
    // One freeze per run id: a run that froze, or ended, never freezes again under the same id.
    const own = runFreeze(root, a.runId);
    if (own.records > 0) return fail(`run ${a.runId} has already frozen its contract: a run freezes once, at its Gate 0, and its scope does not change after that. ${PERSON_DECIDES}`);
    // Every event of the run's log (runFreeze parses only a log that holds a record): any end record refuses.
    if (runEvents(root, a.runId).some(isEndRecord)) return fail(`run ${a.runId} has ended by its own log, and a run that ended never freezes again. ${PERSON_DECIDES}`);
    if (holder) return fail(`run ${holder} is live and holds this project's contract (by its own log). Stop and tell the person: ending that run is the person's decision.`);
    const contractPath = join(root, CONTRACT_REL_PATH);
    const before = existsSync(contractPath) ? readRegularFile(contractPath) : null;
    const sha256 = writeContract(root, { schema_version: 1, active: true, mode: "brownfield", run_id: a.runId, strict: a.strict, allowlist, off_limits: offLimits });
    // The record, after the contract: what the hook and the server compare the contract with until the run ends. A
    // record that cannot be written (the log is no regular file) puts the contract back exactly as it was: a contract
    // left binding without its record would be one no record protects.
    if (!logLine(root, a.runId, FREEZE_EVENT, { sha256 })) {
      if (before) writeWhole(contractPath, before);
      else rmSync(contractPath, { force: true });
      return fail(`the run's log (.sdlc/runs/${a.runId}/orchestrator.log) is not a regular file: nothing is frozen`);
    }
    process.stdout.write(`write-contract: frozen for run ${a.runId} (${allowlist.length} allowlist, ${offLimits.length} off-limits pattern(s))\n`);
    return 0;
  }
  if (a.mode === "abandon") {
    const own = runFreeze(root, a.runId);
    const named = current?.run_id === a.runId;
    if (runEvents(root, a.runId).length === 0 && !named) return fail(`no run ${a.runId} in ${root}: its log holds no record and the contract does not name it`);
    // Ended already: by its freeze record's rule when it froze one (an end after the record), else by its own log.
    const ended = own.records > 0 ? !own.live : runEnded(root, a.runId);
    const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : "abandoned by the person";
    if (!ended && !logLine(root, a.runId, "run.end", { outcome: "aborted", reason })) {
      return fail(`the run's log (.sdlc/runs/${a.runId}/orchestrator.log) is not a regular file: the run's end is not recorded`);
    }
    // After the end record, so the switch-off is never a change to a live run's frozen contract.
    const unlocked = named && current.active === true;
    if (unlocked) writeContract(root, { ...current, active: false });
    process.stdout.write(`write-contract: run ${a.runId} ${ended ? "had already ended" : `ended (aborted: ${reason})`}${unlocked ? "; its contract is switched off" : ""}\n`);
    return 0;
  }
  // close
  if (!current) return fail(`no write contract in ${root}`);
  if (current.run_id !== a.runId) return fail(`the contract belongs to run ${current.run_id}, not ${a.runId}`);
  if (holder === a.runId || !runEnded(root, a.runId)) {
    return fail(`run ${a.runId} is live by its own log: its contract is switched off at close-out, after Gate 4 is accepted, never during the run`);
  }
  writeContract(root, { ...current, active: false });
  process.stdout.write(`write-contract: switched off for run ${a.runId}\n`);
  return 0;
}

const isDirectRun = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirectRun) process.exitCode = main();
