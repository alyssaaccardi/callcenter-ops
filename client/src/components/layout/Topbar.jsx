import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';

const MODULE_TITLES = {
  status:   'System Status Board',
  sms:      'SMS Messaging',
  slack:    'Slack Workflows',
  monday:   'Agent Board',
  settings: 'Settings',
};

function useClock(tz) {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tz]);
  return time;
}

export default function Topbar({ activeModule }) {
  const { status, darkMode, setDarkMode } = useApp();
  const { user } = useAuth();
  const firstName = user?.name?.split(' ')[0] || '';
  const estTime = useClock('America/New_York');
  const bzTime  = useClock('America/Belize');

  const allOp = status ? (
    status.savvyPhone?.state !== 'DOWN' &&
    status.mitelClassic?.state !== 'DOWN' &&
    status.mobileApp?.state !== 'DOWN' &&
    !status.mobileApp?.messagesDown &&
    !status.integrations?.messagesDown
  ) : true;

  return (
    <div className="topbar">
      {firstName && (
        <div className="topbar-greeting">Hey {firstName}, have a savvy day!</div>
      )}
      <div className="topbar-right">
        <div className="dual-clock">
          <div className="dual-clock-entry">
            <span className="dual-clock-label">EST</span>
            <span className="dual-clock-time">{estTime}</span>
          </div>
          <div className="dual-clock-sep" />
          <div className="dual-clock-entry">
            <span className="dual-clock-label">BZ</span>
            <span className="dual-clock-time">{bzTime}</span>
          </div>
        </div>
        <div className={`global-badge ${allOp ? 'operational' : 'standby'}`}>
          {allOp ? 'All Systems Operational' : 'System Degraded'}
        </div>
        <button
          className="dark-toggle-btn"
          onClick={() => setDarkMode(d => !d)}
          title="Toggle dark mode"
        >
          {darkMode ? '☀️' : '🌙'}
        </button>
      </div>
    </div>
  );
}
