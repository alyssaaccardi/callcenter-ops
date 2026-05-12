import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import './AccountReview.css';

const POLL_MS = 60000;
const MONDAY_BOARD_URL = 'https://answeringlegal-unit.monday.com/boards/18358060875';

const PERIOD_OPTIONS = [
  { label: 'This Week',  key: 'this-week'  },
  { label: 'Last Week',  key: 'last-week'  },
  { label: 'Last Month', key: 'last-month' },
  { label: '90d',        key: '90d'        },
  { label: '180d',       key: '180d'       },
  { label: 'All',        key: 'all'        },
];

const SORT_MODES = [
  { key: 'quality',    label: 'Quality',    title: 'Rank by average build quality score' },
  { key: 'volume',     label: 'Volume',     title: 'Rank by number of accounts opened' },
  { key: 'efficiency', label: 'Efficiency', title: 'Rank by quality × volume — rewards agents who produce high quality at high volume' },
];

function getRange(key) {
  const now = new Date();
  if (key === 'all') return null;
  if (key === '90d')  { const s = new Date(now); s.setDate(s.getDate() - 90);  return { start: s, end: now }; }
  if (key === '180d') { const s = new Date(now); s.setDate(s.getDate() - 180); return { start: s, end: now }; }
  if (key === 'this-week') {
    const s = new Date(now);
    s.setDate(s.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    s.setHours(0, 0, 0, 0);
    return { start: s, end: now };
  }
  if (key === 'last-week') {
    const s = new Date(now);
    s.setDate(s.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1) - 7);
    s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setDate(s.getDate() + 6); e.setHours(23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (key === 'last-month') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start: s, end: e };
  }
  return null;
}

