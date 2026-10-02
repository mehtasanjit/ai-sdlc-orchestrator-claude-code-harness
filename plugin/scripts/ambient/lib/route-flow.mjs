/**
 * Zero-touch routing, hand-off half: what the hooks say to Opus and how a
 * route is kept, started and ended (docs/ambient-mode.md, "Routing").
 *
 * Plain words only: the person never sees the plugin, a command or a model
 * name in anything zero-touch says. Opus is told the command's name because
 * it must call it; it is told never to repeat it.
 *
 * A route belongs to the prompt it was made for: it is pending until the
 * Skill call that starts the workflow, and it is dropped at the next prompt.
 * Only the rules make a route: an unclear request is never offered or
 * started on the chat model's guess; it stays an ordinary chat.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adcPath, hasGeminiCredentials, inspectCredentialFile, usableEnv, vertexCredentialState } from "../../verify-setup.mjs";
import { ensureSessionDir, sessionDir } from "./paths.mjs";
import { serverBuilt } from "../../lib/server-lib.mjs";
import { gitInstalled, gitRoot } from "../../lib/git.mjs";
// A function used only when a line is made, so this import cycle (handoff.mjs reads googleLoggedIn here) is safe.
import { displayName } from "./handoff.mjs";
import { findClaude } from "./claude-login.mjs";
import { WORKFLOW_LABELS } from "./zt-saved.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..");
const DRIVER_MODEL_CHECK = join(SCRIPTS, "driver-model-check.mjs");
/** Saves a project with git (git-baseline.mjs, zero-touch's own script): what Claude runs when the person asks for it. */
export const GIT_BASELINE = join(SCRIPTS, "ambient", "git-baseline.mjs");
/** Marks a workflow that stopped before its run began (workflow-stopped.mjs, zero-touch's own script). */
export const WORKFLOW_STOPPED = join(SCRIPTS, "ambient", "workflow-stopped.mjs");
const POLICIES = resolve(SCRIPTS, "..", "config", "policies");
/** The policy a chat whose record names none runs on: the standard pick. */
export const STANDARD_POLICY = "opus-plus-flash-v38";
const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * What the person hears for each job, and the steps it runs, in plain words. No name uses a word the start message
 * never uses (it says "clean up code", "upgrade a library"): tools/test/zero-touch-person-text.test.mjs.
 */
export const PLAIN = {
  greenfield: { name: "new-app build", steps: "requirements, design, build, tests, review" },
  bugfix: { name: "bug-fix workflow", steps: "reproduce, fix, test, review" },
  "feature-extend": { name: "feature workflow", steps: "plan, build, test, review" },
  "feature-new": { name: "new-feature workflow", steps: "design, build, test, review" },
  refactor: { name: "code-cleanup workflow", steps: "plan, change, full test run, review" },
  test: { name: "test-writing workflow", steps: "plan, write the tests, run them" },
  docs: { name: "documentation workflow", steps: "plan, write, review" },
  deps: { name: "library-upgrade workflow", steps: "upgrade, fix what breaks, test" },
};

/** The two workflow commands routing never starts (typed only), named for the person the same way as the eight jobs. */
const TYPED_ONLY = { brownfield: "project workflow", pass: "pipeline run" };

/** The plain name of any workflow command for the person ("bug-fix workflow"). */
export function plainName(job) {
  return PLAIN[job]?.name ?? TYPED_ONLY[job] ?? "workflow";
}

/**
 * The one line the person sees after a message they typed in a workflow-mode chat: what zero-touch did with it. It
 * is the hook's `systemMessage`, which Claude Code shows in the chat and never gives the model, so it appears every
 * time and cannot be reworded by the model. Every line starts with the same label, so anyone watching the chat can
 * tell zero-touch's notices from the model's own reply. Each line says what happened, why, and what the person can
 * do now.
 */
