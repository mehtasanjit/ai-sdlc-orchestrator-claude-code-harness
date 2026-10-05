# Feature runs (feature-extend, feature-new)

This copy of the architect plans brownfield jobs whose intent is `feature-extend` or `feature-new`.
Everything above applies, with the changes below; in such a run these rules are part of "Brownfield
mode", and Glob and Grep are among your tools for finding files.

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
  `timeout_s` is your estimate of how long the check takes on one file. Write
  the plain command, with no line-ending flags and no probing: before the change, code runs each check
  on the file as it is (on a new file's style file), and a check the file already fails there is set
  aside for that file and listed in the run's report.
- `project_checks` — whole-project commands (a typecheck, the test suite): run once, after the last file.

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
  site that does not match is refused with the file's actual text.
- `style_from`: the existing file (`path`, and `lines` when only a part matters) whose shape this
  one copies — imports, error handling, test scaffolding — or an earlier unit it depends on. Prefer a
  style file to describing style in prose. `uses`: existing files the typist must see, such as a
  module whose exports this file calls.
- `tests` (a test file): the cases by name, given, expect. `covers`: the `FR-`/`AC-` ids of
  `requirements.md` the unit implements; every id must be covered by some unit.
- `checks`: the ids of the file checks that judge this file.
- `tooling`: a shell step the orchestrator runs (`run`, `cwd`), such as adding a dependency; no
  model types it.

**Keep the spec small.** Every field is premium-model output that both reviewers read.
- **The same file set.** Do not add a unit to make a typist's job easier — a separate helper module,
  a skeleton component, a test that greps source text. Add a file only when the requirement needs it.
- A decision is one entry; a choice that governs one file is a rule of that unit.
- A new file is a behaviour line, a few rules, its exports and its import line; an edit adds one site
  per place it changes. Tests list cases, not their assertions.
