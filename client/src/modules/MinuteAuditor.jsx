import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
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
  // Zero-usage-on-active-sub ranks ABOVE plan / bill-day drift: if the
  // customer isn't using the service at all, any plan or bill-day mismatch
  // is downstream noise — ops needs to reach out or cancel, not tune the
  // sub. Previously this was ranked below Plan/Bill day, which masked the
  // count entirely.
  if (r.zeroUsageActiveSub) return 'Zero usage';
  // MULTIPLE customers legitimately span different plans across their
  // parent + child accounts, so plan mismatch alone isn't a real issue.
  if (r.planMismatch && cat !== 'MULTIPLE') return 'Plan mismatch';
  if (r.billDayMismatch) return 'Bill day mismatch';
  if (r.rateMismatch)    return 'Rate mismatch';
  const notInCO = r.error === 'Not found in ChargeOver' || r.error === 'No COCustomerId';
  if (notInCO || r.active !== true) return 'No subscription';
  // CSV(Answer)↔CO name divergence is informational only — the required
  // name check is CO↔HubSpot, evaluated below. The alias display in the
  // row cell still calls out the divergence for context.
  // HubSpot cross-check flags. These only fire when a HubSpot deal was
  // matched — no false negatives from missing HubSpot coverage.
  if (r.previouslyPayingMissing)            return 'Previously paying unchecked';
  if (r.hsVsCoMismatch && !r.isLegacy)      return 'HubSpot name mismatch';
  if (r.salesRepMismatch && !r.isLegacy)    return 'Sales rep mismatch';
  if (r.isLegacy)         return 'Legacy';
  return 'Matched';
}

function describeReason(r) {
  if (r.reason === 'Matched')            return 'Answer and ChargeOver agree on plan and bill day.';
  if (r.reason === 'Plan mismatch')      return `Answer allotted ${r.csvPlan ?? '?'} min; ChargeOver plan is ${r.coPlan ?? '?'} min.`;
  if (r.reason === 'Bill day mismatch')  return `Answer bills on day ${r.csvBillDay ?? '?'}; ChargeOver next invoice is day ${r.coBillDay ?? '?'}.`;
  if (r.reason === 'Rate mismatch')      return `Answer has $${(r.csvOverageRate ?? '?')}/min but the ${r.chargeover?.tenant || r.clientType || '?'} ${r.csvPlan ?? '?'}-min tier on the pricing sheet is $${(r.pricingSheetOverageRate ?? '?')}/min.`;
  if (r.reason === 'No subscription')    return `Answer shows this account but ChargeOver has no active subscription${r.chargeover?.subStatus ? ` (status: ${r.chargeover.subStatus})` : ''}.`;
  if (r.reason === 'Zero usage')         return `Zero minutes and zero calls this cycle in Answer, but the ChargeOver subscription is still active — the customer likely deactivated in Answer or never went live, and CO wasn't caught up.`;
  if (r.reason === 'Trial with active sub') return `Answer marks this account as TRIAL, but ChargeOver has an active subscription. Trials shouldn't be paying — either Answer needs to update to STANDARD or ChargeOver needs to end the trial.`;
  if (r.reason === 'HubSpot name mismatch') return `ChargeOver company "${r.chargeover?.company || ''}" doesn't match the HubSpot deal "${r.hubspotName || ''}". HubSpot is source of truth — update ChargeOver to match.`;
  if (r.reason === 'Sales rep mismatch') return `HubSpot Deal Owner is "${r.hubspotSalesRepEmail || r.hubspotSalesRep || '?'}" but the ChargeOver salesperson field is "${r.coSalesperson || '?'}". HubSpot is source of truth — update ChargeOver.`;
  if (r.reason === 'Previously paying unchecked') return `Customer has a canceled subscription AND an active one in ChargeOver (returning customer), but "Previously Paying Customer" isn't checked on the HubSpot deal.`;
  if (r.reason === 'Legacy')             return `Grandfathered — ${r.legacyReason || 'created before the cutoff'}. Name-drift flags suppressed; billing flags stay live.`;
  return r.error || '';
}

const REASON_TONE = {
  'Matched':                       'ok',
  'Trial with active sub':         'crit',
  'Plan mismatch':                 'crit',
  'Bill day mismatch':             'crit',
  'Rate mismatch':                 'crit',
  'Zero usage':                    'crit',
  'No subscription':               'warn',
  'HubSpot name mismatch':         'warn',
  'Sales rep mismatch':            'warn',
  'Previously paying unchecked':   'warn',
  'Legacy':                        'neutral',
  'Skipped':                       'neutral',
};

