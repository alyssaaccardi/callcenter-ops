import React from 'react';
import { useApp } from '../../context/AppContext';

export default function Toast() {
  const { toasts } = useApp();
  return (
    <div id="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.type === 'success' && '✓ '}
          {t.type === 'error' && '✗ '}
          {t.type === 'warn' && '⚠ '}
          {t.message}
        </div>
      ))}
    </div>
  );
}
