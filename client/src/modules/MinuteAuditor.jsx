import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import { Button, Card, Input, Select, Badge, Tabs, EmptyState, DensitySwitch } from '../components/ui';
import './MinuteAuditor.css';

/* ─── helpers ─────────────────────────────────────────────────────── */

function fmtNum(v) {
  if (v === '' || v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v);
}

// Precedence: no-sub > plan > bill day > name. One categorical reason
// per flagged row for the "Reason" column and the reason-breakdown bar.
function computeReason(r) {
  if (r.skipped) return 'Skipped';
  if (!r.flagged) return 'Matched';
  const notInCO = r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId';
  if (notInCO || r.active !== true) return 'No subscription';
  if (r.planMismatch)    return 'Plan mismatch';
  if (r.billDayMismatch) return 'Bill day mismatch';
  if (r.nameMismatch)    return 'Name mismatch';
  return 'Flagged';
}

function describeReason(r) {
  if (r.reason === 'Matched')          return 'Usage recorded and ChargeOver has an active subscription. Nothing to do.';
  if (r.reason === 'No subscription')  return `Usage recorded in Answer but ChargeOver has no active subscription${r.chargeover?.subStatus ? ` (status: ${r.chargeover.subStatus})` : ''}.`;
  if (r.reason === 'Plan mismatch')    return `Answer allotted ${r.csvPlan ?? '?'} min; ChargeOver plan is ${r.coPlan ?? '?'} min.`;
  if (r.reason === 'Bill day mismatch')return `Answer bills on day ${r.csvBillDay ?? '?'}; ChargeOver next invoice is day ${r.coBillDay ?? '?'}.`;
  if (r.reason === 'Name mismatch')    return `Answer client "${r.client}" doesn't match ChargeOver company "${r.coCompany}".`;
  return r.error || '';
}

const REASON_TONE = {
  'Matched':           'ok',
  'No subscription':   'crit',
  'Plan mismatch':     'warn',
  'Bill day mismatch': 'warn',
  'Name mismatch':     'warn',
  'Skipped':           'neutral',
};

const REASON_OPTIONS = [
  { value: 'all',                 label: 'All reasons' },
  { value: 'No subscription',     label: 'No subscription' },
  { value: 'Plan mismatch',       label: 'Plan mismatch' },
  { value: 'Bill day mismatch',   label: 'Bill day mismatch' },
  { value: 'Name mismatch',       label: 'Name mismatch' },
];

/* ─── CSV export (preserved) ───────────────────────────────────────── */

