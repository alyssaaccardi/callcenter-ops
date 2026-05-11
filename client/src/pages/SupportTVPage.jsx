/**
 * SupportTVPage — Wall TV display for the Support team.
 * Accessible to: support, tv_display, super_admin roles; or valid TV token.
 * Shows: stat panels, system status, overdue tasks, daily leaderboard.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';
import './SupportTVPage.css';

const POLL_MS  = 15000;
const BOARD_ID = '18358060875';
const MEDALS   = ['🥇', '🥈', '🥉'];

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

function daysOverdue(str) {
  const due = new Date(str); due.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = Math.round((today - due) / 86400000);
  if (d <= 0) return 'Due today';
  return d === 1 ? '1 day overdue' : `${d} days overdue`;
}

function priorityClass(p = '') {
  const l = p.toLowerCase();
  if (l.includes('urgent')) return 'urgent';
  if (l.includes('high'))   return 'high';
  if (l.includes('med'))    return 'medium';
  return 'low';
}

function SysChip({ label, isUp, statusWord, alert }) {
  return (
    <div className={`stv-chip ${isUp ? 'up' : 'down'}`}>
      <div className="stv-chip-accent" />
      <div className="stv-chip-name">{label}</div>
      <div className="stv-chip-body">
        <div className="stv-chip-status-row">
          <div className={`stv-chip-orb ${isUp ? 'up' : 'down'}`} />
          <div className={`stv-chip-word ${isUp ? 'up' : 'down'}`}>{statusWord}</div>
        </div>
        {alert && <div className="stv-chip-alert">{alert}</div>}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, colorClass }) {
  return (
    <div className={`stv-stat ${colorClass}`}>
      <div className="stv-stat-accent" />
      <div className="stv-stat-label">{label}</div>
      <div className="stv-stat-orb-row">
        <div className={`stv-orb ${colorClass}`} />
        <div className="stv-stat-num">{value}</div>
      </div>
      {sub && <div className="stv-stat-sub">{sub}</div>}
    </div>
  );
}

export default function SupportTVPage() {
  const { user } = useAuth();
  const now = useClock();

  const [authed,    setAuthed]    = useState(false);
  const [authError, setAuthError] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [lastSync,  setLastSync]  = useState(null);

  const [tasks,       setTasks]       = useState([]);
  const [stats,       setStats]       = useState(null);
  const [staleCount,  setStaleCount]  = useState(null);
  const [sysStatus,   setSysStatus]   = useState(null);
  const [hubspotDids, setHubspotDids] = useState(null);
  const [leaderboard, setLeaderboard] = useState({ support: [], csatGood: 0, csatBad: 0 });

  const tvToken = () => new URLSearchParams(window.location.search).get('t');

  useEffect(() => {
    const allowed = ['support', 'tv_display', 'super_admin'];
    if (allowed.includes(user?.role)) { setAuthed(true); return; }

    const t = tvToken();
    if (!t) { setAuthError('Access denied.'); setLoading(false); return; }

    api.get(`/api/tv-session/validate?t=${t}`)
      .then(() => setAuthed(true))
      .catch(() => { setAuthError('Token invalid or expired.'); setLoading(false); });
  }, [user]);

  const fetchAll = useCallback(async () => {
    const t = tvToken();
    const q      = t ? `?t=${t}` : '';
    const tParam = t ? `&t=${t}` : '';
    const tObj   = t ? { t } : {};

    const [tasksRes, statsRes, staleRes, statusRes, hsDidRes, lbRes] = await Promise.allSettled([
      api.get(`/api/monday/support-tasks${q}`),
      api.get(`/api/monday/support-stats${q}`),
      api.get(`/api/zendesk/stale-tickets?team=support${tParam}`),
      api.get('/api/status'),
      api.get('/api/hubspot/dids'),
      api.get('/api/zendesk/leaderboard', { params: { team: 'support', period: 'today', ...tObj } }),
    ]);

    if (tasksRes.status === 'fulfilled') setTasks(tasksRes.value.data?.tasks || []);
    if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
    if (staleRes.status === 'fulfilled') {
      const d = staleRes.value.data;
      setStaleCount(d.unconfigured ? null : (d.tickets?.length ?? 0));
    }
    if (statusRes.status === 'fulfilled') setSysStatus(statusRes.value.data);
    if (hsDidRes.status  === 'fulfilled') setHubspotDids(hsDidRes.value.data);
    if (lbRes.status     === 'fulfilled') {
      const d = lbRes.value.data;
      setLeaderboard({ support: d.support || [], csatGood: d.csatGood || 0, csatBad: d.csatBad || 0 });
    }
    setLastSync(new Date().toLocaleTimeString());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchAll();
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [authed, fetchAll]);

  if (authError) return <div className="stv-loading"><span>{authError}</span></div>;
  if (loading)   return <div className="stv-loading"><div className="stv-spinner" /><span>Dialing in...</span></div>;

  const overdueCount = tasks.length;
  const doneCount    = stats?.byStatus?.find(s => s.label === 'Done')?.count ?? 0;

  const overdueClass = overdueCount > 0 ? 'red' : 'green';
  const staleClass   = staleCount !== null && staleCount > 0 ? 'amber' : staleCount === 0 ? 'green' : 'muted';
  const doneClass    = doneCount > 0 ? 'green' : 'muted';

  const agents     = leaderboard.support;
  const maxSolved  = Math.max(...agents.map(a => a.solved), 1);
  const barClass   = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'default';

  const mobileServiceUp = sysStatus?.mobileApp?.state        !== 'DOWN';
  const mobileTextsUp   = sysStatus?.mobileApp?.messagesDown !== true;
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
    <div className="stv-page">
      <div className="stv-stripe-top" />
      <div className="stv-stripe-bottom" />
      <div className="stv-diag-lines" />

      <div className="stv-wrapper">
        {/* ── Header ── */}
        <header className="stv-header">
          <div className="stv-header-left">
            <img
              className="stv-logo"
              src="/dialedin-logo-dark.png"
              alt="AL"
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div>
              <div className="stv-header-brand">Answering Legal</div>
              <div className="stv-header-sub">Support Team · Live Wall Display</div>
            </div>
          </div>

          <div className="stv-header-center">
            <div className="stv-header-title">Support Display</div>
            {sysStatus && (
              <div className={`stv-global-pill ${allOk ? 'up' : 'down'}`} style={{ marginTop: 8 }}>
                <div className="stv-global-dot" />
                {allOk ? 'All Systems Operational' : 'System Degraded'}
              </div>
            )}
          </div>

          <div className="stv-header-right">
            <div className="stv-dual-clock">
              <div className="stv-clock-entry">
                <span className="stv-clock-label">EST</span>
                <span className="stv-clock">{fmtClock(now, 'America/New_York')}</span>
              </div>
              <div className="stv-clock-sep" />
              <div className="stv-clock-entry">
                <span className="stv-clock-label">BZ</span>
                <span className="stv-clock">{fmtClock(now, 'America/Belize')}</span>
              </div>
            </div>
            <div className="stv-date">{fmtDate(now)}</div>
          </div>
        </header>

        {/* ── Stat Strip ── */}
        <div className="stv-stat-strip">
          <StatCard
            label="Overdue Tasks" colorClass={overdueClass}
            value={overdueCount}
            sub={overdueCount === 0 ? 'All clear!' : `${overdueCount} need attention`}
          />
          <StatCard
            label="Stale Tickets" colorClass={staleClass}
            value={staleCount !== null ? staleCount : '—'}
            sub={staleCount === 0 ? 'All fresh' : staleCount > 0 ? 'Need follow-up' : 'No data'}
          />
          <StatCard
            label="Done Today" colorClass={doneClass}
            value={doneCount}
            sub="Tasks completed"
          />
        </div>

        {/* ── Systems Bar ── */}
        {sysStatus && (
          <div className="stv-systems-bar">
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
              <div className="stv-chip up">
                <div className="stv-chip-accent" />
                <div className="stv-chip-name">DIDs Available</div>
                <div className="stv-chip-body">
                  <div className="stv-chip-did-row">
                    <div className="stv-chip-did-item">
                      <span className="stv-chip-did-label">Pool</span>
                      <span className={`stv-chip-did-count${hubspotDids.didPool != null && hubspotDids.didPool < 20 ? ' zero' : ''}`}>
                        {hubspotDids.didPool ?? '—'}
                      </span>
                    </div>
                    <div className="stv-chip-did-divider" />
                    <div className="stv-chip-did-item">
                      <span className="stv-chip-did-label">Instant</span>
                      <span className={`stv-chip-did-count${hubspotDids.instantDidPool != null && hubspotDids.instantDidPool < 20 ? ' zero' : ''}`}>
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
        <div className="stv-content">
          {/* Overdue tasks */}
          <div className="stv-panel">
            <div className="stv-panel-accent" />
            <div className="stv-corner stv-corner-tl" />
            <div className="stv-corner stv-corner-tr" />
            <div className="stv-corner stv-corner-bl" />
            <div className="stv-corner stv-corner-br" />
            <div className="stv-panel-header">
              <div className="stv-panel-title">Overdue Tasks</div>
              <div className={`stv-panel-badge ${overdueCount === 0 ? 'clear' : 'red'}`}>
                {overdueCount === 0 ? 'All Clear' : `${overdueCount} Overdue`}
              </div>
            </div>
            <div className="stv-panel-body">
              {overdueCount === 0 ? (
                <div className="stv-empty">
                  <div className="stv-empty-icon">✅</div>
                  <div className="stv-empty-text">No overdue tasks — great work!</div>
                </div>
              ) : (
                tasks.map(task => (
                  <a
                    key={task.id}
                    className="stv-task-card"
                    href={`https://answeringlegal-unit.monday.com/boards/${BOARD_ID}/pulses/${task.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <div className="stv-task-name" title={task.name}>{task.name}</div>
                    {task.priority && (
                      <div className={`stv-task-pill ${priorityClass(task.priority)}`}>{task.priority}</div>
                    )}
                    {task.dueDate && (
                      <div className="stv-task-due">{daysOverdue(task.dueDate)}</div>
                    )}
                    <div className="stv-task-arrow">↗</div>
                  </a>
                ))
              )}
            </div>
          </div>

          {/* Daily leaderboard */}
          <div className="stv-panel">
            <div className="stv-panel-accent" />
            <div className="stv-corner stv-corner-tl" />
            <div className="stv-corner stv-corner-tr" />
            <div className="stv-corner stv-corner-bl" />
            <div className="stv-corner stv-corner-br" />
            <div className="stv-panel-header">
              <div className="stv-panel-title">Today's Leaderboard · Tickets Solved</div>
              <div className="stv-panel-badge muted">
                {agents.length} agent{agents.length !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="stv-panel-body">
              {agents.length === 0 ? (
                <div className="stv-empty">
                  <div className="stv-empty-icon">🏆</div>
                  <div className="stv-empty-text">No tickets solved yet today</div>
                </div>
              ) : (
                agents.map((agent, i) => (
                  <div key={agent.id} className={`stv-lb-row${i === 0 ? ' first' : ''}`}>
                    <div className="stv-lb-medal">
                      {i < 3 ? MEDALS[i] : <span className="stv-lb-rank">{i + 1}</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="stv-lb-name">{agent.name}</div>
                      <div className="stv-lb-bar-track">
                        <div
                          className={`stv-lb-bar-fill ${barClass(i)}`}
                          style={{ width: `${maxSolved > 0 ? (agent.solved / maxSolved) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="stv-lb-right">
                      <div className="stv-lb-solved">{agent.solved}</div>
                      <div className="stv-lb-solved-label">solved</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="stv-footer">
          {lastSync && (
            <div className="stv-sync-info" style={{ position: 'static' }}>
              Live · refreshes every {POLL_MS / 1000}s · Last sync: {lastSync}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
