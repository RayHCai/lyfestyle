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
- Deployed to Railway for automation runs ([ADR 0009](../../docs/adr/0009-cloud-runner-for-automations.md)):
  `Dockerfile` (build from the repo root; runs `src/index.ts` with `tsx`, workspace packages from
  source, `AGENT_CONNECTOR_TOOLS=none`) and `railway.json` (the service's config file path).
  Claude Code authenticates with `ANTHROPIC_API_KEY` from the service's variables, which
  `agentEnv()` passes through. Setup in [docs/deployment.md](../../docs/deployment.md#runner-on-railway).
- `pnpm --filter @lyfestyle/runner bridge` or `node apps/runner/bin/lyfestyle-agent.mjs`: prompt on
  stdin, optional `--session <conversation id>` (`--resume` is accepted as an alias).

Env (`src/env.ts`): `LYFESTYLE_API_URL` (default `http://localhost:$PORT`), `LYFESTYLE_API_TOKEN`
(falls back to `API_TOKEN`), `RUNNER_ID` (default the hostname), `RUNNER_CONCURRENCY`,
`RUNNER_KINDS` (`chat`, `automation`, comma-separated; sent as the claim's `kinds`; empty takes both),
`AGENT_HARNESS` (`claude-code` | `command`; unset picks `command` when only
`AGENT_HARNESS_COMMAND` is set), `AGENT_HARNESS_COMMAND`, `AGENT_MODEL`, `AGENT_TOOLS` (comma list
or `none`), `AGENT_CONNECTOR_TOOLS` (claude.ai connector tool names, or `none`), `AGENT_CWD`
(default `~/.lyfestyle/agent`), `AGENT_MAX_TURNS`, `AGENT_MAX_BUDGET_USD` (an optional lower cap
on each run's `budgetUsd` from the API; `0` is an error, leave it empty for none),
`RUN_TIMEOUT_MINUTES` (default 30). Empty values (`KEY=`) count as unset; a count that is not a
positive whole number fails at startup.

## Layout

- `src/index.ts` entry: picks a harness from the `harnesses` map, builds the `Runner`, handles
  SIGINT/SIGTERM. Register a new harness here.
- `src/runner.ts` `Runner`: claim loop (long-poll `POST /runs/claim`), heartbeat, the `Reporter`
  (`POST /runs/:id/events`, 200 per request, retried), completion (retried), cancellation, the run
  time limit, and the run's MCP server list.
- `src/harness.ts` the `Harness` interface (`name`, `run(input)`), `HarnessInput`,
  `McpServerSpec`, and what both harnesses share: `promptFor()` (history replay and the soul for a
  fresh session), `mcpConfig()` (servers in `--mcp-config` shape),
  `resultOutcome()` (a `result` line's output or error), `budgetFor()`, and `agentEnv()` (the child
  environment without the API's secrets).
- `src/claude-code.ts` `ClaudeCodeHarness` (Agent SDK `query`) and `mapSdkMessage`, which turns
  SDK/stream-json messages into `RunEventInput`s.
- `src/command.ts` `CommandHarness`: spawns any executable without a shell, prompt on stdin,
  `--session <id>` to resume, parses stream-json stdout with `mapSdkMessage`. The run's MCP
  servers go in a private temp file in Claude Code's `--mcp-config` format, named by
  `LYFESTYLE_MCP_CONFIG` and deleted when the run ends (the desktop app sets the same variable for
  `LYFESTYLE_AGENT_COMMAND`).
- `src/soul.ts` `readSoul()`: the user's `~/.lyfestyle/SOUL.md`, read per run into
  `HarnessInput.soul` ('' when missing). Every harness must pass it on to the agent.
- `src/bridge.ts` + `bin/lyfestyle-agent.mjs`: one chat turn through the API printed as Claude
  Code stream-json. `src/env.ts` env parsing. `tests/` vitest suites.

A new harness implements `Harness` in its own `src/<name>.ts`, emits events through `input.emit`,
honours `input.signal` (including one already aborted when `run` is called: check it first),
resolves only when the agent finished and rejects otherwise, and is added to `harnesses` in
`src/index.ts`.

## Invariants and conventions

- Harness events must satisfy `runEventInput` from `@lyfestyle/shared`; that schema is the contract
  with the API, client and desktop. Do not invent event types here. The `Reporter` validates each
  event as it is pushed and drops (and logs) an invalid one, since it would fail its whole batch.
- `mapSdkMessage` is the trust boundary for a command's stdout: it checks every field it reads and
  turns an unusable line into a `warn` log. Nothing in the line handler may throw; an exception
  there is uncaught and kills the runner.
- Usage events are what this run added. A resumed Claude Code session reports totals continuing
  from what its transcript saved, so `mapSdkMessage` subtracts the `session.usage` baseline; when
  any figure is below the baseline the transcript had no saved totals and the figures are this
  run's alone. `maxBudgetUsd` is the run's own budget even when resuming: Claude Code checks it
  against what the process spent, not the restored total (see `total_cost_usd` in the SDK's
  `sdk.d.ts`).
- Resume only a session your harness created (`input.session?.harness === this.name`); otherwise
  replay `input.history` with `promptFor()`. When Claude Code no longer has the session (`No
conversation found`, as an exit error or an error result, before any `init`), `ClaudeCodeHarness`
  logs a warning and retries once as a fresh session with the history.
- `ClaudeCodeHarness` locks Claude Code down: `settingSources: []`, `strictMcpConfig` unless
  claude.ai connector tools are allowed (only `DEFAULT_CONNECTOR_TOOLS`, Gmail read-only and
  Calendar, by default), `permissionMode: 'dontAsk'`, built-in tools limited to WebSearch and
  WebFetch unless `AGENT_TOOLS` says otherwise, and `cwd` kept apart from real projects. Loosening
  any of these changes what an unattended agent can do on the user's machine.
- Agent processes get `agentEnv()`: the runner's environment without the API-only variables of the
  root `.env` (`DATABASE_URL`, `ENCRYPTION_KEY`, `RESEND_API_KEY`, `API_TOKEN`,
  `LYFESTYLE_API_TOKEN`, ...). Every MCP server the agent starts inherits it. Add any new API-only
  variable to `API_ONLY_ENV`.
- The API's own MCP server (`lyfestyle`, at `${apiUrl}/mcp`) is always first in `mcpServers`,
  authorised with the claim's `agentToken`, a token scoped to the run's tools. The runner's own
  `LYFESTYLE_API_TOKEN` stays in its API client and never reaches an agent. User-registered
  servers come from `GET /agent/config`.
- Command harness contract: no shell. On Windows the executable is found along `PATH` with
  `PATHEXT`; a `.cmd`/`.bat` runs as `cmd.exe /d /s /v:off /c` with every argument escaped by
  `cmdArg` (`%`, `"` and line breaks are refused). A stored session id must match
  `^[A-Za-z0-9._:-]{1,200}$` or the turn starts a fresh session. The command gets
  `LYFESTYLE_MAX_BUDGET_USD` (the run's budget, or `AGENT_MAX_BUDGET_USD` if lower) and
  `LYFESTYLE_MAX_TURNS`, and must enforce them itself: the API sees its usage only in the final
  result line, too late to stop it. Cancelling kills the whole process tree (`taskkill /T /F` on
  Windows, the process group on POSIX).
- Stopping a run: the runner aborts `input.signal` when a report or heartbeat says
  `cancelRequested`, the API answers 409 (`cancelled`) or 404 (`deleted`: the run or its
  conversation is gone, so it is dropped without completing), the run outlives
  `RUN_TIMEOUT_MINUTES`, or the runner shuts down. Shutdown and the time limit complete the run as
  `failed`; a cancel as `cancelled`. A harness that resolved with output wins over a stop that
  raced it (the API's budget cancel can land just as a run finishes). A harness that has not
  stopped 15 s after its signal aborted is abandoned.
- Delivery: a failed event post keeps its events at the front of the buffer and is retried with
  backoff (1 s doubling to 30 s) while the run lasts; a 4xx other than 404/408/409/429 drops that
  batch. A finished run waits up to 30 s for its events, then `/complete` is retried for up to a
  minute. A post that failed after the API stored it is sent again, so delivery is at least once.
- Bridge contract (desktop parses it, see `apps/desktop/src/lib/agent.ts`): stdout carries JSON
  lines only, one object per line: first `{type:'system',subtype:'init',session_id,...}` (the
  session id is the API conversation id), then `assistant`/`user` lines, finally a `result` line
  with `subtype`, `is_error`, `result`, `session_id`, `total_cost_usd`, `usage`. Diagnostics go to
  stderr. When a session id is unknown, stderr must contain `No conversation found`
  (`UNKNOWN_SESSION`): the desktop app matches that phrase to drop a stale session. On SIGINT or
  SIGTERM the bridge waits (up to 3 s) for its cancel request before exiting.
- `bin/lyfestyle-agent.mjs` loads the repo-root `.env` and registers `tsx` at runtime, so `tsx` is a
  runtime dependency and the bin must not print anything to stdout itself. It sets
  `process.exitCode` rather than calling `process.exit()`, which can cut off piped stdout.
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
    heartbeatMs: 20,
    flushMs: 5,
    retryMs: 5,
});
await runner.runOnce(0);
```

Outages are simulated with a wrapping `fetch` (`flaky()` in the tests) that answers chosen routes
with an error response or a thrown network error. Wait on conditions (`until()`), not fixed
sleeps. The bin is tested end to end over a real local HTTP server wrapping the in-process app.

`ClaudeCodeHarness` is tested by injecting `query` (an async generator of canned `SDKMessage`s, or
one that throws) through its options; `CommandHarness` by writing throwaway `.mjs` agents (and a
native `.cmd`/`sh` wrapper for the Windows quoting and process-tree tests) to one temp dir, with a
space in its path, removed after the suite. `tests/env.test.ts` covers env parsing with a plain
object.

## Gotchas

- Never `console.log` from code reachable by `bridge.ts`; it corrupts the stream-json stdout.
- `AGENT_HARNESS_COMMAND` is split on whitespace with `"..."`/`'...'` grouping and run without a
  shell: no pipes, redirects or variable expansion. Wrap anything fancier in a script.
- Keep heartbeats under the API's `RUN_STALE_AFTER_MS` (default 120 s) or the run is reaped as
  failed.
- The API emits `status` events itself; a harness never reports them.
