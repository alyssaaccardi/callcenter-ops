// Derives QA risk flags from a Staff API call detail. Pure: no I/O.
// Low flags show a badge but do not raise queue priority.
const SEVERITY = { high: 2, medium: 1, low: 0 };

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

const FAULT_LABELS = {
  media_timeout: 'No caller audio',
  did_not_found: 'DID not recognized',
  config_unavailable: 'Account configuration unavailable',
  error: 'Call error',
};

const SLOW_REPLY_MS = Number(process.env.AI_BOT_QC_SLOW_REPLY_MS) || 5000;

// Flags that come from the end-of-call report, present on both list rows and call detail.
function diagnosticFlags(call) {
  if (!call || !call.ended_at) return [];
  const flags = [];
  const diagnostics = call.diagnostics;
  const outcome = diagnostics?.outcome;
  if (outcome?.fault) {
    flags.push({ code: 'fault', severity: 'high', label: FAULT_LABELS[outcome.kind] || 'Call fault', detail: outcome.detail || outcome.kind || '' });
  }
  if (Number(call.failed_action_count) > 0) {
    flags.push({ code: 'failed_action', severity: 'medium', label: 'Failed bot action', detail: `${call.failed_action_count} action(s) reported failure` });
  }
  const p95 = diagnostics?.voice_to_voice_p95_ms;
  if (Number.isFinite(p95) && p95 > SLOW_REPLY_MS) {
    flags.push({ code: 'slow_replies', severity: 'medium', label: 'Slow replies', detail: `Callers waited ${(p95 / 1000).toFixed(1)}s on 95% of turns` });
  }
  if (diagnostics?.ended_prematurely) {
    flags.push({ code: 'ended_early', severity: 'low', label: 'Ended early', detail: outcome?.kind ? `Outcome: ${outcome.kind}` : '' });
  }
  const missing = diagnostics?.missing_required?.count;
  if (missing > 0) {
    flags.push({ code: 'intake_gaps', severity: 'low', label: `Intake incomplete (${missing} missing)`, detail: (diagnostics.missing_required.field_ids || []).join(', ') });
  }
  return flags;
}

function callRiskFlags(call) {
  return [...diagnosticFlags(call), ...transferRiskFlags(call)];
}

module.exports = { transferRiskFlags, diagnosticFlags, callRiskFlags, riskLevel };
