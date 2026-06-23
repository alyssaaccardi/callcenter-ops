#!/usr/bin/env node
// Regression test for the Farewell Report (Zendesk Cancellation Auditor).
//
// Ground truth was compiled from the ops cancellation ledger — accounts where
// we know the actual cancellation reason and have a Zendesk ticket ID. This
// script hits /api/zendesk-auditor/lookup with each (accountName, ticketId)
// pair, lets the auditor fetch the ticket from Zendesk and classify with the
// live prompt, then compares the returned category to the expected category.
//
// Run after any prompt or auditor logic change. Pass = AI never returns
// Unknown on a row that has a clear ground-truth reason; mismatches are
// surfaced so the prompt can be tightened.
//
// Usage:
//   node scripts/auditor-regression-test.js                # local dev server
//   AUDIT_URL=https://ops.answeringlegal.com node ...      # against prod
//
// Local dev auto-auths as super_admin when NODE_ENV != 'production' and no
// GOOGLE_CLIENT_ID is set. Prod requires a session cookie; pass via
// AUDIT_COOKIE='connect.sid=...'.

const axios = require('axios');

const BASE_URL = process.env.AUDIT_URL || 'http://localhost:3001';
const COOKIE = process.env.AUDIT_COOKIE || '';

// Ground truth from ops cancellation ledger.
// expected[] = acceptable categories (any one counts as pass — some rows are
// genuinely ambiguous between two valid buckets).
const TESTS = [
  // Non-Payment (involuntary close)
  { acct: 'Law Office of Dan S. Smith LLC', email: 'dssmithlaw@yahoo.com', ticket: 314688, expected: ['Non-Payment'] },
  { acct: 'Middle Island Landscaping', email: 'peter197444@yahoo.com', ticket: 314695, expected: ['Non-Payment'] },
  { acct: 'LAW OFFICE OF PETER OCONNOR', email: 'peter@pgolawfirm.com', ticket: 314693, expected: ['Non-Payment'] },
  { acct: 'Anthony & Sons Mechanical', email: 'anthonyandsonsmechanical@gmail.com', ticket: 314632, expected: ['Non-Payment'] },
  { acct: 'Garcia Law (NJ)', email: 'kgarcia@garcialawnj.com', ticket: null, expected: ['Non-Payment'] },
  { acct: 'MICHAEL B. COOKE ATTORNEY AT LAW', email: 'mike@attorneycooke.com', ticket: 319921, expected: ['Non-Payment'] },

  // Hired Staff (including "answering own calls" / "more hands on")
  { acct: 'Cool Hot Guys Air Conditioning', email: 'bua19@yahoo.com', ticket: 292016, expected: ['Hired Staff'] },
  { acct: 'Timmerman Law', email: 'mark@timmermanlawllc.com', ticket: 292369, expected: ['Hired Staff'] },
  { acct: 'Reyes Law Group P.C.', email: 'eric@reylawgroup.com', ticket: 293446, expected: ['Hired Staff'] },
  { acct: 'Molson Law Firm', email: 'ashley@molsonlawfirm.com', ticket: 303997, expected: ['Hired Staff'] },
  { acct: 'Eldridge Law Firm', email: 'bermainegroup@gmail.com', ticket: 315559, expected: ['Hired Staff'] },
  { acct: 'SKS POWER AND LIGHT, INC.', email: 'brandon@skspowerandlight.com', ticket: 291522, expected: ['Hired Staff'] },
  { acct: 'Ark Electric', email: 'arkelectricnh@gmail.com', ticket: 290734, expected: ['Hired Staff'] },
  { acct: 'LAW OFFICE OF DAVID J. GRUMMON, P.A.', email: 'davidjgrummon@gmail.com', ticket: 324401, expected: ['Hired Staff'] },
  { acct: 'Law office of Knute Oscar Broady', email: 'knute@koblaw.com', ticket: 321097, expected: ['Hired Staff'] },

  // IVR / Auto Attendant (phone-system replacement)
  { acct: 'The Martin Law Group', email: 'mm@martinlawny.com', ticket: 290647, expected: ['IVR / Auto Attendant'] },
  { acct: 'The Cook Law Firm', email: 'timcook@cooklawatlanta.com', ticket: 316753, expected: ['IVR / Auto Attendant'] },
  { acct: 'Anderson and Harrison', email: 'matthew@andersonlegaltn.com', ticket: 321148, expected: ['IVR / Auto Attendant'] },
  { acct: 'Law Office of Thomas D. Roberts', email: 'tom@tomrobertslaw.com', ticket: 314626, expected: ['IVR / Auto Attendant'] },

  // Overages / Rate Increase
  { acct: 'Hildebrand Law Office', email: 'hildebrandlawpc@gmail.com', ticket: 289380, expected: ['Did Not Want to Pay Rate Increase / Overages'] },
  { acct: 'Robert Bowers', email: 'rb@bowerslawflorida.com', ticket: 289729, expected: ['Did Not Want to Pay Rate Increase / Overages'] },
  { acct: 'True Comfort HVAC', email: 'truecomfort4u@yahoo.com', ticket: 317967, expected: ['Did Not Want to Pay Rate Increase / Overages'] },
  { acct: 'The Cakani Law Firm', email: 'ycakani@cakanilaw.com', ticket: 314843, expected: ['Did Not Want to Pay Rate Increase / Overages'] },
  { acct: 'Newton Barth', email: 'mary@newtonbarth.com', ticket: 311875, expected: ['Did Not Want to Pay Rate Increase / Overages'] },

  // Price Too High
  { acct: 'Law Office of John Paschal', email: 'john@johnpaschallaw.com', ticket: 290250, expected: ['Price Too High'] },
  { acct: 'Law Offices of Harold J. Cronk', email: 'joecronksav@gmail.com', ticket: 292005, expected: ['Price Too High'] },
  { acct: 'SANTORINI LAW FIRM', email: 'bianca@santorinilaw.com', ticket: 297690, expected: ['Price Too High'] },
  { acct: 'LAW OFFICES OF LINDA M. JAFFE, P.A', email: 'lindajaffe@lindajaffepa.com', ticket: 293926, expected: ['Price Too High'] },
  { acct: 'ROLAND LAW FIRM', email: 'hroland@rolandlawfirm.com', ticket: 315327, expected: ['Price Too High'] },

  // Switched to AI
  { acct: 'Duran Law Offices', email: 'duranlaw@yahoo.com', ticket: 290074, expected: ['Switched to AI Service'] },
  { acct: 'BICO LEGAL AND COMPLIANCE CONSULTING', email: 'info@bicolegalcompliance.com', ticket: null, expected: ['Switched to AI Service'] },

  // Downsizing / Restructuring
  { acct: 'LAW OFFICE OF CHRISTOPHER SERPICO', email: 'chrisserp@verizon.net', ticket: 291966, expected: ['Downsizing Practice'] },
  { acct: 'Law Office of Thomas Brown (1 OF 2)', email: 'ctblaw@gmail.com', ticket: 303999, expected: ['Downsizing Practice'] },
  { acct: 'Twin Valley Law', email: 'misty@twinvalleylaw.com', ticket: 325723, expected: ['Downsizing Practice'] },

  // Retired
  { acct: 'Ham Law PLLC', email: 'deborah@ham.law', ticket: 294196, expected: ['Retired'] },

  // Closed Practice (disbarment)
  { acct: 'Booberg Law', email: 'chris@booberglaw.com', ticket: 314718, expected: ['Closed Practice'] },

  // Not Enough Call Volume
  { acct: 'Randy Stalcup Law', email: 'stalcuplaw@hotmail.com', ticket: 291301, expected: ['Not Enough Call Volume'] },
  { acct: 'Henry McDonald & James PC', email: 'legal1@hmj-pc.com', ticket: null, expected: ['Not Enough Call Volume'] },

  // Quality
  { acct: 'Meredith Clark Law', email: 'meredith@meredithclarklaw.com', ticket: 316316, expected: ['Quality'] },
  { acct: 'Law Office of Christopher Dai', email: 'cdailaw@aol.com', ticket: 317968, expected: ['Quality'] },
  { acct: 'Antwi Law Firm', email: 'candice@shantelllaw.com', expected: ['Quality'] },

  // Vague — Unknown is the correct answer (anti-hallucination check)
  { acct: 'Law Office of Adam Burke', email: 'Burke142@gmail.com', ticket: 324901, expected: ['Non-Payment', 'Unknown / Unspecified'] },  // "No response"
  { acct: 'Krizman Law', email: 'casey@krizmanfirm.com', ticket: 329799, expected: ['Non-Payment', 'Unknown / Unspecified'] },             // "No response"
  { acct: 'Cortes Law Firm', email: 'morgan@corteslawfirm.com', ticket: 317876, expected: ['Unknown / Unspecified'] },                       // "happy/just needed to pause for now"
];

