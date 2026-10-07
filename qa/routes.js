// ─── AI Receptionist Testing Platform — HTTP routes ──────────────────────────
// Mounted at /api/qa by server.js.
//
// Three roles, deliberately narrow:
//   qa_admin       full control of rounds, briefs, roster, accounts, export
//   qa_tester      their own queue and submissions, nothing else
//   qa_leadership  read-only dashboard and submissions
// super_admin passes everywhere, matching the rest of the board.

const express = require('express');
const { requireRole } = require('../auth');
const { db, CORE_QUESTIONS, IMPROVEMENT_PROMPT } = require('./db');
const { generateBriefs, MODEL } = require('./generate');
const { planAssignments } = require('./assign');
const { buildCsv, buildPdf } = require('./export');

const ADMIN  = ['super_admin', 'qa_admin'];
const VIEWER = ['super_admin', 'qa_admin', 'qa_leadership'];
const ANY_QA = ['super_admin', 'qa_admin', 'qa_leadership', 'qa_tester'];


// The account configuration a brief should carry. The PRD asks for greeting and
// outro text so testers know what opening and closing language to expect, and
// for model/voice/flags so a model or voice test can be judged against what is
// actually configured rather than what someone assumed.
const ACCOUNT_CONTEXT_COLS = `a.greeting_text, a.outro_text, a.ai_model, a.stt_provider,
  a.tts_provider, a.tts_voice, a.background_noise, a.confirm_answers, a.disambiguation,
  a.capture_intake, a.timezone, a.hours, a.call_flow_notes AS account_flow_notes,
  a.general_notes AS account_notes`;

const router = express.Router();
const j = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

// The tester row for whoever is logged in. Matched on email, which is the one
// identifier the board and the roster genuinely share.
function currentTester(req) {
  const email = String(req.user?.email || '').toLowerCase();
  if (!email) return null;
  return db.prepare('SELECT * FROM testers WHERE lower(email) = ?').get(email) || null;
}

// ─── Context ─────────────────────────────────────────────────────────────────
router.get('/me', requireRole(...ANY_QA), (req, res) => {
  const t = currentTester(req);
  res.json({
    user: { name: req.user?.name, email: req.user?.email, role: req.user?.role },
    tester: t,
    isAdmin:      ADMIN.includes(req.user?.role),
    isLeadership: req.user?.role === 'qa_leadership',
    model: MODEL,
    coreQuestions: CORE_QUESTIONS,
    improvementPrompt: IMPROVEMENT_PROMPT,
  });
});

// ─── Account library ─────────────────────────────────────────────────────────
const ACCOUNT_FIELDS = ['name','account_ref','phone_numbers','greeting_text','outro_text',
  'timezone','hours','capture_intake','confirm_answers','background_noise','ai_model',
  'stt_provider','tts_provider','tts_voice','disambiguation','call_flow_notes','general_notes','active'];

router.get('/accounts', requireRole(...ANY_QA), (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY active DESC, name').all());
});

router.post('/accounts', requireRole(...ADMIN), (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'name is required' });
  const vals = ACCOUNT_FIELDS.map(f => normalise(f, req.body[f]));
  const info = db.prepare(
    `INSERT INTO accounts (${ACCOUNT_FIELDS.join(',')}) VALUES (${ACCOUNT_FIELDS.map(() => '?').join(',')})`
  ).run(...vals);
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/accounts/:id', requireRole(...ADMIN), (req, res) => {
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Account not found' });
  const sets = [], vals = [];
  for (const f of ACCOUNT_FIELDS) {
    if (f in req.body) { sets.push(`${f} = ?`); vals.push(normalise(f, req.body[f])); }
  }
  if (!sets.length) return res.json(existing);
  vals.push(req.params.id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id));
});

router.delete('/accounts/:id', requireRole(...ADMIN), (req, res) => {
  // Soft delete: briefs reference accounts, and a past round must keep showing
  // which account it ran against.
  db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, softDeleted: true });
});

