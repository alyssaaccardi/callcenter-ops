import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import GroupSelect from '../components/ui/GroupSelect';
import api from '../api';

function getSegments(len) {
  if (len === 0) return 0;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

export default function SmsModule() {
  const { toast, addLog } = useApp();
  const [alertTypes, setAlertTypes] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('ccob_alertTypes') || '[]');
      return raw.map((a, i) => ({ ...a, _key: a._key || `at-${i}-${a.label}` }));
    } catch { return []; }
  });
  const [activeAlert, setActiveAlert] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [belizeSelected, setBelizeSelected] = useState(false);
  const [individual, setIndividual] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [smsLog, setSmsLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ccob_smsLog') || '[]'); } catch { return []; }
  });
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    localStorage.setItem('ccob_smsLog', JSON.stringify(smsLog));
  }, [smsLog]);

  useEffect(() => {
    fetchGroups();
  }, []);

  async function fetchGroups() {
    setLoadingGroups(true);
    try {
      const res = await api.get('/api/eztexting/groups');
      const fetched = res.data?.groups || [];
      setGroups(fetched);
      setSelectedGroups(prev => {
        if (prev.length > 0) return prev;
        const def = fetched.find(g => /agents.*(supervisors|sup)|supervisors.*agents/i.test(g.name) || /agents\s*\/\s*supervisors/i.test(g.name));
        return def ? [def] : prev;
      });
    } catch {
      toast('Could not load SMS groups', 'error');
    } finally {
      setLoadingGroups(false);
    }
  }

  const charLen = message.length;
  const segments = getSegments(charLen);
  const charClass = charLen > 160 ? 'over' : charLen > 130 ? 'warn' : '';

  function selectAlert(at) {
    if (activeAlert?.label === at.label) {
      setActiveAlert(null);
      setMessage('');
    } else {
      setActiveAlert(at);
      setMessage(at.msg || '');
    }
  }

  function addSmsLog(msg, type = 'ok') {
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }),
      msg, type,
    };
    setSmsLog(prev => [entry, ...prev].slice(0, 50));
    addLog(msg, type);
  }

  function sendSms() {
    if (!message.trim()) { toast('Message is required', 'warn'); return; }
    const hasTarget = selectedGroups.length > 0 || belizeSelected || individual.trim();
    if (!hasTarget) { toast('Select at least one recipient or group', 'warn'); return; }

    const recipients = [
      ...selectedGroups.map(g => g.name || g.id),
      ...(belizeSelected ? ['Belize Agents'] : []),
      ...(individual.trim() ? [individual.trim()] : []),
    ];
    setConfirm({ recipients, message: message.trim() });
  }

  async function executeSend() {
    setConfirm(null);
    setSending(true);
    const errors = [];

    if (selectedGroups.length > 0) {
      try {
        await api.post('/api/eztexting/send', {
          groups: selectedGroups.map(g => g.id),
          groupNames: selectedGroups.map(g => g.name),
          message: message.trim(),
        });
        addSmsLog(`SMS sent via EZTexting to ${selectedGroups.length} group(s)`, 'ok');
        toast('SMS sent via EZTexting', 'success');
      } catch (e) {
        errors.push(`EZTexting: ${e.response?.data?.error || e.message}`);
      }
    }

    if (individual.trim()) {
      try {
        await api.post('/api/eztexting/send', {
          phoneNumber: individual.trim(),
          message: message.trim(),
        });
        addSmsLog(`SMS sent to ${individual.trim()}`, 'ok');
        toast('SMS sent to individual', 'success');
      } catch (e) {
        errors.push(`Individual: ${e.response?.data?.error || e.message}`);
      }
    }

    if (belizeSelected) {
      try {
        await api.post('/api/smsto/send', { message: message.trim() });
        addSmsLog('SMS sent to Belize Agents via SMS.to', 'ok');
        toast('SMS sent to Belize Agents', 'success');
      } catch (e) {
        errors.push(`SMS.to: ${e.response?.data?.error || e.message}`);
      }
    }

    if (errors.length > 0) {
      toast(errors[0], 'error');
      addSmsLog(`Send errors: ${errors.join('; ')}`, 'err');
    }

    setSending(false);
  }

  return (
    <>
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">SMS Messaging</div>
          <div className="page-sub">EasyTexting API · Send to groups or individuals</div>
        </div>
      </div>

      <div className="grid-2">
        <div>
          {/* Alert Type */}
          {alertTypes.length > 0 && (
            <div className="card mb-12">
              <div className="card-title">Alert Type</div>
              <div className="alert-type-grid">
                {alertTypes.map((at) => (
                  <div
                    key={at._key || at.label}
                    className={`alert-chip${activeAlert?.label === at.label ? ' active' : ''}`}
                    onClick={() => selectAlert(at)}
                  >
                    {at.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recipients */}
          <div className="card mb-12">
            <div className="card-title">
              Recipients
              <button className="btn btn-ghost btn-sm" onClick={fetchGroups}>
                {loadingGroups ? <span className="spinner" /> : '↻'} Refresh Groups
              </button>
            </div>
            <div className="form-row">
              <label className="field-label">Send to Group</label>
              <GroupSelect
                groups={groups}
                selected={selectedGroups}
                onChange={setSelectedGroups}
                loading={loadingGroups}
              />
            </div>

            <div className="smsto-divider">Team B — SMS.to</div>
            <div className="group-chips">
              <div
                className={`group-chip belize-chip${belizeSelected ? ' selected' : ''}`}
                onClick={() => setBelizeSelected(b => !b)}
              >
                <span className="chip-dot" />
                Belize Agents
              </div>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid rgba(168,85,247,0.12)', margin: '14px 0' }} />

            <div className="form-row">
              <label className="field-label">Or send to Individual (E.164)</label>
              <input
                type="text"
                value={individual}
                onChange={e => setIndividual(e.target.value)}
                placeholder="+12125551234"
              />
            </div>
          </div>

          {/* Composer */}
          <div className="card">
            <div className="card-title">Message Composer</div>
            <div className="form-row">
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Compose your message..."
                style={{ minHeight: 90 }}
              />
              <div className={`char-counter${charClass ? ' ' + charClass : ''}`}>
                {charLen} / 160 · {segments} segment{segments !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="send-row">
              <div className="segment-info">
                {segments > 1 && `${segments} segments · ${charLen} chars`}
              </div>
              <div className="flex">
                <button
                  className="btn btn-primary"
                  onClick={sendSms}
                  disabled={sending}
                >
                  {sending ? <span className="spinner" /> : null} Send Message
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-title">Sent Log</div>
            <div className="log-feed">
              {smsLog.length === 0 && <div className="log-empty">No messages sent yet.</div>}
              {smsLog.map((e, i) => (
                <div key={i} className="log-entry">
                  <span className="log-time">{e.time}</span>
                  <span className={`log-msg ${e.type}`}>{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>

    {confirm && (
      <div className="wf-overlay" onClick={() => setConfirm(null)}>
        <div className="wf-modal wf-modal-sm" onClick={e => e.stopPropagation()}>
          <div className="wf-modal-header">
            <span className="wf-modal-title">Confirm SMS Send</span>
            <button className="wf-modal-close" onClick={() => setConfirm(null)}>✕</button>
          </div>
          <div className="wf-modal-body">
            <div className="wf-field">
              <span className="field-label">To</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                {confirm.recipients.map((r, i) => (
                  <span key={i} style={{
                    fontSize: 12, fontWeight: 700, padding: '3px 10px',
                    borderRadius: 20, background: 'rgba(168,85,247,0.1)',
                    border: '1px solid rgba(168,85,247,0.25)', color: 'var(--purple, #a855f7)',
                  }}>{r}</span>
                ))}
              </div>
            </div>
            <div className="wf-field">
              <span className="field-label">Message</span>
              <div style={{
                marginTop: 2, padding: '10px 12px', borderRadius: 8,
                background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(168,85,247,0.12)',
                fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: 'var(--text)',
              }}>{confirm.message}</div>
            </div>
          </div>
          <div className="wf-modal-footer">
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={executeSend}>Send</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
