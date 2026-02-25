#!/bin/bash
set -o pipefail
# Automated NanoClaw update script
# Pulls latest from upstream, builds, and restarts if changes detected
# Uses Claude Code CLI to resolve merge conflicts and build errors

PROJECT_DIR="/home/forge/nanoclaw"
LOG_FILE="$PROJECT_DIR/logs/auto-update.log"
CLAUDE_BUDGET="0.50"
CLAUDE_TIMEOUT=300

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

error_exit() {
    log "ERROR: $1"
    exit 1
}

resolve_conflicts_with_claude() {
    log "Attempting to resolve merge conflicts..."

    # Phase 1: Mechanically resolve non-source files
    local mechanical_files=()
    local source_files=()

    while IFS= read -r file; do
        case "$file" in
            package-lock.json|*.lock|*.svg|*.snap)
                mechanical_files+=("$file")
                ;;
            *)
                source_files+=("$file")
                ;;
        esac
    done < <(git diff --name-only --diff-filter=U)

    for file in "${mechanical_files[@]}"; do
        log "  Mechanical resolve (accept theirs): $file"
        git checkout --theirs "$file" 2>&1 | tee -a "$LOG_FILE"
        git add "$file" 2>&1 | tee -a "$LOG_FILE"
    done

    # Regenerate lock file if package-lock.json was conflicted
    if printf '%s\n' "${mechanical_files[@]}" | grep -qx "package-lock.json"; then
        log "  Regenerating package-lock.json..."
        npm install --legacy-peer-deps 2>&1 | tee -a "$LOG_FILE" || true
        git add package-lock.json 2>&1 | tee -a "$LOG_FILE"
    fi

    # Phase 2: Use Claude for remaining source conflicts
    if [ ${#source_files[@]} -eq 0 ]; then
        log "All conflicts resolved mechanically."
        return 0
    fi

    local file_list
    file_list=$(printf '%s\n' "${source_files[@]}")
    log "  Source conflicts requiring Claude: $file_list"

    local prompt
    prompt="You are resolving git merge conflicts in a NanoClaw update.

The following files have merge conflicts:
$file_list

For each file:
1. Read the file and find all <<<<<<< / ======= / >>>>>>> conflict markers
2. Resolve each conflict by preserving local customizations while incorporating upstream changes. When in doubt, prefer upstream.
3. Write the resolved file (remove all conflict markers)
4. Stage it with: git add <file>

After resolving all files, run 'npm run build' to verify the result compiles.
Do NOT commit — just resolve, stage, and verify the build."

    log "  Invoking Claude to resolve source conflicts..."
    if timeout "$CLAUDE_TIMEOUT" claude -p "$prompt" \
        --dangerously-skip-permissions \
        --allowedTools "Read,Edit,Write,Bash(git:*),Bash(npm:*),Bash(npx:*)" \
        --max-budget-usd "$CLAUDE_BUDGET" \
        --no-session-persistence 2>&1 | tee -a "$LOG_FILE"; then
        log "  Claude conflict resolution succeeded."
        return 0
    else
        log "  Claude conflict resolution failed."
        return 1
    fi
}

fix_build_with_claude() {
    local build_errors="$1"
    log "Build failed after merge. Invoking Claude to fix..."

    local prompt
    prompt="The NanoClaw project just merged upstream changes but the build is failing.

Build errors:
$build_errors

Read the failing files, fix the TypeScript compilation errors, stage your changes with git add, and verify with 'npm run build'.
Do NOT commit — just fix and verify."

    if timeout "$CLAUDE_TIMEOUT" claude -p "$prompt" \
        --dangerously-skip-permissions \
        --allowedTools "Read,Edit,Write,Bash(git:*),Bash(npm:*),Bash(npx:*)" \
        --max-budget-usd "$CLAUDE_BUDGET" \
        --no-session-persistence 2>&1 | tee -a "$LOG_FILE"; then
        log "  Claude build fix succeeded."
        return 0
    else
        log "  Claude build fix failed."
        return 1
    fi
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

COMMIT_COUNT=$(git rev-list --count HEAD..upstream/main)
log "Updates available ($COMMIT_COUNT new commits)"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    log "Uncommitted changes detected, committing them first..."
    git add -A
    git commit -m "chore: auto-commit before upstream merge" 2>&1 | tee -a "$LOG_FILE"
fi

# Save pre-merge state for rollback
PRE_MERGE_HEAD=$(git rev-parse HEAD)

# Try to merge upstream changes
log "Merging upstream/main..."
if git merge upstream/main --no-edit 2>&1 | tee -a "$LOG_FILE"; then
    log "Merge completed without conflicts."
else
    # Check if it's a conflict (vs other merge failure)
    if git diff --name-only --diff-filter=U | grep -q .; then
        log "Merge conflicts detected."
        if resolve_conflicts_with_claude; then
            git commit --no-edit 2>&1 | tee -a "$LOG_FILE" || {
                log "Failed to complete merge commit after conflict resolution."
                git merge --abort 2>/dev/null
                git reset --hard "$PRE_MERGE_HEAD" 2>&1 | tee -a "$LOG_FILE"
                error_exit "Merge commit failed after conflict resolution"
            }
        else
            log "Conflict resolution failed. Rolling back..."
            git merge --abort 2>/dev/null
            git reset --hard "$PRE_MERGE_HEAD" 2>&1 | tee -a "$LOG_FILE"
            error_exit "Could not resolve merge conflicts"
        fi
    else
        log "Merge failed (not a conflict). Rolling back..."
        git merge --abort 2>/dev/null
        git reset --hard "$PRE_MERGE_HEAD" 2>&1 | tee -a "$LOG_FILE"
        error_exit "Merge failed"
    fi
fi

# Push merged changes to origin
log "Pushing to origin..."
git push origin main 2>&1 | tee -a "$LOG_FILE" || log "WARNING: git push failed (non-fatal)"

# Install dependencies
log "Installing dependencies..."
if ! npm install --legacy-peer-deps 2>&1 | tee -a "$LOG_FILE"; then
    error_exit "npm install failed"
fi

# Build the project
log "Building project..."
BUILD_OUTPUT=$(npm run build 2>&1)
BUILD_EXIT=$?
echo "$BUILD_OUTPUT" | tee -a "$LOG_FILE"

if [ $BUILD_EXIT -ne 0 ]; then
    log "Build failed. Attempting Claude-powered fix..."
    if fix_build_with_claude "$BUILD_OUTPUT"; then
        # Verify the fix actually works
        log "Verifying rebuild after Claude fix..."
        if npm run build 2>&1 | tee -a "$LOG_FILE"; then
            log "Build fixed by Claude. Committing fix..."
            git add -A
            git commit -m "fix: auto-resolve build errors after upstream merge" 2>&1 | tee -a "$LOG_FILE"
        else
            log "Build still failing after Claude fix. Rolling back entire merge..."
            git reset --hard "$PRE_MERGE_HEAD" 2>&1 | tee -a "$LOG_FILE"
            error_exit "Build failed even after Claude fix attempt"
        fi
    else
        log "Claude build fix failed. Rolling back entire merge..."
        git reset --hard "$PRE_MERGE_HEAD" 2>&1 | tee -a "$LOG_FILE"
        error_exit "Build failed and Claude could not fix it"
    fi
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

log "Update complete!"
log "  Previous: $PRE_MERGE_HEAD"
log "  Updated:  $(git rev-parse HEAD)"