const LABEL = "Zero-touch:";
/** A job's name in a line: the new-app job is a workflow here like the other seven. */
const lineName = (job) => (job === "greenfield" ? "new-app workflow" : plainName(job));
/** What the person asked for, in a line ("you asked for a new app"). */
const ASKED = {
  greenfield: "a new app", bugfix: "a bug fix", "feature-extend": "an addition to a feature", "feature-new": "a new feature",
  refactor: "a code cleanup", test: "tests", docs: "documentation", deps: "a library upgrade",
};
/** Why a recognised job was not started, one sentence per cause, with what to do (cannotStartInstruction gives the model the same). */
function notStartedWhy(problem, job) {
  const name = lineName(job);
  switch (problem?.cause) {
    case "busy":
      // No command named: a workflow that never began frees the folder by itself, so nothing needs typing in the other
      // chat (which may no longer exist).
      return `the ${name} didn't start, because another chat in this project folder is already running a ${problem.job ? lineName(problem.job) : "workflow"}, and two at once would get in each other's way. When that one has finished, ask again here. Until then, Claude can help in this chat as usual.`;
    case "google":
      return `the ${name} didn't start, because your models include Google's Flash 3.8 and this computer isn't connected to Google. Ask Claude: "help me connect Google for zero-touch". Or type "change zero-touch settings" and choose models without Flash.`;
    // The plugin ships its server pre-built, so this is only a damaged copy: reinstalling fixes it, and
    // nobody is asked to run a setup step.
    case "not-built":
      return `the ${name} didn't start, because part of zero-touch is missing on this computer. Reinstalling zero-touch from your plugins fixes it.`;
    case "policy-missing":
      return `the ${name} didn't start, because the models you chose aren't available in this version of zero-touch. Type "change zero-touch settings" to choose again, or update your plugins.`;
    // A change workflow needs git to undo what it changes; started without it, it would stop with a git command for the
    // person to type, and hold the chat.
    case "no-git":
      return `the ${name} didn't start, because this project isn't saved with git yet, and the workflow needs git so every change it makes can be undone. Ask Claude to "save this project with git", then ask again.`;
    case "git-missing":
      return `the ${name} didn't start, because this computer doesn't have git, which the workflow needs so every change it makes can be undone. Ask Claude to help you install it, then ask again.`;
    case "claude-missing":
      return `the ${name} didn't start, because Claude Code's command-line program wasn't found on this computer, and new-app workflows use it. Installing Claude Code for the terminal fixes it; Claude can help.`;
    // The workflow's helpers follow the chat's model, as mmo's do without zero-touch (zero-touch is a strict add-on),
    // so the chat must be on the model the person's zero-touch models plan with; or the person's own helper setting is.
    // Every workflow choice in the box plans with the same model, so choosing other models never helps: only the
    // setting does. Says why, naming the models the person chose.
    case "chat-model": {
      const need = displayName(problem.needed);
      const label = WORKFLOW_LABELS[problem.policy];
      const chose = label ? `you chose ${label}, where ${need} plans and reviews` : `your workflow models plan and review with ${need}`;
      return problem.via === "setting"
        ? `the ${name} didn't start, because a setting on this computer makes workflow helpers run on ${displayName(problem.have)}, but ${chose}. Ask Claude to help you change that setting.`
        : `the ${name} didn't start, because this chat is on ${displayName(problem.have)}, but ${chose}, and that part runs on this chat's own model. Switch this chat to ${need} with the model menu next to the message box (in the terminal, type /model ${problem.needed}), then ask again.`;
    }
    // The check's own output (raw error text, file paths) is for Claude, never the person. Known causes get plain
    // words.
    default: {
      const why = String(problem?.why ?? "");
      if (/timed? ?out|ETIMEDOUT/i.test(why)) return `the ${name} didn't start, because its start-up check took too long. Ask again in a moment.`;
      return `the ${name} didn't start, because its start-up check failed. Claude can help you look into it.`;
    }
  }
}
/**
 * What the person reads when zero-touch refuses a tool call. Claude Code shows a refusal's reason to the
 * person (in red in the desktop app) and to the model, so the reason is one short plain sentence for the person; the
 * model's exact instructions go with it separately (the refusal's additionalContext). No tool, command, plugin or
 * model names: tools/test/zero-touch-person-text.test.mjs.
 */
export const REFUSAL = {
  startFirst: (job) => `${LABEL} Claude starts the ${lineName(job)} first.`,
  notNow: `${LABEL} a full workflow starts only for a request zero-touch recognises, so Claude carries on in the chat.`,
  typedOnly: `${LABEL} in Hand-off mode no full workflow starts by itself, so Claude carries on in the chat.`,
  waitAnswer: `${LABEL} waiting for your answer in the box first.`,
  hold: `${LABEL} the command you typed is queued, so it waits until the running workflow ends.`,
  helperOutside: `${LABEL} that helper works only inside a workflow, so Claude carries on itself.`,
};

/**
 * The line for a message that is not started as a workflow, by its kind (lib/route.mjs routeMessage), or null when
 * nothing is said: ordinary chat gets no line; a real job a folder rule declined gets the real reason and
 * what to do, instead of "this isn't one of the jobs".
 */
export function declinedLine(kind) {
  switch (kind) {
    case "instruction": return PERSON_LINE.notAJob();
    case "folder-new-app": return `${LABEL} this looks like a new app, but this folder already holds a project, so no workflow was started. To build a new app, open an empty folder and ask there; to change this project, say what to add or fix.`;
    case "folder-no-project": return `${LABEL} this asks to change a project, but this folder doesn't hold one yet, so no workflow was started. Claude answers it in the chat.`;
    case "two-jobs": return `${LABEL} this asks for two jobs at once, so no workflow was started. Ask for one at a time to get a full workflow for each.`;
    case "brief-in-project": return `${LABEL} this looks like a brief for a new app, but this folder already holds a project, so no workflow was started. To build it, open an empty folder and paste it there.`;
    default: return null;
  }
}
/** What the model is told with a declined line: told nothing, Claude may start the workflow itself. */
export const NOT_A_JOB_NOTE = "Zero-touch did not start a full workflow for this message, and the person has been told why in one line. Do not start a workflow yourself and do not mention commands. Handle the message yourself as an ordinary request.";

