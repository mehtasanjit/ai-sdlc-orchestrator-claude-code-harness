# Example — `docs` intent

A tiny 3-file Express app with no documentation. Demonstrates the `docs` intent producing a
README and JSDoc for the auth module.

## What's here

```
package.json          — Express + minimal deps
src/
├── index.js         — app bootstrap + route wiring
├── auth.js          — login / logout / verify handlers
└── errors.js        — the AppError class
```

Nothing has a docstring. There's no README explaining what the app does or how to use `auth.js`.
The `docs` intent turns that into: a project README, an auth module doc and JSDoc-annotated `auth.js`.

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-docs-gen ~/brownfield-docs-gen && cd ~/brownfield-docs-gen
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"

# In Claude Code, in this folder:
/mmo:docs
# Confirm scope at Gate 0: `README.md`, `docs/auth.md`, `src/auth.js`
# The pipeline adds JSDoc to src/auth.js, writes docs/auth.md, and rewrites README.md as the project's README
```

## Intent brief

See [intent_brief.md](intent_brief.md) for the pre-written brief. In an interactive run, the
plugin would interview you; this file demonstrates the shape it produces.

## Expected outputs

- `README.md` — edited: today it describes this example; the run rewrites it as the project's README, linking the auth module doc
- `docs/auth.md` — new, describes the auth module's API
- `src/auth.js` — edited, JSDoc annotations added to each exported function
- `.sdlc/runs/<run-id>/` — provenance, telemetry, final report

Nothing else in the repo should be touched.
