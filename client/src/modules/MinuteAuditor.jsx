import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './MinuteAuditor.css';

const COLUMNS = [
  { key: 'flaggedBadge',    label: 'Flag',              align: 'center', type: 'badge' },
  { key: 'client',          label: 'Client',            align: 'left',  type: 'text' },
  { key: 'coCustomerId',    label: 'CO ID',             align: 'right', type: 'text' },
  { key: 'clientType',      label: 'Tenant',            align: 'left',  type: 'text' },
  { key: 'billingCategory', label: 'CSV Category',      align: 'left',  type: 'text' },
  { key: 'planCompare',     label: 'Plan (CSV/CO)',     align: 'right', type: 'text' },
  { key: 'billDayCompare',  label: 'Bill Day (CSV/CO)', align: 'right', type: 'text' },
  { key: 'used',            label: 'Used',              align: 'right', type: 'num'  },
  { key: 'remaining',       label: '% Remain',          align: 'right', type: 'text' },
  { key: 'totalCalls',      label: 'Calls',             align: 'right', type: 'num'  },
  { key: 'activeBadge',     label: 'CO Status',         align: 'center', type: 'badge' },
];

function fmtNum(v) {
  if (v === '' || v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v);
}

// Flatten job row → cell values keyed by column
function flattenRow(r) {
  const co = r.chargeover || {};
  return {
    ...r,
    coCompany:   co.company || '',
    coUrl:       co.url || '',
    resolvedTenant: co.tenant || r.clientType || '',
  };
}

// Return a { primary, secondary } pair used to render a compare cell.
// When both values match: primary = value, secondary = null (single-line, calm).
// When they differ:      primary = CSV value, secondary = CO value (two-line, red).
// When only one exists:  primary = that value, secondary = null.
function compareCell(csvVal, coVal, mismatched) {
  const csvS = csvVal == null || Number.isNaN(csvVal) ? null : String(csvVal);
  const coS  = coVal  == null || Number.isNaN(coVal)  ? null : String(coVal);
  if (csvS && coS && mismatched) return { primary: csvS, secondary: coS };
  if (csvS && coS)               return { primary: csvS, secondary: null };
  return { primary: csvS || coS || '—', secondary: null };
}

