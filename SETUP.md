# Setup instructions

This file is written for Claude Code to follow. A user who says

> Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness

expects the setup to happen for them. Work through the steps below in order and report the
result. The user should not have to type any command.

Requirements: Node 20 or newer, and the Claude Code CLI. A new-app run types with Claude through
that CLI, so its `claude --help` must list `--tools`, `--append-system-prompt-file` and `--effort`
(`claude update` brings an older one up to date). Step 4 checks both and says what to do if either
is missing, and the run's pre-flight checks the CLI again before anything is spent.

---

## 1. Register the marketplace

```
/plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness.git
```

Use the full `.git` URL rather than the `owner/repo` shorthand. Shorthand sources clone over SSH
by default, which fails for anyone without a GitHub SSH key loaded — a public repo does not need
one, so do not introduce the requirement.

The marketplace registers under the name `tilicho-ai-labs`.

**If it answers that the marketplace is already declared, that command did nothing — and the
next step will install a stale version.** Claude Code caches the marketplace's clone on disk and
keys the install off it, so re-adding an already-registered marketplace is a no-op that leaves
the cached copy exactly as it was, however old. Someone who set this up weeks ago and re-runs the
two prompts today gets the version from weeks ago, with none of the fixes since, and nothing in
the output says so. Refresh it explicitly before installing:

```
/plugin marketplace update tilicho-ai-labs
```

That re-fetches from GitHub. Run it whenever the add reports an existing marketplace — it is
harmless when the cache is already current.

## 2. Install the plugin

```
/plugin install mmo@tilicho-ai-labs
```

Check the version it reports against `.claude-plugin/marketplace.json` on the repo's default
branch. If they differ, the refresh above was skipped; run it and install again.

The plugin's files are in place from here on, but neither its slash commands nor its bundled model
server are live in this session, and no reload makes them so: Claude Code builds the command list
and starts plugin MCP servers when a session starts. Do not go looking for a reload command —
`/reload-plugins` does not exist in the desktop app, and running it wastes the user's turn on an
error. Step 6 says what to tell them instead, and why running the pipeline here would produce a
wrong answer rather than merely an inconvenient one.

Continue with the build below. It runs as a shell command and does not need the plugin's slash
commands to exist.

## 3. Build the bundled model server

**This step is required. Skipping it produces a plugin that installs cleanly and then fails
partway through the first run.**

The plugin dispatches mechanical phases to a cost-efficient model through a bundled MCP server.
The plugin manifest points at that server's build output, which is not tracked in git — a fresh
install carries the source but neither the dependencies nor the build. Until this step runs, the
configured server path does not exist.

