/**
 * The writer's own descriptions stay true to it: every function's what+why sits on that function (none left stacked
 * above another), the apply contract and the event types say what the server does and writes, and the lean typist's
 * login is described as Claude Code actually hands it over. The event types are checked by tsc, the package's own
 * compiler, on the events the server really writes. Offline; temp files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => readFileSync(join(PKG, "src", f), "utf8");
const TSC = join(PKG, "node_modules", "typescript", "bin", "tsc");

/** A comment's words on one line: its `*` margins and line breaks dropped, so a phrase is found wherever it wraps. */
const prose = (c) => c.replace(/^\s*\/?\*+\/?/gm, " ").replace(/\*\//g, " ").replace(/\s+/g, " ");

/** Each doc block (`/** … *\/`) in a source text, with the code that follows it. */
function docBlocks(text) {
  const out = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  for (let m; (m = re.exec(text)); ) out.push({ doc: m[0], at: m.index, next: text.slice(re.lastIndex).trimStart().slice(0, 120) });
  return out;
}

test("apply.ts and applyTypist.ts: no doc block is left stacked above another, so each describes the code under it", () => {
  for (const f of ["apply.ts", "applyTypist.ts"]) {
    const stacked = docBlocks(src(f)).filter((b) => b.next.startsWith("/**"));
    assert.deepEqual(stacked.map((b) => b.doc.slice(0, 80)), [], f);
  }
});

test("checkWriteContract carries its own description, naming the tamper check it makes first", () => {
  const blocks = docBlocks(src("apply.ts"));
  const own = blocks.find((b) => b.next.startsWith("export function checkWriteContract("));
  assert.ok(own, "checkWriteContract has no doc block of its own");
  assert.match(own.doc, /Decide whether the server may write/);
  assert.match(own.doc, /frozen|fingerprint|tamper/i);
});

test("the ApplySpec contract describes the edits the server takes and the ladder it runs", () => {
  const t = src("types.ts");
  const spec = t.slice(t.indexOf("export interface ApplySpec"), t.indexOf("export interface TaskPacket"));
  const header = t.slice(t.lastIndexOf("/**", t.indexOf("export interface ApplySpec")), t.indexOf("export interface ApplySpec"));
  assert.doesNotMatch(spec, /anchor/, "the anchor edit form is gone; the server takes search/replace edits only");
  assert.match(prose(spec), /\{search, replace\}/);
  assert.doesNotMatch(prose(header), /Stops before any attempt the policy would route to a different model/);
  const loop = docBlocks(src("apply.ts")).find((b) => b.next.startsWith("export async function runApplyLoop("));
  assert.ok(loop);
  assert.doesNotMatch(prose(loop.doc), /on one model/);
});

test("typists.ts says what Claude Code hands a plugin's server: never the session's CLAUDE_CODE_OAUTH_TOKEN", () => {
  const t = src(join("executor", "typists.ts"));
  const comment = t.slice(t.lastIndexOf("/**", t.indexOf("const CLAUDE_ROUTING")), t.indexOf("const CLAUDE_ROUTING"));
  assert.doesNotMatch(prose(comment), /A typist bills the same login and provider as the rest of the run/);
  assert.match(prose(comment), /does not pass a session's CLAUDE_CODE_OAUTH_TOKEN to a plugin's server/);
});

test("the event types admit every event the server writes: a probe's phase, any door on a brownfield apply call, each retry reason", () => {
  const door = src("types.ts").match(/\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*door\?:/);
  assert.ok(door);
  assert.doesNotMatch(prose(door[1]), /Also `lean-opus` on a brownfield run's apply call/);
  const dir = mkdtempSync(join(tmpdir(), "mmo-apply-docs-"));
  try {
    const check = join(dir, "check.ts");
    const base = `ts: "", pass: "r", task_type: "", task_id: "t", module: "m", model: "m", routed_by: "orchestrator" as const, routing: { policy_name: "p", policy_version: 1, rule_index: -1, rule_reason: "" }, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0, success: true, retry_count: 0`;
    writeFileSync(check,
      `import type { TelemetryEvent, AttemptRecord, TaskPacket } from ${JSON.stringify(join(PKG, "src", "types.js"))};\n` +
      `export const probe: TelemetryEvent = { ${base}, phase: "preflight", door: "lean-opus" };\n` +
      `export const flash: TelemetryEvent = { ${base}, phase: "codegen", door: "flash-completion", retry_reason: "transport" };\n` +
      `export const agy: TelemetryEvent = { ${base}, phase: "debug", door: "agy", retry_reason: "verify" };\n` +
      `export const reasons: NonNullable<TelemetryEvent["retry_reason"]>[] = ["transport", "refused", "error", "verify", "cut_off", "output_cap"];\n` +
      `export const att: Pick<AttemptRecord, "retry_reason"> = { retry_reason: "verify" };\n` +
      `export const pk: Pick<TaskPacket, "retry_reason"> = { retry_reason: "cut_off" };\n`);
    const r = spawnSync(process.execPath, [TSC, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--types", "node", check], { cwd: PKG, encoding: "utf-8" });
    assert.equal(r.status, 0, `tsc rejected an event the server writes:\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
