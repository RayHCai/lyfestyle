# Architecture decision records

One file per decision that is expensive to reverse or easy to undo by accident. Copy
[template.md](template.md), number it next, and link it from code comments or `AGENTS.md` where the
decision bites. Supersede a record with a new one instead of rewriting it.

| ADR                                          | Decision                                                              |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [0001](0001-pnpm-workspace-monorepo.md)      | One pnpm workspace for every app and package                          |
| [0002](0002-local-runner.md)                 | The agent runs on the user's machine, not on the server               |
| [0003](0003-single-api-replica.md)           | The API runs as exactly one replica                                   |
| [0004](0004-oxlint-and-prettier.md)          | oxlint for linting, Prettier for formatting                           |
| [0005](0005-prisma.md)                       | Prisma for database access; the API runs migrations                   |
| [0006](0006-automations-as-approved-code.md) | Automations are user-approved code the API runs                       |
| [0007](0007-automation-sandbox-process.md)   | Automation code runs in a child process under Node's permission model |
| [0008](0008-postgres-only.md)                | The API runs on Postgres only; PGlite is for tests                    |
| [0009](0009-cloud-runner-for-automations.md) | Automation runs go to a runner on Railway; chat stays local           |
