#!/usr/bin/env node
/**
 * collect-orchestrator-usage — reconstruct the run's OWN cost from session
 * transcripts and record it beside (never inside) the dispatched-work totals.
 *
 * The problem this closes: the orchestrator runs as a Claude Code session;
 * its own loop — reasoning, Read/Glob/Bash tool calls, re-sending the growing
 * conversation every turn — never passes through the MCP dispatch server, so
 * it is invisible to telemetry in BOTH auth modes. On real measured runs the
 * plugin reported $1.87 while the session transcripts summed to ≈$236: a
 * ~100× undercount, large enough to INVERT architecture comparisons drawn
 * from dispatched-only numbers. This tool sums the transcripts post-run and
 * appends one `tier: "orchestrator"` event to the run's telemetry, then
 * patches the manifest with an `orchestrator_overhead` block and a
 * `true_total_cost_usd` — leaving `total_cost_usd` dispatched-only, so the
 * two spends are never blended silently.
 *
 * Method, and the facts it rests on (verified against a real 52,985-line
 * session transcript before this tool was written, and re-verified for the
 * window and receipt rules against four real sessions across two CLI
 * versions in September 2026):
 *
 *   1. WHERE: transcripts live in <root>/projects/<hash>/*.jsonl, where <root>
 *      is $CLAUDE_CONFIG_DIR when set and non-empty, else ~/.claude (the root
 *      the claude-cli worker ledger reads too), and <hash> is the absolute
 *      project path with every character that is not a letter or digit
 *      replaced by `-` (`/a/v0.6.0` → `-a-v0-6-0`); each session may also have
 *      <hash>/<sessionId>/subagents/*.jsonl.
 *      Driver subagents run in-session, so their transcripts count too — all
 *      in-session work is driver-tier work by construction (the plugin ships
 *      only the five driver agents).
 *   2. WHAT: every `"type": "assistant"` line carries `message.usage` with
 *      `input_tokens`, `cache_read_input_tokens`,
 *      `cache_creation_input_tokens`, `output_tokens` — and `message.model`.
 *   3. DEDUPE — the critical one: one API message is written as SEVERAL
 *      JSONL lines (one per content block), each repeating the same
 *      `message.id`. On the reference transcript 5,218 of 7,203 message ids
 *      appeared more than once — naive per-line summing roughly DOUBLES the
 *      cost, so each id is counted once. The usage on those lines is identical
 *      for input, cache_read and cache_write, but NOT for `output_tokens`:
 *      that is a partial snapshot, complete only on the message's terminal
 *      line — the one carrying `stop_reason`. Keeping the first line's value
 *      books a couple of tokens where the true figure is hundreds (measured
 *      2.85x low on a real run), so the terminal line's value is booked
 *      instead. A message with no terminal line (truncated, or still
 *      streaming) falls back to the largest value seen, which is a lower
 *      bound rather than a guess.
 *   4. EXCLUDE: `message.model === "<synthetic>"` lines are error
 *      placeholders fabricated by the CLI, not billed API traffic.
 *   5. WINDOW: run_id is NOT present in transcript metadata (checked
 *      empirically), but the run's own COMMAND TURN is: the `"type": "user"`
 *      line whose text invokes `/mmo:pass`, `/mmo:greenfield` or
 *      `/mmo:brownfield` (any plugin prefix; the orchestration runner's
 *      `ai-sdlc-*` command names too), carrying this run's `--run-id` or no
 *      run id at all. Claude Code bills PER INVOCATION, and an invocation
 *      begins at its human turn, so the window OPENS at that turn's own
 *      timestamp — exact, not approximate. The turn chosen is the latest one
 *      at or before the driver's `run.start` line in
 *      `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` (else at or
 *      before the first dispatched event), preferring a turn in the receipt's
 *      own session and a turn naming this run id. The window CLOSES at the
 *      first human turn after the driver's `run.end` line (that turn starts
 *      the next invocation and is excluded), or at the end of the session
 *      file when no human turn follows — both exact, because assistant
 *      messages only ever follow a human turn. Lines with `isMeta: true`,
 *      `toolUseResult`, or a `tool_result` content block are the CLI's own
 *      bookkeeping, not human turns; nor are compaction summaries
 *      (`isCompactSummary`, `isVisibleInTranscriptOnly`) or harness-injected
 *      lines whose `origin.kind` is not `human` (a background-task
 *      notification), which no person typed. Subagent files hold no human turns and
 *      are not scanned for them.
 *      FALLBACKS, each APPROXIMATE and said so: no command turn → the window
 *      opens at `run.start` minus 5 minutes (the driver's setup runs for a
 *      couple of seconds before it logs run.start), else at the manifest's
 *      `started_at` minus 5 minutes — `started_at` is the FIRST DISPATCHED
 *      event, not the driver's start, and opening the window there dropped
 *      7 messages and 22% of the driver's spend on a real run (v37-agsdk-1,
 *      2026-09-05). No `run.end`, or no pinned session file to read human
 *      turns from → the window closes at `run.end` plus 5 minutes, else at
 *      `ended_at` plus 5 minutes. An approximate window is labelled
 *      "approximate window" in cost_source and `window.exact = false` in the
 *      manifest, and the receipt rule (8) is what decides whether it was
 *      right — a wrong window fails that rule; it never writes a guess.
 *      One case is worse than approximate and says so: when the opening anchor
 *      is `started_at` (the first DISPATCHED call) the window cannot see what
 *      the driver did before it, so the overhead is a FLOOR, not an estimate —
 *      measured 22% low on v37-agsdk-1 and 83% low on a nested-window
 *      receivables fixture. That case reads "LOWER BOUND — window opens at the
 *      first dispatch" in cost_source and sets `window.lower_bound = true`.
 *      `run.start`/`run.end` are read as the LAST run.start at or before the
 *      first dispatch (a reused run id appends to the same log) and the first
 *      lifecycle marker after it, which must be run.end. File-level pruning
 *      uses mtime with a LOWER bound only (mtime < anchor − slack ⇒ the
 *      file's last write predates the run and it cannot contain run
 *      messages). There is deliberately NO mtime upper bound — a session
 *      that keeps going after the run would push mtime past the window and
 *      silently drop the run's own messages. This diverges from report.mjs's
 *      artifacts listing, which bounds mtime on both ends for a different
 *      purpose.
 *   6. PRICE: every counted message is priced on its own — its model
 *      (`message.model`, read with the price list's resolveModel, or, for a
 *      name the list does not carry, as a `model_name` the run's policy
 *      declares under `pricing_override: true`, exactly or with one
 *      bracketed option: runModelResolver), the UTC day
 *      of its timestamp, its own `usage.speed` / `service_tier` /
 *      `inference_geo`, and its own cache-write split
 *      (`cache_creation.ephemeral_5m_input_tokens` at the 5-minute write rate,
 *      `ephemeral_1h_input_tokens` at the 1-hour rate; a line without the
 *      split books its writes as 5-minute). Rates come from the dated price
 *      list, plugin/mcp/model-dispatch/src/prices.ts, which bills every
 *      dispatch too; a policy `pricing` block prices a model only under
 *      `pricing_override: true`, labelled custom. One rate for every token
 *      charged a Claude Fable 5.1 session with Opus 5 helpers at the Opus
 *      price. Streaming lines before a message's terminal line often omit
 *      `speed`, so each modifier is the value any line of the message
 *      recorded; two different values leave the message unpriced. A model,
 *      day or modifier value the list cannot price is never borrowed from a
 *      similar model: its tokens go to `unpriced[]` with the reason and stay
 *      out of the figure, the figure is labelled INCOMPLETE, and
 *      `--strict-pricing` refuses with exit 1. Messages are aggregated per
 *      model and role (`session` for a top-level session file, `helper` for a
 *      file under `subagents/`) into `per_model[]`, one entry per price, and
 *      the transcript figure is the sum of those entries. The policy's
 *      derived driver model now only labels the event. Web searches
 *      (`usage.server_tool_use.web_search_requests`, once per message) bill
 *      per request on top of tokens at the list's per-search price ($10 per
 *      1,000 for Claude); with no such price they are listed in `unpriced[]`
 *      and the tokens stay priced.
 *   7. IDEMPOTENT: re-running replaces the prior orchestrator event for
 *      this pass (telemetry.jsonl is rewritten atomically without any
 *      `tier: "orchestrator"` lines, then the fresh event is appended) and
 *      re-patches the manifest. Run it as many times as you like.
 *   8. RECEIPT — the referee, when the run kept one: Claude Code's own
 *      end-of-session result (`claude -p --output-format json`, a runner's
 *      `claude-session.json`, or the last "result" line of a stream-json
 *      `live-run.log`; `--receipt <file>` overrides discovery and must
 *      exist). Its `modelUsage[model]` is Anthropic's token count for ONE
 *      invocation, and it includes calls Claude Code bills but never writes
 *      to a transcript. There is no percentage anywhere in the rule: the
 *      share billed but not logged was 2.3% and 22% on two real runs, so no
 *      fixed margin could be right. Per model and per token bucket:
 *      a. A receipt naming a session other than the command turn's: exit 3.
 *      b. NAMES are re-keyed on both sides by the price list's resolveModel
 *         id (resolveBucketNames), so the receipt's `claude-opus-5[1m]` is
 *         the transcript's `claude-opus-5`; verbatim names refused a real
 *         headless run (Sep 10 2026). A `model_name` the run's policy
 *         declares on an entry with `pricing_override: true` is read the same
 *         way, exactly or with one bracketed option, and priced at that card
 *         (runModelResolver). Any other name the list cannot read is exit 3,
 *         printing both name lists and both fixes: it is never paired by
 *         similarity.
 *      c. ABOVE — any transcript input, cache_read, cache_write or output
 *         bucket over the receipt, or a transcript model the receipt does not
 *         bill: the window holds messages the receipt never billed. Claude
 *         Code bills per invocation and a runner's `--resume` continuations
 *         each restart the bill, so when the pinned session file carries two
 *         or more human turns inside the window the LAST invocation alone
 *         (from the last human turn to the window's close) is checked by d
 *         and e below, with that turn as its opening anchor: no bucket above,
 *         and either every bucket equal or the invocation provable (pinned to
 *         the receipt's session, opened at that human turn, no later human
 *         turn, an exact close), books the receipt for that invocation — its
 *         token counts at the list, its gap in `unlogged_billed`
 *         (`pct_of_booked` is the gap's share of that invocation), attribution
 *         checked over that invocation's helpers only — and adds the earlier
 *         invocations transcript-priced: "receipt for the last invocation
 *         (Anthropic token counts priced at the price list); N% of it billed
 *         but not logged; K earlier invocation(s) transcript-priced,
 *         unverified". Anything else is exit 3. (Before v0.7.3 Q1 the last
 *         invocation had to equal the receipt on every bucket, and the whole
 *         window was written transcript-priced as "transcript (receipt covers
 *         only the last invocation, verified; N earlier invocation(s)
 *         unverified)".)
 *      d. AT OR BELOW on every bucket — the receipt is BOOKED as its token
 *         counts priced from the list (bookReceiptTokens), never as Claude
 *         Code's own dollars (its price table priced Opus 5 at Sonnet rates
 *         on Aug 24 2026). The logged part is priced per message (fact 6).
 *         The gap — receipt minus log per bucket, output included — is priced
 *         at that model's logged cache-write TTL and modifier mix; a model
 *         with no logged message (a CLI side call, a helper whose file is
 *         missing) at API-default modifiers with 5-minute writes unless the
 *         receipt's own top-level usage proves its split, every assumption
 *         written down. Searches the receipt bills
 *         (`modelUsage[*].webSearchRequests`) beyond the logged ones are in
 *         the gap too, at the list's per-search price, or unpriced when there
 *         is none. The gap is `unlogged_billed` {per_model, unpriced,
 *         cost_usd, pct_of_booked}, and the label is "receipt (Anthropic token
 *         counts priced at the price list); N% billed but not logged". A
 *         transcript EQUAL to the receipt on every bucket is the receipt's
 *         invocation by itself: every billed message writes a non-zero input
 *         or cache bucket, identical on each of its lines, so equal totals
 *         mean the same messages. A transcript BELOW it on some bucket is
 *         booked only when the window is PROVABLY the receipt's invocation
 *         (provableInvocation): pinned to the receipt's session, opened at
 *         the run's command turn, no later human turn, exact and not a lower
 *         bound. The gap is then calls Claude Code never logs, or a helper
 *         transcript that was not copied; `attribution_complete`
 *         (helperAttribution: every helper named by an Agent/Task result has
 *         its `subagents/agent-<id>.jsonl`, and no such file is unnamed)
 *         tells those apart, and the total is right either way.
 *      e. BELOW without that proof: exit 3, nothing written — the gap may be
 *         billed messages outside the window (a subagent file not copied, a
 *         window that opened late).
 *      Claude Code's own dollars stay a check (`receipt_cli_usd`): more than
 *      RECEIPT_CLI_DRIFT (0.5%) from the booked figure is a NOTE. With a
 *      receipt but no transcript lines in the window, the receipt's token
 *      counts are priced the same way, every model receipt-only
 *      ("receipt-only (Anthropic token counts priced at the price list)").
 *      At run-end a headless live-run.log has no result line yet (the CLI
 *      writes it on exit): the figure is written transcript-priced and
 *      labelled "receipt pending; provisional", and a re-run after the
 *      session exits verifies it. Re-running is idempotent.
 *   9. IN-SESSION DISPATCH: packets the session executed itself (provenance
 *      `estimated` or `apportioned_from_measured_total`), and a `claude-cli`
 *      worker whose own `claude -p` session was swept into a transcript-priced
 *      scan, are already inside the overhead. Their dispatched dollars are
 *      subtracted once: true_total = dispatched − in-session + overhead. The
 *      subtraction is bounded by dispatched minus the out-of-session events
 *      (real vendor calls, never rewritten by any repair), restricted to
 *      models the manifest's `totals.models_used` names, classified by the
 *      event's `model_id` when present, and never applied to a claude-cli
 *      worker whose session was not scanned (receipt-booked figures, or a
 *      scan pinned to the driver's session). Measured +21% over the receipt
 *      without it. A claude-cli worker's event is billed from the same price
 *      list as this scan (its modelUsage tokens, TTL split and modifiers from
 *      its own transcript), but its cost_usd also holds what the worker's
 *      result billed that its transcript never logged (a Haiku side call,
 *      unlogged tokens), and the scan cannot see that part. Such an event
 *      carries `transcript_logged_cost_usd`, the dollars for the tokens its
 *      transcript explains, and only that share is subtracted, so the
 *      unlogged dollars stay in the true total. An event written before that
 *      field existed subtracts its whole cost_usd, as before.
 *
 *
 * Usage:
 *   node collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>]
 *        [--policy <name>] [--policy-path <file>]
 *        [--transcripts-dir <dir>] [--receipt <file>] [--strict-pricing]
 *        [--dry-run]
 *
 *   <pass-dir>          the run's output dir (holds manifest.json +
 *                       telemetry.jsonl), e.g. examples/<study>/passes/<run>
 *   --project-root      the repo the run was launched from. Defaults to the
 *                       current directory. This determines the transcript
 *                       location hash, so it must be the directory `claude`
 *                       ran in.
 *   --policy            policy name to price with. Defaults to the manifest's
 *                       `policy` (or `policy_name`) — the policy the run
 *                       actually used.
 *   --policy-path       explicit policy file; beats --policy and the
 *                       repo-local override, mirroring the server's loader.
 *   --transcripts-dir   read transcripts from this directory instead of
 *                       $CLAUDE_CONFIG_DIR/projects/<hash>, or
 *                       ~/.claude/projects/<hash> when CLAUDE_CONFIG_DIR is
 *                       unset or empty (tests; or a transcript tree copied
 *                       from another machine).
 *   --receipt           Claude Code's own end-of-session result for the driver
 *                       session: a `claude -p --output-format json` object, a
 *                       runner's `claude-session.json`, or a stream-json
 *                       capture (`--output-format stream-json > live-run.log`,
 *                       the headless recipe) whose last "result" line is read.
 *                       Defaults to <pass-dir>/claude-session.json, then
 *                       <pass-dir>/live-run.log, whichever exists.
 *   --strict-pricing    refuse (exit 1, nothing written) when any token in the
 *                       window, or any receipt token a booked receipt adds,
 *                       has no price on the list: an unknown model, no price
 *                       period for its day, or a speed / service_tier /
 *                       inference_geo value the list does not price. Without
 *                       it those tokens are listed in unpriced[] (or
 *                       unlogged_billed.unpriced) and the figure is labelled
 *                       INCOMPLETE.
 *   --dry-run           print everything, write nothing.
 *
 * Exit codes: 0 = event written (or --dry-run). 1 = bad arguments, missing
 * manifest, no billable assistant messages found in the run window (the
 * run WAS driven by a session, so an empty window means the wrong
 * project-root/transcripts-dir — nothing is written), or --strict-pricing
 * with a token the price list cannot price. 3 = the transcript and the
 * receipt cannot be reconciled — the transcript is over the receipt with no
 * continuation turn to account for the excess, or its last invocation is over
 * the receipt, or short of it without proof that it is the receipt's
 * invocation (fact 8c), or the transcript is short of the receipt in a window
 * that cannot be proven to be the receipt's invocation, or a model name on
 * either side is neither on the price list nor a `model_name` the run's policy
 * declares under `pricing_override: true`, or the receipt names a session other
 * than the command turn's — nothing is written.
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveDriverModel, IN_SESSION_ADAPTERS } from "./driver-model-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/**
 * Slack for the APPROXIMATE anchors only (header, fact 5): a fallback start
 * opens this much before run.start / started_at, a fallback end closes this
 * much after run.end / ended_at, and the mtime prune reaches this much
 * further back. An exact anchor — the command turn, the next human turn, the
 * end of the session file — never carries slack: it is a real event, not an
 * estimate of one.
 */
const WINDOW_SLACK_MS = 5 * 60_000;

/**
 * One run-lifecycle log line, as plugin/scripts/lib/log.mjs renders it:
 * `MMO: <ISO timestamp> <LEVEL>  run.start run_id=... mode=...`. The prefix
 * is configurable (MMO_LOG_PREFIX, possibly empty), so it is optional here;
 * the timestamp and the event name are what anchor the window. One builder
 * for both markers, so run.start and run.end can never drift apart.
 */
const runMarkerLine = (event) =>
  new RegExp(`^(?:\\S+\\s+)?(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))\\s+[A-Z]+\\s+${event.replace(".", "\\.")}(?:\\s|$)`);
const RUN_START_LINE = runMarkerLine("run.start");
const RUN_END_LINE = runMarkerLine("run.end");