function normalise(field, v) {
  if (['confirm_answers','background_noise','disambiguation','active'].includes(field)) {
    return v === true || v === 1 || v === '1' || v === 'yes' ? 1 : 0;
  }
  return v == null ? null : String(v);
}

router.get('/call-types', requireRole(...ANY_QA), (req, res) => {
  res.json(db.prepare('SELECT * FROM call_types ORDER BY brand, name').all());
});

// ─── Tester roster ───────────────────────────────────────────────────────────
router.get('/testers', requireRole(...VIEWER), (req, res) => {
  res.json(db.prepare('SELECT * FROM testers ORDER BY active DESC, name').all());
});

router.post('/testers', requireRole(...ADMIN), (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const info = db.prepare('INSERT INTO testers (name, email, active) VALUES (?, ?, 1)')
                   .run(String(name), String(email).toLowerCase());
    res.json(db.prepare('SELECT * FROM testers WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already on the roster' });
    throw e;
  }
});

router.put('/testers/:id', requireRole(...ADMIN), (req, res) => {
  const t = db.prepare('SELECT * FROM testers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tester not found' });
  db.prepare('UPDATE testers SET name = ?, email = ?, active = ? WHERE id = ?').run(
    req.body.name ?? t.name,
    (req.body.email ?? t.email).toLowerCase(),
    req.body.active === undefined ? t.active : (req.body.active ? 1 : 0),
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM testers WHERE id = ?').get(req.params.id));
});

router.delete('/testers/:id', requireRole(...ADMIN), (req, res) => {
  db.prepare('UPDATE testers SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, softDeleted: true });
});

// ─── Rounds ──────────────────────────────────────────────────────────────────
router.get('/rounds', requireRole(...VIEWER), (req, res) => {
  res.json(db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM briefs b WHERE b.round_id = r.id)                AS brief_count,
      (SELECT COUNT(*) FROM assignments a WHERE a.round_id = r.id)           AS assignment_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.round_id = r.id)           AS submission_count
    FROM rounds r ORDER BY r.id DESC
  `).all());
});

router.post('/rounds', requireRole(...ADMIN), (req, res) => {
  const name = String(req.body?.name || '').trim() || `Round ${new Date().toISOString().slice(0, 10)}`;
  const info = db.prepare('INSERT INTO rounds (name, dev_notes, created_by) VALUES (?, ?, ?)')
                 .run(name, String(req.body?.dev_notes || ''), req.user?.email || '');
  res.json(db.prepare('SELECT * FROM rounds WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/rounds/:id', requireRole(...VIEWER), (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const briefs = db.prepare(`
    SELECT b.*, ${ACCOUNT_CONTEXT_COLS}
    FROM briefs b LEFT JOIN accounts a ON a.id = b.account_id
    WHERE b.round_id = ? ORDER BY b.seq`).all(req.params.id)
    .map(b => ({ ...b, how_to_run: j(b.how_to_run, []), questions: j(b.questions, []) }));
  res.json({ round, briefs });
});

// Generate briefs from dev notes. Replaces any existing draft briefs for the
// round — regenerating is the expected way to iterate on the notes.
router.post('/rounds/:id/generate', requireRole(...ADMIN), async (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'draft') {
    return res.status(409).json({ error: 'This round is already confirmed — briefs can no longer be regenerated' });
  }
  const notes = String(req.body?.dev_notes ?? round.dev_notes ?? '').trim();
  if (!notes) return res.status(400).json({ error: 'Paste the dev notes first' });

  try {
    const accounts  = db.prepare('SELECT * FROM accounts WHERE active = 1').all();
    const callTypes = db.prepare('SELECT name FROM call_types').all().map(r => r.name);
    const personas  = db.prepare('SELECT call_type, brand, title, persona, note, special_instruction, transfer_capable FROM personas').all();
    const briefs    = await generateBriefs({ notes, accounts, callTypes, personas });

    db.transaction(() => {
      db.prepare('UPDATE rounds SET dev_notes = ? WHERE id = ?').run(notes, round.id);
      db.prepare('DELETE FROM briefs WHERE round_id = ?').run(round.id);
      const ins = db.prepare(`INSERT INTO briefs
        (round_id, seq, title, what_testing, how_to_run, account_id, account_name,
         phone_number, call_notes, questions, call_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const b of briefs) {
        ins.run(round.id, b.seq, b.title, b.what_testing, JSON.stringify(b.how_to_run),
                b.account_id, b.account_name, b.phone_number, b.call_notes,
                JSON.stringify(b.questions), b.call_type);
      }
    })();

    res.json({ ok: true, count: briefs.length,
      briefs: db.prepare('SELECT * FROM briefs WHERE round_id = ? ORDER BY seq').all(round.id)
                .map(b => ({ ...b, how_to_run: j(b.how_to_run, []), questions: j(b.questions, []) })) });
  } catch (err) {
    if (err.code === 'NO_API_KEY') {
      return res.status(503).json({ error: 'Brief generation is unavailable: ANTHROPIC_API_KEY is not set on this server' });
    }
    console.error('[qa] generation failed:', err.message);
    res.status(502).json({ error: 'Generation failed', details: err.message });
  }
});

