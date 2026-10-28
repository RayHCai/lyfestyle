# Lyfestyle API

Every route except `/health` and the two public metrics routes needs `Authorization: Bearer <token>`
(scheme case-insensitive). `API_TOKEN` reaches every route. The `agentToken` from `POST /runs/claim`
reaches only `/mcp`, `GET /tools` and `POST /tools/:name`, and only while its run is `running`: 401
afterwards, 403 on any other route.

Bodies are JSON. Errors are `{ "error": { "code", "message", "details"? } }`, with codes
`invalid_request` (400, including a malformed JSON body; `details` lists failing fields),
`unauthorized` (401), `forbidden` (403), `not_found` (404, also a record deleted mid-request),
`conflict` (409, also a unique or foreign-key race), `payload_too_large` (413),
`integration_unavailable` (424), `rate_limited` (429), `upstream_error` (502: an integration
failed, answered something other than JSON, or did not respond within 15 s) and `internal` (500).

`GET /health` → `{ ok: true }`, or 503 `{ ok: false }` when the database does not answer.

List endpoints that page take `limit` (1–200, default 50) and `cursor`, and return
`{ items, nextCursor }`; pass `nextCursor` back until it is `null`. Timestamps are ISO strings.

From TypeScript, use `@lyfestyle/client` rather than raw fetch:

```ts
import { createApiClient, unwrap } from '@lyfestyle/client';

const api = createApiClient({ baseUrl: 'https://…', token });
const page = await unwrap(api.pages.$post({ json: { title: 'Ideas' } }));
const board = await unwrap(api.todos.board.$get({ query: { today: '2026-10-26' } }));
```

Every call is typed from the server's own routes; `unwrap` throws `ApiRequestError` on non-2xx.

## Pages

