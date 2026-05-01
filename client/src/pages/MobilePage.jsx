import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { PillToggle } from '../components/ui/Toggle';
import api from '../api';

export default function MobilePage() {
  const { status, setStatus, slackConfig, didCounts, toast, addLog } = useApp();
  const [activeTab, setActiveTab] = useState('status');
  const [toastMsg, setToastMsg] = useState(null);
  const [clock, setClock] = useState('');
  const [date, setDate] = useState('');
  const [message, setMessage] = useState('');
  const [agents, setAgents] = useState([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentTab, setAgentTab] = useState('here');
  const [selectedAgents, setSelectedAgents] = useState(new Set());
  const [mobileLog, setMobileLog] = useState([]);
  const [firing, setFiring] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setDate(now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  function showToast(msg, type = 'ok') {
    setToastMsg({ msg, type });
    setTimeout(() => setToastMsg(null), 3000);
  }

  function addMobileLog(msg, type = 'info') {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg, type,
    };
    setMobileLog(prev => [entry, ...prev].slice(0, 50));
  }

  const savvyOn = status?.savvyPhone?.state !== 'DOWN';
  const mitelOn = status?.mitelClassic?.state !== 'DOWN';
  const mobileOn = status?.mobileApp?.state !== 'DOWN';
  const integrOn = status?.integrations?.state !== 'DOWN';
  const didOn    = status?.didStatus !== 'DOWN';

  async function postStatus(patch) {
    try {
      await api.post('/api/status', patch);
      setStatus(prev => ({ ...prev, ...patch }));
      showToast('Status updated');
      addMobileLog('Status updated', 'ok');
    } catch {
      showToast('Failed to update', 'error');
    }
  }

  async function fireWorkflow(url, name) {
    if (!url) { showToast('Not configured', 'warn'); return; }
    setFiring(name);
    try {
      const res = await api.post('/api/slack/notify', { url });
      if (res.data?.openUrl) window.open(res.data.openUrl, '_blank');
      showToast(`Fired: ${name}`);
      addMobileLog(`Fired: ${name}`, 'ok');
    } catch {
      showToast(`Failed: ${name}`, 'error');
    } finally {
      setFiring(null);
    }
  }

  async function fetchAgents() {
    setLoadingAgents(true);
    try {
      const res = await api.get('/api/monday/agents');
      setAgents(res.data?.agents || []);
      setSelectedAgents(new Set());
    } catch {
      showToast('Failed to load agents', 'error');
    } finally {
      setLoadingAgents(false);
    }
  }

  async function moveAgent(id, dir) {
    try {
      await api.post(`/api/monday/agent/${id}/${dir}`);
      setAgents(prev => prev.map(a => a.id === id ? { ...a, status: dir === 'standby' ? 'On Standby' : 'Here' } : a));
      setSelectedAgents(new Set());
      showToast(`Moved to ${dir}`);
      addMobileLog(`Agent ${id} → ${dir}`, 'ok');
    } catch {
      showToast('Move failed', 'error');
    }
  }

  async function sendSms() {
    if (!message.trim()) { showToast('Enter a message', 'warn'); return; }
    setSending(true);
    try {
      await api.post('/api/eztexting/send', { groups: [], message: message.trim() });
      showToast('SMS sent');
      setMessage('');
      addMobileLog('SMS sent', 'ok');
    } catch (e) {
      showToast(e.response?.data?.error || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  }

  const hereAgents = agents.filter(a => a.status === 'Here');
  const standbyAgents = agents.filter(a => a.status !== 'Here');
  const displayAgents = agentTab === 'here' ? hereAgents : standbyAgents;

  return (
    <div style={{
      background: '#0e1520',
      minHeight: '100vh',
      fontFamily: "'Barlow Condensed', sans-serif",
      color: '#f0f4ff',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 58,
        background: '#0e1520', borderBottom: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px', zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/al-logo.png" alt="AL" style={{ width: 42, height: 42, borderRadius: '50%', border: '2px solid #00c9b1', objectFit: 'cover' }} onError={e => e.target.style.display='none'} />
          <div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: '0.1em' }}>CC OPS</div>
            <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, color: '#00c9b1', letterSpacing: '0.2em', textTransform: 'uppercase' }}>Mobile</div>
          </div>
        </div>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{clock}</div>
          <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, color: '#4a5a7a', textAlign: 'right' }}>{date}</div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginTop: 58, marginBottom: 62, overflowY: 'auto', padding: '14px 14px 0', flex: 1 }}>

        {/* STATUS TAB */}
        {activeTab === 'status' && (
          <div>
            {/* DID global */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#4a5a7a' }}>DID Status</div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: '0.1em', color: didOn ? '#00c9b1' : '#f59e0b', marginTop: 2 }}>
                  {didOn ? 'Online' : 'Offline'}
                </div>
              </div>
              <PillToggle
                checked={didOn}
                onChange={val => postStatus({ didStatus: val ? 'UP' : 'DOWN' })}
                id="mob-did"
              />
            </div>

            {/* Savvy */}
            <CCCardMobile
              name="Savvy Phone"
              isUp={savvyOn}
              didCount={didCounts?.savvy}
              changedBy={status?.savvyPhone?.changedBy}
              onToggle={val => postStatus({ savvyPhone: { ...(status?.savvyPhone || {}), state: val ? 'UP' : 'DOWN', changedAt: new Date().toISOString() } })}
            />

            {/* Mitel */}
            <CCCardMobile
              name="Mitel Classic"
              isUp={mitelOn}
              didCount={didCounts?.mitel}
              changedBy={status?.mitelClassic?.changedBy}
              onToggle={val => postStatus({ mitelClassic: { ...(status?.mitelClassic || {}), state: val ? 'UP' : 'DOWN', changedAt: new Date().toISOString() } })}
            />

            {/* Systems */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#4a5a7a', marginBottom: 10 }}>Systems</div>
              <SysRow name="📱 Mobile App" isUp={mobileOn} onToggle={val => postStatus({ mobileApp: { state: val ? 'UP' : 'DOWN', changedAt: new Date().toISOString() } })} />
              <SysRow name="🔗 Integrations" isUp={integrOn} onToggle={val => postStatus({ integrations: { state: val ? 'UP' : 'DOWN', changedAt: new Date().toISOString() } })} />
            </div>

            {/* Slack buttons */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#4a5a7a', marginBottom: 12 }}>Slack Workflows</div>
              {[
                { name: 'DIDs Unavailable', url: slackConfig?.didsUnavailable, icon: '🔴' },
                { name: 'DIDs Available',   url: slackConfig?.didsAvailable,   icon: '🟢' },
                { name: 'Savvy Active',     url: slackConfig?.savvyActive,     icon: '✅' },
                { name: 'Savvy Inactive',   url: slackConfig?.savvyInactive,   icon: '⚠️' },
              ].map(wf => (
                <button
                  key={wf.name}
                  onClick={() => fireWorkflow(wf.url, wf.name)}
                  disabled={firing === wf.name || !wf.url}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.07)',
                    background: firing === wf.name ? 'rgba(0,201,177,0.1)' : 'rgba(255,255,255,0.04)',
                    color: '#f0f4ff', fontFamily: "'Barlow Condensed'", fontSize: 15, fontWeight: 600,
                    cursor: 'pointer', marginBottom: 8, opacity: !wf.url ? 0.4 : 1,
                  }}
                >
                  <span>{wf.icon}</span>
                  {wf.name}
                  {firing === wf.name && <span style={{ marginLeft: 'auto', animation: 'spin 0.6s linear infinite', display: 'inline-block' }}>⟳</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* SMS TAB */}
        {activeTab === 'sms' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: '0.1em' }}>SMS Messaging</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#4a5a7a', marginBottom: 10 }}>Message</div>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Compose your message..."
                style={{ width: '100%', minHeight: 88, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, color: '#f0f4ff', fontFamily: "'Barlow Condensed'", fontSize: 16, padding: '10px 12px', resize: 'none', outline: 'none' }}
              />
              <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 10, color: '#4a5a7a', textAlign: 'right', marginTop: 4 }}>
                {message.length} / 160
              </div>
            </div>
            <button
              onClick={sendSms}
              disabled={sending}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: 14, borderRadius: 8, border: 'none', background: '#00c9b1', color: '#0e1520', fontFamily: "'Bebas Neue'", fontSize: 18, letterSpacing: '0.1em', cursor: 'pointer' }}
            >
              {sending ? '⟳ Sending...' : '📤 Send Message'}
            </button>
          </div>
        )}

        {/* AGENTS TAB */}
        {activeTab === 'agents' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: '0.1em' }}>Agent Board</div>
              <button
                onClick={fetchAgents}
                disabled={loadingAgents}
                style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.06)', color: '#f0f4ff', fontFamily: "'Barlow Condensed'", fontSize: 14, cursor: 'pointer' }}
              >
                {loadingAgents ? '⟳' : '↻ Refresh'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9, marginBottom: 12 }}>
              <StatBox num={hereAgents.length} label="Here" color="#00c9b1" />
              <StatBox num={standbyAgents.length} label="Standby" color="#f59e0b" />
              <StatBox num={agents.length} label="Total" color="#f0f4ff" />
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {['here', 'standby'].map(t => (
                <button
                  key={t}
                  onClick={() => setAgentTab(t)}
                  style={{
                    flex: 1, padding: 8, textAlign: 'center', borderRadius: 6, cursor: 'pointer',
                    fontSize: 14, fontWeight: 600, letterSpacing: '0.04em',
                    border: `1px solid ${agentTab === t ? '#00c9b1' : 'rgba(255,255,255,0.07)'}`,
                    background: agentTab === t ? 'rgba(0,201,177,0.1)' : 'transparent',
                    color: agentTab === t ? '#00c9b1' : '#4a5a7a',
                  }}
                >
                  {t === 'here' ? `Here (${hereAgents.length})` : `Standby (${standbyAgents.length})`}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {displayAgents.length === 0 && (
                <div style={{ textAlign: 'center', padding: 24, color: '#4a5a7a', fontFamily: "'IBM Plex Mono'", fontSize: 12 }}>
                  {agents.length === 0 ? 'Tap Refresh to load agents' : `No agents ${agentTab}`}
                </div>
              )}
              {displayAgents.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: '#4a5a7a', marginTop: 1 }}>{a.callCenter}</div>
                  </div>
                  <button
                    onClick={() => moveAgent(a.id, agentTab === 'here' ? 'standby' : 'here')}
                    style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.07)', background: agentTab === 'here' ? 'rgba(239,68,68,0.12)' : 'rgba(0,201,177,0.12)', color: agentTab === 'here' ? '#ef4444' : '#00c9b1', fontFamily: "'Barlow Condensed'", fontSize: 13, cursor: 'pointer' }}
                  >
                    {agentTab === 'here' ? '→ Standby' : '→ Here'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LOG TAB */}
        {activeTab === 'log' && (
          <div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: '0.1em', marginBottom: 12 }}>Activity Log</div>
            {mobileLog.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: '#4a5a7a', fontFamily: "'IBM Plex Mono'", fontSize: 12 }}>No activity yet.</div>
            )}
            {mobileLog.map((e, i) => (
              <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: 10 }}>
                <span style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, color: '#4a5a7a', flexShrink: 0, marginTop: 4 }}>{e.time}</span>
                <span style={{ fontSize: 14, color: e.type === 'err' ? '#ef4444' : e.type === 'ok' ? '#22c55e' : '#f0f4ff' }}>{e.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Nav */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, height: 62,
        background: '#131e30', borderTop: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', zIndex: 100,
      }}>
        {[
          { id: 'status',  icon: '📊', label: 'Status' },
          { id: 'sms',     icon: '📱', label: 'SMS' },
          { id: 'agents',  icon: '📋', label: 'Agents' },
          { id: 'log',     icon: '📜', label: 'Log' },
        ].map(tab => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, padding: '6px 4px', cursor: 'pointer',
              color: activeTab === tab.id ? '#00c9b1' : '#4a5a7a',
            }}
          >
            <div style={{ fontSize: 21 }}>{tab.icon}</div>
            <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{tab.label}</div>
          </div>
        ))}
      </div>

      {/* Toast */}
      {toastMsg && (
        <div style={{
          position: 'fixed', bottom: 74, left: 12, right: 12,
          background: '#1a2744', border: `1px solid ${toastMsg.type === 'error' ? 'rgba(239,68,68,0.4)' : toastMsg.type === 'warn' ? 'rgba(245,158,11,0.4)' : 'rgba(34,197,94,0.4)'}`,
          borderRadius: 8, padding: '12px 16px', fontSize: 14, fontWeight: 600,
          zIndex: 300, boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          color: toastMsg.type === 'error' ? '#ef4444' : toastMsg.type === 'warn' ? '#f59e0b' : '#22c55e',
        }}>
          {toastMsg.msg}
        </div>
      )}
    </div>
  );
}

