import React, { useState, useEffect } from 'react';
import api from '../api';

const ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'call_center_ops', label: 'Call Center Ops' },
];

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('call_center_ops');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
    if (!confirm(`Remove ${userEmail}?`)) return;
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
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
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
                      background: u.role === 'super_admin' ? 'rgba(99,102,241,0.2)' : 'rgba(0,201,177,0.15)',
                      color: u.role === 'super_admin' ? '#a5b4fc' : '#00c9b1',
                    }}>
                      {ROLES.find(r => r.value === u.role)?.label || u.role}
                    </span>
                  </td>
                  <td style={{ padding: '10px 0', textAlign: 'right' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleRemove(u.email)}
                      style={{ color: 'var(--danger)', fontSize: 12 }}
                    >
                      Remove
                    </button>
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
    </div>
  );
}
