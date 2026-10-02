/**
 * The MCP tools of zero-touch's hand-off mode (docs/ambient-mode.md, "Hand-off mode").
 *
 * In a hand-off chat the chat's own model does the development, and work that is mostly typing AND has a check code
 * can run on the result goes to the hand-off policy's model through these tools:
 *
 *  - write_document — one NEW document, spec or planning text, written from a form the chat's model fills in
 *    (document.ts), checked by code, then written into the project.
 *  - write_tests_from_cases — one NEW test file for cases the chat's model decided (tests.ts), run with the
 *    project's own test command in a scratch copy of the project (scratch.ts); written only when its tests pass.
 *  - repeat_edit_across_files — a change the chat's model made once, repeated in the files it names as exact edits
 *    (repeat.ts), each checked, then all of them run against the project's check command in a scratch copy.
 *  - undo_hand_off — takes a landed hand-off back (landing.ts).
 *
 * Each call carries the stamp the plugin's hook adds (`_mmo`); the chat it names must be a hand-off chat, and its
 * policy and the model that policy gives each kind of work are read from the chat's own records (chat.ts), so they
 * are the ones the chat started with. The model never chooses the policy, the model or the auth mode in a call.
 *
 * A reply is one short receipt. A refused form and a failed hand-off are ordinary replies with `status` and `next`
 * (what the chat's model does now), not errors: both are outcomes the chat's model acts on.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelConfig, Policy, SelectOverrides, TelemetryEvent } from "../types.js";
import { loadPolicy } from "../policy.js";
import { appendEvent } from "../telemetry.js";
import { log } from "../log.js";
import { executorView } from "../executor/run.js";
import { HEARTBEAT_MS, ROUTED_ATTEMPTS, STAGE_CONCURRENCY, TRANSPORT, fallbackLeaf, typistDoorFor, typistForLeaf, type ProgressChannel } from "../executor/tools.js";
import type { Typist } from "../executor/typists.js";
import { beforeSnapshotFile, callInterrupted, formRefused, handoffTelemetryPath, readChatHandoff, recordStopped, releasePath, type ChatHandoff, type HandoffWork } from "./chat.js";
import { DOCUMENT_KINDS, checkDocument, checkDocumentForm, documentPacket, renderDocumentInstruction, renderDocumentShared } from "./document.js";
import { checkTestsForm, checkTestsText, renderTestsInstruction, renderTestsShared, testsPacket } from "./tests.js";
import { changeMarkers, checkRepeatEdits, checkRepeatForm, readTarget, renderRepeatInstruction, renderRepeatShared, repeatPacket } from "./repeat.js";
import { gitProblem, makeScratchCopy, runInScratch, type ScratchRun } from "./scratch.js";
import { recordLanding, undoLanding, landingIdForFile } from "./landing.js";
import { runHandoff, type HandoffDeps, type HandoffJob, type HandoffOutcome } from "./run.js";

/**
 * The time limit on a command run in a scratch copy (a test file's run, a project's check). A stated safety bound
 * that only catches a command that hangs: ten minutes is far longer than one test file or a build takes, and the
 * chat's model is waiting on the call.
 */
export const CHECK_TIMEOUT_S = 600;

const STAMP = { _mmo: { type: "object", description: "Added by the plugin's hook. Do not set it." } };
const oneLine = (description: string) => ({ type: "string", description });

