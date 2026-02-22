#!/bin/bash
# Automated NanoClaw update script
# Pulls latest from upstream, builds, and restarts if changes detected

PROJECT_DIR="/workspace/project"
LOG_FILE="$PROJECT_DIR/logs/auto-update.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

error_exit() {
    log "ERROR: $1"
    exit 1
}

log "Starting automated update check..."

cd "$PROJECT_DIR" || error_exit "Failed to cd to $PROJECT_DIR"

# Fetch latest from upstream
log "Fetching from upstream..."
git fetch upstream main 2>&1 | tee -a "$LOG_FILE" || error_exit "Git fetch failed"

# Check if there are new commits
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse upstream/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    log "Already up to date. No action needed."
    exit 0
fi

log "Updates available ($(git rev-list --count HEAD..upstream/main) new commits)"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    log "Uncommitted changes detected, committing them first..."
    git add -A
    git commit -m "chore: auto-commit before upstream merge" 2>&1 | tee -a "$LOG_FILE"
fi

# Try to merge upstream changes
log "Merging upstream/main..."
if ! git merge upstream/main --no-edit 2>&1 | tee -a "$LOG_FILE"; then
    log "Merge conflict detected. Aborting merge..."
    git merge --abort 2>&1 | tee -a "$LOG_FILE"
    error_exit "Merge conflicts require manual resolution. Please run: git merge upstream/main"
fi

log "Merge successful!"

# Install dependencies (using legacy-peer-deps to handle zod version flexibility)
log "Installing dependencies..."
if ! npm install --legacy-peer-deps 2>&1 | tee -a "$LOG_FILE"; then
    error_exit "npm install failed"
fi

# Build the project
log "Building project..."
if ! npm run build 2>&1 | tee -a "$LOG_FILE"; then
    error_exit "Build failed"
fi

# Rebuild container
log "Rebuilding container..."
if ! (cd container && ./build.sh 2>&1 | tee -a "$LOG_FILE"); then
    error_exit "Container build failed"
fi

# Restart the service
log "Restarting NanoClaw service..."
if ! systemctl --user restart nanoclaw 2>&1 | tee -a "$LOG_FILE"; then
    error_exit "Service restart failed"
fi

log "✓ NanoClaw updated and restarted successfully!"
log "  Local:  $LOCAL"
log "  Remote: $REMOTE"
