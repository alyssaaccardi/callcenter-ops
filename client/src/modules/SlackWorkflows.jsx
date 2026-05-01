import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';

export default function SlackWorkflows() {
  const { slackConfig, toast, addLog } = useApp();
  const [firing, setFiring] = useState(null);
  const [lastTriggered, setLastTriggered] = useState({});
  const [slackLog, setSlackLog] = useState([]);

  const workflows = [
    { id: 'didsUnavailable', name: 'DIDs Unavailable', scope: 'DID Status', icon: '🔴', url: slackConfig?.didsUnavailable },
    { id: 'didsAvailable',   name: 'DIDs Available',   scope: 'DID Status', icon: '🟢', url: slackConfig?.didsAvailable },
    { id: 'savvyActive',     name: 'Savvy Phone Active',   scope: 'Savvy Phone', icon: '✅', url: slackConfig?.savvyActive },
    { id: 'savvyInactive',   name: 'Savvy Phone Inactive', scope: 'Savvy Phone', icon: '⚠️', url: slackConfig?.savvyInactive },
  ];

  function addSlackLog(msg, type = 'ok') {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg, type,
    };
    setSlackLog(prev => [entry, ...prev].slice(0, 50));
    addLog(msg, type === 'ok' ? 'ok' : 'err');
  }

  async function fireWorkflow(wf) {
    if (!wf.url) {
      toast('No URL configured for this workflow', 'warn');
      return;
    }
    setFiring(wf.id);
    try {
      const res = await api.post('/api/slack/notify', { url: wf.url });
      if (res.data?.openUrl) {
        window.open(res.data.openUrl, '_blank');
      }
      setLastTriggered(prev => ({ ...prev, [wf.id]: new Date().toLocaleTimeString() }));
      toast(`Fired: ${wf.name}`, 'success');
      addSlackLog(`Fired workflow: ${wf.name}`, 'ok');
    } catch (e) {
      toast(`Failed to fire: ${wf.name}`, 'error');
      addSlackLog(`Failed to fire: ${wf.name} — ${e.response?.data?.error || e.message}`, 'err');
    } finally {
      setFiring(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Slack Workflows</div>
          <div className="page-sub">Manage and fire status notification workflows</div>
        </div>
      </div>

      <div className="mb-20">
        {workflows.map(wf => (
          <div key={wf.id} className="workflow-card">
            <div className="workflow-card-header">
              <span style={{ fontSize: 20 }}>{wf.icon}</span>
              <span className="workflow-name">{wf.name}</span>
              <span className="workflow-scope">{wf.scope}</span>
            </div>
            <div className="workflow-url-display">
              {wf.url || '(not configured — check Settings → API Keys → Slack)'}
            </div>
            <div className="workflow-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => fireWorkflow(wf)}
                disabled={firing === wf.id || !wf.url}
              >
                {firing === wf.id ? <span className="spinner" /> : '⚡'} Fire
              </button>
              {lastTriggered[wf.id] && (
                <span className="last-triggered">Last fired: {lastTriggered[wf.id]}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">Activity Log</div>
        <div className="log-feed">
          {slackLog.length === 0 && <div className="log-empty">No workflows triggered yet.</div>}
          {slackLog.map((e, i) => (
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
