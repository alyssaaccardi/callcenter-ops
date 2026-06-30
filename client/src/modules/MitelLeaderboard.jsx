import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import { processAgents, scoreMapByExtension, METRICS } from '../lib/mitelScoring';
import './MitelLeaderboard.css';

// Columns for the Full Agent Table. Order matches the spec.
const FULL_COLS = [
  { key: 'fullName',           label: 'Agent',           align: 'left',  type: 'text', defaultDir: 'asc' },
  { key: 'shiftHours',         label: 'Shift Hrs',       align: 'right', type: 'num1', defaultDir: 'desc' },
  { key: 'acdCalls',           label: 'ACD',             align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'callsPerHour',       label: 'Calls / Hr',      align: 'right', type: 'num1', defaultDir: 'desc' },
  { key: 'acdHandlingAvgSec',  label: 'Avg Handle',      align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'occupancy',          label: 'Occ %',           align: 'right', type: 'pct',  defaultDir: 'desc' },
  { key: 'makeBusyPct',        label: 'Make Busy %',     align: 'right', type: 'pct',  defaultDir: 'asc'  },
  { key: 'dndPct',             label: 'DND %',           align: 'right', type: 'pct',  defaultDir: 'asc'  },
  { key: 'availability',       label: 'Avail %',         align: 'right', type: 'pct',  defaultDir: 'desc' },
  { key: 'efficiencyScore',    label: 'Score',           align: 'right', type: 'num1', defaultDir: 'desc' },
];

// Compact columns for Top 10 / Bottom 10 / Low Sample tables
const COMPACT_COLS = [
  { key: 'fullName',           label: 'Agent',           align: 'left',  type: 'text' },
  { key: 'efficiencyScore',    label: 'Score',           align: 'right', type: 'num1' },
  { key: 'callsPerHour',       label: 'Calls / Hr',      align: 'right', type: 'num1' },
  { key: 'occupancy',          label: 'Occ %',           align: 'right', type: 'pct'  },
  { key: 'acdHandlingAvgSec',  label: 'Avg Handle',      align: 'right', type: 'time' },
  { key: 'availability',       label: 'Avail %',         align: 'right', type: 'pct'  },
];

const RANGE_PRESETS = [
  { key: '4w',         label: 'Last 4 weeks'  },
  { key: '12w',        label: 'Last 12 weeks' },
  { key: 'this-month', label: 'This month'    },
  { key: 'last-month', label: 'Last month'    },
  { key: 'all',        label: 'All time'      },
  { key: 'custom',     label: 'Custom…'       },
];

