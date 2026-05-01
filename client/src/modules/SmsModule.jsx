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
    try { return JSON.parse(localStorage.getItem('ccob_alertTypes') || '[]'); } catch { return []; }
  });
  const [activeAlert, setActiveAlert] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [belizeSelected, setBelizeSelected] = useState(false);
  const [individual, setIndividual] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [smsLog, setSmsLog] = useState([]);

  useEffect(() => {
    fetchGroups();
  }, []);

  async function fetchGroups() {
    setLoadingGroups(true);
    try {
      const res = await api.get('/api/eztexting/groups');
      setGroups(res.data?.groups || []);
    } catch {
      // silently fail — groups may not be configured
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
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg, type,
    };
    setSmsLog(prev => [entry, ...prev].slice(0, 50));
    addLog(msg, type);
  }

  async function sendSms() {
    if (!message.trim()) { toast('Message is required', 'warn'); return; }
    const hasTarget = selectedGroups.length > 0 || belizeSelected || individual.trim();
    if (!hasTarget) { toast('Select at least one recipient or group', 'warn'); return; }

    setSending(true);
    const errors = [];

    if (selectedGroups.length > 0) {
      try {
        await api.post('/api/eztexting/send', {
          groups: selectedGroups.map(g => g.id),
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
                {alertTypes.map((at, i) => (
                  <div
                    key={i}
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
  );
}
