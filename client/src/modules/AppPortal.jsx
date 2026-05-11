import React from 'react';
import './AppPortal.css';

const PORTAL_URL = 'https://al-app-portal.vercel.app/';

export default function AppPortal() {
  return (
    <div className="ap-root">
      <iframe
        className="ap-frame"
        src={PORTAL_URL}
        title="App Portal"
        allow="fullscreen"
      />
    </div>
  );
}
