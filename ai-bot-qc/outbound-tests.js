const express = require('express');
const axios = require('axios');
const { listUsers } = require('../auth');
const { db } = require('./db');
const seeds = require('./outbound-seeds');
const staff = require('./staff-api');

module.exports = function createOutboundTests({ listAccounts }) {
const router = express.Router();
const ADMIN_ROLES = ['super_admin', 'ai_bot_qc_admin'];
const QUESTION_TYPES = ['yesno', 'text'];

db.exec(`
CREATE TABLE IF NOT EXISTS bot_outbound_test_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  call_notes TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT '["Call"]',
  questions TEXT NOT NULL DEFAULT '[]',
  improvement_prompt TEXT NOT NULL DEFAULT '',
  default_targets TEXT NOT NULL DEFAULT '[]',
  default_scenarios TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bot_outbound_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES bot_outbound_test_types(id),
  agent_email TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  scenarios TEXT NOT NULL DEFAULT '{}',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','submitted','reviewed')),
  answers TEXT NOT NULL DEFAULT '{}',
  improvement TEXT NOT NULL DEFAULT '',
  calls TEXT NOT NULL DEFAULT '[]',
  admin_note TEXT NOT NULL DEFAULT '',
  assigned_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_tests_agent ON bot_outbound_tests(agent_email, status);
CREATE TABLE IF NOT EXISTS bot_outbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id INTEGER NOT NULL REFERENCES bot_outbound_tests(id) ON DELETE CASCADE,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

if (!db.prepare('PRAGMA table_info(bot_outbound_tests)').all().some(c => c.name === 'staging_calls')) {
  db.exec("ALTER TABLE bot_outbound_tests ADD COLUMN staging_calls TEXT NOT NULL DEFAULT '[]'");
}
if (!db.prepare('PRAGMA table_info(bot_outbound_test_types)').all().some(c => c.name === 'default_scenarios')) {
  db.exec("ALTER TABLE bot_outbound_test_types ADD COLUMN default_scenarios TEXT NOT NULL DEFAULT '{}'");
}
// Account lists are live (HubSpot + recordings), so templates never carry accounts.
db.exec("UPDATE bot_outbound_test_types SET default_targets = '[]'");
if (!db.prepare('SELECT COUNT(*) AS n FROM bot_outbound_test_types').get().n) {
  const insert = db.prepare(`INSERT INTO bot_outbound_test_types
    (title, objective, steps, call_notes, variants, questions, improvement_prompt, default_scenarios)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of seeds) {
    insert.run(t.title, t.objective, JSON.stringify(t.steps), t.call_notes, JSON.stringify(t.variants),
      JSON.stringify(t.questions), t.improvement_prompt, JSON.stringify(t.default_scenarios || {}));
  }
}

