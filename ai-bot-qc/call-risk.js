// Derives QA risk flags from a Staff API call detail. Pure: no I/O.
const SEVERITY = { high: 2, medium: 1 };

const LEG_OUTCOME_FLAGS = {
  failed: { code: 'transfer_failed', severity: 'high', label: 'Transfer failed' },
  declined: { code: 'transfer_declined', severity: 'medium', label: 'Transfer declined' },
  no_answer: { code: 'transfer_no_answer', severity: 'medium', label: 'Transfer not answered' },
  voicemail: { code: 'transfer_voicemail', severity: 'medium', label: 'Transfer went to voicemail' },
};

function secondsBetween(from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
}

function transferRiskFlags(call) {
  if (!call || !call.ended_at) return [];
  const legs = Array.isArray(call.legs) ? call.legs : [];
  const targets = legs.slice(1); // the first leg is the caller
  if (!call.transfer?.attempted && !targets.length) return [];

  if (targets.some(leg => leg.outcome === 'bridged')) {
    // `answered` is the voicemail detector hearing a person; false on a connected transfer suggests a mailbox.
    return call.transfer?.answered === false
      ? [{ code: 'transfer_possible_voicemail', severity: 'medium', label: 'Transfer connected but no person detected', detail: 'The voicemail detector did not hear a person.' }]
      : [];
  }

  const flags = [];
  const seen = new Set();
  for (const leg of targets) {
    const def = LEG_OUTCOME_FLAGS[leg.outcome];
    if (!def) continue;
    const key = `${def.code}:${leg.target_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({
      ...def,
      detail: leg.decline_reason ? `Reason: ${leg.decline_reason}` : '',
      target_id: leg.target_id || null,
      rang_for_seconds: secondsBetween(leg.dialed_at, leg.answered_at),
    });
  }
  if (!flags.length) {
    flags.push({ code: 'transfer_not_connected', severity: 'medium', label: 'Transfer attempted but never connected', detail: '' });
  }
  return flags;
}

function riskLevel(flags) {
  return flags.reduce((level, flag) => Math.max(level, SEVERITY[flag.severity] || 0), 0);
}

module.exports = { transferRiskFlags, riskLevel };
