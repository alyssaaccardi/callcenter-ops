const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('./db');

const router = express.Router();
const CLICK_WINDOW_MINUTES = 90;

const digits = value => String(value || '').replace(/\D/g, '').slice(-10);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

function secretMatches(req) {
  const expected = process.env.KIXIE_WEBHOOK_SECRET;
  if (!expected) return false;
  const given = String(req.get('x-kixie-secret') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Kixie "End Call" webhook: attach the call (and recording) to the matching open outbound test.
router.post('/webhook', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  if (!secretMatches(req)) return res.status(401).json({ error: 'Unauthorized' });
  const details = req.body?.data?.callDetails;
  if (!details || (req.body?.data?.hookevent && req.body.data.hookevent !== 'endcall')) return res.json({ ok: true, matched: false });

  const callId = String(details.callid || details.externalid || '').slice(0, 100);
  const agentEmail = String(details.email || '').trim().toLowerCase();
  const dialed = digits(details.tonumber164 || details.tonumber);
  const startedAt = details.calldate ? new Date(details.calldate) : new Date();
  if (!callId || !agentEmail || !dialed || String(details.calltype || 'outgoing') !== 'outgoing') return res.json({ ok: true, matched: false });

  const candidates = db.prepare(`SELECT * FROM bot_outbound_tests WHERE agent_email = ? AND status != 'reviewed' ORDER BY id DESC`)
    .all(agentEmail).filter(test => digits(test.phone) === dialed);
  if (!candidates.length) return res.json({ ok: true, matched: false });
  if (candidates.some(test => parse(test.calls, []).some(call => call.call_id === callId))) return res.json({ ok: true, matched: true, duplicate: true });

  // Prefer the test whose Call button the agent pressed most recently, else the oldest open one for that number.
  let chosen = null;
  let variant = '';
  let bestClick = 0;
  for (const test of candidates) {
    const click = db.prepare(`SELECT details, created_at FROM bot_outbound_events WHERE test_id = ? AND event_type = 'call_clicked'
      ORDER BY id DESC LIMIT 1`).get(test.id);
    if (!click) continue;
    const clickedAt = new Date(`${click.created_at.replace(' ', 'T')}Z`).getTime();
    if (startedAt.getTime() - clickedAt > CLICK_WINDOW_MINUTES * 60_000 || clickedAt > startedAt.getTime() + 60_000) continue;
    if (clickedAt > bestClick) { bestClick = clickedAt; chosen = test; variant = parse(click.details, {}).variant || ''; }
  }
  if (!chosen) chosen = [...candidates].reverse().find(test => test.status === 'assigned') || candidates[0];

  const call = {
    call_id: callId,
    variant,
    called_at: startedAt.toISOString(),
    answered_at: details.answerDate || '',
    ended_at: details.callEndDate || '',
    duration_seconds: Number(details.duration) || 0,
    status: String(details.callstatus || ''),
    disposition: String(details.disposition || ''),
    from_number: String(details.fromnumber || ''),
    to_number: String(details.tonumber || ''),
    agent: [details.fname, details.lname].filter(Boolean).join(' ') || agentEmail,
    recording_url: /^https:\/\//i.test(details.recordingurl || '') ? details.recordingurl : '',
  };
  const calls = [...parse(chosen.calls, []), call];
  db.transaction(() => {
    db.prepare("UPDATE bot_outbound_tests SET calls = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(calls), chosen.id);
    db.prepare('INSERT INTO bot_outbound_events (test_id, actor_email, actor_name, event_type, details) VALUES (?, ?, ?, ?, ?)')
      .run(chosen.id, agentEmail, call.agent, 'kixie_call', JSON.stringify({
        variant, call_id: callId, duration_seconds: call.duration_seconds, status: call.status, recorded: !!call.recording_url,
      }));
  })();
  res.json({ ok: true, matched: true, test_id: chosen.id });
});

module.exports = router;
