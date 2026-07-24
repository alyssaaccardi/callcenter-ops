import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// Purpose-built TV variant of the Admin Dashboard, sized for a
// close-viewing monitor at the COO's desk (not a wall-mounted TV).
// Fully token-authed (no session cookie required) so it can run in a
// signed-out browser tab. Auto-refreshes all data.

const CHARGEOVER_POLL_MS = 60_000;
const MITEL_POLL_MS      = 10_000;
const TASKS_POLL_MS      = 30_000;
const QUALITY_POLL_MS    = 120_000;
const AGENTS_POLL_MS     = 60_000;
const STATUS_POLL_MS     = 15_000;
const DIDS_POLL_MS       = 30_000;
const TRAINEES_POLL_MS   = 60_000;
const INTERVIEWS_POLL_MS = 120_000;
const CLOCK_MS           = 1000;

function withToken(url, token) {
  return url + (url.includes('?') ? '&' : '?') + `t=${encodeURIComponent(token)}`;
}

function usd(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtWait(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function clockAt(tz) {
  return new Date().toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

function nowDate() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
}

function fmtHourEst(iso) {
  const d = new Date(iso);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const dayStr   = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hour = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: 'America/New_York' });
  if (dayStr === todayStr) return hour;
  const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  return `${short} · ${hour}`;
}

function StatusPill({ label, state }) {
  const isUp = state !== 'DOWN';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '6px 14px', borderRadius: 999,
      background: isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.18)',
      border: `1px solid ${isUp ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.5)'}`,
      fontSize: 15, fontWeight: 600,
      color: isUp ? '#4ade80' : '#f87171',
    }}>
      <span style={{
        width: 9, height: 9, borderRadius: '50%',
        background: isUp ? '#22c55e' : '#ef4444',
        boxShadow: `0 0 8px ${isUp ? '#22c55e' : '#ef4444'}`,
      }} />
      {label}
    </div>
  );
}

function KpiTile({ label, value, sub, valueColor, danger, warn, href }) {
  const color = danger ? '#f87171' : warn ? '#fbbf24' : (valueColor || '#f0f4ff');
  const inner = (
    <>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(240,244,255,0.55)', letterSpacing: 0.7, textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{label}</span>
        {href && <span style={{ color: 'rgba(240,244,255,0.35)', fontSize: 11 }}>↗</span>}
      </div>
      <div>
        <div style={{ fontSize: 34, fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {sub && <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(240,244,255,0.6)' }}>{sub}</div>}
      </div>
    </>
  );
  const style = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: '14px 16px',
    minHeight: 102,
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    textDecoration: 'none', color: 'inherit',
    transition: 'background 0.12s, border-color 0.12s',
  };
  if (href) return (
    <a href={href} target="_blank" rel="noreferrer" className="tv-clickable" style={style}>{inner}</a>
  );
  return <div style={style}>{inner}</div>;
}

function Panel({ title, children, right }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12,
      padding: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(240,244,255,0.7)', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function DidChip({ label, val }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 999,
      background: 'rgba(124,58,237,0.12)',
      border: '1px solid rgba(124,58,237,0.35)',
      fontSize: 13, fontWeight: 600, color: '#c4b5fd',
    }}>
      <span style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)', fontWeight: 500, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{val ?? '—'}</span>
    </div>
  );
}

