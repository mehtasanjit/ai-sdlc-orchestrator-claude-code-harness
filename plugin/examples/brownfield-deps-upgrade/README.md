# Example — `deps` intent

A tiny Express app pinned to `lodash@4.17.20` — a version with a known prototype-pollution
advisory (CVE-2020-8203, patched in 4.17.21). Task: upgrade to a safe version and adapt any
code that breaks.

## What's here

```
package.json         — pinned lodash 4.17.20
src/
├── index.js         — Express app using lodash.merge for config
├── config.js        — deep-merges a default config with env overrides
└── config.spec.js   — one test verifying deep-merge behavior
```

## Try it

A brownfield run's write contract lives at the root of the git project that holds the run, so the example runs as a
git project of its own (inside a clone of this repository, the clone's root would hold it):

```bash
cp -R plugin/examples/brownfield-deps-upgrade ~/brownfield-deps-upgrade && cd ~/brownfield-deps-upgrade
printf 'node_modules/\n' > .gitignore
npm install
git init && git add -A && git commit -m "the example as shipped"
npm audit           # reports the CVE
npm test            # 1 test passes

# In Claude Code, in this folder:
/mmo:deps
```

## Expected outputs

- `package.json` — edited: `lodash` upgraded to a safe version (patched or a newer major)
- `package-lock.json` — written by the install, the run's own `tooling` step (`npm install`); never typed
- `src/config.js` — edited only if the upgrade changed the merge API (major bumps have)
- `src/config.spec.js` — unchanged (test is the invariant)
- Test still passes; `npm audit` clean

See [intent_brief.md](intent_brief.md).