const REASON_OPTIONS = [
  { value: 'all',                          label: 'All reasons' },
  { value: 'Trial with active sub',        label: 'Trial with active sub' },
  { value: 'Plan mismatch',                label: 'Plan mismatch' },
  { value: 'Bill day mismatch',            label: 'Bill day mismatch' },
  { value: 'Rate mismatch',                label: 'Rate mismatch (Answer↔pricing)' },
  { value: 'Zero usage',                   label: 'Zero usage, active sub' },
  { value: 'No subscription',              label: 'No subscription' },
  { value: 'HubSpot name mismatch',        label: 'HubSpot name mismatch (CO↔HS)' },
  { value: 'Sales rep mismatch',           label: 'Sales rep mismatch (HubSpot↔CO)' },
  { value: 'Previously paying unchecked',  label: 'Previously paying unchecked (HS)' },
  { value: 'Legacy',                       label: 'Legacy (grandfathered)' },
];

/* ─── CSV export (preserved) ───────────────────────────────────────── */

function toCsv(rows) {
  const header = [
    'Flagged','Reason','Legacy',
    'Client (Answer)','Company (ChargeOver)','Account (HubSpot)','Name Match Score',
    'Name Score Answer-CO','Name Score CO-HubSpot','Name Score Answer-HubSpot','All 3 Names Match',
    'Plan Answer (Allotted)','Plan ChargeOver','Plan Mismatch',
    'Bill Day Answer','Bill Day ChargeOver','Bill Day Mismatch','ChargeOver Next Invoice',
    'Overage Rate Answer','Overage Rate Pricing Sheet','Rate Mismatch',
    'ChargeOver Customer ID','Tenant (Answer)','Tenant (ChargeOver)',
    'Sales Rep — HubSpot (source of truth)','Sales Rep — ChargeOver (to update on mismatch)','Sales Rep Mismatch',
    'HubSpot Name Mismatch (CO↔HS)','Return Customer (CO)','Previously Paying Checked (HS)','Previously Paying Unchecked',
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
      r.csvOverageRate ?? '', r.pricingSheetOverageRate ?? '', yn(r.rateMismatch),
      r.coCustomerId, r.clientType, co.tenant || '',
      r.hubspotSalesRepEmail || r.hubspotSalesRep || '', r.coSalesperson || '', yn(r.salesRepMismatch),
      yn(r.hsVsCoMismatch), yn(r.previouslyPayingRequired), yn(r.previouslyPayingChecked), yn(r.previouslyPayingMissing),
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
  const [collapsedCategories, setCollapsedCategories] = useState(() => new Set());

  const toggleCategory = useCallback((key) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
      parentCustomerId: co.parentCustomerId || null,
      parentCompany: co.parentCompany || null,
    };
  }), [results]);

  const summary = useMemo(() => {
    const s = {
      total: flat.length, audited: 0, flagged: 0, matched: 0, skipped: 0, legacy: 0,
      hubspotMatched: 0, multiple: 0,
      reasonTrial: 0, reasonPlan: 0, reasonBillDay: 0, reasonRate: 0, reasonZeroUsage: 0, reasonNoSub: 0,
      hubspotNameAgree: 0, hubspotNameDisagree: 0,
    };
    for (const r of flat) {
      if (r.skipped) { s.skipped++; continue; }
      s.audited++;
      if (r.isLegacy) s.legacy++;
      if (String(r.billingCategory || '').toUpperCase() === 'MULTIPLE') s.multiple++;
      if (r.hubspotDealFound) {
        s.hubspotMatched++;
        if      (r.nameAllThreeMatch === true)  s.hubspotNameAgree++;
        else if (r.nameAllThreeMatch === false) s.hubspotNameDisagree++;
      }
      if (r.flagged) {
        s.flagged++;
        if      (r.reason === 'Trial with active sub')       s.reasonTrial++;
        else if (r.reason === 'Plan mismatch')               s.reasonPlan++;
        else if (r.reason === 'Bill day mismatch')           s.reasonBillDay++;
        else if (r.reason === 'Rate mismatch')               s.reasonRate++;
        else if (r.reason === 'Zero usage')                  s.reasonZeroUsage++;
        else if (r.reason === 'No subscription')             s.reasonNoSub++;
        else if (r.reason === 'HubSpot name mismatch')       s.reasonHsName = (s.reasonHsName || 0) + 1;
        else if (r.reason === 'Sales rep mismatch')          s.reasonSalesRep = (s.reasonSalesRep || 0) + 1;
        else if (r.reason === 'Previously paying unchecked') s.reasonPrevPaying = (s.reasonPrevPaying || 0) + 1;
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
      if (tab === 'multiple'  && String(r.billingCategory || '').toUpperCase() !== 'MULTIPLE') return false;
      if (reasonFilter !== 'all' && r.reason !== reasonFilter) return false;
      if (q) {
        const hay = `${r.client || ''} ${r.coCustomerId || ''} ${r.coCompany || ''} ${r.hubspotDealName || ''} ${r.hubspotDealCompany || ''} ${r.hubspotSalesRep || ''} ${r.hubspotSalesRepEmail || ''} ${r.coSalesperson || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flat, tab, reasonFilter, search]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    // MULTIPLE tab groups by parent so parents and children cluster. Parents
    // (no parentCustomerId) sort by their own CO id; children sort by their
    // parent id then their own id.
    if (tab === 'multiple') {
      return [...filtered].sort((a, b) => {
        const aGroup = a.parentCustomerId || a.coCustomerId || '';
        const bGroup = b.parentCustomerId || b.coCustomerId || '';
        if (aGroup !== bGroup) return String(aGroup).localeCompare(String(bGroup), undefined, { numeric: true });
        // Within a group: parent first (no parent id), then children by id.
        const aChild = a.parentCustomerId ? 1 : 0;
        const bChild = b.parentCustomerId ? 1 : 0;
        if (aChild !== bChild) return aChild - bChild;
        return String(a.coCustomerId || '').localeCompare(String(b.coCustomerId || ''), undefined, { numeric: true });
      });
    }
    return [...filtered].sort((a, b) => {
      if (sort.key === 'answer') { return ((a.answer || 0) - (b.answer || 0)) * dir; }
      const av = (a.client || '').toLowerCase();
      const bv = (b.client || '').toLowerCase();
      return av.localeCompare(bv) * dir;
    });
  }, [filtered, sort, tab]);

  // Build parent → children groups for the MULTIPLE tab. Each group carries
  // its parent row (if present in the CSV, otherwise null), the array of
  // children, and metadata used to render the header block.
  const multipleGroups = useMemo(() => {
    if (tab !== 'multiple') return null;
    const groupsMap = new Map();
    for (const r of sorted) {
      const isChild = !!r.parentCustomerId;
      const key = String(isChild ? r.parentCustomerId : (r.coCustomerId || r.id));
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          key,
          parentCoId: isChild ? r.parentCustomerId : (r.coCustomerId || null),
          parentName: isChild ? (r.parentCompany || null) : (r.coCompany || r.client || null),
          parent: null,
          children: [],
        });
      }
      const g = groupsMap.get(key);
      if (isChild) g.children.push(r);
      else         g.parent = r;
    }
    return [...groupsMap.values()];
  }, [sorted, tab]);

  // Group by CSV Billing Category for the "By category" and "Needs
  // attention" tabs. Rollup counts per category (total, flagged, matched,
  // legacy) surface in the header so ops can eyeball where the pain is
  // without expanding groups.
  const categoryGroups = useMemo(() => {
    if (tab !== 'category' && tab !== 'attention') return null;
    const groupsMap = new Map();
    for (const r of sorted) {
      const cat = String(r.billingCategory || 'UNCATEGORIZED').toUpperCase();
      if (!groupsMap.has(cat)) groupsMap.set(cat, {
        key: cat, category: cat, rows: [],
        total: 0, flagged: 0, matched: 0, legacy: 0,
      });
      const g = groupsMap.get(cat);
      g.rows.push(r);
      g.total++;
      if (r.flagged) g.flagged++;
      if (r.isLegacy) g.legacy++;
      if (!r.flagged && r.active === true) g.matched++;
    }
    // Biggest categories first, but with flagged categories always above
    // clean ones — surface the pain.
    return [...groupsMap.values()].sort((a, b) => {
      if ((b.flagged > 0) !== (a.flagged > 0)) return b.flagged > 0 ? 1 : -1;
      return b.total - a.total;
    });
  }, [sorted, tab]);

  const clickSort = (key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  };

  const doExport = () => {
    // Group the export by billing category (with client-sort within group)
    // to mirror the "By category" tab and give billing a scannable sheet.
    const catOrdered = [...sorted].sort((a, b) => {
      const ca = String(a.billingCategory || 'ZZZ').toUpperCase();
      const cb = String(b.billingCategory || 'ZZZ').toUpperCase();
      if (ca !== cb) return ca.localeCompare(cb);
      return (a.client || '').toLowerCase().localeCompare((b.client || '').toLowerCase());
    });
    const blob = new Blob([toCsv(catOrdered)], { type: 'text/csv;charset=utf-8' });
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
    const isVerify   = progress.phase === 'verifying';
    return (
      <div className="ma-root">
        <PageHead subtitle="Comparing Answer usage against ChargeOver…" />
        <Card pad>
          <div className="ma-run-label">
            {isPrefetch
              ? 'Loading ChargeOver customer & subscription data…'
              : isVerify
                ? <>Verifying plan mismatches against invoices…</>
                : <>Matching Answer rows against ChargeOver… <b>{progress.done}</b> / {progress.total}</>
            }
          </div>
          <div className={`ma-progress${(isPrefetch || isVerify) ? ' ma-progress--indeterminate' : ''}`}>
            <div className="ma-progress-fill" style={(isPrefetch || isVerify) ? undefined : { width: `${pct}%` }} />
          </div>
          <div className="ma-run-hint">
            {isPrefetch && progress.prefetch && Object.keys(progress.prefetch).length > 0
              ? Object.entries(progress.prefetch).map(([k, v]) => `${k}: ${v}`).join(' · ')
              : isVerify
                ? 'Re-checking each flagged row against its most recent CO invoice to filter out stale package data.'
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
                {summary.reasonRate       > 0 && <div style={{ flex: summary.reasonRate,       background: 'var(--crit-100)' }} title={`Rate mismatch (${summary.reasonRate})`} />}
                {summary.reasonZeroUsage  > 0 && <div style={{ flex: summary.reasonZeroUsage,  background: 'var(--crit-700)' }} title={`Zero usage, active sub (${summary.reasonZeroUsage})`} />}
                {summary.reasonNoSub      > 0 && <div style={{ flex: summary.reasonNoSub,      background: 'var(--warn-500)' }} title={`No subscription (${summary.reasonNoSub})`} />}
                {summary.reasonHsName     > 0 && <div style={{ flex: summary.reasonHsName,     background: 'var(--warn-100)' }} title={`HubSpot name mismatch (${summary.reasonHsName})`} />}
                {summary.reasonSalesRep   > 0 && <div style={{ flex: summary.reasonSalesRep,   background: 'var(--ink-500)' }} title={`Sales rep mismatch (${summary.reasonSalesRep})`} />}
                {summary.reasonPrevPaying > 0 && <div style={{ flex: summary.reasonPrevPaying, background: 'var(--warn-700)' }} title={`Previously paying unchecked (${summary.reasonPrevPaying})`} />}
              </div>
              <div className="ma-reason-legend">
                <LegendChip color="var(--warn-600)" label="Trial with active sub"    n={summary.reasonTrial} />
                <LegendChip color="var(--crit-600)" label="Plan mismatch"            n={summary.reasonPlan} />
                <LegendChip color="var(--crit-500)" label="Bill day mismatch"        n={summary.reasonBillDay} />
                <LegendChip color="var(--crit-100)" label="Rate mismatch"            n={summary.reasonRate} />
                <LegendChip color="var(--crit-700)" label="Zero usage, active sub"   n={summary.reasonZeroUsage} />
                <LegendChip color="var(--warn-500)" label="No subscription"          n={summary.reasonNoSub} />
                {summary.reasonHsName     > 0 && <LegendChip color="var(--warn-100)" label="HubSpot name mismatch"    n={summary.reasonHsName} />}
                {summary.reasonSalesRep   > 0 && <LegendChip color="var(--ink-500)" label="Sales rep mismatch"       n={summary.reasonSalesRep} />}
                {summary.reasonPrevPaying > 0 && <LegendChip color="var(--warn-700)" label="Previously paying unchecked" n={summary.reasonPrevPaying} />}
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
              value={String(summary.legacy)} hint="name-drift flags suppressed" />
          )}
          <Tile eyebrow="Skipped" sub="INTERNAL / FREE"
            value={String(summary.skipped)} />
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'attention', label: 'Needs attention', count: summary.flagged },
          { id: 'category',  label: 'By category',     count: summary.audited },
          { id: 'matched',   label: 'Matched',         count: summary.matched },
          { id: 'multiple',  label: 'Multiple',        count: summary.multiple },
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
        {(tab === 'attention' || tab === 'category') && categoryGroups && categoryGroups.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => {
            const anyExpanded = categoryGroups.some(g => !collapsedCategories.has(g.key));
            setCollapsedCategories(anyExpanded ? new Set(categoryGroups.map(g => g.key)) : new Set());
          }}>
            {categoryGroups.some(g => !collapsedCategories.has(g.key)) ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
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
                ) : tab === 'multiple' ? (
                  <>
                    <th>Role</th>
                    <th data-align="center">Plan (Answer / CO)</th>
                    <th data-align="center">Bill day (Answer / CO)</th>
                    <th>Reason</th>
                    <th data-align="right">Used</th>
                    {showAllCols && <th>Category</th>}
                    {showAllCols && <th>Cycle</th>}
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
                          ? 'No CSV rows resolved to a HubSpot account that entered Onboarding 2 / PAID in the last 90 days.'
                          : 'Try a different tab, or clear filters to widen the view.'}
                    actions={search || reasonFilter !== 'all' || tab !== 'attention'
                      ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
                      : null}
                  />
                </td></tr>
              ) : tab === 'multiple' ? (
                multipleGroups.map(g => {
                  const total = (g.parent ? 1 : 0) + g.children.length;
                  return (
                    <React.Fragment key={g.key}>
                      <tr className="ma-group-header">
                        <td colSpan={colCount}>
                          <div className="ma-group-title-row">
                            <div>
                              <div className="ma-group-title">{g.parentName || `ChargeOver #${g.parentCoId}`}</div>
                              <div className="ma-group-meta">
                                Parent CO #{g.parentCoId || '—'} · {total} account{total === 1 ? '' : 's'} in this file
                                {!g.parent && ' · parent row not in CSV'}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                      {g.parent && (
                        <TableRow key={g.parent.id} r={g.parent} expanded={expandedId === g.parent.id}
                          onToggle={() => setExpandedId(id => id === g.parent.id ? null : g.parent.id)}
                          colCount={colCount} showAllCols={showAllCols} tab={tab} groupRole="parent" />
                      )}
                      {g.children.map(c => (
                        <TableRow key={c.id} r={c} expanded={expandedId === c.id}
                          onToggle={() => setExpandedId(id => id === c.id ? null : c.id)}
                          colCount={colCount} showAllCols={showAllCols} tab={tab} groupRole="child" />
                      ))}
                    </React.Fragment>
                  );
                })
              ) : (tab === 'category' || tab === 'attention') ? (
                categoryGroups.map(g => {
                  const collapsed = collapsedCategories.has(g.key);
                  return (
                    <React.Fragment key={g.key}>
                      <tr className="ma-group-header ma-group-header--category ma-group-clickable" onClick={() => toggleCategory(g.key)}>
                        <td colSpan={colCount}>
                          <div className="ma-group-title-row">
                            <div>
                              <div className="ma-group-title">
                                <span className="ma-group-caret" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
                                {g.category}
                              </div>
                              <div className="ma-group-meta">
                                {g.total} account{g.total === 1 ? '' : 's'}
                                {g.flagged > 0 && <> · <span className="ma-group-flagged">{g.flagged} flagged</span></>}
                                {g.matched > 0 && ` · ${g.matched} matched`}
                                {g.legacy  > 0 && ` · ${g.legacy} legacy`}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                      {!collapsed && g.rows.map(r => (
                        <TableRow key={r.id} r={r} expanded={expandedId === r.id}
                          onToggle={() => setExpandedId(id => id === r.id ? null : r.id)}
                          colCount={colCount} showAllCols={showAllCols} tab={tab} />
                      ))}
                    </React.Fragment>
                  );
                })
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


function TableRow({ r, expanded, onToggle, colCount, showAllCols, tab, groupRole }) {
  const rowState = (r.planMismatch || r.billDayMismatch) ? 'crit'
                 : r.flagged                             ? 'warn'
                                                         : undefined;
  const rowCls = ['ma-row'];
  if (groupRole === 'parent') rowCls.push('ma-row-parent');
  if (groupRole === 'child')  rowCls.push('ma-row-child');
  return (
    <>
      <tr onClick={onToggle} className={rowCls.join(' ')} data-state={rowState}>
        <td className="ma-caret">
          {groupRole === 'child' && <span className="ma-tree-marker" aria-hidden="true">└</span>}
          {expanded ? '▼' : '▶'}
        </td>
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
            {showAllCols && <td data-align="center"><CompareCell csv={r.hubspotSalesRepEmail || r.hubspotSalesRep} co={r.coSalesperson} unit="" mismatch={r.salesRepMismatch} labels={{ csv: 'HS', co: 'CO' }} /></td>}
            {showAllCols && <td className="ma-cell-meta">{r.hubspotDealId || '—'}</td>}
          </>
        ) : tab === 'multiple' ? (
          <>
            <td>
              {groupRole === 'parent'
                ? <Badge tone="info">Parent</Badge>
                : <Badge tone="neutral">Child</Badge>}
            </td>
            <td data-align="center"><CompareCell csv={r.csvPlan} co={r.coPlan} unit=" min" mismatch={r.planMismatch} /></td>
            <td data-align="center"><CompareCell csv={r.csvBillDay} co={r.coBillDay} unit="" ordinal mismatch={r.billDayMismatch} /></td>
            <td><ReasonPill reason={r.reason} /></td>
            <td data-align="right" data-num>{fmtNum(r.answer)}</td>
            {showAllCols && <td>{r.billingCategory || '—'}</td>}
            {showAllCols && <td>{r.billingCycle || '—'}</td>}
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
              <DetailField label="Overage rate (Answer)"
                value={r.csvOverageRate != null ? `$${r.csvOverageRate.toFixed(2)}/min` : '—'}
                sub={r.rateMismatch ? 'differs from pricing sheet' : null} />
              <DetailField label={`Overage rate (${r.chargeover?.tenant || r.clientType || '?'} pricing sheet)`}
                value={r.pricingSheetOverageRate != null ? `$${r.pricingSheetOverageRate.toFixed(2)}/min` : (r.csvPlan != null ? 'no tier match' : '—')}
                sub={r.csvPlan != null ? `${r.csvPlan}-min tier` : null} />
              {r.hubspotDealFound ? (
                <DetailField label="Sales rep (HubSpot) — source of truth"
                  value={r.hubspotSalesRepEmail || r.hubspotSalesRep || '—'}
                  sub={[
                    r.hubspotSalesRep && r.hubspotSalesRepEmail ? r.hubspotSalesRep : null,
                    r.hubspotRepSource ? `from ${r.hubspotRepSource}` : null,
                    r.hubspotOwnerActive === false ? 'owner deactivated' : null,
                    r.hubspotPaidEnteredAt ? `moved to PAID ${r.hubspotPaidEnteredAt}` : null,
                    `deal: ${r.hubspotDealName}`,
                  ].filter(Boolean).join(' · ')} />
              ) : (
                <DetailField label="HubSpot deal"
                  value={r.isLegacy ? 'none (legacy)' : 'no matching deal in last 90 days'}
                  sub={r.coCreatedAt ? `CO customer since ${r.coCreatedAt}` : null} />
              )}
              <DetailField label={r.salesRepMismatch ? 'Salesperson (ChargeOver) — update to match' : 'Salesperson (ChargeOver)'}
                value={r.coSalesperson || '— (not set on CO)'}
                sub={r.chargeover?.tenant ? `${r.chargeover.tenant === 'AL' ? 'custom_6' : 'custom_2'} on the CO customer` : null} />
              <DetailField label="Account manager (ChargeOver)"
                value={r.coAdminName || '—'}
                sub={r.coAdminEmail || null} />

              {r.previouslyPayingRequired && (
                <DetailField label={r.previouslyPayingMissing ? 'Previously paying (HubSpot) — needs to be checked' : 'Previously paying (HubSpot)'}
                  value={r.previouslyPayingChecked ? 'Checked ✓' : (r.previouslyPayingProp ? 'Not checked' : 'Property not found')}
                  sub={r.returnCustomerLinkedTo
                    ? `Linked to prior CO customer #${r.returnCustomerLinkedTo} (matched on ${String(r.returnCustomerMatchedBy || '').replace('_', ' ')})`
                    : 'Customer has a canceled and a separate active subscription in CO'} />
              )}

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