/**
 * The text of a human turn that starts a run. Claude Code records a slash
 * command as `<command-name>/mmo:pass</command-name>` (with the plugin's
 * install name as the prefix, which need not be `mmo`; the orchestration
 * runner's commands are `ai-sdlc-measured`, `ai-sdlc-pass1`, ...); a `-p`
 * prompt on an older CLI is the bare command line. Both shapes are accepted.
 */
const MMO_COMMAND = /<command-name>\/(?:[\w-]+:)?(?:pass|greenfield|brownfield|ai-sdlc-[\w-]+)<\/command-name>|^\s*\/(?:[\w-]+:)?(?:pass|greenfield|brownfield|ai-sdlc-[\w-]+)(?:\s|$)/;
/** `--run-id=<id>` or `--run-id <id>` inside the command turn's text; stops at whitespace or the closing tag. */
const RUN_ID_FLAG = /--run-id(?:=|\s+)([^\s<]+)/;

/**
 * The driver's own start, read from a run-lifecycle log (header, fact 5).
 * Returns { ms, iso } for the LAST `run.start` line stamped at or before
 * `notAfterMs` (the manifest's first dispatched event), or null when the
 * file is missing or holds no such line. "Last at or before" is deliberate:
 * mmo-log.mjs appends, so a reused run id carries the earlier run's
 * `run.start` in the same file, and the earlier one must not stretch this
 * run's window back over the earlier run's messages. A `run.start` AFTER
 * the first dispatch cannot belong to this run (clock skew, a stale copy)
 * and is ignored the same way.
 */
export function runStartFromLog(logPath, notAfterMs) {
  if (!logPath || !existsSync(logPath)) return null;
  let best = null;
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const m = RUN_START_LINE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (!Number.isFinite(ms) || ms > notAfterMs) continue;
    if (best == null || ms > best.ms) best = { ms, iso: m[1] };
  }
  return best;
}

/**
 * The driver's own end for the run that started at `runStartMs`, read from
 * the same log (header, fact 5). Returns { ms, iso } for the FIRST lifecycle
 * marker after run.start — but only if that marker is a `run.end`. When the
 * next marker is another `run.start` (the run was resumed or the id reused
 * and this run never logged its end), there is no run.end that belongs to
 * this run and null is returned; a later run.end would be another run's,
 * and closing this window there would sweep that run's messages in.
 */
export function runEndFromLog(logPath, runStartMs) {
  if (!logPath || !existsSync(logPath)) return null;
  let first = null;
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    for (const [event, re] of [["run.end", RUN_END_LINE], ["run.start", RUN_START_LINE]]) {
      const m = re.exec(line);
      if (!m) continue;
      const ms = Date.parse(m[1]);
      if (!Number.isFinite(ms) || ms <= runStartMs) continue;
      if (first == null || ms < first.ms) first = { ms, iso: m[1], event };
    }
  }
  return first && first.event === "run.end" ? { ms: first.ms, iso: first.iso } : null;
}

/**
 * The human turns of one top-level session file, oldest first (header,
 * fact 5). A human turn is a `"type": "user"` line that is not the CLI's own
 * bookkeeping: `isMeta: true` lines are the CLI's expansion of a slash
 * command (same timestamp as the turn, not a turn), `toolUseResult` lines and
 * lines whose content holds a `tool_result` block are tool output handed
 * back to the model. Lines Claude Code writes as `"type": "user"` without a
 * person typing them are not turns either: compaction summaries
 * (`isCompactSummary: true`, which also carry `isVisibleInTranscriptOnly:
 * true`), any other transcript-only line, and harness-injected lines, whose
 * `origin.kind` is something other than `human` (a background-task
 * notification is `task-notification`). A line with no `origin` is kept:
 * older transcripts never wrote one. Each turn reports whether its text is a
 * run command (MMO_COMMAND) and which `--run-id` it names, if any. The
 * session id is the line's own `sessionId` field, else the file's basename —
 * the CLI names the file after the session. Lines without a parseable
 * timestamp cannot anchor anything and are skipped.
 */
export function humanTurns(file) {
  const turns = [];
  let lines;
  try { lines = readFileSync(file, "utf-8").split("\n"); } catch { return turns; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "user" || obj.isMeta === true || obj.toolUseResult !== undefined) continue;
    // Not typed by a person, so not a turn (review finding F2; shapes read from
    // real Claude Code transcripts, 2026-09-14). The receipt rule depends on this
    // count: a compaction summary or task notification inside the window was
    // counted as a second human turn and refused a provable run with exit 3, and
    // one just after run.end closed the window there, which moved the session's
    // closing messages into billed-but-not-logged.
    if (obj.isCompactSummary === true || obj.isVisibleInTranscriptOnly === true) continue;
    if (obj.origin && typeof obj.origin === "object" && obj.origin.kind != null && obj.origin.kind !== "human") continue;
    const content = obj.message?.content;
    let text;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      if (content.some((b) => b?.type === "tool_result")) continue;
      text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    } else continue;
    const ms = Date.parse(obj.timestamp);
    if (!Number.isFinite(ms)) continue;
    turns.push({
      ms,
      iso: String(obj.timestamp),
      file,
      session_id: obj.sessionId ?? basename(file, ".jsonl"),
      command: MMO_COMMAND.test(text),
      run_id: RUN_ID_FLAG.exec(text)?.[1] ?? null,
    });
  }
  return turns.sort((a, b) => a.ms - b.ms);
}

/**
 * The per-bucket receipt comparison (header, fact 8), per model. `perModel` is the
 * transcript's per-model token buckets; `receiptModels` the receipt's
 * `modelUsage`, both keyed by price-list id (resolveBucketNames). `ok` means:
 * for every model the transcript recorded, input, cache_read and cache_write
 * EQUAL the receipt's and output is AT MOST the receipt's. The caller decides
 * from the lists, not from `ok`: anything in `above` takes the ABOVE path,
 * and a non-empty `short` is booked only in a provable window. Why equality
 * is exact: every billed message carries at least one
 * non-zero count among input / cache_read / cache_write (a message with all
 * three at zero was never sent), and those three are identical on every
 * duplicate line of a message, so equal totals across all three mean the
 * same set of messages — a missing message lowers a bucket, an extra message
 * raises one, and the two cannot cancel across all three at once on any
 * transcript this tool has seen. Output alone may fall short: a message with
 * no terminal line books a partial snapshot. A receipt model with NO
 * transcript messages at all is the CLI's own side call (recorded on the
 * receipt, never in the transcript) and is reported, not failed; a
 * transcript model with no receipt entry is over the receipt.
 */
export function compareBuckets(perModel, receiptModels) {
  const above = [];
  const short = [];
  const unrecorded = [];
  const lines = [];
  const names = [...new Set([...Object.keys(perModel), ...Object.keys(receiptModels)])].sort();
  for (const name of names) {
    const T = perModel[name];
    const R = receiptModels[name];
    if (!T) { unrecorded.push(name); continue; }
    if (name === "(unlabeled)") {
      above.push(`${T.input + T.input_cached + T.input_cache_write + T.output} tokens on transcript messages with no model name — they cannot be matched to any receipt model`);
      continue;
    }
    if (!R) {
      above.push(`${name}: ${T.input + T.input_cached + T.input_cache_write + T.output} tokens in the transcript, none on the receipt`);
      continue;
    }
    // Output may sit BELOW the receipt (an interrupted message has no terminal
    // line, so its output_tokens never reach the transcript) — but only while
    // the three deterministic buckets (input, cache_read, cache_write) can
    // still prove the window holds every billed message. When those three are
    // zero on BOTH sides they prove nothing (every real billed message writes
    // a non-zero input or cache bucket, so this only happens on synthetic
    // transcripts), and output is the sole remaining evidence: it must then
    // match the receipt exactly, and a shortfall is a missing message.
    const inputless = T.input + T.input_cached + T.input_cache_write === 0 && R.input + R.input_cached + R.input_cache_write === 0;
    const cells = [];
    for (const [key, label] of [["input", "in"], ["input_cached", "cached"], ["input_cache_write", "cache_write"], ["output", "out"]]) {
      const t = T[key], r = R[key];
      if (key === "output") {
        cells.push(`${label} ${t}${t <= r ? "≤" : ">"}${r}`);
        if (t > r) above.push(`${name} output: transcript ${t} > receipt ${r}`);
        else if (t < r && inputless) short.push(`${name} output: transcript ${t} < receipt ${r} (no input or cache tokens on either side, so output alone must match)`);
      } else {
        cells.push(`${label} ${t}${t === r ? "=" : t < r ? "<" : ">"}${r}`);
        if (t > r) above.push(`${name} ${key}: transcript ${t} > receipt ${r}`);
        else if (t < r) short.push(`${name} ${key}: transcript ${t} < receipt ${r}`);
      }
    }
    const verdict = above.some((a) => a.startsWith(`${name} `)) ? "over the receipt" : short.some((s) => s.startsWith(`${name} `)) ? "short of the receipt" : "agrees";
    lines.push(`${name}: ${cells.join(" · ")} → ${verdict}`);
  }
  return { ok: above.length === 0 && short.length === 0, above, short, unrecorded, lines };
}

/**
 * Fix D, names (header, fact 8). The receipt and the transcript spell one model
 * differently: Claude Code writes `claude-opus-5[1m]` on the receipt for a
 * 1M-context session and `claude-haiku-4-5-20251001` for a dated snapshot,
 * while the transcript records the API id `claude-opus-5`. Comparing the names
 * verbatim reported a real session's own tokens as "not on the receipt" and
 * refused the run (Sep 10 2026). Both sides are therefore re-keyed by the price
 * list's resolveModel id, and every bucket of names that resolve to one id is
 * summed, so compareBuckets compares one model with itself. A name the list
 * cannot read is never paired by similarity: it is returned in `unresolved`
 * and the caller refuses. `(unlabeled)` (a message with no model name) keeps
 * its own key, which compareBuckets reports as over the receipt. `names` lists
 * the spellings each id was built from, for the console.
 */
export function resolveBucketNames(perModel, receiptModels, resolve) {
  const transcript = {};
  const receipt = {};
  const unresolved = { transcript: [], receipt: [] };
  for (const [name, b] of Object.entries(perModel)) {
    if (name === "(unlabeled)") { transcript[name] = { ...b, names: [name] }; continue; }
    const id = resolve(name)?.id;
    if (!id) { unresolved.transcript.push(name); continue; }
    const t = (transcript[id] ??= { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 0, names: [] });
    for (const k of ["input", "input_cached", "input_cache_write", "input_cache_write_1h", "output"]) t[k] += b[k] ?? 0;
    t.names.push(name);
  }
  for (const [name, b] of Object.entries(receiptModels)) {
    const id = resolve(name)?.id;
    if (!id) { unresolved.receipt.push(name); continue; }
    const r = (receipt[id] ??= { input: 0, input_cached: 0, input_cache_write: 0, output: 0, cost_usd: null, names: [] });
    for (const k of RECEIPT_BUCKETS) r[k] += b[k] ?? 0;
    if (b.cost_usd != null) r.cost_usd = (r.cost_usd ?? 0) + b.cost_usd;
    if (b.web_search_requests > 0) r.web_search_requests = (r.web_search_requests ?? 0) + b.web_search_requests;
    r.names.push(name);
  }
  for (const v of [...Object.values(transcript), ...Object.values(receipt)]) v.names.sort();
  unresolved.transcript.sort();
  unresolved.receipt.sort();
  return { transcript, receipt, unresolved };
}

/** One bracketed option at the end of a model name (`[1m]`): the part effectivePrice's sameModel strips. */
const OPTION_SUFFIX = /\[[^[\]]+\]$/;

/**
 * Q2 (v0.7.3): the name reader for one run. The price list's resolveModel
 * first; then, for a name the list cannot read, a `model_name` the run's policy
 * declares on an entry with `pricing_override: true` and a pricing block, read
 * exactly or with one bracketed option (`acme-gateway-opus`,
 * `acme-gateway-opus[1m]`). That entry bills its own card for that name: the
 * dispatch server and pre-flight already accepted it through effectivePrice,
 * and the per-message pricer below already billed it custom. The collector
 * read names with resolveModel alone, so a receipt naming the declared model
 * refused a correctly priced run with exit 3 ("cannot resolve model name(s)"),
 * and per-message pricing kept `acme-gateway-opus` and `acme-gateway-opus[1m]`
 * as two models.
 *
 * What it accepts is exactly what effectivePrice's sameModel treats as the
 * declared model when neither name is on the list: equal once one trailing
 * option is removed from each. So a declared `acme-gw[1m]` reads `acme-gw` and
 * `acme-gw[200k]` too, with the id `acme-gw`; a second option, a `-YYYYMMDD`
 * suffix or any other spelling is not the declared name and still returns
 * null, which the caller refuses. A policy entry without the flag, or with the
 * flag and no block (the loader refuses that), declares nothing. The resolver
 * is built from the one policy this run is priced under, so a name one policy
 * declares is never known to another run. `declared_by` lists the policy
 * model ids that declare the name; when they carry different cards the pricer
 * refuses to pick one.
 */
export function runModelResolver(policy, resolveModel) {
  const declared = new Map();
  for (const m of Array.isArray(policy?.models) ? policy.models : []) {
    if (m?.pricing_override !== true || !m.pricing || typeof m.model_name !== "string") continue;
    // A listed name is read by the list first, so declaring it adds nothing.
    if (resolveModel(m.model_name)) continue;
    const base = m.model_name.replace(OPTION_SUFFIX, "");
    if (base === "") continue;
    const ids = declared.get(base) ?? [];
    if (!ids.includes(m.id)) ids.push(m.id);
    declared.set(base, ids);
  }
  return (name) => {
    const listed = resolveModel(name);
    if (listed) return listed;
    if (typeof name !== "string" || name === "") return null;
    const option = OPTION_SUFFIX.exec(name)?.[0] ?? null;
    const ids = declared.get(option ? name.slice(0, -option.length) : name);
    return ids ? { id: option ? name.slice(0, -option.length) : name, tag: option, snapshotDate: null, declared_by: [...ids] } : null;
  };
}

/** The receipt's four per-model token buckets (it carries no TTL split per model). */
const RECEIPT_BUCKETS = ["input", "input_cached", "input_cache_write", "output"];
/** A delegated helper's transcript file, as Claude Code names it: `agent-<agentId>.jsonl`. */
const HELPER_FILE = /^agent-([A-Za-z0-9]+)\.jsonl$/;
/** The line Claude Code appends to an Agent/Task result's text: `agentId: <id> (use SendMessage ...)`. */
const AGENT_ID_TEXT = /agentId: ([A-Za-z0-9]+)/g;

/**
 * Every helper transcript of one session: `agent-<id>.jsonl` files at any depth
 * under `<dir>/<sessionId>/subagents/` (a workflow nests a directory per run).
 * No mtime prune, unlike candidateTranscripts: the attribution check compares
 * the session's whole record of helpers with its whole set of files, whatever
 * window the cost was measured over.
 */
export function sessionHelperFiles(dir, sessionId) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isFile() && HELPER_FILE.test(e.name)) out.push(p);
      else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(join(dir, sessionId, "subagents"), 1);
  return out.sort();
}

/**
 * Fix D, attribution (header, fact 8). Whether the transcript tree holds a file
 * for every helper the session ran. Once a receipt is booked its total is right
 * whatever the tree holds; what a missing helper file loses is the breakdown,
 * because that helper's tokens land in `unlogged_billed` instead of `per_model`.
 * This tells the two causes of a gap apart: calls Claude Code bills but never
 * logs (every helper has its file) and a helper transcript that was not copied
 * (a helper is missing).
 *
 * A helper is named by the result of an `Agent` or `Task` tool use, in the
 * session file or in any helper file (a helper that spawns helpers records the
 * result in its own file). Claude Code writes the id two ways, both seen on a
 * real run: `toolUseResult.agentId` on the result line, and an `agentId: <id>`
 * line in the result text (no toolUseResult on nested results). Results of any
 * other tool are ignored, so a Bash output that prints "agentId:" names nothing.
 * `complete` is true iff the named ids equal the ids of `helperFiles`.
 *
 * Q1 (v0.7.3): `fromMs` / `toMs` scope the check to one invocation, for a
 * resumed window whose receipt bills only its last invocation. Only session-file
 * lines timestamped inside [fromMs, toMs) name helpers (a line with no parseable
 * timestamp cannot be placed and is left out), and only helper files whose
 * earliest timestamp falls inside it are compared: a helper runs after the tool
 * use that spawns it, so it starts inside the invocation that spawned it. A
 * helper file with no parseable timestamp cannot be placed either, so it is
 * compared; a file nothing in scope names then makes the check incomplete,
 * never falsely complete. Without the two bounds the whole session is checked,
 * as before.
 */
export function helperAttribution(sessionFile, helperFiles, { root, fromMs = null, toMs = null } = {}) {
  const scoped = fromMs != null;
  const inScope = (ms) => ms >= fromMs && ms < (toMs ?? Number.POSITIVE_INFINITY);
  const readObjects = (f) => {
    const out = [];
    let lines;
    try { lines = readFileSync(f, "utf-8").split("\n"); } catch { return null; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* not a JSON line */ }
    }
    return out;
  };
  const objects = [];
  const agentUses = new Set();
  const comparedHelperFiles = [];
  for (const f of [sessionFile, ...helperFiles]) {
    let fileObjects = readObjects(f);
    if (fileObjects === null) {
      // An unreadable helper file is still a file the session wrote; compare it as before.
      if (f !== sessionFile) comparedHelperFiles.push(f);
      continue;
    }
    if (scoped && f === sessionFile) {
      fileObjects = fileObjects.filter((o) => inScope(Date.parse(o?.timestamp)));
    } else if (scoped) {
      const stamps = fileObjects.map((o) => Date.parse(o?.timestamp)).filter(Number.isFinite);
      if (stamps.length > 0 && !inScope(Math.min(...stamps))) continue;
    }
    if (f !== sessionFile) comparedHelperFiles.push(f);
    for (const o of fileObjects) {
      objects.push(o);
      if (o?.type === "assistant" && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && typeof b.id === "string") agentUses.add(b.id);
        }
      }
    }
  }
  const referenced = new Set();
  for (const o of objects) {
    if (o?.type !== "user" || !Array.isArray(o.message?.content)) continue;
    const results = o.message.content.filter((b) => b?.type === "tool_result" && agentUses.has(b.tool_use_id));
    if (results.length === 0) continue;
    const tur = o.toolUseResult;
    if (tur && typeof tur === "object" && typeof tur.agentId === "string" && tur.agentId !== "") referenced.add(tur.agentId);
    for (const b of results) {
      const text = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content) ? b.content.map((x) => (x?.type === "text" && typeof x.text === "string" ? x.text : "")).join("\n") : "";
      for (const m of text.matchAll(AGENT_ID_TEXT)) referenced.add(m[1]);
    }
  }
  const fileById = new Map();
  // Scoped (Q1): only the helper files placed inside the invocation are compared.
  for (const f of comparedHelperFiles) {
    const id = HELPER_FILE.exec(basename(f))?.[1];
    if (id) fileById.set(id, f);
  }
  const missing = [...referenced].filter((id) => !fileById.has(id)).sort();
  const unreferenced = [...fileById.entries()].filter(([id]) => !referenced.has(id)).map(([, f]) => (root ? relative(root, f) : f)).sort();
  return {
    complete: missing.length === 0 && unreferenced.length === 0,
    referenced: [...referenced].sort(),
    missing_helper_ids: missing,
    unreferenced_helper_files: unreferenced,
  };
}

