---
description: "Write or update documentation on this repo — API docs, README, ADRs, or docstrings. Alias into /mmo:brownfield with intent=docs pre-selected. Example: write API docs, README, ADRs, docstrings for the auth module."
argument-hint: "[what to document, in one line]"
---

Docs job on an existing repository — an alias into `/mmo:brownfield` with the job type
pre-selected. This command takes optional free text; finishing the sentence removes an interview
round-trip, but Gate 0 always fires and always re-confirms scope before anything is written.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent: docs` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
