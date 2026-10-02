/**
 * Zero-touch routing, recognition half: which /mmo: job an ordinary chat
 * message asks for, or none (docs/ambient-mode.md, "Routing").
 *
 * Fixed patterns, no model: the same message and folder always give the same
 * answer. Two signals must agree:
 *   - the message: an instruction whose job verb opens it (after "please",
 *     "can you" and the like). Questions, negations, a bare "fix it", small
 *     edits (a typo, lint, a rename) and two different jobs in one message are
 *     never routed;
 *   - the folder: a new folder can only be greenfield; an existing project can
 *     only be one of the seven brownfield jobs. "Existing" is /mmo:greenfield's
 *     own four signals (plugin/commands/greenfield.md, "Mode-detection guard")
 *     plus any source file of its own (repo-kind.mjs).
 * Precision first: a wrong route starts a pipeline nobody asked for; a missed
 * route leaves an ordinary chat, where the person can still type the command.
 * Unsure is no route.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoKind } from "./repo-kind.mjs";
import { gitInstalled, gitRoot } from "../../lib/git.mjs";

export const ROUTABLE_JOBS = new Set(["greenfield", "docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"]);

// ─── The folder ─────────────────────────────────────────────────────────

/** Stack manifests at the project root: greenfield.md names package.json, pyproject.toml, go.mod "or another stack manifest". */
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "mix.exs", "pubspec.yaml", "Package.swift", "deno.json", "CMakeLists.txt"];

/** "existing" when any of /mmo:greenfield's signals of an existing repo holds, or the folder holds a source file of its own; else "new". */
export function folderKind(dir) {
  const src = join(dir, "src");
  try { if (statSync(src).isDirectory() && readdirSync(src).length > 0) return "existing"; } catch { /* no src */ }
  if (MANIFESTS.some((m) => existsSync(join(dir, m)))) return "existing";
  try { if (readdirSync(dir).some((f) => /\.(csproj|sln)$/i.test(f))) return "existing"; } catch { /* unreadable */ }
  try { if (statSync(join(dir, "README.md")).size > 200) return "existing"; } catch { /* no README */ }
  // git only inside a git project and with a real git installed (lib/git.mjs): on a Mac without the
  // developer tools, running /usr/bin/git opens an install dialog, and this runs on every typed message.
  if (gitRoot(dir) && gitInstalled()) {
    try {
      const tracked = execFileSync("git", ["ls-files"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 1 << 20 }).toString();
      if (tracked.trim()) return "existing";
    } catch { /* not readable as a repository: no signal */ }
  }
  return repoKind(dir) === "brownfield" ? "existing" : "new";
}

// ─── The message ────────────────────────────────────────────────────────

/**
 * A plain request to stop the running workflow: the whole message is "stop", "cancel", "abort", "quit",
 * "halt", "never mind" or "forget it", optionally with "it", "this", "that", "now", "please", "everything" or "the
 * workflow" / "the run" / "the build" / "the bug-fix workflow". Anything longer is an answer or a new message: "stop
 * the dev server" is not this.
 */
const STOP_REQUEST = /^\s*(?:please\s+)?(?:stop|cancel|abort|quit|halt|never\s*mind|forget\s+(?:it|about\s+it))(?:\s+(?:it|this|that|now|please|everything|the\s+(?:whole\s+)?(?:workflow|run|build|job|[a-z-]+\s+(?:workflow|build|run))))*\s*[.!]*\s*$/i;
export function isStopRequest(text) {
  return STOP_REQUEST.test(String(text ?? ""));
}

/**
 * The verbs the eight jobs open with. A message that opens with one but is not a recognised job ("build a
 * function that reverses a string") gets the "not one of the jobs" line, since the person may have meant a workflow;
 * any other instruction ("rename x", "deploy this") is plain chat work and gets no line.
 */
const JOB_VERB = /^(?:build|create|make|scaffold|generate|develop|write|implement|code|set ?up|bootstrap|spin up|add|introduce|extend|support|fix|debug|resolve|repair|troubleshoot|refactor|restructure|reorgani[sz]e|consolidate|extract|document|upgrade|bump|update|migrate|backfill)\b/;

/**
 * A message about zero-touch itself ("change zero-touch settings", "help me connect Google for zero-touch", "fix my
 * zero-touch config"): never a job and never an answer to a workflow's question ("fix the zero-touch models" is not a
 * bug fix in the person's project). Zero-touch's own hooks handle it.
 */
const ABOUT_ZERO_TOUCH = /\bzero[\s-]?touch\b|\bzerotouch\b/i;
export function mentionsZeroTouch(text) {
  return ABOUT_ZERO_TOUCH.test(String(text ?? ""));
}

