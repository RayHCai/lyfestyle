# @lyfestyle/api

Hono HTTP API over Postgres that owns all Lyfestyle data: pages, planner,
conversations, runs, automations, notifications, usage, metrics, integrations and the agent's tools. Called by the
runner, the desktop app (API mode), `@lyfestyle/client` and MCP clients (`/mcp`); deployed to
Railway. Route reference: [docs/api.md](../../docs/api.md); see also
[docs/architecture.md](../../docs/architecture.md), [docs/deployment.md](../../docs/deployment.md)
and [docs/integrations.md](../../docs/integrations.md).

## Commands

- `pnpm --filter @lyfestyle/api test` (vitest, in-memory PGlite, ~15 s; `vitest.config.ts` gives
  each file's PGlite 30 s to boot) / `typecheck` (`tsc -p .`)
- `pnpm api:dev` from the root: `tsx watch` with the root `.env`; needs `DATABASE_URL` (a local
  Postgres, never production; see docs/development.md), `API_TOKEN` (>= 24 chars) and
  `ENCRYPTION_KEY` (32 bytes base64). `pnpm secrets` generates the last two.
- `pnpm db:generate [name]` from the root (`scripts/db-generate.mjs` here): diffs `prisma/schema.prisma`
  against `prisma/migrations/` using a throwaway PGlite as the shadow database, writes any change
  as a new migration, and regenerates the client. It never connects to `DATABASE_URL`.
- `pnpm api:build`: esbuild bundle to `dist/index.js` (workspace packages inlined, npm external).

## Layout

- `src/index.ts` process entry: config, database, services, scheduler, server, graceful shutdown.
- `src/scheduler.ts` `startScheduler`: every tick starts due automations and reaps stale runs; at
  most hourly it purges expired trash and page views. A failing step is logged and skipped; the
  returned stop function waits for a tick in flight.
- `src/app.ts` `createApp(services)`: CORS, bearer auth, error mapping, and `routeGroups()`.
  Exports `RouteGroups`/`AppType`, which `@lyfestyle/client` types itself from.
- `src/services.ts` `createServices(deps)`: the one place services are constructed and wired.
- `src/config.ts` zod-parsed env into `Config`. New env vars go here (and in `.env.example`).
- `src/<domain>/routes.ts` + `service.ts`: `pages/` (+ `sync-routes.ts`), `todos/` (todos and
  goals), `agent/` (conversations, runs, usage), `automations/` (`service.ts` facade and scheduling,
  `deploys.ts`, `executor.ts`, `queries.ts`, the `ctx` helper manifest in `helpers.ts`, the child
  process in `sandbox.ts`, `schedule.ts`, the agent-facing `guide.ts`),
  `notifications/`, `metrics/`, `mcp-servers/`
  (also `/agent/config`), `integrations/` (Canvas, Resend, `store.ts`, `service.ts` for status and which tool
  requirements are met, `schema.ts` with `emailFields`).
- `src/tools/definitions.ts` every agent tool; `registry.ts` validation and gating; `routes.ts`
  serves the registry as `/mcp` (MCP streamable HTTP) and `/tools` (plain HTTP).
- `src/lib/`: `errors.ts`, `validate.ts` (`validate`, `byId`), `crypto.ts` (SecretBox),
  `notifier.ts` (in-process pub/sub), `pagination.ts` (`keyset` + `paginate` cursors), `html.ts`,
  `report.ts` (`groupedTotals` and SQL fragments for grouped reports), `rate-limit.ts` (in-memory
  token buckets and daily caps), `timezone.ts` (`isTimeZone`, zod `timeZone`), `types.ts`
  (`Patch<T>`). `validate.ts` also has `limitBody(bytes)`. Zod field schemas a route and a tool share live in
  `src/<domain>/schema.ts`, never in `routes.ts`.
- `prisma/schema.prisma` models mapped onto snake_case tables; `prisma/migrations/` SQL migrations.
- `src/db/client.ts` opens Postgres (`DATABASE_URL` is required; [ADR 0008](../../docs/adr/0008-postgres-only.md)), migrates, and returns the Prisma client (`Db`)
  narrowed by a result extension; also `Tx`, `Row<'model'>`, `advisoryLock`, `lockRow`,
  `fromDay`. `src/db/migrate.ts` applies migrations and warns at startup when an applied migration's
  file changed or the database has migrations the folder lacks. `src/db/pglite.ts` (`openPglite`,
  `migratePglite`) opens the same schema on in-memory PGlite for tests only; nothing reachable from `src/index.ts` may import it. `src/db/generated/` is the generated client
  (gitignored, made by `postinstall`). `src/testing.ts` test harness (exported as
  `@lyfestyle/api/testing`). `tests/` vitest suites and `fake-fetch.ts`.

New domain: `src/<domain>/service.ts` (`createXService(deps)` + `export type XService`), wire it in
`services.ts`, add `src/<domain>/routes.ts`, register it in `routeGroups()` in `app.ts`, and add the
same key to `GROUPS` in `packages/client/src/client.ts` (a `satisfies` check fails otherwise).

## Invariants and conventions

- Routers are `new Hono().basePath('/x')` with handlers chained in one expression and responses via
  `c.json(...)`; breaking the chain loses the inferred types the client depends on.
- Validate every input with `validate(target, schema)` from `lib/validate.ts`, never raw
  `zValidator`, so failures use the API's 400 `invalid_request` shape. Read with `c.req.valid()`.
- Throw `ApiError` helpers from `lib/errors.ts` (`notFound`, `badRequest`, `conflict`,
  `unauthorized`, `forbidden`, `tooLarge`, `rateLimited`, `unavailable` = 424, `upstream` and
  `unreachable` = 502). `app.onError` turns them into `{ error: { code, message, details? } }`,
  maps Hono `HTTPException`s by status (malformed JSON → 400 `invalid_request`) and Prisma P2025 →
  404, P2002/P2003 → 409 (`onDuplicate(message)` gives a friendlier 409); anything else becomes a
  logged 500.
- Every route needs the bearer token except `PUBLIC_PATHS` in `app.ts` (`/health`,
  `/metrics/collect`, `/metrics/script.js`). Add to that set deliberately. The root `API_TOKEN`
  reaches everything. A run's agent token (minted by `claim`, checked by `runs.authorize`) reaches
  only what `agentMay` in `app.ts` allows (`/mcp`, `GET /tools`, `POST /tools/:name`), and only
  while the run is running. Never widen it to routes that read secrets or approve deploys.
- Tools are defined once with `defineTool` in `tools/definitions.ts` and reach both `/mcp` and
  `/tools` through the registry. Set `readOnly`/`destructive`, and `requires: 'canvas' | 'resend'` so the tool is hidden (and 424s) until the integration is set up. Tools run as
  `run(input, ctx)`; `ctx: ToolContext` (`run: { id, kind } | null`, `automation` for automation
  code) comes from the `caller` the auth middleware sets. Mark a tool `attendedOnly` when an
  unattended caller must not use it (deploying, running, pausing or deleting automations). Reuse zod
  field schemas from the domain's `schema.ts` (e.g. `todoFields`) instead of redefining them.
- Secrets at rest go through `SecretBox.seal/open` (AES-256-GCM, key from `ENCRYPTION_KEY`):
  integration credentials in `integrations/store.ts`, MCP server url, args, headers and env in
  `mcp-servers/service.ts` (the `url` column holds only a display form and `args` is `[]`; older
  rows upgrade on their next read or write). Never return secret values from UI routes (`view()`
  returns names and counts only); only `/agent/config` hands them to the runner. An undecryptable
  secret shows as `secretsUnavailable` and can still be deleted.
- Single replica (the Railway service is set to 1 replica, docs/deployment.md): `Notifier` is an in-process EventEmitter that
  drives run SSE streams and claim long-polls, and `startScheduler` ticks in-process. Do not add
  state that needs cross-instance coordination without replacing these.
- Automations ([ADR 0006](../../docs/adr/0006-automations-as-approved-code.md),
  [ADR 0007](../../docs/adr/0007-automation-sandbox-process.md)): code changes only through
  `propose` → `approve`; never add a route or tool that writes `automations.code` directly. The code
  runs in a child process (`sandbox.ts`) with `--permission`, `env: {}` and IPC only. Never pass it
  secrets or env, never add an `--allow-*` flag without a new ADR, and send its inputs over IPC, not
  argv. Validate every child message with zod and never throw in the IPC listener. The code reaches
  the API only through `ctx`. A helper is one entry in `HELPERS` in `helpers.ts` (name, argument
  tuple schema, guide line, `run`); the host dispatch, the child's `ctx` and `guide.ts` all derive
  from it. Arguments and results cross IPC as JSON, so an `undefined` argument arrives as null.
  Executions live in the executor's in-memory `active` map. A run that ends cancels its unfinished
  agent runs; pause, delete and shutdown record it as `cancelled` without notifying; `recover()`
  fails leftovers and cancels their agent runs at startup.
- Budgets: every run has `budgetUsd` (at most `RUN_BUDGET_USD`), and `report` asks the runner to stop
  once its usage passes it. An automation run's `ctx.agent` calls share one budget: each is
  enqueued under a per-execution lock with the budget less what finished siblings spent and
  unfinished ones hold, and `report` also sums every agent run of an automation run and, past
  `RUN_BUDGET_USD`, cancels the siblings.
- Runs: `runs.enqueue(tx, ...)` inside the caller's transaction, then `runs.announce(...)` after it
  commits. Run events are append-only rows; status events are written only by the API. Claims are
  serialised with a Postgres advisory lock so one conversation never runs two turns at once. SSE
  uses `runs.follow`, which reads the backlog to its end before emitting buffered live events.
  Every run reaching a terminal status emits `topics.runQueued`. Deleting a conversation calls
  `runs.cancelConversation` first.
- The run-event shapes come from `@lyfestyle/shared` (`runEventInput`); change them there, not here.
- Pages: every write bumps `version` and takes `nextval('page_seq')` under `PAGE_WRITE_LOCK`, with
  timestamps from the injected `now()`; `page_links` is rebuilt from `[label](page:<uuid>)` via
  `extractPageLinks`. `baseVersion` mismatches are 409 conflicts. Deletes only set `deletedAt` (the
  trash); the scheduler's `purgeTrash` removes rows trashed more than `TRASH_DAYS` (from
  `@lyfestyle/shared`) ago. `/sync/push` goes through `pages.applyChanges`, one write per change; a
  change with a non-null `baseVersion` for a missing (purged) page answers `gone` and is never
  inserted. Summaries select no `content`: the excerpt is cut in SQL with `left()`.
