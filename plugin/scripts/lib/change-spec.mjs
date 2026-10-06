/**
 * The typed change spec of a brownfield run, whatever the job: its shape, the check each section gets when it arrives,
 * the rules a job adds when the spec is finalized (jobRules), and what code makes from the accepted sections —
 * change_plan.md for Gate 2 and the reviewers, the typists' briefs, and packets.json.
 *
 * Why: the architect wrote a free-text change_plan.md and plan-to-packets read it with regexes, one tolerance for
 * each wording an architect had once used (action synonyms, line-number spellings, wrapped bullets, a list of
 * command runners, a path classifier). Greenfield's architect hands over a typed spec in sections, each checked
 * when it arrives, with the exact shape shown up front (spec/schema.ts, spec/store.ts). A change gets the same:
 * greenfield's validator, shape printer, section reader and requirement ids, loaded from the server's bundle
 * (lib/server-lib.mjs), and its rules — every text field one line (so no code fits), exact enums, references that
 * point to earlier units. What a change adds is checked against the files as they are: an edit names its sites by
 * line range and the text of their first and last lines, and a site that does not match the file is refused on
 * arrival with the file's actual text, so one Edit fixes it.
 *
 * Files, in the run folder (`.sdlc/runs/<run-id>/`): `change.sections/*.json` (what the architect writes),
 * `change.parts/` (accepted sections, with the hash of every file they point into), `change.checks.json` (the file
 * checks that passed on their files before the change), `change-spec.json`, `change_plan.md`, `briefs/`,
 * `packets.json`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bashDenyRules, deniedBy } from "../ambient/lib/bash-rules.mjs";
import { serverCommandUnchecked } from "../ambient/lib/own-steps.mjs";
import { matchGlob, offLimitsMatch } from "./off-limits.mjs";
import { runEnded } from "./run-log.mjs";
import { loadServerLib } from "./server-lib.mjs";


/** The folders of a run's change spec, under its run folder. */
export const SECTIONS_DIR = "change.sections";
export const PARTS_DIR = "change.parts";
export const BRIEFS_DIR = "briefs";
/** The file checks that passed on their files before the change, so a section checked again does not run them again. */
export const CHECKS_FILE = "change.checks.json";

/** The brownfield jobs, as the plugin's job list names them (config/intents.json). */
export const JOBS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "intents.json"), "utf8")).intents.map((i) => i.id);
/**
 * The jobs whose spec a person always approves at Gate 2 before anything is typed (brownfield-runs.md, "The jobs"; a
 * test keeps the two equal). A bugfix opens it only when its spec is design-affecting (gate2). Only these jobs may hold
 * a tooling unit: its shell step runs through Bash, which the write contract does not govern, so a job whose Gate 2 is
 * not sure to open would run it with nobody having seen it.
 */
export const GATE2_JOBS = ["feature-extend", "feature-new", "refactor", "deps"];

/**
 * The run's job as Gate 0 recorded it: the first line of the run's intent_brief.md, `# Intent Brief — <job> — <title>`
 * (brownfield-guide's heading contract). Null when there is no such record.
 */
export function recordedJob(runDir) {
  try {
    const first = readFileSync(join(runDir, "intent_brief.md"), "utf8").split("\n", 1)[0].replace(/\r$/, "");
    const m = /^# Intent Brief — (\S+) — /.exec(first);
    return m && JOBS.includes(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The job a step checks the spec under: Gate 0's record when there is one, and `--intent` must then name the same
 * job; with no record, `--intent`. Why: the job's rules are code's, and the flag is typed by the run itself, so a
 * mistyped job would otherwise switch the rules off (a bugfix finalized as feature-extend has no reproducing test).
 * Returns { job } (null when neither names one) or { error }.
 */
export function runJob(runDir, given) {
  if (given !== undefined && given !== null && !JOBS.includes(given)) return { error: `--intent must be one of ${JOBS.join(", ")} (the run's job, from Gate 0)` };
  const recorded = recordedJob(runDir);
  if (recorded && given && recorded !== given) return { error: `--intent ${given} is not this run's job: Gate 0 recorded ${recorded} (intent_brief.md)` };
  return { job: recorded ?? given ?? null };
}

/** One line of text: not empty, no line break (greenfield's `line`). */
const line = { type: "string", minLength: 1, pattern: "^[^\\n\\r]+$" };
/** One line that may be empty: the text of a blank line. */
const lineOrEmpty = { type: "string", pattern: "^[^\\n\\r]*$" };
const UNIT_ID = { type: "string", pattern: "^U[0-9]{2,4}$" };
const CHECK_ID = { type: "string", pattern: "^[a-z][a-z0-9-]*$" };
/** A file check's command: one line that names the file as `{path}`. */
const WITH_PATH = { type: "string", pattern: "^[^\\n\\r]*\\{path\\}[^\\n\\r]*$" };
const RANGE = { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 1 }, description: "[from, to], 1-based, inclusive." };

/** The site positions an edit can take: where the typist's exact edits go. */
export const SITE_KINDS = ["replace", "delete", "insert_before", "insert_after"];

/**
 * The schemas, built on greenfield's: a unit's exports, import line, covers and tests are greenfield's own
 * sub-schemas (spec/schema.ts SPEC_UNIT_SCHEMA), so the two flows ask for them the same way.
 */
export async function changeSchemas() {
  const { specSchema } = await loadServerLib();
  const g = specSchema.SPEC_UNIT_SCHEMA.properties;
  const header = {
    type: "object",
    additionalProperties: false,
    required: ["conventions", "file_checks", "project_checks"],
    properties: {
      conventions: { type: "array", minItems: 1, items: line, description: "House style, one rule per line: formatter and its limits, import order, test runner and assertion style, anything a typist cannot see in a style file." },
      decisions: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["topic", "choice", "reason"], properties: { topic: line, choice: line, rejected: { type: "array", items: line }, reason: line } },
      },
      file_checks: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["id", "run", "timeout_s"], properties: { id: CHECK_ID, run: WITH_PATH, fix: WITH_PATH, timeout_s: { type: "integer", minimum: 1, description: "How long this check may run on one file, in seconds: your estimate, as greenfield's commands state theirs." } } },
        description: "Checks of one file, the repo's own commands with the file as {path}; fix is the command's write form (a formatter's --write), run before the check.",
      },
      project_checks: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["id", "run"], properties: { id: CHECK_ID, run: line } },
        description: "Whole-project checks (a typecheck, the test suite), run once after the last file.",
      },
    },
  };
  const unit = {
    type: "object",
    additionalProperties: false,
    required: ["id", "path", "action", "phase", "behaviour", "depends_on"],
    properties: {
      id: UNIT_ID,
      // A tooling unit's path follows one convention, held by checkUnits and jobRules: the file its step writes.
      path: { ...line, description: "Relative to the project root, as git lists it. A tooling unit's: the file its step writes (an install: its lockfile), which no model types." },
      action: { type: "string", enum: ["create", "edit", "tooling"] },
      phase: { type: "string", enum: [...specSchema.SPEC_PHASES] },
      behaviour: { ...line, description: "One line: what the file does after the change." },
      rules: { type: "array", items: line, description: "Behaviour rules the code must satisfy, in evaluation order: rules, not code." },
      exports: g.exports,
      import_line: g.import_line,
      sites: {
        type: "array",
        minItems: 1,
        description: "edit only: where the file changes. from/to are lines of the file as it is now; first_line (and last_line when to > from) are those lines' text, without the line ending and leading or trailing spaces.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "at", "from", "to", "first_line", "rule"],
          properties: {
            id: { type: "string", pattern: "^S[0-9]+$" },
            at: { type: "string", enum: SITE_KINDS },
            from: { type: "integer", minimum: 1 },
            to: { type: "integer", minimum: 1 },
            first_line: lineOrEmpty,
            last_line: lineOrEmpty,
            rule: line,
          },
        },
      },
      style_from: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        description: "The file whose shape this one copies: an existing path (with lines), or an earlier unit it depends on; or neither and the reason there is none.",
        properties: { unit: UNIT_ID, path: line, lines: RANGE, reason: line },
      },
      uses: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["path", "reason"], properties: { path: line, lines: RANGE, reason: line } },
        description: "Existing files (or lines of them) the typist must see, such as a module this file imports.",
      },
      run: { ...line, description: "tooling only: the shell step." },
      cwd: { ...line, description: "tooling only: where it runs, relative to the project root." },
      depends_on: { type: "array", items: UNIT_ID },
      covers: g.covers,
      tests: g.tests,
      checks: { type: "array", items: CHECK_ID, description: "Ids from the header's file_checks that judge this file." },
      red_checks: { type: "array", minItems: 1, items: CHECK_ID, description: "bugfix, the test that reproduces the bug: ids from the header's file_checks that must fail on the code as it is now, and pass once the fix is in." },
    },
  };
  return { header, unit, specSchema };
}