function CCCardMobile({ name, isUp, didCount, changedBy, onToggle }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: `1px solid ${isUp ? 'rgba(0,201,177,0.3)' : 'rgba(239,68,68,0.35)'}`,
      borderRadius: 10, padding: '14px 16px', marginBottom: 12,
      borderLeft: `4px solid ${isUp ? '#00c9b1' : '#f59e0b'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, letterSpacing: '0.08em' }}>{name}</div>
          {didCount !== undefined && (
            <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 10, color: '#00c9b1', marginTop: 2 }}>
              📞 DIDs: {didCount}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontFamily: "'IBM Plex Mono'", fontSize: 12, fontWeight: 600, color: isUp ? '#22c55e' : '#ef4444' }}>
            {isUp ? 'UP' : 'DOWN'}
          </span>
          <PillToggle checked={isUp} onChange={onToggle} id={`mob-${name.replace(/ /g, '')}`} />
        </div>
      </div>
    </div>
  );
}

function SysRow({ name, isUp, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontFamily: "'IBM Plex Mono'", fontSize: 11, color: isUp ? '#22c55e' : '#ef4444' }}>
          {isUp ? 'UP' : 'DOWN'}
        </span>
        <PillToggle checked={isUp} onChange={onToggle} id={`mob-sys-${name}`} />
      </div>
    </div>
  );
}

function StatBox({ num, label, color }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '12px 8px', textAlign: 'center' }}>
      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 38, lineHeight: 1, color }}>{num}</div>
      <div style={{ fontFamily: "'IBM Plex Mono'", fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#4a5a7a', marginTop: 2 }}>{label}</div>
    </div>
  );
}