/**
 * Fix D, provability (header, fact 8). A receipt ABOVE the transcript is booked
 * only when the window is provably the one invocation the receipt bills; these
 * are the facts the collector already records for the window. Every failed
 * fact is a reason, in words. (A transcript EQUAL to the receipt on every
 * bucket needs none of this: the equality itself proves the message set.)
 *
 * The facts: pinned to the receipt's session; opened at the run's command turn
 * (not a lower bound); one human turn inside the window; NO human turn after it
 * (`laterHumanTurns`, counted in the pinned session file from the window's
 * close, the first one's timestamp in `laterHumanTurnFrom`); exact. A receipt
 * is Claude Code's bill for the session's LAST invocation, so a human turn after
 * the window means the receipt may bill that later leg. This fact was missing:
 * only turns inside the window were counted, so a window closed by a later
 * `/mmo:pass` turn was called provable and the later leg's receipt was booked
 * onto the earlier run (review finding F1). `laterHumanTurns` absent counts as 0.
 */
export function provableInvocation({ receiptSessionId, pinnedId, startAnchor, humanTurnsInWindow, laterHumanTurns = 0, laterHumanTurnFrom = null, windowExact, lowerBound }) {
  const reasons = [];
  if (!receiptSessionId) reasons.push("the receipt names no session");
  else if (pinnedId !== receiptSessionId) reasons.push(`the scan is not pinned to the receipt's session ${receiptSessionId}${pinnedId ? ` (it is pinned to ${pinnedId})` : ""}`);
  if (lowerBound) reasons.push("the window opens at the first dispatch (a lower bound)");
  // Q1: the last invocation of a resumed window opens at its own human turn,
  // which is where that invocation's bill begins, exactly as the command turn is
  // for a single invocation. Both are real events in the pinned session file.
  else if (startAnchor !== "command turn" && startAnchor !== LAST_INVOCATION_ANCHOR) reasons.push(`the window opens at ${startAnchor}, not at the run's command turn`);
  if (humanTurnsInWindow > 1) reasons.push(`${humanTurnsInWindow} human turns fall inside the window, so the receipt may bill only the last invocation`);
  if (laterHumanTurns > 0) {
    reasons.push(
      `${laterHumanTurns} human turn(s) follow the window${laterHumanTurnFrom ? ` (from ${laterHumanTurnFrom})` : ""}, ` +
        `so the receipt may bill a later invocation of this session`
    );
  }
  if (!windowExact) reasons.push("the window is approximate");
  return { provable: reasons.length === 0, reasons };
}

/**
 * Q1 (v0.7.3): the opening anchor of the last invocation of a resumed window,
 * as provableInvocation reads it. A runner's `--resume` continuation leaves a
 * human turn in the session file, and the invocation the receipt bills begins
 * at that turn, so a last invocation checked alone opens at an exact event just
 * as a single invocation opens at its command turn.
 */
export const LAST_INVOCATION_ANCHOR = "the last invocation's human turn";

/** Removes float noise from a blended rate (13.125000000000002 → 13.125); display only, costs use the unrounded rate. */
const roundRate = (n) => Math.round(n * 1e9) / 1e9;

/**
 * One model's price on every reference instant, looked up at API-default
 * modifiers. The instants are the window's first and last known moments; a
 * model's periods are day ranges, so one price at both ends is its price
 * across the window. Two different prices, or no price, is unpriced: a model
 * with no logged message has nothing that says which applies.
 */
function referencePrice(name, referenceTimes, pricer) {
  let first = null;
  for (const t of referenceTimes) {
    const r = pricer(name, t, {});
    if (r.unpriced) return r;
    if (first && (first.basis !== r.basis || JSON.stringify(first.pricing) !== JSON.stringify(r.pricing))) {
      return { unpriced: true, model: r.model, reason: `the window spans two prices for ${r.model}, and no logged message says which one its unlogged tokens were billed at` };
    }
    first ??= r;
  }
  return first ?? { unpriced: true, model: name, reason: "no reference day to price on" };
}

/**
 * Fix D, booking (header, fact 8): the receipt's token counts priced from the
 * price list. Claude Code's own dollars are never booked (its price table was
 * stale on Aug 24 2026); they stay a check. Per receipt model (`receipt` is
 * resolveBucketNames' re-keyed map):
 *   - the LOGGED part is `priced` (priceMessages over the window): each message
 *     at its own model, day, modifiers and cache-write split;
 *   - the GAP is receipt minus log, per bucket (output included), and it is
 *     priced at that model's LOGGED MIX: per bucket, the token-weighted average
 *     of the rates its logged messages paid, cache writes averaged over their
 *     5-minute and 1-hour rates. So an unlogged call is priced as the model's
 *     logged calls were, fast mode and 1-hour writes included, in proportion;
 *   - a bucket with no logged tokens, and a model with no logged message (a
 *     CLI side call, or a helper whose file is missing), fall back to the list
 *     at API-default modifiers on the window's days, and every such fallback
 *     that prices a non-zero gap is written into `assumed`. Cache writes then
 *     take the 5-minute rate, unless the receipt's top-level `usage` equals
 *     that model's four counts exactly and no other model's, in which case the
 *     usage's own 5-minute / 1-hour split is that model's (a proven match, not
 *     a pairing guess: Claude Code writes the main loop's usage there);
 *   - a gap the list cannot price goes to `unlogged_billed.unpriced` with the
 *     reason, and `complete` is false.
 * `tokens` are the receipt's counts; their 1-hour share is the logged 1-hour
 * writes plus each model's gap writes apportioned at its logged split (the
 * receipt's split for a proven owner, none otherwise).
 */
export function bookReceiptTokens({ receipt, priced, pricer, referenceTimes, receiptUsage = null }) {
  const round6 = pricer.round6;
  const premium5m = pricer.CACHE_WRITE_PREMIUM ?? 1.25;
  const premium1h = pricer.CACHE_WRITE_PREMIUM_1H ?? 2;
  // computeCostUsd's own fallbacks, so a pricing_override card without write rates blends at the rates it bills.
  const writeRates = (rates) => ({ w5m: rates.input_cache_write ?? rates.input * premium5m, w1h: rates.input_cache_write_1h ?? rates.input * premium1h });
  const usageOwner = (() => {
    const u = receiptUsage;
    if (!u || u.cache_write_5m == null || u.cache_write_1h == null || u.cache_write_5m + u.cache_write_1h !== u.input_cache_write) return null;
    const owners = Object.keys(receipt).filter((id) => RECEIPT_BUCKETS.every((b) => receipt[id][b] === u[b]));
    return owners.length === 1 ? owners[0] : null;
  })();

  const perModel = [];
  const unpriced = [];
  const byModel = [];
  const customModels = new Set(priced.custom_models ?? []);
  const tokens = { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 0 };
  for (const id of Object.keys(receipt).sort()) {
    const R = receipt[id];
    const entries = priced.per_model.filter((e) => e.model === id);
    const logged = zeroTokens();
    for (const e of [...entries, ...priced.unpriced.filter((u) => u.model === id)]) for (const k of TOKEN_KEYS) logged[k] += e.tokens[k] ?? 0;
    const loggedWrites = logged.input_cache_write_5m + logged.input_cache_write_1h;
    const receiptOnly = logged.input + logged.input_cached + loggedWrites + logged.output === 0 && entries.length === 0;
    const gap = {
      input: Math.max(0, R.input - logged.input),
      input_cached: Math.max(0, R.input_cached - logged.input_cached),
      input_cache_write: Math.max(0, R.input_cache_write - loggedWrites),
      output: Math.max(0, R.output - logged.output),
    };
    // Review finding M3: the searches the receipt bills beyond the logged ones.
    const loggedSearches = [...entries, ...priced.unpriced.filter((u) => u.model === id)].reduce((s, e) => s + (e.web_search_requests ?? 0), 0);
    const gapSearches = Math.max(0, (R.web_search_requests ?? 0) - loggedSearches);
    for (const b of RECEIPT_BUCKETS) tokens[b] += R[b];

    // The logged mix: token-weighted rates per bucket.
    const mix = { input: [0, 0], input_cached: [0, 0], input_cache_write: [0, 0], output: [0, 0] };
    for (const e of entries) {
      for (const b of ["input", "input_cached", "output"]) { mix[b][0] += e.tokens[b]; mix[b][1] += e.tokens[b] * e.rates[b]; }
      const w = writeRates(e.rates);
      mix.input_cache_write[0] += e.tokens.input_cache_write_5m + e.tokens.input_cache_write_1h;
      mix.input_cache_write[1] += e.tokens.input_cache_write_5m * w.w5m + e.tokens.input_cache_write_1h * w.w1h;
    }
    let fallback = null;
    const reference = () => (fallback ??= referencePrice(R.names[0], referenceTimes, pricer));
    const rate = {};
    const assumed = [];
    let reason = null;
    for (const b of ["input", "input_cached", "output"]) {
      if (mix[b][0] > 0) { rate[b] = mix[b][1] / mix[b][0]; continue; }
      const f = reference();
      rate[b] = f.unpriced ? null : f.pricing[b];
      if (gap[b] > 0 && f.unpriced) reason = f.reason;
      else if (gap[b] > 0 && !receiptOnly) assumed.push(`no logged ${b} tokens: the ${f.basis === "custom" ? "policy's pricing_override card" : "list's rate at API-default modifiers"}`);
    }
    let ttlSplit;
    let gap1h = 0;
    if (mix.input_cache_write[0] > 0) {
      rate.input_cache_write = mix.input_cache_write[1] / mix.input_cache_write[0];
      ttlSplit = "logged mix";
      gap1h = Math.round(gap.input_cache_write * (logged.input_cache_write_1h / loggedWrites));
    } else {
      const f = reference();
      const w = f.unpriced ? null : writeRates(f.pricing);
      if (gap.input_cache_write === 0) {
        rate.input_cache_write = w ? w.w5m : null;
        ttlSplit = "none";
      } else if (f.unpriced) {
        rate.input_cache_write = null;
        reason = f.reason;
        ttlSplit = "none";
      } else if (receiptOnly && usageOwner === id) {
        rate.input_cache_write = (receiptUsage.cache_write_5m * w.w5m + receiptUsage.cache_write_1h * w.w1h) / R.input_cache_write;
        ttlSplit = "receipt usage";
        gap1h = receiptUsage.cache_write_1h;
      } else {
        rate.input_cache_write = w.w5m;
        ttlSplit = "5-minute (assumed)";
        assumed.push("no cache-write split for these writes: the 5-minute rate");
      }
    }
    if (receiptOnly) {
      const f = reference();
      if (!f.unpriced) {
        assumed.unshift(f.basis === "custom"
          ? "no logged message: the policy's pricing_override card"
          : `no logged message: API-default ${(f.applied_modifiers?.defaulted ?? []).join(", ").replace(/, ([^,]*)$/, " and $1")}`);
        if (f.basis === "custom") customModels.add(id);
      }
    }
    tokens.input_cache_write_1h += logged.input_cache_write_1h + gap1h;

    const loggedCost = round6(entries.reduce((s, e) => s + e.cost_usd, 0));
    const hasGap = RECEIPT_BUCKETS.some((b) => gap[b] > 0);
    // The per-search fee is the list's for the model's day. It is not a token
    // rate, so no logged mix applies. No price: the searches are unpriced.
    let searchFee = null;
    let searchReason = null;
    if (gapSearches > 0) {
      const f = reference();
      if (f.unpriced) searchReason = f.reason;
      else if (f.web_search_per_request == null) searchReason = `${gapSearches} web search request(s) have no per-search price for ${id} on the price list, so their fee is in no figure`;
      else searchFee = f.web_search_per_request;
    }
    const pricedSearches = gapSearches > 0 && searchFee != null;
    let gapCost = 0;
    if (hasGap && reason) {
      unpriced.push({ model: id, reported_as: R.names, reason, tokens: gap });
    }
    if (gapSearches > 0 && searchReason) {
      unpriced.push({ model: id, reported_as: R.names, reason: searchReason, tokens: { input: 0, input_cached: 0, input_cache_write: 0, output: 0 }, web_search_requests: gapSearches });
    }
    if ((hasGap && !reason) || pricedSearches) {
      const tokenCost = hasGap && !reason ? round6(RECEIPT_BUCKETS.reduce((s, b) => s + (gap[b] > 0 ? (gap[b] / 1_000_000) * rate[b] : 0), 0)) : 0;
      const searchCost = pricedSearches ? round6(gapSearches * searchFee) : 0;
      gapCost = round6(tokenCost + searchCost);
      perModel.push({
        model: id,
        reported_as: R.names,
        receipt_only: receiptOnly,
        // Unpriced token gaps are listed in unpriced, so a searches-only entry shows none.
        tokens: hasGap && !reason ? gap : { input: 0, input_cached: 0, input_cache_write: 0, output: 0 },
        rates: Object.fromEntries(RECEIPT_BUCKETS.map((b) => [b, rate[b] == null ? null : roundRate(rate[b])])),
        ttl_split: ttlSplit,
        assumed,
        ...(pricedSearches ? { web_search_requests: gapSearches, web_search_cost_usd: searchCost } : {}),
        cost_usd: gapCost,
      });
    }
    byModel.push({ model: id, reported_as: R.names, cost_usd: round6(loggedCost + gapCost), cli_cost_usd: R.cost_usd });
  }
  tokens.input_cache_write_1h = Math.min(tokens.input_cache_write, tokens.input_cache_write_1h);
  tokens.input_cache_write_5m = tokens.input_cache_write - tokens.input_cache_write_1h;
  const unloggedCost = round6(perModel.reduce((s, g) => s + g.cost_usd, 0));
  const cost = round6(priced.cost_usd + unloggedCost);
  return {
    cost_usd: cost,
    logged_cost_usd: priced.cost_usd,
    tokens,
    unlogged_billed: {
      per_model: perModel,
      unpriced,
      cost_usd: unloggedCost,
      pct_of_booked: cost > 0 ? Math.round((unloggedCost / cost) * 10_000) / 100 : 0,
    },
    complete: priced.complete && unpriced.length === 0,
    custom_models: [...customModels].sort(),
    by_model: byModel,
  };
}

// Runs write `policy`/`run_id`; `buildManifest`'s shape says `policy_name`/`pass`.
// Read both spellings — a manifest key the reader does not recognise otherwise
// resolves to undefined and reprices the whole run under a fallback preset.
// Identity — the run's id and policy name — is `buildManifest`'s INPUT, not its
// output: nothing can derive what a run was called. The manifest's own top-level
// spellings are read first, then the dispatched lines, which each carry `pass`
// and `routing.policy_name`. No nested manifest key is read on purpose: adding
// them would be a list of model-invented names to keep extending, whereas the
// log's field names are written by code and cannot drift.
//
// THIS DOES CHANGE SOME ALREADY-PRICED RUNS, and the change is not cosmetic. A
// manifest with a readable top-level window but no id used to yield the literal
// pass `undefined`, and the command-turn scan skips any turn whose `--run-id`
// does not equal the pass — so the run's own invocation was skipped, the window
// fell back to the approximate ±5m anchors, and no session was pinned. Once the
// id resolves, that run pins its session and measures an exact window, and its
// dollars move. On one probe: $1.85 approximate becomes $1.55 exact. The new
// figure is the correct one, but anything already published from the old path
// must be re-collected rather than assumed stable — `orchestrator_overhead.window`
// records `source`, `exact` and `session_id` so the two are told apart.
//
// Orchestrator lines are skipped, exactly as the window skips them — but for a
// second reason. THIS SCRIPT writes an orchestrator line, and stamps its own
// `pass` and `routing.policy_name` into it. Reading those back on a re-run would
// make the collector's previous answer its next input: run it once with
// `--policy X` and every later run would silently re-price under X, with no
// manifest and no dispatched line ever having said so. The dispatched lines are
// the run's own record and nothing here ever writes them, so the fallback reads
// only those.
const dispatchedOnly = (events) => events.filter((ev) => ev && ev.tier !== "orchestrator");
export const manifestPolicyName = (manifest, events = []) =>
  manifest.policy ??
  manifest.policy_name ??
  dispatchedOnly(events).find((ev) => ev?.routing?.policy_name)?.routing?.policy_name;
export const manifestPassId = (manifest, events = []) =>
  manifest.run_id ?? manifest.pass ?? dispatchedOnly(events).find((ev) => ev?.pass)?.pass;

function parseArgs(argv) {
  const args = {
    passDir: undefined,
    projectRoot: undefined,
    policy: undefined,
    policyPath: undefined,
    transcriptsDir: undefined,
    receipt: undefined,
    dryRun: false,
    strictPricing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--strict-pricing") args.strictPricing = true;
    else if (a === "--project-root" || a.startsWith("--project-root=")) args.projectRoot = eat("--project-root");
    else if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else if (a === "--transcripts-dir" || a.startsWith("--transcripts-dir=")) args.transcriptsDir = eat("--transcripts-dir");
    else if (a === "--receipt" || a.startsWith("--receipt=")) args.receipt = eat("--receipt");
    // The former --receipt-tolerance is gone on purpose: the receipt rule is
    // exact per token bucket (header, fact 8), so there is no fraction to
    // widen. Name it explicitly so an old invocation fails loudly, not
    // silently as "unknown argument".
    else if (a === "--receipt-tolerance" || a.startsWith("--receipt-tolerance=")) throw new Error("--receipt-tolerance no longer exists: the receipt check is exact per token bucket and has no tolerance to widen");
    else if (a.startsWith("--")) throw new Error(`unknown argument '${a}'`);
    else if (args.passDir === undefined) args.passDir = a;
    else throw new Error(`unexpected extra positional '${a}' (pass dir already given: ${args.passDir})`);
  }
  if (!args.passDir) throw new Error("usage: collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>] [--policy <name>] [--policy-path <file>] [--transcripts-dir <dir>] [--receipt <file>] [--strict-pricing] [--dry-run]");
  return args;
}

