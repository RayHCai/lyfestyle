# Lyfestyle API

Every route except `/health` and the two public metrics routes needs `Authorization: Bearer <API_TOKEN>`.
Bodies are JSON. Errors are `{ "error": { "code", "message", "details"? } }`, with codes
`unauthorized` (401), `invalid_request` (400, `details` lists failing fields), `not_found` (404),
`conflict` (409), `integration_unavailable` (424) and `upstream_error` (502).

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
| `DELETE /pages/:id`        | Soft delete. `?baseVersion=` as above.                                                                                                                                 |
| `POST /pages/:id/restore`  | Undelete.                                                                                                                                                              |
| `POST /pages/:id/append`   | `{ content }`, added after a blank line.                                                                                                                               |
| `GET /pages/:id/links`     | Outgoing links: `{ id, title, icon, exists }`. `exists: false` for deleted or not-yet-synced targets.                                                                  |
| `GET /pages/:id/backlinks` | Live pages linking here.                                                                                                                                               |
| `GET /pages/graph`         | `{ nodes: [{ id, title, icon }], edges: [{ source, target }] }` over live pages.                                                                                       |

A page is `{ id, title, content, icon, version, createdAt, updatedAt, deletedAt }`. `content` is
markdown; a link to another page is `[label](page:<uuid>)` (`pageLink()` and `extractPageLinks()`
in `@lyfestyle/shared` write and read them). Every change bumps `version`.

## Offline sync

Pages can be edited offline and reconciled later. `SyncEngine` in `@lyfestyle/client` implements
the client side over a pluggable `LocalStore` (IndexedDB, SQLite or `MemoryStore`):

```ts
const sync = new SyncEngine({ api, store });
await sync.save({ title: 'Plane notes', content: '…' }); // local, instant
const stop = sync.startAutoSync({ intervalMs: 30_000 }); // and on the browser's `online` event
```

The protocol, for any other client:

`POST /sync/push` with `{ changes: [{ id, baseVersion, title, content, icon, deleted }] }`
(up to 500). `baseVersion` is the server version the edit was made on, or `null` for a page the
device created. Each change answers `{ id, status: 'applied' | 'conflict', page }`:

- `applied`: `page` is the new server copy. A change identical to the server copy is also
  `applied`, so retrying a push whose response was lost is safe.
- `conflict`: someone else wrote first; `page` is the server copy. The client resolves it and
  pushes again. `SyncEngine` defaults to keeping both: the server copy stays, and the local edit
  becomes a new page titled "… (conflicted copy)". A `resolve` callback can choose `server`,
  `local` or a merge instead.

`GET /sync/pull?cursor=0&limit=500` answers `{ pages, cursor, hasMore }`: every page written after
`cursor` in write order, deletions included (`deletedAt` set). Store `cursor` and pass it next
time; repeat while `hasMore`. Writes are serialised, so a pull never skips one.

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

| Method & path                                    | Does                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /conversations`                             | Paged, most recently active first.                                                                                                                                                         |
| `POST /conversations`                            | `{ title? }`. Untitled conversations take their first message's first line.                                                                                                                |
| `GET /conversations/:id`                         | The conversation with `messages` and `activeRuns`.                                                                                                                                         |
| `PATCH /conversations/:id`                       | `{ title }`.                                                                                                                                                                               |
| `DELETE /conversations/:id`                      | Deletes it with its messages and runs.                                                                                                                                                     |
| `POST /conversations/:id/messages`               | `{ text }`. Stores the message and queues a run; answers `{ message, run }`.                                                                                                               |
| `GET /runs?status=&kind=&jobId=&conversationId=` | Paged, newest first.                                                                                                                                                                       |
| `GET /runs/:id`                                  | The run with summed `usage`.                                                                                                                                                               |
| `GET /runs/:id/events?after=&type=`              | The run's events in order; `type=log` for its log.                                                                                                                                         |
| `GET /runs/:id/stream?after=`                    | Server-sent events, replaying from `after` (or `Last-Event-ID`) and ending after the terminal status. Use `streamRunEvents()` from the client: `EventSource` cannot send the bearer token. |
| `POST /runs/:id/cancel`                          | Drops a queued run; asks a running one to stop.                                                                                                                                            |

A run is `{ id, kind: 'chat' | 'job', status, prompt, conversationId, jobId, runnerId, harness,
output, error, createdAt, startedAt, finishedAt, … }` with status `queued → running → succeeded |
failed | cancelled`. A run whose runner stops heartbeating for `RUN_STALE_AFTER_MS` (two minutes by
default) is failed.

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

| Method & path            | Does                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /jobs`              | Each job with `lastRun`.                                                                                                   |
| `POST /jobs`             | `{ name, prompt, schedule, timezone?, enabled? }`. `schedule` is cron (5 or 6 fields) in an IANA `timezone` (default UTC). |
| `GET /jobs/:id`          | With its 20 most recent runs.                                                                                              |
| `PATCH /jobs/:id`        | Any field; `enabled: false` pauses it.                                                                                     |
| `DELETE /jobs/:id`       | Past runs are kept.                                                                                                        |
| `POST /jobs/:id/trigger` | Run now. 409 while a run of this job is queued or running.                                                                 |

