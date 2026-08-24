import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import { Button, Card, Input, Select, Badge, Tabs, EmptyState } from '../components/ui';

/* ─── CSV export ──────────────────────────────────────────────────── */

function toCsv(rows) {
  const header = [
    'Flagged','Reason','In Window',
    'Client (Answer)','Company (ChargeOver)',
    'Tenant','Customer ID','Created (CO)','Assigned Salesperson (raw)',
    'Billing Category','Error','ChargeOver URL',
  ];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const yn = v => v === true ? 'Y' : v === false ? 'N' : '';
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.flagged ? 'FLAGGED' : '',
      r.flagReason || '',
      yn(r.inWindow),
      r.client, r.coCompany || '',
      r.tenant || r.clientType || '', r.customerId ?? r.coCustomerId,
      r.createdAt || '',
      r.salesperson || '',
      r.billingCategory || '',
      r.error || '',
      r.coUrl || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function SalespersonAuditor() {
  const { toast } = useApp();
  const [view, setView] = useState('upload'); // upload | running | results
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: null, prefetch: null });
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState({ cutoffDate: null, allowlistSize: null });
  const [error, setError] = useState('');
  const [tab, setTab] = useState('attention');
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('all');
  const [tenantFilter, setTenantFilter] = useState('all');
  const readerRef = useRef(null);

  useEffect(() => () => { try { readerRef.current?.cancel(); } catch { /* ok */ } }, []);

  const onFile = (f) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setError('Please select a .csv file.'); return; }
    setError(''); setFile(f);
  };
  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    onFile(e.dataTransfer.files?.[0]);
  }, []);

  const reconcileResults = useCallback(async (jId) => {
    try {
      const resp = await api.get(`/api/salesperson-auditor/results/${jId}`);
      const full = resp.data?.results;
      if (Array.isArray(full) && full.length > 0) {
        setResults(full);
        setMeta({ cutoffDate: resp.data.cutoffDate || null, allowlistSize: resp.data.allowlistSize ?? null });
        setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total }));
      }
    } catch (e) {
      console.warn('[salesperson-auditor] reconcile failed:', e.message);
    }
  }, []);

  const pollUntilComplete = useCallback(async (jId) => {
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      try {
        const resp = await api.get(`/api/salesperson-auditor/results/${jId}`);
        const status = resp.data?.status;
        if (status === 'done' || status === 'error') {
          setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total }));
          return;
        }
        setProgress(p => ({ ...p, done: resp.data.done ?? p.done, total: resp.data.total ?? p.total, phase: resp.data.phase || p.phase }));
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 2000));
    }
  }, []);

  const startStream = useCallback(async (jId, total) => {
    setProgress({ done: 0, total, phase: 'prefetching', prefetch: null });
    setResults([]);
    let doneReceived = false;
    try {
      const resp = await fetch(`/api/salesperson-auditor/stream/${jId}`, {
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
      if (!resp.ok) { setError(`Stream error: ${resp.status}`); await reconcileResults(jId); setView('results'); return; }
      const reader = resp.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim());
            if (msg.type === 'result' && msg.result) {
              setResults(prev => [...prev, msg.result]);
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase || 'matching', prefetch: msg.prefetch || null });
            } else if (msg.type === 'progress') {
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase, prefetch: msg.prefetch });
            } else if (msg.type === 'done') {
              setProgress({ done: msg.done, total: msg.total, phase: msg.phase, prefetch: msg.prefetch });
              setMeta({ cutoffDate: msg.cutoffDate || null, allowlistSize: msg.allowlistSize ?? null });
              doneReceived = true;
              await reconcileResults(jId);
              setView('results');
              return;
            }
          } catch { /* skip malformed event */ }
        }
      }
      if (!doneReceived) await pollUntilComplete(jId);
      await reconcileResults(jId);
      setView('results');
    } catch (e) {
      setError('Stream disconnected — pulling final results…');
      if (!doneReceived) await pollUntilComplete(jId);
      await reconcileResults(jId);
      setError('');
      setView('results');
    }
  }, [reconcileResults, pollUntilComplete]);

  const handleRun = async () => {
    if (!file) { setError('Select a CSV first.'); return; }
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const resp = await api.post('/api/salesperson-auditor/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const { jobId, total } = resp.data;
      setView('running');
      startStream(jobId, total);
    } catch (e) {
      setError('Upload failed: ' + (e.response?.data?.error || e.message));
    }
  };

  const handleReset = () => {
    setView('upload');
    setFile(null);
    setProgress({ done: 0, total: 0, phase: null, prefetch: null });
    setResults([]);
    setError('');
    setTab('attention');
    setSearch('');
    setReasonFilter('all');
    setTenantFilter('all');
  };

  /* Summary counts */
  const summary = useMemo(() => {
    const s = { total: results.length, inWindow: 0, flagged: 0, unassigned: 0, notSalesperson: 0, notFound: 0, outOfWindow: 0 };
    for (const r of results) {
      if (r.error) s.notFound++;
      if (r.inWindow === true) s.inWindow++;
      if (r.inWindow === false) s.outOfWindow++;
      if (r.flagged) {
        s.flagged++;
        if (r.flagReason === 'Unassigned') s.unassigned++;
        if (r.flagReason === 'Not a salesperson') s.notSalesperson++;
      }
    }
    return s;
  }, [results]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return results.filter(r => {
      if (tab === 'attention' && !r.flagged) return false;
      if (tab === 'legacy'    && r.inWindow !== false) return false;
      if (tab === 'errors'    && !r.error) return false;
      if (reasonFilter !== 'all' && r.flagReason !== reasonFilter) return false;
      if (tenantFilter !== 'all' && (r.tenant || r.clientType) !== tenantFilter) return false;
      if (q) {
        const hay = `${r.client || ''} ${r.customerId || ''} ${r.coCustomerId || ''} ${r.coCompany || ''} ${r.salesperson || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [results, tab, reasonFilter, tenantFilter, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (a.client || '').localeCompare(b.client || ''));
  }, [filtered]);

  const doExport = () => {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `salesperson-audit-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Exported CSV', 'success');
  };

  /* ─── Render ─── */

  if (view === 'upload') {
    return (
      <div style={{ padding: 24, maxWidth: 900 }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Salesperson Auditor</h1>
          <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 14 }}>
            Check every account in a minute-usage CSV against ChargeOver's salesperson field.
            Flags customers created in the last 4 years whose salesperson field is empty or holds
            someone who isn't a real salesperson.
          </div>
        </div>
        {error && <div style={{ background: 'rgba(239,68,68,0.08)', color: '#b91c1c', padding: '10px 14px', borderRadius: 8, marginBottom: 12 }}>{error}</div>}
        <Card pad>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              position: 'relative',
              border: `2px dashed ${dragOver ? '#6366f1' : 'rgba(107,122,153,0.35)'}`,
              borderRadius: 12,
              padding: 40,
              textAlign: 'center',
              background: dragOver ? 'rgba(99,102,241,0.05)' : 'transparent',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 10 }} aria-hidden="true">📄</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{file ? file.name : 'Drop an Answer minute-usage CSV here'}</div>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
              …or click to browse. Uses the same CSV as the Minute Usage Auditor.
            </div>
            <input
              type="file" accept=".csv,text/csv"
              onChange={(e) => onFile(e.target.files?.[0])}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            {file && <Button variant="ghost" onClick={() => setFile(null)}>Clear</Button>}
            <Button variant="primary" disabled={!file} onClick={handleRun}>Run audit</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (view === 'running') {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const isPrefetch = progress.phase === 'prefetching';
    return (
      <div style={{ padding: 24, maxWidth: 900 }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Salesperson Auditor</h1>
          <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 14 }}>
            Loading ChargeOver customers, subscriptions, and admin list…
          </div>
        </div>
        <Card pad>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>
            {isPrefetch
              ? 'Loading ChargeOver data…'
              : <>Matching rows against ChargeOver… <b>{progress.done}</b> / {progress.total}</>
            }
          </div>
          <div style={{
            height: 8, background: 'rgba(107,122,153,0.15)', borderRadius: 4, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: isPrefetch ? '100%' : `${pct}%`,
              background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
              transition: 'width 0.3s',
              animation: isPrefetch ? 'sa-pulse 1.5s ease-in-out infinite' : 'none',
            }} />
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>
            {isPrefetch && progress.prefetch && Object.keys(progress.prefetch).length > 0
              ? Object.entries(progress.prefetch).map(([k, v]) => `${k}: ${v}`).join(' · ')
              : 'Streaming results as each row is resolved.'}
          </div>
          <style>{`@keyframes sa-pulse { 0%,100% { opacity: 0.6 } 50% { opacity: 1 } }`}</style>
        </Card>
      </div>
    );
  }

  /* Results */
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Salesperson Auditor</h1>
          <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 13 }}>
            Cutoff: customers created <b>{meta.cutoffDate || '—'}</b> or later ·
            Allowlist: <b>{meta.allowlistSize ?? '—'}</b> salespeople (CO admins with 0 logins across both tenants)
          </div>
        </div>
        <Button variant="ghost" onClick={handleReset}>Upload another</Button>
        <Button variant="primary" onClick={doExport}>Export CSV</Button>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Tile eyebrow="Total rows"      value={summary.total} />
        <Tile eyebrow="In window"       value={summary.inWindow} sub="within last 4 yrs" />
        <Tile eyebrow="Flagged"         value={summary.flagged} tone="crit" />
        <Tile eyebrow="Unassigned"      value={summary.unassigned} tone="warn" />
        <Tile eyebrow="Wrong assignee"  value={summary.notSalesperson} tone="warn" />
        <Tile eyebrow="Not in CO"       value={summary.notFound} tone="neutral" />
        <Tile eyebrow="Legacy (pre-cutoff)" value={summary.outOfWindow} tone="neutral" />
      </div>

      <Card pad>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'attention', label: 'Needs attention', count: summary.flagged },
              { id: 'all',       label: 'All',             count: summary.total },
              { id: 'legacy',    label: 'Legacy',          count: summary.outOfWindow },
              { id: 'errors',    label: 'Not in CO',       count: summary.notFound },
            ]}
          />
          <div style={{ flex: 1 }} />
          <Input
            placeholder="Search client, company, salesperson, CO id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 280 }}
          />
          <Select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            style={{ width: 200 }}
          >
            <option value="all">All reasons</option>
            <option value="Unassigned">Unassigned</option>
            <option value="Not a salesperson">Not a salesperson</option>
          </Select>
          <Select
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            style={{ width: 140 }}
          >
            <option value="all">All tenants</option>
            <option value="AL">AL only</option>
            <option value="RS">RS only</option>
          </Select>
        </div>

        {sorted.length === 0 ? (
          <EmptyState title="No rows to show" body="Nothing matches the current filter." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(107,122,153,0.2)', color: 'var(--muted)' }}>
                  <th style={{ padding: '8px 10px', width: 90 }}>Flag</th>
                  <th style={{ padding: '8px 10px' }}>Client (Answer)</th>
                  <th style={{ padding: '8px 10px' }}>Company (CO)</th>
                  <th style={{ padding: '8px 10px', width: 60 }}>Tenant</th>
                  <th style={{ padding: '8px 10px', width: 100 }}>CO ID</th>
                  <th style={{ padding: '8px 10px', width: 110 }}>Created</th>
                  <th style={{ padding: '8px 10px' }}>Salesperson (raw)</th>
                  <th style={{ padding: '8px 10px', width: 60 }}>Link</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(107,122,153,0.1)' }}>
                    <td style={{ padding: '8px 10px' }}>
                      {r.flagged
                        ? <Badge tone={r.flagReason === 'Unassigned' ? 'warn' : 'crit'}>{r.flagReason}</Badge>
                        : r.error
                          ? <Badge tone="neutral">Not in CO</Badge>
                          : r.inWindow === false
                            ? <Badge tone="neutral">Legacy</Badge>
                            : <Badge tone="ok">OK</Badge>}
                    </td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.client || '—'}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{r.coCompany || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>{r.tenant || r.clientType || '—'}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'ui-monospace, monospace' }}>{r.customerId || r.coCustomerId || '—'}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{r.createdAt || '—'}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'ui-monospace, monospace' }}>
                      {r.salesperson
                        ? r.salesperson
                        : <span style={{ color: '#b91c1c', fontStyle: 'italic' }}>(empty)</span>}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      {r.coUrl ? <a href={r.coUrl} target="_blank" rel="noopener noreferrer">Open</a> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({ eyebrow, value, sub, tone }) {
  const border = tone === 'crit' ? 'rgba(239,68,68,0.35)' :
                 tone === 'warn' ? 'rgba(245,158,11,0.35)' :
                 'rgba(107,122,153,0.2)';
  const color  = tone === 'crit' ? '#b91c1c' :
                 tone === 'warn' ? '#b45309' :
                 'inherit';
  return (
    <div style={{ padding: 12, border: `1px solid ${border}`, borderRadius: 10, background: 'var(--card-bg, #fff)' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>{eyebrow}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
