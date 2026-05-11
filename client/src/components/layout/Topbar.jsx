import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';

const GREETINGS = [
  "have a great day.",
  "you're doing amazing.",
  "make it a good one.",
  "today's a good day to have a good day.",
  "you've got this.",
  "keep being awesome.",
  "good energy only.",
  "the best is yet to come.",
  "another day, another win.",
  "you make a difference.",
  "stay focused, stay great.",
  "big things incoming.",
  "you belong here.",
  "proud of the work you do.",
  "make today count.",
  "it's a good day to be you.",
  "nothing but wins today.",
  "your effort never goes unnoticed.",
  "the team is better with you in it.",
  "every call is a chance to shine.",
  "good vibes, good work.",
  "you're on a roll.",
  "keep going — you're building something.",
  "you radiate competence.",
  "crushing it, as always.",
  "great things are happening.",
  "just here to remind you that you're great.",
  "energy matched: excellent.",
  "confidence level: elite.",
  "you're exactly where you need to be.",
];

// Changes every 90 minutes, same for all users
function currentGreeting() {
  const bucket = Math.floor(Date.now() / (90 * 60 * 1000));
  return GREETINGS[bucket % GREETINGS.length];
}

function timeOfDay() {
  const h = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }), 10);
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function useClock(tz) {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz })
  );
  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }));
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tz]);
  return time;
}

export default function Topbar() {
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
      <div>
        {firstName && (
          <>
            <div className="topbar-greet-name">{timeOfDay()} {firstName},</div>
            <div className="topbar-greet-pun">{currentGreeting()}</div>
          </>
        )}
      </div>
      <div className="topbar-right">
        <div className="dual-clock">
          <div className="dual-clock-entry">
            <span className="dual-clock-label">EST</span>
            <span className="dual-clock-time">{estTime}</span>
          </div>
          {(user?.role === 'super_admin' || user?.role === 'call_center_ops') && (
            <>
              <div className="dual-clock-sep" />
              <div className="dual-clock-entry">
                <span className="dual-clock-label">BZ</span>
                <span className="dual-clock-time">{bzTime}</span>
              </div>
            </>
          )}
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
