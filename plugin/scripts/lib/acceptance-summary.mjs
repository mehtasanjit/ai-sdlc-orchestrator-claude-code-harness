/**
 * Puts the acceptance table the acceptance stage wrote (acceptance.md, beside spec.json) into the
 * run's SUMMARY.md, between two markers, replacing any earlier copy. The collector calls it on every
 * run, and again when it is re-run after the session closes, so the report's acceptance table is
 * always the one code wrote, whatever else the summary says. A run with no acceptance.md (every
 * flow but the greenfield executor) or no SUMMARY.md is left untouched.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ACCEPTANCE_START = "<!-- acceptance:start -->";
export const ACCEPTANCE_END = "<!-- acceptance:end -->";

export function writeAcceptanceSummary(passDir) {
  const tablePath = join(passDir, "acceptance.md");
  const summaryPath = join(passDir, "SUMMARY.md");
  if (!existsSync(tablePath) || !existsSync(summaryPath)) return false;
  const block = `${ACCEPTANCE_START}\n${readFileSync(tablePath, "utf8").trimEnd()}\n${ACCEPTANCE_END}`;
  const summary = readFileSync(summaryPath, "utf8");
  const i = summary.indexOf(ACCEPTANCE_START);
  const j = summary.indexOf(ACCEPTANCE_END);
  const next = i >= 0 && j > i
    ? summary.slice(0, i) + block + summary.slice(j + ACCEPTANCE_END.length)
    : `${summary.trimEnd()}\n\n${block}\n`;
  writeFileSync(summaryPath, next);
  return true;
}
