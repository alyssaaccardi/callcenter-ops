// Derives QA risk flags from a Staff API call detail. Pure: no I/O.
// Low flags show a badge but do not raise queue priority.
const SEVERITY = { high: 2, medium: 1, low: 0 };

const LEG_OUTCOME_FLAGS = {
  failed: { code: 'transfer_failed', severity: 'high', label: 'Transfer failed', help: 'The bot tried to connect the caller to a person and the connection failed. The caller may have been left without help. Listen to how the call ended.' },
  declined: { code: 'transfer_declined', severity: 'medium', label: 'Transfer declined', help: 'The person the bot tried to reach rejected the transfer. Check whether the caller was told what happens next.' },
  no_answer: { code: 'transfer_no_answer', severity: 'medium', label: 'Transfer: no answer', help: 'The bot called the transfer number and nobody picked up. Check whether the caller was offered a callback or voicemail.' },
  voicemail: { code: 'transfer_voicemail', severity: 'medium', label: 'Transfer hit voicemail', help: 'The transfer reached a voicemail box instead of a person. Check that the caller was not left talking to a mailbox.' },
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
      ? [{ code: 'transfer_possible_voicemail', severity: 'medium', label: 'Transfer may have hit voicemail', help: 'The transfer connected, but the system did not hear a live person. Listen to confirm the caller reached someone.', detail: 'No person detected on the transfer.' }]
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
    flags.push({ code: 'transfer_not_connected', severity: 'medium', label: 'Transfer never connected', help: 'The bot tried to transfer the caller but no connection was made. Listen to see what the caller was told.', detail: '' });
  }
  return flags;
}

function riskLevel(flags) {
  return flags.reduce((level, flag) => Math.max(level, SEVERITY[flag.severity] || 0), 0);
}

const FAULTS = {
  media_timeout: { label: 'Call failed: no caller audio', help: 'The system never received audio from the caller, so the bot could not hear them. The recording may be silent.' },
  did_not_found: { label: 'Call failed: number not recognized', help: 'The dialed phone number is not set up in the system, so the bot could not answer as a firm.' },
  config_unavailable: { label: 'Call failed: account setup missing', help: "The firm's settings could not be loaded, so the bot could not follow its instructions." },
  error: { label: 'Call failed: system error', help: 'The platform hit an error during this call. Listen for anything the caller noticed.' },
};

const SLOW_REPLY_MS = Number(process.env.AI_BOT_QC_SLOW_REPLY_MS) || 5000;

const LOW_CONFIDENCE = Number(process.env.AI_BOT_QC_LOW_CONFIDENCE) || 0.65;
const LONG_CALL_SECONDS = Number(process.env.AI_BOT_QC_LONG_CALL_SECONDS) || 1800;
const LEAD_STUCK_MINUTES = 15;

