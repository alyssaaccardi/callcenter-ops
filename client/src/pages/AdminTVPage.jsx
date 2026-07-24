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
      <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(240,244,255,0.55)', letterSpacing: 0.8, textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{label}</span>
        {href && <span style={{ color: 'rgba(240,244,255,0.35)', fontSize: 12 }}>↗</span>}
      </div>
      <div>
        <div style={{ fontSize: 44, fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {sub && <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(240,244,255,0.6)' }}>{sub}</div>}
      </div>
    </>
  );
  const style = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: '18px 22px',
    minHeight: 128,
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
      borderRadius: 14,
      padding: 18,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(240,244,255,0.7)', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</div>
        {right}
      </div>
      {children}
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

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(1200px 800px at 20% 0%, #0e1828 0%, #070d18 60%, #05080f 100%)',
      color: '#f0f4ff',
      fontFamily: 'Barlow Condensed, sans-serif',
      padding: 24,
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 0.5 }}>Admin Dashboard</div>
          <div style={{ fontSize: 14, color: 'rgba(240,244,255,0.55)' }}>{nowDate()}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
          {[
            { label: 'EST', time: clocks.est },
            { label: 'BZ',  time: clocks.bz  },
            { label: 'JM',  time: clocks.jm  },
          ].map(c => (
            <div key={c.label} style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: 'rgba(240,244,255,0.5)', fontWeight: 600, marginBottom: 2 }}>{c.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{c.time}</div>
            </div>
          ))}
        </div>
      </div>

      {/* System-status strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatusPill label="Mitel Classic" state={status?.mitelClassic?.state} />
        <StatusPill label="Mobile App"    state={status?.mobileApp?.state} />
        <StatusPill label="Integrations"  state={status?.integrations?.state} />
        <StatusPill label="DIDs"          state={status?.didStatus} />
      </div>

      {/* KPI row — 6 tiles, each clickable to its source */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 14, marginBottom: 18 }}>
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
          label="CSAT · This Month"
          value={csat.pct != null ? `${csat.pct}%` : '—'}
          sub={`${csat.good ?? 0} good · ${csat.bad ?? 0} bad`}
          warn={csat.pct != null && csat.pct < 95 && csat.pct >= 85}
          danger={csat.pct != null && csat.pct < 85}
          valueColor={csat.pct != null && csat.pct >= 95 ? '#4ade80' : undefined}
          href="https://answeringlegalhelp.zendesk.com/agent/reporting"
        />
        <KpiTile
          label="SLA Breaches · This Month"
          value={sla.totalBreaches ?? 0}
          sub={(sla.totalBreaches || 0) === 0 ? 'clean' : 'needs attention'}
          danger={(sla.totalBreaches || 0) > 0}
          valueColor={(sla.totalBreaches || 0) === 0 ? '#4ade80' : undefined}
          href="https://answeringlegalhelp.zendesk.com/agent/search/1?type=ticket&q=type%3Aticket%20sla_breach%3Atrue"
        />
        <KpiTile
          label="Overdue Support Tasks"
          value={overdueTasks.length}
          sub={`${upcomingTasks.length} due today`}
          danger={overdueTasks.length > 0}
          valueColor={overdueTasks.length === 0 ? '#4ade80' : undefined}
          href="https://answeringlegal-unit.monday.com/boards/18358060875"
        />
      </div>

      {/* Middle row — Mitel queues + DIDs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)', gap: 14, marginBottom: 18 }}>
        <Panel title="Mitel Queues · Avg Ring Time (Last 24 h)">
          {mitelQueues?.offline || mitelQueues?.unconfigured ? (
            <div style={{ color: '#f87171', fontSize: 14 }}>Poller offline — no queue data</div>
          ) : !hasHourly ? (
            <div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14, fontStyle: 'italic' }}>Waiting for poller data…</div>
          ) : (
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'rgba(240,244,255,0.5)', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 8px' }}>Hour</th>
                    {mitelQ.map(q => (
                      <th key={q.id} style={{ padding: '6px 8px', textAlign: 'right' }}>{q.name || q.id}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((bucket, i) => (
                    <tr key={bucket} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '5px 8px', color: 'rgba(240,244,255,0.65)', whiteSpace: 'nowrap' }}>{fmtHourEst(bucket)}</td>
                      {mitelQ.map(q => {
                        const cell = q.hourly?.[i];
                        return (
                          <td key={q.id} style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {cell?.avgWait != null
                              ? <><span style={{ fontWeight: 700 }}>{fmtWait(cell.avgWait)}</span>
                                  <span style={{ color: 'rgba(240,244,255,0.4)', marginLeft: 6, fontSize: 11 }}>({cell.answered})</span></>
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

        <Panel title="Available DIDs">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {[
              { label: 'Mitel Active', val: didCounts?.mitel },
              { label: 'DID Pool',     val: hubspotDids?.didPool },
              { label: 'Instant',      val: hubspotDids?.instantDidPool },
            ].map(c => (
              <div key={c.label} style={{ padding: '12px 10px', borderRadius: 10, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
                <div style={{ fontSize: 10, color: 'rgba(240,244,255,0.55)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{c.label}</div>
                <div style={{ fontSize: 30, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#a855f7', lineHeight: 1.1 }}>{c.val ?? '—'}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* Bottom row — outstanding accounts + overdue tasks */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gap: 14 }}>
        <Panel title="Top Outstanding Accounts">
          {allOutstanding.length === 0 ? (
            <div style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14, fontStyle: 'italic' }}>None outstanding</div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '3fr 0.6fr 0.6fr 1fr', columnGap: 8, padding: '6px 8px', color: 'rgba(240,244,255,0.5)', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                <div>Company</div>
                <div>Tenant</div>
                <div style={{ textAlign: 'right' }}>Days</div>
                <div style={{ textAlign: 'right' }}>Overdue</div>
              </div>
              {allOutstanding.slice(0, 8).map(c => (
                <a
                  key={`${c.tenant}-${c.customerId}`}
                  href={c.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="tv-clickable"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '3fr 0.6fr 0.6fr 1fr',
                    columnGap: 8,
                    padding: '7px 8px',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    fontSize: 14,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.company || `#${c.customerId}`}</div>
                  <div>
                    <span style={{
                      fontSize: 11, padding: '1px 8px', borderRadius: 4,
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

        <Panel title={`Overdue Support Tasks (${overdueTasks.length})`}>
          {overdueTasks.length === 0 && upcomingTasks.length === 0 && (
            <div style={{ color: '#4ade80', fontSize: 14, fontStyle: 'italic' }}>All clear — no overdue or upcoming tasks</div>
          )}
          {overdueTasks.slice(0, 6).map(t => (
            <a
              key={t.id}
              href={t.link || '#'}
              target="_blank"
              rel="noreferrer"
              className="tv-clickable"
              style={{ display: 'block', padding: '7px 4px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 13, textDecoration: 'none', color: 'inherit' }}
            >
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
              <div style={{ fontSize: 11, color: 'rgba(240,244,255,0.55)' }}>
                {t.accountName && <>{t.accountName} · </>}
                {t.worker || 'unassigned'}
              </div>
            </a>
          ))}
          {overdueTasks.length === 0 && upcomingTasks.length > 0 && (
            <>
              <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(240,244,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.6 }}>Due today</div>
              {upcomingTasks.slice(0, 6).map(t => (
                <a
                  key={t.id}
                  href={t.link || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="tv-clickable"
                  style={{ display: 'block', padding: '7px 4px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 13, textDecoration: 'none', color: 'inherit' }}
                >
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: 'rgba(240,244,255,0.55)' }}>
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
  );
}
