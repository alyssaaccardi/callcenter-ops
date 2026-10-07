// ─── Test-brief generation ───────────────────────────────────────────────────
// Turns raw dev-team notes into structured test briefs.
//
// Output comes back through a tool schema rather than as prose we parse. The
// brief has a fixed shape — steps, questions, an account — and scraping that
// out of free text breaks the moment the model reformats a heading. With a
// schema the shape is guaranteed and a malformed response fails loudly here
// rather than silently producing half a brief.

const Anthropic = require('@anthropic-ai/sdk');
const { CORE_QUESTIONS } = require('./db');

// Sonnet 5 — the spec named claude-sonnet-4-6, which is not a real model id.
const MODEL = process.env.QA_GENERATION_MODEL || 'claude-sonnet-5';

const BRIEF_TOOL = {
  name: 'emit_test_briefs',
  description: 'Return the structured test briefs derived from the dev notes.',
  input_schema: {
    type: 'object',
    properties: {
      briefs: {
        type: 'array',
        description: 'One brief per distinct focus area identified in the notes.',
        items: {
          type: 'object',
          properties: {
            title:        { type: 'string', description: 'Short focus-area title, e.g. "Background noise handling".' },
            what_testing: { type: 'string', description: 'One paragraph explaining what this test is probing and why.' },
            how_to_run:   { type: 'array', items: { type: 'string' }, description: '3-6 concrete steps the tester follows on the call.' },
            call_notes:   { type: 'string', description: 'Behavioural instructions specific to this test — how the tester should act on the call.' },
            call_type:    { type: 'string', description: 'Best-matching call type from the supplied list, or empty if none fits.' },
            account_id:   { type: ['integer', 'null'], description: 'id of the most suitable account from the library, or null if none is clearly suitable.' },
            account_reason: { type: 'string', description: 'One short sentence on why that account suits this test.' },
            extra_questions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 2 feedback questions specific to THIS test. The six core questions are added automatically — do not repeat them.',
            },
          },
          required: ['title', 'what_testing', 'how_to_run', 'call_notes'],
        },
      },
    },
    required: ['briefs'],
  },
};

function buildPrompt({ notes, accounts, callTypes, personas = [] }) {
  const accountLines = accounts.length
    ? accounts.map(a => {
        const flags = [
          a.background_noise ? 'background noise ON' : 'background noise off',
          a.confirm_answers  ? 'confirm answers ON'  : 'confirm answers off',
          a.disambiguation   ? 'disambiguation configured' : 'no disambiguation',
          a.capture_intake ? `intake: ${a.capture_intake}` : null,
          a.ai_model ? `model: ${a.ai_model}` : null,
          a.stt_provider ? `STT: ${a.stt_provider}` : null,
          a.tts_provider ? `TTS: ${a.tts_provider}${a.tts_voice ? ` (${a.tts_voice})` : ''}` : null,
        ].filter(Boolean).join(', ');
        return `- id=${a.id} "${a.name}" — ${flags}${a.call_flow_notes ? `. Flow: ${a.call_flow_notes}` : ''}`;
      }).join('\n')
    : '(no accounts configured yet — return account_id as null)';

  // Scripts already written for each call type. A brief that matches one should
  // build on it rather than inventing a second, competing persona for the same
  // call type — testers work from these.
  const personaLines = personas.length
    ? personas.map(p => `- ${p.call_type} (${p.brand})${p.transfer_capable ? ' [transfer-capable]' : ''}: ${p.persona}`
        + (p.special_instruction ? ` NOTE: ${p.special_instruction}` : '')).join('\n')
    : '(none yet)';

  return `You are preparing QA test briefs for an AI phone receptionist product.

Below are raw notes from the dev team about what changed and what needs testing.
Identify each distinct focus area that warrants its own test, and produce one
brief per focus area. Do not invent focus areas the notes do not support, and do
not merge two genuinely separate concerns into one brief.

Match each brief to the most suitable test account from the library. The account
must actually suit the test: a background-noise test belongs on an account with
background noise enabled, a disambiguation test on an account with
disambiguation configured, and so on. If nothing in the library fits, return
null rather than forcing a poor match.

<dev_notes>
${notes}
</dev_notes>

<account_library>
${accountLines}
</account_library>

<call_types>
${callTypes.join(', ')}
</call_types>

<existing_persona_scripts>
${personaLines}
</existing_persona_scripts>

Where a brief covers a call type that already has a persona script, build on
that script — keep the caller's situation consistent with it and put the new
behaviour being tested into the call notes. Do not invent a second, competing
persona for a call type that already has one.

Write "how to run" steps a tester can follow without training: concrete actions
on the call, not abstract goals. Write call notes that tell the tester how to
behave — accent, pace, interruptions, background, what to withhold or volunteer.`;
}

async function generateBriefs({ notes, accounts = [], callTypes = [], personas = [] }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not configured on this server');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [BRIEF_TOOL],
    // Force the tool so we never get prose back instead of structure.
    tool_choice: { type: 'tool', name: 'emit_test_briefs' },
    messages: [{ role: 'user', content: buildPrompt({ notes, accounts, callTypes, personas }) }],
  });

  const block = msg.content.find(c => c.type === 'tool_use' && c.name === 'emit_test_briefs');
  if (!block) throw new Error('Model did not return structured briefs');

  const accountById = new Map(accounts.map(a => [a.id, a]));

  return (block.input.briefs || []).map((b, i) => {
    const acct = b.account_id != null ? accountById.get(b.account_id) : null;
    return {
      seq:          i + 1,
      title:        b.title,
      what_testing: b.what_testing,
      how_to_run:   Array.isArray(b.how_to_run) ? b.how_to_run : [],
      call_notes:   b.call_notes || '',
      call_type:    b.call_type || '',
      account_id:   acct ? acct.id : null,
      account_name: acct ? acct.name : '',
      // First listed number; admin can edit before confirming.
      phone_number: acct ? String(acct.phone_numbers || '').split(',')[0].trim() : '',
      account_reason: b.account_reason || '',
      // Core six always present and always last, so every round stays
      // comparable; test-specific questions go in front of them.
      questions: [...(b.extra_questions || []).slice(0, 2), ...CORE_QUESTIONS],
    };
  });
}

module.exports = { generateBriefs, MODEL, BRIEF_TOOL };
