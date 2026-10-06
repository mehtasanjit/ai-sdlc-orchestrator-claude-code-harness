#!/usr/bin/env node
/**
 * Zero-touch hook dispatcher: one entry point for the hook moments zero-touch's workflow routing needs, in a chat the
 * zero-touch plugin marked at its start (no /mmo: command typed).
 *
 *   node hook.mjs <event>        hook input JSON on stdin, decision JSON on stdout
 *
 * What it does: a message the fixed rules recognise as one of the eight /mmo: jobs (lib/route.mjs) gets the
 * instruction to start that job's workflow (lib/route-flow.mjs); until the workflow starts, tools that change
 * something wait (Guard A, pre-any) and only that workflow's command may start (Guard B, pre-skill). Every other
 * message and every other tool call passes untouched: the chat is plain Claude Code.
 *
 * Hand-off mode (a chat the zero-touch plugin marked "b"; docs/ambient-mode.md, "Hand-off mode"): the chat's own
 * model does the development, so plain words start no workflow. A message asking for a new document, spec, plan,
 * tests or the same change across files is recognised by fixed rules (lib/handoff-route.mjs) and the chat's model is
 * reminded to hand that work to the hand-off tools; the person sees one line saying where the work goes
 * (lib/handoff.mjs). The chat is kept on its pinned model: a switch to another model is refused (pre-model-switch).
 * A workflow command the person types runs as in any chat.
 *
 * A second job while a workflow runs (lib/queue.mjs): plain words recognised as a job, or the model starting one,
 * are queued at once and said. A typed /mmo: workflow command is held, and the model asks the person "Queue it" or
 * "Replace it"; the answer is read from the multiple-choice result (post-question). A queued job starts by itself
 * at the end of the turn in which the running workflow finished (turn-end); a workflow that ended any other way
 * drops the queue. A replace stops the running workflow as mmo's own abort does (lib/workflow-log.mjs abortRun).
 * One workflow at a time per project (lib/project-lock.mjs).
 *
 * Contract held by every handler:
 *   - Decisions are JSON on stdout with exit 0. The shell shim in front of this file turns ANY exit into 0, so a
 *     crash here can never block a tool call or a prompt. No handler relies on exit 2.
 *   - A chat without the zero-touch mark returns before touching the disk (the shim, then lib/chat-mode.mjs).
 *     Mode "observe", a workflow run and a helper agent's call start nothing.
 *   - Modes: "on" is workflow mode, "b" is hand-off mode; zero-touch acts in both (acts()). "observe" only records.
 *   - No prompt text, file content or command output is ever stored. Paths, sizes, rule ids and numbers only.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, MODES } from "./lib/config.mjs";
import { appendEvent, setEventAgent } from "./lib/events.mjs";
import { typedCommand, WORKFLOW_COMMANDS } from "./lib/commands.mjs";
import { appendPrivate, ensureSessionDir, mmoHome, sessionDir } from "./lib/paths.mjs";
import { onActiveChain, sentWhileWorking } from "./lib/transcript.mjs";
import { RUN_ID, abortRun, runStartMs, workflowState } from "./lib/workflow-log.mjs";
import { stampedRunCheck } from "./lib/run-check.mjs";
import { decideChatMode, dropChatMode } from "./lib/chat-mode.mjs";
import { folderKind, isStopRequest, mentionsZeroTouch, requestLead, routeMessage } from "./lib/route.mjs";
import { PERSON_LINE as L, REFUSAL, NOT_A_JOB_NOTE, SAVED_WITH_GIT, STOP_NOTE, runNote, cannotStartInstruction, carryYes, rememberedNote, midRunJudgeInstruction, chatPolicy, declinedLine, retryInstruction, dropRoute, helperModel, jobsFor, judgeable, judgeInstruction, KEEP_OUT, NOT_NOW_REASON, plainName, policyPath, readRoute, startArgs, startFirstReason, startInstruction, startProblem, typedBusyReason, writeRoute } from "./lib/route-flow.mjs";
import { acquire, heldByOther, lockOwner, pipelineRunOf, pipelineSinceOf, refreshOwner, release, runClaimedByOther } from "./lib/project-lock.mjs";
import * as Q from "./lib/queue.mjs";
import { handoffMessage } from "./lib/handoff-route.mjs";
import { bashDenyRules, deniedBy, toolRuleFor } from "./lib/bash-rules.mjs";
import { modeInForce } from "./lib/zt-saved.mjs";
import { brownfieldRunAgent, contractStepCall, ownScriptCall, ownServerTool, PRE_DISPATCH_TOOLS, serverCommands, serverCommandUnchecked, STAMPED_TOOLS } from "./lib/own-steps.mjs";
import { runEnded } from "../lib/run-log.mjs";
import { runFreeze } from "../lib/contract-lock.mjs";
import { SERVER_COMMAND_DENIED, serverCommandDeniedReason } from "./lib/route-flow.mjs";
import { baseline, SAID as GIT_SAID } from "./git-baseline.mjs";
const SAID_ALREADY = GIT_SAID.already;
import * as H from "./lib/handoff.mjs";
import { createdByHand, fileKind } from "./lib/handoff-net.mjs";
import { chatAuth } from "./lib/claude-login.mjs";
import { withRelay } from "./lib/relay.mjs";

const SELF_STOP_MS = 1500;
const BREAKER_FAILURES = 3;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const DEBUG = process.env.MMO_AMBIENT_DEBUG === "1";
/** The tags Claude Code wraps its own queued notices in, as read from Claude Code's own program (not guessed). */
const NOTICE_TAG = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

// A hook that hangs is worse than a hook that does nothing. The timer is
// unref'd, so it only matters when something (an open stdin) keeps us alive.
setTimeout(() => process.exit(0), SELF_STOP_MS).unref();

function readStdinJson() {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on("end", () => {
      if (size > MAX_STDIN_BYTES) return done(null);
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { done(null); }
    });
    process.stdin.on("error", () => done(null));
  });
}

/** Set once this hook run has written its answer: a run answers once, never twice. */
let emitted = false;
/** This run's moment (main sets it), for the relay of a line where the app folds it away (lib/relay.mjs). */
let currentEvent = null;
/** Claude Code's name for each moment whose answer the model reads; the others get no relay. */
function contextEvent(event) {
  if (event === "prompt") return "UserPromptSubmit";
  if (event === "turn-end") return "Stop";
  if (["pre-skill", "pre-any", "pre-agent", "pre-dispatch", "pre-handoff"].includes(event)) return "PreToolUse";
  if (["post-skill", "post-question", "post-handoff"].includes(event)) return "PostToolUse";
  return null;
}
/**
 * A line owed to the person from before this message (a queue dropped while no line could be shown): it goes out
 * with whatever this hook run emits, or on its own (main), exactly once.
 */
let aheadLine = null;
function emit(obj) {
  emitted = true;
  if (aheadLine) {
    obj = { ...obj, systemMessage: obj.systemMessage ? `${aheadLine}\n${obj.systemMessage}` : aheadLine };
    aheadLine = null;
  }
  // Outside the terminal the person never opens a folded line: Claude says it (lib/relay.mjs).
  process.stdout.write(JSON.stringify(withRelay(obj, contextEvent(currentEvent))));
}

const canonicalModel = H.canonicalModel;