router.put('/briefs/:id', requireRole(...ADMIN), (req, res) => {
  const b = db.prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Brief not found' });
  const round = db.prepare('SELECT status FROM rounds WHERE id = ?').get(b.round_id);
  if (round.status !== 'draft') return res.status(409).json({ error: 'Round is confirmed — briefs are locked' });

  const acct = req.body.account_id != null
    ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.body.account_id) : null;

  db.prepare(`UPDATE briefs SET title=?, what_testing=?, how_to_run=?, account_id=?,
              account_name=?, phone_number=?, call_notes=?, questions=?, call_type=? WHERE id=?`).run(
    req.body.title        ?? b.title,
    req.body.what_testing ?? b.what_testing,
    JSON.stringify(req.body.how_to_run ?? j(b.how_to_run, [])),
    acct ? acct.id : b.account_id,
    acct ? acct.name : (req.body.account_name ?? b.account_name),
    req.body.phone_number ?? (acct ? String(acct.phone_numbers || '').split(',')[0].trim() : b.phone_number),
    req.body.call_notes   ?? b.call_notes,
    JSON.stringify(req.body.questions ?? j(b.questions, [])),
    req.body.call_type    ?? b.call_type,
    req.params.id
  );
  const out = db.prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id);
  res.json({ ...out, how_to_run: j(out.how_to_run, []), questions: j(out.questions, []) });
});

router.delete('/briefs/:id', requireRole(...ADMIN), (req, res) => {
  const b = db.prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Brief not found' });
  const round = db.prepare('SELECT status FROM rounds WHERE id = ?').get(b.round_id);
  if (round.status !== 'draft') return res.status(409).json({ error: 'Round is confirmed — briefs are locked' });
  db.prepare('DELETE FROM briefs WHERE id = ?').run(req.params.id);
  // Keep numbering contiguous so "TEST 3" means the third test.
  const rest = db.prepare('SELECT id FROM briefs WHERE round_id = ? ORDER BY seq').all(b.round_id);
  const up = db.prepare('UPDATE briefs SET seq = ? WHERE id = ?');
  db.transaction(() => rest.forEach((r, i) => up.run(i + 1, r.id)))();
  res.json({ ok: true });
});

