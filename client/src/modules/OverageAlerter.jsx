import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import api from '../api';
import { Button, Card, Input, Select, Badge, Checkbox, EmptyState, Modal } from '../components/ui';
import './OverageAlerter.css';

/* ─── helpers ─────────────────────────────────────────────────────── */

// The job's internal phase names, in words a biller would use.
const PHASE_COPY = {
  starting:            'Starting up',
  prefetching:         'Reading customers and subscriptions',
  'fetching invoices': 'Reading overage invoices',
  aggregating:         'Working out the numbers',
  done:                'Finishing up',
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-08" → "Aug ’26"
function fmtMonth(ym) {
  if (!ym) return '—';
  const [y, m] = String(ym).split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_LABELS[idx] ?? m} ’${String(y).slice(2)}`;
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Math.round(Number(n)).toLocaleString() + '%';
}

// "about 4 minutes left" — deliberately vague at the top end, precise near the
// finish. A countdown that claims "3:47" and then slips reads as broken; a
// rounded estimate that lands early reads as fast.
function fmtEta(seconds) {
  if (seconds == null) return null;
  if (seconds <= 5)  return 'almost done';
  if (seconds < 60)  return 'less than a minute left';
  const mins = Math.round(seconds / 60);
  if (mins === 1)    return 'about a minute left';
  return `about ${mins} minutes left`;
}

function fmtElapsed(ms) {
  if (!ms) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// "12 Sep 2026" — a send date is read at a glance, not compared precisely.
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// A subscription edited this recently is worth a second look before emailing:
// they may have just been moved to a bigger plan, and "you keep going over"
// is the wrong conversation to have a month later.
const SUB_CHANGE_WARN_DAYS = 60;

function subChangedRecently(row) {
  if (!row?.subChangedAt) return null;
  const d = daysSince(row.subChangedAt);
  return d != null && d < SUB_CHANGE_WARN_DAYS ? d : null;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Math.round(Number(n)).toLocaleString();
}

// Severity banding for "% over plan" — drives the heat strip and pill tone.
// A customer at 100% used double their plan, so the bands climb steeply.
function pctTone(pct) {
  if (pct == null) return 'none';
  if (pct >= 200) return 'sev4';
  if (pct >= 100) return 'sev3';
  if (pct >= 50)  return 'sev2';
  return 'sev1';
}

function streakTone(streak, ongoing) {
  if (!ongoing) return 'neutral';
  if (streak >= 6) return 'crit';
  if (streak >= 3) return 'warn';
  return 'info';
}

/* ─── module ──────────────────────────────────────────────────────── */

export default function OverageAlerter() {
  const [view, setView]         = useState('idle');   // idle | running | results
  const [error, setError]       = useState('');
  const [progress, setProgress] = useState({ phase: '', prefetch: {}, invoiceCount: 0, total: 0, pct: 0, etaSeconds: null, elapsedMs: 0 });
  const [data, setData]         = useState(null);     // full job payload

  // ── Thresholds. These are the knobs — every one of them filters the
  //    already-fetched dataset in the browser, so dragging them is instant
  //    and never re-hits ChargeOver. ──
  const [minStreak, setMinStreak]   = useState(2);    // "2 months in a row" is the ask
  const [ongoingOnly, setOngoingOnly] = useState(true);
  const [minPct, setMinPct]         = useState(0);
  const [minTotal, setMinTotal]     = useState(0);
  const [tenant, setTenant]         = useState('all');
  const [search, setSearch]         = useState('');
  const [sort, setSort]             = useState({ key: 'currentStreak', dir: 'desc' });
  const [expanded, setExpanded]     = useState(() => new Set());

  // Outreach: ChargeOver template config + the local send log that powers the
  // last-sent column and the re-send window.
  const [outreach, setOutreach] = useState({ config: { AL: {}, RS: {} }, log: {}, cooldownDays: 30, ready: {} });
  const [sendTarget, setSendTarget] = useState(null);   // row awaiting confirmation
  const [sending, setSending]       = useState(false);
  const [sendError, setSendError]   = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftCfg, setDraftCfg]     = useState({ AL: '', RS: '' });
  const [toast, setToast]           = useState('');
  const [showReplanned, setShowReplanned] = useState(false);

  const readerRef = useRef(null);
  useEffect(() => () => { try { readerRef.current?.cancel(); } catch { /* ok */ } }, []);

  const toggleRow = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  /* ── run ───────────────────────────────────────────────────────── */

  const loadOutreach = useCallback(async () => {
    try {
      const r = await api.get('/api/overage-alerter/outreach');
      setOutreach(r.data);
      setDraftCfg({
        AL: r.data.config?.AL?.messageId ? String(r.data.config.AL.messageId) : '',
        RS: r.data.config?.RS?.messageId ? String(r.data.config.RS.messageId) : '',
      });
    } catch { /* non-fatal — the table still works, sending just won't */ }
  }, []);

  const loadResults = useCallback(async (jobId) => {
    const resp = await api.get(`/api/overage-alerter/results/${jobId}`);
    if (resp.data?.status === 'error') { setError(resp.data.error || 'Job failed'); return false; }
    setData(resp.data);
    // Template config + send log land with the results, so the last-sent column
    // is populated the moment the table renders.
    await loadOutreach();
    return true;
  }, [loadOutreach]);

  // The stream can be cut short by Cloudflare around the 100s mark and this
  // job routinely runs longer than that, so a severed stream falls back to
  // polling rather than being treated as a failure.
  const pollUntilComplete = useCallback(async (jobId) => {
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000) {
      try {
        const resp = await api.get(`/api/overage-alerter/results/${jobId}`);
        const { status, phase, prefetch, invoiceCount, total, pct, etaSeconds, elapsedMs } = resp.data || {};
        setProgress({
          phase, prefetch: prefetch || {}, invoiceCount: invoiceCount || 0, total: total || 0,
          pct: pct || 0, etaSeconds: etaSeconds ?? null, elapsedMs: elapsedMs || 0,
        });
        if (status === 'done' || status === 'error') return;
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 2500));
    }
  }, []);

  const startStream = useCallback(async (jobId) => {
    try {
      const resp = await fetch(`/api/overage-alerter/stream/${jobId}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok) { await pollUntilComplete(jobId); return; }
      const reader = resp.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let doneReceived = false;
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
            setProgress({
              phase: msg.phase, prefetch: msg.prefetch || {},
              invoiceCount: msg.invoiceCount || 0, total: msg.total || 0,
              pct: msg.pct || 0, etaSeconds: msg.etaSeconds ?? null, elapsedMs: msg.elapsedMs || 0,
            });
            if (msg.type === 'done') doneReceived = true;
          } catch { /* skip malformed event */ }
        }
      }
      if (!doneReceived) await pollUntilComplete(jobId);
    } catch {
      await pollUntilComplete(jobId);
    }
  }, [pollUntilComplete]);

  const handleRun = async () => {
    setError('');
    setData(null);
    setProgress({ phase: 'starting', prefetch: {}, invoiceCount: 0, total: 0, pct: 0, etaSeconds: null, elapsedMs: 0 });
    setView('running');
    try {
      const resp = await api.post('/api/overage-alerter/run');
      const { jobId, estimatedSeconds } = resp.data;
      // Seed the countdown from the last run's time so it never shows a blank
      // or an "estimating…" gap while the first rows come back.
      if (estimatedSeconds) setProgress(p => ({ ...p, etaSeconds: estimatedSeconds }));
      await startStream(jobId);
      const ok = await loadResults(jobId);
      setView(ok ? 'results' : 'idle');
    } catch (e) {
      setError('Run failed: ' + (e.response?.data?.error || e.message));
      setView('idle');
    }
  };

  const doSend = useCallback(async (row, override) => {
    setSending(true);
    setSendError('');
    try {
      const r = await api.post('/api/overage-alerter/outreach/send', {
        tenant: row.tenant, customerId: row.customerId, override: !!override,
        // Send the usage picture the operator is actually looking at, so the
        // Monday record explains why this email went out.
        usage: {
          planMinutes: row.planMinutes,
          currentStreak: row.currentStreak,
          months: (row.months || []).slice(-3).map(m => ({
            month: m.month, totalMinutes: m.totalMinutes,
            pctOverPlan: m.pctOverPlan, totalAmount: m.totalAmount,
          })),
        },
      });
      setOutreach(prev => ({ ...prev, log: { ...prev.log, [row.key]: r.data.entry } }));
      setSendTarget(null);
      // A warning here means the email DID go out but the Monday mirror failed —
      // say so plainly rather than reporting a clean success.
      setToast(r.data.warning
        ? `Emailed ${row.company || row.customerId} — but it didn't reach the Monday board. ${r.data.warning}`
        : `Emailed ${row.company || row.customerId}${r.data.entry?.toEmail ? ` at ${r.data.entry.toEmail}` : ''}`);
      setTimeout(() => setToast(''), r.data.warning ? 14000 : 6000);
    } catch (e) {
      const d = e.response?.data;
      setSendError(d?.message || d?.error || e.message);
    } finally {
      setSending(false);
    }
  }, []);

  const saveConfig = useCallback(async () => {
    try {
      const r = await api.put('/api/overage-alerter/outreach/config', {
        AL: { messageId: draftCfg.AL || null },
        RS: { messageId: draftCfg.RS || null },
      });
      setOutreach(prev => ({ ...prev, config: r.data.config, ready: r.data.ready }));
      setSettingsOpen(false);
      setToast('Email template settings saved');
      setTimeout(() => setToast(''), 4000);
    } catch (e) {
      setSendError(e.response?.data?.error || e.message);
    }
  }, [draftCfg]);

  /* ── derived ───────────────────────────────────────────────────── */

  const latestMonth = data?.latestMonth || null;
  const cycles = data?.cycles || 3;

  // Every month present in the window, oldest → newest. This is the x-axis of
  // the heat strip, so every row lines up even when a customer only overaged
  // in a few of them.
  const monthAxis = useMemo(() => {
    if (!data?.results) return [];
    const set = new Set();
    for (const r of data.results) for (const m of r.months) set.add(m.month);
    return [...set].sort();
  }, [data]);

  const rows = useMemo(() => {
    if (!data?.results) return [];
    const q = search.trim().toLowerCase();
    return data.results.filter(r => {
      if (tenant !== 'all' && r.tenant !== tenant) return false;
      if (r.currentStreak < minStreak) return false;
      if (ongoingOnly && r.lastMonth !== latestMonth) return false;
      if (minPct > 0 && !(r.peakPctOverPlan >= minPct)) return false;
      if (minTotal > 0 && !(r.totalAmount >= minTotal)) return false;
      if (q && !(`${r.company || ''} ${r.email || ''} ${r.customerId}`.toLowerCase().includes(q))) return false;
      return true;
    }).map(r => {
      // How far over they are in the newest cycle everyone shares, so the
      // column compares like with like. A customer who wasn't billed an
      // overage that cycle gets null, not zero — "no overage" and "exactly on
      // plan" are different answers.
      const m = r.months.find(x => x.month === latestMonth);
      return { ...r, latestPct: m ? m.pctOverPlan : null, latestMinutes: m ? m.totalMinutes : null };
    });
  }, [data, tenant, minStreak, ongoingOnly, minPct, minTotal, search, latestMonth]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      }
      // Missing values sink to the bottom whichever way the sort runs.
      // Treating them as 0 would rank "no plan on the subscription" as the
      // smallest plan, and "no overage this cycle" as nought percent over —
      // both are absent facts, not low ones.
      const aMissing = av == null, bMissing = bv == null;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return (av - bv) * dir;
    });
  }, [rows, sort]);

  // Customers whose subscription was changed inside the cycles on screen are
  // held separately. They turn up constantly — a third of active subscriptions
  // were edited in this window — and are usually the wrong people to email: the
  // overages above may be exactly what prompted the change, and "you keep going
  // over" lands badly a few weeks after someone moved them to a bigger plan.
  const { mainRows, replannedRows } = useMemo(() => {
    const floor = data?.monthFloor ? `${data.monthFloor}-01` : null;
    if (!floor) return { mainRows: sorted, replannedRows: [] };
    const main = [], replanned = [];
    for (const r of sorted) {
      const changed = r.subChangedAt ? String(r.subChangedAt).slice(0, 10) : null;
      (changed && changed >= floor ? replanned : main).push(r);
    }
    return { mainRows: main, replannedRows: replanned };
  }, [sorted, data]);

  const summary = useMemo(() => {
    const totalAmount = rows.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const withPlan = rows.filter(r => r.peakPctOverPlan > 0);
    const avgPeak = withPlan.length
      ? withPlan.reduce((s, r) => s + r.peakPctOverPlan, 0) / withPlan.length : 0;
    // What the alert would actually bill this month, for the flagged set.
    const latestAmount = rows.reduce((s, r) => {
      const m = r.months.find(x => x.month === latestMonth);
      return s + (m?.totalAmount || 0);
    }, 0);
    return { count: rows.length, totalAmount, avgPeak, latestAmount };
  }, [rows, latestMonth]);

  const setSortKey = (key) => setSort(s => (
    s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
  ));

  const sortArrow = (key) => (sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : '');

  /* One table row, shared by the main list and the re-planned group. */
    const renderRow = (r) => {
                  const isOpen = expanded.has(r.key);
                  const ongoing = r.lastMonth === latestMonth;
                  const byMonth = new Map(r.months.map(m => [m.month, m]));
      return (
                    <React.Fragment key={r.key}>
                      <tr className="oa-row" onClick={() => toggleRow(r.key)}>
                        <td className="oa-td-expand">{isOpen ? '▾' : '▸'}</td>
                        <td>
                          <div className="oa-cust">
                            <Badge tone={r.tenant === 'AL' ? 'info' : 'accent'} size="sm">{r.tenant}</Badge>
                            {r.coUrl ? (
                              <a
                                className="oa-cust-name oa-cust-link"
                                href={r.coUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                // The row itself toggles the month detail, so a
                                // click on the name must not also expand it.
                                onClick={e => e.stopPropagation()}
                                title="Open this customer in ChargeOver"
                              >
                                {r.company || `CO #${r.customerId}`}
                                <span className="oa-ext" aria-hidden="true">↗</span>
                              </a>
                            ) : (
                              <span className="oa-cust-name">{r.company || `CO #${r.customerId}`}</span>
                            )}
                            {r.subStatus && !String(r.subStatus).startsWith('active') && (
                              <Badge tone="neutral" size="sm">{r.subStatus}</Badge>
                            )}
                            {subChangedRecently(r) != null && (
                              <Badge tone="warn" size="sm" title={`Subscription last changed ${fmtDate(r.subChangedAt)} — check whether they were re-planned before emailing`}>
                                sub changed {subChangedRecently(r)}d ago
                              </Badge>
                            )}
                          </div>
                          <div className="oa-cust-sub">{r.email || `CO #${r.customerId}`}</div>
                        </td>
                        <td className="oa-num oa-mono">
                          {r.planMinutes ? `${fmtNum(r.planMinutes)} min` : <span className="oa-muted">no plan</span>}
                          <div className="oa-plan-cost">
                            {r.monthlyCost != null
                              ? `${fmtMoney(r.monthlyCost)}/mo`
                              : <span className="oa-muted">cost unknown</span>}
                          </div>
                        </td>
                        <td className="oa-num">
                          <Badge tone={streakTone(r.currentStreak, ongoing)} size="sm">
                            {r.currentStreak} mo{ongoing ? '' : ' (ended)'}
                          </Badge>
                        </td>
                        <td className="oa-months-td">
                          <div className="oa-strip">
                            {monthAxis.map(ym => {
                              const m = byMonth.get(ym);
                              return (
                                <span
                                  key={ym}
                                  className="oa-cell"
                                  data-tone={m ? pctTone(m.pctOverPlan) : 'none'}
                                  data-waived={m?.fullyWaived ? 'yes' : undefined}
                                  title={m
                                    ? `${fmtMonth(ym)} — ${fmtNum(m.totalMinutes)} overage min on a ${r.planMinutes || '?'} min plan (${fmtPct(m.pctOverPlan)} over), ${fmtMoney(m.totalAmount)}${m.fullyWaived ? ' — waived' : ''}`
                                    : `${fmtMonth(ym)} — no overage`}
                                />
                              );
                            })}
                          </div>
                        </td>
                        <td className="oa-num">
                          {r.latestPct == null
                            ? <span className="oa-muted">—</span>
                            : <span className="oa-pct-pill" data-tone={pctTone(r.latestPct)}
                                    title={`${fmtNum(r.latestMinutes)} overage minutes in ${fmtMonth(latestMonth)}`}>
                                {fmtPct(r.latestPct)}
                              </span>}
                        </td>
                        <td className="oa-num oa-mono">{fmtPct(r.peakPctOverPlan)}</td>
                        <td className="oa-num oa-mono">{fmtMoney(r.totalAmount)}</td>
                        <td className="oa-outreach-td" onClick={e => e.stopPropagation()}>
                          <OutreachCell
                            row={r}
                            entry={outreach.log?.[r.key]}
                            cooldownDays={outreach.cooldownDays}
                            ready={!!outreach.ready?.[r.tenant]}
                            onSend={() => { setSendError(''); setSendTarget(r); }}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="oa-detail-row">
                          <td colSpan={9}>
                            <div className="oa-detail">
                              <table className="oa-detail-table">
                                <thead>
                                  <tr>
                                    <th>Usage month</th>
                                    <th className="oa-num">Overage min</th>
                                    <th className="oa-num">Plan</th>
                                    <th className="oa-num">% over plan</th>
                                    <th className="oa-num">Rate</th>
                                    <th className="oa-num">Billed</th>
                                    <th>Invoice date</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.months.slice().reverse().map(m => (
                                    <tr key={m.month}>
                                      <td>{fmtMonth(m.month)}</td>
                                      <td className="oa-num oa-mono">{fmtNum(m.totalMinutes)}</td>
                                      <td className="oa-num oa-mono">{r.planMinutes ? fmtNum(r.planMinutes) : '—'}</td>
                                      <td className="oa-num">
                                        <span className="oa-pct-pill" data-tone={pctTone(m.pctOverPlan)}>{fmtPct(m.pctOverPlan)}</span>
                                      </td>
                                      <td className="oa-num oa-mono">{m.rate != null ? `$${m.rate.toFixed(2)}` : '—'}</td>
                                      <td className="oa-num oa-mono">
                                        {fmtMoney(m.totalAmount)}
                                        {m.waivedMinutes > 0 && (
                                          <Badge tone="warn" size="sm" className="oa-waived-tag">
                                            {m.fullyWaived ? 'waived' : `${fmtNum(m.waivedMinutes)} min waived`}
                                          </Badge>
                                        )}
                                      </td>
                                      <td className="oa-mono oa-muted">{m.invoices.map(i => i.invoiceDate).join(', ')}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <div className="oa-detail-note">
                                Plan size is the customer’s current ChargeOver subscription ({r.planMinutes ? `${fmtNum(r.planMinutes)} min` : 'not set'}),
                                last changed {r.subChangedAt ? fmtDate(r.subChangedAt) : 'unknown'}.
                                Each invoice bills the previous cycle, so it’s filed under the month the minutes were used. Only the last three cycles are shown — the Monday board keeps the longer history.
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
      );
    };


  /* ── render ────────────────────────────────────────────────────── */

  if (view === 'idle' || view === 'running') {
    const prefetchLines = Object.entries(progress.prefetch || {});
    return (
      <div className="oa-root">
        <PageHead />
        {error && <div className="oa-error">{error}</div>}
        {view === 'idle' ? (
          <Card pad className="oa-launch">
            <EmptyState
              glyph="📈"
              title="Find customers who keep paying overages"
              description="Shows which customers were billed minute overages over their last three billing cycles, measured against the plan on their subscription. Covers both Answering Legal and Ring Savvy. It reads every customer and subscription in both accounts, so give it a few minutes — you'll get a progress bar and a countdown while it works."
              actions={<Button onClick={handleRun}>Run the audit</Button>}
            />
          </Card>
        ) : (
          <Card pad className="oa-launch">
            <div className="oa-running">
              <LoadingBout />
              <div className="oa-running-phase">{PHASE_COPY[progress.phase] || 'Starting up'}</div>
              <div className="oa-running-eta">{fmtEta(progress.etaSeconds) || 'estimating…'}</div>

              <div className="oa-progress" role="progressbar"
                   aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="oa-progress-fill" style={{ width: `${Math.max(2, progress.pct)}%` }} />
              </div>
              <div className="oa-progress-meta">
                <span className="oa-mono">{progress.pct}%</span>
                <span className="oa-muted">elapsed {fmtElapsed(progress.elapsedMs)}</span>
              </div>

              <div className="oa-running-detail">
                {prefetchLines.length === 0
                  ? <span className="oa-muted">Connecting to ChargeOver…</span>
                  : prefetchLines.map(([label, n]) => (
                      <div key={label} className="oa-running-line">
                        <span>{label}</span><span className="oa-mono">{fmtNum(n)}</span>
                      </div>
                    ))}
              </div>

              <p className="oa-running-note">
                This reads every customer, subscription and overage invoice in both ChargeOver
                tenants — a few minutes is normal. You can leave this tab open; it keeps running.
              </p>
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="oa-root">
      <PageHead
        actions={
          <div className="oa-head-actions">
            {outreach.monday?.boardUrl && (
              <a className="oa-board-link" href={outreach.monday.boardUrl} target="_blank" rel="noopener noreferrer">
                Outreach board ↗
              </a>
            )}
            <Button variant="ghost" onClick={() => { loadOutreach(); setSettingsOpen(true); }}>Email settings</Button>
            <Button variant="secondary" onClick={handleRun}>Re-run</Button>
          </div>
        }
        meta={data ? `${fmtNum(data.results?.length)} customers over plan · last ${data.cycles || 3} billing cycles · through ${fmtMonth(latestMonth)}` : null}
      />
      {error && <div className="oa-error">{error}</div>}

      {/* ── thresholds ─────────────────────────────────────────── */}
      <Card className="oa-controls" pad>
        <div className="oa-controls-row">
          <div className="oa-control oa-control--streak">
            <label className="oa-control-label" htmlFor="oa-streak">
              Consecutive months <strong>{minStreak}+</strong>
            </label>
            <input
              id="oa-streak" type="range" min="1" max={cycles} step="1"
              value={minStreak} onChange={e => setMinStreak(Number(e.target.value))}
              className="oa-range"
            />
            <div className="oa-control-hint">Billed an overage {minStreak} month{minStreak === 1 ? '' : 's'} in a row</div>
          </div>

          <div className="oa-control oa-control--streak">
            <label className="oa-control-label" htmlFor="oa-pct">
              Peak over plan <strong>{minPct > 0 ? `${minPct}%+` : 'any'}</strong>
            </label>
            <input
              id="oa-pct" type="range" min="0" max="500" step="25"
              value={minPct} onChange={e => setMinPct(Number(e.target.value))}
              className="oa-range"
            />
            <div className="oa-control-hint">Worst month at least this far over plan</div>
          </div>

          <Input
            label="Min overage billed"
            type="number" min="0" step="500" value={minTotal}
            onChange={e => setMinTotal(Number(e.target.value) || 0)}
          />

          <Select
            label="Tenant" value={tenant} onChange={e => setTenant(e.target.value)}
            options={[
              { value: 'all', label: 'Both tenants' },
              { value: 'AL',  label: 'Answering Legal' },
              { value: 'RS',  label: 'Ring Savvy' },
            ]}
          />

          <Input
            label="Search" placeholder="Company, email or CO id"
            value={search} onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="oa-controls-foot">
          <Checkbox
            label={`Still overaging (streak runs through ${fmtMonth(latestMonth)})`}
            checked={ongoingOnly}
            onChange={e => setOngoingOnly(e.target.checked)}
          />
          <button type="button" className="oa-reset" onClick={() => {
            setMinStreak(2); setOngoingOnly(true); setMinPct(0); setMinTotal(0);
            setTenant('all'); setSearch('');
          }}>Reset to the 2-month alert</button>
        </div>
      </Card>

      {/* ── summary ────────────────────────────────────────────── */}
      <div className="oa-tiles">
        <Tile
          label="Customers shown"
          value={fmtNum(summary.count)}
          hint="How many customers match the filters you've set above."
        />
        <Tile
          label={`Billed in ${fmtMonth(latestMonth)}`}
          value={fmtMoney(summary.latestAmount)}
          hint={`What these customers were charged in overage fees for ${fmtMonth(latestMonth)} alone — their most recent cycle.`}
        />
        <Tile
          label="Billed across all 3 cycles"
          value={fmtMoney(summary.totalAmount)}
          hint="Total overage charges for these customers across the three cycles shown. Not their subscription cost — just the overage on top."
        />
        <Tile
          label="Typical worst month"
          value={fmtPct(summary.avgPeak)}
          hint="Take each customer's worst single cycle, measure how far past their plan they went, and average those. 200% means the typical customer here used triple their plan in their worst month."
        />
      </div>

      {/* ── table ──────────────────────────────────────────────── */}
      {sorted.length === 0 ? (
        <Card pad>
          <EmptyState
            glyph="🔍"
            title="Nothing matches these thresholds"
            description="Loosen the consecutive-month or over-plan sliders to widen the net."
          />
        </Card>
      ) : (
        <Card className="oa-table-card">
          <div className="oa-table-scroll">
            <table className="oa-table">
              <thead>
                <tr>
                  <th className="oa-th-expand" />
                  <th><Hint text="The account in ChargeOver. Click a name to open their ChargeOver profile.">Customer</Hint></th>
                  <th className="oa-num oa-plan-th">
                    <span className="oa-sortable" onClick={() => setSortKey('planMinutes')}>
                      <Hint text="Minutes included in their plan. Click to sort by plan size.">Plan</Hint>{sortArrow('planMinutes')}
                    </span>
                    <span className="oa-sortable oa-subsort" onClick={() => setSortKey('monthlyCost')}>
                      <Hint text="What the subscription bills each month — the plan plus any add-ons, at the price this customer actually pays. Click to sort by monthly cost.">$/mo</Hint>{sortArrow('monthlyCost')}
                    </span>
                  </th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('currentStreak')}><Hint text="How many cycles in a row they've been billed an overage, counting back from the most recent. 3 means every cycle shown.">Streak</Hint>{sortArrow('currentStreak')}</th>
                  <th className="oa-months-th"><Hint text="One square per cycle, oldest on the left. Colour shows how far over plan they went; an empty square means no overage that cycle. Hover a square for the detail.">Overage by billing cycle</Hint></th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('latestPct')}>
                    <Hint text={`How far past their plan they went in ${fmtMonth(latestMonth)}, the most recent cycle. 100% means they used double their plan. A dash means they weren't billed an overage that cycle.`}>{fmtMonth(latestMonth)}</Hint>{sortArrow('latestPct')}
                  </th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('peakPctOverPlan')}><Hint text="Their worst single cycle: how far past their plan they went. 100% means they used double their plan.">Peak</Hint>{sortArrow('peakPctOverPlan')}</th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('totalAmount')}><Hint text="Overage charges across the cycles shown — on top of their subscription.">Billed</Hint>{sortArrow('totalAmount')}</th>
                  <th className="oa-outreach-th"><Hint text="Whether we've emailed this customer about their overages, and when.">Outreach</Hint></th>
                </tr>
              </thead>
              <tbody>
                {mainRows.map(renderRow)}

                {replannedRows.length > 0 && (
                  <tr className="oa-group-row">
                    <td colSpan={9}>
                      <button type="button" className="oa-group-toggle"
                              onClick={() => setShowReplanned(v => !v)}
                              aria-expanded={showReplanned}>
                        <span className="oa-group-caret">{showReplanned ? '▾' : '▸'}</span>
                        Subscription changed this period ({replannedRows.length})
                        <span className="oa-group-note">
                          usually not worth emailing — their plan was already adjusted
                        </span>
                      </button>
                    </td>
                  </tr>
                )}
                {showReplanned && replannedRows.map(renderRow)}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {toast && <div className="oa-toast">{toast}</div>}

      <Modal
        open={!!sendTarget}
        onClose={() => { if (!sending) { setSendTarget(null); setSendError(''); } }}
        title="Send overage email"
        description={sendTarget ? `This emails the customer immediately through ChargeOver ${sendTarget.tenant === 'AL' ? 'Answering Legal' : 'Ring Savvy'}.` : ''}
        footer={sendTarget && (
          <>
            <Button variant="ghost" onClick={() => { setSendTarget(null); setSendError(''); }} disabled={sending}>Cancel</Button>
            <Button
              onClick={() => doSend(sendTarget, sendCooldownActive(outreach, sendTarget))}
              loading={sending}
              disabled={sending}
            >
              {sendCooldownActive(outreach, sendTarget) ? 'Send anyway' : 'Send email'}
            </Button>
          </>
        )}
      >
        {sendTarget && (
          <div className="oa-confirm">
            <dl className="oa-confirm-list">
              <div><dt>Customer</dt><dd>{sendTarget.company || `CO #${sendTarget.customerId}`}</dd></div>
              <div><dt>Goes to</dt><dd className="oa-mono">{sendTarget.email || <span className="oa-muted">no email on the ChargeOver record</span>}</dd></div>
              <div><dt>Sent from</dt><dd>ChargeOver {sendTarget.tenant === 'AL' ? 'Answering Legal' : 'Ring Savvy'}</dd></div>
              <div><dt>Template</dt><dd className="oa-mono">#{outreach.config?.[sendTarget.tenant]?.messageId ?? '—'}</dd></div>
              <div><dt>Plan</dt><dd>{sendTarget.planMinutes ? `${fmtNum(sendTarget.planMinutes)} min` : 'not set'}{sendTarget.monthlyCost != null ? ` · ${fmtMoney(sendTarget.monthlyCost)}/mo` : ''}</dd></div>
              <div><dt>Overage streak</dt><dd>{sendTarget.currentStreak} consecutive months, peak {fmtPct(sendTarget.peakPctOverPlan)} over plan</dd></div>
              {outreach.monday?.configured && (
                <div><dt>Recorded on</dt><dd>the Overage Outreach board in Monday</dd></div>
              )}
            </dl>
            {sendCooldownActive(outreach, sendTarget) && (
              <div className="oa-warn">
                This customer was emailed {daysSince(outreach.log[sendTarget.key].sentAt)} days ago, inside the
                {' '}{outreach.cooldownDays}-day window. Sending again will email them a second time.
              </div>
            )}
            {subChangedRecently(sendTarget) != null && (
              <div className="oa-warn">
                This subscription was changed {subChangedRecently(sendTarget)} days ago
                ({fmtDate(sendTarget.subChangedAt)}). If they were just moved to a bigger plan,
                the overages above may predate it — worth checking before telling them they keep
                going over. ChargeOver records any subscription edit here, not only plan changes.
              </div>
            )}
            {!sendTarget.email && (
              <div className="oa-warn">
                No email address on the ChargeOver record — ChargeOver will decide where this goes, and it may not reach anyone.
              </div>
            )}
            {sendError && <div className="oa-error">{sendError}</div>}
          </div>
        )}
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="ChargeOver email templates"
        description="Each tenant sends its own canned email, so Answering Legal and Ring Savvy keep their own branding and sending address."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button onClick={saveConfig}>Save</Button>
          </>
        }
      >
        <div className="oa-settings">
          <p className="oa-settings-help">
            Create the email template in each ChargeOver account, then paste its id here. The id is the
            number in the URL while you’re editing the template
            (<code>…/admin/…/message/<strong>1234</strong></code>). ChargeOver doesn’t expose templates
            over its API, so these can’t be listed for you.
          </p>
          <Input
            label="Answering Legal template id" mono inputMode="numeric"
            placeholder="e.g. 1234" value={draftCfg.AL}
            onChange={e => setDraftCfg(c => ({ ...c, AL: e.target.value.replace(/[^0-9]/g, '') }))}
          />
          <Input
            label="Ring Savvy template id" mono inputMode="numeric"
            placeholder="e.g. 5678" value={draftCfg.RS}
            onChange={e => setDraftCfg(c => ({ ...c, RS: e.target.value.replace(/[^0-9]/g, '') }))}
          />
          <div className="oa-warn">
            Leave a field blank to disable sending for that tenant. Sending is refused without a
            template id — ChargeOver would otherwise fall back to its default welcome email.
          </div>
          {outreach.monday?.error && (
            <div className="oa-warn">
              Monday is unreachable right now ({outreach.monday.error}). Last-sent dates are falling
              back to this server's own log, so a reach-out logged elsewhere may not be showing.
            </div>
          )}
          {sendError && <div className="oa-error">{sendError}</div>}
        </div>
      </Modal>

      <div className="oa-legend">
        <span className="oa-muted">% over plan:</span>
        <span className="oa-cell" data-tone="sev1" /> under 50%
        <span className="oa-cell" data-tone="sev2" /> 50–99%
        <span className="oa-cell" data-tone="sev3" /> 100–199%
        <span className="oa-cell" data-tone="sev4" /> 200%+
        <span className="oa-cell" data-tone="none" /> no overage
      </div>
    </div>
  );
}

// True when this customer was emailed inside the re-send window — drives both
// the disabled button and the "Send anyway" wording in the dialog.
function sendCooldownActive(outreach, row) {
  if (!row) return false;
  const entry = outreach.log?.[row.key];
  if (!entry?.sentAt) return false;
  const d = daysSince(entry.sentAt);
  return d != null && d < (outreach.cooldownDays ?? 30);
}

function OutreachCell({ row, entry, cooldownDays, ready, onSend }) {
  const sentAt = entry?.sentAt;
  const days = sentAt ? daysSince(sentAt) : null;
  const cooling = days != null && days < (cooldownDays ?? 30);

  if (!ready) {
    return <span className="oa-muted oa-outreach-note" title={`No ChargeOver template configured for ${row.tenant}`}>not set up</span>;
  }
  return (
    <div className="oa-outreach">
      <Button
        size="sm"
        variant={cooling ? 'ghost' : 'secondary'}
        onClick={onSend}
        title={cooling ? `Emailed ${days} days ago — inside the ${cooldownDays}-day window` : 'Email this customer via ChargeOver'}
      >
        {sentAt ? 'Email again' : 'Email'}
      </Button>
      <span className="oa-outreach-note">
        {sentAt
          ? <>Sent {fmtDate(sentAt)}{cooling && <span className="oa-cooldown"> · {cooldownDays - days}d left</span>}</>
          : <span className="oa-muted">never emailed</span>}
      </span>
    </div>
  );
}

// Six minutes is a long stare at a progress bar. A glove working a desk phone
// like a speed bag — for the billing manager, who used to fight. Decorative
// only: hidden from screen readers, and it holds still for anyone who has asked
// the OS to reduce motion.
function LoadingBout() {
  return (
    <div className="oa-bout" role="img" aria-label="Loading">
      <span className="oa-bout__glove" aria-hidden="true">🥊</span>
      <span className="oa-bout__phone" aria-hidden="true">☎️</span>
    </div>
  );
}

function PageHead({ actions, meta }) {
  return (
    <header className="oa-page-head">
      <div>
        <div className="oa-eyebrow">Billing</div>
        <h1 className="oa-title">Overage Alerter</h1>
        <p className="oa-sub">
          {meta || 'Customers billed for minute overages over their last three billing cycles, measured against their plan.'}
        </p>
      </div>
      {actions}
    </header>
  );
}

function Tile({ label, value, hint }) {
  return (
    <div className="oa-tile">
      <div className="oa-tile-label">
        <Hint text={hint}>{label}</Hint>
      </div>
      <div className="oa-tile-value">{value}</div>
    </div>
  );
}

// A plain-English explanation on hover, and on keyboard focus so it isn't
// mouse-only. Every number in this module is a derived figure someone has to
// trust before acting on it, so none of them should need explaining twice.
function Hint({ text, children }) {
  if (!text) return children;
  return (
    <span className="oa-hint" data-hint={text} tabIndex={0} role="note" aria-label={`${children} — ${text}`}>
      {children}
    </span>
  );
}
