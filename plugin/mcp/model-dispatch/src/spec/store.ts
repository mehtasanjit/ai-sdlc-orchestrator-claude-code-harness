/**
 * The typed build spec, received in sections and assembled on disk.
 *
 * submit_spec_section stores the header, then batches of units, each checked
 * on arrival; finalize_spec assembles `spec.json`, checks that every FR- and
 * AC- requirement is covered by a unit and every AC- criterion by an acceptance
 * command (or a stated reason it cannot be run), and renders `design.md` from
 * the spec by code (so Gate 2 and the reviewers read the same content the file
 * writers get).
 *
 * A refused section stores nothing and says exactly why, so the architect
 * re-sends that section alone. Parts live under `<spec_dir>/spec.parts/`.
 *
 * One output folder holds one spec's records at a time. The header of a new
 * spec (after a finalize, or from another run) moves the earlier spec's
 * records under `<spec_dir>/previous/<time>/`, so a second run into the same
 * folder starts clean and nothing of the first is deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { SPEC_HEADER_SCHEMA, SPEC_UNITS_SECTION_SCHEMA, validate, type SchemaError } from "./schema.js";

export interface SpecExport { name: string; kind?: string; params: { name: string; type: string }[]; returns: string }
export interface SpecUnit {
  id: string; path: string; phase: "codegen" | "tests" | "docs"; kind?: string; import_line: string;
  exports: SpecExport[]; behaviour: string; depends_on: string[];
  style_from: { unit?: string; reason: string }; covers: string[];
  tests: { name: string; given: string; expect: string }[]; approx_lines: number;
}
export interface SpecCommand {
  name: string; run: string; cwd: string; role: "install" | "audit" | "check"; checks: string[];
  pass: { exit_code: number; forbid_lines_starting_with?: string[] };
  /** The plan's own time limit for this command, in seconds; code stops it there and reports its criteria as not checked. */
  timeout_s: number;
}
export interface SpecHeader {
  stack: string[];
  commands: SpecCommand[];
  unchecked?: { id: string; reason: string }[];
  no_audit_reason?: string;
  decisions: { topic: string; choice: string; rejected?: string[]; reason: string }[];
  shared: {
    conventions: string[];
    data_model: { name: string; fields: { name: string; type: string; constraints?: string }[] }[];
    api: { method: string; path: string; access: string; request: string; response: string; success_status: number; error_statuses: number[] }[];
  };
}
export interface Spec extends SpecHeader { spec_version: "1"; units: SpecUnit[] }

export interface SubmitResult {
  ok: boolean;
  section: "header" | "units";
  errors: SchemaError[];
  stored_units: number;
  total_units: number;
  /** Set when this header opened a new spec in a folder that held an earlier spec's records: where they were moved. */
  previous?: string;
}

const partsDir = (specDir: string) => join(specDir, "spec.parts");
const headerFile = (specDir: string) => join(partsDir(specDir), "header.json");
const openedFile = (specDir: string) => join(partsDir(specDir), "opened.json");

/**
 * The records one spec leaves in its output folder: its parts, the assembled spec and design, and what
 * the executor's stages write beside spec.json. Files the other phases write there (requirements.md,
 * the reviews, telemetry.jsonl) are not a spec's and stay where they are.
 */
export const SPEC_RECORDS: readonly string[] = Object.freeze([
  "spec.parts", "spec.json", "design.md", "acceptance", "acceptance.json", "acceptance.md", "written-files.json", "shared-brief.txt",
]);
/** The folder under an output folder that keeps earlier specs' records, one timestamped folder each. */
export const PREVIOUS_DIR = "previous";

/**
 * Moves whichever of `names` exist in `dir` into a new folder `<dir>/previous/<time>/` and returns
 * that folder, or undefined when none exists. Nothing is deleted.
 */
export function moveAside(dir: string, names: readonly string[]): string | undefined {
  const present = names.filter((n) => { try { lstatSync(join(dir, n)); return true; } catch { return false; } });
  if (!present.length) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let to = join(dir, PREVIOUS_DIR, stamp);
  for (let k = 2; existsSync(to); k++) to = join(dir, PREVIOUS_DIR, `${stamp}-${k}`);
  mkdirSync(to, { recursive: true });
  for (const n of present) renameSync(join(dir, n), join(to, n));
  return to;
}

