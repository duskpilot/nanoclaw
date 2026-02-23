---
name: update-nanoclaw
description: Trigger an automated update of NanoClaw from upstream. Only available from the main group. The update runs on the host — do NOT try to run scripts/auto-update.sh directly.
---

# Update NanoClaw

Trigger an automated update by writing an IPC task file. The host system will pick it up and run the update.

## How to trigger

```bash
TASKS_DIR="/workspace/ipc/tasks"
TASK_FILE="$TASKS_DIR/trigger_update_$(date +%s).json"
cat > "$TASK_FILE" << EOF
{
  "type": "run_update",
  "timestamp": "$(date -Iseconds)",
  "requested_by": "agent"
}
EOF
```

## Important

- **Never run `scripts/auto-update.sh` directly** — it uses host paths that don't exist inside the container.
- Only works from the **main group**.
- The update runs asynchronously on the host. It will fetch upstream, merge, rebuild, and restart the service.
- After triggering, tell the user the update has been requested and NanoClaw will restart when it's done.
- The restart will kill your session, so send your message **before** the IPC task is processed.
