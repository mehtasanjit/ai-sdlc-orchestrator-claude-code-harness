/**
 * A Workflows chat and its model.
 *
 * Why: mmo's helper agents name no model, so Claude Code runs them on the person's helper setting
 * (CLAUDE_CODE_SUBAGENT_MODEL) when there is one, else on the chat's own model; and a workflow's own run-start check
 * needs them on the model the policy plans with. Zero-touch ships no copies of the helpers that name a model. So:
 *   - each of the three workflow model choices names the model it plans with, and that is what the workflows' own
 *     router says (the check's --print-only, the same code the run uses);
 *   - the start message tells the person which model the chat must be on: once in the summary, and in every chat
 *     while the chat is known to be on another one, or while the person's own setting names another one;
 *   - the chat's model is kept for a Workflows chat too (the mmo plugin checks it before it starts a workflow).
 *
 * Every case runs the plugin's real scripts with its own home folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const M = await import(join(ZT, "scripts", "messages.mjs"));
const S = await import(join(ZT, "scripts", "settings.mjs"));
const { writeZtSettings, ztData, fakeClaudeBin } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();
const BASE_PATH = `${fakeClaudeBin()}:${dirname(process.execPath)}:/usr/bin:/bin`;

test("each workflow model choice names the model it plans with, as the workflows' own router says", { skip: SKIP ?? false }, () => {
  const check = join(ROOT, "plugin", "scripts", "driver-model-check.mjs");
  for (const [policy, m] of Object.entries(S.WORKFLOW_MODELS)) {
    const file = join(ROOT, "plugin", "config", "policies", `${policy}.yaml`);
    const planned = execFileSync(process.execPath, [check, "--project-root", tmpdir(), "--policy-path", file, "--print-only"], { encoding: "utf8" }).trim();
    assert.equal(m.plans, planned, policy);
  }
});

test("the chat-model line: what the person reads for each case, when it is a warning, and why", () => {
  const P = "opus-plus-sonnet";
  // Every line says why, naming the models the person chose.
  const why = "you chose Opus 5 + Sonnet 5, where Opus 5 plans and reviews, and that part runs on this chat's own model";
  const menu = "with the model menu next to the message box (in the terminal, type /model claude-opus-5)";
  assert.deepEqual(M.workflowModelLine(P, { model: "claude-opus-5" }), { line: `• This chat is on Opus 5, which workflows need, because ${why}. While a workflow zero-touch started runs, zero-touch refuses a switch to another model.`, warn: false, kind: "chat" });
  assert.deepEqual(M.workflowModelLine(P, {}), { line: `• Workflows need this chat on Opus 5, because ${why}. If it's on a different model, switch it ${menu}.`, warn: false, kind: "chat" });
  assert.deepEqual(M.workflowModelLine(P, { model: "claude-opus-5-5" }), { line: `• This chat is on Opus 5.5, but ${why}. So no workflow starts until you switch this chat to Opus 5 ${menu}.`, warn: true, kind: "chat" });
  // The person's own helper setting decides the helpers' model: the chat's model does not matter then.
  assert.deepEqual(M.workflowModelLine(P, { model: "claude-opus-5-5", helperSetting: "claude-opus-5" }), { line: null, warn: false, kind: "setting" });
  assert.deepEqual(M.workflowModelLine(P, { model: "claude-opus-5", helperSetting: "claude-opus-4-8" }), { line: "• A setting on this computer makes workflow helpers run on Opus 4.8, but you chose Opus 5 + Sonnet 5, where Opus 5 plans and reviews, so no workflow starts until that setting is changed. Claude can help you change it.", warn: true, kind: "setting" });
  // Fable 5.1 + Flash 3.8 plans with Fable 5.1: the line names it.
  assert.match(M.workflowModelLine("fable51-plus-flash-v38", { model: "claude-opus-5" }).line, /^• This chat is on Opus 5, but you chose Fable 5\.1 \+ Flash 3\.8, where Fable 5\.1 plans and reviews, .* switch this chat to Fable 5\.1 .*\/model claude-fable-5-1\)\.$/);
  for (const r of [M.workflowModelLine(P, { model: "claude-opus-5-5" }), M.workflowModelLine(P, { helperSetting: "opus" })]) {
    assert.doesNotMatch(r.line, /CLAUDE_CODE|settings\.json/, "no variable or file names");
  }
});

function sandbox(settings) {
  const dir = mkdtempSync(join(tmpdir(), "zt-chat-model-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeZtSettings(home, settings);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function start(s, sid, { model, env = {} } = {}) {
  const r = spawnSync("sh", [START], {
    input: JSON.stringify({ session_id: sid, cwd: s.repo, source: "startup", ...(model ? { model } : {}) }), encoding: "utf8", cwd: s.repo,
    env: { PATH: BASE_PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home), CLAUDE_PROJECT_DIR: s.repo, MMO_MANAGED_SETTINGS: join(s.dir, "managed.json"), CLAUDE_CODE_ENTRYPOINT: "cli", ...env },
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* left null */ }
  return json?.systemMessage ?? "";
}
const modelNow = (s, sid) => { try { return readFileSync(join(s.home, "sessions", sid, "model_now"), "utf8"); } catch { return null; } };