| Method & path              | Does                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /pages`               | Summaries, newest edit first: `id, title, icon, excerpt, version, …`. `?q=` searches title and body (full text, plus partial titles). `?deleted=true` lists the trash. |
| `POST /pages`              | `{ id?, title?, content?, icon? }`. `id` lets a client choose the UUID.                                                                                                |
| `GET /pages/:id`           | The full page.                                                                                                                                                         |
| `PATCH /pages/:id`         | `{ title?, content?, icon?, baseVersion? }`. With `baseVersion`, 409 if the page moved on (the current page is in `details.page`).                                     |
| `DELETE /pages/:id`        | Moves to the trash; purged for good after 7 days. `?baseVersion=` as above.                                                                                            |
| `POST /pages/:id/restore`  | Undelete.                                                                                                                                                              |
| `POST /pages/:id/append`   | `{ content }`, added after a blank line.                                                                                                                               |
| `GET /pages/:id/links`     | Outgoing links: `{ id, title, icon, exists }`. `exists: false` for deleted or not-yet-synced targets.                                                                  |
| `GET /pages/:id/backlinks` | Live pages linking here.                                                                                                                                               |
| `GET /pages/graph`         | `{ nodes: [{ id, title, icon }], edges: [{ source, target }] }` over live pages.                                                                                       |

`POST /pages`, `PATCH /pages/:id` and `POST /pages/:id/append` refuse a request body over 4 MiB with
413 `payload_too_large`; `content` is at most 1,000,000 characters (400 beyond that). Summaries
(`GET /pages`, search, backlinks) carry `excerpt`, the body's first 200 characters, and never
`content`.

A page is `{ id, title, content, icon, version, createdAt, updatedAt, deletedAt }`. `content` is
markdown; a link to another page is `[label](page:<uuid>)` (`pageLink()` and `extractPageLinks()`
in `@lyfestyle/shared` write and read them). Every change bumps `version`.

## Offline sync

Pages can be edited offline and reconciled later. The desktop app does this in API mode
(`apps/desktop/src/lib/sync.ts`); the protocol, for any client:

`POST /sync/push` with `{ changes: [{ id, baseVersion, title, content, icon, deleted }] }` (up to
500 changes and 10 MiB of request body; a larger body is refused with 413 `payload_too_large`, so
batch by size as well as count). Changes apply in order, each on its own. `baseVersion` is the
server version the edit was made on, or `null` for a page the device created; only a `null`
`baseVersion` creates a page. Each change answers `{ id, status: 'applied' | 'conflict', page }` or
`{ id, status: 'gone' }`:

- `applied`: `page` is the new server copy. A change identical to the server copy is also
  `applied`, so retrying a push whose response was lost is safe.
- `conflict`: someone else wrote first; `page` is the server copy. The client resolves it (keep
  the server copy, its own, or both) and pushes again.
- `gone`: the change has a `baseVersion` but the page no longer exists: it sat in the trash for 7
  days and was purged. There is no `page`, and the server does not recreate it. Drop the local
  copy; to keep a live local edit, push it again with `baseVersion: null`, which creates it afresh.

`GET /sync/pull?cursor=0&limit=500` answers `{ pages, cursor, hasMore }`: every page written after
`cursor` in write order, deletions included (`deletedAt` set). Store `cursor` and pass it next
time; repeat while `hasMore`. Writes are serialised, so a pull never skips one. Pages that stay
in the trash for 7 days are purged, and a purged page drops out of the pull without a further
change. A device that has not pulled for that long should pull from `cursor=0` and drop the clean
local pages the server no longer returns.

## Planner

Dates are the user's local calendar days, `YYYY-MM-DD`; the server never guesses a time zone.

| Method & path                           | Does                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /todos/board?today=`               | `{ today, weekStart, month, day, tomorrow, week, goals }`. Unfinished items from earlier days, weeks and months come back with `carriedOver: true`. |
| `GET /todos?from=&to=&scope=`           | Todos dated in a range.                                                                                                                             |
| `POST /todos`                           | `{ title, scope: 'day' \| 'week', date, notes?, goalId?, position? }`. Week todos are stored against that week's Sunday.                            |
| `PATCH /todos/:id`                      | Any field, plus `completed: boolean`.                                                                                                               |
| `DELETE /todos/:id`                     |                                                                                                                                                     |
| `GET /goals?from=&to=`                  | Monthly goals for the months in a range.                                                                                                            |
| `POST /goals`                           | `{ title, month, color?, notes?, position? }`. `month` is any day of the month.                                                                     |
| `PATCH /goals/:id`, `DELETE /goals/:id` | As for todos. Deleting a goal unlinks its todos.                                                                                                    |

## Conversations and runs

