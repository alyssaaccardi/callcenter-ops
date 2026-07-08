#!/usr/bin/env node
// Bypass the UI: pull ChargeOver cancellations for a date range, run each
// through the Farewell Reporter (Zendesk match + Gemini + CO enrichment),
// and write a CSV that mirrors the UI export + a Flag column for
// disagreements and unknowns.
//
// Requires a running dev server on http://localhost:3001 with auth bypass:
//   GOOGLE_CLIENT_ID='' NODE_ENV=development node server.js
// Or point at prod with --url + --cookie.
//
// Usage:
//   node scripts/farewell-chargeover-batch.js --tenant=AL --from=2026-06-01 --to=2026-07-07
//   node scripts/farewell-chargeover-batch.js --tenant=both --limit=5     # quick smoke test
//   node scripts/farewell-chargeover-batch.js --url=https://ops.answeringlegal.com --cookie='connect.sid=...'
//
// Flags emitted per row:
//   disagree — ChargeOver custom_3 and Gemini category disagree (needs review)
//   unknown  — both sources returned Unknown/blank (needs manual reason)
//   error    — the lookup errored out (Zendesk/Gemini/CO down or timeout)
//   (blank)  — sources agree or only one had a signal — no review needed

require('dotenv').config({ path: `${process.env.HOME}/callcenter-ops/.env` });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}

const TENANT      = (args.tenant || 'both').toUpperCase();     // AL | RS | BOTH
const DEFAULT_DAYS = 30;
const FROM        = args.from ? new Date(args.from + 'T00:00:00Z') : new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);
const TO          = args.to   ? new Date(args.to   + 'T23:59:59Z') : new Date();
const LIMIT       = parseInt(args.limit || '0', 10) || 0;
const CONCURRENCY = parseInt(args.concurrency || '3', 10);
const BASE_URL    = (args.url || 'http://localhost:3001').replace(/\/$/, '');
const COOKIE      = args.cookie || '';
const OUT         = args.out || path.join(process.env.HOME, 'Downloads',
  `farewell-chargeover-batch-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}.csv`);

function coCfg(tenant) {
  const p = tenant === 'AL' ? 'AL' : 'RS';
  return {
    url:  process.env[`CHARGEOVER_${p}_URL`],
    auth: Buffer.from(`${process.env[`CHARGEOVER_${p}_PUBLIC_KEY`]}:${process.env[`CHARGEOVER_${p}_PRIVATE_KEY`]}`).toString('base64'),
  };
}

async function fetchTenantCancellations(tenant) {
  const { url, auth } = coCfg(tenant);
  if (!url || !auth) { console.log(`[co:${tenant}] no creds — skipping`); return []; }
  console.log(`[co:${tenant}] fetching cancellations ${FROM.toISOString().slice(0,10)}..${TO.toISOString().slice(0,10)}`);
  const subs = [];
  let offset = 0;
  const pageSize = 100;
  // Page through until we hit subs canceled before FROM (list is desc by cancel_datetime).
  while (true) {
    const r = await axios.get(`${url}/package`, {
      params: {
        where: 'package_status_str:EQUALS:canceled-manual',
        order: 'cancel_datetime:desc',
        limit: pageSize,
        offset,
      },
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    });
    const batch = r.data.response || [];
    if (batch.length === 0) break;
    let hitBelow = false;
    for (const s of batch) {
      if (!s.cancel_datetime) continue;
      const d = new Date(s.cancel_datetime.replace(' ', 'T') + 'Z');
      if (d < FROM) { hitBelow = true; continue; }
      if (d > TO) continue;
      subs.push(s);
    }
    offset += pageSize;
    if (hitBelow || batch.length < pageSize) break;
    if (offset > 2000) break; // safety
  }
  console.log(`[co:${tenant}] ${subs.length} cancellations in range`);
  // Fetch each customer record (parallel batches of 5)
  const customerIds = [...new Set(subs.map(s => s.customer_id))];
  const customers = new Map();
  const batchSize = 5;
  for (let i = 0; i < customerIds.length; i += batchSize) {
    await Promise.all(customerIds.slice(i, i + batchSize).map(async id => {
      try {
        const r = await axios.get(`${url}/customer/${id}`, {
          headers: { Authorization: `Basic ${auth}` }, timeout: 8000,
        });
        const c = Array.isArray(r.data.response) ? r.data.response[0] : r.data.response;
        if (c) customers.set(id, c);
      } catch (e) { /* skip */ }
    }));
  }
  return subs.map(s => ({ tenant, sub: s, customer: customers.get(s.customer_id) }));
}

async function callLookup(row) {
  const c = row.customer || {};
  const notes = row.sub?.custom_3 ? `co category: ${row.sub.custom_3}` : '';
  const body = {
    accountName: c.company || '',
    customerEmail: c.superuser_email || c.email || '',
    notes,
    chargeoverTenant: row.tenant,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers['Cookie'] = COOKIE;
  const resp = await axios.post(`${BASE_URL}/api/zendesk-auditor/lookup`, body, {
    headers, timeout: 90000, validateStatus: () => true,
  });
  return resp.data;
}

function decideFlag(r) {
  if (!r || r.status === 'error') return 'error';
  if (r.status === 'no_match') return 'no_match';
  const co = (r.chargeover?.category || '').trim();
  const ai = (r.aiCategory || '').trim();
  const bothBlank = (!co || co === 'Unknown / Unspecified') && (!ai || ai === 'Unknown / Unspecified');
  if (bothBlank) return 'unknown';
  if (r.agreement === 'disagree') return 'disagree';
  return '';
}

function csv(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { __error: e.message }; }
    }
  });
  await Promise.all(runners);
  return results;
}