router.post('/rounds/:id/confirm', requireRole(...ADMIN), (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const count = db.prepare('SELECT COUNT(*) c FROM briefs WHERE round_id = ?').get(round.id).c;
  if (!count) return res.status(400).json({ error: 'Nothing to confirm — generate briefs first' });
  db.prepare("UPDATE rounds SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(round.id);
  res.json(db.prepare('SELECT * FROM rounds WHERE id = ?').get(round.id));
});

// ─── Assignment ──────────────────────────────────────────────────────────────
router.post('/rounds/:id/assign', requireRole(...ADMIN), (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status === 'draft') return res.status(409).json({ error: 'Confirm the briefs before assigning' });

  const roster = Array.isArray(req.body?.testers) ? req.body.testers : [];
  if (!roster.length) return res.status(400).json({ error: 'Select at least one tester' });

  const briefs = db.prepare('SELECT id FROM briefs WHERE round_id = ? ORDER BY seq').all(round.id);
  const { plan, unassigned, reason, capacity } = planAssignments({ briefs, testers: roster });

  db.transaction(() => {
    // Re-assigning replaces the previous plan, but only where nothing has been
    // submitted yet — a tester's completed work is never silently discarded.
    const submitted = new Set(db.prepare('SELECT assignment_id FROM submissions WHERE round_id = ?')
                                .all(round.id).map(r => r.assignment_id));
    const existing = db.prepare('SELECT id FROM assignments WHERE round_id = ?').all(round.id);
    const del = db.prepare('DELETE FROM assignments WHERE id = ?');
    for (const a of existing) if (!submitted.has(a.id)) del.run(a.id);

    const ins = db.prepare(`INSERT OR IGNORE INTO assignments
      (round_id, brief_id, tester_id, queue_pos) VALUES (?,?,?,?)`);
    for (const p of plan) ins.run(round.id, p.brief_id, p.tester_id, p.queue_pos);
    db.prepare("UPDATE rounds SET status = 'assigned' WHERE id = ?").run(round.id);
  })();

  const perTester = db.prepare(`
    SELECT t.id, t.name, t.email, COUNT(a.id) AS assigned
    FROM testers t LEFT JOIN assignments a ON a.tester_id = t.id AND a.round_id = ?
    WHERE t.id IN (${roster.map(() => '?').join(',')})
    GROUP BY t.id ORDER BY t.name
  `).all(round.id, ...roster.map(t => t.id));

  res.json({ ok: true, assigned: plan.length, unassigned: unassigned.length, capacity, reason, perTester });
});

// ─── Tester queue ────────────────────────────────────────────────────────────
router.get('/my-queue', requireRole(...ANY_QA), (req, res) => {
  const t = currentTester(req);
  if (!t) return res.json({ tester: null, queue: [], done: 0, total: 0 });

  const rows = db.prepare(`
    SELECT asn.id AS assignment_id, asn.queue_pos, asn.round_id, r.name AS round_name,
           r.status AS round_status, b.*, s.id AS submission_id, s.submitted_at,
           ${ACCOUNT_CONTEXT_COLS}
    FROM assignments asn
    JOIN rounds r ON r.id = asn.round_id
    JOIN briefs b ON b.id = asn.brief_id
    LEFT JOIN accounts a ON a.id = b.account_id
    LEFT JOIN submissions s ON s.assignment_id = asn.id
    WHERE asn.tester_id = ? AND r.status IN ('assigned','confirmed')
    ORDER BY asn.round_id DESC, asn.queue_pos
  `).all(t.id).map(r => ({ ...r, how_to_run: j(r.how_to_run, []), questions: j(r.questions, []) }));

  res.json({
    tester: t,
    queue: rows,
    done:  rows.filter(r => r.submission_id).length,
    total: rows.length,
  });
});

