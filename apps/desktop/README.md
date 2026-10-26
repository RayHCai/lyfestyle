# Lyfestyle desktop

React + Tauri 2 desktop app for Windows. Front page is a greeting and a composer; everything else is reached from the faint menu in the top-left or the console (Ctrl K).

## Run

```
pnpm install            # from the repo root
pnpm desktop            # tauri dev (hot reload)
pnpm desktop:build      # installer under apps/desktop/src-tauri/target/release/bundle
```

Inside `apps/desktop`: `pnpm dev` serves the UI alone in a browser (storage falls back to localStorage, the agent is disabled).

## Agent

Messages go to the agent through `src-tauri/src/agent.rs`:

- Default: your local Claude Code. The app runs `claude -p --output-format stream-json --verbose --include-partial-messages`, writes the prompt to stdin, and passes `--resume <session id>` on later turns of the same conversation. Command and model can be changed in Settings.
- Override: set `LYFESTYLE_AGENT_COMMAND` in the environment before launching the app. That command is run instead, receives the prompt on stdin and `--session <id>` when resuming, and may print Claude-style JSON lines or plain text. Settings shows which harness is active.

The working directory for the agent defaults to the data folder so the agent can read your documents.

## Data

All data is plain files under the Tauri app data directory (shown in Settings):

```
settings.json
automations.json
conversations/<id>.json
documents/index.json
documents/<id>.md
```

## Keys

- `Ctrl K` opens the console from anywhere on the desktop (global shortcut, can be turned off in Settings) and toggles it inside the app.
- `Enter` sends, `Shift Enter` adds a line. `Esc` closes the console or the sidebar.
- In documents, Notion-style markdown shortcuts apply: `#` headings, `-` lists, `[]` todos, `>` quotes, `/` for the block menu.

## Screenshot mode

`pnpm exec vite --mode screenshot` serves the app with a hash-driven preview hook (compiled out of normal builds). Open `http://localhost:1420/#seed&view=documents`, `#seed&sidebar`, `#seed&console`, or `#seed&view=settings` to land on any surface with sample data, which makes headless screenshots possible without clicking through the window.

## API mode

Set an API URL and token in Settings, or export `LYFESTYLE_API_URL` and `LYFESTYLE_API_TOKEN` (or `API_TOKEN`) before launching. The app then uses the Lyfestyle API (`apps/api`) instead of local files:

- Conversations are API conversations. Each message queues a run; the app follows the run's events over `GET /runs/:id/stream` and shows assistant messages as they arrive. Stop calls `POST /runs/:id/cancel`. Runs only progress while `pnpm runner` is up.
- Documents are API pages (`/pages`), saved on every edit.
- Automations are API jobs. Daily and interval triggers map to cron; a Cron option takes any five-field expression in your time zone. "Run now" triggers the job and shows the run's output under the form.
- Settings shows the connection state. Local agent settings are ignored while the API is configured.

Leave both fields empty to return to local mode (flat files plus a locally spawned Claude Code).

In screenshot mode, `#api=<url>&token=<token>` connects a headless session to an API.
