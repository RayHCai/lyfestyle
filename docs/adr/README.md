# Architecture decision records

One file per decision that is expensive to reverse or easy to undo by accident. Copy
[template.md](template.md), number it next, and link it from code comments or `AGENTS.md` where the
decision bites. Supersede a record with a new one instead of rewriting it.

| ADR                                     | Decision                                                |
| --------------------------------------- | ------------------------------------------------------- |
| [0001](0001-pnpm-workspace-monorepo.md) | One pnpm workspace for every app and package            |
| [0002](0002-local-runner.md)            | The agent runs on the user's machine, not on the server |
| [0003](0003-single-api-replica.md)      | The API runs as exactly one replica                     |
| [0004](0004-oxlint-and-prettier.md)     | oxlint for linting, Prettier for formatting             |
