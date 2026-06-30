import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import './MitelLeaderboard.css';

// Columns shown on the table. Keys match both /api/mitel-leaderboard/:id and the
// aggregated payload from /api/mitel-leaderboard/aggregate (same agent shape).
const TABLE_COLS = [
  { key: 'fullName',         label: 'Agent',             align: 'left',  type: 'text', defaultDir: 'asc' },
  { key: 'reportingId',      label: 'Ext',               align: 'left',  type: 'text', defaultDir: 'asc' },
  { key: 'acdCalls',         label: 'ACD',               align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'nonAcdCalls',      label: 'Non-ACD',           align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'outboundCalls',    label: 'Outbound',          align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'shiftDuration',    label: 'Shift',             align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdHandling',      label: 'ACD Time',          align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdHandlingAvg',   label: 'Avg Handle',        align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdPct',           label: 'ACD %',             align: 'right', type: 'pct',  defaultDir: 'desc' },
  { key: 'makeBusyPct',      label: 'Make Busy %',       align: 'right', type: 'pct',  defaultDir: 'asc'  },
  { key: 'dndPct',           label: 'DND %',             align: 'right', type: 'pct',  defaultDir: 'asc'  },
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

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Convert a preset key to {from, to} as ISO yyyy-mm-dd, or {} for "all time".
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
  if (col.type === 'time') { av = a[col.key + 'Sec'] || 0; bv = b[col.key + 'Sec'] || 0; }
  else if (col.type === 'int' || col.type === 'pct') { av = a[col.key] || 0; bv = b[col.key] || 0; }
  else { av = (a[col.key] || '').toString().toLowerCase(); bv = (b[col.key] || '').toString().toLowerCase(); }
  if (av < bv) return dir === 'asc' ? -1 : 1;
  if (av > bv) return dir === 'asc' ? 1  : -1;
  return 0;
}

function periodLabel(snap) {
  if (snap?.startDate && snap?.endDate) return `${snap.startDate} – ${snap.endDate}`;
  return snap?.periodLine || 'Unknown period';
}

export default function MitelLeaderboard() {
  const { toast } = useApp();
  const { user } = useAuth();
  const canWrite = user?.role === 'super_admin' || user?.role === 'call_center_ops';

  const [viewMode, setViewMode] = useState('snapshot');
  const [snapshots, setSnapshots] = useState([]);
  const [activeId, setActiveId]   = useState(null);
  const [snap, setSnap]           = useState(null);
  const [agg, setAgg]             = useState(null);
  const [loading, setLoading]     = useState(true);

  const [rangePreset, setRangePreset] = useState('12w');
  const [customFrom, setCustomFrom]   = useState('');
  const [customTo,   setCustomTo]     = useState('');

  const [sortKey, setSortKey] = useState('acdCalls');
  const [sortDir, setSortDir] = useState('desc');
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter]   = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText]   = useState('');
  const [importing, setImporting]   = useState(false);

  const [drillAgent, setDrillAgent] = useState(null);     // { reportingId, fullName, rows }
  const [drillLoading, setDrillLoading] = useState(false);

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

  // Initial load
  useEffect(() => { fetchSnapshots().finally(() => setLoading(false)); }, []);  // eslint-disable-line

  // Snapshot view — fetch one snapshot at a time
  useEffect(() => {
    if (viewMode !== 'snapshot' || !activeId) return;
    let cancelled = false;
    setLoading(true);
    api.get(`/api/mitel-leaderboard/${activeId}`)
      .then(r => { if (!cancelled) setSnap(r.data); })
      .catch(() => { if (!cancelled) toast('Could not load snapshot', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewMode, activeId, toast]);

  // Combined view — fetch aggregated data whenever the range changes
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

  function clickHeader(col) {
    if (sortKey === col.key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(col.key);
      setSortDir(col.defaultDir);
    }
  }

  // Data source for the table is whichever view is active
  const sourceAgents = viewMode === 'combined' ? (agg?.agents || []) : (snap?.agents || []);

  const rows = useMemo(() => {
    if (!sourceAgents.length) return [];
    const col = TABLE_COLS.find(c => c.key === sortKey) || TABLE_COLS[2];
    const filterLower = filter.trim().toLowerCase();
    return sourceAgents
      .filter(a => {
        if (!showInactive && a.acdCalls === 0 && (a.shiftDurationSec || 0) === 0) return false;
        if (filterLower && !(a.fullName || '').toLowerCase().includes(filterLower) && !String(a.reportingId || '').includes(filterLower)) return false;
        return true;
      })
      .sort((a, b) => compareCell(a, b, col, sortDir));
  }, [sourceAgents, sortKey, sortDir, showInactive, filter]);

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

  function renderCell(a, col) {
    const v = a[col.key];
    if (col.type === 'time') return fmtTime(a[col.key + 'Sec'] || 0);
    if (col.type === 'pct')  return (v != null ? `${v}%` : '—');
    if (col.type === 'int')  return (v ?? 0).toLocaleString();
    return v ?? '';
  }

  const totals = viewMode === 'combined' ? agg?.totals : snap?.totals;
  const hiddenCount = sourceAgents.length - rows.length;
  const overlaps    = agg?.overlaps?.length || 0;
  const includedSnaps = agg?.snapshots || [];

  return (
    <div className="mitel-lb">
      <div className="mitel-lb-header">
        <div>
          <h1>Mitel Leaderboard</h1>
          <div className="mitel-lb-sub">
            Agent group performance imported from MiCC's "Agent Group Performance by Agent" report.
          </div>
        </div>
        <div className="mitel-lb-actions">
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
          Snapshot
        </button>
        <button
          className={`mode-btn ${viewMode === 'combined' ? 'active' : ''}`}
          onClick={() => setViewMode('combined')}
        >
          Combined Range
        </button>
        <div style={{ flex: 1 }} />
        {viewMode === 'snapshot' && snapshots.length > 0 && (
          <select
            className="mitel-lb-select"
            value={activeId || ''}
            onChange={e => setActiveId(e.target.value)}
          >
            {snapshots.map(s => (
              <option key={s.id} value={s.id}>
                {periodLabel(s)} ({s.agentCount} agents)
              </option>
            ))}
          </select>
        )}
        {viewMode === 'combined' && (
          <>
            <select
              className="mitel-lb-select"
              value={rangePreset}
              onChange={e => setRangePreset(e.target.value)}
            >
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
            <div className="meta-label">Imported</div>
            <div className="meta-value">
              {snap.importedAt ? new Date(snap.importedAt).toLocaleString() : '—'}
              {snap.importedBy && <span className="meta-sub"> · by {snap.importedBy}</span>}
            </div>
          </div>
          <div className="meta-card">
            <div className="meta-label">Source</div>
            <div className="meta-value">{snap.createdAt || '—'} <span className="meta-sub">· {snap.createdBy || ''}</span></div>
          </div>
        </div>
      )}

      {viewMode === 'combined' && agg && (
        <>
          <div className="mitel-lb-meta">
            <div className="meta-card">
              <div className="meta-label">Range</div>
              <div className="meta-value">
                {agg.range.from || 'beginning'} → {agg.range.to || 'now'}
              </div>
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
          {totals && (
            <div className="mitel-lb-totals">
              <div className="totals-tile"><div className="totals-num">{(totals.acdCalls || 0).toLocaleString()}</div><div className="totals-label">ACD calls</div></div>
              <div className="totals-tile"><div className="totals-num">{(totals.nonAcdCalls || 0).toLocaleString()}</div><div className="totals-label">Non-ACD</div></div>
              <div className="totals-tile"><div className="totals-num">{(totals.outboundCalls || 0).toLocaleString()}</div><div className="totals-label">Outbound</div></div>
              <div className="totals-tile"><div className="totals-num">{fmtTime(totals.shiftDurationSec)}</div><div className="totals-label">Total shift</div></div>
              <div className="totals-tile"><div className="totals-num">{fmtTime(totals.acdHandlingSec)}</div><div className="totals-label">ACD handling</div></div>
              <div className="totals-tile">
                <div className="totals-num">
                  {totals.shiftDurationSec > 0
                    ? `${Math.round((totals.acdHandlingSec / totals.shiftDurationSec) * 1000) / 10}%`
                    : '—'}
                </div>
                <div className="totals-label">ACD % shift</div>
              </div>
            </div>
          )}

          <div className="mitel-lb-toolbar">
            <input
              type="text"
              className="mitel-lb-filter"
              placeholder="Search by name or ext..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <label className="mitel-lb-toggle">
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
              Show inactive ({hiddenCount} hidden)
            </label>
            {canWrite && viewMode === 'snapshot' && snap && (
              <button className="btn btn-ghost" onClick={deleteSnapshot} style={{ marginLeft: 'auto', color: '#b91c1c' }}>
                Delete this import
              </button>
            )}
          </div>

          <div className="mitel-lb-table-wrap">
            <table className="mitel-lb-table">
              <thead>
                <tr>
                  <th className="rank-col">#</th>
                  {TABLE_COLS.map(col => (
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
                {rows.map((a, idx) => (
                  <tr key={a.reportingId + a.fullName}>
                    <td className="rank-col">{idx + 1}</td>
                    {TABLE_COLS.map(col => (
                      <td key={col.key} className={col.align === 'right' ? 'align-right' : ''}>
                        {col.key === 'fullName' ? (
                          <button className="agent-link" onClick={() => openDrill(a)}>
                            {a.fullName}
                          </button>
                        ) : renderCell(a, col)}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={TABLE_COLS.length + 1} className="empty-row">No agents match the filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

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

      {drillAgent && (
        <div className="mitel-lb-modal" onClick={e => { if (e.target === e.currentTarget) setDrillAgent(null); }}>
          <div className="mitel-lb-modal-content mitel-lb-drill">
            <div className="modal-header">
              <h2>{drillAgent.fullName || 'Agent'} <span className="drill-ext">· ext {drillAgent.reportingId}</span></h2>
              <button className="modal-close" onClick={() => setDrillAgent(null)}>×</button>
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
                        <th className="align-right">ACD</th>
                        <th className="align-right">Non-ACD</th>
                        <th className="align-right">Outbound</th>
                        <th className="align-right">Shift</th>
                        <th className="align-right">ACD Time</th>
                        <th className="align-right">Avg Handle</th>
                        <th className="align-right">ACD %</th>
                        <th className="align-right">Make Busy %</th>
                        <th className="align-right">DND %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drillAgent.rows.map(r => (
                        <tr key={r.snapshotId}>
                          <td>{r.startDate || '?'} → {r.endDate || '?'}</td>
                          <td className="align-right">{(r.acdCalls || 0).toLocaleString()}</td>
                          <td className="align-right">{(r.nonAcdCalls || 0).toLocaleString()}</td>
                          <td className="align-right">{(r.outboundCalls || 0).toLocaleString()}</td>
                          <td className="align-right">{fmtTime(r.shiftDurationSec)}</td>
                          <td className="align-right">{fmtTime(r.acdHandlingSec)}</td>
                          <td className="align-right">{fmtTime(r.acdHandlingAvgSec)}</td>
                          <td className="align-right">{r.acdPct ?? 0}%</td>
                          <td className="align-right">{r.makeBusyPct ?? 0}%</td>
                          <td className="align-right">{r.dndPct ?? 0}%</td>
                        </tr>
                      ))}
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
