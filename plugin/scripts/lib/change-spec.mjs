/**
 * The typed change spec of a brownfield feature run (feature-extend, feature-new): its shape, the check each section
 * gets when it arrives, and what code makes from the accepted sections — change_plan.md for Gate 2 and the
 * reviewers, the typists' briefs, and packets.json.
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
 * `change.parts/` (accepted sections, with the hash of every file they point into), `change-spec.json`,
 * `change_plan.md`, `briefs/`, `packets.json`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadServerLib } from "./server-lib.mjs";


/** The folders of a run's change spec, under its run folder. */
export const SECTIONS_DIR = "change.sections";
export const PARTS_DIR = "change.parts";
export const BRIEFS_DIR = "briefs";

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
      path: { ...line, description: "Relative to the project root, as git lists it." },
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

/** Same glob dialect as write-contract-check.mjs (`**`, `*`, `?`); that module runs on import, so it is not shared. */
export function matchGlob(path, pattern) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

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
 * whose text differs, the file's actual lines, so one Edit fixes it.
 */
export function checkUnits(units, ctx) {
  const { projectRoot, runId, header, earlier } = ctx;
  const errors = [];
  const hashes = {};
  const contract = activeContract(projectRoot, runId);
  const known = new Map(earlier.map((u) => [u.id, u]));
  const takenPaths = new Map(earlier.filter((u) => u.action !== "tooling").map((u) => [u.path, u.id]));
  const checkIds = new Set((header?.file_checks ?? []).map((c) => c.id));
  const hashOf = (p) => {
    if (!(p in hashes)) hashes[p] = sha256(readFileSync(resolve(projectRoot, p)));
  };
  const lines = new Map();
  const linesOf = (p) => {
    if (!lines.has(p)) lines.set(p, fileLines(projectRoot, p));
    return lines.get(p);
  };
  const rangeOk = (where, p, r) => {
    const ls = linesOf(p);
    if (!ls) { errors.push(`${where}: ${p} is not a file in the project`); return; }
    hashOf(p);
    if (r && (r[0] > r[1] || r[1] > ls.length)) errors.push(`${where}: lines ${r[0]}-${r[1]} are outside ${p} (${ls.length} lines)`);
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
    if (contract && !contract.allowlist.some((g) => matchGlob(u.path, g))) {
      errors.push(`${at}: outside the write contract's allowlist (${contract.allowlist.join(", ")}); plan only files the run may write`);
    }
    if (u.action !== "tooling") {
      if (takenPaths.has(u.path)) errors.push(`${at}: ${takenPaths.get(u.path)} already changes this file; one unit per file`);
      takenPaths.set(u.path, u.id);
    }
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
    } else if (u.style_from?.path && safe(`${u.id}.style_from.path`, u.style_from.path)) {
      rangeOk(`${u.id}.style_from`, u.style_from.path, u.style_from.lines);
    }
    for (const [i, x] of (u.uses ?? []).entries()) if (safe(`${u.id}.uses[${i}].path`, x.path)) rangeOk(`${u.id}.uses[${i}]`, x.path, x.lines);
    for (const c of u.checks ?? []) if (!checkIds.has(c)) errors.push(`${u.id}.checks: ${c} is not a file check in the header`);
    known.set(u.id, u);
  }
  return { errors, hashes };
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

/** `{path}` single-quoted, as the server substitutes it into a shell and route files carry `$` (`$userId`). */
export function quotePath(cmd) {
  return cmd.replace(/["']?\{path\}["']?/g, "'{path}'");
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
      packets.push({
        ...base,
        instruction: `Orchestrator shell step, no model (unit ${u.id}): run \`${u.run}\`${u.cwd ? ` in \`${u.cwd}\`` : ""}. ${u.behaviour}`,
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
    // judge the rest.
    const checks = (u.checks ?? []).map((id) => {
      const c = checkById.get(id);
      return { id, run: quotePath(c.run), ...(c.fix ? { fix: quotePath(c.fix) } : {}) };
    });
    // Each check may run as long as the plan says the packet's slowest check takes.
    const timeouts = (u.checks ?? []).map((id) => checkById.get(id).timeout_s);
    if (!(u.checks ?? []).length) warnings.push(`${u.id}: no file check; the server cannot judge the typist's answer beyond its form`);
    // Before the change, each check runs on the file as it is (an edit), or on the style file (a create with one):
    // a check that already fails there is set aside for this file (apply.ts baseline).
    const baselineFrom = u.action === "create" && st?.path ? st.path : undefined;
    packets.push({
      ...base,
      subtype: SUBTYPE[u.action][u.phase],
      instruction,
      inputs,
      acceptance: (u.tests ?? []).map((t) => `${t.name}: given ${t.given}, expect ${t.expect}`),
      // The server asks for the routed model's documented output limit (apply.ts applyBudget); this is its fallback.
      budget: { ...BUDGET },
      retry_count: 0,
      apply: { write: true, mode: u.action === "edit" ? "edits" : "content", checks, ...(baselineFrom ? { baseline_from: baselineFrom } : {}), ...(timeouts.length ? { verify_timeout_sec: Math.max(...timeouts) } : {}), max_retries: MAX_RETRIES },
    });
  }
  // The project checks run once, after the last file: they ride on the last packet the server applies.
  const last = [...packets].reverse().find((p) => p.apply);
  if (last && spec.header.project_checks.length) last.verify_deferred = spec.header.project_checks.map((c) => c.run);
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