function resultLabel(r) {
  if (r.skipped) return 'Skipped';
  if (r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId') return 'No Match';
  if (r.active === true)  return 'Active';
  if (r.active === false) return 'Inactive';
  return '';
}

function flaggedLabel(r) {
  return r.flagged ? 'FLAGGED' : '';
}

// CSV export for the billing team — every field needed to reconcile a
// discrepancy is in this row: CSV values, CO values, per-check mismatch
// booleans, and the resolved audit verdict.
function toCsv(rows) {
  const header = [
    'Flagged','Flag Reasons',
    'Client (CSV)','Company (CO)','Name Match Score','Name Mismatch',
    'COCustomerId','Tenant (CSV)','Tenant (CO)',
    'Billing Category','Billing Cycle (CSV)',
    'Plan CSV (Allotted)','Plan CO (custom_2)','Plan Mismatch',
    'Bill Day CSV','Bill Day CO','Bill Day Mismatch','CO Next Invoice',
    'Used','Remaining','Total Calls','Overage Rate CSV','Overage Rate CO',
    'CO Sub Status','Audit Result','Error','CO URL',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const yn = v => v === true ? 'Y' : v === false ? 'N' : '';
  const lines = [header.join(',')];
  for (const r of rows) {
    const co = r.chargeover || {};
    lines.push([
      flaggedLabel(r), (r.flagReasons || []).join(' + '),
      r.client, co.company || '', r.nameMatchScore ?? '', yn(r.nameMismatch),
      r.coCustomerId, r.clientType, co.tenant || '',
      r.billingCategory, r.billingCycle,
      r.csvPlan ?? r.allotted, r.coPlan ?? '', yn(r.planMismatch),
      r.csvBillDay ?? '', r.coBillDay ?? '', yn(r.billDayMismatch), co.nextInvoiceDate || '',
      r.used, r.remaining, r.totalCalls, r.overageRate, co.overageRate ?? '',
      co.subStatus || '', resultLabel(r), r.error || '', co.url || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

export default function MinuteAuditor() {
  const { toast } = useApp();
  const [view, setView] = useState('upload'); // upload | running | results
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: null, prefetch: null });
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'client', dir: 'asc' });
  // flagged (default) | audited | active | inactive | notfound | skipped | all
  const [filterActive, setFilterActive] = useState('flagged');
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
    setProgress({ done: 0, total, phase: 'prefetching', prefetch: null });
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
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase || 'matching', prefetch: msg.prefetch || null });
            } else if (msg.type === 'progress') {
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase, prefetch: msg.prefetch });
            } else if (msg.type === 'done') {
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase, prefetch: msg.prefetch });
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
    setFilterActive('flagged');
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
    const isNotInCO = r => r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId';
    return flat.filter(r => {
      if (filterActive === 'flagged'         && !r.flagged) return false;
      if (filterActive === 'nameMismatch'    && !r.nameMismatch) return false;
      if (filterActive === 'planMismatch'    && !r.planMismatch) return false;
      if (filterActive === 'billDayMismatch' && !r.billDayMismatch) return false;
      if (filterActive === 'notPaying'       && !(r.flagged && r.active !== true)) return false;
      if (filterActive === 'audited'  && r.skipped) return false;
      if (filterActive === 'active'   && (r.skipped || r.active !== true)) return false;
      if (filterActive === 'inactive' && (r.skipped || r.active !== false || isNotInCO(r))) return false;
      if (filterActive === 'notfound' && (r.skipped || !isNotInCO(r))) return false;
      if (filterActive === 'skipped'  && !r.skipped) return false;
      // 'all' passes everything
      if (filterCategory !== 'all' && r.billingCategory !== filterCategory) return false;
      if (filterTenant   !== 'all' && r.clientType     !== filterTenant)     return false;
      if (q) {
        const hay = `${r.client} ${r.coCustomerId} ${r.coCompany} ${r.billingCategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, filterActive, filterCategory, filterTenant, search]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av = a[sort.key];
      let bv = b[sort.key];
      if (sort.key === 'activeBadge') {
        av = a.active === true ? 2 : a.active === false ? 1 : 0;
        bv = b.active === true ? 2 : b.active === false ? 1 : 0;
      } else if (sort.key === 'flaggedBadge') {
        av = a.flagged ? 1 : 0;
        bv = b.flagged ? 1 : 0;
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
    const s = {
      total: flat.length, audited: 0, flagged: 0, active: 0, inactive: 0,
      notfound: 0, skipped: 0, error: 0,
      nameMismatch: 0, planMismatch: 0, billDayMismatch: 0, notPaying: 0,
    };
    for (const r of flat) {
      if (r.skipped) { s.skipped++; continue; }
      s.audited++;
      if (r.flagged) s.flagged++;
      if (r.nameMismatch)    s.nameMismatch++;
      if (r.planMismatch)    s.planMismatch++;
      if (r.billDayMismatch) s.billDayMismatch++;
      if (r.flagged && r.active !== true) s.notPaying++;
      if (r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId') s.notfound++;
      else if (r.error) s.error++;
      else if (r.active === true) s.active++;
      else if (r.active === false) s.inactive++;
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
          <h1 className="ma-title">Minute Usage Auditor</h1>
          <div className="ma-subtitle">If a customer used minutes but doesn't have an active ChargeOver subscription, they're flagged. INTERNAL, TRIAL, and FREE are skipped.</div>
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
            <div className="ma-drop-hint">…or click to browse. INTERNAL, TRIAL, and FREE customers are automatically excluded from the audit.</div>
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
          {progress.phase === 'prefetching' ? (
            <>
              <div className="ma-progress-label">Loading ChargeOver customer & subscription data…</div>
              <div className="ma-progress-bar ma-progress-indeterminate">
                <div className="ma-progress-fill" />
              </div>
              <div className="ma-progress-hint">
                {progress.prefetch && Object.keys(progress.prefetch).length > 0
                  ? Object.entries(progress.prefetch).map(([k, v]) => `${k}: ${v}`).join(' · ')
                  : 'One-time snapshot per audit — replaces thousands of API calls with a few.'}
              </div>
            </>
          ) : (
            <>
              <div className="ma-progress-label">
                Matching rows against ChargeOver… <b>{progress.done}</b> / {progress.total}
              </div>
              <div className="ma-progress-bar">
                <div className="ma-progress-fill" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
              </div>
              <div className="ma-progress-hint">Streaming results as each row is resolved.</div>
            </>
          )}
        </div>
      )}

      {view === 'results' && (
        <>
          <div className="ma-overview">
            {/* Primary card: everything actionable lives here */}
            <div className={`ma-flag-card${filterActive === 'flagged' ? ' ma-flag-card-selected' : ''}`}>
              <button
                className="ma-flag-headline"
                onClick={() => setFilterActive('flagged')}
                title="Show all flagged customers"
              >
                <div className="ma-flag-count">🚨 {summary.flagged}</div>
                <div className="ma-flag-label">Flagged<br/><span className="ma-flag-sublabel">need review</span></div>
              </button>
              <div className="ma-flag-reasons">
                <button className={`ma-reason${filterActive === 'notPaying' ? ' ma-reason-active' : ''}`}
                        onClick={() => setFilterActive('notPaying')}
                        title="Customer used minutes but has no active CO subscription">
                  <span className="ma-reason-num">{summary.notPaying}</span>
                  <span className="ma-reason-txt">Not Paying</span>
                </button>
                <button className={`ma-reason${filterActive === 'nameMismatch' ? ' ma-reason-active' : ''}`}
                        onClick={() => setFilterActive('nameMismatch')}
                        title="CSV client name differs from CO company name">
                  <span className="ma-reason-num">{summary.nameMismatch}</span>
                  <span className="ma-reason-txt">Name Mismatch</span>
                </button>
                <button className={`ma-reason${filterActive === 'planMismatch' ? ' ma-reason-active' : ''}`}
                        onClick={() => setFilterActive('planMismatch')}
                        title="CSV Allotted minutes differ from the CO subscription plan">
                  <span className="ma-reason-num">{summary.planMismatch}</span>
                  <span className="ma-reason-txt">Plan Mismatch</span>
                </button>
                <button className={`ma-reason${filterActive === 'billDayMismatch' ? ' ma-reason-active' : ''}`}
                        onClick={() => setFilterActive('billDayMismatch')}
                        title="CSV billing cycle day differs from CO next invoice day">
                  <span className="ma-reason-num">{summary.billDayMismatch}</span>
                  <span className="ma-reason-txt">Bill Day Mismatch</span>
                </button>
              </div>
            </div>

            {/* Context tiles */}
            <div className="ma-context">
              <button
                className={`ma-context-tile${filterActive === 'audited' ? ' ma-context-selected' : ''}`}
                onClick={() => setFilterActive('audited')}
                title="Every customer we checked against ChargeOver"
              >
                <div className="ma-context-num">{summary.audited}</div>
                <div className="ma-context-label">Audited</div>
              </button>
              {summary.skipped > 0 && (
                <button
                  className={`ma-context-tile${filterActive === 'skipped' ? ' ma-context-selected' : ''}`}
                  onClick={() => setFilterActive('skipped')}
                  title="INTERNAL / TRIAL / FREE — not audited"
                >
                  <div className="ma-context-num">{summary.skipped}</div>
                  <div className="ma-context-label">Skipped</div>
                </button>
              )}
            </div>
          </div>

          <div className="ma-filters">
            <input
              className="ma-search"
              type="text"
              placeholder="Search client, CO ID, category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="ma-select" value={filterActive} onChange={e => setFilterActive(e.target.value)}>
              <optgroup label="Flagged">
                <option value="flagged">🚨 All flagged</option>
                <option value="notPaying">Not paying</option>
                <option value="nameMismatch">Name mismatch</option>
                <option value="planMismatch">Plan mismatch</option>
                <option value="billDayMismatch">Bill day mismatch</option>
              </optgroup>
              <optgroup label="Context">
                <option value="audited">All audited</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
                <option value="notfound">No CO match only</option>
                <option value="skipped">Skipped only</option>
                <option value="all">Everything (incl. skipped)</option>
              </optgroup>
            </select>
            <select className="ma-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="all">All CSV categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="ma-select" value={filterTenant} onChange={e => setFilterTenant(e.target.value)}>
              <option value="all">All tenants</option>
              {tenants.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="ma-filter-count">Showing <b>{sorted.length}</b> of {flat.length}</div>
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
                  <tr key={i} className={r.flagged ? 'ma-row-flagged' : r.skipped ? 'ma-row-skipped' : r.active === false ? 'ma-row-unpaid' : r.active === true ? 'ma-row-paid' : 'ma-row-neutral'}>
                    <td className="ma-td ma-td-center">
                      {r.flagged && <span className="ma-flag-icon" title="Used minutes but not paying">🚨</span>}
                    </td>
                    <td className="ma-td ma-td-left">
                      {r.nameMismatch ? (
                        <div className="ma-client-mismatch" title={`Name match score: ${r.nameMatchScore}`}>
                          <div className="ma-cmp-csv"><b>CSV:</b> {r.client || '—'}</div>
                          <div className="ma-cmp-co"><b>CO:</b> {r.coCompany || '—'} ⚠</div>
                        </div>
                      ) : (
                        <div className="ma-client-name">{r.client || '—'}</div>
                      )}
                    </td>
                    <td className="ma-td ma-td-right">
                      {r.coUrl
                        ? <a href={r.coUrl} target="_blank" rel="noopener noreferrer" className="ma-link">{r.coCustomerId || '—'}</a>
                        : (r.coCustomerId || '—')}
                    </td>
                    <td className="ma-td ma-td-left">{r.resolvedTenant || r.clientType || '—'}</td>
                    <td className="ma-td ma-td-left">{r.billingCategory || '—'}</td>
                    <td className={`ma-td ma-td-right${r.planMismatch ? ' ma-td-mismatch' : ''}`}
                        title={r.planMismatch ? `CSV Allotted ${r.csvPlan} differs from CO plan ${r.coPlan}` : ''}>
                      {(() => {
                        const c = compareCell(r.csvPlan ?? parseInt(r.allotted || '', 10), r.coPlan, r.planMismatch);
                        return c.secondary
                          ? <><div className="ma-cmp-csv">CSV {c.primary}</div><div className="ma-cmp-co">CO {c.secondary}</div></>
                          : <span>{c.primary}</span>;
                      })()}
                    </td>
                    <td className={`ma-td ma-td-right${r.billDayMismatch ? ' ma-td-mismatch' : ''}`}
                        title={r.billDayMismatch ? `CSV cycle day ${r.csvBillDay} differs from CO next-invoice day ${r.coBillDay}` : ''}>
                      {(() => {
                        const c = compareCell(r.csvBillDay, r.coBillDay, r.billDayMismatch);
                        return c.secondary
                          ? <><div className="ma-cmp-csv">CSV {c.primary}</div><div className="ma-cmp-co">CO {c.secondary}</div></>
                          : <span>{c.primary}</span>;
                      })()}
                    </td>
                    <td className="ma-td ma-td-right">{fmtNum(r.used)}</td>
                    <td className="ma-td ma-td-right">{r.remaining || '—'}</td>
                    <td className="ma-td ma-td-right">{fmtNum(r.totalCalls)}</td>
                    <td className="ma-td ma-td-center">
                      {r.skipped
                        ? <span className="ma-badge ma-badge-gray" title="Excluded from audit by billing category">Skipped</span>
                        : r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId'
                          ? <span className="ma-badge ma-badge-amber" title={r.error === 'No COCustomerId' ? 'CSV row has no COCustomerId — auto no-match' : 'COCustomerId not found in AL or RS ChargeOver'}>No Match</span>
                          : r.active === true
                            ? <span className="ma-badge ma-badge-green">Active</span>
                            : r.active === false
                              ? <span className="ma-badge ma-badge-red" title={r.error || ''}>Inactive</span>
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