(async () => {
  console.log(`Base URL: ${BASE_URL}`);
  // Preflight — make sure the lookup endpoint is reachable
  try {
    const p = await axios.get(`${BASE_URL}/api/whoami`, { headers: COOKIE ? { Cookie: COOKIE } : {}, timeout: 3000 });
    if (p.status !== 200) throw new Error(`whoami ${p.status}`);
  } catch (e) {
    console.error(`\n✗ Cannot reach ${BASE_URL}. Start dev server first:`);
    console.error(`   GOOGLE_CLIENT_ID='' NODE_ENV=development node server.js\n`);
    process.exit(1);
  }

  const rows = [];
  const tenants = TENANT === 'BOTH' ? ['AL', 'RS'] : [TENANT];
  for (const t of tenants) rows.push(...(await fetchTenantCancellations(t)));

  const capped = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`\nProcessing ${capped.length} cancellations at concurrency=${CONCURRENCY}…`);
  console.log(`Output: ${OUT}\n`);

  const started = Date.now();
  const results = await runWithConcurrency(capped, async (row, i) => {
    const c = row.customer || {};
    const label = `${row.tenant}/${(c.company || '(no name)').slice(0, 40)}`;
    try {
      const r = await callLookup(row);
      const flag = decideFlag(r);
      const tag = flag ? `⚠ ${flag}` : '✓';
      console.log(`[${String(i+1).padStart(3)}/${capped.length}] ${label.padEnd(45)} → ${(r.category || r.status || '?').padEnd(30)} ${tag}`);
      return { ...row, result: r, flag };
    } catch (e) {
      console.log(`[${String(i+1).padStart(3)}/${capped.length}] ${label.padEnd(45)} → ERROR ${e.message}`);
      return { ...row, result: null, flag: 'error', error: e.message };
    }
  }, CONCURRENCY);

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${results.length} lookups complete in ${elapsed}s`);

  // CSV mirrors what the UI export writes, plus dual-source + flag columns.
  const headers = [
    'Tenant', 'CO Customer ID', 'Company', 'Email',
    'Cancel Date (CO)', 'CO Sub Status', 'CO Category (raw)', 'CO Category (normalized)', 'CO Secondary', 'CO Quality Subcat',
    'AI Category', 'AI Confidence', 'AI Competitor', 'AI Summary', 'AI Reasoning',
    'Primary Source', 'Agreement', 'Flag',
    'Matched Zendesk Org', 'Match Confidence', 'Match Type', 'Match Score',
    'Ticket Count', 'Ticket IDs', 'Ticket Subjects', 'Ticket Dates',
    'CO MRR', 'CO ARR', 'CO Plan Tier', 'CO Days Overdue', 'CO Admin',
    'Est. Exit Date', 'Exit Date Source', 'Status', 'Error',
    'Zendesk Subdomain',
  ];
  const lines = [headers.map(csv).join(',')];
  for (const row of results) {
    const r = row.result || {};
    const co = r.chargeover || {};
    const c = row.customer || {};
    lines.push([
      row.tenant,
      c.customer_id, c.company, c.superuser_email || c.email,
      row.sub?.cancel_datetime?.slice(0, 10) || '',
      row.sub?.package_status_str,
      row.sub?.custom_3, co.category, co.secondaryCategory, co.qualitySubcategory,
      r.aiCategory, r.confidence, r.competitorName, r.summary, r.reasoning,
      r.primarySource, r.agreement, row.flag,
      r.matchedOrg, r.matchConfidence, r.matchType, r.matchScore,
      r.ticketCount ?? (r.ticketSubjects?.length ?? 0),
      (r.supportingTicketIds || []).join('; '),
      (r.ticketSubjects || []).join('; '),
      (r.ticketDates || []).join('; '),
      co.mrr, co.arr, co.planTier, co.daysOverdue, co.admin,
      r.estimatedCancellationDate, r.exitDateSource, r.status, r.error || row.error || '',
      r.zdSubdomain,
    ].map(csv).join(','));
  }
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`\nWrote ${results.length} rows → ${OUT}`);

  // Summary block
  const buckets = { total: results.length, agree: 0, disagree: 0, unknown: 0, 'ai-only': 0, 'chargeover-only': 0, no_match: 0, error: 0 };
  for (const row of results) {
    if (row.flag === 'error') buckets.error++;
    else if (row.flag === 'no_match') buckets.no_match++;
    else if (row.flag === 'disagree') buckets.disagree++;
    else if (row.flag === 'unknown') buckets.unknown++;
    else if (row.result?.agreement) buckets[row.result.agreement] = (buckets[row.result.agreement] || 0) + 1;
  }
  console.log('\n─────────────────── Summary ───────────────────');
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`\nFlagged for review: ${buckets.disagree + buckets.unknown + buckets.error + buckets.no_match} rows.`);
})();