async function callLookup(t) {
  const body = {
    accountName: t.acct,
    customerEmail: t.email || '',
    notes: t.ticket ? `see ticket ${t.ticket}` : '',
  };
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers['Cookie'] = COOKIE;
  const resp = await axios.post(`${BASE_URL}/api/zendesk-auditor/lookup`, body, {
    headers, timeout: 60000, validateStatus: () => true,
  });
  return resp.data;
}

function pad(s, n) { return String(s).padEnd(n).slice(0, n); }

(async () => {
  console.log(`Running ${TESTS.length} regression tests against ${BASE_URL}\n`);
  const results = [];
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    process.stdout.write(`[${i + 1}/${TESTS.length}] ${pad(t.acct, 50)} `);
    let r, err;
    try { r = await callLookup(t); } catch (e) { err = e.message; }
    if (err) {
      console.log(`ERROR: ${err}`);
      results.push({ ...t, status: 'error', error: err });
      continue;
    }
    const got = r.category || '(no category)';
    const pass = t.expected.includes(got);
    const tag = pass ? 'PASS' : got === 'Unknown / Unspecified' ? 'UNKNOWN' : 'MISMATCH';
    console.log(`→ ${pad(got, 40)} [${tag}]`);
    results.push({ ...t, status: tag.toLowerCase(), got, summary: r.summary, competitorName: r.competitorName, matchType: r.matchType });
  }

  console.log('\n────────── Summary ──────────');
  const pass = results.filter(r => r.status === 'pass').length;
  const unknown = results.filter(r => r.status === 'unknown').length;
  const mismatch = results.filter(r => r.status === 'mismatch').length;
  const err = results.filter(r => r.status === 'error').length;
  console.log(`PASS:     ${pass} / ${results.length}`);
  console.log(`UNKNOWN:  ${unknown}`);
  console.log(`MISMATCH: ${mismatch}`);
  console.log(`ERROR:    ${err}`);

  const fails = results.filter(r => r.status !== 'pass' && r.status !== 'error');
  if (fails.length > 0) {
    console.log('\n────────── Failures (need prompt work) ──────────');
    for (const f of fails) {
      console.log(`\n  ${f.acct}`);
      console.log(`    ticket:   ${f.ticket || '—'}`);
      console.log(`    expected: ${f.expected.join(' | ')}`);
      console.log(`    got:      ${f.got}`);
      if (f.summary) console.log(`    summary:  ${f.summary.slice(0, 140)}`);
      if (f.matchType) console.log(`    match:    ${f.matchType}`);
    }
  }
  process.exit(fails.length > 0 ? 1 : 0);
})();