async function loadDist() {
  try {
    const policyMod = await import(pathToFileURL(join(DIST, "policy.js")).href);
    const routingMod = await import(pathToFileURL(join(DIST, "routing.js")).href);
    const pricingMod = await import(pathToFileURL(join(DIST, "pricing.js")).href);
    const telemetryMod = await import(pathToFileURL(join(DIST, "telemetry.js")).href);
    // The dated price list and the override rule dispatch bills by, so the
    // orchestrator's messages are priced exactly as dispatched work is.
    const pricesMod = await import(pathToFileURL(join(DIST, "prices.js")).href);
    const effectiveMod = await import(pathToFileURL(join(DIST, "effectivePrice.js")).href);
    return { policyMod, routingMod, pricingMod, telemetryMod, pricesMod, effectiveMod };
  } catch (err) {
    throw new Error(
      `could not load the dispatch server's compiled modules from ${DIST} — the MCP ` +
        `server is not built. Fix: node "${join(HERE, "verify-setup.mjs")}" --fix ` +
        `--project-root "$(pwd)"  (original error: ${err.message})`
    );
  }
}

/**
 * The CLI's transcript directory for a project: `<claude root>/projects/<dir>`.
 * The claude root is `$CLAUDE_CONFIG_DIR` when it is set and non-empty, else
 * `~/.claude`: where Claude Code writes, and the rule claudeProjectsDir in
 * src/adapters/claudeCliLedger.ts uses to find a claude-cli worker's transcript.
 * Reading ~/.claude/projects whatever CLAUDE_CONFIG_DIR said found no message
 * for a session launched with it, so the collector exited 1. <dir> is the
 * absolute path with every character that is not a letter or digit replaced by
 * "-" (the same rule the worker ledger uses); replacing only "/" and whitespace
 * missed any path holding a dot or an underscore. `env` and `home` are
 * parameters so a test can pin both.
 */
export function transcriptsDirFor(projectRoot, env = process.env, home = homedir()) {
  const hash = resolve(projectRoot).replace(/[^A-Za-z0-9]/g, "-");
  // `||`, not `??`: an empty CLAUDE_CONFIG_DIR counts as unset, exactly as claudeProjectsDir treats it.
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects", hash);
}

/**
 * Every transcript file that COULD contain run-window messages: top-level
 * session *.jsonl plus each session's subagents/*.jsonl, pruned by the
 * mtime lower bound only (see header, fact 5).
 */
export function candidateTranscripts(dir, windowStartMs) {
  if (!existsSync(dir)) return [];
  const out = [];
  const fresh = (p) => {
    try { return statSync(p).mtimeMs >= windowStartMs - WINDOW_SLACK_MS; } catch { return false; }
  };
  // Subagent transcripts nest to varying depths under `subagents/` — a plain
  // delegation writes one level down, a workflow adds a directory per run below
  // that. Reading a single flat level found the shallow shape only and returned
  // nothing for the rest, which is most of the spend this collector exists to
  // measure. Walk instead, depth-bounded against a pathological tree.
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        if (fresh(p)) out.push(p);
      } else if (e.isDirectory()) {
        walk(p, depth + 1);
      }
    }
  };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (fresh(p)) out.push(p);
    } else if (entry.isDirectory()) {
      // `subagents/` sits either directly under the project directory or under
      // each session directory inside it.
      if (entry.name === "subagents") walk(p, 1);
      else {
        const sub = join(p, "subagents");
        if (existsSync(sub)) walk(sub, 1);
      }
    }
  }
  return out.sort();
}

/**
 * Sum billable usage across transcript files, deduped by message.id and
 * windowed per-message: a message counts when
 * windowStartMs <= timestamp < windowEndMs, no slack — the anchors already
 * carry whatever slack they deserve (header, fact 5). Returns token buckets
 * + scan stats + the observed model → unique-message-count map + the same
 * buckets per model (what the receipt rule compares) + `messages`, one record
 * per counted message for priceMessages: `{model, role, timestamp, modifiers,
 * conflicts, tokens}`. `role` is `roleOf(file)` for the file holding the
 * message's first line; `timestamp` is that line's; `tokens` carries the
 * disjoint 5-minute / 1-hour write split and the booked output. Each of
 * `modifiers.{speed, service_tier, inference_geo}` is the non-null value any
 * line of the message recorded, and a modifier two lines record differently
 * is named in `conflicts`. `web_search_requests`, set only when non-zero, is
 * the largest `usage.server_tool_use.web_search_requests` any line of the
 * message records: once per message, never summed across its lines.
 */
export function sumTranscriptUsage(files, windowStartMs, windowEndMs, { roleOf = () => "session" } = {}) {
  const messages = [];
  const recordById = new Map();
  const seen = new Set();
  /** Per message id: the output figure booked, whether it came from the
   *  terminal (stop_reason) line, and the model it was booked under. See the
   *  streaming note below. */
  const outputById = new Map();
  const observedModels = {};
  const perModel = {};
  const bucketFor = (model) => (perModel[model] ??= { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 0 });
  // `input_cache_write` stays the TOTAL written (what the report and every
  // earlier consumer read); the two TTL buckets are the disjoint split used
  // for pricing. When a line carries no `cache_creation` split (older CLI),
  // its writes are booked as 5-minute — the same 1.25x they were always priced at.
  const tokens = { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 0 };
  const stats = { files: files.length, lines: 0, assistant: 0, counted: 0, duplicates: 0, synthetic: 0, outside_window: 0 };
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      stats.lines++;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== "assistant") continue;
      stats.assistant++;
      const msg = obj.message;
      const usage = msg?.usage;
      if (!usage) continue;
      if (msg.model === "<synthetic>") { stats.synthetic++; continue; }
      if (obj.timestamp) {
        const t = Date.parse(obj.timestamp);
        if (Number.isFinite(t) && (t < windowStartMs || t >= windowEndMs)) {
          stats.outside_window++;
          continue;
        }
      }
      // Duplicate lines for one id repeat input/cache_read/cache_write, so
      // first-seen is correct for those. `output_tokens` is not: it is a
      // partial snapshot that is only complete on the message's terminal line,
      // the one carrying `stop_reason`. Book that line's value, so the figure
      // comes from the message's own end-of-stream marker rather than from
      // whichever line happened to be largest. Without a terminal line — a
      // truncated or still-streaming message — fall back to the maximum seen,
      // which is the best available lower bound.
      const out = usage.output_tokens ?? 0;
      const terminal = msg.stop_reason != null;
      if (msg.id) {
        const prev = outputById.get(msg.id);
        if (seen.has(msg.id)) {
          stats.duplicates++;
          const rec = recordById.get(msg.id);
          // Streaming lines before the terminal one often omit `speed`, so a
          // fast-mode message would be priced standard from its first line.
          noteModifiers(rec, usage);
          noteSearches(rec, usage);
          // A terminal line always wins; otherwise only a larger value does,
          // and never over a value already taken from a terminal line.
          if (!prev?.terminal && (terminal || out > prev.out)) {
            tokens.output += out - prev.out;
            bucketFor(prev.model).output += out - prev.out;
            rec.tokens.output = out;
            outputById.set(msg.id, { out, terminal, model: prev.model });
          }
          continue;
        }
        seen.add(msg.id);
      }
      stats.counted++;
      const model = msg.model ?? "(unlabeled)";
      if (msg.id) outputById.set(msg.id, { out, terminal, model });
      observedModels[model] = (observedModels[model] ?? 0) + 1;
      const pm = bucketFor(model);
      tokens.input += usage.input_tokens ?? 0;
      tokens.input_cached += usage.cache_read_input_tokens ?? 0;
      const cw = usage.cache_creation_input_tokens ?? 0;
      const split = usage.cache_creation;
      // The split is authoritative for the 1-hour count, the total for the
      // sum: 1h is capped at the total and 5m is the remainder, so a split that
      // disagrees with its total (never seen, never assumed) can neither book
      // a write twice nor price above what the CLI reported.
      const cw1h = Math.min(cw, split?.ephemeral_1h_input_tokens ?? 0);
      tokens.input_cache_write += cw;
      tokens.input_cache_write_1h += cw1h;
      tokens.input_cache_write_5m += cw - cw1h;
      tokens.output += out;
      pm.input += usage.input_tokens ?? 0;
      pm.input_cached += usage.cache_read_input_tokens ?? 0;
      pm.input_cache_write += cw;
      pm.input_cache_write_1h += cw1h;
      pm.output += out;
      const rec = {
        model: msg.model ?? null,
        role: roleOf(file),
        timestamp: obj.timestamp,
        modifiers: { speed: null, service_tier: null, inference_geo: null },
        conflicts: [],
        tokens: {
          input: usage.input_tokens ?? 0,
          input_cached: usage.cache_read_input_tokens ?? 0,
          input_cache_write_5m: cw - cw1h,
          input_cache_write_1h: cw1h,
          output: out,
        },
      };
      noteModifiers(rec, usage);
      noteSearches(rec, usage);
      messages.push(rec);
      if (msg.id) recordById.set(msg.id, rec);
    }
  }
  return { tokens, stats, observedModels, perModel, messages };
}

const MODIFIER_KEYS = ["speed", "service_tier", "inference_geo"];
const TOKEN_KEYS = ["input", "input_cached", "input_cache_write_5m", "input_cache_write_1h", "output"];
const zeroTokens = () => ({ input: 0, input_cached: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 0 });
const ROLE_ORDER = { session: 0, helper: 1 };

/**
 * Records a line's web search count on its message record (review finding M3):
 * the largest count any line of the message reports, so a message is counted
 * once however many lines repeat it, and a partial snapshot never undercounts.
 */
function noteSearches(rec, usage) {
  const n = usage.server_tool_use?.web_search_requests;
  if (typeof n === "number" && Number.isFinite(n) && n > (rec.web_search_requests ?? 0)) rec.web_search_requests = n;
}

/** Records one line's request modifiers on its message record (see sumTranscriptUsage). */
function noteModifiers(rec, usage) {
  for (const k of MODIFIER_KEYS) {
    const v = usage[k];
    if (v == null) continue;
    if (rec.modifiers[k] == null) rec.modifiers[k] = v;
    else if (rec.modifiers[k] !== v && !rec.conflicts.includes(k)) rec.conflicts.push(k);
  }
}

/**
 * `helper` when a directory between the transcript root and the file is named
 * `subagents` (a delegated agent's own transcript, at any depth); `session`
 * otherwise. Only the path below `root` is read, so a `subagents` directory
 * above the root says nothing about the file.
 */
export function roleOfTranscript(root, file) {
  return relative(root, file).split(sep).slice(0, -1).includes("subagents") ? "helper" : "session";
}

/**
 * The price of one message: `pricer(modelName, timestamp, modifiers)` returns
 * `{unpriced: false, model, basis, pricing, period, applied_modifiers}` or
 * `{unpriced: true, model, reason}`, where `model` is the price-list id (the
 * name as written when it is not on the list). The rule is dispatch's own
 * (effectivePrice.ts): the dated list prices the model on the message's UTC
 * day; a policy entry naming the model bills its block only under
 * `pricing_override: true`. Two such entries with different blocks price
 * nothing, because picking one would be a guess. Policy-block warnings collect,
 * deduplicated, on `pricer.warnings`. The deps are the dispatch server's
 * compiled prices.js, effectivePrice.js and pricing.js.
 */