/** The shape of both section files, one line each, rendered from the schemas (greenfield's shapeOf). */
export async function changeShape() {
  const { header, unit, specSchema } = await changeSchemas();
  return [
    `header.json: ${specSchema.shapeOf(header)}`,
    `units-NNN.json: ${specSchema.shapeOf(unit)}[]`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Files as they are
// ---------------------------------------------------------------------------

/** A line's text for a site check: without its terminator and without leading or trailing spaces. */
export const lineText = (s) => s.replace(/\r$/, "").trim();

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A repo file's lines (raw, without "\r"), or null when it is not a regular file inside the project. */
function fileLines(projectRoot, p) {
  const abs = resolve(projectRoot, p);
  try {
    if (!statSync(abs).isFile()) return null;
    if (!insideReal(projectRoot, abs)) return null;
    return readFileSync(abs, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  } catch {
    return null;
  }
}

function insideReal(root, abs) {
  try {
    const rel = relative(realpathSync(root), realpathSync(abs));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** The write contract's glob dialect, shared with every script that reads the contract (lib/off-limits.mjs). */
export { matchGlob };

/** The run's active write contract, or null: a unit outside its allowlist would only be refused at write time. */
export function activeContract(projectRoot, runId) {
  try {
    const c = JSON.parse(readFileSync(resolve(projectRoot, ".sdlc/local/write-contract.json"), "utf8"));
    if (!c.active || c.run_id !== runId || !Array.isArray(c.allowlist)) return null;
    return c;
  } catch {
    return null;
  }
}

/** The project's live write contract, whatever run froze it: active, and its run not ended by its own log. */
export function liveContract(projectRoot) {
  try {
    const c = JSON.parse(readFileSync(resolve(projectRoot, ".sdlc/local/write-contract.json"), "utf8"));
    return c?.active === true && !runEnded(projectRoot, c.run_id) ? c : null;
  } catch {
    return null;
  }
}

/** A path relative to the project's real folder, through every link, or null when it does not resolve inside it. */
function realRel(projectRoot, p) {
  try {
    const rel = relative(realpathSync(projectRoot), realpathSync(resolve(projectRoot, p))).split(sep).join("/");
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
  } catch {
    return null;
  }
}

const offLimitsLabel = (hit) => `${hit.source === "hardcoded" ? "always" : "the write contract"}: ${hit.pattern}`;

/** Off-limits for this path, by its own name and, when it is a link, by the file it reaches. */
function offLimitsOf(projectRoot, p, offLimits) {
  const hit = offLimitsMatch(p, offLimits);
  if (hit) return offLimitsLabel(hit);
  const real = realRel(projectRoot, p);
  const viaLink = real && real !== p ? offLimitsMatch(real, offLimits) : null;
  return viaLink ? `${offLimitsLabel(viaLink)}, through the link to ${real}` : null;
}

/**
 * Why a project file may not be read into a model's prompt, or null: it matches the always-off-limits list (at any
 * depth) or the live contract's off_limits — the one read rule for everything a model is sent (the server's
 * hydrateInputs applies the same). The run's own folder, `.sdlc/runs/<run-id>/`, is exempt: its briefs live there.
 */
export function readRefusal(projectRoot, runId, p, offLimits = liveContract(projectRoot)?.off_limits ?? []) {
  const own = typeof runId === "string" ? `.sdlc/runs/${runId}/` : null;
  if (own && p.startsWith(own) && (realRel(projectRoot, p) ?? p).startsWith(own)) return null;
  const why = offLimitsOf(projectRoot, p, offLimits);
  return why ? `${p} is off-limits (${why})` : null;
}

/**
 * Why the run may not write a project file, or null, in the order the server's writer refuses (apply.ts
 * checkWriteContract): the always-off-limits list at any depth, the live contract's off_limits, then the run's
 * allowlist. A unit or a fix on such a file would be typed and paid for, its text sent out, and its write refused.
 */
export function writeRefusal(projectRoot, p, contract, offLimits = liveContract(projectRoot)?.off_limits ?? []) {
  const why = offLimitsOf(projectRoot, p, offLimits);
  if (why) return `off-limits (${why})`;
  if (contract && !contract.allowlist.some((g) => matchGlob(p, g))) return `outside the write contract's allowlist (${contract.allowlist.join(", ")})`;
  return null;
}

// ---------------------------------------------------------------------------
// One section, on arrival
// ---------------------------------------------------------------------------

/** The accepted parts so far, in file-name order: [{ name, section, value, hashes }]. */
export function acceptedParts(runDir) {
  const dir = join(runDir, PARTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/**
 * Checks one units section against the accepted header, the units accepted in earlier sections, and the files.
 * Returns { errors: string[], hashes: {path: sha256} }. Every error names the unit and the field, and for a site
 * whose text differs, the file's actual lines, so one Edit fixes it. What the run may write and read is held to the
 * server's own rules (writeRefusal, readRefusal, its bound on one input), so nothing is planned that dispatch would
 * refuse after paying for it. With `intent` (the run's job), the job's rules for these units are checked too
 * (unitJobErrors), while the architect still has the section open.
 */
export function checkUnits(units, ctx) {
  const { projectRoot, runId, header, earlier, intent } = ctx;
  const errors = [];
  const hashes = {};
  const contract = activeContract(projectRoot, runId);
  const offLimits = liveContract(projectRoot)?.off_limits ?? [];
  const known = new Map(earlier.map((u) => [u.id, u]));
  const takenPaths = new Map(earlier.filter((u) => u.action !== "tooling").map((u) => [u.path, u.id]));
  const toolingPaths = new Map(earlier.filter((u) => u.action === "tooling").map((u) => [u.path, u.id]));
  const checkById = new Map((header?.file_checks ?? []).map((c) => [c.id, c]));
  const checkIds = new Set(checkById.keys());
  const hashOf = (p) => {
    if (!(p in hashes)) hashes[p] = sha256(readFileSync(resolve(projectRoot, p)));
  };
  const lines = new Map();
  const linesOf = (p) => {
    if (!lines.has(p)) lines.set(p, fileLines(projectRoot, p));
    return lines.get(p);
  };
  // A slice the server reads whole (a style file, a file a unit uses): inside the file, and within the server's bound on
  // one input, measured as the server measures it (apply.ts hydrateInputs: the lines as they are, joined by "\n").
  const rangeOk = (where, p, r) => {
    const ls = linesOf(p);
    if (!ls) { errors.push(`${where}: ${p} is not a file in the project`); return; }
    hashOf(p);
    if (r && (r[0] > r[1] || r[1] > ls.length)) { errors.push(`${where}: lines ${r[0]}-${r[1]} are outside ${p} (${ls.length} lines)`); return; }
    const raw = readFileSync(resolve(projectRoot, p), "utf8");
    const bytes = Buffer.byteLength(r ? raw.split("\n").slice(r[0] - 1, r[1]).join("\n") : raw, "utf8");
    if (bytes > MAX_SLICE_BYTES) errors.push(`${where}: ${p}${r ? ` lines ${r[0]}-${r[1]}` : ""} is ${bytes} bytes, over the server's bound on one input (${MAX_SLICE_BYTES}): narrow it with lines`);
  };
  // The one read rule for what a model is sent: an off-limits file's text never reaches a prompt.
  const readable = (where, p) => {
    const why = readRefusal(projectRoot, runId, p, offLimits);
    if (why) errors.push(`${where}: ${why}: its text is never sent to a model`);
    return !why;
  };
  const safe = (where, p) => {
    const ok = typeof p === "string" && !p.startsWith("/") && !p.includes("\\") && p === p.split("/").filter((s) => s !== "" && s !== ".").join("/") && !p.split("/").includes("..");
    if (!ok) errors.push(`${where}: ${JSON.stringify(p)} must be a path relative to the project root, with no '..', './' or leading '/'`);
    else if (p === ".sdlc" || p.startsWith(".sdlc/")) errors.push(`${where}: ${p} is the run's own record, not part of the change`);
    return ok;
  };

  for (const u of units) {
    const at = `${u.id} (${u.path})`;
    if (known.has(u.id)) { errors.push(`${u.id}: the id is already used by an earlier unit`); continue; }
    if (!safe(`${u.id}.path`, u.path)) { known.set(u.id, u); continue; }
    const unwritable = writeRefusal(projectRoot, u.path, contract, offLimits);
    // Nothing inside a run widens its contract, so a reproducing test the run may not write cannot be planned at all:
    // the refusal says how the run stops instead of leaving the architect to try specs that can never finalize.
    const redOutside = isRed(u) ? "; the test that reproduces the bug must be a file the run may write: if no such file will do, return and say which test file the run needs and why — the allowlist is the person's decision" : "";
    if (unwritable) errors.push(`${at}: ${unwritable}; plan only files the run may write${redOutside}`);
    // A tooling step runs where its cwd says, so the folder is held to the path rule of every other path of the spec.
    if (u.cwd !== undefined) safe(`${u.id}.cwd`, u.cwd);
    if (u.action !== "tooling") {
      if (takenPaths.has(u.path)) errors.push(`${at}: ${takenPaths.get(u.path)} already changes this file; one unit per file`);
      takenPaths.set(u.path, u.id);
    }
    // One convention for a tooling unit's path, the one the architect is told: the file its step writes (an install's
    // lockfile), which no model types. A typed unit at that path would be typed and then written over by the step, a
    // fix round would type the step's file (findings-to-packets routes a tooling path's failures to the step only when no
    // typed unit owns it), and a deps run could not tell the manifest the install reads from the file it writes.
    const sharedWith = u.action === "tooling" ? takenPaths.get(u.path) : toolingPaths.get(u.path);
    if (sharedWith) {
      errors.push(`${at}: ${sharedWith} ${u.action === "tooling" ? "types this file" : "is a tooling unit at this path"}, and a tooling unit's path is the file its step writes (an install: its lockfile), which no model types: give the tooling unit the file its step writes, or leave this file to the step`);
    }
    if (u.action === "tooling" && !toolingPaths.has(u.path)) toolingPaths.set(u.path, u.id);
    const exists = linesOf(u.path) !== null;
    if (u.action === "create" && existsSync(resolve(projectRoot, u.path))) errors.push(`${at}: action "create", but the file exists; use "edit" with sites`);
    if (u.action === "edit" && !exists) errors.push(`${at}: action "edit", but there is no such file; use "create"`);
    if (u.action === "edit" && !u.sites) errors.push(`${at}: an edit names its sites`);
    if (u.action !== "edit" && u.sites) errors.push(`${at}: only an edit has sites`);
    if (u.action === "tooling" && !u.run) errors.push(`${at}: a tooling unit names its shell step in run`);
    if (u.action !== "tooling" && (u.run || u.cwd)) errors.push(`${at}: only a tooling unit has run and cwd`);
    if (u.action === "edit" && exists) {
      hashOf(u.path);
      const ls = linesOf(u.path);
      const seen = new Set();
      const spans = [];
      for (const s of u.sites ?? []) {
        const where = `${u.id}.sites.${s.id}`;
        if (seen.has(s.id)) errors.push(`${where}: the site id is used twice`);
        seen.add(s.id);
        if (s.from > s.to) { errors.push(`${where}: from ${s.from} is after to ${s.to}`); continue; }
        if (s.at.startsWith("insert_") && s.from !== s.to) { errors.push(`${where}: an insert sits next to one line, so from equals to`); continue; }
        if (s.to > ls.length) { errors.push(`${where}: line ${s.to} is past the end of ${u.path} (${ls.length} lines)`); continue; }
        const first = lineText(ls[s.from - 1]);
        if (first !== lineText(s.first_line)) errors.push(`${where}: line ${s.from} of ${u.path} reads ${JSON.stringify(first)}, not ${JSON.stringify(lineText(s.first_line))}`);
        if (s.to > s.from) {
          const last = lineText(ls[s.to - 1]);
          if (s.last_line === undefined) errors.push(`${where}: a site over several lines gives last_line, the text of line ${s.to}: ${JSON.stringify(last)}`);
          else if (last !== lineText(s.last_line)) errors.push(`${where}: line ${s.to} of ${u.path} reads ${JSON.stringify(last)}, not ${JSON.stringify(lineText(s.last_line))}`);
        }
        spans.push(s);
      }
      // Two sites clash when one removes a line the other touches: the typist would be asked for overlapping edits.
      const removes = (s) => s.at === "replace" || s.at === "delete";
      for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i], b = spans[j];
        const overlap = a.from <= b.to && b.from <= a.to;
        if (overlap && (removes(a) || removes(b))) errors.push(`${u.id}.sites: ${a.id} (lines ${a.from}-${a.to}) and ${b.id} (lines ${b.from}-${b.to}) overlap`);
      }
    }
    for (const d of u.depends_on) if (!known.has(d)) errors.push(`${u.id}.depends_on: ${d} is not an earlier unit (a unit depends only on units before it)`);
    if (u.style_from?.unit) {
      if (!known.has(u.style_from.unit)) errors.push(`${u.id}.style_from.unit: ${u.style_from.unit} is not an earlier unit`);
      else if (!u.depends_on.includes(u.style_from.unit)) errors.push(`${u.id}.style_from.unit: ${u.style_from.unit} is not in depends_on, so its file may not exist when this one is typed`);
      if (u.style_from.path) errors.push(`${u.id}.style_from: give a unit or a path, not both`);
    } else if (u.style_from?.path && safe(`${u.id}.style_from.path`, u.style_from.path) && readable(`${u.id}.style_from`, u.style_from.path)) {
      rangeOk(`${u.id}.style_from`, u.style_from.path, u.style_from.lines);
    }
    for (const [i, x] of (u.uses ?? []).entries()) {
      if (safe(`${u.id}.uses[${i}].path`, x.path) && readable(`${u.id}.uses[${i}]`, x.path)) rangeOk(`${u.id}.uses[${i}]`, x.path, x.lines);
    }
    for (const c of u.checks ?? []) if (!checkIds.has(c)) errors.push(`${u.id}.checks: ${c} is not a file check in the header`);
    if (u.red_checks) {
      // A reproducing test's checks: only a test file has them, and a check either must pass or must fail. Its red
      // verdict is the exit code alone, so a file that fails on a typo would pass as the reproduction: a check that must
      // pass proves the file is well-formed. A red check has no write form: a formatter must not rewrite the judge.
      if (u.phase !== "tests" || u.action === "tooling") errors.push(`${at}: only a tests unit has red_checks (the checks of the test that reproduces the bug)`);
      if (u.action !== "tooling" && !(u.checks ?? []).length) errors.push(`${at}: a reproducing test also names a check that must pass (checks): one that proves the file is well-formed (a syntax, type or load check), since a red check passes on any failure, a typo included`);
      for (const c of u.red_checks) {
        if (!checkIds.has(c)) errors.push(`${u.id}.red_checks: ${c} is not a file check in the header`);
        else if ((u.checks ?? []).includes(c)) errors.push(`${u.id}.red_checks: ${c} is also among its checks; a check either must pass or must fail`);
        else if (checkById.get(c).fix) errors.push(`${u.id}.red_checks: ${c} has a write form (fix); a formatter must not rewrite the test that judges the fix`);
      }
    } else if (u.phase === "tests" && u.action !== "tooling" && !(u.checks ?? []).length) {
      // A typed test file with no check is applied unjudged, and every mistake in it becomes the orchestrator's fix round.
      errors.push(`${at}: a test file names at least one file check that runs or loads it (checks): the server judges the typist's answer by it, and a test file can always be run on its own`);
    }
    // The server fills a check's `{path}` with the path as it is written (apply.ts), inside the single quotes quotePath
    // puts around it, so a ' in the path ends them and the shell refuses the command: a baseline that cannot run sets
    // the check aside, and a red check that cannot run reads as failing, so nothing would judge the file. A file whose
    // path holds one is planned without checks; a new file's checks run first on its style file, which is held to the
    // same rule. Then plan-lint, finalize and the server agree on every file that has checks.
    const checked = u.action !== "tooling" && ((u.checks ?? []).length > 0 || (u.red_checks ?? []).length > 0);
    if (checked && u.path.includes("'")) {
      errors.push(`${at}: the server puts a file's path into its checks as it is written, inside single quotes, so the ' in this path ends them and no check could run on it: give this file no checks${u.phase === "tests" ? "; a test file needs a check, so put the case in a test file whose path has no '" : ""}`);
    }
    if (checked && u.action === "create" && typeof u.style_from?.path === "string" && u.style_from.path.includes("'")) {
      errors.push(`${u.id}.style_from: a new file's checks run first on its style file, and the server puts that path into them as it is written, inside single quotes, so the ' in ${u.style_from.path} ends them: give a style file whose path has no '`);
    }
    known.set(u.id, u);
  }
  if (intent) errors.push(...unitJobErrors([...earlier, ...units], intent, new Set(units.map((u) => u.id))));
  return { errors, hashes };
}

/**
 * The vendor credentials the plugin's server and scripts read. A file check is the repo's own command and never needs
 * them, so it runs without them, as the server's checks do.
 */
const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"];
export function checkEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CREDENTIAL_VARS.includes(k) && !/_API_KEY$/.test(k)));
}

/**
 * One check command, as the server runs its checks: a shell in the project root, its output kept to the last
 * `tailChars`, and at its time limit the whole process group is stopped (spawned detached, killed by the negative pid),
 * so a runner's own children cannot hold it past the limit. Resolves { ok, exit, timedOut, output }.
 */
function runCheck(cmd, cwd, timeoutSec, tailChars) {
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; done(r); } };
    const keep = (d) => { output += d; if (output.length > tailChars * 2) output = output.slice(-tailChars); };
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true, detached: true, env: checkEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, exit: null, timedOut: false, output: String(e?.message ?? e) });
      return;
    }
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutSec * 1000);
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, exit: null, timedOut, output: String(e?.message ?? e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0 && !timedOut, exit: timedOut ? null : code, timedOut, output: output.trim().slice(-tailChars) });
    });
  });
}

