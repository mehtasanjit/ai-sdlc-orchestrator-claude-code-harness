/**
 * Zero-touch routing, recognition half: which /mmo: job an ordinary chat message asks for, or none. Two signals
 * must agree: the message (an instruction whose job verb opens it) and the folder (a new folder can only be
 * greenfield; an existing project can only be one of the seven brownfield jobs). Precision first: a wrong route
 * starts a paid pipeline nobody asked for, a missed route only leaves the message to the chat itself. So anything
 * unsure is no route. The labelled set below is the contract; the rules may change,
 * these answers may not without a reason written next to the case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { routeMessage, folderKind, ROUTABLE_JOBS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));

const NEW = "new";
const EXISTING = "existing";

// [message, folder, expected job or null]
const ROUTED = [
  // "below" / "above" as a comparison (followed by an amount or a determiner) is part of the bug, not a pointer at
  // text in the message
  ["fix the bug where the cart total can go below zero when a discount is applied", EXISTING, "bugfix"],
  ["fix the discount code bug so totals in src/cart.js never drop below $0", EXISTING, "bugfix"],
  ["fix the validation bug that accepts quantities above 99 in the cart", EXISTING, "bugfix"],
  ["fix the bug where prices above the limit are not rejected in src/cart.js", EXISTING, "bugfix"],
  // greenfield: an instruction to build a whole app, in a new folder
  ["build me a todo app with a React frontend and a Node backend", NEW, "greenfield"],
  ["Create a small Go service that answers /ping with pong", NEW, "greenfield"],
  ["please build a REST API for a library catalogue", NEW, "greenfield"],
  ["Can you scaffold a new FastAPI backend for invoices?", NEW, "greenfield"],
  ["Let's make a simple CLI tool that converts units", NEW, "greenfield"],
  ["I want you to build a receivables-ops web app from the brief below.\n\n# Brief\n...", NEW, "greenfield"],
  ["# Project brief: TeamBoard\n\nA kanban board for small teams...", NEW, "greenfield"],
  // bugfix
  ["fix the /login endpoint returning 500 on missing password", EXISTING, "bugfix"],
  ["Fix the bug where the invoice total ignores discounts", EXISTING, "bugfix"],
  ["please debug why the export job crashes on empty files", EXISTING, "bugfix"],
  ["Can you fix the failing date parser test?", EXISTING, "bugfix"],
  ["fix this bug: TypeError: cannot read properties of undefined (reading 'id') in orders.ts", EXISTING, "bugfix"],
  ["fix the login bug and add a regression test", EXISTING, "bugfix"],
  // refactor
  ["refactor the payment module to remove the duplicated retry logic", EXISTING, "refactor"],
  ["Extract the shared date logic into a util module and update all call sites", EXISTING, "refactor"],
  ["please restructure the api folder by resource", EXISTING, "refactor"],
  ["consolidate the three config loaders into one", EXISTING, "refactor"],
  // test
  ["add unit tests for src/payments", EXISTING, "test"],
  ["Write integration tests for the orders API", EXISTING, "test"],
  ["backfill tests for the auth module to reach 80% line coverage", EXISTING, "test"],
  ["increase test coverage of the parser to 90%", EXISTING, "test"],
  // docs
  ["document the auth module", EXISTING, "docs"],
  ["Write API docs for the billing endpoints", EXISTING, "docs"],
  ["add docstrings to the scheduler package", EXISTING, "docs"],
  ["update the README with the new setup steps", EXISTING, "docs"],
  // deps
  ["upgrade jest from 28 to 29 and fix whatever breaks", EXISTING, "deps"],
  ["bump react to 19", EXISTING, "deps"],
  ["update all dependencies", EXISTING, "deps"],
  ["Upgrade the npm packages to their latest versions", EXISTING, "deps"],
  // feature-extend: a capability added to something that exists
  ["add a ?filter param to the existing /users endpoint", EXISTING, "feature-extend"],
  ["add pagination to the orders endpoint", EXISTING, "feature-extend"],
  ["extend the export command to support CSV", EXISTING, "feature-extend"],
  // feature-new: a new subsystem
  ["add a webhooks module (endpoint, storage, retry loop)", EXISTING, "feature-new"],
  ["add a notifications module with email and SMS", EXISTING, "feature-new"],
  ["build a new reporting page for managers", EXISTING, "feature-new"],
  // A small-edit word counts only as the thing named, not anywhere in the message.
  ["Build a multi-tenant helpdesk API in TypeScript with Fastify: organisations, tickets, ticket comments and tags", NEW, "greenfield"],
  ["fix the bug where comments are not saved", EXISTING, "bugfix"],
  ["fix 3 failing tests in the parser", EXISTING, "bugfix"],
  // "and" inside the thing named: a part after "and" that opens no new instruction is still the object, so " and "
  // does not cut the message.
  ["write unit tests for the discount and tax functions in src/cart.js", EXISTING, "test"],
  ["add unit tests for applyDiscount and addTax in src/cart.js", EXISTING, "test"],
  ["fix the rounding and overflow bugs in src/money.js", EXISTING, "bugfix"],
  ["add caching and rate limiting to the users endpoint", EXISTING, "feature-extend"],
  // "and" starting a clause that is not an instruction keeps the fix whole.
  ["fix the bug where parseDate accepts 2026-02-30 and returns 2 March instead of refusing it", EXISTING, "bugfix"],
  // A modifier that starts with a preposition and a hyphen is one word, not a preposition: "to-do" is not read as
  // "to". "To do" as two words counts only right after "a"/"an" and size words ("small").
  ["build a small to-do app", NEW, "greenfield"],
  ["build a to-do list app", NEW, "greenfield"],
  ["create a to do app", NEW, "greenfield"],
  ["build an on-call dashboard", NEW, "greenfield"],
  ["make an in-memory cache service", NEW, "greenfield"],
  // "the" before a described app, in an empty folder, is a new app, as "a" is.
  ["build the smallest to-do app", NEW, "greenfield"],
  ["create the hello world app", NEW, "greenfield"],
  // A change to "the … app" itself, as to "the … page". Tried after every other pattern, so nothing another pattern
  // routes moves.
  ["add a name field to the hello world app", EXISTING, "feature-extend"],
  ["add dark mode to the to-do app", EXISTING, "feature-extend"],
  ["add a contact form to the website", EXISTING, "feature-extend"],
  ["add a new screen to the app", EXISTING, "feature-new"],
  // Everyday wordings of the jobs.
  ["add a settings page", EXISTING, "feature-new"],
  ["create an admin panel", EXISTING, "feature-new"],
  ["implement a password reset feature", EXISTING, "feature-new"],
  ["add user authentication", EXISTING, "feature-new"],
  ["add a search box to the header", EXISTING, "feature-extend"],
  ["add a delete button to each to-do", EXISTING, "feature-extend"],
  ["add a confirm dialog before deleting a to-do", EXISTING, "feature-extend"],
  ["the save button doesn't work, fix it", EXISTING, "bugfix"],
  ["The save button does not work. Can you fix it?", EXISTING, "bugfix"],
  ["there's a bug in the date picker, please fix it", EXISTING, "bugfix"],
  ["the login page shows a blank screen, fix it", EXISTING, "bugfix"],
  ["simplify the checkout logic", EXISTING, "refactor"],
  ["split the big app.js into smaller modules", EXISTING, "refactor"],
  ["write tests for the cart", EXISTING, "test"],
  ["write a README", EXISTING, "docs"],
  ["update the README", EXISTING, "docs"],
  ["write setup instructions in the README", EXISTING, "docs"],
  ["build a landing page for my startup", NEW, "greenfield"],
];

const NOT_ROUTED = [
  // questions and explanations
  ["how do I fix the login bug?", EXISTING, "a question"],
  ["why does the export job crash on empty files?", EXISTING, "a question"],
  ["what would it take to refactor the payment module?", EXISTING, "a question"],
  ["should I upgrade jest to 29?", EXISTING, "a question"],
  ["can you explain how the auth module works", EXISTING, "an explanation, not a job"],
  ["is it worth adding tests for the parser?", EXISTING, "a question"],
  ["explain the architecture of this repo", EXISTING, "an explanation"],
  // negations
  ["don't refactor anything yet, just read the code", EXISTING, "negated"],
  ["please do not fix the bug, only find it", EXISTING, "negated"],
  // bare references to earlier context: a follow-up, not a new job
  ["fix it", EXISTING, "no object"],
  ["fix this", EXISTING, "no object"],
  ["refactor that too", EXISTING, "no object"],
  ["add tests for it", EXISTING, "no object"],
  // small edits: never a pipeline
  ["fix the typo in the README", EXISTING, "a typo"],
  ["fix the lint errors", EXISTING, "lint"],
  ["fix formatting in utils.py", EXISTING, "formatting"],
  ["rename getUser to fetchUser", EXISTING, "a rename"],
  ["update the button colour to blue", EXISTING, "an edit, not a dependency"],
  // two different jobs in one message
  ["refactor the parser and update the docs", EXISTING, "two jobs"],
  ["upgrade react to 19 and add tests for the forms", EXISTING, "two jobs"],
  // the folder disagrees
  ["build me a todo app with React", EXISTING, "greenfield words in an existing project"],
  ["fix the /login endpoint returning 500", NEW, "a bugfix in an empty folder"],
  ["add unit tests for src/payments", NEW, "tests in an empty folder"],
  // hand-written look-alikes of real messages
  ["so we need to fix the export job too?", EXISTING, "a question: it ends with a question mark and is not a can-you request"],
  ["fix is in the repo now, so the total is right", EXISTING, "'fix' as a noun: a verb follows it"],
  ["fix 2 worked fine", EXISTING, "'fix' as a noun: a verb follows it"],
  ["Build an inventory REST API in TypeScript with Express", EXISTING, "api/service/dashboard can be a whole app: unsure in an existing project"],
  ["build a new admin dashboard for managing users", EXISTING, "a dashboard can be a whole app: unsure in an existing project"],
  ["implement a new notifications service with email and SMS", EXISTING, "a service can be a whole app: unsure in an existing project"],
  ["add the export button to the reports page as well", EXISTING, "'as well': a follow-up to earlier work"],
  ["also refactor the parser", EXISTING, "'also': a follow-up to earlier work"],
  ["fix the same bug in the invoices module too", EXISTING, "'too': a follow-up to earlier work"],
  ["fix the upload bug again", EXISTING, "'again': a follow-up to earlier work"],
  // ordinary requests that are no job. A new app must be what is built (no preposition
  // between the article and the app word); a project job must name something in the software; a pasted brief
  // is /mmo:greenfield's own "# Project Brief" layout and not a question.
  ["write me a haiku about a bot", NEW, "a poem about a bot, not a bot"],
  ["write a cover letter for a backend role", NEW, "a letter, not a backend"],
  ["write an email to my boss about the project", NEW, "an email"],
  ["generate a report on the website traffic", NEW, "a report"],
  ["## Requirements\n- users can log in\nIs this list complete?", NEW, "a question about requirements"],
  ["# Project Brief: TeamBoard\n\nA kanban board.\n\nIs this brief complete?", NEW, "a brief with a question is a question"],
  ["fix the spelling: teh", EXISTING, "a spelling fix"],
  ["fix typo: teh -> the", EXISTING, "a typo"],
  ["fix the grammar: this are wrong", EXISTING, "grammar"],
  ["fix merged", EXISTING, "news, not a job: nothing in the software named"],
  ["fix deployed, thanks", EXISTING, "news"],
  ["fix nothing yet, just explain the bug", EXISTING, "negated"],
  ["fix your mistake", EXISTING, "nothing in the software named"],
  ["fix my last commit message", EXISTING, "a commit message edit"],
  ["troubleshoot my wifi", EXISTING, "not software in this project"],
  ["fix the code below", EXISTING, "pasted code, not the project"],
  ["fix the error above", EXISTING, "points at text shown earlier, not the project"],
  ["fix the bug described below", EXISTING, "points at text in the message"],
  ["fix the bug shown above in the log", EXISTING, "points at text shown earlier"],
  ["fix the failing test below: TypeError in src/cart.js", EXISTING, "points at pasted text"],
  ["fix the attached error in src/cart.js", EXISTING, "points at an attachment"],
  ["refactor done", EXISTING, "news"],
  ["restructure this essay", EXISTING, "an essay"],
  ["document what you did", EXISTING, "a follow-up about the chat"],
  ["update the deps list in the README", EXISTING, "a docs edit about deps, not an upgrade"],
  // not a pipeline job at all
  ["build the project", EXISTING, "compile, not a job"],
  // "the" before the app: only a described app in an empty folder is a new app. With nothing describing
  // it, or in a project folder, "build the … app" usually means compiling it.
  ["build the app", NEW, "'the app' alone: nothing describes a new app"],
  ["build the project", NEW, "'the project' alone"],
  ["build the mobile app", EXISTING, "compile the app in this project"],
  ["add my app to the app store", EXISTING, "publishing, not a change to the app"],
  // Look-alikes of the everyday wordings: a fault word alone is not software, a document is not a screen, and a
  // capability word followed by a part is a change to that part, never a whole new feature.
  ["the wifi is broken, fix it", EXISTING, "not software: 'broken' alone names nothing in the project"],
  ["this is wrong, fix it", EXISTING, "a follow-up about earlier text"],
  ["it does not work. can you fix it?", EXISTING, "a follow-up: 'it'"],
  ["add a table to the README", EXISTING, "a document edit"],
  ["add an image to the email", EXISTING, "an email"],
  ["put the logo on the slide", EXISTING, "a slide"],
  ["add my name to the list", EXISTING, "not a screen element"],
  ["add a page", EXISTING, "nothing says what the page is"],
  ["add unit tests", EXISTING, "a follow-up: no subject"],
  ["run the tests", EXISTING, "run, not a job"],
  ["review my PR", EXISTING, "review, not one of the eight jobs"],
  ["write a function that reverses a string", NEW, "a snippet, not an app"],
  // "to do" as two words is a modifier only right after "a"/"an" and size words: here "to" starts a purpose.
  ["write a script to do app releases", NEW, "a script with a purpose, not an app"],
  ["create a cron entry to do backups for the app", NEW, "a purpose, not an app"],
  ["status", EXISTING, "chat"],
  ["ok go", EXISTING, "chat"],
  ["thanks mate", NEW, "chat"],
  ["/mmo:greenfield", NEW, "a typed command is handled by Claude Code itself"],
  ["", NEW, "empty"],
  // "and": what the first part names is still judged on its own, so joining the rest never turns a
  // follow-up or a small edit into a job, and a new instruction after "and" is still a clause of its own.
  ["fix it and the tests", EXISTING, "a follow-up: its own subject is 'it'"],
  ["add it and the rest to the users endpoint", EXISTING, "a follow-up: its own subject is 'it'"],
  ["fix the typo and the broken link in src/app.js", EXISTING, "a small edit named first"],
  ["fix the header and run the tests", EXISTING, "the fix names nothing; running the tests is an instruction of its own"],
  ["write unit tests for the discount and refactor src/cart.js", EXISTING, "the tests name nothing; the refactor is a second job"],
];

test("every job the router can name is a /mmo: command that exists", () => {
  const commands = ["greenfield", "docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"];
  assert.deepEqual([...ROUTABLE_JOBS].sort(), [...commands].sort());
  for (const c of commands) readFileSync(join(ROOT, "plugin", "commands", `${c}.md`), "utf8");
});

test("routed: each instruction goes to its job, with the message as the job's description", () => {
  for (const [message, folder, job] of ROUTED) {
    const r = routeMessage(message, folder);
    assert.equal(r.job, job, `${JSON.stringify(message)} in a ${folder} folder: ${r.reason}`);
    if (job !== "greenfield") {
      assert.ok(r.args.length > 0 && r.args.length <= 300 && !r.args.includes("\n"), `a one-line description for ${JSON.stringify(message)}`);
    } else {
      assert.equal(r.args, "", "/mmo:greenfield takes no arguments");
    }
  }
});

test("not routed: questions, negations, follow-ups, small edits, two jobs, a disagreeing folder, chat", () => {
  for (const [message, folder, why] of NOT_ROUTED) {
    const r = routeMessage(message, folder);
    assert.equal(r.job, null, `${JSON.stringify(message)} (${why}) was routed to ${r.job}`);
    assert.ok(r.reason, "every no-route says why");
  }
});

test("'build the … app' in a project folder is read as compiling: never told it looks like a new app", () => {
  // Compiling is the usual meaning there, so it must never be told "this looks like a new app … open an empty folder".
  for (const message of ["build the mobile app", "build the hello world app"]) {
    const r = routeMessage(message, EXISTING);
    assert.equal(r.job, null, message);
    assert.equal(r.kind, "instruction", `${message}: ${r.reason}`);
  }
});

test("the folder check is /mmo:greenfield's own four signals of an existing repo, plus any source file", () => {
  const guard = readFileSync(join(ROOT, "plugin", "commands", "greenfield.md"), "utf8");
  for (const signal of ["`./src/` exists and is non-empty", "`git ls-files | head -1`", "`package.json`, `pyproject.toml`, `go.mod`", "longer than a stub (>200 bytes)"]) {
    assert.ok(guard.includes(signal), `greenfield.md still lists: ${signal} (if it changed, change folderKind with it)`);
  }
  const dir = mkdtempSync(join(tmpdir(), "mmo-route-"));
  const fresh = (name) => { const d = join(dir, name); mkdirSync(d); return d; };
  try {
    const empty = fresh("empty");
    assert.equal(folderKind(empty), NEW);
    const brief = fresh("brief-only"); writeFileSync(join(brief, "brief.md"), "# Brief\n" + "x".repeat(5000));
    assert.equal(folderKind(brief), NEW, "a brief alone is how a greenfield build starts");
    const shortReadme = fresh("short-readme"); writeFileSync(join(shortReadme, "README.md"), "# x\n");
    assert.equal(folderKind(shortReadme), NEW, "a stub README is not a project");
    const longReadme = fresh("long-readme"); writeFileSync(join(longReadme, "README.md"), "x".repeat(201));
    assert.equal(folderKind(longReadme), EXISTING);
    const src = fresh("src"); mkdirSync(join(src, "src")); writeFileSync(join(src, "src", "notes.txt"), "x");
    assert.equal(folderKind(src), EXISTING, "./src/ non-empty");
    const manifest = fresh("manifest"); writeFileSync(join(manifest, "go.mod"), "module x\n");
    assert.equal(folderKind(manifest), EXISTING);
    const code = fresh("loose-code"); writeFileSync(join(code, "main.py"), "print(1)\n");
    assert.equal(folderKind(code), EXISTING, "a source file of its own");
    const git = fresh("git"); execFileSync("git", ["init", "-q"], { cwd: git });
    writeFileSync(join(git, "notes.txt"), "x"); execFileSync("git", ["add", "notes.txt"], { cwd: git });
    assert.equal(folderKind(git), EXISTING, "git tracks a file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The start message lists the jobs as "clean up code", "upgrade a library" and "add to a feature": a request written
// in those words is recognised when it names what it is about, and still not when it names nothing in the software
// (precision first: a wrong route starts a paid workflow).
test("the job words the start message lists are recognised when they name what they are about", () => {
  const routed = [
    ["clean up the date helpers in src/utils", "refactor"],
    ["clean up the auth module", "refactor"],
    ["please tidy up the cart code", "refactor"],
    ["upgrade the lodash library", "deps"],
    ["bump the axios package", "deps"],
    ["upgrade the react library to 19", "deps"],
    ["add CSV export to the reports feature", "feature-extend"],
    ["add a due date to the to-do feature", "feature-extend"],
  ];
  for (const [message, job] of routed) {
    const r = routeMessage(message, EXISTING);
    assert.equal(r.job, job, `${JSON.stringify(message)}: ${r.reason}`);
  }
  const notRouted = [
    ["clean up my desk", "names nothing in the software"],
    ["clean up the formatting in src/app.js", "a small edit"],
    ["clean up", "no subject"],
    ["clean it up", "a follow-up"],
    ["upgrade my laptop", "not a package"],
    ["upgrade the auth library to support SSO", "a feature in a library, not an upgrade of it"],
    ["add a due date to each to-do", "names no part of the project"],
    ["how do I clean up the auth module?", "a question"],
  ];
  for (const [message, why] of notRouted) {
    const r = routeMessage(message, EXISTING);
    assert.equal(r.job, null, `${JSON.stringify(message)} (${why}) was routed to ${r.job}`);
  }
});

test("which messages the rules leave to Claude's judgement: requests they cannot place, never chat", async () => {
  const { judgeable } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  const { requestLead } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));
  const judged = (m, folder = EXISTING) => judgeable(routeMessage(m, folder), requestLead(m.split("\n")[0]).lead, m);
  for (const m of [
    "teh logn page 500s sort it out",
    "Password reset emails aren't being sent anymore, need this fixed asap.",
    "Express has to go to version 5. Upgrade it and adapt the route handlers.",
    "We need a new settings page for notification preferences.",
    "Give the weather widget a toggle between Celsius and Fahrenheit.",
  ]) assert.equal(judged(m), true, m);
  assert.equal(judged("I'd like a habit tracker CLI in Go that stores streaks in a local SQLite file.", NEW), true);
  for (const m of [
    "what does the checkout function return when the cart is empty?", // a question
    "thanks, that makes sense", "yes do it", "ok go ahead", // replies
    "rename the variable x to total in cart.js", // a small edit
    "let me think about it overnight", // chat
    "fix it", // a follow-up: the rules said so
    "fix the typo in the README", // a small edit: the rules said so
    "build me a todo app with React", // a new app in a project: the folder rule said so
  ]) assert.equal(judged(m), false, m);
});
