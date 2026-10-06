/**
 * Renders a run's SUMMARY.md from its records: the manifest write-manifest.mjs has just written (or the collector has
 * just patched) and the files in the run's output folder.
 *
 * Why code writes it: both orchestrators run as Claude Code helpers, and Claude Code refuses a helper's Write of a
 * report file (SUMMARY*.md). A run whose orchestrator was asked to write it paid for the refused call, then for the
 * same report again by another route, and some runs ended with no SUMMARY.md at all. Every figure here is read from
 * manifest.json, so the report cannot disagree with the run's record; the orchestrator's own account of the run goes
 * in its final message.
 *
 * What it holds: the run id, policy and status; the dispatched total and the cost by phase and by model from the
 * manifest's rollups; once the collector has patched the manifest, the orchestrator's overhead, the in-session work
 * counted once and the true total (until then every cost says it is dispatched work only); the collector command with
 * the output folder and project root written out, under "Provisional — re-run after closing this session"; links to
 * the run's files that exist; in brownfield, the checks set aside per file (each packet's latest batch receipt that
 * applied it, as findings-to-packets reads them); and the acceptance table the acceptance stage wrote, kept between
 * its markers across every re-render (lib/acceptance-summary.mjs replaces it with the current acceptance.md).
 *
 * Exports: COLLECTOR_SCRIPT, DISPATCHED_ONLY, setAsideChecks(outDir), renderRunSummary(outDir, manifest, opts),
 * writeRunSummary(outDir, manifest, opts).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTANCE_END, ACCEPTANCE_START } from "./acceptance-summary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The post-run collector, whose command the summary prints with this run's paths. */
export const COLLECTOR_SCRIPT = resolve(HERE, "..", "collect-orchestrator-usage.mjs");
/** The label every cost carries until the collector has added the orchestrator's own loop. */
export const DISPATCHED_ONLY = "dispatched work only — excludes orchestrator overhead";
/** The run's files the summary links to when they exist, in this order (a pattern matches every file it fits). */
const LINKED = ["requirements.md", "design.md", "change_plan.md", "spec.json", "acceptance.md", /^review.*\.json$/, "security_review.md", "manifest.json", "provenance.json"];

const usd = (n) => `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
/** Text for a Markdown table cell: a `|` would end the cell, a line break the row. */
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * The checks set aside per file in a brownfield run: for each packet, its latest receipt in `<outDir>/batches/*.json`
 * (the server writes one per execute_batch call, named by its time) whose item applied it (an item with an outcome; one
 * that was blocked carries none), and that outcome's `set_aside` entries ({ id?, run }). Returns
 * [{ path, checks: [{ id, run }] }] in path order; empty when the run has no receipts or set nothing aside.
 */
export function setAsideChecks(outDir) {
  const dir = join(outDir, "batches");
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const latest = new Map();
  for (const n of names) {
    const items = readJson(join(dir, n))?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (typeof it?.id === "string" && it.outcome && typeof it.outcome === "object") latest.set(it.id, it);
    }
  }
  const byPath = new Map();
  for (const it of latest.values()) {
    const checks = (Array.isArray(it.outcome.set_aside) ? it.outcome.set_aside : [])
      .filter((c) => c && (typeof c.id === "string" || typeof c.run === "string"))
      .map((c) => ({ id: typeof c.id === "string" ? c.id : null, run: typeof c.run === "string" ? c.run : null }));
    if (!checks.length) continue;
    const path = String(it.artifact_path ?? it.outcome.apply?.path ?? it.id);
    byPath.set(path, [...(byPath.get(path) ?? []), ...checks]);
  }
  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, checks]) => ({ path, checks }));
}

/** The run's files that exist in `outDir`, as LINKED orders them. */
function linkedFiles(outDir) {
  let names = [];
  try { names = readdirSync(outDir).sort(); } catch { /* no folder: no links */ }
  const out = [];
  for (const want of LINKED) {
    const hits = typeof want === "string" ? (names.includes(want) ? [want] : []) : names.filter((n) => want.test(n));
    for (const n of hits) if (!out.includes(n) && isFile(join(outDir, n))) out.push(n);
  }
  return out;
}

/** The acceptance block of an existing SUMMARY.md (markers included), or null. */
function acceptanceBlock(text) {
  const i = text.indexOf(ACCEPTANCE_START);
  const j = text.indexOf(ACCEPTANCE_END);
  return i >= 0 && j > i ? text.slice(i, j + ACCEPTANCE_END.length) : null;
}

/**
 * SUMMARY.md's text for this run. `projectRoot` is the folder the collector command names; `keep` is an acceptance
 * block to carry over (renderRunSummary never reads the disk for it; writeRunSummary passes the current file's).
 */