- Use the injected `now()` from `Deps` for timestamps in services so tests can pin the clock, and
  the injected `fetch` for all outbound HTTP (Canvas, Resend), with a timeout.
- Migrations: edit `prisma/schema.prisma`, run `pnpm db:generate`, commit the new migration. Never
  edit or rename an applied migration. They apply automatically on startup and in every test context
  via `src/db/migrate.ts`, recorded in `_prisma_migrations`
  ([ADR 0005](../../docs/adr/0005-prisma.md)). Never run `prisma migrate dev` or `db push`: `.env`
  may point at production. The `tsvector` search column and `page_seq` exist only in migration SQL.
- Prisma types: a text column holding a union, a JSON column or a bigint gets its TypeScript type in
  `narrow()` in `src/db/client.ts`, so routes keep returning the types `@lyfestyle/client` infers.
  `date` columns read back as `YYYY-MM-DD`; write and filter them with `fromDay()`. Functions that
  run inside a caller's transaction take `Tx`.
- What Prisma cannot express is SQL via `$queryRaw`/`$executeRaw` with `Prisma.sql` fragments:
  advisory locks, row locks (`lockRow`), `nextval`, full-text search, and grouped reports.
  Use `$executeRaw` for statements whose result is `void`.
- Imports use NodeNext `.js` suffixes on relative paths and `import type` for types
  (`verbatimModuleSyntax`). `exactOptionalPropertyTypes` is on: optional fields that may be
  `undefined` need `?: T | undefined` (see `Patch<T>`).