router.post('/assignments/:id/submit', requireRole(...ANY_QA), (req, res) => {
  const t = currentTester(req);
  if (!t) return res.status(403).json({ error: 'You are not on the tester roster' });

  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found' });
  // A tester may only submit their own work, whatever id they post.
  if (a.tester_id !== t.id) return res.status(403).json({ error: 'That assignment belongs to another tester' });
  if (db.prepare('SELECT id FROM submissions WHERE assignment_id = ?').get(a.id)) {
    return res.status(409).json({ error: 'You have already submitted this test' });
  }

  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers submitted' });

  const info = db.prepare(`INSERT INTO submissions
    (assignment_id, round_id, brief_id, tester_id, answers, improvement)
    VALUES (?,?,?,?,?,?)`).run(
      a.id, a.round_id, a.brief_id, t.id,
      JSON.stringify(answers), String(req.body?.improvement || '')
    );
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ─── Submissions review ──────────────────────────────────────────────────────
router.get('/submissions', requireRole(...VIEWER), (req, res) => {
  const where = [], params = [];
  const { round_id, tester_id, account_id, call_type, from, to, flagged } = req.query;
  if (round_id)   { where.push('s.round_id = ?');   params.push(round_id); }
  if (tester_id)  { where.push('s.tester_id = ?');  params.push(tester_id); }
  if (account_id) { where.push('b.account_id = ?'); params.push(account_id); }
  if (call_type)  { where.push('b.call_type = ?');  params.push(call_type); }
  if (from)       { where.push('date(s.submitted_at) >= date(?)'); params.push(from); }
  if (to)         { where.push('date(s.submitted_at) <= date(?)'); params.push(to); }
  if (flagged === '1') where.push('s.flagged = 1');

  const rows = db.prepare(`
    SELECT s.*, b.seq, b.title, b.call_type, b.account_name, b.phone_number,
           t.name AS tester_name, t.email AS tester_email, r.name AS round_name
    FROM submissions s
    JOIN briefs b  ON b.id = s.brief_id
    JOIN testers t ON t.id = s.tester_id
    JOIN rounds r  ON r.id = s.round_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.submitted_at DESC
  `).all(...params);
  res.json(rows.map(r => ({ ...r, answers: j(r.answers, []) })));
});

router.get('/submissions/:id', requireRole(...VIEWER), (req, res) => {
  const r = db.prepare(`
    SELECT s.*, b.seq, b.title, b.what_testing, b.how_to_run, b.call_notes, b.call_type,
           b.account_name, b.phone_number, t.name AS tester_name, t.email AS tester_email,
           ro.name AS round_name
    FROM submissions s
    JOIN briefs b  ON b.id = s.brief_id
    JOIN testers t ON t.id = s.tester_id
    JOIN rounds ro ON ro.id = s.round_id
    WHERE s.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Submission not found' });
  res.json({ ...r, answers: j(r.answers, []), how_to_run: j(r.how_to_run, []) });
});

router.post('/submissions/:id/flag', requireRole(...ADMIN), (req, res) => {
  const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Submission not found' });
  const flagged = req.body?.flagged === undefined ? !s.flagged : (req.body.flagged ? 1 : 0);
  db.prepare('UPDATE submissions SET flagged = ?, flag_note = ? WHERE id = ?')
    .run(flagged ? 1 : 0, String(req.body?.note || s.flag_note || ''), req.params.id);
  res.json(db.prepare('SELECT id, flagged, flag_note FROM submissions WHERE id = ?').get(req.params.id));
});

// ─── Dashboard ───────────────────────────────────────────────────────────────
router.get('/dashboard', requireRole(...VIEWER), (req, res) => {
  const where = [], params = [];
  const { round_id, account_id, call_type, from, to,
          background_noise, disambiguation, ai_model, tts_voice } = req.query;
  if (round_id)   { where.push('s.round_id = ?');   params.push(round_id); }
  if (account_id) { where.push('b.account_id = ?'); params.push(account_id); }
  if (call_type)  { where.push('b.call_type = ?');  params.push(call_type); }
  if (from)       { where.push('date(s.submitted_at) >= date(?)'); params.push(from); }
  if (to)         { where.push('date(s.submitted_at) <= date(?)'); params.push(to); }
  // Filtering by account configuration, so "how did background-noise-on
  // accounts do versus off" is one query rather than a manual cross-reference.
  if (background_noise != null && background_noise !== '') { where.push('acc.background_noise = ?'); params.push(background_noise === '1' ? 1 : 0); }
  if (disambiguation  != null && disambiguation  !== '') { where.push('acc.disambiguation = ?');  params.push(disambiguation === '1' ? 1 : 0); }
  if (ai_model)  { where.push('acc.ai_model = ?');  params.push(ai_model); }
  if (tts_voice) { where.push('acc.tts_voice = ?'); params.push(tts_voice); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const JOIN_ACC = 'LEFT JOIN accounts acc ON acc.id = b.account_id';

  const q = sql => db.prepare(sql).all(...params);
  res.json({
    perRound: q(`SELECT r.id, r.name, r.status, COUNT(s.id) AS submissions
                 FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC} JOIN rounds r ON r.id=s.round_id
                 ${W} GROUP BY r.id ORDER BY r.id DESC`),
    perTest:  q(`SELECT b.id, b.seq, b.title, b.call_type, b.account_name, COUNT(s.id) AS submissions,
                        SUM(s.flagged) AS flagged
                 FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC}
                 ${W} GROUP BY b.id ORDER BY submissions DESC`),
    perTester: q(`SELECT t.id, t.name, COUNT(s.id) AS submissions, SUM(s.flagged) AS flagged
                  FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC} JOIN testers t ON t.id=s.tester_id
                  ${W} GROUP BY t.id ORDER BY submissions DESC`),
    byConfig: q(`SELECT
                   CASE acc.background_noise WHEN 1 THEN 'background noise on' ELSE 'background noise off' END AS bucket,
                   COUNT(s.id) AS submissions, SUM(s.flagged) AS flagged
                 FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC}
                 ${W} GROUP BY acc.background_noise`),
    flagged: q(`SELECT s.id, s.flag_note, s.submitted_at, b.seq, b.title, t.name AS tester_name
                FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC} JOIN testers t ON t.id=s.tester_id
                ${W}${W ? ' AND' : 'WHERE'} s.flagged = 1 ORDER BY s.submitted_at DESC`),
    // Every answer to each core question, grouped, so leadership can read what
    // testers actually said rather than only how many said something.
    answers: aggregateAnswers(q(`SELECT s.answers, s.improvement, t.name AS tester_name, b.seq, b.title
                FROM submissions s JOIN briefs b ON b.id=s.brief_id ${JOIN_ACC} JOIN testers t ON t.id=s.tester_id
                ${W} ORDER BY s.submitted_at DESC`)),
  });
});

// Groups every submitted answer under the question that was asked, so the
// dashboard can show aggregated responses per question rather than only counts.
function aggregateAnswers(rows) {
  const byQuestion = new Map();
  for (const r of rows) {
    for (const a of j(r.answers, [])) {
      if (!a?.question) continue;
      if (!byQuestion.has(a.question)) byQuestion.set(a.question, []);
      byQuestion.get(a.question).push({ answer: a.answer, tester: r.tester_name, seq: r.seq, title: r.title });
    }
    if (r.improvement) {
      const k = IMPROVEMENT_PROMPT;
      if (!byQuestion.has(k)) byQuestion.set(k, []);
      byQuestion.get(k).push({ answer: r.improvement, tester: r.tester_name, seq: r.seq, title: r.title });
    }
  }
  return [...byQuestion.entries()].map(([question, responses]) => ({ question, count: responses.length, responses }));
}

// Per-tester completion for the active round — the "who still owes work" view.
router.get('/rounds/:id/progress', requireRole(...VIEWER), (req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.name, t.email,
           COUNT(a.id) AS assigned,
           COUNT(s.id) AS completed
    FROM assignments a
    JOIN testers t ON t.id = a.tester_id
    LEFT JOIN submissions s ON s.assignment_id = a.id
    WHERE a.round_id = ?
    GROUP BY t.id ORDER BY t.name
  `).all(req.params.id));
});

