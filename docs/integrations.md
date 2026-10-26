# Integrations

- **Gmail and Google Calendar:** come from the claude.ai connectors of the account Claude Code is
  logged in with on the runner's machine, not from the API. Connect them at claude.ai under
  _Settings → Connectors_. The runner allows Gmail read-only and Calendar read/write
  (`DEFAULT_CONNECTOR_TOOLS` in `apps/runner/src/claude-code.ts`); `AGENT_CONNECTOR_TOOLS` replaces
  that list, and `none` keeps every claude.ai connector out. They need the `claude-code` harness.
- **Canvas:** generate an access token under _Account → Settings_ in Canvas, then
  `PUT /integrations/canvas` with `{ baseUrl, token }`. The token is checked before it is stored.
- **Email (Resend):** set `RESEND_API_KEY` and `RESEND_FROM`, a sender on a domain verified in
  Resend.
- **Todos:** built in. The planner (day and week todos, monthly goals, unfinished items carried
  forward) is exposed to the agent as `todos_*` and `goals_*` tools. To use an existing todo MCP
  server instead, register it under `/mcp-servers`.

Integration tools appear on `/mcp` and `/tools` only once the integration is connected. OAuth
tokens and Canvas tokens are stored encrypted with `ENCRYPTION_KEY`. Routes are in
[api.md](api.md#integrations).
