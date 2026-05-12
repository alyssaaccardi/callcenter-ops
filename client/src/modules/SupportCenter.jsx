import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import UserBadge from '../components/UserBadge';
import '../pages/SupportPage.css';

const POLL_MS  = 15000;
const BOARD_ID = '18358060875';

const PERIOD_OPTIONS = [
  { label: 'Today',      key: 'today'      },
  { label: 'Yesterday',  key: 'yesterday'  },
  { label: 'This Week',  key: 'this-week'  },
  { label: 'Last Week',  key: 'last-week'  },
  { label: 'Last Month', key: 'last-month' },
  { label: '90d',        key: '90d'        },
  { label: 'All',        key: 'all'        },
];

const STALE_OPTIONS = [8, 12, 24, 48, 72];

function fmtTimeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 60000;
  if (diff < 60)   return `${Math.round(diff)}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 1440)}d ago`;
}

function daysOverdue(str) {
  if (!str) return '';
  const due = new Date(str);
  if (isNaN(due)) return '';
  due.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = Math.round((today - due) / 86400000);
  if (d <= 0) return 'Due today';
  return d === 1 ? '1d overdue' : `${d}d overdue`;
}

function daysLate(str) {
  if (!str) return 0;
  const due = new Date(str);
  if (isNaN(due)) return 0;
  due.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - due) / 86400000));
}

function overdueUrgency(days) {
  if (days >= 7) return 'critical';
  if (days >= 3) return 'high';
  if (days >= 1) return 'medium';
  return 'low';
}

function priorityClass(p) {
  const l = (p || '').toLowerCase();
  if (l.includes('urgent')) return 'urgent';
  if (l.includes('high'))   return 'high';
  if (l.includes('med'))    return 'medium';
  return 'low';
}

function TaskCard({ task, isToday = false }) {
  const isPending = /(pending|in.?progress|working|in.?review)/i.test(task.status || '');
  const late      = !isToday ? daysLate(task.dueDate) : 0;
  return (
    <a
      className={`sc-task-card${isToday ? ' today' : ''}${isPending ? ' pending' : ''}`}
      href={task.link}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="sc-task-body">
        {isPending && (
          <div className="sc-task-working-banner">
            <span className="sc-task-working-banner-icon">⚙️</span>
            <span className="sc-task-working-banner-label">Being worked on</span>
            {task.assignee && (
              <span className="sc-task-working-banner-name">{task.assignee}</span>
            )}
          </div>
        )}
        <div className="sc-task-top-row">
          {task.accountName && <span className="sc-task-account">{task.accountName}</span>}
          <span className="sc-task-name" title={task.name}>{task.name}</span>
        </div>
        {task.description && (
          <div className="sc-task-desc">{task.description}</div>
        )}
        <div className="sc-task-meta-row">
          {task.taskType && <div className="sc-task-pill type">{task.taskType}</div>}
          {task.priority  && <div className={`sc-task-pill ${priorityClass(task.priority)}`}>{task.priority}</div>}
          {!isPending && task.status && <div className="sc-task-pill status">{task.status}</div>}
          {isToday && (
            <div className="sc-task-due today">{task.dueTime ? `Due ${task.dueTime} EST` : 'Due today'}</div>
          )}
          {!isToday && task.dueTime && (
            <div className="sc-task-due muted">⏰ {task.dueTime} EST</div>
          )}
          {task.assignee && !isPending && (
            <div className="sc-task-assignee">
              <span className="sc-task-assignee-dot" style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(168,85,247,0.2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 800, color: 'var(--purple)', flexShrink: 0 }}>
                {task.assignee[0].toUpperCase()}
              </span>
              {task.assignee}
            </div>
          )}
        </div>
      </div>
      {!isToday && (
        <div className={`sc-task-overdue-badge ${late === 0 ? 'today' : overdueUrgency(late)}`}>
          {late === 0 ? (
            <div className="sc-task-overdue-unit">Today</div>
          ) : (
            <>
              <div className="sc-task-overdue-num">{late}</div>
              <div className="sc-task-overdue-unit">day{late !== 1 ? 's' : ''} late</div>
            </>
          )}
        </div>
      )}
      <div className="sc-task-arrow">↗</div>
    </a>
  );
}

