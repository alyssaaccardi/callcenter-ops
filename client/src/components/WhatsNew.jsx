import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api';

const SESSION_KEY = 'ccob_wn_closed';

/* ── Mini UI mockup helpers ──────────────────────────────────────────────── */

function UiSelect({ label }) {
  return (
    <div className="wn-ui-select">
      <span>{label}</span><span className="wn-ui-select-arrow">▾</span>
    </div>
  );
}
function UiTabs({ tabs, active }) {
  return (
    <div className="wn-ui-tabs">
      {tabs.map(t => <div key={t} className={`wn-ui-tab${t === active ? ' active' : ''}`}>{t}</div>)}
    </div>
  );
}
function UiButton({ label, variant = 'secondary' }) {
  return <div className={`wn-ui-btn ${variant}`}>{label}</div>;
}
function UiSidebarItem({ icon, label }) {
  return (
    <div className="wn-ui-sidebar-item"><span>{icon}</span><span>{label}</span></div>
  );
}
function UiSettingsTabs({ active }) {
  return (
    <div className="wn-ui-settings-tabs">
      {['Call Centers', 'Alert Templates', 'Canned Responses', 'Employee Portal'].map(t => (
        <div key={t} className={`wn-ui-settings-tab${t === active ? ' active' : ''}`}>{t}</div>
      ))}
    </div>
  );
}
function UiFormRow() {
  return (
    <div className="wn-ui-form">
      <div className="wn-ui-form-row">
        <div className="wn-ui-form-label">Label</div>
        <div className="wn-ui-form-input">Carrier Outage</div>
      </div>
      <div className="wn-ui-form-row">
        <div className="wn-ui-form-label">Message</div>
        <div className="wn-ui-form-textarea">We're aware of a carrier outage affecting…</div>
      </div>
    </div>
  );
}

function PointedRow({ num, text, visual, last = false }) {
  return (
    <div className={`wn-pointed-row${last ? ' last' : ''}`}>
      <div className="wn-pointed-left">
        <div className="wn-step-num">{num}</div>
        {!last && <div className="wn-pointed-line" />}
      </div>
      <div className="wn-pointed-right">
        <div className="wn-step-text">{text}</div>
        {visual}
      </div>
    </div>
  );
}

/* ── Tutorial content keyed by tutorial ID ───────────────────────────────── */

const TUTORIAL_CONTENT = {
  'canned-responses': {
    icon: '💬',
    title: 'Canned Responses',
    subtitle: 'Pre-written status messages for the whole team',
    steps: [
      {
        heading: 'What are they?',
        body: (
          <>
            <p>Canned responses are shared message templates the whole ops team can instantly drop into a call center's status update — no retyping the same message every time.</p>
            <p>They live in <strong>Settings</strong> and appear as a dropdown on the <strong>Status Board</strong> wherever you write a status message.</p>
            <div className="wn-callout">
              <span className="wn-callout-icon">💡</span>
              Perfect for recurring situations — carrier outages, maintenance windows, system degradation, or "all clear" messages.
            </div>
          </>
        ),
      },
      {
        heading: 'Using a Canned Response',
        body: (
          <div className="wn-pointed-steps">
            <PointedRow num={1} text={<>Click <strong>Status Board</strong> in the sidebar</>} visual={<UiSidebarItem icon="📊" label="Status Board" />} />
            <PointedRow num={2} text={<>Select the <strong>Savvy Phone</strong> or <strong>Mitel Classic</strong> tab</>} visual={<UiTabs tabs={['Savvy Phone', 'Mitel Classic', 'Systems']} active="Savvy Phone" />} />
            <PointedRow num={3} text={<>Open this dropdown under <strong>Status Message</strong></>} visual={<UiSelect label="— Select Canned Response —" />} />
            <PointedRow num={4} text={<>Pick your template, then hit <strong>Save Message</strong> — it goes live immediately</>} visual={<UiButton label="Save Message" />} last />
          </div>
        ),
      },
      {
        heading: 'Creating Canned Responses',
        body: (
          <div className="wn-pointed-steps">
            <PointedRow num={1} text={<>Click <strong>⚙️ Settings</strong> in the sidebar <span className="wn-muted">(scroll down)</span></>} visual={<UiSidebarItem icon="⚙️" label="Settings" />} />
            <PointedRow num={2} text={<>Click the <strong>Canned Responses</strong> tab</>} visual={<UiSettingsTabs active="Canned Responses" />} />
            <PointedRow num={3} text={<>Click <strong>+ Add Response</strong>, fill in a label and message, then <strong>Save</strong></>} visual={<UiFormRow />} />
            <PointedRow num={4} text="Saved for the whole team — everyone sees the same library on the Status Board" visual={
              <div className="wn-callout" style={{ marginTop: 6 }}>
                <span className="wn-callout-icon">👥</span>
                Shared across all ops users. One person adds it, everyone can use it.
              </div>
            } last />
          </div>
        ),
      },
      {
        heading: 'It flows to the Employee Portal',
        body: (
          <>
            <p>When you pick a canned response and save it as the status message, that text appears <strong>in real time</strong> inside the Employee Portal widgets on the staff site.</p>
            <div className="wn-callout" style={{ marginBottom: 10 }}>
              <span className="wn-callout-icon">🖥️</span>
              Employees see the current status <em>and</em> the message — carrier outage, maintenance window, whatever you set.
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>Manage widget embed codes under <strong>Settings → Employee Portal</strong>.</p>
          </>
        ),
      },
    ],
  },

  'general-intro': {
    icon: '👋',
    title: 'Welcome to Dialed In Dash',
    subtitle: "Your call center command center",
    steps: [
      {
        heading: "Everything in one place",
        body: (
          <>
            <p>Dialed In Dash gives you real-time visibility into your call center systems, agent status, and customer queues — all from one screen.</p>
            <div className="wn-callout">
              <span className="wn-callout-icon">🖥️</span>
              Use the sidebar to navigate between modules. Your role determines which sections you can access.
            </div>
          </>
        ),
      },
    ],
  },
};

