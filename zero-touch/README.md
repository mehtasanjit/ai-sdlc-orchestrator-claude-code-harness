# zero-touch

The switch and the settings for zero-touch in the `mmo` plugin. Install it and every new chat has zero-touch, in the
mode you choose; disable it and new chats have none. The `/mmo:` workflows are untouched either way.

```
/plugin install zero-touch@tilicho-ai-labs
```

(In the desktop app: the plugin browser. Or, in any chat: "install the zero-touch plugin from the develop branch of
github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness". Claude Code installs and enables `mmo` with it. An
`mmo` already installed at an older version, which Claude Code leaves as it is, is updated by zero-touch itself at the
first chat (`scripts/mmo-update.mjs`, from the marketplace and scope it was installed from; once at a time; the chat
says to start a new one in a minute). Then start a new chat: plugins load when a chat starts.)

- **Choosing, in the chat:** the first chat after install asks before anything else, in Claude's own question box;
  you click, nothing to type or edit. Later, in any chat, type `change zero-touch settings` (any wording that names
  zero-touch works) and the same box opens. Always the same order: the mode first, then the models for that mode.
  - **Workflows** (workflow mode): a request typed in plain words that clearly asks for one of the eight `/mmo:` jobs
    starts that job's workflow, on the models you pick (Opus 5 + Flash 3.8, Fable 5.1 + Flash 3.8, Opus 5 + Sonnet 5, or Opus 5 only);
    every other message is an ordinary chat.
  - **Hand-off** (hand-off mode): the chat's own model (Opus 5 or Sonnet 5, your pick; the chat is kept on it) does
    the development, and new documents, specs and plans, new tests, and one change repeated across files each go to
    the model you pick for that kind of work (Flash 3.8, Sonnet 5, or Keep in chat) through the `mmo` plugin's
    hand-off tools, which check the result before it reaches your project. Plain words start no workflow there; a
    typed `/mmo:` command still does.
  - **Off:** the plugin stays installed and Claude works as normal, with nothing shown at a chat's start; the
    settings box still works.
- **Settings that cannot be used switch nothing on:** a damaged settings file, or one with a value that isn't one of
  the choices, is not used. Your last saved settings are used instead, or, if there are none, zero-touch is off; every
  chat says so until you choose again. A save that fails says so too, and nothing changes.
- **Setup check:** the moment you choose, zero-touch checks what your choice needs on this computer (Google for
  Flash 3.8, Claude Code's command-line program, git for a change to a project) and says "ready" or exactly what is
  missing and what to do. For Google, ask Claude: "help me connect Google for zero-touch".
- **When a choice applies:** in new chats (a new chat in the desktop app; in the terminal, a restart or `/clear`).
  An open chat keeps what it started with. The first chat after install uses its answers at once.
- **Your models, nothing else:** a project's own `routing-policy.yaml` and its saved choice in `.sdlc/project.json`
  are not used by zero-touch (the start lines say so in every chat in such a folder). A `/mmo:` command you type keeps
  following them.
- **What you see:** in the first new chat after you save your settings, a summary of them: which mode is on, which
  models run, how to change it. After that, only what needs your action, in every chat: Google not connected while
  your models need it, a Hand-off chat on the wrong model, settings that could not be read. Off shows nothing, and so
  does a chat after a compaction or when reopened. The terminal shows these at the top of the chat; the desktop app
  shows them with your first message. Then a line, starting with `Zero-touch:`, when it does something with a
  message (starts a workflow, hands work off, or declines a job-like request); ordinary chat gets none.
- **Turn it off:** choose Off in the settings box, or disable the plugin in Claude Code's plugin list (desktop app:
  **+** next to the prompt box → **Plugins** → **Manage plugins**; terminal chat: `/plugin` → **Installed**; shell:
  `claude plugin disable zero-touch@tilicho-ai-labs`). Either takes effect in new chats.
- **What it contains:** the settings box and the chat's start, in five hooks and the scripts in `scripts/`, and the
  registrations of zero-touch's sixteen workflow and hand-off hooks, which `hooks/mmo-hook.sh` runs in the installed
  `mmo` plugin's folder (the `mmo` plugin's own hook list registers none of them, so without this plugin none exists).
  Your choices are kept in the plugin's own data folder (`${CLAUDE_PLUGIN_DATA}/settings.json`), which Claude Code
  keeps across updates and deletes when the plugin is removed, so installing it again asks again. At the start of each
  chat the start hook writes the chat's record, `~/.mmo-ambient/sessions/<chat id>/chat_mode`, and the chat's
  models, notes where `mmo` is installed (`${CLAUDE_PLUGIN_DATA}/mmo-root`), and shows the start message. The code
  of zero-touch's workflow and hand-off hooks sits in the `mmo` plugin's folder (`scripts/ambient/`) and acts only in
  a chat with that record. This plugin has no code of `mmo`'s because Claude Code gives each plugin its
  own copy of any file it links to, which would mean a second build of the server; the one rule both need, whether
  this computer is connected to Google, is a copy of `mmo`'s own, and a test keeps the two identical.
- **Not checked live yet:** the settings box in the desktop app and an interactive terminal, and hand-off mode with a
  real model. The box itself has been probed with real models in `claude -p` runs.
- **Needs:** the `mmo` plugin (declared as a dependency) and Node.js 20 or newer. Without it, zero-touch says so once
  per chat and Claude works as normal.

How it works and what it stores: [docs/ambient-mode.md](../docs/ambient-mode.md).
