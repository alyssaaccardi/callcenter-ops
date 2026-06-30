// Parser + storage for the Mitel 3300 "Agent Group Performance by Agent" report.
//
// The export is tab-separated text with this shape:
//   line 1: "Agent Group Performance by Agent"
//   line 2: "[Main3300] 601 -   AgentGroup - 6001"
//   line 3: "6/22/2026 - 6/28/2026 - 00:00 - 24:00"
//   line 4: "Created on 6/29/2026 9:56:21 AM by DianaRicottone"
//   line 5: header row (21 columns)
//   line 6..N: one row per agent
//   last:   "Totals" row
//
// The handle-time columns are hh:mm:ss. We store both the raw string and a
// numeric seconds value so the React table can sort without re-parsing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = path.join(__dirname, 'mitel-leaderboard.json');

const COLUMNS = [
  { key: 'reportingId',       label: 'Reporting' },
  { key: 'fullName',          label: 'Full name' },
  { key: 'acdCalls',          label: 'ACD calls handled',                 type: 'int' },
  { key: 'nonAcdCalls',       label: 'Non ACD calls handled',             type: 'int' },
  { key: 'outboundCalls',     label: 'Calls outbound',                    type: 'int' },
  { key: 'requeued',          label: 'Calls requeued',                    type: 'int' },
  { key: 'accountCodes',      label: 'Account Codes',                     type: 'int' },
  { key: 'shiftDuration',     label: 'Shift duration',                    type: 'time' },
  { key: 'acdHandling',       label: 'ACD handling time',                 type: 'time' },
  { key: 'acdHandlingAvg',    label: 'Average ACD handling time',         type: 'time' },
  { key: 'acdPct',            label: 'ACD % of shift',                    type: 'pct' },
  { key: 'nonAcdHandling',    label: 'Non ACD handling time',             type: 'time' },
  { key: 'nonAcdHandlingAvg', label: 'Average non ACD handling time',     type: 'time' },
  { key: 'nonAcdPct',         label: 'Non ACD % of shift',                type: 'pct' },
  { key: 'outboundHandling',  label: 'Outbound handling time',            type: 'time' },
  { key: 'outboundHandlingAvg', label: 'Average outbound handling time',  type: 'time' },
  { key: 'outboundPct',       label: 'Outbound % of shift',               type: 'pct' },
  { key: 'makeBusy',          label: 'Total Make Busy time',              type: 'time' },
  { key: 'makeBusyPct',       label: 'Make Busy % of shift',              type: 'pct' },
  { key: 'dnd',               label: 'Total DND time',                    type: 'time' },
  { key: 'dndPct',            label: 'DND % of shift',                    type: 'pct' },
];

// Parse "hh:mm:ss" (or "hhh:mm:ss") to seconds. Returns 0 for empty/invalid.
function timeToSeconds(s) {
  if (!s) return 0;
  const parts = s.trim().split(':');
  if (parts.length !== 3) return 0;
  const [h, m, sec] = parts.map(p => parseInt(p, 10));
  if ([h, m, sec].some(Number.isNaN)) return 0;
  return h * 3600 + m * 60 + sec;
}

