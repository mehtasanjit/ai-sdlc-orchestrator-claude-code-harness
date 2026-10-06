# Intent Brief — docs — Auth module docs + JSDoc

## Context

Small Express API with three modules. Auth module (`src/auth.js`) has three exported functions
(`login`, `logout`, `verify`) but no docstrings and no user-facing documentation. New
contributors have to read the code to understand the contract.

## Goal

- Add a top-level project README that names the app, lists the endpoints, and shows one curl
  example.
- Produce `docs/auth.md` documenting each function in the auth module — signature, arguments,
  return shape, error conditions.
- Add JSDoc comment blocks to each exported function in `src/auth.js`.

## Files in scope

- `README.md` (edit — today it describes the example; rewrite it as the project's README)
- `docs/auth.md` (create)
- `src/auth.js` (edit — JSDoc only, no behavior change)

Read, not written: `src/errors.js`, `src/index.js` (the error class and the routes the docs describe; outside the allowlist, so never written, and not off-limits, so the typists are shown them)

## Files off-limits

- Standard off-limits (`.env*`, other AI tools' configuration) apply. Everything outside the scope above is outside the allowlist, so the run cannot write it.

## Acceptance criteria

- README exists, has a project title, one-paragraph description, endpoint table, one curl
  example
- `docs/auth.md` exists, has a section per exported function with signature + argument table +
  return type + error cases
- Each exported function in `src/auth.js` has a JSDoc block above it (single-line if the
  function is trivial; multi-block for `login` and `verify`)
- No functional changes to any code — the JSDoc additions must not modify function bodies

## Non-goals

- Not updating `src/errors.js` or `src/index.js` (they'll be their own future intents)
- Not adding new endpoints or changing behavior
- Not generating OpenAPI / Swagger — that's overkill for a 3-endpoint app
