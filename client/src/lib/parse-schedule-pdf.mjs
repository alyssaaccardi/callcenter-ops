// Port of schedule_pdf_to_csv.py to the browser via pdfjs-dist.
// Output shape matches the CSV: rows[][] with header row first.
//
// The WFM export is a grid, not a table — column positions are stable
// (day headers in row 1, worker anchors in the left column, cells filled
// with "8:00 AM - 5:00 PM  Agent" strings). We reconstruct rows/columns
// from x/y coordinates, mirroring pdfplumber.extract_words().

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[–\-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi;
const ROLES = ['Agent - Bilingual', 'Lead Supervisor', 'Supervisor', 'Trainer', 'Agent'];
const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const HEADER_Y = 26, FOOTER_Y = 745, NAME_X = 112;

function toMin(h, m, ap, fallback) {
  h = Number(h); m = Number(m || 0);
  const a = ((ap || fallback || '') + '').toUpperCase();
  if (a === 'PM' && h < 12) h += 12;
  if (a === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

// pdfjs items give position at BASELINE lower-left. pdfplumber's "top" is
// distance from the top of the page to the top of the glyph box, so we
// invert using page height and add glyph height.
async function pageWords(page) {
  const viewport = page.getViewport({ scale: 1 });
  const H = viewport.height;
  const content = await page.getTextContent();
  const out = [];
  for (const item of content.items) {
    const raw = (item.str || '').trim();
    if (!raw) continue;
    const [, , , , e, f] = item.transform;
    const w = item.width || 0;
    const h = Math.abs(item.height || 0) || 8;
    const top = H - f - h;
    // Split multi-word items on whitespace; approximate per-word x by
    // proportion of character count. Good enough for the WFM grid where
    // cells rarely have long phrases.
    const parts = raw.split(/\s+/);
    if (parts.length === 1) {
      out.push({ text: raw, x0: e, x1: e + w, top });
    } else {
      const totalLen = parts.reduce((s, p) => s + p.length, 0) || 1;
      let cx = e;
      for (const p of parts) {
        const px1 = cx + (w * p.length) / totalLen;
        out.push({ text: p, x0: cx, x1: px1, top });
        cx = px1;
      }
    }
  }
  return out;
}

function dayColumns(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const wi = words[i];
    if (wi.text in DOW && i + 1 < words.length && /^\d+$/.test(words[i + 1].text)) {
      found.push({
        dow: wi.text,
        day: Number(words[i + 1].text),
        cx: (wi.x0 + words[i + 1].x1) / 2,
      });
    }
  }
  if (found.length < 2) {
    throw new Error('Could not find the day header row — is this a WFM schedule PDF?');
  }
  found.sort((a, b) => a.cx - b.cx);
  const xs = found.map(f => f.cx);
  const bounds = [
    NAME_X - 2,
    ...xs.slice(0, -1).map((x, i) => (x + xs[i + 1]) / 2),
    1e6,
  ];
  return { bounds, found };
}

const inferDates = (found, year, month) =>
  found.map(f => `${year}-${String(month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`);

// The WFM export tags site as [C], [S], etc. next to each name. The Python
// script strips it and drops the info; we keep it so the Belize-only filter
// still works after PDF ingestion.
function extractSiteAndCleanName(raw) {
  const m = raw.match(/\[([A-Z]{1,3})\]/);
  const site = m ? m[1] : '';
  const name = raw.replace(/\s*\[[A-Z]{1,3}\]/g, '').replace(/\s+/g, ' ').trim();
  return { site, name };
}

export async function parseSchedulePdf(file, opts = {}) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  // Year/month come from the metadata title ("Jan 5 2026 - ..."). Fall back
  // to today if the title doesn't match — the user can correct dates later.
  let year = opts.year, month = opts.month;
  try {
    const meta = await pdf.getMetadata();
    const title = ((meta && meta.info && meta.info.Title) || '') + '';
    const m = title.match(/([A-Z][a-z]{2})\w*\s+\d+.*?(\d{4})/);
    if (m) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      month = month || (months.indexOf(m[1]) + 1);
      year = year || Number(m[2]);
    }
  } catch (_) { /* metadata is optional */ }
  if (!year || !month) {
    const now = new Date();
    year = year || now.getFullYear();
    month = month || (now.getMonth() + 1);
  }

  const page1words = await pageWords(await pdf.getPage(1));
  const { bounds, found } = dayColumns(page1words);
  const dates = inferDates(found, year, month);
  const dayOf = (x) => {
    for (let i = 0; i < dates.length; i++) {
      if (bounds[i] <= x && x < bounds[i + 1]) return i;
    }
    return null;
  };

  const shifts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const words = await pageWords(page);

    // Cluster words into text-lines by rounded y (3-unit buckets absorb
    // subpixel jitter between adjacent glyphs on the same line).
    const lines = new Map();
    for (const w of words) {
      if (w.top < HEADER_Y || w.top > FOOTER_Y) continue;
      const k = Math.round(w.top / 3);
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push(w);
    }
    const keys = [...lines.keys()].sort((a, b) => a - b);

    // Worker anchors: name(s) in the left column, terminated by a "X Hours"
    // or "Total Hours" line. Empty buffer between "Total Daily" and the next
    // name is normal — that's the summary row for a day.
    const anchors = [];
    let buf = [], bufTop = null;
    for (const k of keys) {
      const left = (lines.get(k) || [])
        .filter(w => w.x1 <= NAME_X)
        .sort((a, b) => a.x0 - b.x0);
      if (!left.length) continue;
      const txt = left.map(w => w.text).join(' ').trim();
      if (!txt) continue;

      if (txt.startsWith('Total Hours') || /^[\d.,]+ Hours$/.test(txt)) {
        if (buf.length) {
          const raw = buf.join(' ').replace(/\s+/g, ' ').trim();
          const { site, name } = extractSiteAndCleanName(raw);
          if (name && !name.startsWith('Total')) {
            anchors.push({ top: bufTop, name, site });
          }
        }
        buf = []; bufTop = null;
        continue;
      }
      if (txt === 'Workers' || txt === 'Total Daily') {
        buf = []; bufTop = null; continue;
      }
      if (txt === 'Unassigned Shifts') {
        buf = ['(Unassigned)']; bufTop = left[0].top; continue;
      }
      if (/^[\d.,:]+$/.test(txt)) continue;
      if (bufTop == null) bufTop = left[0].top;
      buf.push(txt);
    }

    for (let ai = 0; ai < anchors.length; ai++) {
      const { top: ytop, name, site } = anchors[ai];
      const ybot = ai + 1 < anchors.length ? anchors[ai + 1].top : 1e6;

      // cells[dayIndex] -> Map<yLineKey, words[]>
      const cells = new Map();
      for (const k of keys) {
        for (const w of (lines.get(k) || [])) {
          if (!(w.top >= ytop - 5 && w.top < ybot - 5)) continue;
          const d = dayOf((w.x0 + w.x1) / 2);
          if (d == null) continue;
          if (!cells.has(d)) cells.set(d, new Map());
          const dm = cells.get(d);
          if (!dm.has(k)) dm.set(k, []);
          dm.get(k).push(w);
        }
      }

      for (const [d, ls] of cells) {
        const txt = [...ls.keys()].sort((a, b) => a - b)
          .map(k => ls.get(k).sort((a, b) => a.x0 - b.x0).map(w => w.text).join(' '))
          .join(' ');
        for (const m of txt.matchAll(TIME_RE)) {
          const eap = m[6];
          const s = toMin(m[1], m[2], m[3], eap);
          const e = toMin(m[4], m[5], eap, null);
          const role = ROLES.find(r => txt.includes(r)) || '';
          shifts.push({
            Agent: name,
            Date: dates[d],
            Start: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
            End: `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`,
            Hours: Math.round((((e - s + 1440) % 1440) / 60) * 100) / 100,
            Role: role,
            Site: site,
            Status: name === '(Unassigned)' ? 'Open' : 'Assigned',
          });
        }
      }
    }
  }

  // Dedupe on (agent, date, start, end) — pdfplumber and pdfjs both
  // occasionally re-emit an item that spans a line break.
  const seen = new Set();
  const uniq = [];
  for (const s of shifts) {
    const k = `${s.Agent}|${s.Date}|${s.Start}|${s.End}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  uniq.sort((a, b) => (a.Date + a.Start).localeCompare(b.Date + b.Start));

  const header = ['Agent', 'Date', 'Start', 'End', 'Hours', 'Role', 'Site', 'Status'];
  return [header, ...uniq.map(s => header.map(h => s[h]))];
}
