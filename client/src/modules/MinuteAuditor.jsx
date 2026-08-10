import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './MinuteAuditor.css';

const COLUMNS = [
  { key: 'client',          label: 'Client',            align: 'left',  type: 'text' },
  { key: 'coCustomerId',    label: 'CO ID',             align: 'right', type: 'text' },
  { key: 'clientType',      label: 'Tenant',            align: 'left',  type: 'text' },
  { key: 'billingCategory', label: 'CSV Category',      align: 'left',  type: 'text' },
  { key: 'billingCycle',    label: 'Cycle',             align: 'left',  type: 'text' },
  { key: 'allotted',        label: 'Allotted',          align: 'right', type: 'num'  },
  { key: 'used',            label: 'Used',              align: 'right', type: 'num'  },
  { key: 'remaining',       label: '% Remain',          align: 'right', type: 'text' },
  { key: 'totalCalls',      label: 'Calls',             align: 'right', type: 'num'  },
  { key: 'coStatus',        label: 'CO Status',         align: 'left',  type: 'text' },
  { key: 'coSubStatus',     label: 'CO Sub',            align: 'left',  type: 'text' },
  { key: 'daysOverdue',     label: 'Days Ovd',          align: 'right', type: 'num'  },
  { key: 'balance',         label: 'Balance',           align: 'right', type: 'money'},
  { key: 'mrr',             label: 'MRR',               align: 'right', type: 'money'},
  { key: 'paidBadge',       label: 'Paid?',             align: 'center', type: 'badge' },
];

function fmtNum(v) {
  if (v === '' || v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v);
}
function fmtMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Flatten job row → cell values keyed by column
function flattenRow(r) {
  const co = r.chargeover || {};
  return {
    ...r,
    coStatus:    co.status || '',
    coSubStatus: co.subStatus || '',
    daysOverdue: co.daysOverdue ?? '',
    balance:     co.balance ?? '',
    mrr:         co.mrr ?? '',
    coCompany:   co.company || '',
    coUrl:       co.url || '',
    resolvedTenant: co.tenant || r.clientType || '',
  };
}

