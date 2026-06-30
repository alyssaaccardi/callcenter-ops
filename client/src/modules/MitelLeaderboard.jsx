import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import './MitelLeaderboard.css';

// Column groups shown on the leaderboard. Keys match the parser's COLUMNS export.
const TABLE_COLS = [
  { key: 'fullName',         label: 'Agent',             align: 'left',  type: 'text', defaultDir: 'asc' },
  { key: 'reportingId',      label: 'Ext',               align: 'left',  type: 'text', defaultDir: 'asc' },
  { key: 'acdCalls',         label: 'ACD',               align: 'right', type: 'int',  defaultDir: 'desc', isPrimary: true },
  { key: 'nonAcdCalls',      label: 'Non-ACD',           align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'outboundCalls',    label: 'Outbound',          align: 'right', type: 'int',  defaultDir: 'desc' },
  { key: 'shiftDuration',    label: 'Shift',             align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdHandling',      label: 'ACD Time',          align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdHandlingAvg',   label: 'Avg Handle',        align: 'right', type: 'time', defaultDir: 'desc' },
  { key: 'acdPct',           label: 'ACD %',             align: 'right', type: 'pct',  defaultDir: 'desc' },
  { key: 'makeBusyPct',      label: 'Make Busy %',       align: 'right', type: 'pct',  defaultDir: 'asc'  },
  { key: 'dndPct',           label: 'DND %',             align: 'right', type: 'pct',  defaultDir: 'asc'  },
];

function fmtTime(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

  const [snapshots, setSnapshots] = useState([]);
  const [activeId, setActiveId]   = useState(null);
  const [snap, setSnap]           = useState(null);
  const [loading, setLoading]     = useState(true);

  const [sortKey, setSortKey] = useState('acdCalls');
  const [sortDir, setSortDir] = useState('desc');
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter]   = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText]   = useState('');
  const [importing, setImporting]   = useState(false);

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
    } finally {
      setLoading(false);
    }
  }, [activeId, toast]);

  useEffect(() => { fetchSnapshots(); }, []);  // eslint-disable-line

  useEffect(() => {
    if (!activeId) { setSnap(null); return; }
    let cancelled = false;
    setLoading(true);
    api.get(`/api/mitel-leaderboard/${activeId}`)
      .then(r => { if (!cancelled) setSnap(r.data); })
      .catch(() => { if (!cancelled) toast('Could not load snapshot', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, toast]);

  function clickHeader(col) {
    if (sortKey === col.key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(col.key);
      setSortDir(col.defaultDir);
    }
  }

  const rows = useMemo(() => {
    if (!snap?.agents) return [];
    const col = TABLE_COLS.find(c => c.key === sortKey) || TABLE_COLS[2];
    const filterLower = filter.trim().toLowerCase();
    return snap.agents
      .filter(a => {
        // "Inactive" = zero ACD calls *and* zero shift time. Tunable; the heuristic
        // hides system accounts and PTO weeks without hiding low-volume real shifts.
        if (!showInactive && a.acdCalls === 0 && (a.shiftDurationSec || 0) === 0) return false;
        if (filterLower && !a.fullName.toLowerCase().includes(filterLower) && !String(a.reportingId).includes(filterLower)) return false;
        return true;
      })
      .sort((a, b) => compareCell(a, b, col, sortDir));
  }, [snap, sortKey, sortDir, showInactive, filter]);

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

  function renderCell(a, col) {
    const v = a[col.key];
    if (col.type === 'time') return fmtTime(a[col.key + 'Sec'] || 0);
    if (col.type === 'pct')  return (v != null ? `${v}%` : '—');
    if (col.type === 'int')  return (v ?? 0).toLocaleString();
    return v ?? '';
  }

  const totals = snap?.totals;
  const hiddenCount = snap?.agents
    ? snap.agents.length - rows.length
    : 0;

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
          {snapshots.length > 0 && (
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
          {canWrite && (
            <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
              + Import Report
            </button>
          )}
        </div>
      </div>

      {loading && !snap && <div className="mitel-lb-empty">Loading…</div>}

      {!loading && !snap && (
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

      {snap && (
        <>
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

          {totals && (
            <div className="mitel-lb-totals">
              <div className="totals-tile"><div className="totals-num">{(totals.acdCalls || 0).toLocaleString()}</div><div className="totals-label">ACD calls handled</div></div>
              <div className="totals-tile"><div className="totals-num">{(totals.nonAcdCalls || 0).toLocaleString()}</div><div className="totals-label">Non-ACD</div></div>
              <div className="totals-tile"><div className="totals-num">{(totals.outboundCalls || 0).toLocaleString()}</div><div className="totals-label">Outbound</div></div>
              <div className="totals-tile"><div className="totals-num">{fmtTime(totals.shiftDurationSec)}</div><div className="totals-label">Total shift</div></div>
              <div className="totals-tile"><div className="totals-num">{fmtTime(totals.acdHandlingSec)}</div><div className="totals-label">ACD handling</div></div>
              <div className="totals-tile"><div className="totals-num">{totals.acdPct ?? 0}%</div><div className="totals-label">ACD % shift</div></div>
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
            {canWrite && (
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
                        {renderCell(a, col)}
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
                    accept=".txt,.tsv,.csv,text/plain"
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
    </div>
  );
}
