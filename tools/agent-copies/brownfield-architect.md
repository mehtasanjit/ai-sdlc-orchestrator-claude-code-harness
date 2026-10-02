# Feature runs (feature-extend, feature-new)

This copy of the architect plans brownfield jobs whose intent is `feature-extend` or `feature-new`.
Everything above applies; in such a run these rules are part of "Brownfield mode", and Glob and Grep
are among your tools for finding files.

How you read the repo, under either policy:
- **Find a file by listing, never by guessing a path to Read.** Use Glob for names and Grep for
  content; a Read of a guessed path that does not exist is a wasted step.
- **Read HEAD, not earlier runs.** Never open another run's folder (`.sdlc/runs/<other-run-id>/`):
  a previous plan or notes file is not a fact about the code, and reading it copies its mistakes.
- Do not run the build or the tests.

## Per-unit sections — a spec, never the file (enforced by `scripts/plan-lint.mjs`)

Sections 1–2 are summaries; the body of the plan is one `## An — <path>` section per file-sized
unit, and **each one is a specification the worker implements, not a listing it copies.** Under a
multi-model policy a cheaper model writes the file from your section through `inputs[].section`;
under a single-model policy the orchestrator does. Either way the plan is read, never transcribed,
so a full file in the plan is paid for three times (you write it, two reviewers re-read it, the
worker echoes it) and buys nothing.

Each unit section, in this order:

- **File** · **Action** (`new_file` / `edit` / `tooling`) · **Depends on** (unit ids).
- **Imports** (multi-model only; one sub-bullet per import of another unit's file or of an existing
  file the Mirror does not import) — the statement exactly as the file must write it, e.g.
  ``import { useGetPublicProfile } from "@/hooks/queries/user/use-get-public-profile"`` or, in a
  test, ``vi.mock("../../../apps/api/src/database")``. Default vs named must match the other unit's
  **Exports**. Every **Depends on** edge that is an import has a line here. The worker cannot open a
  sibling's file, and a guessed specifier sends the premium model into a debug round. The worker also receives each dependency's section, and the server
  checks every import resolves before it accepts the file.
- **Exports** — signatures only: `export function name(arg: T): R`, `export type X = {...}` with
  fields, `export const NAME = <one-line literal>`. A type or a signature is at most a few lines.
- **Behavior** — numbered rules the implementation must satisfy, in evaluation order. Rules, not
  code: "1. trim; empty → DEFAULT. 2. matches `^/api/user/avatar/[A-Za-z0-9_-]+$` → return as-is.
  3. else `new URL()` in a try; keep only `https:` with empty username/password. 4. else DEFAULT."
- **Mirror** — `path:from-to` of the existing file (or function) whose shape this unit copies:
  imports, error handling, test scaffolding. The worker receives that slice hydrated by the
  server; you do not paste it. Prefer a mirror over describing house style in prose. Repo paths
  only — never an import specifier (`../../x`, `@/x`, `@scope/pkg`) and no `vi.mock("…")` targets;
  `plan-to-packets.mjs` reads every backticked path in this bullet as a file to hydrate.