export default function AdminTVPage() {
  const token = new URLSearchParams(window.location.search).get('t') || '';
  const [tokenValid, setTokenValid] = useState(null); // null=unknown, true=ok, false=invalid

  const [clocks, setClocks] = useState({
    est: clockAt('America/New_York'),
    bz:  clockAt('America/Belize'),
    jm:  clockAt('America/Jamaica'),
  });
  const [status, setStatus]           = useState(null);
  const [didCounts, setDidCounts]     = useState(null);
  const [hubspotDids, setHubspotDids] = useState(null);
  const [outstanding, setOutstanding] = useState(null);
  const [mitelQueues, setMitelQueues] = useState(null);
  const [supportTasks, setSupportTasks] = useState(null);
  const [quality, setQuality]         = useState(null);
  const [agentCounts, setAgentCounts] = useState(null);
  const [trainees, setTrainees]       = useState(null);
  const [interviews, setInterviews]   = useState(null);
  const [interviewsError, setInterviewsError] = useState(null);

  // Validate token once so we can show a proper error if the URL is stale.
  useEffect(() => {
    if (!token) { setTokenValid(false); return; }
    axios.get(`/api/tv-session/validate?t=${encodeURIComponent(token)}`)
      .then(() => setTokenValid(true))
      .catch(() => setTokenValid(false));
  }, [token]);

  const get = useCallback((url) => axios.get(withToken(url, token)), [token]);

  // Poll: everything auto-refreshes on its own cadence.
  useEffect(() => {
    const tick = () => setClocks({
      est: clockAt('America/New_York'),
      bz:  clockAt('America/Belize'),
      jm:  clockAt('America/Jamaica'),
    });
    const id = setInterval(tick, CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/status').then(r => setStatus(r.data)).catch(() => {});
    run(); const id = setInterval(run, STATUS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/bandwidth/dids').then(r => setDidCounts(r.data)).catch(() => {});
    run(); const id = setInterval(run, DIDS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/hubspot/dids').then(r => setHubspotDids(r.data)).catch(() => {});
    run(); const id = setInterval(run, DIDS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/chargeover/outstanding').then(r => setOutstanding(r.data)).catch(() => {});
    run(); const id = setInterval(run, CHARGEOVER_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/mitel/queue-stats').then(r => setMitelQueues(r.data)).catch(() => setMitelQueues({ offline: true }));
    run(); const id = setInterval(run, MITEL_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/monday/support-tasks').then(r => setSupportTasks(r.data)).catch(() => {});
    run(); const id = setInterval(run, TASKS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/zendesk/quality?period=this-month').then(r => setQuality(r.data)).catch(() => {});
    run(); const id = setInterval(run, QUALITY_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/monday/agents').then(r => {
      const agents = (r.data?.agents || []).filter(a => (a.callCenter || '').toLowerCase().includes('mitel'));
      const here    = agents.filter(a => a.status === 'Here').length;
      const standby = agents.filter(a => a.status === 'On Standby').length;
      setAgentCounts({ here, standby, total: here + standby });
    }).catch(() => {});
    run(); const id = setInterval(run, AGENTS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/monday/trainees').then(r => setTrainees(r.data)).catch(() => {});
    run(); const id = setInterval(run, TRAINEES_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);
  useEffect(() => {
    if (!tokenValid) return;
    const run = () => get('/api/interviews?days=14')
      .then(r => { setInterviews(r.data); setInterviewsError(null); })
      .catch(e => setInterviewsError(e.response?.data?.error === 'setup_required'
        ? e.response.data.message
        : (e.response?.data?.error || 'Failed to load interviews')));
    run(); const id = setInterval(run, INTERVIEWS_POLL_MS); return () => clearInterval(id);
  }, [tokenValid, get]);

  if (tokenValid === false) {
    return (
      <div style={{ minHeight: '100vh', background: '#070d18', color: '#f0f4ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Barlow Condensed, sans-serif' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 44, fontWeight: 800, marginBottom: 12 }}>Session Expired</div>
          <div style={{ fontSize: 18, color: 'rgba(240,244,255,0.6)' }}>Reopen the Admin TV Dash from the sidebar to refresh.</div>
        </div>
      </div>
    );
  }

  // Derived summary numbers
  const totalOverdue = (outstanding?.AL?.totalOverdue || 0) + (outstanding?.RS?.totalOverdue || 0);
  const totalOverdueCount = (outstanding?.AL?.count || 0) + (outstanding?.RS?.count || 0);

  const overdueTasks  = supportTasks?.overdue  || [];
  const upcomingTasks = supportTasks?.upcoming || [];

  const csat = quality?.csat || {};
  const sla  = quality?.sla  || {};

  // Combine + rank top-outstanding across both tenants for a single unified table
  const allOutstanding = [
    ...(outstanding?.AL?.customers || []).map(c => ({ ...c, tenant: 'AL' })),
    ...(outstanding?.RS?.customers || []).map(c => ({ ...c, tenant: 'RS' })),
  ].sort((a, b) => (b.amountOverdue || 0) - (a.amountOverdue || 0));

  const mitelQ = mitelQueues?.queues || [];
  const hasHourly = mitelQ.some(q => Array.isArray(q.hourly) && q.hourly.length > 0);
  const buckets = hasHourly ? mitelQ[0].hourly.map(h => h.bucket) : [];

  // Interviews this month = every event across both calendars whose start
  // date lands in the current EST calendar month.
  const monthKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);
  const interviewsThisMonth = (interviews?.teams || []).reduce((sum, t) => {
    return sum + (t.events || []).filter(ev => {
      const day = (ev.start || '').slice(0, 10);
      return day && day.startsWith(monthKey);
    }).length;
  }, 0);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(1200px 800px at 20% 0%, #0e1828 0%, #070d18 60%, #05080f 100%)',
      color: '#f0f4ff',
      fontFamily: 'Barlow Condensed, sans-serif',
      padding: 18,
      boxSizing: 'border-box',
    }}>
      {/* Header — title/date on left, clocks on right */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 0.5 }}>Admin Dashboard</div>
          <div style={{ fontSize: 13, color: 'rgba(240,244,255,0.55)' }}>{nowDate()}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
          {[
            { label: 'EST', time: clocks.est },
            { label: 'BZ',  time: clocks.bz  },
            { label: 'JM',  time: clocks.jm  },
          ].map(c => (
            <div key={c.label} style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: 'rgba(240,244,255,0.5)', fontWeight: 600, marginBottom: 2 }}>{c.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{c.time}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Combined status + DID chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatusPill label="Mitel Classic" state={status?.mitelClassic?.state} />
        <StatusPill label="Mobile App"    state={status?.mobileApp?.state} />
        <StatusPill label="Integrations"  state={status?.integrations?.state} />
        <StatusPill label="DIDs"          state={status?.didStatus} />
        <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
        <DidChip label="Mitel"   val={didCounts?.mitel} />
        <DidChip label="Pool"    val={hubspotDids?.didPool} />
        <DidChip label="Instant" val={hubspotDids?.instantDidPool} />
      </div>

      {/* KPI row — 7 tiles, each clickable to its source */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
        <KpiTile
          label="AL Outstanding"
          value={usd(outstanding?.AL?.totalOverdue || 0)}
          sub={`${outstanding?.AL?.count || 0} accounts`}
          danger={(outstanding?.AL?.totalOverdue || 0) > 0}
          href="https://answeringlegal.chargeover.com/admin"
        />
        <KpiTile
          label="RS Outstanding"
          value={usd(outstanding?.RS?.totalOverdue || 0)}
          sub={`${outstanding?.RS?.count || 0} accounts`}
          danger={(outstanding?.RS?.totalOverdue || 0) > 0}
          href="https://ringsavvy.chargeover.com/admin"
        />
        <KpiTile
          label="Mitel Agents Logged In"
          value={agentCounts?.total ?? '—'}
          sub={agentCounts ? `${agentCounts.here} here · ${agentCounts.standby} standby` : ''}
          valueColor="#38bdf8"
          href="https://answeringlegal-unit.monday.com/boards/7846367704"
        />
        <KpiTile
          label="Support CSAT · This Month"
          value={csat.pct != null ? `${csat.pct}%` : '—'}
          sub={`${csat.good ?? 0} good · ${csat.bad ?? 0} bad · from Zendesk`}
          warn={csat.pct != null && csat.pct < 95 && csat.pct >= 85}
          danger={csat.pct != null && csat.pct < 85}
          valueColor={csat.pct != null && csat.pct >= 95 ? '#4ade80' : undefined}
          href="https://answeringlegalhelp.zendesk.com/agent/reporting"
        />
        <KpiTile
          label="Overdue Support Tasks"
          value={overdueTasks.length}
          sub={`${upcomingTasks.length} due today`}
          danger={overdueTasks.length > 0}
          valueColor={overdueTasks.length === 0 ? '#4ade80' : undefined}
          href="https://answeringlegal-unit.monday.com/boards/18358060875"
        />
        <KpiTile
          label="Interviews · This Month"
          value={interviews ? interviewsThisMonth : '—'}
          sub={interviews ? '±14d shown below' : ''}
          valueColor="#fbbf24"
        />
        <KpiTile
          label="New Agents · This Month"
          value={trainees?.newHiresThisMonth?.length ?? '—'}
          sub={trainees?.activeTrainees ? `${trainees.activeTrainees.length} in training` : ''}
          valueColor="#a3e635"
          href="https://answeringlegal-unit.monday.com/boards/9606096056"
        />
      </div>

      {/* Ops row — Mitel queues (wide left) + stacked Outstanding & Overdue Tasks (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1.1fr)', gap: 12, marginBottom: 12 }}>
        <Panel title="Mitel Queues · Avg Ring Time (Last 24 h)">
          {mitelQueues?.offline || mitelQueues?.unconfigured ? (
            <div style={{ color: '#f87171', fontSize: 14 }}>Poller offline — no queue data</div>
          ) : !hasHourly ? (
            <div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14, fontStyle: 'italic' }}>Waiting for poller data…</div>
          ) : (
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'rgba(14,24,40,0.95)', backdropFilter: 'blur(4px)' }}>
                  <tr style={{ textAlign: 'left', color: 'rgba(240,244,255,0.5)', fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                    <th style={{ padding: '5px 8px' }}>Hour</th>
                    {mitelQ.map(q => (
                      <th key={q.id} style={{ padding: '5px 8px', textAlign: 'right' }}>{q.name || q.id}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((bucket, i) => (
                    <tr key={bucket} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '4px 8px', color: 'rgba(240,244,255,0.65)', whiteSpace: 'nowrap' }}>{fmtHourEst(bucket)}</td>
                      {mitelQ.map(q => {
                        const cell = q.hourly?.[i];
                        return (
                          <td key={q.id} style={{ padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {cell?.avgWait != null
                              ? <><span style={{ fontWeight: 700 }}>{fmtWait(cell.avgWait)}</span>
                                  <span style={{ color: 'rgba(240,244,255,0.4)', marginLeft: 4, fontSize: 10 }}>({cell.answered})</span></>
                              : <span style={{ color: 'rgba(240,244,255,0.3)' }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Panel title="Top Outstanding Accounts">
            {allOutstanding.length === 0 ? (
              <div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14, fontStyle: 'italic' }}>None outstanding</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '3fr 0.5fr 0.5fr 1fr', columnGap: 6, padding: '4px 8px', color: 'rgba(240,244,255,0.5)', fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                  <div>Company</div>
                  <div>Tenant</div>
                  <div style={{ textAlign: 'right' }}>Days</div>
                  <div style={{ textAlign: 'right' }}>$</div>
                </div>
                {allOutstanding.slice(0, 6).map(c => (
                  <a
                    key={`${c.tenant}-${c.customerId}`}
                    href={c.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="tv-clickable"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '3fr 0.5fr 0.5fr 1fr',
                      columnGap: 6,
                      padding: '5px 8px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      fontSize: 13,
                      textDecoration: 'none',
                      color: 'inherit',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.company || `#${c.customerId}`}</div>
                    <div>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 4,
                        background: c.tenant === 'AL' ? 'rgba(26,111,232,0.2)' : 'rgba(0,201,177,0.2)',
                        color: c.tenant === 'AL' ? '#60a5fa' : '#5eead4',
                      }}>{c.tenant}</span>
                    </div>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.daysOverdue}</div>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#f87171', fontWeight: 700 }}>{usd(c.amountOverdue)}</div>
                  </a>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Support Tasks"
            right={<span style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)' }}>{overdueTasks.length} overdue · {upcomingTasks.length} due today</span>}
          >
            {overdueTasks.length === 0 && upcomingTasks.length === 0 && (
              <div style={{ color: '#4ade80', fontSize: 13, fontStyle: 'italic', padding: '4px 0' }}>All clear — nothing overdue and nothing due today</div>
            )}

            {overdueTasks.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171' }} />
                  <div style={{ fontSize: 10, color: '#f87171', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>
                    Overdue ({overdueTasks.length})
                  </div>
                </div>
                {overdueTasks.slice(0, 4).map(t => (
                  <a
                    key={t.id}
                    href={t.link || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="tv-clickable"
                    style={{ display: 'block', padding: '5px 6px', borderTop: '1px solid rgba(248,113,113,0.15)', fontSize: 12, textDecoration: 'none', color: 'inherit' }}
                  >
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                    <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)' }}>
                      {t.accountName && <>{t.accountName} · </>}
                      {t.worker || 'unassigned'}
                    </div>
                  </a>
                ))}
              </>
            )}

            {upcomingTasks.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: overdueTasks.length > 0 ? 10 : 0, marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24' }} />
                  <div style={{ fontSize: 10, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>
                    Due Today ({upcomingTasks.length})
                  </div>
                </div>
                {upcomingTasks.slice(0, 4).map(t => (
                  <a
                    key={t.id}
                    href={t.link || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="tv-clickable"
                    style={{ display: 'block', padding: '5px 6px', borderTop: '1px solid rgba(251,191,36,0.15)', fontSize: 12, textDecoration: 'none', color: 'inherit' }}
                  >
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                    <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)' }}>
                      {t.accountName && <>{t.accountName} · </>}
                      {t.worker || 'unassigned'}
                    </div>
                  </a>
                ))}
              </>
            )}
          </Panel>
        </div>
      </div>

      {/* Workforce row — Trainees + US Interviews + Belize Interviews */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <TraineesPanel trainees={trainees} />
        <InterviewsTeamPanel interviews={interviews} error={interviewsError} teamKey="US"     label="US Team" color="#60a5fa" />
        <InterviewsTeamPanel interviews={interviews} error={interviewsError} teamKey="BELIZE" label="Team Belize" color="#5eead4" />
      </div>
    </div>
  );
}

function fmtCandidateName(c) {
  if (c.displayName && c.displayName.trim()) return c.displayName;
  if (!c.email) return '';
  const local = c.email.split('@')[0];
  // "jane.doe" or "jane_doe" → "Jane Doe"
  return local.split(/[._-]+/).filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function candidateLine(ev) {
  const names = (ev.candidates || []).map(fmtCandidateName).filter(Boolean);
  if (names.length === 0) return null;
  return names.join(', ');
}

function fmtInterviewTime(iso, isAllDay) {
  if (!iso) return '—';
  if (isAllDay) {
    // "YYYY-MM-DD" — parse as local
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' }) + ' (all day)';
  }
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York',
  }) + ' EST';
}

function InterviewsTeamPanel({ interviews, error, teamKey, label, color }) {
  if (error) return <Panel title={`${label} · Interviews`}><div style={{ color: '#fbbf24', fontSize: 12 }}>{error}</div></Panel>;
  if (!interviews) return <Panel title={`${label} · Interviews`}><div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 13 }}>Loading…</div></Panel>;
  const team = (interviews.teams || []).find(t => t.team === teamKey);
  if (!team) return <Panel title={`${label} · Interviews`}><div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 13, fontStyle: 'italic' }}>No calendar data</div></Panel>;

  const now = Date.now();
  const upcoming = (team.events || []).filter(e => new Date(e.start).getTime() >= now).slice(0, 5);
  const past     = (team.events || []).filter(e => new Date(e.start).getTime() <  now).slice(-3).reverse();

  const Row = ({ ev, muted }) => {
    const names = candidateLine(ev);
    return (
      <a
        href={ev.htmlLink || ev.hangout || '#'}
        target="_blank"
        rel="noreferrer"
        className="tv-clickable"
        style={{ display: 'block', padding: '5px 6px', borderTop: '1px solid rgba(255,255,255,0.06)', textDecoration: 'none', color: 'inherit', opacity: muted ? 0.72 : 1 }}
      >
        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{names || ev.title}</div>
        <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)' }}>{fmtInterviewTime(ev.start, ev.isAllDay)}</div>
        {names && <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.35)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.title}</div>}
        {!names && ev.description && <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.description}</div>}
      </a>
    );
  };

  return (
    <Panel
      title={
        <span>
          <span style={{ color }}>{label}</span>
          <span style={{ color: 'rgba(240,244,255,0.5)', marginLeft: 8 }}>· Interviews</span>
        </span>
      }
      right={<span style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)' }}>{upcoming.length} up · {past.length} recent</span>}
    >
      {team.error && <div style={{ fontSize: 11, color: '#f87171', fontStyle: 'italic', marginBottom: 4 }}>calendar error: {team.error}</div>}
      <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)', letterSpacing: 0.6, marginBottom: 2, textTransform: 'uppercase' }}>Upcoming</div>
      {upcoming.length === 0 && <div style={{ fontSize: 12, color: 'rgba(240,244,255,0.5)', fontStyle: 'italic' }}>None scheduled</div>}
      {upcoming.map(ev => <Row key={ev.id} ev={ev} />)}
      {past.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)', letterSpacing: 0.6, marginTop: 8, marginBottom: 2, textTransform: 'uppercase' }}>Recent</div>
          {past.map(ev => <Row key={ev.id} ev={ev} muted />)}
        </>
      )}
    </Panel>
  );
}

