# Deployment

## API on Railway

Railway builds and deploys the API from GitHub. CI is the gate: in the service settings, turn on
**Wait for CI** so a push to `main` deploys only after the `CI` workflow passes.

1. Create a project from this repo and add a **Postgres** database.
2. In the API service settings, keep the root directory as `/` and leave the build command, start
   command and config file path empty. Railway reads the root [`railway.json`](../railway.json): it
   builds `apps/api/Dockerfile`, health-checks `/health`, only rebuilds when `apps/api`,
   `packages/shared` or the lockfile change, and pins one replica
   ([ADR 0003](adr/0003-single-api-replica.md)). Set `PORT=3000` and use 3000 as the domain's
   target port.
3. Set variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `API_TOKEN`, `ENCRYPTION_KEY`
   (`pnpm secrets` prints fresh values), and optionally `RESEND_API_KEY`/`RESEND_FROM`. `PUBLIC_URL` defaults to the service's Railway domain.
4. Generate a public domain. Point the runner and the desktop app at it with `LYFESTYLE_API_URL`.

Without `DATABASE_URL` the API falls back to PGlite inside the container, which is lost on
redeploy; it logs a warning when that happens on Railway.

Migrations run on start, so a deploy that changes the schema needs no manual step. Changing
`ENCRYPTION_KEY` orphans every stored OAuth token and MCP secret.

## Desktop app

[`release-desktop.yml`](../.github/workflows/release-desktop.yml) builds the Windows installer on
`windows-latest` and attaches it to a draft GitHub release:

```sh
# bump "version" in apps/desktop/src-tauri/tauri.conf.json first
git tag desktop-v0.2.0
git push origin desktop-v0.2.0
```

Review the draft release on GitHub, then publish it. Locally, `pnpm desktop:build` produces the
same installer under `apps/desktop/src-tauri/target/release/bundle`.

## Runner

The runner is not deployed. It runs on your machine (`pnpm runner`) so the agent uses your Claude
Code login ([ADR 0002](adr/0002-local-runner.md)). Point it at the deployed API with
`LYFESTYLE_API_URL` and `LYFESTYLE_API_TOKEN` in `.env`.
