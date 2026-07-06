#!/usr/bin/env node
// One-off diff of the AI Farewell Reporter output against the June 2026
// ground-truth cancellation reasons recorded by ops (imported by the user
// via bulk audit on 2026-07-06). Not committed as a permanent regression —
// it's a snapshot to target prompt updates.
//
// Usage: node scripts/june-2026-groundtruth-diff.js
// Requires: dev server on http://localhost:3001 with auth bypass.

const axios = require('axios');
const BASE_URL = process.env.AUDIT_URL || 'http://localhost:3001';

// Ground truth from the user's June 2026 export. `expected` = the auditor
// category or set of acceptable categories, based on the ops-recorded
// Cancellation Reason. Test rows (Alyssa Accardi) are skipped.
const ROWS = [
  { id: 435,  acct: 'Law Office of Saul Brown',       email: 'sbrown4710@aol.com',           ticket: 333033, truth: 'he hired staff',                                             expected: ['Hired Staff'] },
  { id: 3920, acct: 'PECK LAW CORP',                  email: 'speck@pecklawcorp.com',        ticket: 331002, truth: 'unknown',                                                    expected: ['Unknown / Unspecified'] },
  { id: 4733, acct: 'Law Office of Ted Wolfendale',   email: 'al@swflelderlaw.com',          ticket: 331817, truth: 'unknown',                                                    expected: ['Unknown / Unspecified'] },
  { id: 6203, acct: 'ATL Legal Advisors',             email: 'parker@atllegaladvisers.com',  ticket: null,   truth: 'Non-payment',                                                expected: ['Non-Payment'] },
  { id: 5028, acct: 'Law Office of Leila Wons',       email: 'leila@wonslegal.com',          ticket: 331384, truth: 'hired staff, minor complaints re: service',                  expected: ['Hired Staff'] },
  { id: 5339, acct: 'Law Office of Megan Harkins',    email: 'attorneymeganharkins@gmail.com', ticket: 331802, truth: 'unable to predict price per month w/ overages, Going to use answering machine', expected: ['Did Not Want to Pay Rate Increase / Overages', 'IVR / Auto Attendant'] },
  { id: 5595, acct: 'The Kian Law Group',             email: 'ryan@kianlaw.com',             ticket: 332072, truth: 'Non-payment',                                                expected: ['Non-Payment'] },
  { id: 5627, acct: 'LAW OFFICE OF JILLIAN MILLER',   email: 'jmilleridaholaw@gmail.com',    ticket: 332144, truth: "account freeze, no longer wanted to pay as she isn't using it", expected: ['Doesn\'t See Value', 'Not Enough Call Volume'] },
  { id: 5653, acct: 'Patricia M. Morgan Law, PLLC',   email: 'morgan@pmmorganlaw.com',       ticket: 332046, truth: 'Stopped using us plus billing error',                        expected: ['Doesn\'t See Value', 'Quality'] },
  { id: 5788, acct: 'MJPA LAW',                       email: 'gino@mjpalaw.com',             ticket: 331406, truth: 'no longer needs an answering service',                       expected: ['Doesn\'t See Value'] },
  { id: 6029, acct: 'Orr Law Firm',                   email: 'orrlaw@orrlaw.com',            ticket: 332074, truth: 'Non-payment',                                                expected: ['Non-Payment'] },
  { id: 6032, acct: 'Butz Law Firm',                  email: 'butzlawfirm@gmail.com',        ticket: 330484, truth: 'hired staff 24/7',                                           expected: ['Hired Staff'] },
  { id: 6033, acct: 'Law Office of Spencer Charif',   email: 'spencer@chariflaw.com',        ticket: 331629, truth: 'no reason provided, back-to-back cancel emails',             expected: ['Unknown / Unspecified'] },
  { id: 6037, acct: 'Strasser Asatrian, LLC',         email: 'hasatrian@strasserasatrian.com', ticket: 330796, truth: 'Unpredictable and excessive costs, complaints re: service', expected: ['Did Not Want to Pay Rate Increase / Overages', 'Price Too High'] },
  { id: 6114, acct: 'The Janson Bailey Law Firm',     email: 'janson@baileylaw.law',         ticket: 332073, truth: 'Non-payment',                                                expected: ['Non-Payment'] },
  { id: 6374, acct: 'Brady Skinner Law',              email: 'bskinner@bsajustice.com',      ticket: null,   truth: '(blank)',                                                    expected: ['Unknown / Unspecified'] },
  { id: 6462, acct: 'Capitol Immigration',            email: 'capitolllcla@gmail.com',       ticket: null,   truth: 'Non-payment',                                                expected: ['Non-Payment'] },
  { id: 6586, acct: 'NS Law Group',                   email: 'nassim@salloumlawep.com',      ticket: null,   truth: '(blank)',                                                    expected: ['Unknown / Unspecified'] },
  { id: 6670, acct: 'Mark Smith Law',                 email: 'mark@markasmithlaw.com',       ticket: null,   truth: '(blank)',                                                    expected: ['Unknown / Unspecified'] },
  { id: 6752, acct: 'Antwi Law Firm',                 email: 'candice@shantelllaw.com',      ticket: null,   truth: '(blank)',                                                    expected: ['Unknown / Unspecified'] },
];

