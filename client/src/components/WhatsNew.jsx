import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const KEY     = 'ccob_wn_v1';
const SESSION = 'ccob_wn_session';
const ROLES   = ['super_admin', 'call_center_ops'];

/* ── Mini UI mockup helpers ──────────────────────────────────────────────── */

function NavPath({ items }) {
  return (
    <div className="wn-nav-path">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          <span className="wn-nav-crumb">{item}</span>
          {i < items.length - 1 && <span className="wn-nav-arrow">›</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function UiSelect({ label }) {
  return (
    <div className="wn-ui-select">
      <span>{label}</span>
      <span className="wn-ui-select-arrow">▾</span>
    </div>
  );
}

function UiTabs({ tabs, active }) {
  return (
    <div className="wn-ui-tabs">
      {tabs.map(t => (
        <div key={t} className={`wn-ui-tab${t === active ? ' active' : ''}`}>{t}</div>
      ))}
    </div>
  );
}

function UiButton({ label, variant = 'secondary' }) {
  return <div className={`wn-ui-btn ${variant}`}>{label}</div>;
}

function UiSidebarItem({ icon, label }) {
  return (
    <div className="wn-ui-sidebar-item">
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function UiSettingsTabs({ active }) {
  const tabs = ['Call Centers', 'Alert Templates', 'Canned Responses', 'Employee Portal'];
  return (
    <div className="wn-ui-settings-tabs">
      {tabs.map(t => (
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

/* ── Step definitions ────────────────────────────────────────────────────── */

const STEPS = [
  {
    icon: '💬',
    title: 'Canned Responses',
    subtitle: 'Pre-written status messages, ready to go',
    body: (
      <>
        <p>Canned responses are saved message templates you can instantly drop into a call center's status update — no retyping the same thing every time.</p>
        <p>They live in <strong>Settings</strong> and appear as a dropdown on the <strong>Status Board</strong> wherever you write a status message.</p>
        <div className="wn-callout">
          <span className="wn-callout-icon">💡</span>
          Perfect for recurring situations — carrier outages, scheduled maintenance, system degradation, or "all clear" messages.
        </div>
      </>
    ),
  },
  {
    icon: '🖱️',
    title: 'Using a Canned Response',
    subtitle: 'Status Board → pick a template → done',
    body: (
      <div className="wn-pointed-steps">

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">1</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Click <strong>Status Board</strong> in the sidebar</div>
            <UiSidebarItem icon="📊" label="Status Board" />
          </div>
        </div>

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">2</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Select the <strong>Savvy Phone</strong> or <strong>Mitel Classic</strong> tab</div>
            <UiTabs tabs={['Savvy Phone', 'Mitel Classic', 'Systems']} active="Savvy Phone" />
          </div>
        </div>

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">3</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Open this dropdown under <strong>Status Message</strong></div>
            <UiSelect label="— Select Canned Response —" />
          </div>
        </div>

        <div className="wn-pointed-row last">
          <div className="wn-pointed-left">
            <div className="wn-step-num">4</div>
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Pick your template, then hit <strong>Save Message</strong></div>
            <UiButton label="Save Message" variant="secondary" />
          </div>
        </div>

      </div>
    ),
  },
  {
    icon: '✏️',
    title: 'Creating Canned Responses',
    subtitle: 'Settings → Canned Responses → Add',
    body: (
      <div className="wn-pointed-steps">

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">1</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Click <strong>⚙️ Settings</strong> in the sidebar <span className="wn-muted">(scroll down)</span></div>
            <UiSidebarItem icon="⚙️" label="Settings" />
          </div>
        </div>

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">2</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Click the <strong>Canned Responses</strong> tab</div>
            <UiSettingsTabs active="Canned Responses" />
          </div>
        </div>

        <div className="wn-pointed-row">
          <div className="wn-pointed-left">
            <div className="wn-step-num">3</div>
            <div className="wn-pointed-line" />
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Click <strong>+ Add Response</strong> and fill in a label and message</div>
            <UiFormRow />
          </div>
        </div>

        <div className="wn-pointed-row last">
          <div className="wn-pointed-left">
            <div className="wn-step-num">4</div>
          </div>
          <div className="wn-pointed-right">
            <div className="wn-step-text">Saves automatically — shows up on the Status Board immediately</div>
            <div className="wn-callout" style={{ marginTop: 6 }}>
              <span className="wn-callout-icon">📌</span>
              Stored per-browser, so each user builds their own library.
            </div>
          </div>
        </div>

      </div>
    ),
  },
];

/* ── Component ───────────────────────────────────────────────────────────── */

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
