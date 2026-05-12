import React from 'react';

export default function UserBadge({ user }) {
  if (!user) return null;
  const initial = (user.name || user.email || '?')[0].toUpperCase();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {user.picture
        ? <img src={user.picture} alt="" referrerPolicy="no-referrer" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        : <div className="user-avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{initial}</div>
      }
      <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{user.name || user.email}</span>
    </div>
  );
}
