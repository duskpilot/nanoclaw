#!/bin/bash
# Trigger update from inside container via IPC
# This creates an IPC task that the host system will pick up and execute

TASKS_DIR="/workspace/ipc/tasks"
TIMESTAMP=$(date +%s)
TASK_FILE="$TASKS_DIR/trigger_update_${TIMESTAMP}.json"

mkdir -p "$TASKS_DIR"

cat > "$TASK_FILE" << EOF
{
  "type": "run_update",
  "timestamp": "$(date -Iseconds)",
  "requested_by": "agent"
}
EOF

echo "Update request sent via IPC. The host system will process it shortly."
echo "Task file: $TASK_FILE"
