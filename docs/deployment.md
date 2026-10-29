# Deployment

## API on Railway

Railway builds and deploys the API from GitHub. CI is the gate: in the service settings, turn on
**Wait for CI** so a push to `main` deploys only after the `CI` workflow passes.

1. Create a project from this repo and add a **Postgres** database.
2. In the API service settings, keep the root directory as `/` and leave the build command, start
   command and config file path empty. Railway reads the root [`railway.json`](../railway.json): it
   builds `apps/api/Dockerfile`, health-checks `/health`, only rebuilds when `apps/api`, a
   workspace package, a root file the image copies (`package.json`, `pnpm-workspace.yaml`,
   `pnpm-lock.yaml`, `tsconfig.base.json`), `.dockerignore` or `railway.json` change, gives a
   stopping deploy 30 s between SIGTERM and SIGKILL (`drainingSeconds`), and pins one replica
   ([ADR 0003](adr/0003-single-api-replica.md)). Set `PORT=3000` and use 3000 as the domain's
   target port.
3. Set variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `API_TOKEN`, `ENCRYPTION_KEY`
   (`pnpm secrets` prints fresh values), and optionally `RESEND_API_KEY`/`RESEND_FROM`. `PUBLIC_URL` defaults to the service's Railway domain.
4. Generate a public domain. Point the runner and the desktop app at it with `LYFESTYLE_API_URL`.

`DATABASE_URL` is required: without it the API exits at startup and the health check fails the
deploy ([ADR 0008](adr/0008-postgres-only.md)). There is no embedded fallback database. For local
development run a Postgres yourself ([development](development.md)).

Migrations run on start, so a deploy that changes the schema needs no manual step. Changing
`ENCRYPTION_KEY` orphans every stored Canvas token and MCP secret.

If an applied migration's file no longer matches the checksum recorded for it, or the database has
migrations this build lacks (after a rollback), the API logs a `WARNING` at startup and boots
anyway; check the deploy logs after a rollback. On SIGTERM the API stops accepting connections,
gives open requests 10 s before cutting claim long-polls and run streams, waits for a scheduler tick
in flight, gives running automations up to 15 s to stop, then closes the database.

## Desktop app

[`release-desktop.yml`](../.github/workflows/release-desktop.yml) builds the Windows installer on
`windows-latest` and attaches it to a draft GitHub release:

```sh
# bump "version" in apps/desktop/src-tauri/tauri.conf.json and Cargo.toml first
git tag desktop-v0.2.0
git push origin desktop-v0.2.0
```

Review the draft release on GitHub, then publish it. Installed apps check
`releases/latest/download/latest.json` on launch and offer to install a newer version, so an update
reaches users only once its release is published (not draft, not prerelease).

Updates are signed. The workflow reads the private key from the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the public key is `plugins.updater.pubkey` in
`tauri.conf.json`. Losing the private key means installed apps can never update again, so keep a
backup. Locally, `pnpm desktop:build` needs `TAURI_SIGNING_PRIVATE_KEY` set (a path works) and
produces the same installer under `apps/desktop/src-tauri/target/release/bundle`.

## Web app

The same frontend also builds as a static site for phones and browsers:
`pnpm --filter @lyfestyle/desktop build:web` writes `apps/desktop/dist`. Host that folder on any
static host (Cloudflare Pages, Vercel, a Railway static service) with `index.html` as the fallback.
It works only through the API: the first visit asks for the API URL and token, and only those are
kept in the browser. Documents load from the API on every visit (no offline copy), and the agent
features are hidden because no runner in the cloud takes chat turns. Add the site's origin to the API's
`CORS_ORIGINS`.

## Runner on Railway

Automations run on the API's schedule, and their `ctx.agent` calls need a runner that is always
up, so a second Railway service runs `apps/runner` for automation runs only
([ADR 0009](adr/0009-cloud-runner-for-automations.md)). Chat stays on your machine: the desktop
app's in-app runner claims only chat turns.

1. In the same Railway project, add a service from this repo. In its settings set the config file
   path to `/apps/runner/railway.json` (it builds `apps/runner/Dockerfile`, pins one replica and
   rebuilds only when the runner or a workspace package changes). Keep the root directory as `/`.
   It needs no public domain and no health check: it only makes outbound requests.
2. Set variables:

    | Variable              | Value                                                                    |
    | --------------------- | ------------------------------------------------------------------------ |
    | `LYFESTYLE_API_URL`   | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`                                 |
    | `LYFESTYLE_API_TOKEN` | `${{api.API_TOKEN}}`                                                     |
    | `ANTHROPIC_API_KEY`   | An Anthropic API key. Automation agent runs are billed to it.            |
    | `RUNNER_KINDS`        | `automation`                                                             |
    | `RUNNER_ID`           | `railway`: shown as the runner on each agent run in the app              |
    | `TZ`                  | Your IANA time zone, e.g. `America/Chicago`: the agent's idea of "today" |
    | `AGENT_MODEL`         | Optional Claude model id                                                 |
    | `RUNNER_CONCURRENCY`  | Optional; 1 by default                                                   |

    (`api` is the API service's name in Railway; use yours.)

Each automation run's agent calls share one budget of the API's `RUN_BUDGET_USD` ($5 by default):
the API stops an agent run that passes it, and Claude Code is started with the same
`--max-budget-usd`. Set the runner's `AGENT_MAX_BUDGET_USD` for a lower cap per call. The image
sets `AGENT_CONNECTOR_TOOLS=none`: a container has no claude.ai login, so automation agents use the
`lyfestyle` tools and the API's integrations, not the Gmail or Calendar connectors.

Watch a run from the app's Automations page: click a run's status, its `logs` button or its mark
on the timeline. The log shows what the code has logged so far and each agent run's messages,
tool calls and spend as they arrive. The runner's own output is in the service's Railway logs.

`pnpm runner` on your machine still works and, without `RUNNER_KINDS`, takes runs of either kind.