Locate the installed plugin and run its setup script:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)" --fix
```

`--fix` installs the server's dependencies and builds it. The script re-checks afterwards and
exits non-zero if the plugin still cannot run.

## 4. Read the result and tell the user where they stand

The script reports three kinds of finding:

- **`✗` blocking** — the plugin cannot run. Node older than 20, a missing Claude Code CLI, or a
  server build that failed. Each carries the command that fixes it. Resolve these before
  continuing.
- **`!` warning** — the plugin runs, but some policies will not. Missing credentials are
  reported here, never written on the user's behalf. Ask the user for whichever they need:
  - `ANTHROPIC_API_KEY` — required for vendor-billed runs, where reported costs reconcile
    against the Anthropic console. Not required when the user is signed in to a Claude Code
    subscription and runs under subscription auth.
  - Gemini access — required by any policy that routes mechanical phases to Gemini. The
    Claude-only policy does not need it. There are two ways in, and either satisfies the check:
    `gcloud auth application-default login` for **Gemini Enterprise Agent Platform** (the service
    Google renamed from Vertex AI — both names are still in circulation, and the API surface and
    the docs URLs still say `vertex`) on a Google Cloud project, which uses no key at all; or
    `GEMINI_API_KEY` for the AI Studio path. Offer the Google Cloud option first to anyone who
    already has a project — it bills that project and needs no secret on disk.
- **`✓`** — setup is complete.

**Where a credential is set matters as much as whether it is set.** Claude Code launched from the
desktop app does not inherit a login shell, so a variable exported in `~/.zshrc` or typed into a
terminal is invisible to it. There are two places that do work:

- **Nowhere — the Google Cloud path.** `gcloud auth application-default login` writes a credentials file
  to a fixed path that the plugin reads directly, and takes the Google Cloud project from that
  file's quota project. No environment variable is involved, which is why this is the option to
  offer first.
- **The `env` block of `~/.claude/settings.json`**, for anything that genuinely must be a variable
  — `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` on the AI Studio path. Claude Code reads that file at
  startup and passes the values through to the plugin's model server.

If the check reports `env-placeholders`, the variables are declared but were never set anywhere
Claude Code could see, and the server received the literal text `${GEMINI_API_KEY}` instead of a
value. The plugin now discards those and falls back to the credentials file, so the run is not
silently wrong — but the credential the user thought they had set is not in play.

## 5. Ask how Gemini should work on the mechanical tier

**Ask this only if step 4 reported Google Cloud credentials.** The agent path signs with
Application Default Credentials and has no API-key door, so on an AI-Studio-key-only install it is
not a choice — it is an option that cannot work. Skip the question entirely there and go to step 6.
Skip it too when there are no Gemini credentials at all.

With Google Cloud credentials present, there are two doors to the same model, billed to the same
project, and the user picks one. Present it as a two-option choice with **short labels only** —
no description on either option. Background lives in
[docs/setup.md](docs/setup.md#gemini-as-a-model-or-gemini-as-an-agent); link it if the user asks,
do not inline it.

- Through Gemini Enterprise Agent Platform (API)
- Through Antigravity SDK

On **Gemini Enterprise Agent Platform (API)**, say nothing further about it and continue. Nothing
needs to be written — that path is what an untouched install already does.

**If step 4 found no Google Cloud credentials, say what would open the second door**, rather than
skipping in silence. Someone who runs `gcloud auth application-default login` a week from now has
no reason to think of re-running this wizard, and will never be told the option exists:

> The other door — Gemini as an agent, through the Antigravity SDK — signs with Google Cloud
> credentials only. To open it later: `gcloud auth application-default login`, then re-run the
> setup check with `--enable-agent`.

The setup check says the same thing on its own from then on: once it can see real credentials on an
install that is still on the model path, it prints that `--enable-agent` line at the end of every
run. That is the surface people actually re-run, which is why the reminder lives there and not only
here.

On **Antigravity SDK**, run the same script from step 3 with `--enable-agent` instead of `--fix`:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)" --enable-agent
```

That flag writes the selection into `.claude/settings.local.json` in the current folder — this
folder only; add `--user` to set it for every folder on the machine — and then does everything
`--fix` does, including building the Python environment the agent path needs. `--disable-agent`
reverses it.

**Do not write `MMO_SELECT` into a settings file by hand, and do not have the user do it.** The
value is a `slot=option` pair, `gemini-flash=flash-agsdk-worker`, and the half that gets dropped
is the slot. A spec missing it looks right, passes the setup check, and then throws when the
policy loads — after the premium phases of a run have already been billed. The flag exists so that
nobody has to know the spelling.

Then pass on the probe the script offers at the end. Everything the setup check does is offline,
and the agent path's commonest failures are not missing files but a missing Model Garden
entitlement or a region that does not serve the model. Both first appear at the run's first
delegated packet, once the premium phases are already billed. The probe is one trivial delegation,
about two cents, and it is the only thing here that settles them.

## 5b. Choose this project's default policy — terminal picker

Per-project, not install-wide — a compliance-sensitive repo may want Opus everywhere while a
side project runs on Flash. The choice is stored in `.sdlc/project.json.default_policy` in the
current repo and picked up by every subsequent `/mmo:greenfield` or `/mmo:brownfield` in that folder.
Applies equally to greenfield and brownfield projects.

