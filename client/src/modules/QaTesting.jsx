import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Button, Card, Badge, EmptyState } from '../components/ui';
import './QaTesting.css';
import { fmtWhen } from './qaFormat';
import { Section } from './QaShared';
import { RoundsAdmin } from './QaAdmin';
import { Submissions, Dashboard, Roster } from './QaViews';
import { Accounts, Intakes, Docs, Personas } from './QaLibrary';

// ─── AI Receptionist Testing Platform ────────────────────────────────────────
// Three audiences in one module, because they share the same data and the board
// routes by role rather than by URL:
//   tester      a queue, one test at a time, and the form for it
//   admin       rounds, roster, accounts, submissions, export, docs
//   leadership  dashboard and submissions, read-only
//
// The tester view is deliberately the default for anyone on the roster: it is
// the screen that has to work without training.

export default function QaTesting() {
  const [ctx, setCtx]       = useState(null);
  const [view, setView]     = useState(null);
  const [error, setError]   = useState('');

  useEffect(() => {
    api.get('/api/qa/me')
      .then(r => {
        setCtx(r.data);
        setView(r.data.isAdmin ? 'rounds' : r.data.isLeadership ? 'dashboard' : 'queue');
      })
      .catch(e => setError(e.response?.data?.error || 'Could not load the testing platform'));
  }, []);

  if (error) return <Card><EmptyState title="Unavailable" message={error} /></Card>;
  if (!ctx)  return <Card><div className="qa-loading">Loading…</div></Card>;

  const isAdmin = ctx.isAdmin;
  const tabs = isAdmin
    ? [['rounds','Rounds'],['submissions','Submissions'],['dashboard','Dashboard'],
       ['roster','Roster'],['accounts','Accounts'],['personas','Scripts'],['intakes','Intakes'],['docs','Docs'],['queue','My Queue']]
    : ctx.isLeadership
      ? [['dashboard','Dashboard'],['submissions','Submissions'],['docs','Docs']]
      : [['queue','My Queue'],['docs','Docs']];

  return (
    <div className="qa">
      <div className="qa-head">
        <div>
          <h1 className="qa-title">AI Receptionist Testing</h1>
          <div className="qa-sub">
            {ctx.user?.name}
            {ctx.tester ? ' · on the tester roster' : isAdmin ? ' · coordinator' : ''}
          </div>
        </div>
      </div>

      <div className="qa-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`qa-tab ${view === id ? 'is-active' : ''}`}
                  onClick={() => setView(id)}>{label}</button>
        ))}
      </div>

      {view === 'queue'       && <TesterQueue ctx={ctx} />}
      {view === 'rounds'      && <RoundsAdmin ctx={ctx} />}
      {view === 'submissions' && <Submissions canFlag={isAdmin} />}
      {view === 'dashboard'   && <Dashboard />}
      {view === 'roster'      && <Roster />}
      {view === 'accounts'    && <Accounts />}
      {view === 'personas'    && <Personas />}
      {view === 'intakes'     && <Intakes />}
      {view === 'docs'        && <Docs canEdit={isAdmin} />}
    </div>
  );
}

