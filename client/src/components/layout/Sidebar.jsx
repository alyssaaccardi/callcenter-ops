import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import api from '../../api';

const NAV_ITEMS = [
  { id: 'status',   icon: '📊', label: 'Status Board', statusDot: true },
  { id: 'sms',      icon: '📱', label: 'SMS Messaging' },
  { id: 'slack',    icon: '💬', label: 'Slack Workflows' },
  { id: 'monday',   icon: '📋', label: 'Agent Board' },
];

const ROLE_LABELS = {
  super_admin:     'Super Admin',
  call_center_ops: 'Call Center Ops',
};

export default function Sidebar({ activeModule, onModuleChange }) {
  const { status, toast } = useApp();
  const { user } = useAuth();
  const [displaysExpanded, setDisplaysExpanded] = useState(false);

  const savvyUp = status?.savvyPhone?.state !== 'DOWN';

  async function openDialedIn() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/dialed-in?t=${token}`, '_blank');
    } catch {
      toast('Could not open Dialed In Dash', 'error');
    }
  }

  async function openMobile() {
    window.open('/mobile', '_blank');
  }

  async function openPulse() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/dialed-in-pulse?t=${token}`, '_blank');
    } catch {
      toast('Could not open Sales/Support Teams Dash', 'error');
    }
  }

  const initial = (user?.name || user?.email || '?')[0].toUpperCase();
  const displayName = user?.name || user?.email || '';
  const roleLabel = ROLE_LABELS[user?.role] || user?.role || '';

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-brand">
          <img
            src="/dialedin-logo-dark.png"
            alt="CCOB"
            onError={e => { e.target.style.display='none'; }}
          />
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section-label">Operations</div>

        {NAV_ITEMS.map(item => (
          <div
            key={item.id}
            className={`nav-item${activeModule === item.id ? ' active' : ''}`}
            onClick={() => onModuleChange(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
            {item.statusDot && (
              <span className={`status-mini ${savvyUp ? 'up' : 'down'}`} />
            )}
          </div>
        ))}

        <div
          className={`nav-item${displaysExpanded ? ' expanded' : ''}`}
          onClick={() => setDisplaysExpanded(v => !v)}
        >
          <span className="nav-icon">📺</span>
          Dialed In Displays
          <span className="nav-chevron">▶</span>
        </div>
        <div className={`nav-subitem${displaysExpanded ? ' expanded' : ''}`} onClick={openDialedIn}>
          <span className="nav-icon" style={{ fontSize: 13 }}>🖥️</span>
          Dialed In Dash
        </div>
        <div className={`nav-subitem${displaysExpanded ? ' expanded' : ''}`} onClick={openMobile}>
          <span className="nav-icon" style={{ fontSize: 13 }}>📲</span>
          Mobile Quick Dash
        </div>
        <div className={`nav-subitem${displaysExpanded ? ' expanded' : ''}`} onClick={openPulse}>
          <span className="nav-icon" style={{ fontSize: 13 }}>📡</span>
          Sales/Support Teams Dash
        </div>

        {user?.role === 'super_admin' && (
          <>
            <div className="nav-section-label">Administration</div>
            <div
              className={`nav-item${activeModule === 'settings' ? ' active' : ''}`}
              onClick={() => onModuleChange('settings')}
            >
              <span className="nav-icon">⚙️</span>
              Settings
            </div>
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <div className="user-info">
          <div className="user-avatar">{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="user-name">{displayName}</div>
            <div className="user-role">{roleLabel}</div>
          </div>
          <button
            onClick={() => { window.location.href = '/auth/logout'; }}
            title="Sign out"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: 16, padding: '0 4px', flexShrink: 0,
            }}
          >
            ↪
          </button>
        </div>
      </div>
    </aside>
  );
}
