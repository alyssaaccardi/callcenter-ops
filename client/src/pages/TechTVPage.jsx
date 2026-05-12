/**
 * TechTVPage — Pit display for the Tech Team.
 * Accessible to: tech, tv_display, super_admin roles; or valid TV token.
 * Shows: live queue stats, CSAT, leaderboard, stale tickets, system status.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import './TechTVPage.css';

const POLL_MS = 20000;
const MEDALS  = ['🥇', '🥈', '🥉'];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtClock(d, tz) {
  return d.toLocaleTimeString('en-US', {
    hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz,
  });
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
}

function fmtTimeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 60000;
  if (diff < 60)   return `${Math.round(diff)}m`;
  if (diff < 1440) return `${Math.round(diff / 60)}h`;
  return `${Math.round(diff / 1440)}d`;
}

function SysChip({ label, isUp, statusWord, alert }) {
  return (
    <div className={`ttv-chip ${isUp ? 'up' : 'down'}`}>
      <div className="ttv-chip-accent" />
      <div className="ttv-chip-name">{label}</div>
      <div className="ttv-chip-body">
        <div className="ttv-chip-status-row">
          <div className={`ttv-chip-orb ${isUp ? 'up' : 'down'}`} />
          <div className={`ttv-chip-word ${isUp ? 'up' : 'down'}`}>{statusWord}</div>
        </div>
        {alert && <div className="ttv-chip-alert">{alert}</div>}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, colorClass }) {
  const orbColor = colorClass === 'muted' ? 'muted' : colorClass;
  return (
    <div className={`ttv-stat ${colorClass}`}>
      <div className="ttv-stat-accent" />
      <div className="ttv-stat-label">{label}</div>
      <div className="ttv-stat-orb-row">
        <div className={`ttv-orb ${orbColor}`} />
        <div className="ttv-stat-num">{value}</div>
      </div>
      {sub && <div className="ttv-stat-sub">{sub}</div>}
    </div>
  );
}

export default function TechTVPage() {
  const { user } = useAuth();
  const now = useClock();

  const [authed,    setAuthed]    = useState(false);
  const [authError, setAuthError] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [lastSync,  setLastSync]  = useState(null);

  const [queue,       setQueue]       = useState({ new: 0, open: 0, pending: 0, onHold: 0 });
  const [stale,       setStale]       = useState({ tickets: [], unconfigured: false });
  const [leaderboard, setLeaderboard] = useState({ support: [], sections: [], csatGood: 0, csatBad: 0, zdSubdomain: null });
  const [sysStatus,   setSysStatus]   = useState(null);
  const [hubspotDids, setHubspotDids] = useState(null);

  const tvToken = () => new URLSearchParams(window.location.search).get('t');

  useEffect(() => {
    const allowed = ['tech', 'tv_display', 'super_admin'];
    if (allowed.includes(user?.role)) { setAuthed(true); return; }

    const t = tvToken();
    if (!t) { setAuthError('Access denied.'); setLoading(false); return; }

    api.get(`/api/tv-session/validate?t=${t}`)
      .then(() => setAuthed(true))
      .catch(() => { setAuthError('Token invalid or expired.'); setLoading(false); });
  }, [user]);

  const fetchAll = useCallback(async () => {
    const t = tvToken();
    const tParam = t ? { t } : {};

    const [queueRes, staleRes, lbRes, statusRes, hsDidRes] = await Promise.allSettled([
      api.get('/api/zendesk/queue-stats',   { params: { team: 'tech', ...tParam } }),
      api.get('/api/zendesk/stale-tickets', { params: { team: 'tech', hours: 24, ...tParam } }),
      api.get('/api/zendesk/leaderboard',   { params: { team: 'tech', period: 'this-week', ...tParam } }),
      api.get('/api/status'),
      api.get('/api/hubspot/dids'),
    ]);

    if (queueRes.status === 'fulfilled') setQueue(queueRes.value.data);
    if (staleRes.status === 'fulfilled') setStale(staleRes.value.data);
    if (lbRes.status    === 'fulfilled') {
      const d = lbRes.value.data;
      setLeaderboard({
        support:     d.support     || [],
        sections:    d.sections    || [],
        csatGood:    d.csatGood    || 0,
        csatBad:     d.csatBad     || 0,
        zdSubdomain: d.zdSubdomain || null,
      });
    }
    if (statusRes.status === 'fulfilled') setSysStatus(statusRes.value.data);
    if (hsDidRes.status  === 'fulfilled') setHubspotDids(hsDidRes.value.data);
    setLastSync(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' EST');
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchAll();
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [authed, fetchAll]);

  if (authError) return <div className="ttv-loading"><span>{authError}</span></div>;
  if (loading)   return <div className="ttv-loading"><div className="ttv-spinner" /><span>Dialing in...</span></div>;

  const agents     = leaderboard.support.filter(a => a.replies > 0);
  const maxReplies = Math.max(...agents.map(a => a.replies), 1);
  const staleList  = stale.tickets || [];
  const staleCount = stale.unconfigured ? null : staleList.length;
  const zdSub      = leaderboard.zdSubdomain;

  const csatTotal = leaderboard.csatGood + leaderboard.csatBad;
  const csatPct   = csatTotal > 0 ? Math.round((leaderboard.csatGood / csatTotal) * 100) : null;

  const barClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'default';

  const queueNewClass  = queue.new > 0 ? 'purple' : 'muted';
  const queueOpenClass = queue.open > 5 ? 'amber' : queue.open > 0 ? 'green' : 'muted';
  const staleClass     = staleCount === null ? 'muted' : staleCount === 0 ? 'green' : 'red';
  const csatClass      = csatPct === null ? 'muted' : csatPct >= 80 ? 'green' : csatPct >= 60 ? 'amber' : 'red';

  const mobileServiceUp = sysStatus?.mobileApp?.state         !== 'DOWN';
  const mobileTextsUp   = sysStatus?.mobileApp?.messagesDown  !== true;
  const mobileOk        = mobileServiceUp && mobileTextsUp;
  const mobileWord      = mobileOk ? 'Online' : !mobileServiceUp ? 'Down' : 'Messages Disrupted';
  const mobileAlert     = mobileOk ? null : !mobileServiceUp ? null : 'App up · messages not routing';

  const integrServiceUp = sysStatus?.integrations?.state        !== 'DOWN';
  const integrTextsUp   = sysStatus?.integrations?.messagesDown !== true;
  const integrOk        = integrServiceUp && integrTextsUp;
  const integrWord      = integrOk ? 'Routing' : !integrServiceUp ? 'Down' : 'Not Routing';
  const integrAlert     = integrOk ? null : !integrServiceUp ? null : 'Service up · not hitting CRMs';

  const didsUp = sysStatus?.didStatus !== 'DOWN';
  const allOk  = mobileOk && integrOk;

  return (
    <div className="ttv-page">
      <div className="ttv-stripe-top" />
      <div className="ttv-stripe-bottom" />
      <div className="ttv-diag-lines" />

      <div className="ttv-wrapper">
        {/* ── Header ── */}
        <header className="ttv-header">
          <div className="ttv-header-left">
            <img
              className="ttv-logo"
              src="/al-logo.png"
              alt="AL"
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div>
              <div className="ttv-header-brand">Answering Legal</div>
              <div className="ttv-header-sub">Tech Team · Live Pit Display</div>
            </div>
          </div>

          <div className="ttv-header-center">
            <div className="ttv-header-title">Tech Pit Display</div>
            {sysStatus && (
              <div className={`ttv-global-pill ${allOk ? 'up' : 'down'}`} style={{ marginTop: 8 }}>
                <div className="ttv-global-dot" />
                {allOk ? 'All Systems Operational' : 'System Degraded'}
              </div>
            )}
          </div>

          <div className="ttv-header-right">
            <div className="ttv-dual-clock">
              <div className="ttv-clock-entry">
                <span className="ttv-clock-label">EST</span>
                <span className="ttv-clock">{fmtClock(now, 'America/New_York')}</span>
              </div>
            </div>
            <div className="ttv-date">{fmtDate(now)}</div>
          </div>
        </header>

        {/* ── Stat Strip ── */}
        <div className="ttv-stat-strip">
          <StatCard
            label="New Tickets" colorClass={queueNewClass}
            value={queue.unconfigured ? '—' : queue.new}
            sub="Awaiting first response"
          />
          <StatCard
            label="Open" colorClass={queueOpenClass}
            value={queue.unconfigured ? '—' : queue.open}
            sub="Active queue"
          />
          <StatCard
            label="Stale · 24h+" colorClass={staleClass}
            value={staleCount !== null ? staleCount : '—'}
            sub={staleCount === 0 ? 'All fresh' : staleCount > 0 ? 'Need attention' : 'No data'}
          />
          <StatCard
            label="CSAT · This Week" colorClass={csatClass}
            value={csatPct !== null ? `${csatPct}%` : '—'}
            sub={csatTotal > 0 ? `👍 ${leaderboard.csatGood}  👎 ${leaderboard.csatBad}` : 'No ratings yet'}
          />
        </div>

        {/* ── Systems Bar ── */}
        {sysStatus && (
          <div className="ttv-systems-bar">
            <SysChip
              label="📱 Mobile App"
              isUp={mobileOk}
              statusWord={mobileWord}
              alert={mobileAlert}
            />
            <SysChip
              label="🔗 Integrations"
              isUp={integrOk}
              statusWord={integrWord}
              alert={integrAlert}
            />
            {didsUp && hubspotDids && (
              <div className="ttv-chip up">
                <div className="ttv-chip-accent" />
                <div className="ttv-chip-name">DIDs Available</div>
                <div className="ttv-chip-body">
                  <div className="ttv-chip-did-row">
                    <div className="ttv-chip-did-item">
                      <span className="ttv-chip-did-label">Pool</span>
                      <span className={`ttv-chip-did-count${hubspotDids.didPool != null && hubspotDids.didPool < 20 ? ' zero' : ''}`}>
                        {hubspotDids.didPool ?? '—'}
                      </span>
                    </div>
                    <div className="ttv-chip-did-divider" />
                    <div className="ttv-chip-did-item">
                      <span className="ttv-chip-did-label">Instant</span>
                      <span className={`ttv-chip-did-count${hubspotDids.instantDidPool != null && hubspotDids.instantDidPool < 20 ? ' zero' : ''}`}>
                        {hubspotDids.instantDidPool ?? '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Two-column content ── */}
        <div className="ttv-content">
          {/* Leaderboard */}
          <div className="ttv-panel">
            <div className="ttv-panel-accent" />
            <div className="ttv-corner ttv-corner-tl" />
            <div className="ttv-corner ttv-corner-tr" />
            <div className="ttv-corner ttv-corner-bl" />
            <div className="ttv-corner ttv-corner-br" />
            <div className="ttv-panel-header">
              <div className="ttv-panel-title">Leaderboard · This Week</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {(leaderboard.csatGood + leaderboard.csatBad) > 0 && (
                  <div className="ttv-panel-badge muted">
                    👍 {leaderboard.csatGood} · 👎 {leaderboard.csatBad}
                  </div>
                )}
                <div className="ttv-panel-badge muted">
                  {agents.length} agent{agents.length !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
            <div className="ttv-panel-body">
              {agents.length === 0 ? (
                <div className="ttv-empty">
                  <div className="ttv-empty-icon">👥</div>
                  <div className="ttv-empty-text">No activity this week yet</div>
                </div>
              ) : (
                <>
                  {/* Top performer spotlight */}
                  <div className="ttv-top-performer">
                    <div className="ttv-tp-crown">👑</div>
                    <div className="ttv-tp-body">
                      <div className="ttv-tp-label">Top Performer · This Week</div>
                      <div className="ttv-tp-name">{agents[0].name}</div>
                    </div>
                    <div className="ttv-tp-stats">
                      <div className="ttv-tp-stat">
                        <div className="ttv-tp-num">{agents[0].replies}</div>
                        <div className="ttv-tp-unit">replied</div>
                      </div>
                    </div>
                  </div>

                  {/* Full ranked list */}
                  {agents.map((agent, i) => (
                    <div key={agent.id} className={`ttv-lb-row${i === 0 ? ' first' : ''}`}>
                      <div className="ttv-lb-medal">
                        {i < 3 ? MEDALS[i] : <span className="ttv-lb-rank">{i + 1}</span>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="ttv-lb-name">{agent.name}</div>
                        <div className="ttv-lb-bar-track">
                          <div
                            className={`ttv-lb-bar-fill ${barClass(i)}`}
                            style={{ width: `${maxReplies > 0 ? (agent.replies / maxReplies) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                      <div className="ttv-lb-right">
                        <div className="ttv-lb-solved">{agent.replies}</div>
                        <div className="ttv-lb-solved-label">replied</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Stale tickets */}
          <div className="ttv-panel">
            <div className="ttv-panel-accent" />
            <div className="ttv-corner ttv-corner-tl" />
            <div className="ttv-corner ttv-corner-tr" />
            <div className="ttv-corner ttv-corner-bl" />
            <div className="ttv-corner ttv-corner-br" />
            <div className="ttv-panel-header">
              <div className="ttv-panel-title">Stale Tickets · 24h+ No Reply</div>
              <div className={`ttv-panel-badge ${staleCount === 0 ? 'green' : staleCount > 0 ? 'red' : 'muted'}`}>
                {stale.unconfigured ? 'N/A' : staleCount === 0 ? 'All fresh' : `${staleCount} stale`}
              </div>
            </div>
            <div className="ttv-panel-body">
              {stale.unconfigured && (
                <div className="ttv-empty">
                  <div className="ttv-empty-icon">🔗</div>
                  <div className="ttv-empty-text">Zendesk not configured</div>
                </div>
              )}
              {!stale.unconfigured && staleList.length === 0 && (
                <div className="ttv-empty">
                  <div className="ttv-empty-icon">✅</div>
                  <div className="ttv-empty-text">No stale tickets — great work!</div>
                </div>
              )}
              {!stale.unconfigured && staleList.map(t => (
                <a
                  key={t.id}
                  className="ttv-ticket-row"
                  href={zdSub ? `https://${zdSub}.zendesk.com/agent/tickets/${t.id}` : t.link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <div className={`ttv-ticket-dot ${t.status}`} />
                  <div className="ttv-ticket-subject" title={t.subject}>
                    {t.subject || `#${t.id}`}
                  </div>
                  <div className="ttv-ticket-age">{fmtTimeAgo(t.updatedAt)} ago</div>
                  <div className="ttv-ticket-arrow">↗</div>
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="ttv-footer">
          {lastSync && (
            <div className="ttv-sync-info" style={{ position: 'static' }}>
              Live · refreshes every {POLL_MS / 1000}s · Last sync: {lastSync}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