/**
 * Each unit's file checks, run on the file as it is before the change — an edit's own file, a new file's style file —
 * which is the baseline the server takes at dispatch (apply.ts baselineChecks). Returns error lines naming the unit
 * and the check, with the check's output.
 *
 * Why here: at dispatch a check that fails on its baseline is set aside and judges nothing, so a command that is wrong
 * for every file (a runner started where it finds no tests) quietly leaves every typed file unjudged, and each mistake
 * then costs a fix round of the orchestrator. Run while the architect has the section open, the failure costs one
 * Edit: fix the command, or take the check off a file that already fails it.
 *
 * A reproducing test edited into an existing test file must also pass its red checks before the change: a file that
 * already fails cannot show that the new case reproduces the bug.
 *
 * A pair that passed is recorded in the run's change.checks.json, keyed by the command as run and the file's hash, and
 * is not run again while both are unchanged. Pairs run one at a time: test runners in one project share its files.
 *
 * The person's Bash deny rules hold here as they hold for the server. plan-lint runs these commands itself, where
 * Claude Code's own Bash check sees only the `node plan-lint.mjs` call (and zero-touch allows that call without a
 * prompt), so before anything runs, every command the server would run for the unit's packet — each check, its write
 * form, each red check, on the unit's file — is checked against the rules the server checks it against
 * (ambient/lib/bash-rules.mjs, the server's apply.ts port): a denied one refuses the unit, naming the rule, and none of
 * the unit's checks runs. While the person has deny rules, a check whose shell syntax the deny check cannot read through
 * (ambient/lib/own-steps.mjs serverCommandUnchecked: `$`, backquotes, brackets, redirects, quotes beyond the path's own,
 * or a path that is not a plain path) is not run either: its baseline is left to dispatch, where the call keeps Claude
 * Code's prompt.
 */
