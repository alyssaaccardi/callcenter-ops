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
  assert.equal(flags[0].label, 'No caller audio');
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