function parseInt0(s) {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function parseFloat0(s) {
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

// Detect the delimiter MiCC's export uses. Defaults to tab; falls back to
// comma (Excel-style CSV) or 2+ spaces (paste from a TSV-rendered table).
function detectDelimiter(lines) {
  // Sample the first 20 non-empty lines and count occurrences
  let tabs = 0, commas = 0;
  for (const l of lines.slice(0, 20)) {
    tabs   += (l.match(/\t/g) || []).length;
    commas += (l.match(/,/g) || []).length;
  }
  if (tabs >= 10)      return 'tab';
  if (commas >= 10)    return 'comma';
  return 'spaces';
}

function makeSplitter(delim) {
  if (delim === 'tab')   return line => line.split('\t').map(c => c.trim());
  if (delim === 'comma') return line => line.split(',').map(c => c.trim());
  return line => line.trim().split(/ {2,}|\t/).map(c => c.trim());
}

// A "noise" row is one where every cell is empty (e.g. ",,,,,,,," in CSV).
function isNoiseRow(cells) {
  return cells.every(c => c.trim() === '');
}

// Trim leading empty cells from a row. Excel sometimes exports the title etc.
// in column B with column A empty, which would shift all our indices.
function leftStrip(cells) {
  let i = 0;
  while (i < cells.length && cells[i] === '') i++;
  return cells.slice(i);
}

function parseDateRange(line) {
  // "6/22/2026 - 6/28/2026 - 00:00 - 24:00"
  const m = line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!m) return { startDate: null, endDate: null };
  return { startDate: m[1], endDate: m[2] };
}

function parseReport(raw) {
  const allLines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))   // trim trailing whitespace
    .filter(l => l.trim().length > 0);

  if (allLines.length < 6) throw new Error('Report too short — expected at least 6 non-empty lines');

  const delim    = detectDelimiter(allLines);
  const splitter = makeSplitter(delim);

  // Split each line into cells, then drop noise rows (all-empty cells, e.g. a row of just commas)
  const rows = allLines
    .map(splitter)
    .filter(cells => !isNoiseRow(cells))
    // strip any leading empty cells so the title etc. don't slide off into column B
    .map(leftStrip);

  // Header row contains "Reporting" and "Full name"
  const headerIdx = rows.findIndex(cells => {
    const joined = cells.join(' | ');
    return /\bReporting\b/.test(joined) && /\bFull name\b/.test(joined);
  });
  if (headerIdx === -1) throw new Error('Could not find column header row ("Reporting" + "Full name")');

  const metaRows = rows.slice(0, headerIdx).map(cells => cells.join(' ').replace(/\s+/g, ' ').trim());

  // Pull metadata lines by content rather than position — order in MiCC exports varies slightly
  const title       = metaRows.find(l => /Performance by Agent/i.test(l)) || metaRows[0] || '';
  const groupInfo   = metaRows.find(l => /AgentGroup|\[Main/i.test(l))     || '';
  const periodLine  = metaRows.find(l => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l) && !/Created on/i.test(l)) || '';
  const createdLine = metaRows.find(l => /^Created on/i.test(l))           || '';
  const { startDate, endDate } = parseDateRange(periodLine);
  const createdMatch = createdLine.match(/Created on (.+?) by (.+)$/);

  // Data rows: everything after the header until "Totals" (or EOF)
  const dataRows  = rows.slice(headerIdx + 1);
  const totalsIdx = dataRows.findIndex(cells => /^total/i.test((cells[0] || '').trim()));
  const agentRows = totalsIdx === -1 ? dataRows : dataRows.slice(0, totalsIdx);
  const totalsRow = totalsIdx === -1 ? null : dataRows[totalsIdx];

  function rowToObject(cells) {
    const row = {};
    COLUMNS.forEach((col, i) => {
      const raw = cells[i] ?? '';
      if (col.type === 'int')        row[col.key] = parseInt0(raw);
      else if (col.type === 'pct')   row[col.key] = parseFloat0(raw);
      else if (col.type === 'time') {
        row[col.key] = raw;
        row[col.key + 'Sec'] = timeToSeconds(raw);
      } else {
        row[col.key] = raw;
      }
    });
    return row;
  }

  const agents = agentRows
    .filter(cells => cells.length >= COLUMNS.length - 2) // tolerate trailing empty cells
    .map(rowToObject);

  let totals = null;
  if (totalsRow) {
    // The Totals row label "Totals" lives in the Reporting column with the name
    // column usually empty. We want the numeric cells to line up with the schema,
    // so insert an empty name cell when the data shifted left.
    const cells = [...totalsRow];
    if (/^total/i.test(cells[0] || '')) {
      if (cells.length === COLUMNS.length - 1) cells.splice(1, 0, ''); // missing name cell
    }
    cells[0] = ''; // drop "Totals" label from the Reporting slot
    totals = rowToObject(cells);
    totals.fullName = 'Totals';
  }

  return {
    title,
    groupInfo,
    periodLine,
    startDate,
    endDate,
    createdAt: createdMatch?.[1] || '',
    createdBy: createdMatch?.[2] || '',
    columns:   COLUMNS,
    agents,
    totals,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

function loadAll() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return []; }
}

