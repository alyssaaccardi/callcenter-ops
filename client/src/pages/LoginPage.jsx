import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'var(--bg)', flexDirection: 'column', gap: 24,
    }}>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.8 }}>📞</div>
        <h1 style={{ fontFamily: 'var(--sans)', fontWeight: 800, fontSize: 24, margin: 0, color: 'var(--text)' }}>
          Call Center Ops
        </h1>
        <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 14 }}>
          Sign in with your AnsweringLegal Google account
        </p>
      </div>

      {error === 'unauthorized' && (
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8, padding: '10px 16px', color: '#ef4444', fontSize: 13,
          maxWidth: 320, textAlign: 'center',
        }}>
          Your account is not authorized. Contact your administrator.
        </div>
      )}

      <a
        href="/auth/google"
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: '#fff', color: '#333', padding: '12px 24px',
          borderRadius: 8, fontFamily: 'var(--sans)', fontWeight: 600,
          fontSize: 15, textDecoration: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          border: '1px solid rgba(0,0,0,0.1)', cursor: 'pointer',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Sign in with Google
      </a>
    </div>
  );
}
