# packages: @lyfestyle/shared and @lyfestyle/client

`@lyfestyle/shared` holds the zod schemas and helpers that the API, runner, client and desktop app
agree on (run events, the run-event SSE reader, dates, page links). `@lyfestyle/client` is the
typed Hono RPC client for the API; the runner uses it, and future Node clients should. Both ship
TypeScript source (`exports` points at `src/index.ts`); there is no build step.

## Commands

- `pnpm --filter @lyfestyle/shared test` / `typecheck` (vitest, pure unit tests).
- `pnpm --filter @lyfestyle/client test` / `typecheck` (vitest against an in-process API).
- After changing either package, also run `pnpm --filter @lyfestyle/api --filter
@lyfestyle/runner test` and `typecheck`: they consume these sources directly. After changing
  `shared`, also typecheck the desktop app, which imports it.

## Layout

- `shared/src/run-events.ts` `contentBlock`, `messageRole`, `runKind`, `runStatus`,
  `TERMINAL_RUN_STATUSES`, `runEventInput` (message, log, session, usage), `INT4_MAX`,
  `StatusEvent`, `RunEvent`, `ModelUsageTotals`.
- `shared/src/sse.ts` `streamRunEvents` (a run's events over SSE with `fetch`), `sseFrames`,
  `StreamHttpError`. `shared/src/http.ts` `trimTrailingSlashes`, `retryableStatus`.
- `shared/src/dates.ts` `isoDate` (YYYY-MM-DD, real calendar day), `addDays`, `weekStart` (Sunday),
  `monthStart`, `DAY_MS`. `shared/src/links.ts` `extractPageLinks`, `pageLink` for
  `[label](page:<uuid>)`. `shared/src/pages.ts` `TRASH_DAYS`.
- `shared/src/index.ts` re-exports every module; add new modules there.
- `client/src/client.ts` `createApiClient` (one `hc` client per route group), `unwrap`,
  `ApiRequestError`. `client/src/events.ts` `streamRunEvents`: the shared reader with HTTP errors
  thrown as `ApiRequestError`. `client/src/index.ts` public surface; it also re-exports
  `@lyfestyle/shared`.

## Invariants and conventions

- `run-events.ts` is a cross-process contract. The API validates reports with `runEventInput` and
  stores them; the runner emits them (and validates each before sending); `streamRunEvents` and
  the bridge read them; the desktop app imports the types. A change here needs matching changes in
  `apps/api/src/agent/runs.ts`, `apps/runner/src/claude-code.ts` and `bridge.ts`, and the desktop
  app. Prefer additive, optional fields; stored `run_events` rows keep their old shape.
- `status` events are written only by the API, so they are not in `runEventInput`.
- Usage in a `usage` event is what one run added, not a session total. Token counts and
  `durationMs` are capped at `INT4_MAX` by the schema (the API's columns are int4), not rejected:
  one absurd figure must not fail a batch of 200 events.
- `isoDate` is a calendar day in the user's zone; never convert it through local `Date` parsing.
  The date helpers work in UTC internally on purpose.
- `extractPageLinks` matches `page:` UUIDs case-insensitively, dedupes, and returns lowercase ids;
  the API's `page_links` table depends on that normalisation.
- Client typing: `ApiClient` is derived from `RouteGroups` in `apps/api/src/app.ts` (a type-only
  import of `@lyfestyle/api`, a devDependency). A new API route group must be added to `GROUPS` in
  `client.ts`; the `satisfies Record<keyof RouteGroups, true>` check fails until it is. Do not type
  the whole `AppType` at once; it is too deep for tsc.
- `unwrap` returns the 2xx JSON body and throws `ApiRequestError` (status, code, message, details)
  for the API's `{ error: { code, message, details? } }` shape.
- `streamRunEvents` uses `fetch`, not `EventSource`, so it can send the bearer token. It retries a
  dropped connection, an early close, a 5xx, 408 or 429 (`retryableStatus`) after the last event
  seen, resetting its retry count whenever an event arrives; any other HTTP error throws at once
  (`StreamHttpError`, or `ApiRequestError` through the client). There is one implementation, in
  `shared`; the client only supplies `toError`.
- The offline page sync engine that used to live in `client` is gone (nothing used it). The API's
  `/sync/push` and `/sync/pull` routes remain; the desktop app has its own sync in
  `apps/desktop/src/lib/sync.ts`.
- Both packages compile with TypeScript 7 and `tsconfig.base.json` (NodeNext, `.js` import suffixes,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). The desktop
  app (TS 5.9, bundler resolution) imports `shared` but not `client`, whose types come from the API
  source; it keeps its own thin client in `apps/desktop/src/lib/api.ts`.
- `shared` depends only on `zod`; keep it free of Node-only APIs so the desktop's webview can
  import it.

## Testing

`shared/tests/*.test.ts` are plain vitest on pure functions; `sse.test.ts` drives
`streamRunEvents` with a scripted `fetch`. `client/tests/client.test.ts` boots a full API in memory
and points the client at it, so no network or real agent is involved:

```ts
import { createTestContext, TEST_TOKEN, TEST_URL } from '@lyfestyle/api/testing';
const t = await createTestContext();
const api = createApiClient({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });
const page = await unwrap(api.pages.$post({ json: { title: 'Typed' } }));
```

Run events are produced in tests by calling `/runs/claim`, `/runs/:id/events` and
`/runs/:id/complete` through `t.call` with a fake harness name, never by running Claude Code.

## Gotchas

- Changing an API route's input or response changes client types; run `client` typecheck after any
  API route edit.
- Do not add runtime imports of `@lyfestyle/api` to the client; it is a devDependency used for
  types only (and `@lyfestyle/api/testing` in tests).
- The API Docker image copies `packages/shared` but not `packages/client`; the API must not import
  the client.
