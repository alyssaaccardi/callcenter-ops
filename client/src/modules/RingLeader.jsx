import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import './RingLeader.css';

const DEPARTMENTS = [
  'Call Center Ops',
  'Support',
  'Tech',
  'Sales',
  'Marketing',
  'HR',
  'Finance',
  'Leadership',
  'Product',
  'Operations',
];

const WELCOME_TYPES = ['New Hire', 'Promotion', 'Internal Transfer'];
const PRODUCT_STATUSES = ['Released', 'In Progress', 'Coming Soon'];
const TREND_OPTIONS = ['Increase', 'Decrease', 'No Change'];
const WATER_CATEGORIES = ['Birthdays', 'Anniversaries', 'Photos', 'Volunteer Events', 'Pets', 'Office Fun', 'Other'];

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function emptyEntry() {
  return {
    executiveSnapshot: '',
    wins: [],
    collaborations: [],
    spotlights: [],
    welcomes: [],
    productUpdates: [],
    departmentHighlights: '',
    kpis: [],
    didYouKnow: '',
    lookingAhead: '',
    waterCooler: [],
    additionalNotes: '',
  };
}

function draftKey(month, email) {
  return `ringleader_draft_${month}_${email || 'anon'}`;
}

function SectionCard({ icon, title, helper, children }) {
  return (
    <div className="rl-section">
      <div className="rl-section-head">
        <span className="rl-section-icon">{icon}</span>
        <div>
          <div className="rl-section-title">{title}</div>
          {helper && <div className="rl-section-helper">{helper}</div>}
        </div>
      </div>
      <div className="rl-section-body">{children}</div>
    </div>
  );
}

function Repeater({ items, onAdd, onRemove, addLabel, emptyLabel, children }) {
  return (
    <div className="rl-repeater">
      {items.length === 0 && <div className="rl-empty">{emptyLabel}</div>}
      {items.map((item, idx) => (
        <div key={idx} className="rl-entry">
          <button type="button" className="rl-entry-remove" onClick={() => onRemove(idx)} title="Remove">×</button>
          {children(item, idx)}
        </div>
      ))}
      <button type="button" className="rl-add-btn" onClick={onAdd}>+ {addLabel}</button>
    </div>
  );
}