function num(value, fallback, min = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

// ---------- chat markers (one tiny file each in the chat's folder; presence is the fact) ----------

function sessionMarker(ctx, name) {
  return join(sessionDir(ctx.sid), name);
}
function hasSessionMarker(ctx, name) {
  return existsSync(sessionMarker(ctx, name));
}
function setSessionMarker(ctx, name, text = "") {
  ensureSessionDir(ctx.sid);
  writeFileSync(sessionMarker(ctx, name), text, { mode: 0o600 });
}
function dropSessionMarker(ctx, name) {
  try { rmSync(sessionMarker(ctx, name), { force: true }); } catch { /* already gone */ }
}
/** A marker's text, or null when there is none. */
function sessionMarkerText(ctx, name) {
  try { return readFileSync(sessionMarker(ctx, name), "utf8"); } catch { return null; }
}

function breakerOpen(sid) {
  try {
    const file = join(sessionDir(sid), "failures.log");
    return existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= BREAKER_FAILURES;
  } catch {
    return false;
  }
}
function recordFailure(sid, event, err) {
  try {
    ensureSessionDir(sid);
    appendPrivate(join(sessionDir(sid), "failures.log"), `${new Date().toISOString()} ${event} ${String(err?.message ?? err).slice(0, 200)}\n`);
  } catch { /* nothing more to do */ }
}

/** Zero-touch acts in this chat: workflow mode ("on") or hand-off mode ("b"). A measuring run ("observe") only records. */
function acts(ctx) {
  return ctx.config.mode === "on" || ctx.config.mode === "b";
}

/**
 * Routing (docs/ambient-mode.md, "Routing") may act: workflow mode on for this chat, workflows switched on, no
 * workflow running, and not inside a helper agent. Hand-off mode never routes: there a workflow starts only from a
 * typed command.
 */
function routingOn(ctx) {
  return ctx.config.mode === "on" && ctx.config.routing === "on" && !ctx.pipeline && !ctx.agent;
}

/**
 * A message typed in a hand-off chat that is idle: which hand-off work it asks for, by the fixed rules. The person
 * sees where the work goes; the chat's model is reminded which tool takes it. Nothing is started and nothing is
 * blocked: the chat's model does the work, and hands the recognised part off.
 */
/**
 * The chat's real model when it is known and is not the one the person chose for Hand-off mode: { have, want }, or
 * null (unknown yet, the same, or an organisation's pin). Read wherever it can be seen (H.chatModelNow: a reported
 * switch, or the chat's own answers), never assumed from the setting.
 */
function handoffWrongModel(ctx, stamp) {
  if (!stamp?.chat_model || stamp.pin === "admin") return null;
  const have = H.chatModelNow(ctx.sid, ctx.input.transcript_path);
  return have && have !== stamp.chat_model ? { have, want: stamp.chat_model } : null;
}

function handoffPrompt(ctx, text) {
  const stamp = H.readStamp(ctx.sid);
  const chat = H.chatState(stamp, H.chatModelNow(ctx.sid, ctx.input.transcript_path));
  // A hand-off the person stopped since their last message: Claude never read its reply, so the person is told now,
  // before anything else.
  const stopped = H.takeStopped(ctx.sid);
  const stoppedSaid = stopped.length ? H.stoppedLine(stopped) : null;
  const sayAll = (note, line) => say(note, [stoppedSaid, line].filter(Boolean).join("\n") || null);
  // The person asked for this message's work to be done in the chat: nothing is handed off, and the safety net lets
  // Claude's own new files through for this turn.
  if (H.DO_IT_YOURSELF.test(text)) {
    H.writeTurn(ctx.sid, { kinds: [], own: true });
    appendEvent(ctx.sid, "handoff.own", {});
    return void sayAll("The person asked for this work to be done in the chat: do it yourself, with your own tools, and do not call the hand-off tools for it.", null);
  }
  const asked = handoffMessage(text);
  // What this turn asked to hand off: the safety net claims a new file only for one of these kinds. A short reply to
  // the hand-off keeps what the message before it asked.
  const before = H.readTurn(ctx.sid);
  const kinds = !asked.kinds.length && before && !before.own && before.kinds.length && H.replyToHandoff(text) ? before.kinds : asked.kinds;
  H.writeTurn(ctx.sid, { kinds });
  // The chat on another model than the person chose: hand-off work is not started (and the safety net still refuses
  // typing it by hand); any other message gets the warning once per model.
  const wrong = handoffWrongModel(ctx, stamp);
  if (wrong && asked.kinds.length) {
    appendEvent(ctx.sid, "handoff.wrong_model", { have: wrong.have, want: wrong.want, kinds: asked.kinds.join(",") });
    setSessionMarker(ctx, "handoff_model_warned", wrong.have);
    return void sayAll(H.wrongModelReason(wrong.have, wrong.want), H.wrongModelLine(wrong.have, wrong.want));
  }
  if (wrong && sessionMarkerText(ctx, "handoff_model_warned") !== wrong.have) {
    setSessionMarker(ctx, "handoff_model_warned", wrong.have);
    appendEvent(ctx.sid, "handoff.wrong_model", { have: wrong.have, want: wrong.want, warned: true });
    return void sayAll(H.wrongModelNote(wrong.have, wrong.want), H.wrongModelWarning(wrong.have, wrong.want));
  }
  // Nothing is said for a message that is not hand-off work (no notice after every "thanks", answer and question).
  if (!asked.kinds.length) {
    appendEvent(ctx.sid, "handoff.none", { reason: asked.reason });
    return void (stoppedSaid ? sayAll(null, null) : undefined);
  }
  const found = H.handoffRoutes(ctx.sid, stamp, process.env, { projectDir: ctx.projectDir });
  if (found.error) {
    appendEvent(ctx.sid, "handoff.unavailable", { kinds: asked.kinds.join(","), cause: found.error });
    // The person hears why once per chat and cause, not after every message; the model is told each time.
    const said = sessionMarkerText(ctx, "handoff_unavailable_said");
    if (said === found.error) return void sayAll(H.unavailableInstruction(found), null);
    setSessionMarker(ctx, "handoff_unavailable_said", found.error);
    return void sayAll(H.unavailableInstruction(found), H.HANDOFF_LINE.unavailable(found, chat));
  }
  // no_google: kinds done in the chat because their model needs Google and this computer has no Google login.
  const offline = asked.kinds.filter((k) => found.routes[{ spec: "docs", plan: "docs" }[k] ?? k]?.noGoogle).join(",") || undefined;
  appendEvent(ctx.sid, "handoff.recognised", { kinds: asked.kinds.join(","), rest: asked.rest || undefined, kept: asked.kinds.filter((k) => H.keptInChat(stamp, k)).join(",") || undefined, no_google: offline });
  sayAll(H.handoffInstruction(asked, found.routes), H.HANDOFF_LINE.handoff(asked, found.routes, chat));
}

/**
 * The chat is running a /mmo: workflow (from its start until its own log shows it ended). The record
 * holds the moment the workflow started, so its run can be told from any earlier run in the project
 * (lib/workflow-log.mjs). While it runs, zero-touch stands down, exactly as for a typed command.
 */
function markPipeline(ctx, via, { job = null, args = "", policy = null, needed = null, toolUseId = null } = {}) {
  // The project first, atomically (two chats starting at once must not both run): when another chat's workflow holds
  // it, nothing is marked and the caller says so. Returns { ok, owner? }.
  const got = acquire(ctx.projectDir, ctx.sid, job);
  if (!got.ok) { appendEvent(ctx.sid, "route.busy", { job: job ?? undefined, via, at: "start" }); return got; }
  // The record holds the moment, and which job: the replace-or-queue question names it in plain words.
  // `policy` is set only for a run zero-touch started: every model-server call of that run is stamped with that
  // policy's shipped file (the "pre-dispatch" moment). A command the person typed keeps its own rules.
  // `transcript`: the chat's own file, so another chat can tell this chat still exists (project-lock).
  // `tool_use_id`: the Skill call that started it. `needed`: the model the run's helpers must stay on, the policy's
  // planning model (a run zero-touch started; the chat's model is kept on it while the run lasts).
  const transcript = typeof ctx.input.transcript_path === "string" && ctx.input.transcript_path ? ctx.input.transcript_path : null;
  setSessionMarker(ctx, "pipeline", JSON.stringify({ since: new Date().toISOString(), job, args, ...(policy ? { policy } : {}), ...(policy && needed ? { needed } : {}), ...(transcript ? { transcript } : {}), ...(toolUseId ? { tool_use_id: toolUseId } : {}) }));
  ctx.pipeline = true;
  appendEvent(ctx.sid, "session.pipeline", { via, job: job ?? undefined });
  return got;
}
/** When this chat's workflow started: the record's moment, or its file time for a record without one. */
function pipelineSince(ctx) {
  const ms = pipelineSinceOf(ctx.sid);
  if (Number.isFinite(ms)) return ms;
  try { return statSync(sessionMarker(ctx, "pipeline")).mtimeMs; } catch { return NaN; }
}
/** The chat's running-workflow record: { since, job, args, policy?, needed? } (null for none, or a bare time). */
function pipelineRecord(ctx) {
  try { const r = JSON.parse(readFileSync(sessionMarker(ctx, "pipeline"), "utf8")); return r && typeof r === "object" ? r : null; } catch { return null; }
}
/** The run this chat's workflow claimed (claimRun), or null before its orchestrator has logged one. */
function pipelineRun(ctx) {
  return pipelineRunOf(ctx.sid);
}
/** Where this chat's workflow stands, read from its own run once claimed (lib/workflow-log.mjs). */
function ownWorkflowState(ctx) {
  return workflowState(ctx.projectDir, pipelineSince(ctx), pipelineRun(ctx));
}

/**
 * Claims the chat's run. A workflow's orchestrator logs every step with
 * `node …/mmo-log.mjs --event=… --run-id=<run-id>` and records its writes with `write-provenance.mjs --run-id=<run-id>`
 * (agents/orchestrator.md), through this chat's own tool calls, so the run id in such a call is this chat's run and no
 * other's. Until then the run is found by time, which can pick another chat's run started later in the same folder;
 * so stopping a run (/clear, "Replace it") needs a claimed one, and never guesses. A run id the model left as a shell
 * variable is not read. Nothing is emitted: the call runs as it is.
 *
 * A brownfield run's first line is Gate 0's contract freeze (`write-contract.mjs --freeze --run-id <run-id>`, the main
 * chat's call, before the orchestrator logs run.start), so the freeze claims the run too: a run that stops between
 * Gate 0 and run.start (its start check halts) is then ended by every zero-touch way out, and its freeze record never
 * holds the project for good. A freeze claims only a fresh run (no run.start, no freeze record yet) and only while the
 * chat has claimed none: a freeze can never move the chat's claim to another run. And once the chat's run has frozen a
 * contract, no call moves the claim (a log line under a new run id included): a workflow freezes one contract as a step.
 */
const RUN_LOGGER = /(?:^|[\s/"'])(?:mmo-log|write-provenance)\.mjs\b/;
const CONTRACT_FREEZE = /(?:^|[\s/"'])write-contract\.mjs\b[^\n]*\s--freeze\b/;
const RUN_ID_FLAG = /--run-id(?:=|\s+)(["']?)([^\s"'\\]+)\1(?=\s|\\|$)/;
function claimRun(ctx) {
  if (!ctx.pipeline || String(ctx.input.tool_name ?? "") !== "Bash") return;
  const command = String(ctx.input.tool_input?.command ?? "");
  const freeze = CONTRACT_FREEZE.test(command);
  if (!freeze && !RUN_LOGGER.test(command)) return;
  const id = RUN_ID_FLAG.exec(command)?.[2];
  const rec = pipelineRecord(ctx);
  if (!id || !RUN_ID.test(id) || !rec || rec.run_id === id) return;
  if (freeze && (rec.run_id || runStartMs(ctx.projectDir, id) !== null || runFreeze(ctx.projectDir, id).records > 0)) {
    appendEvent(ctx.sid, "session.run_not_claimed", { run_id: id, why: "a freeze claims only a fresh run, first" });
    return;
  }
  // A run that froze a contract keeps the claim for the rest of the workflow, whatever its own log says since (it can
  // log its own end): the claim decides which freeze is a step (contractStepAllowed), so a claim moved to a new run id
  // would make a second, wider freeze a step. One workflow freezes one contract without a prompt.
  if (rec.run_id && runFreeze(ctx.projectDir, rec.run_id).records > 0) {
    appendEvent(ctx.sid, "session.run_not_claimed", { run_id: id, why: "the chat's run froze a contract: its claim never moves" });
    return;
  }
  // Only a run of this workflow: a run that started before this workflow did is an earlier workflow's, still logging
  // its last steps (its final report and gate, often from a helper in the background), and is never claimed. The
  // workflow's own run.start call claims a new run, and a reused id with it.
  const startedMs = runStartMs(ctx.projectDir, id);
  const sinceMs = Date.parse(rec.since ?? "");
  if (!/--event=run\.start\b/.test(command) && startedMs !== null && Number.isFinite(sinceMs) && startedMs < sinceMs) {
    appendEvent(ctx.sid, "session.run_not_claimed", { run_id: id, why: "an earlier workflow's run" });
    return;
  }
  setSessionMarker(ctx, "pipeline", JSON.stringify({ ...rec, run_id: id }));
  appendEvent(ctx.sid, "session.run_claimed", { run_id: id, by: ctx.agent ? "helper" : "chat" });
}

/**
 * A workflow that stopped before its run began says so by running ambient/workflow-stopped.mjs: the call is seen
 * here and the chat's record is marked, so the turn's end hands the chat back and frees the project
 * (endPipelineIfOver). Nothing else on disk tells "stopped" from "still asking".
 */
const EARLY_STOP = /(?:^|[\s/"'])workflow-stopped\.mjs\b/;
function noteEarlyStop(ctx) {
  if (!ctx.pipeline || String(ctx.input.tool_name ?? "") !== "Bash") return;
  if (!EARLY_STOP.test(String(ctx.input.tool_input?.command ?? ""))) return;
  const rec = pipelineRecord(ctx);
  if (!rec || rec.stopped) return;
  setSessionMarker(ctx, "pipeline", JSON.stringify({ ...rec, stopped: true }));
  appendEvent(ctx.sid, "session.pipeline_stopped_early", { job: rec.job ?? undefined, by: ctx.agent ? "helper" : "chat" });
}

/**
 * The cost recording this chat's zero-touch starts carry (lib/claude-login.mjs): the configured one,
 * except that a person whose only Claude login is an API key gets "vendor", so a Claude typist is handed the key
 * instead of running with no login.
 */
function auth(ctx) {
  return chatAuth(ctx.sid, ctx.config.routing_defaults.auth);
}

/** The model the chat is on now, or null when Claude Code has not said yet (lib/handoff.mjs chatModelNow). */
function chatModel(ctx) {
  return H.chatModelNow(ctx.sid, ctx.input.transcript_path);
}

/**
 * Whether a job zero-touch recognised can start in this chat now (lib/route-flow.mjs startProblem), judged with the
 * chat's own model: { problem, needed, helper }.
 */
function canStart(ctx, policy, job) {
  return startProblem({ projectDir: ctx.projectDir, policy, auth: auth(ctx), job, chatModel: chatModel(ctx) });
}

/**
 * The run-start check of a run zero-touch started gets the person's policy file too.
 * The orchestrator runs it as a shell command and is told to pass the run's policy file; the model server's calls are
 * stamped by the "pre-dispatch" moment whatever the model wrote, but a shell command is not. So, as a backstop, the
 * check's command gets `--policy-path "<the policy's shipped file>"`, and only when it is one plain call of the check
 * that names no file yet (lib/run-check.mjs says exactly when; anything else is left untouched). Returns true when it
 * emitted. A run the person typed is left alone.
 */
function stampRunCheck(ctx) {
  if (!ctx.pipeline || String(ctx.input.tool_name ?? "") !== "Bash") return false;
  const rec = pipelineRecord(ctx);
  const input = ctx.input.tool_input && typeof ctx.input.tool_input === "object" && !Array.isArray(ctx.input.tool_input) ? ctx.input.tool_input : null;
  if (!rec?.policy || typeof input?.command !== "string") return false;
  // The helpers follow the chat's model when the person has no helper setting (mmo's agents name none): the check
  // is told which model that is, and judges it itself (lib/run-check.mjs). With a setting, the check reads the setting.
  const helper = helperModel({ chatModel: chatModel(ctx) });
  const stamped = stampedRunCheck(input.command, policyPath(rec.policy), { helperModel: helper?.via === "chat" ? helper.model : null });
  if (!stamped) return false;
  appendEvent(ctx.sid, "route.policy_stamped", { tool: "Bash", check: "driver-model-check", policy: rec.policy, helper_model: helper?.model ?? undefined, helper_via: helper?.via ?? undefined, by: ctx.agent ? "helper" : "chat" });
  // The stamped check is one of the workflow's own steps (lib/own-steps.mjs): allowed without a prompt too.
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, command: stamped }, ...(ownScriptCall(stamped, SCRIPTS_DIR) ? { permissionDecision: "allow", permissionDecisionReason: OWN_STEP } : {}) } });
  return true;
}

/** This plugin's scripts folder: the only place a step allowed without a prompt may run from. */
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_STEP = "Zero-touch: a step of the workflow you asked for.";

/**
 * While a workflow runs in this chat, its own steps run without a permission prompt (lib/own-steps.mjs says which,
 * and why). Returns true when it answered.
 */
function allowOwnStep(ctx) {
  if (!ctx.pipeline) return false;
  const tool = String(ctx.input.tool_name ?? "");
  // The server tools a zero-touch run stamps with the person's models (lib/own-steps.mjs STAMPED_TOOLS): those the
  // released zero-touch matcher sends to the stamp's own hook (PRE_DISPATCH_TOOLS) are answered there, so one call
  // never gets two answers; any other (execute_batch) never reaches that hook, so it is stamped and answered here.
  if (STAMPED_TOOLS.test(tool) && pipelineRecord(ctx)?.policy) {
    if (PRE_DISPATCH_TOOLS.test(tool)) return false;
    handlers["pre-dispatch"](ctx);
    return true;
  }
  const command = ctx.input.tool_input?.command;
  // The write contract's own script: a step only as the guide runs it in the main chat (contractStepAllowed).
  if (tool === "Bash" && contractStepAllowed(ctx, command)) {
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: OWN_STEP } });
    return true;
  }
  // A brownfield run's agents wrap and chain their step calls (lib/own-steps.mjs brownfieldRunAgent).
  const joined = brownfieldRunAgent(ctx.input.agent_type);
  if (!(ownServerTool(tool) || (tool === "Bash" && ownScriptCall(command, SCRIPTS_DIR, { joined })))) return false;
  // A server call that would run a command the person's settings forbid, or whose commands cannot be read, is left to
  // Claude Code's own permission prompt, as in a chat without zero-touch.
  if (ownServerTool(tool) && serverCommandProblem(ctx)) return false;
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: OWN_STEP } });
  return true;
}

/**
 * Whether a shell command is the write contract's own script run as a step of the workflow (lib/own-steps.mjs
 * contractStepCall reads it): Gate 0's freeze or the close-out, by the main chat (never a helper: the guide runs both
 * in the main chat), in the chat's own project folder (never another folder: a freeze there would hold that folder's
 * writes in every chat), and a freeze only before the chat's run has started, for the run it claims (or before it has
 * claimed one). So a live run cannot swap its frozen contract for a wider one without the person seeing the call:
 * a freeze mid-run, or under a second run id, keeps Claude Code's prompt, also after the run has logged its own end,
 * since the run that froze keeps the chat's claim (claimRun). --abandon never comes here: the person decides.
 */
function contractStepAllowed(ctx, command) {
  if (ctx.agent) return false;
  const call = contractStepCall(command, SCRIPTS_DIR);
  if (!call) return false;
  const cwd = resolve(ctx.cwd);
  const root = call.projectRoot === null ? cwd : resolve(cwd, call.projectRoot.replaceAll("$(pwd)", cwd));
  if (realOr(root) !== realOr(ctx.projectDir)) return false;
  if (call.mode === "close") return true;
  const claimed = pipelineRun(ctx);
  if (claimed && claimed !== call.runId) return false;
  return runStartMs(ctx.projectDir, call.runId) === null;
}
const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * What keeps a model-server call from running without Claude Code's prompt: a command it would make the server run that
 * the person's Claude settings forbid (`{ command, rule }`), or a packets file it names that cannot be read while the
 * settings forbid any command (`{ unreadable }`), or a command whose shell syntax the check cannot see through
 * (`{ unchecked }`). Null when there is nothing to check or nothing is forbidden.
 */
function serverCommandProblem(ctx) {
  if (!bashDenyRules(ctx.projectDir).length) return null;
  const found = serverCommands(ctx.input.tool_name, ctx.input.tool_input, ctx.projectDir);
  if (found.unreadable) return { unreadable: found.unreadable };
  for (const command of found.commands) {
    const rule = deniedBy(command.run, ctx.projectDir);
    if (rule) return { command: command.run, rule };
    // Shell syntax the deny check cannot see through, in the template or in the file path the server pastes into it
    // (lib/own-steps.mjs serverCommandUnchecked): the command cannot be checked, so it is left to Claude Code's prompt.
    if (serverCommandUnchecked(command)) return { unchecked: command.run };
  }
  return null;
}

/**
 * Whether the chat's conversation was rewound to before its workflow's start: the start's Skill call is no
 * longer on the conversation's chain (lib/transcript.mjs onActiveChain). Only a start this chat recorded with its call
 * id can be told; anything unknown is not a rewind.
 */
function rewoundPastStart(ctx) {
  const rec = pipelineRecord(ctx);
  const since = Date.parse(rec?.since ?? "");
  return onActiveChain(ctx.input.transcript_path, rec?.tool_use_id, since) === false;
}