// ─── Export ──────────────────────────────────────────────────────────────────
router.get('/rounds/:id/export', requireRole(...VIEWER), (req, res) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const rows = db.prepare(`
    SELECT s.*, b.seq, b.title, b.what_testing, b.call_type, b.account_name, b.phone_number,
           t.name AS tester_name, t.email AS tester_email
    FROM submissions s
    JOIN briefs b  ON b.id = s.brief_id
    JOIN testers t ON t.id = s.tester_id
    WHERE s.round_id = ? ORDER BY b.seq, t.name
  `).all(round.id);

  const slug = String(round.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  if ((req.query.format || 'csv') === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.pdf"`);
    return buildPdf({ round, rows, res });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.csv"`);
  res.send(buildCsv({ round, rows }));
});

// ─── Persona scripts ─────────────────────────────────────────────────────────
router.get('/personas', requireRole(...ANY_QA), (req, res) => {
  const rows = db.prepare('SELECT * FROM personas ORDER BY brand, call_type').all();
  res.json(rows.map(r => ({ ...r, answers: j(r.answers, []) })));
});

router.put('/personas/:id', requireRole(...ADMIN), (req, res) => {
  const p = db.prepare('SELECT * FROM personas WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona not found' });
  db.prepare(`UPDATE personas SET title=?, persona=?, opening_line=?, answers=?, note=?,
              special_instruction=?, phone=?, transfer_capable=? WHERE id=?`).run(
    req.body.title ?? p.title, req.body.persona ?? p.persona,
    req.body.opening_line ?? p.opening_line,
    JSON.stringify(req.body.answers ?? j(p.answers, [])),
    req.body.note ?? p.note, req.body.special_instruction ?? p.special_instruction,
    req.body.phone ?? p.phone,
    req.body.transfer_capable === undefined ? p.transfer_capable : (req.body.transfer_capable ? 1 : 0),
    req.params.id
  );
  const out = db.prepare('SELECT * FROM personas WHERE id = ?').get(req.params.id);
  res.json({ ...out, answers: j(out.answers, []) });
});

