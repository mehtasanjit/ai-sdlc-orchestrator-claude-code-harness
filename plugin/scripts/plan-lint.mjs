#!/usr/bin/env node
/**
 * plan-lint — refuse a brownfield `change_plan.md` that contains the program
 * instead of the spec for it.
 *
 * Why: under a multi-model policy the architect tends to write every file in
 * full into the plan so the cheap tier can transcribe it. Every such block is
 * premium-model output that both reviewers re-read, and the worker's part
 * collapses to copying. This gate makes the "no literal code" rule mechanical
 * so it cannot be argued with mid-run.
 *
 * What passes: signatures, one-line literals, a numbered rule list, a
 * `path:lines` pointer to the file to mirror. What fails: any fenced block
 * longer than --max-block-lines (default 12: a type + a signature or two),
 * more than --max-fenced-lines of fenced text overall (default 150), or a
 * section whose body is headed "Content:" / "Full file" / "Complete file".
 * The architect prompt says the same in words; this is the check.
 *
 * Exit 0 = clean. 1 = violations (listed, one per line, with the section
 * heading so the architect can be re-delegated with the list). 2 = usage /
 * unreadable file. Greenfield design.md is not linted — it has no worker to
 * transcribe for.
 *
 * Usage: node plan-lint.mjs <change_plan.md> [--max-block-lines N]
 *                                             [--max-fenced-lines N] [--json]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULTS = { maxBlockLines: 12, maxFencedLines: 150 };

/**
 * Advisory only (never fails the lint — a re-delegation costs more than it saves).
 * A long plan is premium-model output that both reviewers re-read. Notes feed the
 * run's notes.md.
 */
export const PLAN_LINE_BUDGET = 500;

/** Headings that announce a transcription target rather than a spec. */
const LITERAL_BODY_HEADINGS = /^\s*(\*\*)?(content|full file|complete file|file contents?)(\*\*)?\s*:?\s*(\*\*)?\s*$/i;

/**
 * Lint the plan text. Returns { ok, violations: [{ line, section, kind, detail }],
 * stats: { fencedBlocks, fencedLines, sections } }. Pure; no I/O.
 */
export function lintPlan(text, opts = {}) {
  const maxBlockLines = opts.maxBlockLines ?? DEFAULTS.maxBlockLines;
  const maxFencedLines = opts.maxFencedLines ?? DEFAULTS.maxFencedLines;
  const lines = text.split(/\r?\n/);
  const violations = [];
  let section = "(preamble)";
  let sections = 0;
  let inFence = false;
  let fenceStart = 0;
  let fenceLines = 0;
  let fencedBlocks = 0;
  let fencedLines = 0;
  const notes = [];
  const sectionLines = new Map();

  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      if (!inFence) {
        inFence = true;
        fenceStart = n;
        fenceLines = 0;
        fencedBlocks += 1;
      } else {
        inFence = false;
        fencedLines += fenceLines;
        if (fenceLines > maxBlockLines) {
          violations.push({
            line: fenceStart,
            section,
            kind: "block_too_long",
            detail: `fenced block of ${fenceLines} lines (max ${maxBlockLines}) — replace with signatures + numbered rules, or a path:lines pointer to the file to mirror`,
          });
        }
      }
      return;
    }
    if (inFence) {
      fenceLines += 1;
      return;
    }
    if (/^#{1,6}\s/.test(raw)) {
      section = raw.replace(/^#+\s*/, "").trim();
      sections += 1;
      if (/^###\s+Edits?\b/i.test(raw)) notes.push({ line: n, section, kind: "edit_sites_form", detail: "edit sites under a `### Edits` heading — write them as sub-bullets of `- **Edit anchor**`: after `:N` `<line text>`" });
      return;
    }
    if (/^#{1,2}\s/.test(section) === false) sectionLines.set(section, (sectionLines.get(section) ?? 0) + 1);
    if (LITERAL_BODY_HEADINGS.test(raw)) {
      violations.push({
        line: n,
        section,
        kind: "literal_body",
        detail: `"${raw.trim()}" announces a full-file listing — a plan section carries Exports / Behavior / Mirror, never the file`,
      });
    }
  });

  if (inFence) {
    violations.push({ line: fenceStart, section, kind: "unterminated_fence", detail: "code fence never closed" });
  }
  if (fencedLines > maxFencedLines) {
    violations.push({
      line: 0,
      section: "(whole plan)",
      kind: "too_much_fenced_text",
      detail: `${fencedLines} fenced lines in total (max ${maxFencedLines}) across ${fencedBlocks} blocks`,
    });
  }
  const planLines = lines.filter((l) => l.trim()).length;
  if (planLines > PLAN_LINE_BUDGET) {
    notes.push({ line: 0, section: "(whole plan)", kind: "long_plan", detail: `${planLines} non-blank lines (brief form ≈ ${PLAN_LINE_BUDGET}; informational — do not trim a written plan); largest sections: ${[...sectionLines].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, c]) => `${s} (${c})`).join(", ")}` });
  }
  return { ok: violations.length === 0, violations, notes, stats: { fencedBlocks, fencedLines, sections, planLines } };
}

export function formatReport(path, result) {
  const { stats, violations } = result;
  const head = `plan-lint ${result.ok ? "ok" : "FAILED"}: ${path} — ${stats.sections} sections, ${stats.planLines} lines, ${stats.fencedBlocks} fenced blocks, ${stats.fencedLines} fenced lines`;
  const noteRows = (result.notes ?? []).map((v) => `  note L${v.line || "-"} [${v.section}] ${v.kind}: ${v.detail}`);
  if (result.ok) return noteRows.length ? `${head}\n${noteRows.join("\n")}` : head;
  const rows = violations.map((v) => `  L${v.line || "-"} [${v.section}] ${v.kind}: ${v.detail}`);
  return `${head}\n${rows.join("\n")}\n\nRe-delegate the architect with this list: shrink each named section to a spec (Exports as signatures, Behavior as numbered rules, Mirror as path:lines). The plan is read by the worker through inputs[].section, so nothing is lost by pointing instead of pasting.`;
}

function parseArgs(argv) {
  const args = { file: undefined, json: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => Number(a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--json") args.json = true;
    else if (a.startsWith("--max-block-lines")) args.maxBlockLines = eat("--max-block-lines");
    else if (a.startsWith("--max-fenced-lines")) args.maxFencedLines = eat("--max-fenced-lines");
    else if (a.startsWith("--")) throw new Error(`unknown argument '${a}'`);
    else args.file = a;
  }
  if (!args.file) throw new Error("usage: plan-lint.mjs <change_plan.md> [--max-block-lines N] [--max-fenced-lines N] [--json]");
  if (!Number.isFinite(args.maxBlockLines) || !Number.isFinite(args.maxFencedLines)) throw new Error("limits must be numbers");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`plan-lint: ${err.message}`);
    return 2;
  }
  let text;
  try {
    text = readFileSync(resolve(args.file), "utf8");
  } catch (err) {
    console.error(`plan-lint: cannot read ${args.file}: ${err.message}`);
    return 2;
  }
  const result = lintPlan(text, args);
  if (args.json) console.log(JSON.stringify({ path: args.file, ...result }, null, 2));
  else (result.ok ? console.log : console.error)(formatReport(args.file, result));
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exit(main());
