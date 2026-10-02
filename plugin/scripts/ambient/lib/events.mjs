/**
 * Per-session append-only event log: `<MMO_HOME>/sessions/<id>/events.jsonl`.
 *
 * Record format is newline + JSON + newline. The leading newline means a
 * record torn by a crash can never glue itself onto the next one: the reader
 * splits on newlines and drops any line that does not parse. One session, one
 * file, append only, so two sessions never contend for a lock.
 *
 * Privacy rule held here: no prompt text is ever a field. Callers pass rule
 * ids, sizes, paths and numbers. String fields are capped so a record stays a
 * single small append.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendPrivate, ensureSessionDir, sessionDir } from "./paths.mjs";

const MAX_FIELD_CHARS = 400;
const FORBIDDEN_FIELDS = new Set(["prompt", "prompt_text", "content", "stdout", "stderr"]);

function clip(value) {
  if (typeof value === "string" && value.length > MAX_FIELD_CHARS) return value.slice(0, MAX_FIELD_CHARS);
  return value;
}

/** Set once per hook run: the helper agent this process speaks for, or null. Every event then carries it. */
let currentAgent = null;
export function setEventAgent(agentId) {
  currentAgent = typeof agentId === "string" && agentId ? agentId : null;
}

export function appendEvent(sessionId, type, fields = {}, env = process.env) {
  const record = { ts: new Date().toISOString(), type };
  if (currentAgent) record.agent = currentAgent;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || FORBIDDEN_FIELDS.has(k)) continue;
    record[k] = clip(v);
  }
  const dir = ensureSessionDir(sessionId, env);
  appendPrivate(join(dir, "events.jsonl"), "\n" + JSON.stringify(record) + "\n");
  return record;
}

export function readEvents(sessionId, env = process.env) {
  const file = join(sessionDir(sessionId, env), "events.jsonl");
  if (!existsSync(file)) return [];
  return parseEvents(readFileSync(file, "utf8"));
}

export function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && typeof rec.type === "string") out.push(rec);
    } catch { /* torn or foreign line: skip it, keep the rest */ }
  }
  return out;
}
