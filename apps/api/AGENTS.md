# @lyfestyle/api

Hono HTTP API over Postgres (or embedded PGlite) that owns all Lyfestyle data: pages, planner,
conversations, runs, jobs, usage, metrics, integrations and the agent's tools. Called by the
runner, the desktop app (API mode), `@lyfestyle/client` and MCP clients (`/mcp`); deployed to
Railway. Route reference: [docs/api.md](../../docs/api.md); see also
[docs/architecture.md](../../docs/architecture.md), [docs/deployment.md](../../docs/deployment.md)
and [docs/integrations.md](../../docs/integrations.md).

## Commands

- `pnpm --filter @lyfestyle/api test` (vitest, in-memory PGlite, ~10 s) / `typecheck` (`tsc -p .`)
- `pnpm api:dev` from the root: `tsx watch` with the root `.env`; needs `API_TOKEN` (>= 24 chars)
  and `ENCRYPTION_KEY` (32 bytes base64). `pnpm secrets` generates both.
- `pnpm db:generate` from the root (= `drizzle-kit generate` here): writes SQL into `drizzle/`.
- `pnpm api:build`: esbuild bundle to `dist/index.js` (workspace packages inlined, npm external).

## Layout

- `src/index.ts` process entry: config, database, services, scheduler, server, shutdown.
- `src/app.ts` `createApp(services)`: CORS, bearer auth, error mapping, and `routeGroups()`.
  Exports `RouteGroups`/`AppType`, which `@lyfestyle/client` types itself from.
- `src/services.ts` `createServices(deps)`: the one place services are constructed and wired.
- `src/config.ts` zod-parsed env into `Config`. New env vars go here (and in `.env.example`).
- `src/<domain>/routes.ts` + `service.ts`: `pages/` (+ `sync-routes.ts`), `todos/` (todos and
  goals), `agent/` (conversations, runs, jobs, usage, scheduler), `metrics/`, `mcp-servers/`
  (also `/agent/config`), `integrations/` (Canvas, Resend, `store.ts`).
- `src/tools/definitions.ts` every agent tool; `registry.ts` validation and gating; `routes.ts`
  serves the registry as `/mcp` (MCP streamable HTTP) and `/tools` (plain HTTP).
- `src/lib/`: `errors.ts`, `validate.ts`, `crypto.ts` (SecretBox), `notifier.ts` (in-process
  pub/sub), `pagination.ts` (keyset cursors), `types.ts` (`Patch<T>`).
- `src/db/schema.ts` Drizzle schema; `src/db/client.ts` opens Postgres or PGlite and migrates.
- `drizzle/` generated migrations and snapshots. `src/testing.ts` test harness (exported as
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
  `unavailable` = 424, `upstream` = 502). `app.onError` turns them into
  `{ error: { code, message, details? } }`; anything else becomes a logged 500.
- Every route needs the bearer token except `PUBLIC_PATHS` in `app.ts` (`/health`,
  `/metrics/collect`, `/metrics/script.js`). Add to that set deliberately.
- Tools are defined once with `defineTool` in `tools/definitions.ts` and reach both `/mcp` and
  `/tools` through the registry. Set `readOnly`/`destructive`, and `requires: 'canvas' | 'resend'` so the tool is hidden (and 424s) until the integration is set up. Reuse zod field
  schemas from the domain's routes (e.g. `todoFields`) instead of redefining them.
- Secrets at rest go through `SecretBox.seal/open` (AES-256-GCM, key from `ENCRYPTION_KEY`):
  integration credentials in `integrations/store.ts`, MCP server headers/env in
  `mcp-servers/service.ts`. Never return secret values from UI routes (`view()` returns names only);
  only `/agent/config` hands them to the runner.
- Single replica (root `railway.json` `numReplicas: 1`): `Notifier` is an in-process EventEmitter that
  drives run SSE streams and claim long-polls, and `startScheduler` ticks in-process. Do not add
  state that needs cross-instance coordination without replacing these.
- Runs: `runs.enqueue(tx, ...)` inside the caller's transaction, then `runs.announce(...)` after it
  commits. Run events are append-only rows; status events are written only by the API. Claims are
  serialised with a Postgres advisory lock so one conversation never runs two turns at once.
- The run-event shapes come from `@lyfestyle/shared` (`runEventInput`); change them there, not here.
- Pages: every write bumps `version` and takes `nextval('page_seq')` under `PAGE_WRITE_LOCK`;
  `page_links` is rebuilt from `[label](page:<uuid>)` via `extractPageLinks`. `baseVersion`
  mismatches are 409 conflicts.
- Use the injected `now()` from `Deps` for timestamps in services so tests can pin the clock, and
  the injected `fetch` for all outbound HTTP (Google, Canvas, Resend).
- Migrations: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the generated SQL and
  `drizzle/meta/*`. Never hand-edit or renumber files in `drizzle/`. Migrations apply automatically
  on startup and in every test context.
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
  every PATCH (see the comment above `jobInput` in `agent/routes.ts`).
- A schema change without `pnpm db:generate` passes typecheck but fails at runtime and in tests.
- `/metrics/collect` uses its own permissive CORS; all other routes use `CORS_ORIGINS`.
- `BUILTIN_MCP_SERVER` (`lyfestyle`) is a reserved MCP server name.
