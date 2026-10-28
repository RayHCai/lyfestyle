# @lyfestyle/desktop

React 19 + Tauri 2 desktop app (Windows first). In local mode it keeps data in flat files and spawns
the user's Claude Code (or `LYFESTYLE_AGENT_COMMAND`); in API mode it talks to `apps/api` and
follows runs over SSE. User-facing docs: [README.md](README.md); setup in
[docs/development.md](../../docs/development.md).

## Commands

- `pnpm desktop` / `pnpm desktop:build` from the root (`tauri dev` / `tauri build`).
- `pnpm --filter @lyfestyle/desktop dev`: UI alone in a browser on :1420 (localStorage, no agent).
- `dev:web` / `build:web`: the hosted web build (`--mode web`, `isWeb` in `lib/tauri.ts`). API mode
  only (Settings asks for the URL and token until connected); conversations, the composer and the
  console's ask are hidden since no runner is hosted; `storage.ts` keeps everything but
  `settings.json` in memory, so nothing is cached offline. Touch screens (`hover: none`) always
  show hover-only actions.
- `pnpm --filter @lyfestyle/desktop typecheck` (`tsc -b`); `build` = `tsc -b && vite build`.
- Screenshot mode, inside `apps/desktop`: `pnpm exec vite --mode screenshot`, then open
  `http://localhost:1420/#seed&view=documents` (also `#seed&sidebar`, `#seed&console`,
  `#api=<url>&token=<token>`, and `#mock&view=automations` or `#mock&view=pageviews` for a
  stubbed API). Preview modes never
  persist: `applyPreview` turns on `keepInMemory()` (`lib/storage.ts`), so settings, seeds and
  files live in memory for the page's lifetime. `#api=…&token=…` removes the token from the address
  bar once read; `#seed` adds only samples whose titles are missing and switches to local mode
  unless `#api` or `#mock` is given.
- `pnpm --filter @lyfestyle/desktop test`: vitest in Node (no DOM) over `tests/*.test.ts`: pure
  modules in `src/lib`, the stores over a stubbed localStorage, and the sync engine. Never runs the
  agent.
- Rust: `pnpm lint:rust` (`cargo fmt --check` + `clippy -D warnings`) and `pnpm test:rust` (`cargo test`) from the root.

Verify UI changes with `typecheck`, `test`, `lint:rust`, `test:rust` and screenshot mode.

## Layout

- `src/App.tsx` shell: loads data, in API mode starts the 45 s refresh and the 20 s notification poll, global keys
  (Ctrl K toggle console, Ctrl T open console, Ctrl W close tab, Ctrl Tab cycle tabs, Ctrl 1-9
  pick a tab, Esc; all in-app, there is no system-wide shortcut), and the `switch (view.name)`
  router. A new page is a `View` variant in `src/lib/types.ts`, a component in `src/pages/`, a case
  here, an entry in `Sidebar.tsx`, a label in `Tabs.tsx` and `Titlebar.tsx`, and a command in
  `Console.tsx` if the console should reach it. A failed `load` shows a startup error with retry;
  the page sits in an `ErrorBoundary`; `useData.notice` shows above the page until dismissed.
- `src/pages/` one component per view (Home, Conversation(s), Documents, Automations, PageViews,
  Settings).
  Documents has a trash in API mode only (the list header's `trash` swaps the list for trashed
  pages with a `restore`); the API purges a page `TRASH_DAYS` (7) after it is deleted, and
  `lib/types.ts` mirrors that constant. Local mode still deletes the files outright. In API mode
  the list header also shows `N unsynced` while edits wait for the server.
  Automations is API-only and read-only by design: the agent proposes code over the API's MCP
  tools, and the page lists pending deploys (with a line diff against the deployed version) to
  approve or reject, a 24 h timeline (`components/Timeline.tsx`, one lane per automation, runs
  and upcoming slots, hover tooltip) and the deployed list (switch, run now, delete). There is
  no create or edit form; do not add one. Local mode shows only a note. The same deploy card
  (`components/DeployCard.tsx`) is the approval prompt in a conversation: `lib/remote.ts` pairs
  each `automations_deploy` tool call with its result, sets the deploy id on the message
  (`Message.deploys`), and `Conversation.tsx` renders a `DeployPrompt` for it. A decided deploy
  shrinks to one line.
  PageViews is API-only and read-only: it reads `GET /metrics/views/summary` once grouped by
  origin (the table: one row per site, never per path) and once per site grouped by day in the
  user's time zone (`components/ViewsChart.tsx`, a column per day with a hover tooltip), for the
  last 7, 30 or 90 days. Only the busiest `CHARTED` (12) sites get a chart, since each costs a
  request; `lib/metrics.ts` fills the days the API leaves out. With no views it shows the
  tracker snippet. Local mode shows only a note.