function toCsv(rows) {
  const header = [
    'Flagged','Reason','Client (Answer)','Company (ChargeOver)','Name Match Score',
    'ChargeOver Customer ID','Tenant (Answer)','Tenant (ChargeOver)',
    'Billing Category (Answer)','Billing Cycle (Answer)',
    'Answer used','ChargeOver plan (allotted)','Gap (min)','Plan Mismatch',
    'Bill Day Answer','Bill Day ChargeOver','Bill Day Mismatch','ChargeOver Next Invoice',
    'Total Calls','Overage Rate Answer','Overage Rate ChargeOver',
    'ChargeOver Sub Status','Error','ChargeOver URL',
  ];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const yn = v => v === true ? 'Y' : v === false ? 'N' : '';
  const lines = [header.join(',')];
  for (const r of rows) {
    const co = r.chargeover || {};
    lines.push([
      r.flagged ? 'FLAGGED' : '', r.reason,
      r.client, co.company || '', r.nameMatchScore ?? '',
      r.coCustomerId, r.clientType, co.tenant || '',
      r.billingCategory, r.billingCycle,
      r.answer, r.billed ?? '', r.gap ?? '', yn(r.planMismatch),
      r.csvBillDay ?? '', r.coBillDay ?? '', yn(r.billDayMismatch), co.nextInvoiceDate || '',
      r.totalCalls, r.overageRate, co.overageRate ?? '',
      co.subStatus || '', r.error || '', co.url || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function MinuteAuditor() {
  const { toast } = useApp();
  const [view, setView] = useState('upload'); // upload | running | results
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: null, prefetch: null });
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('attention');
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('all');
  const [density, setDensity] = useState('compact');
  const [showAllCols, setShowAllCols] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [sort, setSort] = useState({ key: 'gap', dir: 'desc' });
  const readerRef = useRef(null);

  useEffect(() => () => { try { readerRef.current?.cancel(); } catch { /* ok */ } }, []);

  const onFile = (f) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setError('Please select a .csv file.'); return; }
    setError(''); setFile(f);
  };
  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
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
    setProgress({ done: 0, total: 0, phase: null, prefetch: null });
    setResults([]);
    setError('');
    setTab('attention');
    setSearch('');
    setReasonFilter('all');
    setExpandedId(null);
    setSort({ key: 'gap', dir: 'desc' });
  };

  /* Flatten job rows with computed reason + gap. */
  const flat = useMemo(() => results.map((r, i) => {
    const co = r.chargeover || {};
    const answer = parseInt(String(r.used || '').replace(/,/g, ''), 10) || parseInt(String(r.totalCalls || '').replace(/,/g, ''), 10) || 0;
    const billed = r.active === true ? (r.coPlan != null ? r.coPlan : null) : null;
    const gap = billed == null ? answer : answer - billed;
    return {
      ...r, id: i, answer, billed, gap,
      reason: computeReason(r),
      coCompany: co.company || '',
      coUrl: co.url || '',
      resolvedTenant: co.tenant || r.clientType || '',
    };
  }), [results]);

  const summary = useMemo(() => {
    const s = {
      total: flat.length, audited: 0, flagged: 0, matched: 0, skipped: 0,
      reasonNoSub: 0, reasonPlan: 0, reasonBillDay: 0, reasonName: 0,
    };
    for (const r of flat) {
      if (r.skipped) { s.skipped++; continue; }
      s.audited++;
      if (r.flagged) {
        s.flagged++;
        if      (r.reason === 'No subscription')   s.reasonNoSub++;
        else if (r.reason === 'Plan mismatch')     s.reasonPlan++;
        else if (r.reason === 'Bill day mismatch') s.reasonBillDay++;
        else if (r.reason === 'Name mismatch')     s.reasonName++;
      } else if (r.active === true) {
        s.matched++;
      }
    }
    s.reconciledPct = s.audited > 0 ? Math.round(100 * s.matched / s.audited) : 0;
    return s;
  }, [flat]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return flat.filter(r => {
      if (r.skipped) return false;
      if (tab === 'attention' && !r.flagged) return false;
      if (tab === 'matched'   && (r.flagged || r.active !== true)) return false;
      if (reasonFilter !== 'all' && r.reason !== reasonFilter) return false;
      if (q) {
        const hay = `${r.client || ''} ${r.coCustomerId || ''} ${r.coCompany || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, tab, reasonFilter, search]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av, bv;
      if (sort.key === 'gap')       { av = Math.abs(a.gap || 0);   bv = Math.abs(b.gap || 0);   return (av - bv) * dir; }
      if (sort.key === 'answer')    { av = a.answer || 0;          bv = b.answer || 0;          return (av - bv) * dir; }
      if (sort.key === 'billed')    { av = a.billed || 0;          bv = b.billed || 0;          return (av - bv) * dir; }
      av = (a.client || '').toLowerCase();
      bv = (b.client || '').toLowerCase();
      return av.localeCompare(bv) * dir;
    });
  }, [filtered, sort]);

  const clickSort = (key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  };

  const doExport = () => {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `minute-audit-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Exported CSV', 'success');
  };

  const clearFilters = () => { setSearch(''); setReasonFilter('all'); setTab('attention'); };
  const colCount = 6 + (showAllCols ? 3 : 0);

  /* ─── Render ─── */

  if (view === 'upload') {
    return (
      <div className="ma-root">
        <PageHead subtitle="Compare Answer minute-usage exports against ChargeOver subscriptions." />
        {error && <div className="ma-alert">{error}</div>}
        <Card pad>
          <div
            className={`ma-drop${dragOver ? ' ma-drop--active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="ma-drop-icon" aria-hidden="true">📄</div>
            <div className="ma-drop-title">{file ? file.name : 'Drop an Answer minute-usage CSV here'}</div>
            <div className="ma-drop-hint">…or click to browse. INTERNAL, TRIAL, and FREE customers are automatically excluded.</div>
            <input type="file" accept=".csv,text/csv" className="ma-drop-input"
              onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          <div className="ma-upload-actions">
            {file && <Button variant="ghost" onClick={() => setFile(null)}>Clear</Button>}
            <Button variant="primary" disabled={!file} onClick={handleRun}>Run audit</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (view === 'running') {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const isPrefetch = progress.phase === 'prefetching';
    return (
      <div className="ma-root">
        <PageHead subtitle="Comparing Answer usage against ChargeOver…" />
        <Card pad>
          <div className="ma-run-label">
            {isPrefetch
              ? 'Loading ChargeOver customer & subscription data…'
              : <>Matching Answer rows against ChargeOver… <b>{progress.done}</b> / {progress.total}</>
            }
          </div>
          <div className={`ma-progress${isPrefetch ? ' ma-progress--indeterminate' : ''}`}>
            <div className="ma-progress-fill" style={isPrefetch ? undefined : { width: `${pct}%` }} />
          </div>
          <div className="ma-run-hint">
            {isPrefetch && progress.prefetch && Object.keys(progress.prefetch).length > 0
              ? Object.entries(progress.prefetch).map(([k, v]) => `${k}: ${v}`).join(' · ')
              : 'Streaming results as each row is resolved.'}
          </div>
        </Card>
      </div>
    );
  }

  /* Results */
  return (
    <div className="ma-root">
      <header className="ma-page-head">
        <div className="ma-page-head-left">
          <img src="/dialedin-logo-dark.png" alt="" className="ma-brand-mark" />
          <div>
            <div className="ma-eyebrow">Billing · Minute usage auditor</div>
            <h1 className="ma-page-title">Minute usage audit</h1>
            <div className="ma-page-sub">
              {summary.audited} accounts audited{summary.skipped > 0 ? ` · ${summary.skipped} excluded (INTERNAL / TRIAL / FREE)` : ''}
            </div>
          </div>
        </div>
        <div className="ma-page-actions">
          <Button variant="secondary" onClick={doExport}>Export CSV</Button>
          <Button variant="primary" onClick={handleReset}>New upload</Button>
        </div>
      </header>

      {error && <div className="ma-alert">{error}</div>}

      <div className="ma-hero-grid">
        <section className="ma-attention" data-flagged={summary.flagged > 0 || undefined}>
          <div className="ma-attn-head">
            <div>
              <div className="ma-attn-eyebrow">Needs attention</div>
              <div className="ma-attn-count-line">
                <span className="ma-attn-count">{summary.flagged}</span>
                <span className="ma-attn-of">of {summary.audited} accounts</span>
              </div>
              <p className="ma-attn-desc">
                {summary.flagged > 0
                  ? 'Answer usage and ChargeOver disagree on these accounts. Unresolved rows roll into the next cycle at their current rate.'
                  : 'Every audited account matches ChargeOver. Nothing to reconcile.'}
              </p>
            </div>
          </div>
          {summary.flagged > 0 && (
            <div>
              <div className="ma-attn-eyebrow ma-attn-eyebrow--sub">Why they flagged</div>
              <div className="ma-reason-bar">
                {summary.reasonNoSub    > 0 && <div style={{ flex: summary.reasonNoSub,    background: 'var(--crit-600)' }} title={`No subscription (${summary.reasonNoSub})`} />}
                {summary.reasonPlan     > 0 && <div style={{ flex: summary.reasonPlan,     background: 'var(--warn-500)' }} title={`Plan mismatch (${summary.reasonPlan})`} />}
                {summary.reasonBillDay  > 0 && <div style={{ flex: summary.reasonBillDay,  background: 'var(--warn-600)' }} title={`Bill day mismatch (${summary.reasonBillDay})`} />}
                {summary.reasonName     > 0 && <div style={{ flex: summary.reasonName,     background: 'var(--ink-300)' }} title={`Name mismatch (${summary.reasonName})`} />}
              </div>
              <div className="ma-reason-legend">
                <LegendChip color="var(--crit-600)" label="No subscription"   n={summary.reasonNoSub} />
                <LegendChip color="var(--warn-500)" label="Plan mismatch"     n={summary.reasonPlan} />
                <LegendChip color="var(--warn-600)" label="Bill day mismatch" n={summary.reasonBillDay} />
                <LegendChip color="var(--ink-300)" label="Name mismatch"      n={summary.reasonName} />
              </div>
            </div>
          )}
        </section>

        <div className="ma-tiles">
          <Tile eyebrow="Reconciled" sub="matched to ChargeOver"
            value={`${summary.reconciledPct}%`} tone="ok" hint={String(summary.matched)} />
          <Tile eyebrow="Flagged" sub={summary.flagged > 0 ? 'need review' : 'nothing to review'}
            value={String(summary.flagged)} tone={summary.flagged > 0 ? 'crit' : undefined} />
          <Tile eyebrow="Skipped" sub="INTERNAL / TRIAL / FREE"
            value={String(summary.skipped)} />
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'attention', label: 'Needs attention', count: summary.flagged },
          { id: 'matched',   label: 'Matched',         count: summary.matched },
          { id: 'all',       label: 'All audited',     count: summary.audited },
        ]}
        value={tab}
        onChange={(id) => { setTab(id); setExpandedId(null); }}
      />

      <div className="ma-filters">
        <div className="ma-search">
          <Input placeholder="Search accounts or ChargeOver ID…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="ma-select">
          <Select value={reasonFilter} onChange={e => setReasonFilter(e.target.value)} options={REASON_OPTIONS} />
        </div>
        <div className="ma-filter-spacer" />
        <Button variant="secondary" size="sm" onClick={() => setShowAllCols(v => !v)}>
          {showAllCols ? 'Hide extra columns' : 'Show all columns'}
        </Button>
        <DensitySwitch value={density} onChange={setDensity} />
      </div>

      <div className="ui-table-wrap ma-table-wrap">
        <div className="ui-table-scroll">
          <table className={`ui-table${density === 'comfortable' ? ' ui-table--comfortable' : ''}`}>
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th onClick={() => clickSort('client')} data-sortable data-active={sort.key === 'client' || undefined}>
                  Account
                  {sort.key === 'client' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
                <th data-align="right" onClick={() => clickSort('answer')} data-sortable data-active={sort.key === 'answer' || undefined}>
                  Answer used
                  {sort.key === 'answer' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
                <th data-align="right" onClick={() => clickSort('billed')} data-sortable data-active={sort.key === 'billed' || undefined}>
                  ChargeOver plan
                  {sort.key === 'billed' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
                <th data-align="right" onClick={() => clickSort('gap')} data-sortable data-active={sort.key === 'gap' || undefined}>
                  Gap
                  {sort.key === 'gap' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
                <th>Reason</th>
                {showAllCols && <th>Category</th>}
                {showAllCols && <th>Cycle</th>}
                {showAllCols && <th>Calls</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={colCount} className="ma-empty-cell">
                  <EmptyState
                    glyph="✓"
                    title={tab === 'attention' && summary.flagged === 0 ? 'Nothing to reconcile' : 'Nothing to reconcile here'}
                    description={search
                      ? `No account matches "${search}" in this view.`
                      : tab === 'attention' && summary.flagged === 0
                        ? 'Every audited account agrees with ChargeOver.'
                        : 'Try a different tab, or clear filters to widen the view.'}
                    actions={search || reasonFilter !== 'all' || tab !== 'attention'
                      ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
                      : null}
                  />
                </td></tr>
              ) : sorted.map(r => (
                <TableRow key={r.id} r={r} expanded={expandedId === r.id}
                  onToggle={() => setExpandedId(id => id === r.id ? null : r.id)}
                  colCount={colCount} showAllCols={showAllCols} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="ui-table__foot">
          <span>Showing {sorted.length} of {summary.audited} audited</span>
          <span className="ma-foot-hint">Click a row to see the full comparison</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Subcomponents ────────────────────────────────────────────────── */

function PageHead({ subtitle }) {
  return (
    <header className="ma-page-head">
      <div className="ma-page-head-left">
        <img src="/dialedin-logo-dark.png" alt="" className="ma-brand-mark" />
        <div>
          <div className="ma-eyebrow">Billing · Minute usage auditor</div>
          <h1 className="ma-page-title">Minute usage audit</h1>
          <div className="ma-page-sub">{subtitle}</div>
        </div>
      </div>
    </header>
  );
}

function Tile({ eyebrow, sub, value, tone, hint }) {
  return (
    <div className="ma-tile">
      <div className="ma-tile-txt">
        <div className="ma-tile-eyebrow">{eyebrow}</div>
        <div className="ma-tile-sub">{sub}</div>
      </div>
      <div className="ma-tile-values">
        <span className={`ma-tile-value${tone ? ' ma-tile-value--' + tone : ''}`}>{value}</span>
        {hint && <span className="ma-tile-hint">{hint}</span>}
      </div>
    </div>
  );
}

function LegendChip({ color, label, n }) {
  return (
    <div className="ma-legend-chip">
      <span className="ma-legend-swatch" style={{ background: color }} />
      <span className="ma-legend-label">{label}</span>
      <span className="ma-legend-num">{n}</span>
    </div>
  );
}

function ReasonPill({ reason }) {
  const tone = REASON_TONE[reason] || 'neutral';
  return <Badge tone={tone} dot={tone !== 'neutral'}>{reason}</Badge>;
}

function GapCell({ gap, reason }) {
  const abs = Math.abs(gap || 0);
  const pct = Math.min(100, Math.round(abs / 1500 * 100));
  const color = reason === 'No subscription' ? 'var(--crit-600)'
              : reason === 'Matched'         ? 'var(--text-subtle)'
                                             : 'var(--warn-600)';
  return (
    <div className="ma-gap">
      <div className="ma-gap-track"><div className="ma-gap-fill" style={{ width: `${Math.max(pct, 4)}%`, background: color }} /></div>
      <span className="ma-gap-val" style={{ color }}>{gap === 0 ? '±0' : (gap > 0 ? '+' : '') + fmtNum(gap)}</span>
    </div>
  );
}

function TableRow({ r, expanded, onToggle, colCount, showAllCols }) {
  const rowState = r.reason === 'No subscription' ? 'crit'
                 : r.flagged                      ? 'warn'
                                                  : undefined;
  return (
    <>
      <tr onClick={onToggle} className="ma-row" data-state={rowState}>
        <td className="ma-caret">{expanded ? '▼' : '▶'}</td>
        <td>
          <div className="ma-cell-name">{r.client || '—'}</div>
          <div className="ma-cell-meta">
            CO {r.coCustomerId || '—'} · {r.resolvedTenant || '—'}
            {r.coCompany && r.coCompany.toLowerCase() !== (r.client || '').toLowerCase() &&
              <> · in CO as <span className={r.nameMismatch ? 'ma-alias-mismatch' : ''}>{r.coCompany}</span></>
            }
          </div>
        </td>
        <td data-align="right" data-num>{fmtNum(r.answer)}</td>
        <td data-align="right" data-num style={r.billed == null ? { color: 'var(--crit-700)' } : undefined}>
          {r.billed == null ? 'no active sub' : fmtNum(r.billed)}
        </td>
        <td data-align="right"><GapCell gap={r.gap} reason={r.reason} /></td>
        <td><ReasonPill reason={r.reason} /></td>
        {showAllCols && <td>{r.billingCategory || '—'}</td>}
        {showAllCols && <td>{r.billingCycle || '—'}</td>}
        {showAllCols && <td data-align="right" data-num>{fmtNum(r.totalCalls)}</td>}
      </tr>
      {expanded && (
        <tr className="ma-detail">
          <td colSpan={colCount}>
            <div className="ma-detail-grid">
              <DetailField label="ChargeOver plan"
                value={r.coPlan != null ? `${r.coPlan} min` : '—'}
                sub={r.csvPlan != null && r.csvPlan !== r.coPlan ? `Answer allotted ${r.csvPlan} min` : null} />
              <DetailField label="Subscription"
                value={r.coCustomerId || '—'} mono
                sub={r.chargeover?.subStatus || '—'} />
              <DetailField label="Overage rate"
                value={r.chargeover?.overageRate != null ? `$${r.chargeover.overageRate}` : '—'}
                sub="per minute over plan" mono />
              <DetailField label="Bill day (Answer / CO)"
                value={`${r.csvBillDay ?? '—'} / ${r.coBillDay ?? '—'}`}
                sub={r.billDayMismatch ? 'Cycle day disagrees' : null} />
              <DetailField label="What happened" value={describeReason(r)} full />
              <div className="ma-detail-actions">
                {r.coUrl && (
                  <Button variant="secondary" onClick={(e) => { e.stopPropagation(); window.open(r.coUrl, '_blank', 'noopener,noreferrer'); }}>
                    Open in ChargeOver ↗
                  </Button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DetailField({ label, value, sub, mono, full }) {
  return (
    <div className={`ma-detail-field${full ? ' ma-detail-field--full' : ''}`}>
      <div className="ma-detail-label">{label}</div>
      <div className={`ma-detail-value${mono ? ' ma-detail-value--mono' : ''}`}>{value}</div>
      {sub && <div className="ma-detail-sub">{sub}</div>}
    </div>
  );
}
