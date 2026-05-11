import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const KEY     = 'ccob_wn_v1';
const SESSION = 'ccob_wn_session';
const ROLES   = ['super_admin', 'call_center_ops'];

const STEPS = [
  {
    icon: '💬',
    title: 'Canned Responses',
    subtitle: "Pre-written status messages at your fingertips",
    body: (
      <>
        <p>Canned responses are saved message templates you can instantly apply when updating a call center's status — no retyping the same message every time.</p>
        <p>They show up as a dropdown on the <strong>Status Board</strong> and let you blast out consistent messages in one click.</p>
        <div className="wn-callout">
          <span className="wn-callout-icon">💡</span>
          Great for recurring situations — system degradations, scheduled maintenance, carrier outages, or "all clear" messages.
        </div>
      </>
    ),
  },
  {
    icon: '🖱️',
    title: 'Using a Canned Response',
    subtitle: 'Fill your status message in one click',
    body: (
      <>
        <div className="wn-steps-list">
          <div className="wn-step-row">
            <div className="wn-step-num">1</div>
            <div className="wn-step-text">Open <strong>Status Board</strong> from the sidebar.</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">2</div>
            <div className="wn-step-text">Select the <strong>Savvy Phone</strong> or <strong>Mitel Classic</strong> tab.</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">3</div>
            <div className="wn-step-text">Click the <strong>"— Select Canned Response —"</strong> dropdown beneath <em>Status Message</em>.</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">4</div>
            <div className="wn-step-text">Pick a template — it fills the message box instantly. Hit <strong>Save Message</strong>.</div>
          </div>
        </div>
      </>
    ),
  },
  {
    icon: '✏️',
    title: 'Creating Canned Responses',
    subtitle: 'Build your library in Settings',
    body: (
      <>
        <div className="wn-steps-list">
          <div className="wn-step-row">
            <div className="wn-step-num">1</div>
            <div className="wn-step-text">Click <strong>⚙️ Settings</strong> in the sidebar (scroll down if needed).</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">2</div>
            <div className="wn-step-text">Open the <strong>Canned Responses</strong> tab.</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">3</div>
            <div className="wn-step-text">Click <strong>+ Add Response</strong>, then fill in a short <em>label</em> (e.g. "Carrier Outage") and the full <em>message text</em>.</div>
          </div>
          <div className="wn-step-row">
            <div className="wn-step-num">4</div>
            <div className="wn-step-text">Saves automatically to your browser. Available immediately on the Status Board.</div>
          </div>
        </div>
        <div className="wn-callout">
          <span className="wn-callout-icon">📌</span>
          Canned responses are stored per-browser. Each user on their own machine manages their own library.
        </div>
      </>
    ),
  },
];

export default function WhatsNew() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  const [step, setStep]       = useState(0);

  useEffect(() => {
    if (!user) return;
    if (!ROLES.includes(user.role)) return;
    if (localStorage.getItem(KEY)) return;
    if (sessionStorage.getItem(SESSION)) return;
    setVisible(true);
  }, [user]);

  if (!visible) return null;

  function dismiss() {
    sessionStorage.setItem(SESSION, '1');
    setVisible(false);
  }

  function gotIt() {
    localStorage.setItem(KEY, '1');
    setVisible(false);
  }

  const isFirst = step === 0;
  const isLast  = step === STEPS.length - 1;
  const s       = STEPS[step];

  return (
    <div className="wn-overlay" onClick={e => e.target === e.currentTarget && dismiss()}>
      <div className="wn-modal" role="dialog" aria-modal="true">
        <div className="wn-header">
          <div className="wn-eyebrow">✨ What's New</div>
          <button className="wn-close" onClick={dismiss} aria-label="Close">✕</button>
        </div>

        <div className="wn-body">
          <div className="wn-icon">{s.icon}</div>
          <div className="wn-title">{s.title}</div>
          <div className="wn-subtitle">{s.subtitle}</div>
          <div className="wn-content">{s.body}</div>
        </div>

        <div className="wn-dots">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`wn-dot${i === step ? ' active' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        <div className="wn-footer">
          {!isFirst && (
            <button className="btn btn-ghost btn-sm" onClick={() => setStep(s => s - 1)}>
              ← Back
            </button>
          )}
          <span style={{ flex: 1 }} />
          {!isLast ? (
            <button className="btn btn-secondary btn-sm" onClick={() => setStep(s => s + 1)}>
              Next →
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={gotIt}>
              Got it!
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
