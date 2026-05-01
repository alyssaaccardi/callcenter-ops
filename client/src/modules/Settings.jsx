import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import UserManagement from '../components/UserManagement';

const SETTINGS_TABS = [
  { id: 'general',    label: 'Call Centers' },
  { id: 'alert-cfg',  label: 'Alert Templates' },
  { id: 'canned-cfg', label: 'Canned Responses' },
  { id: 'users',      label: 'User Management' },
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
  const { toast, addLog } = useApp();
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

  // Canned responses
  const [cannedResponses, setCannedResponses] = useLocalSetting('ccob_canned', []);


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

  function addCannedRow() {
    setCannedResponses([...cannedResponses, { label: '', msg: '' }]);
  }
  function updateCanned(i, field, val) {
    const next = cannedResponses.map((c, idx) => idx === i ? { ...c, [field]: val } : c);
    setCannedResponses(next);
  }
  function removeCanned(i) {
    setCannedResponses(cannedResponses.filter((_, idx) => idx !== i));
  }

  function saveAll() {
    toast('Settings saved', 'success');
    addLog('Settings saved', 'ok');
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">API keys, integrations, and call center configuration</div>
        </div>
        <button className="btn btn-primary" onClick={saveAll}>Save All Settings</button>
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
          {cannedResponses.map((c, i) => (
            <div key={i} className="alert-type-row">
              <div className="settings-grid mb-8">
                <div className="form-row" style={{ marginBottom: 0 }}>
                  <label className="field-label">Label</label>
                  <input type="text" value={c.label} onChange={e => updateCanned(i, 'label', e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeCanned(i)} style={{ color: 'var(--danger)' }}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label className="field-label">Message</label>
                <textarea
                  rows={2}
                  value={c.msg}
                  onChange={e => updateCanned(i, 'msg', e.target.value)}
                  style={{ minHeight: 60 }}
                />
              </div>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={addCannedRow}>+ Add Response</button>
        </div>
      )}

      {/* User Management */}
      {activeTab === 'users' && <UserManagement />}
    </div>
  );
}
