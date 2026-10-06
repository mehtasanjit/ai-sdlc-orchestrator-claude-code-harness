# Example — `bugfix` intent

An Express `/login` endpoint that returns 500 (an unhandled exception) when the request body is
missing the `password` field. Should return 400 with a validation error naming the missing
field.

## What's here

```
package.json
src/
├── index.js            — Express app + /login route
├── auth.js             — login handler that throws on missing password
└── auth.spec.js        — the SEEDED FAILING TEST that captures the bug
```

Run the test suite and you'll see one failing test — the one demonstrating what should happen
but doesn't.

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-bugfix ~/brownfield-bugfix && cd ~/brownfield-bugfix
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"
npm test    # 1 failing test: "returns 400 when password missing"

# In Claude Code, in this folder:
/mmo:bugfix
# The run types the test that reproduces the bug first, then the fix
```

## Intent brief

See [intent_brief.md](intent_brief.md).

## Expected outputs

The run types the test that reproduces the bug first, then the fix:

- `src/auth.spec.js` — edited: a `returns 400 when username missing` case, typed before any fix. Its red check
  runs that case alone (for example `node --test --test-name-pattern="username missing" {path}`) and must fail on
  the code as it is. The file already fails on its seeded case, so a check of the whole file could not show that
  the new case reproduces the bug: the server refuses that check.
- `src/auth.js` — edited: checks both fields before the credential check and throws an error naming the missing one.
- `src/index.js` — edited: answers that error with HTTP 400 `{ "error": "validation failed", "field": ... }`; any
  other error stays a 500. The route answers every error with 500 today, so the handler alone cannot return 400.

At the end the reproducing check passes, and so does the full suite (`npm test`), the seeded "returns 400 when
password missing" case included. Nothing outside these three files is written.
