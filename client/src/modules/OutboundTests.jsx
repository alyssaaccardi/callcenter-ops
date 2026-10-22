import { useCallback, useEffect, useState } from 'react';
import { Phone, Plus, Shuffle, Trash2 } from 'lucide-react';
import api from '../api';
import './OutboundTests.css';

const fill = (text, test) => String(text || '')
  .replace(/\{contact\}/g, test.contact || 'the owner')
  .replace(/\{account\}/g, test.account)
  .replace(/\{phone\}/g, test.phone);

const STATUS_LABEL = { assigned: 'To do', submitted: 'Awaiting review', reviewed: 'Reviewed' };
const EVENT_LABEL = {
  assigned: 'Assigned', call_clicked: 'Clicked call', submitted: 'Submitted', reviewed: 'Reviewed', reopened: 'Reopened to agent',
};
const telHref = phone => `tel:+1${String(phone).replace(/\D/g, '').slice(-10)}`;
const when = value => (value ? new Date(`${value.replace(' ', 'T')}Z`).toLocaleString() : '');
const apiError = (err, fallback) => err.response?.data?.error || fallback;

export default function OutboundTests({ isAdmin, readOnly, agents }) {
  const [tests, setTests] = useState([]);
  const [types, setTypes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState('list');
  const [agentFilter, setAgentFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, ty] = await Promise.all([
        api.get('/api/ai-bot-qc/outbound-tests/assignments', { params: readOnly ? { mine: 1 } : {} }),
        api.get('/api/ai-bot-qc/outbound-tests/types'),
      ]);
      setTests(t.data.tests);
      setTypes(ty.data.types);
      setError('');
    } catch (err) { setError(apiError(err, 'Could not load tests')); }
  }, [readOnly]);

  useEffect(() => { load(); }, [load]);

  if (selectedId) {
    return <TestDetail id={selectedId} isAdmin={isAdmin && !readOnly} onBack={() => { setSelectedId(null); load(); }} />;
  }

  const visible = tests.filter(t => !agentFilter || t.agent_email === agentFilter);
  const groups = ['assigned', 'submitted', 'reviewed'];

  return (
    <div className="obt">
      {error && <p className="obt-error">{error}</p>}
      {isAdmin && !readOnly && (
        <div className="obt-toolbar">
          <button className={mode === 'assign' ? 'obt-btn is-primary' : 'obt-btn'} onClick={() => setMode(mode === 'assign' ? 'list' : 'assign')}><Plus size={14} /> Assign tests</button>
          <button className={mode === 'types' ? 'obt-btn is-primary' : 'obt-btn'} onClick={() => setMode(mode === 'types' ? 'list' : 'types')}>Manage test templates</button>
          <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)} aria-label="Filter by agent">
            <option value="">All agents</option>
            {agents.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
        </div>
      )}
      {mode === 'assign' && <AssignForm types={types} agents={agents} onDone={() => { setMode('list'); load(); }} />}
      {mode === 'types' && <TypeManager types={types} onChange={load} />}
      {mode === 'list' && groups.map(status => {
        const rows = visible.filter(t => t.status === status);
        if (status === 'reviewed' && !rows.length) return null;
        return (
          <section key={status} className="obt-group">
            <h3>{STATUS_LABEL[status]} <span>{rows.length}</span></h3>
            {!rows.length && <p className="obt-empty">{status === 'assigned' ? 'Nothing assigned right now.' : 'None.'}</p>}
            {rows.map(t => (
              <button key={t.id} className="obt-row" onClick={() => setSelectedId(t.id)}>
                <strong>{t.type?.title}</strong>
                <span>{t.account} · {t.phone}</span>
                {isAdmin && !readOnly && <span>{t.agent_name}</span>}
                {t.due_date && <span>Due {t.due_date}</span>}
                <em className={`obt-pill is-${t.status}`}>{STATUS_LABEL[t.status]}</em>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function AssignForm({ types, agents, onDone }) {
  const [typeId, setTypeId] = useState('');
  const [accounts, setAccounts] = useState(null);
  const [accountError, setAccountError] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState({});
  const [randomCount, setRandomCount] = useState(3);
  const [scenarios, setScenarios] = useState({});
  const [picked, setPicked] = useState([]);
  const [random, setRandom] = useState(false);
  const [due, setDue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const type = types.find(t => String(t.id) === String(typeId));

  useEffect(() => {
    api.get('/api/ai-bot-qc/outbound-tests/accounts')
      .then(res => setAccounts(res.data.accounts))
      .catch(err => { setAccounts([]); setAccountError(apiError(err, 'Could not load accounts')); });
  }, []);

  const chooseType = id => {
    setTypeId(id);
    setScenarios(types.find(t => String(t.id) === String(id))?.default_scenarios || {});
  };
  const toggleAgent = email => setPicked(cur => (cur.includes(email) ? cur.filter(e => e !== email) : [...cur, email]));
  const toggleAccount = account => setChosen(cur => {
    const next = { ...cur };
    if (next[account.customer]) delete next[account.customer]; else next[account.customer] = { account, contact: '' };
    return next;
  });
  const pickRandom = () => {
    const pool = (accounts || []).filter(a => a.did);
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Number(randomCount) || 1));
    setChosen(Object.fromEntries(shuffled.map(a => [a.customer, { account: a, contact: '' }])));
  };

  const query = search.trim().toLowerCase();
  const shown = (accounts || []).filter(a => !query || a.name.toLowerCase().includes(query) || a.did.includes(query));
  const chosenList = Object.values(chosen);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post('/api/ai-bot-qc/outbound-tests/assignments', {
        type_id: Number(typeId), agent_emails: picked, random, due_date: due || undefined,
        targets: chosenList.map(({ account, contact }) => ({ account: account.name, phone: account.did, contact, scenarios })),
      });
      onDone();
    } catch (err) { setError(apiError(err, 'Could not assign')); } finally { setSaving(false); }
  };

  return (
    <div className="obt-card">
      <h3>Assign tests</h3>
      <label>Test<select value={typeId} onChange={e => chooseType(e.target.value)}>
        <option value="">Choose a test…</option>
        {types.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
      </select></label>

      {type && type.variants.map(v => (
        <label key={v}>{type.variants.length > 1 ? `${v} scenario` : 'Scenario for the caller'}
          <input value={scenarios[v] || ''} onChange={e => setScenarios(cur => ({ ...cur, [v]: e.target.value }))} />
        </label>
      ))}

      <fieldset className="obt-accounts"><legend>Accounts to test (live from HubSpot and recordings){chosenList.length ? ` · ${chosenList.length} selected` : ''}</legend>
        <div className="obt-toolbar">
          <input placeholder="Search by name or DID" value={search} onChange={e => setSearch(e.target.value)} />
          <span className="obt-meta">Pick</span>
          <input type="number" min="1" max="50" className="obt-num" value={randomCount} onChange={e => setRandomCount(e.target.value)} />
          <button type="button" className="obt-btn" disabled={!accounts?.length} onClick={pickRandom}><Shuffle size={13} /> random accounts</button>
          {chosenList.length > 0 && <button type="button" className="obt-btn" onClick={() => setChosen({})}>Clear</button>}
        </div>
        {accounts === null && <p className="obt-meta">Loading accounts…</p>}
        {accountError && <p className="obt-error">{accountError}</p>}
        <div className="obt-account-list">
          {shown.map(a => (
            <label key={a.customer} className="obt-check obt-account-row">
              <input type="checkbox" checked={!!chosen[a.customer]} disabled={!a.did} onChange={() => toggleAccount(a)} />
              <span>{a.name}</span>
              <span className="obt-meta">{a.did ? `${a.did}${a.did_source === 'hubspot' ? ' (HubSpot)' : ''}` : 'No DID on file'}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {chosenList.length > 0 && type && /\{contact\}/.test(type.steps.join(' ')) && (
        <fieldset><legend>Who should the agent ask for? (optional, defaults to "the owner")</legend>
          {chosenList.map(({ account, contact }) => (
            <label key={account.customer}>{account.name}
              <input value={contact} onChange={e => setChosen(cur => ({ ...cur, [account.customer]: { account, contact: e.target.value } }))} />
            </label>
          ))}
        </fieldset>
      )}

      <fieldset><legend>Assign to</legend>
        {agents.map(a => (
          <label key={a.email} className="obt-check"><input type="checkbox" checked={picked.includes(a.email)} onChange={() => toggleAgent(a.email)} /> {a.name}</label>
        ))}
      </fieldset>
      <label className="obt-check"><input type="checkbox" checked={random} onChange={e => setRandom(e.target.checked)} />
        <Shuffle size={13} /> Randomly give each account to one of the selected agents</label>
      <label>Due date (optional)<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>
      {error && <p className="obt-error">{error}</p>}
      <button className="obt-btn is-primary" disabled={saving || !typeId || !picked.length || !chosenList.length} onClick={submit}>{saving ? 'Assigning…' : `Assign ${chosenList.length || ''} account${chosenList.length === 1 ? '' : 's'}`}</button>
    </div>
  );
}

const blankType = { title: '', objective: '', stepsText: '', call_notes: '', variantsText: 'Call', questionsText: '', improvement_prompt: 'Write one specific example from this call of something that could have been improved, provide as much detail as possible.', scenariosText: '' };
const typeToForm = t => ({
  title: t.title, objective: t.objective, stepsText: t.steps.join('\n'), call_notes: t.call_notes, variantsText: t.variants.join(', '),
  questionsText: t.questions.map(q => (q.type === 'text' ? `[text] ${q.text}` : q.text)).join('\n'),
  improvement_prompt: t.improvement_prompt,
  scenariosText: Object.entries(t.default_scenarios || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
});

function TypeManager({ types, onChange }) {
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const set = key => e => setForm(cur => ({ ...cur, [key]: e.target.value }));

  const save = async () => {
    const lines = text => text.split('\n').map(l => l.trim()).filter(Boolean);
    const payload = {
      title: form.title, objective: form.objective, steps: lines(form.stepsText), call_notes: form.call_notes,
      variants: form.variantsText.split(',').map(v => v.trim()).filter(Boolean),
      questions: lines(form.questionsText).map(l => (/^\[text\]/i.test(l) ? { text: l.replace(/^\[text\]\s*/i, ''), type: 'text' } : { text: l, type: 'yesno' })),
      improvement_prompt: form.improvement_prompt,
      default_scenarios: Object.fromEntries(lines(form.scenariosText).map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean)),
    };
    try {
      if (editingId === 'new') await api.post('/api/ai-bot-qc/outbound-tests/types', payload);
      else await api.put(`/api/ai-bot-qc/outbound-tests/types/${editingId}`, payload);
      setForm(null); setEditingId(null); setError(''); onChange();
    } catch (err) { setError(apiError(err, 'Could not save')); }
  };
  const remove = async t => {
    if (!window.confirm(`Remove the "${t.title}" template? Existing assignments keep working.`)) return;
    await api.delete(`/api/ai-bot-qc/outbound-tests/types/${t.id}`);
    onChange();
  };

  if (form) {
    return (
      <div className="obt-card">
        <h3>{editingId === 'new' ? 'New test template' : 'Edit test template'}</h3>
        <label>Title<input value={form.title} onChange={set('title')} /></label>
        <label>What you're testing<textarea rows={3} value={form.objective} onChange={set('objective')} /></label>
        <label>How to run this test (one step per line; you can use {'{contact}'}, {'{account}'}, {'{phone}'})<textarea rows={5} value={form.stepsText} onChange={set('stepsText')} /></label>
        <label>Call notes<textarea rows={2} value={form.call_notes} onChange={set('call_notes')} /></label>
        <label>Calls per account (comma separated, e.g. New Client, Existing Client)<input value={form.variantsText} onChange={set('variantsText')} /></label>
        <label>Feedback questions (one per line; start a line with [text] for a free-text answer, otherwise Yes/No plus details)<textarea rows={5} value={form.questionsText} onChange={set('questionsText')} /></label>
        <label>"One thing that could have been better" prompt<textarea rows={2} value={form.improvement_prompt} onChange={set('improvement_prompt')} /></label>
        <label>Default caller scenarios (one per line, e.g. "New Client: Your AC just broke"); admins can change them when assigning<textarea rows={3} value={form.scenariosText} onChange={set('scenariosText')} /></label>
        {error && <p className="obt-error">{error}</p>}
        <div className="obt-toolbar">
          <button className="obt-btn is-primary" disabled={!form.title.trim()} onClick={save}>Save</button>
          <button className="obt-btn" onClick={() => { setForm(null); setEditingId(null); }}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="obt-card">
      <h3>Test templates</h3>
      {types.map(t => (
        <div key={t.id} className="obt-row is-static">
          <strong>{t.title}</strong>
          <span>{t.variants.length > 1 ? t.variants.join(' + ') : 'Single call'} · {t.questions.length} questions</span>
          <button className="obt-btn" onClick={() => { setEditingId(t.id); setForm(typeToForm(t)); }}>Edit</button>
          <button className="obt-btn" onClick={() => remove(t)} aria-label={`Remove ${t.title}`}><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="obt-btn is-primary" onClick={() => { setEditingId('new'); setForm(blankType); }}><Plus size={14} /> New template</button>
    </div>
  );
}

function TestDetail({ id, isAdmin, onBack }) {
  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [improvement, setImprovement] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const res = await api.get(`/api/ai-bot-qc/outbound-tests/assignments/${id}`);
    setData(res.data);
    setAnswers(res.data.test.answers || {});
    setImprovement(res.data.test.improvement || '');
    setAdminNote(res.data.test.admin_note || '');
  }, [id]);
  useEffect(() => { load().catch(() => setMessage('Could not load this test')); }, [load]);

  if (!data) return <div className="obt"><button className="obt-btn" onClick={onBack}>← Back</button><p>{message || 'Loading…'}</p></div>;
  const { test, events } = data;
  const { type } = test;
  const editable = test.status !== 'reviewed' || isAdmin;

  const setAnswer = (variant, index, patch) => setAnswers(cur => ({
    ...cur, [variant]: { ...(cur[variant] || {}), [index]: { choice: '', text: '', ...(cur[variant]?.[index] || {}), ...patch } },
  }));
  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); setMessage(done); await load(); } catch (err) { setMessage(apiError(err, 'Something went wrong')); } finally { setBusy(false); }
  };
  const base = `/api/ai-bot-qc/outbound-tests/assignments/${id}`;
  const body = { answers, improvement };

  return (
    <div className="obt">
      <button className="obt-btn" onClick={onBack}>← Back to tests</button>
      <div className="obt-card">
        <h2>{type.title} <em className={`obt-pill is-${test.status}`}>{STATUS_LABEL[test.status]}</em></h2>
        <p className="obt-account"><strong>{test.account}</strong> · DID {test.phone}</p>
        <p className="obt-meta">Assigned to {test.agent_name}{test.due_date ? ` · due ${test.due_date}` : ''}</p>
        <h4>What you're testing</h4><p>{type.objective}</p>
        <h4>How to run this test</h4>
        <ol>{type.steps.map((s, i) => <li key={i}>{fill(s, test)}</li>)}</ol>
        {type.call_notes && <><h4>Call notes</h4><p>{fill(type.call_notes, test)}</p></>}
      </div>

      {type.variants.map(variant => (
        <div key={variant} className="obt-card">
          <div className="obt-call-head">
            <h3>{type.variants.length > 1 ? `${variant} call` : 'Call'}</h3>
            <a className="obt-btn is-primary" href={telHref(test.phone)}
              onClick={() => api.post(`${base}/call-click`, { variant }).catch(() => {})}><Phone size={14} /> Call {test.phone}</a>
          </div>
          {test.scenarios[variant] && <p className="obt-scenario">Scenario: {test.scenarios[variant]}</p>}
          {type.questions.map((q, i) => {
            const a = answers[variant]?.[i] || { choice: '', text: '' };
            return (
              <div key={i} className="obt-question">
                <p>{q.text}</p>
                {q.type === 'yesno' && (
                  <div className="obt-choices">
                    {['yes', 'no'].map(c => (
                      <button key={c} type="button" disabled={!editable} className={a.choice === c ? 'is-on' : ''} onClick={() => setAnswer(variant, i, { choice: c })}>{c === 'yes' ? 'Yes' : 'No'}</button>
                    ))}
                  </div>
                )}
                <textarea rows={2} disabled={!editable} placeholder={q.type === 'yesno' ? 'Details' : 'Your answer'} value={a.text} onChange={e => setAnswer(variant, i, { text: e.target.value })} />
              </div>
            );
          })}
        </div>
      ))}

      <div className="obt-card">
        <h3>One thing that could have been better</h3>
        <p className="obt-meta">{type.improvement_prompt}</p>
        <textarea rows={4} disabled={!editable} value={improvement} onChange={e => setImprovement(e.target.value)} />
        {editable && (
          <div className="obt-toolbar">
            <button className="obt-btn" disabled={busy} onClick={() => run(() => api.put(`${base}/answers`, body), 'Saved')}>Save draft</button>
            <button className="obt-btn is-primary" disabled={busy} onClick={() => run(() => api.post(`${base}/submit`, body), 'Submitted')}>{test.status === 'assigned' ? 'Submit for review' : 'Save changes'}</button>
          </div>
        )}
        {message && <p className="obt-meta">{message}</p>}
      </div>

      {isAdmin && (
        <div className="obt-card">
          <h3>Admin review</h3>
          <textarea rows={3} placeholder="Review note (optional)" value={adminNote} onChange={e => setAdminNote(e.target.value)} />
          <div className="obt-toolbar">
            <button className="obt-btn is-primary" disabled={busy || test.status === 'assigned'} onClick={() => run(() => api.post(`${base}/review`, { admin_note: adminNote }), 'Marked reviewed')}>Mark reviewed</button>
            <button className="obt-btn" disabled={busy || test.status === 'assigned'} onClick={() => run(() => api.post(`${base}/reopen`), 'Sent back to agent')}>Send back to agent</button>
            <button className="obt-btn" disabled={busy} onClick={async () => { if (window.confirm('Delete this assignment?')) { await api.delete(base); onBack(); } }}>Delete</button>
          </div>
        </div>
      )}
      {test.status === 'reviewed' && !isAdmin && test.admin_note && <div className="obt-card"><h3>Reviewer note</h3><p>{test.admin_note}</p></div>}

      <div className="obt-card">
        <h3>Audit log</h3>
        {events.map(e => (
          <p key={e.id} className="obt-meta">{when(e.created_at)} · {e.actor_name} · {EVENT_LABEL[e.event_type] || e.event_type}
            {e.details?.variant ? ` (${e.details.variant})` : ''}{e.details?.to ? ` → ${e.details.to}` : ''}</p>
        ))}
      </div>
    </div>
  );
}