| Method & path                                              | Does                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /conversations`                                       | Paged, most recently active first.                                                                                                                                                                                                                                    |
| `POST /conversations`                                      | `{ title? }`. Untitled conversations take their first message's first line.                                                                                                                                                                                           |
| `GET /conversations/:id`                                   | The conversation with `messages` and `activeRuns`.                                                                                                                                                                                                                    |
| `PATCH /conversations/:id`                                 | `{ title }`.                                                                                                                                                                                                                                                          |
| `DELETE /conversations/:id`                                | Cancels a turn still queued or running (its stream ends with `cancelled`; its runner's next call gets 404), then deletes it with its messages and runs.                                                                                                               |
| `POST /conversations/:id/messages`                         | `{ text, from? }`. Stores the message and queues a run; answers `{ message, run }`. `from`, an earlier user message's id, first drops that message and everything after it and starts a fresh harness session (editing or retrying); `409` while a turn is in flight. |
| `GET /runs?status=&kind=&automationRunId=&conversationId=` | Paged, newest first.                                                                                                                                                                                                                                                  |
| `GET /runs/:id`                                            | The run with summed `usage`.                                                                                                                                                                                                                                          |
| `GET /runs/:id/events?after=&type=&limit=`                 | The run's events in order; `type=log` for its log. `limit` 1–1000, default 500: page on with `after`.                                                                                                                                                                 |
| `GET /runs/:id/stream?after=`                              | Server-sent events, replaying from `after` (or `Last-Event-ID`) and ending after the terminal status. Use `streamRunEvents()` from the client: `EventSource` cannot send the bearer token.                                                                            |
| `POST /runs/:id/cancel`                                    | Drops a queued run; asks a running one to stop.                                                                                                                                                                                                                       |

A run is `{ id, kind: 'chat' | 'automation', status, prompt, conversationId, automationRunId,
budgetUsd, runnerId, harness, output, error, createdAt, startedAt, finishedAt, … }` with status
`queued → running → succeeded | failed | cancelled`. A run whose runner stops heartbeating for
`RUN_STALE_AFTER_MS` (two minutes by default) is failed. `budgetUsd` is at most `RUN_BUDGET_USD`
($5 by default). Once the run's reported usage passes it, the API asks the runner to stop. The
agent runs of one automation run share one `RUN_BUDGET_USD`: once together they pass it, every one
still running gets `cancelRequested` and queued ones are cancelled.

A message is `{ id, role: 'user' | 'assistant' | 'tool', content: ContentBlock[], runId, createdAt }`
where a block is `text`, `thinking`, `tool_use { id, name, input }` or
`tool_result { toolUseId, content, isError? }`.

Events (`RunEvent` in `@lyfestyle/shared`) each carry `id, runId, createdAt, type`:

| type      | fields                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `status`  | `status`, `error?`. Written by the API on every status change.                                          |
| `message` | `role: 'assistant' \| 'tool'`, `content`. Also appended to the conversation.                            |
| `log`     | `level: debug \| info \| warn \| error`, `message`, `data?`.                                            |
| `usage`   | `model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs?, sessionId?` |
| `session` | `harness, sessionId`: the harness session the conversation resumes next turn.                           |

## Automations

An automation is code the API runs on a cron schedule
([ADR 0006](adr/0006-automations-as-approved-code.md)). No route here creates or edits one: the agent
proposes code with the `automations_deploy` tool, and the user approves the deploy.

| Method & path                           | Does                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /automations`                      | Each automation (without code) with `lastRun`.                                                                                                                                                  |
| `GET /automations/:id`                  | With `code`, `state` and its 20 most recent runs.                                                                                                                                               |
| `PATCH /automations/:id`                | `{ enabled }`: pause or resume. Needs no deploy.                                                                                                                                                |
| `DELETE /automations/:id`               | Deletes it with its run history; stops a run in progress.                                                                                                                                       |
| `POST /automations/:id/trigger`         | Runs the approved code now. 409 while it is already running.                                                                                                                                    |
| `GET /automations/deploys?status=`      | Proposals, newest first, each with `current`: the deployed version it would replace, or null for a new automation.                                                                              |
| `GET /automations/deploys/:id`          | One proposal with `current`, e.g. for the approval prompt the chat shows.                                                                                                                       |
| `POST /automations/deploys/:id/approve` | Deploys it: creates the automation, or replaces its code and schedule and bumps `version`.                                                                                                      |
| `POST /automations/deploys/:id/reject`  | 409 unless pending. A newer proposal for the same automation supersedes older pending ones (they become `rejected`); proposals for one automation are serialised, so exactly one stays pending. |
| `GET /automations/timeline?from=&to=`   | `{ runs, upcoming }` for a window of up to 7 days: runs that started in it (with `name`) and the scheduled slots still ahead.                                                                   |

Each deploy has `origin` (`chat` or `automation`: the kind of agent run that proposed it, or `user`
for a direct tool call with `API_TOKEN`) and `runId` (that run, or null once it is deleted). An
automation's own agent runs, and automation code, cannot propose, run, pause or delete automations:
those tools answer 403 and are not listed for them.

An automation is `{ id, name, description, schedule, timezone, enabled, version, nextRunAt,
lastRunAt, … }`, where `schedule` is cron in an IANA `timezone`: five fields, six with seconds
first, or a nickname such as `@daily`. A proposal is refused (400) if its schedule does not parse,
has seven fields, or has no next run (`0 0 30 2 *`). An automation run is `{ id, automationId,
version, trigger: 'schedule' | 'manual', status: 'running' | 'succeeded' | 'failed' | 'cancelled',
startedAt, finishedAt, output, error, logs: [{ at, level, message }], costUsd }`, where `costUsd`
sums the agent runs it started. `cancelled` means it was stopped on purpose: the automation was
paused or deleted, or the API shut down; `error` gives the reason and no notification is sent.
`GET /automations` gives each automation's `lastRun` as `{ id, status, startedAt, finishedAt }`.