function inRange(dateStr, range) {
  if (!range) return true;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return d >= range.start && d <= range.end;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function waitingLabel(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (days <= 0) return null;
  if (days < 7)  return { label: `${days}d waiting`, cls: days >= 3 ? 'amber' : '' };
  return { label: `${Math.floor(days / 7)}w waiting`, cls: 'red' };
}

function scoreLabel(avg) {
  if (avg === null) return null;
  if (avg >= 4.5) return { label: 'Excellent', cls: 'excellent' };
  if (avg >= 3.5) return { label: 'Good',      cls: 'good' };
  if (avg >= 2.5) return { label: 'Fair',       cls: 'fair' };
  return              { label: 'Low',        cls: 'low' };
}

function QualityBar({ value, count, total, max = 5 }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const color = value >= 4 ? 'green' : value >= 3 ? 'amber' : 'red';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="ar-bar-track">
          <div className={`ar-bar-fill ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="ar-bar-label">{value.toFixed(1)}<span className="ar-bar-max">/5</span></span>
      </div>
      {count != null && (
        <div className="ar-bar-count">
          {total != null && total > count
            ? `${count} of ${total} accounts rated`
            : `based on ${count} account${count !== 1 ? 's' : ''}`
          }
        </div>
      )}
    </div>
  );
}

function EfficiencyBar({ score, maxScore }) {
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const color = pct >= 70 ? 'green' : pct >= 40 ? 'amber' : 'red';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="ar-bar-track">
          <div className={`ar-bar-fill ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="ar-bar-label ar-eff-score">{score.toFixed(1)}</span>
      </div>
      <div className="ar-bar-count">quality × volume score</div>
    </div>
  );
}

export default function AccountReview() {
  const [items,      setItems]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastSync,   setLastSync]   = useState(null);
  const [periodKey,  setPeriodKey]  = useState('this-week');
  const [reviewTab,  setReviewTab]  = useState('trial'); // 'trial' | 'pending'
  const [sortMode,  setSortMode]  = useState('quality');

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get('/api/monday/account-review');
      setItems(res.data?.items || []);
      setError(null);
      setLastSync(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' EST');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const range = getRange(periodKey);
  const periodItems = items.filter(i => inRange(i.dateOpened, range));

  const agentMap = {};
  periodItems.forEach(item => {
    if (!item.openedBy) return;
    if (!agentMap[item.openedBy]) agentMap[item.openedBy] = { name: item.openedBy, scores: [], count: 0 };
    agentMap[item.openedBy].count++;
    if (item.buildQuality !== null && item.buildQuality > 0) {
      agentMap[item.openedBy].scores.push(item.buildQuality);
    }
  });

  const agentList = Object.values(agentMap).map(a => ({
    name:       a.name,
    count:      a.count,
    rated:      a.scores.length,
    avg:        a.scores.length ? a.scores.reduce((s, v) => s + v, 0) / a.scores.length : null,
    // Efficiency = avg quality × account count (rewards high quality + high volume)
    efficiency: a.scores.length ? (a.scores.reduce((s, v) => s + v, 0) / a.scores.length) * a.count : null,
  }));

  const maxEfficiency = Math.max(...agentList.map(a => a.efficiency ?? 0), 1);

  const leaderboard = [...agentList].sort((a, b) => {
    if (sortMode === 'volume') {
      return b.count - a.count;
    }
    if (sortMode === 'efficiency') {
      if (a.efficiency !== null && b.efficiency !== null) return b.efficiency - a.efficiency;
      if (a.efficiency !== null) return -1;
      if (b.efficiency !== null) return  1;
      return b.count - a.count;
    }
    // quality (default)
    if (a.avg !== null && b.avg !== null) return b.avg - a.avg;
    if (a.avg !== null) return -1;
    if (b.avg !== null) return  1;
    return b.count - a.count;
  });

  const isPendingStage = s => {
    const l = (s || '').toLowerCase();
    return l.includes('support') || l.includes('sales');
  };
  const isCoverageStatus = s => (s || '').toLowerCase().trim() === 'trial';

  const byOldest = (a, b) => {
    if (!a.dateOpened && !b.dateOpened) return 0;
    if (!a.dateOpened) return  1;
    if (!b.dateOpened) return -1;
    return new Date(a.dateOpened) - new Date(b.dateOpened);
  };

  // In Trial — all accounts currently in Trial status (all-time, not period-filtered)
  const inTrialReview = items.filter(i => isCoverageStatus(i.status)).sort(byOldest);

  // Pending Salesmen / Support — accounts flagged "In Review" with a pending deal stage
  const pendingReview = items.filter(i =>
    i.status?.toLowerCase().includes('review') && isPendingStage(i.dealStage)
  ).sort(byOldest);

  const activeReviewList = reviewTab === 'trial' ? inTrialReview : pendingReview;

  const ratedItems     = periodItems.filter(i => i.buildQuality !== null && i.buildQuality > 0);
  const teamAvg        = ratedItems.length ? ratedItems.reduce((s, i) => s + i.buildQuality, 0) / ratedItems.length : null;

  // Coverage % — only denominator accounts with active-deal statuses that should have a rating
  const coverageBase   = periodItems.filter(i => isCoverageStatus(i.status));
  const coverageRated  = coverageBase.filter(i => i.buildQuality !== null && i.buildQuality > 0);
  const coveragePct    = coverageBase.length > 0 ? Math.round((coverageRated.length / coverageBase.length) * 100) : null;
  const pendingSupport = pendingReview.filter(i => (i.dealStage || '').toLowerCase().includes('support')).length;
  const pendingSales   = pendingReview.filter(i => (i.dealStage || '').toLowerCase().includes('sales')).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Account Review Board</div>
          <div className="page-sub">
            <a href={MONDAY_BOARD_URL} target="_blank" rel="noopener noreferrer" className="ar-page-source-link">
              Monday.com · Account Review
            </a>
            {' · '}Build quality scored 1–5 by ops · auto-refreshes every {POLL_MS / 1000}s
          </div>
        </div>
        <div className="flex" style={{ gap: 10, alignItems: 'center' }}>
          {lastSync && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              Synced {lastSync}
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={fetchData} disabled={loading}>
            {loading ? <span className="spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      {/* Period filter */}
      <div className="ar-period-bar mb-16">
        <span className="ar-period-label">Period</span>
        {PERIOD_OPTIONS.map(o => (
          <button
            key={o.key}
            className={`ar-period-btn${periodKey === o.key ? ' active' : ''}`}
            onClick={() => setPeriodKey(o.key)}
          >{o.label}</button>
        ))}
        {!loading && (
          <span className="ar-period-note">
            {periodItems.length} accounts
            {teamAvg !== null && <> · Team avg <strong>{teamAvg.toFixed(1)}/5</strong></>}
            {coveragePct !== null && (
              <> · <span
                className={`ar-coverage-inline ${coveragePct >= 75 ? 'green' : coveragePct >= 40 ? 'amber' : 'red'}`}
                title={`${coverageRated.length} of ${coverageBase.length} Trial accounts have a build quality score`}
              >{coveragePct}% rated</span></>
            )}
          </span>
        )}
      </div>

      {loading && (
        <div className="ar-empty" style={{ paddingTop: 60 }}>
          <div className="sc-spinner" style={{ width: 24, height: 24, margin: '0 auto 8px' }} />
          <div className="ar-empty-text">Dialing in...</div>
        </div>
      )}

      {!loading && error && (
        <div className="ar-empty">
          <div className="ar-empty-icon">⚠️</div>
          <div className="ar-empty-text">{error}</div>
        </div>
      )}

      {!loading && !error && (
        <div className="ar-two-col">

          {/* Build Quality Leaderboard */}
          <div className="ar-panel">
            <div className="ar-panel-header">
              <div>
                <div className="ar-panel-title">Build Quality · by Agent</div>
                <div className="ar-source-line">
                  Scored on{' '}
                  <a href={MONDAY_BOARD_URL} target="_blank" rel="noopener noreferrer" className="ar-source-link">
                    Monday.com
                  </a>
                  {' '}· 1 = poor · 5 = excellent
                </div>
              </div>
              <div className="ar-panel-header-right">
                <div className="ar-panel-badge">{leaderboard.length} agents</div>
                {coveragePct !== null && (
                  <div
                    className={`ar-coverage-badge ${coveragePct >= 75 ? 'green' : coveragePct >= 40 ? 'amber' : 'red'}`}
                    title={`${coverageRated.length} of ${coverageBase.length} Trial accounts have a build quality score`}
                  >
                    {coveragePct}% rated
                  </div>
                )}
              </div>
            </div>

            {/* Sort mode toggle */}
            <div className="ar-sort-bar">
              <span className="ar-sort-label">Rank by</span>
              {SORT_MODES.map(m => (
                <button
                  key={m.key}
                  className={`ar-sort-btn${sortMode === m.key ? ' active' : ''}`}
                  onClick={() => setSortMode(m.key)}
                  title={m.title}
                >
                  {m.label}
                </button>
              ))}
              <span className="ar-sort-hint">
                {sortMode === 'quality'    && 'Highest avg score first'}
                {sortMode === 'volume'     && 'Most accounts opened first'}
                {sortMode === 'efficiency' && 'Quality × volume — rewards both'}
              </span>
            </div>

            {leaderboard.length === 0 && (
              <div className="ar-empty ar-empty-sm">
                <div className="ar-empty-text">No accounts in this period</div>
              </div>
            )}

            {leaderboard.map((agent, i) => {
              const sl = scoreLabel(agent.avg);
              const rank = i + 1;

              return (
                <div key={`${periodKey}-${sortMode}-${agent.name}`} className={`ar-agent-row${agent.avg === null && sortMode !== 'volume' ? ' unrated' : ''}`}>
                  <div className={`ar-agent-rank${rank === 1 ? ' gold' : rank === 2 ? ' silver' : rank === 3 ? ' bronze' : ''}`}>
                    {rank}
                  </div>
                  <div className="ar-agent-info">
                    <div className="ar-agent-name">{agent.name}</div>
                    <div className="ar-agent-meta">
                      <span className="ar-meta-vol">{agent.count} opened</span>
                      {agent.rated > 0 && agent.count > agent.rated && (
                        <span className="ar-meta-gap"> · {agent.count - agent.rated} unrated</span>
                      )}
                      {agent.rated === 0 && (
                        <span className="ar-meta-gap"> · none rated</span>
                      )}
                    </div>
                  </div>
                  <div className="ar-agent-quality">
                    {sortMode === 'efficiency' && agent.efficiency !== null ? (
                      <div>
                        {sl && <span className={`ar-score-label ${sl.cls}`}>{sl.label}</span>}
                        <EfficiencyBar score={agent.efficiency} maxScore={maxEfficiency} />
                      </div>
                    ) : sortMode === 'volume' ? (
                      <div className="ar-volume-display">
                        <span className="ar-volume-num">{agent.count}</span>
                        <span className="ar-volume-label">accounts</span>
                        {agent.avg !== null && (
                          <span className={`ar-score-label ${sl?.cls || ''}`} style={{ marginLeft: 8 }}>{agent.avg.toFixed(1)}/5</span>
                        )}
                      </div>
                    ) : agent.avg !== null ? (
                      <div>
                        {sl && <span className={`ar-score-label ${sl.cls}`}>{sl.label}</span>}
                        <QualityBar value={agent.avg} count={agent.rated} total={agent.count} />
                      </div>
                    ) : (
                      <span className="ar-no-rating">Not yet rated</span>
                    )}
                  </div>
                </div>
              );
            })}

            {leaderboard.length > 0 && (
              <div className="ar-panel-footer">
                {sortMode === 'efficiency'
                  ? 'Efficiency = avg quality score × accounts opened · rewards agents who do a lot and do it well'
                  : sortMode === 'volume'
                  ? 'Volume mode — ranking by accounts opened · quality score shown where rated'
                  : 'Quality mode · unranked agents (shown at bottom) have no build quality scores yet'
                }
              </div>
            )}
          </div>

          {/* Accounts To Review */}
          <div className="ar-panel">
            <div className="ar-panel-header">
              <div>
                <div className="ar-panel-title">Needs Review</div>
                <div className="ar-source-line">
                  {reviewTab === 'trial'
                    ? 'All accounts currently In Trial · all-time · oldest first'
                    : 'Accounts flagged In Review · awaiting Salesmen or Ops action'
                  }
                </div>
              </div>
              <div className="ar-panel-header-right">
                <div className={`ar-panel-badge${activeReviewList.length > 0 ? ' amber' : ' green'}`}>
                  {activeReviewList.length > 0 ? `${activeReviewList.length} accounts` : 'All clear'}
                </div>
              </div>
            </div>

            {/* Tab toggle */}
            <div className="ar-review-tabs">
              <button
                className={`ar-review-tab${reviewTab === 'trial' ? ' active' : ''}`}
                onClick={() => setReviewTab('trial')}
                title="Accounts currently in Trial status"
              >
                In Trial
                {inTrialReview.length > 0 && <span className="ar-tab-count">{inTrialReview.length}</span>}
              </button>
              <button
                className={`ar-review-tab${reviewTab === 'pending' ? ' active' : ''}`}
                onClick={() => setReviewTab('pending')}
                title="Accounts awaiting Salesmen or Ops review"
              >
                Pending Salesmen / Ops
                {pendingReview.length > 0 && <span className={`ar-tab-count${pendingReview.length > 0 ? ' amber' : ''}`}>{pendingReview.length}</span>}
              </button>
            </div>

            {/* Action bar — only shown in pending tab */}
            {reviewTab === 'pending' && pendingReview.length > 0 && (
              <div className="ar-review-action-bar">
                {pendingSupport > 0 && (
                  <span className="ar-action-chip amber">
                    <strong>{pendingSupport}</strong> → Ops team
                  </span>
                )}
                {pendingReview.filter(i => (i.dealStage || '').toLowerCase().includes('sales')).length > 0 && (
                  <span className="ar-action-chip blue">
                    <strong>{pendingReview.filter(i => (i.dealStage || '').toLowerCase().includes('sales')).length}</strong> → Sales team
                  </span>
                )}
              </div>
            )}

            {activeReviewList.length === 0 && (
              <div className="ar-empty ar-empty-sm">
                <div className="ar-empty-text">
                  {reviewTab === 'trial' ? 'No accounts currently in trial need review' : 'No accounts pending review'}
                </div>
              </div>
            )}

            {activeReviewList.map(item => {
              const waiting = waitingLabel(item.dateOpened);
              const isSales = isPendingStage(item.dealStage) && (item.dealStage || '').toLowerCase().includes('sales');
              return (
                <a
                  key={item.id}
                  className="ar-review-row"
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open in Monday.com · ${item.dealStage || item.status || ''} · Opened by ${item.openedBy || 'unknown'}`}
                >
                  <div className="ar-review-main">
                    <div className="ar-review-name">{item.name || `#${item.id}`}</div>
                    <div className="ar-review-meta">
                      {item.openedBy && <span>{item.openedBy}</span>}
                      {item.dateOpened && <span>{fmtDate(item.dateOpened)}</span>}
                      {item.buildQuality !== null && item.buildQuality > 0 && (
                        <span className="ar-review-quality">★ {item.buildQuality}/5</span>
                      )}
                    </div>
                  </div>
                  <div className="ar-review-badges">
                    {waiting && (
                      <span className={`ar-review-waiting${waiting.cls ? ' ' + waiting.cls : ''}`}>{waiting.label}</span>
                    )}
                    {reviewTab === 'pending' && item.dealStage && (
                      <span
                        className={`ar-review-stage ${isSales ? 'blue' : 'amber'}`}
                        title={isSales ? 'Action required: Sales team' : 'Action required: Ops team'}
                      >
                        {item.dealStage}
                      </span>
                    )}
                    {reviewTab === 'trial' && item.buildQuality == null && (
                      <span className="ar-review-stage amber">Unrated</span>
                    )}
                  </div>
                  <div className="ar-review-arrow">↗</div>
                </a>
              );
            })}

            {reviewTab === 'pending' && pendingReview.length > 0 && (
              <div className="ar-panel-footer ar-review-legend">
                <span className="ar-legend-dot amber" /> Pending-Support → Ops team
                <span className="ar-legend-dot blue" style={{ marginLeft: 12 }} /> Pending-Salesmen → Sales team
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
