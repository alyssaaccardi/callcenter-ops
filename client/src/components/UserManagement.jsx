import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';

const ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'call_center_ops', label: 'Call Center Ops' },
  { value: 'support', label: 'Support' },
  { value: 'tech', label: 'Tech Team' },
  { value: 'tv_display', label: 'TV Display' },
];

const ROLE_STYLE = {
  super_admin:    { background: 'rgba(99,102,241,0.2)',  color: '#a5b4fc' },
  call_center_ops:{ background: 'rgba(0,201,177,0.15)',  color: '#00c9b1' },
  support:        { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' },
  tech:           { background: 'rgba(16,185,129,0.15)', color: '#34d399' },
  tv_display:     { background: 'rgba(251,146,60,0.15)', color: '#fb923c' },
};

const ALL_ROLES = [
  { value: 'all',             label: 'All Users' },
  { value: 'super_admin',     label: 'Super Admin' },
  { value: 'call_center_ops', label: 'Call Center Ops' },
  { value: 'support',         label: 'Support' },
  { value: 'tech',            label: 'Tech Team' },
  { value: 'tv_display',      label: 'TV Display' },
];

function TutorialRow({ t, onSave, onReset }) {
  const [open,         setOpen]         = useState(false);
  const [enabled,      setEnabled]      = useState(t.enabled);
  const [enabledRoles, setEnabledRoles] = useState(t.enabledRoles || []);
  const [enabledUsers, setEnabledUsers] = useState(t.enabledUsers || []);
  const [userInput,    setUserInput]    = useState('');
  const [saving,       setSaving]       = useState(false);
  const [resetting,    setResetting]    = useState(false);
  const dirty = enabled !== t.enabled ||
    JSON.stringify([...enabledRoles].sort()) !== JSON.stringify([...(t.enabledRoles||[])].sort()) ||
    JSON.stringify([...enabledUsers].sort()) !== JSON.stringify([...(t.enabledUsers||[])].sort());

  function toggleRole(role) {
    if (role === 'all') {
      setEnabledRoles(r => r.includes('all') ? [] : ['all']);
    } else {
      setEnabledRoles(r => r.includes('all') ? [role] : r.includes(role) ? r.filter(x => x !== role) : [...r, role]);
    }
  }

  function addUser() {
    const e = userInput.trim().toLowerCase();
    if (!e || enabledUsers.includes(e)) return;
    setEnabledUsers(u => [...u, e]);
    setUserInput('');
  }

  async function save() {
    setSaving(true);
    await onSave(t.id, { enabled, enabledRoles, enabledUsers });
    setSaving(false);
  }

  async function handleReset() {
    setResetting(true);
    await onReset(t.id);
    setResetting(false);
  }

  const audience = enabledRoles.includes('all') ? 'All users' : [
    ...enabledRoles.map(r => ALL_ROLES.find(x => x.value === r)?.label || r),
    ...enabledUsers,
  ].join(', ') || 'No audience set';

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 13, color: 'var(--muted)', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{t.title}</span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
              background: enabled ? 'rgba(0,201,177,0.15)' : 'rgba(100,100,120,0.15)',
              color: enabled ? '#00c9b1' : 'var(--muted)',
            }}>{enabled ? 'ON' : 'OFF'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{audience}</div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, color: 'var(--muted)' }}
          disabled={resetting}
          onClick={e => { e.stopPropagation(); handleReset(); }}
          title="Re-surface this tutorial for all users who dismissed it"
        >
          {resetting ? '…' : 'Reset'}
        </button>
      </div>

      {/* expanded panel */}
      {open && (
        <div style={{ paddingBottom: 16, paddingLeft: 22 }} onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>{t.description}</div>

          {/* enabled toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Enabled</span>
            <button
              className={`btn btn-sm ${enabled ? 'btn-danger' : 'btn-primary'}`}
              style={{ fontSize: 11, minWidth: 56 }}
              onClick={() => setEnabled(v => !v)}
            >{enabled ? 'Disable' : 'Enable'}</button>
          </div>

          {/* roles */}
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>Roles</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {ALL_ROLES.map(r => {
              const active = enabledRoles.includes(r.value) || (r.value !== 'all' && enabledRoles.includes('all'));
              const dimmed = r.value !== 'all' && enabledRoles.includes('all');
              return (
                <button
                  key={r.value}
                  onClick={() => !dimmed && toggleRole(r.value)}
                  style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, cursor: dimmed ? 'default' : 'pointer',
                    border: `1.5px solid ${active ? 'rgba(168,85,247,0.5)' : 'rgba(168,85,247,0.15)'}`,
                    background: active ? 'rgba(168,85,247,0.14)' : 'transparent',
                    color: active ? 'var(--purple)' : 'var(--muted)',
                    opacity: dimmed ? 0.5 : 1,
                  }}
                >{r.label}</button>
              );
            })}
          </div>

          {/* specific users */}
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>Specific Users</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              value={userInput}
              onChange={e => setUserInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addUser()}
              placeholder="email@answeringlegal.com"
              style={{ flex: 1, fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1.5px solid rgba(168,85,247,0.2)', background: 'transparent', color: 'var(--text)' }}
            />
            <button className="btn btn-secondary btn-sm" onClick={addUser} style={{ fontSize: 11 }}>Add</button>
          </div>
          {enabledUsers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {enabledUsers.map(email => (
                <span key={email} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 11, padding: '2px 8px', borderRadius: 20,
                  background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', color: 'var(--purple)',
                }}>
                  {email}
                  <button onClick={() => setEnabledUsers(u => u.filter(x => x !== email))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          )}

          {dirty && (
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginTop: 4 }}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TutorialsPanel() {
  const [tutorials, setTutorials] = useState([]);

  const load = useCallback(async () => {
    try { const r = await api.get('/api/tutorials/admin'); setTutorials(r.data.tutorials || []); } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(id, patch) {
    try { await api.patch(`/api/tutorials/${id}`, patch); await load(); } catch {}
  }

  async function handleReset(id) {
    try { await api.patch(`/api/tutorials/${id}`, { resetDismissals: true }); } catch {}
  }

  return (
    <div className="settings-card" style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>Tutorials</h3>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
        Control which tutorials appear for which roles or specific users on login. Reset clears dismissals so users see it again.
      </p>
      {tutorials.map(t => (
        <TutorialRow key={t.id} t={t} onSave={handleSave} onReset={handleReset} />
      ))}
      {tutorials.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>No tutorials configured.</div>
      )}
    </div>
  );
}

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('call_center_ops');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmEmail, setConfirmEmail] = useState(null);

  async function fetchUsers() {
    try {
      const res = await api.get('/api/users');
      setUsers(res.data.users || []);
    } catch {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchUsers(); }, []);

  async function handleAdd(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!email || !name) { setError('Email and name are required'); return; }
    setAdding(true);
    try {
      await api.post('/api/users', { email: email.trim().toLowerCase(), name: name.trim(), role });
      setEmail('');
      setName('');
      setSuccess(`${name} added successfully`);
      await fetchUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add user');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userEmail) {
    if (confirmEmail !== userEmail) { setConfirmEmail(userEmail); return; }
    setConfirmEmail(null);
    try {
      await api.delete(`/api/users/${encodeURIComponent(userEmail)}`);
      await fetchUsers();
    } catch {
      setError('Failed to remove user');
    }
  }

  return (
    <div>
      <div className="settings-card">
        <h3>Users</h3>
        {loading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Dialing in...</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <th style={{ textAlign: 'left', padding: '8px 0', color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', fontSize: 11 }}>Email</th>
                <th style={{ textAlign: 'left', padding: '8px 0', color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', fontSize: 11 }}>Name</th>
                <th style={{ textAlign: 'left', padding: '8px 0', color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', fontSize: 11 }}>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.email} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '10px 0', color: 'var(--text)' }}>{u.email}</td>
                  <td style={{ padding: '10px 0', color: 'var(--text)' }}>{u.name}</td>
                  <td style={{ padding: '10px 0' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                      ...(ROLE_STYLE[u.role] || ROLE_STYLE.call_center_ops),
                    }}>
                      {ROLES.find(r => r.value === u.role)?.label || u.role}
                    </span>
                  </td>
                  <td style={{ padding: '10px 0', textAlign: 'right' }}>
                    {confirmEmail === u.email ? (
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: 'var(--danger)' }}>Confirm?</span>
                        <button className="btn btn-danger btn-sm" onClick={() => handleRemove(u.email)}>Yes</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmEmail(null)}>No</button>
                      </span>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleRemove(u.email)}
                        style={{ color: 'var(--danger)', fontSize: 12 }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-card">
        <h3>Add User</h3>
        {error && <div className="notice notice-err mb-12">{error}</div>}
        {success && <div className="notice notice-ok mb-12">{success}</div>}
        <form onSubmit={handleAdd}>
          <div className="settings-grid">
            <div className="form-row">
              <label className="field-label">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="user@answeringlegal.com"
              />
            </div>
            <div className="form-row">
              <label className="field-label">Display Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="First Last"
              />
            </div>
            <div className="form-row">
              <label className="field-label">Role</label>
              <select value={role} onChange={e => setRole(e.target.value)}>
                {ROLES.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <button className="btn btn-primary btn-sm mt-12" type="submit" disabled={adding}>
            {adding ? 'Adding...' : 'Add User'}
          </button>
        </form>
      </div>

      <TutorialsPanel />
    </div>
  );
}