/** The job the running workflow was started for (null for a record without one). */
function runningJob(ctx) {
  return pipelineRecord(ctx)?.job ?? null;
}
/** The chat's workflow is over (ended, replaced or cleared): the chat is ordinary again and the project is free. */
function endPipeline(ctx) {
  dropSessionMarker(ctx, "pipeline");
  dropRoute(ctx.sid);
  release(ctx.projectDir, ctx.sid);
  ctx.pipeline = false;
}
/**
 * Hands the chat back once its workflow has ended (its log shows the last gate answered, an abort, or a failed
 * end): from the next message on, a job starts its own workflow again and every other message is an ordinary one,
 * as if the person had typed the command and then carried on. A workflow with no logged run yet keeps the chat
 * (lib/workflow-log.mjs says why).
 */
function endPipelineIfOver(ctx) {
  if (!ctx.pipeline) return null;
  const job = runningJob(ctx) ?? "workflow";
  // The workflow reported that it stopped before its run began (ambient/workflow-stopped.mjs, seen at the "pre-any"
  // moment).
  if (pipelineRecord(ctx)?.stopped) {
    // A run that stopped after Gate 0 froze its contract (the freeze claimed it, claimRun) is ended in its own log, as
    // zero-touch's other stops end a claimed run (stopWorkflow): otherwise its live freeze record would hold the project
    // for good. A run that has already ended by its own log is left as it ended.
    const runId = pipelineRun(ctx);
    if (runId && !runEnded(ctx.projectDir, runId)) {
      const done = abortRun(ctx.projectDir, runId, "stopped");
      appendEvent(ctx.sid, "route.stopped", { run_id: runId, why: "stopped-early", logged: done.logged, unlocked: done.unlocked });
    }
    endPipeline(ctx);
    appendEvent(ctx.sid, "session.pipeline_ended", { outcome: "stopped" });
    dropQueueAfter(ctx, job, "stopped");
    return { job, outcome: "stopped" };
  }
  const w = ownWorkflowState(ctx);
  if (w.state !== "ended") return null;
  const rec = pipelineRecord(ctx);
  endPipeline(ctx);
  appendEvent(ctx.sid, "session.pipeline_ended", { run_id: w.runId, outcome: w.outcome });
  const outcome = w.outcome ?? "completed";
  if (outcome !== "completed") dropQueueAfter(ctx, job, outcome);
  return { job, outcome, saved: outcome === "completed" && job === "greenfield" && rec?.policy ? saveNewApp(ctx) : null };
}

/**
 * A queued job starts by itself only after the running workflow finished. Any other end ("abort" at one of its
 * approval steps, a failed run, or a run that stopped before it began) drops the queue, as zero-touch's own stop does
 * (stopWorkflow). What was dropped is kept as a marker until a moment that can show a line says it, once: turn-end, or
 * the person's next message (turn-failed's output is never shown).
 */
function dropQueueAfter(ctx, job, outcome) {
  const queued = Q.readQueue(ctx.sid);
  if (!queued.length) return;
  Q.dropQueue(ctx.sid);
  const jobs = queued.map((q) => q.job);
  setSessionMarker(ctx, QUEUE_DROPPED, JSON.stringify({ job, outcome, jobs }));
  appendEvent(ctx.sid, "route.queue_dropped", { after: outcome, jobs });
}
const QUEUE_DROPPED = "zt_queue_dropped";
/** The queue dropped by dropQueueAfter, read once: { job, outcome, jobs }, or null. */
function takeQueueDropped(ctx) {
  const raw = sessionMarkerText(ctx, QUEUE_DROPPED);
  if (raw === null) return null;
  dropSessionMarker(ctx, QUEUE_DROPPED);
  try { const d = JSON.parse(raw); return Array.isArray(d?.jobs) && d.jobs.length ? d : null; } catch { return null; }
}
/** The person's line for a dropped queue: the workflow's end, unless already said, then what did not start. */
function queueDroppedLine(ctx, dropped, { withEnd = true } = {}) {
  return [withEnd ? L.ended(dropped.job, ctx.config.mode, dropped.outcome) : null, L.queueNotStarted(dropped.jobs)].filter(Boolean).join(" ");
}

/**
 * A new app a workflow zero-touch started has been built: it is saved with git, so the person's next request ("fix
 * this bug in the app") can run its workflow there, which needs git to undo what it changes. Done here, in code, and
 * only for a run zero-touch started: mmo's own command text is left unchanged, and a typed run is left as mmo runs it.
 * Returns the line added to the person's end line, or null ("already saved": nothing new to say).
 */
function saveNewApp(ctx) {
  let r;
  try { r = baseline(ctx.projectDir); } catch (err) { r = { code: 1, detail: String(err?.message ?? err) }; }
  const said = r.code === 0 ? (r.line === SAID_ALREADY ? null : "saved") : r.code === 3 ? "noGit" : "failed";
  appendEvent(ctx.sid, "route.new_app_saved", { result: said ?? "already", detail: r.detail ? String(r.detail).slice(0, 300) : undefined });
  return said ? SAVED_WITH_GIT[said] : null;
}

/** Stops this chat's workflow the way its own abort does (abortRun on its run), frees the project, drops its queue. */
function stopWorkflow(ctx, why) {
  let runId = pipelineRun(ctx);
  if (!runId) {
    const found = ownWorkflowState(ctx).runId ?? null;
    runId = found && !runClaimedByOther(found, ctx.sid) ? found : null;
  }
  const done = abortRun(ctx.projectDir, runId, why);
  const job = runningJob(ctx) ?? "workflow";
  const droppedQueued = Q.readQueue(ctx.sid).length > 0;
  endPipeline(ctx);
  Q.dropChoice(ctx.sid);
  Q.dropQueue(ctx.sid);
  Q.dropHold(ctx.sid);
  appendEvent(ctx.sid, "route.stopped", { run_id: runId ?? undefined, why, logged: done.logged, unlocked: done.unlocked });
  return { job, droppedQueued };
}

/**
 * What the running workflow waits for, when it has asked the person something: "gate" (one of its gates is open),
 * "first" (it has not logged its run yet: it is still asking its first questions), or null. While it waits, the
 * person's next message is its answer, never a new job.
 */
function waitingFor(ctx, cutOff = null) {
  const w = ownWorkflowState(ctx);
  // "First questions" only when the workflow can have asked one: Claude's turn ended (a workflow's turn ends only to
  // wait for the person), or was cut off at a question box. A turn cut off in the middle of another step (the app's
  // Send on a waiting message, Esc, an error) asked nothing, so the message is not its answer.
  if (w.state === "not-started") return cutOff && cutOff !== "AskUserQuestion" ? null : "first";
  return w.state === "running" && w.waiting === true ? "gate" : null;
}

/**
 * The step the turn before this message was cut off in, or null when that turn ended normally (the app's Send on a
 * message waiting while the workflow works stops Claude mid-step, and that message is not the workflow's answer).
 * Zero-touch's own fact, not a guess from the transcript:
 * pre-any keeps the name of each tool the chat starts while its workflow runs, and the end of a turn (turn-end,
 * turn-failed) drops it, so one still kept at the next message means the turn never reached its end. Read once.
 */
const STEP_MARK = "zt_step";
function cutOffStep(ctx) {
  const step = sessionMarkerText(ctx, STEP_MARK);
  if (step === null) return null;
  dropSessionMarker(ctx, STEP_MARK);
  return step || null;
}

/**
 * Why a second job asked for in plain words could not start even once the running workflow is out of the way (Google
 * missing for the person's models, the pre-built server missing, the start-up check failing), or null. The project
 * lock is this chat's own, so "busy" never applies here. A command the person typed runs its own checks.
 */
function newJobProblem(ctx, job) {
  const { problem } = canStart(ctx, chatPolicy(ctx.sid), job);
  return problem && problem.cause !== "busy" ? problem : null;
}

/** Holds a new job and returns what the model is told: ask the person Queue it or Replace it (lib/queue.mjs). */
function ask(ctx, { job, args, via }) {
  const running = runningJob(ctx) ?? "workflow";
  const choice = { job, args: args ?? "", via, running, question: Q.questionFor(running, job), prompt_id: ctx.input.prompt_id ?? null };
  Q.writeChoice(ctx.sid, choice);
  appendEvent(ctx.sid, "route.ask", { job, via, running });
  return Q.askInstruction(choice);
}

/**
 * The person's answer to the question: "queue", "replace" or "other". Returns what the model is told next.
 *   queue    the job joins the chat's queue (a duplicate is not added). After a typed command, whose text the
 *            model holds, nothing that changes anything runs until the turn ends (the hold).
 *   replace  the running workflow is stopped the way its own abort stops it (abortRun: its log records the abort,
 *            its write lock is switched off), then the new one starts: a typed command carries on as the chat's
 *            workflow; any other is routed like a recognised job.
 */
function settle(ctx, choice, kind) {
  Q.dropChoice(ctx.sid);
  const running = plainName(choice.running);
  if (kind === "queue") {
    const res = Q.enqueue(ctx.sid, choice);
    if (choice.via === "typed") Q.setHold(ctx.sid);
    appendEvent(ctx.sid, "route.queued", { job: choice.job, via: choice.via, duplicate: res === "duplicate" || undefined });
    const head = res === "duplicate"
      ? `The ${plainName(choice.job)} is already queued; it is not added twice.`
      : `Queued: the ${plainName(choice.job)} starts by itself when the running ${running} ends.`;
    const tail = choice.via === "typed"
      ? "The person has been shown a line saying so. Do not run the command they typed now: stop here; the running workflow carries on when they answer it."
      : "The person has been shown a line saying so; carry on with the running workflow.";
    return { text: `${head} ${tail} ${KEEP_OUT}`, line: res === "duplicate" ? L.queuedTwice(choice.job) : L.queued(choice.job, choice.running) };
  }
  if (kind === "replace") {
    // The run this chat claimed (claimRun). Without a claim (a run id the model left as a shell variable), the run found
    // by time, unless another chat has claimed that one: the person asked to stop their workflow, so its log and its
    // write lock must not stay open, and another chat's is never touched.
    // /clear (session-end) stops a claimed run only: nobody asked it to stop anything.
    let runId = pipelineRun(ctx);
    if (!runId) {
      const found = ownWorkflowState(ctx).runId ?? null;
      runId = found && !runClaimedByOther(found, ctx.sid) ? found : null;
    }
    const done = abortRun(ctx.projectDir, runId, "replaced");
    endPipeline(ctx);
    appendEvent(ctx.sid, "route.replaced", { job: choice.job, via: choice.via, run_id: runId ?? undefined, logged: done.logged, unlocked: done.unlocked });
    const line = L.replaced(choice.job, choice.running);
    if (choice.via === "typed") {
      const got = markPipeline(ctx, "replace", { job: choice.job, args: choice.args });
      if (!got.ok) {
        // Another chat took the folder in the moment between the stop and this start.
        const problem = { cause: "busy", job: got.owner?.job ?? null };
        return { text: cannotStartInstruction(choice.job, problem), line: L.notStarted(problem, choice.job) };
      }
      return { text: `Replaced: the running ${running} is stopped. Carry on with the command the person typed. ${KEEP_OUT}`, line };
    }
    writeRoute(ctx.sid, { job: choice.job, args: choice.args, via: "replace", status: "pending", prompt_id: ctx.input.prompt_id ?? null });
    appendEvent(ctx.sid, "route.decided", { job: choice.job, via: "replace" });
    return { text: `Replaced: the running ${running} is stopped. ${startInstruction({ job: choice.job, args: choice.args, auth: auth(ctx), policy: chatPolicy(ctx.sid) })}`, line };
  }
  appendEvent(ctx.sid, "route.choice_neither", { job: choice.job, via: choice.via });
  return { text: `The person chose neither: start nothing new, and carry on. ${KEEP_OUT}`, line: L.neither(choice.running) };
}

/** What the model reads while "Queue it" holds a typed command's own steps until the turn ends. */
const HOLD_REASON = `The command the person typed is queued: it starts by itself when the running workflow ends. Do not run its steps now; stop here. ${KEEP_OUT}`;

/**
 * A plugin command typed by the person, decided by the prompt hook alone: it fires for every typed command and sees
 * the typed line, and it is the one hook that can keep the line from the
 * model. The expansion hook (UserPromptExpansion) is deliberately not registered, so it never marks the chat.
 *   - a one-off tool (setup, policy, revert): nothing; it is recorded only so its own Skill call passes Guard B;
 *   - a workflow command while another chat in this project runs one: kept from the model (the prompt hook blocks
 *     it and Claude Code shows the person why);
 *   - a workflow command while this chat runs one: the replace-or-queue question (a typed command is never a gate's
 *     answer);
 *   - otherwise the chat becomes that workflow's run.
 */
function typedMoment(ctx, cmd) {
  const pid = ctx.input.prompt_id ?? null;
  const seen = Q.readTyped(ctx.sid);
  if (seen && pid && seen.prompt_id === pid) return seen.decision ?? {};
  // A start zero-touch still has pending (plain words the person then stopped with Esc) ends here, as any new
  // message ends it: otherwise a typed command for the same job would take that start over, with zero-touch's policy
  // stamped on a run the person typed, and a typed command for another job would be refused.
  if (cmd.workflow && !ctx.pipeline) {
    const stale = readRoute(ctx.sid);
    if (stale?.status === "pending") { dropRoute(ctx.sid); appendEvent(ctx.sid, "route.dropped", { job: stale.job, by: "typed" }); }
  }
  let decision = {};
  if (cmd.workflow && acts(ctx) && !ctx.agent) {
    const lock = heldByOther(ctx.projectDir, ctx.sid);
    if (lock) {
      decision = { block: typedBusyReason(lock) };
      appendEvent(ctx.sid, "route.busy", { job: cmd.name, via: "typed" });
    } else if (ctx.pipeline) {
      decision = { context: ask(ctx, { job: cmd.name, args: cmd.args, via: "typed" }) };
    } else {
      // Taken atomically: another chat may have started one in this folder a moment ago.
      const got = markPipeline(ctx, "typed", { job: cmd.name, args: cmd.args });
      if (!got.ok) decision = { block: typedBusyReason(got.owner) };
    }
  } else if (cmd.workflow && !ctx.pipeline) {
    markPipeline(ctx, "typed", { job: cmd.name, args: cmd.args });
  }
  Q.writeTyped(ctx.sid, { name: cmd.name, prompt_id: pid, decision });
  return decision;
}

/** The chat becomes a workflow run: zero-touch stands down until the run ends, as for a typed command. */
function markStarted(ctx, route, toolUseId = null) {
  // A command the person typed and queued (route.typed) is their own run: its own rules, no zero-touch policy.
  const got = markPipeline(ctx, "route", { job: route.job, args: route.args ?? "", policy: route.typed ? null : chatPolicy(ctx.sid), needed: route.typed ? null : route.needed ?? null, toolUseId });
  if (!got.ok) { dropRoute(ctx.sid); return got; }
  writeRoute(ctx.sid, { ...route, status: "started" });
  appendEvent(ctx.sid, "route.started", { job: route.job, via: route.via });
  return got;
}

