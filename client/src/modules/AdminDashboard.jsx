import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';

const CHARGEOVER_POLL_MS = 60_000;
const MITEL_POLL_MS      = 10_000;
const TASKS_POLL_MS      = 30_000;
const QUALITY_POLL_MS    = 120_000;
const AGENTS_POLL_MS     = 60_000;
const TRAINEES_POLL_MS   = 60_000;

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

function fmtHourEst(iso) {
  const d = new Date(iso);
  const today = todayEstDay();
  const dayStr = estDayOf(iso);
  const hourStr = d.toLocaleTimeString('en-US', {
    hour: 'numeric', hour12: true, timeZone: 'America/New_York',
  });
  if (dayStr === today) return hourStr;
  // Different day (yesterday for 24h view) — prefix the short date
  const shortDate = d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
  return `${shortDate} · ${hourStr}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }) + ' EST';
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York',
  }) + ' EST';
}

function estDayOf(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function todayEstDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Monday.com task due dates arrive as "YYYY-MM-DD" (EST workspace) and dueTime
// as "HH:MM" 24-hr. Render as a human-readable local label.
function fmtDueDate(dueDate, dueTime) {
  if (!dueDate) return '';
  const [y, m, d] = dueDate.split('-').map(Number);
  if (!y || !m || !d) return dueDate;
  const dayOnly = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const today = todayEstDay();
  const tomorrow = (() => {
    const t = new Date(); t.setDate(t.getDate() + 1);
    return t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  let dayLabel;
  if (dayOnly === today) dayLabel = 'Today';
  else if (dayOnly === tomorrow) dayLabel = 'Tomorrow';
  else dayLabel = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!dueTime) return dayLabel;
  // dueTime is "HH:MM" 24-hr in EST → convert to 12-hr
  const [hh, mm] = dueTime.split(':').map(Number);
  const period = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = mm ? `${hour12}:${String(mm).padStart(2,'0')} ${period}` : `${hour12} ${period}`;
  return `${dayLabel} ${time} EST`;
}

// Two-letter tag for a system's state — green UP, red DOWN.
function StatusChip({ label, state }) {
  const isUp = state !== 'DOWN';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', borderRadius: 999,
      background: isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.15)',
      border: `1px solid ${isUp ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.4)'}`,
      fontSize: 13, fontWeight: 600,
      color: isUp ? '#166534' : '#991b1b',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: isUp ? '#22c55e' : '#ef4444',
        boxShadow: `0 0 6px ${isUp ? '#22c55e' : '#ef4444'}`,
      }} />
      {label}
    </div>
  );
}

function Card({ title, headerRight, children }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12, padding: 16,
      backdropFilter: 'blur(10px)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text)' }}>{title}</h3>
        {headerRight}
      </div>
      {children}
    </div>
  );
}

