---
description: "Run the AI-SDLC pipeline against an existing repository. Extends the plugin from greenfield-only to any real project — pick one of seven job types (docs, bugfix, feature-extend, feature-new, refactor, test, deps), confirm scope at Gate 0, and run with a non-destructive write contract that guarantees off-limits files stay untouched."
argument-hint: ""
---

Brownfield entry point. This command takes no arguments. Everything it needs it asks for.

Follow the operating manual in
`${CLAUDE_PLUGIN_ROOT}/skills/brownfield-guide/SKILL.md`,
with this handover:

- `intent:` — not set. Ask which job type at step 4a.
- `seed_description:` — not set. Run the full step 4b interview.