export async function baselineErrors(units, { projectRoot, runDir, header }) {
  const { executorRun } = await loadServerLib();
  const tail = executorRun.RECEIPT_MAX_BYTES;
  const checkById = new Map((header?.file_checks ?? []).map((c) => [c.id, c]));
  const cachePath = join(runDir, CHECKS_FILE);
  let passed = {};
  try { passed = JSON.parse(readFileSync(cachePath, "utf8")) ?? {}; } catch { passed = {}; }
  const ran = new Map();
  const errors = [];
  // Read once per call: whether the person has any Bash deny rule decides whether an unreadable command may run.
  const denyRules = bashDenyRules(projectRoot).length > 0;
  const runOn = async (check, target) => {
    let cmd;
    let template;
    try { template = quotePath(check.run); cmd = fillPath(template, target); } catch (e) { return { ok: false, exit: null, output: String(e?.message ?? e) }; }
    if (denyRules && serverCommandUnchecked({ template, path: target })) return { ok: true, leftToDispatch: true };
    const key = sha256(JSON.stringify([cmd, target, sha256(readFileSync(resolve(projectRoot, target)))]));
    if (passed[key]) return { ok: true };
    if (!ran.has(key)) ran.set(key, await runCheck(cmd, projectRoot, check.timeout_s, tail));
    const r = ran.get(key);
    if (r.ok) passed[key] = true;
    return r;
  };
  // Each command the server would run for the unit's packet that the person's settings deny, as error lines.
  const deniedErrors = (u) => {
    if (!denyRules) return [];
    const out = [];
    const forms = [...(u.checks ?? []).flatMap((id) => [[id, "run", "checks"], [id, "fix", "checks"]]), ...(u.red_checks ?? []).map((id) => [id, "run", "red_checks"])];
    // A new file's checks run first on its style file (its baseline, baselineErrors and the server's baseline_from),
    // so each check's run is judged with that path too: the command that would really run.
    const targets = (field, form) => [u.path, ...(u.action === "create" && field === "checks" && form === "run" && typeof u.style_from?.path === "string" ? [u.style_from.path] : [])];
    for (const [id, form, field] of forms) {
      const c = checkById.get(id);
      if (typeof c?.[form] !== "string") continue;
      let cmd, rule = null;
      for (const t of targets(field, form)) {
        let filled;
        try { filled = fillPath(quotePath(c[form]), t); } catch { continue; }
        rule = deniedBy(filled, projectRoot);
        if (rule) { cmd = filled; break; }
      }
      if (rule) {
        out.push(
          `${u.id}.${field}: ${id}${form === "fix" ? "'s write form" : ""} runs \`${cmd}\`, which the person's Claude settings deny (${rule}): plan-lint does not run it, ` +
          "and the server refuses a packet whose check, write form or red check they deny; a different check is the person's decision: return and say which command the plan needs and why",
        );
      }
    }
    return out;
  };
  const verdict = (r, check) => (r.timedOut ? `timed out after ${check.timeout_s}s` : r.exit === null ? "could not run" : `exit ${r.exit}`);
  const output = (r) => (r.output ? `\n    ${r.output.split("\n").join("\n    ")}` : "");
  for (const u of units) {
    if (u.action === "tooling") continue;
    const denied = deniedErrors(u);
    if (denied.length) { errors.push(...denied); continue; }
    // A new file's style file is its baseline; a style unit's file does not exist until that unit is typed.
    const target = u.action === "edit" ? u.path : u.style_from?.path;
    if (!target || fileLines(projectRoot, target) === null) continue;
    const where = u.action === "edit" ? target : `${target} (its style file)`;
    for (const id of u.checks ?? []) {
      const c = checkById.get(id);
      if (!c) continue;
      const r = await runOn(c, target);
      if (r.ok) continue;
      const fixIt = u.action === "edit"
        ? `if the file already fails it, take ${id} out of this unit's checks`
        : `if the style file already fails it, give another style file or take ${id} out of this unit's checks`;
      errors.push(`${u.id}.checks: ${id} fails on ${where} as it is now, before any change (${verdict(r, c)}): ${fixIt}; if the command is wrong, fix it in the header, then check the header and this file again${output(r)}`);
    }
    if (u.action !== "edit") continue;
    for (const id of u.red_checks ?? []) {
      const c = checkById.get(id);
      if (!c) continue;
      const r = await runOn(c, target);
      if (r.ok) continue;
      errors.push(`${u.id}.red_checks: ${id} already fails on ${u.path} before the change, so its failure cannot show that the new case reproduces the bug: point the red check at the new case only, or put the case in a new test file (${verdict(r, c)})${output(r)}`);
    }
  }
  try { writeFileSync(cachePath, JSON.stringify(passed, null, 2) + "\n"); } catch { /* the record only saves a re-run */ }
  return errors;
}

// ---------------------------------------------------------------------------
// The whole spec, at finalize
// ---------------------------------------------------------------------------