/**
 * Starts a workflow. Every route is made by the prompt hook and was already checked there (only the rules route),
 * so the chat is marked first and only then is the policy saved: the start hook stays cheap, and a
 * slow save can never leave a started workflow blocked by Guard A. A failed save is recorded, not fatal: the
 * workflow's own policy step then says so.
 */
function startWorkflow(ctx, route, toolUseId = null) {
  const got = markStarted(ctx, route, toolUseId);
  if (!got.ok) return got;
  if (route.via === "queue") Q.removeStarted(ctx.sid, route);
  // Nothing is written into the project: the run's models travel in its start arguments and on every
  // model-server call (the "pre-dispatch" moment), never through .sdlc/project.json.
  if (!route.typed) appendEvent(ctx.sid, "route.policy", { policy: chatPolicy(ctx.sid) });
  return got;
}

/**
 * Tools that change nothing: they may run while a routed workflow waits for
 * its start. Everything else, every other MCP server's tools included, waits.
 */
const CHANGES_NOTHING = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch", "TodoWrite", "TodoRead", "TaskList", "TaskGet", "WebFetch", "WebSearch", "Skill", "AskUserQuestion", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

/**
 * Guard A (the catch-all pre-any hook): while a routed workflow waits for its
 * start, nothing that can change files or start work runs, helpers already
 * running included. The Skill call itself is Guard B's.
 */
function blockUntilStarted(ctx) {
  if (CHANGES_NOTHING.has(String(ctx.input.tool_name ?? ""))) return false;
  // While the replace-or-queue question waits for its answer, and while "Queue it" holds a typed command's steps,
  // nothing that changes anything runs, the running workflow included.
  const choice = Q.readChoice(ctx.sid);
  if (choice) return void deny(ctx, "route.tool_blocked", REFUSAL.waitAnswer, Q.askInstruction(choice)) ?? true;
  if (Q.hasHold(ctx.sid)) return void deny(ctx, "route.tool_held", REFUSAL.hold, HOLD_REASON) ?? true;
  if (ctx.pipeline) return false;
  heldFirstMessage(ctx);
  const route = readRoute(ctx.sid);
  // A job zero-touch said cannot start: for the rest of this turn nothing that changes files runs either, so Claude
  // cannot do the job by hand instead, whatever it makes of the note (holdRefused).
  if (route?.status === "refused") {
    deny(ctx, "route.tool_blocked_refused", L.notStarted(route.problem, route.job), cannotStartInstruction(route.job, route.problem));
    return true;
  }
  if (route?.status !== "pending") return false;
  deny(ctx, "route.tool_blocked", REFUSAL.startFirst(route.job), startFirstReason(route.job));
  return true;
}

/**
 * The chat's model, confirmed once its workflow has started. A new chat's first message comes before the chat has
 * answered, and Claude Code passes no model to these hooks, so the start may have been checked with the model
 * unknown (and at the Skill call the app may not have saved Claude's reply yet). By the workflow's first step that
 * changes or spends anything, Claude's earlier reply, which names the model, is in the transcript. On another model
 * than the policy plans with, the workflow is stopped there, before any of its work, and the rest of the turn is
 * held like any start that cannot happen (holdRefused); the person reads the usual line. Checked once per workflow
 * of zero-touch's own (a typed run is mmo's), and only while the model is known; a helper setting decides instead
 * when there is one.
 */
function wrongModelAfterStart(ctx) {
  if (!ctx.pipeline || CHANGES_NOTHING.has(String(ctx.input.tool_name ?? ""))) return false;
  const rec = pipelineRecord(ctx);
  if (!rec?.policy || !rec.needed || rec.model_ok) return false;
  const helper = helperModel({ chatModel: chatModel(ctx) });
  if (!helper) return false;
  if (helper.model === rec.needed) {
    setSessionMarker(ctx, "pipeline", JSON.stringify({ ...rec, model_ok: true }));
    return false;
  }
  const job = rec.job ?? "workflow";
  const problem = { cause: "chat-model", have: helper.model, needed: rec.needed, via: helper.via, policy: rec.policy };
  stopWorkflow(ctx, "chat-model");
  holdRefused(ctx, job, problem);
  appendEvent(ctx.sid, "route.cannot_start", { job, cause: problem.cause, at: "first-step", have: helper.model });
  deny(ctx, "route.tool_blocked_refused", L.notStarted(problem, job), cannotStartInstruction(job, problem));
  return true;
}

/**
 * A job that cannot start (another chat's workflow in the folder, the chat's model, Google, git...). The person reads
 * why and what to do; for the rest of this turn nothing that changes files runs (blockUntilStarted), and a workflow
 * call is refused with the same reason (pre-skill). Cleared when the turn ends and at the next message.
 */
function holdRefused(ctx, job, problem, extra = {}) {
  writeRoute(ctx.sid, { job, status: "refused", problem, prompt_id: ctx.input.prompt_id ?? null, ...extra });
}

/**
 * The first chat's first message, kept by the settings box with `waits` when the chat must switch model first
 * (zero-touch/scripts/settings-hook.mjs): a job the rules recognise in it cannot start in this turn, so it is held
 * like any refused start. Read once; never judged at the turn's end (takeReplay).
 */
function heldFirstMessage(ctx) {
  const file = join(sessionDir(ctx.sid), REPLAY_FILE);
  let rec;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!rec?.waits || typeof rec.prompt !== "string") return;
  try { rmSync(file, { force: true }); } catch { /* read once all the same */ }
  const r = routeMessage(rec.prompt, folderKind(ctx.projectDir));
  if (!r.job) return;
  const { problem } = canStart(ctx, chatPolicy(ctx.sid), r.job);
  if (!problem) return;
  appendEvent(ctx.sid, "route.cannot_start", { job: r.job, cause: problem.cause, at: "first-message" });
  holdRefused(ctx, r.job, problem, { replay: true });
}

/**
 * Hand-off mode's safety net: a NEW document or test file of the project is not typed by hand, with the Write tool
 * or through the shell; it goes to the hand-off tool, which has it written and checked (lib/handoff-net.mjs says
 * which files). Whoever in the chat makes the call, a helper included: the work is the chat's. It stands down
 * when handing off is not possible or not wanted: the file exists (a change to it is the chat model's own edit), a
 * failed hand-off handed it back, the chat is running a workflow (which has its own rules for what is written),
 * or the hand-off cannot run here (then the model is told so by the prompt hook and does the work itself).
 */
/**
 * Before the chat's first edit of a project file in a hand-off chat, its earlier text is kept: a repeated change then
 * copies exactly the chat's own edit (the server compares the file with this text), never the person's uncommitted
 * work in it. Kept once per file until a repeated change uses it.
 */
function keepBeforeEdit(ctx) {
  const tool = String(ctx.input.tool_name ?? "");
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool) || ctx.pipeline) return;
  const raw = ctx.input.tool_input?.file_path ?? ctx.input.tool_input?.notebook_path;
  if (typeof raw !== "string" || !raw) return;
  const abs = resolve(ctx.cwd, raw);
  const rel = relative(resolve(ctx.projectDir), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) return;
  if (H.keepBefore(ctx.sid, abs, rel.split(sep).join("/"))) appendEvent(ctx.sid, "handoff.kept_before", { path: rel.split(sep).join("/") });
}

/** The tools that can create a file: Write, and an edit of a file that does not exist yet. */
const CREATES = new Set(["Write", "Bash", "Edit", "MultiEdit", "NotebookEdit"]);

function typedByHandNet(ctx) {
  const tool = String(ctx.input.tool_name ?? "");
  if (!CREATES.has(tool) || ctx.pipeline) return;
  const paths = createdByHand(tool, ctx.input.tool_input, { cwd: ctx.cwd, projectDir: ctx.projectDir });
  if (!paths.length) return;
  // This turn's message: the person asked for the work in the chat, or it was not a kind of work to hand off (a note,
  // a blog post, a fixture): Claude's own new files pass.
  const turn = H.readTurn(ctx.sid);
  if (turn?.own) return;
  const kindAsked = (k) => !turn || (k === "document" ? turn.kinds.some((x) => ["docs", "spec", "plan"].includes(x)) : turn.kinds.includes("tests"));
  // Another chat's workflow holds this project: no hand-off lands then, so Claude writes itself (and that workflow's
  // write contract still applies to Claude's own writes).
  if (heldByOther(ctx.projectDir, ctx.sid)) return;
  const released = new Set(H.releasedPaths(ctx.sid));
  const stamp = H.readStamp(ctx.sid);
  // A kind of work the person keeps in the chat is the chat model's own: its new files are never refused.
  // A file the net refused before stays claimed across messages (H.claimPath), unless its kind is now kept.
  const claimed = new Set(H.claimedPaths(ctx.sid));
  const handed = (p) => { const k = fileKind(p); return k && (kindAsked(k) || claimed.has(p)) && !H.keptInChat(stamp, k === "document" ? "docs" : "tests"); };
  const path = paths.find((p) => handed(p) && !existsSync(join(ctx.projectDir, p)) && !released.has(p));
  if (!path) return;
  const found = H.handoffRoutes(ctx.sid, stamp, process.env, { projectDir: ctx.projectDir });
  if (found.error) return;
  const kind = fileKind(path);
  // A kind that cannot be handed off because Google is not connected, or because there is no git for the test
  // copy, is the chat model's own, like a kept kind: its tool is refused (pre-handoff), so typing the file by hand
  // must pass, or the work could not be done at all.
  const route = found.routes[kind === "document" ? "docs" : "tests"];
  if (route?.noGoogle || route?.noGit) return;
  const typist = found.routes[kind === "document" ? "docs" : "tests"]?.model ?? null;
  // Every time (a second try that passed silently would let the person believe the hand-off model wrote what Claude
  // wrote). The ways out are all deterministic: the hand-off itself, a hand-off
  // that handed the file back (released), no Google or git for it (above), the person's own "write it yourself"
  // (turn.own), or a kind they keep in the chat.
  const chat = H.chatState(stamp, H.chatModelNow(ctx.sid, ctx.input.transcript_path));
  H.claimPath(ctx.sid, path);
  appendEvent(ctx.sid, "handoff.by_hand_refused", { tool, kind, path });
  // The approved line is the refusal's reason, which Claude Code shows the person; the instruction is the model's.
  emit(refusalOutput(H.byHandLine(path, kind, chat, typist), H.byHandReason(path, kind)));
}

/**
 * Refuses the tool call this PreToolUse hook is about, and logs it. Claude Code shows the reason to the person (in red
 * in the desktop app) as well as to the model, so the reason is one plain sentence for the person and the model's
 * exact instructions travel separately, as the refusal's additionalContext.
 */
function deny(ctx, event, person, model) {
  appendEvent(ctx.sid, event, { tool: String(ctx.input.tool_name ?? "") });
  emit(refusalOutput(person, model));
}
/** The PreToolUse output of a refusal: the person's sentence as the reason, the model's instructions as context. */
function refusalOutput(person, model) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: person, ...(model ? { additionalContext: model } : {}) } };
}

/**
 * The chat's start work: its log line and the old-records sweep; after /clear, forgetting the run and the route of
 * the conversation that ended. Runs at the chat's start moment (SessionStart), or LATE, at the first moment of a
 * chat whose start it missed: the zero-touch plugin writes the chat's record in its own start hook,
 * and Claude Code runs the two plugins' start hooks at once, so this plugin's start hook can run before the record
 * exists and do nothing.
 */
function startChat(ctx, { late = false } = {}) {
  appendEvent(ctx.sid, "session.start", {
    mode: ctx.config.mode, routing: ctx.config.routing, config_sources: ctx.sources.join(","),
    source: late ? undefined : ctx.input.source, late: late || undefined, model: canonicalModel(ctx.input.model) || undefined,
    transcript_path: ctx.input.transcript_path,
  });
  sweepOldSessions(ctx);
  setSessionMarker(ctx, "started");
  if (late) return;
  if (ctx.input.source === "clear") {
    // A fresh conversation: nothing earlier counts. A workflow run and a pending route belong to the conversation
    // /clear ended.
    endPipeline(ctx);
    // The question, the queue and the hold end with the conversation too.
    Q.dropChoice(ctx.sid);
    Q.dropQueue(ctx.sid);
    Q.dropHold(ctx.sid);
    Q.dropTyped(ctx.sid);
  }
}

// ---------- handlers ----------

