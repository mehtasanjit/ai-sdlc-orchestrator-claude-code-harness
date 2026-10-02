/**
 * Zero-touch hand-off mode, the chat's side: what a hand-off chat was started with, which models do its work, and
 * what the hook says to the person and to the chat's model (docs/ambient-mode.md, "Hand-off mode").
 *
 * In a hand-off chat the chat's own model does the development; new docs, specs, plans, tests and the same change
 * repeated across files go to the hand-off policy's models through the plugin's hand-off tools. Which work a message
 * asks for is lib/handoff-route.mjs; this file holds the rest of what the hook needs:
 *
 *   - the chat's stamp (`sessions/<chat id>/handoff.json`), written once at the chat's start by the zero-touch
 *     plugin (zero-touch/scripts/start-chat.mjs): the model the chat is pinned to and the hand-off policy. Settings
 *     are never read again during the chat, so its start note, its no-switching guard and its hand-offs cannot
 *     disagree;
 *   - the models the policy gives each kind of work, asked of the workflows' own router once per chat
 *     (plugin/scripts/handoff-models.mjs) and kept beside the stamp, so a line never names a model by guess;
 *   - the model the chat is on now: what Claude Code last reported (the start moment, a model switch) or, newer than
 *     that, what the chat's transcript shows it answered with;
 *   - the one line the person sees after each message, and the reminder the chat's model gets.
 *
 * Unlike workflow mode's lines, these name models ("this goes to Flash"): in hand-off mode which model does a piece
 * of work is the thing the person wants to see.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSessionDir, sessionDir } from "./paths.mjs";
import { googleLoggedIn } from "./route-flow.mjs";
import { gitInstalled, gitRoot } from "../../lib/git.mjs";
import { lastAssistantModel } from "./transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF_MODELS = resolve(HERE, "..", "..", "handoff-models.mjs");

const STAMP = "handoff.json";
const MODELS = "handoff_models.json";
const MODEL_NOW = "model_now";

/** The hand-off tool each kind of work goes to (the mmo plugin's server registers them). */
export const HANDOFF_TOOL = { docs: "write_document", spec: "write_document", plan: "write_document", tests: "write_tests_from_cases", repeat: "repeat_edit_across_files" };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
export function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/** The kinds of hand-off work a person chooses a typist for, and the kind each hand-off work falls under. */
export const SETTING_OF = { docs: "documents", spec: "documents", plan: "documents", tests: "tests", repeat: "repeats" };
const SETTINGS = ["documents", "tests", "repeats"];
/** The route (the server's name for the kind of work) each setting is typed under. */
const WORK_OF = { documents: "docs", tests: "tests", repeats: "repeat" };

/**
 * The chat's stamp, or null when it has none or it cannot be read:
 * { chat_model, pin, admin_model, typists: { documents|tests|repeats: { typist, policy } } }.
 * typist is "flash", "sonnet" or "chat" (kept in the chat: policy null). A stamp that names one hand-off `policy` for
 * every kind reads as that policy for all three (typist "policy"). A project's own policy file is never used by
 * zero-touch, so a stamp's `policy_file` is ignored.
 */
export function readStamp(sid, env = process.env) {
  const s = readJson(join(sessionDir(sid, env), STAMP));
  if (!s || typeof s !== "object") return null;
  const policyName = (p) => (typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(p) ? p : null);
  const typists = {};
  if (s.typists && typeof s.typists === "object") {
    for (const k of SETTINGS) {
      const t = s.typists[k];
      if (t?.typist === "chat") typists[k] = { typist: "chat", policy: null };
      else if (policyName(t?.policy)) typists[k] = { typist: String(t.typist ?? "policy"), policy: t.policy };
      else return null;
    }
  } else if (policyName(s.policy)) {
    for (const k of SETTINGS) typists[k] = { typist: "policy", policy: s.policy };
  } else {
    return null;
  }
  return {
    chat_model: typeof s.chat_model === "string" && s.chat_model ? s.chat_model : null,
    pin: typeof s.pin === "string" ? s.pin : "setting",
    admin_model: typeof s.admin_model === "string" && s.admin_model ? s.admin_model : null,
    typists,
  };
}

/** Whether the person keeps this kind of hand-off work in the chat (docs, spec, plan, tests or repeat). */
export function keptInChat(stamp, kind) {
  return stamp?.typists?.[SETTING_OF[kind]]?.typist === "chat";
}

/**
 * The models this chat's hand-offs use: `{ routes: { docs, tests, repeat } }`, each `{ id, model, adapter, policy }`
 * or `{ kept: true }` for work the person keeps in the chat; or `{ error, policy }` when they cannot be named:
 * "not-built" (the plugin's server is not built on this machine), "policy" (a hand-off policy cannot be read), "busy"
 * (the router did not answer in time: a machine under heavy load, never a fault of the policy) or "stamp" (the chat
 * has no settings). Each kind is routed by its own policy (the shipped policy whose typist the person chose), asked of
 * the workflows' own router once per chat and kept; a failure is not kept, so a repaired setup, or a machine with time
 * again, works at the next message.
 */
