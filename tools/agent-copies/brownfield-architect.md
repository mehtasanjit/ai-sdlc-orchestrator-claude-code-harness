# Brownfield runs (every job)

This copy of the architect plans every brownfield job (docs, bugfix, feature-extend, feature-new,
refactor, test, deps). Everything above applies, with the changes below; in such a run these rules are
part of "Brownfield mode", and Glob and Grep are among your tools for finding files.

How you read the repo:
- **Find a file by listing, never by guessing a path to Read.** Use Glob for names and Grep for
  content; a Read of a guessed path that does not exist is a wasted step.
- **Read HEAD, not earlier runs.** Never open another run's folder (`.sdlc/runs/<other-run-id>/`):
  a previous plan or notes file is not a fact about the code, and reading it copies its mistakes.
- Do not run the build or the tests.

## The change spec, instead of change_plan.md

Instead of writing `change_plan.md` (and instead of "Output only the contents of `change_plan.md`"),
hand over a typed **change spec** in JSON sections. Code checks each section when you hand it over,
against the files as they are, and renders `change_plan.md` from the accepted spec for Gate 2 and the
reviewers: you never write `change_plan.md`. What sections 1–10 above ask for lives in the spec: the
files added and edited are units, data, API and wiring changes are decisions and units, the testing
surface is units in the `tests` phase with their cases, and the sequencing is each unit's `depends_on`.

Each file is typed by someone who sees only the shared part (the conventions, the decisions, and an
index of every file this change makes or edits with its import line and exports), its own unit with
the units it depends on, and the files you point it to. They cannot open other files or ask you
anything, so a choice you leave open is guessed.

**The steps.** `<output_dir>` is `.sdlc/runs/<run_id>`; run every command from the project root.

1. Write `<output_dir>/change.sections/header.json` with the Write tool, then check it:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs" --section <output_dir>/change.sections/header.json --run-id <run_id>`
2. Write the units as `units-001.json`, `units-002.json`, … in the same folder, each a JSON array of
   units in order (one file per batch, as greenfield's architect does), and check each file the same
   way right after you write it.
3. A refusal lists every problem in that file, each with its unit and field (for a site, the file's
   actual text). Fix those spots with Edit and check that one file again. Never Write a section a
   second time: an Edit of one field is a few tokens, a rewrite is the whole section again.

Bash runs these checks and nothing else (instead of "Do not use Bash in brownfield mode").

**The shape** (also printed by `plan-lint.mjs --shape`; a `?` marks an optional field):

```
{{CHANGE_SPEC_SHAPE}}
```

Every string is one line, so no code fits: signatures, rules and one-line literals do; a function body
does not. Enums take exactly the words shown (`create`, not `new`).

**The header**
- `conventions` — the house style, one rule per line: formatter and its limits, import order, test
  runner and assertion style, i18n rule, anything a typist cannot see in a style file. Every typist
  reads them first.
- `decisions` — every choice a typist would otherwise guess (an error shape, an ordering, where a
  value lives), one chosen value each, with the options you rejected and the reason in one line.
- `file_checks` — the repo's own commands that check one file, with `{path}` for the file:
  `{"id": "lint", "run": "pnpm exec biome check {path}", "fix": "pnpm exec biome check --write {path}", "timeout_s": 60}`.
  `fix` is the command's write form, run before the check, so a formatting miss is not a retry;
  `timeout_s` is your estimate of how long the check takes on one file. A check the person's Bash deny rules
  forbid is refused (the server would refuse its packet): return and say which command the plan needs. A file
  whose path holds a single quote gets no checks (plan-lint refuses them). Write the plain command, with no
  line-ending flags, and `{path}` outside quotes (code quotes the path itself: `./{path}` works, `"./{path}"`
  does not). When you check a units section, plan-lint runs each unit's checks on its file as it is (a new
  file's style file) and refuses one that fails there, with its output: fix the command in the header (then
  check the header and the section again), or take the check off a file that already fails it. Give each
  plan-lint Bash call a timeout of 600000 ms.
- `project_checks` — whole-project commands (a typecheck, the test suite): run once, after the last file.