function OutstandingTenant({ label, tenant }) {
  if (!tenant?.configured) {
    return (
      <div style={{ padding: 12, color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>
        {label} tenant not configured
      </div>
    );
  }
  const rows = tenant.customers || [];
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{label}</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div><span style={{ color: 'var(--muted)', fontSize: 11, marginRight: 4 }}>ACCOUNTS</span><b>{tenant.count}</b></div>
          <div><span style={{ color: 'var(--muted)', fontSize: 11, marginRight: 4 }}>TOTAL</span><b style={{ color: 'var(--danger)' }}>{usd(tenant.totalOverdue)}</b></div>
        </div>
      </div>
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
            <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, letterSpacing: 0.5 }}>
              <th style={{ padding: '6px 8px' }}>Company</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Days</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Overdue</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} style={{ padding: 12, textAlign: 'center', color: 'var(--muted)' }}>None outstanding</td></tr>
            )}
            {rows.map(c => (
              <tr key={c.customerId} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 8px', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.url ? <a href={c.url} target="_blank" rel="noreferrer" style={{ color: 'var(--royal)' }}>{c.company || `#${c.customerId}`}</a> : (c.company || `#${c.customerId}`)}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.daysOverdue}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--danger)', fontWeight: 600 }}>{usd(c.amountOverdue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MitelQueues({ queueStats }) {
  if (queueStats?.offline || queueStats?.unconfigured) {
    return <div style={{ color: 'var(--danger)', fontSize: 13 }}>Poller offline — no queue data</div>;
  }
  const queues = queueStats?.queues || [];
  if (queues.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Waiting for poller data…</div>;
  const hasHourly = queues.some(q => Array.isArray(q.hourly) && q.hourly.length > 0);
  if (!hasHourly) {
    return <div style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>Poller hasn't pushed last-24h data yet.</div>;
  }
  const buckets = queues[0].hourly.map(h => h.bucket);
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 6 }}>
        AVG RING TIME — LAST 24 HOURS
      </div>
      <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
            <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, letterSpacing: 0.5 }}>
              <th style={{ padding: '6px 8px' }}>Hour</th>
              {queues.map(q => (
                <th key={q.id} style={{ padding: '6px 8px', textAlign: 'right' }}>{q.name || q.id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, i) => (
              <tr key={bucket} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 8px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtHourEst(bucket)}</td>
                {queues.map(q => {
                  const cell = q.hourly?.[i];
                  return (
                    <td key={q.id} style={{ padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {cell?.avgWait != null
                        ? <span>{fmtWait(cell.avgWait)}<span style={{ color: 'var(--muted)', marginLeft: 4, fontSize: 10 }}>({cell.answered})</span></span>
                        : <span style={{ color: 'var(--muted)' }}>—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)' }}>
        (count of answered calls per hour in parentheses)
      </div>
    </div>
  );
}

function DidChips({ didCounts, hubspotDids }) {
  const chips = [
    { label: 'Mitel DIDs',    val: didCounts?.mitel,             color: '#7c3aed' },
    { label: 'DID Pool',      val: hubspotDids?.didPool,         color: '#7c3aed' },
    { label: 'Instant',       val: hubspotDids?.instantDidPool,  color: '#7c3aed' },
  ];
  return (
    <>
      {chips.map(c => (
        <div key={c.label} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 999,
          background: 'rgba(124,58,237,0.10)',
          border: '1px solid rgba(124,58,237,0.30)',
          fontSize: 13, fontWeight: 600, color: c.color,
        }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>{c.label}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{c.val ?? '—'}</span>
        </div>
      ))}
    </>
  );
}

function TraineesCard({ trainees }) {
  if (!trainees) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const cutoff = (() => {
    const d = new Date(); d.setDate(d.getDate() - 14);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  const active = (trainees.activeTrainees || [])
    .map(t => {
      const dates = [t.day1Date, t.day2Date].filter(Boolean);
      if (dates.length === 0) return null;
      const upcoming = dates.filter(d => d >= today).sort();
      const nextDate = upcoming[0] || dates.sort()[dates.length - 1];
      return { ...t, nextDate };
    })
    .filter(t => t && t.nextDate && t.nextDate >= cutoff)
    .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''))
    .slice(0, 8);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 8, background: 'rgba(163,230,53,0.08)', border: '1px solid rgba(163,230,53,0.25)' }}>
          <div style={{ fontSize: 10, letterSpacing: 0.5, color: 'var(--muted)' }}>NEW HIRES · {trainees.monthKey || ''}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#65a30d', fontVariantNumeric: 'tabular-nums' }}>{(trainees.newHiresThisMonth || []).length}</div>
        </div>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 8, background: 'rgba(26,111,232,0.08)', border: '1px solid rgba(26,111,232,0.25)' }}>
          <div style={{ fontSize: 10, letterSpacing: 0.5, color: 'var(--muted)' }}>IN TRAINING</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--royal)', fontVariantNumeric: 'tabular-nums' }}>{(trainees.activeTrainees || []).length}</div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 4 }}>UPCOMING</div>
      {active.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>None on the calendar</div>
      )}
      {active.map(t => (
        <a
          key={t.id}
          href={t.link}
          target="_blank"
          rel="noreferrer"
          className="quality-row"
          style={{ display: 'block', padding: '6px 4px', borderTop: '1px solid var(--border)', fontSize: 12, textDecoration: 'none', color: 'inherit' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{t.name}</span>
            {t.team && (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(163,230,53,0.15)', color: '#65a30d', fontWeight: 600 }}>{t.team}</span>
            )}
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t.status}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {t.day1Date && <span>D1 {t.day1Date}</span>}
            {t.day2Date && <span style={{ marginLeft: 8 }}>D2 {t.day2Date}</span>}
          </div>
        </a>
      ))}
    </div>
  );
}

function QualityPanel({ data, loading, period, onPeriodChange }) {
  const csat = data?.csat || {};
  const sla  = data?.sla  || {};
  const pctColor = csat.pct == null ? 'var(--muted)'
    : csat.pct >= 95 ? 'var(--success)'
    : csat.pct >= 85 ? 'var(--warn)'
    : 'var(--danger)';
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {['this-week', 'this-month'].map(p => (
          <button
            key={p}
            onClick={() => onPeriodChange(p)}
            style={{
              padding: '4px 10px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${period === p ? 'var(--royal)' : 'var(--border)'}`,
              background: period === p ? 'rgba(26,111,232,0.1)' : 'transparent',
              color: period === p ? 'var(--royal)' : 'var(--text)',
              fontWeight: period === p ? 700 : 400,
            }}
          >{p === 'this-week' ? 'This Week' : 'This Month'}</button>
        ))}
        {loading && <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>refreshing…</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 4 }}>CSAT</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: pctColor, lineHeight: 1 }}>
              {csat.pct != null ? `${csat.pct}%` : '—'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {csat.good ?? 0} good · <span style={{ color: (csat.bad || 0) > 0 ? 'var(--danger)' : 'inherit' }}>{csat.bad ?? 0} bad</span>
            </div>
          </div>
          {(csat.ratedTickets || []).length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {csat.ratedTickets.map(c => (
                <a key={c.ticketId} href={c.link} target="_blank" rel="noreferrer"
                   className="quality-row"
                   style={{ display: 'block', padding: '6px 8px', borderTop: '1px solid var(--border)', textDecoration: 'none', color: 'inherit', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{
                      fontSize: 10, padding: '1px 5px', borderRadius: 4,
                      background: c.score === 'good' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: c.score === 'good' ? '#166534' : '#991b1b',
                    }}>{c.score}</span>
                    <span style={{ fontWeight: 600, color: 'var(--royal)' }}>#{c.ticketId}</span>
                    {c.requester && <span style={{ color: 'var(--muted)' }}>{c.requester}</span>}
                    <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10 }}>↗</span>
                  </div>
                  <div style={{ marginTop: 2, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.subject}</div>
                  {c.comment && (
                    <div style={{ marginTop: 2, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>“{c.comment}”</div>
                  )}
                </a>
              ))}
            </div>
          )}
          {(csat.ratedTickets || []).length === 0 && csat.total > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>No rated tickets returned for this period.</div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 4 }}>SLA BREACHES</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <div style={{
              fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1,
              color: (sla.totalBreaches || 0) === 0 ? 'var(--success)' : 'var(--danger)',
            }}>{sla.totalBreaches ?? 0}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>tickets breached</div>
          </div>
          {(sla.tickets || []).length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {sla.tickets.map(t => (
                <a key={t.id} href={t.link} target="_blank" rel="noreferrer"
                   className="quality-row"
                   style={{ display: 'block', padding: '6px 8px', borderTop: '1px solid var(--border)', textDecoration: 'none', color: 'inherit', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: 'var(--royal)' }}>#{t.id}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 10 }}>{t.status}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10 }}>↗</span>
                  </div>
                  <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</div>
                </a>
              ))}
            </div>
          )}
          {sla.supported === false && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>SLA data unavailable (no policies configured?)</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SupportTasks({ tasks }) {
  if (!tasks) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const overdue  = tasks.overdue || [];
  const upcoming = tasks.upcoming || [];
  const Section = ({ label, rows, danger }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 4 }}>
        {label.toUpperCase()} <span style={{ color: danger ? 'var(--danger)' : 'inherit', fontWeight: 700 }}>({rows.length})</span>
      </div>
      {rows.length === 0
        ? <div style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic', padding: '4px 0' }}>None</div>
        : rows.slice(0, 10).map(t => (
          <div key={t.id} style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
            <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
            <div style={{ color: 'var(--muted)', fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {t.accountName && <span>{t.accountName}</span>}
              {t.dueDate && <span>· {fmtDueDate(t.dueDate, t.dueTime)}</span>}
              {t.worker && <span>· {t.worker}</span>}
            </div>
          </div>
        ))}
    </div>
  );
  return (
    <div>
      <Section label="Overdue"  rows={overdue}  danger />
      <Section label="Upcoming" rows={upcoming} />
    </div>
  );
}

export default function AdminDashboard() {
  const { status, didCounts, hubspotDids } = useApp();
  const [outstanding, setOutstanding] = useState(null);
  const [outstandingLoading, setOutstandingLoading] = useState(false);
  const [outstandingError, setOutstandingError] = useState(null);
  const [mitelQueues, setMitelQueues] = useState(null);
  const [supportTasks, setSupportTasks] = useState(null);
  const [qualityPeriod, setQualityPeriod] = useState('this-week');
  const [quality, setQuality] = useState(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [agentCounts, setAgentCounts] = useState(null); // { here, standby, total }
  const [trainees, setTrainees]       = useState(null);

  const fetchOutstanding = useCallback(async () => {
    setOutstandingLoading(true);
    setOutstandingError(null);
    try {
      const r = await api.get('/api/chargeover/outstanding');
      setOutstanding(r.data);
    } catch (e) {
      setOutstandingError(e.response?.data?.error || e.message);
    } finally {
      setOutstandingLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOutstanding();
    const id = setInterval(fetchOutstanding, CHARGEOVER_POLL_MS);
    return () => clearInterval(id);
  }, [fetchOutstanding]);

  useEffect(() => {
    const fetch = () => api.get('/api/mitel/queue-stats').then(r => setMitelQueues(r.data)).catch(() => setMitelQueues({ offline: true }));
    fetch();
    const id = setInterval(fetch, MITEL_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fetch = () => api.get('/api/monday/support-tasks').then(r => setSupportTasks(r.data)).catch(() => {});
    fetch();
    const id = setInterval(fetch, TASKS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetch = () => {
      setQualityLoading(true);
      api.get(`/api/zendesk/quality?period=${qualityPeriod}`)
        .then(r => { if (!cancelled) setQuality(r.data); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setQualityLoading(false); });
    };
    fetch();
    const id = setInterval(fetch, QUALITY_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [qualityPeriod]);

  useEffect(() => {
    const fetch = () => api.get('/api/monday/agents').then(r => {
      const agents = (r.data?.agents || []).filter(a => (a.callCenter || '').toLowerCase().includes('mitel'));
      const here    = agents.filter(a => a.status === 'Here').length;
      const standby = agents.filter(a => a.status === 'On Standby').length;
      setAgentCounts({ here, standby, total: here + standby });
    }).catch(() => {});
    fetch();
    const id = setInterval(fetch, AGENTS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fetch = () => api.get('/api/monday/trainees').then(r => setTrainees(r.data)).catch(() => {});
    fetch();
    const id = setInterval(fetch, TRAINEES_POLL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: 20, maxWidth: 1600, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Admin Dashboard</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {agentCounts && (
            <div
              title={`${agentCounts.here} here · ${agentCounts.standby} on standby`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', borderRadius: 999,
                background: 'rgba(26,111,232,0.12)',
                border: '1px solid rgba(26,111,232,0.35)',
                fontSize: 13, fontWeight: 600, color: 'var(--royal)',
              }}
            >
              <span>👥</span>
              <span>{agentCounts.total} Mitel agents</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>
                ({agentCounts.here} here · {agentCounts.standby} standby)
              </span>
            </div>
          )}
          <StatusChip label="Mitel Classic" state={status?.mitelClassic?.state} />
          <StatusChip label="Mobile App"    state={status?.mobileApp?.state} />
          <StatusChip label="Integrations"  state={status?.integrations?.state} />
          <StatusChip label="DIDs"          state={status?.didStatus} />
          <DidChips didCounts={didCounts} hubspotDids={hubspotDids} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        {/* Billing column */}
        <Card
          title="ChargeOver — Outstanding"
          headerRight={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--muted)' }}>
              {outstanding?.generatedAt && <span>updated {fmtTime(outstanding.generatedAt)}</span>}
              <button
                onClick={fetchOutstanding}
                disabled={outstandingLoading}
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}
              >{outstandingLoading ? '…' : 'Refresh'}</button>
            </div>
          }
        >
          {outstandingError && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>Error: {outstandingError}</div>}
          <div style={{ display: 'grid', gap: 16 }}>
            <OutstandingTenant label="AL — Answering Legal"  tenant={outstanding?.AL} />
            <OutstandingTenant label="RS — Ring Savvy" tenant={outstanding?.RS} />
          </div>
        </Card>

        {/* Phone + Trainees column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="Mitel Queues — Avg Ring Time (24h)">
            <MitelQueues queueStats={mitelQueues} />
          </Card>
          <Card title="Trainees">
            <TraineesCard trainees={trainees} />
          </Card>
        </div>

        {/* Support column */}
        <Card title="Open Support Tasks">
          <SupportTasks tasks={supportTasks} />
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card
          title="Zendesk — Quality"
          headerRight={
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {quality?.generatedAt && `updated ${fmtTime(quality.generatedAt)}`}
            </div>
          }
        >
          <QualityPanel
            data={quality}
            loading={qualityLoading}
            period={qualityPeriod}
            onPeriodChange={setQualityPeriod}
          />
        </Card>
      </div>
    </div>
  );
}
