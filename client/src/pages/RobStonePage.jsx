import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import Scriptor from '../modules/Scriptor';

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
);

// Rob-branded Google login — used when an unauthenticated user hits /rob.
function RobLogin({ returnTo = '/rob' }) {
  const error = new URLSearchParams(window.location.search).get('error');
  return (
    <div className="login-root">
      <div className="login-card">
        <img src="/rob-osetta-stone.png" alt="The Rob-osetta Stone" style={{ width: 120, height: 120, borderRadius: 16, objectFit: 'cover', margin: '0 auto' }} />
        <div className="login-divider" />
        <div className="login-tod">The Rob-osetta Stone</div>
        <div className="login-tagline">
          Turning Rob's handwriting<br />into plain English since 2014.
        </div>
        {error === 'unauthorized' && (
          <div className="login-error">Your account is not authorized. Contact your administrator.</div>
        )}
        <a href={`/auth/google?returnTo=${encodeURIComponent(returnTo)}`} className="login-google-btn">
          <GoogleIcon />
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

// Chrome-less shell: no sidebar, just a slim top bar + the module.
// Exported so App.jsx can render it at the root for scriptor-only users.
export function RobStoneApp() {
  const { user } = useAuth();
  return (
    <div style={{ minHeight: '100vh', padding: '20px 24px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto 6px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
        {user?.name && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{user.name}</span>}
        <button
          onClick={() => { window.location.href = '/auth/logout'; }}
          style={{ background: 'none', border: '1px solid var(--border, rgba(0,0,0,0.15))', borderRadius: 8, padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' }}
        >
          Sign out
        </button>
      </div>
      <Scriptor />
    </div>
  );
}

function NoAccess() {
  return (
    <div className="login-root">
      <div className="login-card">
        <img src="/rob-osetta-stone.png" alt="The Rob-osetta Stone" style={{ width: 96, height: 96, borderRadius: 14, objectFit: 'cover', margin: '0 auto' }} />
        <div className="login-divider" />
        <div className="login-tod">No access</div>
        <div className="login-tagline">Your account isn't set up for<br />The Rob-osetta Stone.</div>
        <a href="/auth/logout" className="login-google-btn" style={{ justifyContent: 'center' }}>Sign out</a>
      </div>
    </div>
  );
}

// Standalone route for /rob — handles its own auth + role gate.
export default function RobStonePage() {
  const { user, loading } = useAuth();

  useEffect(() => { document.title = 'The Rob-osetta Stone'; }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <span className="spinner" />
      </div>
    );
  }
  if (!user) return <RobLogin returnTo="/rob" />;

  const roles = [user.role, ...(user.additionalRoles || [])].filter(Boolean);
  if (!roles.includes('scriptor') && !roles.includes('super_admin')) return <NoAccess />;

  return <RobStoneApp />;
}
