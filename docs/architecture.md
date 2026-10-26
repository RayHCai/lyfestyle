# Architecture

The diagram is in the [README](../README.md). This page explains the moving parts.

| Path              | What it is                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api`        | Hono + Drizzle API, deployed to Railway. Postgres in production, embedded PGlite locally.         |
| `apps/runner`     | Local agent worker: claims runs from the API and executes them with Claude Code (or any harness). |
| `apps/desktop`    | Tauri 2 + React desktop app. Talks to the API, or works offline on flat files with local Claude.  |
| `packages/client` | Typed API client, offline page sync engine, run event streaming.                                  |
| `packages/shared` | Run-event protocol, page-link parsing, calendar-date helpers. Shared by API, runner and client.   |

## Core concepts

- **Pages** are flat markdown documents. A page links to another with `[label](page:<id>)`; links,
  backlinks and cycles are tracked server-side. Devices edit offline and reconcile through
  `/sync/push` and `/sync/pull` with per-page versions; see [api.md](api.md#offline-sync).
- **Runs** are the unit of agent work. A chat message or a due cron job queues a run; the runner
  long-polls `/runs/claim`, executes it through a harness, and streams events back: messages,
  logs, usage and session. Conversation history, run logs and usage metrics all live in the API.
- **Tools** are defined once and served twice: as an MCP server at `/mcp` for Claude Code, and as
  plain HTTP at `/tools/:name` for the UI or for a harness that does not speak MCP. Integration
  tools appear only once that integration is connected.
- **Registered MCP servers** (`/mcp-servers`) are handed to the agent on every run. Their headers
  and env are stored encrypted with `ENCRYPTION_KEY`.
- **Jobs** (automations) are cron schedules in a time zone. The API's in-process scheduler queues a
  run when one is due, which is why the API runs as a single replica
  ([ADR 0003](adr/0003-single-api-replica.md)).

## The runner and agent harnesses

The runner executes on your machine, so Claude Code uses your local login and the agent's built-in
tools stay local ([ADR 0002](adr/0002-local-runner.md)). For each run it gives Claude Code:

- the API's MCP server plus every enabled registered server, and nothing from your own Claude Code
  config (`settingSources: []`)
- your claude.ai connectors, with only the Gmail and Google Calendar tools in
  `AGENT_CONNECTOR_TOOLS` allowed (`none` sets `strictMcpConfig` and keeps them out)
- `WebSearch` and `WebFetch` as its only built-in tools (`AGENT_TOOLS` to change), with every other
  tool denied without prompting (`permissionMode: 'dontAsk'`)
- a working directory of its own (`AGENT_CWD`, default `~/.lyfestyle/agent`)
- the conversation's Claude Code session to resume, so multi-turn chats keep their context

Usage is recorded per run from the SDK's `modelUsage`. For a resumed session that figure is
cumulative, so the runner subtracts what the session already recorded.

To swap the agent, set `AGENT_HARNESS_COMMAND` to any executable that reads a prompt on stdin,
accepts `--session <id>`, and prints Claude Code stream-json lines. To add a harness in code,
implement `Harness` (`apps/runner/src/harness.ts`) and register it in `apps/runner/src/index.ts`.

## Desktop app and the agent bridge

The desktop app has two modes:

- **API mode** (API URL and token set in Settings or `LYFESTYLE_API_URL` / `LYFESTYLE_API_TOKEN`):
  conversations, documents and automations are API conversations, pages and jobs. It uses its own
  thin fetch client (`apps/desktop/src/lib/api.ts`) because it builds with TypeScript 5.9 and
  bundler resolution, while `@lyfestyle/client` type-checks against the API source under TS 7.
- **Local mode**: flat files under the Tauri app data directory and a locally spawned
  `claude -p --output-format stream-json`, or whatever `LYFESTYLE_AGENT_COMMAND` names.

`apps/runner/bin/lyfestyle-agent.mjs` implements the `LYFESTYLE_AGENT_COMMAND` contract on top of
the API, so local-mode chats are still recorded as API conversations:

```
LYFESTYLE_AGENT_COMMAND=node C:/path/to/lyfestyle/apps/runner/bin/lyfestyle-agent.mjs
```

It reads the prompt on stdin, takes `--session <id>`, and prints stream-json lines whose
`session_id` is the API conversation id. Its stdout must stay JSON lines only, and it must keep the
`No conversation found` stderr phrase: the desktop app depends on both.

See also: [api.md](api.md) for every route, and the `AGENTS.md` in each package.
