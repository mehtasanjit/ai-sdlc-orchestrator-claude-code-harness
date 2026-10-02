---
description: "Show or change this project's active model policy. Bare: prints the current default_policy from .sdlc/project.json plus when it was set. `change`: terminal picker over shipped policies, with an explicit 'Author a new policy' option that opens the browser console. `--policy=<name>`: silent set, no browser."
argument-hint: "[change | --policy=<name>]"
---

Show or change the project's active model policy.

**Arguments:** $ARGUMENTS

Three shapes, one script (`${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs`) does all three:

# Shape 1 — no args: print the current policy

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --print-only --project-root "$(pwd)"
```

This reads `.sdlc/project.json.default_policy` and prints the policy name (or an empty line if
none is set). Also read `.sdlc/project.json.last_updated_at` and include it in the message:

- If a policy is set: `Current policy: <name>   (set <last_updated_at>, change with /mmo:policy change)`.
- If no policy is set: `No policy set yet — run /mmo:policy change to pick one, or /mmo:setup
  --policy=<name>.`

Do not open the browser here. Do not error. This shape is purely read.

# Shape 2 — `change`: terminal picker (browser only for authoring)

Picking one of the shipped presets is a one-line terminal question. Only "Author a new policy"
opens the browser. Steps:

## 2a — Guard mid-run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --guard-active-run --project-root "$(pwd)"
```

Parse the JSON. If `active: true`, print:

```
A brownfield run is in progress (run_id: <run_id>, phase: <phase>). Finish it or /mmo:revert <run-id> before changing the policy.
```

and STOP. Do not proceed to 2b.

## 2b — List available policies

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --list-json --project-root "$(pwd)"
```

Parse the JSON — one entry per policy in `${CLAUDE_PLUGIN_ROOT}/config/policies/`. Malformed YAMLs surface
as `{ name, error }` and should still appear in the picker (user can skip past them).

## 2c — Ask which policy

Use the `AskUserQuestion` tool with:

- **question:** `Which policy do you want as this project's default?`
- **header:** `Policy`
- **multiSelect:** `false`
- **options:** one per policy from 2b, in list order (`label` = policy name, `description` = `""`).
  Append a final option: `Author a new policy (opens browser)` with description
  `Opens the local policy console to create a custom YAML.`.

## 2d — Handle the pick

- If the user picked a policy name → go to 2e.
- If the user picked `Author a new policy (opens browser)` → run:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --project-root "$(pwd)"
  ```

  This starts the local policy console, opens the browser, and detects the save via `fs.watch`.
  When it returns, print the one-liner it emitted and STOP.

## 2e — Credential check

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --check-creds --policy=<chosen> --project-root "$(pwd)"
```

Parse the JSON.

- If `ok: true` → persist:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<chosen> --project-root "$(pwd)"
  ```

  Print `Policy set: <chosen>` and STOP.

- If `ok: false` → print each entry in `missing` with its `fix` string, e.g.:

  ```
  Missing credentials for policy "<chosen>":
    • <kind>: <name or "">
      fix: <fix>
  ```

  Then ask via `AskUserQuestion`:

  - **question:** `Fix the missing credential(s) and retry, or pick a different policy?`
  - **header:** `Retry`
  - **multiSelect:** `false`
  - **options:** `Retry (I fixed them)` and `Pick a different policy`.

  - `Retry (I fixed them)` → loop back to 2e (re-run `--check-creds` with the same policy).
  - `Pick a different policy` → loop back to 2b.

# Shape 3 — `--policy=<name>`: silent set

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<name> --project-root "$(pwd)"
```

No browser. The script validates `<name>` against files in `${CLAUDE_PLUGIN_ROOT}/config/policies/`, writes it to
`.sdlc/project.json.default_policy`, and exits. Fails if `<name>` doesn't exist on disk — offer
`/mmo:policy change` to author it, or list the shipped presets (the `.yaml` filenames under
`${CLAUDE_PLUGIN_ROOT}/config/policies/` — read the directory rather than reciting names, so the list can
never go stale).

# Notes

- The change is per-project. Once written to `.sdlc/project.json`, every subsequent `/mmo:greenfield` or
  `/mmo:brownfield` in this folder uses the new policy. Prior runs' `provenance.json` records the
  policy that was in effect at run time — those don't get rewritten.
- To change the policy for a single ticket without touching the project's default:
  - **Interactive** (`/mmo:brownfield`): type a different policy name at Gate 0's Policy bullet
    when reviewing the discovery summary. Accepted for that run only.
  - **Headless** (`/mmo:pass`): pass `--policy <name>` on the command line. Same one-run scope.
  Neither path writes to `.sdlc/project.json`.
- The browser opens only when the user picks `Author a new policy` under `change` (or the same
  option during first-time `/mmo:setup`). Picking a shipped preset stays in the terminal.
