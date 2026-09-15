#!/usr/bin/env node
/**
 * Post-run report for an AI-SDLC pass.
 *
 * Usage: node tools/report.mjs <path-to-pass-directory> [--markdown]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";

import { ACTOR, ACTOR_LEGEND, gutter } from "./logfmt.mjs";

const argv = process.argv.slice(2);
const asMarkdown = argv.includes("--markdown");
const passDir = resolve(argv.filter((a) => !a.startsWith("--"))[0] ?? "");

if (!passDir || !existsSync(passDir)) {
  console.error("Usage: node tools/report.mjs <path-to-pass-directory> [--markdown]");
  console.error("Example: node tools/report.mjs examples/workforce-ops/passes/pass1");
  process.exit(2);
}

const telemetryPath = join(passDir, "telemetry.jsonl");
const manifestPath  = join(passDir, "manifest.json");

if (!existsSync(telemetryPath)) {
  console.error(`No telemetry.jsonl found in ${passDir}.`);
  console.error("Confirm the run finished and produced this file.");
  process.exit(2);
}

const allEvents = readFileSync(telemetryPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// Partition FIRST, mirroring buildManifest: the post-run collector
// (plugin/scripts/collect-orchestrator-usage.mjs) appends a
// `tier: "orchestrator"` event carrying the run's OWN loop cost,
// reconstructed from session transcripts. Without this split that event
// would land in the "Runner overhead" bucket below and silently blend the
// two spends — the exact failure the collector exists to prevent. Every
// aggregation below runs on dispatched events only; the overhead is
// rendered as its own labeled line in Costs.
const events = allEvents.filter((e) => e.tier !== "orchestrator");
const orchEvents = allEvents.filter((e) => e.tier === "orchestrator");

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

// SDLC-productive phases; everything else is "runner overhead" (planning,
// reads, debug loops, shell).
const SDLC_PHASES = new Set([
  "requirements_analysis",
  "architecture_design",
  "plan_task_packets",
  "codegen",
  "tests",
  "docs",
  "senior_code_review",
  "security_review",
  "test_run",
]);

// `provenance` field per orchestrator rule 6:
//   "vendor"    — real vendor-reported tokens
//   "estimated" — char/3.8 heuristic for direct-tier calls under estimator mode
//   absent      — legacy pre-rule-6; reported as "unknown"
const phaseAgg = new Map(); // phase → {calls, tokIn, tokOut, cost, provCounts}
let sdlcCost = 0, sdlcCalls = 0;
let overheadCost = 0, overheadCalls = 0;
let totalIn = 0, totalOut = 0, totalCached = 0;
let vendorEvents = 0, estimatedEvents = 0, unknownEvents = 0;
let vendorCost = 0, estimatedCost = 0;

// Collapse doubling attempts into one per-packet record (same task_id).
const packetAgg = new Map(); // task_id → {phase, module, model, attempts, finalCeiling, totalCost, terminal}

for (const e of events) {
  const p = e.phase ?? "unknown";
  const isSdlc = SDLC_PHASES.has(p);
  // Tokens-in includes the cache-write bucket (absent on older telemetry):
  // cache writes ARE input the vendor billed for, and keeping them in this
  // column preserves continuity with reports rendered before the bucket
  // was split out.
  const tokIn = (e.input_tokens ?? 0) + (e.input_tokens_cache_write ?? 0);
  const tokOut = e.output_tokens ?? 0;
  const cached = e.input_tokens_cached ?? 0;
  const cost = e.cost_usd ?? 0;
  const prov = e.provenance ?? "unknown";

  totalIn  += tokIn;
  totalOut += tokOut;
  totalCached += cached;
  if (isSdlc) { sdlcCost += cost; sdlcCalls += 1; }
  else        { overheadCost += cost; overheadCalls += 1; }

  if      (prov === "vendor")    { vendorEvents++;    vendorCost += cost; }
  else if (prov === "estimated") { estimatedEvents++; estimatedCost += cost; }
  else                            { unknownEvents++; }

  const rec = phaseAgg.get(p) ?? { calls: 0, tokIn: 0, tokOut: 0, cost: 0, sdlc: isSdlc, provCounts: { vendor: 0, estimated: 0, unknown: 0 } };
  rec.calls += 1;
  rec.tokIn += tokIn;
  rec.tokOut += tokOut;
  rec.cost += cost;
  rec.provCounts[prov === "vendor" ? "vendor" : prov === "estimated" ? "estimated" : "unknown"]++;
  phaseAgg.set(p, rec);

  // Only packets whose events carry attempt fields — older telemetry
  // contributes nothing.
  const tid = e.task_id;
  if (tid && (e.attempt_number != null || e.ceiling_used != null)) {
    const pkt = packetAgg.get(tid) ?? {
      task_id: tid,
      phase: p,
      module: e.module ?? "?",
      model: e.model ?? "?",
      attempts: 0,
      initialCeiling: e.ceiling_used ?? null,
      finalCeiling: e.ceiling_used ?? null,
      totalCost: 0,
      lastSuccess: false,
    };
    pkt.attempts += 1;
    if (pkt.initialCeiling == null || (e.attempt_number ?? 1) === 1) {
      pkt.initialCeiling = e.ceiling_used ?? pkt.initialCeiling;
    }
    if (e.ceiling_used != null) pkt.finalCeiling = e.ceiling_used;
    pkt.totalCost += cost;
    pkt.lastSuccess = e.success === true;
    packetAgg.set(tid, pkt);
  }
}

const packetsWithDoublings = [...packetAgg.values()]
  .filter((p) => p.attempts > 1)
  .sort((a, b) => b.attempts - a.attempts);

// Any non-vendor event taints the whole run's label.
const runMode =
  vendorEvents > 0 && estimatedEvents === 0 && unknownEvents === 0 ? "vendor" :
  estimatedEvents > 0 && vendorEvents === 0                        ? "estimated" :
  vendorEvents > 0 && estimatedEvents > 0                          ? "mixed" :
                                                                     "unknown";
const provTag = (rec) =>
  rec.provCounts.vendor === rec.calls    ? "V" :
  rec.provCounts.estimated === rec.calls ? "E" :
  rec.provCounts.unknown === rec.calls   ? "?" :
                                           "M"; // mixed within phase

const totalCost = sdlcCost + overheadCost;
const sessionCost = manifest.total_cost_usd ?? totalCost;

// Orchestrator overhead — the run's own loop, measured post-run from session
// transcripts. The manifest block is authoritative (the collector writes
// event + manifest together); summing the telemetry events is the fallback
// for a manifest that predates the collector run. `hasOverhead` false means
// the collector has not run and every dollar below is dispatched-work only.
const orchCost =
  manifest.orchestrator_overhead?.cost_usd ??
  (orchEvents.length > 0
    ? orchEvents.reduce((s, e) => s + (e.cost_usd ?? 0), 0)
    : null);
const hasOverhead = orchCost != null;
// Written by the collector since the receipt/in-session fix: the dispatched
// dollars that ran inside the session and were subtracted once. Absent on
// manifests patched by the earlier collector, whose true total added both.
const inSessionSubtracted = manifest.orchestrator_overhead?.dispatched_in_session_cost_usd ?? null;
const trueTotalLabel = inSessionSubtracted != null ? "True total (dispatched − in-session + orchestrator)" : "True total (dispatched + orchestrator)";
// Whether the overhead figure was checked against Claude Code's own receipt.
const receiptCost = manifest.orchestrator_overhead?.receipt_cost_usd ?? null;
const costSource = manifest.orchestrator_overhead?.cost_source ?? null;
// The collector's cost_source vocabulary, matched by prefix:
//   "receipt (Anthropic token counts…)"  no transcript bucket above the receipt, and the window provably its invocation (or
//                                    every bucket equal): verified, the receipt's token counts booked at the price list
//   "receipt (transcript agrees…)"   collected before v0.7.3: every bucket equal, Claude Code's own dollars booked
//   "receipt-only"                   no transcript message fell in the window; the receipt's token counts at the list stand
//                                    alone (before v0.7.3, its dollars)
//   "receipt for the last invocation (Anthropic token counts…)"   a --resume continuation (v0.7.3 Q1): the last leg's receipt
//                                    booked at the price list, the earlier legs transcript-priced: partly verified
//   "transcript (receipt covers only the last invocation…)"   the same case collected before Q1: only the last leg was
//                                    checked, and the whole window was transcript-priced
//   "transcript (receipt pending…)"  the headless capture has no result line yet
//   "transcript (no receipt…)"       nothing to verify against
//   "transcript (receipt-verified…)" / "transcript"   written by the collector BEFORE the exact rule (a 5% tolerance,
//                                    receipt as a floor): say so, and ask for a re-collect rather than call it verified
const receiptUSD = receiptCost != null ? `$${receiptCost.toFixed(4)}` : "n/a";

// ─── v0.7.3 orchestrator fields (Fix E) ───────────────────────────────
// Beside the figures above, the v0.7.3 collector writes: per_model (the
// transcript's cost per model and role, one entry per price), unlogged_billed
// (what a booked receipt billed that no transcript message recorded),
// attribution_complete with missing_helper_ids / unreferenced_helper_files,
// unpriced, price_basis "custom" on a per_model entry priced by a policy's
// pricing_override card, receipt_cli_usd (Claude Code's own figure, a check
// only) and price_list_verified. Before, the report printed one orchestrator
// figure: a Fable 5.1 session with Opus 5 helpers read as one number, an
// interactive transcript figure read as the whole bill although Claude Code
// bills calls it never logs, and a booked receipt printed Claude Code's own
// dollars as if they were booked. Every line below keys on a field no earlier
// collector wrote, so an older manifest renders exactly as before
// (tools/test/report-old-manifests.test.mjs). The manifest block is read
// first; the collector's orchestrator event carries the same fields and stands
// in when the manifest has not been patched.
const ohFields = manifest.orchestrator_overhead ?? orchEvents.at(-1) ?? null;
const perModel = Array.isArray(ohFields?.per_model) ? ohFields.per_model : null;
const unlogged = ohFields?.unlogged_billed != null && typeof ohFields.unlogged_billed === "object" ? ohFields.unlogged_billed : null;
// Only a booked receipt writes unlogged_billed: the figure is the receipt's
// token counts at the price list, not a transcript measurement, and the labels say so.
const receiptBooked = unlogged != null;
// Q1: a receipt booked for a resumed window's last invocation covers that
// invocation only; the earlier invocations in the figure are still transcript-measured.
const partlyBooked = typeof costSource === "string" && costSource.startsWith("receipt for the last invocation");
const overheadHow = partlyBooked
  ? "last invocation's receipt tokens at the price list, earlier invocations transcript-measured"
  : receiptBooked ? "receipt tokens at the price list" : "transcript-measured";

// Claude Code's own figure beside a v0.7.3 booked receipt: a check, never the
// booked figure. Its distance from the booked figure is stated past 0.5%, the
// collector's own note threshold (a stale Claude Code price table shows here).
const cliCheck = () => {
  const cli = ohFields?.receipt_cli_usd ?? receiptCost;
  if (cli == null) return "";
  // v0.7.3 review fix: Claude Code's figure bills only the booked part, so it is
  // measured against that part's list figure (booked_cost_usd). On a resumed
  // run cost_usd also holds the earlier, transcript-priced invocations, and a
  // run that matched to the cent printed "14.43% below the booked figure".
  // A manifest from before the field falls back to cost_usd, as it rendered then.
  const booked = ohFields?.booked_cost_usd ?? ohFields?.cost_usd;
  const pct = booked ? ((cli - booked) / booked) * 100 : 0;
  const drift = Math.abs(pct) > 0.5 ? ` (${Math.abs(pct).toFixed(2)}% ${pct > 0 ? "above" : "below"} the booked figure)` : "";
  return `Claude Code's own figure, $${cli.toFixed(4)}, is a check and never booked${drift}`;
};

const verifiedLine = costSource == null
  ? null
  // v0.7.3 labels first: each also starts with a pre-v0.7.3 prefix below.
  // Q1: a resumed window whose receipt was booked for its last invocation only.
  // It starts with "receipt", so without this branch it would read as fully verified.
  : costSource.startsWith("receipt for the last invocation")
    ? `PARTLY VERIFIED — ${costSource}; the receipt's token counts are booked for the last invocation only, the earlier ones are transcript-priced${cliCheck() ? `; ${cliCheck()}` : ""}`
  : costSource.startsWith("receipt-only (Anthropic token counts")
    ? `Booked from the receipt's token counts at the price list (${costSource}); no transcript message fell inside the window to cross-check it${cliCheck() ? `, and ${cliCheck()}` : ""}`
  : costSource.startsWith("receipt (Anthropic token counts")
    ? `Verified against Claude Code's own receipt (${costSource})${cliCheck() ? `; ${cliCheck()}` : ""}`
  : costSource.startsWith("receipt-only")
    ? `Booked from Claude Code's own receipt (${receiptUSD}); no transcript message fell inside the window to cross-check it`
  : costSource.startsWith("receipt")
    ? `Verified against Claude Code's own receipt (${receiptUSD}; ${costSource})`
  : costSource.startsWith("transcript (receipt covers only")
    ? `PARTLY VERIFIED — ${costSource}; the receipt (${receiptUSD}) bills only the last invocation, the earlier ones are transcript-priced`
  : costSource.startsWith("transcript (receipt pending")
    ? `PROVISIONAL — ${costSource}; the headless capture has no result line yet, re-run the collector after the session exits`
  : costSource.startsWith("transcript (receipt-verified") || costSource === "transcript"
    ? `COLLECTED UNDER THE OLD RULE — ${costSource}; that check allowed a 5% shortfall and any excess, re-run the collector to verify exactly`
    : `UNVERIFIED — ${costSource}; no receipt was found beside the manifest, re-run the collector after a headless session exits, or keep its claude -p result`;
// The window the collector measured, when the manifest records one (written since the command-turn anchor).
const win = manifest.orchestrator_overhead?.window ?? null;
const windowLine = win == null
  ? null
  : `Window ${win.start} → ${win.end ?? "end of session"} (${win.exact ? "exact" : "approximate"}: opens at ${win.start_anchor}, closes at ${win.end_anchor}${win.session_id ? `; session ${win.session_id}` : ""})`;
const trueTotal = manifest.true_total_cost_usd ?? (hasOverhead ? sessionCost + orchCost : null);
const collectorCmd = `node plugin/scripts/collect-orchestrator-usage.mjs ${passDir}`;

// ─── formatting helpers ──────────────────────────────────────────────
const fmtUSD = (n) => `$${n.toFixed(4)}`;
const fmtCompact = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
const fmtDuration = (sec) => {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
};

// ─── render ───────────────────────────────────────────────────────────
const passName = manifest.pass_name ?? manifest.pass ?? basename(passDir);
// Runs write `policy`; `buildManifest`'s shape says `policy_name`. Read both,
// or the header renders "—" for every real run.
const policy = manifest.policy ?? manifest.policy_name ?? "—";
const started = manifest.started_at ?? "—";
const duration = fmtDuration(manifest.duration_sec ?? manifest.total_wall_clock_sec ?? 0);

const line = "─".repeat(66);
const header = `Workforce Ops · ${basename(passDir)} · ${policy} · ${started}`;
const modeLabel =
  runMode === "vendor"    ? "Vendor-authoritative" :
  runMode === "estimated" ? "Estimator mode"       :
  runMode === "mixed"     ? "Mixed (vendor + estimator)" :
                            "Unknown provenance";
const modeHint =
  runMode === "vendor"    ? "every event carries real Anthropic / Google usage — reconcilable to your API dashboard" :
  runMode === "estimated" ? "direct-tier events are char/3.8 estimated; total will drift from vendor-billed" :
  runMode === "mixed"     ? "MCP-dispatched events are vendor-reported; direct-tier events are estimated" :
                            "pre-provenance telemetry; run again with today's orchestrator to get a labeled report";
// Scope sits right beside Mode: which spends this report's dollars cover.
const scopeLabel = hasOverhead
  ? "dispatched work + orchestrator overhead"
  : "dispatched work only — excludes orchestrator overhead";
const scopeHint = hasOverhead
  ? `the run's own loop (${fmtUSD(orchCost)}, ${overheadHow}) is a separate line in Costs, never blended into dispatched totals`
  : "the orchestrator's own loop never passes through the MCP server; measure and add it with the collector (see Costs)";

// The v0.7.3 orchestrator lines, printed under the true total beside the
// verification and window lines (without their trailing period). Each is keyed
// on a field only the v0.7.3 collector writes; see "v0.7.3 orchestrator fields".
const roleName = (role) => (role === "helper" ? "helpers" : "session");
const fmtCount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const tokenTotal = (tokens) => Object.values(tokens ?? {}).reduce((s, n) => s + (Number(n) || 0), 0);
// One figure per role and model: per_model has one entry per PRICE, so a model
// that crossed a price period or ran partly in fast mode has several entries.
// Session before helpers, then the larger figure first.
const byRoleModel = (entries) => {
  const sums = new Map();
  for (const e of entries) {
    // JSON key: a role or model name can never collide across the pair.
    const key = JSON.stringify([e.role, e.model]);
    const s = sums.get(key) ?? { role: e.role, model: e.model, cost: 0 };
    s.cost += e.cost_usd ?? 0;
    sums.set(key, s);
  }
  const rank = (role) => (role === "session" ? 0 : role === "helper" ? 1 : 2);
  return [...sums.values()].sort((a, b) => rank(a.role) - rank(b.role) || b.cost - a.cost || a.model.localeCompare(b.model));
};
const orchLines = [];
if (perModel && perModel.length > 0) {
  // Which model the session and its helpers ran on, and what each cost. For a
  // booked receipt these are the logged messages; the unlogged rest is the next line.
  orchLines.push(
    `By model: ${byRoleModel(perModel).map((s) => `${roleName(s.role)} (${s.model}): ${fmtUSD(s.cost)}`).join(" · ")}` +
      (ohFields.price_list_verified ? ` (price list verified ${ohFields.price_list_verified})` : ""),
  );
}
if (unlogged) {
  // Headless: the receipt billed these tokens and no transcript message recorded them
  // (calls Claude Code never logs, or a helper transcript that was not read).
  const gap = (unlogged.per_model ?? []).map((g) => `${g.model}${g.receipt_only ? " (receipt only)" : ""} ${fmtUSD(g.cost_usd ?? 0)}`);
  orchLines.push(
    `Of the booked receipt, billed but not logged: ${fmtUSD(unlogged.cost_usd ?? 0)} (${Number(unlogged.pct_of_booked ?? 0).toFixed(2)}%)` +
      (gap.length ? ` — ${gap.join(" · ")}` : ""),
  );
} else if (perModel) {
  // Interactive (or any figure not booked from a receipt): the transcript is all
  // there is, and it misses what Claude Code bills without logging, measured at
  // 2.3% (Sep 10 2026 headless run) and 22% (another measured run).
  orchLines.push("No receipt booked, so this is a floor: excludes calls Claude Code bills but does not log (2.3%–22% on measured runs)");
}
const customEntries = (perModel ?? []).filter((e) => e.price_basis === "custom");
if (customEntries.length > 0) {
  orchLines.push(
    `Custom price, from the policy's pricing_override card and not the price list: ` +
      byRoleModel(customEntries).map((s) => `${roleName(s.role)} (${s.model}) ${fmtUSD(s.cost)}`).join(" · "),
  );
}
const unpricedParts = [
  ...(Array.isArray(ohFields?.unpriced) ? ohFields.unpriced : []).map(
    (u) => `${roleName(u.role)} (${u.model}) ${fmtCount(tokenTotal(u.tokens))} tokens${u.messages != null ? ` on ${u.messages} message(s)` : ""}, ${u.reason}`,
  ),
  ...(Array.isArray(unlogged?.unpriced) ? unlogged.unpriced : []).map(
    (u) => `billed but not logged (${u.model}) ${fmtCount(tokenTotal(u.tokens))} tokens, ${u.reason}`,
  ),
];
if (unpricedParts.length > 0) orchLines.push(`Unpriced, so in no figure above: ${unpricedParts.join(" · ")}`);
if (ohFields?.attribution_complete === false) {
  // What a missing or unnamed helper file does to the figures depends on whether a receipt was booked.
  const missing = ohFields.missing_helper_ids ?? [];
  const unreferenced = ohFields.unreferenced_helper_files ?? [];
  const parts = [];
  if (missing.length) parts.push(`helper(s) ${missing.join(", ")} named by an Agent/Task result have no transcript file`);
  if (unreferenced.length) parts.push(`${unreferenced.length} helper file(s) named by no Agent/Task result (${unreferenced.join(", ")})`);
  if (!parts.length) parts.push("a helper transcript and the Agent/Task results that name helpers do not match");
  const consequence = !missing.length
    ? "their tokens are counted, only the helper call they came from is unknown"
    : receiptBooked
      ? "the booked total is unaffected, but their tokens sit in billed but not logged instead of By model"
      : "their tokens are in no figure above — copy the session's whole subagents/ directory and re-run the collector";
  orchLines.push(`Attribution incomplete: ${[...parts, consequence].join("; ")}`);
}

if (asMarkdown) {
  console.log(`# ${header}\n`);
  console.log(`**Mode: ${modeLabel}** — ${modeHint}\n`);
  console.log(`**Scope: ${scopeLabel}** — ${scopeHint}\n`);
  console.log(`## SDLC task run\n`);
  console.log(`| Phase | Prov | Calls | Tokens (in / out) | Cost |`);
  console.log(`|---|:---:|---:|---|---:|`);
} else {
  console.log(`\n┌${line}┐`);
  console.log(`│ ${header.padEnd(64)} │`);
  console.log(`└${line}┘\n`);
  console.log(`Mode: ${modeLabel}`);
  console.log(`  ${modeHint}`);
  console.log(`Scope: ${scopeLabel}`);
  console.log(`  ${scopeHint}\n`);
  console.log(`SDLC task run\n`);
  console.log(`  ${"Phase".padEnd(24)}${"Prov".padStart(6)}${"Calls".padStart(7)}${"Tokens (in / out)".padStart(22)}${"Cost".padStart(11)}`);
  console.log(`  ${"─".repeat(24 + 6 + 7 + 22 + 11)}`);
}

// SDLC rows in a stable order, then any remaining phases
const preferredOrder = ["requirements_analysis", "architecture_design", "plan_task_packets", "codegen", "tests", "docs", "test_run", "senior_code_review", "security_review"];
const seen = new Set();
const sdlcRows = [];
for (const p of preferredOrder) {
  if (phaseAgg.has(p)) { sdlcRows.push([p, phaseAgg.get(p)]); seen.add(p); }
}
for (const [p, rec] of phaseAgg) {
  if (!seen.has(p) && rec.sdlc) sdlcRows.push([p, rec]);
}

for (const [phase, rec] of sdlcRows) {
  const tokStr = `${fmtCompact(rec.tokIn)} / ${fmtCompact(rec.tokOut)}`;
  const tag = provTag(rec);
  if (asMarkdown) {
    console.log(`| \`${phase}\` | ${tag} | ${rec.calls} | ${tokStr} | ${fmtUSD(rec.cost)} |`);
  } else {
    console.log(`  ${phase.padEnd(24)}${tag.padStart(6)}${String(rec.calls).padStart(7)}${tokStr.padStart(22)}${fmtUSD(rec.cost).padStart(11)}`);
  }
}

if (asMarkdown) {
  console.log(`| **SDLC task total** |  |  |  | **${fmtUSD(sdlcCost)}** |\n`);
  console.log(`_Prov key: V = vendor-authoritative, E = estimated, M = mixed within phase, ? = pre-provenance legacy._\n`);
} else {
  console.log(`  ${"─".repeat(24 + 6 + 7 + 22 + 11)}`);
  console.log(`  ${"SDLC task total".padEnd(59)}${fmtUSD(sdlcCost).padStart(11)}\n`);
  console.log(`  Prov key: V = vendor-authoritative, E = estimated, M = mixed, ? = legacy\n`);
}

// Delegation section — receipts join to telemetry on task_id. A retried
// packet's receipt describes the LAST attempt while telemetry's cost covers
// ALL attempts; markers on the row flag the difference.
const delegationDir = join(passDir, "delegation");
const delegationFiles = existsSync(delegationDir)
  ? readdirSync(delegationDir).filter((n) => n.startsWith("worker-delegation-") && n.endsWith(".json")).sort()
  : [];

let unreadableReceipts = 0;
const receipts = delegationFiles
  .map((n) => {
    try {
      return JSON.parse(readFileSync(join(delegationDir, n), "utf8"));
    } catch {
      // Counted and named below rather than dropped silently.
      unreadableReceipts += 1;
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

if (receipts.length || unreadableReceipts) {
  // Per-task telemetry, recomputed locally to keep this block self-contained.
  const byTask = new Map();
  for (const e of events) {
    if (!e.task_id) continue;
    const r = byTask.get(e.task_id) ?? { calls: 0, cost: 0 };
    r.calls += 1;
    r.cost += e.cost_usd ?? 0;
    byTask.set(e.task_id, r);
  }

  const rows = receipts.map((d) => {
    const tel = byTask.get(d.task_id);
    return {
      d,
      tries: tel?.calls ?? 1,
      // Prefer telemetry (covers every attempt) over receipt (last attempt only).
      cost: tel ? tel.cost : (d.cost_usd ?? 0),
      joined: Boolean(tel),
    };
  });

  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const delegatedCalls = sum((r) => (r.joined ? r.tries : 0));
  const delegatedCost = sum((r) => (r.joined ? r.cost : 0));
  const otherCalls = events.length - delegatedCalls;
  const otherCost = totalCost - delegatedCost;

  const toolTotal = sum((r) => r.d.tool_calls?.count ?? 0);
  const fileTotal = { added: 0, modified: 0, removed: 0 };
  for (const r of rows) {
    fileTotal.added += r.d.files?.added?.length ?? 0;
    fileTotal.modified += r.d.files?.modified?.length ?? 0;
    fileTotal.removed += r.d.files?.removed?.length ?? 0;
  }

  // `+` added, `~` modified, `-` removed; zero terms omitted.
  const fmtFiles = (f) =>
    [
      f.added ? `+${f.added}` : "",
      f.modified ? `~${f.modified}` : "",
      f.removed ? `-${f.removed}` : "",
    ].filter(Boolean).join(" ") || "none";
  const filesOf = (d) =>
    fmtFiles({
      added: d.files?.added?.length ?? 0,
      modified: d.files?.modified?.length ?? 0,
      removed: d.files?.removed?.length ?? 0,
    });

  // Markers explained under the table.
  const marks = (r) =>
    (r.tries > 1 ? "*" : "") + (r.d.success === false ? "!" : "") + (r.joined ? "" : "?");

  const anyRetry = rows.some((r) => r.tries > 1);
  const anyFailure = rows.some((r) => r.d.success === false);
  const anyUnjoined = rows.some((r) => !r.joined);
  const anyTruncated = rows.some((r) => r.d.files?.truncated);
  const anyUnreadablePath = rows.some((r) => (r.d.files?.unreadable?.length ?? 0) > 0);

  const lead =
    `${delegatedCalls} of this run's ${events.length} model calls were delegations: the packet went to ` +
    `an agent running inside the working directory, with tools, instead of being answered in one completion.`;

  const notes = [
    "Files compares a content digest of the working directory taken immediately",
    "before the worker starts against one taken immediately after it exits, with",
    "the worker's own output directory excluded. It reports what changed while the",
    "worker held the directory — not proof that nothing else was running in it, and",
    "not an attribution of any one change to any one tool call.",
  ];
  if (anyRetry) notes.push("* retried — cost covers every attempt; tools, files and time are the last one.");
  if (anyFailure) notes.push("! the worker did not finish; it was still billed, and may still have edited files.");
  if (anyUnjoined) notes.push("? no telemetry event carries this task id, so cost is the receipt's own figure.");
  if (anyTruncated) notes.push(`A file scan hit its cap; those counts are a floor, not a total.`);
  if (anyUnreadablePath) notes.push("Some paths could not be read during a scan; they are listed in the receipt.");
  if (unreadableReceipts) {
    notes.push(
      `${unreadableReceipts} receipt${unreadableReceipts === 1 ? "" : "s"} in ${basename(delegationDir)}/ could not be parsed ` +
        `and ${unreadableReceipts === 1 ? "is" : "are"} missing from this table.`,
    );
  }
  // Door-comparison guard: this table is where driver-vs-worker (model door
  // vs agent door) reads happen, and its rows are dispatched work only. The
  // orchestrator's own loop dwarfed dispatched totals ~100× on measured
  // runs — enough to invert the comparison — so the warning is strong until
  // the collector has run and softens to a pointer once it has.
  notes.push(
    hasOverhead
      ? "These rows are dispatched work; the orchestrator's own loop is a separate line in Costs and only the true total there compares architectures fairly."
      : "These rows are dispatched work ONLY — the orchestrator's own loop is in no number here. Do not compare architectures (model door vs agent door) from this table; run the collector first (see Costs).",
  );
  notes.push(`One receipt per delegation: ${basename(delegationDir)}/worker-delegation-<packet>.json`);

  // Escape *, <, > for the Markdown branch — plain glyphs for the terminal,
  // which is the primary reader.
  const md = (s) =>
    String(s).replace(/[*<>]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "\\*"));

  if (asMarkdown) {
    console.log(`## Delegated to an agent worker\n`);
    console.log(`${lead}\n`);
    for (const [tag, meaning] of ACTOR_LEGEND) console.log(`- \`${tag}\` — ${meaning}`);
    console.log("");
    // Header carries the handoff tag — every line under it is a packet
    // leaving the harness for a worker.
    console.log(`| \`${ACTOR.handoff}\` | Phase | Packet | Tool calls | Files | Time | Cost |`);
    console.log(`|---|---|---|---:|---|---:|---:|`);
    for (const r of rows) {
      console.log(
        `| \`${ACTOR.worker}\` | \`${r.d.phase ?? "—"}\` | \`${r.d.task_id}\`${md(marks(r))} | ` +
          `${r.d.tool_calls?.count ?? 0}${r.d.tool_calls?.truncated ? "+" : ""} | ${filesOf(r.d)} | ` +
          `${fmtDuration((r.d.duration_ms ?? 0) / 1000)} | ${fmtUSD(r.cost)} |`,
      );
    }
    console.log(
      `| | **${rows.length} delegation${rows.length === 1 ? "" : "s"}** | | **${toolTotal}** | ` +
        `**${fmtFiles(fileTotal)}** | | **${fmtUSD(delegatedCost)}** |`,
    );
    console.log(`| \`${ACTOR.driver}\` | everything else in this run | ${otherCalls} calls | | | | ${fmtUSD(otherCost)} |\n`);
    for (const n of notes) console.log(`_${md(n)}_  `);
    console.log("");
  } else {
    const w = 74;
    console.log(`Delegated to an agent worker\n`);
    console.log(`  ${lead.replace(/(.{1,70})(\s|$)/g, "$1\n  ").trimEnd()}\n`);
    for (const [tag, meaning] of ACTOR_LEGEND) console.log(`  ${gutter(tag)}${meaning}`);
    console.log("");
    console.log(
      `  ${gutter(ACTOR.handoff)}${"Phase".padEnd(14)}${"Packet".padEnd(20)}${"Tools".padStart(6)}${"Files".padStart(10)}${"Time".padStart(8)}${"Cost".padStart(10)}`,
    );
    console.log(`  ${"─".repeat(w)}`);
    for (const r of rows) {
      const tools = `${r.d.tool_calls?.count ?? 0}${r.d.tool_calls?.truncated ? "+" : ""}`;
      console.log(
        `  ${gutter(ACTOR.worker)}${String(r.d.phase ?? "—").padEnd(14)}` +
          `${(r.d.task_id + marks(r)).padEnd(20)}${tools.padStart(6)}${filesOf(r.d).padStart(10)}` +
          `${fmtDuration((r.d.duration_ms ?? 0) / 1000).padStart(8)}${fmtUSD(r.cost).padStart(10)}`,
      );
    }
    console.log(`  ${"─".repeat(w)}`);
    console.log(
      `  ${" ".repeat(6)}${`${rows.length} delegation${rows.length === 1 ? "" : "s"}`.padEnd(34)}` +
        `${String(toolTotal).padStart(6)}${fmtFiles(fileTotal).padStart(10)}${"".padStart(8)}${fmtUSD(delegatedCost).padStart(10)}`,
    );
    console.log(
      `  ${gutter(ACTOR.driver)}${"everything else in this run".padEnd(34)}` +
        `${"".padStart(6)}${`${otherCalls} calls`.padStart(10)}${"".padStart(8)}${fmtUSD(otherCost).padStart(10)}\n`,
    );
    for (const n of notes) console.log(`  ${n}`);
    console.log("");
  }
}

// Run stats
if (asMarkdown) {
  console.log(`## Run stats\n`);
  console.log(`- Wall-clock: ${duration}`);
  console.log(`- Model calls: ${events.length}`);
  const arts = manifest.artifacts?.code_files?.length ?? (manifest.artifacts?.files ?? "—");
  console.log(`- Code files produced: ${arts}`);
  console.log("");
} else {
  console.log(`  Wall-clock                                                ${duration}`);
  console.log(`  Model calls                                              ${String(events.length).padStart(4)}`);
  const arts = manifest.artifacts?.code_files?.length ?? (manifest.artifacts?.files ?? "—");
  console.log(`  Code files produced                                      ${String(arts).padStart(4)}\n`);
}

// Cost block. Total label depends on runMode.
const totalLabel =
  runMode === "vendor"    ? "Total (vendor-billed)" :
  runMode === "estimated" ? "Total (estimator sum)"  :
  runMode === "mixed"     ? "Total (mixed)"          :
                            "Total (unknown provenance)";
const totalNote =
  runMode === "vendor"    ? "reconcilable to your Anthropic + Google dashboards" :
  runMode === "estimated" ? "char/3.8 × policy rates; drift ±15% from vendor bill is normal" :
  runMode === "mixed"     ? "MCP dispatches vendor-billed; direct calls estimated" :
                            "provenance field missing from events";

// Three-number rendering when the collector has run (dispatched /
// orchestrator / true total — architecture comparisons only ever from the
// true total); otherwise the dispatched-only caveat plus the exact command
// that removes it. Either way no dollar renders without a scope label.
if (asMarkdown) {
  console.log(`## Costs\n`);
  console.log(`| Line | Amount |`);
  console.log(`|---|---:|`);
  console.log(`| SDLC task cost | ${fmtUSD(sdlcCost)} |`);
  console.log(`| Runner overhead | ${fmtUSD(overheadCost)} |`);
  if (runMode === "mixed") {
    console.log(`| — vendor-billed subtotal | ${fmtUSD(vendorCost)} |`);
    console.log(`| — estimator subtotal | ${fmtUSD(estimatedCost)} |`);
  }
  if (hasOverhead) {
    console.log(`| ${totalLabel} — dispatched work only | ${fmtUSD(sessionCost)} |`);
    console.log(`| Orchestrator overhead (${overheadHow}) | ${fmtUSD(orchCost)} |`);
    if (inSessionSubtracted != null && inSessionSubtracted > 0) {
      console.log(`| In-session dispatch, subtracted once | −${fmtUSD(inSessionSubtracted)} |`);
    }
    console.log(`| **${trueTotalLabel}** | **${fmtUSD(trueTotal)}** |\n`);
    if (verifiedLine) console.log(`_${verifiedLine}._\n`);
    if (windowLine) console.log(`_${windowLine}._\n`);
    for (const l of orchLines) console.log(`_${l}._\n`);
    // A booked receipt (v0.7.3) is the receipt's token counts, not a transcript reconstruction.
    const overheadFootnote = receiptBooked
      ? "The overhead line is the run's own loop: Claude Code's receipt token counts, checked against the session transcripts and priced at the price list by collect-orchestrator-usage.mjs; only the true total compares architectures fairly."
      : "The overhead line is the run's own loop, reconstructed from session transcripts by collect-orchestrator-usage.mjs; only the true total compares architectures fairly.";
    console.log(`_${totalNote}. ${overheadFootnote}_\n`);
    if (inSessionSubtracted == null && (runMode === "estimated" || runMode === "mixed")) {
      console.log(`_Estimator overlap: this run's estimated direct-tier events describe in-session work the transcript-measured overhead also contains, so the true total is conservative (double-counts up to ${fmtUSD(estimatedCost)})._\n`);
    }
  } else {
    console.log(`| **${totalLabel}** — dispatched work only | **${fmtUSD(sessionCost)}** |\n`);
    console.log(`_${totalNote}_\n`);
    console.log(`_**Excludes orchestrator overhead.** The orchestrator's own loop (reasoning, file reads, growing-conversation re-sends) never passes through the MCP server and is in no number above — on measured runs it exceeded the dispatched total ~100×. Measure and add it: \`${collectorCmd}\`_\n`);
  }
} else {
  console.log(`Costs\n`);
  console.log(`  SDLC task cost                                       ${fmtUSD(sdlcCost).padStart(9)}  (sum of SDLC-phase events)`);
  console.log(`  Runner overhead                                      ${fmtUSD(overheadCost).padStart(9)}  (planning / reads / debug)`);
  if (runMode === "mixed") {
    console.log(`    — vendor-billed subtotal                         ${fmtUSD(vendorCost).padStart(9)}  (${vendorEvents} events)`);
    console.log(`    — estimator subtotal                             ${fmtUSD(estimatedCost).padStart(9)}  (${estimatedEvents} events)`);
  }
  console.log(`  ${"─".repeat(24 + 6 + 7 + 22 + 11)}`);
  if (hasOverhead) {
    console.log(`  ${`${totalLabel} — dispatched work only`.padEnd(59)}${fmtUSD(sessionCost).padStart(11)}`);
    console.log(`  ${`Orchestrator overhead (${overheadHow})`.padEnd(59)}${fmtUSD(orchCost).padStart(11)}`);
    if (inSessionSubtracted != null && inSessionSubtracted > 0) {
      console.log(`  ${"In-session dispatch, subtracted once".padEnd(59)}${("−" + fmtUSD(inSessionSubtracted)).padStart(11)}`);
    }
    console.log(`  ${"─".repeat(24 + 6 + 7 + 22 + 11)}`);
    console.log(`  ${trueTotalLabel.padEnd(59)}${fmtUSD(trueTotal).padStart(11)}`);
    if (verifiedLine) console.log(`    ${verifiedLine}.`);
    if (windowLine) console.log(`    ${windowLine}.`);
    for (const l of orchLines) console.log(`    ${l}.`);
    console.log(`  ${modeHint === totalNote ? "" : "  " + totalNote}`);
    if (receiptBooked) {
      // A booked receipt (v0.7.3) is the receipt's token counts, not a transcript reconstruction.
      console.log(`    The overhead line is the run's own loop: Claude Code's receipt token`);
      console.log(`    counts, checked against the session transcripts and priced at the price`);
      console.log(`    list by collect-orchestrator-usage.mjs; only the true total compares`);
      console.log(`    architectures fairly.`);
    } else {
      console.log(`    The overhead line is the run's own loop, reconstructed from session`);
      console.log(`    transcripts by collect-orchestrator-usage.mjs; only the true total`);
      console.log(`    compares architectures fairly.`);
    }
    if (runMode === "estimated" || runMode === "mixed") {
      console.log(`    Estimator overlap: the estimated direct-tier events describe in-session`);
      console.log(`    work the transcript-measured overhead also contains, so the true total`);
      console.log(`    is conservative (double-counts up to ${fmtUSD(estimatedCost)}).`);
    }
    console.log("");
  } else {
    console.log(`  ${`${totalLabel} — dispatched work only`.padEnd(59)}${fmtUSD(sessionCost).padStart(11)}`);
    console.log(`  ${modeHint === totalNote ? "" : "  " + totalNote}`);
    console.log(`    EXCLUDES ORCHESTRATOR OVERHEAD: the orchestrator's own loop (reasoning,`);
    console.log(`    file reads, growing-conversation re-sends) never passes through the MCP`);
    console.log(`    server and is in no number above — on measured runs it exceeded the`);
    console.log(`    dispatched total ~100×. Measure and add it:`);
    console.log(`      ${collectorCmd}\n`);
  }
}

// Methodology — content shifts based on mode
const methLines =
  runMode === "vendor" ? [
    "Every event's tokens and cost came from the vendor's own usage block —",
    "Anthropic and Google responses are read verbatim into telemetry.jsonl.",
    "Cross-check the total against your Anthropic + Google API dashboards for",
    "the session's time window; they should match to within a few cents.",
    "See docs/methodology.md for the full derivation.",
  ] : runMode === "estimated" ? [
    "Every event's tokens are char-count estimated (≈3.8 chars/token) per",
    "plugin/agents/orchestrator.md rule 6, then multiplied by policy rates.",
    "This is the mode Claude Code subscription users run in — no API key",
    "means no per-call vendor usage is available to the subagent.",
    "To get vendor-authoritative numbers, set ANTHROPIC_API_KEY and rerun.",
    "See docs/methodology.md.",
  ] : runMode === "mixed" ? [
    "Mixed provenance run. Mechanical-tier events dispatched through the MCP",
    "server carry real vendor tokens; direct-tier events (subagent-handled)",
    "use the char/3.8 estimator per plugin/agents/orchestrator.md rule 6.",
    "See docs/methodology.md.",
  ] : [
    "This run's telemetry pre-dates the provenance field. Rerun with",
    "today's orchestrator for a labeled report. See docs/methodology.md.",
  ];
if (asMarkdown) {
  console.log(`## Methodology\n`);
  for (const l of methLines) console.log(`- ${l}`);
  console.log("");
} else {
  console.log(`Methodology`);
  for (const l of methLines) console.log(`  • ${l}`);
  console.log("");
}

// ─── Findings (n=1) ────────────────────────────────────────────────────
const findingsPreamble = [
  "This is n=1. Generation tasks have material run-to-run variance under",
  "identical settings. Before drawing conclusions about a policy's cost-quality",
  "profile from any number on this report, run at least 5 independent passes",
  "and report the distribution, not a single point.",
];
if (asMarkdown) {
  console.log(`## Findings from this run (n=1)\n`);
  for (const l of findingsPreamble) console.log(`> ${l}`);
  console.log("");
} else {
  console.log(`Findings from this run (n=1)`);
  for (const l of findingsPreamble) console.log(`  ${l}`);
  console.log("");
}

// Output-ceiling doubling — factual list.
if (packetsWithDoublings.length > 0) {
  if (asMarkdown) {
    console.log(`### Packets that needed output-ceiling doublings\n`);
    console.log(`Each row is one TaskPacket whose first attempt hit the vendor max-tokens signal, triggering the adapter's doubling loop. \`Final ceiling\` is the max_tokens the packet ultimately converged under (or terminated at, if it exhausted the doubling budget). Cost is the sum across attempts; cached input keeps retry cost low. This is descriptive, not diagnostic — a packet needing doublings on one run may fit first-shot on another.\n`);
    console.log(`| Packet | Phase | Model | Attempts | Initial → final ceiling | Cost across attempts | Terminal |`);
    console.log(`|---|---|---|---:|---|---:|---|`);
    for (const p of packetsWithDoublings) {
      const terminal = p.lastSuccess ? "converged" : "still truncated";
      console.log(
        `| \`${p.task_id}\` | ${p.phase} | ${p.model} | ${p.attempts} | ${p.initialCeiling} → ${p.finalCeiling} | ${fmtUSD(p.totalCost)} | ${terminal} |`
      );
    }
    console.log("");
  } else {
    console.log(`Packets that needed output-ceiling doublings\n`);
    console.log(`  ${"Packet".padEnd(24)}${"Phase".padEnd(22)}${"Model".padEnd(22)}${"Att".padStart(4)}  ${"Init→Final".padStart(14)}  ${"Cost".padStart(10)}  Terminal`);
    for (const p of packetsWithDoublings) {
      const terminal = p.lastSuccess ? "converged" : "still truncated";
      console.log(
        `  ${p.task_id.padEnd(24)}${p.phase.padEnd(22)}${p.model.padEnd(22)}${String(p.attempts).padStart(4)}  ${`${p.initialCeiling}→${p.finalCeiling}`.padStart(14)}  ${fmtUSD(p.totalCost).padStart(10)}  ${terminal}`
      );
    }
    console.log("");
  }
}

const nextIterations = [
  ["Run 5+ independent passes under identical settings and report the cost / completion-rate distribution rather than a single-point number.",
   "Why: n=1 conclusions about generation quality are known to be unreliable; distribution reveals whether an outcome is systematic or a tail draw.",
   "Pitfall: 5× the wall-clock and API spend per policy under study."],
  ["If any packets terminated as 'still truncated', re-run with a higher initial ceiling for that phase's packet template.",
   "Why: doubling from too-low an initial burns extra output tokens on the retries before converging; a moderate raise of the initial catches large files first-shot.",
   "Pitfall: raising the initial across the board pays extra ceiling on every packet, most of which don't need it."],
  ["Cross-check the report's total against the vendor dashboard for the run's time window.",
   // From v0.7.3 a dispatch bills the dated price list (or a pricing_override
   // card) and stamps price_basis, so a divergence can no longer be YAML drift.
   // Runs without price_basis billed the policy YAML; they keep the sentence
   // that was true for them, byte for byte (report-old-manifests.test.mjs).
   events.some((e) => e.price_basis != null)
     ? "Why: the only end-to-end integrity check for vendor-authoritative mode; a material divergence means a telemetry gap, a stale period on the dated price list (plugin/mcp/model-dispatch/src/prices.ts), or a policy's pricing_override card."
     : "Why: the only end-to-end integrity check for vendor-authoritative mode; a material divergence means either a telemetry gap or a pricing-YAML drift.",
   "Pitfall: dashboards aggregate by API key, so mixing keys or running other work in the window contaminates the comparison."],
];
if (asMarkdown) {
  console.log(`### Suggested next iterations\n`);
  for (const [what, why, pitfall] of nextIterations) {
    console.log(`- **${what}**`);
    console.log(`  - _Why:_ ${why}`);
    console.log(`  - _Pitfall:_ ${pitfall}`);
  }
  console.log("");
} else {
  console.log(`Suggested next iterations`);
  for (const [what, why, pitfall] of nextIterations) {
    console.log(`  • ${what}`);
    console.log(`      Why:     ${why}`);
    console.log(`      Pitfall: ${pitfall}`);
  }
  console.log("");
}

// Artifacts. Ordered: narrative → data → code → Claude Code transcripts.
// All entries conditional on existsSync.
const artLines = [];

// 1. SDLC narrative
const narrativeFiles = [
  ["Requirements",              "requirements.md"],
  ["Design",                    "design.md"],
  ["Task-packet plan",          "packets.json"],
  ["Senior review",             "review.json"],
  ["Senior review (markdown)",  "senior_review.md"],
  ["Security review",           "security_review.md"],
  ["Generated README",          "README.md"],
];
for (const [label, name] of narrativeFiles) {
  const p = join(passDir, name);
  if (existsSync(p)) artLines.push([label, p]);
}
const adrDir = join(passDir, "docs", "adr");
if (existsSync(adrDir)) artLines.push(["ADR set", adrDir + "/"]);

// 2. Data
artLines.push(["Telemetry (JSON-lines)", join(passDir, "telemetry.jsonl")]);
artLines.push(["Manifest",               join(passDir, "manifest.json")]);

// 3. Code output — check the two common layouts (app/ or src/ at pass root)
for (const candidate of ["app", "src"]) {
  const p = join(passDir, candidate);
  if (existsSync(p)) { artLines.push(["Generated source", p + "/"]); break; }
}
for (const dir of ["prisma", "test"]) {
  const p = join(passDir, dir);
  if (existsSync(p)) artLines.push([dir === "prisma" ? "Prisma schema + seed" : "Tests", p + "/"]);
}

// 4. Claude Code session/subagent transcripts under
// <claude root>/projects/<project-dir>/. The claude root is $CLAUDE_CONFIG_DIR
// when it is set and non-empty, else ~/.claude: where Claude Code writes, and the
// root transcriptsDirFor in plugin/scripts/collect-orchestrator-usage.mjs and the
// claude-cli worker ledger (claudeProjectsDir) read. Looking only under
// ~/.claude listed no transcript for a run launched with CLAUDE_CONFIG_DIR.
// Claude Code names the project directory after the absolute project path with
// EVERY character that is not a letter or digit replaced by '-'
// (`/a/my_app.v0.6.0` -> `-a-my-app-v0-6-0`), as docs/methodology.md states.
// This used to replace only '/' and whitespace, so for a project path holding a
// dot or an underscore it looked in a directory that never exists
// (tools/test/report-transcript-dir.test.mjs pins both rules).
try {
  // Project root is four levels up from passDir
  // (examples/<study>/passes/<run-id>/ → repo root)
  const projectRoot = dirname(dirname(dirname(dirname(passDir))));
  const projectHash = resolve(projectRoot).replace(/[^A-Za-z0-9]/g, "-");
  // `||`, not `??`: an empty CLAUDE_CONFIG_DIR counts as unset, as the collector and the ledger treat it.
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const claudeProjectDir = join(claudeRoot, "projects", projectHash);
  if (existsSync(claudeProjectDir)) {
    const startedAt = Date.parse(manifest.started_at ?? "") || 0;
    const endedAt   = Date.parse(manifest.ended_at   ?? "") || Date.now();
    // Session-level transcripts (files directly under the project dir)
    const sessionFiles = readdirSync(claudeProjectDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ n, full: join(claudeProjectDir, n), mtime: statSync(join(claudeProjectDir, n)).mtimeMs }))
      .filter(({ mtime }) => startedAt === 0 || (mtime >= startedAt - 5*60_000 && mtime <= endedAt + 5*60_000))
      .sort((a, b) => a.mtime - b.mtime);
    for (const { full } of sessionFiles) {
      artLines.push(["Claude Code session log", full]);
    }
    // Subagent transcripts (one directory per session, subagents/ inside)
    for (const { n } of sessionFiles) {
      const sessionId = n.replace(/\.jsonl$/, "");
      const subDir = join(claudeProjectDir, sessionId, "subagents");
      if (existsSync(subDir)) {
        const subs = readdirSync(subDir).filter((x) => x.endsWith(".jsonl"));
        for (const s of subs) artLines.push(["Subagent transcript", join(subDir, s)]);
      }
    }
    if (sessionFiles.length === 0) {
      artLines.push(["Claude Code session log", claudeProjectDir + "/  (no JSONL in the pass's time window)"]);
    }
  }
} catch { /* Claude Code project dir not accessible — skip */ }

if (asMarkdown) {
  console.log(`## Artifacts\n`);
  for (const [label, p] of artLines) console.log(`- ${label}: \`${p}\``);
} else {
  console.log(`Artifacts`);
  for (const [label, p] of artLines) console.log(`  • ${label.padEnd(28)}${p}`);
}
console.log("");