The API checks for due automations every `SCHEDULER_TICK_MS` (15 s). Slots missed while it was down
collapse into one run, and a slot is skipped while the previous run is still going. An automation
whose stored schedule no longer parses is paused, with a failed run that says why. Code runs in a
child Node process under the permission model ([ADR 0007](adr/0007-automation-sandbox-process.md)):
no environment variables, no file system, no child processes or worker threads, no native addons,
and no npm or relative imports; the network is open. Memory is capped at 256 MB, and the process is
killed after `AUTOMATION_TIMEOUT_MS` (15 minutes). A failed run also sends a notification. When a
run ends, the agent runs it started that have not finished are cancelled. Its `ctx.agent` calls
share `RUN_BUDGET_USD`: each gets what earlier calls have not spent or still hold, and a call fails
once nothing is left.

## Notifications

| Method & path                      | Does                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /notifications?after=&limit=` | `{ items, latestId }`: oldest first after the id `after`; without it, the newest `limit` (default 50, at most 100). `latestId` is the newest notification id (null when there are none), so a new client starts its cursor with `?limit=1`. |
| `POST /notifications`              | `{ title, body? }`.                                                                                                                                                                                                                         |

A notification is `{ id, title, body, source, automationId, createdAt }`. The desktop app polls for
new ones and shows them as system notifications.

## Usage

`GET /usage?from=&to=&groupBy=day|model|kind|harness|automation&timezone=` answers
`{ groupBy, totals, groups: [{ key, runs, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }] }`
for this app's agent runs. `day` keys are dates in `timezone`.

## Metrics

Any website can report page views. Drop in the tracker, which reports the first view and every
client-side navigation:

```html
<script src="https://…/metrics/script.js" defer></script>
```

or send the beacon yourself:

```js
navigator.sendBeacon('https://…/metrics/collect', JSON.stringify({ url: location.href }));
```

| Method & path                | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /metrics/collect`      | Public, any CORS origin. `{ url, title?, referrer?, language?, props? }` → 204. The body is parsed as JSON whatever its content type, so `text/plain` beacons skip the preflight. `url` and `referrer` ≤ 2048 characters, `title` ≤ 300, `props` ≤ 20 keys (≤ 50 characters each) of string (≤ 200 characters), number, boolean or null. The API records the visitor's IP (the last `X-Forwarded-For` entry, which Railway's proxy appends; else the socket) and user agent. 400 if an `Origin` header disagrees with `url`. When `METRICS_ORIGINS` is a list: 403 unless the request has an `Origin` (browsers always send one) and the page's origin is listed. 413 over 16 KB. 429 `rate_limited` past 60 beacons a minute from one IP or 10,000 recorded views a day. |
| `GET /metrics/script.js`     | Public. The tracker, pointed at this API's `PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /metrics/views`         | Raw views, newest first, paged. `?from=&to=&origin=` filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /metrics/views/summary` | `?from=&to=&origin=&groupBy=day\|origin\|path\|referrer&timezone=` → `{ groupBy, totals, groups: [{ key, views, visitors }] }`. `visitors` counts distinct IPs; `referrer` keys are the referring host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Views older than `METRICS_RETENTION_DAYS` (365; 0 keeps them) are deleted hourly.

## Integrations