**Confirm you are in the project directory**, then run the picker. It stays in the terminal for
every shipped preset; the browser only opens if the user picks `Author a new policy`.

1. Enumerate policies:

   ```bash
   node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/setup-policy.mjs | tail -1)" --list-json --project-root "$(pwd)"
   ```

2. Ask the user via `AskUserQuestion` which policy to use. Options are one per policy from step 1
   (label = policy name) plus a final `Author a new policy (opens browser)`.

3. If the user picks a policy name, run the credential check:

   ```bash
   node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/setup-policy.mjs | tail -1)" --check-creds --policy=<chosen> --project-root "$(pwd)"
   ```

   - `ok: true` → persist with `--policy=<chosen>`. Done.
   - `ok: false` → print each missing item with its `fix`, then re-ask: retry (loop back to the
     check) or pick a different policy (loop back to step 2).

4. If the user picks `Author a new policy (opens browser)`, run the script bare:

   ```bash
   node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/setup-policy.mjs | tail -1)" --project-root "$(pwd)"
   ```

   This starts the policy console (`plugin/policy-console/`, a single HTML page served by a tiny
   Node http server, ~350 lines) on the first free port from 3000 upward, bound to `127.0.0.1`.
   First run only, `npm install` for one dep (`yaml`) — ~1 second. Opens the URL in the default
   browser (`open` on macOS, `xdg-open` on Linux). On a headless machine, pass `--no-browser`
   and the URL prints instead. Watches `plugin/config/policies/` via `fs.watch`; the save
   auto-detects — no need to return to the terminal to press Enter. Non-interactive fallback:
   after a 10-minute timeout the script exits cleanly with "no save detected".

   A console-authored YAML lands inside the installed plugin's `config/policies/` directory,
   which `/plugin update` replaces wholesale. To keep a custom policy across updates, copy it
   to `<project root>/routing-policy.yaml` — the loader prefers that file automatically.

Whichever the user chooses, `.sdlc/project.json` must have a `default_policy` field when this
step returns — the task commands read it via session-hydrate and refuse to run without it.

Passing `--project-root "$(pwd)"` is required on every invocation: the script writes bookkeeping
into the caller's project, not into whichever git worktree an earlier `cd` may have drifted the
shell into.

To inspect the current project's saved default from any terminal:

```bash
node ".../scripts/setup-policy.mjs" --print-only --project-root "$(pwd)"
```

## 6. Hand over

`verify-setup.mjs` from step 3 already prints a next-steps banner on success. State plainly what
is installed, which policies are available given the credentials present, then deliver the banner
verbatim so the user sees every command they can now use:

```
✓ Setup complete for this project.

  Try one of these in a NEW session in the same folder:

    /mmo:greenfield          — generate a new app from a brief (empty folder)
    /mmo:brownfield   — work on this existing repo (docs, bugfix, feature, refactor, …)
    /mmo:policy       — show / change this project's model policy
    /mmo:pass         — headless/scripted run (for CI or replays)
    /mmo:setup        — re-verify or re-configure this install any time
```

Pick the one that matches the folder the user is standing in — the two task commands
(`/mmo:greenfield`, `/mmo:brownfield`) take no arguments and ask for whatever they need.

**Say this in the same breath: the command is not available in this session.** Claude Code builds
its list of slash commands when a session starts, and nothing written to disk afterwards can add
one to a session already running. The install is complete and correct; `/mmo:greenfield` simply arrives
one session late. Tell the user to open a new session in the same folder and type it there, where
it will be in the menu.

This boundary is not merely about the menu, and it is worth being firm about it. A session also
starts each plugin's MCP servers at startup, so in the session that performed the install, the
bundled model server is not connected either. Every dispatch to the cost-efficient tier goes
through that server. A run started here would not fail — it would quietly execute all nine phases
on the premium model and hand back a cost figure several times what the policy promises, which is
the one outcome this plugin exists to avoid. One new session is the whole remedy, and it is a
requirement, not a nicety.

