import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { DialingIn } from '../components/DialingIn';
import './TeamLeaderboard.css';

const POLL_MS = 60000;

const PERIOD_OPTIONS = [
  { label: 'Today',      key: 'today'      },
  { label: 'This Week',  key: 'this-week'  },
  { label: 'Last Week',  key: 'last-week'  },
  { label: 'Last Month', key: 'last-month' },
  { label: '90d',        key: '90d'        },
  { label: '180d',       key: '180d'       },
  { label: 'All',        key: 'all'        },
];

const PERIOD_LABEL = {
  'today':      'Today',
  'this-week':  'This Week',
  'last-week':  'Last Week',
  'last-month': 'Last Month',
  '90d':        'Last 90 Days',
  '180d':       'Last 180 Days',
  'all':        'All Time',
};

// ── Account review period helpers ────────────────────────────────────────────
function getArRange(periodKey) {
  const now = new Date();
  if (periodKey === 'all') return { start: null, end: null };
  let start, end = null;
  if (periodKey === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (periodKey === 'this-week') {
    const dow = now.getDay();
    start = new Date(now);
    start.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    start.setHours(0, 0, 0, 0);
  } else if (periodKey === 'last-week') {
    const dow = now.getDay();
    start = new Date(now);
    start.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (periodKey === 'last-month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else if (periodKey === '90d') {
    start = new Date(now); start.setDate(now.getDate() - 90);
  } else if (periodKey === '180d') {
    start = new Date(now); start.setDate(now.getDate() - 180);
  }
  return { start: start || null, end };
}

function arInRange(dateStr, range) {
  if (!range.start) return true;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  if (d < range.start) return false;
  if (range.end && d > range.end) return false;
  return true;
}

function normName(n) {
  return (n || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildArLookup(arItems, range) {
  const map = new Map();
  arItems
    .filter(i => arInRange(i.dateOpened, range))
    .forEach(i => {
      const key = normName(i.openedBy);
      if (!key) return;
      if (!map.has(key)) map.set(key, { count: 0, scores: [] });
      const e = map.get(key);
      e.count++;
      if (i.buildQuality > 0) e.scores.push(i.buildQuality);
    });
  return map;
}

function lookupAr(agentName, agentEmail, arLookup) {
  const full = normName(agentName);
  if (arLookup.has(full)) return arLookup.get(full);

  // Try email prefix → name (e.g. "john.smith@..." → "john smith")
  if (agentEmail) {
    const prefix = normName(agentEmail.split('@')[0].replace(/[._-]/g, ' '));
    if (arLookup.has(prefix)) return arLookup.get(prefix);
    // Also try just first word of email prefix
    const prefFirst = prefix.split(' ')[0];
    if (prefFirst.length > 2) {
      for (const [key, val] of arLookup) {
        if (key.split(' ')[0] === prefFirst) return val;
      }
    }
  }

  // First-name-only fallback (when AR key is a single word)
  const firstName = full.split(' ')[0];
  if (firstName.length > 2 && arLookup.has(firstName)) return arLookup.get(firstName);

  return null;
}

// Build a photo lookup from Monday.com users: name→photoThumb + email→photoThumb
function buildPhotoLookup(mondayUsers = []) {
  const byName  = new Map();
  const byEmail = new Map();
  mondayUsers.forEach(u => {
    if (!u.photoThumb) return;
    if (u.name)  byName.set(normName(u.name),   u.photoThumb);
    if (u.email) byEmail.set(u.email.toLowerCase(), u.photoThumb);
  });
  return { byName, byEmail };
}

function resolvePhoto(agent, photoLookup) {
  // 1. Zendesk native photo
  if (agent.photoUrl) return agent.photoUrl;
  // 2. Monday.com by email
  if (agent.email && photoLookup.byEmail.has(agent.email.toLowerCase()))
    return photoLookup.byEmail.get(agent.email.toLowerCase());
  // 3. Monday.com by name
  const n = normName(agent.name);
  if (photoLookup.byName.has(n)) return photoLookup.byName.get(n);
  return null;
}

function RankBadge({ rank }) {
  const cls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  return <span className={`tl-rank ${cls}`}>{rank}</span>;
}

export default function TeamLeaderboard({ team = 'support' }) {
  const [sections,     setSections]     = useState([]);
  const [support,      setSupport]      = useState([]);
  const [escalation,   setEscalation]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [lastSync,     setLastSync]     = useState(null);
  const [period,       setPeriod]       = useState('today');
  const [csatGood,     setCsatGood]     = useState(0);
  const [csatBad,      setCsatBad]      = useState(0);
  const [zdSubdomain,  setZdSubdomain]  = useState(null);
  const [arItems,      setArItems]      = useState([]);
  const [mondayUsers,  setMondayUsers]  = useState([]);

  const fetchData = useCallback(async (p) => {
    setLoading(true);
    try {
      const [zdRes, arRes] = await Promise.all([
        api.get('/api/zendesk/leaderboard', { params: { period: p, team } }),
        api.get('/api/monday/account-review').catch(() => null),
      ]);
      setSections(zdRes.data?.sections   || []);
      setSupport(zdRes.data?.support     || []);
      setEscalation(zdRes.data?.escalation || []);
      setCsatGood(zdRes.data?.csatGood   || 0);
      setCsatBad(zdRes.data?.csatBad     || 0);
      setZdSubdomain(zdRes.data?.zdSubdomain || null);
      if (arRes?.data) {
        setArItems(arRes.data?.items      || []);
        setMondayUsers(arRes.data?.mondayUsers || []);
      }
      setError(null);
      setLastSync(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' EST');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, [team]);

  useEffect(() => {
    fetchData(period);
    const id = setInterval(() => fetchData(period), POLL_MS);
    return () => clearInterval(id);
  }, [fetchData, period]);

  // Build Zendesk search URL helper
  const zdUrl = zdSubdomain
    ? (q) => `https://${zdSubdomain}.zendesk.com/agent/search/1?q=${encodeURIComponent(q)}`
    : null;

  const zdAgentRepliedUrl = (agent) => zdUrl
    ? zdUrl(`type:ticket commenter:${agent.id}`)
    : null;
  const zdAgentOpenUrl   = (agent) => zdUrl
    ? zdUrl(`type:ticket assignee_id:${agent.id} status:open status:new`)
    : null;

  // Account review lookup (period-filtered, client-side)
  const arRange  = getArRange(period);
  const arLookup = buildArLookup(arItems, arRange);

  // Photo lookup from Monday.com users
  const photoLookup = buildPhotoLookup(mondayUsers);

  // For display: support team only (no escalation), tech uses all sections
  const displayAgents = team === 'tech' ? [...support, ...escalation] : support;
  const allAgents    = displayAgents;
  const maxReplies   = Math.max(...allAgents.map(a => a.replies), 1);
  const totalReplies = allAgents.reduce((s, a) => s + a.replies, 0);
  const totalOpen    = allAgents.reduce((s, a) => s + a.open, 0);
  const periodLabel  = PERIOD_LABEL[period] || period;

  function AgentRow({ agent, rank, isFirst }) {
    const eff        = agent.replies + agent.open > 0
      ? Math.round((agent.replies / (agent.replies + agent.open)) * 100)
      : null;
    const barPct     = maxReplies > 0 ? (agent.replies / maxReplies) * 100 : 0;
    const repliedHref = zdAgentRepliedUrl(agent);
    const openHref    = zdAgentOpenUrl(agent);
    const photo       = resolvePhoto(agent, photoLookup);

    const ar  = lookupAr(agent.name, agent.email, arLookup);
    const avg = ar?.scores.length
      ? (ar.scores.reduce((s, v) => s + v, 0) / ar.scores.length)
      : null;
    const arColor = avg === null ? '' : avg >= 4 ? 'green' : avg >= 3 ? 'amber' : 'red';

    return (
      <div className={`tl-row${isFirst ? ' first' : ''}`}>
        <div className="tl-col-rank"><RankBadge rank={rank} /></div>

        <div className="tl-col-name">
          <div className="tl-avatar">
            {photo
              ? <img src={photo} alt={agent.name} className="tl-avatar-img" onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
              : null
            }
            <span className="tl-avatar-initial" style={photo ? { display: 'none' } : {}}>
              {(agent.name || '?')[0].toUpperCase()}
            </span>
          </div>
          <div className="tl-name-cell">
            <span className="tl-name">{agent.name}</span>
            {zdUrl && (
              <a
                className="tl-agent-link"
                href={zdUrl(`type:ticket assignee_id:${agent.id}`)}
                target="_blank"
                rel="noopener noreferrer"
                title={`View all tickets assigned to ${agent.name} in Zendesk`}
              >
                all tickets ↗
              </a>
            )}
          </div>
        </div>

        <div className="tl-col-solved">
          {repliedHref ? (
            <a
              className="tl-solved-num tl-num-link"
              href={repliedHref}
              target="_blank"
              rel="noopener noreferrer"
              title={`${agent.replies} tickets with a public reply from ${agent.name} in ${periodLabel}`}
            >
              {agent.replies}
            </a>
          ) : (
            <span className="tl-solved-num">{agent.replies}</span>
          )}
        </div>

        <div className="tl-col-touched" title={`${agent.touched ?? '—'} tickets resolved/solved by ${agent.name} in ${periodLabel} · from Zendesk`}>
          <span className="tl-touched-num">{agent.touched ?? '—'}</span>
        </div>

        <div className="tl-col-bar">
          <div className="tl-bar-track" title={`${agent.replies} replied — bar shows volume relative to top performer`}>
            <div
              className={`tl-bar-fill ${rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'default'}`}
              style={{ width: `${barPct}%` }}
            />
          </div>
        </div>

        <div className="tl-col-open">
          {openHref ? (
            <a
              className={`tl-open-num tl-num-link ${agent.open > 10 ? 'high' : agent.open > 5 ? 'mid' : ''}`}
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              title={`${agent.open} tickets currently open or new assigned to ${agent.name} (all-time)`}
            >
              {agent.open}
            </a>
          ) : (
            <span className={`tl-open-num ${agent.open > 10 ? 'high' : agent.open > 5 ? 'mid' : ''}`}>{agent.open}</span>
          )}
        </div>

        <div className="tl-col-quality" title={ar ? `${ar.count} accounts opened · ${ar.scores.length} rated · avg ${avg?.toFixed(1) ?? '—'}/5 · from Account Review board` : 'No account review data matched'}>
          {ar ? (
            <div className="tl-quality-cell">
              <span className={`tl-quality-score ${arColor}`}>
                {avg !== null ? avg.toFixed(1) : '—'}
              </span>
              <span className="tl-quality-meta">{ar.count} accts</span>
            </div>
          ) : (
            <span className="tl-quality-score muted">—</span>
          )}
        </div>

        <div className="tl-col-eff">
          {eff !== null
            ? (
              <span
                className={`tl-eff ${eff >= 80 ? 'green' : eff >= 60 ? 'amber' : 'red'}`}
                title={`Reply rate: ${agent.replies} replied ÷ (${agent.replies} replied + ${agent.open} open) = ${eff}%`}
              >
                {eff}%
              </span>
            )
            : <span className="tl-eff muted">—</span>
          }
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Team Leaderboard</div>
          <div className="page-sub">
            {zdUrl ? (
              <a
                href={zdUrl('type:ticket')}
                target="_blank"
                rel="noopener noreferrer"
                className="tl-source-link"
              >
                {team === 'tech' ? 'Zendesk · Tech Team' : 'Zendesk · Trial Account + Escalation teams'}
              </a>
            ) : (
              team === 'tech' ? 'Zendesk · Tech Team' : 'Zendesk · Trial Account + Escalation teams'
            )}
            {' · '}Tickets &amp; account review quality · {POLL_MS / 1000}s refresh
          </div>
        </div>
        <div className="flex" style={{ gap: 10, alignItems: 'center' }}>
          {lastSync && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              Synced {lastSync}
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => fetchData(period)} disabled={loading}>
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
            className={`ar-period-btn${period === o.key ? ' active' : ''}`}
            onClick={() => setPeriod(o.key)}
          >{o.label}</button>
        ))}
        {!loading && allAgents.length > 0 && (
          <span className="ar-period-note">
            {allAgents.length} agent{allAgents.length !== 1 ? 's' : ''} · {totalReplies} replied · {totalOpen} open
          </span>
        )}
      </div>

      {/* Summary strip */}
      {!loading && allAgents.length > 0 && (() => {
        const csatTotal = csatGood + csatBad;
        const csatPct    = csatTotal > 0 ? Math.round((csatGood / csatTotal) * 100) : null;
        const effPct     = totalReplies + totalOpen > 0
          ? Math.round((totalReplies / (totalReplies + totalOpen)) * 100)
          : null;
        const topAgent   = allAgents[0];
        const csatHref   = zdUrl ? zdUrl('type:ticket has_csat:true') : null;
        const repliedHref = zdUrl ? zdUrl(`type:ticket status:solved`) : null;
        const openHref    = zdUrl ? zdUrl('type:ticket status:open status:new') : null;

        // AR team stats for the period
        const arPeriodItems = arItems.filter(i => arInRange(i.dateOpened, arRange));
        const arRated = arPeriodItems.filter(i => i.buildQuality > 0);
        const arTeamAvg = arRated.length
          ? arRated.reduce((s, i) => s + i.buildQuality, 0) / arRated.length
          : null;

        const SummaryCard = ({ href, children, className = '', title }) => {
          const cls = `tl-summary-card${className ? ' ' + className : ''}`;
          if (href) return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" title={title}>{children}</a>;
          return <div className={cls} title={title}>{children}</div>;
        };

        return (
          <div className="tl-summary mb-16">
            <SummaryCard
              href={repliedHref}
              title={`${totalReplies} tickets with a public reply across all agents in ${periodLabel}`}
            >
              <div className="tl-summary-label">Replied · {periodLabel}</div>
              <div className="tl-summary-value">{totalReplies}</div>
              <div className="tl-summary-sub">Tickets · public replies{repliedHref && ' · click ↗'}</div>
            </SummaryCard>

            <SummaryCard
              href={openHref}
              className={totalOpen > 20 ? 'accent-amber' : ''}
              title={`${totalOpen} tickets currently open or new across all agents — live queue`}
            >
              <div className="tl-summary-label">Open Queue · Live</div>
              <div className="tl-summary-value">{totalOpen}</div>
              <div className="tl-summary-sub">All-time assigned · not period-filtered{openHref && ' · click ↗'}</div>
            </SummaryCard>

            <SummaryCard
              href={csatHref}
              className={csatPct !== null ? (csatPct >= 80 ? 'accent-green' : csatPct >= 60 ? 'accent-amber' : 'accent-red') : ''}
              title={csatTotal > 0
                ? `CSAT: ${csatGood} positive / ${csatBad} negative = ${csatPct}% · ${periodLabel}`
                : 'No CSAT ratings in this period'
              }
            >
              <div className="tl-summary-label">Customer Satisfaction</div>
              <div className="tl-summary-value">{csatPct !== null ? `${csatPct}%` : '—'}</div>
              <div className="tl-summary-sub">
                {csatTotal > 0
                  ? `${csatGood} 👍 · ${csatBad} 👎${csatHref ? ' · click ↗' : ''}`
                  : 'No ratings yet this period'
                }
              </div>
            </SummaryCard>

            {arTeamAvg !== null ? (
              <SummaryCard
                className={arTeamAvg >= 4 ? 'accent-green' : arTeamAvg >= 3 ? 'accent-amber' : 'accent-red'}
                title={`Team build quality avg: ${arTeamAvg.toFixed(1)}/5 based on ${arRated.length} rated accounts · from Monday.com Account Review board`}
              >
                <div className="tl-summary-label">Build Quality · Avg</div>
                <div className="tl-summary-value">{arTeamAvg.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 400, color: 'var(--muted)' }}>/5</span></div>
                <div className="tl-summary-sub">{arRated.length} of {arPeriodItems.length} accounts rated · Monday.com</div>
              </SummaryCard>
            ) : (
              <SummaryCard
                className={effPct !== null ? (effPct >= 80 ? 'accent-green' : effPct >= 60 ? 'accent-amber' : 'accent-red') : ''}
                title={`Resolution rate = total replied ÷ (replied + open). Below 60% means backlog is growing.`}
              >
                <div className="tl-summary-label">Resolution Rate</div>
                <div className="tl-summary-value">{effPct !== null ? `${effPct}%` : '—'}</div>
                <div className="tl-summary-sub">
                  {effPct !== null
                    ? `Replied ÷ (replied+open)${topAgent ? ` · top: ${topAgent.name.split(' ')[0]}` : ''}`
                    : 'No data'
                  }
                </div>
              </SummaryCard>
            )}
          </div>
        );
      })()}

      {loading && <DialingIn />}

      {!loading && error && (
        <div className="ar-empty">
          <div className="ar-empty-icon">⚠️</div>
          <div className="ar-empty-text">{error}</div>
        </div>
      )}

      {!loading && !error && allAgents.length === 0 && (
        <div className="ar-empty">
          <div className="ar-empty-text">No agents with activity in this period</div>
        </div>
      )}

      {!loading && !error && allAgents.length > 0 && (
        <div className="tl-board">

          {/* Column headers */}
          <div className="tl-board-header">
            <span className="tl-col-rank">#</span>
            <span className="tl-col-name">Agent</span>
            <span className="tl-col-solved" title={`Tickets with a public reply in the selected period (${periodLabel}) · source: Tickets`}>
              Replied ↗
            </span>
            <span className="tl-col-touched" title={`Tickets resolved/closed by this agent in ${periodLabel} · source: Tickets`}>
              Solved
            </span>
            <span className="tl-col-bar" style={{ fontSize: 9, color: 'rgba(60,50,120,0.3)', paddingLeft: 2 }}>
              relative volume
            </span>
            <span className="tl-col-open" title="Tickets currently open or new — live, all-time queue">
              Open ↗
            </span>
            <span className="tl-col-quality" title="Avg build quality score from Account Review board · 1=poor 5=excellent">
              Quality
            </span>
            <span className="tl-col-eff" title="Reply rate = replied ÷ (replied + open). Green ≥80% · Amber 60–79% · Red &lt;60%">
              Rate
            </span>
          </div>

          {/* Tech team: delineated sections per Zendesk group */}
          {team === 'tech' && sections.length > 0 ? (
            sections.map(section => (
              <React.Fragment key={section.name}>
                <div className="tl-section-label">
                  <div>
                    <span>{section.name}</span>
                    <span className="tl-section-hint">Tickets · ranked by public replies in period</span>
                  </div>
                </div>
                {section.agents.map((agent, i) => (
                  <AgentRow key={agent.id} agent={agent} rank={i + 1} isFirst={i === 0} />
                ))}
              </React.Fragment>
            ))
          ) : (
            <>
              {support.length > 0 && (
                <div className="tl-section-label">
                  <div>
                    <span>Trial Account Team</span>
                    <span className="tl-section-hint">Tickets support queue · ranked by public replies in period</span>
                  </div>
                  {zdUrl && (
                    <a className="tl-section-link" href={zdUrl('type:ticket')} target="_blank" rel="noopener noreferrer">
                      View all tickets ↗
                    </a>
                  )}
                </div>
              )}
              {support.map((agent, i) => (
                <AgentRow key={agent.id} agent={agent} rank={i + 1} isFirst={i === 0} />
              ))}

            </>
          )}

          {/* Board footer */}
          <div className="tl-board-footer">
            <span>Replied = public ticket replies in <strong>{periodLabel}</strong> · Tickets incremental events API</span>
            <span>·</span>
            <span>Solved = tickets closed in <strong>{periodLabel}</strong> · Tickets search</span>
            <span>·</span>
            <span>Open = live queue (all-time assigned, not period-filtered) · Tickets search</span>
            <span>·</span>
            <span>Quality = avg build score /5 from Tasks board · {periodLabel}</span>
            <span>·</span>
            <span>Rate = replied ÷ (replied + open)</span>
            {zdUrl && (
              <>
                <span>·</span>
                <a href={zdUrl('type:ticket')} target="_blank" rel="noopener noreferrer" className="tl-footer-link">
                  Open Tickets ↗
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