const handlers = {
  "session-start"(ctx) {
    startChat(ctx);
  },

  prompt(ctx) {
    const text = typeof ctx.input.prompt === "string" ? ctx.input.prompt : "";
    // Claude Code delivers some things through the prompt hook that nobody
    // typed: a background command's completion notice, queued as a message.
    // Such a message is a tagged block; it is never judged as a request.
    // Only the app's own notice tags mark a machine notice; a person pasting HTML is still a person.
    const typed = !NOTICE_TAG.test(text);
    // A workflow that has ended gives the chat back before this message is judged (a new typed command then starts
    // a new run of its own).
    endPipelineIfOver(ctx);
    appendEvent(ctx.sid, "prompt", { prompt_id: ctx.input.prompt_id ?? randomUUID(), typed, chars: text.length });
    if (!typed) return;
    // A queue dropped since the last line the person could see (its workflow ended other than finished while the turn
    // was cut off, or in a turn that failed; dropQueueAfter): said now, with this message's own line if it has one.
    const dropped = takeQueueDropped(ctx);
    if (dropped && showsLines) aheadLine = queueDroppedLine(ctx, dropped);
    // What belongs to the previous message ends here, once, before any path below can return (a typed /mmo:setup, a
    // message about zero-touch or "stop" returns early; otherwise a start abandoned with Esc would keep refusing every
    // tool, and a kept job would start on a later "ok thanks"). Only for a message sent while Claude is idle: one
    // typed mid-turn joins the running turn and its pending start.
    const working = sentWhileWorking(ctx.input.transcript_path, text) === true;
    const carried = working || ctx.agent ? null : takeCarry(ctx);
    // The step the turn before was cut off in, if it was (cutOffStep). Read once, by the next message only.
    const cutOff = working || ctx.agent ? null : cutOffStep(ctx);
    if (!working && !ctx.agent && !ctx.pipeline) {
      const stale = readRoute(ctx.sid);
      if (stale?.status === "pending" || stale?.status === "judge" || stale?.status === "refused") { dropRoute(ctx.sid); appendEvent(ctx.sid, "route.dropped", { job: stale.job ?? null, status: stale.status }); }
    }
    // A chat made by /branch while a workflow runs in this folder: the workflow carries on only in
    // the chat that runs it, so the branch is told once, at its first message, and its message is answered normally.
    const forked = join(sessionDir(ctx.sid), "zt_forked");
    if (existsSync(forked) && !ctx.agent) {
      rmSync(forked, { force: true });
      const lock = heldByOther(ctx.projectDir, ctx.sid);
      if (lock && acts(ctx)) {
        appendEvent(ctx.sid, "session.forked_during_workflow", { job: lock.job ?? undefined });
        return void say(`This chat is a branch made while a ${lock.job ? plainName(lock.job) : "workflow"} runs in another chat of this folder; that workflow carries on only there, and the person has been told in one line. Answer this message normally, and do not carry on any of that workflow's steps here. ${KEEP_OUT}`, L.forkedDuringWorkflow(lock.job ?? null));
      }
    }
    if (ctx.pipeline && acts(ctx) && !ctx.agent) {
      // This chat's workflow never began, sat waiting, and another chat has taken the folder since (project-lock
      // NOT_STARTED_IDLE_MS): it is over here; the person is told once.
      const owner = lockOwner(ctx.projectDir);
      if (owner?.sid && owner.sid !== ctx.sid && heldByOther(ctx.projectDir, ctx.sid)) {
        const job = runningJob(ctx) ?? "workflow";
        // A run that had begun lost the folder because this chat was closed while it ran (its Claude Code process
        // ended; lib/project-lock.mjs): said as such, never "it never began".
        const began = ownWorkflowState(ctx).state !== "not-started";
        endPipeline(ctx);
        dropSessionMarker(ctx, "stop_requested");
        appendEvent(ctx.sid, "session.pipeline_lost", { to: owner.sid, began });
        return void say(`This chat's ${plainName(job)} has stopped: ${began ? "this chat was closed while it ran" : "it never began"}, and another chat in this folder has started a workflow since. The person has been told in one line. Answer this message normally, without starting a workflow or carrying on any of its steps. ${KEEP_OUT}`, L.lostFolder(job, { began }));
      } else if (hasSessionMarker(ctx, "stop_requested")) {
        // A stop asked for while the workflow was working, whose turn then ended without the Stop hook (the person
        // pressed Esc): it is carried out now, at the next message.
        const { job, droppedQueued } = stopWorkflow(ctx, "stopped");
        dropSessionMarker(ctx, "stop_requested");
        return void say(`The person asked earlier to stop the ${plainName(job)}; it has now been stopped and the person has been told in one line. Do not carry on any of its steps. Answer this message normally. ${KEEP_OUT}`, L.stopped(job, droppedQueued));
      } else if (rewoundPastStart(ctx)) {
        // The conversation was rewound to before the workflow started: it is no longer in the
        // conversation, so it is stopped the way its own abort stops it, and the folder is free.
        const { job } = stopWorkflow(ctx, "rewound");
        return void say(`The conversation was rewound to before the ${plainName(job)} started, so it has been stopped; the person has been told in one line. Answer this message normally; a job asked for again starts a new workflow. ${KEEP_OUT}`, L.rewound(job));
      } else if (isStopRequest(text) && pipelineRecord(ctx)?.policy && (working || waitingFor(ctx) !== "gate")) {
        // Only a run zero-touch started, and never at one of its gates: a run the person typed is mmo's own, as mmo
        // runs it without zero-touch; at a gate the person's words are the workflow's answer ("abort" is mmo's own gate
        // reply), so mmo's own abort records the end, its manifest and its report.
        // Before its run has begun (its first questions) there is nothing of mmo's to record, so zero-touch stops it.
        // "stop" typed while the workflow is working (in the terminal this hook runs at Enter, mid-turn): stopping now
        // would switch its file rules off and free the folder while its helper is still writing. The stop is recorded,
        // Claude is told to stop, and it is carried out when the turn ends (turn-end, turn-failed), or at the next
        // message if the turn ended without the Stop hook.
        if (sentWhileWorking(ctx.input.transcript_path, text) === true) {
          const job = runningJob(ctx) ?? "workflow";
          setSessionMarker(ctx, "stop_requested");
          appendEvent(ctx.sid, "route.stop_requested", { job });
          return void say(`The person asked to stop the ${plainName(job)} while it was working. Do not start any more of its steps or helpers: say in one short sentence that it is being stopped, and end your turn. Zero-touch stops it fully when this turn ends. ${KEEP_OUT}`, L.stopping(job));
        }
        // "stop", "cancel", "never mind" while a workflow runs: it is stopped the way its own abort
        // stops it, wherever it stands (asking its first questions, at a gate, or running).
        const { job, droppedQueued } = stopWorkflow(ctx, "stopped");
        return void say(`The person asked to stop the ${plainName(job)}; it has been stopped and the person has been told in one line. Do not carry on with any of its steps: say in one short sentence that it is stopped, and stop. ${KEEP_OUT}`, L.stopped(job, droppedQueued));
      }
    }
    // The replace-or-queue question belongs to the message that raised it: a later message that is one of its two
    // answers, written out, settles it; any other message drops it, so nothing stays blocked.
    const waiting = Q.readChoice(ctx.sid);
    // An answer written out while Claude is working ("Replace it" typed mid-turn must not stop the running workflow
    // while its helper is still writing) neither settles nor drops the question: it joins the running turn, and the
    // box stays.
    if (waiting && waiting.prompt_id !== (ctx.input.prompt_id ?? null) && sentWhileWorking(ctx.input.transcript_path, text) !== true) {
      const kind = Q.labelKind(text);
      // The answer written out: the person sees what happened (queued, replaced), the model what to do next.
      if (kind) { const done = settle(ctx, waiting, kind); return void say(done.text, done.line); }
      Q.dropChoice(ctx.sid);
      appendEvent(ctx.sid, "route.choice_dropped", { job: waiting.job });
    }
    // A typed plugin command (only a workflow command makes the chat a workflow run; see typedMoment). Before the
    // zero-touch-mention exit below, so a typed /mmo:docs whose words name zero-touch is still a typed command.
    const cmd = typedCommand(text, { projectDir: ctx.projectDir });
    if (cmd) {
      const decision = typedMoment(ctx, cmd);
      if (decision.block) return void emit({ decision: "block", reason: decision.block });
      // A typed command shows no line of its own (the person named the workflow), except when it must wait for
      // the Queue-or-Replace answer.
      if (decision.context) say(decision.context, L.alreadyRunning(runningJob(ctx), cmd.name));
      return;
    }
    // "Write it yourself" in Hand-off mode, before the zero-touch-mention exit below: the reply the refusal line asks
    // for often names zero-touch ("zero-touch stopped it, just write it yourself"), and dropped as a message about
    // zero-touch, the same refusal would come back on every write. Sent while Claude works, the person's word applies
    // to the running work at once, so the safety net lets Claude's own file through; sent while idle, it is this
    // message's work (handoffPrompt).
    if (ctx.config.mode === "b" && !ctx.agent && !ctx.pipeline && H.DO_IT_YOURSELF.test(text)) {
      if (!working) return void handoffPrompt(ctx, text);
      H.writeTurn(ctx.sid, { kinds: [], own: true });
      appendEvent(ctx.sid, "handoff.own", { working: true });
      return void say("The person asked for this work to be done in the chat: do it yourself, with your own tools, and do not call the hand-off tools for it.", null);
    }
    // A message about zero-touch itself ("change zero-touch settings", "help me connect Google for zero-touch"): the
    // zero-touch plugin's own hooks handle it. It never starts a workflow, is never a workflow's answer, and gets no
    // line from here ("fix my zero-touch config" is not a bug fix).
    if (mentionsZeroTouch(text)) {
      appendEvent(ctx.sid, "route.none", { reason: "about zero-touch itself" });
      return;
    }
    if (ctx.pipeline) {
      // Plain words while this chat runs a workflow (a running workflow is either working, when the message joins
      // Claude's turn, or waiting at one of its steps, when the message is its answer). A job asked for now is queued
      // at once, said at once, and starts by itself when the running workflow ends (turn-end, as any queued job does).
      // Nothing is held and no box opens, so the running workflow's own steps and helpers are never in the way.
      if (!acts(ctx) || ctx.agent || ctx.config.mode === "b") return;
      // Waiting at one of its steps (a gate, or its first questions): the message is the workflow's answer. At a gate
      // "add a due date to the form" is a revision of the running work, not a new job.
      if (!working && waitingFor(ctx, cutOff)) return;
      const running = runningJob(ctx) ?? "workflow";
      // During a new-app build the folder is becoming that app: a change asked for now is a change to it.
      const folder = running === "greenfield" ? "existing" : folderKind(ctx.projectDir);
      const r = routeMessage(text, folder);
      if (!r.job || r.job === "greenfield") {
        // A request the rules cannot place is left to Claude's judgement, as when no workflow runs: about the running
        // work, it stays part of it; a clearly separate job, Claude calls its workflow, and pre-skill queues that call
        // and tells the person. Nothing starts here, so the running workflow is never in the way.
        const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
        if (!r.job && judgeable(r, requestLead(firstLine).lead, text)) {
          appendEvent(ctx.sid, "route.judge", { reason: r.reason, during: running, working });
          return void say(midRunJudgeInstruction({ folder, running, cutOff: Boolean(cutOff) }), null);
        }
        appendEvent(ctx.sid, "route.none", { reason: r.job ? "a new app while a workflow runs" : r.reason, during: running, working });
        return;
      }
      const added = Q.enqueue(ctx.sid, { job: r.job, args: r.args, via: "words" });
      appendEvent(ctx.sid, "route.remembered", { job: r.job, running, working, ...(added === "duplicate" ? { duplicate: true } : {}) });
      return void say(rememberedNote(r.job, running, { cutOff: Boolean(cutOff) }), added === "duplicate" ? L.queuedTwice(r.job) : L.remembered(r.job, running));
    }
    // A message typed while Claude is still working joins the running task: it never starts a
    // workflow and never ends a start that task has pending. Only a message sent when the chat is idle is judged,
    // as the person typing a command would be; work done earlier in the chat does not matter.
    // ("Write it yourself" typed while Claude works, in Hand-off mode, is handled above, before the zero-touch-mention exit.)
    if (working) {
      appendEvent(ctx.sid, "route.none", { reason: "sent while Claude was working: part of the running task" });
      return;
    }
    // A route belongs to one prompt: the new prompt ended it at the top of this handler, so nothing stays blocked.
    // Hand-off mode: the message is the chat's own work; the part that is hand-off work is recognised.
    if (ctx.config.mode === "b") return void (ctx.agent ? undefined : handoffPrompt(ctx, text));
    // Workflows switched off by a setting file: a message that asks for a job is told why nothing starts, once per
    // chat; anything else gets nothing.
    if (ctx.config.mode === "on" && ctx.config.routing === "off" && !ctx.pipeline && !ctx.agent) {
      const asked = routeMessage(text, folderKind(ctx.projectDir));
      if (!asked.job || hasSessionMarker(ctx, "routing_off_said")) return;
      setSessionMarker(ctx, "routing_off_said");
      appendEvent(ctx.sid, "route.routing_off", { job: asked.job, by: ctx.config.routing_off_by ?? undefined });
      return void say(`${NOT_A_JOB_NOTE} ${KEEP_OUT}`, L.routingOff(asked.job, ctx.config.routing_off_by));
    }
    if (!routingOn(ctx)) return;
    // A "yes" to the job that did not start; anything else is judged as usual.
    const carry = carriedStart(ctx, text, carried);
    if (carry) return void say(carry.note, carry.line);
    const j = judgeMessage(ctx, text);
    if (j) say(j.note, j.line);
  },

  "pre-skill"(ctx) {
    // Guard B. Every command start, typed or model-started, can be a Skill call
    // Zero-touch off: nothing to decide.
    const name = String(ctx.input.tool_input?.skill ?? "").trim().replace(/^\//, "");
    if (!/^mmo:/.test(name) || !acts(ctx)) return;
    // Workflow mode starts a workflow the rules recognised; hand-off mode only one the person typed.
    const notNow = ctx.config.mode === "b" ? [REFUSAL.typedOnly, H.TYPED_ONLY_REASON] : [REFUSAL.notNow, NOT_NOW_REASON];
    const job = name.slice("mmo:".length);
    const typed = Q.readTyped(ctx.sid);
    // The Skill call of a command the person just typed (in modes where a typed command makes one): the prompt
    // hooks have already decided about it.
    const typedNow = typed?.name === job && (!ctx.input.prompt_id || !typed.prompt_id || typed.prompt_id === ctx.input.prompt_id);
    const refuse = ([person, model]) => emit(refusalOutput(person, model));
    if (!WORKFLOW_COMMANDS.has(job)) {
      // A one-off command (setup, policy, revert) or a skill of the plugin (the brownfield manual): the person's
      // own typing runs it, and so does a running workflow; the chat starting one by itself is refused.
      if (typedNow || ctx.pipeline) return;
      appendEvent(ctx.sid, "route.refused", { job, by: ctx.agent ? "helper" : "chat" });
      return void refuse(notNow);
    }
    // The replace-or-queue question waits for its answer; no workflow starts before it.
    const waiting = Q.readChoice(ctx.sid);
    if (waiting) return void refuse([REFUSAL.waitAnswer, Q.askInstruction(waiting)]);
    // A helper agent never starts the chat's workflow: the person asked the chat, not the helper.
    if (ctx.agent) { appendEvent(ctx.sid, "route.refused", { job, by: "helper" }); return void refuse(notNow); }
    const route = readRoute(ctx.sid);
    // A job zero-touch said cannot start in this turn: any workflow call gets the same reason (holdRefused).
    if (route?.status === "refused" && !typedNow && !ctx.pipeline) {
      appendEvent(ctx.sid, "route.refused", { job, by: "chat", why: "refused start" });
      return void refuse([L.notStarted(route.problem, route.job), cannotStartInstruction(route.job, route.problem)]);
    }
    if (route?.status === "judge" && !typedNow && !ctx.pipeline) {
      // Claude judged the message a job (judgeInstruction). Zero-touch checks the start as it would its own:
      // a job this folder allows, then the same start checks and the same one-workflow-per-folder rule.
      dropRoute(ctx.sid);
      if (!Array.isArray(route.allowed) || !route.allowed.includes(job)) {
        appendEvent(ctx.sid, "route.refused", { job, by: "judge", why: "not a job for this folder" });
        return void refuse(notNow);
      }
      const policy = chatPolicy(ctx.sid);
      const lock = heldByOther(ctx.projectDir, ctx.sid);
      const { problem, needed } = lock ? { problem: { cause: "busy", job: lock.job } } : canStart(ctx, policy, job);
      if (problem) {
        appendEvent(ctx.sid, "route.cannot_start", { job, cause: problem.cause, at: "judge" });
        holdRefused(ctx, job, problem);
        return void refuse([L.notStarted(problem, job), cannotStartInstruction(job, problem)]);
      }
      // The request in Claude's words, or the message's first line; a new app takes none (its message is the brief).
      const given = typeof ctx.input.tool_input?.args === "string" ? ctx.input.tool_input.args : "";
      const words = job === "greenfield" ? "" : (given.replace(/^\s*\[zero-touch[^\]]*\]\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 300) || route.args || "");
      const args = startArgs({ args: words, auth: auth(ctx), policy });
      writeRoute(ctx.sid, { job, args: words, via: "judge", status: "pending", prompt_id: route.prompt_id ?? null, ...(needed ? { needed } : {}) });
      appendEvent(ctx.sid, "route.decided", { job, via: "judge", policy });
      // The run's tag is zero-touch's, never Claude's copy of it: set here when Claude's differs.
      if (given.trim() !== args) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...ctx.input.tool_input, args } } });
      return;
    }
    if (route?.status === "pending") {
      if (route.job !== job) return void refuse([REFUSAL.startFirst(route.job), startFirstReason(route.job)]);
      // The chat's model, checked again now that the chat has answered: a new chat's first message comes
      // before Claude Code says which model the chat is on, and the workflow's helpers will follow that model.
      const helper = route.needed ? helperModel({ chatModel: chatModel(ctx) }) : null;
      if (helper && helper.model !== route.needed) {
        // The chat's policy too, so the line names the models the person chose.
        const problem = { cause: "chat-model", have: helper.model, needed: route.needed, via: helper.via, policy: chatPolicy(ctx.sid) };
        holdRefused(ctx, job, problem);
        appendEvent(ctx.sid, "route.cannot_start", { job, cause: problem.cause, at: "skill" });
        return void refuse([L.notStarted(problem, job), cannotStartInstruction(job, problem)]);
      }
      // Allowed. The start is recorded after the call really ran (post-skill): recording it here would mark the chat
      // as running a workflow even when Claude Code's own permission rules, another hook, or an interrupt then stop the
      // call, leaving the chat stuck and the folder locked.
      return;
    }
    if (typedNow) return;
    if (ctx.pipeline) {
      // The chat starting a second workflow by itself while one runs: queued, as the person's own words are (no box,
      // nothing held), unless the new one could not start anyway (newJobProblem).
      const args = typeof ctx.input.tool_input?.args === "string" ? ctx.input.tool_input.args.replace(/^\s*\[zero-touch[^\]]*\]\s*/i, "") : "";
      const running = runningJob(ctx) ?? "workflow";
      // Only a job this folder allows, as for a start Claude judges when no workflow runs: never a new app in a
      // project, never a change in an empty folder. During a new-app build the folder is becoming that app.
      const folder = running === "greenfield" ? "existing" : folderKind(ctx.projectDir);
      if (!jobsFor(folder).includes(job)) {
        appendEvent(ctx.sid, "route.refused", { job, by: "chat", why: "not a job for this folder", during: running });
        return void refuse(notNow);
      }
      const blocked = newJobProblem(ctx, job);
      if (blocked) return void refuse([L.notStarted(blocked, job), cannotStartInstruction(job, blocked)]);
      const added = Q.enqueue(ctx.sid, { job, args, via: "words" });
      appendEvent(ctx.sid, "route.remembered", { job, running, by: "skill", ...(added === "duplicate" ? { duplicate: true } : {}) });
      return void refuse([added === "duplicate" ? L.queuedTwice(job) : L.remembered(job, running), rememberedNote(job, running)]);
    }
    // No route: the chat is starting a workflow on its own guess. Only the rules (or a typed command) start one,
    // so this is always refused and the chat carries on.
    appendEvent(ctx.sid, "route.refused", { job, by: "chat" });
    refuse(notNow);
  },

  "pre-any"(ctx) {
    // The chat's workflow claims its run from its own logging calls (claimRun); it emits nothing.
    claimRun(ctx);
    // The workflow reports that it stopped before its run began (ambient/workflow-stopped.mjs); it emits
    // nothing: the chat's workflow ends when the turn ends.
    noteEarlyStop(ctx);
    // The chat's own step in its running workflow, kept until the turn ends (cutOffStep); it emits nothing.
    if (ctx.pipeline && !ctx.agent && typeof ctx.input.tool_name === "string") setSessionMarker(ctx, STEP_MARK, ctx.input.tool_name);
    // The chat's model, confirmed at the workflow's first step (wrongModelAfterStart).
    if (wrongModelAfterStart(ctx)) return;
    // Guard A: one catch-all, so every tool that can change something waits
    // for a routed workflow's start, whoever calls it (blockUntilStarted).
    if (blockUntilStarted(ctx)) return;
    // A run zero-touch started: its run-start check reads the person's policy file too (stampRunCheck).
    if (stampRunCheck(ctx)) return;
    // The workflow's own steps, without a permission prompt.
    if (allowOwnStep(ctx)) return;
    // Hand-off mode's safety net rides on the same catch-all, so no extra hook runs in any chat.
    if (ctx.config.mode === "b") { keepBeforeEdit(ctx); typedByHandNet(ctx); }
  },

  "post-skill"(ctx) {
    // The routed workflow's command really ran. Its start is marked here too,
    // so a start hook that never finished (Claude Code lets the call through
    // on a hook timeout) cannot leave the workflow blocked by Guard A.
    const name = String(ctx.input.tool_input?.skill ?? "").trim().replace(/^\//, "");
    const route = readRoute(ctx.sid);
    const note = (text) => emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
    if (ctx.agent || route?.status !== "pending" || name !== `mmo:${route.job}`) {
      // A workflow command the person typed in a zero-touch chat: its own choices stand, and Claude is told only how
      // to hand the chat back if it stops before its run begins (mmo's command texts are left unchanged).
      const rec = !ctx.agent && acts(ctx) && ctx.pipeline ? pipelineRecord(ctx) : null;
      if (rec && !rec.policy && name === `mmo:${rec.job}` && WORKFLOW_COMMANDS.has(rec.job)) note(`${STOP_NOTE}.`);
      return;
    }
    const got = startWorkflow(ctx, route, typeof ctx.input.tool_use_id === "string" ? ctx.input.tool_use_id : null);
    if (got.ok) {
      // What differs in a run zero-touch started, said beside the unchanged command (lib/route-flow.mjs runNote).
      return void note(route.typed ? `${STOP_NOTE}.` : runNote({ job: route.job, policy: chatPolicy(ctx.sid), auth: auth(ctx) }));
    }
    // Another chat started a workflow in this folder a moment before this one (the lock is taken atomically here):
    // the command's text is already loaded, so the model is told not to carry it out, and the person why.
    const problem = { cause: "busy", job: got.owner?.job ?? null };
    appendEvent(ctx.sid, "route.cannot_start", { job: route.job, cause: "busy", at: "start" });
    emit({ ...(showsLines ? { systemMessage: L.notStarted(problem, route.job) } : {}), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Do not carry out the workflow you just loaded. ${cannotStartInstruction(route.job, problem)}` } });
  },

  "pre-agent"(ctx) {
    const type = String(ctx.input.tool_input?.subagent_type ?? "");
    if (!type.startsWith("mmo:")) return;
    // While the replace-or-queue question waits, or "Queue it" holds a typed command, no workflow helper starts.
    const waiting = acts(ctx) ? Q.readChoice(ctx.sid) : null;
    if (waiting || (acts(ctx) && Q.hasHold(ctx.sid))) {
      appendEvent(ctx.sid, "agent.mmo-ambient_request", { agent: type, blocked: true, held: true });
      return void emit(waiting ? refusalOutput(REFUSAL.waitAnswer, Q.askInstruction(waiting)) : refusalOutput(REFUSAL.hold, HOLD_REASON));
    }
    // The mmo agents belong to a workflow run. In ordinary chat the
    // model picking one up on its own starts a gated run nobody asked for.
    const blocked = !ctx.pipeline && !ctx.agent;
    appendEvent(ctx.sid, "agent.mmo-ambient_request", { agent: type, blocked: blocked && acts(ctx) });
    if (blocked && acts(ctx)) {
      emit(refusalOutput(REFUSAL.helperOutside, `${type} runs only inside a workflow the person started or agreed to. None is running in this chat, so carry on with your own tools. ${KEEP_OUT}`));
    }
  },

  "post-question"(ctx) {
    // The person answered a multiple-choice question (PostToolUse on AskUserQuestion). When it is the waiting
    // replace-or-queue question, its exact label decides (lib/queue.mjs answerFrom); any other question is not ours.
    const waiting = Q.readChoice(ctx.sid);
    if (!waiting || !acts(ctx)) return;
    const kind = Q.answerFrom(ctx.input.tool_response, waiting.question);
    if (kind === null) return;
    const done = settle(ctx, waiting, kind);
    emit({ ...(showsLines ? { systemMessage: done.line } : {}), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: done.text } });
  },

  "turn-end"(ctx) {
    // The end of a turn (Stop). The hold of a queued typed command ends here. When the chat's workflow has ended and
    // a job is queued, the turn continues with the first one: the reason is what the model reads next. A start the
    // model then does not make is not pushed again (stop_hook_active): the route is dropped, the job stays queued
    // for the next turn's end.
    Q.dropHold(ctx.sid);
    // A refused start holds file changes for its own turn only (holdRefused).
    if (readRoute(ctx.sid)?.status === "refused") dropRoute(ctx.sid);
    dropSessionMarker(ctx, STEP_MARK); // the turn reached its end: it was not cut off (cutOffStep)
    // A stop the person asked for while the workflow was working: carried out now that the turn is over.
    if (ctx.pipeline && hasSessionMarker(ctx, "stop_requested")) {
      const { job, droppedQueued } = stopWorkflow(ctx, "stopped");
      dropSessionMarker(ctx, "stop_requested");
      if (showsLines) emit({ systemMessage: L.stopped(job, droppedQueued) });
      return;
    }
    // The workflow that ended with this turn, if one did: the person is told, and a queued job follows.
    const ended = endPipelineIfOver(ctx);
    // A queue dropped because its workflow ended other than finished (dropQueueAfter): said with the end.
    const dropped = takeQueueDropped(ctx);
    // A message left to Claude's judgement that Claude answered without starting anything ends with the turn.
    if (readRoute(ctx.sid)?.status === "judge") dropRoute(ctx.sid);
    const route = readRoute(ctx.sid);
    const endedLine = () => {
      if (ended) return [L.ended(ended.job, ctx.config.mode, ended.outcome), ended.saved, dropped ? queueDroppedLine(ctx, dropped, { withEnd: false }) : null].filter(Boolean).join(" ");
      return dropped ? queueDroppedLine(ctx, dropped) : null;
    };
    const endedOnly = () => { const line = endedLine(); if (line && showsLines) emit({ systemMessage: line }); };
    if (ctx.input.stop_hook_active === true) {
      // A start Claude was told to make, then told once more (below), and still did not make (the first chat's replayed
      // first message included): given up, said, and kept for the person's next message (carry), so "yes" starts it.
      // A workflow that ended in this continued turn is said too: its end, and a dropped queue.
      if (route?.status === "pending" && acts(ctx) && !ctx.agent) giveUpStart(ctx, route, endedLine());
      else endedOnly();
      return;
    }
    // The first chat after install: the person need not send their first message again.
    // Zero-touch's settings box saved Workflows in this turn, and the first message arrived before there were
    // settings: it is judged now, as if it had just been typed, with the same rules. Its workflow starts (the turn
    // continues with the start instruction, as a queued job does), or Claude answers it.
    const replay = !route && acts(ctx) && !ctx.agent && !ctx.pipeline && ctx.config.mode !== "b" && routingOn(ctx) ? takeReplay(ctx.sid) : null;
    if (replay) {
      const text = replay.prompt;
      const quoted = `The person's first message, sent before zero-touch had settings, was: """${text.slice(0, 4000)}"""`;
      if (/^\s*\//.test(text)) return void emit({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: `${quoted}. It is a command; ask them to type it again now, and do not run it yourself. ${KEEP_OUT}` } });
      const j = judgeMessage(ctx, text, { replay: true });
      return void emit({
        ...(j?.line && showsLines ? { systemMessage: j.line } : {}),
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: j ? `${quoted}. ${j.note}` : `${quoted}. It is not a workflow job: answer it now, as a normal chat.` },
      });
    }
    // A start the person was told about ("Claude is starting the …") that Claude never made in this turn: dropped,
    // and said, instead of silently at the next message.
    if (route?.status === "pending" && acts(ctx) && !ctx.agent) {
      // Told once more, never twice (route.retried, besides Claude Code's own stop_hook_active).
      if (!route.retried) {
        writeRoute(ctx.sid, { ...route, retried: true });
        appendEvent(ctx.sid, "route.retry", { job: route.job, via: route.via });
        // A command the person typed and queued is pushed again exactly as typed: zero-touch's model tag and its
        // "do not ask" sentences are only for a job zero-touch recognised.
        const line = endedLine();
        return void emit({ ...(line && showsLines ? { systemMessage: line } : {}), hookSpecificOutput: { hookEventName: "Stop", additionalContext: retryInstruction({ job: route.job, args: route.args, auth: auth(ctx), policy: chatPolicy(ctx.sid), typed: route.typed === true }) } });
      }
      return void giveUpStart(ctx, route, endedLine());
    }
    if (!acts(ctx) || ctx.agent || ctx.pipeline || route?.status === "pending" || Q.readChoice(ctx.sid)) return void endedOnly();
    const next = Q.readQueue(ctx.sid)[0];
    if (!next) return void endedOnly();
    const lock = heldByOther(ctx.projectDir, ctx.sid);
    if (lock) { appendEvent(ctx.sid, "route.queue_waits", { job: next.job, cause: "busy" }); return void endedOnly(); }
    // A command the person typed and queued starts exactly as they typed it: no
    // zero-touch models, no zero-touch start checks (it runs its own), nothing stamped. Only a job zero-touch
    // recognised carries the person's zero-touch models.
    const typedJob = next.via === "typed";
    const policy = typedJob ? null : chatPolicy(ctx.sid);
    const { problem, needed } = typedJob ? { problem: null } : canStart(ctx, policy, next.job);
    if (problem) {
      // The person reads the line; nothing for the model to act on, so the turn simply ends (a Stop "block" reason
      // is shown to the person as "Stop hook feedback").
      Q.removeStarted(ctx.sid, next);
      appendEvent(ctx.sid, "route.cannot_start", { job: next.job, cause: problem.cause, via: "queue" });
      return void (showsLines ? emit({ systemMessage: L.notStarted(problem, next.job) }) : undefined);
    }
    writeRoute(ctx.sid, { job: next.job, args: next.args, via: "queue", ...(typedJob ? { typed: true } : {}), ...(needed ? { needed } : {}), status: "pending", prompt_id: ctx.input.prompt_id ?? null });
    appendEvent(ctx.sid, "route.decided", { job: next.job, via: "queue", policy: policy ?? undefined, typed: typedJob || undefined });
    // The start instruction is the Stop hook's context, which reaches the model and lets the conversation continue
    // (as Claude Code describes it), instead of a "block" reason the person would read as "Stop hook
    // feedback" with the command and its arguments in it.
    emit({ systemMessage: [L.startingQueued(next.job, ended?.job ?? null), ended?.saved].filter(Boolean).join(" "), hookSpecificOutput: { hookEventName: "Stop", additionalContext: Q.queuedStartInstruction(next, typedJob ? {} : { auth: auth(ctx), policy }) } });
  },

  "turn-failed"(ctx) {
    // A turn that ended in an error (StopFailure: a usage or rate limit, an overloaded service) never reaches
    // turn-end, so a queued typed command's hold would refuse every tool in the next turn. The same clean-up runs
    // here; Claude Code ignores this hook's output, so nothing is said.
    Q.dropHold(ctx.sid);
    if (readRoute(ctx.sid)?.status === "refused") dropRoute(ctx.sid);
    dropSessionMarker(ctx, STEP_MARK); // the turn reached its end, even if failed (cutOffStep)
    // A stop asked for while the workflow was working: carried out here too (this hook's output is ignored; the person
    // was told at the time that it stops once Claude's current step ends).
    if (ctx.pipeline && hasSessionMarker(ctx, "stop_requested")) {
      stopWorkflow(ctx, "stopped");
      dropSessionMarker(ctx, "stop_requested");
      return;
    }
    endPipelineIfOver(ctx);
  },

  "pre-dispatch"(ctx) {
    // A model-server call that takes a policy file (lib/own-steps.mjs STAMPED_TOOLS) inside a run zero-touch
    // started: it is stamped with that run's policy file, an explicit path, which the server and the
    // run-start check put ahead of everything else, a project's routing-policy.yaml included. So the run uses the
    // person's zero-touch choice whatever any instruction says, from the chat or from a helper (helpers make most of
    // these calls). A run the person typed is left to its own rules. execute_stage takes no policy: it reuses the one
    // pre-flight recorded, which this stamp set.
    const rec = pipelineRecord(ctx);
    if (!rec?.policy || !ctx.pipeline) return;
    const input = ctx.input.tool_input && typeof ctx.input.tool_input === "object" && !Array.isArray(ctx.input.tool_input) ? ctx.input.tool_input : {};
    const path = policyPath(rec.policy);
    // The commands the call would make the server run (a written file's check and format commands) run outside
    // Claude Code's Bash rules: one the person's settings forbid refuses the call; a packets file that cannot be read
    // to check them, or a command whose shell syntax the check cannot see through, leaves the call to Claude Code's
    // prompt (lib/own-steps.mjs serverCommands).
    const problem = serverCommandProblem(ctx);
    if (problem?.rule) {
      appendEvent(ctx.sid, "route.server_command_denied", { tool: String(ctx.input.tool_name ?? ""), rule: problem.rule });
      return void emit(refusalOutput(SERVER_COMMAND_DENIED, serverCommandDeniedReason(problem.command, problem.rule)));
    }
    // A step of the person's own workflow: allowed without a permission prompt (lib/own-steps.mjs).
    const allow = problem ? {} : { permissionDecision: "allow", permissionDecisionReason: OWN_STEP };
    if (input.policy_path === path) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...allow } });
    appendEvent(ctx.sid, "route.policy_stamped", { tool: String(ctx.input.tool_name ?? ""), policy: rec.policy, by: ctx.agent ? "helper" : "chat" });
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, policy_path: path }, ...allow } });
  },

  "session-end"(ctx) {
    // The conversation ended (SessionEnd). Claude Code sends it for the OLD chat id when the person types /clear, and
    // gives the cleared conversation a new id. A workflow abandoned that way would otherwise hold the project
    // forever: every later workflow there, typed ones included, would be refused with "type /clear in that chat",
    // which could never help. So at /clear the run is recorded as stopped, as "Replace it"
    // stops it, and the project is free. Other endings (an exit, /resume to another chat) keep it: that chat can be
    // reopened and carry on its workflow.
    if (ctx.input.reason !== "clear" || !ctx.pipeline) return;
    // Only the run this chat claimed is recorded as stopped (claimRun): a run found by time alone may be another
    // chat's, started later in the same folder. Unclaimed, the chat still lets go of the project.
    const runId = pipelineRun(ctx);
    const done = abortRun(ctx.projectDir, runId, "cleared");
    endPipeline(ctx);
    Q.dropChoice(ctx.sid);
    Q.dropQueue(ctx.sid);
    Q.dropHold(ctx.sid);
    appendEvent(ctx.sid, "route.cleared", { run_id: runId ?? undefined, logged: done.logged, unlocked: done.unlocked });
  },

  "pre-handoff"(ctx) {
    // A hand-off tool call (hand-off mode; the tools are the server's, which never sees a chat). In a hand-off chat
    // that runs no workflow the call gets the hook's stamp, so the server knows which chat it belongs to; the chat's
    // models are resolved first, so the server finds them in the chat's records. Anywhere else the call is refused:
    // a chat in workflow mode has no hand-offs, and a workflow run has its own steps and its own bill.
    const tool = H.handoffToolName(ctx.input.tool_name);
    if (!tool) return;
    // The person reads one plain sentence; the model its instruction (refusals are shown to the person).
    // A refusal that tells Claude to do the work itself hands the call's new file back first: otherwise the safety net
    // would refuse Claude's own write of that file, in red, telling it to hand it off, the very call just refused.
    const refuse = (person, model, cause) => {
      const file = ctx.input.tool_input?.file;
      if (tool !== H.UNDO_TOOL && typeof file === "string" && file) H.releasePath(ctx.sid, file);
      appendEvent(ctx.sid, "handoff.tool_refused", { tool, cause });
      emit(refusalOutput(person, model));
    };
    // An undo works in any chat outside a running workflow (see main): it sends nothing to a model and takes back only
    // the hand-off's own files, which the server finds in any chat's records of this project.
    if (tool === H.UNDO_TOOL) {
      if (ctx.pipeline) return void refuse(H.HANDOFF_REFUSAL.inWorkflow, H.NOT_IN_A_WORKFLOW, "workflow-run");
      appendEvent(ctx.sid, "handoff.tool_call", { tool });
      const allow = toolRuleFor(ctx.input.tool_name, ctx.projectDir) ? {} : { permissionDecision: "allow", permissionDecisionReason: H.HANDOFF_UNDO_ALLOWED };
      return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...allow, updatedInput: H.stampedInput(ctx.input.tool_input, { sessionId: ctx.sid, projectDir: ctx.projectDir, auth: auth(ctx), toolUseId: ctx.input.tool_use_id }) } });
    }
    if (ctx.config.mode !== "b") return void (acts(ctx) ? refuse(H.HANDOFF_REFUSAL.notHandoffChat, H.NOT_A_HANDOFF_CHAT, "not-handoff-chat") : undefined);
    if (ctx.pipeline) return void refuse(H.HANDOFF_REFUSAL.inWorkflow, H.NOT_IN_A_WORKFLOW, "workflow-run");
    // Another chat's workflow holds this project: a hand-off would write files beside it that its
    // write contract never sees, so none lands now. Claude does the work itself, under that contract like any write.
    // An undo is the person's own ask, and takes back only the hand-off's own files: it still runs.
    if (tool !== H.UNDO_TOOL) {
      const lock = heldByOther(ctx.projectDir, ctx.sid);
      if (lock) return void refuse(H.HANDOFF_REFUSAL.busy(lock.job ? plainName(lock.job) : null), H.BUSY_REASON, "busy");
    }
    // An undo sends nothing to a model, so it works even when the chat's hand-off policy cannot be read.
    if (tool !== H.UNDO_TOOL) {
      const stamp = H.readStamp(ctx.sid);
      // Work the person keeps in the chat is never handed off, whoever makes the call.
      const kind = { write_document: "docs", write_tests_from_cases: "tests", repeat_edit_across_files: "repeat" }[tool];
      if (kind && H.keptInChat(stamp, kind)) return void refuse(H.HANDOFF_REFUSAL.keptInChat, H.KEPT_IN_CHAT_REASON, "kept-in-chat");
      // Checked again at the call, as Workflows do: a new chat's first message comes before its model is
      // known, and by the call the chat has answered. Not handed back: Claude is not to do it itself either.
      const wrong = handoffWrongModel(ctx, stamp);
      if (wrong) {
        appendEvent(ctx.sid, "handoff.tool_refused", { tool, cause: "chat-model", have: wrong.have });
        return void emit(refusalOutput(H.wrongModelLine(wrong.have, wrong.want), H.wrongModelReason(wrong.have, wrong.want)));
      }
      const found = H.handoffRoutes(ctx.sid, stamp, process.env, { projectDir: ctx.projectDir });
      if (found.error) return void refuse(H.HANDOFF_REFUSAL.unavailable(found), H.unavailableInstruction(found), found.error);
      // A call that could only fail at the server (its model needs Google, and there is no Google login) is refused
      // here; the chat's model does the work, as the start message and the line after the message said.
      if (kind && found.routes[kind]?.noGoogle) return void refuse(H.HANDOFF_REFUSAL.noGoogle, H.NO_GOOGLE_REASON, "google");
      if (kind && found.routes[kind]?.noGit) return void refuse(H.HANDOFF_REFUSAL.noGit(found.routes[kind].noGit), H.NO_GIT_REASON, "no-git");
      // The command a hand-off runs to check its work runs in the server, where Claude Code's own Bash rules never
      // apply: one the person's settings forbid is refused here (lib/bash-rules.mjs).
      const input = ctx.input.tool_input && typeof ctx.input.tool_input === "object" ? ctx.input.tool_input : {};
      for (const field of ["test_command", "check_command"]) {
        const rule = typeof input[field] === "string" ? deniedBy(input[field], ctx.projectDir) : null;
        if (rule) return void refuse(H.HANDOFF_REFUSAL.commandDenied, H.commandDeniedReason(input[field], rule), "command-denied");
      }
    }
    appendEvent(ctx.sid, "handoff.tool_call", { tool });
    // A new document, and an undo, are allowed without Claude Code's permission prompt: the person
    // chose Hand-off, so handing this work off is what they asked for, and the prompt showed them the call's raw form,
    // the stamp included, in words they could not judge; neither runs a command, the document is checked by the
    // server before it reaches the project, and every landing can be undone. The tests and the repeated change run a
    // command the chat wrote, so they keep the prompt, where the person sees that command, as for Claude's own Bash.
    // A deny or ask rule in the person's settings that names the tool keeps Claude Code's own decision too
    // (lib/bash-rules.mjs toolRuleFor).
    const quiet = tool === "write_document" && !toolRuleFor(ctx.input.tool_name, ctx.projectDir);
    const allow = quiet ? { permissionDecision: "allow", permissionDecisionReason: H.HANDOFF_ALLOWED } : {};
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...allow, updatedInput: H.stampedInput(ctx.input.tool_input, { sessionId: ctx.sid, projectDir: ctx.projectDir, auth: auth(ctx), toolUseId: ctx.input.tool_use_id }) } });
  },

  "handoff-failed"(ctx) {
    // A hand-off tool call failed or was interrupted (PostToolUseFailure). Its new file is handed
    // back, so Claude can write it; an interrupted call is also marked by its id, which the server reads before it
    // lands anything, so a hand-off the person stopped never writes into the project later. Says nothing: Claude
    // Code shows the interruption itself.
    // A helper's call too: pre-handoff stamps and runs a helper's hand-off and the safety
    // net claims its file, so a helper's call that failed or was stopped is marked and handed back the same way.
    if (ctx.config.mode !== "b") return;
    const tool = H.handoffToolName(ctx.input.tool_name);
    if (!tool || tool === H.UNDO_TOOL) return;
    if (ctx.input.is_interrupt === true) H.markInterrupted(ctx.sid, ctx.input.tool_use_id);
    const file = ctx.input.tool_input?.file;
    if (typeof file === "string") H.releasePath(ctx.sid, file);
    appendEvent(ctx.sid, "handoff.tool_failed", { tool, interrupted: ctx.input.is_interrupt === true || undefined, ...(ctx.agent ? { helper: true } : {}) });
  },

  "post-handoff"(ctx) {
    // A hand-off tool answered. The person sees one line written by code from the tool's receipt; the model reads
    // the receipt itself, so nothing is added for it.
    const handoffTool = H.handoffToolName(ctx.input.tool_name);
    if (!handoffTool || (ctx.config.mode !== "b" && handoffTool !== H.UNDO_TOOL)) return;
    const receipt = H.toolReceipt(ctx.input.tool_response);
    const stamp = H.readStamp(ctx.sid);
    const chat = H.chatState(stamp, H.chatModelNow(ctx.sid, ctx.input.transcript_path));
    const shown = H.receiptLine(receipt, chat, { documentsHandedOff: Boolean(stamp) && !H.keptInChat(stamp, "docs") });
    if (!shown) return;
    appendEvent(ctx.sid, "handoff.receipt", { status: receipt.status, file: typeof receipt.file === "string" ? receipt.file : undefined, cost_usd: typeof receipt.cost_usd === "number" ? receipt.cost_usd : undefined });
    emit({ systemMessage: shown });
  },

  "pre-model-switch"(ctx) {
    if (ctx.agent) return;
    const to = canonicalModel(ctx.input.to_model);
    // A switch whose target cannot be read is never refused: a guard that misreads its input must not lock the person
    // out of their own model picker.
    if (!to) return;
    const leavesFor = (model) => to !== model && canonicalModel(ctx.input.requested_model) !== model;
    if (ctx.config.mode === "on") {
      // A workflow zero-touch started keeps the chat on the model its helpers follow until it ends: mmo's
      // helper agents name no model, so they run on the chat's model, and a switch mid-run would put the
      // rest of the run on a model its start-up check never passed. Not when the person's own helper setting decides
      // the helpers' model, and never outside a run zero-touch started.
      const rec = ctx.pipeline ? pipelineRecord(ctx) : null;
      if (!rec?.policy || !rec.needed || helperModel({ chatModel: null })?.via === "setting") return;
      const leaves = leavesFor(rec.needed);
      appendEvent(ctx.sid, "model.switch_request", { to, refused: leaves, during: "workflow" });
      if (!leaves) return;
      return void emit({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: L.switchDuringWorkflow(rec.job, rec.needed) } });
    }
    // Hand-off mode keeps the chat on its pinned model: the chat's own model does the development, so which model
    // that is decides the quality and the cost of everything that is not handed off. A switch to the pinned model
    // always passes.
    if (ctx.config.mode !== "b") return;
    const stamp = H.readStamp(ctx.sid);
    if (!stamp?.chat_model) return;
    const leaves = leavesFor(stamp.chat_model);
    appendEvent(ctx.sid, "model.switch_request", { to, refused: leaves });
    if (!leaves) return;
    emit({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: H.switchRefusal(stamp) } });
  },

  "post-model-switch"(ctx) {
    // The chat is on another model now (a switch that passed, or one this plugin could not refuse; Claude Code also
    // sends this when a reopened chat gets its model back). Kept so every line names the model really in use, and
    // so a Workflows chat's next start is judged on the model it is really on.
    if ((ctx.config.mode !== "b" && ctx.config.mode !== "on") || ctx.agent) return;
    const to = canonicalModel(ctx.input.to_model);
    if (!to) return;
    H.recordModelNow(ctx.sid, to);
    appendEvent(ctx.sid, "model.switched", { to });
  },
};