function fmtTime(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtMMSS(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function rangeForPreset(key) {
  const now = new Date();
  if (key === 'all') return { from: null, to: null };
  if (key === '4w' || key === '12w') {
    const days = key === '4w' ? 28 : 84;
    const start = new Date(now); start.setDate(now.getDate() - days);
    return { from: isoDate(start), to: isoDate(now) };
  }
  if (key === 'this-month') {
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  }
  if (key === 'last-month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: isoDate(start), to: isoDate(end) };
  }
  return { from: null, to: null };
}

function compareCell(a, b, col, dir) {
  let av, bv;
  if (col.type === 'time') { av = a[col.key] || 0; bv = b[col.key] || 0; }
  else if (col.type === 'int' || col.type === 'pct' || col.type === 'num1') { av = a[col.key] || 0; bv = b[col.key] || 0; }
  else { av = (a[col.key] || '').toString().toLowerCase(); bv = (b[col.key] || '').toString().toLowerCase(); }
  if (av < bv) return dir === 'asc' ? -1 : 1;
  if (av > bv) return dir === 'asc' ? 1  : -1;
  return 0;
}

function renderCell(a, col) {
  const v = a[col.key];
  if (col.type === 'time') return fmtMMSS(a[col.key] || 0);
  if (col.type === 'pct')  return (v != null ? `${v}%` : '—');
  if (col.type === 'int')  return (v ?? 0).toLocaleString();
  if (col.type === 'num1') return (v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return v ?? '';
}

function periodLabel(snap) {
  if (snap?.startDate && snap?.endDate) return `${snap.startDate} – ${snap.endDate}`;
  return snap?.periodLine || 'Unknown period';
}

function TrendArrow({ delta, suffix }) {
  if (delta == null) return null;
  const rounded = Math.round(delta * 10) / 10;
  if (Math.abs(rounded) < 0.5) return <span className="trend trend-flat">= </span>;
  if (rounded > 0)              return <span className="trend trend-up">▲ {rounded.toFixed(1)}{suffix || ''}</span>;
  return                              <span className="trend trend-down">▼ {Math.abs(rounded).toFixed(1)}{suffix || ''}</span>;
}

export default function MitelLeaderboard() {
  const { toast } = useApp();
  const { user } = useAuth();
  const canWrite = user?.role === 'super_admin' || user?.role === 'call_center_ops';

  const [viewMode, setViewMode] = useState('snapshot');
  const [snapshots, setSnapshots] = useState([]);
  const [activeId, setActiveId]   = useState(null);
  const [snap, setSnap]           = useState(null);
  const [prevSnap, setPrevSnap]   = useState(null);  // for trend arrows
  const [agg, setAgg]             = useState(null);
  const [loading, setLoading]     = useState(true);

  const [rangePreset, setRangePreset] = useState('12w');
  const [customFrom, setCustomFrom]   = useState('');
  const [customTo,   setCustomTo]     = useState('');

  const [sortKey, setSortKey] = useState('efficiencyScore');
  const [sortDir, setSortDir] = useState('desc');
  const [filter, setFilter]   = useState('');
  const [showLowSample, setShowLowSample] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText]   = useState('');
  const [importing, setImporting]   = useState(false);

  const [drillAgent, setDrillAgent] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const [exclusions, setExclusions] = useState([]);
  const [exclOpen,   setExclOpen]   = useState(false);
  const [newExclExt,    setNewExclExt]    = useState('');
  const [newExclName,   setNewExclName]   = useState('');
  const [newExclReason, setNewExclReason] = useState('');

  const fetchSnapshots = useCallback(async () => {
    try {
      const r = await api.get('/api/mitel-leaderboard');
      const list = r.data?.snapshots || [];
      setSnapshots(list);
      if (list.length && !activeId) setActiveId(list[0].id);
      if (!list.length) setSnap(null);
      return list;
    } catch {
      toast('Could not load leaderboard snapshots', 'error');
      return [];
    }
  }, [activeId, toast]);

  const fetchExclusions = useCallback(async () => {
    try {
      const r = await api.get('/api/mitel-leaderboard/exclusions');
      setExclusions(r.data?.exclusions || []);
    } catch { /* non-fatal; UI just won't filter */ }
  }, []);

  useEffect(() => { fetchSnapshots().finally(() => setLoading(false)); }, []);  // eslint-disable-line
  useEffect(() => { fetchExclusions(); }, [fetchExclusions]);

  // Snapshot view — also fetch the previous-period snapshot for week-over-week trends
  useEffect(() => {
    if (viewMode !== 'snapshot' || !activeId) return;
    let cancelled = false;
    setLoading(true);
    api.get(`/api/mitel-leaderboard/${activeId}`)
      .then(async r => {
        if (cancelled) return;
        setSnap(r.data);
        // Find the snapshot immediately preceding this one by start date
        const sorted = [...snapshots].sort((a, b) => {
          const ad = new Date(a.startDate || 0).getTime();
          const bd = new Date(b.startDate || 0).getTime();
          return bd - ad;
        });
        const idx = sorted.findIndex(s => s.id === activeId);
        const prev = idx >= 0 ? sorted[idx + 1] : null;
        if (prev) {
          try {
            const pr = await api.get(`/api/mitel-leaderboard/${prev.id}`);
            if (!cancelled) setPrevSnap(pr.data);
          } catch { if (!cancelled) setPrevSnap(null); }
        } else if (!cancelled) {
          setPrevSnap(null);
        }
      })
      .catch(() => { if (!cancelled) toast('Could not load snapshot', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewMode, activeId, snapshots, toast]);

  // Combined view — aggregate endpoint
  useEffect(() => {
    if (viewMode !== 'combined') return;
    let cancelled = false;
    setLoading(true);
    const { from, to } = rangePreset === 'custom'
      ? { from: customFrom || null, to: customTo || null }
      : rangeForPreset(rangePreset);
    const params = {};
    if (from) params.from = from;
    if (to)   params.to   = to;
    api.get('/api/mitel-leaderboard/aggregate', { params })
      .then(r => { if (!cancelled) setAgg(r.data); })
      .catch(() => { if (!cancelled) toast('Could not load aggregated data', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewMode, rangePreset, customFrom, customTo, toast]);

  const excludedExtensions = useMemo(() => exclusions.map(e => e.extension), [exclusions]);

  // Process data through scoring pipeline — single source of truth for the page
  const processed = useMemo(() => {
    const sourceAgents = viewMode === 'combined' ? (agg?.agents || []) : (snap?.agents || []);
    return processAgents(sourceAgents, { excludedExtensions });
  }, [viewMode, snap, agg, excludedExtensions]);

  // Previous-period score lookup for trend arrows — also exclude admins so
  // their inclusion in last week's pool doesn't shift the normalization
  // bounds for the trend comparison.
  const prevScores = useMemo(() => {
    if (viewMode !== 'snapshot' || !prevSnap?.agents) return new Map();
    return scoreMapByExtension(prevSnap.agents, excludedExtensions);
  }, [viewMode, prevSnap, excludedExtensions]);

  function clickHeader(col) {
    if (sortKey === col.key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(col.key);
      setSortDir(col.defaultDir);
    }
  }

  const ranked = processed.ranked;

  const filteredRanked = useMemo(() => {
    const filterLower = filter.trim().toLowerCase();
    if (!filterLower) return ranked;
    return ranked.filter(a =>
      (a.fullName || '').toLowerCase().includes(filterLower) ||
      String(a.reportingId || '').includes(filterLower)
    );
  }, [ranked, filter]);

  const sortedForTable = useMemo(() => {
    const col = FULL_COLS.find(c => c.key === sortKey) || FULL_COLS[FULL_COLS.length - 1];
    return [...filteredRanked].sort((a, b) => compareCell(a, b, col, sortDir));
  }, [filteredRanked, sortKey, sortDir]);

  // Top 10 = highest scores; Bottom 10 = lowest, but only among ranked
  const top10    = ranked.slice(0, 10);
  const bottom10 = ranked.length > 10 ? ranked.slice(-10).reverse() : [];

  // Trend arrows: difference vs previous-period agent (by extension)
  function trendFor(a, field) {
    const prev = prevScores.get(String(a.reportingId));
    if (!prev) return null;
    return (a[field] || 0) - (prev[field] || 0);
  }

  async function submitImport() {
    if (!pasteText.trim()) { toast('Paste the report first', 'error'); return; }
    setImporting(true);
    try {
      const r = await api.post('/api/mitel-leaderboard/import', { text: pasteText });
      toast(`Imported ${r.data?.snapshot?.agentCount ?? 0} agents`, 'success');
      setImportOpen(false);
      setPasteText('');
      const list = await fetchSnapshots();
      if (r.data?.snapshot?.id) setActiveId(r.data.snapshot.id);
      else if (list[0]) setActiveId(list[0].id);
    } catch (err) {
      const msg = err.response?.data?.details || err.response?.data?.error || err.message;
      toast(`Import failed: ${msg}`, 'error');
    } finally {
      setImporting(false);
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/api/mitel-leaderboard/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast(`Imported ${r.data?.snapshot?.agentCount ?? 0} agents`, 'success');
      setImportOpen(false);
      setPasteText('');
      const list = await fetchSnapshots();
      if (r.data?.snapshot?.id) setActiveId(r.data.snapshot.id);
      else if (list[0]) setActiveId(list[0].id);
    } catch (err) {
      const msg = err.response?.data?.details || err.response?.data?.error || err.message;
      toast(`Import failed: ${msg}`, 'error');
    } finally {
      setImporting(false);
    }
  }

  async function deleteSnapshot() {
    if (!activeId) return;
    if (!window.confirm('Delete this import? This cannot be undone.')) return;
    try {
      await api.delete(`/api/mitel-leaderboard/${activeId}`);
      toast('Snapshot deleted', 'success');
      setActiveId(null);
      setSnap(null);
      await fetchSnapshots();
    } catch {
      toast('Delete failed', 'error');
    }
  }

  async function addExclusion() {
    const ext = newExclExt.trim();
    if (!ext) { toast('Extension is required', 'error'); return; }
    try {
      await api.post('/api/mitel-leaderboard/exclusions', {
        extension: ext,
        name:      newExclName.trim(),
        reason:    newExclReason.trim(),
      });
      setNewExclExt('');
      setNewExclName('');
      setNewExclReason('');
      await fetchExclusions();
      toast(`Excluded ext ${ext}`, 'success');
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toast(`Could not add exclusion: ${msg}`, 'error');
    }
  }

  async function removeExclusion(extension) {
    try {
      await api.delete(`/api/mitel-leaderboard/exclusions/${encodeURIComponent(extension)}`);
      await fetchExclusions();
    } catch {
      toast('Could not remove exclusion', 'error');
    }
  }

  // Quick "exclude this person" action from a table row — preloads the modal.
  function startExcludeFor(agent) {
    setNewExclExt(String(agent.reportingId || ''));
    setNewExclName(agent.fullName || '');
    setNewExclReason('');
    setExclOpen(true);
  }

  async function openDrill(agent) {
    if (!agent?.reportingId) return;
    setDrillAgent({ reportingId: agent.reportingId, fullName: agent.fullName, rows: [] });
    setDrillLoading(true);
    try {
      const r = await api.get(`/api/mitel-leaderboard/agent/${encodeURIComponent(agent.reportingId)}`);
      setDrillAgent({ reportingId: r.data?.reportingId, fullName: r.data?.fullName || agent.fullName, rows: r.data?.rows || [] });
    } catch {
      toast('Could not load agent history', 'error');
    } finally {
      setDrillLoading(false);
    }
  }

  const summary = processed.summary;
  const overlaps    = agg?.overlaps?.length || 0;
  const includedSnaps = agg?.snapshots || [];

  function renderCompactTable(rows, opts = {}) {
    const { showTrend = false, showRank = true } = opts;
    return (
      <div className="mitel-lb-table-wrap">
        <table className="mitel-lb-table">
          <thead>
            <tr>
              {showRank && <th className="rank-col">#</th>}
              {COMPACT_COLS.map(col => (
                <th key={col.key} className={col.align === 'right' ? 'align-right' : ''}>{col.label}</th>
              ))}
              {showTrend && <th className="align-right">Δ vs last</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((a, idx) => (
              <tr key={(a.reportingId || '') + a.fullName}>
                {showRank && <td className="rank-col">{idx + 1}</td>}
                {COMPACT_COLS.map(col => (
                  <td key={col.key} className={col.align === 'right' ? 'align-right' : ''}>
                    {col.key === 'fullName'
                      ? <button className="agent-link" onClick={() => openDrill(a)}>{a.fullName}</button>
                      : renderCell(a, col)}
                  </td>
                ))}
                {showTrend && (
                  <td className="align-right">
                    <TrendArrow delta={trendFor(a, 'efficiencyScore')} />
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={COMPACT_COLS.length + (showRank ? 1 : 0) + (showTrend ? 1 : 0)} className="empty-row">No agents.</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mitel-lb">
      <div className="mitel-lb-header">
        <div>
          <h1>Mitel Leaderboard</h1>
          <div className="mitel-lb-sub">
            Efficiency-focused view of MiCC's "Agent Group Performance by Agent" report — normalized for shift length.
          </div>
        </div>
        <div className="mitel-lb-actions">
          <button className="btn btn-ghost" onClick={() => setExclOpen(true)}>
            👤 Exclusions {exclusions.length > 0 && <span className="excl-pill">{exclusions.length}</span>}
          </button>
          {canWrite && (
            <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
              + Import Report
            </button>
          )}
        </div>
      </div>

      <div className="mitel-lb-modeswitch">
        <button
          className={`mode-btn ${viewMode === 'snapshot' ? 'active' : ''}`}
          onClick={() => setViewMode('snapshot')}
        >
          Weekly
        </button>
        <button
          className={`mode-btn ${viewMode === 'combined' ? 'active' : ''}`}
          onClick={() => setViewMode('combined')}
        >
          Combined Range
        </button>
        <div style={{ flex: 1 }} />
        {viewMode === 'snapshot' && snapshots.length > 0 && (
          <select className="mitel-lb-select" value={activeId || ''} onChange={e => setActiveId(e.target.value)}>
            {snapshots.map(s => (
              <option key={s.id} value={s.id}>
                {periodLabel(s)} ({s.agentCount} agents)
              </option>
            ))}
          </select>
        )}
        {viewMode === 'combined' && (
          <>
            <select className="mitel-lb-select" value={rangePreset} onChange={e => setRangePreset(e.target.value)}>
              {RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            {rangePreset === 'custom' && (
              <>
                <input type="date" className="mitel-lb-date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                <span style={{ color: 'var(--muted, #6b7a99)' }}>→</span>
                <input type="date" className="mitel-lb-date" value={customTo}   onChange={e => setCustomTo(e.target.value)}   />
              </>
            )}
          </>
        )}
      </div>

      {loading && !snap && !agg && <div className="mitel-lb-empty">Loading…</div>}

      {!loading && viewMode === 'snapshot' && !snap && (
        <div className="mitel-lb-empty">
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>No reports imported yet</div>
          <div>Export the "Agent Group Performance by Agent" report from MiCC and paste it in.</div>
          {canWrite && (
            <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setImportOpen(true)}>
              + Import Report
            </button>
          )}
        </div>
      )}

      {viewMode === 'snapshot' && snap && (
        <div className="mitel-lb-meta">
          <div className="meta-card">
            <div className="meta-label">Period</div>
            <div className="meta-value">{periodLabel(snap)}</div>
          </div>
          <div className="meta-card">
            <div className="meta-label">Group</div>
            <div className="meta-value">{(snap.groupInfo || '').replace(/\s+/g, ' ').trim()}</div>
          </div>
          <div className="meta-card">
            <div className="meta-label">Compared to</div>
            <div className="meta-value">
              {prevSnap ? `${prevSnap.startDate} – ${prevSnap.endDate}` : <span style={{ color: 'var(--muted, #6b7a99)' }}>no earlier snapshot</span>}
            </div>
          </div>
          <div className="meta-card">
            <div className="meta-label">Imported</div>
            <div className="meta-value">
              {snap.importedAt ? new Date(snap.importedAt).toLocaleString() : '—'}
              {snap.importedBy && <span className="meta-sub"> · by {snap.importedBy}</span>}
            </div>
          </div>
        </div>
      )}

      {viewMode === 'combined' && agg && (
        <>
          <div className="mitel-lb-meta">
            <div className="meta-card">
              <div className="meta-label">Range</div>
              <div className="meta-value">{agg.range.from || 'beginning'} → {agg.range.to || 'now'}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Snapshots included</div>
              <div className="meta-value">{includedSnaps.length}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Unique agents</div>
              <div className="meta-value">{agg.agents?.length || 0}</div>
            </div>
            <div className="meta-card">
              <div className="meta-label">Coverage</div>
              <div className="meta-value">
                {includedSnaps.length
                  ? `${includedSnaps[includedSnaps.length - 1]?.startDate || '?'} → ${includedSnaps[0]?.endDate || '?'}`
                  : '—'}
              </div>
            </div>
          </div>
          {overlaps > 0 && (
            <div className="mitel-lb-warn">
              ⚠️ {overlaps} pair{overlaps === 1 ? '' : 's'} of snapshots in this range have overlapping date ranges. Agents in the overlap are counted twice. Delete the redundant imports for accurate numbers.
            </div>
          )}
          {includedSnaps.length === 0 && (
            <div className="mitel-lb-empty">No snapshots fall within this range.</div>
          )}
        </>
      )}

      {(snap || agg) && (
        <>
          {/* ── Executive Summary ──────────────────────────── */}
          <div className="section-title">Executive Summary</div>
          <div className="mitel-lb-totals">
            <div className="totals-tile">
              <div className="totals-num">{summary.avgCallsPerHour.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
              <div className="totals-label">Avg Calls / Hr</div>
            </div>
            <div className="totals-tile">
              <div className="totals-num">{summary.avgOccupancy}%</div>
              <div className="totals-label">Avg Occupancy</div>
            </div>
            <div className="totals-tile">
              <div className="totals-num">{fmtMMSS(summary.avgHandleSec)}</div>
              <div className="totals-label">Avg Handle Time</div>
            </div>
            <div className="totals-tile">
              <div className="totals-num">{summary.avgAvailability}%</div>
              <div className="totals-label">Avg Availability</div>
            </div>
            <div className="totals-tile">
              <div className="totals-num">{summary.rankedCount}</div>
              <div className="totals-label">Ranked Agents</div>
            </div>
            <div className="totals-tile">
              <div className="totals-num">{summary.lowSampleCount}</div>
              <div className="totals-label">Low Sample</div>
            </div>
          </div>

          {/* ── Top 10 / Bottom 10 ────────────────────────── */}
          <div className="two-col">
            <div className="col">
              <div className="section-title">🏆 Top 10 Most Efficient</div>
              {renderCompactTable(top10, { showTrend: viewMode === 'snapshot' && prevSnap })}
            </div>
            <div className="col">
              <div className="section-title">📉 Bottom 10 (coaching opportunities)</div>
              {renderCompactTable(bottom10, { showTrend: viewMode === 'snapshot' && prevSnap })}
            </div>
          </div>

          {/* ── Filter bar ────────────────────────────────── */}
          <div className="section-title" style={{ marginTop: 18 }}>Full Agent Table</div>
          <div className="mitel-lb-toolbar">
            <input
              type="text"
              className="mitel-lb-filter"
              placeholder="Search by name or ext..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {canWrite && viewMode === 'snapshot' && snap && (
              <button className="btn btn-ghost" onClick={deleteSnapshot} style={{ marginLeft: 'auto', color: '#b91c1c' }}>
                Delete this import
              </button>
            )}
          </div>

          {/* ── Full Agent Table ─────────────────────────── */}
          <div className="mitel-lb-table-wrap">
            <table className="mitel-lb-table">
              <thead>
                <tr>
                  <th className="rank-col">#</th>
                  {FULL_COLS.map(col => (
                    <th
                      key={col.key}
                      className={`${col.align === 'right' ? 'align-right' : ''} ${sortKey === col.key ? 'sorted' : ''}`}
                      onClick={() => clickHeader(col)}
                      style={{ cursor: 'pointer' }}
                    >
                      {col.label}
                      {sortKey === col.key && <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedForTable.map((a, idx) => (
                  <tr key={(a.reportingId || '') + a.fullName}>
                    <td className="rank-col">{idx + 1}</td>
                    {FULL_COLS.map(col => (
                      <td key={col.key} className={col.align === 'right' ? 'align-right' : ''}>
                        {col.key === 'fullName' ? (
                          <button className="agent-link" onClick={() => openDrill(a)}>{a.fullName}</button>
                        ) : col.key === 'efficiencyScore' && viewMode === 'snapshot' ? (
                          <>
                            <span className="score-badge">{renderCell(a, col)}</span>
                            {prevSnap && <TrendArrow delta={trendFor(a, 'efficiencyScore')} />}
                          </>
                        ) : renderCell(a, col)}
                      </td>
                    ))}
                  </tr>
                ))}
                {sortedForTable.length === 0 && (
                  <tr><td colSpan={FULL_COLS.length + 1} className="empty-row">No agents match the filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* ── Low Sample Size section ──────────────────── */}
          {processed.lowSample.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 22, cursor: 'pointer' }} onClick={() => setShowLowSample(v => !v)}>
                <span className="lowsample-chevron">{showLowSample ? '▼' : '▶'}</span>
                Low Sample Size ({processed.lowSample.length} agents — &lt;4 shift hrs or &lt;50 ACD calls)
              </div>
              {showLowSample && (
                <div className="mitel-lb-table-wrap">
                  <table className="mitel-lb-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th className="align-right">Shift Hrs</th>
                        <th className="align-right">ACD</th>
                        <th className="align-right">Calls / Hr</th>
                        <th className="align-right">Avg Handle</th>
                        <th className="align-right">Avail %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {processed.lowSample.map(a => (
                        <tr key={(a.reportingId || '') + a.fullName}>
                          <td><button className="agent-link" onClick={() => openDrill(a)}>{a.fullName}</button></td>
                          <td className="align-right">{a.shiftHours.toFixed(1)}</td>
                          <td className="align-right">{(a.acdCalls || 0).toLocaleString()}</td>
                          <td className="align-right">{a.callsPerHour.toFixed(1)}</td>
                          <td className="align-right">{fmtMMSS(a.acdHandlingAvgSec || 0)}</td>
                          <td className="align-right">{a.availability}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── Methodology footnote ─────────────────────── */}
          <div className="methodology">
            <strong>Efficiency Score (0–100):</strong> {METRICS.map(m => `${Math.round(m.weight * 100)}% ${m.label.toLowerCase()}`).join(' + ')}.
            Metrics are min-max normalized across ranked agents for the current view. Lower is better for handle time
            (with a 60s floor to prevent over-rewarding rushed calls). Ranking requires a completed shift (≥4 hours, covering both 4hr and 8hr standard shifts) <em>and</em> ≥50 ACD calls.
          </div>
        </>
      )}

      {/* ── Import modal ───────────────────────────────── */}
      {importOpen && (
        <div className="mitel-lb-modal" onClick={e => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className="mitel-lb-modal-content">
            <div className="modal-header">
              <h2>Import Report</h2>
              <button className="modal-close" onClick={() => setImportOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="upload-section">
                <label className="file-upload-label">
                  <input
                    type="file"
                    accept=".txt,.tsv,.csv,text/plain,text/csv"
                    onChange={e => uploadFile(e.target.files?.[0])}
                    disabled={importing}
                  />
                  <span className="file-upload-button">📁 Upload .txt / .tsv / .csv</span>
                </label>
              </div>
              <div className="modal-divider"><span>or paste</span></div>
              <textarea
                className="paste-area"
                placeholder="Paste the entire report here, starting with 'Agent Group Performance by Agent'..."
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                disabled={importing}
                rows={12}
              />
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setImportOpen(false)} disabled={importing}>Cancel</button>
                <button className="btn btn-primary" onClick={submitImport} disabled={importing || !pasteText.trim()}>
                  {importing ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Exclusions modal ───────────────────────────── */}
      {exclOpen && (
        <div className="mitel-lb-modal" onClick={e => { if (e.target === e.currentTarget) setExclOpen(false); }}>
          <div className="mitel-lb-modal-content mitel-lb-excl">
            <div className="modal-header">
              <h2>Excluded Extensions</h2>
              <button className="modal-close" onClick={() => setExclOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--muted, #6b7a99)', marginTop: 0, marginBottom: 14 }}>
                Admins, supervisors, QA reviewers, and other extensions that shouldn't be evaluated as call-handling agents. Excluded extensions never appear on the leaderboard, the Top/Bottom 10 boards, the Full Agent Table, or the Low Sample list.
              </p>

              {canWrite ? (
                <div className="excl-form">
                  <input
                    type="text"
                    className="mitel-lb-filter"
                    placeholder="Extension (e.g. 2063)"
                    value={newExclExt}
                    onChange={e => setNewExclExt(e.target.value)}
                    style={{ flex: '0 0 150px' }}
                  />
                  <input
                    type="text"
                    className="mitel-lb-filter"
                    placeholder="Name (optional)"
                    value={newExclName}
                    onChange={e => setNewExclName(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <input
                    type="text"
                    className="mitel-lb-filter"
                    placeholder="Reason (optional)"
                    value={newExclReason}
                    onChange={e => setNewExclReason(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-primary" onClick={addExclusion} disabled={!newExclExt.trim()}>Add</button>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--muted, #6b7a99)', marginBottom: 14 }}>
                  Read-only — only super admins and Call Center Ops can edit exclusions.
                </div>
              )}

              {exclusions.length === 0 ? (
                <div className="mitel-lb-empty" style={{ padding: 24, marginTop: 14 }}>No extensions excluded yet.</div>
              ) : (
                <div className="mitel-lb-table-wrap" style={{ marginTop: 14 }}>
                  <table className="mitel-lb-table">
                    <thead>
                      <tr>
                        <th>Ext</th>
                        <th>Name</th>
                        <th>Reason</th>
                        <th>Added</th>
                        {canWrite && <th></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {exclusions.map(e => (
                        <tr key={e.extension}>
                          <td><strong>{e.extension}</strong></td>
                          <td>{e.name || '—'}</td>
                          <td>{e.reason || '—'}</td>
                          <td style={{ fontSize: 12, color: 'var(--muted, #6b7a99)' }}>
                            {e.addedAt ? new Date(e.addedAt).toLocaleDateString() : '—'}
                            {e.addedBy && <> · {e.addedBy}</>}
                          </td>
                          {canWrite && (
                            <td className="align-right">
                              <button className="btn btn-ghost" onClick={() => removeExclusion(e.extension)} style={{ color: '#b91c1c', padding: '4px 10px' }}>
                                Remove
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* If the current view contains rows that match an exclusion, list them
                  so the user can sanity-check that they hid the right people. */}
              {processed.excluded?.length > 0 && (
                <>
                  <div className="section-title" style={{ marginTop: 18 }}>
                    Excluded agents in this view ({processed.excluded.length})
                  </div>
                  <div className="mitel-lb-table-wrap">
                    <table className="mitel-lb-table">
                      <thead>
                        <tr>
                          <th>Ext</th>
                          <th>Name</th>
                          <th className="align-right">Shift Hrs</th>
                          <th className="align-right">ACD</th>
                          <th className="align-right">Calls / Hr</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processed.excluded.map(a => (
                          <tr key={(a.reportingId || '') + a.fullName}>
                            <td>{a.reportingId}</td>
                            <td>{a.fullName}</td>
                            <td className="align-right">{a.shiftHours.toFixed(1)}</td>
                            <td className="align-right">{(a.acdCalls || 0).toLocaleString()}</td>
                            <td className="align-right">{a.callsPerHour.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Drill-down modal ───────────────────────────── */}
      {drillAgent && (
        <div className="mitel-lb-modal" onClick={e => { if (e.target === e.currentTarget) setDrillAgent(null); }}>
          <div className="mitel-lb-modal-content mitel-lb-drill">
            <div className="modal-header">
              <h2>{drillAgent.fullName || 'Agent'} <span className="drill-ext">· ext {drillAgent.reportingId}</span></h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {canWrite && drillAgent.reportingId && !exclusions.find(e => String(e.extension) === String(drillAgent.reportingId)) && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => { startExcludeFor(drillAgent); setDrillAgent(null); }}
                    style={{ fontSize: 12 }}
                  >
                    Exclude this agent
                  </button>
                )}
                <button className="modal-close" onClick={() => setDrillAgent(null)}>×</button>
              </div>
            </div>
            <div className="modal-body">
              {drillLoading && <div className="mitel-lb-empty" style={{ padding: 30 }}>Loading…</div>}
              {!drillLoading && (drillAgent.rows?.length === 0 ? (
                <div className="mitel-lb-empty" style={{ padding: 30 }}>No data found for this agent.</div>
              ) : (
                <div className="mitel-lb-table-wrap" style={{ maxHeight: '60vh' }}>
                  <table className="mitel-lb-table">
                    <thead>
                      <tr>
                        <th>Week</th>
                        <th className="align-right">Shift Hrs</th>
                        <th className="align-right">ACD</th>
                        <th className="align-right">Calls / Hr</th>
                        <th className="align-right">Avg Handle</th>
                        <th className="align-right">Occ %</th>
                        <th className="align-right">Avail %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drillAgent.rows.map(r => {
                        const shiftHrs = (r.shiftDurationSec || 0) / 3600;
                        const cph = shiftHrs > 0 ? (r.acdCalls || 0) / shiftHrs : 0;
                        const mb = (r.shiftDurationSec || 0) > 0 ? ((r.makeBusySec || 0) / r.shiftDurationSec) * 100 : 0;
                        const dd = (r.shiftDurationSec || 0) > 0 ? ((r.dndSec || 0)      / r.shiftDurationSec) * 100 : 0;
                        const av = Math.max(0, 100 - mb - dd);
                        return (
                          <tr key={r.snapshotId}>
                            <td>{r.startDate || '?'} → {r.endDate || '?'}</td>
                            <td className="align-right">{shiftHrs.toFixed(1)}</td>
                            <td className="align-right">{(r.acdCalls || 0).toLocaleString()}</td>
                            <td className="align-right">{cph.toFixed(1)}</td>
                            <td className="align-right">{fmtMMSS(r.acdHandlingAvgSec || 0)}</td>
                            <td className="align-right">{r.acdPct ?? 0}%</td>
                            <td className="align-right">{av.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
