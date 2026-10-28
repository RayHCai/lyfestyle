# 0008. Run the API on Postgres only; keep PGlite for tests

- Status: accepted
- Date: 2026-10-28

## Context

[ADR 0005](0005-prisma.md) kept embedded PGlite as a second runtime database: without
`DATABASE_URL` the API stored its data in `DATA_DIR` inside the process. In practice that path only
caused trouble. On Railway a missing variable silently put the data in the container, where a
redeploy deletes it, and in the Docker image the non-root user could not even create the data
directory, so the documented fallback crash-looped instead. Locally it meant two database engines
behind one code path, and development data that never matched production.

## Decision

- The API requires `DATABASE_URL` (a `postgres://` connection string) and refuses to start
  without one. `src/db/client.ts` only opens Postgres through `@prisma/adapter-pg`.
- PGlite stays where no server is the point: the test suites (`src/db/pglite.ts`, reached only
  from `src/testing.ts`) and `pnpm db:generate`'s throwaway shadow database. Both run the same
  migrations through the same `migrate()` as production. Its packages are dev dependencies, so the
  production image does not ship them.
- Local development runs against a Postgres of its own, e.g.
  `docker run -d --name lyfestyle-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17` with
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres`.

## Consequences

- No silent data loss from a missing variable: a misconfigured deploy fails its health check
  instead of running on throwaway storage.
- Running the API locally needs a Postgres server; tests still need nothing.
- `.env`'s `DATABASE_URL` is now always dialled by `pnpm dev`/`pnpm api:dev`. Pointing it at the
  production database makes local runs write production data, so keep a local one in `.env`.
- Supersedes the "embedded database" part of ADR 0005; its migration design is unchanged.
