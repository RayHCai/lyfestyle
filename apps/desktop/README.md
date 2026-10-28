# Lyfestyle desktop

React + Tauri 2 desktop app for Windows. Front page is a greeting and a composer; the rail on the left holds recent conversations, documents, automations, page views and settings, and the console (Ctrl T or Ctrl K) reaches everything.

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

Either way the agent gets the same tools, from `mcp.json` in the data folder (passed to Claude Code as `--mcp-config`, and to a custom command as the path in `LYFESTYLE_MCP_CONFIG`):

- `lyfestyle`: the app itself run as `lyfestyle --mcp --data-dir <data folder>`, a stdio MCP server with `pages_*` tools over your documents. The app re-reads them when a turn ends.
- `todo`: your todo app's MCP server, when Settings has its URL (`…/mcp/<secret>`), else `LYFESTYLE_TODO_MCP_URL` from the environment (dev builds also read it from the repo-root `.env`).

Claude Code is started with `--allowedTools mcp__lyfestyle,mcp__todo`, since print mode cannot ask for permission. In API mode the runner supplies the API's own tools, and saving the todo URL registers it with the API as the `todo` server.

The working directory for the agent defaults to the data folder so the agent can read your documents.

## Data

All data is plain files under the Tauri app data directory (shown in Settings):

```
settings.json
mcp.json                # rewritten on every send: the agent's MCP servers
notifications.json      # API mode: the last notification shown, per API URL
conversations/<id>.json
documents/index.json
documents/<id>.md
sync/<api host>/        # API mode: this device's copy of the API's pages (index.json, <id>.md)
```

## Keys

- `Ctrl K` toggles the console. It only works inside the app, so other apps keep their own `Ctrl K`.
- `Ctrl T` opens the console. It floats over the app; drag its title bar to move it. `Esc`, `×`, a click outside it, or opening a page closes it.
- `Ctrl W` closes the current tab, `Ctrl Tab` cycles tabs, `Ctrl 1`-`8` jump to that tab and `Ctrl 9` to the last. In a conversation, typing anywhere goes to the reply box, unless focus is on a button, link, field or dialog. Deleting a conversation, document or automation asks first.
- `Enter` sends, `Shift Enter` adds a line. `Esc` closes the console, or the sidebar when the window is narrow enough for it to be a drawer.
- `/` in the composer lists skills and commands. Skills come from the folder in Settings (else `LYFESTYLE_SKILLS_DIR`), which the app links into `~/.claude/skills` so the local Claude Code loads them; with neither, the menu lists what is already in `~/.claude/skills`. `/model <alias or id>` and `/effort <low|medium|high|xhigh|max>` set what the next turn runs with; `default` clears either.
- In documents, Notion-style markdown shortcuts apply: `#` headings, `-` lists, `[]` todos, `>` quotes, `/` for the block menu.

## Screenshot mode

`pnpm exec vite --mode screenshot` serves the app with a hash-driven preview hook (compiled out of normal builds). Open `http://localhost:1420/#seed&view=documents`, `#seed&sidebar`, `#seed&console`, `#seed&view=settings`, `#mock&view=automations` (a stubbed API with sample automations, a pending deploy and a day of runs) or `#mock&view=pageviews` (three sample sites) to land on any surface with sample data, which makes headless screenshots possible without clicking through the window. Preview modes never save anything: settings, seeds and documents stay in memory until reload, and the token in `#api=…&token=…` is removed from the address bar once read.

## API mode

Set an API URL and token in Settings, or export `LYFESTYLE_API_URL` and `LYFESTYLE_API_TOKEN` (or `API_TOKEN`) before launching. The app then uses the Lyfestyle API (`apps/api`) instead of local files:

- Conversations are API conversations. Each message queues a run; the app follows the run's events over `GET /runs/:id/stream` and shows assistant messages as they arrive. Stop calls `POST /runs/:id/cancel`. Runs only progress while `pnpm runner` is up.
- Documents are kept on this device and synced with the API (`/sync`), so they work offline. An edit that conflicts with one made elsewhere is kept as `… (conflicted copy)`. Deleting moves a document to the trash, restorable for 7 days.
- Automations exist only in API mode. They are code that runs on the API server on a cron schedule. You never write one in the app: ask the agent in a conversation, and it proposes the code through the API's MCP tools. An approval prompt with the code (a diff when it changes a deployed one) appears right under the agent's message; the Automations page lists each pending proposal too (with a diff when it changes a deployed one) to approve or reject; nothing runs until you approve it. The page also shows a 24-hour timeline of runs and upcoming slots (hover a mark for time, status, duration and cost) and the deployed list, where you can pause, run now or delete.
- Page views exist only in API mode too. Sites that load the API's tracker (`<script src="<api>/metrics/script.js" defer>`) report views to it; the Page views page has a table of every site (views today, views and visitors over the range) and a chart of views per day for each, over the last 7, 30 or 90 days. Sites are grouped by origin, not by path.
- Notifications that automations or agent runs send through the API show up as system notifications while the app is open (polled every 20 seconds).
- Settings shows the connection state and warns when the API URL is plain http to another machine (installed builds refuse it). Local agent settings are ignored while the API is configured.

Leave both fields empty to return to local mode (flat files plus a locally spawned Claude Code).

In screenshot mode, `#api=<url>&token=<token>` connects a headless session to an API.