// CSV export — enriched with CO columns
function toCsv(rows) {
  const header = [
    'Client','COCustomerId','Tenant (CSV)','Tenant (CO)','Billing Category','Billing Cycle',
    'Allotted','Used','Remaining','Total Calls','Emails','SMS Pages',
    'CO Status','CO Sub Status','Days Overdue','Balance','MRR','Paid','Error','CO URL',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    const co = r.chargeover || {};
    lines.push([
      r.client, r.coCustomerId, r.clientType, co.tenant || '',
      r.billingCategory, r.billingCycle,
      r.allotted, r.used, r.remaining, r.totalCalls, r.emails, r.smsPages,
      co.status || '', co.subStatus || '', co.daysOverdue ?? '', co.balance ?? '', co.mrr ?? '',
      r.paid === true ? 'Paid' : r.paid === false ? 'Unpaid' : '',
      r.error || '', co.url || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

export default function MinuteAuditor() {
  const { toast } = useApp();
  const [view, setView] = useState('upload'); // upload | running | results
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'client', dir: 'asc' });
  const [filterPaid, setFilterPaid] = useState('all'); // all | paid | unpaid | notfound
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterTenant, setFilterTenant] = useState('all');
  const [search, setSearch] = useState('');
  const readerRef = useRef(null);

  useEffect(() => () => { try { readerRef.current?.cancel(); } catch { /* reader may already be closed */ } }, []);

  const onFile = (f) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) {
      setError('Please select a .csv file.');
      return;
    }
    setError('');
    setFile(f);
  };
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    onFile(e.dataTransfer.files?.[0]);
  }, []);

  const startStream = useCallback(async (jId, total) => {
    setProgress({ done: 0, total });
    setResults([]);
    try {
      const resp = await fetch(`/api/minute-auditor/stream/${jId}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok) { setError(`Stream error: ${resp.status}`); setView('results'); return; }
      const reader = resp.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim());
            if (msg.type === 'result' && msg.result) {
              setResults(prev => [...prev, msg.result]);
              setProgress({ done: msg.done, total: msg.total });
            } else if (msg.type === 'progress') {
              setProgress({ done: msg.done, total: msg.total });
            } else if (msg.type === 'done') {
              setProgress({ done: msg.done, total: msg.total });
              setView('results');
              return;
            }
          } catch { /* skip malformed event */ }
        }
      }
      setView('results');
    } catch (e) {
      setError('Stream disconnected: ' + e.message);
      setView('results');
    }
  }, []);

  const handleRun = async () => {
    if (!file) { setError('Select a CSV first.'); return; }
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const resp = await api.post('/api/minute-auditor/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const { jobId, total } = resp.data;
      setView('running');
      startStream(jobId, total);
    } catch (e) {
      setError('Upload failed: ' + (e.response?.data?.error || e.message));
    }
  };

  const handleReset = () => {
    setView('upload');
    setFile(null);
    setProgress({ done: 0, total: 0 });
    setResults([]);
    setError('');
    setSort({ key: 'client', dir: 'asc' });
    setFilterPaid('all');
    setFilterCategory('all');
    setFilterTenant('all');
    setSearch('');
  };

  const flat = useMemo(() => results.map(flattenRow), [results]);

  const categories = useMemo(() => {
    const s = new Set();
    flat.forEach(r => r.billingCategory && s.add(r.billingCategory));
    return [...s].sort();
  }, [flat]);

  const tenants = useMemo(() => {
    const s = new Set();
    flat.forEach(r => r.clientType && s.add(r.clientType));
    return [...s].sort();
  }, [flat]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return flat.filter(r => {
      if (filterPaid === 'paid'     && r.paid !== true) return false;
      if (filterPaid === 'unpaid'   && (r.paid !== false || r.error === 'Not found in ChargeOver')) return false;
      if (filterPaid === 'notfound' && r.error !== 'Not found in ChargeOver' && r.error !== 'No COCustomerId') return false;
      if (filterCategory !== 'all' && r.billingCategory !== filterCategory) return false;
      if (filterTenant   !== 'all' && r.clientType     !== filterTenant)     return false;
      if (q) {
        const hay = `${r.client} ${r.coCustomerId} ${r.coCompany} ${r.billingCategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, filterPaid, filterCategory, filterTenant, search]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av = a[sort.key];
      let bv = b[sort.key];
      if (sort.key === 'paidBadge') {
        av = a.paid === true ? 2 : a.paid === false ? 1 : 0;
        bv = b.paid === true ? 2 : b.paid === false ? 1 : 0;
      } else if (col.type === 'num' || col.type === 'money') {
        av = Number(av); bv = Number(bv);
        if (!Number.isFinite(av)) av = -Infinity;
        if (!Number.isFinite(bv)) bv = -Infinity;
      } else {
        av = (av ?? '').toString().toLowerCase();
        bv = (bv ?? '').toString().toLowerCase();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  }, [filtered, sort]);

  const summary = useMemo(() => {
    const s = { total: flat.length, paid: 0, unpaid: 0, notfound: 0, error: 0 };
    for (const r of flat) {
      if (r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId') s.notfound++;
      else if (r.error) s.error++;
      else if (r.paid === true) s.paid++;
      else if (r.paid === false) s.unpaid++;
    }
    return s;
  }, [flat]);

  const toggleSort = (key) => {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  };

  const doExport = () => {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `minute-audit-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Exported enriched CSV', 'success');
  };

  return (
    <div className="ma-root">
      <div className="ma-header">
        <div>
          <h1 className="ma-title">Minute Usage vs. Paid Auditor</h1>
          <div className="ma-subtitle">Verify that customers in your minute-usage export match ChargeOver paid status.</div>
        </div>
        {view === 'results' && (
          <div className="ma-header-actions">
            <button className="ma-btn ma-btn-ghost" onClick={handleReset}>New upload</button>
            <button className="ma-btn ma-btn-primary" onClick={doExport}>Export CSV</button>
          </div>
        )}
      </div>

      {error && <div className="ma-alert">{error}</div>}

      {view === 'upload' && (
        <div className="ma-upload-panel">
          <div
            className={`ma-drop${dragOver ? ' ma-drop-active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="ma-drop-icon">📄</div>
            <div className="ma-drop-title">{file ? file.name : 'Drop a Percentage_YYYY-MM-DD.csv here'}</div>
            <div className="ma-drop-hint">…or click to browse. Multi-section files (STANDARD / TRIAL / PENDING CANCELLATION / etc.) parse automatically.</div>
            <input type="file" accept=".csv,text/csv" className="ma-drop-input" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          <div className="ma-actions">
            <button className="ma-btn ma-btn-primary" disabled={!file} onClick={handleRun}>Run audit</button>
            {file && <button className="ma-btn ma-btn-ghost" onClick={() => setFile(null)}>Clear</button>}
          </div>
        </div>
      )}

      {view === 'running' && (
        <div className="ma-running-panel">
          <div className="ma-progress-label">
            Checking ChargeOver… <b>{progress.done}</b> / {progress.total}
          </div>
          <div className="ma-progress-bar">
            <div className="ma-progress-fill" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <div className="ma-progress-hint">Streaming results as each row completes.</div>
        </div>
      )}

      {view === 'results' && (
        <>
          <div className="ma-summary">
            <div className="ma-stat"><div className="ma-stat-num">{summary.total}</div><div className="ma-stat-label">Rows</div></div>
            <div className="ma-stat ma-stat-green"><div className="ma-stat-num">{summary.paid}</div><div className="ma-stat-label">Paid</div></div>
            <div className="ma-stat ma-stat-red"><div className="ma-stat-num">{summary.unpaid}</div><div className="ma-stat-label">Unpaid</div></div>
            <div className="ma-stat ma-stat-amber"><div className="ma-stat-num">{summary.notfound}</div><div className="ma-stat-label">Not in CO</div></div>
            {summary.error > 0 && <div className="ma-stat ma-stat-amber"><div className="ma-stat-num">{summary.error}</div><div className="ma-stat-label">Errors</div></div>}
          </div>

          <div className="ma-filters">
            <input
              className="ma-search"
              type="text"
              placeholder="Search client, CO ID, category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="ma-select" value={filterPaid} onChange={e => setFilterPaid(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="paid">Paid only</option>
              <option value="unpaid">Unpaid only</option>
              <option value="notfound">Not found in CO</option>
            </select>
            <select className="ma-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="all">All CSV categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="ma-select" value={filterTenant} onChange={e => setFilterTenant(e.target.value)}>
              <option value="all">All tenants</option>
              {tenants.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="ma-filter-count">{sorted.length} of {flat.length}</div>
          </div>

          <div className="ma-table-wrap">
            <table className="ma-table">
              <thead>
                <tr>
                  {COLUMNS.map(c => (
                    <th
                      key={c.key}
                      className={`ma-th ma-th-${c.align}${sort.key === c.key ? ' ma-th-active' : ''}`}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {sort.key === c.key && <span className="ma-th-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={i} className={r.paid === false ? 'ma-row-unpaid' : r.paid === true ? 'ma-row-paid' : 'ma-row-neutral'}>
                    <td className="ma-td ma-td-left">
                      <div className="ma-client-name">{r.client || '—'}</div>
                      {r.coCompany && r.coCompany.toLowerCase() !== (r.client || '').toLowerCase() && (
                        <div className="ma-client-alias">CO: {r.coCompany}</div>
                      )}
                    </td>
                    <td className="ma-td ma-td-right">
                      {r.coUrl
                        ? <a href={r.coUrl} target="_blank" rel="noopener noreferrer" className="ma-link">{r.coCustomerId || '—'}</a>
                        : (r.coCustomerId || '—')}
                    </td>
                    <td className="ma-td ma-td-left">{r.resolvedTenant || r.clientType || '—'}</td>
                    <td className="ma-td ma-td-left">{r.billingCategory || '—'}</td>
                    <td className="ma-td ma-td-left ma-cycle">{r.billingCycle || '—'}</td>
                    <td className="ma-td ma-td-right">{fmtNum(r.allotted)}</td>
                    <td className="ma-td ma-td-right">{fmtNum(r.used)}</td>
                    <td className="ma-td ma-td-right">{r.remaining || '—'}</td>
                    <td className="ma-td ma-td-right">{fmtNum(r.totalCalls)}</td>
                    <td className="ma-td ma-td-left">{r.coStatus || '—'}</td>
                    <td className="ma-td ma-td-left">{r.coSubStatus || '—'}</td>
                    <td className={`ma-td ma-td-right${Number(r.daysOverdue) > 0 ? ' ma-td-overdue' : ''}`}>
                      {r.daysOverdue === '' ? '—' : fmtNum(r.daysOverdue)}
                    </td>
                    <td className="ma-td ma-td-right">{fmtMoney(r.balance)}</td>
                    <td className="ma-td ma-td-right">{fmtMoney(r.mrr)}</td>
                    <td className="ma-td ma-td-center">
                      {r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId'
                        ? <span className="ma-badge ma-badge-gray" title={r.error}>Not in CO</span>
                        : r.paid === true
                          ? <span className="ma-badge ma-badge-green">Paid</span>
                          : r.paid === false
                            ? <span className="ma-badge ma-badge-red" title={r.error || ''}>Unpaid</span>
                            : <span className="ma-badge ma-badge-gray" title={r.error || ''}>?</span>}
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} className="ma-empty">No rows match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
