# 0006. Run automations as user-approved code on the API

- Status: accepted
- Date: 2026-10-27

## Context

Automations used to be a cron schedule plus a prompt: each slot queued an agent run, so nothing
happened unless the runner was up on the user's laptop, and every run spent Claude usage even when
the work was mechanical (send a digest, check a list, ping a reminder). Different automations also
did the same things (email the user, tell them something) in different ways, because each prompt
asked the agent to improvise it.

## Decision

An automation is an ES module the API runs itself, on its cron schedule, in a `worker_threads`
worker (`apps/api/src/automations/`). The agent writes the code in a chat and proposes it with the
`automations_deploy` tool. That creates a pending deploy, and nothing runs until the user approves
it in the desktop app. Every change to code, schedule or name is a new deploy and needs a new
approval. Only pause, resume, run-now and delete do not.

The code reaches the rest of the system through one `ctx` object, so every automation sends email,
desktop notifications and the like the same way. The helpers are `ctx.email`, `ctx.notify`,
`ctx.tool` (any agent tool), `ctx.state` and `ctx.log`, plus `ctx.agent`, which queues a normal run
for the runner and waits for it. Each agent run is capped at `RUN_BUDGET_USD` ($5), and all the agent
runs one automation run starts share that cap. The runner passes it to Claude Code, and the API
cancels a run whose reported usage goes past it.

Existing jobs were migrated to automations whose code hands their prompt to `ctx.agent`.

## Consequences

- Automations run while the laptop is closed. Only the parts that need the agent wait for a
  runner.
- The worker is not a security boundary. Approved code runs with the API's privileges: its
  environment, its database connection, the network. That is acceptable only because this is a
  single-user app and the user reads and approves each version. Approval is a bearer-token route
  like any other, so anything holding `API_TOKEN` could approve. The agent's harness has no tool
  that sends arbitrary authenticated requests, and that must stay true.
- Executions are tracked in memory, which ties automations to the single API replica
  ([ADR 0003](0003-single-api-replica.md)). An execution cut off by a restart is marked failed when
  the API next starts.
- Revisit this if the app gains other users, or if automation code needs npm packages. Either would
  mean a real sandbox (a separate process or container with its own credentials) instead of a
  worker thread.