/** The spec being written in `specDir`: its id, and the run that opened it when the caller named one. */
export function openedSpec(specDir: string): { id: string; run?: string } | undefined {
  try { const v = JSON.parse(readFileSync(openedFile(specDir), "utf8")); return typeof v?.id === "string" ? v : undefined; } catch { return undefined; }
}

/**
 * A spec's identity by its content: the same spec.json always gives the same key, and any change to
 * it gives another. The acceptance stage counts its runs per key, so its bound belongs to one spec.
 */
export function specKey(spec: Spec): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

/**
 * Whether a header opens a new spec rather than replacing the header of the spec being written (one
 * whose header is stored and that is not finalized). A header after a finalize opens a new spec: a
 * Gate 2 revise, or another run into the same folder. So does a header from a run other than the one
 * that opened the spec being written, when the caller names its run; a caller that names none cannot
 * tell a retry from a new run, so the spec being written keeps its units.
 */
function opensNewSpec(specDir: string, run: string | undefined): boolean {
  const writing = existsSync(headerFile(specDir)) && !existsSync(join(specDir, "spec.json"));
  if (!writing) return true;
  const openedBy = openedSpec(specDir)?.run;
  return run !== undefined && openedBy !== undefined && openedBy !== run;
}

/** Units already accepted, in the order they arrived. */
export function storedUnits(specDir: string): SpecUnit[] {
  const dir = partsDir(specDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^units-\d{3}\.json$/.test(f))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).units as SpecUnit[]);
}

/**
 * A path the executor may write: relative, already normalised, no `..`
 * segment. Anything else could land outside the code directory.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  const n = posix.normalize(p);
  return n === p && !n.split("/").includes("..") && n !== ".";
}

/**
 * A spec section as the file the architect wrote. A large section sent as tool input can arrive in a form Claude
 * Code cannot parse and is then thrown away whole, with no location, costing a full resend. So the architect writes
 * the section with the Write tool and names the file; this parses it and, when it is not valid JSON, names the
 * exact line, column and text, so one Edit fixes it instead of a resend of the whole section. The file must lie
 * inside the spec directory (real paths, so a symlink cannot lead out). A header file holds the header object;
 * a units file holds an array of units (or {"units": [...]}).
 */
