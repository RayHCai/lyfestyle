# 0002. The agent runs on the user's machine, not on the server

- Status: accepted
- Date: 2026-10-26

## Context

The agent is Claude Code driven through the Agent SDK. Running it on the server would need an API
key billed separately from the user's Claude subscription, and its built-in tools would act on a
container instead of the user's machine.

## Decision

`apps/runner` runs locally, long-polls `/runs/claim`, executes each run through a `Harness`, and
posts run events back. The API only queues runs and stores their results. Harnesses are pluggable
(`claude-code`, or any command speaking stream-json via `AGENT_HARNESS_COMMAND`).

## Consequences

- Chat replies and automations only progress while a runner is up.
- Runs spend the user's real Claude usage, so tests must use a fake runner or harness.
- The runner is isolated from the user's own Claude Code config (`strictMcpConfig`,
  `settingSources: []`, `permissionMode: 'dontAsk'`) so personal settings cannot leak into runs.