// Add seeded types introduced after the first install (matched by title).
for (const t of seeds) {
  if (db.prepare('SELECT 1 FROM bot_outbound_test_types WHERE title = ?').get(t.title)) continue;
  db.prepare(`INSERT INTO bot_outbound_test_types
    (title, objective, steps, call_notes, variants, questions, improvement_prompt, default_scenarios)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(t.title, t.objective, JSON.stringify(t.steps), t.call_notes, JSON.stringify(t.variants),
    JSON.stringify(t.questions), t.improvement_prompt, JSON.stringify(t.default_scenarios || {}));
}

for (const t of seeds) {
  db.prepare("UPDATE bot_outbound_test_types SET default_scenarios = ? WHERE title = ? AND default_scenarios = '{}'")
    .run(JSON.stringify(t.default_scenarios || {}), t.title);
}

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const str = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

function isAdmin(req) {
  return [req.user?.role, ...(req.user?.additionalRoles || [])].some(role => ADMIN_ROLES.includes(role));
}
function actorFor(req) {
  return { email: String(req.user.email || 'dev@local').toLowerCase(), name: req.user.name || req.user.email || 'Unknown' };
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  next();
}
function addEvent(testId, actor, type, details = {}) {
  db.prepare('INSERT INTO bot_outbound_events (test_id, actor_email, actor_name, event_type, details) VALUES (?, ?, ?, ?, ?)')
    .run(testId, actor.email, actor.name, type, JSON.stringify(details));
}

function typeOut(row) {
  return {
    id: row.id, title: row.title, objective: row.objective, steps: parse(row.steps, []), call_notes: row.call_notes,
    variants: parse(row.variants, ['Call']), questions: parse(row.questions, []), improvement_prompt: row.improvement_prompt,
    default_scenarios: parse(row.default_scenarios, {}), active: !!row.active,
  };
}
function testOut(row, type) {
  return {
    id: row.id, type_id: row.type_id, type: type ? typeOut(type) : null, agent_email: row.agent_email, agent_name: row.agent_name,
    account: row.account, phone: row.phone, contact: row.contact, scenarios: parse(row.scenarios, {}), due_date: row.due_date,
    status: row.status, answers: parse(row.answers, {}), improvement: row.improvement, calls: parse(row.calls, []), staging_calls: parse(row.staging_calls, []),
    admin_note: row.admin_note, assigned_by: row.assigned_by, reviewed_by: row.reviewed_by, created_at: row.created_at,
    submitted_at: row.submitted_at, reviewed_at: row.reviewed_at,
  };
}
const typeById = id => db.prepare('SELECT * FROM bot_outbound_test_types WHERE id = ?').get(id);

function cleanType(body) {
  const title = str(body.title, 200);
  if (!title) return { error: 'Title is required' };
  const list = (value, max) => (Array.isArray(value) ? value : []).map(v => str(v, max)).filter(Boolean).slice(0, 50);
  const variants = list(body.variants, 80);
  const questions = (Array.isArray(body.questions) ? body.questions : []).slice(0, 50)
    .map(q => ({ text: str(q?.text, 500), type: QUESTION_TYPES.includes(q?.type) ? q.type : 'yesno' }))
    .filter(q => q.text);
  const scenarios = cleanTarget({ scenarios: body.default_scenarios }).scenarios;
  return {
    value: {
      title, objective: str(body.objective, 3000), steps: list(body.steps, 500), call_notes: str(body.call_notes, 3000),
      variants: variants.length ? variants : ['Call'], questions, improvement_prompt: str(body.improvement_prompt, 500),
      default_scenarios: scenarios,
    },
  };
}
function cleanTarget(t = {}) {
  const scenarios = {};
  for (const [k, v] of Object.entries(t.scenarios && typeof t.scenarios === 'object' ? t.scenarios : {})) {
    if (str(v)) scenarios[str(k, 80)] = str(v, 500);
  }
  return { account: str(t.account, 200), phone: str(t.phone, 40), contact: str(t.contact, 120), scenarios };
}

router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    res.json({ accounts: await listAccounts({ refresh: req.query.refresh === '1' }) });
  } catch (error) {
    console.error('[ai-bot-qc] outbound test account lookup failed:', error.response?.status || error.message);
    res.status(503).json({ error: error.code === 'not_configured'
      ? 'The staging API key is not configured on the server.'
      : 'Could not load staging accounts. Try again shortly.' });
  }
});

router.get('/types', (req, res) => {
  const rows = db.prepare('SELECT * FROM bot_outbound_test_types WHERE active = 1 ORDER BY id').all();
  res.json({ types: rows.map(typeOut) });
});

function saveType(req, res, id) {
  const { value, error } = cleanType(req.body || {});
  if (error) return res.status(400).json({ error });
  const params = [value.title, value.objective, JSON.stringify(value.steps), value.call_notes, JSON.stringify(value.variants),
    JSON.stringify(value.questions), value.improvement_prompt, JSON.stringify(value.default_scenarios)];
  if (id) {
    db.prepare(`UPDATE bot_outbound_test_types SET title=?, objective=?, steps=?, call_notes=?, variants=?, questions=?,
      improvement_prompt=?, default_scenarios=?, updated_at=datetime('now') WHERE id=?`).run(...params, id);
  } else {
    id = db.prepare(`INSERT INTO bot_outbound_test_types (title, objective, steps, call_notes, variants, questions,
      improvement_prompt, default_scenarios) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...params).lastInsertRowid;
  }
  res.json({ type: typeOut(typeById(id)) });
}
router.post('/types', requireAdmin, (req, res) => saveType(req, res, null));
router.put('/types/:id', requireAdmin, (req, res) => {
  if (!typeById(req.params.id)) return res.status(404).json({ error: 'Test type not found' });
  saveType(req, res, Number(req.params.id));
});
router.delete('/types/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE bot_outbound_test_types SET active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

function visibleTest(req, id) {
  const row = db.prepare('SELECT * FROM bot_outbound_tests WHERE id = ?').get(id);
  if (!row) return null;
  if (!isAdmin(req) && row.agent_email !== actorFor(req).email) return null;
  return row;
}

router.get('/assignments', (req, res) => {
  const where = [];
  const params = [];
  if (!isAdmin(req) || req.query.mine === '1') { where.push('agent_email = ?'); params.push(actorFor(req).email); }
  if (['assigned', 'submitted', 'reviewed'].includes(req.query.status)) { where.push('status = ?'); params.push(req.query.status); }
  const rows = db.prepare(`SELECT * FROM bot_outbound_tests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'assigned' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, id DESC LIMIT 500`).all(...params);
  const types = new Map();
  const tests = rows.map(row => {
    if (!types.has(row.type_id)) types.set(row.type_id, typeById(row.type_id));
    return testOut(row, types.get(row.type_id));
  });
  res.json({ tests });
});

const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^\+?\d[\d\s().-]*$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// One row per test, call variant and question so results can be filtered and pivoted in a spreadsheet.
router.get('/export', requireAdmin, (req, res) => {
  const where = [];
  const params = [];
  if (dateOk(req.query.from)) { where.push('substr(created_at, 1, 10) >= ?'); params.push(req.query.from); }
  if (dateOk(req.query.to)) { where.push('substr(created_at, 1, 10) <= ?'); params.push(req.query.to); }
  const rows = db.prepare(`SELECT * FROM bot_outbound_tests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`).all(...params);
  const header = ['Test ID', 'Test', 'Account', 'DID', 'Agent', 'Status', 'Assigned', 'Due', 'Submitted', 'Reviewed', 'Reviewed by',
    'Call', 'Scenario', 'Question', 'Answer', 'Details', 'One thing to improve', 'Reviewer note', 'Staging call ids'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const type = typeById(row.type_id);
    const questions = parse(type?.questions, []);
    const variants = parse(type?.variants, ['Call']);
    const answers = parse(row.answers, {});
    const scenarios = parse(row.scenarios, {});
    const base = [row.id, type?.title || '', row.account, row.phone, row.agent_name || row.agent_email, row.status, row.created_at,
      row.due_date || '', row.submitted_at || '', row.reviewed_at || '', row.reviewed_by || ''];
    const tail = [row.improvement, row.admin_note, parse(row.staging_calls, []).map(c => c.call_id).join(' ')];
    for (const variant of variants) {
      questions.forEach((q, i) => {
        const a = answers[variant]?.[i] || {};
        lines.push([...base, variant, scenarios[variant] || '', q.text, a.choice || '', a.text || '', ...tail].map(csvCell).join(','));
      });
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="airi-outbound-tests-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\ufeff${lines.join('\r\n')}\r\n`);
});

router.get('/summary', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT agent_email, agent_name, type_id, status, due_date, created_at, submitted_at, reviewed_at FROM bot_outbound_tests').all();
  const overdue = r => r.status === 'assigned' && r.due_date && r.due_date < today;
  const days = (a, b) => (utc(b) - utc(a)) / 86400000;
  const agents = new Map();
  const types = new Map();
  for (const r of rows) {
    const agent = agents.get(r.agent_email) || { email: r.agent_email, name: r.agent_name || r.agent_email, assigned: 0, submitted: 0, reviewed: 0, overdue: 0, last_submitted_at: null };
    agent[r.status] += 1;
    if (overdue(r)) agent.overdue += 1;
    if (r.submitted_at && (!agent.last_submitted_at || r.submitted_at > agent.last_submitted_at)) agent.last_submitted_at = r.submitted_at;
    agents.set(r.agent_email, agent);
    const type = types.get(r.type_id) || { title: typeById(r.type_id)?.title || 'Unknown', total: 0, done: 0 };
    type.total += 1;
    if (r.status !== 'assigned') type.done += 1;
    types.set(r.type_id, type);
  }
  const submittedRows = rows.filter(r => r.submitted_at);
  res.json({
    totals: {
      total: rows.length,
      assigned: rows.filter(r => r.status === 'assigned').length,
      submitted: rows.filter(r => r.status === 'submitted').length,
      reviewed: rows.filter(r => r.status === 'reviewed').length,
      overdue: rows.filter(overdue).length,
      submitted_today: rows.filter(r => r.submitted_at && r.submitted_at.slice(0, 10) === today).length,
      avg_days_to_submit: submittedRows.length ? Math.round((submittedRows.reduce((sum, r) => sum + days(r.created_at, r.submitted_at), 0) / submittedRows.length) * 10) / 10 : null,
    },
    agents: [...agents.values()].sort((a, b) => b.overdue - a.overdue || b.assigned - a.assigned || a.name.localeCompare(b.name)),
    types: [...types.values()].sort((a, b) => b.total - a.total),
  });
});

const lastStagingCheck = new Map();
const utc = value => Date.parse(`${String(value).replace(' ', 'T')}Z`);

// Finds staging calls to the test's DID made after the agent clicked Call and links them by id.
async function matchStagingCalls(row, { force = false } = {}) {
  if (!process.env.STAFF_API_KEY) return;
  if (!force && Date.now() - (lastStagingCheck.get(row.id) || 0) < 30000) return;
  lastStagingCheck.set(row.id, Date.now());
  const clicks = db.prepare("SELECT created_at, details FROM bot_outbound_events WHERE test_id = ? AND event_type = 'call_clicked' ORDER BY id").all(row.id)
    .map(e => ({ at: utc(e.created_at), variant: parse(e.details, {}).variant || '' }));
  if (!clicks.length) return;
  const wanted = staff.last10(row.phone);
  const calls = await staff.recentCalls({ sinceMs: clicks[0].at - 2 * 60 * 1000 });
  const known = parse(row.staging_calls, []);
  let changed = false;
  for (const call of calls) {
    if (staff.last10(call.dialed_number) !== wanted || known.some(k => k.call_id === call.id)) continue;
    const startedAt = Date.parse(call.started_at);
    const click = [...clicks].reverse().find(c => c.at - 2 * 60 * 1000 <= startedAt);
    known.push({ call_id: call.id, variant: click?.variant || '', started_at: call.started_at, caller_number: call.caller_number || '' });
    changed = true;
  }
  if (changed) {
    known.sort((a, b) => a.started_at.localeCompare(b.started_at));
    db.prepare("UPDATE bot_outbound_tests SET staging_calls = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(known), row.id);
    addEvent(row.id, { email: 'system', name: 'Staging API' }, 'staging_call', { count: known.length });
  }
}

async function freshRow(row, options) {
  try { await matchStagingCalls(row, options); } catch (error) { console.error('[ai-bot-qc] staging call match failed:', error.response?.status || error.message); }
  return db.prepare('SELECT * FROM bot_outbound_tests WHERE id = ?').get(row.id);
}

router.get('/assignments/:id/staging/:callId', async (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  if (!parse(row.staging_calls, []).some(k => k.call_id === req.params.callId)) return res.status(404).json({ error: 'Call not linked to this test' });
  try {
    const call = await staff.getCall(req.params.callId);
    res.json({ call: {
      id: call.id, started_at: call.started_at, ended_at: call.ended_at, caller_number: call.caller_number, dialed_number: call.dialed_number,
      billed_duration_seconds: call.billed_duration_seconds, classification: call.classification, classification_type: call.classification_type,
      disposition: call.disposition, summary: call.summary, failed_action_count: call.failed_action_count, diagnostics: call.diagnostics,
      intake: call.intake, transfer: call.transfer, legs: call.legs, actions: call.actions, transcript: call.transcript || [], has_recording: !!call.recording_url,
    } });
  } catch (error) {
    console.error('[ai-bot-qc] staging call detail failed:', error.response?.status || error.message);
    res.status(502).json({ error: 'Could not load the staging call. Try again shortly.' });
  }
});

router.get('/assignments/:id/staging/:callId/recording', async (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row || !parse(row.staging_calls, []).some(k => k.call_id === req.params.callId)) return res.status(404).end();
  try {
    const url = await staff.recordingUrl(req.params.callId);
    if (!url) return res.status(404).end();
    const upstream = await axios.get(url, {
      responseType: 'stream', timeout: 20000, validateStatus: () => true,
      headers: req.headers.range ? { Range: req.headers.range } : {},
    });
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[name]) res.setHeader(name, upstream.headers[name]);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    upstream.data.pipe(res);
  } catch (error) {
    console.error('[ai-bot-qc] staging recording failed:', error.response?.status || error.message);
    res.status(502).end();
  }
});

router.post('/assignments/:id/staging-refresh', async (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  const next = await freshRow(row, { force: true });
  res.json({ staging_calls: parse(next.staging_calls, []) });
});

router.get('/assignments/:id', async (req, res) => {
  let row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  row = await freshRow(row);
  const events = db.prepare('SELECT * FROM bot_outbound_events WHERE test_id = ? ORDER BY id').all(row.id)
    .map(e => ({ ...e, details: parse(e.details, {}) }));
  res.json({ test: testOut(row, typeById(row.type_id)), events });
});

router.post('/assignments', requireAdmin, (req, res) => {
  const body = req.body || {};
  const type = typeById(body.type_id);
  if (!type || !type.active) return res.status(400).json({ error: 'Choose a test type' });
  const targets = (Array.isArray(body.targets) ? body.targets : []).map(cleanTarget).filter(t => t.account && t.phone).slice(0, 50);
  if (!targets.length) return res.status(400).json({ error: 'Add at least one account with a phone number' });
  const users = listUsers();
  const eligible = new Set(Object.entries(users)
    .filter(([, rec]) => [rec.role, ...(rec.additionalRoles || [])].some(r => ['ai_bot_qc', 'ai_bot_qc_admin', 'super_admin'].includes(r)))
    .map(([email]) => email.toLowerCase()));
  const agents = [...new Set((Array.isArray(body.agent_emails) ? body.agent_emails : [body.agent_email])
    .map(e => str(e, 200).toLowerCase()).filter(Boolean))];
  if (!agents.length || agents.some(e => !eligible.has(e))) return res.status(400).json({ error: 'Choose valid QC agents' });
  const due = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? body.due_date : null;
  const actor = actorFor(req);
  const nameFor = email => (Object.entries(users).find(([e]) => e.toLowerCase() === email)?.[1].name) || email;
  const insert = db.prepare(`INSERT INTO bot_outbound_tests (type_id, agent_email, agent_name, account, phone, contact, scenarios, due_date, assigned_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const created = [];
  db.transaction(() => {
    targets.forEach((target, index) => {
      // Random mode spreads the targets across the chosen agents; otherwise every agent gets every target.
      const recipients = body.random ? [agents[Math.floor(Math.random() * agents.length)]] : agents;
      for (const email of recipients) {
        const id = insert.run(type.id, email, nameFor(email), target.account, target.phone, target.contact,
          JSON.stringify(target.scenarios), due, actor.email).lastInsertRowid;
        addEvent(id, actor, 'assigned', { to: email, random: !!body.random, due_date: due, order: index + 1 });
        created.push(id);
      }
    });
  })();
  res.json({ created: created.length });
});

// Rings the agent's own Kixie dialer through Kixie's Make a Call API (only for the test's assigned agent).
router.post('/assignments/:id/call', async (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  const actor = actorFor(req);
  const variant = str(req.body?.variant, 80);
  addEvent(row.id, actor, 'call_clicked', { variant, phone: row.phone });
  if (row.agent_email !== actor.email) return res.status(403).json({ error: 'Only the assigned agent can place this call' });
  const key = process.env.KIXIE_API_KEY;
  const businessId = process.env.KIXIE_BUSINESS_ID;
  if (!key || !businessId) return res.status(503).json({ error: 'Kixie is not configured', fallback: true });
  const digits = String(row.phone).replace(/\D/g, '');
  const target = digits.length === 10 ? `1${digits}` : digits;
  try {
    const response = await axios.post(`https://apig.kixie.com/app/event?apikey=${encodeURIComponent(key)}`, {
      businessid: businessId, email: actor.email, target, displayname: 'AIRI QA test', eventname: 'call', apikey: key,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
    if (response.status >= 200 && response.status < 300 && response.data?.success !== false) {
      addEvent(row.id, actor, 'kixie_dial_requested', { variant });
      return res.json({ ok: true });
    }
    console.error('[ai-bot-qc] Kixie dial rejected:', response.status, response.data?.msg || '');
    const reason = response.data?.msg ? ` Kixie said: ${response.data.msg}` : '';
    res.status(502).json({ error: `Kixie did not place the call.${reason} Dial the number in Kixie instead.`, fallback: true });
  } catch (error) {
    console.error('[ai-bot-qc] Kixie dial failed:', error.message);
    res.status(502).json({ error: 'Could not reach Kixie. Dial the number in Kixie instead.', fallback: true });
  }
});

function cleanAnswers(value, type) {
  const out = {};
  const variants = parse(type.variants, ['Call']);
  const questions = parse(type.questions, []);
  for (const variant of variants) {
    const given = value?.[variant];
    if (!given || typeof given !== 'object') continue;
    out[variant] = {};
    questions.forEach((_, i) => {
      const a = given[i];
      if (!a || typeof a !== 'object') return;
      out[variant][i] = { choice: ['yes', 'no'].includes(a.choice) ? a.choice : '', text: str(a.text, 3000) };
    });
  }
  return out;
}

function saveAnswers(req, res, submit) {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  if (row.status === 'reviewed' && !isAdmin(req)) return res.status(409).json({ error: 'This test has been reviewed' });
  const type = typeById(row.type_id);
  const answers = cleanAnswers(req.body?.answers, type);
  const improvement = str(req.body?.improvement, 5000);
  const status = submit ? (row.status === 'reviewed' ? 'reviewed' : 'submitted') : row.status;
  db.prepare(`UPDATE bot_outbound_tests SET answers = ?, improvement = ?, status = ?,
    submitted_at = CASE WHEN ? THEN datetime('now') ELSE submitted_at END, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(answers), improvement, status, submit ? 1 : 0, row.id);
  if (submit) {
    addEvent(row.id, actorFor(req), 'submitted');
    freshRow(row, { force: true });
  }
  res.json({ test: testOut(db.prepare('SELECT * FROM bot_outbound_tests WHERE id = ?').get(row.id), type) });
}
router.put('/assignments/:id/answers', (req, res) => saveAnswers(req, res, false));
router.post('/assignments/:id/submit', (req, res) => saveAnswers(req, res, true));

router.post('/assignments/:id/review', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM bot_outbound_tests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  if (row.status === 'assigned') return res.status(409).json({ error: 'The agent has not submitted this test yet' });
  const actor = actorFor(req);
  const note = str(req.body?.admin_note, 3000);
  db.prepare(`UPDATE bot_outbound_tests SET status = 'reviewed', admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now'),
    updated_at = datetime('now') WHERE id = ?`).run(note, actor.email, row.id);
  addEvent(row.id, actor, 'reviewed', { note });
  res.json({ ok: true });
});

router.post('/assignments/:id/reopen', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM bot_outbound_tests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  db.prepare("UPDATE bot_outbound_tests SET status = 'assigned', updated_at = datetime('now') WHERE id = ?").run(row.id);
  addEvent(row.id, actorFor(req), 'reopened');
  res.json({ ok: true });
});

router.delete('/assignments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bot_outbound_tests WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

return router;
};