The API checks for due jobs every `SCHEDULER_TICK_MS` (15 s). Slots missed while it was down collapse
into one run, and a slot is skipped while the job's previous run is still queued or running, so a
laptop left closed does not come back to a pile of queued briefings.

## Usage

`GET /usage?from=&to=&groupBy=day|model|kind|harness|job&timezone=` answers
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

| Method & path                | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /metrics/collect`      | Public, any CORS origin. `{ url, title?, referrer?, language?, props? }` → 204. The body is parsed as JSON whatever its content type, so `text/plain` beacons skip the preflight. `props` holds up to 20 string/number/boolean values. The API records the visitor's IP (first `X-Forwarded-For` hop, else the socket) and user agent. 403 if the page's origin is not in `METRICS_ORIGINS`; 400 if an `Origin` header disagrees with `url`; 413 over 16 KB. |
| `GET /metrics/script.js`     | Public. The tracker, pointed at this API's `PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /metrics/views`         | Raw views, newest first, paged. `?from=&to=&origin=` filter.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /metrics/views/summary` | `?from=&to=&origin=&groupBy=day\|origin\|path\|referrer&timezone=` → `{ groupBy, totals, groups: [{ key, views, visitors }] }`. `visitors` counts distinct IPs; `referrer` keys are the referring host.                                                                                                                                                                                                                                                      |

## Integrations

| Method & path                 | Does                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| `GET /integrations`           | `{ canvas: { connected, account, baseUrl }, resend: { configured, from } }` |
| `PUT /integrations/canvas`    | `{ baseUrl, token }`, verified against Canvas before it is stored.          |
| `DELETE /integrations/canvas` |                                                                             |

## Tools and MCP

`/mcp` is a stateless Streamable HTTP MCP server. `GET /tools` lists the same tools with JSON Schemas,
and `POST /tools/:name` with the input as the body answers `{ result }`. Integration tools are listed
only once their integration is connected or configured.

| Group       | Tools                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages       | `pages_search`, `pages_list_recent`, `pages_get`, `pages_create`, `pages_update`, `pages_append`, `pages_delete`, `pages_backlinks`           |
| Planner     | `todos_get_board`, `todos_list`, `todos_create`, `todos_update`, `todos_delete`, `goals_list`, `goals_create`, `goals_update`, `goals_delete` |
| Automations | `automations_list`, `automations_create`, `automations_update`, `automations_delete`                                                          |
| Canvas      | `canvas_list_courses`, `canvas_list_assignments`, `canvas_get_assignment`, `canvas_upcoming`, `canvas_todo`, `canvas_announcements`           |
| Email       | `email_send`                                                                                                                                  |

### Registering MCP servers

| Method & path             | Does                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /mcp-servers`        | Registered servers. Header and env _names_ only, never values.                                                                                                                                   |
| `POST /mcp-servers`       | `{ name, transport: 'http' \| 'sse' \| 'stdio', url?, headers?, command?, args?, env?, enabled? }`. `name` is lowercase and becomes the tool prefix (`mcp__<name>__…`); `lyfestyle` is reserved. |
| `PATCH /mcp-servers/:id`  | Any field. `headers` and `env` replace the stored ones when given.                                                                                                                               |
| `DELETE /mcp-servers/:id` |                                                                                                                                                                                                  |

stdio servers run on the runner's machine, next to Claude Code.

## Runner protocol

What `apps/runner` speaks. Another harness host can implement it to take runs instead.

| Method & path              | Does                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agent/config`        | `{ builtinServer: { name, path }, mcpServers }`, with secrets, for the harness.                                                                                                                                                                                                                                                                         |
| `POST /runs/claim`         | `{ runnerId, harness, waitMs? }` long-polls up to 30 s. Answers 204 if nothing was queued, or `{ run, session, history, job }`. `session` is `{ harness, sessionId, usage }`, the session to resume and what it has spent so far; `history` is the earlier turns, for a harness that cannot resume it. Two turns of one conversation never run at once. |
| `POST /runs/:id/events`    | `{ events: RunEventInput[] }` (up to 200) → `{ cancelRequested }`.                                                                                                                                                                                                                                                                                      |
| `POST /runs/:id/heartbeat` | → `{ status, cancelRequested }`. Send one at least every two minutes.                                                                                                                                                                                                                                                                                   |
| `POST /runs/:id/complete`  | `{ status: 'succeeded' \| 'failed' \| 'cancelled', output?, error? }`.                                                                                                                                                                                                                                                                                  |

Report `usage` as what this run added; the `session.usage` totals are there for harnesses whose own
figures are cumulative across a session, like Claude Code's.
