# Development

## Setup

Requires Node 22.18+ (`.nvmrc`), pnpm 11 (`corepack enable`), and for the desktop app the Rust
toolchain plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install            # also installs the git hooks
cp .env.example .env
pnpm secrets            # paste API_TOKEN and ENCRYPTION_KEY into .env
# a local Postgres for the API; set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
docker run -d --name lyfestyle-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
pnpm dev                # API, runner and desktop app together; Ctrl+C stops all three
```

The API only runs on Postgres and needs `DATABASE_URL` ([ADR 0008](adr/0008-postgres-only.md)).
Keep a local database in `.env`: pointed at the production database, every local run writes
production data.

`pnpm dev` starts the API (`http://localhost:3000`, on the Postgres in `DATABASE_URL`) and waits for it to
answer before starting the runner and the desktop app. It stops when `DATABASE_URL` is missing and
warns when its host is not this machine. Each process gets only what it needs: the API all of
`.env`, the runner its `LYFESTYLE_*`, `AGENT_*`, `RUNNER_*` and `RUN_TIMEOUT_MINUTES` keys, the desktop app its
`LYFESTYLE_*` keys; `API_TOKEN`, `ENCRYPTION_KEY`, `DATABASE_URL` and `RESEND_API_KEY` reach those
two as empty values. Both get `LYFESTYLE_API_URL` and `LYFESTYLE_API_TOKEN`, so the app opens
already connected to the API. An API already answering at `LYFESTYLE_API_URL` is reused; if that URL
is not on this machine and not answering, `pnpm dev` stops instead of starting a local one. Use
`pnpm dev --no-desktop` for the API and runner alone, or run `pnpm api:dev`, `pnpm runner` and
`pnpm desktop` in separate terminals. The runner uses your local Claude Code login, so chat turns
and automations spend your Claude usage.

Then talk to it:

```sh
curl -H "Authorization: Bearer $API_TOKEN" localhost:3000/pages
echo "What's on my plate today?" | node apps/runner/bin/lyfestyle-agent.mjs
```

## Commands

| Command            | Does                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `pnpm check`       | Lint, format check, typecheck and tests: what CI and pre-push run.         |
| `pnpm lint`        | oxlint over the whole repo (`pnpm lint:fix` applies safe fixes).           |
| `pnpm format`      | Prettier over the whole repo (`pnpm format:check` to verify only).         |
| `pnpm typecheck`   | `tsc` in every package.                                                    |
| `pnpm test`        | Vitest in every package. API tests use in-memory PGlite; no services.      |
| `pnpm build`       | API bundle (`apps/api/dist`) and desktop frontend (`apps/desktop/dist`).   |
| `pnpm lint:rust`   | `cargo fmt --check` and `clippy -D warnings` for `apps/desktop/src-tauri`. |
| `pnpm test:rust`   | `cargo test` for `apps/desktop/src-tauri`.                                 |
| `pnpm db:generate` | Write a migration after changing `apps/api/prisma/schema.prisma`.          |

The API applies pending migrations on start. Never edit an applied migration under
`apps/api/prisma/migrations/`. `pnpm install` generates the Prisma client into
`apps/api/src/db/generated/` (gitignored); `pnpm db:generate` regenerates it.

Use pnpm only. `npm install` or a `package-lock.json` breaks the workspace links.

## Quality gates

Three layers check the same things, from fastest to most complete.

**Pre-commit** ([lefthook.yml](../lefthook.yml)), on staged files only:

- refuses `.env`/`.env.*` files (not `.env.example`) and `.envrc`, `package-lock.json`/`yarn.lock`,
  files over 1 MB, and strings that look like API keys, private keys, GitHub tokens, a database URL
  with a password for a non-local host, the todo MCP URL's secret path, or a real value for
  `API_TOKEN`, `ENCRYPTION_KEY`, `LYFESTYLE_API_TOKEN` or `RESEND_API_KEY`
  (`scripts/hooks/check-staged.mjs`)
- formats with Prettier, fixes with oxlint, runs rustfmt on staged Rust files, and re-stages the
  result

**Commit message**: [Conventional Commits](https://www.conventionalcommits.org/), checked by
`scripts/hooks/commit-msg.mjs`:

```
type(scope): summary in the imperative, no trailing period, 72 chars max
```

Types: `feat fix docs style refactor perf test build ci chore revert`.
Scopes: `api runner desktop client shared deps deps-dev ci docs repo` (optional).

**Pre-push**: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` in parallel.

**CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), on every push to `main` and every
pull request:

- `check`: lint (annotated inline), format, typecheck, test, build, and a check that
  `pnpm db:generate` produces no new migration
- `rust`: `cargo fmt --check`, `clippy -D warnings` and `cargo test` for the Tauri crate, on Linux
  and Windows (Windows compiles the `#[cfg(windows)]` code the app ships)
- `docker`: builds the API image from `apps/api/Dockerfile`

**Release** ([release-desktop.yml](../.github/workflows/release-desktop.yml)): bump `version` in
both `apps/desktop/src-tauri/tauri.conf.json` and `Cargo.toml` (the MCP server reports Cargo's;
`pnpm test:rust` fails while they differ), then push the tag `desktop-v<version>`, or run the
workflow by hand with that existing tag. It refuses a tag that does not match, runs `pnpm check`,
`lint:rust` and `test:rust`, then builds the installer into a draft release.

Dependabot opens weekly grouped updates for npm and Cargo, monthly for Actions and the Docker base
image, each after a 3-day cooldown to match `minimumReleaseAge` in `pnpm-workspace.yaml`.

`LEFTHOOK=0 git commit ...` skips the hooks once. Agents never use it (AGENTS.md); people only
when CI checks the same thing.