function saveAll(snapshots) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(snapshots, null, 2));
}

function listSnapshots() {
  // Return without the heavy `agents` array — just the metadata for the picker.
  return loadAll().map(s => ({
    id:          s.id,
    title:       s.title,
    groupInfo:   s.groupInfo,
    periodLine:  s.periodLine,
    startDate:   s.startDate,
    endDate:     s.endDate,
    createdAt:   s.createdAt,
    createdBy:   s.createdBy,
    importedAt:  s.importedAt,
    importedBy:  s.importedBy,
    agentCount:  s.agents?.length || 0,
  }));
}

function getSnapshot(id) {
  return loadAll().find(s => s.id === id) || null;
}

function saveSnapshot(parsed, importedBy) {
  const all = loadAll();
  const snapshot = {
    id:          crypto.randomBytes(8).toString('hex'),
    importedAt:  new Date().toISOString(),
    importedBy:  importedBy || 'unknown',
    ...parsed,
  };
  // Newest first
  all.unshift(snapshot);
  saveAll(all);
  return snapshot;
}

function deleteSnapshot(id) {
  const all = loadAll();
  const next = all.filter(s => s.id !== id);
  if (next.length === all.length) return false;
  saveAll(next);
  return true;
}

// ── Aggregation ──────────────────────────────────────────────────────────────
//
// Combine snapshots whose period falls inside [from, to] into one per-agent
// view. Sums for counts and durations; *weighted* averages for handle-time
// and percent-of-shift (plain means would lie when weeks differ in volume).
//
// Returns:
//   {
//     range:       { from, to },          // echoed
//     snapshots:   [{id, startDate, endDate, agentCount}], // included
//     overlaps:    [{a, b}],              // pairs of snapshot ids with overlapping dates
//     totals:      {acdCalls, ...},       // grand totals across the range
//     agents:      [{...per-agent aggregate...}],
//     columns:     COLUMNS,
//   }

function parseMDY(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return new Date(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10));
}

function inRange(snap, from, to) {
  const s = parseMDY(snap.startDate);
  const e = parseMDY(snap.endDate);
  if (!s || !e) return false;
  // Treat snapshot as included if it overlaps the range at all.
  if (from && e < from) return false;
  if (to   && s > to)   return false;
  return true;
}

function detectOverlaps(snaps) {
  const pairs = [];
  for (let i = 0; i < snaps.length; i++) {
    for (let j = i + 1; j < snaps.length; j++) {
      const a = snaps[i], b = snaps[j];
      const aStart = parseMDY(a.startDate);
      const aEnd   = parseMDY(a.endDate);
      const bStart = parseMDY(b.startDate);
      const bEnd   = parseMDY(b.endDate);
      if (!aStart || !aEnd || !bStart || !bEnd) continue;
      if (aStart <= bEnd && bStart <= aEnd) {
        pairs.push({ a: a.id, b: b.id });
      }
    }
  }
  return pairs;
}

