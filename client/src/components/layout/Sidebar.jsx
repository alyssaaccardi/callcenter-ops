import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import api from '../../api';

const ALL_NAV_ITEMS = [
  { id: 'status',           icon: '📊', label: 'Status Board',    statusDot: true, roles: ['super_admin', 'call_center_ops'], section: 'Operations'    },
  { id: 'sms',              icon: '📱', label: 'SMS Messaging',                    roles: ['super_admin', 'call_center_ops'], section: 'Operations'    },
  { id: 'slack',            icon: '💬', label: 'Slack Workflows',                  roles: ['super_admin', 'call_center_ops'], section: 'Operations'    },
  { id: 'monday',           icon: '📋', label: 'Agent Board',                      roles: ['super_admin', 'call_center_ops'], section: 'Operations'    },
  { id: 'settings',         icon: '⚙️', label: 'Settings',                         roles: ['super_admin', 'call_center_ops'], section: 'Operations'    },
  { id: 'support-center',   icon: '🎧', label: 'Support Center',                   roles: ['super_admin', 'support'],         section: 'Support'       },
  { id: 'account-review',   icon: '🔍', label: 'Account Review',                   roles: ['super_admin', 'support'],         section: 'Support'       },
  { id: 'team-leaderboard', icon: '🏆', label: 'Team Leaderboard',                 roles: ['super_admin', 'support'],         section: 'Support'       },
  { id: 'tech-center',      icon: '🔧', label: 'Tech Center',      roles: ['super_admin', 'tech'], section: 'Tech'           },
  { id: 'tech-leaderboard', icon: '🏆', label: 'Team Leaderboard', roles: ['super_admin', 'tech'], section: 'Tech'           },
  { id: 'app-portal',       icon: '🌐', label: 'App Portal',       roles: ['super_admin', 'tech'], section: 'Tech'           },
  { id: 'user-management',  icon: '👥', label: 'User Management',  roles: ['super_admin'],         section: 'Administration' },
];

const ROLE_LABELS = {
  super_admin:     'Super Admin',
  call_center_ops: 'Call Center Ops',
  support:         'Support',
  tech:            'Tech Team',
  tv_display:      'TV Display',
};

const NAV_SECTION_LABEL = {
  super_admin:     'Operations',
  call_center_ops: 'Operations',
  support:         'Support',
  tv_display:      'Displays',
};

