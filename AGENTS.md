# AGENTS.md

Guide for coding agents working in this repo. Each package has its own `AGENTS.md` with its layout,
invariants and test patterns; read the one for the package you are changing before editing it.

| Package        | Guide                                            | Stack                                   |
| -------------- | ------------------------------------------------ | --------------------------------------- |
| `apps/api`     | [apps/api/AGENTS.md](apps/api/AGENTS.md)         | Hono, Drizzle, Postgres/PGlite, MCP SDK |
| `apps/runner`  | [apps/runner/AGENTS.md](apps/runner/AGENTS.md)   | Node, Claude Agent SDK                  |
| `apps/desktop` | [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) | Tauri 2 (Rust), React 19, Vite, Zustand |
| `packages/*`   | [packages/AGENTS.md](packages/AGENTS.md)         | Shared protocol and typed client        |

Background: [architecture](docs/architecture.md), [API reference](docs/api.md),
[development](docs/development.md), [deployment](docs/deployment.md),
[decisions](docs/adr/README.md).

## Commands

Run from the repo root. Use **pnpm only** (never npm or yarn, never commit `package-lock.json`).

```sh
pnpm check                          # lint + format:check + typecheck + test. Run before you finish.
pnpm lint:fix && pnpm format        # fix what can be fixed automatically
pnpm --filter @lyfestyle/api test   # one package; add `-- tests/pages.test.ts` for one file
pnpm lint:rust                      # only after touching apps/desktop/src-tauri
pnpm db:generate                    # after any change to apps/api/src/db/schema.ts
```

Tests use in-memory PGlite and fakes. They need no running services and no network.

## Workflow

1. Read the package's `AGENTS.md` and the code around your change. Match its style: naming, comment
   density, error handling, and where things live.
2. Make the smallest change that solves the problem. Do not reformat or refactor unrelated code.
3. Add or update tests next to the existing ones (`<package>/tests/*.test.ts`) for behaviour you add
   or fix.
4. Run `pnpm check`. It must pass with 0 lint errors. Do not introduce new lint warnings.
5. Update docs when behaviour changes: `docs/api.md` for routes, the package `AGENTS.md` for new
   conventions, a new ADR in `docs/adr/` for decisions that are expensive to reverse.

Commits use Conventional Commits (`feat(api): add page backlinks`); the `commit-msg` hook lists the
allowed types and scopes. Hooks format, lint and guard staged files; do not bypass them with
`--no-verify` or `LEFTHOOK=0`.

## Hard rules

- **No AI attribution.** Never add `Co-Authored-By: Claude …`, `noreply@anthropic.com`, or
  "Generated with Claude Code" lines to commits or PR descriptions. The `commit-msg` hook strips
  them and CI fails a PR that contains them.
- **Never commit secrets.** `.env` is gitignored; `.env.example` is the template. Add new variables
  to `.env.example` with a comment, and to `apps/api/src/config.ts` or `apps/runner/src/env.ts`.
- **Never run the real agent in tests or scripts.** Runs spend the user's Claude usage. Use the fake
  harness / fake runner patterns already in the tests.
- **Never hand-edit `apps/api/drizzle/`.** Change `schema.ts`, run `pnpm db:generate`, commit both.
  CI fails if the schema and migrations disagree.
- **Contracts that cross packages** change in one commit with all their consumers:
    - the run-event protocol in `packages/shared/src/run-events.ts` (API, runner, client, desktop)
    - API routes, which type `@lyfestyle/client`, and the desktop's own client in
      `apps/desktop/src/lib/api.ts`
    - the stream-json bridge `apps/runner/bin/lyfestyle-agent.mjs`, which the desktop app parses
      (stdout must stay JSON lines only; keep the `No conversation found` stderr phrase)
- **The API is single-replica** ([ADR 0003](docs/adr/0003-single-api-replica.md)). Do not add state
  that assumes otherwise, and do not move in-memory coordination without a new ADR.
- **Lint exceptions are explicit**: `// oxlint-disable-next-line <rule> -- <reason>`, never a
  file-wide disable or a config change to silence one site.
- **Dependencies**: add them to the package that uses them (`pnpm --filter <pkg> add <dep>`), not the
  root. `minimumReleaseAge` resolves very new releases to older versions; that is intended.

## Code style

Prettier and oxlint enforce formatting and most rules; these are the conventions they cannot:

- TypeScript strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`
  outside tests; validate untrusted input with zod at the boundary.
- ES modules everywhere. `import type` for type-only imports. Node built-ins as `node:fs`.
- Comments explain _why_, not what. Short doc comments on exported functions whose contract is not
  obvious from the signature.
- Errors: throw the helpers in `apps/api/src/lib/errors.ts` from API code; they map to the
  documented `{ error: { code, message } }` shape.
- Prefer deep modules: a small interface over a lot of behaviour. Keep route handlers thin and put
  logic in the package's `service.ts` files.

## Glossary

| Term             | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| Page             | A markdown document. Links to other pages as `[label](page:<uuid>)`.                   |
| Conversation     | A chat thread with the agent. Holds messages and a Claude Code session to resume.      |
| Job / automation | A cron schedule plus a prompt. When due, it queues a run.                              |
| Run              | One unit of agent work, queued by a message or a job and claimed by a runner.          |
| Run event        | A message, log, usage, session or status record that a runner posts for a run.         |
| Runner           | The local worker that claims runs and executes them through a harness.                 |
| Harness          | The thing that actually runs the agent: Claude Code, or any stream-json command.       |
| Tool             | A capability exposed to the agent via MCP at `/mcp` and as HTTP at `/tools/:name`.     |
| Integration      | A connected external account: Canvas, Resend. Gmail/Calendar are claude.ai connectors. |
| Bridge           | `lyfestyle-agent.mjs`: the desktop app's `LYFESTYLE_AGENT_COMMAND` backed by the API.  |