function aggregate({ from, to } = {}) {
  const fromDate = from ? new Date(from) : null;
  const toDate   = to   ? new Date(to)   : null;
  const all      = loadAll();
  const included = all.filter(s => inRange(s, fromDate, toDate));

  // Per-agent accumulator keyed by extension (reportingId) — names can change spelling,
  // extensions are stable.
  const byAgent = new Map();
  const sumFields  = ['acdCalls', 'nonAcdCalls', 'outboundCalls', 'requeued', 'accountCodes'];
  const timeFields = ['shiftDurationSec', 'acdHandlingSec', 'nonAcdHandlingSec', 'outboundHandlingSec', 'makeBusySec', 'dndSec'];

  for (const snap of included) {
    for (const a of snap.agents || []) {
      const key = a.reportingId || a.fullName;
      if (!key) continue;
      let agg = byAgent.get(key);
      if (!agg) {
        agg = { reportingId: a.reportingId, fullName: a.fullName, snapshotsContributed: 0 };
        for (const f of sumFields) agg[f] = 0;
        for (const f of timeFields) agg[f] = 0;
        byAgent.set(key, agg);
      }
      agg.snapshotsContributed += 1;
      agg.fullName = a.fullName || agg.fullName;  // prefer most recent name spelling
      for (const f of sumFields)  agg[f] += (a[f]  || 0);
      for (const f of timeFields) agg[f] += (a[f]  || 0);
    }
  }

  // Derive averages + percentages from the sums.
  const agents = [];
  for (const agg of byAgent.values()) {
    const fmt = (sec) => {
      sec = Math.max(0, Math.round(sec || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    const row = { ...agg };
    // Echo time strings for display
    for (const f of timeFields) row[f.replace(/Sec$/, '')] = fmt(agg[f]);
    // Weighted average handle time = total ACD handling / ACD calls
    row.acdHandlingAvgSec = agg.acdCalls > 0 ? Math.round(agg.acdHandlingSec / agg.acdCalls) : 0;
    row.acdHandlingAvg    = fmt(row.acdHandlingAvgSec);
    row.nonAcdHandlingAvgSec = agg.nonAcdCalls > 0 ? Math.round(agg.nonAcdHandlingSec / agg.nonAcdCalls) : 0;
    row.nonAcdHandlingAvg    = fmt(row.nonAcdHandlingAvgSec);
    row.outboundHandlingAvgSec = agg.outboundCalls > 0 ? Math.round(agg.outboundHandlingSec / agg.outboundCalls) : 0;
    row.outboundHandlingAvg    = fmt(row.outboundHandlingAvgSec);
    // Weighted percentages: time on each state / total shift
    const shift = agg.shiftDurationSec || 0;
    row.acdPct       = shift > 0 ? Math.round((agg.acdHandlingSec      / shift) * 1000) / 10 : 0;
    row.nonAcdPct    = shift > 0 ? Math.round((agg.nonAcdHandlingSec   / shift) * 1000) / 10 : 0;
    row.outboundPct  = shift > 0 ? Math.round((agg.outboundHandlingSec / shift) * 1000) / 10 : 0;
    row.makeBusyPct  = shift > 0 ? Math.round((agg.makeBusySec         / shift) * 1000) / 10 : 0;
    row.dndPct       = shift > 0 ? Math.round((agg.dndSec              / shift) * 1000) / 10 : 0;
    agents.push(row);
  }

  // Grand totals
  const totals = {};
  for (const f of sumFields)  totals[f] = agents.reduce((a, r) => a + (r[f] || 0), 0);
  for (const f of timeFields) totals[f] = agents.reduce((a, r) => a + (r[f] || 0), 0);
  totals.fullName = 'Totals';
  totals.snapshotsContributed = included.length;

  return {
    range: { from: from || null, to: to || null },
    snapshots: included.map(s => ({
      id: s.id, startDate: s.startDate, endDate: s.endDate,
      periodLine: s.periodLine, agentCount: s.agents?.length || 0,
    })),
    overlaps: detectOverlaps(included),
    totals,
    agents,
    columns: COLUMNS,
  };
}

// Return the full history of one agent (by extension) across every snapshot.
function agentHistory(reportingId) {
  if (!reportingId) return { reportingId, rows: [] };
  const rows = [];
  for (const snap of loadAll()) {
    const a = (snap.agents || []).find(x => String(x.reportingId) === String(reportingId));
    if (!a) continue;
    rows.push({
      snapshotId: snap.id,
      startDate:  snap.startDate,
      endDate:    snap.endDate,
      ...a,
    });
  }
  // Newest first by parsed start date when possible
  rows.sort((a, b) => {
    const ad = parseMDY(a.startDate)?.getTime() || 0;
    const bd = parseMDY(b.startDate)?.getTime() || 0;
    return bd - ad;
  });
  return { reportingId, fullName: rows[0]?.fullName || '', rows };
}

module.exports = {
  COLUMNS,
  parseReport,
  listSnapshots,
  getSnapshot,
  saveSnapshot,
  deleteSnapshot,
  aggregate,
  agentHistory,
};
