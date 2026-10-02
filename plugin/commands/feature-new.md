---
description: "Design and add a new subsystem to this repo — endpoint, storage, and tests together. Alias into /mmo:brownfield with intent=feature-new pre-selected. Example: add a webhooks module (endpoint, storage, retry loop)."
argument-hint: "[the subsystem to add, in one line]"
---

Feature-new job on an existing repository — an alias into `/mmo:brownfield` with the job type
pre-selected. This command takes optional free text; finishing the sentence removes an interview
round-trip, but Gate 0 always fires and always re-confirms scope before anything is written.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent: feature-new` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