test("the start message: the model line in the summary; after that, only while the chat or the setting is on another model", () => {
  const s = sandbox({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
  try {
    const first = start(s, "c1", { model: "claude-opus-5[1m]" });
    assert.ok(first.includes("• This chat is on Opus 5, which workflows need, because you chose Opus 5 + Sonnet 5"), first);
    assert.equal(modelNow(s, "c1"), "claude-opus-5", "kept, without the context tag");
    assert.equal(start(s, "c2", { model: "claude-opus-5" }), "", "summary already shown, nothing needs action: quiet");
    const wrong = start(s, "c3", { model: "claude-opus-5-5" });
    assert.equal(wrong, `Zero-touch is on in this chat: Workflows mode.\n${M.workflowModelLine("opus-plus-sonnet", { model: "claude-opus-5-5" }).line}`);
    assert.equal(start(s, "c4"), "", "the model not known yet: nothing to warn about (checked again at the first job)");
    assert.equal(modelNow(s, "c4"), null);
    assert.equal(start(s, "c5", { model: "claude-opus-5-5", env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" } }), "", "the person's setting decides the helpers: the chat's model does not matter");
    assert.match(start(s, "c6", { model: "claude-opus-5", env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" } }), /A setting on this computer makes workflow helpers run on Opus 4\.8/);
  } finally { s.cleanup(); }
});

test("Hand-off and Off chats are unchanged: no workflow model line", () => {
  const h = sandbox({ mode: "handoff" });
  try {
    const m = start(h, "h1", { model: "claude-opus-5" });
    assert.doesNotMatch(m, /Workflows need|which workflows need/);
  } finally { h.cleanup(); }
  const o = sandbox({ mode: "off" });
  try {
    assert.equal(start(o, "o1", { model: "claude-opus-5-5" }), "");
    assert.ok(!existsSync(join(o.home, "sessions", "o1", "model_now")), "an Off chat leaves nothing behind");
  } finally { o.cleanup(); }
});

test("mmo's own line for a chat on another model says why, with the choice's name; its names match zero-touch's", async () => {
  const F = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  const Z = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "zt-saved.mjs"));
  const S = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
  assert.deepEqual(Z.WORKFLOW_LABELS, Object.fromEntries(Object.entries(S.WORKFLOW_MODELS).map(([k, v]) => [k, v.label])), "mmo's copy of the names is zero-touch's");
  assert.deepEqual(Z.CHOICES.workflowModels, Object.keys(S.WORKFLOW_MODELS));
  assert.equal(F.PERSON_LINE.notStarted({ cause: "chat-model", have: "claude-opus-5-5", needed: "claude-opus-5", via: "chat", policy: "opus-plus-flash-v38" }, "greenfield"),
    "Zero-touch: the new-app workflow didn't start, because this chat is on Opus 5.5, but you chose Opus 5 + Flash 3.8, where Opus 5 plans and reviews, and that part runs on this chat's own model. Switch this chat to Opus 5 with the model menu next to the message box (in the terminal, type /model claude-opus-5), then ask again.");
  assert.match(F.PERSON_LINE.notStarted({ cause: "chat-model", have: "claude-opus-5", needed: "claude-fable-5-1", via: "chat", policy: "fable51-plus-flash-v38" }, "bugfix"), /you chose Fable 5\.1 \+ Flash 3\.8, where Fable 5\.1 plans and reviews/);
  assert.match(F.PERSON_LINE.notStarted({ cause: "chat-model", have: "claude-opus-5-5", needed: "claude-opus-5", via: "chat", policy: "some-typed-policy" }, "bugfix"), /your workflow models plan and review with Opus 5/, "a policy zero-touch never offered gets no name");
});

test("every workflow choice plans with the model its policy's run-start check names (Fable 5.1 + Flash 3.8 included)", () => {
  return import(join(ROOT, "zero-touch", "scripts", "settings.mjs")).then(({ WORKFLOW_MODELS }) => {
    for (const [policy, m] of Object.entries(WORKFLOW_MODELS)) {
      const printed = execFileSync(process.execPath, [join(ROOT, "plugin", "scripts", "driver-model-check.mjs"), "--project-root", tmpdir(), "--policy-path", join(ROOT, "plugin", "config", "policies", `${policy}.yaml`), "--print-only"], { encoding: "utf8" }).trim();
      assert.equal(printed, m.plans, policy);
    }
  });
});
