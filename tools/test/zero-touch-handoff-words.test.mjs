/**
 * Zero-touch hand-off mode, recognition half: which hand-off work a chat message asks for, or none.
 *
 * In a hand-off chat the chat's own model does the development, and five kinds of typing-heavy work with a built-in
 * check go to the hand-off policy's model: a new document ("docs"), a new spec ("spec"), planning text ("plan"), new
 * tests ("tests") and the same change repeated across files ("repeat"). This half only reads the message: fixed
 * patterns, no model, the same message always gives the same answer. What it decides is the one line the person sees
 * and the reminder the chat's model gets; the model can still hand off work the patterns missed, and a new document
 * typed by hand is refused by the hook whatever was recognised here. So precision comes first: unsure is none.
 *
 * The labelled set below is the contract; the rules may change, these answers may not without a reason written next
 * to the case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { handoffMessage, HANDOFF_KINDS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff-route.mjs"));

// [message, the hand-off kinds it asks for, whether it also asks for other work]
const RECOGNISED = [
  // A new document whose words name a destination that is not an existing document.
  ["add a README to the repo", ["docs"], false],
  ["add a contributing guide to the docs folder", ["docs"], false],
  ["write a setup guide in docs/setup.md", ["docs"], false],
  // a new document of the project
  ["write a README for this project", ["docs"], false],
  ["Write a README.md for the api package", ["docs"], false],
  ["create a setup guide for new developers", ["docs"], false],
  ["please draft a user guide covering the export screens", ["docs"], false],
  ["Can you write an API reference for the billing endpoints?", ["docs"], false],
  ["add a changelog", ["docs"], false],
  ["generate the API docs for src/orders", ["docs"], false],
  ["write documentation for the billing module", ["docs"], false],
  ["put together a troubleshooting guide for the worker queue", ["docs"], false],
  ["write a getting-started tutorial", ["docs"], false],
  ["write up installation instructions for Windows", ["docs"], false],
  // A modifier that starts with a preposition and a hyphen is one word: "on-call", "in-depth" and "no-code" are not
  // read as "on", "in" and "no".
  ["write an on-call runbook", ["docs"], false],
  ["write an in-depth readme for the worker", ["docs"], false],
  ["write a no-code setup guide for the admin panel", ["docs"], false],
  // a new spec
  ["write the requirements for the export feature", ["spec"], false],
  ["draft a design doc for the cache layer", ["spec"], false],
  ["write a design document for offline sync", ["spec"], false],
  ["create an API spec for the orders endpoints", ["spec"], false],
  ["write up a data-model write-up for invoices", ["spec"], false],
  ["please write a technical spec for the retry queue", ["spec"], false],
  ["draft an ADR for moving to Postgres", ["spec"], false],
  ["write an architecture overview of the ingest pipeline", ["spec"], false],
  // planning text
  ["write a migration plan for moving to Postgres", ["plan"], false],
  ["draft release notes for v2.3", ["plan"], false],
  ["write a status report for this sprint", ["plan"], false],
  ["create tickets for the remaining checkout work", ["plan"], false],
  ["break the payments rewrite down into tasks", ["plan"], false],
  ["break down the importer work into tickets", ["plan"], false],
  ["write a test plan for the checkout flow", ["plan"], false],
  ["prepare a task breakdown for the search feature", ["plan"], false],
  ["write user stories for the onboarding flow", ["plan"], false],
  // new tests
  ["write unit tests for parseCart in src/cart.js", ["tests"], false],
  ["add tests for the discount rules", ["tests"], false],
  ["write tests for it", ["tests"], false], // a follow-up is fine here: the hand-off form makes the chat name the target
  ["also add integration tests for the orders API", ["tests"], false],
  ["write test cases for the tax function", ["tests"], false],
  ["Could you write specs for cart.js?", ["tests"], false], // plural "specs" is the test-file word
  ["increase test coverage of the parser", ["tests"], false],
  ["backfill tests for the auth module", ["tests"], false],
  // the same change repeated across files
  ["rename getUser to fetchUser everywhere", ["repeat"], false],
  ["replace moment with date-fns across the codebase", ["repeat"], false],
  ["apply the same change to the other handlers", ["repeat"], false],
  ["migrate all the tests to vitest", ["repeat"], false],
  ["change every call to logger.warn to logger.warning", ["repeat"], false],
  ["convert all the class components to function components", ["repeat"], false],
  ["update all the endpoints to return the new error shape", ["repeat"], false],
  ["switch every import of lodash to lodash-es", ["repeat"], false],
  // more than one kind, and hand-off work beside other work
  ["write a README and add tests for the parser", ["docs", "tests"], false],
  ["draft the design doc, then write a migration plan", ["spec", "plan"], false],
  ["fix the login bug and write tests for it", ["tests"], true],
  ["write release notes for v2.3 and update the version in package.json", ["plan"], true],
  ["add a rate limiter to the API and write a README for it", ["docs"], true],
  // two things named by one verb: each is judged on its own
  ["add tests and docs for the parser", ["docs", "tests"], false],
  ["write a README and a changelog", ["docs"], false],
  ["write unit and integration tests for the API", ["tests"], false], // two test types, one kind
  ["add logging and tests", ["tests"], true], // the logging is the chat's own work
  ["write tests and run them", ["tests"], true],
  // the request is a later sentence of the first line
  ["Thanks. Now write the README.", ["docs"], false],
  ["How do I run this? Write a setup guide for it.", ["docs"], false],
  // "do the same …" reads like a question opener but is the plainest repeated change there is
  ["do the same thing in the other three services", ["repeat"], false],
  ["make the same fix in orders.ts and invoices.ts", ["repeat"], false],
  ["now do the same for the other handlers", ["repeat"], false],
  // a document named by its file
  ["write CONTRIBUTING.md", ["docs"], false],
  ["create docs/setup.md for new developers", ["docs"], false],
  // a trailing "too", uneven spacing, capitals
  ["build me a todo app. write a README too", ["docs"], true],
  ["write   a   readme", ["docs"], false],
  ["WRITE A README", ["docs"], false],
  // a new document put somewhere
  ["add a README to the repo", ["docs"], false],
  ["add tests to the parser module", ["tests"], false],
];

// [message, why it is no hand-off]
const NOT_RECOGNISED = [
  // Put into a document that exists: an edit of it, never a new document.
  ["add installation instructions to the README", "an edit of the README"],
  ["add a FAQ to the README", "an edit of the README"],
  ["add a troubleshooting guide to docs/setup.md", "an edit of an existing document"],
  ["add an overview of the API to the README", "an edit of the README"],
  ["add a usage section in the README", "an edit of the README"],
  ["add a changelog entry to CHANGELOG.md", "an edit of the changelog"],
  // the chat's own work
  ["fix the /login endpoint returning 500 on missing password", "a bug fix is the chat's own work"],
  ["build me a todo app with a React frontend", "new code is the chat's own work"],
  ["refactor the payment module", "judgment-heavy"],
  ["add a rate limiter to the API", "a feature"],
  ["upgrade react to 19", "a dependency upgrade"],
  // questions and explanations
  ["what does the README say about setup?", "a question"],
  ["how should we document the API?", "a question"],
  ["explain the design doc", "asks for an explanation"],
  ["summarise the release notes", "asks for a summary"],
  ["should we write tests for this?", "a question"],
  ["is there a changelog?", "a question"],
  // edits to something that exists: small corrections stay with the chat
  ["fix the typo in the README", "an edit, not a new document"],
  ["update the README with the new setup steps", "an update to a file that exists"],
  ["add a section to the README about caching", "an edit: the thing named is a section"],
  ["add a changelog entry for this fix", "an edit: the thing named is an entry"],
  ["improve the docs", "an update, not a new document"],
  // documentation inside code files is an edit to code
  ["add docstrings to the scheduler package", "inline documentation is an edit to code files"],
  ["add jsdoc to every function in src/cart.js", "inline documentation"],
  ["add documentation to the parseCart function", "put INTO a code file"],
  ["document the auth module", "unsure: a document of its own, or comments in the code"],
  // the words mean something else
  ["add requirements.txt", "a file name, not a requirements document"],
  ["add a reference to the helper in index.ts", "a code reference, not a reference document"],
  ["create a design system", "the thing named is a system"],
  ["add test data for the orders table", "test data, not tests"],
  ["write a test helper for the fixtures", "a helper, not tests"],
  ["add manual retry logic", "manual is an adjective here"],
  ["add a timeline component", "a component"],
  ["generate a coverage report", "runs a tool"],
  ["create a model for invoices", "code"],
  ["plan the migration to Postgres", "unsure: the chat's own thinking, not a document"],
  ["write a spec file for the parser", "a spec file is a test file as often as a specification"],
  ["create a requirements file", "requirements.txt as often as a requirements document"],
  ["write a proposal to the client about pricing", "not a document of the project"],
  ["write an email to the team about the outage", "not a document of the project"],
  ["write a commit message", "a line, not a document"],
  ["add the README to the package files list", "a file that exists, put on a list"],
  ["add docs to the repo", "unsure: a document of its own, or comments in the code"],
  ["add docs/setup.md to the sidebar", "a file that exists, put on a list"],
  ["update CONTRIBUTING.md", "an update to a file that exists"],
  ["add requirements.txt and a Dockerfile", "files that are not documents"],
  ["add a plan tier to the pricing page", "the thing named is a tier"],
  ["write a failing test first", "a step of the chat's own work"],
  ["write a function that parses the readme", "the thing named is a function"],
  ["do we have tests for this?", "a question"],
  ["do the same?", "a question"],
  // negated, or about text in the message
  ["don't write tests yet", "negated"],
  ["write no docs for now", "negated"],
  ["write docs for the code below", "about text in the message, not the project"],
  // not the same change across files
  ["fix the failing tests across the repo", "each failure is its own fix"],
  ["update all dependencies", "a dependency upgrade"],
  ["rename the variable x to total in cart.js", "one file"],
  ["remove all tests for the legacy API", "deleting files"],
  ["add error handling to every endpoint", "each endpoint needs its own handling"],
  // not an instruction
  ["the README is out of date", "a statement"],
  ["tests are failing on main", "a statement"],
  ["thanks, that makes sense", "no instruction"],
  ["", "empty"],
  ["/mmo:docs write the API docs", "a typed command"],
];

test("the five hand-off kinds, in the order a line names them", () => {
  assert.deepEqual(HANDOFF_KINDS, ["docs", "spec", "plan", "tests", "repeat"]);
});

test("a message that asks for hand-off work is recognised, with every kind it names", () => {
  for (const [message, kinds, rest] of RECOGNISED) {
    const r = handoffMessage(message);
    assert.deepEqual(r.kinds, kinds, `${JSON.stringify(message)} → ${kinds.join(", ")} (${r.reason})`);
    assert.equal(r.rest, rest, `${JSON.stringify(message)}: other work beside it = ${rest}`);
  }
});

test("everything else is none: the chat's own work, questions, edits to what exists, inline documentation, look-alikes", () => {
  for (const [message, why] of NOT_RECOGNISED) {
    const r = handoffMessage(message);
    assert.deepEqual(r.kinds, [], `${JSON.stringify(message)} is no hand-off: ${why} (got ${r.kinds.join(", ")})`);
    assert.ok(typeof r.reason === "string" && r.reason, `a reason is given for ${JSON.stringify(message)}`);
  }
});

test("the same message always gives the same answer, and any input is safe", () => {
  for (const [message] of [...RECOGNISED, ...NOT_RECOGNISED]) {
    assert.deepEqual(handoffMessage(message), handoffMessage(message));
  }
  for (const odd of [undefined, null, 42, {}, "   ", "\n\n", "a".repeat(100000)]) {
    assert.deepEqual(handoffMessage(odd).kinds, []);
  }
});
