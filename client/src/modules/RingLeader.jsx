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

function emptySubmission() {
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

function FileHint() {
  return <div className="rl-file-hint">📎 Image uploads coming in the next update</div>;
}

export default function RingLeader() {
  const { user } = useAuth();
  const { toast } = useApp();

  const isSuperAdmin = user?.role === 'super_admin';
  const [tab, setTab] = useState('submit');

  const [month, setMonth] = useState(monthKey());
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [data, setData] = useState(emptySubmission);
  const [status, setStatus] = useState('draft'); // draft | submitted
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
        setData({ ...emptySubmission(), ...(parsed.data || {}) });
        setDepartment(parsed.department || DEPARTMENTS[0]);
        setStatus(parsed.status || 'draft');
        setLastSavedAt(parsed.savedAt || null);
      } else {
        setData(emptySubmission());
        setStatus('draft');
        setLastSavedAt(null);
      }
    } catch {
      setData(emptySubmission());
    }
  }, [key]);

  // Autosave (debounced) on data/department change
  useEffect(() => {
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    setSaving(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const payload = {
          month, department, status,
          data,
          savedAt: new Date().toISOString(),
          submittedBy: user?.email,
          submittedByName: user?.name,
        };
        localStorage.setItem(key, JSON.stringify(payload));
        setLastSavedAt(payload.savedAt);
      } catch {}
      setSaving(false);
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [data, department, status, key, month, user?.email, user?.name]);

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

  const handleSaveDraft = useCallback(() => {
    setSaving(true);
    clearTimeout(saveTimerRef.current);
    try {
      const payload = {
        month, department, status: 'draft',
        data,
        savedAt: new Date().toISOString(),
        submittedBy: user?.email,
        submittedByName: user?.name,
      };
      localStorage.setItem(key, JSON.stringify(payload));
      setLastSavedAt(payload.savedAt);
      setStatus('draft');
      toast('Draft saved', 'success');
    } catch {
      toast('Could not save draft', 'error');
    }
    setSaving(false);
  }, [month, department, data, key, user?.email, user?.name, toast]);

  const handleSubmit = useCallback(() => {
    setSubmitting(true);
    try {
      const payload = {
        month, department, status: 'submitted',
        data,
        savedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        submittedBy: user?.email,
        submittedByName: user?.name,
      };
      localStorage.setItem(key, JSON.stringify(payload));
      setLastSavedAt(payload.savedAt);
      setStatus('submitted');
      toast('Update submitted', 'success');
    } catch {
      toast('Could not submit update', 'error');
    }
    setSubmitting(false);
  }, [month, department, data, key, user?.email, user?.name, toast]);

  const monthOptions = useMemo(() => {
    const opts = [];
    const now = new Date();
    for (let i = -1; i <= 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      opts.push(monthKey(d));
    }
    return opts;
  }, []);

  const savedIndicator = saving
    ? 'Saving…'
    : lastSavedAt
      ? `Saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Not yet saved';

  return (
    <div className="rl-wrap">
      <div className="rl-hero">
        <div className="rl-hero-badge">🛎️ The Ring Leader</div>
        <h1 className="rl-hero-title">Submit Monthly Update</h1>
        <p className="rl-hero-sub">Your Monthly Pulse on Everything Ring Savvy</p>
      </div>

      {isSuperAdmin && (
        <div className="rl-tabs">
          <button className={`rl-tab${tab === 'submit' ? ' active' : ''}`} onClick={() => setTab('submit')}>Submit Update</button>
          <button className={`rl-tab${tab === 'admin' ? ' active' : ''}`} onClick={() => setTab('admin')}>Admin Dashboard</button>
        </div>
      )}

      {tab === 'submit' && (
        <>
          <div className="rl-meta-bar">
            <div className="rl-meta-field">
              <label className="field-label">Month</label>
              <select value={month} onChange={e => setMonth(e.target.value)}>
                {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </div>
            <div className="rl-meta-field">
              <label className="field-label">Department</label>
              <select value={department} onChange={e => setDepartment(e.target.value)}>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="rl-meta-field">
              <label className="field-label">Submitting As</label>
              <div className="rl-meta-user">{user?.name || user?.email}</div>
            </div>
            <div className="rl-meta-field rl-meta-status">
              <label className="field-label">Status</label>
              <div className={`rl-status-pill rl-status-${status}`}>
                {status === 'submitted' ? '✓ Submitted' : 'Draft'}
              </div>
            </div>
          </div>

          <SectionCard icon="🚀" title="Executive Snapshot" helper="If someone only read one thing about your department this month, what would you want it to be?">
            <textarea
              className="rl-textarea rl-textarea-lg"
              placeholder="e.g. This month, our team shipped the new intake flow and reduced average hold time by 22%…"
              value={data.executiveSnapshot}
              onChange={e => update('executiveSnapshot', e.target.value)}
            />
          </SectionCard>

          <SectionCard icon="🏆" title="Wins Across the Company" helper="What were your department's biggest accomplishments this month?">
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
                  <FileHint />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="🤝" title="Better Together" helper="Did another department help your team succeed this month? Give them a shout-out.">
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
                  <FileHint />
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
                  <FileHint />
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
                  <FileHint />
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
                  <FileHint />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="📈" title="Department Highlights" helper="What has your department been focused on this month?">
            <textarea
              className="rl-textarea rl-textarea-lg"
              placeholder="Share the projects, priorities, and progress that defined the month…"
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

          <SectionCard icon="💡" title="Did You Know?" helper="One fun or interesting fact about your department.">
            <textarea
              className="rl-textarea"
              placeholder="Something surprising, delightful, or nerdy…"
              value={data.didYouKnow}
              onChange={e => update('didYouKnow', e.target.value)}
            />
          </SectionCard>

          <SectionCard icon="🔭" title="Looking Ahead" helper="What should everyone expect from your department next month?">
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
                  <FileHint />
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
              <button className="btn btn-secondary" onClick={handleSaveDraft} disabled={saving || submitting}>
                Save Draft
              </button>
              <button className="btn btn-primary" onClick={handleSubmit} disabled={saving || submitting}>
                {submitting ? 'Submitting…' : status === 'submitted' ? 'Resubmit Update' : 'Submit Update'}
              </button>
            </div>
          </div>
        </>
      )}

      {tab === 'admin' && isSuperAdmin && <AdminDashboard month={month} setMonth={setMonth} monthOptions={monthOptions} />}
    </div>
  );
}

function AdminDashboard({ month, setMonth, monthOptions }) {
  // Placeholder — real submissions will come from the server in a later pass.
  // For now, surface any local drafts stored on this machine so the tab isn't empty.
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const prefix = `ringleader_draft_${month}_`;
    const collected = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        collected.push(v);
      } catch {}
    }
    setRows(collected);
  }, [month]);

  const submitted = rows.filter(r => r.status === 'submitted');
  const drafts    = rows.filter(r => r.status !== 'submitted');
  const totalDepts = DEPARTMENTS.length;
  const pct = Math.round((submitted.length / totalDepts) * 100);

  return (
    <div>
      <div className="rl-meta-bar">
        <div className="rl-meta-field">
          <label className="field-label">Month</label>
          <select value={month} onChange={e => setMonth(e.target.value)}>
            {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <div className="rl-meta-field rl-meta-progress">
          <label className="field-label">Completion</label>
          <div className="rl-progress-wrap">
            <div className="rl-progress-bar"><div className="rl-progress-fill" style={{ width: `${pct}%` }} /></div>
            <div className="rl-progress-label">{submitted.length}/{totalDepts} departments</div>
          </div>
        </div>
      </div>

      <div className="rl-admin-note notice notice-info">
        Backend persistence is coming in the next pass. For now this tab reflects only drafts saved on <em>this browser</em>.
      </div>

      <div className="rl-section">
        <div className="rl-section-head">
          <span className="rl-section-icon">📋</span>
          <div>
            <div className="rl-section-title">Submissions — {monthLabel(month)}</div>
            <div className="rl-section-helper">Who's submitted, who hasn't.</div>
          </div>
        </div>
        <div className="rl-section-body">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Submitted by</th>
                <th>Status</th>
                <th>Last edited</th>
              </tr>
            </thead>
            <tbody>
              {DEPARTMENTS.map(d => {
                const r = rows.find(x => x.department === d);
                return (
                  <tr key={d}>
                    <td>{d}</td>
                    <td>{r?.submittedByName || r?.submittedBy || <span className="rl-muted">—</span>}</td>
                    <td>
                      {r
                        ? <span className={`rl-status-pill rl-status-${r.status}`}>{r.status === 'submitted' ? '✓ Submitted' : 'Draft'}</span>
                        : <span className="rl-status-pill rl-status-none">Not started</span>}
                    </td>
                    <td>{r?.savedAt ? new Date(r.savedAt).toLocaleString() : <span className="rl-muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {submitted.length + drafts.length === 0 && (
            <div className="rl-empty" style={{ marginTop: 12 }}>No submissions for this month yet.</div>
          )}
        </div>
      </div>

      <div className="rl-generate-cta">
        <div>
          <div className="rl-generate-title">🪄 Generate Newsletter</div>
          <div className="rl-generate-sub">AI newsletter compilation ships in the next pass.</div>
        </div>
        <button className="btn btn-primary" disabled>Coming Soon</button>
      </div>
    </div>
  );
}
