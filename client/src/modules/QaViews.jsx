import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Button, Card, Input, Select, Badge, Checkbox, EmptyState, Modal } from '../components/ui';
import { fmtWhen } from './qaFormat';

// ─── Submissions review ──────────────────────────────────────────────────────
export function Submissions({ canFlag }) {
  const [rows, setRows]   = useState([]);
  const [f, setF]         = useState({ round_id: '', tester_id: '', account_id: '', call_type: '', from: '', to: '', flagged: '' });
  const [refs, setRefs]   = useState({ rounds: [], testers: [], accounts: [], callTypes: [] });
  const [open, setOpen]   = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/api/qa/rounds'), api.get('/api/qa/testers'),
      api.get('/api/qa/accounts'), api.get('/api/qa/call-types'),
    ]).then(([a, b, c, d]) => setRefs({ rounds: a.data, testers: b.data, accounts: c.data, callTypes: d.data }));
  }, []);

  const load = useCallback(() => {
    const qs = Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    api.get(`/api/qa/submissions${qs ? '?' + qs : ''}`).then(r => setRows(r.data));
  }, [f]);
  // load() returns a promise; React would treat it as a cleanup function.
  useEffect(() => { void load(); }, [load]);

  const flag = async (s) => {
    const note = window.prompt('Why is this notable?', s.flag_note || '');
    if (note === null) return;
    await api.post(`/api/qa/submissions/${s.id}/flag`, { flagged: !s.flagged || !!note, note });
    load();
  };

  return (
    <Card>
      <div className="qa-filters">
        <Select label="Round" value={f.round_id} onChange={e => setF({ ...f, round_id: e.target.value })}
                options={[{ value: '', label: 'All rounds' }, ...refs.rounds.map(r => ({ value: r.id, label: r.name }))]} />
        <Select label="Tester" value={f.tester_id} onChange={e => setF({ ...f, tester_id: e.target.value })}
                options={[{ value: '', label: 'All testers' }, ...refs.testers.map(t => ({ value: t.id, label: t.name }))]} />
        <Select label="Account" value={f.account_id} onChange={e => setF({ ...f, account_id: e.target.value })}
                options={[{ value: '', label: 'All accounts' }, ...refs.accounts.map(a => ({ value: a.id, label: a.name }))]} />
        <Select label="Call type" value={f.call_type} onChange={e => setF({ ...f, call_type: e.target.value })}
                options={[{ value: '', label: 'All call types' }, ...refs.callTypes.map(c => ({ value: c.name, label: `${c.name} (${c.brand})` }))]} />
        <Input label="From" type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} />
        <Input label="To"   type="date" value={f.to}   onChange={e => setF({ ...f, to: e.target.value })} />
        <Checkbox label="Flagged only" checked={f.flagged === '1'}
                  onChange={e => setF({ ...f, flagged: e.target.checked ? '1' : '' })} />
      </div>

      <div className="qa-count">{rows.length} submission{rows.length === 1 ? '' : 's'}</div>

      {!rows.length && <EmptyState title="Nothing here" message="No submissions match these filters yet." />}

      <table className="qa-table">
        <thead><tr>
          <th>Test</th><th>Tester</th><th>Account</th><th>Call type</th><th>Submitted</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id} className={s.flagged ? 'is-flagged' : ''}>
              <td><button className="qa-link" onClick={() => setOpen(s.id)}>TEST {s.seq} — {s.title}</button></td>
              <td>{s.tester_name}</td>
              <td>{s.account_name}</td>
              <td>{s.call_type}</td>
              <td className="qa-mono">{fmtWhen(s.submitted_at)}</td>
              <td>
                {s.flagged ? <Badge tone="crit" size="sm">flagged</Badge> : null}
                {canFlag && <button className="qa-flagbtn" onClick={() => flag(s)}
                                    title={s.flagged ? 'Unflag' : 'Flag as notable'}>⚑</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && <SubmissionModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function SubmissionModal({ id, onClose }) {
  const [s, setS] = useState(null);
  useEffect(() => { api.get(`/api/qa/submissions/${id}`).then(r => setS(r.data)); }, [id]);
  return (
    <Modal open onClose={onClose} title={s ? `TEST ${s.seq} — ${s.title}` : 'Loading…'}>
      {!s ? <div className="qa-loading">Loading…</div> : (
        <div className="qa-submission">
          <div className="qa-sub-meta">
            <span>{s.tester_name}</span><span>·</span><span>{fmtWhen(s.submitted_at)}</span>
            {s.account_name && <><span>·</span><span>{s.account_name}</span></>}
            {s.flagged ? <Badge tone="crit" size="sm">flagged</Badge> : null}
          </div>
          {s.flag_note && <div className="qa-flagnote">Flag note: {s.flag_note}</div>}
          {s.what_testing && <p className="qa-muted">{s.what_testing}</p>}
          {s.answers.map((a, i) => (
            <div key={i} className="qa-answer">
              <div className="qa-q">{a.question}</div>
              <div className="qa-a">{a.answer || <span className="qa-muted">— left blank —</span>}</div>
            </div>
          ))}
          {s.improvement && (
            <div className="qa-answer qa-answer-closing">
              <div className="qa-q">One thing that could have been better</div>
              <div className="qa-a">{s.improvement}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
export function Dashboard() {
  const [d, setD] = useState(null);
  const [f, setF] = useState({ round_id: '', account_id: '', call_type: '', from: '', to: '', background_noise: '' });
  const [refs, setRefs] = useState({ rounds: [], accounts: [], callTypes: [] });

  useEffect(() => {
    Promise.all([api.get('/api/qa/rounds'), api.get('/api/qa/accounts'), api.get('/api/qa/call-types')])
      .then(([a, b, c]) => setRefs({ rounds: a.data, accounts: b.data, callTypes: c.data }));
  }, []);
  useEffect(() => {
    const qs = Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    api.get(`/api/qa/dashboard${qs ? '?' + qs : ''}`).then(r => setD(r.data));
  }, [f]);

  if (!d) return <Card><div className="qa-loading">Loading…</div></Card>;
  const total = d.perTester.reduce((s, t) => s + t.submissions, 0);

  return (
    <>
      <Card>
        <div className="qa-filters">
          <Select label="Round" value={f.round_id} onChange={e => setF({ ...f, round_id: e.target.value })}
                  options={[{ value: '', label: 'All rounds' }, ...refs.rounds.map(r => ({ value: r.id, label: r.name }))]} />
          <Select label="Account" value={f.account_id} onChange={e => setF({ ...f, account_id: e.target.value })}
                  options={[{ value: '', label: 'All accounts' }, ...refs.accounts.map(a => ({ value: a.id, label: a.name }))]} />
          <Select label="Call type" value={f.call_type} onChange={e => setF({ ...f, call_type: e.target.value })}
                  options={[{ value: '', label: 'All call types' }, ...refs.callTypes.map(c => ({ value: c.name, label: c.name }))]} />
          <Select label="Background noise" value={f.background_noise}
                  onChange={e => setF({ ...f, background_noise: e.target.value })}
                  options={[{ value: '', label: 'Any' }, { value: '1', label: 'On' }, { value: '0', label: 'Off' }]} />
          <Input label="From" type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} />
          <Input label="To"   type="date" value={f.to}   onChange={e => setF({ ...f, to: e.target.value })} />
        </div>
      </Card>

      <div className="qa-tiles">
        <Tile label="Submissions" value={total} />
        <Tile label="Flagged" value={d.flagged.length} tone={d.flagged.length ? 'crit' : undefined} />
        <Tile label="Tests covered" value={d.perTest.length} />
        <Tile label="Testers reporting" value={d.perTester.length} />
      </div>

      {!!d.flagged.length && (
        <Card className="qa-flagged-card">
          <h3>Flagged submissions</h3>
          {d.flagged.map(x => (
            <div key={x.id} className="qa-flagged-row">
              <strong>TEST {x.seq} — {x.title}</strong>
              <span className="qa-muted">{x.tester_name} · {fmtWhen(x.submitted_at)}</span>
              {x.flag_note && <div className="qa-flagnote">{x.flag_note}</div>}
            </div>
          ))}
        </Card>
      )}

      <div className="qa-two">
        <Card>
          <h3>Per test</h3>
          {!d.perTest.length && <EmptyState title="No data" message="No submissions match these filters." />}
          {d.perTest.map(t => (
            <div key={t.id} className="qa-bar-row">
              <span className="qa-bar-label">TEST {t.seq} — {t.title}</span>
              <span className="qa-mono">{t.submissions}{t.flagged ? ` · ${t.flagged} flagged` : ''}</span>
            </div>
          ))}
        </Card>
        <Card>
          <h3>Per tester</h3>
          {d.perTester.map(t => (
            <div key={t.id} className="qa-bar-row">
              <span className="qa-bar-label">{t.name}</span>
              <span className="qa-mono">{t.submissions}</span>
            </div>
          ))}
          <h3 className="qa-mt">By account configuration</h3>
          {d.byConfig.map(b => (
            <div key={b.bucket} className="qa-bar-row">
              <span className="qa-bar-label">{b.bucket}</span>
              <span className="qa-mono">{b.submissions}</span>
            </div>
          ))}
        </Card>
      </div>

      <Card>
        <h3>What testers said</h3>
        <p className="qa-muted">Every answer grouped by the question it answers.</p>
        {d.answers.map((a, i) => (
          <details key={i} className="qa-agg">
            <summary>{a.question} <span className="qa-muted">({a.count})</span></summary>
            {a.responses.map((r, k) => (
              <div key={k} className="qa-agg-row">
                <span className="qa-muted">{r.tester} · TEST {r.seq}</span>
                <div>{r.answer || <span className="qa-muted">— blank —</span>}</div>
              </div>
            ))}
          </details>
        ))}
      </Card>
    </>
  );
}

function Tile({ label, value, tone }) {
  return <div className={`qa-tile ${tone ? `is-${tone}` : ''}`}>
    <div className="qa-tile-label">{label}</div><div className="qa-tile-value">{value}</div></div>;
}

// ─── Roster ──────────────────────────────────────────────────────────────────
export function Roster() {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/api/qa/testers').then(r => setRows(r.data)), []);
  // load() returns a promise; React would treat it as a cleanup function.
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setErr('');
    try { await api.post('/api/qa/testers', { name, email }); setName(''); setEmail(''); load(); }
    catch (e) { setErr(e.response?.data?.error || 'Could not add'); }
  };
  const toggle = async (t) => { await api.put(`/api/qa/testers/${t.id}`, { active: !t.active }); load(); };

  return (
    <Card>
      <h3>Tester roster</h3>
      <p className="qa-muted">Testers are matched to their board login by email. The roster carries across rounds.</p>
      <div className="qa-addrow">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@answeringlegal.com" />
        <Button onClick={add} disabled={!name.trim() || !email.trim()}>Add tester</Button>
      </div>
      {err && <div className="qa-error">{err}</div>}
      <table className="qa-table">
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id}>
              <td>{t.name}</td><td className="qa-mono">{t.email}</td>
              <td>{t.active ? <Badge tone="success" size="sm">active</Badge> : <Badge tone="neutral" size="sm">inactive</Badge>}</td>
              <td><button className="qa-link" onClick={() => toggle(t)}>{t.active ? 'Deactivate' : 'Reactivate'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