Do not send the user to `/reload-plugins`. It does not exist in the Claude Code desktop app, so on
the surface where this is most likely to be read it produces a flat "isn't available in this
environment" and leaves the user with a working install and no way forward — a worse dead end than
the restart it was meant to save.

---

## Verifying later

The same script, without `--fix`, re-checks an existing install and changes nothing:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)"
```

Run it after `/plugin update`. An update re-copies the plugin from source, which removes the
build produced in step 3; re-running with `--fix` restores it.

The same script switches the mechanical tier between the two Gemini doors at any time, in either
direction — `--enable-agent` records the selection and builds the Python environment the agent path
needs, `--disable-agent` clears it. Both write this folder only; add `--user` for the machine.

Refresh the marketplace before updating, for the reason given in step 1 — an update reads the
cached clone, so without `/plugin marketplace update tilicho-ai-labs` it can reinstall the same
version it already has and report success:

```
/plugin marketplace update tilicho-ai-labs
```

Working from a git clone instead of an install:

```bash
npm run verify --prefix /path/to/ai-sdlc-orchestrator-claude-code-harness
```

---

## Brownfield addendum

If the user's intent is to use `/mmo:brownfield` (extend an existing repo — not generate a new
project from scratch), the plugin runs **additional prerequisite checks** after step 3's
`--fix`. Same script, extra flag:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)" --brownfield-check
```

`--brownfield-check` runs the greenfield checks in step 3–4 AND then appends:

- **Node ≥ 20 · git ≥ 2.30 · plugin command-name conflicts · filesystem permissions** on
  `~/.claude` and `.sdlc/local/` (via `plugin/scripts/env-checks.mjs`).
- **Credential discovery** — scans shell env, home-dir configs, shell rc files, repo `.env*` and
  code references for Anthropic, Gemini (Google AI Studio / Vertex AI), and Antigravity SDK.
  Names only, never values. (via `plugin/scripts/credential-discovery.mjs`.)

The shepherd behavior contract for prompt 1 in brownfield mode (documented in plan §25 and §23):

- **Sequential.** One section at a time, always clear where you are. Seven sections:
  `install`, `environment`, `repo-detection`, `credentials`, `repo-setup`, `policy`, `summary`.
- **Auto-do what you can.** Marketplace add, plugin install, MCP dist build, credential
  detection all happen without asking. Report success in one line.
- **Pause + guide + verify.** When a step needs human action — upgrade Node, install a missing
  binary, obtain an API key — print the exact command (with platform options), wait for the
  user to reply `done` / `skip` / `abort`, then **re-run the actual check** to verify. Never
  blindly trust the user's "done."
- **3 verification failures → offer skip or abort.** Don't loop forever.
- **Never restart from scratch.** After a fix, continue from where you were.
- **Persist progress via `setup-status-write.mjs`.** At the start of prompt 1, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-status-write.mjs" --reset --project-root "$(pwd)"`
  (initializes `.sdlc/local/setup-status.json` with all seven sections pending). At the end
  of each section, run `--section=<name> --project-root "$(pwd)"` with the section slug above.
  On completion of `summary`, run `--all-done --project-root "$(pwd)"` (clears the resume hint).
  Every call passes `--project-root "$(pwd)"` so the state file lands in the project the user
  is standing in, not in whichever git worktree an earlier `cd` may have drifted into.
  `session-hydrate.mjs` reads this file on every subsequent command; if a session dies
  mid-setup, the next `/mmo:brownfield` picks up from the first pending section — no user
  intervention needed, no new command required.
- **Final summary always.** Line-by-line status of what was done, what the user did, what was
  skipped (with consequences noted).

The plugin ships a settings fragment for CI:
`plugin/templates/settings-ci-fragment.json` pre-allows `Bash(git *)` so headless CI runs don't
prompt for permission on every git command. Users copy it into their `.claude/settings.json` for
CI-only project scope, or into `~/.claude/settings.json` for user scope.
