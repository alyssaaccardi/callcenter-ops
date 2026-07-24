import React, { useState, useRef, useCallback, useEffect } from 'react';
import api from '../api';

// The Rob-osetta Stone — drop a handwritten note (photo or PDF) and get
// clean, typed text back. Accuracy improves via the glossary + corrections.

const ACCEPT = '.jpg,.jpeg,.png,.heic,.heif,.webp,.pdf,image/*,application/pdf';

// Design tokens — kept local so the /rob shell can't be pulled into the
// app's dark-mode variables. Everything reads cleanly against white.
const T = {
  bg:            '#ffffff',
  surface:       '#ffffff',
  surfaceAlt:    '#fafaf9',
  border:        '#e7e5e4',
  borderStrong:  '#d6d3d1',
  text:          '#0c0a09',
  textMuted:     '#78716c',
  textFaint:     '#a8a29e',
  accent:        '#0c0a09',
  accentInk:     '#ffffff',
  danger:        '#b91c1c',
  dangerBg:      '#fef2f2',
  dangerBorder:  '#fecaca',
  success:       '#15803d',
  radius:        12,
  radiusSm:      8,
  radiusLg:      16,
};

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
  const [result, setResult] = useState(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);

  const [showGlossary, setShowGlossary] = useState(false);
  const [glossary, setGlossary] = useState('');
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  const [glossarySaved, setGlossarySaved] = useState(false);
  const [corrections, setCorrections] = useState([]);
  const [corr, setCorr] = useState({ before: '', after: '' });
  const [docxLoading, setDocxLoading] = useState(false);

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
    <div style={{ maxWidth: 1080, margin: '0 auto', color: T.text }}>
      {/* Header — brand mark + glossary toggle */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 20, padding: '8px 4px 28px', borderBottom: `1px solid ${T.border}`, marginBottom: 32,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <img
            src="/rob-osetta-stone.png"
            alt=""
            style={{ width: 56, height: 56, borderRadius: T.radiusSm, objectFit: 'cover', flexShrink: 0 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>
              The Rob-osetta Stone
            </h1>
            <p style={{ color: T.textMuted, margin: '3px 0 0', fontSize: 14, fontWeight: 400 }}>
              Decoding Rob's handwriting since 2014.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowGlossary(v => !v)}
          style={{
            padding: '9px 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, cursor: 'pointer',
            border: `1px solid ${showGlossary ? T.accent : T.border}`,
            background: showGlossary ? T.accent : T.surface,
            color: showGlossary ? T.accentInk : T.text, whiteSpace: 'nowrap',
            transition: 'all 120ms ease',
          }}
        >
          Glossary{corrections.length ? ` · ${corrections.length}` : ''}
        </button>
      </header>

      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: T.radiusSm,
          background: T.dangerBg, border: `1px solid ${T.dangerBorder}`, color: T.danger,
          fontSize: 13, marginBottom: 20,
        }}>
          {error}
        </div>
      )}

      {/* Glossary panel */}
      {showGlossary && (
        <section style={{
          background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radius,
          padding: 20, marginBottom: 24,
        }}>
          <div style={sectionLabel}>Handwriting glossary</div>
          <p style={{ fontSize: 13, color: T.textMuted, margin: '0 0 12px', lineHeight: 1.5 }}>
            Notes about the writer's quirks, abbreviations, and recurring names. This is fed to the reader on every transcription — the more you add, the more accurate it gets.
          </p>
          <textarea
            value={glossary}
            onChange={e => { setGlossary(e.target.value); setGlossaryDirty(true); }}
            rows={7}
            style={{ ...textareaStyle, background: T.surface }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <button
              onClick={saveGlossary}
              disabled={!glossaryDirty}
              style={{
                ...primaryBtn,
                opacity: glossaryDirty ? 1 : 0.4,
                cursor: glossaryDirty ? 'pointer' : 'default',
              }}
            >
              Save glossary
            </button>
            {glossarySaved && <span style={{ fontSize: 13, color: T.success, fontWeight: 500 }}>Saved</span>}
          </div>

          {corrections.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
              <div style={{ ...sectionLabel, marginBottom: 10 }}>
                Learned corrections · {corrections.length}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {corrections.slice().reverse().slice(0, 30).map((c, i) => (
                  <span key={i} style={{
                    fontSize: 12, padding: '4px 10px', borderRadius: 999,
                    background: T.surface, border: `1px solid ${T.border}`, color: T.text,
                  }}>
                    <s style={{ color: T.textFaint }}>{c.before}</s>
                    <span style={{ color: T.textFaint, margin: '0 6px' }}>→</span>
                    <strong style={{ fontWeight: 600 }}>{c.after}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: result || loading ? '1fr 1fr' : '1fr',
        gap: 24, alignItems: 'start',
      }}>
        {/* Upload / preview */}
        <div>
          {!file ? (
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `1.5px dashed ${dragOver ? T.accent : T.borderStrong}`,
                borderRadius: T.radiusLg,
                padding: '72px 32px', textAlign: 'center', cursor: 'pointer',
                background: dragOver ? T.surfaceAlt : T.surface,
                transition: 'all 150ms ease',
              }}
            >
              <img
                src="/rob-osetta-stone.png"
                alt=""
                style={{
                  width: 128, height: 128, borderRadius: T.radius, objectFit: 'cover', marginBottom: 20,
                  opacity: dragOver ? 1 : 0.92,
                  transition: 'all 150ms ease',
                }}
                onError={e => { e.target.style.display = 'none'; }}
              />
              <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
                Drop Rob's chicken scratch here
              </div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>
                or click to browse · JPEG, PNG, HEIC, or PDF · up to 20MB
              </div>
              <input ref={fileInputRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            </div>
          ) : (
            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text }}>
                  {file.name}
                </div>
                <button
                  onClick={reset}
                  style={{
                    background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 999,
                    width: 26, height: 26, cursor: 'pointer', fontSize: 14, color: T.textMuted, lineHeight: 1, padding: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                  title="Remove"
                >×</button>
              </div>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="preview"
                  style={{
                    width: '100%', maxHeight: 440, objectFit: 'contain',
                    borderRadius: T.radiusSm, background: T.surfaceAlt,
                    border: `1px solid ${T.border}`,
                  }}
                />
              ) : (
                <div style={{
                  padding: '60px 0', textAlign: 'center', color: T.textMuted, fontSize: 14,
                  background: T.surfaceAlt, borderRadius: T.radiusSm, border: `1px solid ${T.border}`,
                }}>
                  PDF ready to transcribe
                </div>
              )}
              <button
                onClick={transcribe}
                disabled={loading}
                style={{
                  ...primaryBtn,
                  width: '100%', marginTop: 14, padding: '13px', fontSize: 14,
                  opacity: loading ? 0.5 : 1, cursor: loading ? 'default' : 'pointer',
                }}
              >
                {loading ? 'Reading the handwriting…' : 'Transcribe'}
              </button>
            </div>
          )}
        </div>

        {/* Result */}
        {(loading || result) && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={sectionLabel}>Transcription</div>
              {result?.provider && (
                <span style={{ fontSize: 11, color: T.textFaint, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                  {result.provider}
                </span>
              )}
            </div>

            {loading ? (
              <div style={{ padding: '80px 0', textAlign: 'center', color: T.textMuted, fontSize: 14 }}>
                <Spinner /> <span style={{ marginLeft: 10 }}>Reading…</span>
              </div>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={16}
                  style={{ ...textareaStyle, fontSize: 14, lineHeight: 1.65 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button onClick={copyText} style={ghostBtn}>{copied ? 'Copied' : 'Copy'}</button>
                  <button onClick={downloadTxt} style={ghostBtn}>Download .txt</button>
                  <button onClick={downloadDocx} disabled={docxLoading} style={ghostBtn}>
                    {docxLoading ? 'Building…' : 'Download .docx'}
                  </button>
                </div>

                <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
                  <div style={{ ...sectionLabel, marginBottom: 10 }}>
                    Fix a misread word
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      value={corr.before}
                      onChange={e => setCorr({ ...corr, before: e.target.value })}
                      placeholder="it read…"
                      style={inputStyle}
                    />
                    <span style={{ color: T.textFaint, fontSize: 14 }}>→</span>
                    <input
                      value={corr.after}
                      onChange={e => setCorr({ ...corr, after: e.target.value })}
                      placeholder="should be…"
                      style={inputStyle}
                    />
                    <button onClick={addCorrection} style={primaryBtn}>Save</button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{
        textAlign: 'center', marginTop: 48, paddingTop: 20,
        fontSize: 11, letterSpacing: '0.06em', color: T.textFaint, textTransform: 'uppercase',
      }}>
        Powered by Gallicch Vision™
      </div>
    </div>
  );
}

// ─── Shared style objects ────────────────────────────────────────────────────
const cardStyle = {
  background: T.surface,
  border: `1px solid ${T.border}`,
  borderRadius: T.radius,
  padding: 20,
};

const sectionLabel = {
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em',
  color: T.textMuted,
};

const primaryBtn = {
  padding: '9px 18px', borderRadius: 999, fontSize: 13, fontWeight: 500,
  border: `1px solid ${T.accent}`, background: T.accent, color: T.accentInk,
  cursor: 'pointer', transition: 'opacity 120ms ease',
};

const ghostBtn = {
  padding: '8px 16px', borderRadius: 999, fontSize: 13, fontWeight: 500,
  border: `1px solid ${T.border}`, background: T.surface, color: T.text,
  cursor: 'pointer', transition: 'all 120ms ease',
};

const inputStyle = {
  flex: '1 1 140px', minWidth: 120, fontSize: 13,
  padding: '8px 12px', borderRadius: T.radiusSm,
  border: `1px solid ${T.border}`, background: T.surface, color: T.text,
  boxSizing: 'border-box', outline: 'none',
};

const textareaStyle = {
  width: '100%', fontSize: 13, fontFamily: 'inherit',
  padding: 12, borderRadius: T.radiusSm,
  border: `1px solid ${T.border}`, background: T.surface, color: T.text,
  resize: 'vertical', boxSizing: 'border-box', outline: 'none',
};

// Simple spinner (avoids depending on the app's global .spinner class)
function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block', width: 14, height: 14,
        border: `2px solid ${T.border}`, borderTopColor: T.accent,
        borderRadius: '50%', animation: 'rob-spin 700ms linear infinite',
        verticalAlign: 'middle',
      }}
    >
      <style>{`@keyframes rob-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
