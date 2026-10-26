const test = require('node:test');
const assert = require('node:assert/strict');
const { transferRiskFlags, riskLevel } = require('./call-risk');

const caller = { outcome: null };
const base = { ended_at: '2026-10-01T10:00:00Z', transfer: { attempted: true, type: 'warm', answered: true } };

test('no transfer means no flags', () => {
  assert.deepEqual(transferRiskFlags({ ended_at: '2026-10-01T10:00:00Z', transfer: { attempted: false }, legs: [caller] }), []);
});

test('in-progress calls are skipped', () => {
  assert.deepEqual(transferRiskFlags({ ...base, ended_at: null, legs: [caller, { outcome: 'failed' }] }), []);
});

test('a bridged transfer is healthy', () => {
  assert.deepEqual(transferRiskFlags({ ...base, legs: [caller, { outcome: 'bridged' }] }), []);
});

test('bridged but voicemail detector heard no person is flagged', () => {
  const flags = transferRiskFlags({ ...base, transfer: { attempted: true, answered: false }, legs: [caller, { outcome: 'bridged' }] });
  assert.equal(flags[0].code, 'transfer_possible_voicemail');
});

test('failed, declined, unanswered and voicemail outcomes are flagged', () => {
  const legs = [caller, { outcome: 'declined', target_id: 'a', decline_reason: 'busy' }, { outcome: 'no_answer', target_id: 'b' },
    { outcome: 'voicemail', target_id: 'c' }, { outcome: 'failed', target_id: 'd' }];
  const flags = transferRiskFlags({ ...base, legs });
  assert.deepEqual(flags.map(f => f.code), ['transfer_declined', 'transfer_no_answer', 'transfer_voicemail', 'transfer_failed']);
  assert.equal(flags[0].detail, 'Reason: busy');
  assert.equal(riskLevel(flags), 2);
});

test('rang-for is derived from leg timestamps', () => {
  const flags = transferRiskFlags({ ...base, legs: [caller, { outcome: 'declined', dialed_at: '2026-10-01T09:59:00Z', answered_at: '2026-10-01T09:59:12Z' }] });
  assert.equal(flags[0].rang_for_seconds, 12);
});

test('attempted transfer with no usable legs is still flagged', () => {
  const flags = transferRiskFlags({ ...base, legs: [caller] });
  assert.equal(flags[0].code, 'transfer_not_connected');
  assert.equal(riskLevel(flags), 1);
});

test('end-of-call report flags: fault, slow replies, early end, intake gaps', () => {
  const { callRiskFlags } = require('./call-risk');
  const call = {
    ended_at: '2026-10-25T14:03:00Z',
    failed_action_count: 1,
    diagnostics: { outcome: { kind: 'media_timeout', fault: true }, voice_to_voice_p95_ms: 6200, ended_prematurely: true, missing_required: { count: 2, field_ids: ['a', 'b'] } },
  };
  const flags = callRiskFlags(call);
  assert.deepEqual(flags.map(f => f.code), ['fault', 'failed_action', 'slow_replies', 'ended_early', 'intake_gaps']);
  assert.equal(flags[0].label, 'Call failed: no caller audio');
  assert.equal(riskLevel(flags), 2);
});

test('low-severity flags do not raise priority and healthy calls are clean', () => {
  const { callRiskFlags } = require('./call-risk');
  const low = callRiskFlags({ ended_at: 'x', diagnostics: { ended_prematurely: true, voice_to_voice_p95_ms: 2000 } });
  assert.deepEqual(low.map(f => f.code), ['ended_early']);
  assert.equal(riskLevel(low), 0);
  assert.deepEqual(callRiskFlags({ ended_at: 'x', diagnostics: { voice_to_voice_p95_ms: 4000, missing_required: { count: 0 } } }), []);
  assert.deepEqual(callRiskFlags({ diagnostics: { outcome: { fault: true } } }), []);
});

test('classification, billing and list-level flags', () => {
  const { callRiskFlags } = require('./call-risk');
  const row = { kind: 'inbound', started_at: '2026-10-25T14:00:00Z', ended_at: '2026-10-25T14:02:00Z', classification: null, billed_duration_seconds: 300 };
  assert.deepEqual(callRiskFlags(row).map(f => f.code), ['unclassified', 'billing_edited']);
  const clean = { ...row, classification: 'divorce', billed_duration_seconds: 120 };
  assert.deepEqual(callRiskFlags(clean), []);
  const long = { ...clean, ended_at: '2026-10-25T15:00:00Z', billed_duration_seconds: 3600 };
  assert.deepEqual(callRiskFlags(long).map(f => f.code), ['long_call']);
  const detail = { ...clean, duration_override_seconds: 60, billed_duration_seconds: 120, classification_detail: { confidence: 0.5, needs_review: false }, diagnostics: { call_type_decision: { corrections: [{ from: 'a', to: 'b' }] } } };
  assert.deepEqual(callRiskFlags(detail).map(f => f.code), ['low_confidence', 'call_type_changed', 'billing_override']);
  assert.deepEqual(callRiskFlags({ ...clean, classification_detail: { confidence: 0.98, needs_review: false } }), []);
});

test('lead delivery flags', () => {
  const { leadFlags } = require('./call-risk');
  const ended = new Date(Date.now() - 30 * 60000).toISOString();
  const call = { ended_at: ended };
  const failed = leadFlags(call, { destinations: [{ type: 'email', status: 'failed', permanent: true, error: 'bounced' }, { status: 'delivered' }] });
  assert.equal(failed.flags[0].code, 'lead_failed');
  assert.equal(failed.flags[0].severity, 'high');
  const retry = leadFlags(call, { destinations: [{ status: 'failed', permanent: false, error: 'timeout' }] });
  assert.equal(retry.flags[0].severity, 'medium');
  const stuck = leadFlags(call, { destinations: [{ status: 'pending' }] });
  assert.deepEqual(stuck.flags.map(f => f.code), ['lead_pending']);
  assert.equal(stuck.recheck, true);
  const fresh = leadFlags({ ended_at: new Date().toISOString() }, { destinations: [{ status: 'pending' }] });
  assert.deepEqual(fresh.flags, []);
  assert.equal(fresh.recheck, true);
  assert.deepEqual(leadFlags(call, null).flags, []);
  assert.deepEqual(leadFlags(call, { destinations: [{ status: 'delivered' }, { status: 'disabled' }] }).flags, []);
});