export const PERSON_LINE = {
  starting: (job) => `${LABEL} you asked for ${ASKED[job] ?? "a job"}, so Claude is starting the ${lineName(job)}. It will wait for your approval at each main step.`,
  // Said after L.ended when the running workflow ended other than finished: only a finished workflow is followed by
  // what was queued (startingQueued).
  queueNotStarted: (jobs) => jobs.length === 1
    ? `The ${lineName(jobs[0])} you queued was not started; ask for it again when you want it.`
    : "The workflows you queued were not started; ask for them again when you want them.",
  startingQueued: (job, ended) => ended
    ? `${LABEL} the ${lineName(ended)} has finished, so the ${lineName(job)} you queued is starting now.`
    : `${LABEL} the ${lineName(job)} you queued is starting now.`,
  alreadyRunning: (running, job) => running && job
    ? `${LABEL} a ${lineName(running)} is still running in this chat. In the box, choose whether the ${lineName(job)} you asked for should wait its turn or replace the running one.`
    : `${LABEL} a workflow is still running in this chat. In the box, choose whether the new one should wait its turn or replace the running one.`,
  notStarted: (problem, job) => `${LABEL} ${notStartedWhy(problem, job)}`,
  gateAnswer: () => `${LABEL} the workflow is waiting for your approval, so this message is taken as your answer to it, not as a new request.`,
  workflowAnswer: () => `${LABEL} the workflow asked you a question, so this message is taken as your answer, not as a new request.`,
  duringWorkflow: (running) => `${LABEL} this isn't a new job, so the running ${running ? lineName(running) : "workflow"} carries on, taking your message into account.`,
  // "wasn't recognised as", not "isn't": "add a due date to each to-do" IS a feature job, only not said
  // precisely enough to start a paid workflow on (route.mjs: precision first); the second sentence says how to get one.
  notAJob: () => `${LABEL} this wasn't recognised as one of the jobs that get a full workflow, so Claude answers it normally. To start one, say what you want done and what it is about.`,
  // What happens next depends on the chat's mode: Hand-off mode starts no workflow from plain words, so a Hand-off
  // chat is told it is back to its own work.
  // Worded by how the workflow ended, so an aborted or failed run is never said to have "finished": completed, aborted
  // (stopped at a gate or replaced), failed, or stopped before its run began.
  ended: (job, mode, outcome = "completed") => {
    const what = outcome === "aborted" ? "was stopped"
      : outcome === "failed" ? "stopped because of a problem; Claude's last reply says what happened"
      : outcome === "stopped" ? "stopped before it began"
      : "has finished";
    return mode === "b"
      ? `${LABEL} the ${lineName(job)} ${what}. From here, Claude works in this chat in Hand-off mode again.`
      // "another job", not "a job in your own words": the start message says what is recognised.
      : `${LABEL} the ${lineName(job)} ${what}. From here, asking for another job starts a new workflow; anything else gets a normal answer.`;
  },
  // The person typed "stop" or "cancel" while a workflow ran.
  stopped: (job, droppedQueued) => `${LABEL} the ${lineName(job)} was stopped, as you asked.${droppedQueued ? " The workflow you had queued was dropped too." : ""} Anything it already changed in your files stays as it is.`,
  // Another chat took the folder after this chat's workflow sat waiting at its first questions (NOT_STARTED_IDLE_MS).
  lostFolder: (job, { began = false } = {}) => began
    // The chat was closed while its workflow ran, and another chat took the folder (the lock follows the owner's Claude
    // Code process, lib/project-lock.mjs).
    ? `${LABEL} the ${lineName(job)} in this chat stopped, because this chat was closed while it ran and another chat in this folder has started a workflow since. Ask again here when that one has finished.`
    : `${LABEL} the ${lineName(job)} in this chat stopped before it began, because it waited more than 30 minutes and another chat in this folder has started a workflow since. Ask again here when that one has finished.`,
  // "stop" typed while the workflow is working: stopping then would switch its file rules off and free the folder while
  // its helper is still writing, so it stops when Claude's current step ends.
  stopping: (job) => `${LABEL} stopping the ${lineName(job)}, as you asked, as soon as Claude's current step ends. Anything it already changed in your files stays as it is.`,
  // A start the line announced but Claude never made, even when told once more: the next "yes" starts it.
  didntStart: (job) => `${LABEL} the ${lineName(job)} didn't start. Say "yes" to start it now, or ask for something else.`,
  // A model switch refused while a workflow zero-touch started runs: its helpers follow the chat's model.
  switchDuringWorkflow: (job, needed) => `${LABEL} this chat stays on ${displayName(needed)} until the ${lineName(job)} ends, because the workflow's helpers use this chat's model. You can switch once it has finished.`,
  // A chat made by /branch while a workflow runs in this folder.
  forkedDuringWorkflow: (job) => `${LABEL} this branch can't carry on the ${job ? lineName(job) : "workflow"} running in another chat of this folder (most likely the one you branched from). Answer its questions there. Here, Claude works as normal; a new workflow can start here once that one has finished.`,
  // The conversation was rewound to before the workflow started.
  rewound: (job) => `${LABEL} the conversation went back to before the ${lineName(job)} started, so it was stopped. Anything it already changed in your files stays as it is. Ask again to start it.`,
  // Workflows from plain words switched off by a setting file: said once per chat, at a job.
  routingOff: (job, by) => `${LABEL} the ${lineName(job)} didn't start, because workflows from plain words are switched off ${by === "project" ? "for this project by a setting file in it" : "by a zero-touch setting file on this computer"}, so Claude answers it normally.`,
  // The person's settings say Off: an open or reopened chat lets go at its next message.
  turnedOff: () => `${LABEL} you turned zero-touch off in its settings, so this chat works as normal from here.`,
  // Zero-touch stopped acting in this chat after repeated errors: said once, when it happens.
  breaker: () => `${LABEL} zero-touch stopped working in this chat after repeated errors, so Claude carries on as normal here. A new chat starts fresh.`,
  queued: (job, running) => `${LABEL} queued. The ${lineName(job)} will start by itself when the ${lineName(running)} finishes.`,
  // A job asked for in plain words while a workflow runs: no Queue-or-Replace box would ever show, because a running
  // workflow is either working, when the message joins Claude's turn, or waiting at a step, when the message is its
  // answer. It is queued at once, said at once, and starts when the running one ends.
  remembered: (job, running) => `${LABEL} noted. The ${lineName(job)} will start by itself when the ${lineName(running)} finishes, and it will wait for your approval at its first main step.`,
  // A queued command the person typed that Claude did not start: it is theirs to type again (it starts as typed).
  didntStartTyped: (job) => `${LABEL} the ${lineName(job)} you queued didn't start. Type its command again to start it.`,
  queuedTwice: (job) => `${LABEL} the ${lineName(job)} is already queued, so it wasn't added twice.`,
  replaced: (job, running) => `${LABEL} the ${lineName(running)} was stopped, and the ${lineName(job)} is starting now.`,
  neither: (running) => `${LABEL} nothing new was started; the ${lineName(running)} carries on.`,
};

/**
 * The person chose this: Workflows mode is the person's own choice of a full workflow for every job zero-touch
 * recognises, small ones included.
 */
