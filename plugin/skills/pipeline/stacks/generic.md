# Stack adapter — generic

**Fallback adapter.** Used when Tier 1 discovery detects a stack we don't ship a first-class
adapter for (React/Next.js, Go, Rails, Java, Rust, Vue, Svelte, custom in-house, unknown). In
brownfield mode, this generic fragment is paired with the **adaptive stack profile** (Tier 2b,
written to `.sdlc/baseline/stack-profile.md`) — the profile wins on conflict because it reflects
the actual repo. This file is the baseline; the profile is the ground truth. Only brownfield runs read
the stack adapters: the architect, while it writes the change spec.

## When this adapter applies

The architect reads this adapter while it writes a brownfield change spec when:
- The detected stack manifest maps to a stack with no dedicated adapter, OR
- The stack is unknown, OR
- Discovery's adaptive-profile trigger fired but no matching pre-authored fragment exists

## Placement rules (§15)

Because the generic adapter can be pointed at any repo, placement is **entirely** inferred from
the adaptive stack profile + existing repo layout. The architect:

1. Reads `.sdlc/baseline/stack-profile.md` for the learned file-naming convention, folder
   structure, and framework-owned wiring pattern.
2. Reads `.sdlc/baseline/current.json` for `topology.top_level_dirs` and existing entry points.
3. Places each new file's unit where it MIRRORS the sampled patterns. Never invent a new layout
   convention.
4. Keeps every unit's `path` inside the scope confirmed at Gate 0 (the write contract's allowlist).

If no stack profile exists (adaptive-profile step was skipped), fall back to these defaults:
- **Source files** — under `src/` if it exists; otherwise sibling to the entry point file
- **Test files** — mirror the existing test-file location convention if any; else `tests/` at
  repo root
- **Doc files** — under `docs/` if it exists; else at repo root with a `.md` extension
- **Config files** — repo root (env, editorconfig, lint rules)

## Units, not packet types

Each file of the change is one unit of the spec: `create` for a new file, `edit` for an existing one
(its sites), in the `codegen`, `tests` or `docs` phase. Code derives one packet per unit and labels it;
the spec names no task type or subtype. A step a tool performs (installing a dependency, a generator the
stack runs) is a `tooling` unit with its shell command.

## Framework-owned wiring — the generic case

The generic adapter has no framework wiring of its own. If the stack profile identified a
framework-owned wiring pattern (a file that registers new ones), the registration is its own `edit`
unit of that file which `depends_on` the unit it registers, so it is typed after that file. A wiring
edit that fails its checks goes to a fix round like any other file.

## What each unit points its typist to

A typist sees the shared part of the spec, its own unit and the files the unit names. So for a file
of this stack:

- `style_from` — the existing file of the same kind the profile sampled (its shape in this repo)
- `uses` — the files it must agree with (a type it imports, the module it plugs into)
- `rules` — any framework-specific constraint the profile recorded, one rule per line
- `conventions` (the header) — the profile's house rules that hold for every file

**Do not include** a general framework tutorial — the profile snippets are the authoritative
"how this repo does X" reference.

## Test-runner idioms

Discovery already detected the test command, confirmed at Gate 0. A `tests` unit produces a file that
runs under that runner, and the command that runs one test file is a `file_checks` entry of the header.

## What NOT to do in this adapter

- Don't plan a file kind that belongs to a specific framework (a Prisma schema, a Nest controller, a
  Django view) from this adapter — those live in the framework-specific adapters.
- Don't assume ESM vs CJS, TypeScript vs JavaScript, or any language feature beyond what the
  profile confirmed. The profile is authoritative.
- Don't propose paths outside the confirmed allowlist. The write-contract hook will refuse them
  anyway, but a well-planned change never asks.
