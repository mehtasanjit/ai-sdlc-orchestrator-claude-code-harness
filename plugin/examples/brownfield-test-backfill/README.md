# Example — `test` intent

A payments service (`src/payments.js`) with no test coverage. Task: backfill unit tests to
reach reasonable coverage on the happy paths and the error cases.

## What's here

```
package.json
src/
├── payments.js   — charge / refund / getBalance functions, no tests
└── db.js         — in-memory store used by payments
```

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-test-backfill ~/brownfield-test-backfill && cd ~/brownfield-test-backfill
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"
npm test    # no test files yet

# In Claude Code, in this folder:
/mmo:test
```

## Expected outputs

- `src/payments.spec.js` — new: unit tests for charge / refund / getBalance
- Coverage includes: happy paths, insufficient-funds error, unknown-account error, idempotency

See [intent_brief.md](intent_brief.md).