export function readSectionFile(specDir: string, file: unknown, section: "header" | "units"): { value: unknown } | { error: string } {
  if (typeof file !== "string" || !file.trim()) return { error: "name the section file you wrote with the Write tool (file: a path under the spec directory, e.g. spec.sections/header.json)" };
  const root = resolve(specDir);
  const inside = (p: string, r: string) => { const rel = relative(r, p); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
  const full = resolve(root, file);
  if (!inside(full, root)) return { error: `${file} is outside the spec directory ${specDir}; write the section file under it` };
  if (!existsSync(full)) return { error: `no file at ${file}: write the section with the Write tool first, then submit it` };
  if (!inside(realpathSync(full), realpathSync(root))) return { error: `${file} is outside the spec directory ${specDir}; write the section file under it` };
  const text = readFileSync(full, "utf8");
  let value: unknown;
  try { value = JSON.parse(text); } catch (e: any) { return { error: jsonErrorAt(text, String(e?.message ?? e)) }; }
  if (section === "units") {
    if (value && !Array.isArray(value) && Array.isArray((value as any).units)) value = (value as any).units;
    if (!Array.isArray(value)) return { error: `${file} must hold a JSON array of units (or {"units": [...]})` };
  } else if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${file} must hold the header object {stack, commands, decisions, shared}` };
  }
  return { value };
}

/** Where a JSON text fails to parse, as a line, a column and that line's text (from the parser's own position). */
function jsonErrorAt(text: string, message: string): string {
  const lc = /line (\d+) column (\d+)/.exec(message);
  let line: number, col: number;
  if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
  else {
    const m = /position (\d+)/.exec(message);
    const pos = m ? Number(m[1]) : text.length;
    const before = text.slice(0, pos).split("\n");
    line = before.length; col = before[before.length - 1].length + 1;
  }
  const lines = text.split("\n");
  const shown = (lines[line - 1] ?? "").slice(0, 200);
  // The parser notices a missing comma or quote at the NEXT token, so the line before is shown too.
  const before = line > 1 ? `; the line before (${line - 1}) reads: ${(lines[line - 2] ?? "").slice(0, 200)}` : "";
  const why = message.replace(/\s*\(line \d+ column \d+\)/, "").replace(/ in JSON at position \d+/, "");
  return `the file is not valid JSON at line ${line}, column ${col}: ${why}. That line reads: ${shown}${before}\nFix that spot with the Edit tool and submit the same file again; do not rewrite the whole file.`;
}

/**
 * `run` names the run sending the section (one per pre-flight), when the caller knows it: a header from
 * another run then opens a new spec even if the earlier one was never finalized, and that run's units
 * cannot join a spec it did not open.
 */
export function submitSpecSection(specDir: string, input: { section: "header"; header: unknown } | { section: "units"; units: unknown }, opts: { run?: string } = {}): SubmitResult {
  const prior = storedUnits(specDir);
  if (input.section === "header") {
    const errors = validate(SPEC_HEADER_SCHEMA, input.header, "/header");
    if (!errors.length) {
      (input.header as SpecHeader).commands.forEach((c, i) => {
        if (c.cwd !== "." && !isSafeRelativePath(c.cwd)) errors.push({ path: `/header/commands/${i}/cwd`, message: `${c.cwd} is not a folder inside the code directory: give it relative to the code directory, or "." for the code directory itself` });
      });
    }
    // A refused header changes nothing, not even the earlier spec's records.
    if (errors.length) return { ok: false, section: "header", errors, stored_units: 0, total_units: prior.length };
    const previous = opensNewSpec(specDir, opts.run) ? moveAside(specDir, SPEC_RECORDS) : undefined;
    mkdirSync(partsDir(specDir), { recursive: true });
    writeFileSync(headerFile(specDir), JSON.stringify(input.header, null, 2) + "\n");
    const opened = openedSpec(specDir);
    if (!opened || (opts.run !== undefined && opened.run === undefined)) {
      writeFileSync(openedFile(specDir), JSON.stringify({ id: opened?.id ?? randomUUID(), ...(opts.run !== undefined ? { run: opts.run } : {}) }) + "\n");
    }
    return { ok: true, section: "header", errors: [], stored_units: 0, total_units: storedUnits(specDir).length, ...(previous ? { previous } : {}) };
  }

  if (!existsSync(headerFile(specDir))) {
    return { ok: false, section: "units", errors: [{ path: "/", message: "send the header section first (stack, commands, decisions, shared)" }], stored_units: 0, total_units: prior.length };
  }
  const openedBy = openedSpec(specDir)?.run;
  if (opts.run !== undefined && openedBy !== undefined && openedBy !== opts.run) {
    return { ok: false, section: "units", errors: [{ path: "/", message: "send the header section first: the stored header belongs to an earlier run's spec (stack, commands, decisions, shared)" }], stored_units: 0, total_units: prior.length };
  }
  const errors = validate(SPEC_UNITS_SECTION_SCHEMA, { units: input.units }, "");
  if (errors.length) return { ok: false, section: "units", errors, stored_units: 0, total_units: prior.length };

  // Cross-checks the schema cannot express: uniqueness across batches, and
  // references that point only to units accepted earlier (or earlier in this
  // batch), which is what keeps the job graph acyclic.
  const batch = input.units as SpecUnit[];
  const seenIds = new Set(prior.map((u) => u.id));
  const seenPaths = new Set(prior.map((u) => u.path));
  batch.forEach((u, i) => {
    const at = `/units/${i}`;
    if (seenIds.has(u.id)) errors.push({ path: `${at}/id`, message: `duplicate unit id ${u.id}` });
    if (!isSafeRelativePath(u.path)) errors.push({ path: `${at}/path`, message: `not a safe relative path: ${u.path}` });
    if (seenPaths.has(u.path)) errors.push({ path: `${at}/path`, message: `another unit already writes ${u.path}` });
    for (const d of u.depends_on) {
      if (d === u.id) errors.push({ path: `${at}/depends_on`, message: `${u.id} depends on itself` });
      else if (!seenIds.has(d)) errors.push({ path: `${at}/depends_on`, message: `${d} is not an earlier unit (send units after the units they depend on)` });
    }
    // A path that is another unit's folder (src/config and src/config/app.py): both files cannot exist.
    for (const other of seenPaths) {
      if (other.startsWith(`${u.path}/`)) errors.push({ path: `${at}/path`, message: `${u.path} is also a folder of ${other}` });
      else if (u.path.startsWith(`${other}/`)) errors.push({ path: `${at}/path`, message: `${other} is also a folder of ${u.path}` });
    }
    const s = u.style_from?.unit;
    if (s !== undefined && !seenIds.has(s)) errors.push({ path: `${at}/style_from/unit`, message: `${s} is not an earlier unit` });
    seenIds.add(u.id);
    seenPaths.add(u.path);
  });
  if (errors.length) return { ok: false, section: "units", errors, stored_units: 0, total_units: prior.length };

  const n = readdirSync(partsDir(specDir)).filter((f) => /^units-\d{3}\.json$/.test(f)).length + 1;
  writeFileSync(join(partsDir(specDir), `units-${String(n).padStart(3, "0")}.json`), JSON.stringify({ units: batch }, null, 2) + "\n");
  return { ok: true, section: "units", errors: [], stored_units: batch.length, total_units: prior.length + batch.length };
}

export interface FinalizeResult {
  ok: boolean;
  errors: SchemaError[];
  missing_coverage: string[];
  /** AC- criteria no acceptance command checks and `unchecked` does not list. */
  missing_acceptance: string[];
  units: number;
  by_phase: Record<string, number>;
  spec_path?: string;
  design_path?: string;
}

/**
 * Requirement ids a spec must cover: every FR- and AC- id in requirements.md,
 * read by the same grammar a unit's `covers` field accepts (FR-1, FR-1.2,
 * AC-3, AC-1.2), so an id is compared exactly as written, whatever numbering
 * the requirements use. NFR ids are not required to be covered by a unit.
 */
export function requiredIds(requirementsText: string): string[] {
  return [...new Set(requirementsText.match(/\b(?:FR|AC)-\d+(?:\.\d+)?\b/g) ?? [])];
}

export function finalizeSpec(specDir: string, requirementsPath?: string): FinalizeResult {
  const errors: SchemaError[] = [];
  if (!existsSync(headerFile(specDir))) errors.push({ path: "/", message: "no header section was accepted" });
  const units = storedUnits(specDir);
  if (!units.length) errors.push({ path: "/units", message: "no unit batch was accepted" });
  const byPhase: Record<string, number> = {};
  for (const u of units) byPhase[u.phase] = (byPhase[u.phase] ?? 0) + 1;
  let missing: string[] = [];
  let missingAcceptance: string[] = [];
  const header = existsSync(headerFile(specDir)) ? (JSON.parse(readFileSync(headerFile(specDir), "utf8")) as SpecHeader) : undefined;
  if (requirementsPath && !existsSync(requirementsPath)) errors.push({ path: "/", message: `the requirements file ${requirementsPath} does not exist, so coverage cannot be checked` });
  if (requirementsPath && existsSync(requirementsPath)) {
    const ids = requiredIds(readFileSync(requirementsPath, "utf8"));
    const covered = new Set(units.flatMap((u) => u.covers));
    missing = ids.filter((id) => !covered.has(id));
    if (header) {
      const accounted = new Set([...header.commands.flatMap((c) => c.checks), ...(header.unchecked ?? []).map((u) => u.id)]);
      missingAcceptance = ids.filter((id) => id.startsWith("AC-") && !accounted.has(id));
    }
  }
  if (header && !header.commands.some((c) => c.role === "audit") && !header.no_audit_reason) {
    errors.push({ path: "/header/commands", message: 'no command has role "audit" and no no_audit_reason is given: add the stack\'s dependency audit (its threshold set so high or critical advisories exit non-zero), or say in no_audit_reason why there is none' });
  }
  if (missingAcceptance.length) {
    errors.push({ path: "/header/commands", message: `no acceptance command checks ${missingAcceptance.join(", ")}: add it to a command's checks, or list it in unchecked with the reason it cannot be checked by running` });
  }
  if (errors.length || missing.length) return { ok: false, errors, missing_coverage: missing, missing_acceptance: missingAcceptance, units: units.length, by_phase: byPhase };
  const spec: Spec = { spec_version: "1", ...header!, units };
  const specPath = join(specDir, "spec.json");
  const designPath = join(specDir, "design.md");
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
  writeFileSync(designPath, renderDesign(spec));
  return { ok: true, errors: [], missing_coverage: [], missing_acceptance: [], units: units.length, by_phase: byPhase, spec_path: specPath, design_path: designPath };
}

