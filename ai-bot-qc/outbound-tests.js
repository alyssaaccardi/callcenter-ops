const express = require('express');
const { listUsers } = require('../auth');
const { db } = require('./db');
const seeds = require('./outbound-seeds');

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

if (!db.prepare('SELECT COUNT(*) AS n FROM bot_outbound_test_types').get().n) {
  const insert = db.prepare(`INSERT INTO bot_outbound_test_types
    (title, objective, steps, call_notes, variants, questions, improvement_prompt, default_targets)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of seeds) {
    insert.run(t.title, t.objective, JSON.stringify(t.steps), t.call_notes, JSON.stringify(t.variants),
      JSON.stringify(t.questions), t.improvement_prompt, JSON.stringify(t.default_targets));
  }
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
    default_targets: parse(row.default_targets, []), active: !!row.active,
  };
}
function testOut(row, type) {
  return {
    id: row.id, type_id: row.type_id, type: type ? typeOut(type) : null, agent_email: row.agent_email, agent_name: row.agent_name,
    account: row.account, phone: row.phone, contact: row.contact, scenarios: parse(row.scenarios, {}), due_date: row.due_date,
    status: row.status, answers: parse(row.answers, {}), improvement: row.improvement, calls: parse(row.calls, []),
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
  const targets = (Array.isArray(body.default_targets) ? body.default_targets : []).slice(0, 50)
    .map(cleanTarget).filter(t => t.account && t.phone);
  return {
    value: {
      title, objective: str(body.objective, 3000), steps: list(body.steps, 500), call_notes: str(body.call_notes, 3000),
      variants: variants.length ? variants : ['Call'], questions, improvement_prompt: str(body.improvement_prompt, 500),
      default_targets: targets,
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

router.get('/types', (req, res) => {
  const rows = db.prepare('SELECT * FROM bot_outbound_test_types WHERE active = 1 ORDER BY id').all();
  res.json({ types: rows.map(typeOut) });
});

function saveType(req, res, id) {
  const { value, error } = cleanType(req.body || {});
  if (error) return res.status(400).json({ error });
  const params = [value.title, value.objective, JSON.stringify(value.steps), value.call_notes, JSON.stringify(value.variants),
    JSON.stringify(value.questions), value.improvement_prompt, JSON.stringify(value.default_targets)];
  if (id) {
    db.prepare(`UPDATE bot_outbound_test_types SET title=?, objective=?, steps=?, call_notes=?, variants=?, questions=?,
      improvement_prompt=?, default_targets=?, updated_at=datetime('now') WHERE id=?`).run(...params, id);
  } else {
    id = db.prepare(`INSERT INTO bot_outbound_test_types (title, objective, steps, call_notes, variants, questions,
      improvement_prompt, default_targets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...params).lastInsertRowid;
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

router.get('/assignments/:id', (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
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

router.post('/assignments/:id/call-click', (req, res) => {
  const row = visibleTest(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Test not found' });
  addEvent(row.id, actorFor(req), 'call_clicked', { variant: str(req.body?.variant, 80), phone: row.phone });
  res.json({ ok: true });
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
  if (submit) addEvent(row.id, actorFor(req), 'submitted');
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

module.exports = router;
