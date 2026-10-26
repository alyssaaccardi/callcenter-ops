import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api';

const POLL_MS = 60_000;
const PAGE_SIZE = 100;

function dateLabel(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function elapsedLabel(value) {
  if (!value) return 'No agent reply yet';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function Status({ value }) {
  const colors = {
    new: ['#d97706', 'rgba(245,158,11,.14)'],
    open: ['#2563eb', 'rgba(59,130,246,.14)'],
    pending: ['#7c3aed', 'rgba(139,92,246,.14)'],
    hold: ['#64748b', 'rgba(100,116,139,.15)'],
  };
  const [color, background] = colors[value] || ['var(--muted)', 'var(--surface2, rgba(0,0,0,.06))'];
  return <span style={{ color, background, padding: '3px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{value}</span>;
}

function Stat({ label, value, accent }) {
  return (
    <div className="card" style={{ flex: '1 1 160px', minWidth: 150 }}>
      <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 750, color: accent || 'var(--text)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

export default function ZendeskAdminOverview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [sittingOnly, setSittingOnly] = useState(false);
  const [search, setSearch] = useState('');

  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await api.get('/api/zendesk/admin-overview');
      setData(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not load Zendesk overview');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialFetch = setTimeout(() => fetchOverview(), 0);
    const timer = setInterval(() => fetchOverview(true), POLL_MS);
    return () => {
      clearTimeout(initialFetch);
      clearInterval(timer);
    };
  }, [fetchOverview]);

  const visibleTickets = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (data?.tickets || []).filter(ticket => {
      if (selectedGroup !== 'all' && String(ticket.groupId ?? 'unassigned') !== selectedGroup) return false;
      if (sittingOnly && !ticket.sitting) return false;
      if (!normalizedSearch) return true;
      return `${ticket.id} ${ticket.subject} ${ticket.assigneeName || ''} ${ticket.groupName}`.toLowerCase().includes(normalizedSearch);
    });
  }, [data, search, selectedGroup, sittingOnly]);

  const truncatedGroups = (data?.groups || []).filter(group => group.truncated);
  const sittingCount = data?.sittingCount ?? 0;

  return (
    <div style={{ padding: 20, maxWidth: 1800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div className="page-title">Zendesk Admin Overview</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            New/open tickets awaiting a reply are flagged after 24 weekday business hours without a public agent response to the latest requester message (9am–5pm ET; holidays not excluded) · Touches are ticket updates, not page clicks · Refreshes every minute
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {data?.generatedAt && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Updated {dateLabel(data.generatedAt)} ET</span>}
          <button className="btn btn-secondary" onClick={() => fetchOverview(true)} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="card" role="alert" style={{ color: 'var(--danger)', marginBottom: 16 }}>Could not load Zendesk data: {error}</div>}
      {data?.unconfigured && <div className="card" role="status">Zendesk is not configured for this environment.</div>}

      {data && !data.unconfigured && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat label="Unsolved tickets" value={data.totalUnsolved ?? 0} />
            <Stat label="Waiting on agent · 24 business hours" value={sittingCount} accent={sittingCount ? 'var(--danger)' : undefined} />
            <Stat label="Active groups" value={data.activeGroupCount ?? 0} />
            {data.activityErrors > 0 && <Stat label="Activity lookup issues" value={data.activityErrors} accent="var(--danger)" />}
          </div>

          {data.activityErrors > 0 && (
            <div className="card" role="status" style={{ color: 'var(--danger)', marginBottom: 16 }}>
              Agent activity could not be loaded for {data.activityErrors} ticket(s). Those tickets are excluded from the sitting count; retry or check Zendesk API access.
            </div>
          )}
          {truncatedGroups.length > 0 && (
            <div className="card" role="status" style={{ color: 'var(--danger)', marginBottom: 16 }}>
              Zendesk search returned more than 1,000 open tickets for {truncatedGroups.map(group => group.name).join(', ')}. Displayed ticket activity, status breakdowns, and the sitting count are partial; group totals use Zendesk’s reported counts.
            </div>
          )}

          <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
            <div className="card-title">Unsolved tickets by group</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'left' }}>
                  {['Group', 'Total', 'New', 'Open', 'Pending', 'On hold'].map(label => <th key={label} style={{ padding: '8px 10px' }}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.groups?.map(group => {
                  const id = String(group.id ?? 'unassigned');
                  const active = selectedGroup === id;
                  return (
                    <tr key={id} onClick={() => setSelectedGroup(active ? 'all' : id)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: active ? 'var(--surface2, rgba(0,0,0,.04))' : undefined }}>
                      <td style={{ padding: '9px 10px', fontWeight: 650 }}>{group.name}{group.truncated && <span style={{ color: 'var(--danger)', marginLeft: 6 }}>· partial details</span>}</td>
                      {[group.total, group.new, group.open, group.pending, group.hold].map((value, index) => <td key={index} style={{ padding: '9px 10px', fontVariantNumeric: 'tabular-nums' }}>{value}</td>)}
                    </tr>
                  );
                })}
                {!data.groups?.length && <tr><td colSpan={6} style={{ padding: 12, color: 'var(--muted)' }}>No active Zendesk groups found.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 16 }}>
              <div className="card-title" style={{ margin: 0 }}>Ticket activity <span style={{ color: 'var(--muted)', fontWeight: 500 }}>({visibleTickets.length})</span></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search ticket, assignee, group"
                  aria-label="Search ticket activity"
                  style={{ minWidth: 220, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                />
                <button className={`btn ${sittingOnly ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSittingOnly(value => !value)}>
                  {sittingOnly ? 'Showing sitting only' : 'Show sitting only'}
                </button>
                {(selectedGroup !== 'all' || search || sittingOnly) && (
                  <button className="btn btn-secondary" onClick={() => { setSelectedGroup('all'); setSearch(''); setSittingOnly(false); }}>Clear filters</button>
                )}
              </div>
            </div>
            <div style={{ maxHeight: 680, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface)' }}>
                  <tr style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'left' }}>
                    {['Ticket', 'Group', 'Status', 'Assignee', 'Last agent touch', 'Last public agent reply', 'Waiting age'].map(label => <th key={label} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {visibleTickets.slice(0, PAGE_SIZE).map(ticket => (
                    <tr key={ticket.id} style={{ borderBottom: '1px solid var(--border)', background: ticket.sitting ? 'rgba(239,68,68,.05)' : undefined }}>
                      <td style={{ padding: '10px 12px', maxWidth: 360 }}>
                        <a href={ticket.link} target="_blank" rel="noreferrer" style={{ color: 'var(--royal)', fontWeight: 650 }}>
                          #{ticket.id} · {ticket.subject}
                        </a>
                      </td>
                      <td style={{ padding: '10px 12px' }}>{ticket.groupName}</td>
                      <td style={{ padding: '10px 12px' }}><Status value={ticket.status} /></td>
                      <td style={{ padding: '10px 12px' }}>{ticket.assigneeName || 'Unassigned'}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        {!ticket.activityAvailable ? 'Activity unavailable' : ticket.lastAgentTouchAt ? <>{dateLabel(ticket.lastAgentTouchAt)}{ticket.lastAgentTouchBy && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{ticket.lastAgentTouchBy}</div>}</> : 'No agent update yet'}
                      </td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        {!ticket.activityAvailable ? 'Activity unavailable' : ticket.lastAgentReplyAt ? <>{dateLabel(ticket.lastAgentReplyAt)}{ticket.lastAgentReplyBy && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{ticket.lastAgentReplyBy}</div>}</> : 'No agent reply yet'}
                      </td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: ticket.sitting ? 'var(--danger)' : 'var(--text)', fontWeight: ticket.sitting ? 700 : 500 }}>
                        {!ticket.activityAvailable ? 'Unknown' : ticket.waitingSince ? elapsedLabel(ticket.waitingSince) : 'No reply due'}
                        {ticket.sitting && <div style={{ fontSize: 10, textTransform: 'uppercase' }}>Sitting</div>}
                      </td>
                    </tr>
                  ))}
                  {visibleTickets.length === 0 && <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No tickets match these filters.</td></tr>}
                </tbody>
              </table>
              {visibleTickets.length > PAGE_SIZE && <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>Showing first {PAGE_SIZE} of {visibleTickets.length} matching tickets. Filter by group or search to narrow the list.</div>}
            </div>
          </div>
        </>
      )}

      {!data && loading && <div className="card" role="status">Loading Zendesk groups and ticket activity…</div>}
    </div>
  );
}