export default function Sidebar({ activeModule, onModuleChange }) {
  const { status, toast } = useApp();
  const { user } = useAuth();
  const isTvDisplay  = user?.role === 'tv_display';
  const isOpsOrAdmin = user?.role === 'super_admin' || user?.role === 'call_center_ops';
  const [displaysExpanded, setDisplaysExpanded] = useState(isTvDisplay || isOpsOrAdmin);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === '1');
  const [tooltip, setTooltip] = useState(null); // { text, top }

  function toggleCollapse() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebar_collapsed', next ? '1' : '0');
      document.body.classList.toggle('sidebar-collapsed', next);
      return next;
    });
  }

  React.useEffect(() => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
  }, []);

  function showTooltip(e, text) {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ text, top: rect.top + rect.height / 2 });
  }

  const savvyUp  = status?.savvyPhone?.state !== 'DOWN';
  const navItems = ALL_NAV_ITEMS.filter(item => item.roles.includes(user?.role));

  async function openDialedIn() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/dialed-in?t=${token}`, '_blank');
    } catch { toast('Could not open Dialed In Dash', 'error'); }
  }

  async function openMobile() { window.open('/mobile', '_blank'); }

  async function openSupportDash() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/support-dash?t=${token}`, '_blank');
    } catch { toast('Could not open Support Teams Dash', 'error'); }
  }

  async function openTechDash() {
    try {
      const res = await api.post('/api/tv-session');
      const token = res.data?.token;
      if (token) window.open(`/tech-dash?t=${token}`, '_blank');
    } catch { toast('Could not open Tech Team Dash', 'error'); }
  }

  const DISPLAY_ITEMS = [
    { id: 'dialed-in',    icon: '🖥️', label: 'Dialed In Dash',    roles: ['super_admin', 'call_center_ops', 'tv_display'], onClick: openDialedIn },
    { id: 'mobile',       icon: '📲', label: 'Mobile Quick Dash',  roles: ['super_admin', 'call_center_ops', 'tv_display'], onClick: openMobile },
    { id: 'support-dash', icon: '📡', label: 'Support Teams Dash', roles: ['super_admin', 'support', 'tv_display'],         onClick: openSupportDash },
    { id: 'tech-dash',    icon: '🔬', label: 'Tech Team Dash',     roles: ['super_admin', 'tech', 'tv_display'],             onClick: openTechDash },
  ];

  const visibleDisplays = DISPLAY_ITEMS.filter(d => d.roles.includes(user?.role));
  const initial     = (user?.name || user?.email || '?')[0].toUpperCase();
  const displayName = user?.name || user?.email || '';
  const roleLabel   = ROLE_LABELS[user?.role] || user?.role || '';

  const navSections = navItems.reduce((acc, item) => {
    const sec = item.section || NAV_SECTION_LABEL[user?.role] || 'Workspace';
    if (!acc[sec]) acc[sec] = [];
    acc[sec].push(item);
    return acc;
  }, {});

  const sidebarWidth = collapsed ? 96 : 240;

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-logo">
        <div className="sidebar-brand">
          <img
            src="/dialedin-logo-dark.png"
            alt="Dialed In Dash"
            onError={e => { e.target.style.display = 'none'; }}
          />
          {!collapsed && <div className="sidebar-brand-name">DIALED IN DASH</div>}
        </div>
      </div>

      <button className="sidebar-collapse-btn" onClick={toggleCollapse} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? '›' : '‹'}
      </button>

      <nav className="sidebar-nav">
        {Object.entries(navSections).map(([secLabel, items]) => (
          <React.Fragment key={secLabel}>
            {!collapsed && <div className="nav-section-label">{secLabel}</div>}
            {items.map(item => (
              <div
                key={item.id}
                className={`nav-item${activeModule === item.id ? ' active' : ''}`}
                onClick={() => onModuleChange(item.id)}
                onMouseEnter={e => collapsed && showTooltip(e, item.label)}
                onMouseLeave={() => setTooltip(null)}
              >
                <span className="nav-icon">{item.icon}</span>
                {!collapsed && item.label}
                {!collapsed && item.statusDot && (
                  <span className={`status-mini ${savvyUp ? 'up' : 'down'}`} />
                )}
              </div>
            ))}
          </React.Fragment>
        ))}

        {visibleDisplays.length > 0 && (
          <>
            {navItems.length > 0 && !isTvDisplay && <div style={{ height: 4 }} />}
            <div
              className={`nav-item${displaysExpanded ? ' expanded' : ''}`}
              onClick={() => !collapsed && setDisplaysExpanded(v => !v)}
              onMouseEnter={e => collapsed && showTooltip(e, 'Displays')}
              onMouseLeave={() => setTooltip(null)}
            >
              <span className="nav-icon">📺</span>
              {!collapsed && <>Displays<span className="nav-chevron">▶</span></>}
            </div>
            {!collapsed && visibleDisplays.map(d => (
              <div
                key={d.id}
                className={`nav-subitem${displaysExpanded ? ' expanded' : ''}`}
                onClick={d.onClick}
              >
                <span className="nav-icon" style={{ fontSize: 13 }}>{d.icon}</span>
                {d.label}
              </div>
            ))}
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <div className="user-info">
          {user?.picture
            ? <img src={user.picture} alt={displayName} className="user-avatar user-avatar--photo" referrerPolicy="no-referrer" />
            : <div className="user-avatar">{initial}</div>
          }
          {!collapsed && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="user-name">{displayName}</div>
              <div className="user-role">{roleLabel}</div>
            </div>
          )}
          {!collapsed && (
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
          )}
        </div>
      </div>

      {/* Fixed-position tooltip — escapes overflow without causing scroll */}
      {tooltip && (
        <div className="sidebar-tooltip" style={{ top: tooltip.top, left: sidebarWidth + 10 }}>
          {tooltip.text}
        </div>
      )}
    </aside>
  );
}