export const HANDOFF_TOOLS = [
  {
    name: "write_document",
    description:
      "Zero-touch hand-off (works only in a hand-off chat): have the hand-off policy's model write ONE NEW file of this project from the brief you fill in here: docs (a README, a guide, an API reference, a changelog), spec (requirements, a design document, an API spec, a data-model write-up) or plan (a plan, a task breakdown or tickets, a status report, release notes). Code checks the result (every section present, every shell command one of your facts, every project path real) and only then writes the file. The form is a brief, never the finished text: every string is ONE line. The typist cannot see the project, so `facts` must hold everything the document may state about it: every command, path, setting, name and number. Returns one short receipt; read the written file before you tell the person it is done.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...DOCUMENT_KINDS] },
        file: oneLine("The NEW file, as a path from the project folder (for example docs/setup.md). A file that exists is refused: change it yourself."),
        purpose: oneLine("What the document is for."),
        readers: oneLine("Who reads it, and what they already know."),
        sections: {
          type: "array",
          description: "The sections, in order. At least one.",
          items: {
            type: "object",
            properties: { heading: oneLine("The section's heading, as it will appear."), must_say: oneLine("What the section must tell the reader: an instruction, not the text itself.") },
            required: ["heading", "must_say"],
          },
        },
        facts: {
          type: "array",
          description: "Everything the document may state about the project. At least one.",
          items: {
            type: "object",
            properties: {
              statement: oneLine("One fact, with the exact command, path, setting, name or number in it."),
              source: oneLine('The project file the fact comes from (a path from the project folder), or "chat" for something the person said.'),
              quote: oneLine("For a project file: one line copied exactly from it that shows the fact. Omit for a fact from the chat."),
            },
            required: ["statement", "source"],
          },
        },
        style_from: oneLine("Optional: an existing document of the project whose tone and layout to follow."),
        ...STAMP,
      },
      required: ["kind", "file", "purpose", "readers", "sections", "facts"],
    },
  },
  {
    name: "write_tests_from_cases",
    description:
      "Zero-touch hand-off (works only in a hand-off chat): have the hand-off policy's model write ONE NEW test file for code that exists, from the cases you decide here. Code runs the file with your test command in a scratch copy of the project, and writes it into the project only when its tests pass. A case's expected result is the specification: the typist may not change it to make a test pass, so when the tests keep failing you get the run's output back. Then: a wrong case you correct and hand off again; a real bug in the code under test you tell the person. Every string is ONE line. The project must be a git repository.",
    inputSchema: {
      type: "object",
      properties: {
        file: oneLine("The NEW test file, as a path from the project folder (for example tests/cart.test.js)."),
        target: oneLine("The file under test, as a path from the project folder."),
        functions: { type: "array", items: { type: "string" }, description: "The names in the target the tests exercise. Each must be in the target file. At least one." },
        cases: {
          type: "array",
          description: "One test per case. At least one.",
          items: {
            type: "object",
            properties: { name: oneLine("The test's title; it must be unique."), given: oneLine("The input or the situation."), expect: oneLine("The exact expected result.") },
            required: ["name", "given", "expect"],
          },
        },
        style_from: oneLine("Optional: an existing test file whose framework, imports and layout to follow."),
        test_command: oneLine("The command that runs the new test file, as typed from the project folder (for example node --test tests/cart.test.js)."),
        fails_until_fixed: { type: "boolean", description: "Optional: true for a regression test written BEFORE you fix the bug it shows. The tests must then fail in the scratch copy (and name a case in the failure), and the file is written for you to make pass with your fix." },
        notes: oneLine("Optional: anything else the typist must know."),
        ...STAMP,
      },
      required: ["file", "target", "functions", "cases", "test_command"],
    },
  },
  {
    name: "repeat_edit_across_files",
    description:
      "Zero-touch hand-off (works only in a hand-off chat): repeat in other files a change you ALREADY made by hand in one file. The example file's own change since the last commit is the pattern; the hand-off policy's model answers with exact edits for each target. Code checks every edit applies exactly once and removes only lines the change is about, runs your check command in a scratch copy with all the changed files, and only then writes them. A target whose edits do not pass is named back for you to change yourself. undo_hand_off takes the landing back. The project must be a git repository.",
    inputSchema: {
      type: "object",
      properties: {
        example: oneLine("The file you changed by hand, as a path from the project folder. It must differ from the last commit."),
        targets: { type: "array", items: { type: "string" }, description: "The files to repeat the change in, as paths from the project folder. At least one." },
        change: oneLine("The change, in words."),
        check_command: oneLine("Optional but wanted: the project's build or test command, run in a scratch copy with every changed file."),
        ...STAMP,
      },
      required: ["example", "targets", "change"],
    },
  },
  {
    name: "undo_hand_off",
    description:
      "Zero-touch hand-off (works only in a hand-off chat): take a landed hand-off back. A file it changed gets its earlier text, a file it created is removed; a file changed since is left alone and named.",
    inputSchema: {
      type: "object",
      properties: {
        id: oneLine("The hand-off's id from its receipt (for example h7k2q). Or give file instead."),
        file: oneLine("Or the file the hand-off wrote, as the person names it (for example CONTRIBUTING.md): its latest hand-off is undone."),
        include_changed: { type: "boolean", description: "Optional: true only after the person agreed to undo it even though its files changed since (a later correction is lost)." },
        ...STAMP,
      },
    },
  },
] as const;

export const HANDOFF_TOOL_NAMES: ReadonlySet<string> = new Set(HANDOFF_TOOLS.map((t) => t.name));

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
/** A receipt is sent as compact JSON: the chat's model re-reads it on every later turn. */
const receipt = (value: unknown): Reply => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export interface HandoffContext {
  overrides: SelectOverrides;
  env?: Record<string, string | undefined>;
  /** Tests pass fake typists; the server passes nothing and gets the executor's. */
  typistFor?: (leaf: ModelConfig, authMode: "estimated" | "vendor") => Typist;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  /** The request's progress channel: a hand-off that runs a command can take minutes, and progress keeps the call alive. */
  progress?: ProgressChannel;
  /** The request's cancel signal: the person stopped the call. Nothing lands after it fires. */
  signal?: AbortSignal;
}