export const CHOSEN_FULL = "The person chose a full workflow for every job like this, small ones included (Workflows mode in zero-touch's settings): do not question its size, cost or need, and do not offer to do the job in the chat instead.";

/** What Claude is told when a job asked for in plain words is queued while a workflow runs (PERSON_LINE.remembered). */
export function rememberedNote(job, running, { cutOff = false } = {}) {
  // `cutOff`: this message stopped the workflow's last step part-way, so Claude is
  // told to redo that step, not to read the cut-off as a failure or a reason to stop the workflow.
  const resume = cutOff ? " Sending this message cut off the workflow's last step: run that step again and carry on; it was not a failure, and the person did not ask to stop." : "";
  return `The person also asked for a ${PLAIN[job].name} while the ${PLAIN[running]?.name ?? "workflow"} runs. Zero-touch has queued it: it starts by itself when this workflow ends, and the person has been told so in one line. Do not start it and do not do it now. Carry on with the running workflow, taking the message into account only if it is plainly about the work this workflow is doing.${resume} ${KEEP_OUT}`;
}

/** One wording everywhere, in every instruction and refusal below; it informs, it does not order, and it is exact. */
export const KEEP_OUT = "Keep the plugin, command names and model names out of what you say to the person.";

/**
 * The arguments that start a routed workflow: a tag with this run's models and cost recording, chosen by zero-touch,
 * then the person's own words for the job: `[zero-touch policy=<name> auth=<mode>] <words>`. The workflow commands
 * read the tag as this run's choice (the same explicit choice /mmo:pass makes with its policy flag), which wins over
 * the project's saved choice and any routing-policy.yaml. It is a tag, not a flag, on purpose: a person typing a
 * command gets exactly mmo's own surface, with no new flags to learn (tools/test/command.test.mjs).
 */
export function startArgs({ args, auth, policy }) {
  const tag = `[zero-touch policy=${POLICY_NAME.test(String(policy ?? "")) ? policy : STANDARD_POLICY} auth=${auth === "vendor" ? "vendor" : "estimated"}]`;
  return args ? `${tag} ${args}` : tag;
}

/** The instruction that starts a routed workflow (the rules recognised the request). */
export function startInstruction({ job, args, auth, policy }) {
  const plain = PLAIN[job];
  const call = `skill "mmo:${job}", args ${JSON.stringify(startArgs({ args, auth, policy }))}`;
  const lead = `The person's message asks for a full ${plain.name}.`;
  const line = job === "greenfield" ? "Running this as a full new-app build." : `Running this as a full ${plain.name}.`;
  const brief = job === "greenfield"
    ? " Their message is the brief to build from: in the brief step, write it into ./brief.md in the Project Brief layout instead of offering the example briefs, and ask only for what that layout needs and the message does not say."
    : "";
  return (
    `${lead} Start it now with the Skill tool: ${call}. Before the call, tell the person this one plain line: "${line}" ` +
    `The arguments carry this run's models and cost recording, chosen by zero-touch: do not ask about either.${brief} ` +
    `${CHOSEN_FULL} Do nothing else before the workflow starts: other tools are blocked until it does. ${KEEP_OUT}`
  );
}

/**
 * Model-judged recognition. The rules recognise few of the ways people really ask, and more rules cannot keep up. So a
 * message the rules could not place, but which reads like a request, is judged by the chat's own Claude, which reads it
 * anyway: no extra model call, no key, the same on a Claude plan, in the app and in the terminal. The rules still
 * decide what is never a job (a question, a follow-up, a negation, a small edit, the wrong folder, two jobs at once),
 * and zero-touch still checks every start Claude makes (hook.mjs "pre-skill": the job is one this folder allows, the
 * chat's model, Google, another running workflow), and fixes the run's tag itself.
 */
export const JUDGE_JOBS = {
  greenfield: "build a whole new app, website, tool, API or game from nothing",
  bugfix: "fix something broken: a bug, a crash, an error, something that does not work as it should",
  "feature-extend": "add to something that already exists: a field, a button, an option, a filter, sorting, a setting, a flag",
  "feature-new": "add a new part: a new page or screen, a module, a whole capability such as sign-in, search or notifications",
  refactor: "restructure, clean up or simplify code without changing what it does",
  test: "write tests for something",
  docs: "write documentation: a README, a guide, API docs, a changelog",
  deps: "upgrade or update libraries or dependencies",
};
/** The jobs a folder allows: a new app only in an empty folder, the seven changes only in a project. */
export function jobsFor(folder) {
  return folder === "new" ? ["greenfield"] : Object.keys(JUDGE_JOBS).filter((j) => j !== "greenfield");
}
/** Short replies that never ask for a job by themselves ("yes", "ok go ahead"): never judged. */
const REPLY = /^(?:yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|please do|sounds good|great|thanks|thank you|no|nope|cool|nice|perfect|right|agreed|fine)\b/;
/**
 * Whether the rules' "no" for a message leaves the judging to Claude: only "no job verb opens it" and "names nothing
 * in the software" (both mean "not sure"), for a message of three words or more that is not a reply, and that shows
 * work is asked for. `lead` is the request as the rules read it (lib/route.mjs requestLead); `message` the whole
 * message, where the ask often comes in a second sentence ("Express has to go to version 5. Upgrade it.").
 */
