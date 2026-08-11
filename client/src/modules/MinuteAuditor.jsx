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

// The two mismatches this audit actually cares about — plan and bill day.
// Everything else is secondary. Legacy grandfathering demotes name mismatches
// to informational for customers created before the cutoff.
//
// HubSpot is deliberately absent here. It never contributes a reason and never
// flags a row; it lives entirely in its own tab. The core audit is
// Answer ↔ ChargeOver only.
function computeReason(r) {
  if (r.skipped) return 'Skipped';
  const cat = String(r.billingCategory || '').toUpperCase();
  // TRIAL is audited inversely: no active sub is expected. Having one is
  // the only thing that flags a trial.
  if (cat === 'TRIAL') return r.active === true ? 'Trial with active sub' : 'Matched';
  // MANUAL customers are billed manually — no subscription is expected,
  // no plan / bill-day check applies.
  if (cat === 'MANUAL') return 'Matched';
  // MULTIPLE customers legitimately span different plans across their
  // parent + child accounts, so plan mismatch alone isn't a real issue.
  if (r.planMismatch && cat !== 'MULTIPLE') return 'Plan mismatch';
  if (r.billDayMismatch) return 'Bill day mismatch';
  if (r.zeroUsageActiveSub) return 'Zero usage';
  const notInCO = r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId';
  if (notInCO || r.active !== true) return 'No subscription';
  if (r.isLegacy && r.nameMismatch) return 'Legacy';
  if (r.nameMismatch)     return 'Name mismatch';
  if (r.isLegacy)         return 'Legacy';
  return 'Matched';
}

function describeReason(r) {
  if (r.reason === 'Matched')            return 'Answer and ChargeOver agree on plan and bill day.';
  if (r.reason === 'Plan mismatch')      return `Answer allotted ${r.csvPlan ?? '?'} min; ChargeOver plan is ${r.coPlan ?? '?'} min.`;
  if (r.reason === 'Bill day mismatch')  return `Answer bills on day ${r.csvBillDay ?? '?'}; ChargeOver next invoice is day ${r.coBillDay ?? '?'}.`;
  if (r.reason === 'No subscription')    return `Answer shows this account but ChargeOver has no active subscription${r.chargeover?.subStatus ? ` (status: ${r.chargeover.subStatus})` : ''}.`;
  if (r.reason === 'Zero usage')         return `Zero minutes and zero calls this cycle in Answer, but the ChargeOver subscription is still active — the customer likely deactivated in Answer or never went live, and CO wasn't caught up.`;
  if (r.reason === 'Trial with active sub') return `Answer marks this account as TRIAL, but ChargeOver has an active subscription. Trials shouldn't be paying — either Answer needs to update to STANDARD or ChargeOver needs to end the trial.`;
  if (r.reason === 'Name mismatch')      return `Answer client "${r.client}" doesn't match ChargeOver company "${r.coCompany}".`;
  if (r.reason === 'Legacy')             return `Grandfathered — ${r.legacyReason || 'created before the cutoff'}. Name-drift flags suppressed; billing flags stay live.`;
  return r.error || '';
}

const REASON_TONE = {
  'Matched':                'ok',
  'Trial with active sub':  'crit',
  'Plan mismatch':          'crit',
  'Bill day mismatch':      'crit',
  'Zero usage':             'crit',
  'No subscription':        'warn',
  'Name mismatch':          'neutral',
  'Legacy':                 'neutral',
  'Skipped':                'neutral',
};

const REASON_OPTIONS = [
  { value: 'all',                     label: 'All reasons' },
  { value: 'Trial with active sub',   label: 'Trial with active sub' },
  { value: 'Plan mismatch',           label: 'Plan mismatch' },
  { value: 'Bill day mismatch',       label: 'Bill day mismatch' },
  { value: 'Zero usage',              label: 'Zero usage, active sub' },
  { value: 'No subscription',         label: 'No subscription' },
  { value: 'Name mismatch',           label: 'Name mismatch' },
  { value: 'Legacy',                  label: 'Legacy (grandfathered)' },
];

/* ─── CSV export (preserved) ───────────────────────────────────────── */