- `src/components/` shared UI: Titlebar (frameless window chrome as a status line), Sidebar
  (persistent rail; a drawer in compact windows), Tabs (ARIA tabs: arrows, Home/End, Delete closes;
  close buttons sit beside the tab with tabIndex -1, `+` outside the tablist), Console (floating,
  draggable; a listbox with `aria-activedescendant`; closes on Esc, outside click or navigation),
  Confirm (`confirmAction()` before any delete; focus starts on Cancel, is trapped and restored),
  Composer (the `/` menu as a listbox; Enter ignored during IME composition), CopyButton,
  DeployCard/DeployPrompt, Timeline, ErrorBoundary, Masthead (page title), Markdown (memoised;
  never loads remote images, which render as an `image:` link; inline `data:` raster images are
  allowed; `page:<uuid>` links open the document; other links go through `openExternal`, which
  opens a tab in a browser and copies the URL in Tauri, never navigating the webview), icons (rail
  and trash only). `src/hooks/`: `useAttempt` (keeps an action's error for the UI),
  `useQuoteSelection`, `useTypeToCompose`.
- `src/lib/commands.ts` composer slash commands: `/model` and `/effort` are handled in the app
  (they set `settings.model`/`effort`, which `agent_send` passes as `--model`/`--effort`); any
  other `/name` is a skill and is sent as typed for Claude Code to expand. Local mode only: the
  runner sets its own model and loads no user skills (`settingSources: []`).
- `src/store/app.ts` zustand UI state: the open `tabs` and the `active` one, `view` (the active
  tab's view, what the router renders), sidebar, compact, console. `navigate(view)` focuses the
  view's tab if it has one, turns a fresh home tab into it, or opens a new tab beside the active one;
  `tabKey` gives every screen one tab and every conversation its own, so Documents calls
  `rememberSelection` when the user picks inside it instead of navigating. `store/app.ts` also keeps
  per-conversation `drafts`. `src/store/data.ts` builds the `useData` zustand store from one module
  per domain and owns `load`/`refresh`: `settings.ts`, `conversations.ts`, `docs.ts`,
  `automations.ts`, with their interfaces in `state.ts`. `backend.ts` holds the API client and
  `PageSync` (`getApi`, `getPages`, `isActive`); store code asks it instead of branching on `mode`.
  Results for a superseded API or an overtaken load are dropped. `docs.ts` has one `DocBackend`
  with a local and a synced implementation. Local `documents/index.json` writes re-read the file and
  apply only their own change (the agent's `mcp.rs` rewrites it mid-turn), and an index that does
  not parse is an error, never `[]`. Editor saves still in their debounce are flushed before any
  reload or sync, and a save that loses to an agent edit becomes `… (conflicted copy)` plus a
  notice.
- `src/lib/agent.ts` local agent: `agent_send`/`agent_cancel` and the stream-json line parser;
  delegates to `remote.ts` in API mode. `src/lib/remote.ts` API-mode conversations (runs + SSE).
  `resend` (edit a message, retry a reply) drops a user message and what follows: locally it
  starts a fresh Claude Code session given the kept turns as `<conversation_so_far>`; in API mode
  it sends `from` and swaps the optimistic user message's id for the API's so it can be edited.
  `lib/turn.ts` is the turn lifecycle both share; `lib/transcript.ts` holds `mapTranscript` and
  deploy pairing; `lib/actions.ts` has `startConversation`, `removeConversation` and
  `newDocument`; `lib/stored.ts` validates settings, conversations and the index at the storage
  boundary; also `lib/time.ts`, `lib/diff.ts`, `lib/views.ts` (`useViewLabel`), `lib/confirm.ts`.
- `src/lib/sync.ts` `PageSync`, API mode's documents: a local copy of every page under
  `sync/<api host>/` (`index.json` plus `<id>.md`). Every document action in `store/data.ts` edits
  the copy first; 1.5 s after the last edit a round pushes the dirty pages through
  `POST /sync/push` (at most 100 changes and 8 MB per request), then pulls from the stored cursor.
  Rounds also run on the 45 s refresh, on the window's `online` event and when a run ends, so
  documents work offline and catch up on reconnect. A conflict keeps both: the server copy keeps
  the id and the local edit becomes `… (conflicted copy)`; a pull that changes a body bumps
  `docRevisions` so the open editor remounts. A page over the API's limits stays local and the
  round reports it; a `gone` result (purged on the server) drops a trashed copy and re-creates a
  live one.
- `src/lib/api.ts` thin fetch client for the API routes the app uses. `src/lib/storage.ts` storage
  over Tauri commands with a localStorage fallback. `src/lib/tauri.ts` `call`/`onEvent`/`isTauri`.
- `src/lib/cron.ts` `describeCron` (common cron shapes in words, else the raw expression).
  `src/lib/notifications.ts` API mode: polls `GET /notifications?after=` and shows each new item
  through the `notify` Tauri command (Web Notification API in a browser). The cursor lives in
  `notifications.json` as `{ [apiUrl]: lastId }` (the older `{ url, after }` form is read too);
  first contact asks `GET /notifications?limit=1` and starts at `latestId` without replaying
  history, and a burst of more than five collapses into one summary.
- `src/lib/preview.ts` screenshot-mode seeding. `src/styles/global.css` all styling and tokens.
- `src-tauri/src/lib.rs` builder, `notify` (system
  notification through `tauri-plugin-notification`, called from Rust so JS needs no plugin
  package), the webview zoom (0.8);
  `agent.rs` `agent_send`, `agent_cancel`, `agent_env`; `storage.rs`
  `storage_read/write/delete/list/dir`; `soul.rs` `soul_read/soul_write` for
  `~/.lyfestyle/SOUL.md` (seeded with a starter on first read; the runner reads the same file), which
  `agent_send` passes to Claude Code as `--append-system-prompt-file`; `skills.rs` `skills_load`, which links every
  `<dir>/<name>/SKILL.md` folder into `~/.claude/skills` (junctions on Windows, existing entries
  left alone) and lists the user-invocable ones. A folder that cannot be linked is skipped (logged),
  not fatal. `settings.skillsDirectory` empty falls back to `LYFESTYLE_SKILLS_DIR`; with neither it
  links nothing and lists what is already in `~/.claude/skills`. On Windows the junction is
  `cmd /C mklink /J` with both paths double-quoted; paths containing `"`, `%` or control characters
  are refused. The store calls it on load and when the setting changes.
  `capabilities/default.json` window permissions; `tauri.conf.json` (frameless, port 1420).

## Invariants and conventions

- Toolchain differs from the rest of the repo: TypeScript 5.9, `moduleResolution: "bundler"`, own
  `tsconfig.json` (does not extend `tsconfig.base.json`, but also sets `noUncheckedIndexedAccess`
  and `exactOptionalPropertyTypes`, and includes `tests` and the Vite/Vitest configs),
  extensionless relative imports. Imports from `@lyfestyle/shared` are fine: its TS sources compile
  under TS 5.9 and Vite resolves their `./x.js` specifiers; `lib/api.ts` takes the run-event types,
  `streamRunEvents`, `TERMINAL_RUN_STATUSES`, `TRASH_DAYS` and `DAY_MS` from it. Do not import
  `@lyfestyle/client` (it type-checks against the API source); update `lib/api.ts` by hand when
  routes change.
- Store code picks its backend through `store/backend.ts`; local mode must keep working with no API
  configured. Mode is `api` when Settings or `LYFESTYLE_API_URL`/`_TOKEN` give both
  URL and token.
- Stream-json parsing in `lib/agent.ts`: `system` lines carry `session_id` (stored as the
  conversation's `sessionId`), `stream_event` text deltas fill `live`, `assistant` lines append text
  and tool names, `result` sets the final text/error; non-JSON lines are plain text. A stderr line
  matching `No conversation found` clears the stored session. The runner's bridge and any
  `LYFESTYLE_AGENT_COMMAND` must keep producing this format.
- `agent.rs`: with `LYFESTYLE_AGENT_COMMAND` set, it passes `--session <id>`; otherwise it runs
  `claude -p --output-format stream-json --verbose --include-partial-messages [--model]
[--effort] --mcp-config <data>/mcp.json --allowedTools mcp__lyfestyle[,mcp__todo] [--resume <id>]`.
  Every send rewrites `mcp.json` and sets `LYFESTYLE_MCP_CONFIG` to it for either kind of command. Prompt goes on stdin; stdout/stderr come back as `agent-event`
  (`kind: line | stderr | exit`). On Windows cancel kills the process tree with `taskkill /T`.
  Each send has a spawn id: a send for a conversation whose process is still running tree-kills it
  and drops its remaining events, and `lib.rs` kills every agent tree on `RunEvent::Exit`. The child
  never inherits `ENCRYPTION_KEY`, `DATABASE_URL` or `RESEND_API_KEY`, and Claude Code never gets
  `API_TOKEN`/`LYFESTYLE_API_TOKEN` (a `LYFESTYLE_AGENT_COMMAND` keeps them for the bridge). A `cwd`
  that does not exist is an error.
- `mcp.rs` is the agent's tool server: `main.rs` hands `lyfestyle --mcp --data-dir <dir>` to it
  before Tauri starts. It is JSON-RPC over stdio (stdout is protocol only, diagnostics to stderr)
  reading and writing the same files as `store/data.ts`, with the API's tool names (`pages_*`)
  where local mode has the concept. Automations exist only on the API server, so it has no
  `automations_*` tools (an old `automations.json` in the data folder is no longer read). Changing a local file format means changing
  it there too. When a turn ends `agent.ts` calls `reloadFiles`, which bumps `docRevisions` for
  documents changed on disk so the open editor remounts. Its tools mirror the API's `pages_*`
  (including `pages_backlinks`) with the same annotations, and writes go through
  `storage::write_atomic`. The release profile aborts on panic, so never index or unwrap tool input
  or file contents.
- Commands that spawn processes or do slow IO are `#[tauri::command(async)]`; the `storage_*`
  commands stay synchronous because the UI relies on overlapping writes to one key landing in order.
- `tauri.conf.json` sets a CSP: scripts only from the app, inline styles allowed (Mantine/BlockNote),
  images only from the app, `data:` and `blob:` (agent markdown must not load remote images), and a
  `connect-src` of `https:` plus `http://localhost:*`/`127.0.0.1:*` because the API URL is chosen at
  runtime. Never change `identifier` (`com.lyfestyle.app`): it names the app data folder.
- A new Tauri command: `#[tauri::command]` fn, add it to `generate_handler!` in `lib.rs`, call it
  through `call()` in `lib/tauri.ts`, and guard with `isTauri` (or a fallback) so `pnpm dev` works.
  New window APIs need a permission in `capabilities/default.json`.
- Storage keys are relative paths (`settings.json`, `conversations/<id>.json`,
  `documents/<id>.md`); `storage.rs` rejects `..`, absolute paths and `:`.
- `src/lib/preview.ts` is only imported behind `import.meta.env.MODE === 'screenshot'` in `App.tsx`
  so it is compiled out of normal builds. Keep it that way; never import it statically.

## Design rules

- Mono system: a light, text-first workspace with the calm of a plain-text notebook. White page
  (`--bg`), off-white only for code and the editor's hover (`--bg-2`, `--bg-3`), warm near-black
  text (`--ink`, `--ink-strong` for titles) with a grey scale for everything secondary (`--text2`,
  `--muted`, `--faint`, `--ghost`, `--hair`). Every rule is a dashed hairline (`--dash`); hover is a
  faint wash (`--hover`), selection one step darker (`--active`). Light only (`color-scheme: light`).
- One accent, sakura (`--accent`, tint `--accent-soft`), spent only on the `>` marker of the
  current item, the prompt glyph, the live dot and the cursor. Never a fill, never a button.
  Green `--ok` and red `--danger` are the only other colours, for the mode dot and errors.
- One typeface: `--mono` (Geist Mono, 400/500/700, self-hosted through `@fontsource/geist-mono`
  imports in `src/main.tsx`). Body is 14px/1.7; the greeting 30px, titles 20-26px bold, labels
  `.eyebrow` 11px uppercase with 0.12em tracking. Section names, mode text and hints are lowercase.
  Text does the work of chrome: buttons are words in brackets (`.btn`, `.send` draw `[ ]` with
  pseudo-elements), the switch reads `[ on ]`/`[ off ]`, tool calls are `{braces}`, tags too,
  markdown headings keep their `#`, lists their `-`, document titles get a `#` (`.hash`).
- Chrome is drawn as text and rules, never boxes: the titlebar is a status line (wordmark, dashed
  `.tb-fill`s, the current crumb, a clock), the sidebar a listing where `.mark` (`>`) points at the
  active item and counts sit at the right, the tab strip (`.tabs`) a row of `>` labels with a solid
  2px underline on the active one and a `×` on hover. No icons except the rail toggle, window
  controls and the trash can on a recent conversation's hover; the sidebar's `+` is text, and the
  console and sidebar draw `>` instead. Hover-only actions also show on `:focus-within`. The `/` menu above the composer is the same kind of listing.
- Fields are an underline, not a box: dashed at rest, solid near-black on focus (`.field`,
  `.composer-wrap`). Labels sit in a 12ch column to the left of the field (`.field` is a grid),
  stacking above it under 760px. Radii are 2-4px and only on code, errors and the console.
  The only shadows are on the console and the compact drawer.
- Layout: a 36px titlebar, then the rail (`--rail`, 252px) beside a 32px tab strip and the page.
  The whole webview renders at 80% zoom (set in `lib.rs`; `pnpm dev` in a browser is not zoomed),
  so these sizes are CSS pixels before zoom. The sidebar starts closed and closes again when the
  window crosses the breakpoint; it opens with the toggle. Under 900px (`compact` in `store/app.ts`) it is a drawer over
  the page that closes on navigate and Esc. The page content is left-aligned and capped at
  `--content` (820px) with a `--gutter`; the landing page is the exception, centred in the window
  so the composer sits in the middle, and page views (`.pv`) is centred too. Pages open with a `Masthead` (eyebrow plus bold title).
  Lists are numbered rows between dashed rules (`.rows` uses a CSS counter). Two-column pages
  (`.two`) are a 300px list column with a dashed right rule; they stack under 760px.
- Conversations are a transcript: `.msg` is a grid with a 6ch gutter where `::before` writes
  `you ›` (ink) or `lyf ›` (sakura); the composer's `prompt` prop repeats the glyph.
- The BlockNote editor uses `theme="light"` and is themed by the `--bn-*` variables on
  `.bn-container` and the `.bn-editor` rules in `global.css`; restyle it there.
- Motion uses `--ease` for everything. Pages and tabs
  `slide` in from the left by 8px, rows `rise` with a staggered `animation-delay:
min(calc(sibling-index() * 20ms), 160ms)` (engines without `sibling-index()` drop the delay),
  the greeting types itself (`.typed`, one `steps()` per character from the `--n` inline variable)
  and ends on a blinking caret, live dots and the cursor `blink`, the active tab's underline
  `grow-x`. Hovers 100-150 ms, panels 160-300 ms. `prefers-reduced-motion` turns it all off.
- Minimal chrome still applies: no helper text beyond a field's `.note` (no shortcut hints, no
  mode line in the sidebar), no decorative icons.
  Styles live in `global.css` by class name; inline `style` only sets custom properties: `.typed`'s
  `--n`, and positions (`--x`/`--y` on the quote button and timeline tooltip, `--at`/`--w` on
  timeline marks, `--n`/`--h`/`--at` on the page-views chart, `--left`/`--top` on a dragged console).

## Gotchas

- Tauri 2 expects top-level command arguments in camelCase from JS (`{ conversationId }`) unless the
  command sets `rename_all`; struct fields inside `args` follow serde. A wrong key fails the invoke
  with "missing required key", so never swallow a `call()` error silently.
- `App.tsx` effects run twice under StrictMode in dev; make init idempotent (see `initAgent`).
- Do not spend Claude usage when checking agent flows: point `LYFESTYLE_AGENT_COMMAND` at a script
  that prints canned stream-json, or use API mode with a runner on `AGENT_HARNESS=command`.
- `vite.config.ts` pins port 1420 (`strictPort`), which `tauri.conf.json` `devUrl` expects. Its
  `envPrefix` is `VITE_`/`TAURI_ENV_`: a bare `TAURI_` would bundle `TAURI_SIGNING_PRIVATE_KEY`.
