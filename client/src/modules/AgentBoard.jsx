import React, { useState, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AgentBoard() {
  const { toast, addLog } = useApp();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('here');
  const [selected, setSelected] = useState(new Set());
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoInterval, setAutoInterval] = useState(null);
  const [agentLog, setAgentLog] = useState([]);
  const [movingId, setMovingId] = useState(null);

  useEffect(() => () => { if (autoInterval) clearInterval(autoInterval); }, [autoInterval]);

  function addAgentLog(msg, type = 'ok') {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg, type,
    };
    setAgentLog(prev => [entry, ...prev].slice(0, 50));
    addLog(msg, type);
  }

  async function fetchAgents() {
    setLoading(true);
    try {
      const res = await api.get('/api/monday/agents');
      setAgents(res.data?.agents || []);
      setLastUpdated(new Date().toLocaleTimeString());
      setSelected(new Set());
    } catch (e) {
      toast('Failed to load agents', 'error');
    } finally {
      setLoading(false);
    }
  }

  function toggleAutoRefresh() {
    if (autoRefresh) {
      clearInterval(autoInterval);
      setAutoInterval(null);
      setAutoRefresh(false);
    } else {
      fetchAgents();
      const id = setInterval(fetchAgents, 30000);
      setAutoInterval(id);
      setAutoRefresh(true);
    }
  }

  async function moveAgent(id, direction) {
    setMovingId(id);
    try {
      await api.post(`/api/monday/agent/${id}/${direction}`);
      setAgents(prev => prev.map(a => a.id === id
        ? { ...a, status: direction === 'standby' ? 'On Standby' : 'Here' }
        : a
      ));
      addAgentLog(`Moved agent ${id} to ${direction}`, 'ok');
      toast(`Agent moved to ${direction}`, 'success');
    } catch (e) {
      toast('Failed to move agent', 'error');
      addAgentLog(`Failed to move agent ${id}: ${e.message}`, 'err');
    } finally {
      setMovingId(null);
    }
  }

  async function bulkMoveStandby() {
    for (const id of selected) {
      await moveAgent(id, 'standby');
    }
    setSelected(new Set());
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(val) {
    if (val) setSelected(new Set(hereAgents.map(a => a.id)));
    else setSelected(new Set());
  }

  const hereAgents = agents.filter(a => a.status === 'Here');
  const standbyAgents = agents.filter(a => a.status !== 'Here');
  const savvyHere = hereAgents.filter(a => a.callCenter?.toLowerCase().includes('savvy')).length;
  const mitelHere = hereAgents.filter(a => a.callCenter?.toLowerCase().includes('mitel')).length;

  // Group by call center for here table
  const ccGroups = {};
  hereAgents.forEach(a => {
    const cc = a.callCenter || 'Unknown';
    if (!ccGroups[cc]) ccGroups[cc] = [];
    ccGroups[cc].push(a);
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Agent Board</div>
          <div className="page-sub">Monday.com · View and move agents between statuses</div>
        </div>
        <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="ab-stat-strip">
            <div className="ab-stat-chip">
              <span className="ab-chip-label">Savvy Here</span>
              <span className="ab-chip-val">{savvyHere}</span>
            </div>
            <div className="ab-stat-chip">
              <span className="ab-chip-label">Mitel Here</span>
              <span className="ab-chip-val">{mitelHere}</span>
            </div>
            <div className="ab-stat-chip ab-chip-standby">
              <span className="ab-chip-label">Standby</span>
              <span className="ab-chip-val">{standbyAgents.length}</span>
            </div>
          </div>
          {lastUpdated && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              Updated {lastUpdated}
            </span>
          )}
          <button className={`btn btn-ghost btn-sm${autoRefresh ? ' active' : ''}`} onClick={toggleAutoRefresh}>
            Auto ↻ {autoRefresh ? 'On' : 'Off'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={fetchAgents} disabled={loading}>
            {loading ? <span className="spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      <div className="card mb-16">
        <div className="ab-tab-bar">
          <button
            className={`ab-tab${activeTab === 'here' ? ' active' : ''}`}
            onClick={() => setActiveTab('here')}
          >
            Here <span className="ab-tab-count">{hereAgents.length}</span>
          </button>
          <button
            className={`ab-tab${activeTab === 'standby' ? ' active' : ''}`}
            onClick={() => setActiveTab('standby')}
          >
            Standby <span className="ab-tab-count">{standbyAgents.length}</span>
          </button>
          <div className="ab-tab-spacer" />
          {selected.size > 0 && (
            <div className="bulk-bar show">
              <span className="bulk-bar-count">{selected.size} selected</span>
              <button className="btn btn-danger btn-sm" onClick={bulkMoveStandby}>→ Standby</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Cancel</button>
            </div>
          )}
        </div>

        {activeTab === 'here' && (
          <table className="agent-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    className="agent-check"
                    checked={selected.size === hereAgents.length && hereAgents.length > 0}
                    onChange={e => selectAll(e.target.checked)}
                  />
                </th>
                <th>Agent Name</th>
                <th>Call Center</th>
                <th>Last Update</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    Click Refresh to load agents from Monday.com
                  </td>
                </tr>
              )}
              {Object.entries(ccGroups).map(([cc, ccAgents]) => (
                <React.Fragment key={cc}>
                  <tr className="cc-section-header">
                    <td colSpan={5}>{cc}</td>
                  </tr>
                  {ccAgents.map(a => (
                    <tr key={a.id}>
                      <td>
                        <input
                          type="checkbox"
                          className="agent-check"
                          checked={selected.has(a.id)}
                          onChange={() => toggleSelect(a.id)}
                        />
                      </td>
                      <td>{a.name}</td>
                      <td>{a.callCenter}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{fmtTime(a.lastUpdate)}</td>
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => moveAgent(a.id, 'standby')}
                          disabled={movingId === a.id}
                        >
                          {movingId === a.id ? <span className="spinner" /> : '→ Standby'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'standby' && (
          <table className="agent-table">
            <thead>
              <tr>
                <th>Agent Name</th>
                <th>Call Center</th>
                <th>Last Update</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    Click Refresh to load agents from Monday.com
                  </td>
                </tr>
              )}
              {standbyAgents.map(a => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.callCenter}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>{fmtTime(a.lastUpdate)}</td>
                  <td>
                    <button
                      className="btn btn-teal btn-sm"
                      onClick={() => moveAgent(a.id, 'here')}
                      disabled={movingId === a.id}
                    >
                      {movingId === a.id ? <span className="spinner" /> : '→ Here'}
                    </button>
                  </td>
                </tr>
              ))}
              {agents.length > 0 && standbyAgents.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    No agents on standby
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title">Activity Log</div>
        <div className="log-feed">
          {agentLog.length === 0 && <div className="log-empty">No activity yet.</div>}
          {agentLog.map((e, i) => (
            <div key={i} className="log-entry">
              <span className="log-time">{e.time}</span>
              <span className={`log-msg ${e.type}`}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
