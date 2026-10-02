/**
 * Zero-touch hand-off mode, recognition half: which hand-off work a chat message asks for, or none
 * (docs/ambient-mode.md, "Hand-off mode").
 *
 * In a hand-off chat the chat's own model does the development. Five kinds of work go to the hand-off policy's model
 * instead, because each is mostly typing AND has a check that code can run on the result:
 *   docs    a new document of the project (a README, a guide, an API reference, a changelog)
 *   spec    a new spec (requirements, a design document, an API spec, a data-model write-up)
 *   plan    planning text (a plan, a task breakdown or tickets, a status report, release notes)
 *   tests   new tests for code that exists
 *   repeat  the same change repeated across files
 * Everything else (new code, a bug fix, a refactor, a question) stays with the chat's model.
 *
 * Fixed patterns, no model: the same message always gives the same answer. The message is read the way the workflow
 * recogniser reads it (lib/route.mjs: the first line's first sentence, polite openers removed, questions and
 * requests to explain set aside), then clause by clause. A clause is hand-off work when a creating verb opens it and
 * the thing it names IS one of the documents above, not something that merely mentions one: "add a changelog" is,
 * "add a changelog entry" and "add a section to the README" are edits to a file that exists and stay with the chat.
 * That is a grammar rule (the document word must close its noun phrase), not a list of exceptions.
 *
 * What this decides is the one line the person sees and the reminder the chat's model gets. The model can still hand
 * off work these patterns missed, and a new document typed by hand is refused by the hook whatever was recognised
 * here. So precision comes first: a wrong "this goes to the hand-off model" line is worse than a missed one. Unsure
 * is none.
 *
 * Unlike the workflow recogniser, a follow-up is fine here ("also add tests", "write tests for it"): nothing is
 * started, and the hand-off form makes the chat's model name the exact target.
 */
import { INSTRUCTION, pointsAtText, requestLead, splitClauses } from "./route.mjs";

/** The five kinds, in the order a line names them. */
export const HANDOFF_KINDS = ["docs", "spec", "plan", "tests", "repeat"];

/** Only so much of a first sentence is read: a request longer than this is not one crisp instruction. */
const MAX_LEAD_CHARS = 1000;

/** Words that carry a clause over from the one before ("also add tests", "then write the plan"). */
const CARRY_OVER = /^(?:(?:also|then|now|just|please)\s+)+/;

/** Verbs that ask for something new to be written. Updating, improving or fixing a file that exists is not here. */
const CREATE = "(?:write up|write|create|draft|generate|prepare|produce|compose|author|add|put together)";

/**
 * The words between the verb and the document word: modifiers only ("a short", "the api", "some unit"). Never a
 * preposition, a conjunction or a clause word, so the document word is the thing being written ("write a function
 * that parses the readme" names a function); and never a negation ("write no docs for now").
 */
const NOT_A_MODIFIER = "for|about|on|of|to|in|with|from|by|at|into|like|as|that|which|who|where|when|and|or|plus|but|if|so|then|is|are|was|were|be|no|not|never|without";
// Such a word counts only on its own: "on-call", "in-depth" and "no-code" are modifiers (as "to-do" is in the workflow
// recogniser's "a small to-do app").
const MODS = `(?:(?!(?:${NOT_A_MODIFIER})\\s)[\\w.+#/'-]+\\s+){0,5}?`;

/**
 * The document word closes its noun phrase: the clause ends there, or a comma, or a word that starts what the
 * document is about or for, or "and" before a second thing, or a closing adverb ("… too", "… now"). "A changelog
 * entry", "a design system" and "requirements.txt" go on, so they name something else.
 */
const CLOSES = "(?=\\s*$|\\s*[,:;&]|\\s+(?:for|about|on|of|in|with|from|by|at|to|covering|describing|explaining|documenting|listing|showing|that|which|so|based|using|as|per|and|or|plus|too|also|now|please|next|later|instead|here|there|today)\\b)";

/** Where one verb names a second thing: "tests and docs", "a README, a changelog and a guide". */
const AND = "(?:\\s*,\\s*(?:and\\s+)?|\\s*&\\s*|\\s+and\\s+|\\s+or\\s+|\\s+plus\\s+)";

const PLAN_WORD =
  "(?:plan|roadmap|breakdown|tickets?|user stor(?:y|ies)|epics?|backlog|checklist|release notes|" +
  "(?:status|progress|weekly|daily|monthly|sprint|incident) (?:report|update|summary)|post-?mortem|retrospective)";

/**
 * A "spec file" and a "requirements file" are left out on purpose: the first is a test file as often as a
 * specification, the second is requirements.txt as often as a requirements document. So are words for writing that
 * is not a document of the project (a proposal, a summary, an email).
 */
const SPEC_WORD =
  "(?:(?:design|requirements|architecture|technical|data[- ]model|schema|product|functional) (?:docs?|documents?|spec|specification|write-?up|description|overview)|" +
  "requirements|spec|specifications?|prd|rfc|adrs?|architecture decision records?|design|overview)";