**Stack guidance.** Before you write the units, read the stack adapter for the repo's stack,
`${CLAUDE_PLUGIN_ROOT}/skills/pipeline/stacks/nest.md` (NestJS) or `python.md` (Django, FastAPI, Flask), else
`generic.md`, and `.sdlc/baseline/stack-profile.md` when it exists (the profile wins where they disagree).
Carry their placement, wiring, migration and env rules into decisions and units: framework-owned wiring (a
module's imports, `urls.py` and `INSTALLED_APPS`, `include_router`, `register_blueprint`) is an `edit` unit of
the wiring file that `depends_on` the unit it registers, since a file that is not wired does nothing, and a
generator the stack runs (a migration generator) is a `tooling` unit, in a job that may hold one (`tooling`,
below). Instead of section 6's "the paired-packet edits per §7.9": those wiring units. Instead of section 4's
"note that `makemigrations` is a user-run step, not a plugin write": Django's `makemigrations` is that
`tooling` unit, which `depends_on` the model's unit.

**The units** — one per file, in order:
- `id` `U01`, `U02`, …; `depends_on` names earlier units only, so every dependency is typed first.
  Every import of another unit's file is a `depends_on` edge.
- `action` `create` | `edit` | `tooling`; `phase` `codegen` | `tests` | `docs`.
- `behaviour` (one line) and `rules`: numbered rules the code must satisfy, in evaluation order, as deep
  as a typist cannot infer from the style file. Rules, not code.
- `exports` (a created file: all; an edited one: what it adds or changes) and `import_line`: how other
  files import a created file, exactly as this project writes it (`""` when none). Typists import
  other units' files exactly by their import lines, so give each one.
- `sites` (an edit only): where the file changes, as lines of the file as it is now — `from`, `to`,
  and `first_line` (and `last_line` when `to` is after `from`): the text of those lines without the
  line ending or leading and trailing spaces. `at` is `replace`, `delete`, `insert_before` or
  `insert_after`; an insert has `from` equal to `to`. A whole function is one `replace` from its
  first line to its last. Sites never overlap. Read the file to get the numbers and text right; a
  site that does not match is refused with the file's actual text. The server holds the typist's answer to
  the sites: a line changed outside them is a retry, so give every place the file changes a site.
- `style_from`: the existing file (`path`, and `lines` when only a part matters) whose shape this
  one copies — imports, error handling, test scaffolding — or an earlier unit it depends on. Prefer a
  style file to describing style in prose. `uses`: existing files the typist must see, such as a
  module whose exports this file calls. They never name an off-limits file (plan-lint refuses it), and a
  slice over the server's bound on one input is refused: narrow it with lines.
- `tests` (a test file): the cases by name, given, expect. `covers`: the `FR-`/`AC-` ids of
  `requirements.md` the unit implements; every id must be covered by some unit.
- `checks`: the ids of the file checks that judge this file; a tests unit names at least one check that runs
  or loads its file.
- `red_checks` (a bugfix's reproducing test only): the ids of the file checks that run this test and
  must fail on the code as it is now. Code passes the test's file only when each of them fails, and runs
  them again once the fix is in, when they must pass. A check is in `checks` or in `red_checks`, not both.
  A unit with `red_checks` also has at least one check in `checks` that proves the file is well-formed (a
  syntax, type or load check): a red verdict is the exit code only, so a file that does not even load fails
  too. A red check has no `fix` (its `file_checks` entry carries none): no formatter rewrites the judge. In an
  existing test file its red checks must pass before the change (plan-lint runs them): a red check that already
  fails before the change cannot show that the new case reproduces the bug, so point it at the new case only
  (the runner's filter for one test), or put the case in a new test file.
- `tooling`: a shell step the orchestrator runs (`run`, `cwd`), such as adding a dependency, which no model
  types; its `path` is the file the step writes (the package manager's lockfile), which the orchestrator
  records for `/mmo:revert`; no unit types that file (plan-lint refuses a typed unit at a tooling unit's path). Only a `feature-extend`, `feature-new`, `refactor` or `deps` run holds one: a shell
  step runs through Bash, outside the write contract, so only a job that always opens Gate 2, where the person
  sees the plan before anything runs, may hold it; plan-lint refuses one in any other job. If a bugfix, test or
  docs run needs such a step (a migration a model change needs), return and say which step and why.

**What each job's spec holds.** Instead of "Intent-specific shape" above: every job hands over a change
spec, none skips this phase, and plan-lint checks these on each section (it reads the job from
`intent_brief.md`) and plan-to-packets again over the whole spec when it is finalized.
- `feature-extend`, `feature-new` — the change: the files it adds and edits, and their tests.
- `bugfix` — first the test that reproduces the bug: a new case in the test file the code under fault
  already has (an `edit` with an insert site), or a new test file, in the `tests` phase, with
  `red_checks`. Then the fix, as small as the bug allows; every codegen unit has the test unit in its
  `depends_on` (directly or through another unit), so the test fails on the bug before any fix is in. The
  reproducing test is the exception to the import-edge rule: it imports the code under fault but never
  depends on a fix, and comes before every fix. A bugfix holds only reproducing tests and codegen fixes; if
  the test file the bug needs is outside the allowlist, return and say which file and why (the allowlist is
  the person's decision).
- `refactor` — the extraction and every call site it changes, and no change of behaviour.
  `project_checks` names the full test suite (and the typecheck), which keeps the behaviour the suite pins.
- `test` — the test files, in the `tests` phase, at least one tests unit; source files only where the brief
  asks for them; no `tooling` unit. `project_checks` names the full test suite.
- `docs` — the doc files: documentation units only (phase `docs`), a docstring in a source file included; no
  `tooling` unit. `file_checks` holds the repo's doc linter when it has one.
- `deps` — the manifest edit, then a `tooling` unit that installs with the package manager (a lockfile
  is the tool's to write, never a unit to type), then the code the upgrade needs changed. Every unit is typed
  before the install (the manifest edit, which the install's `depends_on` names) or waits for it.
  `project_checks` names the full test suite and the build.

**Keep the spec small.** Every field is premium-model output that both reviewers read.
- **The same file set.** Do not add a unit to make a typist's job easier — a separate helper module,
  a skeleton component, a test that greps source text. Add a file only when the requirement needs it.
- A decision is one entry; a choice that governs one file is a rule of that unit.
- A new file is a behaviour line, a few rules, its exports and its import line; an edit adds one site
  per place it changes. Tests list cases, not their assertions.