| Method & path                 | Does                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /integrations`           | `{ canvas: { connected, account, baseUrl, updatedAt }, resend: { configured, from } }`                   |
| `PUT /integrations/canvas`    | `{ baseUrl, token }` → `{ account, baseUrl }`: https only, origin kept, 400 if Canvas rejects the token. |
| `DELETE /integrations/canvas` | → `{ disconnected }` (false if nothing was connected).                                                   |

Canvas tools answer 424 once Canvas rejects the stored token, and follow `Link: rel="next"` only on
the Canvas host.

## Tools and MCP

`/mcp` is a stateless Streamable HTTP MCP server. `GET /tools` lists the same tools with JSON Schemas,
and `POST /tools/:name` with the input as the body answers `{ result }`; an empty body means no
arguments, a malformed one is 400. Integration tools are listed only once their integration is
connected or configured. With an agent token, `GET /tools`, the MCP list and calls show only what
that run may use. An unexpected failure reaches the agent only as
`{ error: 'internal', message: 'Internal server error' }`; the API logs the real error.

| Group       | Tools                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages       | `pages_search`, `pages_list_recent`, `pages_get`, `pages_create`, `pages_update`, `pages_append`, `pages_delete`, `pages_backlinks`                         |
| Planner     | `todos_get_board`, `todos_list`, `todos_create`, `todos_update`, `todos_delete`, `goals_list`, `goals_create`, `goals_update`, `goals_delete`               |
| Automations | `automations_list`, `automations_get`, `automations_deploy`, `automations_list_deploys`, `automations_run`, `automations_set_enabled`, `automations_delete` |
| Notify      | `notify`                                                                                                                                                    |
| Canvas      | `canvas_list_courses`, `canvas_list_assignments`, `canvas_get_assignment`, `canvas_upcoming`, `canvas_todo`, `canvas_announcements`                         |
| Email       | `email_send`                                                                                                                                                |

### Registering MCP servers

| Method & path             | Does                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /mcp-servers`        | `{ id, name, transport, url, command, argCount, headerNames, envNames, enabled, secretsUnavailable, createdAt, updatedAt }`. `url` shows scheme and host only (plus `/…` when it has a path or query). The full url, args, header and env values are stored encrypted and never returned. `secretsUnavailable: true` means another `ENCRYPTION_KEY` sealed them: delete and re-add the server. |
| `GET /mcp-servers/:id`    | One server, as above.                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /mcp-servers`       | `{ name, transport: 'http' \| 'sse' \| 'stdio', url?, headers?, command?, args?, env?, enabled? }`. `name` is lowercase and becomes the tool prefix (`mcp__<name>__…`); `lyfestyle` is reserved.                                                                                                                                                                                               |
| `PATCH /mcp-servers/:id`  | Any field. `headers`, `env` and `args` replace the stored ones when given; switching `transport` drops what it cannot use; 409 if its secrets cannot be decrypted.                                                                                                                                                                                                                             |
| `DELETE /mcp-servers/:id` | Works even when its secrets cannot be decrypted.                                                                                                                                                                                                                                                                                                                                               |

stdio servers run on the runner's machine, next to Claude Code.

## Runner protocol

What `apps/runner` speaks. Another harness host can implement it to take runs instead.

| Method & path              | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /agent/config`        | `{ builtinServer: { name, path }, mcpServers }`, with secrets, for the harness. Root token only; skips servers whose secrets cannot be decrypted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /runs/claim`         | `{ runnerId, harness, waitMs? }` long-polls up to 30 s. Answers 204 if nothing was queued, or `{ run, session, history, automation, agentToken }`. `automation` is `{ id, name }` when automation code started the run, and `run.budgetUsd` is its spending cap. `session` is `{ harness, sessionId, usage }`, the session to resume and what it has spent so far; `history` is the conversation's earlier messages in order, without this turn's and later turns' (an earlier turn's reply that arrived after this message is included), for a harness that cannot resume. `agentToken` is the bearer token to give the agent for the built-in MCP server: it reaches only the tools and stops working when the run ends (24 h at most). Two turns of one conversation never run at once. |
| `POST /runs/:id/events`    | `{ events: RunEventInput[] }` (up to 200) → `{ cancelRequested }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /runs/:id/heartbeat` | → `{ status, cancelRequested }`. Send one at least every two minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /runs/:id/complete`  | `{ status: 'succeeded' \| 'failed' \| 'cancelled', output?, error? }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

A 404 from heartbeat or events means the run was deleted with its conversation: stop.

Report `usage` as what this run added; the `session.usage` totals are there for harnesses whose own
figures are cumulative across a session, like Claude Code's.
