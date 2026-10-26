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
