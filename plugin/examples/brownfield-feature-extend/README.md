# Example — `feature-extend` intent

Existing `GET /users` endpoint returns all users. Task: extend it to accept a `?role=<value>`
query param and filter results server-side.

## What's here

```
package.json
src/
├── index.js       — GET /users endpoint (returns all)
├── users.js       — in-memory user store
└── users.spec.js  — one passing test asserting the current shape
```

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-feature-extend ~/brownfield-feature-extend && cd ~/brownfield-feature-extend
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"
npm test

# In Claude Code, in this folder:
/mmo:feature-extend
```

## Expected outputs

- `src/index.js` — edited: read `req.query.role`, pass to `getUsers`
- `src/users.js` — edited: `getUsers(role?)` filters when provided
- `src/users.spec.js` — edited: new tests for the filter param (with role, with unknown role, no role)
- Existing test still passes (no regression)

See [intent_brief.md](intent_brief.md).