/**
 * The accepted spec, checked as a whole: one header, at least one unit, every reference still resolving after
 * any section was re-sent, every file a section pointed into unchanged since it was accepted, and every
 * requirement id covered by a unit (greenfield's rule). Returns { spec, errors }.
 */
export function assembleSpec(runDir, projectRoot, runId) {
  const parts = acceptedParts(runDir);
  const errors = [];
  const headers = parts.filter((p) => p.section === "header");
  const header = headers.length ? headers[headers.length - 1].value : null;
  if (!header) errors.push("no header section was accepted");
  const units = parts.filter((p) => p.section === "units").flatMap((p) => p.value);
  if (!units.length) errors.push("no units section was accepted");
  if (header) errors.push(...headerErrors(header).map((e) => `header ${e}`));
  if (header && units.length) errors.push(...checkUnitsQuietly(units, projectRoot, runId, header));
  for (const p of parts) {
    for (const [file, hash] of Object.entries(p.hashes ?? {})) {
      const abs = resolve(projectRoot, file);
      const now = existsSync(abs) ? sha256(readFileSync(abs)) : null;
      if (now !== hash) errors.push(`${file} changed since ${p.source} was accepted: check that section again (plan-lint --section) so its lines match the file`);
    }
  }
  return { spec: header ? { header, units } : null, errors };
}

/** The cross-unit rules again over every accepted unit, in order (a re-sent earlier section can break a later one). */
function checkUnitsQuietly(units, projectRoot, runId, header) {
  const { errors } = checkUnits(units, { projectRoot, runId, header, earlier: [] });
  return errors;
}

/**
 * A header's own rules beyond its shape: every `{path}` of a file check stands where code can quote it (quotePath).
 * Returns error lines naming the field.
 */
export function headerErrors(header) {
  const errors = [];
  for (const [i, c] of (header?.file_checks ?? []).entries()) {
    for (const field of ["run", "fix"]) {
      const problem = typeof c?.[field] === "string" ? pathPlacementError(c[field]) : null;
      if (problem) errors.push(`/file_checks/${i}/${field}: ${problem}`);
    }
  }
  return errors;
}

/** The jobs checked on the whole project: a refactor keeps the behaviour the suite pins, a test run adds to the suite,
 * a deps run changes what the code runs on. */
const WHOLE_PROJECT_JOBS = ["refactor", "test", "deps"];

/**
 * What a job asks of the header: the whole-project checks of a refactor, test or deps run. Code checks that there is
 * at least one; which commands make the full suite is the architect's to name.
 */
export function headerJobErrors(header, intent) {
  if (WHOLE_PROJECT_JOBS.includes(intent) && !(header?.project_checks ?? []).length) {
    return [`a ${intent} run is checked on the whole project: the header's project_checks names the full test suite (and the typecheck, when the project has one)`];
  }
  return [];
}

const isRed = (u) => Boolean(u?.red_checks?.length);

/** Every unit a unit waits for, directly or through another unit. */
function ancestorsIn(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const reach = new Map();
  const walk = (u) => {
    if (reach.has(u.id)) return reach.get(u.id);
    const out = new Set();
    reach.set(u.id, out);
    for (const d of u.depends_on ?? []) {
      out.add(d);
      const dep = byId.get(d);
      if (dep) for (const a of walk(dep)) out.add(a);
    }
    return out;
  };
  return walk;
}

/**
 * What a job asks of each unit, in spec order (each unit sees only the units before it, as depends_on does). With
 * `report`, only the units whose ids it holds are reported: plan-lint checks a section on arrival against the units
 * accepted before it. Returns error lines, each naming the unit.
 *   - Only a job whose Gate 2 always opens holds a tooling unit: its shell step runs through Bash, which the write
 *     contract does not govern, so in any other job nobody is sure to see it before it runs.
 *   - A docs run holds documentation units (phase docs), a docstring in a source file included.
 *   - Only a bugfix has a reproducing test (red_checks). A bugfix holds its reproducing tests and the fix (codegen):
 *     every tests unit reproduces the bug, every reproducing test comes before every fix and waits for none (it must
 *     fail on the code as it is), and every fix waits for every reproducing test.
 */
export function unitJobErrors(units, intent, report = null) {
  const errors = [];
  const out = (u, msg) => { if (!report || report.has(u.id)) errors.push(`${u.id} (${u.path}): ${msg}`); };
  const ancestors = ancestorsIn(units);
  units.forEach((u, i) => {
    if (u.action === "tooling" && !GATE2_JOBS.includes(intent)) {
      const gate = intent === "bugfix" ? "a bugfix run opens Gate 2 only for a design-affecting spec, so no gate is sure to show it" : `a ${intent} run has no Gate 2 to show it`;
      out(u, `a tooling unit runs a shell step, and ${gate}: a ${intent} run holds no tooling unit`);
    }
    if (intent === "docs" && u.action !== "tooling" && u.phase !== "docs") {
      out(u, `a docs run holds documentation units only (phase docs); this unit is phase ${u.phase}`);
    }
    if (intent !== "bugfix") {
      if (isRed(u)) out(u, `red_checks are a bugfix run's reproducing test; this is a ${intent} run`);
      return;
    }
    if (u.action === "tooling") return;
    const before = units.slice(0, i);
    if (u.phase === "docs") out(u, "a bugfix run holds the test that reproduces the bug and the fix: a docs unit is not part of it");
    if (u.phase === "tests" && !isRed(u)) out(u, "a bugfix run's tests units are the tests that reproduce the bug: give it red_checks, the checks that must fail on the code as it is, or leave it out");
    if (isRed(u)) {
      const fixes = [...ancestors(u)].filter((id) => { const a = units.find((x) => x.id === id); return a && !isRed(a); });
      if (fixes.length) out(u, `the test that reproduces the bug waits for ${fixes.join(", ")}, a fix: it must fail on the code as it is, so it waits for no fix`);
      const firstFix = before.find((a) => a.action !== "tooling" && a.phase === "codegen" && !isRed(a));
      if (firstFix) out(u, `the tests that reproduce the bug come before every fix: put it before ${firstFix.id}`);
    } else if (u.phase === "codegen") {
      const red = before.filter(isRed);
      if (!red.length) out(u, "a fix is typed after the test that reproduces the bug: put the tests unit with red_checks before it and add it to depends_on");
      else {
        const missing = red.filter((r) => !ancestors(u).has(r.id)).map((r) => r.id);
        if (missing.length) out(u, `a fix is typed after the test that reproduces the bug: add ${missing.join(", ")} to its depends_on`);
      }
    }
  });
  return errors;
}

/**
 * What a job adds to the spec's rules, checked at finalize (plan-to-packets --intent) over the whole spec: every job
 * runs the same flow, and these are the few places where one job needs something of the plan another does not. The
 * rules for the header and for each unit (headerJobErrors, unitJobErrors) are checked again here, since plan-lint
 * checks them on arrival only when it knows the job. Returns error lines.
 *   - bugfix: at least one reproducing test (a tests unit with red_checks, which must fail on the code as it is) and at
 *     least one fix. When the run's write contract binds, the line names its allowlist: a bugfix whose test file the
 *     run may not write cannot be planned, and the allowlist is the person's decision.
 *   - test: at least one tests unit; source files only where the brief asks for them.
 *   - refactor, test, deps: the header names whole-project checks.
 *   - deps: the install is a tooling unit, the package manager's own step, whose path is the file it writes (a lockfile
 *     is the tool's to write; checkUnits keeps typed units off that path). It waits for at least one typed unit, the
 *     manifest edit it installs from: an install that waits for none would run on the manifest as it is, with the
 *     manifest edit after it or nowhere. Every other unit is typed before it or waits for it — none races the install.
 *     Which typed unit is the manifest is the architect's to say (Gate 2 shows the order); code reads no file names.
 */
