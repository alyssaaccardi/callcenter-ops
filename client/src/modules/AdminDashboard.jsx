import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';

const CHARGEOVER_POLL_MS = 60_000;
const MITEL_POLL_MS      = 10_000;
const TASKS_POLL_MS      = 30_000;

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

function monthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
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
  const hasMtd = queues.some(q => q.mtdAnswered != null || q.mtdLongestWait != null);
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 6 }}>
        HOLD TIMES — {monthLabel().toUpperCase()}
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, letterSpacing: 0.5 }}>
            <th style={{ padding: '6px 4px' }}>Queue</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Longest</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Avg</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Answered</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Aband</th>
          </tr>
        </thead>
        <tbody>
          {queues.map(q => (
            <tr key={q.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 4px' }}>
                <div style={{ fontWeight: 700 }}>{q.name || q.id}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>{q.id}</div>
              </td>
              <td style={{ padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtWait(q.mtdLongestWait)}</td>
              <td style={{ padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtWait(q.mtdAvgWait)}</td>
              <td style={{ padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{q.mtdAnswered ?? 0}</td>
              <td style={{ padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: (q.mtdAbandoned || 0) > 0 ? 'var(--danger)' : 'inherit' }}>{q.mtdAbandoned ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!hasMtd && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
          Poller hasn't pushed month-to-date fields yet.
        </div>
      )}
    </div>
  );
}

function DidCounts({ didCounts, hubspotDids }) {
  const cells = [
    { label: 'Mitel Active',    val: didCounts?.mitel,             hint: 'Bandwidth' },
    { label: 'DID Pool',        val: hubspotDids?.didPool,         hint: 'HubSpot (available)' },
    { label: 'Instant DIDs',    val: hubspotDids?.instantDidPool,  hint: 'HubSpot' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
      {cells.map(c => (
        <div key={c.label} style={{ padding: 10, borderRadius: 10, background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.15)' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5 }}>{c.label.toUpperCase()}</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.val ?? '—'}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{c.hint}</div>
        </div>
      ))}
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
            <div style={{ color: 'var(--muted)', fontSize: 11, display: 'flex', gap: 8 }}>
              {t.accountName && <span>{t.accountName}</span>}
              {t.dueDate && <span>· {t.dueDate}{t.dueTime ? ` ${t.dueTime}` : ''}</span>}
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

  return (
    <div style={{ padding: 20, maxWidth: 1600, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Admin Dashboard</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <StatusChip label="Mitel Classic" state={status?.mitelClassic?.state} />
          <StatusChip label="Mobile App"    state={status?.mobileApp?.state} />
          <StatusChip label="Integrations"  state={status?.integrations?.state} />
          <StatusChip label="DIDs"          state={status?.didStatus} />
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
            <OutstandingTenant label="RS — Reliable Service" tenant={outstanding?.RS} />
          </div>
        </Card>

        {/* Phone / DID column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="Mitel Queues — MTD">
            <MitelQueues queueStats={mitelQueues} />
          </Card>
          <Card title="Available DIDs">
            <DidCounts didCounts={didCounts} hubspotDids={hubspotDids} />
          </Card>
        </div>

        {/* Support column */}
        <Card title="Open Support Tasks">
          <SupportTasks tasks={supportTasks} />
        </Card>
      </div>
    </div>
  );
}