/** Runs a long step while telling the client the call is still alive. */
async function alive<T>(ctx: HandoffContext, message: string, step: () => Promise<T>): Promise<T> {
  const token = ctx.progress?.token;
  if (token === undefined) return step();
  let n = 0;
  const beat = setInterval(() => { void ctx.progress!.send({ progressToken: token, progress: ++n, message }).catch(() => {}); }, HEARTBEAT_MS);
  try { return await step(); } finally { clearInterval(beat); }
}

/**
 * A typist that is built when it is first used: one that cannot run on this machine (a claude CLI without the lean
 * flags, no Python for the agent door) then fails its attempt with the reason, and the ladder moves on, instead of
 * the whole hand-off failing before anything was tried.
 */
function lazyTypist(leaf: ModelConfig, build: () => Typist): Typist {
  let built: Typist | undefined;
  return {
    door: typistDoorFor(leaf) ?? "lean-opus",
    modelId: leaf.id,
    modelName: leaf.model_name,
    type: async (req) => (built ??= build()).type(req),
  };
}

/**
 * The typists for one kind of hand-off work. The kind's own shipped policy (the one whose typist the person chose; a
 * project's policy file is never used by zero-touch) routes the typing, read as the executor reads it. The last
 * attempt, after the typist fails twice, is the chat's own model (the person's chat model, or the organisation's), so
 * no model the person did not choose ever works on their project; a chat with no one chat model keeps the policy's own
 * Claude model for it.
 */
function typistsFor(chat: ChatHandoff, work: HandoffWork, ctx: HandoffContext): { policy: Policy; routed: Typist; fallback: Typist | null } | { refused: string } {
  const route = chat.routes[work];
  if (route.kept) return { refused: "the person keeps this kind of work in the chat (their zero-touch setting), so it is not handed off" };
  let policy: Policy;
  try {
    policy = executorView(loadPolicy({ policyName: route.policy })).policy;
  } catch (e: any) {
    return { refused: `the hand-off policy cannot be read: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}` };
  }
  const leaf = policy.models.find((m) => m.id === route.id);
  if (!leaf) return { refused: `the hand-off policy no longer has the model this chat resolved for ${work} work (${route.id}); start a new chat` };
  if (!typistDoorFor(leaf)) return { refused: `the hand-off tools have no typist for adapter '${leaf.adapter}' (model ${leaf.id})` };
  const build = ctx.typistFor ?? typistForLeaf;
  const routed = lazyTypist(leaf, () => build(leaf, chat.authMode));
  const last = chatModelLeaf(chat, policy, ctx);
  // The last attempt and the routed attempts share one typist when both are the same model.
  const fallback = !last ? null : last.model_name === leaf.model_name ? routed : lazyTypist(last, () => build(last, chat.authMode));
  return { policy, routed, fallback };
}

/**
 * The leaf the last attempt types with: the chat's own model through the Claude command line (the same door, login
 * and billing as the policy's Claude model, with the chat's model named), or the policy's own Claude model when the
 * chat has no one model (an organisation's alias).
 */
function chatModelLeaf(chat: ChatHandoff, policy: Policy, ctx: HandoffContext): ModelConfig | null {
  const claude = fallbackLeaf(policy, ctx.overrides);
  if (!chat.chatModel) return claude;
  if (claude && claude.model_name === chat.chatModel) return claude;
  return {
    id: `chat-model:${chat.chatModel}`,
    adapter: claude?.adapter ?? "builtin-anthropic",
    model_name: chat.chatModel,
    ...(claude?.auth ? { auth: claude.auth } : {}),
    ...(claude?.max_output_tokens_absolute ? { max_output_tokens_absolute: claude.max_output_tokens_absolute } : {}),
  };
}

const refusedCall = (reason: string) => receipt({ status: "refused", reason, next: "Nothing was sent. Do this work yourself." });

export async function handleHandoffTool(name: string, rawArgs: unknown, ctx: HandoffContext): Promise<Reply> {
  const { _mmo: stamp, ...args } = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  // An undo sends nothing to a model, so it needs the chat and its project, not the chat's models.
  const chat = readChatHandoff(stamp, ctx.env ?? process.env, { needRoutes: name !== "undo_hand_off" });
  if ("refused" in chat) {
    log("warn", "handoff.refused", { tool: name, reason: chat.refused });
    return refusedCall(chat.refused);
  }
  // A document can take minutes too (a rate-limited typist's waits, then the last attempt): progress keeps the call
  // alive and shows the person it is working.
  if (name === "write_document") return alive(ctx, "the hand-off is writing the new document", () => writeDocument(args, chat, ctx));
  if (name === "write_tests_from_cases") return alive(ctx, "the hand-off is writing and running the tests", () => writeTests(args, chat, ctx));
  if (name === "repeat_edit_across_files") return alive(ctx, "the hand-off is repeating and checking the change", () => repeatEdit(args, chat, ctx));
  if (name === "undo_hand_off") return undo(args, chat);
  return refusedCall(`unknown hand-off tool ${name}`);
}

