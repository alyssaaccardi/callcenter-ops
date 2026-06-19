import React from 'react';

export default function ZendeskAuditor() {
  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Cancellation Auditor</div>
          <div className="page-sub">Zendesk AI · Analyze cancellation reasons from ticket history</div>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center', padding: '60px 40px' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔎</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
          Coming Soon
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
          Upload a spreadsheet of customer accounts and this tool will automatically
          review Zendesk ticket history to identify and categorize cancellation reasons
          using AI analysis.
        </div>
        <div style={{ marginTop: 24, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          {[
            'Spreadsheet Upload',
            'Customer Matching',
            'Ticket Analysis',
            'AI Summarization',
            'CSV Export',
          ].map(f => (
            <span key={f} style={{
              fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
              color: '#6366f1',
            }}>{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
