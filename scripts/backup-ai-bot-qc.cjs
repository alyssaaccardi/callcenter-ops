#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');

process.umask(0o077);

const databasePath = process.env.AI_BOT_QC_DB_PATH || path.join(__dirname, '..', 'ai-bot-qc.db');
const backupDirectory = process.env.AI_BOT_QC_BACKUP_DIR || path.join(path.dirname(databasePath), 'backups', 'ai-bot-qc');
const retentionDays = Math.max(1, Number.parseInt(process.env.AI_BOT_QC_BACKUP_RETENTION_DAYS, 10) || 30);

async function main() {
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDirectory, 0o700);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `ai-bot-qc-${timestamp}.db`);
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  await fs.chmod(backupPath, 0o600);
  const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = snapshot.pragma('integrity_check');
  } finally {
    snapshot.close();
  }
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    await fs.unlink(backupPath);
    throw new Error(`Backup integrity check failed: ${JSON.stringify(integrity)}`);
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(backupDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^ai-bot-qc-\d{4}-\d{2}-\d{2}T.*\.db$/.test(entry.name)) continue;
    const entryPath = path.join(backupDirectory, entry.name);
    const stats = await fs.stat(entryPath);
    if (stats.mtimeMs < cutoff) await fs.unlink(entryPath);
  }

  console.log(`AIRI QA backup verified: ${backupPath}`);
}

main().catch(error => {
  console.error(`[ai-bot-qc-backup] ${error.message}`);
  process.exitCode = 1;
});