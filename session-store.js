'use strict';

const session = require('express-session');
const Database = require('better-sqlite3');

// Persistent session store so logins survive restarts and memory stays bounded.
class SqliteStore extends session.Store {
  constructor(file) {
    super();
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires)');
    this.getStmt = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)');
    this.delStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = this.db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.prune();
    setInterval(() => this.prune(), 60 * 60 * 1000).unref();
  }

  prune() {
    try { this.pruneStmt.run(Date.now()); } catch { /* retry next interval */ }
  }

  expiry(sess) {
    const e = sess?.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + 8 * 60 * 60 * 1000;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try { this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess)); cb?.(null); } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }

  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }
}

module.exports = SqliteStore;
