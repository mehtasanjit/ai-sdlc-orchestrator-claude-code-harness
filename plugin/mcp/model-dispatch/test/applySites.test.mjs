/**
 * An edit typed "at these sites only" is held to its sites (apply.ts runApplyLoop, siteProblem): plan-to-packets puts
 * each edit unit's sites in the packet (`apply.sites`, line ranges of the file before the change), and the server
 * compares the answer with the file before the change. A line outside every replace or delete site that the answer
 * changes or removes, or a line it adds anywhere but at an insert site or a replace site, makes the attempt a retry
 * with the lines named; nothing is written. Any alignment the sites allow is accepted, so a block whose lines repeat
 * its neighbours' (a blank line, a closing brace) is never refused for where a diff happens to place it. A packet with
 * no sites is held to none. Stub models and temp folders: no model is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA, siteProblem } = await import(join(DIST, "apply.js"));

process.env.MMO_MANAGED_SETTINGS = join(tmpdir(), "mmo-no-managed-settings.json");
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mmo-apply-sites-config-"));

const FLASH = { modelId: "flash", reason: "policy", ruleIndex: 0 };
const packet = (over = {}) => ({
  id: "tp_docs_U01", phase: "docs", task_type: "", module: "spec", pass_id: "r", instruction: "Edit the file at these sites only.",
  inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/calc.py", ...over,
});
function stub(replies) {
  const calls = [];
  const dispatch = async (p) => {
    calls.push(p);
    const r = replies.shift() ?? { edits: [{ search: "zzz", replace: "zzz" }] };
    return { decision: FLASH, events: [{ task_id: p.id, success: true }], result: { success: true, result: { path: p.artifact_path, ...r }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0.01, terminal_reason: "success" } };
  };
  return { calls, dispatch };
}
const CALC = 'def divide(a, b):\n    """Divide."""\n    return a / b\n';

test("normalizeApply keeps an edit packet's sites", () => {
  const sites = [{ id: "S1", at: "replace", from: 2, to: 2 }, { id: "S2", at: "insert_after", from: 3, to: 3 }];
  assert.deepEqual(normalizeApply({ write: true, mode: "edits", sites }).sites, sites);
  assert.equal(normalizeApply({ write: true, mode: "edits" }).sites, undefined, "a packet with no sites is held to none");
});

test("an answer that also changes a line outside its sites is a retry naming the line; the answer that keeps to them is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-sites-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "calc.py"), CALC);
  const m = stub([
    { edits: [{ search: '"""Divide."""', replace: '"""Divide a by b."""' }, { search: "a / b", replace: "a // b" }] },
    { edits: [{ search: '"""Divide."""', replace: '"""Divide a by b."""' }] },
  ]);
  const out = await runApplyLoop({ projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", sites: [{ id: "S1", at: "replace", from: 2, to: 2 }] }), dispatch: m.dispatch });
  assert.equal(out.status, "applied");
  assert.equal(m.calls.length, 2);
  assert.match(out.attempts[0].failure, /^the answer changes lines outside its sites: 3; change only the planned sites/);
  assert.match(m.calls[1].instruction, /the answer changes lines outside its sites: 3/);
  assert.equal(m.calls[1].retry_reason, "refused");
  assert.equal(readFileSync(join(root, "src", "calc.py"), "utf8"), 'def divide(a, b):\n    """Divide a by b."""\n    return a / b\n');
  // The whole file as the answer is held the same way.
  writeFileSync(join(root, "src", "calc.py"), CALC);
  const w = stub([{ content: 'def divide(a, b):\n    """Divide a by b."""\n    return a // b\n' }, { content: 'def divide(a, b):\n    """Divide a by b."""\n    return a / b\n' }]);
  const o2 = await runApplyLoop({ projectRoot: root, keepEvents: true, route: () => FLASH, log: () => {}, packet: packet(), apply: normalizeApply({ write: true, mode: "edits", sites: [{ id: "S1", at: "replace", from: 2, to: 2 }] }), dispatch: w.dispatch });
  assert.equal(o2.status, "applied");
  assert.match(o2.attempts[0].failure, /outside its sites: 3;/);
  rmSync(root, { recursive: true, force: true });
});

test("inserts stand only at insert sites or inside a replaced range; deletes only inside delete or replace sites", () => {
  const before = "a {\n}\n\nb {\n}\n";
  const ins = [{ id: "S1", at: "insert_after", from: 2, to: 2 }];
  // A block whose lines repeat its neighbours' (a blank line, a closing brace) is accepted, however a diff would place it.
  assert.equal(siteProblem(before, "a {\n}\n\nc {\n}\n\nb {\n}\n", ins), null);
  assert.equal(siteProblem(before, "a {\n}\n\nb {\n}\n\nc {\n}\n", ins), "the answer changes lines outside its sites: new lines after 5; change only the planned sites", "an insert at the end is not at line 2");
  assert.equal(siteProblem(before, "x {\n}\n\nb {\n}\n", [{ id: "S1", at: "insert_before", from: 1, to: 1 }]), "the answer changes lines outside its sites: 1; change only the planned sites");
  assert.equal(siteProblem(before, "new\na {\n}\n\nb {\n}\n", [{ id: "S1", at: "insert_before", from: 1, to: 1 }]), null);
  assert.equal(siteProblem(before, "a {\n}\n\n", [{ id: "S1", at: "delete", from: 4, to: 5 }]), null);
  assert.equal(siteProblem(before, "a {\n}\n", [{ id: "S1", at: "delete", from: 4, to: 5 }]), "the answer changes lines outside its sites: 3; change only the planned sites");
  assert.equal(siteProblem(before, "a {\n  x;\n  y;\n}\n\nb {\n}\n", [{ id: "S1", at: "replace", from: 2, to: 2 }]), null, "a replaced range may grow");
  assert.equal(siteProblem(before, before, ins), null, "no change is no change outside the sites");
  // Line endings are compared as lines: a CRLF file answered in its own ending is held to the same lines.
  assert.equal(siteProblem(before.replace(/\n/g, "\r\n"), "a {\r\n}\r\n\r\nc {\r\n}\r\n\r\nb {\r\n}\r\n", ins), null);
});
