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

const ROLE_LABEL = {
  all:             'All Users',
  super_admin:     'Super Admin',
  call_center_ops: 'Call Center Ops',
  support:         'Support',
  tech:            'Tech Team',
  tv_display:      'TV Display',
};

function TutorialRow({ t, onToggle, onReset }) {
  const [toggling,  setToggling]  = useState(false);
  const [resetting, setResetting] = useState(false);

  async function handleToggle() {
    setToggling(true);
    await onToggle(t.id, !t.enabled);
    setToggling(false);
  }

  async function handleReset() {
    setResetting(true);
    await onReset(t.id);
    setResetting(false);
  }

  const roles = t.enabledRoles || [];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{t.title}</span>
          {roles.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {roles.map(r => (
                <span key={r} style={{
                  fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10,
                  background: 'rgba(168,85,247,0.12)', color: 'var(--purple)',
                }}>{ROLE_LABEL[r] || r}</span>
              ))}
            </div>
          )}
        </div>
        {t.description && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.description}</div>
        )}
      </div>
      <button
        className="btn btn-ghost btn-sm"
        style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}
        disabled={resetting}
        onClick={handleReset}
        title="Re-surface this tutorial for all users who dismissed it"
      >
        {resetting ? '…' : 'Reset'}
      </button>
      <button
        className={`btn btn-sm ${t.enabled ? 'btn-danger' : 'btn-primary'}`}
        style={{ fontSize: 11, minWidth: 60, flexShrink: 0 }}
        disabled={toggling}
        onClick={handleToggle}
      >
        {toggling ? '…' : t.enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  );
}

function TutorialsPanel() {
  const [tutorials, setTutorials] = useState([]);

  const load = useCallback(async () => {
    try { const r = await api.get('/api/tutorials/admin'); setTutorials(r.data.tutorials || []); } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(id, enabled) {
    try { await api.patch(`/api/tutorials/${id}`, { enabled }); await load(); } catch {}
  }

  async function handleReset(id) {
    try { await api.patch(`/api/tutorials/${id}`, { resetDismissals: true }); } catch {}
  }

  return (
    <div className="settings-card" style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>Tutorials</h3>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
        Toggle tutorials on or off. Shown to users based on their role. Reset clears dismissals so users see it again.
      </p>
      {tutorials.map(t => (
        <TutorialRow key={t.id} t={t} onToggle={handleToggle} onReset={handleReset} />
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
