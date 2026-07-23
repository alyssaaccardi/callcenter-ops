/**
 * Mitel CCM Queue Poller
 *
 * Run on any machine with access to the Mitel SQL server.
 * Queries CCM queue stats every 5 seconds and pushes to the ops server.
 *
 *   node scripts/mitel-queue-poller.js
 *
 * Required .env variables:
 *   MSSQL_SERVER        — hostname or IP (e.g. MICCSQL01 or 192.168.1.242)
 *   MSSQL_INSTANCE      — named instance, if any (e.g. MSSQLSERVER) — optional
 *   MSSQL_USER          — SQL login
 *   MSSQL_PASS          — SQL password
 *   MSSQL_DB            — database name (e.g. CCMData or CCMStatisticalData)
 *   MITEL_POLLER_SECRET — shared secret matching the ops server
 *   CCOPS_BASE_URL      — ops server base URL (e.g. https://ops.answeringlegal.com)
 */

require('dotenv').config();
const sql   = require('mssql');
const https = require('https');
const http  = require('http');

const POLL_MS   = 5000;
const QUEUE_MAP = { P862: '8262', P861: '8261', P803: '8203' };

const REQUIRED = ['MSSQL_SERVER', 'MSSQL_USER', 'MSSQL_PASS', 'MSSQL_DB', 'MITEL_POLLER_SECRET', 'CCOPS_BASE_URL'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`[fatal] ${k} not set in .env`); process.exit(1); }
}

