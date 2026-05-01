import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { BigToggle, PillToggle } from '../components/ui/Toggle';
import api from '../api';

const CC_TABS = ['savvy', 'mitel', 'systems'];

function fmt(ts) {
  if (!ts) return 'Never changed';
  return new Date(ts).toLocaleString();
}

export default function StatusBoard() {
  const { status, setStatus, didCounts, addLog, toast, slackConfig } = useApp();

  const [activeTab, setActiveTab] = useState('savvy');
  const [saving, setSaving] = useState(null);
  const [cannedResponses, setCannedResponses] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ccob_canned') || '[]'); } catch { return []; }
  });

  // Local form state mirrors status
  const [savvyOn, setSavvyOn] = useState(true);
  const [mitelOn, setMitelOn] = useState(true);
  const [mobileOn, setMobileOn] = useState(true);
  const [mobileMessagesOk, setMobileMessagesOk] = useState(true);
  const [integrOn, setIntegrOn] = useState(true);
  const [integrMessagesOk, setIntegrMessagesOk] = useState(true);
  const [didOn, setDidOn] = useState(true);
  const [savvyMsg, setSavvyMsg] = useState('');
  const [mitelMsg, setMitelMsg] = useState('');
  // Sync from API status
  useEffect(() => {
    if (!status) return;
    setSavvyOn(status.savvyPhone?.state !== 'DOWN');
    setMitelOn(status.mitelClassic?.state !== 'DOWN');
    setMobileOn(status.mobileApp?.state !== 'DOWN');
    setMobileMessagesOk(!status.mobileApp?.messagesDown);
    setIntegrOn(status.integrations?.state !== 'DOWN');
    setIntegrMessagesOk(!status.integrations?.messagesDown);
    setDidOn(status.didStatus !== 'DOWN');
    setSavvyMsg(status.savvyPhone?.message || '');
    setMitelMsg(status.mitelClassic?.message || '');
  }, [status]);

  async function postStatus(patch) {
    setSaving(true);
    try {
      const res = await api.post('/api/status', patch);
      if (res.data?.success) {
        setStatus(prev => ({ ...prev, ...patch }));
        toast('Status updated', 'success');
        const keys = Object.keys(patch);
        addLog(`Status updated: ${keys.join(', ')}`, 'ok');
      }
    } catch (e) {
      toast('Failed to update status', 'error');
      addLog('Status update failed', 'err');
    } finally {
      setSaving(false);
    }
  }

  function handleToggle(system, val) {
    const state = val ? 'UP' : 'DOWN';
    switch (system) {
      case 'savvy':
        setSavvyOn(val);
        postStatus({ savvyPhone: { state, message: savvyMsg, changedAt: new Date().toISOString() } });
        break;
      case 'mitel':
        setMitelOn(val);
        postStatus({ mitelClassic: { state, message: mitelMsg, changedAt: new Date().toISOString() } });
        break;
      case 'mobile':
        setMobileOn(val);
        postStatus({ mobileApp: { state, changedAt: new Date().toISOString() } });
        break;
      case 'mobile-messages':
        setMobileMessagesOk(val);
        postStatus({ mobileApp: { messagesDown: !val, changedAt: new Date().toISOString() } });
        break;
      case 'integrations':
        setIntegrOn(val);
        postStatus({ integrations: { state, changedAt: new Date().toISOString() } });
        break;
      case 'integrations-messages':
        setIntegrMessagesOk(val);
        postStatus({ integrations: { messagesDown: !val, changedAt: new Date().toISOString() } });
        break;
    }
  }

  async function handleDIDToggle(val) {
    setDidOn(val);
    postStatus({ didStatus: val ? 'UP' : 'DOWN' });
    const slackUrl = val ? slackConfig?.didsAvailable : slackConfig?.didsUnavailable;
    if (slackUrl) {
      try {
        const res = await api.post('/api/slack/notify', { url: slackUrl });
        if (res.data?.openUrl) window.open(res.data.openUrl, '_blank');
        addLog(`Slack notified: DIDs ${val ? 'Available' : 'Unavailable'}`, 'ok');
      } catch {
        toast('Slack notification failed', 'error');
      }
    }
  }

  function handleMessage(system, msg) {
    if (system === 'savvy') setSavvyMsg(msg);
    if (system === 'mitel') setMitelMsg(msg);
  }

  function saveMessage(system) {
    if (system === 'savvy') {
      postStatus({ savvyPhone: { ...(status?.savvyPhone || {}), message: savvyMsg } });
    } else if (system === 'mitel') {
      postStatus({ mitelClassic: { ...(status?.mitelClassic || {}), message: mitelMsg } });
    }
  }

  function fillCanned(system, val) {
    if (!val) return;
    if (system === 'savvy') setSavvyMsg(val);
    if (system === 'mitel') setMitelMsg(val);
  }

  const savvyDid = didCounts?.savvy;
  const mitelDid = didCounts?.mitel;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">System Status Board</div>
          <div className="page-sub">Declare call center status · Sync to public endpoint · Fire Slack workflows</div>
        </div>
        <div className="ab-stat-strip">
          <div className={`ab-stat-chip${savvyOn ? '' : ' ab-chip-standby'}`}>
            <span className={`cc-tab-dot${savvyOn ? '' : ' down'}`} />
            <span className="ab-chip-label">Savvy</span>
            <span className="ab-chip-val">{savvyOn ? 'Operational' : 'Down'}</span>
          </div>
          <div className={`ab-stat-chip${mitelOn ? '' : ' ab-chip-standby'}`}>
            <span className={`cc-tab-dot${mitelOn ? '' : ' down'}`} />
            <span className="ab-chip-label">Mitel</span>
            <span className="ab-chip-val">{mitelOn ? 'Operational' : 'Down'}</span>
          </div>
          <div className={`ab-stat-chip${mobileOn && mobileMessagesOk && integrMessagesOk ? '' : ' ab-chip-standby'}`}>
            <span className={`cc-tab-dot${mobileOn && mobileMessagesOk && integrMessagesOk ? '' : ' down'}`} />
            <span className="ab-chip-label">Systems</span>
            <span className="ab-chip-val">{mobileOn && mobileMessagesOk && integrMessagesOk ? 'Operational' : 'Degraded'}</span>
          </div>
        </div>
      </div>

      <div className="card mb-20">
        {/* DID Global Row */}
        <div className="sb-global-did-row">
          <span className="sb-did-label">DID Status</span>
          <PillToggle checked={didOn} onChange={handleDIDToggle} id="toggle-did-global" />
          <span className={`sb-did-status-text ${didOn ? 'up' : 'down'}`}>{didOn ? 'Available' : 'Unavailable'}</span>
        </div>

        {/* CC Tabs */}
        <div className="ab-tab-bar">
          {['savvy', 'mitel', 'systems'].map(tab => (
            <button
              key={tab}
              className={`ab-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className={`cc-tab-dot${
                tab === 'savvy' ? (savvyOn ? '' : ' down') :
                tab === 'mitel' ? (mitelOn ? '' : ' down') :
                (mobileOn && mobileMessagesOk && integrMessagesOk ? '' : ' down')
              }`} />
              {tab === 'savvy' ? 'Savvy Phone' : tab === 'mitel' ? 'Mitel Classic' : 'Systems'}
            </button>
          ))}
        </div>

        {/* Savvy Phone Panel */}
        {activeTab === 'savvy' && (
          <div className={`sb-panel ${savvyOn ? 'up' : 'down'}`}>
            <div className="sb-main-row">
              <div className="big-toggle-wrap" style={{ marginBottom: 0 }}>
                <BigToggle checked={savvyOn} onChange={val => handleToggle('savvy', val)} id="toggle-savvy" />
                <span className={`toggle-status-text ${savvyOn ? 'up' : 'down'}`}>
                  {savvyOn ? 'SYSTEM OPERATIONAL' : 'SYSTEM DOWN'}
                </span>
              </div>
              <div className="sb-meta-col">
                <span className={`status-badge ${savvyOn ? 'up' : 'down'}`}>
                  {savvyOn ? 'Operational' : 'Down'}
                </span>
                <div className={`did-badge${savvyDid !== undefined ? ' loaded' : ''}`}>
                  <span>📞 DIDs:</span>
                  <span className="did-number">{savvyDid !== undefined ? savvyDid : '—'}</span>
                </div>
                <div className="panel-meta">
                  Changed by {status?.savvyPhone?.changedBy || '—'} · {fmt(status?.savvyPhone?.changedAt)}
                </div>
              </div>
            </div>
            <div className="sb-msg-section">
              <label className="field-label">Status Message</label>
              <div className="msg-row">
                <select
                  className="form-select"
                  value=""
                  onChange={e => fillCanned('savvy', e.target.value)}
                >
                  <option value="">— Select Canned Response —</option>
                  {cannedResponses.map((c, i) => (
                    <option key={i} value={c.msg}>{c.label}</option>
                  ))}
                </select>
                <button className="btn btn-ghost btn-sm" onClick={() => setSavvyMsg('')}>Clear</button>
              </div>
              <textarea
                className="form-select"
                style={{ marginTop: 8, minHeight: 60 }}
                value={savvyMsg}
                onChange={e => handleMessage('savvy', e.target.value)}
                placeholder="Status message..."
              />
              <button className="btn btn-secondary btn-sm mt-12" onClick={() => saveMessage('savvy')}>
                Save Message
              </button>
            </div>
          </div>
        )}

        {/* Mitel Panel */}
        {activeTab === 'mitel' && (
          <div className={`sb-panel ${mitelOn ? 'up' : 'down'}`}>
            <div className="sb-main-row">
              <div className="big-toggle-wrap" style={{ marginBottom: 0 }}>
                <BigToggle checked={mitelOn} onChange={val => handleToggle('mitel', val)} id="toggle-mitel" />
                <span className={`toggle-status-text ${mitelOn ? 'up' : 'down'}`}>
                  {mitelOn ? 'SYSTEM OPERATIONAL' : 'SYSTEM DOWN'}
                </span>
              </div>
              <div className="sb-meta-col">
                <span className={`status-badge ${mitelOn ? 'up' : 'down'}`}>
                  {mitelOn ? 'Operational' : 'Down'}
                </span>
                <div className={`did-badge${mitelDid !== undefined ? ' loaded' : ''}`}>
                  <span>📞 DIDs:</span>
                  <span className="did-number">{mitelDid !== undefined ? mitelDid : '—'}</span>
                </div>
                <div className="panel-meta">
                  Changed by {status?.mitelClassic?.changedBy || '—'} · {fmt(status?.mitelClassic?.changedAt)}
                </div>
              </div>
            </div>
            <div className="sb-msg-section">
              <label className="field-label">Status Message</label>
              <div className="msg-row">
                <select
                  className="form-select"
                  value=""
                  onChange={e => fillCanned('mitel', e.target.value)}
                >
                  <option value="">— Select Canned Response —</option>
                  {cannedResponses.map((c, i) => (
                    <option key={i} value={c.msg}>{c.label}</option>
                  ))}
                </select>
                <button className="btn btn-ghost btn-sm" onClick={() => setMitelMsg('')}>Clear</button>
              </div>
              <textarea
                className="form-select"
                style={{ marginTop: 8, minHeight: 60 }}
                value={mitelMsg}
                onChange={e => handleMessage('mitel', e.target.value)}
                placeholder="Status message..."
              />
              <button className="btn btn-secondary btn-sm mt-12" onClick={() => saveMessage('mitel')}>
                Save Message
              </button>
            </div>
          </div>
        )}

        {/* Systems Panel */}
        {activeTab === 'systems' && (
          <div className="sb-systems-panel" style={{ padding: '0 20px 20px' }}>
            <div className={`systems-item-row ${mobileOn ? 'up' : 'down'}`}>
              <div className="systems-item-name">📱 Mobile App</div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="big-toggle-wrap" style={{ marginBottom: 0 }}>
                  <BigToggle checked={mobileOn} onChange={val => handleToggle('mobile', val)} id="toggle-mobile" />
                  <span className={`toggle-status-text ${mobileOn ? 'up' : 'down'}`}>
                    App {mobileOn ? 'UP' : 'DOWN'}
                  </span>
                </div>
                <div className="big-toggle-wrap" style={{ marginBottom: 0 }}>
                  <BigToggle checked={mobileMessagesOk} onChange={val => handleToggle('mobile-messages', val)} id="toggle-mobile-msgs" />
                  <span className={`toggle-status-text ${mobileMessagesOk ? 'up' : 'down'}`}>
                    Messages {mobileMessagesOk ? 'ROUTING' : 'NOT ROUTING'}
                  </span>
                </div>
              </div>
              <div className="systems-item-right">
                <span className={`status-badge ${mobileOn && mobileMessagesOk ? 'up' : 'down'}`}>
                  {mobileOn && mobileMessagesOk ? 'Operational' : 'Degraded'}
                </span>
                {(!mobileOn || !mobileMessagesOk) && (
                  <div className="panel-meta" style={{ color: 'var(--amber)', maxWidth: 180, lineHeight: 1.4 }}>
                    {!mobileOn
                      ? 'Mobile App is DOWN — messages cannot route.'
                      : 'App is up, but messages are NOT routing into it.'}
                  </div>
                )}
                <div className="panel-meta">{fmt(status?.mobileApp?.changedAt)}</div>
              </div>
            </div>
            <div className={`systems-item-row ${integrMessagesOk ? 'up' : 'down'}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div className="systems-item-name">🔗 Integrations</div>
                <div className="panel-meta" style={{ maxWidth: 160, lineHeight: 1.4, textTransform: 'none', letterSpacing: 0, color: integrMessagesOk ? undefined : 'var(--amber)' }}>
                  {integrMessagesOk
                    ? 'Messages are routing into customer CRMs.'
                    : 'Messages are NOT hitting customer CRMs — their CRM may still be up.'}
                </div>
              </div>
              <div className="big-toggle-wrap" style={{ marginBottom: 0, flex: 1 }}>
                <BigToggle checked={integrMessagesOk} onChange={val => handleToggle('integrations-messages', val)} id="toggle-integr-msgs" />
                <span className={`toggle-status-text ${integrMessagesOk ? 'up' : 'down'}`}>
                  Messages {integrMessagesOk ? 'ROUTING' : 'NOT ROUTING'}
                </span>
              </div>
              <div className="systems-item-right">
                <span className={`status-badge ${integrMessagesOk ? 'up' : 'down'}`}>
                  {integrMessagesOk ? 'Operational' : 'Degraded'}
                </span>
                <div className="panel-meta">{fmt(status?.integrations?.changedAt)}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Activity Log */}
      <ActivityLog />
    </div>
  );
}

function ActivityLog() {
  const { activityLog } = useApp();
  return (
    <div className="card">
      <div className="card-title">Activity Log</div>
      <div className="log-feed">
        {activityLog.length === 0 && <div className="log-empty">No activity yet.</div>}
        {activityLog.map((entry, i) => (
          <div key={i} className="log-entry">
            <span className="log-time">{entry.time}</span>
            <span className={`log-msg ${entry.type}`}>{entry.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