/** Openers that turn a request into an instruction ("can you fix …" is "fix …"); stripped one after another. */
const OPENERS = /^(?:(?:hey|hi|hello|ok|okay|so|now|next|then|alright|right|please|pls|kindly|just|quickly)\b[\s,!.]*|(?:can|could|would|will) (?:you|we)(?: please)?\s+|let'?s\s+|let us\s+|i(?:'d| would) like (?:you )?to\s+|i (?:want|need)(?: you)? to\s+|we (?:want|need) to\s+|go ahead and\s+|help me(?: to)?\s+)/;

/** A message that opens like these asks for information, not a job. */
const INFO_OPENERS = /^(?:how|what|why|where|when|which|who|whose|is|are|was|were|does|do|did|should|shall|will|would|could|can|have|has|explain|tell me|describe|show me|summari[sz]e|list|walk me through|compare)\b/;

/** Words that point back at earlier context; an object made only of these is a follow-up, never a new job. */
const DEICTIC = new Set(["it", "this", "that", "these", "those", "them", "everything", "all", "both", "the", "a", "an", "too", "also", "now", "please", "again", "same", "one", "up", "as", "well", "for", "to", "in", "on", "of"]);

/**
 * A job verb followed at once by one of these is a noun ("fix is in the repo",
 * "fix 2 worked fine"): the message talks about a fix, it does not ask for one.
 */
const AUX = new Set(["is", "was", "are", "were", "be", "been", "being", "has", "have", "had", "did", "does", "do", "should", "would", "could", "will", "can", "might", "must", "shall", "may", "worked", "works", "went", "looks", "looked", "seems", "seemed", "sounds", "sounded", "got", "landed"]);

/** Openers that make a question mark polite: "can you fix the test?" is an instruction, "we need to fix it too?" is not. */
const POLITE = /^(?:(?:hey|hi|hello|ok|okay|so|now|next|then|alright|right|please|pls|kindly|just)\b[\s,!.]*)*(?:can|could|would|will) (?:you|we)\b/;

/**
 * Words that continue earlier work: "also …", "… as well", "… too", "… again".
 * Such a message is a follow-up inside a chat that is already working, never a
 * new job.
 */
const FOLLOW_UP = /^also\b|\bas well\b|\b(?:too|again)$/;

/**
 * Too small to be a pipeline job when it is the thing named: the head of the
 * object, up to its first colon, preposition or clause ("fix the spelling:
 * teh", "fix the lint errors"). A mention further on ("the bug where comments
 * are not saved", a brief listing "ticket comments") names something else
 * (checking the whole clause would drop a real new-app brief).
 */
const SMALL_EDIT = /\b(typos?|spelling|grammar|formatting|indentation|whitespace|lint(?:ing)?|linter|prettier|eslint|import order|comments?|commit messages?)\b/;

/**
 * Where a message may be cut into clauses: "and", "and then", "then", a comma before those, a semicolon. Kept
 * as a capture so a part that is not cut off can be joined back exactly as written.
 */
const CLAUSE_SEPARATOR = /(\s*(?:,\s*and then|,\s*then|,\s*and|;|\s+and then|\s+then|\s+and)\s+)/;

/**
 * A part after a separator that opens with one of these verbs is a new instruction, a clause of its own ("fix
 * the parser and run the tests"). Any other part continues what the clause before it names ("tests for the
 * discount and tax functions in src/cart.js": cut at " and ", "… for the discount" would name nothing). A part that
 * opens one of the eight jobs is always a clause of its own as well, whatever this list says, so no second job can
 * hide inside an object. A word that can be a verb or a noun ("test", "change", "return") is treated as a verb: an
 * unsure part is cut, so the worst case stays a missed route, never a wrong one.
 */
export const INSTRUCTION = /^(?:(?:also|please|just|then|now)\s+)*(?:add|write|create|build|make|fix|update|upgrade|bump|refactor|document|implement|support|extend|generate|develop|scaffold|bootstrap|introduce|extract|migrate|convert|integrate|debug|diagnose|troubleshoot|investigate|resolve|repair|reproduce|run|rerun|re-run|test|check|verify|ensure|confirm|remove|delete|drop|rename|move|replace|change|split|combine|improve|increase|reduce|optimi[sz]e|clean|tidy|deploy|push|commit|merge|rebase|install|uninstall|enable|disable|turn|switch|use|keep|set|wire|hook|connect|expose|handle|return|print|call|explain|describe|summari[sz]e|compare|show|tell|list|review|find|revert|undo|open|close|send|start|stop|restart|give|put|get|let|try|do|go|see|look|read)\b/;

