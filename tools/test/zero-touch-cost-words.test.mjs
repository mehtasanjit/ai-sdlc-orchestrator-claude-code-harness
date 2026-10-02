/**
 * What zero-touch says about money and about which requests start a workflow is true for every person.
 *
 * Money: most people sign in to Claude with a plan, not an API key. On a plan, Opus 5 and Sonnet 5 use up the plan's
 * limits and Flash 3.8 adds a separate Google bill, so "the cheapest", "the most expensive" and "costs less than
 * Opus 5" are not prices the person pays (and "the cheapest" could mean a new bill). Zero-touch says who runs each
 * model and how much of the person's Claude usage it takes, which is true on a plan and with an API key alike, and a
 * hand-off receipt's dollar figure is called an estimate (the models' list prices, not a charge on a plan).
 *
 * Requests: zero-touch recognises a request in English that starts with what is wanted ("fix the login bug", "please
 * write tests for the cart", "can you build…") or says "I want a … app". So no text promises "in your own words",
 * which a request in another language, or one that only describes a problem, does not meet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
const B = await import(join(ROOT, "zero-touch", "scripts", "boxes.mjs"));
const RF = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));

/** A price ranking between models, which is not what a person on a Claude plan pays. */
const PRICE_RANK = /cheapest|most expensive|more expensive|costs? less than|costs? more than (?:Flash|Sonnet|Opus)|cheaper|savings/i;
const OWN_WORDS = /in your own words/i;

const boxText = (box) => box.questions.flatMap((q) => [q.question, ...q.options.flatMap((o) => [o.label, o.description])]).join("\n");
const WF = (models) => ({ mode: "workflows", workflows: { models } });
const HO = (handoff = {}) => ({ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat", ...handoff } });
const stamp = (chat_model, t) => ({ chat_model, typists: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { typist: v }])) });

/** Every text a person reads that names models or the jobs, with every setup that changes its words. */
function personTexts() {
  const out = [["welcome", M.welcomeMessage()]];
  for (const first of [true, false]) {
    out.push([`mode box first=${first}`, boxText(B.modeBox(first ? null : WF("opus-plus-flash-v38"), { first }))]);
    out.push([`hand-off box first=${first}`, boxText(B.handoffBox(first ? null : HO(), { first }))]);
  }
  out.push(["models box", boxText(B.modelsBox(null))]);
  for (const p of ["opus-plus-flash-v38", "opus-plus-sonnet", "opus-only-v5"]) out.push([`workflows ${p}`, M.workflowMessage({ policy: p })]);
  const typists = [["flash", "sonnet", "chat"], ["sonnet", "sonnet", "sonnet"], ["chat", "chat", "chat"], ["flash", "flash", "flash"]];
  for (const chat of ["claude-opus-5", "claude-sonnet-5"]) {
    for (const [documents, tests, repeats] of typists) {
      out.push([`hand-off ${chat} ${documents}/${tests}/${repeats}`, M.handoffMessage(stamp(chat, { documents, tests, repeats }), chat)]);
    }
  }
  for (const g of [{ state: "none" }, { online: "refused" }, { state: "broken" }, { state: "no-project" }, { shellOnly: ["GEMINI_API_KEY"] }]) {
    out.push([`google ${JSON.stringify(g)} workflows`, M.googleLine(WF("opus-plus-flash-v38"), g)]);
    out.push([`google ${JSON.stringify(g)} hand-off`, M.googleLine(HO(), g)]);
  }
  for (const job of ["greenfield", "bugfix", "docs"]) for (const mode of ["on", "b"]) out.push([`ended ${job} ${mode}`, RF.PERSON_LINE.ended(job, mode)]);
  return out;
}

test("no text a person reads ranks the models by price", () => {
  for (const [label, text] of personTexts()) assert.doesNotMatch(text, PRICE_RANK, `${label}: ${text}`);
});

