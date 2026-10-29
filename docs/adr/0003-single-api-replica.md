# 0003. The API runs as exactly one replica

- Status: accepted
- Date: 2026-10-26

## Context

The cron scheduler, long-poll wakeups for `/runs/claim`, and SSE fan-out for run streams all live in
process memory (`apps/api/src/lib/notifier.ts`, `apps/api/src/scheduler.ts`). This is a
single-user app; one small instance has ample headroom.

## Decision

The API service's Railway settings pin one replica ([deployment](../deployment.md)). Cross-request coordination stays in memory instead of
going through Postgres `LISTEN/NOTIFY` or Redis.

## Consequences

- Simple, fast, no extra infrastructure.
- A second replica would fire every due job twice and miss wakeups and stream events raised on the
  other instance. Scaling out requires moving the notifier and scheduler to a shared backend first.
- Deploys have a brief gap; runners and SSE clients reconnect and resume from the last event id.