/** An object that starts by negating itself ("fix nothing yet, just explain") asks for no job. */
const NEGATED_OBJECT = /^(?:nothing|none|no|not|never)\b/;

/** An object pointing at text in the message ("the following", "the attached log") is about that text, not the project. */
const POINTS_AT_TEXT = /\b(?:following|attached|pasted)\b/;
/**
 * "below" and "above" are two different words in a request. As a pointer they close the noun they follow: "the code
 * below", "the error above", "described below", "shown above in the log". As a comparison they take an object, an
 * amount or a determined noun: "below zero", "above 99", "below $0", "above the limit". Only the pointer is about text
 * in the message; the comparison is part of the bug ("…the total can go below zero"). What may follow a comparison is a
 * closed class of English words (numbers and determiners), so this is a grammar rule, not a list of cases.
 */
const POSITION = /\b(?:below|above)\b/g;
const COMPARED_OBJECT = /^\s*(?:[-+]?[$€£₹]?\d|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|the|a|an|its|their|his|her|our|your|my|this|that|these|those|some|any|each|every|all|no|half)\b)/;

/** Whether an object points at text in the message rather than naming something in the project. */
export function pointsAtText(raw) {
  if (POINTS_AT_TEXT.test(raw)) return true;
  for (const m of raw.matchAll(POSITION)) {
    if (!COMPARED_OBJECT.test(raw.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/**
 * A project job must name something in the software ("restructure this essay", "troubleshoot my wifi" and "fix merged"
 * are not jobs). Precision first, so this is a positive requirement, never a list of exceptions: a path or file name, a
 * code identifier or call, an HTTP status, an error type, or a word of the software trade.
 */
const SOFTWARE = new RegExp([
  "[\\w-]+/[\\w./-]+",                                   // a path: src/payments, /login
  "\\b[\\w-]+\\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|cs|php|swift|json|ya?ml|toml|sql|html|s?css|sh|md)\\b", // a file
  "\\b[a-z0-9]+_[a-z0-9_]+\\b", "\\w\\(\\)",                 // an identifier, a call
  "\\b[1-5]\\d\\d\\b", "\\b\\w+(?:error|exception)\\b",       // an HTTP status, an error type
  "\\b(?:bugs?|errors?|exceptions?|crash(?:es|ed|ing)?|fail(?:s|ed|ing|ures?)?|broken|regressions?|flaky|timeouts?|leaks?|tests?|specs?|coverage|endpoints?|apis?|routes?|router|handlers?|controllers?|services?|modules?|packages?|librar(?:y|ies)|functions?|methods?|class(?:es)?|components?|hooks?|pages?|screens?|forms?|buttons?|views?|quer(?:y|ies)|database|db|schemas?|migrations?|models?|tables?|parsers?|builds?|compiler|deploy(?:ment)?s?|pipelines?|jobs?|workers?|queues?|cli|commands?|scripts?|config(?:uration)?s?|login|logout|auth(?:entication|orization)?|signup|sessions?|tokens?|cache|servers?|clients?|frontend|backend|ui|code|codebase|repo(?:sitory)?|features?|logic|validation|exports?|imports?|uploads?|downloads?|webhooks?|integrations?|dependenc(?:y|ies)|deps|readme|docs?|documentation|docstrings?|helpers?|utils?|utilit(?:y|ies)|loaders?|folders?|director(?:y|ies)|files?|src|lib)\\b",
].join("|"));

const ART = "(?:a |an )";
const ADJ = "(?:(?:new|simple|small|basic|minimal|full|complete|tiny|production[- ]ready|full[- ]stack)\\s+)*";
// The words between the article and the head noun: modifiers only, never a preposition or a clause, so the
// app noun is what gets built ("a haiku about a bot" is a poem).
// A preposition counts only as a word of its own: "to-do", "on-call" and "in-memory" are modifiers ("build a small
// to-do app" is a new app).
const SOME = "(?:(?!(?:for|about|on|of|to|in|with|from|by|at|into|like|as|that|which|who|where|when)\\s)[\\w.+#/-]+\\s+){0,6}?";
// "To do" written as two words names the app only right after the article and size words ("a small to do app");
// anywhere else "to" starts a purpose ("a script to do app releases" is not an app).
const TO_DO = "(?:to do (?:list )?)";
const APP_NOUN = "(?:app|application|web ?app|website|site|landing page|web ?page|home ?page|api|backend|back-end|frontend|front-end|service|microservice|server|cli(?: tool)?|command[- ]line tool|tool|bot|dashboard|project|library|sdk|game|prototype|mvp|platform|system|portal|extension)";
// Parts of a project only. A noun that can also be a whole app (api, service, dashboard, backend …) is unsure in an
// existing project: "build an inventory REST API" there may be a new app in the wrong folder.
const SUBSYSTEM = "(?:module|subsystem|feature|endpoint|page|screen|component|integration|webhooks?|queue|worker|cron job|scheduler|admin panel|panel|pipeline)";
// "feature": the start message calls this job "add to a feature", so "add X to the Y feature" is it.
const THING = "(?:endpoint|route|api|module|page|screen|component|service|command|form|model|table|class|cli|report|export|import|view|handler|controller|resolver|query|feature)";
const VERSION = "(?:v?\\d[\\w.]*|latest|the latest(?: versions?)?|their latest versions?)";
// One describing word at least (SOME needs none): feature-new.
const SOME_ONE = SOME.replace("{0,6}?", "{1,6}?");
// What a fault sounds like, for "the problem, fix it".
const PROBLEM = "(?:bugs?|crash(?:es|ed|ing)?|errors?|exceptions?|broken|breaks|fails?|failing|failed|freez(?:es|ing)|hangs|blank|wrong|incorrect|(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not|won'?t|will not|stopped|not) work(?:ing|s)?)";
// The fault words that say nothing about software on their own: "the wifi is broken".
const GENERAL_FAULT = /\b(?:broken|breaks|fails?|failing|failed|freez(?:es|ing)|hangs|blank|wrong|incorrect|(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not|won'?t|will not|stopped|not) work(?:ing|s)?)\b/g;
// Whole capabilities a person names without "a": a closed list, so "add milk" is never a feature.
const CAPABILITY = "(?:authentication|auth|log[- ]?in|sign[- ]?up|sign[- ]?in|registration|search|dark mode|light mode|notifications|payments|checkout|pagination|file uploads?|i18n|internationali[sz]ation|locali[sz]ation|analytics|rate limiting|caching|offline mode|two[- ]factor(?: authentication)?|2fa|password reset)";
// Screen elements: what "add X to the Y" must add to be a feature change.
const UI_PART = "(?:button|field|input|box|checkbox|check box|dropdown|drop-down|select|menu|link|icon|column|row|filter|toggle|switch|tooltip|placeholder|label|badge|counter|dialog|modal|popup|pop-up|banner|footer|header|sidebar|navbar|nav bar|tab|card|section|widget|picker|slider|spinner|progress bar|search bar|form|table|chart|image|logo)";
const PKG = "[\\w@][\\w@/.-]*";
const DEP_WORDS = "(?:(?:npm |pip |python |node |go |js |javascript )?(?:dependencies|deps|packages|libraries|modules))";
// An upgrade of the dependencies ends there, or names a target version or a part of the project; anything else
// ("the deps list in the README") is about the dependencies, not an upgrade of them.
const DEP_TAIL = `(?: to ${"(?:v?\\d[\\w.]*|latest|the latest(?: versions?)?|their latest versions?)"})?(?: (?:in|for|across) (?:the |this |our )?[\\w./-]+)?`;

/**
 * Each job: the patterns that open an instruction for it, tried in this order
 * (the most specific first, so "add docstrings to X" is docs, not a feature).
 * `object` is the capture that must hold a real subject (not "it", not a typo).
 */
const JOBS = [
  { job: "deps", re: [
    new RegExp(`^(?:upgrade|bump|update) (?:the |our |all |all the |all our )?${DEP_WORDS}${DEP_TAIL}(?<object>)$`),
    new RegExp(`^(?:upgrade|bump) (?<object>${PKG})(?: from ${VERSION})? to ${VERSION}\\b.*$`),
    new RegExp(`^(?:update|migrate) (?<object>${PKG})(?: from ${VERSION})? to v?\\d[\\w.]*\\b.*$`),
    // "upgrade the lodash library": the start message calls this job "upgrade a library". Only "upgrade"
    // and "bump" (never "update the auth library", which may be a change to one's own code), only a named package
    // followed by library / package / dependency, and nothing after it but a target version.
    new RegExp(`^(?:upgrade|bump) (?:the |our )?(?<object>${PKG}) (?:library|package|dependency)(?: to ${VERSION})?$`),
  ], objectOptional: true },
  // No software word needed in the object ("write tests for the cart"): "tests" is the software word. A bare "add
  // tests" is still a follow-up (no subject).
  { job: "test", re: [
    /^(?:write|add|create|backfill|generate|increase|improve|expand)(?: more| some| missing| the)?(?: unit| integration| e2e| end-to-end| regression| api)? (?:tests?|test cases|test coverage|coverage|specs?)(?: for| of| on| to| in| covering)?(?<object>.*)$/,
  ] },
  { job: "docs", emptyObjectOk: true, re: [
    // A project's own documents are software by themselves; plain "docs" must say what they document. A README or
    // changelog needs nothing after it ("write a README").
    /^(?:write|add|create|generate|update|improve)(?: the| a| an| some| missing| inline| better)? (?:api docs|readme|docstrings|adrs?|architecture decision records?|changelog|jsdoc|javadoc|runbook)\b(?<object>.*)$/,
    // A section of the README by name ("write setup instructions in the README").
    /^(?:write|add) (?:the |some |a |an )?(?<object>(?:[\w-]+ ){0,3}(?:instructions|section|guide|steps|usage|overview|notes)) (?:in|to|into) (?:the |our )?readme\b.*$/,
  ] },
  { job: "docs", software: true, re: [
    /^(?:write|add|create|generate|update|improve)(?: the| a| an| some| missing| inline| better)? (?:docs|documentation)\b(?<object>.*)$/,
    /^document (?<object>.+)$/,
  ] },
  { job: "bugfix", software: true, re: [
    /^(?:fix|debug|resolve|repair|troubleshoot|diagnose and fix|investigate and fix|find and fix) (?<object>.+)$/,
  ] },
  { job: "bugfix", software: "fault", re: [
    // The problem first, then "fix it" ("the save button doesn't work, fix it"). The first part must describe a fault
    // (PROBLEM) and name the software by a word other than a general fault word ("the wifi is broken, fix it" names
    // nothing in the software: software "fault" below); "it" is that part.
    new RegExp(`^(?<object>(?:there(?:'s| is) (?:a |an )?)?.+?\\b${PROBLEM}.*?)\\s*(?:[,;:.!-]+\\s*|\\s+(?:so|and)\\s+)(?:please |pls |can you |could you |would you |kindly )?(?:fix|debug|repair|resolve) (?:it|this|that|them)(?: please| for me)?[.!]?$`),
  ] },
  { job: "refactor", software: true, re: [
    // "clean up" / "tidy up": the start message calls this job "clean up code"; the object must still
    // name something in the software, and a small edit ("clean up the formatting") is still not a job.
    // "split" and "simplify": the object must still name the software ("simplify this
    // sentence" is not a job).
    /^(?:refactor|restructure|reorgani[sz]e|consolidate|deduplicate|de-?dupe|de-duplicate|decouple|modulari[sz]e|clean[ -]?up|tidy[ -]?up|simplify|split up|split|break up) (?<object>.+)$/,
  ] },
  { job: "refactor", re: [
    /^extract (?<object>.+?) (?:into|to|out into) (?:a |an |the |one )?(?:shared |common |separate |new |single )?(?:module|util|utility|utils|helper|library|package|file|class|function|service|component)\b.*$/,
  ] },
  { job: "feature-extend", re: [
    new RegExp(`^(?:add|implement|support) (?<object>.+?) (?:to|in|into) (?:the |our )?(?:existing )?(?:[\\w./?{}:-]+\\s+){0,3}${THING}s?\\b.*$`),
    /^extend (?:the |our )?(?:existing )?(?<object>.+?) (?:to support|to handle|to allow|to accept|with)\b.*$/,
  ] },
  { job: "feature-new", re: [
    // The subject is the whole named part ("add a settings page" names a "settings page", not only the words after
    // "page"). A word must describe it, before the part or after it: "add a page" alone says nothing about what to
    // build.
    new RegExp(`^(?:add|build|create|implement|introduce) ${ART}${ADJ}(?<object>(?:${SOME_ONE}${SUBSYSTEM}\\b.*|${SUBSYSTEM}\\b\\s+\\S.*))$`),
    // A whole capability named without "a" ("add user authentication", "add dark mode"): a closed list.
    // Only when nothing is named after it but a purpose ("for admins", "with Google"): "add dark mode to the app" and
    // "add a search box …" are changes to a part, handled below.
    new RegExp(`^(?:add|implement|introduce|build) (?<object>(?:user |a |an )?${CAPABILITY}(?:$|\\s+(?:for|with|using|via|through|so|that|which)\\b.*))$`),
  ] },
  // A change to the app itself ("add a name field to the hello world app"). After feature-new, so a request that
  // already routed keeps its job ("add a new screen to the app" stays a new feature); "the app store" is publishing,
  // not a change to the app.
  { job: "feature-extend", re: [
    new RegExp(`^(?:add|implement|support) (?<object>.+?) (?:to|in|into) (?:the |our |my |this )?(?:existing )?(?:[\\w./?{}:-]+\\s+){0,3}(?:app|application|web ?app|website|site)s?(?!\\s+stores?\\b)\\b.*$`),
    // A part of the screen added to another part ("add a search box to the header", "add a delete button to each
    // to-do"): what is added must be a screen element (UI_PART), so "add my name to the list"
    // or "add a note to the email" never starts a workflow.
    new RegExp(`^(?:add) (?<object>(?:a |an |the |some )?(?:[\\w-]+\\s+){0,3}${UI_PART}s?\\b.*?) (?:(?:to|in|into|on|next to|under|above|below) (?:the |each |every |our |my |this )(?!(?:readme|docs?|documents?|documentation|emails?|slides?|deck|spreadsheets?|sheets?|pdf|notes?|messages?|pr|pull request|issues?|tickets?|wiki|summary|memo|essay|letter|posts?|blog|changelog|report)\\b)|(?:before|after|when|while) )\\S.*$`),
  ] },
  { job: "greenfield", re: [
    new RegExp(`^(?:build|create|make|scaffold|generate|develop|write|implement|code|set up|setup|bootstrap|spin up|start) (?:me |us )?${ART}${ADJ}(?:${TO_DO}|${SOME})${APP_NOUN}\\b(?<object>.*)$`),
  ], objectOptional: true },
  // "the" before a described app ("build the smallest to-do app"). Only in an empty folder (newFolderOnly), only with a
  // word describing the app ("build the app" alone is not a new app), and only the verbs that create: "start the dev
  // server" or "set up the backend" runs or configures something. In a project folder "build the mobile app" usually
  // means compiling it, so there it is no match.
  { job: "greenfield", newFolderOnly: true, re: [
    new RegExp(`^(?:build|create|make|scaffold|develop|code) (?:me |us )?the (?!${APP_NOUN}\\b)${ADJ}(?:${TO_DO}|${SOME})${APP_NOUN}\\b(?<object>.*)$`),
  ], objectOptional: true },
];

/** What a job may carry in a second clause without becoming two jobs: its own follow-up. */
const COMPANIONS = {
  bugfix: /^(?:add|write)(?: a| an| the)?(?: regression| unit)? tests?\b/,
  deps: /^(?:fix|patch|adapt|update) (?:whatever|what|anything|everything|all)?(?: that)? ?(?:breaks|broke|fails|failed|changed)\b|^(?:fix|patch|adapt)(?: to)? the (?:breakages?|breaking changes?|fallout)\b/,
};

/**
 * A brief pasted as the message: /mmo:greenfield's own brief layout, whose
 * first heading begins "# Project Brief" (greenfield.md step 2a), and not
 * followed by a question ("## Requirements … Is this list complete?").
 */
const BRIEF_HEADING = /^#\s+project brief\b/i;

function stripOpeners(s) {
  let prev;
  do { prev = s; s = s.replace(OPENERS, "").trim(); } while (s !== prev);
  return s;
}

/**
 * Whether an object is a real subject for a job. `own` is the part the first clause names by itself, before any
 * "and …" joined to it; `whole` includes what was joined. A negation, a pointer at pasted text, or a
 * subject made only of "it / this / that" is judged on `own`, so joining "and the tests" to "fix it" never
 * turns a follow-up into a job. Naming the software is judged on `whole`: "the discount and tax functions in
 * src/cart.js" names a file even though "the discount" alone does not.
 */
function realObject(own, whole, { software }) {
  const raw = (own ?? "").trim().toLowerCase();
  if (NEGATED_OBJECT.test(raw)) return { ok: false, why: "the request negates itself" };
  if (pointsAtText(raw)) return { ok: false, why: "about text in the message (below / above as a pointer), not the project" };
  const text = raw.replace(/[`'"(),.!?;:]/g, " ");
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.some((w) => !DEICTIC.has(w))) return { ok: false, why: "no subject of its own (it / this / that): a follow-up, not a new job" };
  // "fault": the general fault words (broken, wrong, doesn't work …) are not themselves a sign of software.
  const named = software === "fault" ? (whole ?? "").toLowerCase().replace(GENERAL_FAULT, " ") : (whole ?? "");
  if (software && !SOFTWARE.test(named.trim().toLowerCase())) return { ok: false, why: "names nothing in the software (no file, path, error, test, module …)" };
  return { ok: true };
}

/** The thing an object names: up to its first colon, preposition or clause. */
function objectHead(object) {
  return String(object ?? "").trim().split(/:|\s(?:for|about|on|of|to|in|into|with|from|by|at|where|that|which|who|when|while|so|because|after|before|since|until)\s/)[0];
}

/** Each job pattern with match indices on, so the object's start is known exactly (see clauseJobs). */
const INDEXED = new Map();
function indexed(re) {
  let r = INDEXED.get(re);
  if (!r) { r = new RegExp(re.source, re.flags.replace("d", "") + "d"); INDEXED.set(re, r); }
  return r;
}

/** A colon hands over the subject ("fix this bug: TypeError …"): what follows it is part of the object. */
function subjectOf(object, text) {
  const colon = text.indexOf(":");
  return colon >= 0 ? `${object.slice(0, Math.max(0, object.indexOf(":")))} ${text.slice(colon + 1)}` : object;
}

/**
 * Every job one clause could be asking for, in JOBS order (one entry per job, its first matching pattern).
 * `first` is the clause's first part as written before any "and …" was joined to it; the part of the
 * object inside it is what the clause names by itself, and the small-edit, follow-up and negation checks read
 * only that. With nothing joined, `first` is the clause and both views are the same.
 */
function clauseJobs(clause, first = clause) {
  const found = [];
  for (const spec of JOBS) {
    for (const re of spec.re) {
      const m = indexed(re).exec(clause);
      if (!m) continue;
      const object = m.groups?.object ?? "";
      const start = m.indices?.groups?.object?.[0] ?? clause.length;
      // The verb is a noun here ("fix is in the repo"). Only for a pattern that opens with its verb: a fault described
      // first ("the page is blank, fix it") has its object at the start and an "is" of its own.
      if (start > 0 && clause.split(/\s+/).slice(1, 3).some((w) => AUX.has(w))) break;
      const own = object.slice(0, Math.max(0, first.length - start));
      const subject = subjectOf(object, clause);
      const ownSubject = subjectOf(own, first);
      // A new app and a dependency upgrade carry their subject in the pattern itself (the app noun, the version):
      // what follows is context, and for a new app a brief below IS the input. Project jobs check their object.
      // A README or changelog asked for with nothing after it is a whole job (emptyObjectOk).
      const check = spec.objectOptional || (spec.emptyObjectOk && !object.trim())
        ? { ok: true }
        : SMALL_EDIT.test(objectHead(own))
          ? { ok: false, why: "a small edit (typo, spelling, formatting, lint, a commit message), not a pipeline job" }
          : realObject(ownSubject || own, subject || object, { software: spec.software === true ? true : spec.software === "fault" ? "fault" : false });
      found.push({ job: spec.job, check, ...(spec.newFolderOnly ? { newFolderOnly: true } : {}) });
      break;
    }
  }
  return found;
}

/**
 * The job a clause asks for in this folder: the first match the folder allows.
 * "Build a small Go service" reads as a new app or a new subsystem; only the
 * folder tells them apart (new folder: greenfield; existing project: feature-new).
 */
function pickJob(found, folder) {
  return found.find((f) => (folder === "new") === (f.job === "greenfield")) ?? null;
}

/**
 * The instruction a message's first line opens with, in lower case and with its polite openers removed ("can you
 * fix …" is "fix …"), or the reason it is not an instruction: nothing is asked, or it asks for information. Shared
 * by the workflow recogniser below and by hand-off mode's recogniser (lib/handoff-route.mjs), so both read a
 * question, a polite request and a sentence end the same way.
 */
export function requestLead(firstLine) {
  // The request: the first line, up to the first sentence end ("app.py" and "v1.2" are not sentence ends).
  const lower = String(firstLine ?? "").trim().toLowerCase();
  const sentence = /^(.*?)([.!?])(?:\s|$)/.exec(lower);
  // "I want a small to-do app", "I need an API for invoices": a request for something built, said
  // without a verb, reads as "build a …"; only before "a"/"an", so "I want to know …" stays a question.
  // A fault described in one sentence and "fix it" as the next ("The save button doesn't work. Can you fix it?"):
  // read as one request, "<the fault>, fix it". Only when the second sentence is exactly that.
  const rest = sentence ? lower.slice(sentence[0].length).trim() : "";
  const fixIt = sentence && sentence[2] !== "?" && /^(?:so |please |pls )?(?:(?:can|could|would) you (?:please )?)?(?:fix|debug|repair|resolve) (?:it|this|that|them)(?: please| for me)?[.!?]?$/.test(rest);
  const lead = stripOpeners((fixIt ? `${sentence[1]}, fix it` : sentence ? sentence[1] : lower).trim()).replace(/^i (?:want|need|would like|'d like)\s+(?=(?:a|an)\s)/, "build ");
  if (!lead) return { lead, reason: "no instruction" };
  if (INFO_OPENERS.test(lead)) return { lead, reason: "a question or a request to explain, not a job" };
  if (sentence?.[2] === "?" && !POLITE.test(lower)) return { lead, reason: "a question: it ends with a question mark and is not a can-you request" };
  return { lead, reason: null };
}

/**
 * The clauses of an instruction. A part after "and" / "then" / ";" starts a new clause only when it opens an
 * instruction: a verb (INSTRUCTION), or whatever else `opens` says opens one. Any other part is joined back to the
 * clause before it, exactly as written. Each clause carries `first`, its first part before anything was
 * joined to it.
 */
export function splitClauses(lead, opens = () => false) {
  const parts = lead.split(CLAUSE_SEPARATOR);
  const clauses = [];
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    if (!part) continue;
    if (!clauses.length || INSTRUCTION.test(part) || opens(part)) clauses.push({ text: part, first: part });
    else clauses[clauses.length - 1].text += parts[i - 1] + part;
  }
  return clauses;
}

/**
 * The /mmo: job this message asks for in a folder of this kind ("new" or
 * "existing"), or { job: null, reason, kind } when it asks for none or is unsure.
 * `args` is the one-line job description a brownfield command takes; greenfield takes none.
 *
 * `kind` says what the person is told, if anything: "chat" (a question, thanks, a follow-up, a small
 * edit: nothing is said), "instruction" (asks for work, but not one of the eight jobs), "folder-new-app" (a new app
 * asked for in a folder that holds a project), "folder-no-project" (a change asked for in a folder with no project),
 * "two-jobs", "brief-in-project".
 */
export function routeMessage(message, folder) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return { job: null, reason: "empty message", kind: "chat" };
  if (text.startsWith("/")) return { job: null, reason: "a typed command: Claude Code runs it itself", kind: "chat" };
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";

  const lastLine = text.split("\n").filter((l) => l.trim()).pop() ?? "";
  if (BRIEF_HEADING.test(firstLine.trim()) && !lastLine.trim().endsWith("?")) {
    return folder === "new"
      ? { job: "greenfield", args: "", reason: "a pasted brief in a new folder" }
      : { job: null, reason: "a brief pasted in an existing project: not sure it is a new build", kind: "brief-in-project" };
  }

  const { lead, reason: notAnInstruction } = requestLead(firstLine);
  if (notAnInstruction) return { job: null, reason: notAnInstruction, kind: "chat" };
  if (FOLLOW_UP.test(lead)) return { job: null, reason: "a follow-up to earlier work (also / as well / too / again), not a new job", kind: "chat" };

  // A part that opens one of the eight jobs is always a clause of its own (see splitClauses).
  const clauses = splitClauses(lead, (part) => clauseJobs(part).length > 0);
  if (!clauses.length) return { job: null, reason: "no instruction", kind: "chat" };
  // A pattern that counts only in an empty folder (newFolderOnly) is no match at all elsewhere, so a project folder
  // gives the same answer with or without that pattern.
  const found = clauseJobs(clauses[0].text, clauses[0].first).filter((f) => folder === "new" || !f.newFolderOnly);
  if (!found.length) return { job: null, reason: "no job verb opens the message", kind: JOB_VERB.test(lead) ? "instruction" : "chat" };
  const first = pickJob(found, folder);
  if (!first) {
    return folder === "new"
      ? { job: null, reason: `a ${found[0].job} job in a folder with no project`, kind: "folder-no-project" }
      : { job: null, reason: "words of a new build in an existing project: not sure which job", kind: "folder-new-app" };
  }
  if (!first.check.ok) return { job: null, reason: first.check.why, kind: "chat" };
  for (const { text: clause, first: part } of clauses.slice(1)) {
    const other = pickJob(clauseJobs(clause, part), folder);
    if (!other || other.job === first.job) continue;
    if (COMPANIONS[first.job]?.test(clause)) continue;
    return { job: null, reason: `two jobs in one message (${first.job} and ${other.job})`, kind: "two-jobs" };
  }

  const greenfield = first.job === "greenfield";
  const args = greenfield ? "" : firstLine.trim().replace(/\s+/g, " ").slice(0, 300);
  return { job: first.job, args, reason: `"${lead.slice(0, 60)}" opens a ${first.job} instruction; the folder agrees` };
}