function toCsv(rows) {
  const header = [
    'Flagged','Reason','Legacy',
    'Client (Answer)','Company (ChargeOver)','Account (HubSpot)','Name Match Score',
    'Name Score Answer-CO','Name Score CO-HubSpot','Name Score Answer-HubSpot','All 3 Names Match',
    'Plan Answer (Allotted)','Plan ChargeOver','Plan Mismatch',
    'Bill Day Answer','Bill Day ChargeOver','Bill Day Mismatch','ChargeOver Next Invoice',
    'ChargeOver Customer ID','Tenant (Answer)','Tenant (ChargeOver)',
    'Sales Rep — HubSpot (source of truth)','Sales Rep — ChargeOver (to update on mismatch)','Sales Rep Mismatch',
    'HubSpot Deal ID','HubSpot Deal Name','HubSpot Deal Found',
    'CO Created At',
    'Billing Category (Answer)','Billing Cycle (Answer)',
    'Used (Answer)','Total Calls (Answer)',
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
      r.flagged ? 'FLAGGED' : '', r.reason, yn(r.isLegacy),
      r.client, co.company || '', r.hubspotName || '', r.nameMatchScore ?? '',
      r.nameScoreAnswerCo ?? '', r.nameScoreCoHs ?? '', r.nameScoreAnswerHs ?? '', yn(r.nameAllThreeMatch),
      r.csvPlan ?? r.allotted, r.coPlan ?? '', yn(r.planMismatch),
      r.csvBillDay ?? '', r.coBillDay ?? '', yn(r.billDayMismatch), co.nextInvoiceDate || '',
      r.coCustomerId, r.clientType, co.tenant || '',
      r.hubspotSalesRep || '', r.coAdminName || '', yn(r.salesRepMismatch),
      r.hubspotDealId || '', r.hubspotDealName || '', yn(r.hubspotDealFound),
      r.coCreatedAt || '',
      r.billingCategory, r.billingCycle,
      r.used, r.totalCalls,
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
  const [sort, setSort] = useState({ key: 'client', dir: 'asc' });
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

  // Fetch the authoritative results snapshot after the stream ends. The
  // SSE stream can be cut short by proxies (Cloudflare kills long-running
  // streams around the 100s mark) — since skipped rows and other late
  // rows land near the end of the stream, we always reconcile from the
  // /results endpoint before flipping to the results view.
  const reconcileResults = useCallback(async (jId) => {
    try {
      const resp = await api.get(`/api/minute-auditor/results/${jId}`);
      const full = resp.data?.results;
      if (Array.isArray(full) && full.length > 0) {
        setResults(full);
        setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total }));
      }
    } catch (e) {
      // Non-fatal — we still have whatever the stream gave us.
      console.warn('[minute-auditor] reconcile failed:', e.message);
    }
  }, []);

  const startStream = useCallback(async (jId, total) => {
    setProgress({ done: 0, total, phase: 'prefetching', prefetch: null });
    setResults([]);
    let doneReceived = false;
    try {
      const resp = await fetch(`/api/minute-auditor/stream/${jId}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok) { setError(`Stream error: ${resp.status}`); await reconcileResults(jId); setView('results'); return; }
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
              doneReceived = true;
              await reconcileResults(jId);
              setView('results');
              return;
            }
          } catch { /* skip malformed event */ }
        }
      }
      // Stream ended without a 'done' message → likely a proxy timeout.
      // Poll the job until it completes, then reconcile.
      if (!doneReceived) await pollUntilComplete(jId);
      await reconcileResults(jId);
      setView('results');
    } catch (e) {
      setError('Stream disconnected — pulling final results…');
      if (!doneReceived) await pollUntilComplete(jId);
      await reconcileResults(jId);
      setError('');
      setView('results');
    }
  }, [reconcileResults]);

  // When the stream is severed early, poll the job status endpoint until
  // the server marks it done. Bounded at 5 minutes to avoid indefinite waits.
  const pollUntilComplete = useCallback(async (jId) => {
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      try {
        const resp = await api.get(`/api/minute-auditor/results/${jId}`);
        const status = resp.data?.status;
        if (status === 'done' || status === 'error') {
          setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total }));
          return;
        }
        // Show live progress from the polled snapshot
        setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total, phase: resp.data.phase || p.phase }));
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 2000));
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
    setSort({ key: 'client', dir: 'asc' });
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
      total: flat.length, audited: 0, flagged: 0, matched: 0, skipped: 0, legacy: 0,
      hubspotMatched: 0,
      reasonTrial: 0, reasonPlan: 0, reasonBillDay: 0, reasonZeroUsage: 0, reasonNoSub: 0, reasonName: 0,
      hubspotNameAgree: 0, hubspotNameDisagree: 0,
    };
    for (const r of flat) {
      if (r.skipped) { s.skipped++; continue; }
      s.audited++;
      if (r.isLegacy) s.legacy++;
      if (r.hubspotDealFound) {
        s.hubspotMatched++;
        if      (r.nameAllThreeMatch === true)  s.hubspotNameAgree++;
        else if (r.nameAllThreeMatch === false) s.hubspotNameDisagree++;
      }
      if (r.flagged) {
        s.flagged++;
        if      (r.reason === 'Trial with active sub') s.reasonTrial++;
        else if (r.reason === 'Plan mismatch')         s.reasonPlan++;
        else if (r.reason === 'Bill day mismatch')     s.reasonBillDay++;
        else if (r.reason === 'Zero usage')            s.reasonZeroUsage++;
        else if (r.reason === 'No subscription')       s.reasonNoSub++;
        else if (r.reason === 'Name mismatch')         s.reasonName++;
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
      if (tab === 'hubspot'   && !r.hubspotDealFound) return false;
      if (reasonFilter !== 'all' && r.reason !== reasonFilter) return false;
      if (q) {
        const hay = `${r.client || ''} ${r.coCustomerId || ''} ${r.coCompany || ''} ${r.hubspotDealName || ''} ${r.hubspotDealCompany || ''} ${r.hubspotSalesRep || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, tab, reasonFilter, search]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'answer') { return ((a.answer || 0) - (b.answer || 0)) * dir; }
      const av = (a.client || '').toLowerCase();
      const bv = (b.client || '').toLowerCase();
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
  const colCount = 7 + (showAllCols ? 2 : 0);

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
            <div className="ma-drop-hint">…or click to browse. INTERNAL and FREE customers are automatically excluded.</div>
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
              {summary.audited} accounts audited{summary.skipped > 0 ? ` · ${summary.skipped} excluded (INTERNAL / FREE)` : ''}
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
                {summary.reasonTrial      > 0 && <div style={{ flex: summary.reasonTrial,      background: 'var(--warn-600)' }} title={`Trial with active sub (${summary.reasonTrial})`} />}
                {summary.reasonPlan       > 0 && <div style={{ flex: summary.reasonPlan,       background: 'var(--crit-600)' }} title={`Plan mismatch (${summary.reasonPlan})`} />}
                {summary.reasonBillDay    > 0 && <div style={{ flex: summary.reasonBillDay,    background: 'var(--crit-500)' }} title={`Bill day mismatch (${summary.reasonBillDay})`} />}
                {summary.reasonZeroUsage  > 0 && <div style={{ flex: summary.reasonZeroUsage,  background: 'var(--crit-700)' }} title={`Zero usage, active sub (${summary.reasonZeroUsage})`} />}
                {summary.reasonNoSub      > 0 && <div style={{ flex: summary.reasonNoSub,      background: 'var(--warn-500)' }} title={`No subscription (${summary.reasonNoSub})`} />}
                {summary.reasonName       > 0 && <div style={{ flex: summary.reasonName,       background: 'var(--ink-300)' }} title={`Name mismatch (${summary.reasonName})`} />}
              </div>
              <div className="ma-reason-legend">
                <LegendChip color="var(--warn-600)" label="Trial with active sub"  n={summary.reasonTrial} />
                <LegendChip color="var(--crit-600)" label="Plan mismatch"          n={summary.reasonPlan} />
                <LegendChip color="var(--crit-500)" label="Bill day mismatch"      n={summary.reasonBillDay} />
                <LegendChip color="var(--crit-700)" label="Zero usage, active sub" n={summary.reasonZeroUsage} />
                <LegendChip color="var(--warn-500)" label="No subscription"        n={summary.reasonNoSub} />
                <LegendChip color="var(--ink-300)" label="Name mismatch"           n={summary.reasonName} />
              </div>
            </div>
          )}
        </section>

        <div className="ma-tiles">
          <Tile eyebrow="Reconciled" sub="matched to ChargeOver"
            value={`${summary.reconciledPct}%`} tone="ok" hint={String(summary.matched)} />
          <Tile eyebrow="Flagged" sub={summary.flagged > 0 ? 'need review' : 'nothing to review'}
            value={String(summary.flagged)} tone={summary.flagged > 0 ? 'crit' : undefined} />
          {summary.legacy > 0 && (
            <Tile eyebrow="Legacy" sub="created before 2020"
              value={String(summary.legacy)} hint={summary.hubspotMatched > 0 ? `${summary.hubspotMatched} matched` : undefined} />
          )}
          <Tile eyebrow="Skipped" sub="INTERNAL / FREE"
            value={String(summary.skipped)} />
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'attention', label: 'Needs attention', count: summary.flagged },
          { id: 'matched',   label: 'Matched',         count: summary.matched },
          { id: 'hubspot',   label: 'HubSpot',         count: summary.hubspotMatched },
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
                {tab === 'hubspot' ? (
                  <>
                    <th>Account name (HubSpot)</th>
                    <th data-align="center">Name agreement</th>
                    <th data-align="right" onClick={() => clickSort('answer')} data-sortable data-active={sort.key === 'answer' || undefined}>
                      Used
                      {sort.key === 'answer' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                    {showAllCols && <th>Matched by</th>}
                    {showAllCols && <th data-align="center">Sales rep (HS / CO)</th>}
                    {showAllCols && <th>Deal</th>}
                  </>
                ) : (
                  <>
                    <th>Category</th>
                    <th data-align="center">Plan (Answer / CO)</th>
                    <th data-align="center">Bill day (Answer / CO)</th>
                    <th>Reason</th>
                    <th data-align="right" onClick={() => clickSort('answer')} data-sortable data-active={sort.key === 'answer' || undefined}>
                      Used
                      {sort.key === 'answer' && <span className="ui-table__arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                    {showAllCols && <th>Cycle</th>}
                    {showAllCols && <th data-align="right">Calls</th>}
                  </>
                )}
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
                        : tab === 'hubspot' && summary.hubspotMatched === 0
                          ? 'No CSV rows resolved to a HubSpot account in Onboarding 2 / PAID this run.'
                          : 'Try a different tab, or clear filters to widen the view.'}
                    actions={search || reasonFilter !== 'all' || tab !== 'attention'
                      ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
                      : null}
                  />
                </td></tr>
              ) : sorted.map(r => (
                <TableRow key={r.id} r={r} expanded={expandedId === r.id}
                  onToggle={() => setExpandedId(id => id === r.id ? null : r.id)}
                  colCount={colCount} showAllCols={showAllCols} tab={tab} />
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


function TableRow({ r, expanded, onToggle, colCount, showAllCols, tab }) {
  const rowState = (r.planMismatch || r.billDayMismatch) ? 'crit'
                 : r.flagged                             ? 'warn'
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
        {tab === 'hubspot' ? (
          <>
            <td>
              <div className="ma-cell-name">{r.hubspotName || '—'}</div>
              {r.hubspotDealName && r.hubspotDealName !== r.hubspotName && (
                <div className="ma-cell-meta">deal: {r.hubspotDealName}</div>
              )}
            </td>
            <td data-align="center"><NameAgreement r={r} /></td>
            <td data-align="right" data-num>{fmtNum(r.answer)}</td>
            {showAllCols && <td className="ma-cell-meta">{r.hubspotMatchedBy || '—'}</td>}
            {showAllCols && <td data-align="center"><CompareCell csv={r.hubspotSalesRep} co={r.coAdminName} unit="" mismatch={r.salesRepMismatch} labels={{ csv: 'HS', co: 'CO' }} /></td>}
            {showAllCols && <td className="ma-cell-meta">{r.hubspotDealId || '—'}</td>}
          </>
        ) : (
          <>
            <td>{r.billingCategory || '—'}</td>
            <td data-align="center"><CompareCell csv={r.csvPlan} co={r.coPlan} unit=" min" mismatch={r.planMismatch} /></td>
            <td data-align="center"><CompareCell csv={r.csvBillDay} co={r.coBillDay} unit="" ordinal mismatch={r.billDayMismatch} /></td>
            <td><ReasonPill reason={r.reason} /></td>
            <td data-align="right" data-num>{fmtNum(r.answer)}</td>
            {showAllCols && <td>{r.billingCycle || '—'}</td>}
            {showAllCols && <td data-align="right" data-num>{fmtNum(r.totalCalls)}</td>}
          </>
        )}
      </tr>
      {expanded && (
        <tr className="ma-detail">
          <td colSpan={colCount}>
            <div className="ma-detail-grid">
              <DetailField label="Plan (Answer)"
                value={r.csvPlan != null ? `${r.csvPlan} min` : '—'}
                sub={r.planMismatch ? 'differs from CO' : null} />
              <DetailField label="Plan (ChargeOver)"
                value={r.coPlan != null ? `${r.coPlan} min` : '—'}
                sub={r.chargeover?.subStatus || 'no active subscription'} />
              <DetailField label="Bill day (Answer)"
                value={r.csvBillDay != null ? ordinal(r.csvBillDay) : '—'}
                sub={r.billingCycle || null} />
              <DetailField label="Bill day (ChargeOver)"
                value={r.coBillDay != null ? ordinal(r.coBillDay) : '—'}
                sub={r.chargeover?.nextInvoiceDate ? `next invoice ${r.chargeover.nextInvoiceDate}` : null} />
              {r.hubspotDealFound ? (
                <DetailField label="Sales rep (HubSpot) — source of truth"
                  value={r.hubspotSalesRep || '—'}
                  sub={[
                    r.hubspotRepSource ? `from ${r.hubspotRepSource}` : null,
                    r.hubspotOwnerActive === false ? 'owner deactivated' : null,
                    `deal: ${r.hubspotDealName}`,
                  ].filter(Boolean).join(' · ')} />
              ) : (
                <DetailField label="HubSpot deal"
                  value={r.isLegacy ? 'none (legacy)' : 'no matching deal'}
                  sub={r.coCreatedAt ? `CO customer since ${r.coCreatedAt}` : null} />
              )}
              <DetailField label={r.salesRepMismatch ? 'Sales rep (ChargeOver) — update to match' : 'Sales rep (ChargeOver)'}
                value={r.coAdminName || '—'}
                sub={r.coAdminEmail || null} />

              <DetailField label="ChargeOver customer"
                value={r.coCustomerId || '—'} mono
                sub={r.resolvedTenant || null} />
              <DetailField label="What happened" value={describeReason(r)} full />
              <div className="ma-detail-actions">
                {r.coUrl && (
                  <Button variant="secondary" onClick={(e) => { e.stopPropagation(); window.open(r.coUrl, '_blank', 'noopener,noreferrer'); }}>
                    Open in ChargeOver ↗
                  </Button>
                )}
                {r.hubspotDealId && (
                  <Button variant="secondary" onClick={(e) => { e.stopPropagation(); window.open(`https://app.hubspot.com/contacts/*/deal/${r.hubspotDealId}`, '_blank', 'noopener,noreferrer'); }}>
                    Open deal in HubSpot ↗
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

// Side-by-side comparison cell. Matched = single value.
// Mismatched = two lines, both bold, second side in critical red.
// Default labels are ANSWER / CO; override via `labels` for other pairs
// (e.g. HubSpot rep vs CO admin uses HS / CO).
/* Three-way account-name agreement: Answer (CSV) / ChargeOver / HubSpot.
   This is the whole point of the HubSpot tab — it reports agreement and
   never flags a row. Legacy rows are labelled so grandfathering stays
   visible here even though nothing is suppressed. */
function NameAgreement({ r }) {
  const pairs = [
    ['A↔CO', r.nameScoreAnswerCo],
    ['CO↔HS', r.nameScoreCoHs],
    ['A↔HS', r.nameScoreAnswerHs],
  ];
  const scores = (
    <div className="ma-cell-meta">
      {pairs.map(([l, v]) => `${l} ${v == null ? '—' : v.toFixed(2)}`).join('   ')}
    </div>
  );
  if (r.nameAllThreeMatch == null) {
    return (
      <div className="ma-name3">
        <Badge tone="neutral" size="sm">Not enough names</Badge>
        {scores}
      </div>
    );
  }
  return (
    <div className="ma-name3">
      <Badge tone={r.nameAllThreeMatch ? 'ok' : 'crit'} size="sm">
        {r.nameAllThreeMatch ? 'All 3 match' : 'Names differ'}
      </Badge>
      {r.isLegacy && <Badge tone="neutral" size="sm">Legacy</Badge>}
      {scores}
    </div>
  );
}

function CompareCell({ csv, co, unit = '', ordinal: asOrd = false, mismatch, labels }) {
  const fmt = v => v == null || v === '' ? '—' : (asOrd ? ordinal(v) : v + unit);
  const csvS = fmt(csv);
  const coS  = fmt(co);
  if (csvS === '—' && coS === '—') return <span className="ma-cmp-none">—</span>;
  if (!mismatch) return <span className="ma-cmp-match">{csvS === '—' ? coS : csvS}</span>;
  const csvLabel = labels?.csv || 'Answer';
  const coLabel  = labels?.co  || 'CO';
  return (
    <div className="ma-cmp">
      <div className="ma-cmp-answer"><b>{csvLabel}</b> {csvS}</div>
      <div className="ma-cmp-co"><b>{coLabel}</b> {coS}</div>
    </div>
  );
}

function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const j = num % 10, k = num % 100;
  if (j === 1 && k !== 11) return num + 'st';
  if (j === 2 && k !== 12) return num + 'nd';
  if (j === 3 && k !== 13) return num + 'rd';
  return num + 'th';
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