/**
 * Judges a message the person typed while the chat was idle, in workflow mode: { note, line } (what the model is told,
 * what the person reads), or null for ordinary chat, which gets nothing. A recognised job that can start becomes the
 * chat's pending route. A request the rules cannot place but that reads as one is left to the chat's own judgement
 * (a "judge" route, checked at the Skill call like any start); anything else is an ordinary chat, never an offer.
 * Used for a message as it arrives, and for the first chat's first message
 * once its settings are saved (turn-end, `replay`).
 */
function judgeMessage(ctx, text, { replay = false } = {}) {
  const folder = folderKind(ctx.projectDir);
  const r = routeMessage(text, folder);
  // Not placed by the rules, but a request: Claude judges it (lib/route-flow.mjs judgeable). Its start is checked at
  // the Skill call ("pre-skill", the "judge" route). Also while another chat holds this folder: a job Claude judges it
  // to be is then refused at the call with the busy line.
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  if (!r.job && judgeable(r, requestLead(firstLine).lead, text)) {
    const policy = chatPolicy(ctx.sid);
    writeRoute(ctx.sid, { status: "judge", allowed: jobsFor(folder), args: firstLine.trim().replace(/\s+/g, " ").slice(0, 300), prompt_id: ctx.input.prompt_id ?? null, ...(replay ? { replay } : {}) });
    appendEvent(ctx.sid, "route.judge", { reason: r.reason, ...(replay ? { replay } : {}) });
    return { note: judgeInstruction({ folder, auth: auth(ctx), policy }), line: null };
  }
  if (!r.job) {
    appendEvent(ctx.sid, "route.none", { reason: r.reason, kind: r.kind, ...(replay ? { replay } : {}) });
    // Ordinary chat gets nothing; a message that looks like a job, or a real job a folder rule declined, gets the
    // real reason, and the model is told not to start a workflow itself (given nothing, Claude would start the
    // workflow itself and be refused in red).
    const line = declinedLine(r.kind);
    return line ? { note: `${NOT_A_JOB_NOTE} ${KEEP_OUT}`, line } : null;
  }
  const route = { job: r.job, args: r.args, via: "rules" };
  // One workflow at a time in one project, then never tell Opus to start a workflow that its own
  // run-start check would stop.
  const lock = heldByOther(ctx.projectDir, ctx.sid);
  const policy = chatPolicy(ctx.sid);
  const { problem, needed } = lock
    ? { problem: { cause: "busy", job: lock.job } }
    : canStart(ctx, policy, route.job);
  if (!problem) {
    // `needed` is kept so the chat's model can be checked again when the workflow's command is called (pre-skill).
    writeRoute(ctx.sid, { ...route, ...(needed ? { needed } : {}), status: "pending", prompt_id: ctx.input.prompt_id ?? null, ...(replay ? { replay } : {}) });
    appendEvent(ctx.sid, "route.decided", { job: route.job, via: route.via, policy, ...(replay ? { replay } : {}) });
    return { note: startInstruction({ ...route, auth: auth(ctx), policy }), line: L.starting(route.job) };
  }
  appendEvent(ctx.sid, "route.cannot_start", { job: route.job, cause: problem.cause });
  holdRefused(ctx, route.job, problem, replay ? { replay } : {});
  return { note: cannotStartInstruction(route.job, problem), line: L.notStarted(problem, route.job) };
}