// ─── Tester: queue + feedback form ───────────────────────────────────────────
function TesterQueue() {
  const [data, setData]       = useState(null);
  const [idx, setIdx]         = useState(0);
  const [answers, setAnswers] = useState({});
  const [improvement, setImprovement] = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const [done, setDone]       = useState(false);

  const load = useCallback(() => {
    api.get('/api/qa/my-queue').then(r => {
      setData(r.data);
      // Land on the first test they have not submitted, so returning mid-round
      // picks up where they left off rather than at the top.
      const next = (r.data.queue || []).findIndex(q => !q.submission_id);
      setIdx(next === -1 ? 0 : next);
    });
  }, []);
  // Consistent with the other loaders: never hand a loader's return value to
  // useEffect, which reads it as a cleanup function.
  useEffect(() => { void load(); }, [load]);

  if (!data) return <Card><div className="qa-loading">Loading your tests…</div></Card>;
  if (!data.tester) {
    return <Card><EmptyState title="You're not on the tester roster"
      message="Ask the coordinator to add your email to the roster and you'll see your assignments here." /></Card>;
  }
  if (!data.queue.length) {
    return <Card><EmptyState title="Nothing assigned yet"
      message="When the coordinator assigns a round, your tests appear here one at a time." /></Card>;
  }

  const t = data.queue[idx];
  const submitted = !!t.submission_id;
  const unanswered = t.questions.filter(q => !String(answers[q] || '').trim()).length;

  const submit = async () => {
    setErr(''); setSaving(true);
    try {
      await api.post(`/api/qa/assignments/${t.assignment_id}/submit`, {
        answers: t.questions.map(q => ({ question: q, answer: answers[q] || '' })),
        improvement,
      });
      setAnswers({}); setImprovement('');
      const rest = data.queue.filter((q, i) => i !== idx && !q.submission_id);
      if (rest.length) { load(); } else { setDone(true); load(); }
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not submit');
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="qa-progress">
        <div className="qa-progress-bar">
          <span style={{ width: `${data.total ? (data.done / data.total) * 100 : 0}%` }} />
        </div>
        <div className="qa-progress-text">{data.done} of {data.total} complete</div>
      </div>

      {done && data.done === data.total && (
        <Card className="qa-done"><EmptyState title="All done — nice work"
          message="You've submitted every test assigned to you this round." /></Card>
      )}

      <div className="qa-queue-nav">
        {data.queue.map((q, i) => (
          <button key={q.assignment_id}
                  className={`qa-pip ${i === idx ? 'is-active' : ''} ${q.submission_id ? 'is-done' : ''}`}
                  onClick={() => { setIdx(i); setAnswers({}); setImprovement(''); setErr(''); }}
                  title={`Test ${q.seq} — ${q.title}`}>
            {q.submission_id ? '✓' : i + 1}
          </button>
        ))}
      </div>

      <Card className="qa-brief">
        <div className="qa-brief-head">
          <h2>TEST {t.seq} — {t.title}</h2>
          {submitted && <Badge tone="success" size="sm">submitted {fmtWhen(t.submitted_at)}</Badge>}
        </div>

        <Section label="What you're testing"><p>{t.what_testing}</p></Section>

        <Section label="How to run this test">
          <ul className="qa-steps">{t.how_to_run.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </Section>

        <div className="qa-callcard">
          <div><span className="qa-k">Account</span><span className="qa-v">{t.account_name || '—'}</span></div>
          <div><span className="qa-k">Phone number</span>
            <a className="qa-phone" href={`tel:${t.phone_number}`}>{t.phone_number || '—'}</a></div>
          {t.call_type && <div><span className="qa-k">Call type</span><span className="qa-v">{t.call_type}</span></div>}
        </div>

        {/* What is actually configured on the account, so a model or voice test
            is judged against the real setup rather than an assumption. */}
        {(t.greeting_text || t.outro_text || t.ai_model || t.tts_voice) && (
          <Section label="What to expect on this account">
            <div className="qa-config">
              {t.greeting_text && <div><span className="qa-k">Greeting</span><span className="qa-v">“{t.greeting_text}”</span></div>}
              {t.outro_text    && <div><span className="qa-k">Outro</span><span className="qa-v">“{t.outro_text}”</span></div>}
              {t.ai_model      && <div><span className="qa-k">Model</span><span className="qa-v">{t.ai_model}</span></div>}
              {t.tts_voice     && <div><span className="qa-k">Voice</span><span className="qa-v">{t.tts_voice}{t.tts_provider ? ` (${t.tts_provider})` : ''}</span></div>}
              <div className="qa-flags">
                <Badge tone={t.background_noise ? 'warn' : 'neutral'} size="sm">
                  background noise {t.background_noise ? 'on' : 'off'}</Badge>
                <Badge tone={t.disambiguation ? 'info' : 'neutral'} size="sm">
                  disambiguation {t.disambiguation ? 'configured' : 'not configured'}</Badge>
                {!!t.confirm_answers && <Badge tone="info" size="sm">confirms answers</Badge>}
              </div>
            </div>
          </Section>
        )}

        <Section label="Call notes"><p className="qa-notes">{t.call_notes}</p></Section>

        <div className="qa-feedback">
          <h3>Feedback</h3>
          {submitted ? (
            <div className="qa-muted">You've already submitted this one. Pick another from the row above.</div>
          ) : (
            <>
              {t.questions.map((q, i) => (
                <label key={i} className="qa-field">
                  <span className="qa-q">{q}</span>
                  <textarea rows={3} value={answers[q] || ''}
                            onChange={e => setAnswers(a => ({ ...a, [q]: e.target.value }))} />
                </label>
              ))}
              <label className="qa-field qa-field-closing">
                <span className="qa-q">One thing that could have been better</span>
                <span className="qa-hint">Write one specific example from this call of something that could have been improved, with as much detail as possible.</span>
                <textarea rows={4} value={improvement}
                          onChange={e => setImprovement(e.target.value)} />
              </label>

              {err && <div className="qa-error">{err}</div>}
              {unanswered > 0 && (
                <div className="qa-muted qa-warnline">
                  {unanswered} question{unanswered === 1 ? '' : 's'} still blank — you can submit anyway, but the dev team gets more from a filled answer.
                </div>
              )}
              <Button onClick={submit} disabled={saving}>
                {saving ? 'Submitting…' : 'Submit and go to next test'}
              </Button>
            </>
          )}
        </div>
      </Card>
    </>
  );
}

export { TesterQueue };
