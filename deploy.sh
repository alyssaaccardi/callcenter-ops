#!/usr/bin/env bash
# deploy.sh — safe deploy for callcenter-ops
# Syncs frontend build + server code to prod, NEVER overwrites data files.

set -e

REMOTE="root@165.22.11.251"
REMOTE_DIR="/opt/ccops"

# Data files that live on the server and must never be overwritten by a deploy
DATA_EXCLUDES=(
  --exclude='users.json'
  --exclude='activity-log.json'
  --exclude='slack-workflows.json'
  --exclude='tv-sessions.json'
)

# 1. Build frontend
echo "→ Building frontend..."
npm run build --prefix client

# 2. Sync frontend build (already correct — scoped to public/app/)
echo "→ Syncing frontend..."
rsync -az --delete \
  /Users/alyssaaccardi/callcenter-ops/public/app/ \
  "$REMOTE:$REMOTE_DIR/public/app/"

# 3. Sync server code (excludes data files so prod state is preserved)
echo "→ Syncing server code..."
rsync -az \
  "${DATA_EXCLUDES[@]}" \
  --exclude='node_modules/' \
  --exclude='client/' \
  --exclude='public/app/' \
  --exclude='.env' \
  --exclude='.git/' \
  /Users/alyssaaccardi/callcenter-ops/ \
  "$REMOTE:$REMOTE_DIR/"

# 4. Restart server
echo "→ Restarting server..."
ssh "$REMOTE" "cd $REMOTE_DIR && pm2 restart ccops --update-env"

echo "✓ Deploy complete"
