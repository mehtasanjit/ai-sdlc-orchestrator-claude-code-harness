---
description: "Upgrade a dependency on this repo and patch the breaking-change fallout it causes. Alias into /mmo:brownfield with intent=deps pre-selected. Example: upgrade jest 28 → 29 (and adapt breaking changes)."
argument-hint: "[the dependency + target version, in one line]"
---

Dependency-upgrade job on an existing repository — an alias into `/mmo:brownfield` with the job
type pre-selected. This command takes optional free text; finishing the sentence removes an
interview round-trip, but Gate 0 always fires and always re-confirms scope before anything is
written.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent: deps` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