export function judgeable(r, lead, message = lead) {
  if (!r || r.job) return false;
  if (r.reason !== "no job verb opens the message" && !/^names nothing in the software/.test(String(r.reason ?? ""))) return false;
  const text = String(lead ?? "").trim();
  if (text.split(/\s+/).filter(Boolean).length < 3 || REPLY.test(text)) return false;
  // A sign of work asked for: it opens with a job verb (r.kind "instruction"), or a job verb or a fault is named
  // anywhere ("…, can you sort that out", "need this fixed", "page 2 shows the same posts"). Ordinary chat ("rename
  // x to total", "that makes sense") gets nothing added.
  return r.kind === "instruction" || WORK_SIGN.test(String(message ?? "").toLowerCase());
}
/** Words that show work is asked for, anywhere in a message (judgeable). */
const WORK_SIGN = /\b(?:fix(?:ed|es|ing)?|repair|debug|broken|bugs?|crash(?:es|ed|ing)?|errors?|exceptions?|wrong|incorrect|fails?|failing|failed|race condition|leaks?|(?:doesn'?t|does not|don'?t|isn'?t|is not|aren'?t|won'?t|can'?t|cannot|stopped|not) (?:work|load|save|show|update|send|open|run|check)\w*|add(?:ed|ing)?|build|create|make|implement|support|extend|upgrad(?:e|ed|ing)|update|bump|refactor|clean(?:ed)? (?:up|out)|simplify|split|merge|extract|decouple|move|pull|break (?:up|down|apart|the|it|this)|get rid of|remove|replace|migrate|convert|tests?|document|documentation|readme|docs|changelog|guide|jsdoc|put together|wire up|hook up|set up|give (?:the|it|this|our|my)|needs?|should|want|would like|'d like|has to|have to|sort (?:it|this|that|them) out|sort out|look into|track (?:it|this|that) down|[45]\d\d(?:s)?)\b/;
/**
 * The outcome contract: a start Claude was told to make and did not is pushed once more at the end of its turn
 * (retryInstruction); still not made, the person is told, and their next message, if it is a plain yes (carryYes),
 * starts that job.
 */
export function retryInstruction({ job, args, auth, policy, typed = false }) {
  // A command the person typed and queued: pushed again exactly as typed, with no
  // zero-touch tag and no "do not ask" sentences, as its first push (queue.mjs queuedStartInstruction) does.
  if (typed) {
    const call = args ? `skill "mmo:${job}", args ${JSON.stringify(args)}` : `skill "mmo:${job}" (no arguments)`;
    return `You were told to start the ${PLAIN[job].name} the person typed and queued, and did not. Start it now with the Skill tool: ${call}, exactly as they typed it. Do nothing else before the workflow starts: other tools are blocked until it does. Only if something really prevents it, say so in one plain sentence. ${KEEP_OUT}`;
  }
  return `You were told to start the person's ${PLAIN[job].name} and did not. ${startInstruction({ job, args, auth, policy })} Only if something really prevents it, say so in one plain sentence, and that they can say "yes" to start it.`;
}
const AFFIRM = /^(?:yes|yeah|yep|yup|ok|okay|sure|go|go ahead|go for it|do it|start it|run it|please|proceed|full|run|start|build it)\b/;
const NEGATE = /\b(?:no|not|don'?t|do not|never|instead|just|in the chat|here|skip|cancel|stop|wait|later)\b/;
/** A plain yes to the job that did not start: short, affirmative, no negation, not a question. */
export function carryYes(text) {
  const t = String(text ?? "").split("\n").find((l) => l.trim())?.trim().toLowerCase() ?? "";
  return Boolean(t) && t.split(/\s+/).length <= 8 && !t.includes("?") && AFFIRM.test(t) && !NEGATE.test(t);
}

/** What Claude is told for such a message: the jobs this folder allows, when to start one, and exactly how. */
/**
 * What Claude is told about a message, sent while this chat's workflow runs, that the rules could not place but that
 * may ask for work (judgeable). Most such messages are about the running work; only a clearly separate job is
 * queued. Claude never starts it: its Skill call is turned into a queued job by pre-skill, which says so to the
 * person. `cutOff`: the message stopped the workflow's last step part-way, so that step is run again.
 */
export function midRunJudgeInstruction({ folder, running, cutOff = false }) {
  const jobs = jobsFor(folder);
  const name = PLAIN[running]?.name ?? "workflow";
  return [
    `The person sent this while the ${name} runs, and zero-touch's quick rules did not place it, so you judge it:`,
    `- About the work this workflow is doing (a detail, a change of scope, an answer, a question): it is part of that work. Take it into account in the running workflow and call no other workflow.`,
    `- Only if it clearly asks for a separate job of one of these kinds, call the Skill tool with skill "mmo:<job>" and args set to the request in one line, in the person's own words:`,
    ...jobs.map((j) => `  - "mmo:${j}": ${JUDGE_JOBS[j]}`),
    `  Zero-touch does not start it now: it queues it, tells the person, and it starts by itself when this workflow finishes. Then carry on with the running workflow.`,
    `- When unsure, treat it as part of the running work.`,
    `Do not do a separate job yourself now.${cutOff ? " Sending this message cut off the workflow's last step: run that step again and carry on; it was not a failure, and the person did not ask to stop." : ""}`,
    KEEP_OUT,
  ].join("\n");
}

export function judgeInstruction({ folder, auth, policy }) {
  const jobs = jobsFor(folder);
  const tag = startArgs({ args: "", auth, policy });
  const how = folder === "new"
    ? `call the Skill tool with skill "mmo:greenfield" and args exactly ${JSON.stringify(tag)}. Their message is the brief to build from: in the brief step, write it into ./brief.md in the Project Brief layout instead of offering the example briefs, and ask only for what that layout needs and the message does not say.`
    : `call the Skill tool with skill "mmo:<job>" and args ${JSON.stringify(`${tag} `)} followed by the request in one line, in the person's own words.`;
  return [
    `Zero-touch's quick rules did not recognise this message, so you judge whether it asks for one of the jobs that get a full workflow in this ${folder === "new" ? "empty folder" : "project"}:`,
    ...jobs.map((j) => `- "mmo:${j}": ${JUDGE_JOBS[j]}`),
    "Start one only when this message itself asks you to do that job now and says what it is about. Never for a question, a request to explain, review, run, deploy or commit something, a reply to something you said, a tiny edit, or when you are unsure: then answer normally and say nothing about workflows.",
    `To start one, first tell the person one plain line, "Running this as a full <the job in plain words>.", then ${how} Do nothing else before the call; zero-touch checks the start itself and may refuse it, with the reason.`,
    `Once you judge it one of these jobs: ${CHOSEN_FULL}`,
    KEEP_OUT,
  ].join("\n");
}

/**
 * What Claude is told the moment a workflow command loads in a zero-touch chat (hook.mjs "post-skill"; zero-touch is a
 * strict add-on): mmo's command texts are mmo's own, so what differs in a run zero-touch
 * started is said here, beside the command, and only in a zero-touch chat. A command the person typed gets only the
 * early-stop instruction (STOP_NOTE): its own choices stand.
 */
export const STOP_NOTE = `If this workflow stops before its run begins (the person says no, a check fails, the folder is the wrong kind, a choice is missing), run this once before your reply, so the chat is free for the person's next request: node "${WORKFLOW_STOPPED}" --reason "<a few plain words>"`;

export function runNote({ job, policy, auth }) {
  const tag = `[zero-touch policy=${policy} auth=${auth}]`;
  const lines = [
    `Zero-touch started this workflow with the person's own choices. The tag at the start of its arguments, ${tag}, is zero-touch's, not the person's words, and it settles two things the command would otherwise read or ask; this note comes after the command and wins over it on these points only:`,
    `- Models: the policy ${policy}. Do not read or require a saved project choice (setup-policy.mjs --print-only, or default_policy in .sdlc/project.json), and do not stop because none is saved. Resolve it with load_policy and policy_path "${policyPath(policy)}" (an explicit file, which wins over a project's routing-policy.yaml), pass that same policy_path on every policy call, give the orchestrator policy ${policy} and that policy_path, and where the command shows the policy, show "${policy} (chosen for this run)".`,
    `- Cost recording: ${auth}. Show it where the command shows it, and do not ask.`,
  ];
  if (auth !== "vendor") lines.push("- Do not ask the person to set CLAUDE_CODE_SUBAGENT_MODEL or to restart Claude Code: in this run the workflow's helpers run on this chat's own model, which zero-touch has checked against the policy, and the run's own model check is told so.");
  if (job !== "greenfield") lines.push("- The job's description is the text after the tag.");
  else lines.push("- The brief: the person's message that asked for this app is the brief to build from. In the brief step, write it into ./brief.md in the Project Brief layout instead of offering the example briefs, and ask only for what that layout needs and the message does not say.");
  lines.push(`- ${STOP_NOTE}.`);
  lines.push(`Everything else runs exactly as the command says. ${KEEP_OUT}`);
  return lines.join("\n");
}

/**
 * The new app, saved with git at the end of a new-app workflow zero-touch started (hook.mjs "turn-end"):
 * the line added to the person's end line, by the git script's result code ("already" adds nothing).
 */
export const SAVED_WITH_GIT = {
  saved: "The new app is saved with git as a starting point, so the changes you ask for next can be undone.",
  noGit: "This computer doesn't have git, so the new app isn't saved with it yet, and changes to it need git. Claude can help you install it.",
  failed: "The new app couldn't be saved with git, and changes to it need git. Claude can help you look into it.",
};

/** Guard A's refusal while a route waits for its Skill call. */
export function startFirstReason(job) {
  return `Start the workflow first: the person asked for the full ${PLAIN[job].name}. Call the Skill tool with skill "mmo:${job}" now; other tools are blocked until it starts. ${KEEP_OUT}`;
}

/**
 * Guard B's refusal for a workflow the chat tried to start by itself. Only the rules (or a typed command) start one,
 * whatever the chat's model thinks the request is; the chat does the work itself instead.
 */
// No "the person types the command": Claude would pass it on, telling the person to type /mmo:greenfield.
export const NOT_NOW_REASON = "A full workflow starts only when zero-touch recognises the request, so none starts now. Do not start one yourself and do not mention commands to the person: carry on with your own tools.";

/**
 * What Opus says when a workflow cannot start in this chat: the real cause and the fix that works for that cause,
 * never one fixed sentence for every cause.
 * The same causes as the person's line (PERSON_LINE.notStarted), so the two never disagree.
 */
export function cannotStartInstruction(job, problem) {
  const lead = `The person's message asks for a full ${PLAIN[job].name}, but it did not start, and the person has been told why in one line:`;
  // One tail for every cause: an offer of help in the chat is a question that waits for the answer, never permission to
  // do the job.
  const tail = `Do not do the job yourself now and do not start the workflow yourself. In one short sentence, ask whether they want help with it here in the chat instead, and wait for their answer. ${KEEP_OUT}`;
  switch (problem?.cause) {
    case "policy-missing":
      return `${lead} the models the person chose are not in this version of the plugin. They can choose again with "change zero-touch settings", or update their plugins. ${tail}`;
    case "not-built":
      return `${lead} part of the plugin is missing from this computer. If they ask how to fix it: reinstalling zero-touch from their plugins fixes it. Do not run any setup or install command yourself. ${tail}`;
    case "google":
      return `${lead} its models include Google's Flash, and this computer is not connected to Google. If they want to connect it, they can ask "help me connect Google for zero-touch". Do not change their zero-touch settings yourself. ${tail}`;
    case "no-git":
      return `${lead} the project folder is not tracked by git, and the workflow needs git so every change can be undone. In one short sentence, ask whether they want you to save the project with git now, and wait for their answer. If they do, run exactly this once, nothing else: node "${GIT_BASELINE}" --dir "${problem.projectDir}" and tell them its one line; then they can ask for the job again. Do not do the job yourself now and do not start the workflow yourself. ${KEEP_OUT}`;
    case "claude-missing":
      return `${lead} Claude Code's command-line program is not on this computer, and a new-app workflow types with it. If they want help: installing Claude Code for the terminal (claude.com/download, or "npm install -g @anthropic-ai/claude-code" where Node.js is installed) fixes it; they then start a new chat. ${tail}`;
    case "git-missing":
      return `${lead} this computer has no working git (on a Mac, the developer tools are not installed), and the workflow needs git so every change can be undone. If they want to install it on a Mac, run "xcode-select --install", which opens Apple's installer, and tell them to follow it and then ask again. ${tail}`;
    case "busy":
      // One workflow at a time in one project (lib/project-lock.mjs).
      return `${lead} another chat in this project folder is running a ${problem?.job ? plainName(problem.job) : "workflow"}, and two workflows in one folder would overwrite each other's records. They can ask again when that one has finished. ${tail}`;
    case "chat-model":
      return problem.via === "setting"
        ? `${lead} the person's CLAUDE_CODE_SUBAGENT_MODEL setting (the "env" block of ~/.claude/settings.json, or an export in the shell Claude Code was started from) makes every workflow helper run on ${problem.have}, and their zero-touch models plan with ${problem.needed}. If they want help: changing that setting to ${problem.needed}, or removing it, fixes it, and it takes effect once Claude Code is restarted; it applies to workflows they type too. Do not change it yourself unless they ask. ${tail}`
        : `${lead} the workflow's helpers run on the chat's own model, ${problem.have}, and the person's zero-touch models plan with ${problem.needed}. If they ask how to fix it: switch this chat to ${problem.needed} with the model menu next to the message box (in the terminal: /model ${problem.needed}), then ask again. ${tail}`;
    default:
      return `${lead} its start-up check failed (${problem?.why ?? "no reason given"}). ${tail}`;
  }
}

// ─── Route state (one chat) ─────────────────────────────────────────────

const ROUTE = "route.json";

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readRoute(sid) { return readJson(join(sessionDir(sid), ROUTE)); }
export function writeRoute(sid, route) {
  ensureSessionDir(sid);
  writeFileSync(join(sessionDir(sid), ROUTE), JSON.stringify({ ...route, at: new Date().toISOString() }), { mode: 0o600 });
}
export function dropRoute(sid) { try { rmSync(join(sessionDir(sid), ROUTE), { force: true }); } catch { /* already gone */ } }


// ─── What zero-touch checks before it starts a workflow ─────────────────

/**
 * The models every workflow zero-touch starts in this chat runs on: the chat's own record, written at its start from
 * the person's settings (zero-touch/scripts/mark.mjs, `workflow.json`). A chat whose record names none runs on the
 * standard pick. The project's saved choice and its routing-policy.yaml are not used by zero-touch; a workflow typed
 * by hand follows them.
 */
export function chatPolicy(sid, env = process.env) {
  try {
    const p = JSON.parse(readFileSync(join(sessionDir(sid, env), "workflow.json"), "utf8"))?.policy;
    // A policy name this mmo does not ship is kept as chosen: the start check then says so,
    // instead of running other models than the person chose.
    if (POLICY_NAME.test(String(p ?? ""))) return p;
  } catch { /* none: the standard pick */ }
  return STANDARD_POLICY;
}

/** The shipped file of a policy name: passed as an explicit path, it wins over a project's own file everywhere. */
export function policyPath(policy) {
  return join(POLICIES, `${policy}.yaml`);
}

/** Whether a shipped policy sends any work to Google (a Gemini model): then a Google login is needed. */
export function policyUsesGoogle(policy) {
  try { return /^\s*model_name:\s*gemini-/m.test(readFileSync(policyPath(policy), "utf8")); } catch { return false; }
}

/**
 * Whether this machine has a Google login, by mmo's own rule (verify-setup.mjs, the same functions): an API key, or a
 * login file that can be used; a project name alone is not a login. Offline: a login that has expired is caught at
 * the first call to Google, where the workflow's own pre-flight and dispatch report it.
 */
export function googleLoggedIn(env = process.env) {
  const real = usableEnv(env);
  const serviceAccountFile = real.GOOGLE_APPLICATION_CREDENTIALS ? inspectCredentialFile(real.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const adcFile = inspectCredentialFile(adcPath(real.HOME || undefined));
  if (!hasGeminiCredentials({ env: real, vertex: vertexCredentialState({ env: real, serviceAccountFile, adcFile }) })) return false;
  // A key needs nothing more; a Google Cloud sign-in needs a project: without one Flash cannot run, and a workflow
  // started on it would stop at its first Flash step. mmo's own setup check (verify-setup.mjs) is left as mmo has it.
  return Boolean(real.GEMINI_API_KEY) || Boolean(googleProject(env));
}

/**
 * The Google Cloud project a sign-in uses, or null: GOOGLE_CLOUD_PROJECT; else the sign-in file's own
 * (quota_project_id, project_id), as the model server reads it (geminiTransports.ts resolveGcpProject); else gcloud's
 * own configuration (`gcloud config set project`), where Google's auth library looks next. Files only; nothing runs.
 * zero-touch/scripts/google.mjs googleProject is the same rule (tools/test/zero-touch-google.test.mjs).
 */
export function googleProject(env = process.env) {
  const real = usableEnv(env);
  if (real.GOOGLE_CLOUD_PROJECT) return real.GOOGLE_CLOUD_PROJECT;
  try {
    const file = JSON.parse(readFileSync(real.GOOGLE_APPLICATION_CREDENTIALS || adcPath(real.HOME || undefined), "utf8"));
    const p = file?.quota_project_id ?? file?.project_id;
    if (typeof p === "string" && p.trim()) return p.trim();
  } catch { /* no file, or not one this can read */ }
  try {
    const home = env.HOME && env.HOME.trim() ? env.HOME : homedir();
    const dir = env.CLOUDSDK_CONFIG && env.CLOUDSDK_CONFIG.trim() ? env.CLOUDSDK_CONFIG : join(home, ".config", "gcloud");
    let name = "default";
    try { name = readFileSync(join(dir, "active_config"), "utf8").trim() || "default"; } catch { /* the default configuration */ }
    const ini = readFileSync(join(dir, "configurations", `config_${name}`), "utf8");
    let core = false;
    for (const line of ini.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) core = t === "[core]";
      else if (core) { const m = /^project\s*=\s*(\S+)/.exec(t); if (m) return m[1]; }
    }
  } catch { /* no gcloud configuration */ }
  return null;
}

/**
 * Which model a workflow's helpers will run on (zero-touch is a strict add-on): mmo's helper agents name no model, so
 * Claude Code runs them on the person's CLAUDE_CODE_SUBAGENT_MODEL setting when there is
 * one, else on the model of the chat that starts them. `{ model, via: "setting" | "chat" }`, or null when neither is
 * known (Claude Code has not said which model the chat is on yet).
 */
export function helperModel({ chatModel = null, env = process.env } = {}) {
  const set = String(usableEnv(env).CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim();
  if (set) return { model: set, via: "setting" };
  const chat = String(chatModel ?? "").replace(/\[[^\]]*\]$/, "").trim();
  return chat ? { model: chat, via: "chat" } : null;
}

/**
 * Why a workflow cannot start here, or null when it can. The policy's planning model is read with the workflow's own
 * run-start check (driver-model-check.mjs --print-only, the pipeline's router) on the policy's shipped file, so the
 * hook and the workflow judge the same policy, and a project's routing-policy.yaml decides nothing. Causes: "google"
 * (the policy uses Flash and there is no Google login), "not-built" (the plugin's pre-built server is missing),
 * "no-git" / "git-missing" (a change job), "chat-model" (the helpers would run on another model than the policy plans
 * with: the chat's own model, or the person's setting; `via` says which), "check" (the check itself failed, in its own
 * words). On success: `needed`, the policy's planning model (null under vendor), and `helper`, the model the helpers
 * will run on, or null when Claude Code has not yet said which model the chat is on (a new chat's first message).
 * Then the start goes ahead, and the chat's model is checked again when the workflow's own command is called, by when
 * the chat has answered (hook.mjs "pre-skill"), and by the run's own check (hook.mjs stampRunCheck).
 */
export function startProblem({ projectDir, policy, auth, job = null, chatModel = null, env = process.env }) {
  // The models the person chose are not in this version of mmo: never swapped for others.
  if (!existsSync(policyPath(policy))) return { problem: { cause: "policy-missing" } };
  if (policyUsesGoogle(policy) && !googleLoggedIn(env)) return { problem: { cause: "google" } };
  if (!serverBuilt()) return { problem: { cause: "not-built" } };
  // A new app types with Claude through Claude Code's own command-line program, which its first step checks for (the
  // model server's rule, claudeCommand.ts): none on this computer is said plainly before the start, never as the
  // first step's terminal command.
  if (job === "greenfield" && !findClaude(env)) return { problem: { cause: "claude-missing" } };
  // A change workflow undoes its changes with git; a folder git does not track would stop it after it started. Checked
  // without running git where there is none (lib/git.mjs: no macOS install dialog). A new app needs no git.
  if (job && job !== "greenfield" && !gitRoot(projectDir)) return { problem: { cause: gitInstalled({ env }) ? "no-git" : "git-missing", projectDir } };
  // Under vendor every call, the helpers' own included, goes through the model server: no helper model to match.
  if (auth === "vendor") return { problem: null, policy, needed: null, helper: null };
  const first = (err) => String(err?.stderr ?? "").trim().split("\n")[0] || "its run-start model check failed.";
  let needed;
  try {
    needed = execFileSync(process.execPath, [DRIVER_MODEL_CHECK, "--project-root", projectDir, "--policy-path", policyPath(policy), "--print-only"], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }).toString().trim();
  } catch (err) {
    return { problem: { cause: "check", why: first(err) } };
  }
  const helper = helperModel({ chatModel, env });
  if (helper && helper.model !== needed) return { problem: { cause: "chat-model", have: helper.model, needed, via: helper.via, policy } };
  return { problem: null, policy, needed, helper };
}

/**
 * A model-server call of a workflow zero-touch started is refused because a command it would make the server run (a
 * written file's check or format command) is one the person's Claude settings forbid: the server runs it outside
 * Claude Code's Bash rules (lib/own-steps.mjs serverCommands, lib/bash-rules.mjs).
 */
export const SERVER_COMMAND_DENIED = `${LABEL} this workflow step wasn't run, because it would run a command your Claude settings don't allow.`;
export function serverCommandDeniedReason(command, rule) {
  return `This call was refused: the model server would run \`${String(command).slice(0, 300)}\` in the project, which the person's Claude settings forbid (${rule}), and the server runs these commands outside your Bash tool's rules. Do not run that command another way. Say at the workflow's next approval step, in one sentence, which command the person's settings forbid.`;
}

/**
 * Shown to the person, not the model, when a typed workflow command is kept back because another chat in this
 * project is running a workflow: the prompt hook blocks the typed line, and Claude Code shows this reason.
 */
export function typedBusyReason(lock) {
  return `Zero-touch: this didn't start, because another chat in this project folder is already running a ${lock?.job ? lineName(lock.job) : "workflow"}, and two at once would get in each other's way. When that one has finished, try again.`;
}