/** A start Claude did not make, even when told once more: dropped, said, and kept for one message (carry). */
function giveUpStart(ctx, route, lead = null) {
  dropRoute(ctx.sid);
  // A queued job leaves the queue either way; a command the person typed is theirs to type again, never carried.
  if (route.via === "queue") Q.removeStarted(ctx.sid, route);
  // `lead`: a line this turn's end must say too (a workflow that ended), before this one.
  const show = (line) => { if (showsLines) emit({ systemMessage: [lead, line].filter(Boolean).join(" ") }); };
  if (route.typed) {
    appendEvent(ctx.sid, "route.not_started", { job: route.job, via: route.via, typed: true });
    return void show(L.didntStartTyped(route.job));
  }
  setSessionMarker(ctx, CARRY, JSON.stringify({ job: route.job, args: route.args ?? "", at: Date.now() }));
  appendEvent(ctx.sid, "route.not_started", { job: route.job, via: route.via, ...(route.replay ? { replay: true } : {}), retried: Boolean(route.retried) });
  show(L.didntStart(route.job));
}
const CARRY = "zt_carry";
/** The job kept by giveUpStart, read once (an hour at most), or null. */
function takeCarry(ctx) {
  const raw = sessionMarkerText(ctx, CARRY);
  if (raw === null) return null;
  dropSessionMarker(ctx, CARRY);
  try { const c = JSON.parse(raw); return c?.job && Date.now() - Number(c.at) < 60 * 60 * 1000 ? c : null; } catch { return null; }
}
/**
 * The person's message after a start that did not happen: a plain yes starts that
 * job, through the same checks as any start; anything else is judged as usual. Returns the answer, or null.
 */