// ── SQL pool ──────────────────────────────────────────────────────────────────
let pool = null;
async function getPool() {
  if (pool?.connected) return pool;
  const config = {
    user:     process.env.MSSQL_USER,
    password: process.env.MSSQL_PASS,
    server:   process.env.MSSQL_SERVER,
    database: process.env.MSSQL_DB,
    options:  { trustServerCertificate: true, encrypt: false },
    pool:     { max: 3, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 8000,
    requestTimeout:    10000,
  };
  if (process.env.MSSQL_INSTANCE) config.options.instanceName = process.env.MSSQL_INSTANCE;
  pool = await sql.connect(config);
  return pool;
}

// ── Push to ops server ────────────────────────────────────────────────────────
function pushToServer(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const base    = process.env.CCOPS_BASE_URL.replace(/\/$/, '');
    const url     = new URL(base + '/api/mitel/queue-stats');
    const lib     = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(payload),
        'x-poller-secret': process.env.MITEL_POLLER_SECRET,
      },
    }, res => {
      res.resume();
      if (res.statusCode === 200) resolve();
      else reject(new Error(`Server responded ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Query ─────────────────────────────────────────────────────────────────────
async function fetchQueueStats() {
  const p = await getPool();

  const [todayResult, recentResult, hourlyResult, last24hResult] = await Promise.all([
    // Today's running totals
    p.request().query(`
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
    `),
    // Rolling 15-min wait
    p.request().query(`
      SELECT
        Queue,
        COUNT(*) AS recentAnswered,
        AVG(CAST(TimeToAnswer AS float)) AS recentAvgWait,
        MAX(TimeToAnswer)                AS recentMaxWait
      FROM [dbo].[tblData_LC_Trace]
      WHERE Queue IN ('P862','P861','P803')
        AND PegCount = 1
        AND TimeToAnswer IS NOT NULL
        AND CallStartTime >= DATEADD(MINUTE, -15, GETDATE())
      GROUP BY Queue
    `),
    // All hours today — we'll pick the correct clock-based 3 hours in JS
    p.request().query(`
      SELECT
        DATEPART(HOUR, CallStartTime) AS HourOfDay,
        COUNT(*)                      AS answered,
        AVG(CAST(TimeToAnswer AS float)) AS avgWait
      FROM [dbo].[tblData_LC_Trace]
      WHERE Queue IN ('P862','P861','P803')
        AND PegCount = 1
        AND TimeToAnswer IS NOT NULL
        AND TimeToAnswer > 0
        AND CallStartTime >= CAST(GETDATE() AS DATE)
      GROUP BY DATEPART(HOUR, CallStartTime)
    `),
    // Last-24-hours ring time — grouped per queue, per hour bucket
    p.request().query(`
      SELECT
        Queue,
        DATEADD(HOUR, DATEDIFF(HOUR, 0, CallStartTime), 0) AS HourBucket,
        COUNT(*)                            AS answered,
        AVG(CAST(TimeToAnswer AS float))    AS avgWait
      FROM [dbo].[tblData_LC_Trace]
      WHERE Queue IN ('P862','P861','P803')
        AND PegCount = 1
        AND TimeToAnswer IS NOT NULL
        AND TimeToAnswer > 0
        AND CallStartTime >= DATEADD(HOUR, -24, GETDATE())
      GROUP BY Queue, DATEADD(HOUR, DATEDIFF(HOUR, 0, CallStartTime), 0)
    `),
  ]);

  // Build a 24-slot array (oldest → newest) of the last 24 clock hours.
  // We use ISO strings for the bucket so timezone handling is done client-side.
  const nowMs      = Date.now();
  const oneHourMs  = 3_600_000;
  const currentHrStart = new Date(Math.floor(nowMs / oneHourMs) * oneHourMs);
  const hourSlots = Array.from({ length: 24 }, (_, i) =>
    new Date(currentHrStart.getTime() - (23 - i) * oneHourMs));

  const queues = ['P862', 'P861', 'P803'].map(id => {
    const t = todayResult.recordset.find(r => r.Queue === id);
    const r = recentResult.recordset.find(r => r.Queue === id);
    const monthRows = last24hResult.recordset.filter(r => r.Queue === id);
    const byBucket = new Map(monthRows.map(row => [
      new Date(row.HourBucket).getTime(),
      { avgWait: row.avgWait != null ? Math.round(row.avgWait) : null, answered: row.answered ?? 0 },
    ]));
    const hourly = hourSlots.map(d => {
      const hit = byBucket.get(d.getTime());
      return {
        bucket:   d.toISOString(),
        avgWait:  hit?.avgWait  ?? null,
        answered: hit?.answered ?? 0,
      };
    });
    return {
      id,
      name:           QUEUE_MAP[id],
      answered:       t?.answered    ?? 0,
      abandoned:      t?.abandoned   ?? 0,
      avgWait:        t?.avgWait     != null ? Math.round(t.avgWait)        : null,
      avgDuration:    t?.avgDuration != null ? Math.round(t.avgDuration)    : null,
      recentAnswered: r?.recentAnswered ?? 0,
      recentAvgWait:  r?.recentAvgWait  != null ? Math.round(r.recentAvgWait) : null,
      recentMaxWait:  r?.recentMaxWait  ?? null,
      hourly,
    };
  });

  // Clock-based: always show previous 3 EST hours regardless of DB lag
  const estHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date()), 10);
  const hourMap = new Map(hourlyResult.recordset.map(r => [r.HourOfDay, r]));
  const hourlyStats = [1, 2, 3].map(h => {
    const hr  = estHour - h;
    const row = hourMap.get(hr);
    const d   = new Date();
    d.setHours(hr, 0, 0, 0);
    return {
      label:    d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
      avgWait:  row?.avgWait != null ? Math.round(row.avgWait) : null,
      answered: row?.answered ?? 0,
    };
  });

  return { queues, hourlyStats, updatedAt: new Date().toISOString() };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function ts() { return new Date().toLocaleTimeString(); }

async function tick() {
  try {
    const data = await fetchQueueStats();
    await pushToServer(data);
    const totals = data.queues.map(q => `${q.name}:${q.answered}ans/${q.abandoned}abn`).join('  ');
    console.log(`[${ts()}] ✓ ${totals}`);
  } catch (err) {
    pool = null; // force SQL reconnect on next tick
    console.error(`[${ts()}] ✗ ${err.message}`);
  }
}

(async () => {
  console.log('Mitel queue poller starting...');
  console.log(`  SQL:    ${process.env.MSSQL_SERVER} / ${process.env.MSSQL_DB}`);
  console.log(`  Server: ${process.env.CCOPS_BASE_URL}`);
  console.log(`  Poll:   every ${POLL_MS / 1000}s\n`);

  await tick();
  setInterval(tick, POLL_MS);
})();
