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
  --exclude='status-store.json'
  --exclude='scriptor-store.json'
  --exclude='xcally-buffer.json'
  --exclude='slack-workflows.json'
  --exclude='tv-sessions.json'
  --exclude='overage-alerter-calibration.json'
  --exclude='overage-outreach-config.json'
  --exclude='overage-outreach-log.json'
  --exclude='ai-bot-qc.db'
  --exclude='ai-bot-qc.db-wal'
  --exclude='ai-bot-qc.db-shm'
  --exclude='qa-platform.db'
  --exclude='qa-platform.db-wal'
  --exclude='qa-platform.db-shm'
  --exclude='backups/'
)

# 1. Build frontend
echo "→ Building frontend..."
npm run build --prefix client

# 1a. Rebuild the admin-downloadable training guide from its Markdown sources
echo "→ Building AIRI QA training guide..."
node scripts/build-airi-qa-handbook.cjs

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

# 4. Install updated production dependencies
echo "→ Installing production dependencies..."
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev"

# 5. Verify native SQLite loads before restarting the live process
echo "→ Verifying production SQLite..."
ssh "$REMOTE" "cd $REMOTE_DIR && node -e \"const Database=require('better-sqlite3'); const db=new Database('ai-bot-qc.db',{readonly:true}); const result=db.pragma('integrity_check'); const reviews=db.prepare('SELECT COUNT(*) AS total FROM bot_reviews').get().total; db.close(); if(result.length!==1||result[0].integrity_check!=='ok') process.exit(1); console.log('AIRI QA SQLite ready; '+reviews+' reviews; integrity ok')\""

# 6. Restart server
echo "→ Restarting server..."
ssh "$REMOTE" "cd $REMOTE_DIR && pm2 restart ccops --update-env"

echo "✓ Deploy complete"