export function jobRules(spec, intent, { allowlist } = {}) {
  const errors = [...headerJobErrors(spec.header, intent), ...unitJobErrors(spec.units, intent)];
  const red = spec.units.filter(isRed);
  if (intent === "bugfix") {
    if (!red.length) {
      errors.push(
        "a bugfix run starts with the test that reproduces the bug: give the tests unit that holds it red_checks, the ids of the file checks that run it and must fail before the fix" +
        (allowlist ? `; the write contract allows ${allowlist.join(", ")}: if no test file the bug needs is among them, return and say which test file the run needs and why; the allowlist is the person's decision` : ""),
      );
    }
    if (!spec.units.some((u) => u.action !== "tooling" && u.phase === "codegen" && !isRed(u))) {
      errors.push("a bugfix run fixes the bug: add the fix, a codegen unit that waits for the test that reproduces it");
    }
  }
  if (intent === "test" && !spec.units.some((u) => u.action !== "tooling" && u.phase === "tests")) {
    errors.push("a test run adds to the suite: the spec holds at least one tests unit");
  }
  if (intent === "deps") {
    const tools = spec.units.filter((u) => u.action === "tooling");
    if (!tools.length) errors.push("a deps run installs what it changes: add a tooling unit that runs the package manager (a lockfile is the tool's to write, never typed)");
    const ancestors = ancestorsIn(spec.units);
    const byId = new Map(spec.units.map((u) => [u.id, u]));
    const at = (u) => spec.units.indexOf(u);
    for (const t of tools) {
      if (![...ancestors(t)].some((id) => byId.get(id) && byId.get(id).action !== "tooling")) {
        errors.push(`${t.id} (${t.path}): the install waits for no typed unit, so it would run on the manifest as it is: type the manifest edit before it and add that unit to ${t.id}'s depends_on`);
      }
      for (const u of spec.units) {
        if (u.action === "tooling") continue;
        const beforeInstall = ancestors(t).has(u.id);
        const afterInstall = ancestors(u).has(t.id);
        if (!beforeInstall && !afterInstall) {
          errors.push(
            `${u.id} (${u.path}): neither waits for the install (${t.id}) nor is waited for by it: ` +
            (at(u) > at(t)
              ? `code a dependency upgrade needs waits for the install (add ${t.id} to its depends_on)`
              : `a file the install reads comes before it (add ${u.id} to ${t.id}'s depends_on); code the upgrade needs comes after it and waits for it`),
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Whether the person approves the spec at Gate 2 before anything is typed, and the first reason. The jobs in GATE2_JOBS
 * always open it. A bugfix opens it only when its spec is design-affecting, decided here from the spec and never from
 * its wording (brownfield-runs.md, "The jobs"): it records a decision, creates a file outside the tests phase, or
 * replaces or deletes lines of an existing test file — anything beyond the new case that reproduces the bug and the fix,
 * such as an assertion loosened so the suite stays green. Docs and test runs never open it.
 * Returns { open, reason }.
 */
export function gate2(spec, intent) {
  if (GATE2_JOBS.includes(intent)) return { open: true, reason: `every ${intent} run` };
  if (intent !== "bugfix") return { open: false, reason: `a ${intent} run has no Gate 2` };
  const decision = (spec.header.decisions ?? [])[0];
  if (decision) return { open: true, reason: `the spec records a decision: ${decision.topic}` };
  const created = spec.units.find((u) => u.action === "create" && u.phase !== "tests");
  if (created) return { open: true, reason: `${created.id} creates ${created.path} outside the tests phase` };
  for (const u of spec.units) {
    const site = u.action === "edit" && u.phase === "tests" ? (u.sites ?? []).find((s) => s.at === "replace" || s.at === "delete") : null;
    if (site) return { open: true, reason: `${u.id} ${site.at === "replace" ? "replaces" : "deletes"} lines of an existing test file: ${u.path}, ${site.id}` };
  }
  return { open: false, reason: "the test that reproduces the bug and its fix only" };
}

/** Requirement ids (FR-n, AC-n) no unit covers. */
export function uncovered(spec, requirementsText, requiredIds) {
  const covered = new Set(spec.units.flatMap((u) => u.covers ?? []));
  return requiredIds(requirementsText).filter((id) => !covered.has(id));
}

// ---------------------------------------------------------------------------
// What code makes from it
// ---------------------------------------------------------------------------

const exportLine = (e) => `${e.kind ? `${e.kind} ` : ""}${e.name}(${(e.params ?? []).map((p) => `${p.name}: ${p.type}`).join(", ")}): ${e.returns}`;
const siteWords = { replace: "replace", delete: "delete", insert_before: "insert before", insert_after: "insert after" };
const siteLines = (s) => (s.from === s.to ? `line ${s.from}` : `lines ${s.from}-${s.to}`);
const styleOf = (u, byId) =>
  u.style_from?.unit ? { path: byId.get(u.style_from.unit)?.path, reason: u.style_from.reason, unit: u.style_from.unit }
  : u.style_from?.path ? { path: u.style_from.path, lines: u.style_from.lines, reason: u.style_from.reason }
  : null;

/** One unit as the plan and the briefs show it. `full` adds what only its own typist needs (sites, tests). */
function unitBlock(u, byId, { full }) {
  const out = [`### ${u.id} — ${u.action} \`${u.path}\` (${u.phase})`, "", `Behaviour: ${u.behaviour}`];
  if (u.rules?.length) out.push("", "Rules:", ...u.rules.map((r, i) => `${i + 1}. ${r}`));
  if (u.exports?.length) out.push("", "Exports:", ...u.exports.map((e) => `- \`${exportLine(e)}\``));
  if (u.import_line) out.push("", `Import line: \`${u.import_line}\``);
  if (u.action === "tooling") out.push("", `Run: \`${u.run}\`${u.cwd ? ` in \`${u.cwd}\`` : ""}`);
  if (full && u.sites?.length) {
    out.push("", "Sites:", ...u.sites.map((s) => `- ${s.id}: ${siteWords[s.at]} ${siteLines(s)} (line ${s.from} reads \`${s.first_line}\`${s.to > s.from ? `, line ${s.to} reads \`${s.last_line}\`` : ""}) — ${s.rule}`));
  }
  const st = styleOf(u, byId);
  if (st) out.push("", `Style from: \`${st.path}${st.lines ? `:${st.lines[0]}-${st.lines[1]}` : ""}\`${st.unit ? ` (${st.unit})` : ""} — ${st.reason}`);
  else if (u.style_from) out.push("", `Style from: none — ${u.style_from.reason}`);
  if (full && u.uses?.length) out.push("", "Uses:", ...u.uses.map((x) => `- \`${x.path}${x.lines ? `:${x.lines[0]}-${x.lines[1]}` : ""}\` — ${x.reason}`));
  if (u.depends_on.length) out.push("", `Depends on: ${u.depends_on.join(", ")}`);
  if (u.covers?.length) out.push("", `Covers: ${u.covers.join(", ")}`);
  if (full && u.tests?.length) out.push("", "Tests:", ...u.tests.map((t) => `- ${t.name}: given ${t.given}, expect ${t.expect}`));
  if (u.checks?.length) out.push("", `Checks: ${u.checks.join(", ")}`);
  if (u.red_checks?.length) out.push("", `Fails before the fix: ${u.red_checks.join(", ")} — the test must fail on the code as it is now, and pass once the fix is in`);
  return out.join("\n");
}

function headerBlock(h) {
  const out = ["## Conventions", "", ...h.conventions.map((c) => `- ${c}`)];
  if (h.decisions?.length) out.push("", "## Decisions", "", ...h.decisions.map((d) => `- ${d.topic}: ${d.choice}${d.rejected?.length ? ` (not ${d.rejected.join("; not ")})` : ""} — ${d.reason}`));
  return out.join("\n");
}

/** change_plan.md: the whole spec for Gate 2 and the reviewers, rendered by code. */
export function renderPlan(spec, runId) {
  const byId = new Map(spec.units.map((u) => [u.id, u]));
  const h = spec.header;
  const checks = [
    ...h.file_checks.map((c) => `- ${c.id} (each file): \`${c.run}\`${c.fix ? `; fix: \`${c.fix}\`` : ""}`),
    ...h.project_checks.map((c) => `- ${c.id} (whole project, once at the end): \`${c.run}\``),
  ];
  // A replace or delete on a test file the project already has changes what the suite pins: listed under its own
  // heading, so Gate 2 and the reviewers see it as such and not as one more site among the units.
  const testEdits = spec.units.flatMap((u) =>
    u.action === "edit" && u.phase === "tests"
      ? (u.sites ?? []).filter((s) => s.at === "replace" || s.at === "delete").map((s) => `- ${u.id} \`${u.path}\` ${s.id}: ${siteWords[s.at]} ${siteLines(s)} (\`${s.first_line}\`${s.to > s.from ? ` … \`${s.last_line}\`` : ""}) — ${s.rule}`)
      : []);
  return [
    `# Change plan — ${runId}`,
    "",
    "Rendered by code from the accepted change spec (change-spec.json). Change the spec's section files and check them again; do not edit this file.",
    "",
    headerBlock(h),
    "",
    "## Checks",
    "",
    ...(checks.length ? checks : ["None."]),
    "",
    ...(testEdits.length ? ["## Existing tests this change edits", "", "Each changes lines of a test file the project already has, so it changes what the suite checks.", "", ...testEdits, ""] : []),
    "## Units",
    "",
    "| Unit | Action | Phase | File | Depends on |",
    "|---|---|---|---|---|",
    ...spec.units.map((u) => `| ${u.id} | ${u.action} | ${u.phase} | \`${u.path}\` | ${u.depends_on.join(", ") || "—"} |`),
    "",
    ...spec.units.flatMap((u) => [unitBlock(u, byId, { full: true }), ""]),
  ].join("\n");
}

/**
 * The typists' briefs. `shared.md` is the same bytes for every packet (the conventions, the decisions, and an index
 * of every file the change makes or edits with how it is imported and what it exports, greenfield's shared block),
 * so the batch marks it shared and the lean typist reads it from its cache. `<id>.md` is the unit's own entry and
 * the entries of the units it depends on.
 */
export function renderBriefs(spec) {
  const byId = new Map(spec.units.map((u) => [u.id, u]));
  const index = spec.units
    .filter((u) => u.action !== "tooling")
    .map((u) => [`- \`${u.path}\` (${u.id}, ${u.action})${u.import_line ? ` — import: \`${u.import_line}\`` : ""}`, ...(u.exports ?? []).map((e) => `  - \`${exportLine(e)}\``)].join("\n"));
  const shared = [headerBlock(spec.header), "", "## Files of this change", "", ...index, ""].join("\n");
  const units = {};
  for (const u of spec.units) {
    const deps = u.depends_on.map((d) => byId.get(d)).filter(Boolean);
    units[u.id] = [
      `## This file`,
      "",
      unitBlock(u, byId, { full: true }),
      ...(deps.length ? ["", "## Files it depends on", "", ...deps.flatMap((d) => [unitBlock(d, byId, { full: false }), ""])] : []),
      "",
    ].join("\n");
  }
  return { shared, units };
}

