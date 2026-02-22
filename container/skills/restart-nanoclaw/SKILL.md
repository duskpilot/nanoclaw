---
name: restart-nanoclaw
description: Trigger a full restart of NanoClaw — kills all running agent containers and restarts the service. Only available from the main group.
---

# Restart NanoClaw

Use the MCP tool `mcp__nanoclaw__restart_service` to fully restart NanoClaw.

This kills all running agent containers and restarts the service via systemd.

## Important

- **This will kill ALL running agent containers**, including your own session.
- Only works from the **main group**.
- Use only when the user explicitly requests a restart.
- Send your final message to the user **before** calling the tool — you won't be able to respond afterward.