export function renderRunSummary(outDir, manifest, { projectRoot = process.cwd(), keep = null } = {}) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const out = resolve(outDir);
  const runId = m.run_id ?? m.pass ?? "(no run id)";
  const policy = m.policy_name ?? "(no policy recorded)";
  const oh = m.orchestrator_overhead && typeof m.orchestrator_overhead === "object" ? m.orchestrator_overhead : null;
  const withTrueTotal = Number.isFinite(m.true_total_cost_usd) && Number.isFinite(oh?.cost_usd);
  const only = withTrueTotal ? "" : ` — ${DISPATCHED_ONLY}`;
  const dispatched = Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : m.totals?.dispatched_cost_usd;
  const L = [];
  L.push(`# Run ${runId} — policy ${policy}`, "");
  L.push(`Status: **${m.status ?? "provisional"}**`, "");
  L.push("Written by code from this run's records (manifest.json and the files below); every figure is the manifest's.", "");

  L.push(`## Cost${only}`, "", "| | Cost |", "|---|---:|");
  L.push(`| Dispatched work${withTrueTotal ? " (the calls the dispatch server made or logged)" : ` (${DISPATCHED_ONLY})`} | ${usd(dispatched)} |`);
  if (withTrueTotal) {
    L.push(`| Orchestrator overhead (this session's own loop, priced from its transcripts) | ${usd(oh.cost_usd)} |`);
    if (Number.isFinite(oh.dispatched_in_session_cost_usd) && oh.dispatched_in_session_cost_usd > 0) {
      L.push(`| In-session work already inside the overhead, counted once | −${usd(oh.dispatched_in_session_cost_usd)} |`);
    }
    L.push(`| **True total** | **${usd(m.true_total_cost_usd)}** |`, "");
    if (oh.cost_source) L.push(`How the overhead was measured: ${oh.cost_source}.`, "");
  } else {
    L.push("", "The orchestrator's own loop is in no figure here. The collector (below) adds it and the true total.", "");
  }

  const phases = Object.entries(m.phase_breakdown && typeof m.phase_breakdown === "object" ? m.phase_breakdown : {});
  L.push(`### By phase${only}`, "");
  if (withTrueTotal) L.push("The calls dispatched (or logged) in each phase. The rest of the orchestrator's own loop is in the overhead above, in no phase.", "");
  if (phases.length) {
    L.push("| Phase | Calls | Models | Cost |", "|---|---:|---|---:|");
    for (const [phase, p] of phases) {
      const measured = p?.measured ? " (measured: the helper's own transcript)" : "";
      L.push(`| ${cell(phase)}${measured} | ${p?.calls ?? "—"} | ${cell((p?.models ?? []).join(", ") || "—")} | ${usd(p?.cost_usd)} |`);
    }
    if (phases.some(([, p]) => p?.measured)) {
      L.push("", "A phase marked measured ran in a helper of this session (the architect or a reviewer): its cost is that helper's transcript priced at the list (part of the overhead above), in place of any estimate the orchestrator logged.");
    }
  } else {
    L.push("No phase was recorded.");
  }
  L.push("");

  const models = Object.entries(m.model_breakdown && typeof m.model_breakdown === "object" ? m.model_breakdown : {});
  L.push(withTrueTotal ? "### Dispatched work by model" : `### By model${only}`, "");
  if (models.length) {
    L.push("| Model | Calls | Cost |", "|---|---:|---:|");
    for (const [model, b] of models) L.push(`| ${cell(model)} | ${b?.calls ?? "—"} | ${usd(b?.cost_usd)} |`);
  } else {
    L.push("No model was recorded.");
  }
  L.push("");
  if (withTrueTotal && Array.isArray(oh.per_model) && oh.per_model.length) {
    L.push("### Orchestrator overhead by model", "", "| Model | Role | Messages | Cost |", "|---|---|---:|---:|");
    for (const e of oh.per_model) L.push(`| ${cell(e?.model ?? "?")} | ${cell(e?.role ?? "?")} | ${e?.messages ?? "—"} | ${usd(e?.cost_usd)} |`);
    L.push("");
  }

  L.push("## Provisional — re-run after closing this session", "");
  L.push("The collector reads the session's transcripts; run from inside a session that has not ended, it misses the session's own tail. Once the session is closed, run:", "");
  L.push("```", `node "${COLLECTOR_SCRIPT}" "${out}" --project-root "${resolve(projectRoot)}"`, "```", "");

  const files = linkedFiles(out);
  L.push("## Files", "");
  if (files.length) for (const f of files) L.push(`- [${f}](${f})`);
  else L.push("No run file was found beside this summary.");
  L.push("");

  const setAside = setAsideChecks(out);
  if (setAside.length) {
    L.push("## Checks set aside", "");
    L.push("A check that already failed before the run changed a file could not judge the change, so it was set aside for that file (the latest batch receipt of each packet):", "");
    for (const { path, checks } of setAside) {
      L.push(`- \`${path}\`: ${checks.map((c) => (c.id ? `\`${c.id}\`${c.run ? ` (\`${c.run}\`)` : ""}` : `\`${c.run}\``)).join("; ")}`);
    }
    L.push("");
  }

  if (keep) L.push(keep, "");
  return L.join("\n");
}

/**
 * Writes `<outDir>/SUMMARY.md` (renderRunSummary), keeping the acceptance block of the file it replaces. Returns the
 * path. Throws when the file cannot be written; the callers report that and go on, since the manifest is the record.
 */
export function writeRunSummary(outDir, manifest, { projectRoot } = {}) {
  const path = join(resolve(outDir), "SUMMARY.md");
  let keep = null;
  if (existsSync(path) && isFile(path)) keep = acceptanceBlock(readFileSync(path, "utf8"));
  writeFileSync(path, renderRunSummary(outDir, manifest, { projectRoot, keep }));
  return path;
}
