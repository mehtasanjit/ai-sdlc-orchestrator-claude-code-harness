/**
 * zero-touch's copy of mmo's transcript reader gives the same answer, so the two cannot drift unnoticed. The first
 * chat's Hand-off line about the chat's model depends on the copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const Z = await import(join(ROOT, "zero-touch", "scripts", "transcript-model.mjs"));
const T = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));

test("both copies read the chat's own model the same way, in every case", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-transcript-model-"));
  try {
    const a = (model, extra = {}) => ({ type: "assistant", timestamp: "2026-10-01T10:00:00.000Z", message: { model, content: [] }, ...extra });
    const cases = [
      ["the chat's last answer", [a("claude-sonnet-5"), a("claude-opus-5")], { model: "claude-opus-5" }],
      ["a helper's answer is not the chat's", [a("claude-opus-5"), a("claude-sonnet-5", { isSidechain: true })], { model: "claude-opus-5" }],
      ["Claude Code's own entries are not a model", [a("claude-opus-5"), a("<synthetic>")], { model: "claude-opus-5" }],
      ["a context tag is kept as written", [a("claude-opus-5[1m]")], { model: "claude-opus-5[1m]" }],
      ["no answer at all", [{ type: "user", message: { content: "hi" } }], null],
    ];
    for (const [name, entries, want] of cases) {
      const file = join(dir, `${name.replace(/\W+/g, "-")}.jsonl`);
      writeFileSync(file, "not json, a cut first line\n" + entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const z = Z.lastAssistantModel(file);
      const t = T.lastAssistantModel(file);
      assert.deepEqual(z, t, `${name}: the copy agrees`);
      assert.equal(z?.model ?? null, want?.model ?? null, name);
    }
    assert.equal(Z.lastAssistantModel(join(dir, "none.jsonl")), null);
    assert.equal(Z.lastAssistantModel(""), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
