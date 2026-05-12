import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
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

  const fetchData = useCallback(async (p) => {
    setLoading(true);
    try {
      const res = await api.get('/api/zendesk/leaderboard', { params: { period: p, team } });
      setSections(res.data?.sections   || []);
      setSupport(res.data?.support     || []);
      setEscalation(res.data?.escalation || []);
      setCsatGood(res.data?.csatGood   || 0);
      setCsatBad(res.data?.csatBad     || 0);
      setZdSubdomain(res.data?.zdSubdomain || null);
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

  const allAgents    = [...support, ...escalation];
  const maxReplies   = Math.max(...allAgents.map(a => a.replies), 1);
  const totalReplies = allAgents.reduce((s, a) => s + a.replies, 0);
  const totalOpen    = allAgents.reduce((s, a) => s + a.open, 0);
  const periodLabel  = PERIOD_LABEL[period] || period;

  function AgentRow({ agent, rank, isFirst }) {
    const eff     = agent.replies + agent.open > 0
      ? Math.round((agent.replies / (agent.replies + agent.open)) * 100)
      : null;
    const barPct  = maxReplies > 0 ? (agent.replies / maxReplies) * 100 : 0;
    const repliedHref = zdAgentRepliedUrl(agent);
    const openHref    = zdAgentOpenUrl(agent);

    return (
      <div className={`tl-row${isFirst ? ' first' : ''}`}>
        <div className="tl-col-rank"><RankBadge rank={rank} /></div>

        <div className="tl-col-name">
          <div className="tl-avatar">{(agent.name || '?')[0].toUpperCase()}</div>
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
              title={`${agent.replies} tickets with a public reply from ${agent.name} in ${periodLabel} — click to open in Zendesk`}
            >
              {agent.replies}
            </a>
          ) : (
            <span className="tl-solved-num">{agent.replies}</span>
          )}
        </div>

        <div className="tl-col-touched" title={`${agent.touched} tickets assigned to ${agent.name} that were active in ${periodLabel}`}>
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
              title={`${agent.open} tickets currently open or new assigned to ${agent.name} (all-time, not period-filtered) — click to open in Zendesk`}
            >
              {agent.open}
            </a>
          ) : (
            <span className={`tl-open-num ${agent.open > 10 ? 'high' : agent.open > 5 ? 'mid' : ''}`}>{agent.open}</span>
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
            {' · '}public replies &amp; open tickets per agent · {POLL_MS / 1000}s refresh
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

        const SummaryCard = ({ href, children, className = '', title }) => {
          const cls = `tl-summary-card${className ? ' ' + className : ''}`;
          if (href) return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" title={title}>{children}</a>;
          return <div className={cls} title={title}>{children}</div>;
        };

        return (
          <div className="tl-summary mb-16">
            <SummaryCard
              href={repliedHref}
              title={`${totalReplies} tickets with a public reply across all agents in ${periodLabel} — data from Zendesk · click to view in Zendesk`}
            >
              <div className="tl-summary-label">Replied · {periodLabel}</div>
              <div className="tl-summary-value">{totalReplies}</div>
              <div className="tl-summary-sub">Zendesk · tickets with reply{repliedHref && ' · click to view ↗'}</div>
            </SummaryCard>

            <SummaryCard
              href={openHref}
              className={totalOpen > 20 ? 'accent-amber' : ''}
              title={`${totalOpen} tickets currently open or new across all agents — this is the live queue, not period-filtered · click to view in Zendesk`}
            >
              <div className="tl-summary-label">Open Queue · Live</div>
              <div className="tl-summary-value">{totalOpen}</div>
              <div className="tl-summary-sub">All-time assigned · not period-filtered{openHref && ' · click ↗'}</div>
            </SummaryCard>

            <SummaryCard
              href={csatHref}
              className={csatPct !== null ? (csatPct >= 80 ? 'accent-green' : csatPct >= 60 ? 'accent-amber' : 'accent-red') : ''}
              title={csatTotal > 0
                ? `CSAT: ${csatGood} positive / ${csatBad} negative = ${csatPct}% satisfaction · ${periodLabel} · from Zendesk satisfaction ratings${csatHref ? ' · click to view' : ''}`
                : 'No CSAT ratings in this period'
              }
            >
              <div className="tl-summary-label">Customer Satisfaction</div>
              <div className="tl-summary-value">{csatPct !== null ? `${csatPct}%` : '—'}</div>
              <div className="tl-summary-sub">
                {csatTotal > 0
                  ? `${csatGood} 👍 · ${csatBad} 👎 · ${csatTotal} ratings${csatHref ? ' · click ↗' : ''}`
                  : 'No ratings yet this period'
                }
              </div>
            </SummaryCard>

            <SummaryCard
              className={effPct !== null ? (effPct >= 80 ? 'accent-green' : effPct >= 60 ? 'accent-amber' : 'accent-red') : ''}
              title={`Resolution rate = total solved ÷ (solved + open). ${effPct}% means ${effPct}% of all assigned work is resolved. Below 60% means backlog is growing.`}
            >
              <div className="tl-summary-label">Resolution Rate</div>
              <div className="tl-summary-value">{effPct !== null ? `${effPct}%` : '—'}</div>
              <div className="tl-summary-sub">
                {effPct !== null
                  ? `Solved ÷ (solved+open)${topAgent ? ` · top: ${topAgent.name.split(' ')[0]}` : ''}`
                  : 'No data'
                }
              </div>
            </SummaryCard>
          </div>
        );
      })()}

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

      {!loading && !error && allAgents.length === 0 && (
        <div className="ar-empty">
          <div className="ar-empty-text">No agents with activity in this period</div>
        </div>
      )}

      {!loading && !error && allAgents.length > 0 && (
        <div className="tl-board">

          {/* Column headers with context */}
          <div className="tl-board-header">
            <span className="tl-col-rank">#</span>
            <span className="tl-col-name">Agent</span>
            <span className="tl-col-solved" title={`Tickets with a public reply in the selected period (${periodLabel}) · source: Zendesk · click each number to view in Zendesk`}>
              Replied ↗
            </span>
            <span className="tl-col-touched" title={`Tickets assigned to this agent that were active in ${periodLabel} — broader activity signal`}>
              Touched
            </span>
            <span className="tl-col-bar" style={{ fontSize: 9, color: 'rgba(60,50,120,0.3)', paddingLeft: 2 }}>
              relative volume
            </span>
            <span className="tl-col-open" title="Tickets currently open or new assigned to this agent — live, all-time queue · not period-filtered · click to view in Zendesk">
              Open ↗
            </span>
            <span className="tl-col-eff" title="Resolution rate = solved ÷ (solved + open). Green ≥80% · Amber 60–79% · Red <60%">
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
                    <span className="tl-section-hint">Zendesk · ranked by public replies in period</span>
                  </div>
                </div>
                {section.agents.map((agent, i) => (
                  <AgentRow key={agent.id} agent={agent} rank={i + 1} isFirst={i === 0} />
                ))}
              </React.Fragment>
            ))
          ) : (
            <>
              {/* Support team */}
              {support.length > 0 && (
                <div className="tl-section-label">
                  <div>
                    <span>Trial Account Team</span>
                    <span className="tl-section-hint">Zendesk support queue · ranked by public replies in period</span>
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

              {/* Escalation team */}
              {escalation.length > 0 && (
                <div className="tl-section-label escalation">
                  <div>
                    <span>Escalation Station</span>
                    <span className="tl-section-hint">handles escalated tickets · also counted in Trial team above</span>
                  </div>
                </div>
              )}
              {escalation.map((agent, i) => (
                <AgentRow key={`esc-${agent.id}`} agent={agent} rank={i + 1} isFirst={false} />
              ))}
            </>
          )}

          {/* Board footer */}
          <div className="tl-board-footer">
            <span>Replied = public replies in <strong>{periodLabel}</strong> period</span>
            <span>·</span>
            <span>Open = current live queue (all time)</span>
            <span>·</span>
            <span>Rate = replied ÷ (replied + open)</span>
            <span>·</span>
            <span>Bar = relative to top performer</span>
            {zdUrl && (
              <>
                <span>·</span>
                <a href={zdUrl('type:ticket')} target="_blank" rel="noopener noreferrer" className="tl-footer-link">
                  Open Zendesk ↗
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
