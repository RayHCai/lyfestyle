# Lyfestyle

A personal knowledge and productivity hub where markdown pages, a planner and a Claude agent (chat, scheduled automations, Gmail/Calendar/Canvas/email tools) live behind one API and a Tauri desktop app.

```mermaid
flowchart LR
    subgraph machine["Your machine"]
        desktop["apps/desktop<br/>Tauri + React"]
        bridge["apps/runner/bin<br/>lyfestyle-agent.mjs"]
        runner["apps/runner<br/>agent worker"]
        claude["Claude Code<br/>Agent SDK"]
    end

    subgraph railway["Railway"]
        api["apps/api<br/>Hono + Prisma"]
        db[("Postgres")]
    end

    ext["Canvas · Resend<br/>registered MCP servers"]
    connectors["claude.ai connectors<br/>Gmail · Calendar"]

    subgraph pkgs["packages"]
        client["client<br/>typed API client, offline sync"]
        shared["shared<br/>run events, page links, dates"]
    end

    desktop -- "HTTP + SSE" --> api
    desktop -. "LYFESTYLE_AGENT_COMMAND<br/>stream-json" .-> bridge
    bridge -- "conversation messages" --> api
    runner -- "long-poll /runs/claim<br/>post run events" --> api
    runner -- "runs a harness" --> claude
    claude -- "MCP tools at /mcp" --> api
    claude --> connectors
    api --> db
    api --> ext

    runner -.-> client
    client -.-> shared
    api -.-> shared
```
