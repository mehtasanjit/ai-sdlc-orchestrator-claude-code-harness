#!/usr/bin/env node
/**
 * plan-lint — check one section of a brownfield feature run's change spec when the architect hands it over, or
 * print the spec's shape.
 *
 * Why: the plan used to be free-text change_plan.md, linted after the architect returned by counting fenced lines,
 * and a failure cost a fresh architect delegation. Greenfield checks each spec section on arrival, in the same
 * architect session, against a strict schema whose shape is shown up front (spec/store.ts submitSpecSection), so a
 * refusal costs one Edit. This does the same for a change, as a mode of the run's own script so the server's tool
 * list is unchanged: the schema rules (every text field one line, so no code fits; exact enums), and the change's
 * pointers checked against the files as they are (lib/change-spec.mjs checkUnits). An accepted section is copied
 * to the run's change.parts/ with the hash of every file it points into; plan-to-packets --spec builds from those.
 *
 * Usage:
 *   node plan-lint.mjs --shape
 *   node plan-lint.mjs --section <file> --run-id <id> [--project-root <dir>]
 *     <file>: header.json or units-NNN.json under <project>/.sdlc/runs/<id>/change.sections/
 *
 * Exit 0 = accepted (one summary line). 1 = refused (one line per problem, each naming the unit and field; nothing is
 * stored). 2 = usage, or a file outside the run's section folder.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";
import { PARTS_DIR, SECTIONS_DIR, acceptedParts, changeSchemas, changeShape, checkUnits, runFolder } from "./lib/change-spec.mjs";

function parseArgs(argv) {
  const out = { shape: false, section: null, runId: null, projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--shape") out.shape = true;
    else if (a.startsWith("--section")) out.section = val();
    else if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
  }
  return out;
}

/**
 * Checks one section file. Returns { ok, lines } — the lines to print; on success the section is stored.
 * A header section is named header*.json; every other section file holds units.
 */
export async function checkSection(projectRoot, runId, file) {
  const run = runFolder(projectRoot, runId);
  if (run.error) return { ok: false, usage: true, lines: [run.error] };
  const { specSchema, specStore } = await loadServerLib();
  const { header: headerSchema, unit: unitSchema } = await changeSchemas();
  const sectionsDir = join(run.dir, SECTIONS_DIR);
  const name = basename(file);
  const kind = /^header/i.test(name) ? "header" : "units";
  const read = specStore.readSectionFile(sectionsDir, resolve(projectRoot, file), kind);
  if (read.error) {
    const why = read.error.replace(/must hold the header object \{[^}]*\}/, "must hold the header object {conventions, decisions, file_checks, project_checks}");
    return { ok: false, usage: /outside the spec directory|name the section file/.test(why), lines: [why] };
  }
  const value = read.value;
  const parts = acceptedParts(run.dir);
  let hashes = {};
  if (kind === "header") {
    const schemaErrors = specSchema.validate(headerSchema, value);
    if (schemaErrors.length) return { ok: false, lines: schemaErrors.map((e) => `${name} ${e.path}: ${e.message}`) };
  } else {
    // Earlier = the units of section files named before this one; a re-sent section replaces its own earlier copy.
    const header = [...parts].reverse().find((p) => p.section === "header")?.value;
    if (!header) return { ok: false, lines: [`${name}: check the header section first (its file checks are what units name)`] };
    const earlier = parts.filter((p) => p.section === "units" && p.source < name).flatMap((p) => p.value);
    // Every problem in one answer, so one round of Edits fixes the section: the schema's, and the file checks of
    // every unit whose shape is right (a unit with a wrong shape still counts as known, so others' references to it
    // are not reported twice).
    const schemaErrors = value.flatMap((u, i) => specSchema.validate(unitSchema, u, `/${i}`).map((e) => ({ i, e })));
    const bad = new Set(schemaErrors.map((x) => x.i));
    const r = checkUnits(value.filter((_, i) => !bad.has(i)), { projectRoot: resolve(projectRoot), runId, header, earlier: [...earlier, ...value.filter((u, i) => bad.has(i) && u && typeof u.id === "string")] });
    const lines = [...schemaErrors.map(({ e }) => `${name} ${e.path}: ${e.message}`), ...r.errors.map((e) => `${name} ${e}`)];
    if (lines.length) return { ok: false, lines };
    hashes = r.hashes;
  }
  mkdirSync(join(run.dir, PARTS_DIR), { recursive: true });
  writeFileSync(join(run.dir, PARTS_DIR, name), JSON.stringify({ section: kind, source: name, value, hashes }, null, 2) + "\n");
  const summary = kind === "header"
    ? `accepted ${name}: ${value.conventions.length} conventions, ${value.file_checks.length} file checks, ${value.project_checks.length} project checks`
    : `accepted ${name}: ${value.length} unit(s) (${value.map((u) => u.id).join(", ")})`;
  return { ok: true, lines: [summary] };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.shape) {
    process.stdout.write((await changeShape()) + "\n");
    return 0;
  }
  if (!args.section || !args.runId) {
    process.stderr.write("usage: plan-lint.mjs --shape | --section <change.sections/file.json> --run-id <id> [--project-root <dir>]\n");
    return 2;
  }
  const r = await checkSection(args.projectRoot, args.runId, args.section);
  (r.ok ? process.stdout : process.stderr).write(r.lines.join("\n") + "\n");
  return r.ok ? 0 : r.usage ? 2 : 1;
}

// Run directly, also through a linked folder (real paths compared, as handoff-models.mjs does). exitCode, not
// exit(): the process ends once its output has drained, which a pipe on macOS needs.
const isDirectRun = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`plan-lint: ${e?.message ?? e}\n`); process.exitCode = 2; });
}
