# Architecture

The diagram is in the [README](../README.md). This page explains the moving parts.

| Path              | What it is                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`        | Hono + Prisma API on Postgres, deployed to Railway. Tests run it on in-memory PGlite.                                              |
| `apps/runner`     | Agent worker: claims runs from the API and executes them with Claude Code (or any harness). Local, and on Railway for automations. |
| `apps/desktop`    | Tauri 2 + React desktop app. Talks to the API, or works offline on flat files with local Claude.                                   |
| `packages/client` | Typed API client for Node clients (the runner) and run event streaming.                                                            |
| `packages/shared` | Run-event protocol and its SSE reader, page-link parsing, calendar-date helpers. Shared by API, runner, client and desktop.        |

## Core concepts

- **Pages** are flat markdown documents. A page links to another with `[label](page:<id>)`; links,
  backlinks and cycles are tracked server-side. Devices edit offline and reconcile through
  `/sync/push` and `/sync/pull` with per-page versions; see [api.md](api.md#offline-sync).
- **Runs** are the unit of agent work. A chat message or an automation's `ctx.agent` queues a run; the runner
  long-polls `/runs/claim`, executes it through a harness, and streams events back: messages,
  logs, usage and session. Conversation history, run logs and usage metrics all live in the API.
- **Tools** are defined once and served twice: as an MCP server at `/mcp` for Claude Code, and as
  plain HTTP at `/tools/:name` for the UI or for a harness that does not speak MCP. Integration
  tools appear only once that integration is connected.
- **Registered MCP servers** (`/mcp-servers`) are handed to the agent on every run. Their headers
  and env are stored encrypted with `ENCRYPTION_KEY`.
- **Automations** are code the API itself runs on a cron schedule, each run in a child Node process under the permission model, with no
  environment, file system or child processes ([ADR 0007](adr/0007-automation-sandbox-process.md)). The agent
  writes and proposes the code in a chat, and the user approves each deploy in the app. The code
  uses `ctx` helpers for email, desktop notifications, the agent's tools and the agent itself,
  which queues a run for the runner. The in-process scheduler and execution tracking are why the API
  runs as a single replica ([ADR 0003](adr/0003-single-api-replica.md),
  [ADR 0006](adr/0006-automations-as-approved-code.md)).
- **Budgets**: an agent run may spend at most `RUN_BUDGET_USD` ($5), and the agent runs of one
  automation run share that amount.

## The runner and agent harnesses

Chat turns run on your machine, so Claude Code uses your local login and the agent's built-in tools
stay local ([ADR 0002](adr/0002-local-runner.md)). Automation runs go to a second runner on Railway
with `RUNNER_KINDS=automation`, billed to an `ANTHROPIC_API_KEY` and without claude.ai connectors
([ADR 0009](adr/0009-cloud-runner-for-automations.md)); `POST /runs/claim` takes `kinds` so each
runner takes only its share. For each run a runner gives Claude Code:

- the API's MCP server plus every enabled registered server, and nothing from your own Claude Code
  config (`settingSources: []`)
- your claude.ai connectors, with only the Gmail and Google Calendar tools in
  `AGENT_CONNECTOR_TOOLS` allowed (`none` sets `strictMcpConfig` and keeps them out)
- `WebSearch` and `WebFetch` as its only built-in tools (`AGENT_TOOLS` to change), with every other
  tool denied without prompting (`permissionMode: 'dontAsk'`)
- a working directory of its own (`AGENT_CWD`, default `~/.lyfestyle/agent`)
- the conversation's Claude Code session to resume, so multi-turn chats keep their context
- the user's `~/.lyfestyle/SOUL.md` (`src/soul.ts`), read fresh for each run and appended to the
  system prompt; a command harness gets it at the top of a fresh session's prompt. The desktop app
  edits the same file in Settings and gives it to its local Claude Code with
  `--append-system-prompt-file`, so every agent path follows it

Usage is recorded per run from the SDK's `modelUsage`. A resumed session's figures continue from
the totals its transcript saved, so the runner subtracts what the session already recorded; figures
below that baseline mean the transcript saved none and count as this run's own. Claude Code's
`maxBudgetUsd` counts only what the process itself spends, so every run gets its own budget,
resumed or not.

The agent never sees the runner's API token: the built-in `lyfestyle` MCP server gets the claim's
`agentToken`, scoped to the run's tools. Every agent process, and each MCP server it starts, gets
the runner's environment without the API-only variables of `.env` (`DATABASE_URL`,
`ENCRYPTION_KEY`, `RESEND_API_KEY`, `API_TOKEN`, `LYFESTYLE_API_TOKEN`, …). A run still going
after `RUN_TIMEOUT_MINUTES` (default 30) is stopped and failed. Events that fail to post are retried
in order with backoff, and so is a run's completion. When Claude Code no longer has a
conversation's session, the turn starts a fresh one with the conversation so far.

To swap the agent, set `AGENT_HARNESS_COMMAND` to any executable that reads a prompt on stdin,
accepts `--session <id>`, and prints Claude Code stream-json lines. The runner starts it without a
shell (on Windows a `.cmd`/`.bat` goes through `cmd.exe` with every argument escaped), so the value
is split on spaces with `"…"` grouping and nothing else is interpreted. It finds its tools in the
file named by `LYFESTYLE_MCP_CONFIG` (Claude Code's `--mcp-config` format: the `lyfestyle` server
plus every enabled registry entry), so a wrapper around `claude -p` can pass it straight on. It must
keep to `LYFESTYLE_MAX_BUDGET_USD` and `LYFESTYLE_MAX_TURNS` itself: the API learns what a command
spent only from its final `result` line, too late to stop it. Cancelling a run kills the command's
whole process tree. To add a harness in code,
implement `Harness` (`apps/runner/src/harness.ts`) and register it in `apps/runner/src/index.ts`.

## Desktop app and the agent bridge

The desktop app has two modes:

- **API mode** (API URL and token set in Settings or `LYFESTYLE_API_URL` / `LYFESTYLE_API_TOKEN`):
  conversations and documents are API conversations and pages; the Automations page approves deploys,
  shows the day's runs, and the app shows API notifications as system notifications. It uses its own
  thin fetch client (`apps/desktop/src/lib/api.ts`) because it builds with TypeScript 5.9 and
  bundler resolution, while `@lyfestyle/client` type-checks against the API source under TS 7.
- **Local mode**: flat files under the Tauri app data directory and a locally spawned
  `claude -p --output-format stream-json`, or whatever `LYFESTYLE_AGENT_COMMAND` names. Either
  gets the app's own MCP server (`lyfestyle --mcp`, the app binary serving `pages_*` tools
  over those files; automations exist only in API mode) and, when Settings has its URL, the todo app's server:
  Claude Code through `--mcp-config`, a custom command through `LYFESTYLE_MCP_CONFIG`.

`apps/runner/bin/lyfestyle-agent.mjs` implements the `LYFESTYLE_AGENT_COMMAND` contract on top of
the API, so local-mode chats are still recorded as API conversations:

```
LYFESTYLE_AGENT_COMMAND=node C:/path/to/lyfestyle/apps/runner/bin/lyfestyle-agent.mjs
```

It reads the prompt on stdin, takes `--session <id>`, and prints stream-json lines whose
`session_id` is the API conversation id. Its stdout must stay JSON lines only, and it must keep the
`No conversation found` stderr phrase: the desktop app depends on both.

See also: [api.md](api.md) for every route, and the `AGENTS.md` in each package.