export function makeMessagePricer(policy, { pricesMod, effectiveMod, pricingMod }) {
  const models = Array.isArray(policy?.models) ? policy.models : [];
  const warnings = [];
  // Q2: the list's names, then the names this policy declares under
  // pricing_override, so `acme-gateway-opus[1m]` and `acme-gateway-opus` key
  // one per_model entry, exactly as `claude-opus-5[1m]` and `claude-opus-5` do.
  const resolveName = runModelResolver(policy, pricesMod.resolveModel);
  const pricer = (name, timestamp, modifiers) => {
    if (typeof name !== "string" || name === "") {
      return { unpriced: true, model: "(unlabeled)", reason: "the message carries no model name" };
    }
    const model = resolveName(name)?.id ?? name;
    const matches = models.filter((m) => typeof m?.model_name === "string" && effectiveMod.sameModel(m.model_name, name));
    const overrides = matches.filter((m) => m.pricing_override === true && m.pricing);
    if (new Set(overrides.map((m) => JSON.stringify(m.pricing))).size > 1) {
      return {
        unpriced: true,
        model,
        reason: `policy models ${overrides.map((m) => `'${m.id}'`).join(", ")} give ${model} different custom prices under pricing_override: true, and picking one would be a guess`,
      };
    }
    const entry = overrides[0] ?? matches.find((m) => m.adapter === "builtin-anthropic") ?? matches[0] ?? null;
    const custom = entry?.pricing_override === true && Boolean(entry.pricing);
    if (!custom && typeof timestamp !== "string") {
      return { unpriced: true, model, reason: `the message carries no timestamp, so no price period for ${model} can be chosen` };
    }
    const r = entry
      ? effectiveMod.effectivePrice(entry, timestamp ?? "", modifiers ?? {}, name)
      : pricesMod.lookupPrice(name, timestamp, modifiers ?? {});
    for (const w of r.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
    if (r.unpriced) return { unpriced: true, model, reason: r.reason };
    return {
      unpriced: false,
      model,
      basis: r.basis ?? "list",
      pricing: r.pricing,
      period: r.period ?? null,
      applied_modifiers: r.applied_modifiers ?? null,
      // The list's per-search fee for the model's day (a custom card has none of its own); null: searches unpriced.
      web_search_per_request: r.web_search_per_request ?? null,
    };
  };
  pricer.warnings = warnings;
  pricer.computeCostUsd = pricingMod.computeCostUsd;
  pricer.round6 = pricingMod.round6;
  // computeCostUsd's cache-write fallbacks, so a booked receipt's gap blends a
  // pricing_override card that declares no write rates at the rates it bills.
  pricer.CACHE_WRITE_PREMIUM = pricingMod.CACHE_WRITE_PREMIUM;
  pricer.CACHE_WRITE_PREMIUM_1H = pricingMod.CACHE_WRITE_PREMIUM_1H;
  return pricer;
}

/**
 * How far Claude Code's own `total_cost_usd` may sit from a booked receipt's
 * list-priced figure before a NOTE says so (header, fact 8): the same 0.5% the
 * claude-cli worker ledger and the policy-card check use. It never decides
 * what is booked.
 */
export const RECEIPT_CLI_DRIFT = 0.005;

/**
 * Prices sumTranscriptUsage's `messages` one by one and aggregates them per
 * model and role. Messages at the same price (model, role, basis, period,
 * rates, applied modifiers) share one `per_model` entry, so an entry's cost is
 * its tokens at its one card, which is the sum of its messages' costs; a
 * window that crosses a price change or mixes fast and standard requests gets
 * one entry per price. A message the pricer cannot price, or whose lines
 * disagree on a modifier, goes to `unpriced` with the reason, and its tokens
 * are in no cost. `cost_usd` is the sum of the entries' costs.
 */
export function priceMessages(messages, pricer) {
  const entries = new Map();
  const missing = new Map();
  // Review finding M3: searches with no per-search price, per role and model, and each entry's fee.
  const searchesMissing = new Map();
  const searchFees = new Map();
  // The grouping keys below join their parts with the escape \u0000, written
  // as six printable characters. It is the same NUL character at run time, so
  // no part can collide with another. A raw NUL byte used to sit here, and it
  // made ripgrep and binary-skipping greps treat this whole file as binary and
  // skip it without a warning (tools/test/no-nul-bytes.test.mjs).
  for (const msg of messages) {
    let r = pricer(msg.model, msg.timestamp, msg.modifiers);
    if (!r.unpriced && msg.conflicts?.length > 0) {
      r = { unpriced: true, model: r.model, reason: `the lines of one ${r.model} message disagree on ${msg.conflicts.join(", ")}, so no single price applies` };
    }
    if (r.unpriced) {
      const key = [msg.role, r.model, r.reason].join("\u0000");
      const u = missing.get(key) ?? { model: r.model, role: msg.role, reason: r.reason, messages: 0, tokens: zeroTokens() };
      u.messages++;
      for (const k of TOKEN_KEYS) u.tokens[k] += msg.tokens[k] ?? 0;
      if ((msg.web_search_requests ?? 0) > 0) u.web_search_requests = (u.web_search_requests ?? 0) + msg.web_search_requests;
      missing.set(key, u);
      continue;
    }
    const am = r.applied_modifiers;
    const key = [msg.role, r.model, r.basis, r.period?.from ?? "", JSON.stringify(r.pricing), am ? `${am.speed}/${am.service_tier}/${am.inference_geo}/${am.multiplier}` : ""].join("\u0000");
    let e = entries.get(key);
    if (!e) {
      e = {
        model: r.model,
        role: msg.role,
        reported_as: [],
        price_basis: r.basis,
        price_period: r.period ? { from: r.period.from, to: r.period.to, source_url: r.period.source_url, verified: r.period.verified } : null,
        applied_modifiers: am ? { speed: am.speed, service_tier: am.service_tier, inference_geo: am.inference_geo, multiplier: am.multiplier, defaulted: [] } : null,
        rates: { ...r.pricing },
        messages: 0,
        tokens: zeroTokens(),
        cost_usd: 0,
      };
      entries.set(key, e);
    }
    if (typeof msg.model === "string" && !e.reported_as.includes(msg.model)) e.reported_as.push(msg.model);
    // Modifiers absent on some messages took the API default; the entry names every one that did.
    if (am) for (const d of am.defaulted) if (!e.applied_modifiers.defaulted.includes(d)) e.applied_modifiers.defaulted.push(d);
    e.messages++;
    for (const k of TOKEN_KEYS) e.tokens[k] += msg.tokens[k] ?? 0;
    // Web searches bill per request on top of tokens, at the list's per-search
    // price for the model's day. With no such price the searches are unpriced
    // (the tokens stay priced), never billed at another model's fee.
    const searches = msg.web_search_requests ?? 0;
    if (searches > 0) {
      if (r.web_search_per_request == null) {
        const sk = JSON.stringify([msg.role, r.model]);
        const s = searchesMissing.get(sk) ?? { model: r.model, role: msg.role, reason: "", messages: 0, tokens: zeroTokens(), web_search_requests: 0 };
        s.messages++;
        s.web_search_requests += searches;
        searchesMissing.set(sk, s);
      } else {
        e.web_search_requests = (e.web_search_requests ?? 0) + searches;
        searchFees.set(e, r.web_search_per_request);
      }
    }
  }
  const per_model = [...entries.values()];
  for (const e of per_model) {
    e.applied_modifiers?.defaulted.sort((a, b) => MODIFIER_KEYS.indexOf(a) - MODIFIER_KEYS.indexOf(b));
    e.cost_usd = pricer.computeCostUsd(
      { input: e.tokens.input, input_cached: e.tokens.input_cached, output: e.tokens.output, input_cache_write: e.tokens.input_cache_write_5m, input_cache_write_1h: e.tokens.input_cache_write_1h },
      e.rates
    );
    if (e.web_search_requests > 0) {
      e.web_search_cost_usd = pricer.round6(e.web_search_requests * searchFees.get(e));
      e.cost_usd = pricer.round6(e.cost_usd + e.web_search_cost_usd);
    }
  }
  const byRoleModel = (a, b) => (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2) || a.model.localeCompare(b.model);
  per_model.sort((a, b) =>
    byRoleModel(a, b) ||
    (a.price_period?.from ?? "").localeCompare(b.price_period?.from ?? "") ||
    JSON.stringify(a.applied_modifiers).localeCompare(JSON.stringify(b.applied_modifiers))
  );
  for (const s of searchesMissing.values()) {
    s.reason = `${s.web_search_requests} web search request(s) have no per-search price for ${s.model} on the price list for their day, so their fee is in no figure`;
  }
  const unpriced = [...missing.values(), ...searchesMissing.values()].sort((a, b) => byRoleModel(a, b) || a.reason.localeCompare(b.reason));
  return {
    per_model,
    unpriced,
    cost_usd: pricer.round6(per_model.reduce((s, e) => s + e.cost_usd, 0)),
    complete: unpriced.length === 0,
    custom_models: [...new Set(per_model.filter((e) => e.price_basis === "custom").map((e) => e.model))].sort(),
  };
}

/** One per_model entry's price, in words, for the console. */
function describePrice(e) {
  if (e.price_basis === "custom") return "custom policy price (pricing_override)";
  const p = e.price_period;
  const m = e.applied_modifiers;
  return (
    `list ${p.from}..${p.to ?? "open"}; ${m.speed}/${m.service_tier}/${m.inference_geo}` +
    (m.multiplier !== 1 ? ` x${m.multiplier}` : "") +
    (m.defaulted.length > 0 ? `; default ${m.defaulted.join("+")}` : "")
  );
}

/**
 * Claude Code's own end-of-session receipt: the `result` object a
 * `claude -p --output-format json` run prints (or a runner's copy of it,
 * e.g. `claude-session.json`). Returns null when the file is absent.
 * `modelUsage[model].costUSD` is what the CLI's price table multiplied —
 * the top-level `usage` can be a per-turn snapshot, so dollars and per-model
 * tokens are read from modelUsage and `usage` only supplies the TTL split.
 */
export function readReceipt(path, { required = false } = {}) {
  if (!path) return null;
  if (!existsSync(path)) {
    if (required) throw new Error(`--receipt ${path} does not exist`);
    return null;
  }
  const text = readFileSync(path, "utf-8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not one JSON object — a `--output-format stream-json` capture (the
    // headless recipe's live-run.log). The CLI's final `result` event is the
    // receipt; take the LAST one, so a resumed/continued session reports its
    // final accounting.
    const results = text.split("\n").filter((l) => l.includes('"result"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.type === "result");
    if (results.length === 0) {
      // A stream capture with no result line is a session still running —
      // exactly what the run-end step sees, because the CLI prints the
      // result event only when the process exits. An auto-discovered one is
      // "not final yet"; an explicit --receipt that is not a receipt is an error.
      if (required) throw new Error(`receipt ${path} is neither a JSON object nor a stream-json capture with a "type":"result" line`);
      return { pending: true, path };
    }
    raw = results[results.length - 1];
  }
  const r = raw?.result && typeof raw.result === "object" && raw.result.modelUsage ? raw.result : raw;
  const mu = r.modelUsage ?? {};
  const models = {};
  for (const [name, v] of Object.entries(mu)) {
    models[name] = {
      input: v.inputTokens ?? v.input_tokens ?? 0,
      input_cached: v.cacheReadInputTokens ?? v.cache_read_input_tokens ?? 0,
      input_cache_write: v.cacheCreationInputTokens ?? v.cache_creation_input_tokens ?? 0,
      output: v.outputTokens ?? v.output_tokens ?? 0,
      cost_usd: v.costUSD ?? v.cost_usd ?? null,
      // Review finding M3: server-side web searches, billed per request on top
      // of tokens. Recorded only when non-zero.
      ...((v.webSearchRequests ?? v.web_search_requests ?? 0) > 0 ? { web_search_requests: v.webSearchRequests ?? v.web_search_requests } : {}),
    };
  }
  const modelCost = Object.values(models).reduce((a, m) => a + (m.cost_usd ?? 0), 0);
  const total = typeof r.total_cost_usd === "number" ? r.total_cost_usd : (modelCost || null);
  if (total == null) throw new Error(`receipt ${path} carries neither total_cost_usd nor modelUsage[*].costUSD`);
  if (!(total > 0)) throw new Error(`receipt ${path} reports $${total} — a zero or negative receipt cannot referee anything`);
  const cc = r.usage?.cache_creation ?? {};
  // The top-level usage, when it carries all four counts. bookReceiptTokens
  // takes its 5-minute / 1-hour split only for a model whose four counts it
  // equals exactly: Claude Code writes the main loop's usage there (two real
  // receipts, CLI 2.1.245 and 2.1.270), but an older capture holds a per-turn
  // snapshot that matches no model and must not be attributed to one.
  const u = r.usage;
  const usage = u && [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens].every((n) => typeof n === "number")
    ? {
        input: u.input_tokens,
        input_cached: u.cache_read_input_tokens,
        input_cache_write: u.cache_creation_input_tokens,
        output: u.output_tokens,
        cache_write_5m: cc.ephemeral_5m_input_tokens ?? null,
        cache_write_1h: cc.ephemeral_1h_input_tokens ?? null,
      }
    : null;
  return {
    path,
    session_id: r.session_id ?? null,
    total_cost_usd: total,
    models,
    cache_write_1h: cc.ephemeral_1h_input_tokens ?? null,
    cache_write_5m: cc.ephemeral_5m_input_tokens ?? null,
    usage,
  };
}

/**
 * Dispatched telemetry that ran INSIDE the driver session — and is therefore
 * already inside the transcript-measured overhead. Adding it again on top of
 * the overhead double-counts it (measured +21% on a real run). Two shapes:
 *   - provenance `estimated` / `apportioned_from_measured_total`: the packet
 *     was executed by the session itself (an in-session subagent, or a slice
 *     of the session's own measured total handed back as per-packet events);
 *   - a `claude-cli` worker: it spawns its own `claude -p` session under the
 *     same project, whose transcript the scan above also sums.
 * `vendor` events on any other adapter are real API calls made by the
 * dispatch server outside the session: they are NOT in the transcript and
 * must stay in the total.
 *
 * A claude-cli event's cost_usd is the worker's whole ledger, including
 * receipt-only side calls and tokens its transcript never logged; the scan
 * added only the logged part. When the event carries
 * `transcript_logged_cost_usd`, only that share (never more than cost_usd) is
 * subtracted. Review finding M4: subtracting the whole cost took the unlogged
 * dollars out of the true total. Older events without the field subtract
 * cost_usd, as before.
 */
export function inSessionDispatched(events, policy, manifest, dispatched, { claudeCliScanned = true } = {}) {
  const models = policy?.models ?? [];
  const adapterById = new Map(models.map((m) => [m.id, m.adapter]));
  const adaptersByName = new Map();
  for (const m of models) adaptersByName.set(m.model_name, [...(adaptersByName.get(m.model_name) ?? []), m.adapter]);
  // A claude-cli worker is inside the overhead only when its own `claude -p`
  // session was actually summed into it — i.e. the scan was not restricted to
  // the driver's session and the figure is transcript-priced. Classify by
  // the event's model_id when it carries one; by model_name only when every
  // policy entry of that name is a claude-cli seat (an API-call event on a
  // model that is ALSO listed as a claude-cli seat must stay in the total).
  const viaClaudeCli = (ev) => {
    if (!claudeCliScanned) return false;
    if (ev.model_id != null && adapterById.has(ev.model_id)) return adapterById.get(ev.model_id) === "claude-cli";
    const adapters = adaptersByName.get(ev.model) ?? [];
    return adapters.length > 0 && adapters.every((a) => a === "claude-cli");
  };
  const isInside = (ev) =>
    ev.provenance === "estimated" ||
    ev.provenance === "apportioned_from_measured_total" ||
    viaClaudeCli(ev);
  // What subtracting one inside event removes: its whole cost, except a
  // claude-cli worker that says which share of it its transcript logged.
  const insideShare = (ev) => {
    const whole = ev.cost_usd ?? 0;
    const logged = ev.transcript_logged_cost_usd;
    if (viaClaudeCli(ev) && typeof logged === "number" && Number.isFinite(logged) && logged >= 0) return Math.min(whole, logged);
    return whole;
  };
  const work = events.filter((ev) => ev && ev.tier !== "orchestrator");
  const allCost = work.reduce((a, ev) => a + (ev.cost_usd ?? 0), 0);
  // Only events whose model the manifest's dispatched figure actually
  // contains can be inside it: a repair that later ADDED apportioned driver
  // events to the telemetry did not change what buildManifest summed.
  const modelsUsed = Array.isArray(manifest?.totals?.models_used) ? new Set(manifest.totals.models_used) : null;
  const inside = work.filter((ev) => isInside(ev) && (!modelsUsed || modelsUsed.has(ev.model)));
  const insideSum = inside.reduce((a, ev) => a + insideShare(ev), 0);
  const outsideSum = work.filter((ev) => !inside.includes(ev)).reduce((a, ev) => a + (ev.cost_usd ?? 0), 0);
  const notes = [];
  // buildManifest summed these same events into `dispatched`. The in-session
  // share can never exceed what is left of the dispatched figure after the
  // out-of-session events — real vendor calls, never rewritten by any repair
  // — are taken out. When the telemetry still sums to the manifest this is
  // exactly the in-session events' own sum; when it was rewritten after the
  // run (a repair apportioning a measured total, say) the bound is what
  // remains, and the difference is said aloud. Never below zero, never more
  // than dispatched.
  const consistent = Math.abs(allCost - dispatched) <= Math.max(0.01, 0.01 * dispatched);
  const bound = Math.max(0, Math.min(dispatched, dispatched - outsideSum));
  const cost = Math.min(insideSum, bound);
  if (!consistent && inside.length > 0 && Math.abs(cost - insideSum) > 0.000001) {
    notes.push(
      `telemetry events sum to $${allCost.toFixed(6)} but the manifest's dispatched figure is $${dispatched} — the ` +
        `telemetry was rewritten after the run. In-session events sum to $${insideSum.toFixed(6)}; only $${cost.toFixed(6)} ` +
        `(dispatched minus the out-of-session events) can be inside the dispatched figure, so that is what is subtracted.`
    );
  }
  return { cost, count: inside.length, allCost, consistent, notes };
}

function readTelemetry(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Restrict a transcript scan to one session when the receipt names it. */
export function filesForSession(files, sessionId) {
  if (!sessionId) return files;
  const mine = files.filter((f) => {
    const base = f.split("/").pop();
    return base.startsWith(sessionId) || f.includes(`/${sessionId}/`);
  });
  // A copied tree (tests, another machine) may not carry the session id in
  // its file names; scanning nothing would be worse than scanning everything.
  return mine.length > 0 ? mine : files;
}

/** Sum a receipt's per-model buckets into one set of totals. */
const sumReceiptModels = (models) =>
  Object.values(models).reduce(
    (a, m) => ({ input: a.input + m.input, input_cached: a.input_cached + m.input_cached, input_cache_write: a.input_cache_write + m.input_cache_write, output: a.output + m.output }),
    { input: 0, input_cached: 0, input_cache_write: 0, output: 0 }
  );

const fmtPct = (delta) => `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
const isoOf = (ms) => new Date(ms).toISOString();

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const passDir = resolve(args.passDir);
  const manifestPath = join(passDir, "manifest.json");
  const telemetryPath = join(passDir, "telemetry.jsonl");
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json in ${passDir} — is this a run's pass directory?`);
  }
  const modelWritten = JSON.parse(readFileSync(manifestPath, "utf-8"));
  // The call log: machine-written, one line per dispatched call.
  const logEvents = readTelemetry(telemetryPath);
  const { policyMod, routingMod, pricingMod, telemetryMod, pricesMod, effectiveMod } = await loadDist();

  // ── When the model's manifest cannot be read, rebuild it ────────────────
  //
  // manifest.json is written BY THE MODEL, by hand. `buildManifest` — the
  // function this repo wrote to produce it — had no caller that ever wrote a
  // manifest: SKILL.md's Phase 9 names it as a SHAPE for the model to imitate
  // ("Build rollup manifest using the buildManifest shape") and hands the model
  // the write. The call below is its first production caller. So the shape drifts,
  // and the two greenfield runs in this repo disagree on every field that
  // matters:
  //
  //   examples/quick-demo/passes/agent-path/.sdlc  run.pass    run.policy       run.finished_at
  //   examples/quick-demo/passes/model-path/.sdlc  run.pass_id run.policy_name  run.ended_at
  //
  // Neither puts the window where this script looks, so EVERY greenfield run
  // exited at "no parseable started_at/ended_at" before reading a transcript
  // line, and the driver's own cost has never once been booked for one.
  //
  // Chasing those names would be endless — each run invents its own. So this
  // does not read them. When the manifest's own top-level window is missing,
  // the manifest is REBUILT with `buildManifest` over the run's own
  // telemetry.jsonl, and the rebuilt object is read from there on. That file
  // is written by code, one line per dispatched call, and is the same source
  // buildManifest derives every figure from — so this is not a guess and not
  // a fallback chain: it is the repo's own builder, finally run, on the run's
  // own call log.
  //
  // The model-written file is left on disk untouched; nothing here writes it.
  let manifest = modelWritten;
  let rebuilt = false;
  const windowUnreadable = () =>
    !Number.isFinite(Date.parse(manifest.started_at)) || !Number.isFinite(Date.parse(manifest.ended_at));

  // buildManifest takes the run's identity as input — it derives every figure,
  // but it cannot know what the run was called. That is the one thing only the
  // manifest recorded, so it is read there first and from the dispatched lines
  // second (they each carry `pass` and `routing.policy_name`).
  const passIdRaw = manifestPassId(modelWritten, logEvents);
  const policyNameRaw = manifestPolicyName(modelWritten, logEvents);
  if (windowUnreadable()) {
    if (passIdRaw === undefined || passIdRaw === null || passIdRaw === "") {
      throw new Error(
        `no run id: manifest.json has no run_id/pass and telemetry.jsonl has no dispatched event carrying one — cannot rebuild the manifest`
      );
    }
    const anchorable = dispatchedOnly(logEvents).filter((ev) => Number.isFinite(Date.parse(ev.ts)));
    if (anchorable.length === 0) {
      const total = dispatchedOnly(logEvents).length;
      throw new Error(
        `manifest.json has no parseable started_at/ended_at and telemetry.jsonl has no dispatched event with a parseable ts to rebuild it from ` +
          `(${total} dispatched line(s), none timestamped) — cannot anchor the run window`
      );
    }
    manifest = telemetryMod.buildManifest(logEvents, {
      pass: String(passIdRaw),
      policy_name: policyNameRaw === undefined || policyNameRaw === null ? "" : String(policyNameRaw),
    });
    rebuilt = true;
    console.log(
      `  manifest.json carries no top-level started_at/ended_at — rebuilt from telemetry.jsonl with buildManifest (${dispatchedOnly(logEvents).length} dispatched call(s)); the model-written file is left as it is`
    );
  }

  const firstDispatchMs = Date.parse(manifest.started_at);
  const lastDispatchMs = Date.parse(manifest.ended_at);
  if (!Number.isFinite(firstDispatchMs) || !Number.isFinite(lastDispatchMs)) {
    throw new Error(`manifest.json has no parseable started_at/ended_at — cannot anchor the run window`);
  }
  // Report each anchor under the file it actually came from. Naming the manifest
  // for a value it never held printed the word `undefined` into the run's own
  // record, and a reader checking the window against the manifest would find
  // nothing there.
  const source = rebuilt ? "the manifest rebuilt from telemetry.jsonl" : "the manifest's";
  const startedAtLabel = `${source} started_at ${manifest.started_at} (= first dispatched event)`;
  const endedAtLabel = `${source} ended_at ${manifest.ended_at} (= last dispatched event)`;
  if (passIdRaw === undefined || passIdRaw === null || passIdRaw === "") {
    throw new Error(
      `no run id: manifest.json has no run_id/pass and telemetry.jsonl has no dispatched event carrying one — cannot name this run`
    );
  }
  const passId = String(passIdRaw);
  const projectRoot = resolve(args.projectRoot ?? process.cwd());

  // ── The driver's own lifecycle markers ──────────────────────────────────
  // The prompt logs `run.start` / `run.end` with `--run-id --project-root`,
  // so the file is `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` in
  // both modes; brownfield's output directory IS that directory, so the pass
  // directory's own log is the second place to look. run.start bounds the
  // search for the command turn (the turn precedes it) and is the fallback
  // opening anchor; run.end is where the closing human turn is looked for
  // and the fallback closing anchor (header, fact 5). run.end is only ever
  // read from the log that holds this run's run.start: a run.end in some
  // other file cannot be shown to be this run's.
  const runLogCandidates = [
    join(projectRoot, ".sdlc", "runs", passId, "orchestrator.log"),
    join(passDir, "orchestrator.log"),
  ];
  let runStart = null;
  for (const p of runLogCandidates) {
    const found = runStartFromLog(p, firstDispatchMs);
    if (found) { runStart = { ...found, path: p }; break; }
  }
  let runEnd = null;
  if (runStart) {
    const found = runEndFromLog(runStart.path, runStart.ms);
    if (found) runEnd = { ...found, path: runStart.path };
  }

  // Default to the policy the run recorded — pricing overhead under any
  // other policy would attribute dollars the run never saw.
  //
  // When nothing named one, `loadPolicy` picks a shipped preset. That is a
  // reasonable default but it is NOT this run's policy, and pricing a driver
  // session under a rate card the run never used is the exact class of error
  // this script exists to catch. It is not fatal — the id is required because
  // buildManifest cannot run without it, whereas a rate card can be supplied
  // after the fact with --policy or --policy-path — but it is never silent: the
  // fallback is named on stdout and the run says which policy it was priced
  // under, so a reader can see that the name came from nowhere.
  const policyNameGiven = args.policy ?? policyNameRaw;
  if (!args.policyPath && (policyNameGiven === undefined || policyNameGiven === null || policyNameGiven === "")) {
    console.log(
      `  NOTE: no policy name in manifest.json (policy/policy_name) or in any dispatched telemetry line, ` +
        `and no --policy given — falling back to this install's default policy. The driver's dollars below are ` +
        `priced under that card, NOT under a card this run recorded. Pass --policy <name> or --policy-path <file> ` +
        `to price it under the run's own.`
    );
  }
  const policy = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: policyNameGiven, projectRoot });
  if (!args.policyPath && (policyNameGiven === undefined || policyNameGiven === null || policyNameGiven === "")) {
    console.log(`  NOTE: that default resolved to policy '${policy.name}'.`);
  }
  const overrides = routingMod.parseSelectOverrides(process.env.MMO_SELECT);

  // Claude Code's own accounting for the driver session, when a runner kept
  // it (a `claude -p --output-format json` result, or `claude-session.json`
  // beside the manifest). It is the referee: transcript arithmetic that
  // disagrees with it is wrong, and is not written (header, fact 8).
  // Discovery order: --receipt, then the runner convention (claude-session.json),
  // then the headless recipe's stream capture (live-run.log, whose last line is
  // the CLI's result event). The first that exists wins.
  const receiptCandidates = args.receipt
    ? [resolve(args.receipt)]
    : [join(passDir, "claude-session.json"), join(passDir, "live-run.log")];
  const receiptPath = receiptCandidates.find((c) => existsSync(c)) ?? receiptCandidates[0];
  let receipt = readReceipt(receiptPath, { required: Boolean(args.receipt) });
  let receiptPending = false;
  if (receipt?.pending) {
    receiptPending = true;
    receipt = null;
    console.error(
      `NOTE: ${receiptPath} has no "result" line yet — the session that writes it is still running (the CLI ` +
        `prints its receipt when the process exits). The figure below is transcript-priced and UNVERIFIED. ` +
        `Re-run this collector once the session has exited to verify it against the receipt; re-running is safe.`
    );
  }

  // ── Candidate transcript files ──────────────────────────────────────────
  // Pruned by mtime against the earliest anchor the window could open at:
  // the command turn precedes run.start by seconds and every run message is
  // written after it, so a file whose last write predates run.start (else
  // the first dispatch) minus the slack cannot hold this run.
  const tDir = args.transcriptsDir ? resolve(args.transcriptsDir) : transcriptsDirFor(projectRoot);
  const candidates = candidateTranscripts(tDir, runStart ? runStart.ms : firstDispatchMs);
  const topLevel = candidates.filter((f) => dirname(f) === tDir);
  const turnsByFile = new Map(topLevel.map((f) => [f, humanTurns(f)]));

  // ── The command turn: where the invocation, and so the window, begins ───
  // Candidates: run commands at or before run.start (else the first
  // dispatch) that name this run id or none. Preference, in order: a turn
  // in the receipt's own session (the receipt says which invocation it
  // bills), a turn naming this run id, then the latest. Two concurrent runs
  // of the same project with no receipt are the one case this cannot tell
  // apart — such runs are unverified anyway, and the docs say so.
  const commandBoundMs = runStart ? runStart.ms : firstDispatchMs;
  let commandTurn = null;
  for (const turns of turnsByFile.values()) {
    for (const t of turns) {
      if (!t.command || t.ms > commandBoundMs) continue;
      if (t.run_id != null && t.run_id !== passId) continue;
      const rank = (receipt?.session_id && t.session_id === receipt.session_id ? 2 : 0) + (t.run_id === passId ? 1 : 0);
      if (!commandTurn || rank > commandTurn.rank || (rank === commandTurn.rank && t.ms > commandTurn.ms)) commandTurn = { ...t, rank };
    }
  }
  if (commandTurn && receipt?.session_id && commandTurn.session_id !== receipt.session_id) {
    // The receipt bills one session; the run's command turn is in another.
    // Either the receipt was copied from a different run or the receipt's
    // session file is not in this tree. Neither can be verified.
    console.error(
      `collect-orchestrator-usage FAILED: the receipt ${receipt.path} is for session ${receipt.session_id}, but the ` +
        `run's command turn (${commandTurn.iso}) is in session ${commandTurn.session_id} (${commandTurn.file}), and ` +
        `session ${receipt.session_id} holds no command turn for run '${passId}'. A receipt for another session cannot ` +
        `referee this run. Nothing was written.`
    );
    return 3;
  }

  // ── Pin the scan to one session ─────────────────────────────────────────
  // With a command turn, the files are that turn's session file plus its
  // subagent files; the receipt's session id does the same job without one.
  // Unpinned (no command turn, no receipt session in the tree — a copied
  // tree, tests) the scan takes every candidate, and the receipt rule below
  // is what catches a stray session.
  let files;
  let pinned;
  let pinnedId;
  // Set only by the opening-anchor branch that starts at the first dispatched
  // call: everything the driver did before it is outside the window, so the
  // overhead can only be under-reported, never over.
  let overheadIsFloor = false;
  let mainFile;
  if (commandTurn) {
    pinnedId = commandTurn.session_id;
    files = candidates.filter((f) => f === commandTurn.file || basename(f).startsWith(pinnedId) || f.includes(`/${pinnedId}/`));
    pinned = true;
    mainFile = commandTurn.file;
  } else {
    files = filesForSession(candidates, receipt?.session_id);
    pinned = Boolean(receipt?.session_id) && files.some((f) => basename(f).startsWith(receipt.session_id) || f.includes(`/${receipt.session_id}/`));
    pinnedId = pinned ? receipt.session_id : null;
    mainFile = pinned ? (topLevel.find((f) => basename(f).startsWith(receipt.session_id)) ?? null) : null;
  }
  const mainTurns = mainFile ? (turnsByFile.get(mainFile) ?? humanTurns(mainFile)) : [];

  // ── Opening anchor ──────────────────────────────────────────────────────
  let windowStartMs;
  let startAnchor;
  let startExact;
  let startLine;
  if (commandTurn) {
    windowStartMs = commandTurn.ms;
    startAnchor = "command turn";
    startExact = true;
    startLine = `opens at the run's command turn ${commandTurn.iso} in ${commandTurn.file} (exact: the invocation the CLI bills begins there)`;
  } else if (runStart) {
    windowStartMs = runStart.ms - WINDOW_SLACK_MS;
    startAnchor = "run.start - 5m";
    startExact = false;
    startLine = `opens at run.start ${runStart.iso} in ${runStart.path} minus 5 minutes (approximate: no run command turn found in ${tDir})`;
  } else {
    windowStartMs = firstDispatchMs - WINDOW_SLACK_MS;
    startAnchor = rebuilt ? "telemetry rebuild started_at - 5m" : "manifest started_at - 5m";
    // THIS BRANCH PRODUCES A FLOOR, NOT AN APPROXIMATION.
    //
    // started_at is the first DISPATCHED call, so opening the window there drops
    // every driver message before it — reading the brief, requirements analysis,
    // planning. That is not noise around a true value, it is missing spend, and
    // it only ever runs one way: the reported cost is at or below the real one.
    // Measured: 22% low on v37-agsdk-1 (docs/methodology.md), and 83% low on a
    // nested-window receivables fixture ($16.15 real, $2.78 reported).
    //
    // "approximate" reads as "give or take". A figure that can be a fifth of the
    // truth must not be quoted that way — it is the same failure this script
    // exists to end, one order of magnitude smaller. So it is labelled a lower
    // bound, in the console, in the report line and in the run's own record.
    overheadIsFloor = true;
    startExact = false;
    startLine = `opens at ${startedAtLabel} minus 5 minutes (approximate: no run command turn found in ${tDir} and no run.start line in ${runLogCandidates[0]})`;
  }

  // ── Closing anchor ──────────────────────────────────────────────────────
  // Exact when a pinned session file can be read: the first human turn after
  // run.end starts the next invocation (excluded), and no such turn means the
  // session file ends with this invocation. Without run.end the session file
  // is still exact when no human turn follows the opening at all. Otherwise
  // approximate: run.end (else ended_at) plus the slack.
  let windowEndMs;
  let endAnchor;
  let endExact;
  let endLine;
  if (runEnd && mainFile) {
    const next = mainTurns.find((t) => t.ms > runEnd.ms);
    if (next) {
      windowEndMs = next.ms;
      endAnchor = "next human turn after run.end";
      endExact = true;
      endLine = `closes at the next human turn ${next.iso} after run.end ${runEnd.iso} in ${runEnd.path} (exact: that turn starts the next invocation and is excluded)`;
    } else {
      windowEndMs = Number.POSITIVE_INFINITY;
      endAnchor = "end of session";
      endExact = true;
      endLine = `closes at the end of the session file: run.end ${runEnd.iso} in ${runEnd.path} and no later human turn (exact)`;
    }
  } else if (runEnd) {
    windowEndMs = runEnd.ms + WINDOW_SLACK_MS;
    endAnchor = "run.end + 5m";
    endExact = false;
    endLine = `closes at run.end ${runEnd.iso} in ${runEnd.path} plus 5 minutes (approximate: the scan is not pinned to a session file, so no human turn can bound it)`;
  } else if (mainFile && !mainTurns.some((t) => t.ms > windowStartMs)) {
    windowEndMs = Number.POSITIVE_INFINITY;
    endAnchor = "end of session";
    endExact = true;
    endLine = `closes at the end of the session file: no run.end line in ${runLogCandidates[0]}, and no human turn after the window opens (exact)`;
  } else {
    windowEndMs = lastDispatchMs + WINDOW_SLACK_MS;
    endAnchor = rebuilt ? "telemetry rebuild ended_at + 5m" : "manifest ended_at + 5m";
    endExact = false;
    endLine =
      `closes at ${endedAtLabel} plus 5 minutes (approximate: no run.end line in ${runLogCandidates[0]}` +
      (mainFile ? ", and a human turn after the window opens that only run.end could place)" : ", and the scan is not pinned to a session file)");
  }
  const windowExact = startExact && endExact;
  const finiteEnd = Number.isFinite(windowEndMs);

  // A window that closes in the future (the run-end step invokes this from
  // inside the session) cannot be observed past now. Reading it as-is would
  // silently report a partial measurement as a complete one, so clamp to now
  // and say how much of the window was unobservable.
  const collectedAtMs = Date.now();
  const unobservableMs = finiteEnd ? Math.max(0, windowEndMs - collectedAtMs) : 0;
  const effectiveEndMs = finiteEnd ? Math.min(windowEndMs, collectedAtMs) : windowEndMs;

  const roleOf = (f) => roleOfTranscript(tDir, f);
  const { tokens, stats, observedModels, perModel, messages } = sumTranscriptUsage(files, windowStartMs, effectiveEndMs, { roleOf });

  console.log(
    `collect-orchestrator-usage: pass '${passId}' window ${isoOf(windowStartMs)} → ${finiteEnd ? isoOf(windowEndMs) : "end of session"}` +
      (windowExact ? "" : " (approximate)") +
      (overheadIsFloor ? " — LOWER BOUND" : "")
  );
  if (overheadIsFloor) {
    console.log(
      `  ! the overhead below is a LOWER BOUND, not an estimate: the window opens at the first dispatched call, ` +
        `so every driver message before it (brief, requirements, planning) is outside it. The real figure is higher — ` +
        `by 22% on one measured run and by 83% on another. Do not quote it as a measurement. To close the gap, run ` +
        `the collector where the run's .sdlc/runs/<run-id>/orchestrator.log and the driver's session transcript live.`
    );
  }
  console.log(`  ${startLine}`);
  console.log(`  ${endLine}`);
  if (runStart && firstDispatchMs - runStart.ms > 60 * 60_000) {
    // Not an error — a gate left open before the first dispatch does this —
    // but a stale log under a reused run id looks the same, so say it.
    console.error(
      `NOTE: run.start is ${Math.round((firstDispatchMs - runStart.ms) / 60_000)} minutes before the first dispatched ` +
        `event. If this run reused an earlier run's id, check ${runStart.path} holds this run's own run.start line ` +
        `(the receipt cross-check below is the referee).`
    );
  }
  console.log(`transcripts: ${tDir}${pinned ? ` (scan pinned to session ${pinnedId}${finiteEnd ? "" : "; no upper time bound"})` : ""}`);
  console.log(
    `scanned ${stats.files} file(s), ${stats.lines} line(s): counted ${stats.counted} unique API message(s) ` +
      `(${stats.duplicates} duplicate content-block line(s) skipped, ${stats.synthetic} synthetic, ${stats.outside_window} outside window)`
  );
  console.log(`observed_models ${JSON.stringify(observedModels)}`);
  if (receipt) {
    const perModelCost = Object.fromEntries(Object.entries(receipt.models).map(([k, v]) => [k, v.cost_usd]));
    console.log(`receipt: ${receipt.path} → $${receipt.total_cost_usd} ${JSON.stringify(perModelCost)}`);
  }
  if (unobservableMs > 0) {
    console.error(
      `NOTE: the declared window extends ${Math.round(unobservableMs / 1000)}s past this ` +
        `collection. Messages written after now cannot be counted, so this figure is a ` +
        `lower bound. Re-run after the window closes for the complete measurement.`
    );
  }

  const receiptOnly = stats.counted === 0 && receipt != null;
  if (stats.counted === 0 && !receipt) {
    console.error(
      `collect-orchestrator-usage FAILED: no billable assistant messages found in the run window. ` +
        `The run was driven by a session, so this almost always means the wrong --project-root ` +
        `(transcript location is derived from it) or a transcript tree that lives elsewhere ` +
        `(--transcripts-dir). Nothing was written.`
    );
    return 1;
  }

  // ── Price every message on its own (header, fact 6) ─────────────────────
  // Model, day, modifiers and cache-write split come from the message; the
  // rate from the dated price list (or a pricing_override card). Nothing here
  // depends on which model the policy drives with.
  const pricer = makeMessagePricer(policy, { pricesMod, effectiveMod, pricingMod });
  const priced = priceMessages(messages, pricer);
  for (const w of pricer.warnings) console.error(`NOTE: ${w}`);
  const transcriptCost = priced.cost_usd;
  let pricingBasis =
    `each message at its own model's list price on its own day (price list verified ${pricesMod.PRICE_LIST_VERIFIED})` +
    (priced.custom_models.length > 0 ? `; custom policy price under pricing_override for ${priced.custom_models.join(", ")}` : "");
  if (stats.counted > 0) {
    console.log(`per-model pricing (price list verified ${pricesMod.PRICE_LIST_VERIFIED}):`);
    for (const e of priced.per_model) {
      console.log(
        `  ${e.role.padEnd(7)} ${e.model} [${describePrice(e)}]: in ${e.tokens.input} · cached ${e.tokens.input_cached} · ` +
          `write 5m ${e.tokens.input_cache_write_5m} / 1h ${e.tokens.input_cache_write_1h} · out ${e.tokens.output} ` +
          `(${e.messages} message(s)) = $${e.cost_usd}`
      );
    }
  }
  if (!priced.complete) {
    const tokenCount = (t) => TOKEN_KEYS.reduce((s, k) => s + t[k], 0);
    const total = priced.unpriced.reduce((s, u) => s + tokenCount(u.tokens), 0);
    const count = priced.unpriced.reduce((s, u) => s + u.messages, 0);
    console.error(
      `WARNING: ${total} token(s) on ${count} message(s) in the window could not be priced, so the transcript figure is ` +
        `INCOMPLETE: it leaves them out rather than borrow another model's price.\n` +
        priced.unpriced.map((u) => `  ${u.role} ${u.model}: ${tokenCount(u.tokens)} token(s) on ${u.messages} message(s) — ${u.reason}`).join("\n")
    );
    if (args.strictPricing) {
      console.error(
        `collect-orchestrator-usage FAILED: --strict-pricing, and ${total} token(s) have no price on the list ` +
          `(${[...new Set(priced.unpriced.map((u) => u.model))].join(", ")}). Nothing was written.`
      );
      return 1;
    }
  }

  // ── Which model labels the orchestrator event ───────────────────────────
  // The event carries one `model`; per_model[] is the breakdown. In order: the
  // policy's derived driver model; the one model the session ran, when the
  // policy names it; the receipt's dominant model; the model most messages
  // ran on; the policy's in-session seat.
  const observedNames = Object.keys(observedModels).filter((m) => m !== "(unlabeled)");
  const receiptNames = receipt ? Object.keys(receipt.models) : [];
  const single = observedNames.length === 1 ? observedNames[0] : receiptNames.length === 1 ? receiptNames[0] : null;
  let derived;
  let driver;
  let labelBasis = "the policy's derived driver model";
  try {
    derived = deriveDriverModel(policy, routingMod, overrides);
    driver = policy.models.find((m) => m.id === derived.modelId);
  } catch (err) {
    // A claude-cli entry is a worker seat, so it is the last choice to label a driver.
    const byName = single ? policy.models.filter((m) => m.model_name === single) : [];
    const named = byName.find((m) => m.adapter !== "claude-cli") ?? byName[0];
    const inSession = policy.models.find((m) => m.adapter === "builtin-anthropic");
    const busiest = Object.entries(observedModels).filter(([n]) => n !== "(unlabeled)").sort((a, b) => b[1] - a[1])[0]?.[0];
    if (named) {
      derived = { modelName: named.model_name, modelId: named.id };
      driver = named;
      labelBasis = `the session's observed model '${single}' (the policy's '${named.id}' entry)`;
    } else if (receipt) {
      const dominant = Object.entries(receipt.models).sort((a, b) => (b[1].cost_usd ?? 0) - (a[1].cost_usd ?? 0))[0];
      derived = { modelName: dominant ? dominant[0] : "(receipt)", modelId: null };
      driver = null;
      labelBasis = `the receipt (policy '${policy.name}' prices no Claude model; receipt bills ${receiptNames.length ? receiptNames.join(" + ") : "an unnamed model"})`;
    } else if (busiest) {
      derived = { modelName: busiest, modelId: null };
      driver = null;
      labelBasis = `the model most messages ran on, '${busiest}' (policy '${policy.name}' names none of the session's models)`;
    } else if (inSession) {
      derived = { modelName: inSession.model_name, modelId: inSession.id };
      driver = inSession;
      labelBasis = "the policy's in-session model (judgment tier is not in-session)";
    } else {
      derived = { modelName: "(unlabeled)", modelId: null };
      driver = null;
      labelBasis = "no model name (no message in the window names one)";
    }
    console.error(
      `NOTE: ${err.message}\nThe orchestrator event is labelled with ${labelBasis}. Its dollars are priced per message ` +
        `from the price list either way: the session runs on Claude Code whatever the policy routes the judgment tier to.`
    );
  }

  // The receipt diagnostics below (implied cache-write rate, rate drift) read
  // one card: the labelled driver's effective price on the window's first day.
  // They inform; the receipt decision is per token bucket.
  const driverPrice = driver ? effectiveMod.effectivePrice(driver, isoOf(windowStartMs), {}) : null;
  const card = driverPrice && !driverPrice.unpriced ? driverPrice.pricing : null;
  const cardName = card && driverPrice.basis === "custom" ? "the policy card" : "the price list";
  const approxTag = overheadIsFloor ? "; LOWER BOUND — window opens at the first dispatch" : windowExact ? "" : "; approximate window";
  // A transcript-priced figure that left unpriced tokens out says so in its label.
  const transcriptTags = approxTag + (priced.complete ? "" : "; INCOMPLETE — unpriced tokens excluded");

  // ── The receipt rule ────────────────────────────────────────────────────
  let cost;
  let costSource;
  // Set when a receipt is booked (header, fact 8): its token counts priced
  // from the list, never Claude Code's own dollars.
  let booking = null;

  // Every helper the session ran should have its transcript file. Only a scan
  // pinned to a session file can check it; the result is recorded whatever
  // the cost source (header, fact 8).
  const helperFiles = pinned && mainFile && pinnedId ? sessionHelperFiles(tDir, pinnedId) : [];
  // `let`: a receipt booked for the last invocation of a resumed window replaces
  // this whole-session check with one scoped to that invocation (Q1).
  let attribution = pinned && mainFile && pinnedId ? helperAttribution(mainFile, helperFiles, { root: tDir }) : null;
  if (attribution) {
    console.log(
      `helpers: ${attribution.referenced.length} named by Agent/Task results, ${helperFiles.length} transcript file(s) → ` +
        `attribution ${attribution.complete ? "complete" : "INCOMPLETE"}`
    );
    if (!attribution.complete) {
      console.error(
        `NOTE: attribution incomplete — ` +
          [
            ...attribution.missing_helper_ids.map((id) => `helper ${id} named by an Agent/Task result has no transcript file`),
            ...attribution.unreferenced_helper_files.map((f) => `${f} is named by no Agent/Task result`),
          ].join("; ") +
          `. A booked receipt's total is unaffected, but a missing helper's tokens are counted in unlogged_billed ` +
          `instead of per_model. Copy the session's whole subagents/ directory to keep the breakdown.`
      );
    }
  }

  // The receipt's model names and the transcript's, re-keyed by price-list id
  // (header, fact 8): `claude-opus-5[1m]` on a receipt is the transcript's
  // `claude-opus-5`. Q2: a name this run's policy declares under
  // pricing_override is read the same way (runModelResolver). Any other name
  // could only be paired by guesswork, so it refuses, printing both sides'
  // names and both ways to make the name known.
  const resolveName = runModelResolver(policy, pricesMod.resolveModel);
  const names = receipt ? resolveBucketNames(perModel, receipt.models, resolveName) : null;
  if (names && (names.unresolved.transcript.length > 0 || names.unresolved.receipt.length > 0)) {
    const u = names.unresolved;
    console.error(
      `collect-orchestrator-usage FAILED: cannot resolve model name(s) the price list does not carry: ` +
        `${[...u.transcript.map((n) => `transcript ${n}`), ...u.receipt.map((n) => `receipt ${n}`)].join(", ")}. The receipt check ` +
        `pairs the receipt's models with the transcript's by price-list id, and a name that neither the list nor this run's ` +
        `policy (a model_name under pricing_override: true) declares would have to be paired by guesswork. transcript names: ` +
        `${Object.keys(perModel).filter((n) => n !== "(unlabeled)").sort().join(", ") || "(none)"}; ` +
        `receipt names: ${Object.keys(receipt.models).sort().join(", ") || "(none)"}. Add the model's verified price period to ` +
        `plugin/mcp/model-dispatch/src/prices.ts, or, for a name the policy uses on purpose (a gateway alias, say), give the ` +
        `policy model a pricing block with pricing_override: true and that model_name; then re-run. Nothing was written.`
    );
    return 3;
  }
  if (names) {
    const renamed = (map) => Object.entries(map).flatMap(([id, v]) => v.names.filter((n) => n !== id).map((n) => `${n} → ${id}`)).sort();
    if (renamed(names.receipt).length > 0) console.log(`  receipt names resolved: ${renamed(names.receipt).join(", ")}`);
    if (renamed(names.transcript).length > 0) console.log(`  transcript names resolved: ${renamed(names.transcript).join(", ")}`);
  }

  // v0.7.3 review fix: a receipt with Claude Code's dollars but no modelUsage
  // has nothing to check the transcript against and nothing to price, on any
  // path. Only the no-transcript path used to say so: with transcript lines in
  // the window, every model read as "in the transcript, none on the receipt",
  // and the refusal blamed the window (a stale run.start, a reused run id)
  // instead of the receipt. Every receipt name resolved above, so an empty
  // re-keyed map means exactly an empty modelUsage.
  if (names && Object.keys(names.receipt).length === 0) {
    console.error(
      `collect-orchestrator-usage FAILED: the receipt ${receipt.path} carries no per-model token counts (modelUsage), so there ` +
        `is nothing to check the transcript against or to price. Claude Code's own dollar figure is never booked. Keep the ` +
        `result line of claude -p --output-format json or stream-json, which carries modelUsage, or move this file out of ` +
        `the pass directory to collect a transcript-priced figure labelled unverified. Nothing was written.`
    );
    return 3;
  }

  // A model with no logged message is priced on the window's opening and its
  // last known moment: the last counted message, else the window's (clamped)
  // close, else the last dispatched event.
  const lastMessageMs = messages.reduce((mx, m) => {
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) && t > mx ? t : mx;
  }, Number.NEGATIVE_INFINITY);
  const referenceEndMs = Number.isFinite(lastMessageMs) ? lastMessageMs : finiteEnd ? Math.min(windowEndMs, collectedAtMs) : lastDispatchMs;
  const referenceTimes = [isoOf(windowStartMs), isoOf(Math.max(windowStartMs, referenceEndMs))];

  /**
   * Books the receipt's token counts at the list (bookReceiptTokens) for the
   * part of the window the receipt bills, and prints the gap. The part is the
   * whole window by default; for a resumed window it is the last invocation
   * (Q1), passed as its re-keyed receipt map, its priced messages, its token
   * counts and its reference days. Either way:
   *   - the token fields become the window's minus the part's logged tokens plus
   *     the receipt's (for the whole window, exactly the receipt's, as before);
   *   - cost_usd = transcript_cost_usd + unlogged_billed.cost_usd, because the
   *     logged part of the booking is the part's own per-message figure, which
   *     the whole-window transcript figure already holds (for the whole window
   *     this is bookReceiptTokens' own cost, as before).
   * Returns the gap's share of the booked part, in percent.
   */
  const book = ({ receiptMap = names.receipt, part = priced, partTokens = { ...tokens }, refTimes = referenceTimes, label = "  booked" } = {}) => {
    booking = bookReceiptTokens({ receipt: receiptMap, priced: part, pricer, referenceTimes: refTimes, receiptUsage: receipt.usage });
    for (const k of ["input", "input_cached", "input_cache_write", "input_cache_write_5m", "input_cache_write_1h", "output"]) {
      tokens[k] = tokens[k] - partTokens[k] + booking.tokens[k];
    }
    cost = pricingMod.round6(transcriptCost + booking.unlogged_billed.cost_usd);
    const share = booking.cost_usd > 0 ? (booking.unlogged_billed.cost_usd / booking.cost_usd) * 100 : 0;
    console.log(
      `${label}: logged $${booking.logged_cost_usd} + billed but not logged $${booking.unlogged_billed.cost_usd} ` +
        `(${share.toFixed(1)}%) = $${booking.cost_usd}`
    );
    for (const g of booking.unlogged_billed.per_model) {
      console.log(
        `    not logged ${g.model}${g.receipt_only ? " (no logged message)" : ""}: in ${g.tokens.input} · cached ${g.tokens.input_cached} · ` +
          `cache_write ${g.tokens.input_cache_write} · out ${g.tokens.output} [${g.ttl_split}${g.assumed.length ? `; ${g.assumed.join("; ")}` : ""}] = $${g.cost_usd}`
      );
    }
    return share;
  };
  /** Receipt tokens the list cannot price: warned; with --strict-pricing, refused (true = refuse). */
  const strictRefusesBooking = () => {
    const gapUnpriced = booking.unlogged_billed.unpriced;
    if (gapUnpriced.length === 0) return false;
    const count = (t) => RECEIPT_BUCKETS.reduce((s, k) => s + t[k], 0);
    console.error(
      `WARNING: the receipt bills ${gapUnpriced.reduce((s, x) => s + count(x.tokens), 0)} token(s) no transcript message recorded ` +
        `and the list cannot price, so the booked figure is INCOMPLETE: it leaves them out rather than borrow another price.\n` +
        gapUnpriced.map((x) => `  ${x.model} (${x.reported_as.join(", ")}): ${count(x.tokens)} token(s) — ${x.reason}`).join("\n")
    );
    if (!args.strictPricing) return false;
    console.error(
      `collect-orchestrator-usage FAILED: --strict-pricing, and receipt tokens for ${gapUnpriced.map((x) => x.model).join(", ")} ` +
        `have no price on the list. Nothing was written.`
    );
    return true;
  };
  const customTag = () => (booking.custom_models.length > 0 ? `; custom policy price for ${booking.custom_models.join(", ")}` : "");
  /** Claude Code's own dollars are a check only: more than RECEIPT_CLI_DRIFT away from the booked figure is a NOTE. */
  const noteDrift = () => {
    const cli = receipt.total_cost_usd;
    if (!(booking.cost_usd > 0)) return;
    const drift = (cli - booking.cost_usd) / booking.cost_usd;
    if (Math.abs(drift) <= RECEIPT_CLI_DRIFT) return;
    console.error(
      `NOTE: Claude Code's own price table differs from the price list on this run: the receipt's token counts come to ` +
        `$${booking.cost_usd} at ${booking.custom_models.length > 0 ? "the price list and the policy's pricing_override cards" : "the price list"} ` +
        `(booked), but the receipt says $${pricingMod.round6(cli)} (${fmtPct(drift)} against the booked figure). Per model: ` +
        booking.by_model.map((m) => `${m.model} $${m.cost_usd} vs $${m.cli_cost_usd == null ? "?" : pricingMod.round6(m.cli_cost_usd)}`).join("; ") +
        `. Claude Code's dollars are kept as receipt_cli_usd and never booked. Either its table or ` +
        `plugin/mcp/model-dispatch/src/prices.ts is out of date, or unlogged tokens were billed at a cache-write TTL other ` +
        `than the one assumed in unlogged_billed.`
    );
  };

  if (receiptOnly) {
    // No transcript line fell in the window, but the receipt's token counts
    // did. They are priced from the list like any booked receipt, with every
    // model receipt-only; only attribution to phases is lost, and that is said.
    // A receipt with no modelUsage was refused above, before either path.
    book();
    if (strictRefusesBooking()) return 1;
    costSource = `receipt-only (Anthropic token counts priced at the price list${customTag()})${booking.complete ? "" : "; INCOMPLETE — unpriced tokens excluded"}`;
    // Label the figure with what the receipt says ran, not what the policy
    // would have priced: the two differ exactly when the policy was not the
    // driver (an Opus 4.8 session under a Gemini-worker policy, say).
    const dominant = Object.entries(receipt.models).sort((a, b) => (b[1].cost_usd ?? 0) - (a[1].cost_usd ?? 0))[0];
    if (dominant) {
      derived = { modelName: dominant[0], modelId: null };
      pricingBasis = `the receipt's token counts at the price list (${Object.keys(receipt.models).join(" + ")})`;
    }
    console.error(
      `NOTE: no transcript lines fell in the window (${tDir}), but the receipt ${receipt.path} carries the session's ` +
        `own token counts: priced from the list they come to $${cost} (Claude Code's own figure: ` +
        `$${pricingMod.round6(receipt.total_cost_usd)}). Attribution to phases is not possible without the transcript.`
    );
    noteDrift();
  } else if (receipt) {
    const rm = sumReceiptModels(receipt.models);
    const delta = transcriptCost == null ? null : (transcriptCost - receipt.total_cost_usd) / receipt.total_cost_usd;
    const pct = delta == null ? null : fmtPct(delta);
    // What the receipt's dollars imply the cache-write rate was, given the
    // policy card's other three rates — the diagnostic that found the 1-hour
    // tier. Informational; the decision is the bucket rule below.
    let implied = "";
    if (card && rm.input_cache_write > 0) {
      const pr = card;
      const nonWrite = (rm.input * pr.input + rm.input_cached * pr.input_cached + rm.output * pr.output) / 1_000_000;
      const rate = ((receipt.total_cost_usd - nonWrite) / rm.input_cache_write) * 1_000_000;
      implied =
        `; receipt implies a cache-write rate of $${rate.toFixed(2)}/M (${cardName}: 5-minute $${(pr.input_cache_write ?? pr.input * 1.25).toFixed(2)}, ` +
        `1-hour $${(pr.input_cache_write_1h ?? pr.input * 2).toFixed(2)})`;
    }
    console.log(
      `receipt cross-check: transcript $${transcriptCost} vs receipt $${receipt.total_cost_usd}` +
        `${pct ? ` → ${pct}` : ""} (informational; the decision is per token bucket)${implied}`
    );
    console.log(
      `  tokens transcript in ${tokens.input} · cached ${tokens.input_cached} · cache_write ${tokens.input_cache_write} · out ${tokens.output}` +
        ` | receipt in ${rm.input} · cached ${rm.input_cached} · cache_write ${rm.input_cache_write} · out ${rm.output}`
    );
    // Per price-list model, not per spelling (header, fact 8).
    const cmp = compareBuckets(names.transcript, names.receipt);
    for (const l of cmp.lines) console.log(`  ${l}`);
    if (cmp.unrecorded.length > 0) {
      const detail = cmp.unrecorded.map((m) => {
        const r = names.receipt[m];
        return `${m} (${r.input + r.input_cached + r.input_cache_write + r.output} tokens, $${r.cost_usd ?? "?"})`;
      }).join(", ");
      console.error(
        `NOTE: the receipt also bills ${detail} for calls the transcript does not record — the CLI's own side calls ` +
          `(session titles, summaries), or a helper whose transcript file is missing. When the receipt is booked, their ` +
          `tokens are priced from the list inside unlogged_billed.`
      );
    }
    // A bucket BELOW the receipt no longer refuses by itself: the decision is
    // in the branch after ABOVE, where the window's provability is checked.
    if (cmp.above.length > 0) {
      // The window holds messages the receipt never billed. The one honest
      // explanation is another invocation on the same session inside the
      // window — a runner's `--resume` continuation, whose receipt covers
      // only the last leg. That leaves a human turn behind, so check the
      // last invocation alone with the same exact rule.
      const turnsInWindow = mainTurns.filter((t) => t.ms >= windowStartMs && t.ms < windowEndMs);
      if (turnsInWindow.length >= 2) {
        const last = turnsInWindow[turnsInWindow.length - 1];
        const earlierCount = turnsInWindow.length - 1;
        const lastInv = sumTranscriptUsage(files, last.ms, effectiveEndMs, { roleOf });
        // The last leg is compared per price-list model too (header, fact 8).
        const lastNames = resolveBucketNames(lastInv.perModel, receipt.models, resolveName);
        const cmpLast = compareBuckets(lastNames.transcript, lastNames.receipt);
        console.log(`  last invocation (from the human turn at ${last.iso}, ${earlierCount} earlier turn(s) in the window):`);
        for (const l of cmpLast.lines) console.log(`    ${l}`);
        // Priced per message like the whole window, so no policy rate is needed.
        const pricedLast = priceMessages(lastInv.messages, pricer);
        const lastPct = fmtPct((pricedLast.cost_usd - receipt.total_cost_usd) / receipt.total_cost_usd);
        console.log(`    transcript $${pricedLast.cost_usd} vs receipt $${receipt.total_cost_usd} → ${lastPct} (informational; the decision is per token bucket)`);
        // Q1 (v0.7.3): the last invocation gets the main path's rule (header,
        // fact 8c-d), where it used to need every bucket EQUAL. Claude Code bills
        // calls it never logs in an invocation (2.3% and 22% on two measured
        // single-invocation runs), and nothing about a --resume leg stops that,
        // so equality refused a last leg with such calls with exit 3, and an
        // equal leg was written transcript-priced while its receipt sat unused. Now:
        //   - a bucket ABOVE the receipt: exit 3, as before;
        //   - a bucket BELOW: booked only when the last invocation is provably
        //     the receipt's invocation (pinned to the receipt's session, opened
        //     at its own human turn, no later human turn, an exact close);
        //   - otherwise (every bucket equal, output at most): booked, the
        //     equality being its own proof, as on the main path.
        // Booking prices the receipt's tokens at the list for that invocation
        // only; the earlier invocations stay transcript-priced and unverified.
        if (cmpLast.above.length > 0) {
          console.error(
            `collect-orchestrator-usage FAILED: the receipt matches neither the whole window nor its last invocation. ` +
              `Whole window: ${cmp.above.join("; ")}. Last invocation (from ${last.iso}): ` +
              `${[...cmpLast.above, ...cmpLast.short].join("; ")}. Nothing was written; no number is guessed.`
          );
          return 3;
        }
        if (cmpLast.short.length > 0) {
          // Human turns at or after the window's close, exactly as the main path counts them.
          const laterTurns = mainTurns.filter((t) => t.ms >= windowEndMs);
          const proof = provableInvocation({
            receiptSessionId: receipt.session_id,
            pinnedId,
            startAnchor: LAST_INVOCATION_ANCHOR,
            // 1 by construction (last is the window's last human turn); counted, not assumed.
            humanTurnsInWindow: mainTurns.filter((t) => t.ms >= last.ms && t.ms < windowEndMs).length,
            laterHumanTurns: laterTurns.length,
            laterHumanTurnFrom: laterTurns[0]?.iso ?? null,
            // The last invocation opens at a human turn, which is exact whatever
            // anchored the whole window's opening, so only the close can be approximate.
            windowExact: endExact,
            lowerBound: false,
          });
          if (!proof.provable) {
            console.error(
              `collect-orchestrator-usage FAILED: the receipt matches neither the whole window nor its last invocation. ` +
                `Whole window: ${cmp.above.join("; ")}. The last invocation (from ${last.iso}) is BELOW the receipt ` +
                `(${cmpLast.short.join("; ")}) and cannot be proven to be the receipt's invocation: ${proof.reasons.join("; ")}. ` +
                `A last invocation below the receipt is booked only when it provably is that invocation (pinned to the receipt's ` +
                `session, opened at its own human turn, no later human turn, an exact close), because the gap is then calls ` +
                `Claude Code bills but never logs. Nothing was written; no number is guessed.`
            );
            return 3;
          }
          console.log(
            `    below the receipt, and the last invocation is provably its invocation (session ${pinnedId}, opened at its human ` +
              `turn ${last.iso}, no later human turn, exact close): the difference is billed but not logged`
          );
        }
        // Attribution over the booked invocation's helpers only: a helper file
        // missing from an earlier invocation is in no booked figure, while one
        // missing from this invocation moves its tokens into unlogged_billed.
        if (pinned && mainFile && pinnedId) {
          attribution = helperAttribution(mainFile, helperFiles, { root: tDir, fromMs: last.ms, toMs: windowEndMs });
          const compared = attribution.referenced.length - attribution.missing_helper_ids.length + attribution.unreferenced_helper_files.length;
          console.log(
            `    last invocation helpers: ${attribution.referenced.length} named by Agent/Task results, ${compared} transcript file(s) → ` +
              `attribution ${attribution.complete ? "complete" : "INCOMPLETE"}`
          );
          if (!attribution.complete) {
            console.error(
              `NOTE: the last invocation's attribution is incomplete — ` +
                [
                  ...attribution.missing_helper_ids.map((id) => `helper ${id} named by an Agent/Task result has no transcript file`),
                  ...attribution.unreferenced_helper_files.map((f) => `${f} is named by no Agent/Task result`),
                ].join("; ") +
                `. The booked total is unaffected, but a missing helper's tokens are counted in unlogged_billed instead of per_model.`
            );
          }
        }
        const lastMsgMs = lastInv.messages.reduce((mx, m) => {
          const t = Date.parse(m.timestamp);
          return Number.isFinite(t) && t > mx ? t : mx;
        }, Number.NEGATIVE_INFINITY);
        const lastRefEnd = Number.isFinite(lastMsgMs) ? lastMsgMs : referenceEndMs;
        const share = book({
          receiptMap: lastNames.receipt,
          part: pricedLast,
          partTokens: lastInv.tokens,
          refTimes: [isoOf(last.ms), isoOf(Math.max(last.ms, lastRefEnd))],
          label: "    last invocation booked",
        });
        if (strictRefusesBooking()) return 1;
        const earlierCost = pricingMod.round6(transcriptCost - pricedLast.cost_usd);
        console.log(`    + ${earlierCount} earlier invocation(s) transcript-priced $${earlierCost} = $${cost}`);
        costSource =
          `receipt for the last invocation (Anthropic token counts priced at the price list${customTag()}); ${share.toFixed(1)}% of it ` +
          `billed but not logged; ${earlierCount} earlier invocation(s) transcript-priced, unverified${approxTag}` +
          (booking.complete && priced.complete ? "" : "; INCOMPLETE — unpriced tokens excluded");
        pricingBasis +=
          "; the last invocation's receipt tokens that no transcript message recorded at each model's logged cache-write and modifier mix (unlogged_billed)";
        console.error(
          `NOTE: the receipt bills only the last invocation (from the human turn at ${last.iso}): its token counts are booked at ` +
            `the price list ($${booking.cost_usd}). The ${earlierCount} earlier invocation(s) in the window are transcript-priced and ` +
            `unverified ($${earlierCost}). A receipt for each invocation would verify them all.`
        );
        noteDrift();
      } else {
        console.error(
          `collect-orchestrator-usage FAILED: the window holds messages the receipt never billed (${cmp.above.join("; ")}) ` +
            `and no continuation turn explains them: ` +
            (mainFile
              ? `the session file ${mainFile} carries ${turnsInWindow.length} human turn(s) inside the window. `
              : `the scan is not pinned to a session file, so its human turns cannot be read. `) +
            `Claude Code bills per invocation, so an over-count means the window opened before this invocation (a preamble ` +
            `under the same session id, a stale run.start, a reused run id) or swept in another run's messages. Nothing was ` +
            `written; no number is guessed.`
        );
        return 3;
      }
    } else {
      // No bucket above the receipt (header, fact 8). A transcript EQUAL to the
      // receipt on every bucket is the receipt's invocation by itself, as it
      // always was. A bucket BELOW it is booked only when the window is
      // provably that invocation: the gap is then calls Claude Code bills but
      // never logs (or a helper file not copied, which attribution names),
      // never messages outside the window. There is no percentage: the gap was
      // 2.3% and 22% on two real runs.
      if (cmp.short.length > 0) {
        const turnsInWindow = mainTurns.filter((t) => t.ms >= windowStartMs && t.ms < windowEndMs);
        // Human turns at or after the window's close (review finding F1). A pinned
        // window with a finite close ends AT the next human turn, so any close other
        // than the end of the session refuses here: the receipt may be that later
        // invocation's bill. An unpinned scan has no session file to read turns from;
        // its close is approximate, which provableInvocation refuses on its own.
        const laterTurns = mainTurns.filter((t) => t.ms >= windowEndMs);
        const proof = provableInvocation({
          receiptSessionId: receipt.session_id,
          pinnedId,
          startAnchor,
          humanTurnsInWindow: turnsInWindow.length,
          laterHumanTurns: laterTurns.length,
          laterHumanTurnFrom: laterTurns[0]?.iso ?? null,
          windowExact,
          lowerBound: overheadIsFloor,
        });
        if (!proof.provable) {
          console.error(
            `collect-orchestrator-usage FAILED: the transcript is BELOW the CLI's own receipt (${cmp.short.join("; ")}` +
              `${pct ? `; priced $${transcriptCost} vs receipt $${receipt.total_cost_usd}, ${pct}` : ""}), and the window cannot be ` +
              `proven to be the receipt's invocation: ${proof.reasons.join("; ")}. A receipt above the transcript is booked only ` +
              `when the window provably is that one invocation (pinned to the receipt's session, opened at the run's command ` +
              `turn, no later human turn, exact), because the gap is then calls Claude Code bills but never logs. Without that ` +
              `proof the gap may be billed messages outside the window — usually a subagent transcript not copied alongside the ` +
              `session file, a run log with no run.start line (the window then opens near the first dispatch, after the driver's ` +
              `setup work), or a window that closed before the invocation did. Nothing was written; the rule has no tolerance to widen.`
          );
          return 3;
        }
        console.log(
          `  below the receipt, and the window is provably its invocation (session ${pinnedId}, opened at the command turn, ` +
            `one human turn, no later human turn, exact): the difference is billed but not logged`
        );
      }
      const share = book();
      if (strictRefusesBooking()) return 1;
      costSource =
        `receipt (Anthropic token counts priced at the price list${customTag()}); ${share.toFixed(1)}% billed but not logged` +
        (booking.complete ? "" : "; INCOMPLETE — unpriced tokens excluded");
      pricingBasis += "; a booked receipt's tokens that no transcript message recorded at each model's logged cache-write and modifier mix (unlogged_billed)";
      noteDrift();
    }
  } else {
    cost = transcriptCost;
    costSource = receiptPending
      ? `transcript (receipt pending; provisional${transcriptTags})`
      : `transcript (no receipt; unverified${transcriptTags})`;
    if (!receiptPending) {
      console.error(
        `NOTE: no receipt at ${receiptPath} — dollars are transcript-priced (${pricingBasis}) and UNVERIFIED. ` +
          `Keep the run's \`claude -p --output-format json\` result (or the headless live-run.log; or pass --receipt) ` +
          `and this tool will verify itself against it.`
      );
    }
  }

  // ── Dispatched total, minus what already sits inside the transcript ─────
  // buildManifest writes the dispatched figure as totals.dispatched_cost_usd;
  // total_cost_usd is only present on a manifest this collector has already
  // patched. Reading the latter alone meant a first run defaulted it to 0 and
  // reported overhead as if it were the whole cost — a silent under-report of
  // the entire mechanical tier, which is the failure this script exists to end.
  // Absent both, stop: a cost of zero must never be assumed.
  // THE MONEY COMES FROM THE MODEL'S OWN FILE, NOT FROM THE REBUILD.
  //
  // The rebuild exists to supply the run WINDOW when the model misplaced it —
  // nothing else. Reading the dispatched total off it too would silently swap an
  // authoritative figure for a re-derivation whenever the window happened to be
  // nested: `buildManifest` emits no `totals` object at all, so
  // `totals.dispatched_cost_usd` would miss and fall through to the rebuild's own
  // sum of the log. Those two disagree routinely — telemetry is repriced or
  // repaired after a run — and on the repo's own receivables fixture the swap
  // reports $22.31 where the manifest says $6.08, a 3.7x overstatement, and
  // fabricates an in-session subtraction the run never had (`models_used` is also
  // absent from a rebuild, which disables the model filter).
  //
  // So: the model's file first, both spellings, exactly as before this change.
  // The rebuild is the last resort, and only reaches this line for a run whose
  // manifest records no dispatched figure anywhere — which is the greenfield
  // case, where the rebuild's sum is the same arithmetic over the same log.
  const dispatched =
    modelWritten.totals?.dispatched_cost_usd ??
    modelWritten.total_cost_usd ??
    (rebuilt ? manifest.total_cost_usd : undefined);
  if (!Number.isFinite(dispatched)) {
    console.error(
      `collect-orchestrator-usage FAILED: the manifest carries no usable dispatched cost ` +
        `(looked for totals.dispatched_cost_usd, then total_cost_usd; got ${JSON.stringify(dispatched)}). ` +
        `A NaN counts as unusable: it survives a typeof check, serialises to null, and would write a run ` +
        `record whose cost reads as absent. Refusing to assume $0 — that would report the overhead as the ` +
        `entire run cost. Nothing was written.`
    );
    return 1;
  }
  // A claude-cli worker's own session is inside the overhead only when the
  // scan was not pinned to the driver's session AND the figure written is the
  // transcript's: a booked receipt bills the driver's session alone, so the
  // worker's dollars are not inside it and must stay in the total.
  const inside = inSessionDispatched(readTelemetry(telemetryPath), policy, modelWritten, dispatched, {
    claudeCliScanned: !pinned && costSource.startsWith("transcript"),
  });
  for (const n of inside.notes) console.error(`NOTE: ${n}`);
  const insideCost = pricingMod.round6(inside.cost);
  const trueTotal = pricingMod.round6(dispatched - insideCost + cost);

  console.log(
    `overhead: in ${tokens.input} + cached ${tokens.input_cached} + cache_write ${tokens.input_cache_write} ` +
      `(5m ${tokens.input_cache_write_5m} / 1h ${tokens.input_cache_write_1h}) + out ${tokens.output} tokens ` +
      `@ ${booking ? "the receipt's token counts at the list" : "each message's own price"} = $${cost} [${costSource}]`
  );
  if (inside.count > 0) {
    console.log(
      `in-session dispatch: ${inside.count} event(s) totaling $${insideCost} ran inside the session ` +
        `and are already inside the overhead above — subtracted so they are counted once.`
    );
  }
  console.log(
    `dispatched total $${dispatched} → true total $${trueTotal}` +
      (inside.count > 0 ? ` (= ${dispatched} − ${insideCost} in-session + ${cost} overhead)` : "")
  );

  if (args.dryRun) {
    console.log("dry-run: nothing written.");
    return 0;
  }

  // Provenance keeps the report's vocabulary: the figure is reconstructed from
  // the session transcript; whether the receipt verified or supplied the
  // dollars is recorded in cost_source / receipt_cost_usd beside it.
  const provenance = "transcript";
  const event = {
    ts: new Date().toISOString(),
    pass: passId,
    phase: "orchestrator_overhead",
    task_type: "orchestrator_overhead",
    task_id: `orchestrator-overhead-${passId}`,
    module: "orchestrator",
    model: derived.modelName,
    model_id: derived.modelId,
    routed_by: "orchestrator",
    provenance,
    tier: "orchestrator",
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: -1,
      rule_reason: `orchestrator overhead — ${costSource}; priced: ${pricingBasis}; labelled with ${labelBasis}`,
    },
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    input_tokens_cache_write_1h: tokens.input_cache_write_1h,
    output_tokens: tokens.output,
    cost_usd: cost,
    transcript_cost_usd: transcriptCost,
    receipt_cost_usd: receipt?.total_cost_usd ?? null,
    // Header, fact 8: Claude Code's own figure, kept as a check; what a booked
    // receipt billed beyond the transcript; whether every helper file was there.
    receipt_cli_usd: receipt?.total_cost_usd ?? null,
    // v0.7.3 review fix: the booked part at the list (the whole receipt, or a
    // resumed window's last invocation), which receipt_cli_usd is checked against.
    booked_cost_usd: booking?.cost_usd ?? null,
    unlogged_billed: booking?.unlogged_billed ?? null,
    attribution_complete: attribution ? attribution.complete : null,
    // The transcript's cost per model and role, and what could not be priced.
    per_model: priced.per_model,
    unpriced: priced.unpriced,
    // v0.7.3 (Fix E): the rest of the manifest block's Fix E fields, so the
    // event alone (telemetry.jsonl before the manifest is patched, which
    // tools/report.mjs falls back to) carries the whole per-model, receipt and
    // attribution picture. Same values as the manifest block below;
    // TelemetryEvent declares every field written here
    // (orchestratorOverheadFields.test.mjs type-checks this output).
    pricing_complete: booking ? booking.complete && priced.complete : priced.complete,
    price_list_verified: pricesMod.PRICE_LIST_VERIFIED,
    missing_helper_ids: attribution?.missing_helper_ids ?? [],
    unreferenced_helper_files: attribution?.unreferenced_helper_files ?? [],
    latency_ms: null,
    success: true,
    retry_count: 0,
  };

  // Replace-on-rerun: rewrite telemetry without any prior orchestrator
  // event, append the fresh one, then atomically swap. A crash mid-write
  // can never leave a half-written telemetry.jsonl behind.
  const existing = existsSync(telemetryPath)
    ? readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean)
    : [];
  const kept = existing.filter((l) => {
    try { return JSON.parse(l).tier !== "orchestrator"; } catch { return true; }
  });
  kept.push(JSON.stringify(event));
  const tmpT = `${telemetryPath}.tmp-collect`;
  writeFileSync(tmpT, kept.join("\n") + "\n", "utf-8");
  renameSync(tmpT, telemetryPath);

  // The two figures this script adds go onto the file that is ON DISK — the
  // model-written one — never onto a rebuild. A rebuild exists only so the
  // window and the dispatched total can be READ when the model misplaced them;
  // writing it back would replace the run's own record with a reconstruction,
  // and the run's own record is the evidence. `modelWritten` and `manifest` are
  // the same object whenever no rebuild happened, so this is a no-op then.
  modelWritten.orchestrator_overhead = {
    cost_usd: cost,
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    input_tokens_cache_write_1h: tokens.input_cache_write_1h,
    output_tokens: tokens.output,
    events: 1,
    provenance,
    pricing_basis: pricingBasis,
    cost_source: costSource,
    transcript_cost_usd: transcriptCost,
    receipt_cost_usd: receipt?.total_cost_usd ?? null,
    receipt_path: receipt?.path ?? null,
    // Header, fact 6: transcript_cost_usd is the sum of per_model[].cost_usd;
    // unpriced[] tokens are in no cost, and pricing_complete says whether any exist.
    per_model: priced.per_model,
    unpriced: priced.unpriced,
    // A booked receipt is complete only when its unlogged gap was priced too.
    pricing_complete: booking ? booking.complete && priced.complete : priced.complete,
    price_list_verified: pricesMod.PRICE_LIST_VERIFIED,
    // Header, fact 8. receipt_cli_usd is Claude Code's own total, never booked
    // (receipt_cost_usd keeps the same value under its old name). unlogged_billed
    // is null unless a receipt was booked, and then cost_usd = transcript_cost_usd
    // + unlogged_billed.cost_usd. The attribution fields are null / empty unless
    // the scan was pinned to a session file.
    receipt_cli_usd: receipt?.total_cost_usd ?? null,
    // v0.7.3 review fix: booked_cost_usd is the booked part at the list: the
    // whole receipt, or on a resumed window the last invocation alone, which
    // is all Claude Code's figure bills. tools/report.mjs checks
    // receipt_cli_usd against it; cost_usd would compare different spans.
    // null unless a receipt was booked.
    booked_cost_usd: booking?.cost_usd ?? null,
    unlogged_billed: booking?.unlogged_billed ?? null,
    attribution_complete: attribution ? attribution.complete : null,
    missing_helper_ids: attribution?.missing_helper_ids ?? [],
    unreferenced_helper_files: attribution?.unreferenced_helper_files ?? [],
    dispatched_in_session_cost_usd: insideCost,
    dispatched_in_session_events: inside.count,
    // The window the figure was measured over, so a reader can tell an exact
    // invocation-bounded measurement from an approximate one without
    // re-running the tool (header, fact 5).
    window: {
      start: isoOf(windowStartMs),
      end: finiteEnd ? isoOf(windowEndMs) : null,
      start_anchor: startAnchor,
      end_anchor: endAnchor,
      exact: windowExact,
      // true when the window opens at the first dispatched call: the overhead is
      // a floor, and the real driver cost is higher. Recorded so a reader of the
      // manifest sees it without having watched the run.
      lower_bound: overheadIsFloor,
      session_id: pinnedId,
      // Which file the anchors were derived from. "manifest" is the model's own
      // file; "telemetry-rebuild" means it carried no top-level window and the
      // manifest was rebuilt from telemetry.jsonl with buildManifest to read it.
      // Recorded because the anchor names alone were once written as
      // "manifest started_at - 5m" for a value the manifest never held.
      source: rebuilt ? "telemetry-rebuild" : "manifest",
    },
  };
  modelWritten.true_total_cost_usd = trueTotal;
  const tmpM = `${manifestPath}.tmp-collect`;
  writeFileSync(tmpM, JSON.stringify(modelWritten, null, 2), "utf-8");
  renameSync(tmpM, manifestPath);

  console.log(`written: 1 orchestrator event → ${telemetryPath}; manifest patched with orchestrator_overhead + true_total_cost_usd.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`collect-orchestrator-usage FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
