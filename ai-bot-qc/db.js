const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.AI_BOT_QC_DB_PATH || path.join(__dirname, '..', 'ai-bot-qc.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS bot_calls (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  customer TEXT NOT NULL,
  caller_phone TEXT,
  caller_phone_checked_at TEXT,
  destination_phone TEXT,
  destination_phone_checked_at TEXT,
  call_date TEXT NOT NULL,
  room_name TEXT,
  room_id TEXT,
  egress_id TEXT,
  started_at_ns INTEGER,
  ended_at_ns INTEGER,
  recording_keys TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  metadata_last_modified TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_reviews (
  call_id TEXT PRIMARY KEY REFERENCES bot_calls(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed','in_review','reviewed')),
  outcome TEXT CHECK (outcome IN ('ok','needs_follow_up') OR outcome IS NULL),
  caller_happiness INTEGER CHECK (caller_happiness BETWEEN 1 AND 5 OR caller_happiness IS NULL),
  feedback TEXT NOT NULL DEFAULT '',
  call_tags TEXT NOT NULL DEFAULT '[]',
  critical INTEGER NOT NULL DEFAULT 0,
  critical_flagged_at TEXT,
  critical_note TEXT NOT NULL DEFAULT '',
  reviewer_email TEXT,
  reviewer_name TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  last_saved_at TEXT,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES bot_calls(id) ON DELETE CASCADE,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_qc_bulletin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL DEFAULT '',
  notice_type TEXT NOT NULL DEFAULT 'watch',
  expires_on TEXT,
  updated_by_email TEXT,
  updated_by_name TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bot_qc_bulletin_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  notice_type TEXT NOT NULL DEFAULT 'watch',
  expires_on TEXT,
  updated_by_email TEXT NOT NULL,
  updated_by_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_qc_bulletin_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  notice_type TEXT NOT NULL CHECK (notice_type IN ('bug','watch','test')),
  expires_on TEXT,
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_email TEXT,
  deleted_by_name TEXT
);

CREATE TABLE IF NOT EXISTS bot_qc_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_type TEXT NOT NULL CHECK (change_type IN ('prompt','knowledge','call_flow','model_voice','other')),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_forwarding_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  last_call_id TEXT NOT NULL REFERENCES bot_calls(id),
  checked_by_email TEXT NOT NULL,
  checked_by_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(customer, last_call_id)
);

CREATE TABLE IF NOT EXISTS bot_qc_excluded_phone_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL UNIQUE,
  display_phone TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_calls_date ON bot_calls(started_at_ns DESC, customer);
CREATE INDEX IF NOT EXISTS idx_bot_reviews_status ON bot_reviews(status, critical, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_reviews_reviewer ON bot_reviews(reviewer_email, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_review_events_call ON bot_review_events(call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_qc_bulletin_history_updated ON bot_qc_bulletin_history(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_qc_bulletin_posts_active ON bot_qc_bulletin_posts(deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_qc_changes_created ON bot_qc_changes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_forwarding_checks_customer ON bot_forwarding_checks(customer, checked_at DESC);
`);

db.prepare('INSERT OR IGNORE INTO bot_qc_bulletin (id, body) VALUES (1, ?)').run('');

const legacyBulletin = db.prepare(`SELECT body, notice_type, expires_on, updated_by_email, updated_by_name, updated_at
  FROM bot_qc_bulletin WHERE id = 1`).get();
if (legacyBulletin?.body?.trim() && db.prepare('SELECT COUNT(*) AS count FROM bot_qc_bulletin_posts').get().count === 0) {
  db.prepare(`INSERT INTO bot_qc_bulletin_posts
    (body, notice_type, expires_on, created_by_email, created_by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(legacyBulletin.body, legacyBulletin.notice_type || 'watch', legacyBulletin.expires_on || null,
      legacyBulletin.updated_by_email || 'system@qc', legacyBulletin.updated_by_name || 'AIRI QA admin',
      legacyBulletin.updated_at || new Date().toISOString());
}

try { db.exec('ALTER TABLE bot_calls ADD COLUMN metadata_last_modified TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_reviews ADD COLUMN critical_flagged_at TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE bot_reviews ADD COLUMN call_tags TEXT NOT NULL DEFAULT '[]'"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_reviews ADD COLUMN caller_happiness INTEGER'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE bot_qc_bulletin ADD COLUMN notice_type TEXT NOT NULL DEFAULT 'watch'"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_qc_bulletin ADD COLUMN expires_on TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE bot_qc_bulletin_history ADD COLUMN notice_type TEXT NOT NULL DEFAULT 'watch'"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_qc_bulletin_history ADD COLUMN expires_on TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE bot_forwarding_checks ADD COLUMN notes TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_forwarding_checks ADD COLUMN result TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_calls ADD COLUMN caller_phone TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_calls ADD COLUMN caller_phone_checked_at TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_calls ADD COLUMN destination_phone TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE bot_calls ADD COLUMN destination_phone_checked_at TEXT'); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}
try { db.exec("ALTER TABLE bot_qc_excluded_phone_numbers ADD COLUMN label TEXT NOT NULL DEFAULT ''"); } catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

const insertCall = db.prepare(`
  INSERT INTO bot_calls (
    id, bucket, object_key, customer, caller_phone, caller_phone_checked_at, destination_phone, destination_phone_checked_at, call_date, room_name, room_id, egress_id,
    started_at_ns, ended_at_ns, recording_keys, metadata_key, metadata_last_modified
  ) VALUES (
    @id, @bucket, @object_key, @customer, @caller_phone, @caller_phone_checked_at, @destination_phone, @destination_phone_checked_at, @call_date, @room_name, @room_id, @egress_id,
    @started_at_ns, @ended_at_ns, @recording_keys, @metadata_key, @metadata_last_modified
  )
  ON CONFLICT(object_key) DO UPDATE SET
    bucket = excluded.bucket,
    customer = excluded.customer,
    caller_phone = COALESCE(excluded.caller_phone, bot_calls.caller_phone),
    caller_phone_checked_at = excluded.caller_phone_checked_at,
    destination_phone = excluded.destination_phone,
    destination_phone_checked_at = excluded.destination_phone_checked_at,
    call_date = excluded.call_date,
    room_name = excluded.room_name,
    room_id = excluded.room_id,
    egress_id = excluded.egress_id,
    started_at_ns = excluded.started_at_ns,
    ended_at_ns = excluded.ended_at_ns,
    recording_keys = excluded.recording_keys,
    metadata_last_modified = excluded.metadata_last_modified,
    last_seen_at = datetime('now')
`);

const ensureReview = db.prepare('INSERT OR IGNORE INTO bot_reviews (call_id) VALUES (?)');

const upsertCall = db.transaction(call => {
  insertCall.run(call);
  ensureReview.run(call.id);
});

function addEvent(callId, actor, eventType, details = {}) {
  db.prepare(`INSERT INTO bot_review_events (call_id, actor_email, actor_name, event_type, details)
    VALUES (?, ?, ?, ?, ?)`)
    .run(callId, actor.email, actor.name || actor.email, eventType, JSON.stringify(details));
}

const releaseOnRestart = db.transaction(() => {
  const active = db.prepare(`SELECT call_id, reviewer_email, reviewer_name FROM bot_reviews
    WHERE status = 'in_review'`).all();
  const now = new Date().toISOString();
  db.prepare(`UPDATE bot_reviews SET status = 'unreviewed', claim_expires_at = NULL, updated_at = ?
    WHERE status = 'in_review'`).run(now);
  for (const call of active) {
    addEvent(call.call_id, { email: 'system@qc', name: 'QC system' }, 'released_on_restart', {
      previous_reviewer: call.reviewer_name || call.reviewer_email,
      draft_preserved: true,
    });
  }
  return active.length;
});

const releasedOnRestart = releaseOnRestart();
if (releasedOnRestart) console.log(`[ai-bot-qc] released ${releasedOnRestart} stale review claim(s) after restart`);

module.exports = { db, upsertCall, addEvent };