const DOCS_WORD =
  "(?:(?:readme(?:\\.md)?|guide|manual|handbook|tutorial|walkthrough|runbook|faq|changelog(?:\\.md)?|change log|how-to|cheat ?sheet|glossary|" +
  "(?:api|cli|command|config(?:uration)?|sdk|endpoint) reference|" +
  "(?:setup|set-up|install(?:ation)?|build|deployment|usage|upgrade|migration) instructions|" +
  "(?<general>docs?|documents?|documentation))(?: file| page)?|" +
  // A document named by its file: "write CONTRIBUTING.md", "create docs/setup.md".
  "(?<named>[\\w./-]*\\w\\.(?:md|mdx|rst|adoc)))";

/** Plural "specs" is the test-file word ("write specs for cart.js"); a singular "spec" is a specification. */
const TESTS_WORD = "(?:tests?|test cases?|test suite|specs)";
/** Kinds of test, a closed class: two of them joined ("unit and integration tests") are still one thing, tests. */
const TEST_TYPE = "(?:unit|integration|e2e|end-to-end|regression|api|functional|snapshot|smoke|acceptance|component|contract|property|performance|load|ui)";

/**
 * Where a change is repeated: everywhere, across a whole part of the project, or in every one of a kind of place.
 * The nouns are places code lives or is used, so "all dependencies" (an upgrade) is not one.
 */
const SPREAD =
  "(?:everywhere|throughout|across (?:all the |all our |the |all |every |our )?(?:[\\w-]+ ){0,3}(?:codebase|repo|repository|project|files|modules|packages|components|services|tests|directories|folders|app)|" +
  "(?:all|every|each)(?: of)?(?: the| our)? (?:[\\w-]+ ){0,2}(?:files?|modules?|components?|packages?|services?|tests?|pages?|endpoints?|handlers?|controllers?|call ?sites?|calls?|usages?|uses|occurrences?|references?|imports?|instances?))";

/**
 * "Do the same …" and its like: the plainest repeated change there is. It names no place ("do the same"), or says
 * where ("… in the other three services", "… for the other handlers").
 */
const SAME_AGAIN = /^(?:apply|make|do|repeat|roll out|propagate) (?:exactly )?(?:the |this |that )?same(?: (?:change|edit|fix|update|rename|replacement|pattern|thing))?(?=\s*$|\s+(?:in|to|for|across|on|with|everywhere|throughout|here|there)\b)(?<rest>.*)$/;

/**
 * Each kind's patterns, tried in this order: the most specific document word first, so "a test plan" is a plan and
 * "a design doc" is a spec, not tests or docs. `verb` is the creating verb, `rest` what follows the document word.
 */
const KINDS = [
  { kind: "plan", re: [
    new RegExp(`^(?<verb>${CREATE}) ${MODS}${PLAN_WORD}${CLOSES}(?<rest>.*)$`),
    // "break the payments rewrite down into tasks", "break down the importer work into tickets"
    /^break (?:down )?.+? (?:down )?into (?:[\w-]+ ){0,2}(?:tasks|sub-?tasks|tickets|issues|stories|steps|milestones)\b(?<rest>.*)$/,
  ] },
  { kind: "spec", re: [new RegExp(`^(?<verb>${CREATE}) ${MODS}${SPEC_WORD}${CLOSES}(?<rest>.*)$`)] },
  { kind: "docs", re: [new RegExp(`^(?<verb>${CREATE}) ${MODS}${DOCS_WORD}${CLOSES}(?<rest>.*)$`)] },
  { kind: "tests", re: [
    new RegExp(`^(?<verb>${CREATE}|backfill) ${MODS}(?:${TEST_TYPE}${AND})*${MODS}${TESTS_WORD}${CLOSES}(?<rest>.*)$`),
    new RegExp(`^(?:increase|improve|expand|raise|backfill|add) (?:the |our |more )?(?:unit |integration |e2e )?(?:test )?coverage${CLOSES}(?<rest>.*)$`),
  ] },
  { kind: "repeat", re: [
    // A mechanical change verb plus where it is repeated. Fixing, adding and removing are not here: each place then
    // needs its own thinking ("fix the failing tests across the repo", "add error handling to every endpoint").
    new RegExp(`^(?:rename|replace|swap|switch|migrate|convert|change|update)\\b.*?\\b${SPREAD}\\b(?<rest>.*)$`),
    SAME_AGAIN,
  ] },
];

/** Put INTO something: "add documentation to the parseCart function", "add the README to the files list". */
const INTO = /^\s+(?:to|into|inside|onto)\b/;
/**
 * Put into a document that exists: "add installation instructions to the README", "add a FAQ to the README", "add a
 * troubleshooting section to docs/setup.md" are edits of that document, never a new one (write_document only creates
 * files, and the line would say a new document is written). The project's
 * standing documents by name (after to, into, inside, onto or in), a document file by its path (after to, into,
 * inside or onto: "write a guide in docs/guide.md" names a new file), or a part of a document, wherever the destination
 * stands ("add an overview of the API to the README").
 */