function pad(s, n) { return String(s).padEnd(n).slice(0, n); }

async function callLookup(row) {
  // Match what a real bulk-audit row looks like: notes column contains the
  // ops-recorded reason text AND the ticket number (parseTicketIdsFromRow
  // picks up any 5-7 digit sequence). Empty-truth rows just get the ticket #.
  const notesParts = [];
  if (row.truth && row.truth !== '(blank)') notesParts.push(row.truth);
  if (row.ticket) notesParts.push(`ticket ${row.ticket}`);
  const body = {
    accountName: row.acct,
    customerEmail: row.email,
    emailDomain: row.email ? row.email.split('@')[1] : '',
    notes: notesParts.join(' — '),
  };
  const resp = await axios.post(`${BASE_URL}/api/zendesk-auditor/lookup`, body, {
    timeout: 60000, validateStatus: () => true,
  });
  return resp.data;
}

(async () => {
  console.log(`Running ${ROWS.length} ground-truth rows against ${BASE_URL}\n`);
  const results = [];
  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    process.stdout.write(`[${i + 1}/${ROWS.length}] ${pad(row.acct, 42)} `);
    let r; try { r = await callLookup(row); } catch (e) { console.log(`ERROR ${e.message}`); results.push({ ...row, err: e.message }); continue; }
    const got = r.category || '(no category)';
    const status = r.status;
    const pass = row.expected.includes(got);
    const tag = status === 'no_match' ? 'NO_MATCH' : pass ? 'PASS' : got === 'Unknown / Unspecified' ? 'UNKNOWN' : 'MISMATCH';
    console.log(`→ ${pad(got, 44)} [${tag}]  matchType=${r.matchType}  orgId=${r.zdOrgId ?? '-'}`);
    results.push({ ...row, got, status, tag, summary: r.summary, matchType: r.matchType, zdOrgId: r.zdOrgId, matchedOrg: r.matchedOrg });
  }

  console.log('\n─────────────────── Summary ───────────────────');
  const counts = results.reduce((a, r) => (a[r.tag] = (a[r.tag] || 0) + 1, a), {});
  for (const [k, v] of Object.entries(counts)) console.log(`  ${pad(k, 10)} ${v}`);

  console.log('\n─────────────── Failures / Notes ──────────────');
  for (const r of results) {
    if (r.tag === 'PASS') continue;
    console.log(`\n  ${r.acct}  (id ${r.id})  [${r.tag}]`);
    console.log(`    truth:      ${r.truth}`);
    console.log(`    expected:   ${r.expected.join(' | ')}`);
    console.log(`    got:        ${r.got || r.status}`);
    console.log(`    matchType:  ${r.matchType}`);
    console.log(`    matchedOrg: ${r.matchedOrg}`);
    if (r.summary) console.log(`    summary:    ${String(r.summary).slice(0, 140)}`);
  }

  // Duplicate-orgId detection (relevant to the "cancel count" concern)
  console.log('\n─────────── Potential dup zdOrgIds ────────────');
  const byOrg = new Map();
  for (const r of results) {
    if (!r.zdOrgId) continue;
    if (!byOrg.has(r.zdOrgId)) byOrg.set(r.zdOrgId, []);
    byOrg.get(r.zdOrgId).push(r);
  }
  let dupFound = false;
  for (const [orgId, rows] of byOrg) {
    if (rows.length > 1) {
      dupFound = true;
      console.log(`  zdOrgId=${orgId} matched by ${rows.length} rows:`);
      for (const r of rows) console.log(`    - ${r.acct} (id ${r.id})`);
    }
  }
  if (!dupFound) console.log('  (none — every matched customer has a unique zdOrgId)');
})();
