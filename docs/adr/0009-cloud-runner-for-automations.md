# 0009. Automation runs go to a runner on Railway; chat stays local

- Status: accepted
- Date: 2026-10-29
- Supersedes, for automation runs only: [0002](0002-local-runner.md)

## Context

Automations run on a cron schedule in the API ([0006](0006-automations-as-approved-code.md)), and
their `ctx.agent` calls queue agent runs. Under 0002 those runs waited for a runner on the user's
machine, so a 7 am automation that needed the agent stalled until the laptop woke up and was
reaped as stale.

## Decision

`apps/runner` also deploys to Railway as its own service (`apps/runner/Dockerfile`,
settings in the Railway dashboard) with `RUNNER_KINDS=automation`. It runs Claude Code through the Agent
SDK, billed to an `ANTHROPIC_API_KEY`, with no claude.ai connectors (`AGENT_CONNECTOR_TOOLS=none`).
`POST /runs/claim` takes `kinds`, and the desktop app's in-app runner claims only `chat`, so chat
keeps using the user's own Claude login and tools on their machine.

Each automation run's agent calls share one `RUN_BUDGET_USD` budget ($5 by default), enforced by
the API through `report` and by Claude Code itself through `--max-budget-usd`.

## Consequences

- Automation agent spend is billed per token to the API key, not the Claude subscription.
- Automation agents cannot use Gmail or Calendar connectors; they reach the user's data through
  the `lyfestyle` tools and the API's own integrations.
- Nothing in the cloud claims chat runs. A local `pnpm runner` with no `RUNNER_KINDS` still takes
  both kinds, so it can stand in for either.
- The cloud runner's Claude Code works in a throwaway container directory; its built-in tools
  stay limited to WebSearch and WebFetch.
