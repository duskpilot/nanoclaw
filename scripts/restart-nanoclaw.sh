#!/usr/bin/env bash
set -euo pipefail

# Fully restart NanoClaw: kill all agent containers, then restart the service.
# Can be run manually or triggered by the bot via a systemd path unit.

echo "[restart-nanoclaw] Killing all nanoclaw agent containers..."
containers=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' 2>/dev/null || true)
if [ -n "$containers" ]; then
  echo "$containers" | xargs -r docker kill 2>/dev/null || true
  echo "[restart-nanoclaw] Killed: $containers"
else
  echo "[restart-nanoclaw] No running containers found."
fi

echo "[restart-nanoclaw] Restarting nanoclaw service..."
systemctl --user restart nanoclaw

# Clean up trigger file (if triggered via path unit)
rm -f /home/forge/nanoclaw/data/restart-trigger

echo "[restart-nanoclaw] Done. Service restarted."
