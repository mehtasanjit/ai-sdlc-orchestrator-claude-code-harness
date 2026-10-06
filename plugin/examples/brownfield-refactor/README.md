# Example — `refactor` intent

Two files with duplicated email-validation logic. Task: extract to a shared util and update
call sites.

## What's here

```
package.json
src/
├── signup.js        — validates email inline with a regex
├── invite.js        — validates email inline with the SAME regex
└── validators.spec.js — tests for email validity (used by both files today)
```

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-refactor ~/brownfield-refactor && cd ~/brownfield-refactor
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"
npm test

# In Claude Code, in this folder:
/mmo:refactor
```

## Expected outputs

- `src/validators/email.js` — new: single source of truth for `isValidEmail`
- `src/signup.js` — edited: imports from validators
- `src/invite.js` — edited: imports from validators
- Existing tests still pass (no behavior change)

See [intent_brief.md](intent_brief.md).
