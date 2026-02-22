---
name: restart-nanoclaw
description: Trigger a full restart of NanoClaw — kills all running agent containers and restarts the service. Only available from the main group.
allowed-tools: Bash(touch:*)
---

# Restart NanoClaw

Triggers a full restart: kills all running agent containers, then restarts the NanoClaw service via systemd.

## Usage

```bash
touch /workspace/project/data/restart-trigger
```

This creates a trigger file that the host's systemd path unit watches for. The restart happens automatically within seconds.

## Important

- **This will kill ALL running agent containers**, including your own session. Your current response will be lost.
- Only works from the **main group** (requires `/workspace/project` mount).
- Use only when the user explicitly requests a restart.
- Tell the user the restart is happening before triggering it — you won't be able to respond afterward.
