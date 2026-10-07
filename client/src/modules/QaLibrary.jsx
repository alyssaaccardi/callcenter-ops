import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Button, Card, Input, Badge, Checkbox, EmptyState, Modal } from '../components/ui';
import { fmtWhen } from './qaFormat';

// ─── Account library ─────────────────────────────────────────────────────────
// Mirrors what is configured in the AnsweringService.ai account builder, so the
// coordinator knows what an account does before assigning a test to it, and so
// generation can match a test to an account that actually has the setting the
// test is about.
const TEXT_FIELDS = [
  ['name', 'Account name'], ['account_ref', 'Account ID'], ['phone_numbers', 'Phone number(s)'],
  ['greeting_text', 'Greeting text'], ['outro_text', 'Outro text'],
  ['timezone', 'Timezone'], ['hours', 'Hours'], ['capture_intake', 'Capture intake'],
  ['ai_model', 'AI model'], ['stt_provider', 'Speech-to-Text provider'],
  ['tts_provider', 'Text-to-Speech provider'], ['tts_voice', 'TTS voice'],
];
const FLAG_FIELDS = [
  ['confirm_answers', 'Confirm answers'],
  ['background_noise', 'Background noise'],
  ['disambiguation', 'Disambiguation configured'],
];

export function Accounts() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => api.get('/api/qa/accounts').then(r => setRows(r.data)), []);
  // load() returns a promise; React would treat it as a cleanup function.
  useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <div className="qa-list-head">
        <h3>Account library</h3>
        <Button size="sm" onClick={() => setEdit({})}>Add account</Button>
      </div>
      {!rows.length && <EmptyState title="No accounts yet"
        message="Add the test accounts with their configuration so briefs can be matched to them." />}
      <table className="qa-table">
        <thead><tr><th>Account</th><th>Phone</th><th>Model / voice</th><th>Configuration</th><th></th></tr></thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.id} className={a.active ? '' : 'is-inactive'}>
              <td><strong>{a.name}</strong>{a.account_ref && <div className="qa-muted qa-mono">{a.account_ref}</div>}</td>
              <td className="qa-mono">{a.phone_numbers}</td>
              <td>{a.ai_model || '—'}{a.tts_voice ? ` · ${a.tts_voice}` : ''}</td>
              <td className="qa-flags">
                {!!a.background_noise && <Badge tone="warn" size="sm">noise</Badge>}
                {!!a.disambiguation && <Badge tone="info" size="sm">disambig</Badge>}
                {!!a.confirm_answers && <Badge tone="info" size="sm">confirms</Badge>}
                {!a.active && <Badge tone="neutral" size="sm">inactive</Badge>}
              </td>
              <td><button className="qa-link" onClick={() => setEdit(a)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <AccountModal account={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </Card>
  );
}

function AccountModal({ account, onClose, onSaved }) {
  const [a, setA] = useState({ active: 1, ...account });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      if (a.id) await api.put(`/api/qa/accounts/${a.id}`, a);
      else      await api.post('/api/qa/accounts', a);
      onSaved();
    } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={a.id ? `Edit ${a.name}` : 'New account'}>
      <div className="qa-acct-form">
        {TEXT_FIELDS.map(([k, label]) => (
          k === 'greeting_text' || k === 'outro_text' ? (
            <label key={k} className="qa-field qa-span2"><span className="qa-q">{label}</span>
              <textarea rows={2} value={a[k] || ''} onChange={e => setA({ ...a, [k]: e.target.value })} /></label>
          ) : (
            <Input key={k} label={label} value={a[k] || ''} onChange={e => setA({ ...a, [k]: e.target.value })} />
          )
        ))}
        <div className="qa-span2 qa-flagrow">
          {FLAG_FIELDS.map(([k, label]) => (
            <Checkbox key={k} label={label} checked={!!a[k]}
                      onChange={e => setA({ ...a, [k]: e.target.checked ? 1 : 0 })} />
          ))}
          <Checkbox label="Active" checked={!!a.active}
                    onChange={e => setA({ ...a, active: e.target.checked ? 1 : 0 })} />
        </div>
        <label className="qa-field qa-span2"><span className="qa-q">Call flow notes</span>
          <textarea rows={3} value={a.call_flow_notes || ''} onChange={e => setA({ ...a, call_flow_notes: e.target.value })} /></label>
        <label className="qa-field qa-span2"><span className="qa-q">Account-specific behaviour notes</span>
          <textarea rows={3} value={a.general_notes || ''} onChange={e => setA({ ...a, general_notes: e.target.value })} /></label>
      </div>
      <div className="qa-actions">
        <Button onClick={save} disabled={saving || !String(a.name || '').trim()}>
          {saving ? 'Saving…' : 'Save account'}</Button>
        <button className="qa-link" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ─── Templated intakes ───────────────────────────────────────────────────────
