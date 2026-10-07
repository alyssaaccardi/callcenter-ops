#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ccops}"
NODE_BIN="$(command -v node)"
BACKUP_SCRIPT="$APP_DIR/scripts/backup-ai-bot-qc.cjs"
BACKUP_DIR="$APP_DIR/backups/ai-bot-qc"
LOG_FILE="/var/log/ai-bot-qc-backup.log"
CRON_LINE="0 3 * * * AI_BOT_QC_BACKUP_DIR=$BACKUP_DIR $NODE_BIN $BACKUP_SCRIPT >> $LOG_FILE 2>&1"

if [[ ! -f "$BACKUP_SCRIPT" ]]; then
  printf 'Missing backup script: %s\n' "$BACKUP_SCRIPT" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$APP_DIR/backups" "$BACKUP_DIR"
{
  (crontab -l 2>/dev/null || true) | grep -Fv "$BACKUP_SCRIPT" || true
  printf '%s\n' "$CRON_LINE"
} | crontab -

printf 'Installed daily AIRI QA backup at 03:00. Snapshots: %s\n' "$BACKUP_DIR"