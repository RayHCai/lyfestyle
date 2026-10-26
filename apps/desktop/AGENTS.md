# @lyfestyle/desktop

React 19 + Tauri 2 desktop app (Windows first). In local mode it keeps data in flat files and spawns
the user's Claude Code (or `LYFESTYLE_AGENT_COMMAND`); in API mode it talks to `apps/api` and
follows runs over SSE. User-facing docs: [README.md](README.md); setup in
[docs/development.md](../../docs/development.md).

## Commands

- `pnpm desktop` / `pnpm desktop:build` from the root (`tauri dev` / `tauri build`).
- `pnpm --filter @lyfestyle/desktop dev`: UI alone in a browser on :1420 (localStorage, no agent).
- `pnpm --filter @lyfestyle/desktop typecheck` (`tsc -b`); `build` = `tsc -b && vite build`.
- Screenshot mode, inside `apps/desktop`: `pnpm exec vite --mode screenshot`, then open
  `http://localhost:1420/#seed&view=documents` (also `#seed&sidebar`, `#seed&console`,
  `#api=<url>&token=<token>`).
- Rust: `pnpm lint:rust` from the root (`cargo fmt --check` + `clippy -D warnings`).

There is no test script; verify with `typecheck`, `lint:rust` and screenshot mode.

## Layout

- `src/App.tsx` shell: loads data, starts the local scheduler or the 45 s API refresh, global keys
  (Ctrl K, Esc), and the `switch (view.name)` router. A new page is a `View` variant in
  `src/lib/types.ts`, a component in `src/pages/`, a case here, an entry in `Sidebar.tsx`, and a
  command in `Console.tsx` if Ctrl K should reach it.
- `src/pages/` one component per view (Home, Conversation(s), Documents, Automations, Settings).
- `src/components/` shared UI: Titlebar (frameless window chrome), Sidebar (floating, hover-peek),
  Console (Ctrl K palette), Composer, Markdown, Aurora (background), icons.
- `src/store/app.ts` zustand UI state (view, sidebar, console). `src/store/data.ts` zustand data
  state: settings, `mode: 'local' | 'api'`, conversations, docs, automations, and every mutation.
- `src/lib/agent.ts` local agent: `agent_send`/`agent_cancel` and the stream-json line parser;
  delegates to `remote.ts` in API mode. `src/lib/remote.ts` API-mode conversations (runs + SSE).
- `src/lib/api.ts` thin fetch client for the API routes the app uses. `src/lib/storage.ts` storage
  over Tauri commands with a localStorage fallback. `src/lib/tauri.ts` `call`/`onEvent`/`isTauri`.
- `src/lib/scheduler.ts` local-mode automations (only while the app is open).
- `src/lib/preview.ts` screenshot-mode seeding. `src/styles/global.css` all styling and tokens.
- `src-tauri/src/lib.rs` builder, global shortcut, `set_global_shortcut`; `agent.rs` `agent_send`,
  `agent_cancel`, `agent_env`; `storage.rs` `storage_read/write/delete/list/dir`.
  `capabilities/default.json` window permissions; `tauri.conf.json` (frameless, port 1420).

## Invariants and conventions

- Toolchain differs from the rest of the repo: TypeScript 5.9, `moduleResolution: "bundler"`, own
  `tsconfig.json` (does not extend `tsconfig.base.json`), extensionless relative imports. Do not
  import `@lyfestyle/client` or `@lyfestyle/shared` (TS 7/NodeNext sources); `src/lib/api.ts` is
  the deliberately dependency-free client. When the API or the run-event contract in
  `packages/shared` changes, update the hand-written types in `src/lib/api.ts` to match.
- Every mode-dependent action branches on `useData.getState().mode`; local mode must keep working
  with no API configured. Mode is `api` when Settings or `LYFESTYLE_API_URL`/`_TOKEN` give both
  URL and token.
- Stream-json parsing in `lib/agent.ts`: `system` lines carry `session_id` (stored as the
  conversation's `sessionId`), `stream_event` text deltas fill `live`, `assistant` lines append text
  and tool names, `result` sets the final text/error; non-JSON lines are plain text. A stderr line
  matching `No conversation found` clears the stored session. The runner's bridge and any
  `LYFESTYLE_AGENT_COMMAND` must keep producing this format.
- `agent.rs`: with `LYFESTYLE_AGENT_COMMAND` set, it passes `--session <id>`; otherwise it runs
  `claude -p --output-format stream-json --verbose --include-partial-messages [--model]
[--resume <id>]`. Prompt goes on stdin; stdout/stderr come back as `agent-event`
  (`kind: line | stderr | exit`). On Windows cancel kills the process tree with `taskkill /T`.
- A new Tauri command: `#[tauri::command]` fn, add it to `generate_handler!` in `lib.rs`, call it
  through `call()` in `lib/tauri.ts`, and guard with `isTauri` (or a fallback) so `pnpm dev` works.
  New window APIs need a permission in `capabilities/default.json`.
- Storage keys are relative paths (`settings.json`, `conversations/<id>.json`,
  `documents/<id>.md`); `storage.rs` rejects `..`, absolute paths and `:`.
- `src/lib/preview.ts` is only imported behind `import.meta.env.MODE === 'screenshot'` in `App.tsx`
  so it is compiled out of normal builds. Keep it that way; never import it statically.

## Design rules

- Square corners everywhere: `--radius: 0px` is applied with `!important` to every element; only
  the aurora blobs are round. Do not add `border-radius`.
- Use the tokens in `src/styles/global.css` (`--bg`, `--ink`, `--text2`, `--muted`, `--accent`,
  `--hover`, `--active`, `--line`, `--float`, ...). Hover/active tints instead of borders and
  cards; `--line` only as a hairline divider; `--float` shadow for floating panels.
- Type: `--display` (Cormorant Garamond) only for titles, markdown headings, quotes and italic
  empty states; `--body` (Manrope) for every label, control, list and form.
- Light mode only (`color-scheme: light`); no dark theme.
- Minimal chrome: no extra buttons, labels or helper text. New screens follow the greeting plus
  composer minimalism. Styles live in `global.css` by class name; inline `style` is rare.
- The BlockNote document editor is themed by the `--bn-*` variables on `.bn-container` and the
  `.bn-editor` rules in `global.css`; restyle it there.

## Gotchas

- Tauri 2 expects top-level command arguments in camelCase from JS (`{ conversationId }`) unless the
  command sets `rename_all`; struct fields inside `args` follow serde. A wrong key fails the invoke
  with "missing required key", so never swallow a `call()` error silently.
- `App.tsx` effects run twice under StrictMode in dev; make init idempotent (see `initAgent`).
- Do not spend Claude usage when checking agent flows: point `LYFESTYLE_AGENT_COMMAND` at a script
  that prints canned stream-json, or use API mode with a runner on `AGENT_HARNESS=command`.
- `vite.config.ts` pins port 1420 (`strictPort`), which `tauri.conf.json` `devUrl` expects.
