---
description: "Add a capability to an existing endpoint or module on this repo. Alias into /mmo:brownfield with intent=feature-extend pre-selected. Example: add a ?filter param to the existing /users endpoint."
argument-hint: "[the capability to add, in one line]"
---

Feature-extend job on an existing repository — an alias into `/mmo:brownfield` with the job type
pre-selected. This command takes optional free text; finishing the sentence removes an interview
round-trip, but Gate 0 always fires and always re-confirms scope before anything is written.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent: feature-extend` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
