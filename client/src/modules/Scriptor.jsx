import React, { useState, useRef, useCallback, useEffect } from 'react';
import api from '../api';

// The Scribe — drop a handwritten note (phone photo or PDF) and get clean,
// typed text back. Accuracy improves over time via the glossary + corrections.

const ACCEPT = '.jpg,.jpeg,.png,.heic,.heif,.webp,.pdf,image/*,application/pdf';

function isSupported(f) {
  return /^image\//.test(f.type) || f.type === 'application/pdf' ||
    /\.(jpe?g|png|heic|heif|webp|pdf)$/i.test(f.name);
}

export default function Scriptor() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);     // { text, provider }
  const [text, setText] = useState('');            // editable transcription
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);

  // Glossary panel
  const [showGlossary, setShowGlossary] = useState(false);
  const [glossary, setGlossary] = useState('');
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  const [glossarySaved, setGlossarySaved] = useState(false);
  const [corrections, setCorrections] = useState([]);

  // Correction form
  const [corr, setCorr] = useState({ before: '', after: '' });

  useEffect(() => {
    api.get('/api/scriptor/glossary')
      .then(r => { setGlossary(r.data.glossary || ''); setCorrections(r.data.corrections || []); })
      .catch(() => {});
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const handleFile = useCallback((f) => {
    if (!f) return;
    if (!isSupported(f)) { setError('Please upload an image (JPEG/PNG/HEIC) or a PDF.'); return; }
    setError(''); setResult(null); setText('');
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f.type === 'application/pdf' ? null : URL.createObjectURL(f));
  }, [previewUrl]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  async function transcribe() {
    if (!file) { setError('Choose a photo or PDF first.'); return; }
    setLoading(true); setError(''); setResult(null); setText('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/api/scriptor/transcribe', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      setText(data.text || '');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setFile(null); setResult(null); setText(''); setError('');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function copyText() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  function downloadTxt() {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcription-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const [docxLoading, setDocxLoading] = useState(false);
  async function downloadDocx() {
    setDocxLoading(true); setError('');
    try {
      const title = file?.name ? file.name.replace(/\.[^.]+$/, '') : 'Transcription';
      const resp = await api.post('/api/scriptor/docx', { text, title }, { responseType: 'blob' });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[^\w\-]+/g, '_') || 'transcription'}.docx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not build the Word document.');
    } finally {
      setDocxLoading(false);
    }
  }

  async function saveGlossary() {
    try {
      const { data } = await api.put('/api/scriptor/glossary', { glossary });
      setGlossary(data.glossary || '');
      setGlossaryDirty(false);
      setGlossarySaved(true); setTimeout(() => setGlossarySaved(false), 1500);
    } catch (e) { setError(e.response?.data?.error || e.message); }
  }

  async function addCorrection() {
    if (!corr.before.trim() || !corr.after.trim()) return;
    try {
      const { data } = await api.post('/api/scriptor/correction', corr);
      setCorrections(data.corrections || []);
      setCorr({ before: '', after: '' });
    } catch (e) { setError(e.response?.data?.error || e.message); }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src="/rob-osetta-stone.png"
            alt="The Rob-osetta Stone"
            style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border, rgba(0,0,0,0.1))' }}
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>The Rob-osetta Stone</h1>
            <p style={{ color: 'var(--muted)', margin: '4px 0 0', fontSize: 13 }}>
              Decoding Rob's handwriting since 2014. Drop a photo or PDF and get clean, typed text back.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowGlossary(v => !v)}
          className="btn"
          style={{
            padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border, rgba(0,0,0,0.12))', background: showGlossary ? 'var(--accent, #6366f1)' : 'transparent',
            color: showGlossary ? '#fff' : 'var(--text)', whiteSpace: 'nowrap',
          }}
        >
          📖 Glossary{corrections.length ? ` · ${corrections.length}` : ''}
        </button>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#b91c1c', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Glossary panel */}
      {showGlossary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>
            Handwriting glossary
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
            Notes about the writer's quirks, abbreviations, and recurring names. This is fed to the reader on every transcription — the more you add, the more accurate it gets. This replaces "training a model."
          </p>
          <textarea
            value={glossary}
            onChange={e => { setGlossary(e.target.value); setGlossaryDirty(true); }}
            rows={7}
            style={{ width: '100%', fontSize: 13, fontFamily: 'inherit', padding: 10, borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.15))', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button onClick={saveGlossary} disabled={!glossaryDirty} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: glossaryDirty ? 'var(--accent, #6366f1)' : 'rgba(107,114,128,0.25)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: glossaryDirty ? 'pointer' : 'default' }}>
              Save glossary
            </button>
            {glossarySaved && <span style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>Saved ✓</span>}
          </div>

          {corrections.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 6 }}>
                Learned corrections ({corrections.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {corrections.slice().reverse().slice(0, 30).map((c, i) => (
                  <span key={i} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(99,102,241,0.1)', color: 'var(--text)' }}>
                    <s style={{ color: '#dc2626' }}>{c.before}</s> → <strong>{c.after}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: result || loading ? '1fr 1fr' : '1fr', gap: 16, alignItems: 'start' }}>
        {/* Left: upload / preview */}
        <div>
          {!file ? (
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? 'var(--accent, #6366f1)' : 'var(--border, rgba(0,0,0,0.2))'}`,
                borderRadius: 12, padding: '48px 24px', textAlign: 'center', cursor: 'pointer',
                background: dragOver ? 'rgba(99,102,241,0.06)' : 'transparent', transition: 'all 0.15s',
              }}
            >
              <img
                src="/rob-osetta-stone.png"
                alt="The Rob-osetta Stone"
                style={{ width: 84, height: 84, borderRadius: 12, objectFit: 'cover', marginBottom: 12, filter: dragOver ? 'none' : 'grayscale(0.25) opacity(0.9)', transition: 'filter 0.15s' }}
                onError={e => { e.target.style.display = 'none'; }}
              />
              <div style={{ fontSize: 15, fontWeight: 600 }}>Drop Rob's chicken scratch here 🐔</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>or click to browse · JPEG, PNG, HEIC, or PDF · up to 20MB</div>
              <input ref={fileInputRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            </div>
          ) : (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                <button onClick={reset} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', lineHeight: 1 }} title="Remove">×</button>
              </div>
              {previewUrl ? (
                <img src={previewUrl} alt="preview" style={{ width: '100%', maxHeight: 420, objectFit: 'contain', borderRadius: 8, background: 'rgba(0,0,0,0.03)' }} />
              ) : (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>📄 PDF ready to transcribe</div>
              )}
              <button
                onClick={transcribe}
                disabled={loading}
                style={{ width: '100%', marginTop: 12, padding: '11px', borderRadius: 8, border: 'none', background: loading ? 'rgba(107,114,128,0.4)' : 'var(--accent, #6366f1)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: loading ? 'default' : 'pointer' }}
              >
                {loading ? 'Reading the handwriting…' : 'Transcribe'}
              </button>
            </div>
          )}
        </div>

        {/* Right: result */}
        {(loading || result) && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
                Transcription
              </div>
              {result?.provider && <span style={{ fontSize: 10, color: 'var(--muted)' }}>{result.provider}</span>}
            </div>

            {loading ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
                <span className="spinner" style={{ marginRight: 8 }} /> Reading…
              </div>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={16}
                  style={{ width: '100%', fontSize: 14, lineHeight: 1.6, fontFamily: 'inherit', padding: 12, borderRadius: 8, border: '1px solid var(--border, rgba(0,0,0,0.15))', resize: 'vertical', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button onClick={copyText} style={btnStyle}>{copied ? 'Copied ✓' : 'Copy'}</button>
                  <button onClick={downloadTxt} style={btnStyle}>Download .txt</button>
                  <button onClick={downloadDocx} disabled={docxLoading} style={btnStyle}>{docxLoading ? 'Building…' : 'Download .docx'}</button>
                </div>

                {/* Teach a correction */}
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border, rgba(0,0,0,0.08))' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 8 }}>
                    Fix a misread word (teaches the glossary)
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input value={corr.before} onChange={e => setCorr({ ...corr, before: e.target.value })} placeholder="it read…" style={inputStyle} />
                    <span style={{ color: 'var(--muted)' }}>→</span>
                    <input value={corr.after} onChange={e => setCorr({ ...corr, after: e.target.value })} placeholder="should be…" style={inputStyle} />
                    <button onClick={addCorrection} style={{ ...btnStyle, background: 'var(--accent, #6366f1)', color: '#fff', border: 'none' }}>Save</button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ textAlign: 'center', marginTop: 28, fontSize: 10, letterSpacing: '0.04em', color: 'var(--muted)', opacity: 0.55 }}>
        powered by Gallicch Vision™
      </div>
    </div>
  );
}

const btnStyle = {
  padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: '1px solid var(--border, rgba(0,0,0,0.15))', background: 'transparent', color: 'var(--text)',
};
const inputStyle = {
  flex: '1 1 120px', minWidth: 100, fontSize: 13, padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--border, rgba(0,0,0,0.15))', boxSizing: 'border-box',
};