function StatCard({ label, value, className = '', href, title }) {
  const cls = `sc-stat-card${className ? ' ' + className : ''}`;
  const body = (
    <>
      <div className="sc-stat-label">{label}</div>
      <div className="sc-stat-value">{value}</div>
    </>
  );
  if (href) {
    const isAnchor = href.startsWith('#');
    return <a className={cls} href={href} {...(!isAnchor && { target: '_blank', rel: 'noopener noreferrer' })} title={title}>{body}</a>;
  }
  return <div className={cls} title={title}>{body}</div>;
}

function Empty({ icon, text }) {
  return (
    <div className="sc-empty">
      {icon && <div className="sc-empty-icon">{icon}</div>}
      <div className="sc-empty-text">{text}</div>
    </div>
  );
}

function StalePanel({ tickets, unconfigured, hours }) {
  const count = tickets?.length ?? 0;
  return (
    <div className="sc-panel">
      <div className="sc-panel-header">
        <div className="sc-panel-title">Stale · {hours}h+ no reply</div>
        <div className={`sc-panel-badge ${unconfigured ? 'muted' : count > 0 ? 'red' : 'green'}`}>
          {unconfigured ? 'N/A' : count > 0 ? `${count} stale` : 'All fresh'}
        </div>
      </div>
      <div className="sc-panel-criteria">
        NEW &amp; OPEN — no agent reply for {hours}+ business hrs (Mon–Fri 9–5)
      </div>
      <div className="sc-panel-body">
        {unconfigured && <Empty icon="🔗" text="Add Zendesk credentials in .env" />}
        {!unconfigured && count === 0 && <Empty icon="✅" text="No stale tickets" />}
        {!unconfigured && tickets?.map(t => (
          <a key={t.id} className="sc-ticket-row" href={t.link} target="_blank" rel="noopener noreferrer">
            <div className={`sc-status-dot ${t.status}`} />
            <div className="sc-ticket-subject" title={t.subject}>{t.subject || `#${t.id}`}</div>
            <div className="sc-ticket-meta">{fmtTimeAgo(t.updatedAt)}</div>
            <div className="sc-ticket-arrow">↗</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function CsatPanel({ ratings, unconfigured }) {
  const count     = ratings?.length ?? 0;
  const goodCount = ratings?.filter(r => r.score === 'good').length ?? 0;
  const badCount  = ratings?.filter(r => r.score === 'bad').length  ?? 0;
  return (
    <div className="sc-panel">
      <div className="sc-panel-header">
        <div className="sc-panel-title">CSAT Ratings</div>
        <div className="sc-panel-badge muted">
          {unconfigured ? 'N/A' : `${goodCount} 👍  ${badCount} 👎`}
        </div>
      </div>
      <div className="sc-panel-body">
        {unconfigured && <Empty icon="🔗" text="Add Zendesk credentials in .env" />}
        {!unconfigured && count === 0 && <Empty icon="⭐" text="No ratings in this period" />}
        {!unconfigured && ratings?.map(r => (
          <React.Fragment key={r.id}>
            <a className="sc-ticket-row" href={r.link} target="_blank" rel="noopener noreferrer">
              <div className={`sc-status-dot ${r.score === 'good' ? 'good' : 'bad'}`} />
              <div className="sc-ticket-subject">{r.requester || `Ticket #${r.ticketId}`}</div>
              <div className="sc-ticket-meta">{fmtTimeAgo(r.createdAt)}</div>
              <div className="sc-ticket-arrow">↗</div>
            </a>
            {r.comment && <div className="sc-ticket-comment">"{r.comment}"</div>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function LeaderboardPanel({ support, escalation, unconfigured, csatGood, csatBad, zdUrl, periodLabel }) {
  const rankCls   = i => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
  const totalAgents = (support?.length ?? 0) + (escalation?.length ?? 0);
  const supportReplies = (support || []).reduce((s, a) => s + a.replies, 0);
  const csatTotal  = (csatGood || 0) + (csatBad || 0);
  const csatPct    = csatTotal > 0 ? Math.round(((csatGood || 0) / csatTotal) * 100) : null;

  function chipHref(a, type) {
    if (!zdUrl) return null;
    if (type === 'replied') return zdUrl(`type:ticket commenter:${a.id}`);
    return zdUrl(`type:ticket assignee_id:${a.id} status:open status:new`);
  }

  function AgentChip({ agent, type }) {
    const href  = chipHref(agent, type);
    const label = type === 'replied' ? `${agent.replies} replied` : `${agent.open} open`;
    const title = type === 'replied'
      ? `${agent.replies} tickets with a public reply from ${agent.name} in the selected period — click to open in Zendesk`
      : `${agent.open} tickets currently assigned & open/new for ${agent.name} — click to open in Zendesk`;
    const cls   = `sc-lb-chip ${type}${href ? ' linked' : ''}`;
    if (href) return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" title={title}>{label}</a>;
    return <span className={cls} title={title}>{label}</span>;
  }

  function AgentRow({ agent, rank }) {
    const total   = agent.replies + agent.open;
    const ratePct = total > 0 ? Math.round((agent.replies / total) * 100) : null;
    return (
      <div className="sc-lb-row">
        <div className={`sc-lb-rank ${rankCls(rank)}`}>{rank + 1}</div>
        <div className="sc-lb-avatar">{(agent.name || '?')[0].toUpperCase()}</div>
        <div className="sc-lb-name" title={agent.name}>{agent.name}</div>
        {ratePct !== null && (
          <span
            className={`sc-lb-rate ${ratePct >= 70 ? 'green' : ratePct >= 40 ? 'amber' : 'red'}`}
            title={`${ratePct}% of this agent's ticket workload is resolved (replied ÷ replied+open)`}
          >
            {ratePct}%
          </span>
        )}
        <div className="sc-lb-chips">
          <AgentChip agent={agent} type="replied" />
          <AgentChip agent={agent} type="open" />
        </div>
      </div>
    );
  }

  return (
    <div className="sc-panel">
      <div className="sc-panel-header">
        <div>
          <div className="sc-panel-title">Agent Leaderboard</div>
          <div className="sc-lb-source">
            Zendesk · replied in period · open = all-time assigned · ranked by replies desc
          </div>
        </div>
        <div className="sc-lb-header-right">
          <div className="sc-panel-badge muted">
            {unconfigured ? 'N/A' : `${totalAgents} agents`}
          </div>
          {csatPct !== null && (
            <div
              className={`sc-lb-csat-badge ${csatPct >= 80 ? 'green' : csatPct >= 60 ? 'amber' : 'red'}`}
              title={`CSAT: ${csatGood} good · ${csatBad} bad · ${csatTotal} total ratings this period`}
            >
              {csatPct}% CSAT
            </div>
          )}
        </div>
      </div>

      <div className="sc-panel-criteria">
        REPLIED = tickets with public reply in {periodLabel} period · OPEN = active queue (all time) · % = replied÷(replied+open) · click chips → Zendesk
      </div>

      <div className="sc-panel-body">
        {unconfigured && <Empty icon="🔗" text="Add Zendesk credentials in .env" />}
        {!unconfigured && totalAgents === 0 && <Empty icon="👥" text="No agents with activity" />}

        {!unconfigured && support?.length > 0 && (
          <div className="sc-lb-section">
            Trial Account Team
            {supportReplies > 0 && (
              <span className="sc-lb-section-stat">{supportReplies} replied</span>
            )}
          </div>
        )}
        {!unconfigured && support?.map((a, i) => (
          <AgentRow key={a.id} agent={a} rank={i} />
        ))}

        {!unconfigured && escalation?.length > 0 && (
          <div className="sc-lb-section escalation">
            Escalation Station
            <span className="sc-lb-section-hint">dual-role — also in trial team above</span>
          </div>
        )}
        {!unconfigured && escalation?.map((a, i) => (
          <AgentRow key={`esc-${a.id}`} agent={a} rank={i} />
        ))}
      </div>

      {!unconfigured && csatTotal > 0 && (
        <div className="sc-lb-footer">
          <span className="sc-lb-footer-label">CSAT · {periodLabel}</span>
          <span className="sc-lb-csat-good" title={`${csatGood} positive ratings`}>👍 {csatGood}</span>
          <span className="sc-lb-csat-bad"  title={`${csatBad} negative ratings`}>👎 {csatBad}</span>
          {zdUrl && (
            <a className="sc-lb-csat-link" href={zdUrl('type:ticket has_csat:true')} target="_blank" rel="noopener noreferrer">
              View all →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function SystemStatusStrip({ status, hubspotDids }) {
  if (!status) return null;

  const Pill = ({ label, up, title }) => (
    <div className={`sc-sys-pill ${up ? 'up' : 'down'}`} title={title}>
      <span className="sc-sys-dot" />
      {label}
    </div>
  );

  const savvyUp     = status.savvyPhone?.state   !== 'DOWN';
  const mitelUp     = status.mitelClassic?.state !== 'DOWN';
  const mobileUp    = status.mobileApp?.state    !== 'DOWN';
  const mobileTexts = !status.mobileApp?.messagesDown;
  const integrUp    = status.integrations?.state !== 'DOWN';
  const integrTexts = !status.integrations?.messagesDown;
  const didsUp      = status.didStatus           !== 'DOWN';

  return (
    <div className="sc-sys-strip mb-16">
      <span className="sc-sys-label">Systems</span>

      <Pill label="Savvy Phone"   up={savvyUp} title={`Savvy Phone: ${savvyUp ? 'UP' : 'DOWN'}${status.savvyPhone?.message ? ' — ' + status.savvyPhone.message : ''}`} />
      <Pill label="Mitel Classic" up={mitelUp} title={`Mitel Classic: ${mitelUp ? 'UP' : 'DOWN'}${status.mitelClassic?.message ? ' — ' + status.mitelClassic.message : ''}`} />

      <span className="sc-sys-divider" />

      <Pill label="Mobile App"    up={mobileUp}    title={`Mobile App: ${mobileUp ? 'UP' : 'DOWN'}`} />
      <Pill label="Mobile Texts"  up={mobileTexts} title={`Mobile Texts/Messaging: ${mobileTexts ? 'OK' : 'DOWN'}`} />

      <span className="sc-sys-divider" />

      <Pill label="Integrations"       up={integrUp}    title={`Integrations: ${integrUp ? 'UP' : 'DOWN'}`} />
      <Pill label="Integration Texts"  up={integrTexts} title={`Integration Texts/Messaging: ${integrTexts ? 'OK' : 'DOWN'}`} />

      {didsUp && hubspotDids && (
        <>
          <span className="sc-sys-divider" />
          <div
            className="sc-sys-pill up"
            title={`HubSpot DID Pool — Available: ${hubspotDids.didPool ?? '?'} · Instant: ${hubspotDids.instantDidPool ?? '?'}`}
          >
            <span className="sc-sys-dot" />
            DIDs: {hubspotDids.didPool ?? '?'} avail · {hubspotDids.instantDidPool ?? '?'} instant
          </div>
        </>
      )}
    </div>
  );
}

export default function SupportCenter() {
  const { status, hubspotDids } = useApp();
  const { user } = useAuth();
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [lastSync,    setLastSync]    = useState(null);
  const [tasks,       setTasks]       = useState([]);
  const [upcoming,    setUpcoming]    = useState([]);
  const [stats,       setStats]       = useState(null);
  const [stale,       setStale]       = useState({ tickets: [], unconfigured: false });
  const [csat,        setCsat]        = useState({ ratings: [], unconfigured: false });
  const [leaderboard, setLeaderboard] = useState({ support: [], escalation: [], unconfigured: false, csatGood: 0, csatBad: 0 });
  const [queue,       setQueue]       = useState({ new: 0, open: 0, pending: 0, onHold: 0, unconfigured: false, zdSubdomain: null, zdGroupFilter: null });
  const [period,      setPeriod]      = useState('this-week');
  const [staleHours,  setStaleHours]  = useState(24);

  const fetchAll = useCallback(async (p, sh) => {
    setRefreshing(true);
    try {
      const [tasksRes, statsRes, staleRes, csatRes, lbRes, queueRes] = await Promise.allSettled([
        api.get('/api/monday/support-tasks'),
        api.get('/api/monday/support-stats'),
        api.get('/api/zendesk/stale-tickets', { params: { hours: sh, team: 'support' } }),
        api.get('/api/zendesk/csat',          { params: { period: p, team: 'support' } }),
        api.get('/api/zendesk/leaderboard',   { params: { period: p, team: 'support' } }),
        api.get('/api/zendesk/queue-stats',   { params: { team: 'support' } }),
      ]);
      if (tasksRes.status === 'fulfilled') {
        setTasks(tasksRes.value.data?.tasks || []);
        setUpcoming(tasksRes.value.data?.upcoming || []);
      } else { setTasks([]); setUpcoming([]); }
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
      if (staleRes.status === 'fulfilled') setStale(staleRes.value.data);
      if (csatRes.status  === 'fulfilled') setCsat(csatRes.value.data);
      if (lbRes.status    === 'fulfilled') {
        const d = lbRes.value.data;
        setLeaderboard({ support: d.support || [], escalation: d.escalation || [], unconfigured: !!d.unconfigured, csatGood: d.csatGood || 0, csatBad: d.csatBad || 0 });
      }
      if (queueRes.status === 'fulfilled') setQueue(queueRes.value.data);
      setLastSync(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' EST');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(period, staleHours);
    const id = setInterval(() => fetchAll(period, staleHours), POLL_MS);
    return () => clearInterval(id);
  }, [fetchAll, period, staleHours]);

  async function launchTVDisplay() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/support-dash?t=${token}`, '_blank');
    } catch { /* ignore */ }
  }

  const doneCount    = stats?.byStatus?.find(s => s.label?.toLowerCase() === 'done')?.count ?? 0;
  const overdueCount = tasks.length;
  const staleCount   = stale.unconfigured ? null : (stale.tickets?.length ?? 0);

  const mondayUrl  = `https://answeringlegal-unit.monday.com/boards/${BOARD_ID}`;
  const zdSub      = queue.zdSubdomain;
  const zdUrl      = zdSub ? (q) => `https://${zdSub}.zendesk.com/agent/search/1?q=${encodeURIComponent(q)}` : null;
  const zdGroupUrl = zdUrl && queue.zdGroupFilter
    ? (q) => zdUrl(`${q} ${queue.zdGroupFilter}`)
    : zdUrl;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Support Command Center</div>
          <div className="page-sub">Monday.com · Zendesk · {POLL_MS / 1000}s refresh</div>
        </div>
        <div className="flex" style={{ gap: 10 }}>
          {lastSync && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>
              Synced {lastSync}
            </span>
          )}
          <UserBadge user={user} />
          <button className="btn btn-secondary btn-sm" onClick={launchTVDisplay}>
            🖥 TV Display
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => fetchAll(period, staleHours)} disabled={loading || refreshing}>
            {(loading || refreshing) ? <span className="spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      {/* Global filter bar */}
      <div className="sc-filter-bar mb-16">
        <div className="sc-filter-group">
          <span className="sc-filter-label">Period</span>
          {PERIOD_OPTIONS.map(o => (
            <button
              key={o.key}
              className={`sc-filter-btn${period === o.key ? ' active' : ''}`}
              onClick={() => setPeriod(o.key)}
            >{o.label}</button>
          ))}
        </div>
        <div className="sc-filter-divider" />
        <div className="sc-filter-group">
          <span className="sc-filter-label">Stale &gt;</span>
          {STALE_OPTIONS.map(h => (
            <button
              key={h}
              className={`sc-filter-btn${staleHours === h ? ' active' : ''}`}
              onClick={() => setStaleHours(h)}
            >{h}h</button>
          ))}
        </div>
        <div className="sc-filter-divider" />
        <span className="sc-filter-note">Affects CSAT · leaderboard · stale</span>
        {refreshing && <span className="sc-filter-note sc-filter-updating">↻</span>}
      </div>

      {loading ? (
        <div className="sc-empty" style={{ paddingTop: 60 }}>
          <div className="sc-spinner" style={{ width: 24, height: 24, margin: '0 auto 8px' }} />
          <div className="sc-empty-text">Dialing in...</div>
        </div>
      ) : (
        <>
          {/* ── System Status ── */}
          <SystemStatusStrip status={status} hubspotDids={hubspotDids} />

          {/* ── Stat strips ── */}
          <div className="sc-stat-row mb-8">
            <div className="sc-stat-group-label">Monday.com</div>
            <div className="sc-stat-strip">
              <StatCard
                label="Total Tasks" value={stats?.total ?? '—'}
                href={mondayUrl}
                title={`${stats?.total ?? '?'} total support tasks on the board — click to open Monday`}
              />
              <StatCard
                label="Overdue" value={overdueCount}
                className={overdueCount > 0 ? 'accent-red' : ''}
                href="#overdue-section"
                title={`${overdueCount} task${overdueCount !== 1 ? 's' : ''} past their due date — click to jump to list`}
              />
              <StatCard
                label="Due Today" value={stats?.dueToday ?? '—'}
                href="#today-section"
                title={`${stats?.dueToday ?? '?'} tasks due today — click to jump to list`}
              />
              <StatCard
                label="Done" value={doneCount}
                className="accent-green"
                href={mondayUrl}
                title={`${doneCount} tasks completed`}
              />
            </div>
          </div>

          <div className="sc-stat-row mb-16">
            <div className="sc-stat-group-label">Zendesk Queue <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, opacity: 0.6 }}>(live)</span></div>
            <div className="sc-stat-strip">
              <StatCard
                label="New" value={queue.unconfigured ? '—' : queue.new}
                className={!queue.unconfigured && queue.new > 0 ? 'accent-purple' : ''}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:new') : null}
                title={`${queue.new} new ticket${queue.new !== 1 ? 's' : ''} awaiting first response — click to view in Zendesk`}
              />
              <StatCard
                label="Open" value={queue.unconfigured ? '—' : queue.open}
                className={!queue.unconfigured && queue.open > 0 ? 'accent-amber' : ''}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:open') : null}
                title={`${queue.open} open ticket${queue.open !== 1 ? 's' : ''} actively being worked — click to view in Zendesk`}
              />
              <StatCard
                label="Pending" value={queue.unconfigured ? '—' : queue.pending}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:pending') : null}
                title={`${queue.pending} ticket${queue.pending !== 1 ? 's' : ''} awaiting customer response`}
              />
              <StatCard
                label="On Hold" value={queue.unconfigured ? '—' : queue.onHold}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:hold') : null}
                title={`${queue.onHold} ticket${queue.onHold !== 1 ? 's' : ''} on hold`}
              />
              <StatCard
                label={`Stale (${staleHours}h+)`} value={staleCount ?? '—'}
                className={staleCount !== null && staleCount > 0 ? 'accent-red' : ''}
                title={`${staleCount ?? '?'} open tickets with no agent reply for ${staleHours}+ business hours`}
              />
            </div>
          </div>

          {/* ── Panels ── */}
          <div className="sc-panel-grid mb-16">
            <StalePanel       tickets={stale.tickets}       unconfigured={stale.unconfigured}    hours={staleHours} />
            <CsatPanel        ratings={csat.ratings}        unconfigured={csat.unconfigured} />
            <LeaderboardPanel
              support={leaderboard.support}
              escalation={leaderboard.escalation}
              unconfigured={leaderboard.unconfigured}
              csatGood={leaderboard.csatGood}
              csatBad={leaderboard.csatBad}
              zdUrl={zdUrl}
              periodLabel={PERIOD_OPTIONS.find(o => o.key === period)?.label ?? period}
            />
          </div>

          {/* ── Overdue Tasks ── */}
          <div className="sc-tasks-section" id="overdue-section">
            <div className="sc-section-bar">
              <div className="sc-section-title">Overdue Tasks</div>
              <div className={`sc-badge${overdueCount === 0 ? ' clear' : ''}`}>
                {overdueCount === 0 ? 'All clear' : `${overdueCount} overdue`}
              </div>
            </div>
            {overdueCount === 0 && <Empty icon="✅" text="No overdue tasks — great work!" />}
            {overdueCount > 0 && (
              <div className="sc-task-list">
                {tasks.map(task => <TaskCard key={task.id} task={task} />)}
              </div>
            )}
          </div>

          {/* ── Due Today ── */}
          <div className="sc-tasks-section" id="today-section">
            <div className="sc-section-bar">
              <div className="sc-section-title">Due Today</div>
              <div className={`sc-badge${upcoming.length === 0 ? ' clear' : ' today'}`}>
                {upcoming.length === 0 ? 'Nothing due' : `${upcoming.length} task${upcoming.length !== 1 ? 's' : ''}`}
              </div>
            </div>
            {upcoming.length === 0 && <Empty icon="📅" text="No tasks due today" />}
            {upcoming.length > 0 && (
              <div className="sc-task-list">
                {upcoming.map(task => <TaskCard key={task.id} task={task} isToday />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