/** The server's bound on one input it reads whole (model-dispatch apply.ts MAX_SLICE_BYTES; a test keeps them equal). */
export const MAX_SLICE_BYTES = 200_000;
/**
 * A packet's budget when the routed model declares no output limit (the server otherwise asks for the model's own,
 * apply.ts applyBudget): greenfield's fallback (executor/typists.ts, 8192). The input figure is only logged, as in
 * greenfield's unit packets.
 */
export const BUDGET = { maxInputTokens: 400_000, maxOutputTokens: 8192 };
/** Retries after the first attempt: three attempts in all, greenfield's two routed attempts and its last one. */
export const MAX_RETRIES = 2;

/**
 * A file as inputs, whole: one input when it is within the server's bound on one input, else consecutive line
 * ranges each within it, so the typist sees every line whatever the file's size.
 */
export function wholeFileInputs(projectRoot, path, reason) {
  const abs = resolve(projectRoot, path);
  if (statSync(abs).size <= MAX_SLICE_BYTES) return [{ path, reason }];
  const lines = readFileSync(abs, "utf8").split("\n");
  const parts = [];
  let start = 0, bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = Buffer.byteLength(lines[i], "utf8") + 1;
    if (bytes + n > MAX_SLICE_BYTES && i > start) { parts.push([start + 1, i]); start = i; bytes = 0; }
    bytes += n;
  }
  parts.push([start + 1, lines.length]);
  return parts.map((r, k) => ({ path, lines: r, reason: `${reason}: part ${k + 1} of ${parts.length}` }));
}
/** The brownfield label of a unit, kept in `subtype`; routing uses the phase alone, as greenfield's does. */
const SUBTYPE = { create: { codegen: "new_file_add", tests: "test_add", docs: "doc_addition" }, edit: { codegen: "existing_file_edit", tests: "existing_file_edit", docs: "doc_update" } };

const PATH_TOKEN = "{path}";

/**
 * Each `{path}` of a check command and where it stands, read by the shell's own quoting rules (single quotes, double
 * quotes, a backslash escape): `word` — outside quotes, alone or joined to other unquoted text (`./{path}`,
 * `--file={path}`); `wrapped` — exactly `'{path}'` or `"{path}"`; `inside` — within a longer quoted string; `escaped` —
 * after a backslash. `open` is true when the command leaves a quote open.
 */
function pathSpots(cmd) {
  const spots = [];
  let quote = null;
  let opened = -1;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote !== "'" && ch === "\\") {
      if (cmd.startsWith(PATH_TOKEN, i + 1)) { spots.push({ kind: "escaped", start: i + 1, end: i + 1 + PATH_TOKEN.length }); i += PATH_TOKEN.length; }
      else i++;
      continue;
    }
    if (cmd.startsWith(PATH_TOKEN, i)) {
      const end = i + PATH_TOKEN.length;
      if (quote === null) spots.push({ kind: "word", start: i, end });
      else if (opened === i - 1 && cmd[end] === quote) { spots.push({ kind: "wrapped", start: i - 1, end: end + 1 }); quote = null; i = end; continue; }
      else spots.push({ kind: "inside", start: i, end });
      i = end - 1;
      continue;
    }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; opened = i; }
  }
  return { spots, open: quote !== null };
}

/**
 * Why code cannot quote this command's `{path}`, or null. A `{path}` inside a longer quoted string would be filled
 * with the path inside that string, where a `$` or a quote in the path changes what the shell runs; one after a
 * backslash is not the token the shell sees.
 */
export function pathPlacementError(cmd) {
  const { spots, open } = pathSpots(cmd);
  if (open) return "the command leaves a quote open";
  if (spots.some((s) => s.kind === "inside")) return `{path} sits inside a quoted string: write it outside quotes — code puts the path in single quotes itself, so ./{path} works and "./{path}" does not`;
  if (spots.some((s) => s.kind === "escaped")) return "{path} follows a backslash: write it as it is — code puts the path in single quotes itself";
  return null;
}

/**
 * The command with every `{path}` single-quoted where it stands, as the server substitutes the path into a shell and
 * paths carry `$` (`$userId`) or spaces: `{path}` and `./{path}` become `'{path}'` and `./'{path}'`, and a `{path}`
 * already wrapped in quotes of its own becomes `'{path}'`. The rest of the command is the architect's, unchanged. The
 * server fills the path in as written, so a single quote in it would end these quotes: a file whose path holds one has
 * no checks (checkUnits refuses them).
 * Throws for a command pathPlacementError refuses (plan-lint refuses it on arrival).
 */
export function quotePath(cmd) {
  const problem = pathPlacementError(cmd);
  if (problem) throw new Error(`${cmd}: ${problem}`);
  let out = "";
  let at = 0;
  for (const s of pathSpots(cmd).spots) {
    out += cmd.slice(at, s.start) + `'${PATH_TOKEN}'`;
    at = s.end;
  }
  return out + cmd.slice(at);
}

/**
 * A quotePath command with the file filled in, for the commands code runs itself or hands over to be run as written
 * (plan-lint's run of a check before the change, a bugfix's end-of-run test command). Every `{path}` of such a command
 * sits inside single quotes, so each quote in the path is written as `'\''` (close, an escaped quote, reopen) and the
 * shell reads the path as it is; for a path with no quote this is exactly the server's own fill.
 */
