# 0005. Use Prisma for the API's database access and migrations

- Status: accepted
- Date: 2026-10-26

## Context

The API started on Drizzle. We are moving it to Prisma 7, which talks to Postgres through driver
adapters (`@prisma/adapter-pg`, and `pglite-prisma-adapter` for the embedded and test database).
Two constraints shape how:

- Existing databases, Railway's included, hold data in the tables Drizzle created.
- Tests and local development run on PGlite inside the API process. The Prisma CLI's migration
  engine is a separate binary that only reaches databases over TCP, and Prisma Client cannot run a
  multi-statement migration script.

## Decision

- `apps/api/prisma/schema.prisma` maps camelCase models onto the existing snake_case tables, and
  the first migration, `0_init`, is exactly the SQL Drizzle generated. No table changes.
- The API applies `prisma/migrations` itself on startup (`src/db/migrate.ts`) through the raw
  driver, in one transaction, recording each migration in `_prisma_migrations` as
  `prisma migrate deploy` would. A database that has Drizzle's tables but no Prisma history gets
  `0_init` marked as applied instead of re-run.
- `pnpm db:generate` diffs the schema against the migrations with a throwaway PGlite served over a
  local socket as Prisma's shadow database, so it never needs or touches a real `DATABASE_URL`.
- Text columns holding unions, JSON columns and bigint counters are narrowed in one Prisma Client
  result extension (`src/db/client.ts`), so service return types, and the client types Hono infers
  from them, are unchanged.
- Queries Prisma cannot express stay as SQL through `$queryRaw`/`$executeRaw`: advisory locks,
  `FOR UPDATE [SKIP LOCKED]`, `nextval('page_seq')`, full-text search over the generated
  `tsvector` column, and the usage and metrics reports that group by expressions.

## Consequences

- One migration path for Postgres and PGlite; tests exercise the same SQL production runs.
- The generated client (`src/db/generated/`, gitignored) must exist before typecheck, tests or a
  build. The API's `postinstall` runs `prisma generate`, and `pnpm db:generate` refreshes it.
- `prisma migrate dev` is not used: pointed at `.env` it would target the production database.
  `prisma migrate status` against a real database still works.
- Prisma cannot model the `tsvector` column or the `page_seq` sequence; both live only in
  migration SQL. Changes to them are hand-written migrations, which `pnpm db:generate` then sees as
  matching.
- Revisit if Prisma Migrate gains in-process adapters for PGlite, which would let the CLI replace
  `src/db/migrate.ts`.
