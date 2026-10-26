# Development

## Setup

Requires Node 22.18+ (`.nvmrc`), pnpm 11 (`corepack enable`), and for the desktop app the Rust
toolchain plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install            # also installs the git hooks
cp .env.example .env
pnpm secrets            # paste API_TOKEN and ENCRYPTION_KEY into .env
pnpm dev                # API, runner and desktop app together; Ctrl+C stops all three
```

`pnpm dev` starts the API (`http://localhost:3000`, data in `apps/api/.data`) and waits for it to
answer before starting the runner and the desktop app. It passes `.env` to all of them, so the app
opens already connected to the API. If an API is already answering on that port, it is reused. Use
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
| `pnpm test`        | Vitest in every package. In-memory PGlite; no services needed.             |
| `pnpm build`       | API bundle (`apps/api/dist`) and desktop frontend (`apps/desktop/dist`).   |
| `pnpm lint:rust`   | `cargo fmt --check` and `clippy -D warnings` for `apps/desktop/src-tauri`. |
| `pnpm db:generate` | Write a migration after changing `apps/api/src/db/schema.ts`.              |

The API applies pending migrations on start. Never edit files under `apps/api/drizzle/` by hand.

Use pnpm only. `npm install` or a `package-lock.json` breaks the workspace links.

## Quality gates

Three layers check the same things, from fastest to most complete.

**Pre-commit** ([lefthook.yml](../lefthook.yml)), on staged files only:

- refuses `.env` files, `package-lock.json`/`yarn.lock`, files over 1 MB, and strings that look
  like API keys or private keys (`scripts/hooks/check-staged.mjs`)
- formats with Prettier, fixes with oxlint, runs `cargo fmt` on Rust, and re-stages the result

**Commit message**: [Conventional Commits](https://www.conventionalcommits.org/), checked by
`scripts/hooks/commit-msg.mjs`:

```
type(scope): summary in the imperative, no trailing period, 72 chars max
```

Types: `feat fix docs style refactor perf test build ci chore revert`.
Scopes: `api runner desktop client shared deps ci docs repo` (optional).

**Pre-push**: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` in parallel.

**CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), on every push to `main` and every
pull request:

- `check`: lint (annotated inline), format, typecheck, test, build, and a check that
  `pnpm db:generate` produces no new migration
- `rust`: `cargo fmt --check` and `clippy -D warnings` for the Tauri crate
- `docker`: builds the API image from `apps/api/Dockerfile`

Dependabot opens weekly grouped updates for npm and Cargo, monthly for Actions and the Docker base
image, each after a 3-day cooldown to match `minimumReleaseAge` in `pnpm-workspace.yaml`.

`LEFTHOOK=0 git commit ...` skips the hooks once. Use it rarely; CI runs the same checks.
