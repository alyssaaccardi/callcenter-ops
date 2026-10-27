import { useCallback, useEffect, useState } from 'react';
import api from '../api';

const POLL_MS = 120_000;
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days']];
const ACTION_LABEL = { reply: 'Public reply', note: 'Internal note', solve: 'Solved', update: 'Updated' };
const ACTION_COLOR = { reply: '#2563eb', note: '#7c3aed', solve: '#16a34a', update: '#64748b' };

function timeLabel(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function agoLabel(value) {
  if (!value) return 'No activity';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

export default function ZendeskAgentActivity() {
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hideQuiet, setHideQuiet] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get('/api/zendesk/agent-activity', { params: { period } });
      setData(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    const first = setTimeout(() => { setLoading(true); load(); }, 0);
    const interval = setInterval(load, POLL_MS);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, [load]);

  const agents = (data?.agents || []).filter(agent => !hideQuiet || agent.replies + agent.notes + agent.solves + agent.updates > 0);
  const quietCount = (data?.agents || []).filter(agent => agent.replies + agent.notes + agent.solves + agent.updates === 0).length;
  const totals = (data?.agents || []).reduce((sum, agent) => ({
    replies: sum.replies + agent.replies, notes: sum.notes + agent.notes, solves: sum.solves + agent.solves, updates: sum.updates + agent.updates,
  }), { replies: 0, notes: 0, solves: 0, updates: 0 });

  return (
    <div className="card" id="agent-activity" style={{ marginBottom: 16, scrollMarginTop: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="card-title" style={{ margin: 0 }}>Team activity in Zendesk</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {PERIODS.map(([value, label]) => (
            <button key={value} type="button" className={`btn ${period === value ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod(value)}>{label}</button>
          ))}
          <label style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={hideQuiet} onChange={event => setHideQuiet(event.target.checked)} /> Hide agents with no activity
          </label>
        </div>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>
        Counts of actions each agent took on tickets (ticket changes made in Zendesk, not page views). Day boundaries are Eastern time.
        {data && !data.unconfigured && <> Updated {timeLabel(data.generatedAt)} ET.</>}
      </div>

      {error && <div role="alert" style={{ color: 'var(--danger)', marginBottom: 10 }}>Could not load agent activity: {error}</div>}
      {loading && !data && <div style={{ color: 'var(--muted)', padding: 12 }}>Loading team activity… the first load can take up to a minute.</div>}
      {data?.unconfigured && <div>Zendesk is not configured for this environment.</div>}
      {data?.truncated && <div role="status" style={{ color: 'var(--danger)', marginBottom: 10 }}>This period has more than 1,000 updated tickets, so counts are partial.</div>}
      {data?.activityErrors > 0 && <div role="status" style={{ color: 'var(--danger)', marginBottom: 10 }}>{data.activityErrors} ticket(s) could not be read, so counts may be slightly low.</div>}

      {data && !data.unconfigured && (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
            <span><b>{totals.replies}</b> public replies</span>
            <span><b>{totals.notes}</b> internal notes</span>
            <span><b>{totals.solves}</b> solved</span>
            <span><b>{totals.updates}</b> other updates</span>
            <span style={{ color: 'var(--muted)' }}>{quietCount} of {data.agents.length} agents with no activity</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '2 1 560px', overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'left' }}>
                    {['Agent', 'Public replies', 'Internal notes', 'Solved', 'Other updates', 'Tickets touched', 'Last activity'].map(label => (
                      <th key={label} style={{ padding: '8px 10px', position: 'sticky', top: 0, background: 'var(--surface, var(--card-bg, #fff))' }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agents.map(agent => {
                    const quiet = agent.replies + agent.notes + agent.solves + agent.updates === 0;
                    return (
                      <tr key={agent.id} style={{ borderTop: '1px solid var(--border)', opacity: quiet ? 0.55 : 1 }}>
                        <td style={{ padding: '8px 10px', fontWeight: 650 }}>{agent.name}</td>
                        {[agent.replies, agent.notes, agent.solves, agent.updates, agent.ticketsTouched].map((value, index) => (
                          <td key={index} style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{value}</td>
                        ))}
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }} title={timeLabel(agent.lastActivityAt)}>{agoLabel(agent.lastActivityAt)}</td>
                      </tr>
                    );
                  })}
                  {!agents.length && <tr><td colSpan={7} style={{ padding: 12, color: 'var(--muted)' }}>No agent activity in this period.</td></tr>}
                </tbody>
              </table>
            </div>

            <div style={{ flex: '1 1 320px', maxHeight: 520, overflowY: 'auto' }}>
              <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Latest actions</div>
              {data.feed.map((item, index) => (
                <div key={`${item.ticketId}-${item.at}-${index}`} style={{ borderTop: '1px solid var(--border)', padding: '7px 0', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span><b>{item.agentName}</b> <span style={{ color: ACTION_COLOR[item.action], fontWeight: 700 }}>{ACTION_LABEL[item.action]}</span></span>
                    <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{timeLabel(item.at)}</span>
                  </div>
                  <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--royal)' }}>#{item.ticketId} {item.subject}</a>
                </div>
              ))}
              {!data.feed.length && <div style={{ color: 'var(--muted)', fontSize: 12 }}>No actions in this period.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