const INTO_DOCUMENT = /(?:^|\s)(?:(?:to|into|inside|onto|in)\s+(?:the |this |our |my |your )?(?:readme|changelog|contributing|license|code[_ ]of[_ ]conduct|security)(?:\.(?:md|mdx|rst|txt|adoc))?\b|(?:to|into|inside|onto)\s+(?:the |this |our |my |your )?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|rst|adoc|txt)\b|(?:to|into|inside|onto|in)\s+(?:the |this |our |my |your )(?:docs? page|guide|section|wiki|description)\b)/i;
/** A determiner that says the thing exists already ("the README", "our changelog"). */
const DEFINITE = /^(?:the|this|that|our|its|their|your|my)\b/;

/** The first pattern a clause matches: its kind, its creating verb (when it has one) and what follows the document word. */
function match(text) {
  for (const { kind, re } of KINDS) {
    for (const pattern of re) {
      const m = pattern.exec(text);
      if (!m) continue;
      const rest = m.groups?.rest ?? "";
      const verb = m.groups?.verb ?? null;
      if (kind !== "tests" && INTO_DOCUMENT.test(rest)) return null;
      if (INTO.test(rest)) {
        // General documentation put into something is an edit to code, and nobody can tell from the words whether
        // "add docs to the repo" means a document or comments: unsure is none.
        if (m.groups?.general !== undefined) return null;
        // "add the README to the package files list": a file that exists, put on a list. "Add a README to the repo"
        // and "add tests to the parser module" name something new.
        // A document named by its file is as definite as "the README".
        if (verb === "add" && kind !== "tests" && (m.groups?.named !== undefined || DEFINITE.test(text.slice(verb.length).trimStart()))) return null;
      }
      if (pointsAtText(rest)) return null;
      return { kind, verb, rest };
    }
  }
  return null;
}

/** How many things one verb may name before the rest is left unread ("a README, a changelog, a guide and tests"). */
const MAX_THINGS = 6;

/**
 * The hand-off kinds one clause asks for, and whether it also names work that is not hand-off work. One verb can
 * name several things: "add tests and docs for the parser" is tests and docs; "add logging and tests" is tests
 * beside the chat's own work. Each thing is judged on its own, as if the verb stood before it.
 */
function clauseWork(clause, left = MAX_THINGS) {
  const text = clause.replace(CARRY_OVER, "");
  const kinds = new Set();
  const hit = match(text);
  if (hit) {
    kinds.add(hit.kind);
    const next = hit.verb && left > 1 ? new RegExp(`^${AND}(.+)$`).exec(hit.rest) : null;
    if (next) for (const k of clauseWork(`${hit.verb} ${next[1]}`, left - 1).kinds) kinds.add(k);
    return { kinds, other: false };
  }
  // The first thing named is not hand-off work; a later one may be.
  const later = left > 1 ? new RegExp(`^(${CREATE}|backfill) .+?${AND}(.+)$`).exec(text) : null;
  if (later) for (const k of clauseWork(`${later[1]} ${later[2]}`, left - 1).kinds) kinds.add(k);
  return { kinds, other: kinds.size > 0 || INSTRUCTION.test(text) };
}

/** The sentences of a message's first line (at most five): a request is often the second one ("Thanks. Now write …"). */
function sentences(firstLine) {
  return (firstLine.match(/.+?(?:[.!?](?=\s|$)|$)\s*/g) ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 5);
}

/**
 * The hand-off work this message asks for: `kinds` (in HANDOFF_KINDS order, empty for none), `rest` (true when the
 * message also asks for other work, which the chat's model does itself), and `reason` in plain words.
 */
export function handoffMessage(message) {
  const none = (reason) => ({ kinds: [], rest: false, reason });
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return none("empty message");
  if (text.startsWith("/")) return none("a typed command: Claude Code runs it itself");
  const firstLine = (text.split("\n").find((l) => l.trim()) ?? "").slice(0, MAX_LEAD_CHARS);

  const found = new Set();
  let rest = false;
  let why = "no instruction";
  for (const sentence of sentences(firstLine)) {
    const read = requestLead(sentence);
    const reason = read.reason;
    const lead = read.lead.replace(/\s+/g, " ");
    // "Do the same …" opens like a question ("do we have tests?") and is an instruction; a real question still ends
    // with its question mark.
    if (reason && !(SAME_AGAIN.test(lead) && !sentence.endsWith("?"))) { why = reason; continue; }
    for (const { text: clause } of splitClauses(lead, (part) => match(part.replace(CARRY_OVER, "")) !== null)) {
      const work = clauseWork(clause);
      for (const k of work.kinds) found.add(k);
      if (work.other) rest = true;
    }
  }
  if (!found.size) return none(rest ? "an instruction, but no clause asks for a new document, spec, plan, tests or a repeated change" : why);
  const kinds = HANDOFF_KINDS.filter((k) => found.has(k));
  return { kinds, rest, reason: `asks for ${kinds.join(", ")}${rest ? " beside other work" : ""}` };
}
