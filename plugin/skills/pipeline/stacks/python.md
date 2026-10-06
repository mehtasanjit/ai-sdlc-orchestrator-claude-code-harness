# Stack adapter — Python (Django + FastAPI + Flask)

Detected by: `pyproject.toml`, `requirements.txt`, `Pipfile`, or `setup.py` at repo root, with
one of these dependency signals:
- `django` → Django adapter branch (below)
- `fastapi` → FastAPI adapter branch (below)
- `flask` → Flask adapter branch (light — fewer conventions)
- None of the above → falls back to the generic adapter; adaptive stack profile is authoritative

The three frameworks have very different conventions. This file describes each branch; the
architect, which reads it while it writes a brownfield change spec, picks the branch based on which
dependency was detected. If multiple are present (e.g. a Django project with an internal FastAPI
service), it uses the framework of the file being edited (via the file's imports); cross-cutting work
is settled at Gate 0.

The adaptive stack profile stays the ground truth — snippets in the profile override anything below
when they disagree.

---

## Django branch

### Placement rules (§15)

```
<project>/                              ← contains manage.py, settings/
├── manage.py                           ← existing, never touched
├── <project>/                          ← project package (settings, urls)
│   ├── settings.py OR settings/        ← env-driven config
│   └── urls.py                         ← root URL conf — REGISTER new app URLs here
└── apps/                               ← common convention; may also be flat
    └── <app_name>/                     ← one Django app per feature
        ├── __init__.py
        ├── apps.py                     ← AppConfig
        ├── models.py                   ← @dataclass-like Model classes
        ├── views.py                    ← view functions or class-based views
        ├── urls.py                     ← app-local URL conf
        ├── serializers.py              ← DRF, if detected
        ├── admin.py
        ├── migrations/                 ← auto-generated; never hand-edit
        └── tests/
            ├── __init__.py
            ├── test_views.py
            └── test_models.py
```

### Framework-owned wiring (Django)

Every new view must be registered in the app's `urls.py`, AND the app's URL conf must be
included in the project's root `urls.py`. So the spec holds, in order:

- the unit for `<app>/views.py` (`edit`, or `create` for a new file);
- an `edit` unit of `<app>/urls.py` whose site adds the URL pattern, `depends_on` the view's unit;
- an `edit` unit of `<project>/urls.py` (only if the app itself is new — one-shot registration),
  `depends_on` the app's `urls.py` unit.

Each wiring edit is typed after the file it registers; one that fails its checks goes to a fix round
like any other file.

Also: new models require migrations, and Django's `makemigrations` writes them, not a typist. Plan a
`tooling` unit that runs `python manage.py makemigrations <app>` and `depends_on` the model's unit.

### File kinds (Django)

| Kind | What the file holds |
|---|---|
| view | Function-based or class-based view |
| model | `models.Model` subclass |
| serializer | DRF serializer (if DRF detected) |
| URL registration | An `edit` site adding a path/pattern to `urls.py` |
| settings | An `edit` site adding the app to `INSTALLED_APPS`, middleware to `MIDDLEWARE`, etc. |
| view test | pytest-django or Django `TestCase` |
| migration | Not typed: the `tooling` unit above writes it |

### Django-specific test-runner

Django projects almost always use pytest-django or `python manage.py test`. Discovery detected
which. A `tests` unit produces a file compatible with the detected runner.

---

## FastAPI branch

### Placement rules (§15)

FastAPI has weaker file-layout conventions than Django. The stack profile is especially
important here. Common shapes:

```
src/OR app/                             ← package root
├── main.py                             ← FastAPI app instance + include_router() calls
├── routers/                            ← one file per router group
│   └── <feature>.py                    ← APIRouter with endpoints
├── models/                             ← Pydantic BaseModel classes
├── services/                           ← business logic
├── db/                                 ← SQLAlchemy models / session
└── tests/
    └── test_<feature>.py               ← pytest + httpx TestClient
```

Alternative shapes to detect from the profile:
- **Domain-driven**: `src/<domain>/{router,service,model}.py`
- **Flat**: everything in one package with `routes.py`, `models.py`, `services.py`

### Framework-owned wiring (FastAPI)

Every new router must be `include_router`'d in `main.py` (or wherever the FastAPI app instance
is constructed). So the spec holds, in order:

- the unit for `routers/<feature>.py` (`create`, or `edit`);
- an `edit` unit of `main.py` whose sites add `from routers import <feature>` and
  `app.include_router(<feature>.router, prefix="/<x>")`, `depends_on` the router's unit.

### File kinds (FastAPI)

| Kind | What the file holds |
|---|---|
| router | APIRouter with @router.get/@router.post handlers |
| Pydantic model | BaseModel subclass |
| service | Plain function or class; injected via Depends() |
| router wiring | An `edit` site adding an include_router() call in main.py |
| test | pytest + httpx.AsyncClient or TestClient |

---

## Flask branch

Flask is deliberately unopinionated. This adapter is thin — it relies almost entirely on the
adaptive stack profile. Common patterns detected:

- **Single-file app** — everything in `app.py`. Units edit `app.py` directly.
- **Application factory** — `create_app()` function; blueprints registered inside.
- **Blueprints** — one folder per blueprint under `blueprints/` or similar.

### Framework-owned wiring (Flask)

When blueprints are in use: a new blueprint requires `app.register_blueprint(<bp>)` in the factory,
an `edit` unit of the factory's file that `depends_on` the blueprint's unit — only in that case.

### File kinds (Flask)

Minimal — a route is `@bp.route` or `@app.route`, as the profile shows; say which in the unit's
`rules`. A `tests` unit produces a file compatible with pytest + `app.test_client()`.

---

## Common to all Python branches

### Config & env

Python apps typically use one of:
- `python-dotenv` + `os.getenv(...)` — env-driven
- `pydantic-settings` (formerly `pydantic.BaseSettings`) — validated at import
- `envalid` (rare in Python; more common in Node)
- `dynaconf`, `viper`, etc.

Discovery recorded which via `baseline.env_keys_referenced_in_code`. When a unit
introduces a new required env var:
1. Append to `.env.example` if present (an `edit` unit)
2. **Never** modify `.env`
3. If `pydantic-settings` is used, add the field to the Settings class (an `edit` unit of the
   settings module) — that's a code change, not just an env change

### Test-runner

Almost always `pytest` (with or without pytest-django). Discovery detected the exact command.
`tests` units produce files compatible with the runner Gate 0 confirmed. When `pytest-django`
is present, use `django_db` fixture in tests that touch the DB.

### Type hints

Detect via profile: is the codebase using type hints (`def foo(x: int) -> str:`)? If yes, ALL
new code adds them. If not, don't introduce them (mismatched style).