export default function RingLeader() {
  const { user } = useAuth();
  const { toast } = useApp();

  const [month, setMonth] = useState(monthKey());
  const [data, setData] = useState(emptyEntry);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const key = useMemo(() => draftKey(month, user?.email), [month, user?.email]);
  const skipNextSaveRef = useRef(true);
  const saveTimerRef = useRef(null);

  // Load draft when month or user changes
  useEffect(() => {
    skipNextSaveRef.current = true;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        setData({ ...emptyEntry(), ...(parsed.data || {}) });
        setLastSavedAt(parsed.savedAt || null);
      } else {
        setData(emptyEntry());
        setLastSavedAt(null);
      }
    } catch {
      setData(emptyEntry());
    }
  }, [key]);

  // Autosave (debounced)
  useEffect(() => {
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    setSaving(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const payload = {
          month,
          data,
          savedAt: new Date().toISOString(),
          editedBy: user?.email,
          editedByName: user?.name,
        };
        localStorage.setItem(key, JSON.stringify(payload));
        setLastSavedAt(payload.savedAt);
      } catch {
        // localStorage may be full or unavailable — ignore
      }
      setSaving(false);
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [data, key, month, user?.email, user?.name]);

  function update(field, value) {
    setData(d => ({ ...d, [field]: value }));
  }

  function addRow(field, template) {
    setData(d => ({ ...d, [field]: [...d[field], template] }));
  }

  function updateRow(field, idx, patch) {
    setData(d => ({
      ...d,
      [field]: d[field].map((r, i) => i === idx ? { ...r, ...patch } : r),
    }));
  }

  function removeRow(field, idx) {
    setData(d => ({ ...d, [field]: d[field].filter((_, i) => i !== idx) }));
  }

  const handleGenerate = useCallback(() => {
    setGenerating(true);
    toast('AI newsletter generation ships in the next update. Your entries are saved.', 'info');
    setTimeout(() => setGenerating(false), 400);
  }, [toast]);

  const handleClear = useCallback(() => {
    if (!window.confirm(`Clear all entries for ${monthLabel(month)}? This can't be undone.`)) return;
    setData(emptyEntry());
    try { localStorage.removeItem(key); } catch { /* noop */ }
    setLastSavedAt(null);
    toast('Cleared', 'info');
  }, [month, key, toast]);

  const monthOptions = useMemo(() => {
    const opts = [];
    const now = new Date();
    for (let i = -1; i <= 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      opts.push(monthKey(d));
    }
    return opts;
  }, []);

  const filledCount = useMemo(() => {
    let n = 0;
    if (data.executiveSnapshot.trim())    n++;
    if (data.wins.length)                 n++;
    if (data.collaborations.length)       n++;
    if (data.spotlights.length)           n++;
    if (data.welcomes.length)             n++;
    if (data.productUpdates.length)       n++;
    if (data.departmentHighlights.trim()) n++;
    if (data.kpis.length)                 n++;
    if (data.didYouKnow.trim())           n++;
    if (data.lookingAhead.trim())         n++;
    if (data.waterCooler.length)          n++;
    if (data.additionalNotes.trim())      n++;
    return n;
  }, [data]);

  const savedIndicator = saving
    ? 'Saving…'
    : lastSavedAt
      ? `Autosaved ${new Date(lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Autosave ready';

  return (
    <div className="rl-wrap">
      <div className="rl-hero">
        <div className="rl-hero-badge">🛎️ The Ring Leader</div>
        <h1 className="rl-hero-title">Compile Monthly Newsletter</h1>
        <p className="rl-hero-sub">
          Enter this month's inputs collected from leadership below.
          When you're done, click <strong>Generate Newsletter</strong> to compile them into a polished publication.
        </p>
      </div>

      <div className="rl-meta-bar">
        <div className="rl-meta-field">
          <label className="field-label">Newsletter month</label>
          <select value={month} onChange={e => setMonth(e.target.value)}>
            {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <div className="rl-meta-field">
          <label className="field-label">Sections filled</label>
          <div className="rl-progress-wrap">
            <div className="rl-progress-bar">
              <div className="rl-progress-fill" style={{ width: `${Math.round((filledCount / 12) * 100)}%` }} />
            </div>
            <div className="rl-progress-label">{filledCount} / 12</div>
          </div>
        </div>
        <div className="rl-meta-field">
          <label className="field-label">Editor</label>
          <div className="rl-meta-user">{user?.name || user?.email}</div>
        </div>
      </div>

      <SectionCard icon="🚀" title="Executive Snapshot" helper="One-paragraph summary of the month. If a reader only sees this, what should they take away?">
        <textarea
          className="rl-textarea rl-textarea-lg"
          placeholder="Paste or type the executive summary here…"
          value={data.executiveSnapshot}
          onChange={e => update('executiveSnapshot', e.target.value)}
        />
      </SectionCard>

      <SectionCard icon="🏆" title="Wins Across the Company" helper="Add one entry per win. The Ring Leader will merge and polish these into a wins section.">
        <Repeater
          items={data.wins}
          addLabel="Add a win"
          emptyLabel="No wins added yet."
          onAdd={() => addRow('wins', { title: '', description: '' })}
          onRemove={i => removeRow('wins', i)}
        >
          {(item, idx) => (
            <>
              <input
                className="rl-input"
                placeholder="Win title"
                value={item.title}
                onChange={e => updateRow('wins', idx, { title: e.target.value })}
              />
              <textarea
                className="rl-textarea"
                placeholder="Describe the win and why it matters…"
                value={item.description}
                onChange={e => updateRow('wins', idx, { description: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="🤝" title="Better Together" helper="Cross-department shout-outs. One entry per collaboration.">
        <Repeater
          items={data.collaborations}
          addLabel="Add a shout-out"
          emptyLabel="No collaborations added yet."
          onAdd={() => addRow('collaborations', { department: '', person: '', description: '', impact: '' })}
          onRemove={i => removeRow('collaborations', i)}
        >
          {(item, idx) => (
            <>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Department that helped</label>
                  <select
                    value={item.department}
                    onChange={e => updateRow('collaborations', idx, { department: e.target.value })}
                  >
                    <option value="">— Select —</option>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Person (optional)</label>
                  <input
                    className="rl-input"
                    placeholder="Name"
                    value={item.person}
                    onChange={e => updateRow('collaborations', idx, { person: e.target.value })}
                  />
                </div>
              </div>
              <textarea
                className="rl-textarea"
                placeholder="What did they do?"
                value={item.description}
                onChange={e => updateRow('collaborations', idx, { description: e.target.value })}
              />
              <input
                className="rl-input"
                placeholder="Business impact"
                value={item.impact}
                onChange={e => updateRow('collaborations', idx, { impact: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="👏" title="Employee Spotlight" helper="Recognize employees who went above and beyond.">
        <Repeater
          items={data.spotlights}
          addLabel="Add a spotlight"
          emptyLabel="No spotlights added yet."
          onAdd={() => addRow('spotlights', { name: '', department: '', reason: '' })}
          onRemove={i => removeRow('spotlights', i)}
        >
          {(item, idx) => (
            <>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Employee name</label>
                  <input
                    className="rl-input"
                    value={item.name}
                    onChange={e => updateRow('spotlights', idx, { name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Department</label>
                  <select
                    value={item.department}
                    onChange={e => updateRow('spotlights', idx, { department: e.target.value })}
                  >
                    <option value="">— Select —</option>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <textarea
                className="rl-textarea"
                placeholder="Reason for recognition"
                value={item.reason}
                onChange={e => updateRow('spotlights', idx, { reason: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="👋" title="Welcome to the Team" helper="New hires, promotions, and internal transfers.">
        <Repeater
          items={data.welcomes}
          addLabel="Add someone"
          emptyLabel="No welcomes added yet."
          onAdd={() => addRow('welcomes', { name: '', role: '', department: '', type: WELCOME_TYPES[0], funFact: '' })}
          onRemove={i => removeRow('welcomes', i)}
        >
          {(item, idx) => (
            <>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Name</label>
                  <input
                    className="rl-input"
                    value={item.name}
                    onChange={e => updateRow('welcomes', idx, { name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Role</label>
                  <input
                    className="rl-input"
                    value={item.role}
                    onChange={e => updateRow('welcomes', idx, { role: e.target.value })}
                  />
                </div>
              </div>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Department</label>
                  <select
                    value={item.department}
                    onChange={e => updateRow('welcomes', idx, { department: e.target.value })}
                  >
                    <option value="">— Select —</option>
                    {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Type</label>
                  <select
                    value={item.type}
                    onChange={e => updateRow('welcomes', idx, { type: e.target.value })}
                  >
                    {WELCOME_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <input
                className="rl-input"
                placeholder="Fun fact"
                value={item.funFact}
                onChange={e => updateRow('welcomes', idx, { funFact: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="💻" title="Product & Technology" helper="Product updates, features, and technical wins.">
        <Repeater
          items={data.productUpdates}
          addLabel="Add an update"
          emptyLabel="No product updates yet."
          onAdd={() => addRow('productUpdates', { title: '', description: '', impact: '', status: PRODUCT_STATUSES[0] })}
          onRemove={i => removeRow('productUpdates', i)}
        >
          {(item, idx) => (
            <>
              <input
                className="rl-input"
                placeholder="Title"
                value={item.title}
                onChange={e => updateRow('productUpdates', idx, { title: e.target.value })}
              />
              <textarea
                className="rl-textarea"
                placeholder="Description"
                value={item.description}
                onChange={e => updateRow('productUpdates', idx, { description: e.target.value })}
              />
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Business impact</label>
                  <input
                    className="rl-input"
                    value={item.impact}
                    onChange={e => updateRow('productUpdates', idx, { impact: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Status</label>
                  <select
                    value={item.status}
                    onChange={e => updateRow('productUpdates', idx, { status: e.target.value })}
                  >
                    {PRODUCT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="📈" title="Department Highlights" helper="Freeform summary of what departments focused on this month.">
        <textarea
          className="rl-textarea rl-textarea-lg"
          placeholder="Paste the compiled department highlights here…"
          value={data.departmentHighlights}
          onChange={e => update('departmentHighlights', e.target.value)}
        />
      </SectionCard>

      <SectionCard icon="📊" title="By the Numbers" helper="KPIs and metrics worth celebrating.">
        <Repeater
          items={data.kpis}
          addLabel="Add a metric"
          emptyLabel="No metrics added yet."
          onAdd={() => addRow('kpis', { name: '', value: '', previous: '', trend: 'No Change', explanation: '' })}
          onRemove={i => removeRow('kpis', i)}
        >
          {(item, idx) => (
            <>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Metric name</label>
                  <input
                    className="rl-input"
                    value={item.name}
                    onChange={e => updateRow('kpis', idx, { name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Value</label>
                  <input
                    className="rl-input"
                    value={item.value}
                    onChange={e => updateRow('kpis', idx, { value: e.target.value })}
                  />
                </div>
              </div>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Previous value (optional)</label>
                  <input
                    className="rl-input"
                    value={item.previous}
                    onChange={e => updateRow('kpis', idx, { previous: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Trend</label>
                  <select
                    value={item.trend}
                    onChange={e => updateRow('kpis', idx, { trend: e.target.value })}
                  >
                    {TREND_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <textarea
                className="rl-textarea"
                placeholder="Explanation (optional)"
                value={item.explanation}
                onChange={e => updateRow('kpis', idx, { explanation: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="💡" title="Did You Know?" helper="One fun or interesting fact from the month.">
        <textarea
          className="rl-textarea"
          placeholder="Something surprising, delightful, or nerdy…"
          value={data.didYouKnow}
          onChange={e => update('didYouKnow', e.target.value)}
        />
      </SectionCard>

      <SectionCard icon="🔭" title="Looking Ahead" helper="What should everyone expect next month?">
        <textarea
          className="rl-textarea rl-textarea-lg"
          placeholder="Upcoming launches, initiatives, hiring plans…"
          value={data.lookingAhead}
          onChange={e => update('lookingAhead', e.target.value)}
        />
      </SectionCard>

      <SectionCard icon="☕" title="Water Cooler" helper="Fun company updates — birthdays, anniversaries, pets, and everything in between.">
        <Repeater
          items={data.waterCooler}
          addLabel="Add an entry"
          emptyLabel="No water cooler entries yet."
          onAdd={() => addRow('waterCooler', { category: WATER_CATEGORIES[0], description: '' })}
          onRemove={i => removeRow('waterCooler', i)}
        >
          {(item, idx) => (
            <>
              <div className="rl-row-2">
                <div>
                  <label className="field-label">Category</label>
                  <select
                    value={item.category}
                    onChange={e => updateRow('waterCooler', idx, { category: e.target.value })}
                  >
                    {WATER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div />
              </div>
              <textarea
                className="rl-textarea"
                placeholder="Tell us about it…"
                value={item.description}
                onChange={e => updateRow('waterCooler', idx, { description: e.target.value })}
              />
            </>
          )}
        </Repeater>
      </SectionCard>

      <SectionCard icon="📝" title="Additional Notes" helper="Anything else you'd like included?">
        <textarea
          className="rl-textarea"
          value={data.additionalNotes}
          onChange={e => update('additionalNotes', e.target.value)}
        />
      </SectionCard>

      <div className="rl-actions">
        <div className="rl-save-indicator">{savedIndicator}</div>
        <div className="rl-actions-btns">
          <button className="btn btn-ghost" onClick={handleClear}>Clear month</button>
          <button className="btn btn-primary btn-lg" onClick={handleGenerate} disabled={generating || filledCount === 0}>
            {generating ? 'Generating…' : '🪄 Generate Newsletter'}
          </button>
        </div>
      </div>
    </div>
  );
}