function fmtDayShort(iso) {
  if (!iso) return '—';
  // "YYYY-MM-DD" — construct a local date so timezone parsing doesn't shift it
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt - today) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function TraineesPanel({ trainees }) {
  if (!trainees) return <Panel title="Trainees"><div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 13 }}>Loading…</div></Panel>;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const cutoff = (() => {
    const d = new Date(); d.setDate(d.getDate() - 14);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  const rows = (trainees.activeTrainees || [])
    .map(t => {
      const dates = [t.day1Date, t.day2Date].filter(Boolean);
      if (dates.length === 0) return null;
      const upcoming = dates.filter(d => d >= today).sort();
      const nextDate = upcoming.length ? upcoming[0] : dates.sort()[dates.length - 1];
      return { ...t, nextDate };
    })
    .filter(t => t && t.nextDate && t.nextDate >= cutoff)
    .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''))
    .slice(0, 8);
  const newHires = (trainees.newHiresThisMonth || [])
    .slice()
    .sort((a, b) => (b.independentStartDate || b.day2Date || '').localeCompare(a.independentStartDate || a.day2Date || ''));

  return (
    <Panel
      title={<span style={{ color: '#a3e635' }}>Trainees</span>}
      right={<span style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)' }}>{rows.length} upcoming · {newHires.length} new agents this month</span>}
    >
      {rows.length === 0 && newHires.length === 0 && (
        <div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 13, fontStyle: 'italic' }}>No trainees or new hires in the current window</div>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)', letterSpacing: 0.6, marginBottom: 2, textTransform: 'uppercase' }}>Upcoming</div>
          {rows.map(t => (
            <a
              key={t.id}
              href={t.link}
              target="_blank"
              rel="noreferrer"
              className="tv-clickable"
              style={{ display: 'block', padding: '5px 6px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, textDecoration: 'none', color: 'inherit' }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{t.name}</span>
                {t.team && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(163,230,53,0.15)', color: '#a3e635', fontWeight: 600 }}>{t.team}</span>}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)' }}>
                {t.status}
                {t.day1Date && <span style={{ marginLeft: 6 }}>D1 {fmtDayShort(t.day1Date)}</span>}
                {t.day2Date && <span style={{ marginLeft: 6 }}>D2 {fmtDayShort(t.day2Date)}</span>}
              </div>
            </a>
          ))}
        </>
      )}

      {newHires.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.5)', letterSpacing: 0.6, marginTop: 8, marginBottom: 2, textTransform: 'uppercase' }}>
            New Agents · {trainees.monthKey || ''}
          </div>
          {newHires.map(t => (
            <a
              key={t.id}
              href={t.link}
              target="_blank"
              rel="noreferrer"
              className="tv-clickable"
              style={{ display: 'block', padding: '5px 6px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 12, textDecoration: 'none', color: 'inherit', opacity: 0.85 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                <span style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)', whiteSpace: 'nowrap' }}>
                  {t.independentStartDate ? `Start ${fmtDayShort(t.independentStartDate)}` : (t.day2Date ? `D2 ${fmtDayShort(t.day2Date)}` : '')}
                </span>
              </div>
            </a>
          ))}
        </>
      )}
    </Panel>
  );
}