test("the models box and the who-writes box say who runs each model and how much Claude usage it takes", () => {
  const models = B.modelsBox(null).questions[0].options;
  const line = (label) => models.find((o) => o.label === label).description;
  // No "the least" / "the most": with Fable 5.1 + Flash 3.8 among the choices, which choice uses most depends on the
  // run.
  for (const flash of ["Opus 5 + Flash 3.8", "Fable 5.1 + Flash 3.8"]) assert.match(line(flash), /Writing the code uses none of your Claude usage: Flash 3\.8 runs on your Google account\./);
  assert.match(line("Fable 5.1 + Flash 3.8"), /^Fable 5\.1 plans and reviews; Google's Flash 3\.8 writes the code\./);
  assert.match(line("Opus 5 + Sonnet 5"), /Everything runs on your Claude account\./);
  assert.match(line("Opus 5 only"), /Everything runs on your Claude account\./);
  assert.deepEqual(models.map((o) => o.label), ["Opus 5 + Flash 3.8", "Fable 5.1 + Flash 3.8", "Opus 5 + Sonnet 5", "Opus 5 only"], "four choices, the most the box shows");
  const [chatModel, documents] = B.handoffBox(null).questions;
  assert.match(chatModel.options.find((o) => o.label.startsWith("Sonnet")).description, /^Uses less of your Claude usage than Opus 5, with weaker judgment\.$/);
  assert.match(documents.options.find((o) => o.label === "Flash 3.8").description, /runs on your Google account, so it uses none of your Claude usage/);
  assert.match(documents.options.find((o) => o.label === "Sonnet 5").description, /^Runs on your Claude account and uses less of it than Opus 5\./);
});

test("a hand-off receipt calls its dollar figure an estimate", () => {
  const chat = { name: "Opus 5", reminder: "" };
  const receipts = [
    { status: "written", file: "docs/a.md", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", cost_usd: 0.004, id: "habcd" },
    { status: "landed", changed: ["a.js"], failed: [], check: "npm test", routed_model: "gemini-3.8-flash", cost_usd: 0.01, id: "habcd" },
    { status: "landed", changed: [], failed: [], routed_model: "gemini-3.8-flash", cost_usd: 0.001 },
    { status: "failed", kind: "tests", file: "t.test.js", output: "1 failing", cost_usd: 0.02 },
    { status: "failed", file: "docs/a.md", cost_usd: 0.003 },
    { status: "failed", cause: "appeared", file: "docs/a.md", cost_usd: 0.003 },
    { status: "failed", changed_meanwhile: ["a.js"], cost_usd: 0.003 },
    { status: "stopped", files: ["docs/a.md"], cost_usd: 0.002 },
  ];
  for (const r of receipts) {
    const line = H.receiptLine(r, chat);
    assert.match(line, /[Ee]stimated cost( so far)?: \$/, line);
    assert.doesNotMatch(line, /(?<![Ee]stimated )\b[Cc]ost( so far)?: \$/, `${line}: every dollar figure is an estimate`);
  }
});

test("the promise of a workflow says what zero-touch recognises: English, starting with what is wanted", () => {
  for (const [label, text] of personTexts()) assert.doesNotMatch(text, OWN_WORDS, `${label}: ${text}`);
  assert.match(M.workflowMessage({ policy: "opus-plus-flash-v38" }), /When you ask in English for one of these jobs, starting with what you want done and saying what it is about \(for example "fix the login bug", "add a due date to the to-do form", or "build a small to-do app" in an empty folder\), Claude starts a full workflow for it:/);
  assert.match(boxText(B.modeBox(null, { first: true })), /Ask for a job in English, starting with what you want done and saying what it is about \(fix the login bug, build a to-do app…\), and Claude runs a full workflow for it/);
});

test("every example the start message and the box give is recognised, in the folder it names", async () => {
  const { routeMessage } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));
  const EXISTING = "existing";
  const NEW = "new";
  const say = M.workflowMessage({ policy: "opus-plus-flash-v38" });
  for (const [example, folder, job] of [["fix the login bug", EXISTING, "bugfix"], ["add a due date to the to-do form", EXISTING, "feature-extend"], ["build a small to-do app", NEW, "greenfield"], ["build a to-do app", NEW, "greenfield"]]) {
    assert.ok(say.includes(example) || boxText(B.modeBox(null, { first: true })).includes(example), `${example} is an example we give`);
    assert.equal(routeMessage(example, folder).job, job, `${example}: ${routeMessage(example, folder).reason}`);
  }
});
