import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';

const ALL_SETTINGS_TABS = [
  { id: 'general',    label: 'Call Centers',     roles: ['super_admin', 'call_center_ops'] },
  { id: 'alert-cfg',  label: 'Alert Templates',  roles: ['super_admin', 'call_center_ops'] },
  { id: 'canned-cfg', label: 'Canned Responses', roles: ['super_admin', 'call_center_ops'] },
  { id: 'portal',     label: 'Employee Portal',  roles: ['super_admin', 'call_center_ops'] },
];

function useLocalSetting(key, defaultVal) {
  const [val, setVal] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? defaultVal; } catch { return defaultVal; }
  });
  function update(v) {
    setVal(v);
    localStorage.setItem(key, JSON.stringify(v));
  }
  return [val, update];
}

export default function Settings() {
  const { user } = useAuth();
  const SETTINGS_TABS = ALL_SETTINGS_TABS.filter(t => t.roles.includes(user?.role));
  const [activeTab, setActiveTab] = useState('general');

  // Call centers
  const [savvyName, setSavvyName] = useLocalSetting('ccob_savvyName', 'Savvy Phone');
  const [savvyLoc, setSavvyLoc] = useLocalSetting('ccob_savvyLoc', 'Stafford Location');
  const [mitelName, setMitelName] = useLocalSetting('ccob_mitelName', 'Mitel Classic');
  const [mitelLoc, setMitelLoc] = useLocalSetting('ccob_mitelLoc', 'Mitel Location');

  // Alert types
  const [alertTypes, setAlertTypes] = useLocalSetting('ccob_alertTypes', [
    { label: 'System Down', msg: 'URGENT: System is currently down. Please stand by.' },
    { label: 'Maintenance', msg: 'Scheduled maintenance in progress.' },
  ]);

  // Canned responses — server-side
  const [cannedResponses, setCannedResponses] = useState([]);
  const [cannedLoaded, setCannedLoaded] = useState(false);

  useEffect(() => {
    if (activeTab === 'canned-cfg' && !cannedLoaded) {
      api.get('/api/canned-responses').then(r => { setCannedResponses(r.data || []); setCannedLoaded(true); }).catch(() => {});
    }
  }, [activeTab, cannedLoaded]);


  function addAlertType() {
    setAlertTypes([...alertTypes, { label: 'New Alert', msg: '' }]);
  }
  function updateAlertType(i, field, val) {
    const next = alertTypes.map((a, idx) => idx === i ? { ...a, [field]: val } : a);
    setAlertTypes(next);
  }
  function removeAlertType(i) {
    setAlertTypes(alertTypes.filter((_, idx) => idx !== i));
  }

  async function addCannedRow() {
    try {
      const r = await api.post('/api/canned-responses', { label: '', msg: '' });
      setCannedResponses(prev => [...prev, r.data]);
    } catch {}
  }

  async function saveCanned(id, label, msg) {
    try {
      const r = await api.put(`/api/canned-responses/${id}`, { label, msg });
      setCannedResponses(prev => prev.map(c => c.id === id ? r.data : c));
    } catch {}
  }

  async function removeCanned(id) {
    try {
      await api.delete(`/api/canned-responses/${id}`);
      setCannedResponses(prev => prev.filter(c => c.id !== id));
    } catch {}
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">API keys, integrations, and call center configuration</div>
        </div>
      </div>

      <div className="settings-subnav">
        {SETTINGS_TABS.map(t => (
          <div
            key={t.id}
            className={`settings-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* Call Centers */}
      {activeTab === 'general' && (
        <>
          <div className="settings-card">
            <h3>Savvy Phone</h3>
            <div className="settings-grid">
              <div className="form-row">
                <label className="field-label">Display Name</label>
                <input type="text" value={savvyName} onChange={e => setSavvyName(e.target.value)} />
              </div>
              <div className="form-row">
                <label className="field-label">Location Label</label>
                <input type="text" value={savvyLoc} onChange={e => setSavvyLoc(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="settings-card">
            <h3>Mitel Classic</h3>
            <div className="settings-grid">
              <div className="form-row">
                <label className="field-label">Display Name</label>
                <input type="text" value={mitelName} onChange={e => setMitelName(e.target.value)} />
              </div>
              <div className="form-row">
                <label className="field-label">Location Label</label>
                <input type="text" value={mitelLoc} onChange={e => setMitelLoc(e.target.value)} />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Alert Templates */}
      {activeTab === 'alert-cfg' && (
        <div className="settings-card">
          <h3>Alert Templates</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
            Each template appears as a quick-select button on the SMS tab.
          </p>
          {alertTypes.map((at, i) => (
            <div key={i} className="alert-type-row">
              <div className="settings-grid mb-8">
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label className="field-label">Label</label>
                  <input type="text" value={at.label} onChange={e => updateAlertType(i, 'label', e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeAlertType(i)} style={{ color: 'var(--danger)' }}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label className="field-label">Message Template</label>
                <textarea
                  rows={2}
                  value={at.msg}
                  onChange={e => updateAlertType(i, 'msg', e.target.value)}
                  style={{ minHeight: 60, fontFamily: 'var(--mono)', fontSize: 11 }}
                />
              </div>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addAlertType}>+ Add Template</button>
        </div>
      )}

      {/* Canned Responses */}
      {activeTab === 'canned-cfg' && (
        <div className="settings-card">
          <h3>Canned Responses</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
            Shared across all operators. Pick one on the Status Board to instantly fill a message — it appears in the Employee Portal widget in real time.
          </p>
          {cannedResponses.map(c => (
            <CannedRow key={c.id} entry={c} onSave={saveCanned} onRemove={removeCanned} />
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addCannedRow}>+ Add Response</button>
        </div>
      )}

      {/* Employee Portal */}
      {activeTab === 'portal' && <PortalWidgets />}
    </div>
  );
}

function CannedRow({ entry, onSave, onRemove }) {
  const [label, setLabel] = useState(entry.label);
  const [msg, setMsg] = useState(entry.msg);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dirty = label !== entry.label || msg !== entry.msg;

  async function handleSave() {
    setSaving(true);
    await onSave(entry.id, label, msg);
    setSaving(false);
  }

  async function handleRemove() {
    setRemoving(true);
    await onRemove(entry.id);
  }

  return (
    <div className="alert-type-row">
      <div className="settings-grid mb-8">
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label className="field-label">Label</label>
          <input type="text" value={label} onChange={e => setLabel(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          {dirty && (
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={handleRemove} disabled={removing} style={{ color: 'var(--danger)' }}>
            {removing ? '…' : 'Remove'}
          </button>
        </div>
      </div>
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label className="field-label">Message</label>
        <textarea rows={2} value={msg} onChange={e => setMsg(e.target.value)} style={{ minHeight: 60 }} />
      </div>
    </div>
  );
}

function PortalWidgets() {
  const [copied, setCopied] = useState(null);
  const base = window.location.origin;
  const apiKey = 'ccops2024secret';

  const widgets = [
    { id: 'savvy', label: 'Savvy Phone', cc: 'savvy' },
    { id: 'mitel', label: 'Mitel Classic', cc: 'mitel' },
  ];

  function iframeUrl(cc) {
    return `${base}/widget?cc=${cc}&key=${apiKey}`;
  }

  function iframeEmbed(cc) {
    return `<iframe src="${iframeUrl(cc)}" width="320" height="90" frameborder="0" scrolling="no" style="border:none;"></iframe>`;
  }

  function copy(text, id) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <>
      <div className="settings-card">
        <h3>Employee Portal Widgets</h3>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          Embeddable status widgets for the Answering Legal staff site. Add each as an HTML iframe in Wix via Insert → Embed → HTML iFrame.
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 0 }}>
          Status messages set on the <strong style={{ color: 'var(--text)' }}>Status Board</strong> — including canned responses — appear inside these widgets in real time.
        </p>
      </div>
      {widgets.map(w => (
        <div className="settings-card" key={w.id}>
          <h3>{w.label}</h3>
          <div className="form-row" style={{ marginBottom: 12 }}>
            <label className="field-label">Widget URL</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" readOnly value={iframeUrl(w.cc)} style={{ fontFamily: 'var(--mono)', fontSize: 11 }} />
              <button className="btn btn-secondary btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={() => copy(iframeUrl(w.cc), `url-${w.id}`)}>
                {copied === `url-${w.id}` ? 'Copied!' : 'Copy URL'}
              </button>
            </div>
          </div>
          <div className="form-row" style={{ marginBottom: 16 }}>
            <label className="field-label">Embed Code</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" readOnly value={iframeEmbed(w.cc)} style={{ fontFamily: 'var(--mono)', fontSize: 11 }} />
              <button className="btn btn-secondary btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={() => copy(iframeEmbed(w.cc), `embed-${w.id}`)}>
                {copied === `embed-${w.id}` ? 'Copied!' : 'Copy Embed'}
              </button>
            </div>
          </div>
          <label className="field-label" style={{ marginBottom: 8, display: 'block' }}>Live Preview</label>
          <iframe
            src={iframeUrl(w.cc)}
            width="320"
            height="90"
            frameBorder="0"
            scrolling="no"
            style={{ border: 'none', borderRadius: 8, display: 'block' }}
            title={`${w.label} widget preview`}
          />
        </div>
      ))}
    </>
  );
}
