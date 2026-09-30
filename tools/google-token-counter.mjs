#!/usr/bin/env node
/**
 * Compares a run's Gemini telemetry with Google's own token counter.
 *
 *   node tools/google-token-counter.mjs <pass-dir> --project <gcp-project> [--model gemini-3.8-flash] [--slack-minutes 2]
 *
 * Why: a run's Gemini dollars are priced from each call's usage report. Google
 * counts the same tokens independently, per minute, in Cloud Monitoring
 * (aiplatform.googleapis.com/publisher/online_serving/token_count, split into
 * input and output). If the two disagree, some calls were not recorded (a job
 * killed before it wrote usage) or were recorded wrongly (usage totals read
 * from the wrong fields of the Antigravity SDK's report, for example).
 * Reading the counter is free.
 *
 * What it does: sums the pass's telemetry input (fresh + cached) and output
 * tokens for the model, reads Google's counter for the window from the first
 * to the last telemetry event (widened by --slack-minutes, because the counter
 * is per minute), and prints both with the difference. It reads everything
 * else on the project in that window too, so run it for a window where only
 * this run used that model on that project.
 *
 * The access token comes from `gcloud auth application-default
 * print-access-token` and is never printed. Read-only.
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The run's Gemini tokens from its telemetry, and the window they fall in. */
export function telemetryTotals(lines, model) {
  let input = 0, output = 0, first = null, last = null, events = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev.tier === "orchestrator" || ev.model !== model) continue;
    input += (ev.input_tokens ?? 0) + (ev.input_tokens_cached ?? 0);
    output += ev.output_tokens ?? 0;
    events++;
    const t = Date.parse(ev.ts);
    if (Number.isFinite(t)) { first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t); }
  }
  return { input, output, events, first, last };
}

/** Sums one Cloud Monitoring timeSeries list into input and output tokens for a model. */
export function counterTotals(series, model) {
  const out = { input: 0, output: 0 };
  for (const s of series ?? []) {
    if (s.resource?.labels?.model_user_id !== model) continue;
    const type = s.metric?.labels?.type;
    if (type !== "input" && type !== "output") continue;
    for (const p of s.points ?? []) out[type] += Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// Compared as URLs of the real path, so a path with spaces or through a symlink still runs the tool.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const pass = process.argv[2];
  const project = arg("project");
  const model = arg("model", "gemini-3.8-flash");
  const slack = Number(arg("slack-minutes", "2")) * 60_000;
  if (!pass || !project) {
    console.error("usage: node tools/google-token-counter.mjs <pass-dir> --project <gcp-project> [--model gemini-3.8-flash] [--slack-minutes 2]");
    process.exit(2);
  }
  const tpath = join(pass, "telemetry.jsonl");
  if (!existsSync(tpath)) { console.error(`no telemetry at ${tpath}`); process.exit(1); }
  const t = telemetryTotals(readFileSync(tpath, "utf8").split("\n"), model);
  if (!t.events) { console.log(`no ${model} events in ${tpath}`); process.exit(0); }
  const start = new Date(t.first - slack).toISOString(), end = new Date(t.last + slack).toISOString();
  const token = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8" }).trim();
  const filter = encodeURIComponent('metric.type="aiplatform.googleapis.com/publisher/online_serving/token_count"');
  const url = `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?filter=${filter}&interval.startTime=${start}&interval.endTime=${end}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": project } });
  const body = await res.json();
  if (!res.ok) { console.error(`Cloud Monitoring said ${res.status}: ${body?.error?.message ?? ""}`); process.exit(1); }
  const g = counterTotals(body.timeSeries, model);
  const row = (name, ours, theirs) => `${name.padEnd(7)} telemetry ${String(ours).padStart(12)}   Google ${String(theirs).padStart(12)}   difference ${String(theirs - ours).padStart(10)}`;
  console.log(`${model} on ${project}, ${start} → ${end} (${t.events} telemetry events)`);
  console.log(row("input", t.input, g.input));
  console.log(row("output", t.output, g.output));
  console.log(g.input === t.input && g.output === t.output ? "MATCH" : "DIFFERENT — see the header of this script for what a difference can mean");
}
