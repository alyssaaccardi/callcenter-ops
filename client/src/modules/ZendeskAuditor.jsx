import React, { useState, useRef, useCallback } from 'react';
import api from '../api';

// ─── Category color mapping ────────────────────────────────────────────────
const CATEGORY_COLORS = {
  'Went to Competitor':                { bg: 'rgba(239,68,68,0.12)',    color: '#dc2626' },
  'Switched to AI Service':            { bg: 'rgba(6,182,212,0.12)',    color: '#0891b2' },
  'Price is Too High':                 { bg: 'rgba(249,115,22,0.12)',   color: '#ea580c' },
  'Downsizing Practice':               { bg: 'rgba(139,92,246,0.12)',   color: '#7c3aed' },
  'Hired Staff':                       { bg: 'rgba(139,92,246,0.12)',   color: '#7c3aed' },
  'IVR / Auto Attendant':              { bg: 'rgba(6,182,212,0.12)',    color: '#0e7490' },
  'Missed Calls':                      { bg: 'rgba(239,68,68,0.12)',    color: '#dc2626' },
  'Message / Intake Errors':           { bg: 'rgba(249,115,22,0.12)',   color: '#c2410c' },
  'Receptionist Conduct':              { bg: 'rgba(239,68,68,0.12)',    color: '#991b1b' },
  'Quality of Service':                { bg: 'rgba(239,68,68,0.12)',    color: '#dc2626' },
  'Technical Issues':                  { bg: 'rgba(239,68,68,0.12)',    color: '#b91c1c' },
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

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function TrendChart({ results, onSegmentClick }) {
  const [tooltip, setTooltip] = useState(null); // { x, y, key, cat, rows }
  const containerRef = useRef(null);

  const dated = results.filter(r => r.status === 'done' && r.estimatedCancellationDate);

  if (dated.length < 3) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af', marginBottom: 8 }}>Cancellation Trend</div>
        <div style={{ fontSize: 13, color: '#9ca3af', padding: '24px 0', textAlign: 'center' }}>
          Not enough dated data — only {dated.length} of {results.filter(r=>r.status==='done').length} results have an estimated cancellation date.
        </div>
      </div>
    );
  }

  const timestamps = dated.map(r => new Date(r.estimatedCancellationDate + 'T00:00:00').getTime());
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const rangeMonths = (maxTs - minTs) / (1000 * 60 * 60 * 24 * 30.5);

  let bucketKeyFn, bucketLabelFn, groupNote, xAxisLabel;
  if (rangeMonths <= 20) {
    bucketKeyFn = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    bucketLabelFn = k => { const [y,m] = k.split('-'); return `${MONTHS[+m-1]} '${y.slice(2)}`; };
    xAxisLabel = 'EXIT MONTH';
  } else if (rangeMonths <= 52) {
    bucketKeyFn = d => `${d.getFullYear()}-Q${Math.ceil((d.getMonth()+1)/3)}`;
    bucketLabelFn = k => k.replace('-', ' ');
    groupNote = 'Grouped by quarter';
    xAxisLabel = 'EXIT QUARTER';
  } else {
    bucketKeyFn = d => String(d.getFullYear());
    bucketLabelFn = k => k;
    groupNote = `Wide date range (${Math.round(rangeMonths/12)}+ yrs) — grouped by year`;
    xAxisLabel = 'EXIT YEAR';
  }

  // Build bucket → category → [result rows]
  const buckets = {};
  for (const r of dated) {
    const key = bucketKeyFn(new Date(r.estimatedCancellationDate + 'T00:00:00'));
    if (!buckets[key]) buckets[key] = {};
    if (!buckets[key][r.category]) buckets[key][r.category] = [];
    buckets[key][r.category].push(r);
  }

  const sortedKeys = Object.keys(buckets).sort();
  const totals = sortedKeys.map(k => Object.values(buckets[k]).reduce((s, arr) => s + arr.length, 0));
  const maxTotal = Math.max(...totals);

  const allCats = {};
  for (const r of dated) allCats[r.category] = (allCats[r.category] || 0) + 1;
  const catOrder = Object.entries(allCats).sort((a,b) => b[1]-a[1]).map(([c]) => c);

  const PAD = { top: 28, right: 16, bottom: 52, left: 46 };
  const SVG_W = 640;
  const SVG_H = 210;
  const chartW = SVG_W - PAD.left - PAD.right;
  const chartH = SVG_H - PAD.top - PAD.bottom;

  const colW = chartW / sortedKeys.length;
  const barW = Math.max(10, Math.min(44, colW * 0.65));

  const yTick = maxTotal <= 4 ? 1 : maxTotal <= 10 ? 2 : maxTotal <= 20 ? 5 : 10;
  const yTicks = [];
  for (let v = 0; v <= maxTotal; v += yTick) yTicks.push(v);
  if (yTicks[yTicks.length-1] < maxTotal) yTicks.push(maxTotal);

  function handleMouseMove(e, key, cat) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, key, cat, rows: buckets[key][cat] || [] });
  }

  function handleClick(key, cat) {
    if (!onSegmentClick) return;
    const rows = cat ? (buckets[key][cat] || []) : Object.values(buckets[key]).flat();
    const label = cat ? `${bucketLabelFn(key)} · ${cat}` : `All cancellations in ${bucketLabelFn(key)}`;
    onSegmentClick(rows, label);
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af' }}>Cancellation Trend</div>
        {groupNote && <div style={{ fontSize: 11, color: '#9ca3af' }}>{groupNote}</div>}
      </div>

      <div ref={containerRef} style={{ position: 'relative' }}>
        {/* Tooltip */}
        {tooltip && (
          <div style={{
            position: 'absolute',
            left: tooltip.x + 14,
            top: Math.max(4, tooltip.y - 90),
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '10px 13px',
            fontSize: 12,
            color: '#f1f5f9',
            maxWidth: 240,
            pointerEvents: 'none',
            zIndex: 100,
            boxShadow: '0 4px 18px rgba(0,0,0,0.4)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 2, color: CATEGORY_COLORS[tooltip.cat]?.color || '#6366f1' }}>
              {tooltip.cat}
            </div>
            <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 7 }}>
              {bucketLabelFn(tooltip.key)} &middot; {tooltip.rows.length} cancellation{tooltip.rows.length !== 1 ? 's' : ''}
            </div>
            {tooltip.rows.slice(0, 5).map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: '#e2e8f0', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 210 }}>
                · {r.accountName || r.matchedOrg || r.customerEmail || 'Unknown'}
              </div>
            ))}
            {tooltip.rows.length > 5 && (
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>+{tooltip.rows.length - 5} more</div>
            )}
            <div style={{ fontSize: 10, color: '#6366f1', fontWeight: 600, marginTop: 7 }}>Click to filter ↓</div>
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <svg
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            style={{ width: '100%', minWidth: Math.max(340, sortedKeys.length * 52), display: 'block' }}
            onMouseLeave={() => setTooltip(null)}
          >
            {/* Y axis label */}
            <text
              transform={`translate(11, ${PAD.top + chartH / 2}) rotate(-90)`}
              textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="0.07em" fill="#9ca3af"
            >CANCELLATIONS</text>

            {/* Grid lines + Y tick labels */}
            {yTicks.map(tick => {
              const y = PAD.top + chartH - (tick / maxTotal) * chartH;
              return (
                <g key={tick}>
                  <line x1={PAD.left} x2={PAD.left + chartW} y1={y} y2={y}
                    stroke="rgba(156,163,175,0.15)" strokeWidth="1" strokeDasharray={tick === 0 ? '' : '3 3'} />
                  <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#9ca3af">{tick}</text>
                </g>
              );
            })}

            {/* X axis label */}
            <text
              x={PAD.left + chartW / 2} y={SVG_H - 3}
              textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="0.07em" fill="#9ca3af"
            >{xAxisLabel}</text>

            {/* Bars */}
            {sortedKeys.map((key, i) => {
              const cx = PAD.left + i * colW + colW / 2;
              const x = cx - barW / 2;
              let yOffset = 0;
              const total = totals[i];

              return (
                <g key={key} style={{ cursor: 'pointer' }} onClick={() => handleClick(key, null)}>
                  {catOrder.filter(cat => buckets[key][cat]).map(cat => {
                    const count = buckets[key][cat].length;
                    const segH = Math.max(2, (count / maxTotal) * chartH);
                    const sy = PAD.top + chartH - yOffset - segH;
                    const isTop = yOffset + segH >= (total / maxTotal) * chartH * 0.99;
                    yOffset += segH;
                    const col = CATEGORY_COLORS[cat]?.color || '#6366f1';
                    return (
                      <rect
                        key={cat} x={x} y={sy} width={barW} height={segH}
                        fill={col} opacity="0.82"
                        rx={isTop ? Math.min(4, barW/4) : 0}
                        ry={isTop ? Math.min(4, barW/4) : 0}
                        onMouseMove={e => { e.stopPropagation(); handleMouseMove(e, key, cat); }}
                        onMouseLeave={() => setTooltip(null)}
                        onClick={e => { e.stopPropagation(); handleClick(key, cat); }}
                        style={{ cursor: 'pointer' }}
                      />
                    );
                  })}
                  {/* Total label */}
                  {total > 0 && (
                    <text x={cx} y={PAD.top + chartH - (total/maxTotal)*chartH - 5}
                      textAnchor="middle" fontSize="11" fontWeight="700" fill="#9ca3af">{total}</text>
                  )}
                  {/* X tick label */}
                  <text x={cx} y={SVG_H - 18} textAnchor="middle" fontSize="10" fill="#9ca3af">{bucketLabelFn(key)}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10 }}>
        {catOrder.map(cat => (
          <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 9, height: 9, borderRadius: 2, background: CATEGORY_COLORS[cat]?.color || '#6366f1', flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#6b7280' }}>{cat}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LOOKBACK_OPTIONS = [
  { value: '',    label: 'All time' },
  { value: '30',  label: 'Last 30 days' },
  { value: '90',  label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last 12 months' },
  { value: '730', label: 'Last 2 years' },
];

function LookbackSelect({ value, onChange }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ minWidth: 140 }}>
      {LOOKBACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function exportCsv(results) {
  const headers = ['Account Name', 'Email Domain', 'Matched Org', 'Match Confidence', 'Match Type', 'Category', 'Competitor / AI Name', 'Confidence', 'Summary', 'Reasoning', 'Est. Exit Date', 'Ticket IDs', 'Ticket Subjects', 'Ticket Dates', 'Analysis Method', 'Status'];
  const needsCompetitor = r => r.category === 'Went to Competitor' || r.category === 'Switched to AI Service';
  const rows = results.map(r => [
    r.accountName, r.emailDomain, r.matchedOrg, r.matchConfidence, r.matchType,
    r.category, needsCompetitor(r) ? (r.competitorName || 'Unknown') : (r.competitorName || ''),
    r.confidence, r.summary, r.reasoning,
    r.estimatedCancellationDate || '',
    (r.supportingTicketIds || []).join('; '),
    (r.ticketSubjects || []).join('; '),
    (r.ticketDates || []).join('; '),
    r.analysisMethod || 'ai',
    r.status,
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'farewell-report.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SummaryCell({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const isLong = text.length > 120;
  return (
    <div>
      <div style={!isLong || expanded ? {} : {
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        maxWidth: 320,
      }}>
        {text}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--accent, #6366f1)', marginTop: 2 }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
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
      <td style={{ padding: '10px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
        {r.estimatedCancellationDate ? (
          <div>
            <div style={{ color: 'var(--text)' }}>
              {new Date(r.estimatedCancellationDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
            {r.exitDateSource === 'last_ticket' && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>last ticket</div>
            )}
          </div>
        ) : <span style={{ color: 'var(--muted)' }}>—</span>}
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

function SingleResult({ r, onClear }) {
  const zdSubdomain = r.zdSubdomain || '';
  const needsCompetitor = r.category === 'Went to Competitor' || r.category === 'Switched to AI Service';
  const usedKeywords = r.analysisMethod === 'keywords';
  const { csat } = r;
  const csatColor = !csat || csat.pct === null ? '#6b7280'
    : csat.pct >= 80 ? '#15803d'
    : csat.pct >= 60 ? '#b45309'
    : '#dc2626';

  return (
    <div className="card" style={{ marginTop: 16, position: 'relative' }}>
      <button onClick={onClear} style={{ position: 'absolute', top: 10, right: 12, background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', lineHeight: 1 }} title="Clear">×</button>

      {/* Header */}
      <div style={{ marginBottom: 14, paddingRight: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
          {r.matchedOrg || r.accountName || r.customerEmail || '—'}
        </div>
        {r.matchedOrg && r.accountName && r.matchedOrg !== r.accountName && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Searched: {r.accountName}</div>
        )}
      </div>

      {r.status === 'no_match' && (
        <div style={{ fontSize: 13, color: '#b45309' }}>No Zendesk user found. Try a different name or email address.</div>
      )}
      {r.status === 'error' && (
        <div style={{ fontSize: 13, color: '#dc2626' }}>{r.error}</div>
      )}

      {r.status === 'done' && r.category && (
        <>
          {/* Category + confidence */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <Badge label={r.category} colors={CATEGORY_COLORS} />
            {needsCompetitor && (
              <span style={{ fontSize: 12, fontWeight: 600, color: r.competitorName ? 'var(--text)' : 'var(--muted)' }}>
                {r.competitorName || 'Unknown'}
              </span>
            )}
            {r.confidence && <Badge label={r.confidence} colors={CONFIDENCE_COLORS} />}
            {usedKeywords && <span style={{ fontSize: 10, fontWeight: 600, color: '#b45309', letterSpacing: '0.03em' }}>KEYWORD MATCH</span>}
          </div>

          {r.summary && (
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 10 }}>{r.summary}</div>
          )}
          {r.reasoning && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              <strong>Signals: </strong>{r.reasoning}
            </div>
          )}
          {r.supportingTicketIds?.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              <strong style={{ color: 'var(--muted)' }}>Tickets: </strong>
              <TicketLinks ids={r.supportingTicketIds} subjects={r.ticketSubjects} zdSubdomain={zdSubdomain} />
            </div>
          )}

          {/* Account Pulse / CSAT */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 10 }}>Account Pulse</div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {/* Exit date */}
              {r.estimatedCancellationDate && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
                    {new Date(r.estimatedCancellationDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {r.exitDateSource === 'last_ticket' ? 'last ticket on file' : 'est. exit date'}
                  </div>
                </div>
              )}
              {/* Ticket count */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{r.ticketCount ?? r.ticketSubjects?.length ?? 0}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>tickets found</div>
              </div>

              {/* CSAT */}
              {csat && csat.total > 0 ? (
                <>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: csatColor }}>{csat.pct}%</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>satisfaction</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{csat.total}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>ratings</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {csat.good > 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'rgba(34,197,94,0.12)', color: '#15803d' }}>{csat.good} good</span>}
                    {csat.bad > 0  && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'rgba(239,68,68,0.12)',  color: '#dc2626' }}>{csat.bad} bad</span>}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>No satisfaction ratings on record</div>
              )}
            </div>

            {/* Last rating comment */}
            {csat?.lastComment && (
              <div style={{ marginTop: 10, fontSize: 12, fontStyle: 'italic', color: 'var(--muted)', borderLeft: '3px solid var(--border, rgba(0,0,0,0.1))', paddingLeft: 10 }}>
                "{csat.lastComment}"
                {csat.lastDate && <span style={{ fontStyle: 'normal', marginLeft: 6, opacity: 0.6 }}>— {csat.lastDate}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ZendeskAuditor() {
  const [view, setView] = useState('upload');      // 'upload' | 'running' | 'results'
  const [lookupMode, setLookupMode] = useState('single'); // 'upload' | 'single'
  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const readerRef = useRef(null);
  const [lookbackDays, setLookbackDays] = useState('');  // '' = all time
  const [singleForm, setSingleForm] = useState({ accountName: '', customerEmail: '', notes: '' });
  const [singleResult, setSingleResult] = useState(null);
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState('');
  const [chartFilter, setChartFilter] = useState(null); // { rows, label }

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
    if (lookbackDays) formData.append('lookbackDays', lookbackDays);

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
    setChartFilter(null);
  }, [handleCancel]);

  async function handleSingleLookup(e) {
    e.preventDefault();
    setSingleError('');
    setSingleResult(null);
    if (!singleForm.accountName.trim() && !singleForm.customerEmail.trim()) {
      setSingleError('Enter an account name or email address');
      return;
    }
    setSingleLoading(true);
    try {
      const resp = await api.post('/api/zendesk-auditor/lookup', { ...singleForm, lookbackDays: lookbackDays || undefined });
      setSingleResult(resp.data);
    } catch (err) {
      setSingleError(err.response?.data?.error || err.message);
    } finally {
      setSingleLoading(false);
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // ── Upload view ─────────────────────────────────────────────────────────────
  if (view === 'upload') {
    return (
      <div>
        <div className="page-header">
          <div>
            <div className="page-title">The Farewell Report</div>
            <div className="page-sub">Zendesk AI · Analyze customer exit reasons from ticket history</div>
          </div>
        </div>

        {/* ── Mode selector cards ──────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, maxWidth: 680, margin: '0 auto 24px' }}>
          {[
            { id: 'upload', label: 'Bulk Import', desc: 'Upload a CSV or Excel file to analyze an entire cancellation list at once' },
            { id: 'single', label: 'Single Lookup', desc: 'Search one customer by name or email — includes CSAT and full account pulse' },
          ].map(({ id, label, desc }) => {
            const active = lookupMode === id;
            return (
              <button
                key={id}
                onClick={() => setLookupMode(id)}
                style={{
                  textAlign: 'left', padding: '18px 20px', borderRadius: 12, cursor: 'pointer',
                  border: active ? '2px solid var(--accent, #6366f1)' : '2px solid var(--border, rgba(0,0,0,0.1))',
                  background: active ? 'rgba(99,102,241,0.07)' : 'var(--card-bg, var(--surface, transparent))',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: active ? 'var(--accent, #6366f1)' : 'var(--text)', marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</div>
              </button>
            );
          })}
        </div>

        {/* ── Single Lookup Form ─────────────────────────────────────────────── */}
        {lookupMode === 'single' && (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <div className="card">
              {singleError && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 14 }}>
                  {singleError}
                </div>
              )}
              <form onSubmit={handleSingleLookup}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div className="form-row">
                    <label className="field-label">Account / Firm Name</label>
                    <input
                      type="text"
                      autoFocus
                      value={singleForm.accountName}
                      onChange={e => setSingleForm(f => ({ ...f, accountName: e.target.value }))}
                      placeholder="Smith & Associates Law"
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label">Customer Email</label>
                    <input
                      type="email"
                      value={singleForm.customerEmail}
                      onChange={e => setSingleForm(f => ({ ...f, customerEmail: e.target.value }))}
                      placeholder="john@smithlaw.com"
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div className="form-row">
                    <label className="field-label">Notes / Ticket IDs <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
                    <input
                      type="text"
                      value={singleForm.notes}
                      onChange={e => setSingleForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Ticket #314123 or cancellation context"
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label">Look back</label>
                    <LookbackSelect value={lookbackDays} onChange={setLookbackDays} />
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={singleLoading || (!singleForm.accountName.trim() && !singleForm.customerEmail.trim())}
                >
                  {singleLoading ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10" />
                      </svg>
                      Analyzing…
                    </span>
                  ) : 'Analyze'}
                </button>
              </form>
            </div>
            {singleResult && <SingleResult r={singleResult} onClear={() => setSingleResult(null)} />}
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* ── Upload Card ────────────────────────────────────────────────────── */}
        {lookupMode === 'upload' && (
        <div className="card" style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ marginBottom: 20 }}>
            <div className="field-label">Upload Customer List</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              CSV or Excel file with columns: Account Name, Email Domain, Customer Email, and/or Org Name
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleRunAudit} disabled={!file}>
              Run Audit
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="field-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Look back</label>
              <LookbackSelect value={lookbackDays} onChange={setLookbackDays} />
            </div>
          </div>
        </div>
        )}
      </div>
    );
  }

  // ── Running + Results view (unified — results appear live as they come in) ───
  const doneCount    = results.filter(r => r.status === 'done').length;
  const noMatchCount = results.filter(r => r.status === 'no_match').length;
  const errorCount   = results.filter(r => r.status === 'error').length;
  const keywordCount = results.filter(r => r.analysisMethod === 'keywords').length;
  const isRunning    = view === 'running';

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">The Farewell Report</div>
          <div className="page-sub">
            {isRunning
              ? `Analyzing… ${progress.done} of ${progress.total} complete`
              : `${results.length} customers · ${doneCount} analyzed · ${noMatchCount} no match · ${errorCount} error${lookbackDays ? ` · ${LOOKBACK_OPTIONS.find(o => o.value === lookbackDays)?.label || ''}` : ''}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {results.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => exportCsv(results)}>
              Export CSV
            </button>
          )}
          {isRunning
            ? <button className="btn btn-ghost btn-sm" onClick={handleCancel}>Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={handleReset}>New Audit</button>
          }
        </div>
      </div>

      {/* Slim progress bar — only shown while running */}
      {isRunning && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ background: 'var(--border, rgba(0,0,0,0.1))', borderRadius: 99, height: 5, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 99,
              background: 'var(--accent, #6366f1)',
              width: `${pct}%`,
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      )}

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

      {/* Trend chart — shown once the audit is done */}
      {!isRunning && doneCount > 0 && (
        <TrendChart
          results={results}
          onSegmentClick={(rows, label) => setChartFilter({ rows, label })}
        />
      )}

      {/* Category totals — shown once the audit is done */}
      {!isRunning && doneCount > 0 && (() => {
        const catCounts = {};
        for (const r of results) {
          if (r.status === 'done' && r.category) catCounts[r.category] = (catCounts[r.category] || 0) + 1;
        }
        const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
        const total = doneCount + noMatchCount;
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 12 }}>Results Summary</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {sorted.map(([cat, count]) => (
                <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, background: 'var(--surface2, rgba(0,0,0,0.03))' }}>
                  <Badge label={cat} colors={CATEGORY_COLORS} />
                  <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{count}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>{Math.round(count / total * 100)}%</span>
                </div>
              ))}
              {noMatchCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, background: 'var(--surface2, rgba(0,0,0,0.03))' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', padding: '2px 8px', borderRadius: 20, background: 'rgba(234,179,8,0.12)' }}>No Match</span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{noMatchCount}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>{Math.round(noMatchCount / total * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Chart filter banner */}
      {chartFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderRadius: 8, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.22)', marginBottom: 12, fontSize: 13 }}>
          <span style={{ flex: 1, color: 'var(--text)' }}>
            <strong style={{ color: 'var(--accent, #6366f1)' }}>Filtered:</strong> {chartFilter.label} &middot; {chartFilter.rows.length} result{chartFilter.rows.length !== 1 ? 's' : ''}
          </span>
          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => setChartFilter(null)}>
            × Clear filter
          </button>
        </div>
      )}

      {(() => {
        const displayResults = chartFilter ? chartFilter.rows : results;
        return displayResults.length === 0 && !isRunning ? (
          <div className="card" style={{ textAlign: 'center', padding: '60px 40px', color: 'var(--muted)' }}>
            {chartFilter ? 'No results match this filter.' : 'No results to display.'}
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2, rgba(0,0,0,0.03))' }}>
                    {['Customer', 'Matched Org', 'Category', 'Confidence', 'Summary', 'Tickets', 'Exit Date', 'Status'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayResults.map((r, i) => <ResultRow key={i} r={r} index={i} />)}
                  {isRunning && !chartFilter && progress.done < progress.total && <SpinnerRow index={progress.done} />}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