export function handoffRoutes(sid, stamp, env = process.env, { timeoutMs = 3000, projectDir = null } = {}) {
  if (!stamp) return { error: "stamp" };
  const file = join(sessionDir(sid, env), MODELS);
  const kept = readJson(file)?.routes;
  const usable = (r) => r && (r.kept === true || (typeof r.model === "string" && r.model && typeof r.policy === "string"));
  if (kept && usable(kept.docs) && usable(kept.tests) && usable(kept.repeat)) return { routes: withGit(withGoogle(kept, env), projectDir, env) };
  const byPolicy = new Map();
  const routes = {};
  for (const setting of SETTINGS) {
    const work = WORK_OF[setting];
    const t = stamp.typists[setting];
    if (t.typist === "chat") { routes[work] = { kept: true }; continue; }
    if (!byPolicy.has(t.policy)) {
      try {
        const out = execFileSync(process.execPath, [HANDOFF_MODELS, "--policy", t.policy], { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).toString();
        byPolicy.set(t.policy, JSON.parse(out).routes);
      } catch (err) {
        // A child stopped at the time limit has no exit status (it was killed): that is the machine, not the policy.
        if (err?.code === "ETIMEDOUT" || (err?.status == null && err?.signal)) return { error: "busy", policy: t.policy };
        return { error: err?.status === 2 ? "not-built" : "policy", policy: t.policy };
      }
    }
    routes[work] = { ...byPolicy.get(t.policy)[work], policy: t.policy };
  }
  ensureSessionDir(sid, env);
  writeFileSync(file, JSON.stringify({ routes, at: new Date().toISOString() }), { mode: 0o600 });
  return { routes: withGit(withGoogle(routes, env), projectDir, env) };
}

/**
 * Tests and a repeated change are checked in a scratch copy of the project, which needs git: in a project without git,
 * or on a computer without it, those two kinds are the chat model's own from the start, said up front, never refused
 * one by one after a promise. `noGit` is "no-git" or "git-missing". Documents need no git.
 */
function withGit(routes, projectDir, env) {
  const needsGit = (r) => Boolean(r && !r.kept);
  if (!projectDir || (!needsGit(routes.tests) && !needsGit(routes.repeat))) return routes;
  const cause = !gitInstalled({ env }) ? "git-missing" : !gitRoot(projectDir) ? "no-git" : null;
  if (!cause) return routes;
  const out = { ...routes };
  for (const work of ["tests", "repeat"]) if (needsGit(routes[work])) out[work] = { ...routes[work], noGit: cause };
  return out;
}

/**
 * The routes as they can be used right now. A kind whose model is one of Google's (Flash 3.8) cannot be
 * handed off while this computer has no Google login, by mmo's own rule (route-flow.mjs googleLoggedIn, the one the
 * workflow start uses): its route gets `noGoogle: true`, and that kind is done by the chat's own model, as the start
 * message promised ("work set to Flash 3.8 is done by this chat's model instead").
 * Checked at every use and never kept in the chat's file, so a person who connects Google mid-chat hands off again at
 * the next message. Offline: a login that has expired is caught at the call, where the ladder's last attempt covers it.
 */
function withGoogle(routes, env) {
  const needsGoogle = (r) => Boolean(r && !r.kept && /^gemini-/.test(String(r.model ?? "")));
  if (!Object.values(routes).some(needsGoogle) || googleLoggedIn(env)) return routes;
  const out = {};
  for (const [work, r] of Object.entries(routes)) out[work] = needsGoogle(r) ? { ...r, noGoogle: true } : r;
  return out;
}

/** Keeps the model Claude Code just said the chat is on (a model switch). */
export function recordModelNow(sid, model, env = process.env) {
  const name = canonicalModel(model);
  if (!name) return;
  writeFileSync(join(ensureSessionDir(sid, env), MODEL_NOW), name, { mode: 0o600 });
}

/**
 * The model the chat is on now, or null when nothing says. Two witnesses: what Claude Code last reported (kept at the
 * chat's start and at every model switch), and the model the chat's transcript shows it last answered with. The
 * newer one wins: an older Claude Code has no model-switch hook, and then only the transcript sees a switch.
 */
export function chatModelNow(sid, transcriptPath, env = process.env) {
  let kept = null;
  let keptAt = 0;
  try {
    const file = join(sessionDir(sid, env), MODEL_NOW);
    kept = readFileSync(file, "utf8").trim() || null;
    keptAt = statSync(file).mtimeMs;
  } catch { /* nothing reported */ }
  const seen = lastAssistantModel(transcriptPath);
  if (seen && (!kept || seen.at > keptAt)) return canonicalModel(seen.model) || kept;
  return kept;
}

/**
 * A model's name as a person reads it, with its version: "claude-opus-5" is Opus 5, "claude-sonnet-5" Sonnet 5,
 * "gemini-3.8-flash" Flash 3.8. An id of another shape is shown as it is, never guessed at.
 */
export function displayName(modelId) {
  const name = canonicalModel(modelId);
  const claude = /^claude-([a-z]+)-(\d+(?:[.-]\d+)?)(?:-\d{8})?$/.exec(name);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2].replace("-", ".")}`;
  const gemini = /^gemini-([\d.]+)-([a-z]+(?:-[a-z]+)*)$/.exec(name);
  if (gemini) return `${gemini[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")} ${gemini[1]}`;
  return name;
}

/**
 * Who the chat is, for a line: `name` (its model, or null when its model is not known) and `reminder`, the sentence
 * added to every line while the chat is on another model than the one it is kept on.
 */
export function chatState(stamp, model) {
  const pin = stamp?.chat_model ?? null;
  const offPin = Boolean(pin && model && model !== pin);
  return {
    // A model is named only when Claude Code said which one the chat is on: never guessed from the pin.
    name: model ? displayName(model) : null,
    reminder: offPin ? ` This chat is on ${displayName(model)}, not ${displayName(pin)}: switch it using the model menu next to the message box (in the terminal, type /model ${pin}).` : "",
  };
}

const LABEL = "Zero-touch:";
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const who = (chat) => chat.name ?? "the chat's model";
/** Why hand-off cannot run, in the person's words. */
function unavailableWhy(found) {
  if (found.error === "google") return "this computer isn't connected to Google";
  // The plugin ships its server pre-built: only a damaged copy lacks it, and reinstalling fixes it.
  if (found.error === "not-built") return "part of zero-touch is missing on this computer (reinstalling zero-touch from your plugins fixes it)";
  if (found.error === "policy") return "the models for this work can't be read";
  if (found.error === "busy") return "the computer was too busy to check; ask again";
  return "this chat's hand-off settings can't be read";
}

/**
 * What the person reads when a hand-off tool call is refused: Claude Code shows a refusal's reason to the
 * person (in red in the desktop app), so it is one plain sentence; what the model must do goes separately.
 */
/** What the model is told when a hand-off's check command is one the person's settings forbid. */
export function commandDeniedReason(command, rule) {
  return `This hand-off was refused: its command \`${String(command).slice(0, 300)}\` is forbidden by the person's Claude settings (${rule}), and the hand-off tools run their command outside your Bash tool's rules. Do not hand this work off with that command, and do not run it another way. Do the work yourself in the chat, and tell the person in one sentence that the check command is not allowed by their settings.`;
}

/**
 * Shown with a new document or an undo that zero-touch lets through without Claude Code's permission prompt (hook.mjs
 * "pre-handoff"): neither runs a command.
 */
export const HANDOFF_ALLOWED = "Zero-touch: handing this work off, as your Hand-off settings say. It is checked before anything reaches your project.";
/** Shown with an undo zero-touch lets through. */
export const HANDOFF_UNDO_ALLOWED = "Zero-touch: taking back the hand-off you asked to undo.";

/** What Claude reads when a hand-off is refused because another chat's workflow holds the project. */
export const BUSY_REASON = "Another chat in this project folder is running a workflow, so no hand-off lands now: it would write files beside that workflow's own. Do this work yourself, with your own tools (the workflow's file rules still apply to your writes), and tell the person in one plain line why it was not handed off.";

export const HANDOFF_REFUSAL = {
  // Another chat's workflow holds the project.
  busy: (job) => `${LABEL} this can't be handed off right now, because another chat in this project folder is running a ${job ?? "workflow"}, so Claude does it in the chat.`,
  // A check command the person's Claude settings forbid: never run, by the server or anyone.
  commandDenied: "Zero-touch: this hand-off wasn't run, because the command it would run to check the work is one your Claude settings don't allow. Claude does the work in the chat instead.",
  notHandoffChat: `${LABEL} hand-offs work only in a Hand-off chat, so Claude does this itself.`,
  inWorkflow: `${LABEL} hand-offs don't run inside a workflow, so the workflow carries on with its own steps.`,
  keptInChat: `${LABEL} you keep this kind of work in the chat, so Claude does it itself.`,
  noGoogle: `${LABEL} this can't be handed off, because this computer isn't connected to Google, so Claude does it in the chat.`,
  // No git for the test copy.
  noGit: (cause) => `${LABEL} this can't be handed off here, because ${cause === "git-missing" ? "git isn't installed on this computer" : "this project isn't set up with git"}, so Claude does it in the chat.`,
  unavailable: (found) => `${LABEL} this can't be handed off here, because ${unavailableWhy(found)}, so Claude does it in the chat.`,
};

/** The kinds of written work (a README, a design doc, release notes are all documents to the person). */
const WRITTEN = new Set(["docs", "spec", "plan"]);

/**
 * The one line the person sees after a message they typed in a hand-off chat. It is the hook's `systemMessage`, which
 * Claude Code shows in the chat and never gives the model, so it appears every time and cannot be reworded.
 */
export const HANDOFF_LINE = {
  /** Nothing is handed off: the chat's model does the work. */
  chatHandles: (chat) => `${LABEL} this isn't the kind of work zero-touch hands off (new documents, specs, plans, tests, or one change repeated in many files), so ${who(chat)} does it directly.${chat.reminder}`,
  /** Hand-off work, one sentence per kind; `routes` names the model each goes to, or that the person keeps it in the chat. */
  handoff({ kinds, rest }, routes, chat) {
    const me = who(chat);
    const route = (k) => routes[WRITTEN.has(k) ? "docs" : k];
    // Every kind asked for needs Google, and this computer has no Google login: the same "can't be handed off" line
    // as for any other reason.
    if (kinds.length && kinds.every((k) => route(k)?.noGoogle)) return HANDOFF_LINE.unavailable({ error: "google" }, chat);
    const sentences = [];
    const written = kinds.filter((k) => WRITTEN.has(k));
    // One kind that needs Google beside others that do not: that kind in the same words, the others as usual.
    const noGoogle = (what, verb) => `${what} can't be handed off right now, because this computer isn't connected to Google, so ${me} ${verb} directly.`;
    if (written.length) {
      const what = written.length > 1 ? "documents" : "document";
      sentences.push(routes.docs?.kept
        ? `new documents are set to stay in this chat (your setting), so ${me} writes the new ${what} directly.`
        : routes.docs?.noGoogle ? noGoogle(`the new ${what}`, `writes ${written.length > 1 ? "them" : "it"}`)
          : `${me} will collect the facts and give ${displayName(routes.docs.model)} instructions to write the new ${what}. It's checked automatically before it's added to your project.`);
    }
    // No git here: tests and a repeated change are checked in a test copy, which needs git.
    const noGit = (what, verb, cause) => `${what} can't be handed off here, because ${cause === "git-missing" ? "git isn't installed on this computer" : "this project isn't set up with git"}, and the test copy they're checked in needs it, so ${me} ${verb} directly.`;
    if (kinds.includes("tests")) {
      sentences.push(routes.tests?.kept
        ? `new tests are set to stay in this chat (your setting), so ${me} writes them directly.`
        : routes.tests?.noGit ? noGit("new tests", "writes them", routes.tests.noGit)
        : routes.tests?.noGoogle ? noGoogle("the new tests", "writes them")
          : `${me} will decide what to test, and ${displayName(routes.tests.model)} will write the tests. They're run in a test copy of your project first, and only added if the result is the expected one.`);
    }
    if (kinds.includes("repeat")) {
      sentences.push(routes.repeat?.kept
        ? `the same change in many files is set to stay in this chat (your setting), so ${me} makes it directly.`
        : routes.repeat?.noGit ? noGit("the same change in many files", "makes it", routes.repeat.noGit)
        : routes.repeat?.noGoogle ? noGoogle("the same change in many files", "makes it")
          : `${me} will make the change in one file, and ${displayName(routes.repeat.model)} will repeat it in the others. If your project has an automatic check (such as its tests), it's run on a test copy first, and nothing is changed unless it passes.`);
    }
    if (rest) sentences.push(`${me} does the rest directly.`);
    return `${LABEL} ${sentences.map((x, i) => (i ? capital(x) : x)).join(" ")}${chat.reminder}`;
  },
  /** Hand-off work was asked for but cannot run here. */
  unavailable: (found, chat) => `${LABEL} this can't be handed off right now, because ${unavailableWhy(found)}. So ${who(chat)} does it directly.${chat.reminder}`,
};

/** What the chat's model reads with a message that asks for hand-off work: which tool takes which part. */
export function handoffInstruction({ kinds, rest }, routes = {}) {
  const parts = [];
  const kept = [];
  const offline = [];
  const noGitWork = [];
  const place = (route, what, handed) => (route?.kept ? kept.push(what) : route?.noGit ? noGitWork.push(what) : route?.noGoogle ? offline.push(what) : parts.push(handed));
  const written = kinds.filter((k) => WRITTEN.has(k));
  if (written.length) {
    const what = written.map((k) => ({ docs: "document", spec: "spec", plan: "planning text" })[k]).join(" and ");
    place(routes.docs, `the new ${what}`, `the new ${what}: gather its facts, then one ${HANDOFF_TOOL.docs} call for each file`);
  }
  if (kinds.includes("tests")) place(routes.tests, "the new tests", `the new tests: decide the cases yourself, then one ${HANDOFF_TOOL.tests} call`);
  if (kinds.includes("repeat")) place(routes.repeat, "the same change in several files", `the same change in several files: make it yourself in one file, then one ${HANDOFF_TOOL.repeat} call for the others`);
  const lines = [];
  if (parts.length) {
    lines.push(
      `The person's message asks for hand-off work. Hand it off instead of typing it yourself: ${parts.join("; ")}. ` +
      "Fill in every field of the tool's form with exact facts from the project; the form is a brief, never the finished text.",
    );
  }
  if (kept.length) lines.push(`The person keeps this work in the chat: do it yourself, with your own tools: ${kept.join("; ")}.`);
  if (offline.length) lines.push(`This computer is not connected to Google, so this work cannot be handed off (the person has been told): do it yourself, with your own tools: ${offline.join("; ")}.`);
  if (noGitWork.length) lines.push(`This project cannot use a git test copy (it is not set up with git, or git is not installed), so this work cannot be handed off (the person has been told): do it yourself, with your own tools: ${noGitWork.join("; ")}.`);
  if (rest) lines.push("The rest of the message is yours to do.");
  if (parts.length) lines.push("If the work turns out not to be of this kind, or the hand-off tool is not in your tool list, do it yourself and say so in one line.");
  return lines.join(" ");
}

/** What the chat's model reads when hand-off work was asked for but cannot run here. */
export function unavailableInstruction(found) {
  return `Hand-off cannot run in this chat: ${unavailableWhy(found)}. Do this work yourself, and tell the person in one plain line that it was not handed off and why.`;
}

// ─── Around a hand-off tool call ────────────────────────────────────────

const TOOL_NAME = /^mcp__(?:plugin_mmo_)?model-dispatch__([a-z_]+)$/;
/** The undo sends nothing to a model: it needs the chat, not the chat's models. */
export const UNDO_TOOL = "undo_hand_off";
const HANDOFF_TOOLS = new Set([...Object.values(HANDOFF_TOOL), UNDO_TOOL]);

/** The hand-off tool a tool call names ("write_document"), installed as a plugin or run from a clone; null for any other tool. */
export function handoffToolName(toolName) {
  const m = TOOL_NAME.exec(String(toolName ?? ""));
  return m && HANDOFF_TOOLS.has(m[1]) ? m[1] : null;
}

/**
 * The tool call with the hook's stamp on it. The stamp names the chat, the project folder and who pays for a Claude
 * typist; the server reads everything else about the chat from the chat's own records, so nothing the model writes
 * in a call can choose a policy or a model. A `_mmo` the model wrote is always replaced: `updatedInput` replaces the
 * whole input, so every other field is carried over as it was.
 */
export function stampedInput(toolInput, { sessionId, projectDir, auth, toolUseId = null }) {
  const base = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? { ...toolInput } : {};
  // `tool_use_id`: the call's own id, so the server can tell this call was interrupted
  // (interruptedCall below) and never land it.
  base._mmo = { session_id: sessionId, project_dir: projectDir, auth: auth === "vendor" ? "vendor" : "estimated", ...(typeof toolUseId === "string" && toolUseId ? { tool_use_id: toolUseId } : {}) };
  return base;
}

// ─── Records the hooks and the server share for one chat ───────────────

const RELEASED_FILE = "handoff_released.json";
const STOPPED_FILE = "handoff_stopped.json";
const INTERRUPTED_FILE = "handoff_interrupted.json";
const TURN_FILE = "handoff_turn.json";
const CLAIMED_FILE = "handoff_claimed.json";

function writeJsonFile(sid, name, value, env) {
  writeFileSync(join(ensureSessionDir(sid, env), name), JSON.stringify(value), { mode: 0o600 });
}
const list = (sid, name, env) => { const v = readJson(join(sessionDir(sid, env), name)); return Array.isArray(v) ? v : []; };

/** Hands a new file back to the chat's model (the server's handoff/chat.ts releasePath, same file). */
export function releasePath(sid, path, env = process.env) {
  if (typeof path !== "string" || !path) return;
  const all = new Set(list(sid, RELEASED_FILE, env).filter((x) => typeof x === "string"));
  if (all.has(path)) return;
  all.add(path);
  writeJsonFile(sid, RELEASED_FILE, [...all].sort(), env);
}

/**
 * A hand-off call the person interrupted (PostToolUseFailure with is_interrupt): kept by its call id, which the server
 * reads before it lands anything (handoff/chat.ts callInterrupted). Claude Code may not tell the server itself that the
 * call was cancelled.
 */
export function markInterrupted(sid, toolUseId, env = process.env) {
  if (typeof toolUseId !== "string" || !toolUseId) return;
  const all = list(sid, INTERRUPTED_FILE, env).filter((x) => typeof x === "string");
  if (!all.includes(toolUseId)) writeJsonFile(sid, INTERRUPTED_FILE, [...all.slice(-49), toolUseId], env);
}

/** Hand-offs the person stopped, written by the server (handoff/chat.ts recordStopped); read once and removed. */
export function takeStopped(sid, env = process.env) {
  const file = join(sessionDir(sid, env), STOPPED_FILE);
  const all = list(sid, STOPPED_FILE, env).filter((e) => e && Array.isArray(e.files));
  if (all.length) try { rmSync(file, { force: true }); } catch { /* said again next time: harmless */ }
  return all;
}

/** The line for hand-offs the person stopped. */
export function stoppedLine(entries) {
  const files = [...new Set(entries.flatMap((e) => e.files))];
  const cost = entries.reduce((s, e) => s + (typeof e.cost_usd === "number" ? e.cost_usd : 0), 0);
  const what = files.length === 1 ? files[0] : `${files.length} files`;
  return `${LABEL} the hand-off of ${what} was stopped, as you asked, and nothing was added to your project (estimated cost so far: ${dollars(cost)}).`;
}

/**
 * What the person's message in this turn asked of hand-off mode: the kinds it asked to hand off, or `own` when they
 * asked Claude to do the work itself. The safety net claims a new file only for a kind the turn asked to hand off, and
 * never when the person asked for it to be done in the chat.
 */
export function writeTurn(sid, turn, env = process.env) {
  writeJsonFile(sid, TURN_FILE, { kinds: Array.isArray(turn.kinds) ? turn.kinds : [], own: turn.own === true, at: new Date().toISOString() }, env);
}
export function readTurn(sid, env = process.env) {
  const v = readJson(join(sessionDir(sid, env), TURN_FILE));
  return v && typeof v === "object" && Array.isArray(v.kinds) ? v : null;
}

/**
 * "Write it yourself", "do it on your own", "write it in this chat", "just write it here", "write it directly", "you
 * write it", "don't hand it off", "don't send it to Flash", "skip the hand-off", "don't use the hand-off", "no need for
 * a hand-off" (a curly apostrophe and "handoff" included): the person wants this message's work done in the chat.
 * "Here" and "directly" count only after it/this/that/them, so "write a README here" (a place) still hands off.
 */
export const DO_IT_YOURSELF = /(?:\b(?:write|do|make|type|create|handle|draft|code)\s+(?:[\w.\/'’-]+\s+){0,5}?(?:yourself|by\s+yourself|on\s+your\s+own|in\s+(?:the\s+|this\s+)?chat)\b|\bdo\s+it\s+(?:yourself|here|in\s+(?:the\s+|this\s+)?chat)\b|\b(?:write|make|type|create|handle|draft|code)\s+(?:it|this|that|them)\s+(?:here|directly)\b|(?:^|[.!?,;:]\s*)(?:ok(?:ay)?[,\s]+|just\s+|then\s+)?you\s+(?:can\s+)?(?:write|draft|code)\s+(?:it|this|that|them)\b|\bskip\s+(?:the\s+)?hand-?\s?offs?\b|\b(?:don['’]?t|do\s+not)\s+use\s+(?:the\s+|a\s+)?hand-?\s?offs?\b|\bno\s+need\s+(?:for|of)\s+(?:a\s+|the\s+|any\s+)?hand-?\s?offs?\b|\b(?:don['’]?t|do\s+not|no\s+need\s+to|never|stop)\s+(?:hand(?:ing)?|send(?:ing)?|giv(?:e|ing)|pass(?:ing)?)\s*(?:it|this|that|them)?\s*(?:off|over|to\s+(?:flash|sonnet|gemini|another\s+model|the\s+other\s+model))\b|\b(?:don['’]?t|do\s+not)\s+hand-?\s?off\b|\bno\s+hand-?\s?offs?\b|\bwithout\s+(?:a\s+)?hand-?\s?off\b)/i;

/**
 * Files the safety net has refused in this chat: the person was told the hand-off model writes them, so they stay
 * claimed across messages, whatever the later messages ask, until they are handed off (then they exist), handed back,
 * or the person asks for them in the chat.
 */
export function claimPath(sid, path, env = process.env) {
  const all = list(sid, CLAIMED_FILE, env).filter((x) => typeof x === "string");
  if (!all.includes(path)) writeJsonFile(sid, CLAIMED_FILE, [...all.slice(-199), path], env);
}
export function claimedPaths(sid, env = process.env) {
  return list(sid, CLAIMED_FILE, env).filter((x) => typeof x === "string");
}

/**
 * A short reply to the hand-off ("ok", "yes, hand it off", "thanks"): it asks for nothing new, so the hand-off work the
 * message before it asked for stays asked.
 */
export function replyToHandoff(text) {
  const t = String(text ?? "").trim().toLowerCase();
  return Boolean(t) && t.split(/\s+/).length <= 8 && !t.includes("?") && /^(?:yes|yeah|yep|ok|okay|sure|go|go ahead|do it|please|hand it off|thanks|thank you|right|fine|good|great|perfect|cool)\b/.test(t) && !DO_IT_YOURSELF.test(t);
}


/**
 * The chat's own earlier text of a file it is about to edit: kept once, before the chat's first
 * edit of it, so a repeated change copies exactly the chat's own edit, never the person's uncommitted work. The
 * server's handoff/chat.ts beforeSnapshotFile names it the same way.
 */
export function beforeSnapshotFile(sid, relPath, env = process.env) {
  return join(sessionDir(sid, env), "handoff_before", createHash("sha256").update(relPath).digest("hex").slice(0, 32));
}
const SNAPSHOT_MAX_BYTES = 2 << 20;
export function keepBefore(sid, absPath, relPath, env = process.env) {
  try {
    const target = beforeSnapshotFile(sid, relPath, env);
    if (existsSync(target)) return false;
    const st = statSync(absPath);
    if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return false;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(absPath, target);
    return true;
  } catch { return false; }
}

/** The JSON a plugin tool answered with, as Claude Code hands it to a hook: a string, a content list, or the object itself. */
export function toolReceipt(resp) {
  const parse = (t) => { try { const v = JSON.parse(t); return v && typeof v === "object" ? v : null; } catch { return null; } };
  const text = (list) => { const t = list.find((c) => c && c.type === "text" && typeof c.text === "string"); return t ? parse(t.text) : null; };
  if (typeof resp === "string") return parse(resp);
  if (Array.isArray(resp)) return text(resp);
  if (resp && typeof resp === "object") return Array.isArray(resp.content) ? text(resp.content) : resp;
  return null;
}

/** Dollars as a person reads them: cents, or four places for an amount under one cent's worth of rounding. */
// Every figure is called an estimate: it is the models' list price for the tokens used, which a
// person on a Claude plan does not pay as such (the plan's limits are used instead).
function dollars(n) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The reasons a Claude typist gives when this computer's `claude` sign-in can no longer be used: an expired or
 * missing login, or a rejected key, as `claude -p` reports them.
 */
const SIGN_IN_FAILED = /failed to authenticate|oauth (?:session|token)[^.]*(?:expired|revoked)|not (?:logged|signed) in|please run \/login|authentication_error|invalid (?:x-)?api[ -]?key/i;

/**
 * The one line the person sees after a hand-off tool call, written from the tool's receipt: what was written or
 * changed, by which model and what it cost, and how to undo it; that the chosen model failed and another did the
 * work; that the hand-off failed and the chat's model does the work itself; that the brief was incomplete; or that a
 * hand-off was undone. Null for a reply that is no receipt.
 */
export function receiptLine(receipt, chat, { documentsHandedOff = false } = {}) {
  if (!receipt || typeof receipt.status !== "string") return null;
  const me = who(chat);
  // The project is not set up with git: plain words, not the server's reason. Tests and a repeated
  // change are tried in a test copy first, and git is what tells the project's own files from downloaded packages.
  // "New documents can still be handed off" is said only when this chat hands documents off.
  if (receipt.status === "refused" && receipt.cause === "no-git") {
    return `${LABEL} this can't be handed off here, because the test copy it needs only works in a project set up with git. So ${me} does it directly.${documentsHandedOff ? " (New documents can still be handed off.)" : ""}`;
  }
  // git itself is not installed (on a Mac, Apple's developer tools are missing): said as such, never
  // blamed on the project.
  if (receipt.status === "refused" && receipt.cause === "git-missing") {
    return `${LABEL} this can't be handed off here, because the test copy it needs uses git, which isn't installed on this computer. So ${me} does it directly.${documentsHandedOff ? " (New documents can still be handed off.)" : ""}`;
  }
  const Me = capital(me);
  const cost = dollars(receipt.cost_usd);
  const routed = displayName(receipt.routed_model);
  // How to take a landing back: going back in the chat (rewind) does not remove a hand-off's files, because the
  // plugin's server writes them, not Claude's own editing tools.
  // Named by its file, never by an id the person cannot know (the undo tool takes the file and finds its latest
  // hand-off). A change repeated in many files is named by its first file, and every file of it is taken back together.
  const files = typeof receipt.file === "string" && receipt.file ? [receipt.file] : Array.isArray(receipt.changed) ? receipt.changed.filter((f) => typeof f === "string") : [];
  const undo = typeof receipt.id === "string" && receipt.id
    ? files.length === 1 ? ` To undo it, ask Claude to undo the hand-off of ${files[0]} (going back in the chat doesn't undo it).`
      : files.length > 1 ? ` To undo it, ask Claude to undo the hand-off of ${files[0]}; all ${files.length} files are taken back together (going back in the chat doesn't undo it).`
        : ` To undo it, ask Claude to undo hand-off ${receipt.id} (going back in the chat doesn't undo it).`
    : "";
  // The person stopped it.
  if (receipt.status === "stopped") return stoppedLine([receipt]);
  // Someone else created the file while the hand-off ran: never written over.
  if (receipt.status === "failed" && receipt.cause === "appeared" && typeof receipt.file === "string") {
    return `${LABEL} ${receipt.file} was created by someone else while the hand-off was running, so nothing was written over it (estimated cost: ${cost}). ${Me} will ask you what to do.`;
  }
  if (receipt.status === "written" && typeof receipt.file === "string") {
    const by = displayName(receipt.written_by);
    // A regression test written before the fix: it fails until the bug is fixed, as meant.
    const failing = receipt.fails_until_fixed === true ? ` Its tests fail for now, as expected, until ${me} fixes the bug.` : "";
    return receipt.routed_model && receipt.written_by !== receipt.routed_model
      ? `${LABEL} ${routed} couldn't write ${receipt.file}, so ${by} wrote it. It was checked automatically.${failing} Estimated cost: ${cost}.${undo}`
      : `${LABEL} ${receipt.file} was written by ${by} and checked automatically.${failing} Estimated cost: ${cost}.${undo}`;
  }
  // Every file of the hand-off changed since: nothing was undone, and the person decides.
  if (receipt.status === "kept" && Array.isArray(receipt.changed_since)) {
    // Named by its file, as the person asked for it.
    const what = receipt.changed_since.length ? `the hand-off of ${receipt.changed_since[0]}` : `hand-off ${receipt.id}`;
    return `${LABEL} ${what} wasn't undone, because ${receipt.changed_since.length === 1 ? "its file has" : `its ${receipt.changed_since.length} files have`} been changed since. ${Me} will ask you whether to undo it anyway.`;
  }
  if (receipt.status === "landed" && Array.isArray(receipt.changed)) {
    // A repeated change: how many files it reached, whether a command checked them, and what is left for the chat.
    if (!receipt.changed.length && !(receipt.failed ?? []).length) return `${LABEL} no file needed the change. Estimated cost: ${cost}.`;
    const helped = receipt.by_fallback ? ` (${count(receipt.by_fallback, "file")} by ${displayName(receipt.fallback_model)} after ${routed} failed)` : "";
    const checked = String(receipt.check ?? "").startsWith("not run") ? "no automatic check was available" : "your project's check passed on a test copy";
    const left = (receipt.failed ?? []).length ? ` ${count(receipt.failed.length, "file")} still ${receipt.failed.length === 1 ? "needs" : "need"} the change, and ${me} will do ${receipt.failed.length === 1 ? "it" : "them"}.` : "";
    return `${LABEL} ${routed} made the change in ${count(receipt.changed.length, "file")}${helped}, and ${checked}. Estimated cost: ${cost}.${undo}${left}`;
  }
  // A hand-off to a Claude model runs through this computer's `claude` command and its sign-in. When that sign-in has
  // expired every attempt fails the same way, so the line names the cause and the one step that fixes it, instead
  // of a bare "didn't work" the person cannot act on.
  const signInExpired = receipt.status === "failed" && SIGN_IN_FAILED.test(String(receipt.reason ?? ""));
  if (signInExpired) {
    const what = typeof receipt.file === "string" ? `the hand-off of ${receipt.file}` : "the repeated change";
    return `${LABEL} ${what} didn't run: the Claude sign-in this computer uses for ${routed} has expired, so nothing was added (estimated cost: ${cost}). To fix it, sign in again: in a terminal, run claude and type /login. ${Me} will ${typeof receipt.file === "string" ? "write it" : "make the change"} directly now.`;
  }
  if (receipt.status === "failed" && typeof receipt.file === "string") {
    // Tests that ran and did not pass are not a typing failure: the output may show a real bug.
    if (receipt.kind === "tests" && typeof receipt.output === "string") return `${LABEL} the new tests in ${receipt.file} didn't pass in the test copy (estimated cost: ${cost}), so nothing was added. ${Me} will look at why: if a test was wrong, it fixes the test; if the code has a real bug, it tells you.`;
    return `${LABEL} the hand-off of ${receipt.file} didn't work (estimated cost so far: ${cost}), and nothing was added to your project. ${Me} will write it directly now.`;
  }
  if (receipt.status === "failed") {
    // A file changed while the hand-off ran is never written over: said in those words.
    const meanwhile = Array.isArray(receipt.changed_meanwhile) && receipt.changed_meanwhile.length;
    const why = meanwhile ? `${count(receipt.changed_meanwhile.length, "file")} changed while it was running` : typeof receipt.output === "string" ? "your project's check failed on the test copy" : "it couldn't be handed off";
    return `${LABEL} the change couldn't be repeated safely (${why}; estimated cost: ${cost}), so nothing was changed. ${Me} will make the change directly.`;
  }
  if (receipt.status === "undone" && Array.isArray(receipt.restored)) {
    const left = (receipt.left_alone ?? []).length ? ` (${count(receipt.left_alone.length, "file")} had been changed again since, so ${receipt.left_alone.length === 1 ? "it was" : "they were"} left as ${receipt.left_alone.length === 1 ? "it is" : "they are"}.)` : "";
    const what = receipt.restored.length ? `the hand-off of ${receipt.restored[0]}` : `hand-off ${receipt.id}`;
    return `${LABEL} ${what} was undone: ${count(receipt.restored.length, "file")} ${receipt.restored.length === 1 ? "is" : "are"} back as ${receipt.restored.length === 1 ? "it was" : "they were"}.${left}`;
  }
  if (receipt.status === "refused") {
    // A form refused twice, or for something the form cannot fix, hands the file back.
    if (Array.isArray(receipt.problems) && receipt.handed_back) return `${LABEL} ${receipt.handed_back} couldn't be handed off, so nothing was sent and nothing was charged. ${Me} will write it directly.`;
    if (Array.isArray(receipt.problems)) return `${LABEL} ${me}'s instructions for the hand-off were missing ${count(receipt.problems.length, "thing")}, so nothing was sent and nothing was charged. ${Me} is fixing them and will try again.`;
    // An undo that found nothing to undo: plain words, never the server's own reason.
    if (receipt.cause === "unknown-id") return `${LABEL} there's no hand-off ${receipt.id} in this project, so nothing was undone.`;
    // An undo by file that found none.
    if (receipt.cause === "no-id") return typeof receipt.file === "string" && receipt.file ? `${LABEL} there's no hand-off of ${receipt.file} to undo in this project, so nothing was undone.` : `${LABEL} nothing was undone: say which file's hand-off to take back.`;
    if (receipt.cause === "already-undone") return `${LABEL} hand-off ${receipt.id} was already undone, so nothing changed.`;
    if (receipt.cause === "other-project") return `${LABEL} hand-off ${receipt.id} was made in another project, so nothing was undone here.`;
    // Any other refusal: plain words only, never the server's own reason; Claude reads the reason in the reply.
    return `${LABEL} this couldn't be handed off here, so nothing was sent and nothing was charged. ${Me} does it directly.`;
  }
  return null;
}

/** The project files a failed hand-off handed back to the chat's model (written by the server, handoff/chat.ts). */
export function releasedPaths(sid, env = process.env) {
  const v = readJson(join(sessionDir(sid, env), "handoff_released.json"));
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** What the net says for each kind of file: the tool that takes it, its form's fields, and the person's word for it. */
const BY_HAND = {
  document: { tool: HANDOFF_TOOL.docs, form: "kind, file, purpose, readers, sections, facts", word: "document" },
  tests: { tool: HANDOFF_TOOL.tests, form: "file, target, functions, cases, test_command", word: "test file" },
};

/** What the chat's model reads when a new document or test file it typed by hand is refused. */
export function byHandReason(path, kind) {
  const k = BY_HAND[kind];
  return (
    `In this chat a new ${k.word} is not typed by hand: hand ${path} to the ${k.tool} tool (its form: ${k.form}), which has it written and checked. ` +
    "If the hand-off fails, the tool hands the file back and you write it yourself. A change to a file that exists is yours to make. " +
    // A chat reopened after the settings changed may have no hand-off tools listed. The refusal holds every time (a
    // file the person set to hand off is never written by hand without their word), so Claude says so and the person
    // decides; "write it yourself" lets it through (DO_IT_YOURSELF).
    `This refusal holds every time. If ${k.tool} is not in your tool list, do not write ${path}: tell the person in one plain line that it cannot be handed off in this chat, and that they can say "write it yourself" or start a new chat.`
  );
}

/** The line the person sees with that refusal. `chat` names the chat's model; `typist` the model the work goes to. */
// The way out is said every time: the refusal holds until the file is handed off or the person asks
// for it in the chat, so it must say how to ask.
export const byHandLine = (path, kind, chat = { name: null }, typist = null) =>
  `${LABEL} ${who(chat)} started writing the new ${BY_HAND[kind].word} ${path} itself. In Hand-off mode that work goes to ${typist ? displayName(typist) : "the hand-off"}, so zero-touch stopped it and told ${who(chat)} to hand it off. To have it written here instead, say "write it yourself".`;

/**
 * Hand-off mode's model rule, the same as Workflows': the chat's real model (chatModelNow) must be the one the person
 * chose; while it is not, nothing is handed off and nothing of that kind is typed by hand.
 */
export const wrongModelLine = (have, want) => `${LABEL} this chat is on ${displayName(have)}, but you chose ${displayName(want)} to do the development in Hand-off mode, so nothing is handed off until you switch this chat to ${displayName(want)} with the model menu next to the message box (in the terminal, type /model ${want}). Then ask again.`;
export const wrongModelReason = (have, want) => `This chat is on ${have}, and the person chose ${want} to do the development in Hand-off mode, so zero-touch hands nothing off until the chat is switched. Do not do this work yourself and do not call the hand-off tools: in one short sentence, tell the person to switch this chat to ${displayName(want)} with the model menu, then ask again. If asked which model you are, you are ${have}.`;
/** Said once per model, at the first message where the chat is seen on another model than the person chose. */
export const wrongModelWarning = (have, want) => `${LABEL} this chat is on ${displayName(have)}, but you chose ${displayName(want)} to do the development in Hand-off mode. Switch it with the model menu next to the message box (in the terminal, type /model ${want}); until then, nothing is handed off.`;
export const wrongModelNote = (have, want) => `This chat is on ${have}; the person chose ${want} for Hand-off mode, so nothing is handed off until they switch, and they have been told how. If asked which model you are, you are ${have}, not ${want}.`;

/** What the model reads when a hand-off tool is called where hand-off mode does not act. */
export const NOT_A_HANDOFF_CHAT = "The hand-off tools work only in a chat that started in zero-touch hand-off mode. Do this work yourself.";
export const NOT_IN_A_WORKFLOW = "The hand-off tools are not available inside a workflow run. Carry on with the workflow's own steps.";

/** What the model reads when it calls a hand-off tool for work the person keeps in the chat. */
export const KEPT_IN_CHAT_REASON = "The person keeps this kind of work in the chat (their zero-touch setting), so it is not handed off. Do it yourself, with your own tools.";
/** A hand-off tool called for tests or a repeated change where there is no git for the test copy. */
export const NO_GIT_REASON = "This project cannot use a git test copy (it is not set up with git, or git is not installed), so tests and repeated changes cannot be checked and are not handed off here. Do it yourself, with your own tools, and tell the person in one plain line why it was not handed off.";

/** A hand-off tool called for a kind whose model needs Google, on a computer with no Google login. */
export const NO_GOOGLE_REASON = "This kind of work goes to a Google model, and this computer is not connected to Google, so it cannot be handed off now. Do it yourself, with your own tools, and tell the person in one plain line that it was not handed off because Google is not connected.";

/** Guard B's refusal in a hand-off chat, for a workflow the chat tried to start by itself. */
export const TYPED_ONLY_REASON = "In this chat no full workflow starts from the person's plain words: do the work yourself, with your own tools.";

/** What the person reads when a switch to another model is refused. */
export function switchRefusal(stamp) {
  const model = displayName(stamp.chat_model);
  if (stamp.pin === "admin") return `Zero-touch hand-off mode keeps this chat on ${model}, the model your organisation set.`;
  return `Zero-touch keeps this Hand-off chat on ${model}, the chat model you chose, because it does the development and decides the hand-offs. To use a different model, type "change zero-touch settings", then start a new chat.`;
}

