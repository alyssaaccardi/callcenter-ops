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

// Split a row honoring both tab-separated and 2+ space-separated cells.
// MiCC exports as tabs but pasting through some tools collapses to spaces.
function splitRow(line) {
  if (line.includes('\t')) {
    return line.split('\t').map(c => c.trim());
  }
  // Fall back to runs of 2+ whitespace as a separator
  return line.trim().split(/ {2,}|\t/).map(c => c.trim());
}

function parseDateRange(line) {
  // "6/22/2026 - 6/28/2026 - 00:00 - 24:00"
  const m = line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!m) return { startDate: null, endDate: null };
  return { startDate: m[1], endDate: m[2] };
}

function parseReport(raw) {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))   // trim trailing whitespace
    .filter(l => l.trim().length > 0);

  if (lines.length < 6) throw new Error('Report too short — expected at least 6 lines');

  // Metadata lines (1-4) — peel off until we hit the column header (row containing "Reporting" and "Full name")
  const headerIdx = lines.findIndex(l => /\bReporting\b/.test(l) && /\bFull name\b/.test(l));
  if (headerIdx === -1) throw new Error('Could not find column header row ("Reporting" + "Full name")');
  if (headerIdx < 1) throw new Error('Metadata lines missing before header');

  const metaLines = lines.slice(0, headerIdx);
  const title       = metaLines[0] || '';
  const groupInfo   = metaLines[1] || '';
  const periodLine  = metaLines[2] || '';
  const createdLine = metaLines[3] || '';
  const { startDate, endDate } = parseDateRange(periodLine);
  const createdMatch = createdLine.match(/Created on (.+?) by (.+)$/);

  // Data rows: everything after the header until "Totals" (or EOF)
  const dataLines = lines.slice(headerIdx + 1);
  const totalsIdx = dataLines.findIndex(l => /^Totals\b/i.test(l.trim()));
  const agentLines = totalsIdx === -1 ? dataLines : dataLines.slice(0, totalsIdx);
  const totalsLine = totalsIdx === -1 ? null : dataLines[totalsIdx];

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

  const agents = agentLines
    .map(splitRow)
    .filter(cells => cells.length >= COLUMNS.length - 2) // tolerate trailing empty cells
    .map(rowToObject);

  let totals = null;
  if (totalsLine) {
    // Totals row has an empty Reporting cell — pad the front so column indices line up
    const cells = splitRow(totalsLine);
    // First cell is "Totals". Reporting ID and name slots are empty in this export
    // — but the splitRow above strips the empties. So we shift one in.
    if (cells[0].toLowerCase().startsWith('total')) {
      // Insert an empty "name" cell at index 1 if numbers start at index 1
      // Detect: if cells[1] is purely numeric, the "name" cell was collapsed.
      if (cells.length === COLUMNS.length - 1) cells.splice(1, 0, '');
    }
    cells[0] = ''; // drop "Totals" from the Reporting cell
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

module.exports = {
  COLUMNS,
  parseReport,
  listSnapshots,
  getSnapshot,
  saveSnapshot,
  deleteSnapshot,
};