function carriedStart(ctx, text, carried) {
  if (!carried || !carryYes(text)) return null;
  const folder = folderKind(ctx.projectDir);
  // The folder may have changed since (a new app's folder that now holds files): its rule still decides.
  if ((carried.job === "greenfield") !== (folder === "new")) {
    const line = declinedLine(folder === "new" ? "folder-no-project" : "folder-new-app");
    return { note: `${NOT_A_JOB_NOTE} ${KEEP_OUT}`, line };
  }
  const policy = chatPolicy(ctx.sid);
  const lock = heldByOther(ctx.projectDir, ctx.sid);
  const { problem, needed } = lock ? { problem: { cause: "busy", job: lock.job } } : canStart(ctx, policy, carried.job);
  if (problem) {
    appendEvent(ctx.sid, "route.cannot_start", { job: carried.job, cause: problem.cause, at: "carry" });
    holdRefused(ctx, carried.job, problem);
    return { note: cannotStartInstruction(carried.job, problem), line: L.notStarted(problem, carried.job) };
  }
  writeRoute(ctx.sid, { job: carried.job, args: carried.args, via: "carry", status: "pending", prompt_id: ctx.input.prompt_id ?? null, ...(needed ? { needed } : {}) });
  appendEvent(ctx.sid, "route.decided", { job: carried.job, via: "carry", policy });
  return { note: startInstruction({ job: carried.job, args: carried.args, auth: auth(ctx), policy }), line: L.starting(carried.job) };
}

/**
 * The first chat's first message, left by the zero-touch plugin's settings box when it saved Workflows in this turn
 * (zero-touch/scripts/settings-hook.mjs, `zt_replay.json` in the chat's folder): { prompt }, read once and removed.
 * Only a recent one counts (an hour), so a record a crash left behind never judges an old message.
 */
const REPLAY_FILE = "zt_replay.json";
function takeReplay(sid) {
  const file = join(sessionDir(sid), REPLAY_FILE);
  let rec = null;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  try { rmSync(file, { force: true }); } catch { /* read once all the same */ }
  const age = Date.now() - Date.parse(rec?.at ?? "");
  // A first message that waits for a model switch is never judged here: the person sends it again (heldFirstMessage).
  if (rec?.waits) return null;
  return typeof rec?.prompt === "string" && rec.prompt.trim() && age >= 0 && age < 60 * 60 * 1000 ? rec : null;
}

/**
 * The prompt hook's one reply to a typed message: `text` is added to what the model reads with the message, and
 * `line` is shown to the person (a `systemMessage`: the model never reads it). Either may be absent; the line is
 * shown only in a chat where zero-touch acts (a measuring run that only records shows nothing).
 */
function say(text, line = null) {
  const shown = line && showsLines ? line : null;
  if (!text && !shown) return;
  emit({ ...(shown ? { systemMessage: shown } : {}), ...(text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } } : {}) });
}
/** Set once per hook run (main): zero-touch acts in the chat (workflow or hand-off mode) and the call is the chat's own, not a helper's. */
let showsLines = false;

/**
 * Once a day, drop session folders older than the retention window. `logs` is swept too: nothing writes there, so
 * the records left in it age out.
 */
/** The newest change time of a folder and the files directly in it (a file appended to counts). */
function newestIn(dir) {
  let newest = statSync(dir).mtimeMs;
  try { for (const n of readdirSync(dir)) { try { newest = Math.max(newest, statSync(join(dir, n)).mtimeMs); } catch { /* gone meanwhile */ } } } catch { /* not a folder */ }
  return newest;
}

function sweepOldSessions(ctx) {
  const home = mmoHome();
  const stamp = join(home, "last-sweep");
  const dayMs = 24 * 3600 * 1000;
  try {
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < dayMs) return;
    writeFileSync(stamp, "", { mode: 0o600 });
    const keepMs = num(ctx.config.retention_days, 30, 1) * dayMs;
    for (const root of [join(home, "sessions"), join(home, "logs")]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        // By the newest file in it: a folder's own time changes only when a file is added, so a chat used every day
        // for a month would look old and lose its hand-off records and undo copies.
        if (Date.now() - newestIn(dir) > keepMs) rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch { /* housekeeping must never fail a session start */ }
}

async function main() {
  const event = process.argv[2];
  currentEvent = event;
  const handler = handlers[event];
  if (!handler) return;
  const input = await readStdinJson();
  if (!input || typeof input !== "object" || typeof input.session_id !== "string" || !input.session_id) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const { config, sources } = loadConfig({ projectDir });
  const sid = input.session_id;
  // Each chat is decided once, when it starts (lib/chat-mode.mjs): the zero-touch plugin's start hook
  // writes the chat's record at a fresh start (a new chat or /clear), so enabling or disabling that plugin in Claude
  // Code's plugin list is the switch; every moment acts on the record, so a chat is never half on and half off. A
  // chat with no record is off. MMO_AMBIENT is a one-run override for a developer or a measuring setup.
  const override = MODES.includes(process.env.MMO_AMBIENT) ? process.env.MMO_AMBIENT : undefined;
  const mode = decideChatMode({ event, source: input.source, override, sessionId: sid });
  // Undoing a hand-off is the person's own ask, and the earlier texts live only in zero-touch's records: the undo, and
  // its receipt line, work in any chat outside a running workflow, also after the person leaves Hand-off mode
  // (Workflows, Off, or a chat opened without zero-touch).
  const undoAnywhere = (event === "pre-handoff" || event === "post-handoff") && H.handoffToolName(input.tool_name) === H.UNDO_TOOL;
  if (!mode && !undoAnywhere) return;
  config.mode = mode ?? "off";

  if (breakerOpen(sid)) return;
  // A call from inside a helper agent carries agent_id; the session id is the parent chat's.
  const agent = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  const ctx = { input, sid, cwd, projectDir, config, sources, agent };
  showsLines = acts({ config }) && !agent;
  setEventAgent(agent);
  try {
    ctx.pipeline = hasSessionMarker(ctx, "pipeline");
    // A chat reopened in the middle of its workflow takes its project lock back (lib/project-lock.mjs refreshOwner).
    if (ctx.pipeline) refreshOwner(ctx.projectDir, sid);
    // Off reaches an open or reopened chat: when the person's saved settings now say Off, this
    // chat stops acting. Not while one of its workflows runs: that run keeps its own bookkeeping (its end, the
    // project lock) and the chat lets go at the first message after it. Other changes of the settings still reach new
    // chats only. The person is told at their next message, the one moment a line can be shown.
    if (!override && acts(ctx) && !ctx.pipeline && !undoAnywhere && modeInForce() === "off") {
      if (event === "prompt" && !agent) turnedOff(ctx);
      return;
    }
    // The chat's start work, if its start hook ran before the zero-touch plugin had marked the chat (startChat).
    if (event !== "session-start" && !hasSessionMarker(ctx, "started")) {
      startChat(ctx, { late: true });
    }
    await handler(ctx);
    // A line owed from before this message that nothing else carried out (aheadLine).
    if (aheadLine && !emitted) emit({});
  } catch (err) {
    recordFailure(sid, event, err);
    if (DEBUG) console.error(`[mmo zero-touch] ${event}: ${err?.stack ?? err}`);
    // Zero-touch stops acting in a chat after repeated errors (the breaker): said once, when it happens, and only
    // where a line can be shown.
    if (breakerOpen(sid) && !emitted && showsLines && SHOWS_LINE_EVENTS.has(event)) emit({ systemMessage: L.breaker() });
  }
}

/** The moments whose output can carry a line for the person (a systemMessage). */
const SHOWS_LINE_EVENTS = new Set(["prompt", "turn-end", "post-skill", "post-question", "post-handoff"]);

/**
 * The person's settings now say Off: this chat lets go of everything zero-touch held for it (its mode record,
 * a pending start, the Queue-or-Replace question, the queue, a held command, its project lock) and works as plain
 * Claude Code from here; the person reads one line with this message.
 */
function turnedOff(ctx) {
  // Chosen in this chat, where zero-touch's own saved line has said it already (zero-touch/scripts/settings-hook.mjs):
  // not said twice.
  const saidHere = existsSync(join(sessionDir(ctx.sid), "zt_off_said"));
  if (saidHere) rmSync(join(sessionDir(ctx.sid), "zt_off_said"), { force: true });
  dropChatMode(ctx.sid);
  dropRoute(ctx.sid);
  Q.dropChoice(ctx.sid);
  Q.dropQueue(ctx.sid);
  Q.dropHold(ctx.sid);
  release(ctx.projectDir, ctx.sid);
  appendEvent(ctx.sid, "session.turned_off", { said_here: saidHere || undefined });
  if (showsLines && !saidHere) emit({ systemMessage: L.turnedOff() });
}

main().catch(() => {}).finally(() => {
  // Flush stdout before leaving; process.exit() alone can cut a pipe short.
  process.stdout.write("", () => process.exit(0));
});