export function loadSpec(specPath: string): Spec {
  return JSON.parse(readFileSync(specPath, "utf8")) as Spec;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** design.md, rendered from the spec by code: what Gate 2 and the reviewers read. */
export function renderDesign(spec: Spec): string {
  const lines: string[] = ["# Design (rendered from spec.json)", "", "## Stack", ...spec.stack.map((s) => `- ${s}`), "", "## Acceptance checks", "",
    "Run by code at the end of the run, in this order; each criterion's verdict comes from these.", "",
    "| Command | Role | Run | Checks | Passes when | Time limit |", "|---|---|---|---|---|---|"];
  for (const c of spec.commands) {
    const pass = [`exit code ${c.pass?.exit_code ?? 0}`, ...(c.pass?.forbid_lines_starting_with ?? []).map((p) => `no line starts with "${p}"`)].join("; ");
    lines.push(`| ${cell(c.name)} | ${c.role} | \`${cell(c.run)}\` (in ${cell(c.cwd)}) | ${(c.checks ?? []).join(", ") || "—"} | ${cell(pass)} | ${c.timeout_s ?? "—"} s |`);
  }
  if (spec.commands.length) lines.push("", "A command the machine cannot run (its program is not found, or it is stopped at its time limit) marks its criteria not checked, with that reason; a command that runs and fails marks them failed.");
  for (const u of spec.unchecked ?? []) lines.push("", `- ${u.id}: no command could check this by running — ${u.reason}`);
  if (spec.no_audit_reason) lines.push("", `- No dependency audit: ${spec.no_audit_reason}`);
  lines.push("", "## Decisions", "", "| Topic | Choice | Why | Rejected |", "|---|---|---|---|");
  for (const d of spec.decisions) lines.push(`| ${cell(d.topic)} | ${cell(d.choice)} | ${cell(d.reason)} | ${cell((d.rejected ?? []).join("; "))} |`);
  lines.push("", "## Conventions", ...spec.shared.conventions.map((c) => `- ${c}`), "", "## Data model");
  for (const t of spec.shared.data_model) lines.push(`- **${t.name}**: ${t.fields.map((f) => `${f.name} ${f.type}${f.constraints ? ` (${f.constraints})` : ""}`).join("; ")}`);
  lines.push("", "## API", "", "| Method | Path | Access | Request | Response | OK | Errors |", "|---|---|---|---|---|---|---|");
  for (const a of spec.shared.api) lines.push(`| ${a.method} | ${cell(a.path)} | ${cell(a.access)} | ${cell(a.request)} | ${cell(a.response)} | ${a.success_status} | ${a.error_statuses.join(", ")} |`);
  lines.push("", "## Files", "", "| Id | Path | Phase | What it does | Imported as | Uses |", "|---|---|---|---|---|---|");
  for (const u of spec.units) lines.push(`| ${u.id} | ${cell(u.path)} | ${u.phase} | ${cell(u.behaviour)} | ${u.import_line ? cell(u.import_line) : "—"} | ${u.depends_on.join(", ")} |`);
  return lines.join("\n") + "\n";
}