export function fillPath(quoted, path) {
  return quoted.split(PATH_TOKEN).join(String(path).replace(/'/g, "'\\''"));
}

/**
 * The end of every edit instruction: greenfield's own answer wording for a fix (executor/brief.ts
 * renderRepairInstruction; a test keeps the two equal), so a typist is asked for exact edits the same way in both
 * flows, and the server applies the answer with greenfield's applier (apply.ts applySearchReplace).
 */
export function editAnswerLines(path) {
  return [
    "The file's current text is under Inputs, marked \"current text\"; your edits apply to exactly that text.",
    "", "## Answer",
    `Return ONLY a JSON object {"path": "${path}", "edits": [{"search": "<text copied exactly from the current text>", "replace": "<its replacement>"}]} with no other text. Each search must appear exactly once in the current text; the edits apply in order.`,
    `If the file does not exist yet, or the change rewrites most of it, return {"path": "${path}", "content": "<the complete file>"} instead.`,
  ];
}

/**
 * packets.json from the spec: one packet per unit, in spec order (each unit depends only on earlier ones).
 * `runRel` is the run folder relative to the project root (the briefs' paths). Returns { packets, warnings }.
 */
export function derivePackets(spec, { runId, intent, projectRoot, runRel }) {
  const byId = new Map(spec.units.map((u) => [u.id, u]));
  const checkById = new Map(spec.header.file_checks.map((c) => [c.id, c]));
  const packetId = (u) => (u.action === "tooling" ? `tooling_${u.id}` : `tp_${u.phase}_${u.id}`);
  const warnings = [];
  const packets = [];
  for (const u of spec.units) {
    const base = {
      id: packetId(u),
      unit: u.id,
      phase: u.action === "tooling" ? "codegen" : u.phase,
      task_type: u.action === "tooling" ? "tooling" : "",
      module: "spec",
      intent,
      pass_id: runId,
      artifact_path: u.path,
      depends_on: u.depends_on.map((d) => packetId(byId.get(d))),
    };
    if (u.action === "tooling") {
      // The step runs through the orchestrator's Bash, outside the server's writer, so what it writes reaches
      // /mmo:revert and the reviewers only through the provenance pair around it (brownfield-runs.md, Phase 5). The
      // instruction names the pair with the run, the packet id and the path, so the orchestrator recalls none of them.
      packets.push({
        ...base,
        instruction:
          `Orchestrator shell step, no model (unit ${u.id}): in one Bash call, write-provenance.mjs --before --run-id=${runId} --packet-id=${base.id} ` +
          `for \`${u.path}\` and every other file the step writes, then \`${u.run}\`${u.cwd ? ` in \`${u.cwd}\`` : ""}, then write-provenance.mjs --after ` +
          `--run-id=${runId} for each of them, whether the step succeeded or not (brownfield-runs.md, Phase 5). ${u.behaviour}`,
        inputs: [],
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        acceptance: [],
        budget: { maxInputTokens: 0, maxOutputTokens: 0 },
      });
      continue;
    }
    // Paths only: the server reads each file at dispatch. The shared brief is the same for every packet.
    const inputs = [
      { path: `${runRel}/${BRIEFS_DIR}/shared.md`, reason: "shared brief: conventions, decisions, the files of this change (stable run record)" },
      // Only the shared brief is marked stable (a cached block every packet reads); this file's own brief follows it.
      { path: `${runRel}/${BRIEFS_DIR}/${u.id}.md`, reason: "this file's brief and the files it depends on" },
    ];
    const st = styleOf(u, byId);
    if (st?.path) inputs.push({ path: st.path, ...(st.lines ? { lines: st.lines } : {}), reason: `style file: ${st.reason}` });
    for (const x of u.uses ?? []) inputs.push({ path: x.path, ...(x.lines ? { lines: x.lines } : {}), reason: `uses: ${x.reason}` });
    let instruction;
    if (u.action === "edit") {
      // The file being edited, whole, so every line a site replaces is in view; any slice of it is then already there.
      for (let i = inputs.length - 1; i >= 2; i--) if (inputs[i].path === u.path) inputs.splice(i, 1);
      inputs.push(...wholeFileInputs(projectRoot, u.path, "current text"));
      const sites = u.sites.map((s) => `- ${s.id}: ${siteWords[s.at]} ${siteLines(s)} (line ${s.from} reads \`${s.first_line}\`${s.to > s.from ? `, line ${s.to} reads \`${s.last_line}\`` : ""}) — ${s.rule}`);
      instruction = [
        `Edit \`${u.path}\` (unit ${u.id}) at these sites only, as its brief says, following the conventions in the shared brief:`,
        ...sites,
        "",
        ...editAnswerLines(u.path),
      ].join("\n");
    } else {
      instruction =
        `Write \`${u.path}\` (unit ${u.id}) as its brief says: its behaviour, rules and exports, importing other files exactly as their import lines say, ` +
        `in the shape of the style file, following the conventions in the shared brief. Return JSON {path, content} with the complete file.`;
    }
    // The unit's typed checks, each with its own write form. No check of one language's imports: the spec states each
    // file's import line and the shared brief lists every file's, as greenfield's does, and the project's own checks
    // judge the rest. A bugfix's reproducing test also carries its red checks, typed `expect: "fail"`: the server
    // passes the answer only when each fails on the bug (apply.ts runRed).
    const typed = (id, extra = {}) => {
      const c = checkById.get(id);
      return { id, run: quotePath(c.run), ...(c.fix ? { fix: quotePath(c.fix) } : {}), ...extra };
    };
    const checks = [...(u.checks ?? []).map((id) => typed(id)), ...(u.red_checks ?? []).map((id) => typed(id, { expect: "fail" }))];
    // Each check may run as long as the plan says the packet's slowest check takes.
    const timeouts = [...(u.checks ?? []), ...(u.red_checks ?? [])].map((id) => checkById.get(id).timeout_s);
    if (!checks.length) warnings.push(`${u.id}: no file check; the server cannot judge the typist's answer beyond its form`);
    // Before the change, each check runs on the file as it is (an edit), or on the style file (a create with one):
    // a check that already fails there is set aside for this file (apply.ts baseline).
    const baselineFrom = u.action === "create" && st?.path ? st.path : undefined;
    // An edit is typed "at these sites only": its sites, as line ranges of the file before the change, go with the
    // packet so the server can hold the answer to them.
    const sites = u.action === "edit" ? u.sites.map((x) => ({ id: x.id, at: x.at, from: x.from, to: x.to })) : undefined;
    packets.push({
      ...base,
      subtype: u.red_checks?.length ? "bug_reproduce" : SUBTYPE[u.action][u.phase],
      instruction,
      inputs,
      acceptance: (u.tests ?? []).map((t) => `${t.name}: given ${t.given}, expect ${t.expect}`),
      // The server asks for the routed model's documented output limit (apply.ts applyBudget); this is its fallback.
      budget: { ...BUDGET },
      retry_count: 0,
      apply: { write: true, mode: u.action === "edit" ? "edits" : "content", checks, ...(sites ? { sites } : {}), ...(baselineFrom ? { baseline_from: baselineFrom } : {}), ...(timeouts.length ? { verify_timeout_sec: Math.max(...timeouts) } : {}), max_retries: MAX_RETRIES },
    });
  }
  // The project checks run once, after the last file: they ride on the last packet the server applies. A bugfix's
  // reproducing test goes first among them, on its own file: once the fix is in, the test that failed on the bug passes.
  // The orchestrator runs these as written, so the path is filled in here, quoted for the shell (fillPath).
  const greenAgain = spec.units.flatMap((u) => (u.red_checks ?? []).map((id) => fillPath(quotePath(checkById.get(id).run), u.path)));
  const deferred = [...greenAgain, ...spec.header.project_checks.map((c) => c.run)];
  const last = [...packets].reverse().find((p) => p.apply);
  if (last && deferred.length) last.verify_deferred = deferred;
  return { packets, warnings };
}

/** Writes the rendered files and packets.json into the run folder. Returns their paths. */
export function writeOutputs(runDir, spec, runId, packets) {
  const briefs = renderBriefs(spec);
  mkdirSync(join(runDir, BRIEFS_DIR), { recursive: true });
  writeFileSync(join(runDir, BRIEFS_DIR, "shared.md"), briefs.shared);
  for (const [id, text] of Object.entries(briefs.units)) writeFileSync(join(runDir, BRIEFS_DIR, `${id}.md`), text);
  const specPath = join(runDir, "change-spec.json");
  const planPath = join(runDir, "change_plan.md");
  const packetsPath = join(runDir, "packets.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
  writeFileSync(planPath, renderPlan(spec, runId));
  writeFileSync(packetsPath, JSON.stringify(packets, null, 2) + "\n");
  return { specPath, planPath, packetsPath };
}

/**
 * The run folder a step may write: `<project>/.sdlc/runs/<run-id>`, real paths, so a step that runs without a
 * prompt (zero-touch's own steps) cannot be pointed at any other folder.
 */
export function runFolder(projectRoot, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return { error: "--run-id must be the run's id (a folder name under .sdlc/runs)" };
  const runs = resolve(projectRoot, ".sdlc", "runs");
  const dir = join(runs, runId);
  if (!existsSync(dir)) return { error: `no run folder ${relative(projectRoot, dir).split(sep).join("/")}` };
  if (!insideReal(runs, dir)) return { error: `${dir} is not inside the project's .sdlc/runs` };
  return { dir, rel: [".sdlc", "runs", runId].join("/") };
}
