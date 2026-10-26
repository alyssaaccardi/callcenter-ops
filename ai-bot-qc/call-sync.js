// Indexes calls from the Answering AI Staff API into bot_calls (replaces the iDrive recording archive).
const { db, upsertCall } = require('./db');
const staff = require('./staff-api');
const { callRiskFlags, leadFlags, riskLevel } = require('./call-risk');

const BACKFILL_DAYS = Math.max(1, Number.parseInt(process.env.AI_BOT_QC_BACKFILL_DAYS, 10) || 7);
const DETAIL_BATCH = 40; // per run (every 2 minutes); call detail is limited to 30 requests a minute for keys with Transcripts or Recordings
const TIMEZONE = process.env.AI_BOT_QC_BUSINESS_TIMEZONE || 'America/New_York';

db.exec("CREATE TABLE IF NOT EXISTS bot_customer_names (customer TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, resolved_at TEXT NOT NULL DEFAULT (datetime('now')))");

const getState = key => db.prepare('SELECT value FROM bot_sync_state WHERE key = ?').get(key)?.value || null;
const setState = (key, value) => db.prepare('INSERT OR REPLACE INTO bot_sync_state (key, value) VALUES (?, ?)').run(key, value);

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function localDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Every ended call gets its detail (legs, classification, billing override) and lead checked, newest first.
function needsDetail() {
  return true;
}

function toRecord(row, checkedAt) {
  const startedMs = Date.parse(row.started_at);
  const endedMs = Date.parse(row.ended_at);
  return {
    id: row.id,
    bucket: 'staff-api',
    object_key: `staff-api:${row.id}`,
    customer: row.account_id,
    caller_phone: normalizePhone(row.caller_number),
    caller_phone_checked_at: checkedAt,
    destination_phone: normalizePhone(row.dialed_number),
    destination_phone_checked_at: checkedAt,
    call_date: localDay(startedMs),
    room_name: '',
    room_id: '',
    egress_id: '',
    started_at_ns: startedMs * 1e6,
    ended_at_ns: Number.isFinite(endedMs) ? endedMs * 1e6 : null,
    recording_keys: JSON.stringify(['recording']),
    metadata_key: `staff-api:${row.id}`,
    metadata_last_modified: row.updated_at || null,
  };
}

const markSource = db.prepare(`UPDATE bot_calls SET source = 'staff_api', risk_pending = ?, risk_flags = ?, risk_level = ?,
  risk_checked_at = ? WHERE id = ?`);

const indexRows = db.transaction((rows, checkedAt) => {
  let indexed = 0;
  for (const row of rows) {
    // In-progress calls are picked up on a later run, when updated_at moves.
    if (row.kind !== 'inbound' || row.internal_only || !row.ended_at || !Number.isFinite(Date.parse(row.started_at))) continue;
    const existing = db.prepare('SELECT metadata_last_modified FROM bot_calls WHERE id = ?').get(row.id);
    if (existing && existing.metadata_last_modified === (row.updated_at || null)) continue;
    upsertCall(toRecord(row, checkedAt));
    const flags = callRiskFlags(row);
    markSource.run(needsDetail(row) ? 1 : 0, JSON.stringify(flags), riskLevel(flags), checkedAt, row.id);
    indexed += 1;
  }
  return indexed;
});

async function refreshAccountNames(customers) {
  const known = new Set(db.prepare("SELECT customer FROM bot_customer_names WHERE source = 'staff_api'").all().map(r => r.customer));
  if (customers.every(customer => known.has(customer))) return;
  const insert = db.prepare("INSERT OR REPLACE INTO bot_customer_names (customer, name, source) VALUES (?, ?, 'staff_api')");
  for (const account of await staff.listAccountSummaries()) if (account.name) insert.run(account.id, account.name);
}

let leadsUnavailable = false;

// Detail- and lead-based flags for one call. `recheck` keeps a still-pending lead delivery in the queue.
async function evaluateCall(id) {
  const call = await staff.getCall(id);
  const flags = callRiskFlags(call);
  let recheck = false;
  if (!leadsUnavailable) {
    try {
      const lead = leadFlags(call, await staff.getLead(id));
      flags.push(...lead.flags);
      recheck = lead.recheck;
    } catch (error) {
      if (error.response?.status !== 403) throw error;
      leadsUnavailable = true;
      console.error('[ai-bot-qc] Staff API key has no Leads scope; lead delivery flags are disabled');
    }
  }
  return { flags, recheck };
}

async function enrichPending() {
  const pending = db.prepare(`SELECT id FROM bot_calls WHERE source = 'staff_api' AND risk_pending = 1
    ORDER BY started_at_ns DESC LIMIT ?`).all(DETAIL_BATCH);
  const save = db.prepare(`UPDATE bot_calls SET risk_flags = ?, risk_level = ?, risk_checked_at = ?, risk_pending = ? WHERE id = ?`);
  for (const { id } of pending) {
    try {
      const { flags, recheck } = await evaluateCall(id);
      save.run(JSON.stringify(flags), riskLevel(flags), new Date().toISOString(), recheck ? 1 : 0, id);
    } catch (error) {
      if (error.response?.status === 404) save.run('[]', 0, new Date().toISOString(), 0, id);
      else console.error('[ai-bot-qc] call detail failed:', id, error.response?.status || error.message);
    }
  }
  return pending.length;
}

let running = null;

async function run() {
  const startedAt = new Date();
  // Bump when the flag rules change so already-indexed calls are re-evaluated by a fresh backfill.
  if (getState('risk_rules_version') !== '4') {
    db.prepare("DELETE FROM bot_sync_state WHERE key = 'calls_synced_at'").run();
    db.prepare("UPDATE bot_calls SET metadata_last_modified = NULL WHERE source = 'staff_api'").run();
    setState('risk_rules_version', '4');
  }
  const last = getState('calls_synced_at');
  const params = last
    ? { updated_since: new Date(Date.parse(last) - 60_000).toISOString() }
    : { from: localDay(Date.now() - BACKFILL_DAYS * 86_400_000), to: localDay(Date.now() + 86_400_000) };
  const { calls, complete } = await staff.listCalls(params, { maxPages: last ? 25 : 100 });
  const indexed = indexRows(calls, startedAt.toISOString());
  if (complete) setState('calls_synced_at', startedAt.toISOString());
  await refreshAccountNames([...new Set(calls.map(call => call.account_id))]).catch(error =>
    console.error('[ai-bot-qc] account name refresh failed:', error.message));
  const enriched = await enrichPending();
  return { indexed, object_count: calls.length, enriched, complete };
}

// Concurrent callers share one run so a burst of page loads cannot exhaust the API rate limit.
function syncCalls() {
  if (!running) running = run().finally(() => { running = null; });
  return running;
}

// Refreshes one call's risk flags (used when a reviewer opens it).
async function refreshCallRisk(id) {
  const { flags, recheck } = await evaluateCall(id);
  db.prepare('UPDATE bot_calls SET risk_flags = ?, risk_level = ?, risk_checked_at = ?, risk_pending = ? WHERE id = ?')
    .run(JSON.stringify(flags), riskLevel(flags), new Date().toISOString(), recheck ? 1 : 0, id);
  return flags;
}

module.exports = { syncCalls, refreshCallRisk, toRecord, needsDetail };