## Testing

Each test file builds one `createTestContext()` (fresh in-memory PGlite, real migrations, real
services) in `beforeAll` and closes it in `afterAll`. `t.call(method, path, body)` sends an
authenticated JSON request; `t.services` reaches services directly; `t.fetch` lets clients hit the
app in-process. Outbound fetch rejects unless you pass `fakeFetch()` from `tests/fake-fetch.ts`:

```ts
const net = fakeFetch();
net.on('GET', 'https://school.instructure.com/api/v1/courses', () => net.json([]));
const t = await createTestContext({
    fetch: net.fetch,
    now: () => clock,
    env: { RESEND_API_KEY: 're_test', RESEND_FROM: 'Lyfestyle <agent@example.com>' },
});
```

Tests in one file share the database, so make assertions robust to earlier rows (see `drainQueue`
in `tests/agent.test.ts`). Simulate a runner by calling `/runs/claim`, `/runs/:id/events` and
`/runs/:id/complete` with `harness: 'fake'`; no test may start Claude Code or any real agent.

## Gotchas

- The Dockerfile only copies `packages/shared` into the build; importing `@lyfestyle/client` (or any
  other workspace package) from API source breaks the image.
- `.partial()` schemas must not carry `.default()`: the default would overwrite stored values on
  every PATCH.
- A schema change without `pnpm db:generate` leaves the client stale and the database unmigrated.
- Prisma interactive transactions time out (30 s, set in `src/db/client.ts`); do no outbound HTTP
  inside `db.$transaction`.
- Prisma reserves `_sum`/`_count` keys, which oxlint's `no-underscore-dangle` flags as property
  access; destructure them instead (`const { _sum: sum } = ...`).
- `PUBLIC_METRICS_PATHS` use their own permissive CORS; all other routes use `CORS_ORIGINS`.
  `/metrics/collect` is rate limited in memory (60 per IP per minute, 10,000 per day); the client
  IP is the rightmost `X-Forwarded-For` entry.
- Routes that take a large body put `limitBody(bytes)` before `validate('json', ...)`; it answers
  413 `payload_too_large` (4 MiB per page write, 10 MiB per sync push).
- `BUILTIN_MCP_SERVER` (`lyfestyle`) is a reserved MCP server name.
