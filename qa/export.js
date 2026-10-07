// ─── Round export ────────────────────────────────────────────────────────────
// CSV for spreadsheets, PDF for sending straight to the dev team. Both are
// organised by test rather than by tester: the dev team reads these asking
// "what did people find about feature X", not "what did Dana do".

const PDFDocument = require('pdfkit');
const { IMPROVEMENT_PROMPT } = require('./db');

// The closing item lives in its own column on the submission rather than among
// the answers, so every exporter has to append it explicitly or it silently
// goes missing — and it is the one answer the dev team most wants to read.
function answerRows(sub) {
  const rows = safeJson(sub.answers, []).map(a => ({ question: a.question, answer: a.answer }));
  if (sub.improvement) rows.push({ question: IMPROVEMENT_PROMPT, answer: sub.improvement });
  return rows;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Quote when the value contains anything that would break a row, and double
  // any embedded quotes. A tester's answer routinely contains commas and
  // newlines, so this is the common case, not the edge case.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv({ round, rows }) {
  const out = [];
  out.push(['Round', 'Test #', 'Test Title', 'Call Type', 'Account', 'Phone',
            'Tester', 'Tester Email', 'Submitted', 'Flagged', 'Question', 'Answer']
           .map(csvCell).join(','));
  for (const r of rows) {
    const answers = answerRows(r);
    if (!answers.length) {
      out.push([round.name, r.seq, r.title, r.call_type, r.account_name, r.phone_number,
                r.tester_name, r.tester_email, r.submitted_at, r.flagged ? 'YES' : '', '', '']
               .map(csvCell).join(','));
      continue;
    }
    // One row per question keeps the file pivot-friendly; repeating the test
    // and tester columns is deliberate so each row stands alone when sorted.
    for (const a of answers) {
      out.push([round.name, r.seq, r.title, r.call_type, r.account_name, r.phone_number,
                r.tester_name, r.tester_email, r.submitted_at, r.flagged ? 'YES' : '',
                a.question, a.answer].map(csvCell).join(','));
    }
  }
  return out.join('\r\n');
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function buildPdf({ round, rows, res }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(18).text('AI Receptionist Testing');
  doc.font('Helvetica').fontSize(12).fillColor('#444')
     .text(`${round.name}  ·  exported ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  doc.moveDown(0.5);
  doc.fillColor('#000').fontSize(10)
     .text(`${rows.length} submission${rows.length === 1 ? '' : 's'}`);
  doc.moveDown(1);

  // Group by test so the dev team reads all feedback on one focus area
  // together rather than jumping between tests.
  const byBrief = new Map();
  for (const r of rows) {
    if (!byBrief.has(r.brief_id)) byBrief.set(r.brief_id, { brief: r, subs: [] });
    byBrief.get(r.brief_id).subs.push(r);
  }

  let first = true;
  for (const { brief, subs } of byBrief.values()) {
    if (!first) doc.addPage();
    first = false;

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
       .text(`TEST ${brief.seq} — ${brief.title}`);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#555')
       .text([brief.call_type, brief.account_name, brief.phone_number].filter(Boolean).join('  ·  '));
    doc.moveDown(0.6);

    if (brief.what_testing) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text("What you're testing:");
      doc.font('Helvetica').fontSize(10).fillColor('#222').text(brief.what_testing, { align: 'left' });
      doc.moveDown(0.6);
    }

    for (const s of subs) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
         .text(`${s.tester_name}${s.flagged ? '   ⚑ FLAGGED' : ''}`, { continued: true })
         .font('Helvetica').fontSize(8).fillColor('#666')
         .text(`   ${s.submitted_at}`);
      if (s.flagged && s.flag_note) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#a31d1d').text(`Flag note: ${s.flag_note}`);
      }
      doc.moveDown(0.2);
      for (const a of answerRows(s)) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text(a.question);
        doc.font('Helvetica').fontSize(10).fillColor('#000')
           .text(a.answer || '—', { indent: 12 });
        doc.moveDown(0.25);
      }
      doc.moveDown(0.5);
    }
  }

  if (!byBrief.size) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#666')
       .text('No submissions in this round yet.');
  }
  doc.end();
}

module.exports = { buildCsv, buildPdf };
