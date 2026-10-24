import { useCallback, useEffect, useState } from 'react';
import { Phone, Plus, Shuffle, Trash2 } from 'lucide-react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import './OutboundTests.css';

const fill = (text, test) => String(text || '')
  .replace(/\{contact\}/g, test.contact || 'the owner')
  .replace(/\{account\}/g, test.account)
  .replace(/\{phone\}/g, test.phone);

const STATUS_LABEL = { assigned: 'To do', submitted: 'Awaiting review', reviewed: 'Reviewed' };
const EVENT_LABEL = {
  assigned: 'Assigned', call_clicked: 'Clicked call', submitted: 'Submitted', reviewed: 'Reviewed', reopened: 'Reopened to agent', kixie_call: 'Kixie call attached', staging_call: 'Staging call found', kixie_dial_requested: 'Kixie dial requested',
};
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
  const [manualName, setManualName] = useState('');
  const [manualDid, setManualDid] = useState('');
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
    if (next[account.customer]) delete next[account.customer]; else next[account.customer] = { account, contact: account.contact || '' };
    return next;
  });
  const setDid = (key, did) => setChosen(cur => ({ ...cur, [key]: { ...cur[key], did } }));
  const addManual = () => {
    const name = manualName.trim();
    const did = manualDid.trim();
    if (!name || !did) return;
    setChosen(cur => ({ ...cur, [`manual:${Date.now()}`]: { account: { name, customer: '', did }, contact: '', did, manual: true } }));
    setManualName('');
    setManualDid('');
  };
  const pickRandom = () => {
    const pool = (accounts || []).filter(a => a.did);
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Number(randomCount) || 1));
    setChosen(Object.fromEntries(shuffled.map(a => [a.customer, { account: a, contact: a.contact || '' }])));
  };

  const query = search.trim().toLowerCase();
  const shown = (accounts || []).filter(a => !query || a.name.toLowerCase().includes(query) || (a.did || '').includes(query));
  const chosenEntries = Object.entries(chosen);
  const chosenList = Object.values(chosen);

  const submit = async () => {
    const missing = chosenList.find(({ account, did }) => !(did ?? account.did ?? '').trim());
    if (missing) { setError(`Enter a DID for ${missing.account.name}`); return; }
    setError('');
    setSaving(true);
    try {
      await api.post('/api/ai-bot-qc/outbound-tests/assignments', {
        type_id: Number(typeId), agent_emails: picked, random, due_date: due || undefined,
        targets: chosenList.map(({ account, contact, did }) => ({ account: account.name, phone: (did ?? account.did ?? '').trim(), contact, scenarios })),
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

      <fieldset className="obt-accounts"><legend>Accounts to test (live from the staging AI bot){chosenList.length ? ` · ${chosenList.length} selected` : ''}</legend>
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
              <input type="checkbox" checked={!!chosen[a.customer]} onChange={() => toggleAccount(a)} />
              <span>{a.name}</span>
              {chosen[a.customer]
                ? <input className="obt-did-input" placeholder="DID to call" value={chosen[a.customer].did ?? a.did ?? ''} onClick={e => e.stopPropagation()} onChange={e => setDid(a.customer, e.target.value)} aria-label={`DID for ${a.name}`} />
                : <span className="obt-meta">{a.did || 'No DID on file'}</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset><legend>Add an account manually (any name, any DID)</legend>
        <div className="obt-toolbar">
          <input list="obt-account-names" placeholder="Account name (type or pick)" value={manualName} onChange={e => {
            setManualName(e.target.value);
            const match = (accounts || []).find(a => a.name === e.target.value);
            if (match?.did) setManualDid(match.did);
          }} />
          <datalist id="obt-account-names">{(accounts || []).map(a => <option key={a.customer} value={a.name} />)}</datalist>
          <input placeholder="DID to call, e.g. 631-555-0100" value={manualDid} onChange={e => setManualDid(e.target.value)} />
          <button type="button" className="obt-btn" disabled={!manualName.trim() || !manualDid.trim()} onClick={addManual}>Add</button>
        </div>
        {chosenEntries.length > 0 && <p className="obt-meta">Selected accounts: edit a DID to override the one on file.</p>}
        {chosenEntries.map(([key, entry]) => (
          <div key={key} className="obt-toolbar">
            <span>{entry.account.name}{entry.manual ? ' (manual)' : ''}</span>
            <input value={entry.did ?? entry.account.did ?? ''} onChange={e => setDid(key, e.target.value)} aria-label={`DID for ${entry.account.name}`} />
            <button type="button" className="obt-btn" onClick={() => setChosen(cur => { const next = { ...cur }; delete next[key]; return next; })}>Remove</button>
          </div>
        ))}
      </fieldset>

      {chosenList.length > 0 && type && /\{contact\}/.test(type.steps.join(' ')) && (
        <fieldset><legend>Who should the agent ask for? (optional, defaults to "the owner")</legend>
          {chosenEntries.map(([key, { account, contact }]) => (
            <label key={key}>{account.name}
              <input value={contact} onChange={e => setChosen(cur => ({ ...cur, [key]: { ...cur[key], contact: e.target.value } }))} />
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

// Shows a quiet one-line prompt (or the saved text) and only opens the text box when clicked.
function NoteField({ value, disabled, label, onChange }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return <textarea autoFocus rows={3} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} onBlur={() => setOpen(false)} />;
  }
  return (
    <button type="button" className={`obt-note${value ? ' has-text' : ''}`} disabled={disabled && !value} onClick={() => !disabled && setOpen(true)}>
      {value || `+ ${label}`}
    </button>
  );
}

const secs = n => (n == null ? '' : `${Math.floor(n / 60)}m ${n % 60}s`);

function StagingCall({ testId, link }) {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const base = `/api/ai-bot-qc/outbound-tests/assignments/${testId}/staging/${encodeURIComponent(link.call_id)}`;
  useEffect(() => {
    let live = true;
    api.get(base).then(res => { if (live) setCall(res.data.call); }).catch(err => { if (live) setError(apiError(err, 'Could not load this call')); });
    return () => { live = false; };
  }, [base]);
  const diag = call?.diagnostics;
  const intake = Object.entries(call?.intake || {}).filter(([, v]) => v !== null && v !== '');
  return (
    <div className="obt-kixie">
      <p><strong>{link.variant || 'Call'}</strong> · {new Date(link.started_at).toLocaleString()} · from {link.caller_number || 'unknown'}{call ? ` · ${secs(call.billed_duration_seconds)}` : ''}</p>
      {error && <p className="obt-error">{error}</p>}
      {!call && !error && <p className="obt-meta">Loading call details…</p>}
      {call && (
        <>
          {call.has_recording ? <audio controls preload="none" src={`${base}/recording`} /> : <p className="obt-meta">No recording for this call.</p>}
          {call.summary && <p><strong>Summary:</strong> {call.summary}</p>}
          <p className="obt-meta">
            {[call.disposition && `Disposition: ${call.disposition}`, call.classification && `Classification: ${call.classification}`,
              diag?.outcome?.kind && `Ended: ${diag.outcome.kind.replace(/_/g, ' ')}${diag.outcome.fault ? ' (FAULT)' : ''}`,
              diag?.voice_to_voice_p95_ms != null && `Reply wait (p95): ${(diag.voice_to_voice_p95_ms / 1000).toFixed(1)}s`,
              call.failed_action_count ? `${call.failed_action_count} failed action(s)` : ''].filter(Boolean).join(' · ')}
          </p>
          {intake.length > 0 && (
            <details><summary>Intake answers ({intake.length})</summary>
              {intake.map(([k, v]) => <p key={k} className="obt-meta"><strong>{k.replace(/_/g, ' ')}:</strong> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</p>)}
            </details>
          )}
          <button type="button" className="obt-btn" onClick={() => setShowTranscript(v => !v)}>{showTranscript ? 'Hide transcript' : 'Show transcript'}</button>
          {showTranscript && (
            <div className="obt-transcript">
              {call.transcript.length ? call.transcript.map((t, i) => <p key={i}><b>{t.role === 'assistant' ? 'AIRI' : 'Caller'}:</b> {t.content}</p>) : <p className="obt-meta">No transcript for this call.</p>}
            </div>
          )}
        </>
      )}
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
  const [dialing, setDialing] = useState('');
  const [callMessage, setCallMessage] = useState('');
  const { user } = useAuth();
  const viewerEmail = String(user?.email || '').toLowerCase();

  const load = useCallback(async () => {
    const res = await api.get(`/api/ai-bot-qc/outbound-tests/assignments/${id}`);
    setData(res.data);
    setAnswers(res.data.test.answers || {});
    setImprovement(res.data.test.improvement || '');
    setAdminNote(res.data.test.admin_note || '');
  }, [id]);
  useEffect(() => { load().catch(() => setMessage('Could not load this test')); }, [load]);

  const refreshStaging = async () => {
    try { await api.post(`/api/ai-bot-qc/outbound-tests/assignments/${id}/staging-refresh`); await load(); } catch { setMessage('Could not check staging'); }
  };

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
  const dial = async variant => {
    setDialing(variant);
    try {
      await api.post(`${base}/call`, { variant });
      setCallMessage(`Kixie is calling you now. Answer in Kixie and it will dial ${test.phone}.`);
      await load();
    } catch (err) {
      setCallMessage(`${apiError(err, 'Could not start the call.')} Number: ${test.phone}`);
    } finally { setDialing(''); }
  };

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
            <button type="button" className="obt-btn is-primary" disabled={dialing === variant || test.agent_email !== viewerEmail}
              title={test.agent_email !== viewerEmail ? 'Only the assigned agent can place this call' : undefined}
              onClick={() => dial(variant)}><Phone size={14} /> {dialing === variant ? 'Calling…' : `Call ${test.phone} with Kixie`}</button>
          </div>
          {callMessage && dialing === '' && <p className="obt-meta">{callMessage}</p>}
          {test.scenarios[variant] && <p className="obt-scenario">Scenario: {fill(test.scenarios[variant], test)}</p>}
          {type.questions.map((q, i) => {
            const a = answers[variant]?.[i] || { choice: '', text: '' };
            return (
              <div key={i} className="obt-question">
                <div className="obt-question-row">
                  <p><span className="obt-qnum">{i + 1}.</span> {q.text}</p>
                  {q.type === 'yesno' && (
                    <div className="obt-choices">
                      {['yes', 'no'].map(c => (
                        <button key={c} type="button" disabled={!editable} className={a.choice === c ? 'is-on' : ''} onClick={() => setAnswer(variant, i, { choice: a.choice === c ? '' : c })}>{c === 'yes' ? 'Yes' : 'No'}</button>
                      ))}
                    </div>
                  )}
                </div>
                <NoteField value={a.text} disabled={!editable} label={q.type === 'yesno' ? 'Add details' : 'Write your answer'} onChange={text => setAnswer(variant, i, { text })} />
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
        <h3>Staging calls</h3>
        {!test.staging_calls.length && <p className="obt-meta">No staging call found yet. After you call {test.phone} it appears here automatically with the recording, transcript and details.
          {' '}<button type="button" className="obt-btn" onClick={refreshStaging}>Check now</button></p>}
        {test.staging_calls.map(link => <StagingCall key={link.call_id} testId={test.id} link={link} />)}
      </div>

      <div className="obt-card">
        <h3>Kixie calls</h3>
        {!test.calls.length && <p className="obt-meta">No Kixie call has been matched yet. Calls from {test.agent_email} to {test.phone} attach here automatically after they end.</p>}
        {test.calls.map(c => (
          <div key={c.call_id} className="obt-kixie">
            <p><strong>{c.variant || 'Call'}</strong> · {when(c.called_at.replace('T', ' ').replace(/\.\d+Z$/, ''))} · {Math.floor(c.duration_seconds / 60)}m {c.duration_seconds % 60}s · {c.status || 'unknown'}{c.disposition && c.disposition !== 'not disposed' ? ` · ${c.disposition}` : ''}</p>
            {c.recording_url ? <audio controls preload="none" src={c.recording_url} /> : <p className="obt-meta">No recording was provided for this call.</p>}
          </div>
        ))}
      </div>

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
