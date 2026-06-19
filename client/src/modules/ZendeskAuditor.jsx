import React, { useState, useRef, useCallback } from 'react';
import api from '../api';

// ─── Category color mapping ────────────────────────────────────────────────
const CATEGORY_COLORS = {
  'Went to Competitor':                { bg: 'rgba(239,68,68,0.12)',    color: '#dc2626' },
  'Switched to AI Service':            { bg: 'rgba(6,182,212,0.12)',    color: '#0891b2' },
  'Price is Too High':                 { bg: 'rgba(249,115,22,0.12)',   color: '#ea580c' },
  'Downsizing Practice':               { bg: 'rgba(139,92,246,0.12)',   color: '#7c3aed' },
  'Hired Staff':                       { bg: 'rgba(139,92,246,0.12)',   color: '#7c3aed' },
  'Quality Issues':                    { bg: 'rgba(239,68,68,0.12)',    color: '#dc2626' },
  'Closed Practice':                   { bg: 'rgba(139,92,246,0.12)',   color: '#7c3aed' },
  'Leaving Firm':                      { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
  'Fired':                             { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
  'Not Enough Call Volume':            { bg: 'rgba(234,179,8,0.12)',    color: '#b45309' },
  'Wanted Features/Services Not Offered': { bg: 'rgba(99,102,241,0.12)', color: '#4338ca' },
  'Does Not See Value in Service':     { bg: 'rgba(249,115,22,0.12)',   color: '#ea580c' },
  'Unknown / Unspecified':             { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
};

const CONFIDENCE_COLORS = {
  High:   { bg: 'rgba(34,197,94,0.12)',  color: '#15803d' },
  Medium: { bg: 'rgba(234,179,8,0.12)',  color: '#b45309' },
  Low:    { bg: 'rgba(239,68,68,0.12)',  color: '#dc2626' },
};

function Badge({ label, colors }) {
  const c = colors?.[label] || { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' };
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 11,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 20,
      background: c.bg,
      color: c.color,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function exportCsv(results) {
  const headers = ['Account Name', 'Email Domain', 'Matched Org', 'Match Confidence', 'Match Type', 'Category', 'Competitor / AI Name', 'Confidence', 'Summary', 'Reasoning', 'Ticket IDs', 'Ticket Subjects', 'Status'];
  const needsCompetitor = r => r.category === 'Went to Competitor' || r.category === 'Switched to AI Service';
  const rows = results.map(r => [
    r.accountName, r.emailDomain, r.matchedOrg, r.matchConfidence, r.matchType,
    r.category, needsCompetitor(r) ? (r.competitorName || 'Unknown') : (r.competitorName || ''),
    r.confidence, r.summary, r.reasoning,
    (r.supportingTicketIds || []).join('; '),
    (r.ticketSubjects || []).join('; '),
    r.status,
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cancellation-audit.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function SummaryCell({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <div>
      <div style={expanded ? {} : {
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        maxWidth: 320,
      }}>
        {text}
      </div>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--accent, #6366f1)', marginTop: 2 }}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

function TicketLinks({ ids, subjects, zdSubdomain }) {
  if (!ids || ids.length === 0) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span>
      {ids.map((id, i) => (
        <span key={id}>
          <a
            href={`https://${zdSubdomain}.zendesk.com/agent/tickets/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={subjects?.[i] || String(id)}
            style={{ color: 'var(--accent, #6366f1)' }}
          >
            #{id}
          </a>
          {i < ids.length - 1 && ', '}
        </span>
      ))}
    </span>
  );
}

function ResultRow({ r, index }) {
  const zdSubdomain = r.zdSubdomain || '';
  const statusColor = r.status === 'done' ? '#15803d' : r.status === 'no_match' ? '#b45309' : '#dc2626';
  const usedKeywords = r.analysisMethod === 'keywords';

  return (
    <tr style={{ borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))', opacity: usedKeywords ? 0.85 : 1 }}>
      <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {r.accountName || r.emailDomain || <span style={{ color: 'var(--muted)' }}>—</span>}
        {r.emailDomain && r.accountName && (
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{r.emailDomain}</div>
        )}
        {usedKeywords && (
          <div style={{ fontSize: 10, fontWeight: 600, color: '#b45309', marginTop: 2, letterSpacing: '0.03em' }}>KEYWORD MATCH</div>
        )}
      </td>
      <td style={{ padding: '10px 12px', fontSize: 13 }}>
        {r.matchedOrg ? (
          <div>
            <div style={{ fontWeight: 500 }}>{r.matchedOrg}</div>
            {r.matchConfidence && <Badge label={r.matchConfidence} colors={CONFIDENCE_COLORS} />}
          </div>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>No match</span>
        )}
      </td>
      <td style={{ padding: '10px 12px' }}>
        {r.category ? (
          <div>
            <Badge label={r.category} colors={CATEGORY_COLORS} />
            {(r.category === 'Went to Competitor' || r.category === 'Switched to AI Service') && (
              <div style={{ fontSize: 11, color: r.competitorName ? 'var(--muted)' : 'rgba(156,163,175,0.7)', marginTop: 3, fontWeight: 500 }}>
                {r.competitorName || 'Unknown'}
              </div>
            )}
          </div>
        ) : <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>}
      </td>
      <td style={{ padding: '10px 12px' }}>
        {r.confidence ? <Badge label={r.confidence} colors={CONFIDENCE_COLORS} /> : <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>}
      </td>
      <td style={{ padding: '10px 12px', fontSize: 13, maxWidth: 360 }}>
        <SummaryCell text={r.summary} />
      </td>
      <td style={{ padding: '10px 12px', fontSize: 13 }}>
        <TicketLinks ids={r.supportingTicketIds} subjects={r.ticketSubjects} zdSubdomain={zdSubdomain} />
      </td>
      <td style={{ padding: '10px 12px', fontSize: 12, fontWeight: 700, color: statusColor, whiteSpace: 'nowrap' }}>
        {r.status === 'done' ? 'Done' : r.status === 'no_match' ? 'No Match' : 'Error'}
        {r.error && <div style={{ fontSize: 11, fontWeight: 400, color: '#dc2626', maxWidth: 200 }}>{r.error}</div>}
      </td>
    </tr>
  );
}

function SpinnerRow({ index }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
      <td colSpan={7} style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite' }}>
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10" />
          </svg>
          Analyzing row {index + 1}…
        </span>
      </td>
    </tr>
  );
}

export default function ZendeskAuditor() {
  const [view, setView] = useState('upload');      // 'upload' | 'running' | 'results'
  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const readerRef = useRef(null);

  const handleFile = useCallback((f) => {
    if (!f) return;
    const ok = /\.(csv|xlsx|xls)$/i.test(f.name);
    if (!ok) { setError('Please upload a .csv, .xlsx, or .xls file.'); return; }
    setFile(f);
    setError('');
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const onDragOver = useCallback((e) => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  const startStream = useCallback(async (jId, total) => {
    setProgress({ done: 0, total });
    setResults([]);

    // Use fetch + ReadableStream to maintain auth cookies (EventSource doesn't send cookies)
    try {
      const resp = await fetch(`/api/zendesk-auditor/stream/${jId}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });

      if (!resp.ok) {
        setError(`Stream error: ${resp.status}`);
        setView('results');
        return;
      }

      const reader = resp.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';

      const read = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // incomplete last chunk
            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data:')) continue;
              const json = line.slice(5).trim();
              if (!json) continue;
              try {
                const msg = JSON.parse(json);
                if (msg.type === 'result' && msg.result) {
                  setResults(prev => [...prev, msg.result]);
                  setProgress({ done: msg.done, total: msg.total });
                } else if (msg.type === 'progress') {
                  setProgress({ done: msg.done, total: msg.total });
                } else if (msg.type === 'done') {
                  setProgress({ done: msg.done, total: msg.total });
                  setView('results');
                  return;
                }
              } catch (parseErr) {
                // ignore malformed event
              }
            }
          }
          setView('results');
        } catch (readErr) {
          if (readErr.name !== 'AbortError') {
            setError('Stream disconnected: ' + readErr.message);
          }
          setView('results');
        }
      };

      read();
    } catch (fetchErr) {
      setError('Failed to open stream: ' + fetchErr.message);
      setView('results');
    }
  }, []);

  const handleRunAudit = useCallback(async () => {
    if (!file) { setError('Please select a file first.'); return; }
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const resp = await api.post('/api/zendesk-auditor/run', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const { jobId: jId, total } = resp.data;
      setJobId(jId);
      setView('running');
      startStream(jId, total);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setError('Failed to start audit: ' + msg);
    }
  }, [file, startStream]);

  const handleCancel = useCallback(() => {
    if (readerRef.current) {
      try { readerRef.current.cancel(); } catch (e) { /* ignore */ }
      readerRef.current = null;
    }
    setView('results');
  }, []);

  const handleReset = useCallback(() => {
    handleCancel();
    setView('upload');
    setFile(null);
    setJobId(null);
    setProgress({ done: 0, total: 0 });
    setResults([]);
    setError('');
  }, [handleCancel]);

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // ── Upload view ─────────────────────────────────────────────────────────────
  if (view === 'upload') {
    return (
      <div>
        <div className="page-header">
          <div>
            <div className="page-title">Cancellation Auditor</div>
            <div className="page-sub">Zendesk AI · Analyze cancellation reasons from ticket history</div>
          </div>
        </div>

        <div className="card" style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ marginBottom: 20 }}>
            <div className="field-label">Upload Customer List</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Upload a CSV or Excel file with columns: Account Name, Email Domain, Customer Email, and/or Org Name
            </div>
          </div>

          {/* Drop zone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent, #6366f1)' : 'var(--border, rgba(0,0,0,0.15))'}`,
              borderRadius: 10,
              padding: '40px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? 'rgba(99,102,241,0.04)' : 'transparent',
              transition: 'all 0.15s',
              marginBottom: 16,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={e => handleFile(e.target.files?.[0])}
            />
            <div style={{ fontSize: 32, marginBottom: 10 }}>📄</div>
            {file ? (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{file.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  {(file.size / 1024).toFixed(1)} KB · Click or drop to replace
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                  Drop file here or <span style={{ color: 'var(--accent, #6366f1)' }}>click to browse</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Accepts .csv, .xlsx, .xls</div>
              </div>
            )}
          </div>

          {error && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={handleRunAudit} disabled={!file}>
              Run Audit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Running view ────────────────────────────────────────────────────────────
  if (view === 'running') {
    return (
      <div>
        <div className="page-header">
          <div>
            <div className="page-title">Cancellation Auditor</div>
            <div className="page-sub">Zendesk AI · Analyzing customers…</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-ghost btn-sm" onClick={handleCancel}>Stop &amp; View Results</button>
          </div>
        </div>

        {/* Progress */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {progress.done} / {progress.total} customers analyzed
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{pct}%</span>
          </div>
          <div style={{ background: 'var(--border, rgba(0,0,0,0.1))', borderRadius: 99, height: 8, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 99,
              background: 'var(--accent, #6366f1)',
              width: `${pct}%`,
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>

        {/* Live results table */}
        {(results.length > 0 || progress.total > 0) && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2, rgba(0,0,0,0.03))' }}>
                    {['Customer', 'Matched Org', 'Category', 'Confidence', 'Summary', 'Tickets', 'Status'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => <ResultRow key={i} r={r} index={i} />)}
                  {progress.done < progress.total && <SpinnerRow index={progress.done} />}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Results view ────────────────────────────────────────────────────────────
  const doneCount      = results.filter(r => r.status === 'done').length;
  const noMatchCount   = results.filter(r => r.status === 'no_match').length;
  const errorCount     = results.filter(r => r.status === 'error').length;
  const keywordCount   = results.filter(r => r.analysisMethod === 'keywords').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Cancellation Auditor</div>
          <div className="page-sub">
            {results.length} customers · {doneCount} analyzed · {noMatchCount} no match · {errorCount} error
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {results.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => exportCsv(results)}>
              Export CSV
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={handleReset}>
            New Audit
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {keywordCount > 0 && (
        <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#b45309', marginBottom: 3 }}>
              AI quota reached — {keywordCount} {keywordCount === 1 ? 'row was' : 'rows were'} categorized using keyword matching
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Keyword matching scans ticket text for known terms and patterns — it works well for clear-cut cases but lacks the context and nuance of AI analysis. Results marked <strong style={{ color: '#b45309' }}>KEYWORD MATCH</strong> should be reviewed manually for accuracy. The Gemini free tier quota resets daily at midnight Pacific Time — re-run the audit after midnight and AI analysis will resume automatically.
            </div>
          </div>
        </div>
      )}

      {results.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 40px', color: 'var(--muted)' }}>
          No results to display.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface2, rgba(0,0,0,0.03))' }}>
                  {['Customer', 'Matched Org', 'Category', 'Confidence', 'Summary', 'Tickets', 'Status'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => <ResultRow key={i} r={r} index={i} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