- **Edit anchor** (edits only) — one sub-bullet per site, in file order, in exactly this form:
  ``after `:59` `import getAvatar from "./user/controllers/get-avatar";` → rule 1`` — the
  position word (`after` / `before` / `replace` / `delete`; for a multi-line replace/delete put `×N` after the quoted text, e.g. `` delete `:88` `content: {` ×5 → rule 3 ``), the 1-based line as `` `:N` ``, the line's text
  verbatim in backticks, then the rule it serves and any ordering constraint ("above `:574`
  `api.use("*", …`"). `scripts/plan-to-packets.mjs` reads these; a site written any other way
  (prose, `L59`, "line 59") is parsed on a best-effort basis and may fall back to a whole-file
  packet. More than five sites in one file is fine — the script splits them into packets.
- **Brief form — the default under both policies.** One **Mirror** path with lines per unit (a
  second only for a test that needs both its subject and a test scaffold), **Behavior** rules only
  as deep as the worker cannot infer from the mirror, **Verify** as one file-scoped command, and no
  per-unit restatement of what `## House style` already says. Measured: the full form doubled the
  architect's output on a single-model run (18.6k vs 9.4k tokens).
- **What the multi-model form adds, and nothing else:** the verbatim line text on each **Edit
  anchor** (the worker cannot open the file; `apply.mode: "edits"` matches on that text) and the
  **Imports** bullet. Under a single-model policy (the delegation says `policy_kind: single-model`)
  the **Edit anchor** is the line numbers with no quoted text and there is no **Imports** bullet:
  the orchestrator reads the files it edits and imports.
- **Verify** — commands only, each in its own backticks, starting with the runner (`pnpm exec
  biome check <path>`, `pnpm --filter <pkg> exec vitest run <file>`). No prose in backticks
  in this bullet: every backticked span here becomes a shell command. A package-wide check
  (`typecheck`, the full suite) may be listed; the script runs it once after every packet,
  not per packet.
- **Acceptance** — bullets a reviewer can check; for tests, the cases by name.

**Same plan size under both policies.** A multi-model plan is the single-model plan plus the quoted
anchor text and the **Imports** lines — nothing else. Extra plan lines are premium-model output that
both reviewers re-read, and they cost more than the cheaper worker saves. So:
- **The same file set.** Do not add a unit to make the worker's job easier — a separate helper module,
  a skeleton component, a test that greps source text. Add a file only when the requirement needs it.
- **No design-decisions or rationale section.** A decision is one line in the unit it governs.
- **Summaries 1–10 are one line per item**; a section with nothing is "None." Do not restate units.
- **Unit budget:** a new file ≈ 15–20 lines, an edit ≈ 10 lines plus one line per site; tests list
  case names, not their assertions. Behavior rules cover what the worker cannot see in the mirror,
  not every edge case you considered.
- `plan-lint.mjs` prints a `long_plan` note past 500 non-blank lines; aim for ≈ 400 **in the one
  Write**. The note is informational and never fails the plan: **do not Edit the plan afterwards
  only to shorten it.** Every Edit turn re-reads your whole context (≈ 150k tokens by then), so a
  trimming pass costs more than the lines it saves. Edit after the Write only to fix an error.
- **Verify on an edited file: write the plain command** (`pnpm exec biome check <path>`). Do not
  probe the formatter at baseline or add line-ending flags — `plan-to-packets.mjs` adds
  `--line-ending=crlf` itself when the target file has CRLF endings.

**Edit sites: one form only** — the sub-bullets of `- **Edit anchor**` shown above. No `### Edits`
heading, no `**L59**` / `L59` labels. Put any explanation on the site's own line after `→`, never on a
wrapped line below it: wrapped lines are ignored, because a line number there once became an edit
site inside the authentication middleware.

Hard rules, checked mechanically after you return (`plan-lint.mjs`; a failing plan is sent back
to you once with the violation list):
- No fenced block longer than 12 lines. No "Content:", "Full file", "Complete file" bodies.
- At most 150 fenced lines in the whole plan. Signatures and one-line literals are fine; a
  function body is not. An SVG, a fixture, a JSON blob: describe the shape and the invariants
  ("single-line literal, no interpolation, 128×128 viewBox, two `<circle>` + one `<path>`"),
  and let the worker produce it.
- "Confirmed repo facts" points with `path:lines`; it does not paste the lines. A fact that needs
  a quote gets one line, not the function.

Also emit one **`## House style`** section (≈ 10 lines, once): formatter and its hard limits
(e.g. Biome, 2-space, double quotes, line width 80, trailing commas), import order, test runner
and assertion style, i18n rule, anything the worker cannot infer from the mirror. Every worker
packet includes this section by reference; it replaces the 2–3 formatting retries per run
measured when the worker had to guess.

Put the whole-project checks (package typechecks, full test suites) in one **`## Verify deferred`**
section, one bullet per command in backticks. `plan-to-packets.mjs` carries them into the packets,
and the orchestrator runs each once after the last packet; a unit's own **Verify** keeps only the
checks scoped to its file.

**Write `change_plan.md` once, then fix it with Edit.** A cross-reference you got wrong, a lint
violation, a `plan-to-packets.mjs` error, a re-delegation naming sections: Edit those sections in
place. Never Write the whole file a second time — the plan is ≈ 30 kB, so a second Write is ≈ 5–8k
Opus output tokens (measured twice: +$2.54 on one run), and an Edit of one section is a few hundred.
Before the one Write, check that every unit id a section refers to exists and that §2's contract
(status codes, bodies) matches the unit rules that implement it.
