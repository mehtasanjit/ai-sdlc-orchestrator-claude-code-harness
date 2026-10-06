---
description: "Fix a specific defect on this repo: write a test that reproduces it first, then fix it. Alias into /mmo:brownfield with intent=bugfix pre-selected. Example: fix the /login endpoint returning 500 on missing password."
argument-hint: "[the bug, in one line]"
---

Bug-fix job on an existing repository — an alias into `/mmo:brownfield` with the job type
pre-selected. This command takes optional free text; finishing the sentence removes an interview
round-trip, but Gate 0 always fires and always re-confirms scope before anything is written.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent: bugfix` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