/** What one hand-off's runner needs besides its job: the typists, the ladder, the bill. */
function depsFor(chat: ChatHandoff, typists: { policy: Policy; routed: Typist; fallback: Typist | null }, ctx: HandoffContext): HandoffDeps {
  const telemetryPath = handoffTelemetryPath(chat);
  return {
    routed: typists.routed, fallback: typists.fallback, routedAttempts: ROUTED_ATTEMPTS, transport: TRANSPORT,
    policy: { name: typists.policy.name, version: typists.policy.version },
    emit: (ev: TelemetryEvent) => appendEvent(telemetryPath, ev), sleep: ctx.sleep, random: ctx.random,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

/** The person stopped this call: the request's cancel signal, or the hook's mark of an interrupted call. */
const wasStopped = (chat: ChatHandoff, ctx: HandoffContext, outcome?: { stopped?: boolean }) => Boolean(outcome?.stopped || ctx.signal?.aborted || callInterrupted(chat));

/**
 * The person stopped the hand-off: nothing lands, the file is handed back, and since Claude never
 * reads the reply to a cancelled call, the person is told at their next message (chat.ts recordStopped).
 */
function stoppedReply(chat: ChatHandoff, files: string[], cost: number, releases: string[] = files): Reply {
  for (const f of releases) releasePath(chat.dir, f);
  recordStopped(chat.dir, { files, cost_usd: round6(cost) });
  log("info", "handoff.stopped", { files: files.length, cost_usd: round6(cost) });
  return receipt({ status: "stopped", files, cost_usd: round6(cost), next: "The person stopped this hand-off, and nothing was added to the project. Do not hand it off again unless they ask." });
}

/**
 * A new file appeared while its hand-off ran: someone else's work. It is never written over and
 * not handed back for Claude to overwrite either; the person decides.
 */
function appearedReply(file: string, kind: string, outcome: HandoffOutcome): Reply {
  log("warn", "handoff.appeared", { file, cost_usd: outcome.cost_usd });
  return receipt({
    status: "failed", cause: "appeared", file, kind, routed_model: outcome.routed_model, attempts: outcome.attempts, cost_usd: outcome.cost_usd,
    reason: `${file} was created by someone else while the hand-off ran, so nothing was written over it`,
    next: `${file} now exists, made by someone else while the hand-off ran. Do not overwrite it and do not hand it off again: tell the person in one line and ask what they want done.`,
  });
}

/** A refused form for a new file: fix it and call again, or, once handed back (chat.ts formRefused), write it yourself. */
function refusedForm(chat: ChatHandoff, file: unknown, problems: string[]): Reply {
  const handedBack = formRefused(chat.dir, file, problems);
  return receipt({
    status: "refused", problems, ...(handedBack ? { handed_back: file } : {}),
    next: handedBack
      ? `Nothing was sent. This file cannot be handed off as asked, so write ${String(file)} yourself.`
      : "Nothing was sent. Fix these in the form and call again.",
  });
}
const maxOutOf = (typists: { policy: Policy; routed: Typist }) => typists.policy.models.find((m) => m.id === typists.routed.modelId)?.max_output_tokens_absolute ?? 8192;
const seconds = (run: ScratchRun) => `${(run.ms / 1000).toFixed(1)} s`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function writeDocument(args: Record<string, unknown>, chat: ChatHandoff, ctx: HandoffContext): Promise<Reply> {
  const checked = checkDocumentForm(args, chat.projectDir);
  if ("problems" in checked) {
    log("info", "handoff.document", { status: "refused", problems: checked.problems.length });
    return refusedForm(chat, args.file, checked.problems);
  }
  const form = checked.form;
  const typists = typistsFor(chat, "docs", ctx);
  if ("refused" in typists) {
    log("warn", "handoff.refused", { tool: "write_document", reason: typists.refused });
    // The reply tells Claude to write it itself: the file is handed back first, so the hook's safety net lets that
    // write through.
    releasePath(chat.dir, form.file);
    return refusedCall(typists.refused);
  }

  const maxOut = maxOutOf(typists);
  const job: HandoffJob = {
    id: `doc:${form.file}`,
    path: form.file,
    phase: "docs",
    kind: form.kind,
    contract: "file",
    shared: renderDocumentShared(),
    packet: (refusal) => documentPacket(form, chat.projectDir, renderDocumentInstruction(form, refusal), "handoff", maxOut),
    accept: (answer) => {
      const verdict = checkDocument(form, answer.content ?? "", chat.projectDir);
      return verdict.ok ? { content: answer.content!, checked: verdict.checked } : { reason: verdict.reason };
    },
  };
  const outcome: HandoffOutcome = await runHandoff(job, depsFor(chat, typists, ctx));

  if (wasStopped(chat, ctx, outcome)) return stoppedReply(chat, [form.file], outcome.cost_usd);
  // The file was new when the form was checked; one that appeared meanwhile is someone's work and is never overwritten.
  if (existsSync(join(chat.projectDir, form.file))) return appearedReply(form.file, form.kind, outcome);
  if (!outcome.ok) {
    releasePath(chat.dir, form.file);
    log("warn", "handoff.document", { status: "failed", file: form.file, attempts: outcome.attempts, cost_usd: outcome.cost_usd });
    return receipt({
      status: "failed", file: form.file, kind: form.kind, routed_model: outcome.routed_model, attempts: outcome.attempts, reason: outcome.reason ?? "no answer", cost_usd: outcome.cost_usd,
      next: `Write ${form.file} yourself, and tell the person in one line that the hand-off failed.`,
    });
  }
  const id = recordLanding(chat.dir, chat.projectDir, { tool: "write_document", files: [{ path: form.file, content: outcome.content! }] });
  log("info", "handoff.document", { status: "written", id, file: form.file, written_by: outcome.written_by, attempts: outcome.attempts, cost_usd: outcome.cost_usd });
  return receipt({
    status: "written", id, file: form.file, kind: form.kind, written_by: outcome.written_by, routed_model: outcome.routed_model, attempts: outcome.attempts, cost_usd: outcome.cost_usd,
    ...(outcome.note ? { note: outcome.note } : {}),
    checked: outcome.checked,
    next: `Read ${form.file} before you tell the person it is done; correct a slip yourself. ${whoWrote(outcome.written_by, outcome.routed_model)}`,
  });
}

async function writeTests(args: Record<string, unknown>, chat: ChatHandoff, ctx: HandoffContext): Promise<Reply> {
  const checked = checkTestsForm(args, chat.projectDir);
  if ("problems" in checked) {
    log("info", "handoff.tests", { status: "refused", problems: checked.problems.length });
    return refusedForm(chat, args.file, checked.problems);
  }
  const form = checked.form;
  const typists = typistsFor(chat, "tests", ctx);
  if ("refused" in typists) {
    log("warn", "handoff.refused", { tool: "write_tests_from_cases", reason: typists.refused });
    releasePath(chat.dir, form.file);
    return refusedCall(typists.refused);
  }
  // No copy to run the tests in means they cannot be checked, so nothing is sent: the chat's model writes them itself.
  const scratch = makeScratchCopy(chat.projectDir);
  if (scratch.refused !== undefined) {
    releasePath(chat.dir, form.file);
    log("warn", "handoff.refused", { tool: "write_tests_from_cases", reason: scratch.refused });
    return receipt({ status: "refused", reason: scratch.refused, ...(scratch.cause ? { cause: scratch.cause } : {}), next: `Nothing was sent. Write ${form.file} yourself.` });
  }

  const maxOut = maxOutOf(typists);
  let lastRun: ScratchRun | null = null;
  const job: HandoffJob = {
    id: `tests:${form.file}`,
    path: form.file,
    phase: "tests",
    kind: "tests",
    contract: "file",
    shared: renderTestsShared(),
    packet: (refusal) => testsPacket(form, chat.projectDir, renderTestsInstruction(form, refusal), maxOut),
    accept: async (answer) => {
      const content = answer.content ?? "";
      const text = checkTestsText(form, content);
      if (!text.ok) { lastRun = null; return { reason: text.reason }; }
      // Paths are the chat folder's; the copy is the whole repository, with the chat folder at scratch.cwd.
      const inCopy = join(scratch.dir, scratch.cwd, form.file);
      mkdirSync(dirname(inCopy), { recursive: true });
      writeFileSync(inCopy, content);
      const run = await runInScratch(scratch.dir, form.test_command, { timeoutMs: CHECK_TIMEOUT_S * 1000, env: ctx.env, ...(scratch.cwd ? { cwd: scratch.cwd } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      lastRun = run;
      const present = `${form.cases.length} case${form.cases.length === 1 ? "" : "s"} present`;
      // A regression test written before the fix: it must fail now, on its own cases (a failure that names none of
      // them is a file that did not run, not a test that found the bug).
      if (form.fails_until_fixed) {
        const named = form.cases.filter((c) => run.output.includes(c.name)).map((c) => c.name);
        if (run.code !== 0 && !run.timedOut && named.length) return { content, checked: [present, `\`${form.test_command}\` failed in a scratch copy, as expected before the fix, naming: ${named.join("; ")}`] };
        if (run.code === 0 && !run.timedOut) return { reason: "the tests passed, but they are meant to fail until the bug is fixed: make each case's test assert exactly the expected result" };
        const how = run.timedOut ? `it was stopped at its ${CHECK_TIMEOUT_S} s time limit` : `exit ${run.code}, and the output names no case`;
        return { reason: `the test file did not run its cases in a scratch copy (${how}). Its output:\n${run.output.trimEnd()}` };
      }
      if (run.code === 0 && !run.timedOut) {
        return { content, checked: [present, `\`${form.test_command}\` passed in a scratch copy (${seconds(run)})`] };
      }
      const how = run.timedOut ? `it was stopped at its ${CHECK_TIMEOUT_S} s time limit` : `exit ${run.code}`;
      return { reason: `the test command failed in a scratch copy of the project (${how}). Its output:\n${run.output.trimEnd()}` };
    },
  };
  let outcome: HandoffOutcome;
  try { outcome = await runHandoff(job, depsFor(chat, typists, ctx)); } finally { scratch.remove(); }

  if (wasStopped(chat, ctx, outcome)) return stoppedReply(chat, [form.file], outcome.cost_usd);
  if (existsSync(join(chat.projectDir, form.file))) return appearedReply(form.file, "tests", outcome);
  if (!outcome.ok) {
    releasePath(chat.dir, form.file);
    const failedRun = lastRun as ScratchRun | null;
    log("warn", "handoff.tests", { status: "failed", file: form.file, attempts: outcome.attempts, cost_usd: outcome.cost_usd });
    return receipt({
      status: "failed", file: form.file, kind: "tests", routed_model: outcome.routed_model, attempts: outcome.attempts, reason: outcome.reason ?? "no answer", cost_usd: outcome.cost_usd,
      ...(failedRun ? { output: failedRun.output.trimEnd() } : {}),
      next: `Nothing was written. Read the output: if a case is wrong, correct it and hand off again, or write ${form.file} yourself; if it shows a real bug in ${form.target}, tell the person, and do not change a test to hide it.`,
    });
  }
  const id = recordLanding(chat.dir, chat.projectDir, { tool: "write_tests_from_cases", files: [{ path: form.file, content: outcome.content! }] });
  log("info", "handoff.tests", { status: "written", id, file: form.file, written_by: outcome.written_by, attempts: outcome.attempts, cost_usd: outcome.cost_usd, fails_until_fixed: form.fails_until_fixed || undefined });
  return receipt({
    status: "written", id, file: form.file, kind: "tests", written_by: outcome.written_by, routed_model: outcome.routed_model, attempts: outcome.attempts, cost_usd: outcome.cost_usd,
    ...(form.fails_until_fixed ? { fails_until_fixed: true } : {}),
    ...(outcome.note ? { note: outcome.note } : {}),
    checked: outcome.checked,
    next: form.fails_until_fixed
      ? `Read ${form.file}. Its tests fail until you fix ${form.target}: make the fix, then run \`${form.test_command}\` and see them pass.`
      : `Read ${form.file} before you tell the person it is done. ${whoWrote(outcome.written_by, outcome.routed_model)}`,
  });
}

/**
 * A model's name as the person reads it ("gemini-3.8-flash" is Flash 3.8, "claude-sonnet-5" Sonnet 5), the same rule
 * as the hooks' lib/handoff.mjs displayName; an id of another shape is shown as it is.
 */
function personModel(model: unknown): string {
  const id = String(model ?? "").trim().replace(/\[[^\]]*\]$/, "");
  const claude = /^claude-([a-z]+)-(\d+(?:[.-]\d+)?)(?:-\d{8})?$/.exec(id);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2].replace("-", ".")}`;
  const gemini = /^gemini-([\d.]+)-([a-z]+(?:-[a-z]+)*)$/.exec(id);
  if (gemini) return `${gemini[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")} ${gemini[1]}`;
  return id;
}
/**
 * Who Claude names as the writer, so Claude never says "I wrote it" about a file the hand-off model wrote. The
 * receipt's own `written_by`: the hand-off model, or the chat's own model after two failed attempts, when "I wrote it"
 * is the truth. Every receipt that lands work carries it (documents, tests, repeats).
 */
function whoWrote(writtenBy: unknown, routedModel?: unknown): string {
  const name = personModel(writtenBy);
  if (!name) return "";
  // After two failed attempts the chat's own model wrote it: then that is the truth to tell.
  if (routedModel && writtenBy !== routedModel) return `When you tell the person, say that the hand-off to ${personModel(routedModel)} failed twice, so ${name} wrote it.`;
  return `When you tell the person, say that ${name} wrote it, not you.`;
}

async function repeatEdit(args: Record<string, unknown>, chat: ChatHandoff, ctx: HandoffContext): Promise<Reply> {
  // git first: without it nothing can be checked, so the form is not judged at all (its "make the
  // change first" would send the chat's model round a loop it cannot leave).
  const noGit = gitProblem(chat.projectDir);
  if (noGit) {
    log("warn", "handoff.refused", { tool: "repeat_edit_across_files", reason: noGit.refused });
    return receipt({ status: "refused", reason: noGit.refused, cause: noGit.cause, next: "Nothing was sent. Make the change in the other files yourself." });
  }
  const checked = checkRepeatForm(args, chat.projectDir, { before: (path) => beforeSnapshotFile(chat.dir, path) });
  if ("problems" in checked) {
    log("info", "handoff.repeat", { status: "refused", problems: checked.problems.length });
    return receipt({ status: "refused", problems: checked.problems, next: "Nothing was sent. Fix these in the form and call again." });
  }
  const form = checked.form;
  const typists = typistsFor(chat, "repeat", ctx);
  if ("refused" in typists) {
    log("warn", "handoff.refused", { tool: "repeat_edit_across_files", reason: typists.refused });
    return refusedCall(typists.refused);
  }
  const scratch = makeScratchCopy(chat.projectDir);
  if (scratch.refused !== undefined) {
    log("warn", "handoff.refused", { tool: "repeat_edit_across_files", reason: scratch.refused });
    return receipt({ status: "refused", reason: scratch.refused, ...(scratch.cause ? { cause: scratch.cause } : {}), next: "Nothing was sent. Make the change in the other files yourself." });
  }

  try {
    const markers = changeMarkers(form.diff);
    const shared = renderRepeatShared(form);
    const maxOut = maxOutOf(typists);
    const deps = depsFor(chat, typists, ctx);
    // One job per target, a few at a time: each carries only its own file, so no job waits for another.
    const results = new Map<string, { before: string; outcome: HandoffOutcome }>();
    const queue = [...form.targets];
    await Promise.all(Array.from({ length: Math.min(STAGE_CONCURRENCY, queue.length) }, async () => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        const path = target;
        const before = readTarget(chat.projectDir, path);
        const job: HandoffJob = {
          id: `repeat:${path}`,
          path,
          phase: "codegen",
          kind: "repeat",
          contract: "edit",
          shared,
          packet: (refusal) => repeatPacket(path, before, renderRepeatInstruction(path, refusal), maxOut),
          accept: (answer) => {
            // Exact edits only: a whole rewritten file cannot be checked line by line against the change.
            if (!answer.edits) return { reason: "answer with exact edits for this file, not the whole file" };
            const verdict = checkRepeatEdits(before, answer.edits, markers);
            return verdict.ok ? { content: verdict.content, checked: [] } : { reason: verdict.reason };
          },
        };
        results.set(path, { before, outcome: await runHandoff(job, deps) });
      }
    }));

    if (wasStopped(chat, ctx) || [...results.values()].some((r) => r.outcome.stopped)) {
      return stoppedReply(chat, form.targets, round6([...results.values()].reduce((s, r) => s + r.outcome.cost_usd, 0)), []);
    }
    const changed: { path: string; content: string }[] = [];
    const unchanged: string[] = [];
    const failed: { file: string; reason: string }[] = [];
    let cost = 0;
    let byClaude = 0;
    for (const path of form.targets) {
      const { before, outcome } = results.get(path)!;
      cost += outcome.cost_usd;
      if (!outcome.ok) failed.push({ file: path, reason: outcome.reason ?? "no answer" });
      else if (outcome.content === before) unchanged.push(path);
      else { changed.push({ path, content: outcome.content! }); if (outcome.written_by !== outcome.routed_model) byClaude++; }
    }
    cost = round6(cost);
    const routedModel = typists.routed.modelName;
    const changedPaths = changed.map((c) => c.path);
    const leftForChat = failed.length ? `Make the change in ${failed.map((f) => f.file).join(", ")} yourself. ` : "";

    if (!changed.length && failed.length) {
      log("warn", "handoff.repeat", { status: "failed", targets: form.targets.length, failed: failed.length, cost_usd: cost });
      return receipt({ status: "failed", reason: "no target's edits passed the checks", routed_model: routedModel, changed: [], unchanged, failed, cost_usd: cost, next: `Nothing was changed. ${leftForChat}`.trim() });
    }

    let check = "not run (no check_command was given)";
    if (changed.length && form.check_command) {
      // The copy already holds the example as the chat's model changed it; the repeated edits go on top.
      for (const c of changed) writeFileSync(join(scratch.dir, scratch.cwd, c.path), c.content);
      const run = await runInScratch(scratch.dir, form.check_command, { timeoutMs: CHECK_TIMEOUT_S * 1000, env: ctx.env, ...(scratch.cwd ? { cwd: scratch.cwd } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (wasStopped(chat, ctx)) return stoppedReply(chat, changedPaths, cost, []);
      if (run.code !== 0 || run.timedOut) {
        const how = run.timedOut ? `it was stopped at its ${CHECK_TIMEOUT_S} s time limit` : `exit ${run.code}`;
        log("warn", "handoff.repeat", { status: "failed", targets: form.targets.length, changed: changed.length, cost_usd: cost, check: "failed" });
        return receipt({
          status: "failed", reason: `the check command failed in a scratch copy with the ${changed.length} changed file${changed.length === 1 ? "" : "s"} (${how})`, routed_model: routedModel,
          would_change: changedPaths, unchanged, failed, output: run.output.trimEnd(), cost_usd: cost,
          next: "Nothing was changed in the project. Read the output, then make the change yourself, or hand off again with fewer targets.",
        });
      }
      check = `\`${form.check_command}\` passed in a scratch copy (${seconds(run)})`;
    }

    // A file changed in the project while the hand-off ran (the person in their editor, another chat) is never written
    // over: the edits were made against the file as it was at the start. Nothing lands then, not even the
    // other files: the check above ran on all the edits together, so landing only some of them would be a set nobody
    // checked. A file that is gone counts as changed.
    const stillAsBefore = (path: string) => { try { return readTarget(chat.projectDir, path) === results.get(path)!.before; } catch { return false; } };
    const meanwhile = changed.map((c) => c.path).filter((path) => !stillAsBefore(path));
    if (meanwhile.length) {
      log("warn", "handoff.repeat", { status: "failed", targets: form.targets.length, changed_meanwhile: meanwhile.length, cost_usd: cost });
      return receipt({
        status: "failed", reason: `${meanwhile.join(", ")} changed while the hand-off ran`, routed_model: routedModel,
        changed_meanwhile: meanwhile, would_change: changedPaths, unchanged, failed, cost_usd: cost,
        next: `Nothing was changed in the project: ${meanwhile.join(", ")} changed while the hand-off ran, so nothing was written over. Read ${meanwhile.length === 1 ? "it" : "them"}, then make the change yourself where it is still needed.`,
      });
    }

    if (wasStopped(chat, ctx)) return stoppedReply(chat, changedPaths, cost, []);
    const id = changed.length ? recordLanding(chat.dir, chat.projectDir, { tool: "repeat_edit_across_files", files: changed }) : undefined;
    // The example's kept earlier text served this change; the chat's next change of it starts a new one.
    if (id) try { rmSync(beforeSnapshotFile(chat.dir, form.example), { force: true }); } catch { /* kept: harmless */ }
    log("info", "handoff.repeat", { status: "landed", id, changed: changed.length, unchanged: unchanged.length, failed: failed.length, cost_usd: cost });
    return receipt({
      status: "landed", ...(id ? { id } : {}), changed: changedPaths, unchanged, failed, routed_model: routedModel,
      ...(byClaude ? { by_fallback: byClaude, fallback_model: typists.fallback?.modelName } : {}),
      check, cost_usd: cost,
      next: `${leftForChat}${id ? `Look over the changed files before you tell the person it is done; undo_hand_off with id ${id} takes this back. ${byClaude ? `When you tell the person, say that ${personModel(routedModel)} made the change in ${changed.length - byClaude} of the files and ${personModel(typists.fallback?.modelName)} in ${byClaude}.` : whoWrote(routedModel)}` : "No file needed the change."}`,
    });
  } finally {
    scratch.remove();
  }
}

function undo(args: Record<string, unknown>, chat: ChatHandoff): Reply {
  // By the file the person names, or by the receipt's id.
  const file = typeof args.file === "string" ? args.file.trim() : "";
  const id = (typeof args.id === "string" ? args.id.trim() : "") || (file ? landingIdForFile(chat.dir, chat.projectDir, file) ?? "" : "");
  if (!id) return receipt({ status: "refused", cause: "no-id", ...(file ? { file } : {}), reason: file ? `there is no hand-off of ${file} to undo in this project` : "name the hand-off to undo: the file it wrote, or its receipt's id", next: "Nothing was changed. Tell the person in one line." });
  const result = undoLanding(chat.dir, chat.projectDir, id, { includeChanged: args.include_changed === true });
  if ("refused" in result) return receipt({ status: "refused", cause: result.cause, id, reason: result.refused, next: "Nothing was changed. Tell the person in one line." });
  // Every file changed since: nothing is undone and the landing stays, so the person can decide.
  if (result.kept) {
    log("info", "handoff.undo", { id, kept: result.left_alone.length });
    return receipt({
      status: "kept", id, changed_since: result.left_alone,
      next: `Nothing was undone: ${result.left_alone.join(", ")} changed after the hand-off (perhaps your own correction). Tell the person, and ask whether to undo it anyway, which loses those changes; only if they say yes, call undo_hand_off again with include_changed: true.`,
    });
  }
  log("info", "handoff.undo", { id, restored: result.restored.length, left_alone: result.left_alone.length });
  return receipt({
    status: "undone", id, restored: result.restored, left_alone: result.left_alone,
    ...(result.left_alone.length ? { next: `${result.left_alone.join(", ")} changed after the hand-off and was left as it is: tell the person, and ask whether to take it back too (undo_hand_off again with include_changed: true).` } : {}),
  });
}