/* ── Component ───────────────────────────────────────────────────────────── */

export default function WhatsNew() {
  const { user } = useAuth();
  const [queue,   setQueue]   = useState([]);  // tutorials yet to show
  const [current, setCurrent] = useState(null); // active tutorial id
  const [step,    setStep]    = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!user) return;
    const closed = sessionStorage.getItem(SESSION_KEY);
    if (closed) return;
    api.get('/api/tutorials')
      .then(res => {
        const list = (res.data.tutorials || []).filter(t => TUTORIAL_CONTENT[t.id]);
        if (!list.length) return;
        setQueue(list.slice(1).map(t => t.id));
        setCurrent(list[0].id);
        setStep(0);
        setVisible(true);
      })
      .catch(() => {});
  }, [user]);

  if (!visible || !current || !TUTORIAL_CONTENT[current]) return null;

  const content = TUTORIAL_CONTENT[current];
  const steps   = content.steps;
  const isFirst = step === 0;
  const isLast  = step === steps.length - 1;

  function dismiss() {
    sessionStorage.setItem(SESSION_KEY, '1');
    setVisible(false);
  }

  async function gotIt() {
    try { await api.post(`/api/tutorials/${current}/dismiss`); } catch {}
    if (queue.length) {
      setCurrent(queue[0]);
      setQueue(q => q.slice(1));
      setStep(0);
    } else {
      setVisible(false);
    }
  }

  return (
    <div className="wn-overlay" onClick={e => e.target === e.currentTarget && dismiss()}>
      <div className="wn-modal" role="dialog" aria-modal="true">

        <div className="wn-header">
          <div className="wn-eyebrow">✨ What's New</div>
          <button className="wn-close" onClick={dismiss} aria-label="Close">✕</button>
        </div>

        <div className="wn-body">
          <div className="wn-icon">{content.icon}</div>
          <div className="wn-title">{content.title}</div>
          <div className="wn-subtitle">{content.subtitle}</div>
          {steps.length > 1 && (
            <div className="wn-step-heading">{steps[step].heading}</div>
          )}
          <div className="wn-content">{steps[step].body}</div>
        </div>

        {steps.length > 1 && (
          <div className="wn-dots">
            {steps.map((_, i) => (
              <button key={i} className={`wn-dot${i === step ? ' active' : ''}`} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`} />
            ))}
          </div>
        )}

        <div className="wn-footer">
          {!isFirst && (
            <button className="btn btn-ghost btn-sm" onClick={() => setStep(s => s - 1)}>← Back</button>
          )}
          <span style={{ flex: 1 }} />
          {!isLast ? (
            <button className="btn btn-secondary btn-sm" onClick={() => setStep(s => s + 1)}>Next →</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={gotIt}>Got it!</button>
          )}
        </div>

      </div>
    </div>
  );
}