export function Intakes() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  useEffect(() => { api.get('/api/qa/intakes').then(r => setRows(r.data)); }, []);
  const shown = rows.filter(r => !q ||
    r.name.toLowerCase().includes(q.toLowerCase()) ||
    r.fields.some(f => f.label.toLowerCase().includes(q.toLowerCase())));

  return (
    <Card>
      <div className="qa-list-head">
        <h3>Templated intakes</h3>
        <Input label="Search" value={q} onChange={e => setQ(e.target.value)} placeholder="Intake or field name" />
      </div>
      <p className="qa-muted">The intake scripts configured in the platform, by call type. {rows.length} templates.</p>
      {shown.map(i => (
        <details key={i.id} className="qa-intake">
          <summary>
            <strong>{i.name}</strong>
            <Badge tone={i.brand === 'AL' ? 'info' : 'accent'} size="sm">{i.brand === 'AL' ? 'Answering Legal' : 'Ring Savvy'}</Badge>
            <span className="qa-muted">{i.fields.length} fields</span>
          </summary>
          <ol className="qa-intake-fields">
            {i.fields.map((f, k) => (
              <li key={k}>
                {f.label}
                {f.type === 'dropdown' && (
                  <span className="qa-dropdown"> — {f.options.join(' / ')}</span>
                )}
              </li>
            ))}
          </ol>
        </details>
      ))}
      {!shown.length && <EmptyState title="No match" message="No intake or field matches that search." />}
    </Card>
  );
}

// ─── Persona scripts ─────────────────────────────────────────────────────────
export function Personas() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  useEffect(() => { api.get('/api/qa/personas').then(r => setRows(r.data)); }, []);
  const shown = rows.filter(r => !q ||
    `${r.title} ${r.call_type} ${r.persona}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <Card>
      <div className="qa-list-head">
        <h3>Persona scripts</h3>
        <Input label="Search" value={q} onChange={e => setQ(e.target.value)} placeholder="Call type or situation" />
      </div>
      <p className="qa-muted">
        The call scripts testers work from — a persona, and the answers to give when the bot asks
        intake questions. {rows.length} scripts.
      </p>
      {shown.map(p => (
        <details key={p.id} className="qa-intake">
          <summary>
            <strong>{p.title}</strong>
            <Badge tone={p.brand === 'AL' ? 'info' : 'accent'} size="sm">{p.call_type}</Badge>
            {!!p.transfer_capable && <Badge tone="success" size="sm">transfer-capable</Badge>}
            {p.special_instruction && <Badge tone="warn" size="sm">special instruction</Badge>}
            <span className="qa-mono qa-muted">{p.phone}</span>
          </summary>
          <div className="qa-persona">
            <div className="qa-section-label">Persona</div>
            <p>{p.persona}</p>
            {p.opening_line && (<>
              <div className="qa-section-label">Your opening line</div>
              <p className="qa-quote">“{p.opening_line}”</p>
            </>)}
            {p.special_instruction && (
              <div className="qa-special">{p.special_instruction}</div>
            )}
            <div className="qa-section-label">Intake answers</div>
            <table className="qa-table qa-answers-table">
              <tbody>
                {p.answers.map(([qn, an], i) => (
                  <tr key={i}><td className="qa-aq">{qn}</td><td>{an}</td></tr>
                ))}
              </tbody>
            </table>
            {p.note && <p className="qa-muted qa-note">{p.note}</p>}
          </div>
        </details>
      ))}
      {!shown.length && <EmptyState title="No match" message="No script matches that search." />}
    </Card>
  );
}

// ─── Document tabs ───────────────────────────────────────────────────────────
export function Docs({ canEdit }) {
  const [tabs, setTabs] = useState([]);
  const [sel, setSel]   = useState(null);
  // Unsaved text per tab. Keying by slug means switching tabs shows the right
  // draft on its own, instead of an effect overwriting a single body field.
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => api.get('/api/qa/docs').then(r => {
    setTabs(r.data);
    setSel(s => s || r.data[0]?.slug);
  }), []);
  // load() returns a promise; React would treat it as a cleanup function.
  useEffect(() => { void load(); }, [load]);

  const cur  = tabs.find(t => t.slug === sel);
  const body = drafts[sel] ?? cur?.body ?? '';
  const setBody = (v) => setDrafts(d => ({ ...d, [sel]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/qa/docs/${sel}`, { body });
      setDrafts(d => { const n = { ...d }; delete n[sel]; return n; });
      await load();
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <div className="qa-doctabs">
        {tabs.map(t => (
          <button key={t.slug} className={`qa-doctab ${sel === t.slug ? 'is-active' : ''}`}
                  onClick={() => setSel(t.slug)}>{t.title}</button>
        ))}
      </div>
      {cur && (
        <>
          <div className="qa-muted qa-docmeta">
            {cur.updated_at ? `Updated ${fmtWhen(cur.updated_at)}${cur.updated_by ? ` by ${cur.updated_by}` : ''}` : 'Not written yet'}
          </div>
          {canEdit ? (
            <>
              <textarea className="qa-docbody" rows={18} value={body} onChange={e => setBody(e.target.value)}
                        placeholder={`Write the ${cur.title} page…`} />
              <div className="qa-actions">
                <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save page'}</Button>
              </div>
            </>
          ) : (
            body ? <pre className="qa-docview">{body}</pre>
                 : <EmptyState title={`${cur.title} is empty`} message="The coordinator hasn't written this page yet." />
          )}
        </>
      )}
    </Card>
  );
}
