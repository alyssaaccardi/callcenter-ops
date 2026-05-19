/**
 * Mitel CCM Queue Poller
 *
 * Runs on an always-on office PC with direct access to the Mitel SQL server.
 * Queries CCMStatisticalData every 5 seconds and pushes today's queue totals
 * to JSONBin so the ops dashboard can display them without any port forwarding
 * or relay infrastructure.
 *
 * How to run:
 *   node scripts/mitel-queue-poller.js
 *
 * For unattended startup on Windows (Task Scheduler):
 *   Program:   node
 *   Arguments: C:\path\to\scripts\mitel-queue-poller.js
 *   Start in:  C:\path\to\  (the folder that contains .env)
 *
 * Required .env variables (same file as the rest of the project):
 *   MSSQL_SERVER              — SQL server IP (e.g. 192.168.1.242)
 *   MSSQL_USER                — SQL login
 *   MSSQL_PASS                — SQL password
 *   JSONBIN_API_KEY           — JSONBin master key ($2a$10$...)
 *   JSONBIN_MITEL_QUEUES_BIN_ID — bin ID to write to (auto-created on first run if blank)
 */

require('dotenv').config();
const sql   = require('mssql');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const POLL_MS      = 5000;
const QUEUE_MAP    = { P862: '8262', P861: '8261', P803: '8203' };
const JSONBIN_KEY  = process.env.JSONBIN_API_KEY;
let   BIN_ID       = process.env.JSONBIN_MITEL_QUEUES_BIN_ID || '';

if (!JSONBIN_KEY) {
  console.error('[fatal] JSONBIN_API_KEY not set in .env');
  process.exit(1);
}
if (!process.env.MSSQL_USER) {
  console.error('[fatal] MSSQL_USER not set in .env');
  process.exit(1);
}

// ── SQL pool ──────────────────────────────────────────────────────────────────
let pool = null;
async function getPool() {
  if (pool?.connected) return pool;
  pool = await sql.connect({
    user:     process.env.MSSQL_USER,
    password: process.env.MSSQL_PASS,
    server:   process.env.MSSQL_SERVER || '192.168.1.242',
    database: 'CCMStatisticalData',
    options:  { trustServerCertificate: true, encrypt: false },
    pool:     { max: 3, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 8000,
    requestTimeout:    10000,
  });
  return pool;
}

// ── JSONBin helpers ───────────────────────────────────────────────────────────
function jsonbinRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.jsonbin.io',
      path:     urlPath,
      method,
      headers: {
        'Content-Type':  'application/json',
        'X-Master-Key':  JSONBIN_KEY,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createBin(data) {
  const r = await jsonbinRequest('POST', '/v3/b', data, {
    'X-Bin-Name':    'mitel-queue-stats',
    'X-Bin-Private': 'false',
  });
  if (r.status !== 200) throw new Error(`JSONBin create failed: ${r.status}`);
  return r.body.metadata?.id;
}

async function putBin(binId, data) {
  const r = await jsonbinRequest('PUT', `/v3/b/${binId}`, data);
  if (r.status !== 200) throw new Error(`JSONBin PUT failed: ${r.status}`);
}

// ── Query ─────────────────────────────────────────────────────────────────────
async function fetchQueueStats() {
  const p = await getPool();
  const result = await p.request().query(`
    SELECT
      Queue,
      SUM(CASE WHEN TimeToAnswer IS NOT NULL THEN 1 ELSE 0 END) AS answered,
      SUM(CASE WHEN TimeToAnswer IS NULL     THEN 1 ELSE 0 END) AS abandoned,
      AVG(CASE WHEN TimeToAnswer > 0 THEN CAST(TimeToAnswer AS float) END) AS avgWait,
      AVG(CASE WHEN Duration     > 0 THEN CAST(Duration     AS float) END) AS avgDuration
    FROM [dbo].[tblData_LC_Trace]
    WHERE Queue IN ('P862','P861','P803')
      AND PegCount = 1
      AND CallStartTime >= CAST(GETDATE() AS DATE)
    GROUP BY Queue
  `);
  const queues = ['P862', 'P861', 'P803'].map(id => {
    const row = result.recordset.find(r => r.Queue === id);
    return {
      id,
      name:        QUEUE_MAP[id],
      answered:    row?.answered    ?? 0,
      abandoned:   row?.abandoned   ?? 0,
      avgWait:     row?.avgWait     != null ? Math.round(row.avgWait)     : null,
      avgDuration: row?.avgDuration != null ? Math.round(row.avgDuration) : null,
    };
  });
  return { queues, updatedAt: new Date().toISOString() };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function ts() { return new Date().toLocaleTimeString(); }

async function tick() {
  try {
    const data = await fetchQueueStats();

    if (!BIN_ID) {
      BIN_ID = await createBin(data);
      console.log(`[${ts()}] Created JSONBin: ${BIN_ID}`);
      console.log(`          → Add to .env:  JSONBIN_MITEL_QUEUES_BIN_ID=${BIN_ID}`);
      console.log(`          → Add to prod server .env too, then restart pm2`);
    } else {
      await putBin(BIN_ID, data);
    }

    const totals = data.queues.map(q => `${q.name}:${q.answered}ans/${q.abandoned}abn`).join('  ');
    console.log(`[${ts()}] ✓ ${totals}`);
  } catch (err) {
    pool = null; // force reconnect on SQL errors
    console.error(`[${ts()}] ✗ ${err.message}`);
  }
}

(async () => {
  console.log('Mitel queue poller starting...');
  console.log(`  SQL: ${process.env.MSSQL_SERVER} / CCMStatisticalData`);
  console.log(`  Bin: ${BIN_ID || '(will auto-create on first successful query)'}`);
  console.log(`  Poll: every ${POLL_MS / 1000}s\n`);

  await tick();
  setInterval(tick, POLL_MS);
})();
