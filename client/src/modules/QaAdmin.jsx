import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Button, Card, Input, Select, Badge, EmptyState } from '../components/ui';

// ─── Rounds: dev notes → generation → review → confirm → assign ──────────────
// One screen per step of the round, in the order the coordinator works, rather
// than scattering the flow across pages.
export function RoundsAdmin() {
  const [rounds, setRounds] = useState([]);
  const [sel, setSel]       = useState(null);
  const [detail, setDetail] = useState(null);
  const [notes, setNotes]   = useState('');
  const [busy, setBusy]     = useState('');
  const [err, setErr]       = useState('');
  const [testers, setTesters] = useState([]);
  const [quotas, setQuotas]   = useState({});
  const [assignResult, setAssignResult] = useState(null);
  const [progress, setProgress] = useState([]);

  const loadRounds = useCallback(() => api.get('/api/qa/rounds').then(r => setRounds(r.data)), []);
  useEffect(() => { loadRounds(); api.get('/api/qa/testers').then(r => setTesters(r.data)); }, [loadRounds]);

  const open = useCallback(async (id) => {
    setSel(id); setErr(''); setAssignResult(null);
    const { data } = await api.get(`/api/qa/rounds/${id}`);
    setDetail(data); setNotes(data.round.dev_notes || '');
    api.get(`/api/qa/rounds/${id}/progress`).then(r => setProgress(r.data)).catch(() => setProgress([]));
  }, []);

  const newRound = async () => {
    const name = window.prompt('Name this round', `Round ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const { data } = await api.post('/api/qa/rounds', { name });
    await loadRounds(); open(data.id);
  };

  const generate = async () => {
    setBusy('generate'); setErr('');
    try {
      await api.post(`/api/qa/rounds/${sel}/generate`, { dev_notes: notes });
      await open(sel); await loadRounds();
    } catch (e) { setErr(e.response?.data?.error || 'Generation failed'); }
    finally { setBusy(''); }
  };

  const confirm = async () => {
    setBusy('confirm'); setErr('');
    try { await api.post(`/api/qa/rounds/${sel}/confirm`); await open(sel); await loadRounds(); }
    catch (e) { setErr(e.response?.data?.error || 'Could not confirm'); }
    finally { setBusy(''); }
  };

  const assign = async () => {
    setBusy('assign'); setErr('');
    const chosen = testers.filter(t => t.active && Number(quotas[t.id]) > 0)
                          .map(t => ({ id: t.id, quota: Number(quotas[t.id]) }));
    if (!chosen.length) { setErr('Give at least one tester a number of tests'); setBusy(''); return; }
    try {
      const { data } = await api.post(`/api/qa/rounds/${sel}/assign`, { testers: chosen });
      setAssignResult(data); await open(sel); await loadRounds();
    } catch (e) { setErr(e.response?.data?.error || 'Could not assign'); }
    finally { setBusy(''); }
  };

  const round = detail?.round;
  const briefs = detail?.briefs || [];
  const locked = round && round.status !== 'draft';

  return (
    <div className="qa-two">
      <Card className="qa-list">
        <div className="qa-list-head">
          <h3>Rounds</h3>
          <Button size="sm" onClick={newRound}>New round</Button>
        </div>
        {!rounds.length && <EmptyState title="No rounds yet" message="Create one to paste in dev notes." />}
        {rounds.map(r => (
          <button key={r.id} className={`qa-row ${sel === r.id ? 'is-active' : ''}`} onClick={() => open(r.id)}>
            <div className="qa-row-main">{r.name}</div>
            <div className="qa-row-sub">
              <Badge tone={r.status === 'draft' ? 'neutral' : r.status === 'closed' ? 'neutral' : 'info'} size="sm">{r.status}</Badge>
              <span>{r.brief_count} tests · {r.submission_count}/{r.assignment_count} in</span>
            </div>
          </button>
        ))}
      </Card>

      <div className="qa-detail">
        {!round && <Card><EmptyState title="Pick a round" message="Or create one to get started." /></Card>}

        {round && (
          <>
            <Card>
              <h3>1 · Dev notes</h3>
              <p className="qa-muted">Paste the dev team's raw notes. Generation produces one brief per focus area it finds.</p>
              <textarea className="qa-notes-input" rows={8} value={notes} disabled={locked}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="Paste raw notes from the dev team…" />
              <div className="qa-actions">
                <Button onClick={generate} disabled={!!busy || locked || !notes.trim()}>
                  {busy === 'generate' ? 'Generating…' : briefs.length ? 'Regenerate tests' : 'Generate tests'}
                </Button>
                {locked && <span className="qa-muted">Round is {round.status} — notes and briefs are locked.</span>}
              </div>
              {err && <div className="qa-error">{err}</div>}
            </Card>

            {!!briefs.length && (
              <Card>
                <div className="qa-list-head">
                  <h3>2 · Review briefs ({briefs.length})</h3>
                  {!locked && <Button onClick={confirm} disabled={!!busy}>
                    {busy === 'confirm' ? 'Confirming…' : 'Confirm briefs'}</Button>}
                </div>
                {briefs.map(b => <BriefEditor key={b.id} brief={b} locked={locked} onSaved={() => open(sel)} />)}
              </Card>
            )}

            {locked && (
              <Card>
                <div className="qa-list-head"><h3>3 · Assign</h3></div>
                <p className="qa-muted">Set how many tests each tester is doing this round. Tests are spread as evenly as the numbers allow.</p>
                <div className="qa-quota">
                  {testers.filter(t => t.active).map(t => (
                    <label key={t.id} className="qa-quota-row">
                      <span>{t.name}</span>
                      <input type="number" min="0" value={quotas[t.id] ?? ''}
                             onChange={e => setQuotas(q => ({ ...q, [t.id]: e.target.value }))}
                             placeholder="0" />
                    </label>
                  ))}
                  {!testers.filter(t => t.active).length &&
                    <div className="qa-muted">No active testers — add some on the Roster tab.</div>}
                </div>
                <div className="qa-actions">
                  <Button onClick={assign} disabled={!!busy}>{busy === 'assign' ? 'Assigning…' : 'Assign tests'}</Button>
                  <a className="qa-export" href={`/api/qa/rounds/${sel}/export?format=csv`}>Export CSV</a>
                  <a className="qa-export" href={`/api/qa/rounds/${sel}/export?format=pdf`}>Export PDF</a>
                </div>
                {assignResult && (
                  <div className={assignResult.unassigned ? 'qa-warn' : 'qa-ok'}>
                    {assignResult.assigned} test{assignResult.assigned === 1 ? '' : 's'} assigned
                    {assignResult.perTester?.length ? ' — ' + assignResult.perTester.map(t => `${t.name}: ${t.assigned}`).join(', ') : ''}
                    {assignResult.reason ? `. ${assignResult.reason}.` : ''}
                  </div>
                )}
                {!!progress.length && (
                  <div className="qa-progress-table">
                    <h4>Completion</h4>
                    {progress.map(p => (
                      <div key={p.id} className="qa-progress-row">
                        <span>{p.name}</span>
                        <div className="qa-progress-bar sm">
                          <span style={{ width: `${p.assigned ? (p.completed / p.assigned) * 100 : 0}%` }} />
                        </div>
                        <span className="qa-mono">{p.completed}/{p.assigned}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BriefEditor({ brief, locked, onSaved }) {
  // Only unsaved edits live in state; everything else is read straight from the
  // prop. Clearing the draft after a save lets the reloaded brief show through
  // without an effect syncing one into the other.
  const [draft, setDraft] = useState(null);
  const b = draft ?? brief;
  const setB = setDraft;
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open && !accounts.length) api.get('/api/qa/accounts').then(r => setAccounts(r.data)); }, [open, accounts.length]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/qa/briefs/${b.id}`, {
        title: b.title, what_testing: b.what_testing, how_to_run: b.how_to_run,
        call_notes: b.call_notes, questions: b.questions,
        account_id: b.account_id, phone_number: b.phone_number, call_type: b.call_type,
      });
      setDraft(null);
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="qa-brief-edit">
      <button className="qa-brief-toggle" onClick={() => setOpen(o => !o)}>
        <span className="qa-caret">{open ? '▾' : '▸'}</span>
        <strong>TEST {b.seq} — {b.title}</strong>
        <span className="qa-muted">{b.account_name || 'no account'}{b.call_type ? ` · ${b.call_type}` : ''}</span>
      </button>
      {open && (
        <div className="qa-brief-body">
          <Input label="Title" value={b.title} disabled={locked}
                 onChange={e => setB({ ...b, title: e.target.value })} />
          <label className="qa-field"><span className="qa-q">What you're testing</span>
            <textarea rows={3} value={b.what_testing || ''} disabled={locked}
                      onChange={e => setB({ ...b, what_testing: e.target.value })} /></label>
          <label className="qa-field"><span className="qa-q">How to run this test (one step per line)</span>
            <textarea rows={4} value={(b.how_to_run || []).join('\n')} disabled={locked}
                      onChange={e => setB({ ...b, how_to_run: e.target.value.split('\n').filter(Boolean) })} /></label>
          <label className="qa-field"><span className="qa-q">Call notes</span>
            <textarea rows={3} value={b.call_notes || ''} disabled={locked}
                      onChange={e => setB({ ...b, call_notes: e.target.value })} /></label>
          <div className="qa-grid2">
            <Select label="Account" value={b.account_id || ''} disabled={locked}
                    onChange={e => setB({ ...b, account_id: e.target.value ? Number(e.target.value) : null })}
                    options={[{ value: '', label: '— none —' },
                      ...accounts.map(a => ({ value: a.id, label: `${a.name}${a.background_noise ? ' · noise on' : ''}${a.disambiguation ? ' · disambig' : ''}` }))]} />
            <Input label="Phone number" value={b.phone_number || ''} disabled={locked}
                   onChange={e => setB({ ...b, phone_number: e.target.value })} />
          </div>
          <label className="qa-field"><span className="qa-q">Feedback questions (one per line)</span>
            <textarea rows={5} value={(b.questions || []).join('\n')} disabled={locked}
                      onChange={e => setB({ ...b, questions: e.target.value.split('\n').filter(Boolean) })} /></label>
          <p className="qa-muted">“One thing that could have been better” is added automatically as the closing field on every test.</p>
          {!locked && <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save brief'}</Button>}
        </div>
      )}
    </div>
  );
}
