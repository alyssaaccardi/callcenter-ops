import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import UserBadge from '../components/UserBadge';
import '../pages/SupportPage.css';
import './TechCenter.css';

const POLL_MS = 15000;

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

function StatCard({ label, value, className = '', href, title, children }) {
  const cls = `sc-stat-card${className ? ' ' + className : ''}`;
  const body = (
    <>
      <div className="sc-stat-label">{label}</div>
      <div className="sc-stat-value">{value}</div>
      {children}
    </>
  );
  if (href) {
    return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" title={title}>{body}</a>;
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

function LeaderboardPanel({ sections, support, unconfigured, csatGood, csatBad, zdUrl, periodLabel }) {
  const rankCls   = i => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
  const totalAgents = (support?.length ?? 0);
  const csatTotal = (csatGood || 0) + (csatBad || 0);
  const csatPct   = csatTotal > 0 ? Math.round(((csatGood || 0) / csatTotal) * 100) : null;

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
          <div className="sc-panel-title">Tech Team Leaderboard</div>
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

        {!unconfigured && sections?.length > 0 ? (
          sections.map(section => (
            <React.Fragment key={section.name}>
              <div className="sc-lb-section">
                {section.name}
                {section.agents.reduce((s, a) => s + (a.replies || 0), 0) > 0 && (
                  <span className="sc-lb-section-stat">
                    {section.agents.reduce((s, a) => s + (a.replies || 0), 0)} replied
                  </span>
                )}
              </div>
              {section.agents.map((a, i) => (
                <AgentRow key={a.id} agent={a} rank={i} />
              ))}
            </React.Fragment>
          ))
        ) : (
          !unconfigured && support?.map((a, i) => (
            <AgentRow key={a.id} agent={a} rank={i} />
          ))
        )}
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

export default function TechCenter() {
  const { status, hubspotDids } = useApp();
  const { user } = useAuth();
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [lastSync,    setLastSync]    = useState(null);
  const [stale,       setStale]       = useState({ tickets: [], unconfigured: false });
  const [csat,        setCsat]        = useState({ ratings: [], unconfigured: false });
  const [leaderboard, setLeaderboard] = useState({ sections: null, support: [], unconfigured: false, csatGood: 0, csatBad: 0 });
  const [queue,       setQueue]       = useState({ new: 0, open: 0, pending: 0, onHold: 0, unconfigured: false, zdSubdomain: null, zdGroupFilter: null });
  const [period,      setPeriod]      = useState('this-week');
  const [staleHours,  setStaleHours]  = useState(24);

  const fetchAll = useCallback(async (p, sh) => {
    setRefreshing(true);
    try {
      const [staleRes, csatRes, lbRes, queueRes] = await Promise.allSettled([
        api.get('/api/zendesk/stale-tickets', { params: { hours: sh, team: 'tech' } }),
        api.get('/api/zendesk/csat',          { params: { period: p, team: 'tech' } }),
        api.get('/api/zendesk/leaderboard',   { params: { period: p, team: 'tech' } }),
        api.get('/api/zendesk/queue-stats',   { params: { team: 'tech' } }),
      ]);
      if (staleRes.status === 'fulfilled') setStale(staleRes.value.data);
      if (csatRes.status  === 'fulfilled') setCsat(csatRes.value.data);
      if (lbRes.status    === 'fulfilled') {
        const d = lbRes.value.data;
        setLeaderboard({ sections: d.sections || null, support: d.support || [], unconfigured: !!d.unconfigured, csatGood: d.csatGood || 0, csatBad: d.csatBad || 0 });
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

  const staleCount = stale.unconfigured ? null : (stale.tickets?.length ?? 0);

  const zdSub      = queue.zdSubdomain;
  const zdUrl      = zdSub ? (q) => `https://${zdSub}.zendesk.com/agent/search/1?q=${encodeURIComponent(q)}` : null;
  const zdGroupUrl = zdUrl && queue.zdGroupFilter
    ? (q) => zdUrl(`${q} ${queue.zdGroupFilter}`)
    : zdUrl;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Tech Center</div>
          <div className="page-sub">Zendesk · Tech Team · queue, stale, CSAT &amp; leaderboard · {POLL_MS / 1000}s refresh</div>
        </div>
        <div className="flex" style={{ gap: 10 }}>
          {lastSync && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>
              Synced {lastSync}
            </span>
          )}
          <UserBadge user={user} />
          <button className="btn btn-secondary btn-sm" onClick={async () => {
            try {
              const res = await api.post('/api/tv-session');
              const token = res.data?.token;
              if (token) window.open(`/tech-dash?t=${token}`, '_blank');
            } catch { /* ignore */ }
          }}>
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

          {/* ── HubSpot placeholder ── */}
          <div className="sc-stat-row mb-8">
            <div className="sc-stat-group-label">
              HubSpot <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, opacity: 0.6 }}>· integration coming soon</span>
            </div>
            <div className="tc-hubspot-strip">
              <div
                className="sc-stat-card tc-hubspot-card"
                title="HubSpot mobile app activation data will appear here once the integration is configured"
              >
                <div className="sc-stat-label">Mobile App Activations</div>
                <div className="sc-stat-value tc-placeholder-val">—</div>
                <div className="tc-placeholder-sub">Integration coming soon</div>
              </div>
            </div>
          </div>

          {/* ── Zendesk Queue stats ── */}
          <div className="sc-stat-row mb-16">
            <div className="sc-stat-group-label">
              Zendesk Queue <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, opacity: 0.6 }}>(live)</span>
            </div>
            <div className="sc-stat-strip">
              <StatCard
                label="New" value={queue.unconfigured ? '—' : queue.new}
                className={!queue.unconfigured && queue.new > 0 ? 'accent-purple' : ''}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:new') : null}
                title={`${queue.new} new tickets awaiting first response — click to view in Zendesk`}
              />
              <StatCard
                label="Open" value={queue.unconfigured ? '—' : queue.open}
                className={!queue.unconfigured && queue.open > 0 ? 'accent-amber' : ''}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:open') : null}
                title={`${queue.open} open tickets actively being worked — click to view in Zendesk`}
              />
              <StatCard
                label="Pending" value={queue.unconfigured ? '—' : queue.pending}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:pending') : null}
                title={`${queue.pending} tickets awaiting customer response`}
              />
              <StatCard
                label="On Hold" value={queue.unconfigured ? '—' : queue.onHold}
                href={zdGroupUrl ? zdGroupUrl('type:ticket status:hold') : null}
                title={`${queue.onHold} tickets on hold`}
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
            <StalePanel tickets={stale.tickets} unconfigured={stale.unconfigured} hours={staleHours} />
            <CsatPanel  ratings={csat.ratings}  unconfigured={csat.unconfigured} />
            <LeaderboardPanel
              sections={leaderboard.sections}
              support={leaderboard.support}
              unconfigured={leaderboard.unconfigured}
              csatGood={leaderboard.csatGood}
              csatBad={leaderboard.csatBad}
              zdUrl={zdUrl}
              periodLabel={PERIOD_OPTIONS.find(o => o.key === period)?.label ?? period}
            />
          </div>
        </>
      )}
    </div>
  );
}
