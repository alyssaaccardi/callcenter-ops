import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import api from '../api';
import { Button, Card, Input, Select, Badge, Checkbox, EmptyState } from '../components/ui';
import './OverageAlerter.css';

/* ─── helpers ─────────────────────────────────────────────────────── */

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
  const [progress, setProgress] = useState({ phase: '', prefetch: {}, invoiceCount: 0, total: 0 });
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

  const loadResults = useCallback(async (jobId) => {
    const resp = await api.get(`/api/overage-alerter/results/${jobId}`);
    if (resp.data?.status === 'error') { setError(resp.data.error || 'Job failed'); return false; }
    setData(resp.data);
    return true;
  }, []);

  // The stream can be cut short by Cloudflare around the 100s mark and this
  // job routinely runs longer than that, so a severed stream falls back to
  // polling rather than being treated as a failure.
  const pollUntilComplete = useCallback(async (jobId) => {
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000) {
      try {
        const resp = await api.get(`/api/overage-alerter/results/${jobId}`);
        const { status, phase, prefetch, invoiceCount, total } = resp.data || {};
        setProgress({ phase, prefetch: prefetch || {}, invoiceCount: invoiceCount || 0, total: total || 0 });
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
    setProgress({ phase: 'starting', prefetch: {}, invoiceCount: 0, total: 0 });
    setView('running');
    try {
      const resp = await api.post('/api/overage-alerter/run');
      const { jobId } = resp.data;
      await startStream(jobId);
      const ok = await loadResults(jobId);
      setView(ok ? 'results' : 'idle');
    } catch (e) {
      setError('Run failed: ' + (e.response?.data?.error || e.message));
      setView('idle');
    }
  };

  /* ── derived ───────────────────────────────────────────────────── */

  const latestMonth = data?.latestMonth || null;

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
    });
  }, [data, tenant, minStreak, ongoingOnly, minPct, minTotal, search, latestMonth]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      }
      return ((av ?? 0) - (bv ?? 0)) * dir;
    });
  }, [rows, sort]);

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
              description="Pulls every overage invoice from both ChargeOver tenants over the last 13 months, files each one under the cycle it bills, and measures the overage against each customer's plan. Takes a few minutes — it reads every customer, subscription and overage invoice in AL and RS."
              actions={<Button onClick={handleRun}>Run the audit</Button>}
            />
          </Card>
        ) : (
          <Card pad className="oa-launch">
            <div className="oa-running">
              <div className="oa-running-spinner" aria-hidden="true" />
              <div className="oa-running-phase">{progress.phase || 'starting'}…</div>
              <div className="oa-running-detail">
                {prefetchLines.length === 0
                  ? <span className="oa-muted">Connecting to ChargeOver…</span>
                  : prefetchLines.map(([label, n]) => (
                      <div key={label} className="oa-running-line">
                        <span>{label}</span><span className="oa-mono">{fmtNum(n)}</span>
                      </div>
                    ))}
              </div>
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="oa-root">
      <PageHead
        actions={<Button variant="secondary" onClick={handleRun}>Re-run</Button>}
        meta={data ? `${fmtNum(data.invoiceCount)} overage invoices · ${fmtNum(data.results?.length)} customers · through ${fmtMonth(latestMonth)}` : null}
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
              id="oa-streak" type="range" min="1" max="12" step="1"
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
            label="Min overage billed (window)"
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
        <Tile label="Customers flagged" value={fmtNum(summary.count)} />
        <Tile label={`Overage billed in ${fmtMonth(latestMonth)}`} value={fmtMoney(summary.latestAmount)} />
        <Tile label="Overage billed in window" value={fmtMoney(summary.totalAmount)} />
        <Tile label="Avg peak over plan" value={fmtPct(summary.avgPeak)} />
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
                  <th>Customer</th>
                  <th className="oa-num">Plan</th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('currentStreak')}>Streak{sortArrow('currentStreak')}</th>
                  <th className="oa-months-th">Overage by usage month — % over plan</th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('peakPctOverPlan')}>Peak{sortArrow('peakPctOverPlan')}</th>
                  <th className="oa-num oa-sortable" onClick={() => setSortKey('totalAmount')}>Billed{sortArrow('totalAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => {
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
                            <span className="oa-cust-name">{r.company || `CO #${r.customerId}`}</span>
                            {r.subStatus && !String(r.subStatus).startsWith('active') && (
                              <Badge tone="neutral" size="sm">{r.subStatus}</Badge>
                            )}
                          </div>
                          <div className="oa-cust-sub">{r.email || `CO #${r.customerId}`}</div>
                        </td>
                        <td className="oa-num oa-mono">
                          {r.planMinutes ? `${fmtNum(r.planMinutes)} min` : <span className="oa-muted">no plan</span>}
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
                        <td className="oa-num oa-mono">{fmtPct(r.peakPctOverPlan)}</td>
                        <td className="oa-num oa-mono">{fmtMoney(r.totalAmount)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="oa-detail-row">
                          <td colSpan={7}>
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
                                Plan size is the customer’s current ChargeOver subscription ({r.planMinutes ? `${fmtNum(r.planMinutes)} min` : 'not set'}).
                                Each invoice bills the previous cycle, so it’s filed under the month the minutes were used.
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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

function PageHead({ actions, meta }) {
  return (
    <header className="oa-page-head">
      <div>
        <div className="oa-eyebrow">Billing</div>
        <h1 className="oa-title">Overage Alerter</h1>
        <p className="oa-sub">
          {meta || 'Customers billed for minute overages in consecutive months, measured against their plan.'}
        </p>
      </div>
      {actions}
    </header>
  );
}

function Tile({ label, value }) {
  return (
    <div className="oa-tile">
      <div className="oa-tile-label">{label}</div>
      <div className="oa-tile-value">{value}</div>
    </div>
  );
}