const wallSeconds = call => {
  const start = Date.parse(call.started_at);
  const end = Date.parse(call.ended_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
};

// Flags that come from the call list row (no extra request): faults, replies, intake, classification and billing.
function diagnosticFlags(call) {
  if (!call || !call.ended_at) return [];
  const flags = [];
  const diagnostics = call.diagnostics;
  const outcome = diagnostics?.outcome;
  if (outcome?.fault) {
    const fault = FAULTS[outcome.kind] || { label: 'Call failed', help: 'The platform counted this call as a fault.' };
    flags.push({ code: 'fault', severity: 'high', ...fault, detail: outcome.detail || '' });
  }
  if (Number(call.failed_action_count) > 0) {
    flags.push({ code: 'failed_action', severity: 'medium', label: 'Bot action failed', help: 'Something the bot tried to do during the call (such as sending a message or a lead) did not work.', detail: `${call.failed_action_count} action(s) reported failure` });
  }
  const p95 = diagnostics?.voice_to_voice_p95_ms;
  if (Number.isFinite(p95) && p95 > SLOW_REPLY_MS) {
    flags.push({ code: 'slow_replies', severity: 'medium', label: 'Bot was slow to reply', help: 'The caller waited a long time for the bot to answer, which can sound like dead air. Listen for long pauses.', detail: `Callers waited ${(p95 / 1000).toFixed(1)} seconds or more on most turns.` });
  }
  if (diagnostics?.ended_prematurely) {
    flags.push({ code: 'ended_early', severity: 'low', label: 'Call ended early', help: 'The call ended before the conversation was finished, for example the caller hung up mid-intake. For information only.', detail: outcome?.kind ? `Why it ended: ${outcome.kind.replace(/_/g, ' ')}` : '' });
  }
  const missing = diagnostics?.missing_required?.count;
  if (missing > 0) {
    flags.push({ code: 'intake_gaps', severity: 'low', label: `Missing info (${missing} ${missing === 1 ? 'question' : 'questions'})`, help: 'The bot did not collect every required intake answer. For information only; check whether the bot asked and the caller refused, or the bot skipped it.', detail: `Not answered: ${(diagnostics.missing_required.field_ids || []).join(', ')}` });
  }
  if (call.kind === 'inbound' && !call.internal_only && !call.classification) {
    flags.push({ code: 'unclassified', severity: 'medium', label: 'Call type not identified', help: 'The system could not decide what kind of call this was (for example new client or existing client), which affects billing. Listen and note the right type.', detail: '' });
  }

  const wall = wallSeconds(call);
  const billed = call.billed_duration_seconds;
  if (wall != null && Number.isFinite(billed) && Math.abs(billed - wall) > 2) {
    flags.push({ code: 'billing_edited', severity: 'medium', label: 'Billed time differs from call time', help: 'The length this call is billed for does not match how long it actually lasted, usually because someone edited it. Confirm the change is correct.', detail: `Billed ${billed} seconds, call lasted ${wall} seconds.` });
  }
  if (wall != null && wall > LONG_CALL_SECONDS) {
    flags.push({ code: 'long_call', severity: 'low', label: 'Very long call', help: 'This call lasted much longer than a typical call. For information only; check it was a real conversation and not a stuck line.', detail: `${Math.round(wall / 60)} minutes.` });
  }
  const agentMs = diagnostics?.agent_duration_ms;
  if (wall != null && Number.isFinite(agentMs) && wall - agentMs / 1000 > 120) {
    flags.push({ code: 'ran_past_hangup', severity: 'medium', label: 'Call stayed open after hang-up', help: 'The line stayed open well after the conversation ended, which may bill extra minutes. Check the end of the recording.', detail: `Call lasted ${wall} seconds but the bot measured ${Math.round(agentMs / 1000)} seconds.` });
  }
  return flags;
}

// Flags that need the call detail: classification confidence and call type changes.
function detailFlags(call) {
  if (!call || !call.ended_at) return [];
  const flags = [];
  const detail = call.classification_detail;
  if (detail) {
    const percent = Number.isFinite(detail.confidence) ? Math.round(detail.confidence * 100) : null;
    if (detail.needs_review || (percent != null && detail.confidence < LOW_CONFIDENCE)) {
      flags.push({ code: 'low_confidence', severity: 'medium', label: 'Unsure of call type', help: 'The system was not confident about what kind of call this was, which affects billing. Listen and confirm the call type.', detail: percent != null ? `Only ${percent}% sure.` : 'The system marked this call for review.' });
    }
  }
  const corrections = call.diagnostics?.call_type_decision?.corrections;
  if (Array.isArray(corrections) && corrections.length) {
    flags.push({ code: 'call_type_changed', severity: 'low', label: 'Call type changed mid-call', help: 'The bot first thought this was one kind of call, then changed its mind. For information only; check the final type is right.', detail: corrections.map(c => `${c.from} to ${c.to}`).join('; ') });
  }
  if (Number.isFinite(call.duration_override_seconds)) {
    flags.push({ code: 'billing_override', severity: 'medium', label: 'Billing time edited by admin', help: "An admin typed in a billed length for this call instead of using the real one. Confirm there is a reason for it.", detail: `Billed length set to ${call.duration_override_seconds} seconds.` });
  }
  return flags;
}

// Lead delivery, from GET /v1/calls/{id}/lead. `recheck` is true while a pending delivery may still complete.
function leadFlags(call, lead) {
  const result = { flags: [], recheck: false };
  if (!call?.ended_at || !lead || !Array.isArray(lead.destinations)) return result;
  const ageMinutes = (Date.now() - Date.parse(call.ended_at)) / 60000;
  const failed = lead.destinations.filter(d => d.status === 'failed');
  const pending = lead.destinations.filter(d => d.status === 'pending');
  if (failed.length) {
    const permanent = failed.some(d => d.permanent);
    result.flags.push({
      code: 'lead_failed',
      severity: permanent ? 'high' : 'medium',
      label: permanent ? "Lead can't be delivered" : 'Lead not delivered',
      help: permanent ? "The caller's details could not be sent to the firm and the system will not retry. Someone must send them by hand." : "The caller's details were not sent to the firm. The system will try again, so check back later.",
      detail: failed.map(d => `${d.type || d.name || 'destination'}: ${d.error || 'failed'}`).join('; '),
    });
  }
  if (pending.length) {
    if (ageMinutes >= LEAD_STUCK_MINUTES) {
      result.flags.push({ code: 'lead_pending', severity: 'medium', label: 'Lead not sent yet', help: "The caller's details have not been sent to the firm and are taking too long. Check the lead was delivered.", detail: `Still not sent ${Math.round(ageMinutes)} minutes after the call.` });
    }
    result.recheck = ageMinutes < 120;
  }
  return result;
}

function callRiskFlags(call) {
  return [...diagnosticFlags(call), ...detailFlags(call), ...transferRiskFlags(call)];
}

module.exports = { transferRiskFlags, diagnosticFlags, detailFlags, leadFlags, callRiskFlags, riskLevel };
