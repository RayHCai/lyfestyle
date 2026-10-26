# packages: @lyfestyle/shared and @lyfestyle/client

`@lyfestyle/shared` holds the zod schemas and helpers that the API, runner and client agree on (run
events, dates, page links). `@lyfestyle/client` is the typed Hono RPC client for the API, plus the
run-event SSE reader and the offline page `SyncEngine`; the runner uses it, and future clients
should. Both ship TypeScript source (`exports` points at `src/index.ts`); there is no build step.

## Commands

- `pnpm --filter @lyfestyle/shared test` / `typecheck` (vitest, pure unit tests).
- `pnpm --filter @lyfestyle/client test` / `typecheck` (vitest against an in-process API).
- After changing either package, also run `pnpm --filter @lyfestyle/api --filter
@lyfestyle/runner test` and `typecheck`: they consume these sources directly.

## Layout

- `shared/src/run-events.ts` `contentBlock`, `messageRole`, `runKind`, `runStatus`,
  `TERMINAL_RUN_STATUSES`, `runEventInput` (message, log, session, usage), `StatusEvent`,
  `RunEvent`, `ModelUsageTotals`.
- `shared/src/dates.ts` `isoDate` (YYYY-MM-DD, real calendar day), `addDays`, `weekStart` (Sunday),
  `monthStart`. `shared/src/links.ts` `extractPageLinks`, `pageLink` for `[label](page:<uuid>)`.
- `shared/src/index.ts` re-exports all three; add new modules there.
- `client/src/client.ts` `createApiClient` (one `hc` client per route group), `unwrap`,
  `ApiRequestError`. `client/src/events.ts` `streamRunEvents` (SSE over fetch, resumes from the last
  id, ends on a terminal status). `client/src/sync.ts` `SyncEngine`, `LocalStore`, `MemoryStore`,
  conflict resolution. `client/src/index.ts` public surface; it also re-exports `@lyfestyle/shared`.

## Invariants and conventions

- `run-events.ts` is a cross-process contract. The API validates reports with `runEventInput` and
  stores them; the runner emits them; `streamRunEvents` and the bridge read them; the desktop app
  mirrors the types by hand in `apps/desktop/src/lib/api.ts`. A change here needs matching changes
  in `apps/api/src/agent/runs.ts`, `apps/runner/src/claude-code.ts` and `bridge.ts`, and desktop's
  `api.ts`. Prefer additive, optional fields; stored `run_events` rows keep their old shape.
- `status` events are written only by the API, so they are not in `runEventInput`.
- Usage in a `usage` event is what one run added, not a session total.
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
- `streamRunEvents` uses `fetch`, not `EventSource`, so it can send the bearer token. It does not
  retry on `ApiRequestError` (HTTP errors), only on dropped connections.
- `SyncEngine` defaults to `keep: 'both'` on conflict so no edit is lost silently; `LocalStore` is
  the seam for IndexedDB/SQLite/memory.
- Both packages compile with TypeScript 7 and `tsconfig.base.json` (NodeNext, `.js` import suffixes,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). The desktop
  app (TS 5.9, bundler resolution) cannot import them, which is why it has its own thin client.
- `shared` depends only on `zod`; keep it free of Node-only APIs so any runtime can import it.

## Testing

`shared/tests/shared.test.ts` is plain vitest on pure functions. `client/tests/client.test.ts`
boots a full API in memory and points the client at it, so no network or real agent is involved:

```ts
import { createTestContext, TEST_TOKEN, TEST_URL } from '@lyfestyle/api/testing';
const t = await createTestContext();
const api = createApiClient({ baseUrl: TEST_URL, token: TEST_TOKEN, fetch: t.fetch });
const page = await unwrap(api.pages.$post({ json: { title: 'Typed' } }));
```

Run events are produced in tests by calling `/runs/claim`, `/runs/:id/events` and
`/runs/:id/complete` through `t.call` with a fake harness name, never by running Claude Code. Sync
tests build several `SyncEngine`s over separate `MemoryStore`s to simulate devices.

## Gotchas

- Changing an API route's input or response changes client types; run `client` typecheck after any
  API route edit.
- Do not add runtime imports of `@lyfestyle/api` to the client; it is a devDependency used for
  types only (and `@lyfestyle/api/testing` in tests).
- The API Docker image copies `packages/shared` but not `packages/client`; the API must not import
  the client.