// ─── Templated intakes ───────────────────────────────────────────────────────
router.get('/intakes', requireRole(...ANY_QA), (req, res) => {
  const rows = db.prepare('SELECT * FROM intakes ORDER BY brand, name').all();
  res.json(rows.map(r => ({ ...r, fields: j(r.fields, []) })));
});

router.put('/intakes/:id', requireRole(...ADMIN), (req, res) => {
  const it = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Intake not found' });
  db.prepare('UPDATE intakes SET name = ?, brand = ?, fields = ?, notes = ? WHERE id = ?').run(
    req.body.name ?? it.name, req.body.brand ?? it.brand,
    JSON.stringify(req.body.fields ?? j(it.fields, [])),
    req.body.notes ?? it.notes, req.params.id
  );
  const out = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  res.json({ ...out, fields: j(out.fields, []) });
});

// ─── Document tabs ───────────────────────────────────────────────────────────
router.get('/docs', requireRole(...ANY_QA), (req, res) => {
  res.json(db.prepare('SELECT * FROM doc_tabs ORDER BY sort').all());
});

router.put('/docs/:slug', requireRole(...ADMIN), (req, res) => {
  const tab = db.prepare('SELECT * FROM doc_tabs WHERE slug = ?').get(req.params.slug);
  if (!tab) return res.status(404).json({ error: 'Tab not found' });
  db.prepare("UPDATE doc_tabs SET body = ?, title = ?, updated_at = datetime('now'), updated_by = ? WHERE slug = ?")
    .run(String(req.body?.body ?? tab.body ?? ''), String(req.body?.title || tab.title), req.user?.email || '', req.params.slug);
  res.json(db.prepare('SELECT * FROM doc_tabs WHERE slug = ?').get(req.params.slug));
});

module.exports = { router, CORE_QUESTIONS };
