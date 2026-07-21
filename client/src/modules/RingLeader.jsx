import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import api from '../api';
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

  const [view, setView] = useState('edit'); // edit | preview | past
  const [month, setMonth] = useState(monthKey());
  const [data, setData] = useState(emptyEntry);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [currentNewsletter, setCurrentNewsletter] = useState(null);

  const key = useMemo(() => draftKey(month, user?.email), [month, user?.email]);
  const skipNextSaveRef = useRef(true);
  const saveTimerRef = useRef(null);

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

  useEffect(() => {
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    setSaving(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({
          month, data,
          savedAt: new Date().toISOString(),
          editedBy: user?.email,
          editedByName: user?.name,
        }));
        setLastSavedAt(new Date().toISOString());
      } catch { /* full or unavailable */ }
      setSaving(false);
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [data, key, month, user?.email, user?.name]);

  // When we switch to preview view (or the month changes while in preview), load the saved newsletter
  useEffect(() => {
    if (view !== 'preview') return;
    let cancelled = false;
    api.get(`/api/newsletter/${month}`)
      .then(r => { if (!cancelled) setCurrentNewsletter(r.data); })
      .catch(() => { if (!cancelled) setCurrentNewsletter(null); });
    return () => { cancelled = true; };
  }, [view, month]);

  function update(field, value) { setData(d => ({ ...d, [field]: value })); }
  function addRow(field, template) { setData(d => ({ ...d, [field]: [...d[field], template] })); }
  function updateRow(field, idx, patch) {
    setData(d => ({ ...d, [field]: d[field].map((r, i) => i === idx ? { ...r, ...patch } : r) }));
  }
  function removeRow(field, idx) {
    setData(d => ({ ...d, [field]: d[field].filter((_, i) => i !== idx) }));
  }

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await api.post('/api/newsletter/generate', { month, data });
      setCurrentNewsletter(res.data);
      setView('preview');
      toast('Newsletter generated', 'success');
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Generation failed';
      toast(msg, 'error');
    } finally {
      setGenerating(false);
    }
  }, [month, data, toast]);

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
      opts.push(monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
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
          Enter this month's inputs collected from leadership, then generate a polished publication.
        </p>
      </div>

      <div className="rl-tabs">
        <button className={`rl-tab${view === 'edit' ? ' active' : ''}`} onClick={() => setView('edit')}>Compile</button>
        <button className={`rl-tab${view === 'preview' ? ' active' : ''}`} onClick={() => setView('preview')}>Preview</button>
        <button className={`rl-tab${view === 'past' ? ' active' : ''}`} onClick={() => setView('past')}>Past Newsletters</button>
      </div>

      {view === 'edit' && (
        <>
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

          <SectionCard icon="🚀" title="Executive Snapshot" helper="One-paragraph summary of the month.">
            <textarea className="rl-textarea rl-textarea-lg" value={data.executiveSnapshot}
              onChange={e => update('executiveSnapshot', e.target.value)}
              placeholder="Paste or type the executive summary here…" />
          </SectionCard>

          <SectionCard icon="🏆" title="Wins Across the Company" helper="Add one entry per win.">
            <Repeater
              items={data.wins} addLabel="Add a win" emptyLabel="No wins added yet."
              onAdd={() => addRow('wins', { title: '', description: '' })}
              onRemove={i => removeRow('wins', i)}
            >
              {(item, idx) => (
                <>
                  <input className="rl-input" placeholder="Win title" value={item.title}
                    onChange={e => updateRow('wins', idx, { title: e.target.value })} />
                  <textarea className="rl-textarea" placeholder="Describe the win…" value={item.description}
                    onChange={e => updateRow('wins', idx, { description: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="🤝" title="Better Together" helper="Cross-department shout-outs.">
            <Repeater
              items={data.collaborations} addLabel="Add a shout-out" emptyLabel="No collaborations added yet."
              onAdd={() => addRow('collaborations', { department: '', person: '', description: '', impact: '' })}
              onRemove={i => removeRow('collaborations', i)}
            >
              {(item, idx) => (
                <>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Department that helped</label>
                      <select value={item.department} onChange={e => updateRow('collaborations', idx, { department: e.target.value })}>
                        <option value="">— Select —</option>
                        {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="field-label">Person (optional)</label>
                      <input className="rl-input" placeholder="Name" value={item.person}
                        onChange={e => updateRow('collaborations', idx, { person: e.target.value })} />
                    </div>
                  </div>
                  <textarea className="rl-textarea" placeholder="What did they do?" value={item.description}
                    onChange={e => updateRow('collaborations', idx, { description: e.target.value })} />
                  <input className="rl-input" placeholder="Business impact" value={item.impact}
                    onChange={e => updateRow('collaborations', idx, { impact: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="👏" title="Employee Spotlight" helper="Recognize employees.">
            <Repeater
              items={data.spotlights} addLabel="Add a spotlight" emptyLabel="No spotlights added yet."
              onAdd={() => addRow('spotlights', { name: '', department: '', reason: '' })}
              onRemove={i => removeRow('spotlights', i)}
            >
              {(item, idx) => (
                <>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Employee name</label>
                      <input className="rl-input" value={item.name}
                        onChange={e => updateRow('spotlights', idx, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Department</label>
                      <select value={item.department} onChange={e => updateRow('spotlights', idx, { department: e.target.value })}>
                        <option value="">— Select —</option>
                        {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  </div>
                  <textarea className="rl-textarea" placeholder="Reason for recognition" value={item.reason}
                    onChange={e => updateRow('spotlights', idx, { reason: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="👋" title="Welcome to the Team" helper="New hires, promotions, transfers.">
            <Repeater
              items={data.welcomes} addLabel="Add someone" emptyLabel="No welcomes added yet."
              onAdd={() => addRow('welcomes', { name: '', role: '', department: '', type: WELCOME_TYPES[0], funFact: '' })}
              onRemove={i => removeRow('welcomes', i)}
            >
              {(item, idx) => (
                <>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Name</label>
                      <input className="rl-input" value={item.name}
                        onChange={e => updateRow('welcomes', idx, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Role</label>
                      <input className="rl-input" value={item.role}
                        onChange={e => updateRow('welcomes', idx, { role: e.target.value })} />
                    </div>
                  </div>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Department</label>
                      <select value={item.department} onChange={e => updateRow('welcomes', idx, { department: e.target.value })}>
                        <option value="">— Select —</option>
                        {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="field-label">Type</label>
                      <select value={item.type} onChange={e => updateRow('welcomes', idx, { type: e.target.value })}>
                        {WELCOME_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <input className="rl-input" placeholder="Fun fact" value={item.funFact}
                    onChange={e => updateRow('welcomes', idx, { funFact: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="💻" title="Product & Technology" helper="Product updates and technical wins.">
            <Repeater
              items={data.productUpdates} addLabel="Add an update" emptyLabel="No product updates yet."
              onAdd={() => addRow('productUpdates', { title: '', description: '', impact: '', status: PRODUCT_STATUSES[0] })}
              onRemove={i => removeRow('productUpdates', i)}
            >
              {(item, idx) => (
                <>
                  <input className="rl-input" placeholder="Title" value={item.title}
                    onChange={e => updateRow('productUpdates', idx, { title: e.target.value })} />
                  <textarea className="rl-textarea" placeholder="Description" value={item.description}
                    onChange={e => updateRow('productUpdates', idx, { description: e.target.value })} />
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Business impact</label>
                      <input className="rl-input" value={item.impact}
                        onChange={e => updateRow('productUpdates', idx, { impact: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Status</label>
                      <select value={item.status} onChange={e => updateRow('productUpdates', idx, { status: e.target.value })}>
                        {PRODUCT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="📈" title="Department Highlights" helper="What departments focused on this month.">
            <textarea className="rl-textarea rl-textarea-lg" value={data.departmentHighlights}
              onChange={e => update('departmentHighlights', e.target.value)}
              placeholder="Paste the compiled department highlights here…" />
          </SectionCard>

          <SectionCard icon="📊" title="By the Numbers" helper="KPIs and metrics.">
            <Repeater
              items={data.kpis} addLabel="Add a metric" emptyLabel="No metrics added yet."
              onAdd={() => addRow('kpis', { name: '', value: '', previous: '', trend: 'No Change', explanation: '' })}
              onRemove={i => removeRow('kpis', i)}
            >
              {(item, idx) => (
                <>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Metric name</label>
                      <input className="rl-input" value={item.name}
                        onChange={e => updateRow('kpis', idx, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Value</label>
                      <input className="rl-input" value={item.value}
                        onChange={e => updateRow('kpis', idx, { value: e.target.value })} />
                    </div>
                  </div>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Previous value (optional)</label>
                      <input className="rl-input" value={item.previous}
                        onChange={e => updateRow('kpis', idx, { previous: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Trend</label>
                      <select value={item.trend} onChange={e => updateRow('kpis', idx, { trend: e.target.value })}>
                        {TREND_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <textarea className="rl-textarea" placeholder="Explanation (optional)" value={item.explanation}
                    onChange={e => updateRow('kpis', idx, { explanation: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="💡" title="Did You Know?" helper="One fun or interesting fact.">
            <textarea className="rl-textarea" value={data.didYouKnow}
              onChange={e => update('didYouKnow', e.target.value)}
              placeholder="Something surprising, delightful, or nerdy…" />
          </SectionCard>

          <SectionCard icon="🔭" title="Looking Ahead" helper="What to expect next month.">
            <textarea className="rl-textarea rl-textarea-lg" value={data.lookingAhead}
              onChange={e => update('lookingAhead', e.target.value)}
              placeholder="Upcoming launches, initiatives, hiring plans…" />
          </SectionCard>

          <SectionCard icon="☕" title="Water Cooler" helper="Fun company updates.">
            <Repeater
              items={data.waterCooler} addLabel="Add an entry" emptyLabel="No water cooler entries yet."
              onAdd={() => addRow('waterCooler', { category: WATER_CATEGORIES[0], description: '' })}
              onRemove={i => removeRow('waterCooler', i)}
            >
              {(item, idx) => (
                <>
                  <div className="rl-row-2">
                    <div>
                      <label className="field-label">Category</label>
                      <select value={item.category} onChange={e => updateRow('waterCooler', idx, { category: e.target.value })}>
                        {WATER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div />
                  </div>
                  <textarea className="rl-textarea" placeholder="Tell us about it…" value={item.description}
                    onChange={e => updateRow('waterCooler', idx, { description: e.target.value })} />
                </>
              )}
            </Repeater>
          </SectionCard>

          <SectionCard icon="📝" title="Additional Notes" helper="Anything else?">
            <textarea className="rl-textarea" value={data.additionalNotes}
              onChange={e => update('additionalNotes', e.target.value)} />
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
        </>
      )}

      {view === 'preview' && (
        <PreviewPane
          month={month}
          setMonth={setMonth}
          monthOptions={monthOptions}
          newsletter={currentNewsletter}
          onBackToEdit={() => setView('edit')}
          onRegenerate={handleGenerate}
          generating={generating}
        />
      )}

      {view === 'past' && (
        <PastNewslettersPane
          onOpen={(m) => { setMonth(m); setView('preview'); }}
        />
      )}
    </div>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────

function PreviewPane({ month, setMonth, monthOptions, newsletter, onBackToEdit, onRegenerate, generating }) {
  const printableRef = useRef(null);

  if (!newsletter) {
    return (
      <div>
        <div className="rl-meta-bar">
          <div className="rl-meta-field">
            <label className="field-label">Newsletter month</label>
            <select value={month} onChange={e => setMonth(e.target.value)}>
              {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </div>
        </div>
        <div className="rl-empty-state">
          <div className="rl-empty-state-icon">📰</div>
          <div className="rl-empty-state-title">No newsletter for {monthLabel(month)}</div>
          <div className="rl-empty-state-sub">Compile this month's inputs and click Generate Newsletter to create one.</div>
          <button className="btn btn-primary" onClick={onBackToEdit}>Back to Compile</button>
        </div>
      </div>
    );
  }

  const n = newsletter.newsletter;

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportHtml() {
    const html = renderNewsletterHtml(month, n);
    downloadFile(`ring-leader-${month}.html`, html, 'text/html;charset=utf-8');
  }

  function exportPdf() {
    if (!printableRef.current) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(renderNewsletterHtml(month, n));
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 400);
  }

  function exportSlackMd() {
    const md = newsletterToSlackMarkdown(month, n);
    downloadFile(`ring-leader-${month}.md`, md, 'text/markdown;charset=utf-8');
  }

  async function copySlackMd() {
    try {
      await navigator.clipboard.writeText(newsletterToSlackMarkdown(month, n));
    } catch { /* clipboard blocked */ }
  }

  return (
    <div>
      <div className="rl-meta-bar">
        <div className="rl-meta-field">
          <label className="field-label">Newsletter month</label>
          <select value={month} onChange={e => setMonth(e.target.value)}>
            {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <div className="rl-meta-field">
          <label className="field-label">Generated</label>
          <div className="rl-meta-user">
            {new Date(newsletter.generatedAt).toLocaleString()} · {newsletter.generatedByName || newsletter.generatedBy}
          </div>
        </div>
        <div className="rl-meta-field rl-meta-actions">
          <button className="btn btn-ghost btn-sm" onClick={onBackToEdit}>← Back to Compile</button>
          <button className="btn btn-secondary btn-sm" onClick={onRegenerate} disabled={generating}>
            {generating ? 'Regenerating…' : '🪄 Regenerate'}
          </button>
        </div>
      </div>

      <div className="rl-export-bar">
        <div className="rl-export-label">Export</div>
        <button className="btn btn-secondary btn-sm" onClick={exportHtml}>📄 HTML</button>
        <button className="btn btn-secondary btn-sm" onClick={exportPdf}>🖨️ PDF</button>
        <button className="btn btn-secondary btn-sm" onClick={exportSlackMd}>💬 Slack Markdown</button>
        <button className="btn btn-ghost btn-sm" onClick={copySlackMd}>Copy Slack MD</button>
      </div>

      <div ref={printableRef}>
        <NewsletterView month={month} n={n} />
      </div>
    </div>
  );
}

// ─── Newsletter render (used by preview + HTML export) ──────────────────

function NewsletterView({ month, n }) {
  return (
    <article className="nl-doc">
      <header className="nl-cover">
        <div className="nl-cover-badge">🛎️ The Ring Leader</div>
        <h1 className="nl-cover-title">Your Monthly Pulse on Everything Ring Savvy</h1>
        <div className="nl-cover-month">{monthLabel(month)}</div>
        {n.coverIntro && <p className="nl-cover-intro">{n.coverIntro}</p>}
      </header>

      {n.executiveSnapshot && (
        <NlSection icon="🚀" title="Executive Snapshot">
          <p className="nl-lede">{n.executiveSnapshot}</p>
        </NlSection>
      )}

      {n.wins?.length > 0 && (
        <NlSection icon="🏆" title="Wins Across the Company">
          <div className="nl-wins-grid">
            {n.wins.map((w, i) => (
              <div key={i} className="nl-win-card">
                {w.title && <div className="nl-win-title">{w.title}</div>}
                {w.description && <div className="nl-win-desc">{w.description}</div>}
              </div>
            ))}
          </div>
        </NlSection>
      )}

      {n.collaborations?.length > 0 && (
        <NlSection icon="🤝" title="Better Together">
          {n.collaborations.map((c, i) => (
            <div key={i} className="nl-callout">
              <div className="nl-callout-header">
                {c.department && <span className="nl-badge">{c.department}</span>}
                {c.person && <span className="nl-callout-person">{c.person}</span>}
              </div>
              {c.description && <div className="nl-callout-body">{c.description}</div>}
              {c.impact && <div className="nl-callout-impact">Impact: {c.impact}</div>}
            </div>
          ))}
        </NlSection>
      )}

      {n.spotlights?.length > 0 && (
        <NlSection icon="👏" title="Employee Spotlight">
          <div className="nl-spotlight-grid">
            {n.spotlights.map((s, i) => (
              <div key={i} className="nl-spotlight">
                <div className="nl-spotlight-name">{s.name}</div>
                {s.department && <div className="nl-spotlight-dept">{s.department}</div>}
                {s.reason && <div className="nl-spotlight-reason">{s.reason}</div>}
              </div>
            ))}
          </div>
        </NlSection>
      )}

      {n.welcomes?.length > 0 && (
        <NlSection icon="👋" title="Welcome to the Team">
          <div className="nl-welcomes-grid">
            {n.welcomes.map((w, i) => (
              <div key={i} className="nl-welcome">
                <div className="nl-welcome-type">{w.type || 'New Hire'}</div>
                <div className="nl-welcome-name">{w.name}</div>
                {(w.role || w.department) && (
                  <div className="nl-welcome-meta">{[w.role, w.department].filter(Boolean).join(' · ')}</div>
                )}
                {w.funFact && <div className="nl-welcome-fact">💫 {w.funFact}</div>}
              </div>
            ))}
          </div>
        </NlSection>
      )}

      {n.productUpdates?.length > 0 && (
        <NlSection icon="💻" title="Product & Technology">
          {n.productUpdates.map((p, i) => (
            <div key={i} className="nl-product">
              <div className="nl-product-head">
                {p.title && <div className="nl-product-title">{p.title}</div>}
                {p.status && <span className={`nl-status-tag nl-status-${p.status.toLowerCase().replace(/\s+/g, '-')}`}>{p.status}</span>}
              </div>
              {p.description && <div className="nl-product-desc">{p.description}</div>}
              {p.impact && <div className="nl-product-impact">💥 {p.impact}</div>}
            </div>
          ))}
        </NlSection>
      )}

      {n.departmentHighlights && (
        <NlSection icon="📈" title="Department Highlights">
          <p className="nl-body">{n.departmentHighlights}</p>
        </NlSection>
      )}

      {n.kpis?.length > 0 && (
        <NlSection icon="📊" title="By the Numbers">
          <div className="nl-kpi-grid">
            {n.kpis.map((k, i) => {
              const arrow = k.trend === 'Increase' ? '▲' : k.trend === 'Decrease' ? '▼' : '●';
              const tclass = k.trend === 'Increase' ? 'up' : k.trend === 'Decrease' ? 'down' : 'flat';
              return (
                <div key={i} className="nl-kpi">
                  <div className="nl-kpi-name">{k.name}</div>
                  <div className="nl-kpi-value">{k.value}</div>
                  {(k.previous || k.trend) && (
                    <div className={`nl-kpi-trend nl-kpi-${tclass}`}>
                      <span className="nl-kpi-arrow">{arrow}</span>
                      {k.previous && <span className="nl-kpi-prev">from {k.previous}</span>}
                    </div>
                  )}
                  {k.explanation && <div className="nl-kpi-explain">{k.explanation}</div>}
                </div>
              );
            })}
          </div>
        </NlSection>
      )}

      {n.didYouKnow && (
        <NlSection icon="💡" title="Did You Know?">
          <div className="nl-fact-box">{n.didYouKnow}</div>
        </NlSection>
      )}

      {n.lookingAhead && (
        <NlSection icon="🔭" title="Looking Ahead">
          <p className="nl-body">{n.lookingAhead}</p>
        </NlSection>
      )}

      {n.waterCooler?.length > 0 && (
        <NlSection icon="☕" title="Water Cooler">
          <div className="nl-wc-grid">
            {n.waterCooler.map((w, i) => (
              <div key={i} className="nl-wc">
                {w.category && <div className="nl-wc-cat">{w.category}</div>}
                {w.description && <div className="nl-wc-desc">{w.description}</div>}
              </div>
            ))}
          </div>
        </NlSection>
      )}

      {n.additionalNotes && (
        <NlSection icon="📝" title="Additional Notes">
          <p className="nl-body">{n.additionalNotes}</p>
        </NlSection>
      )}

      <footer className="nl-footer">
        <div>🛎️ The Ring Leader · {monthLabel(month)}</div>
        <div className="nl-footer-sub">Answering Legal · Internal Newsletter</div>
      </footer>
    </article>
  );
}

function NlSection({ icon, title, children }) {
  return (
    <section className="nl-section">
      <div className="nl-section-head">
        <span className="nl-section-icon">{icon}</span>
        <h2 className="nl-section-title">{title}</h2>
      </div>
      <div className="nl-section-body">{children}</div>
    </section>
  );
}

// ─── Past newsletters browser ────────────────────────────────────────────

function PastNewslettersPane({ onOpen }) {
  const [list, setList] = useState(null);

  useEffect(() => {
    api.get('/api/newsletter')
      .then(r => setList(r.data || []))
      .catch(() => setList([]));
  }, []);

  if (list === null) {
    return <div className="rl-loading">Loading past newsletters…</div>;
  }

  if (list.length === 0) {
    return (
      <div className="rl-empty-state">
        <div className="rl-empty-state-icon">🗞️</div>
        <div className="rl-empty-state-title">No past newsletters yet</div>
        <div className="rl-empty-state-sub">Generate your first newsletter to start the archive.</div>
      </div>
    );
  }

  return (
    <div className="rl-past-list">
      {list.map(item => (
        <button key={item.month} className="rl-past-card" onClick={() => onOpen(item.month)}>
          <div className="rl-past-month">{monthLabel(item.month)}</div>
          <div className="rl-past-meta">
            Generated {new Date(item.generatedAt).toLocaleDateString()} · {item.generatedByName || item.generatedBy}
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Export helpers ─────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNewsletterHtml(month, n) {
  const label = monthLabel(month);
  const win = (n.wins || []).map(w => `
      <div class="nl-win-card">
        ${w.title ? `<div class="nl-win-title">${esc(w.title)}</div>` : ''}
        ${w.description ? `<div class="nl-win-desc">${esc(w.description)}</div>` : ''}
      </div>`).join('');
  const collab = (n.collaborations || []).map(c => `
      <div class="nl-callout">
        <div class="nl-callout-header">
          ${c.department ? `<span class="nl-badge">${esc(c.department)}</span>` : ''}
          ${c.person ? `<span class="nl-callout-person">${esc(c.person)}</span>` : ''}
        </div>
        ${c.description ? `<div class="nl-callout-body">${esc(c.description)}</div>` : ''}
        ${c.impact ? `<div class="nl-callout-impact">Impact: ${esc(c.impact)}</div>` : ''}
      </div>`).join('');
  const spots = (n.spotlights || []).map(s => `
      <div class="nl-spotlight">
        <div class="nl-spotlight-name">${esc(s.name)}</div>
        ${s.department ? `<div class="nl-spotlight-dept">${esc(s.department)}</div>` : ''}
        ${s.reason ? `<div class="nl-spotlight-reason">${esc(s.reason)}</div>` : ''}
      </div>`).join('');
  const welcomes = (n.welcomes || []).map(w => `
      <div class="nl-welcome">
        <div class="nl-welcome-type">${esc(w.type || 'New Hire')}</div>
        <div class="nl-welcome-name">${esc(w.name)}</div>
        ${(w.role || w.department) ? `<div class="nl-welcome-meta">${esc([w.role, w.department].filter(Boolean).join(' · '))}</div>` : ''}
        ${w.funFact ? `<div class="nl-welcome-fact">💫 ${esc(w.funFact)}</div>` : ''}
      </div>`).join('');
  const products = (n.productUpdates || []).map(p => `
      <div class="nl-product">
        <div class="nl-product-head">
          ${p.title ? `<div class="nl-product-title">${esc(p.title)}</div>` : ''}
          ${p.status ? `<span class="nl-status-tag nl-status-${esc(p.status.toLowerCase().replace(/\s+/g, '-'))}">${esc(p.status)}</span>` : ''}
        </div>
        ${p.description ? `<div class="nl-product-desc">${esc(p.description)}</div>` : ''}
        ${p.impact ? `<div class="nl-product-impact">💥 ${esc(p.impact)}</div>` : ''}
      </div>`).join('');
  const kpis = (n.kpis || []).map(k => {
    const arrow = k.trend === 'Increase' ? '▲' : k.trend === 'Decrease' ? '▼' : '●';
    const tclass = k.trend === 'Increase' ? 'up' : k.trend === 'Decrease' ? 'down' : 'flat';
    return `
      <div class="nl-kpi">
        <div class="nl-kpi-name">${esc(k.name)}</div>
        <div class="nl-kpi-value">${esc(k.value)}</div>
        ${(k.previous || k.trend) ? `<div class="nl-kpi-trend nl-kpi-${tclass}"><span class="nl-kpi-arrow">${arrow}</span>${k.previous ? `<span class="nl-kpi-prev">from ${esc(k.previous)}</span>` : ''}</div>` : ''}
        ${k.explanation ? `<div class="nl-kpi-explain">${esc(k.explanation)}</div>` : ''}
      </div>`;
  }).join('');
  const water = (n.waterCooler || []).map(w => `
      <div class="nl-wc">
        ${w.category ? `<div class="nl-wc-cat">${esc(w.category)}</div>` : ''}
        ${w.description ? `<div class="nl-wc-desc">${esc(w.description)}</div>` : ''}
      </div>`).join('');

  const section = (icon, title, body) => body ? `
    <section class="nl-section">
      <div class="nl-section-head"><span class="nl-section-icon">${icon}</span><h2 class="nl-section-title">${esc(title)}</h2></div>
      <div class="nl-section-body">${body}</div>
    </section>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>The Ring Leader — ${esc(label)}</title>
<style>${NEWSLETTER_EXPORT_CSS}</style>
</head><body>
<article class="nl-doc">
  <header class="nl-cover">
    <div class="nl-cover-badge">🛎️ The Ring Leader</div>
    <h1 class="nl-cover-title">Your Monthly Pulse on Everything Ring Savvy</h1>
    <div class="nl-cover-month">${esc(label)}</div>
    ${n.coverIntro ? `<p class="nl-cover-intro">${esc(n.coverIntro)}</p>` : ''}
  </header>
  ${section('🚀', 'Executive Snapshot', n.executiveSnapshot ? `<p class="nl-lede">${esc(n.executiveSnapshot)}</p>` : '')}
  ${section('🏆', 'Wins Across the Company', win ? `<div class="nl-wins-grid">${win}</div>` : '')}
  ${section('🤝', 'Better Together', collab)}
  ${section('👏', 'Employee Spotlight', spots ? `<div class="nl-spotlight-grid">${spots}</div>` : '')}
  ${section('👋', 'Welcome to the Team', welcomes ? `<div class="nl-welcomes-grid">${welcomes}</div>` : '')}
  ${section('💻', 'Product & Technology', products)}
  ${section('📈', 'Department Highlights', n.departmentHighlights ? `<p class="nl-body">${esc(n.departmentHighlights)}</p>` : '')}
  ${section('📊', 'By the Numbers', kpis ? `<div class="nl-kpi-grid">${kpis}</div>` : '')}
  ${section('💡', 'Did You Know?', n.didYouKnow ? `<div class="nl-fact-box">${esc(n.didYouKnow)}</div>` : '')}
  ${section('🔭', 'Looking Ahead', n.lookingAhead ? `<p class="nl-body">${esc(n.lookingAhead)}</p>` : '')}
  ${section('☕', 'Water Cooler', water ? `<div class="nl-wc-grid">${water}</div>` : '')}
  ${section('📝', 'Additional Notes', n.additionalNotes ? `<p class="nl-body">${esc(n.additionalNotes)}</p>` : '')}
  <footer class="nl-footer">
    <div>🛎️ The Ring Leader · ${esc(label)}</div>
    <div class="nl-footer-sub">Answering Legal · Internal Newsletter</div>
  </footer>
</article>
</body></html>`;
}

function newsletterToSlackMarkdown(month, n) {
  const label = monthLabel(month);
  const out = [];
  out.push(`*🛎️ The Ring Leader — ${label}*`);
  out.push(`_Your Monthly Pulse on Everything Ring Savvy_`);
  if (n.coverIntro) { out.push(''); out.push(n.coverIntro); }

  if (n.executiveSnapshot) {
    out.push(''); out.push('*🚀 Executive Snapshot*');
    out.push(n.executiveSnapshot);
  }
  if (n.wins?.length) {
    out.push(''); out.push('*🏆 Wins Across the Company*');
    for (const w of n.wins) out.push(`• *${w.title || 'Win'}* — ${w.description || ''}`);
  }
  if (n.collaborations?.length) {
    out.push(''); out.push('*🤝 Better Together*');
    for (const c of n.collaborations) {
      const who = [c.department, c.person].filter(Boolean).join(' · ');
      out.push(`• *${who || 'Shout-out'}* — ${c.description || ''}${c.impact ? ` _Impact: ${c.impact}_` : ''}`);
    }
  }
  if (n.spotlights?.length) {
    out.push(''); out.push('*👏 Employee Spotlight*');
    for (const s of n.spotlights) out.push(`• *${s.name}*${s.department ? ` (${s.department})` : ''} — ${s.reason || ''}`);
  }
  if (n.welcomes?.length) {
    out.push(''); out.push('*👋 Welcome to the Team*');
    for (const w of n.welcomes) {
      const meta = [w.role, w.department].filter(Boolean).join(' · ');
      out.push(`• *${w.name}* — ${w.type || 'New Hire'}${meta ? ` · ${meta}` : ''}${w.funFact ? ` — 💫 ${w.funFact}` : ''}`);
    }
  }
  if (n.productUpdates?.length) {
    out.push(''); out.push('*💻 Product & Technology*');
    for (const p of n.productUpdates) {
      out.push(`• *${p.title || 'Update'}* ${p.status ? `[${p.status}]` : ''} — ${p.description || ''}${p.impact ? ` _Impact: ${p.impact}_` : ''}`);
    }
  }
  if (n.departmentHighlights) {
    out.push(''); out.push('*📈 Department Highlights*');
    out.push(n.departmentHighlights);
  }
  if (n.kpis?.length) {
    out.push(''); out.push('*📊 By the Numbers*');
    for (const k of n.kpis) {
      const arrow = k.trend === 'Increase' ? '▲' : k.trend === 'Decrease' ? '▼' : '●';
      out.push(`• *${k.name}*: ${k.value} ${arrow}${k.previous ? ` (from ${k.previous})` : ''}${k.explanation ? ` — ${k.explanation}` : ''}`);
    }
  }
  if (n.didYouKnow) { out.push(''); out.push('*💡 Did You Know?*'); out.push(n.didYouKnow); }
  if (n.lookingAhead) { out.push(''); out.push('*🔭 Looking Ahead*'); out.push(n.lookingAhead); }
  if (n.waterCooler?.length) {
    out.push(''); out.push('*☕ Water Cooler*');
    for (const w of n.waterCooler) out.push(`• *${w.category || 'Note'}* — ${w.description || ''}`);
  }
  if (n.additionalNotes) { out.push(''); out.push('*📝 Additional Notes*'); out.push(n.additionalNotes); }

  return out.join('\n');
}

// Inlined CSS used only inside the exported HTML file (self-contained).
const NEWSLETTER_EXPORT_CSS = `
  :root { --p:#7c3aed; --pk:#ec4899; --t:#00c9b1; --tx:#1a1a3e; --mut:rgba(26,26,62,.55); --br:rgba(168,85,247,.15); }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f6f5fb;color:var(--tx);padding:40px 20px;line-height:1.55;}
  .nl-doc{max-width:820px;margin:0 auto;background:#fff;border-radius:24px;box-shadow:0 20px 60px rgba(60,50,120,.08);overflow:hidden;}
  .nl-cover{padding:56px 48px 40px;background:linear-gradient(135deg,rgba(124,58,237,.10),rgba(236,72,153,.10) 60%,rgba(6,182,212,.10));border-bottom:1px solid var(--br);}
  .nl-cover-badge{display:inline-block;padding:6px 12px;background:#fff;color:var(--p);font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;border-radius:999px;border:1px solid var(--br);}
  .nl-cover-title{margin-top:16px;font-size:34px;font-weight:800;letter-spacing:-.01em;line-height:1.15;}
  .nl-cover-month{margin-top:6px;font-size:14px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.12em;}
  .nl-cover-intro{margin-top:20px;font-size:17px;line-height:1.55;color:#3a3560;max-width:640px;}
  .nl-section{padding:32px 48px;border-bottom:1px solid var(--br);}
  .nl-section:last-of-type{border-bottom:none;}
  .nl-section-head{display:flex;align-items:center;gap:12px;margin-bottom:16px;}
  .nl-section-icon{font-size:24px;}
  .nl-section-title{font-size:22px;font-weight:800;letter-spacing:-.01em;}
  .nl-lede{font-size:17px;line-height:1.55;color:#3a3560;}
  .nl-body{font-size:15px;line-height:1.6;color:#3a3560;}
  .nl-wins-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .nl-win-card{padding:16px;background:linear-gradient(135deg,rgba(124,58,237,.06),rgba(236,72,153,.04));border:1px solid var(--br);border-radius:12px;}
  .nl-win-title{font-weight:700;margin-bottom:4px;color:var(--p);}
  .nl-win-desc{font-size:14px;color:#3a3560;line-height:1.5;}
  .nl-callout{padding:14px 16px;background:rgba(0,201,177,.06);border-left:4px solid var(--t);border-radius:8px;margin-bottom:10px;}
  .nl-callout-header{display:flex;gap:8px;align-items:center;margin-bottom:6px;}
  .nl-badge{padding:2px 8px;background:var(--t);color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;}
  .nl-callout-person{font-size:13px;font-weight:600;color:var(--t);}
  .nl-callout-body{font-size:14px;color:#3a3560;line-height:1.5;}
  .nl-callout-impact{margin-top:6px;font-size:12px;font-weight:600;color:var(--t);letter-spacing:.03em;text-transform:uppercase;}
  .nl-spotlight-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .nl-spotlight{padding:16px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.25);border-radius:12px;}
  .nl-spotlight-name{font-weight:800;font-size:17px;color:#b35d00;}
  .nl-spotlight-dept{font-size:11px;font-weight:600;color:#b35d00;letter-spacing:.1em;text-transform:uppercase;margin-top:2px;}
  .nl-spotlight-reason{font-size:14px;line-height:1.5;margin-top:8px;color:#3a3560;}
  .nl-welcomes-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .nl-welcome{padding:14px;background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.25);border-radius:12px;}
  .nl-welcome-type{font-size:10px;font-weight:700;color:#0891b2;letter-spacing:.14em;text-transform:uppercase;}
  .nl-welcome-name{font-weight:800;font-size:16px;margin-top:2px;}
  .nl-welcome-meta{font-size:13px;color:var(--mut);margin-top:2px;}
  .nl-welcome-fact{margin-top:8px;font-size:13px;color:#3a3560;font-style:italic;}
  .nl-product{padding:14px 16px;background:#f9f8ff;border:1px solid var(--br);border-radius:10px;margin-bottom:10px;}
  .nl-product-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;}
  .nl-product-title{font-weight:700;font-size:15px;color:var(--p);}
  .nl-status-tag{padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;background:rgba(148,148,180,.15);color:var(--mut);}
  .nl-status-released{background:rgba(34,197,94,.15);color:#15803d;}
  .nl-status-in-progress{background:rgba(245,158,11,.15);color:#b35d00;}
  .nl-status-coming-soon{background:rgba(124,58,237,.15);color:var(--p);}
  .nl-product-desc{font-size:14px;color:#3a3560;line-height:1.5;}
  .nl-product-impact{margin-top:6px;font-size:13px;color:var(--p);}
  .nl-kpi-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
  .nl-kpi{padding:18px 16px;background:linear-gradient(135deg,#fff,#f6f5fb);border:1px solid var(--br);border-radius:14px;text-align:center;}
  .nl-kpi-name{font-size:10px;font-weight:700;color:var(--mut);letter-spacing:.14em;text-transform:uppercase;}
  .nl-kpi-value{font-size:28px;font-weight:800;color:var(--tx);margin-top:6px;line-height:1;}
  .nl-kpi-trend{margin-top:6px;font-size:12px;font-weight:700;display:flex;justify-content:center;align-items:center;gap:6px;}
  .nl-kpi-up{color:#15803d;} .nl-kpi-down{color:#dc2626;} .nl-kpi-flat{color:var(--mut);}
  .nl-kpi-arrow{font-size:14px;}
  .nl-kpi-prev{font-size:11px;color:var(--mut);font-weight:500;}
  .nl-kpi-explain{font-size:12px;color:var(--mut);margin-top:6px;line-height:1.4;}
  .nl-fact-box{padding:20px;background:linear-gradient(135deg,rgba(251,191,36,.10),rgba(236,72,153,.06));border:1px solid rgba(251,191,36,.30);border-radius:14px;font-size:15px;line-height:1.55;color:#3a3560;font-style:italic;}
  .nl-wc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .nl-wc{padding:12px 14px;background:#f9f8ff;border-radius:10px;border:1px solid var(--br);}
  .nl-wc-cat{font-size:10px;font-weight:700;color:var(--pk);letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px;}
  .nl-wc-desc{font-size:13px;line-height:1.5;color:#3a3560;}
  .nl-footer{padding:24px 48px;text-align:center;font-size:12px;color:var(--mut);background:#f9f8ff;}
  .nl-footer-sub{margin-top:4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;}
  @media print { body{background:#fff;padding:0;} .nl-doc{box-shadow:none;border-radius:0;} }
`;
