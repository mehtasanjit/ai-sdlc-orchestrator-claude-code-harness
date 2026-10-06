# Intent Brief — bugfix — /login 500 on missing password

## Context

The `POST /login` endpoint (in `src/auth.js`) throws an unhandled exception when the request
body is missing the `password` field, which surfaces to the client as HTTP 500 "internal
error." The seeded test at `src/auth.spec.js` reproduces this behavior — see the failing
"returns 400 when password missing" case.

Observed:
```
$ curl -s -X POST http://localhost:3000/login -H 'content-type: application/json' -d '{"username":"foo"}'
{"error":"internal error"}   # HTTP 500
```

## Goal

Return HTTP 400 with a structured error naming the missing field:
```
{"error":"validation failed","field":"password"}
```

Same for a missing `username`. Same status, same shape.

## Files in scope

- `src/auth.spec.js` (edit — the reproducing case for a missing `username`, typed first; the seeded case stays as it is)
- `src/auth.js` (edit — validate both fields before the credential check)
- `src/index.js` (edit — answer the validation error with 400; the route answers every error with 500 today)

## Files off-limits

- Standard off-limits apply. Everything else is outside the allowlist, so the run cannot write it.

## Acceptance criteria

- New test `returns 400 when username missing` fails before the fix and passes after it
- Existing failing test `returns 400 when password missing` passes
- HTTP status is 400, not 500
- Response body has both `error` and `field` fields
- No changes to the credential check itself — that's still `admin`/`hunter2`

## Non-goals

- Not switching validation library (no adding zod, joi, etc.)
- Not refactoring the whole auth module — smallest change that satisfies the acceptance
- Not adding rate limiting or other hardening — a separate concern
