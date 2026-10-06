# Stack adapter — NestJS + TypeScript

Detected by: `package.json` with `@nestjs/core` (or `@nestjs/common`) in `dependencies`. Usually
paired with Prisma, TypeORM, or Sequelize; those are detected separately and produce hints
below.

Carries over the existing greenfield NestJS expertise the plugin ships with. The architect reads it
while it writes a brownfield change spec, and still relies on the adaptive stack profile as ground truth — the snippets and conventions in
that profile OVERRIDE what's in this file when they disagree (the profile reflects the actual
repo; this adapter reflects idiomatic Nest in general).

## Placement rules (§15)

Nest projects follow strong conventions but with variations. Precedence:
1. **Stack profile** — mirror what the profile sampled from real files.
2. **Detected layout** — if the profile is absent, look at how existing modules are laid out
   in `baseline.topology.top_level_dirs` and the existing `src/` structure.
3. **Fallback** — if nothing to sample, use the conventions below.

### Fallback conventions (Nest idiom)

```
src/
├── main.ts                           ← app bootstrap; existing, never touched
├── app.module.ts                     ← root module; register new modules HERE
└── modules/
    └── <feature>/                    ← one folder per feature (bounded context)
        ├── <feature>.module.ts       ← @Module — declares controllers, providers, imports
        ├── <feature>.controller.ts   ← @Controller — one per resource
        ├── <feature>.service.ts      ← @Injectable — business logic
        ├── dto/
        │   ├── create-<x>.dto.ts     ← @IsString, @IsNotEmpty etc.
        │   └── update-<x>.dto.ts
        ├── entities/                 ← Prisma/TypeORM entity types (if not Prisma-inferred)
        └── __tests__/
            ├── <feature>.controller.spec.ts   ← @nestjs/testing + supertest
            └── <feature>.service.spec.ts     ← @nestjs/testing
```

**Framework-owned wiring** — Nest requires every new `@Controller` and `@Injectable` to be
declared in a `@Module`'s `controllers: [...]` and `providers: [...]` arrays. A file that isn't
wired does nothing. So for any new controller or service the spec holds, in order:

- the unit that creates `<feature>.controller.ts` (and its service);
- the unit that creates `<feature>.module.ts`, or an `edit` unit of the feature's existing module
  whose site adds to its `controllers: [...]` / `providers: [...]` arrays, `depends_on` the units it
  declares;
- an `edit` unit of `app.module.ts` whose site adds the feature module to `imports: [...]`,
  `depends_on` the module's unit.

Each wiring edit is typed after the file it registers. A wiring edit that fails its checks goes to a
fix round like any other file; nothing already written is undone.

## File kinds

What a unit's file holds for each Nest kind (its `behaviour` and `rules` say which):

| Kind | What the file holds |
|---|---|
| controller | Class annotated `@Controller('<path>')` with `@Get`/`@Post`/etc. handler methods |
| service | Class annotated `@Injectable()`, injected into controller/other services |
| module | `@Module({...})` class wiring controllers + providers + imports |
| guard | `@Injectable()` implementing `CanActivate` |
| interceptor | `@Injectable()` implementing `NestInterceptor` |
| filter | `@Catch(...)` implementing `ExceptionFilter` |
| DTO | Class with `class-validator` decorators (`@IsString`, `@MinLength`, etc.) |
| module wiring | An `edit` site adding a controller / service to a `@Module`'s arrays |
| Prisma model | An `edit` site adding a model to `schema.prisma` (if Prisma detected) |
| Prisma migration | A new migration file under `prisma/migrations/<timestamp>_<name>/`, a `create` unit that `depends_on` the schema edit |
| unit test | `@nestjs/testing`'s `Test.createTestingModule` with mocked deps |
| integration test | Same + supertest against a `NestFactory.create()` app instance |

## What each unit points its typist to

- `style_from` — the profile's snippet file of the same kind (or the nearest existing one)
- `uses` — the `@Module` file the new class is registered in, the DTO files of a controller (so
  parameter types resolve), the service a controller calls, and any base class or interface the file
  implements

An edit of `app.module.ts` that adds one line is one site at the `imports: [...]` array, not a rewrite of
the file.

## Config & env handling (Nest specifics)

Nest apps that use `ConfigModule.forRoot({ validationSchema })` require every referenced env
var to be present at boot. Discovery already recorded env-var references in
`baseline.env_keys_by_file` and `baseline.env_keys_referenced_in_code`. When a unit
introduces a new required env var:

1. Add it to `.env.example` (an `edit` unit whose site appends the key — never overwrite)
2. **Never** modify `.env` — that's off-limits and belongs to the user
3. Add it to `.env.test` if that file exists in the repo AND `intent ∈ (feature-new,
   feature-extend)`. Otherwise the test-runner probe (§7.4 step 2) will report the missing key
   and Gate 0 informs the user.

## Test-runner (Nest)

Discovery detected the test command. Nest projects almost always use Jest via `npm test` or
`pnpm test`. A `tests` unit produces a file compatible with the runner the Gate 0 confirmed test
command uses; the adapter itself doesn't override that choice.
