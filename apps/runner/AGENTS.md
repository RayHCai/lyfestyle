# @lyfestyle/runner

Long-running worker that claims queued runs from the API and executes them through a harness
(local Claude Code via the Agent SDK, or any stream-json command), reporting events back. Also
ships `bin/lyfestyle-agent.mjs`, a stream-json bridge the desktop app can use as
`LYFESTYLE_AGENT_COMMAND`. Protocol:
[docs/api.md#runner-protocol](../../docs/api.md#runner-protocol); overview in
[docs/architecture.md](../../docs/architecture.md).

## Commands

- `pnpm --filter @lyfestyle/runner test` (vitest; boots an in-process API) / `typecheck`.
- `pnpm runner` from the root (= `tsx src/index.ts` with the root `.env`). Needs a running API.
- `pnpm --filter @lyfestyle/runner bridge` or `node apps/runner/bin/lyfestyle-agent.mjs`: prompt on
  stdin, optional `--session <conversation id>` (`--resume` is accepted as an alias).

Env (`src/env.ts`): `LYFESTYLE_API_URL` (default `http://localhost:$PORT`), `LYFESTYLE_API_TOKEN`
(falls back to `API_TOKEN`), `RUNNER_ID`, `RUNNER_CONCURRENCY`, `AGENT_HARNESS`
(`claude-code` | `command`), `AGENT_HARNESS_COMMAND`, `AGENT_MODEL`, `AGENT_TOOLS` (comma list or
`none`), `AGENT_CONNECTOR_TOOLS` (claude.ai connector tool names, or `none`), `AGENT_CWD` (default `~/.lyfestyle/agent`), `AGENT_MAX_TURNS`, `AGENT_MAX_BUDGET_USD`.
Empty values (`KEY=`) count as unset.

## Layout

- `src/index.ts` entry: picks a harness from the `harnesses` map, builds the `Runner`, handles
  SIGINT/SIGTERM. Register a new harness here.
- `src/runner.ts` `Runner`: claim loop (long-poll `POST /runs/claim`), heartbeat, batched
  `Reporter` (`POST /runs/:id/events`, 200 per request), completion, cancellation, MCP server list.
- `src/harness.ts` the `Harness` interface (`name`, `run(input)`), `HarnessInput`,
  `McpServerSpec`, and `transcript()` for replaying history to a harness that cannot resume.
- `src/claude-code.ts` `ClaudeCodeHarness` (Agent SDK `query`), `defaultSystemPrompt`, and
  `mapSdkMessage`, which turns SDK/stream-json messages into `RunEventInput`s.
- `src/command.ts` `CommandHarness`: spawns any executable, prompt on stdin, `--session <id>` to
  resume, parses stream-json stdout with `mapSdkMessage`.
- `src/bridge.ts` + `bin/lyfestyle-agent.mjs`: one chat turn through the API printed as Claude
  Code stream-json. `src/env.ts` env parsing. `tests/` vitest suites.

A new harness implements `Harness` in its own `src/<name>.ts`, emits events through `input.emit`,
honours `input.signal`, and is added to `harnesses` in `src/index.ts`.

## Invariants and conventions

- Harness events must satisfy `runEventInput` from `@lyfestyle/shared`; that schema is the contract
  with the API, client and desktop. Do not invent event types here.
- Usage events are what this run added. Claude Code reports session-cumulative totals, so
  `mapSdkMessage` subtracts the `session.usage` baseline when resuming. Keep that delta logic.
- Resume only a session your harness created (`input.session?.harness === this.name`); otherwise
  replay `input.history` via `transcript()` inside `<conversation_so_far>`.
- `ClaudeCodeHarness` locks Claude Code down: `settingSources: []`, `strictMcpConfig` unless
  claude.ai connector tools are allowed (only `DEFAULT_CONNECTOR_TOOLS`, Gmail read-only and Calendar,
  by default),
  `permissionMode: 'dontAsk'`, built-in tools limited to `DEFAULT_TOOLS` (WebSearch, WebFetch)
  unless `AGENT_TOOLS` says otherwise, and `cwd` kept apart from real projects. Loosening any of
  these changes what an unattended agent can do on the user's machine.
- The API's own MCP server (`lyfestyle`, at `${apiUrl}/mcp` with the bearer token) is always first
  in `mcpServers`; user-registered servers come from `GET /agent/config`.
- Cancellation: the runner aborts `input.signal` when a report or heartbeat says
  `cancelRequested`, or the API answers 409. Shutdown aborts with reason `shutdown` and the run is
  completed as `failed`; a user cancel completes as `cancelled`.
- Bridge contract (desktop parses it, see `apps/desktop/src/lib/agent.ts`): stdout carries JSON
  lines only, one object per line: first `{type:'system',subtype:'init',session_id,...}` (the
  session id is the API conversation id), then `assistant`/`user` lines, finally a `result` line
  with `subtype`, `is_error`, `result`, `session_id`, `total_cost_usd`, `usage`. Diagnostics go to
  stderr. When a session id is unknown, stderr must contain `No conversation found`
  (`UNKNOWN_SESSION`): the desktop app matches that phrase to drop a stale session.
- `bin/lyfestyle-agent.mjs` loads the repo-root `.env` and registers `tsx` at runtime, so `tsx` is a
  runtime dependency and the bin must not print anything to stdout itself.
- API calls go through the typed `@lyfestyle/client` (`createApiClient`, `unwrap`,
  `ApiRequestError`); a 204 from `/runs/claim` means nothing was queued.

## Testing

Tests must never spend real Claude usage. `tests/runner.test.ts` runs the real `Runner` and
`bridge` against `createTestContext()` from `@lyfestyle/api/testing`, using a `FakeHarness` and
`t.fetch`:

```ts
const t = await createTestContext();
const api = createApiClient({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });
const runner = new Runner({
    api,
    harness: new FakeHarness(),
    runnerId: 'test-runner',
    apiUrl: TEST_URL,
    apiToken: TEST_TOKEN,
    heartbeatMs: 20,
    flushMs: 5,
});
await runner.runOnce(0);
```

`ClaudeCodeHarness` is tested by injecting `query` (an async generator of canned `SDKMessage`s)
through its options; `CommandHarness` by writing a throwaway `.mjs` agent to a temp dir and running
it with `node`. `tests/env.test.ts` covers env parsing with a plain object.

## Gotchas

- Never `console.log` from code reachable by `bridge.ts`; it corrupts the stream-json stdout.
- `CommandHarness` spawns with `shell: true` on Windows; quote paths in `AGENT_HARNESS_COMMAND`.
- Keep heartbeats under the API's `RUN_STALE_AFTER_MS` (default 120 s) or the run is reaped as
  failed.
- The API emits `status` events itself; a harness never reports them.
