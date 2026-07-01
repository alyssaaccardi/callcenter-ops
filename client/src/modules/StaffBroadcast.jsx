import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './StaffBroadcast.css';

// Public endpoint — no auth, sanitized payload (no updatedBy). The internal
// dashboard still uses /api/staff-broadcast (auth-required) for edit/delete.
const EMBED_URL = 'https://ops.answeringlegal.com/api/widget/staff-broadcast';

function buildEmbedCode() {
  return `<div id="al-bc"></div>
<style>
  #al-bc, #al-bc *, #al-bc *::before, #al-bc *::after { box-sizing: border-box; }
  #al-bc {
    font-family: "Helvetica Neue", Arial, system-ui, sans-serif;
    width: 100%; max-width: 520px; margin: 0 auto;
  }
  #al-bc .al-bc-shell {
    position: relative;
    background: radial-gradient(140% 120% at 50% -10%, #123163 0%, #0A183A 45%, #070F22 100%);
    border-radius: 22px;
    padding: 18px;
    box-shadow: 0 18px 40px rgba(0,0,0,.35);
    overflow: hidden;
  }
  #al-bc .al-bc-card {
    background: rgba(255,255,255,.07);
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 16px;
    overflow: hidden;
    text-align: left;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    animation: al-bc-rise .45s ease both;
  }
  #al-bc .al-bc-img { width: 100%; height: auto; max-height: 200px; object-fit: cover; display: block; }
  #al-bc .al-bc-in { padding: 18px 20px; }
  #al-bc .al-bc-eyebrow {
    font-size: 11px; font-weight: 800; letter-spacing: .14em;
    text-transform: uppercase; color: #5FE3B3; margin-bottom: 9px;
  }
  #al-bc .al-bc-title {
    font-size: 17px; font-weight: 800; color: #fff;
    line-height: 1.3; margin-bottom: 6px; letter-spacing: -.01em;
  }
  #al-bc .al-bc-body {
    font-size: 14px; line-height: 1.6; color: #9DB2D8;
    white-space: pre-wrap; word-wrap: break-word;
  }
  #al-bc .al-bc-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  #al-bc .al-bc-btn {
    display: inline-block; padding: 8px 16px; border-radius: 999px;
    text-decoration: none; font-size: 13px; font-weight: 700; line-height: 1;
    color: #06331F;
    background: linear-gradient(100deg, #FFDE86, #FFC53D);
    transition: filter .15s;
  }
  #al-bc .al-bc-btn:hover { filter: brightness(1.06); }
  #al-bc .al-bc-rest { background: rgba(255,255,255,.045); }
  #al-bc .al-bc-rest-in { display: flex; align-items: center; gap: 12px; padding: 14px 18px; }
  #al-bc .al-bc-dot {
    width: 9px; height: 9px; border-radius: 50%; flex: none;
    background: #5FE3B3;
    box-shadow: 0 0 0 4px rgba(95,227,179,.18);
    animation: al-bc-breath 2.4s ease-in-out infinite;
  }
  #al-bc .al-bc-rest-lbl {
    font-size: 11px; font-weight: 800; letter-spacing: .14em;
    text-transform: uppercase; color: #5FE3B3; margin-bottom: 2px;
  }
  #al-bc .al-bc-rest-txt { font-size: 13px; color: #9DB2D8; font-weight: 500; }
  @keyframes al-bc-breath { 0%,100%{opacity:.45} 50%{opacity:1} }
  @keyframes al-bc-rise { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:none} }
  @media (prefers-reduced-motion: reduce) {
    #al-bc *, #al-bc *::before, #al-bc *::after { animation: none !important; }
  }
</style>
<script>
(function(){
  var el = document.getElementById('al-bc');
  if (!el) return;
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function renderResting(){
    el.innerHTML =
      '<div class="al-bc-shell"><div class="al-bc-card al-bc-rest">' +
        '<div class="al-bc-rest-in">' +
          '<span class="al-bc-dot"></span>' +
          '<div>' +
            '<div class="al-bc-rest-lbl">from ops</div>' +
            '<div class="al-bc-rest-txt">all quiet — no updates right now</div>' +
          '</div>' +
        '</div>' +
      '</div></div>';
  }
  function render(d){
    if (!d || d.empty){ renderResting(); return; }
    var s = '<div class="al-bc-shell"><div class="al-bc-card">';
    if (d.imageUrl) s += '<img class="al-bc-img" src="' + esc(d.imageUrl) + '" alt="">';
    s += '<div class="al-bc-in">';
    s += '<div class="al-bc-eyebrow">● from ops</div>';
    if (d.title) s += '<div class="al-bc-title">' + esc(d.title) + '</div>';
    if (d.body)  s += '<div class="al-bc-body">' + esc(d.body) + '</div>';
    if (d.links && d.links.length){
      s += '<div class="al-bc-links">';
      d.links.forEach(function(l){
        s += '<a class="al-bc-btn" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label||l.url) + '</a>';
      });
      s += '</div>';
    }
    s += '</div></div></div>';
    el.innerHTML = s;
    var img = el.querySelector('.al-bc-img');
    if (img) img.onerror = function(){ this.style.display = 'none'; };
  }
  function load(){
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '${EMBED_URL}');
      x.onload = function(){ try { render(JSON.parse(x.responseText)); } catch(e){ renderResting(); } };
      x.onerror = function(){ renderResting(); };
      x.send();
    } catch(e){ renderResting(); }
  }
  renderResting();
  load();
  setInterval(load, 30000);
})();
<\/script>`;
}

export default function StaffBroadcast() {
  const { toast } = useApp();

  const [title, setTitle]       = useState('');
  const [body, setBody]         = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [links, setLinks]       = useState([{ label: '', url: '' }]);
  const [live, setLive]         = useState(null);
  const [saving, setSaving]     = useState(false);
  const [copied, setCopied]     = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    api.get('/api/staff-broadcast').then(r => {
      const d = r.data;
      if (d && !d.empty) {
        setTitle(d.title || '');
        setBody(d.body || '');
        setImageUrl(d.imageUrl || '');
        setLinks(d.links?.length ? [...d.links, { label: '', url: '' }] : [{ label: '', url: '' }]);
        setLive(d);
      }
    }).catch(() => {});
  }, []);

  function updateLink(i, field, val) {
    setLinks(prev => {
      const next = prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l);
      const last = next[next.length - 1];
      if (last.label || last.url) next.push({ label: '', url: '' });
      return next;
    });
  }

  function removeLink(i) {
    setLinks(prev => prev.length === 1 ? [{ label: '', url: '' }] : prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    const cleanLinks = links.filter(l => l.url.trim());
    if (!title.trim() && !body.trim() && !cleanLinks.length) {
      toast('Add a title, body, or at least one link', 'warn');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/api/staff-broadcast', { title, body, imageUrl, links: cleanLinks });
      setLive(data.data);
      toast('Broadcast saved and live on Wix', 'ok');
    } catch {
      toast('Failed to save broadcast', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    if (!window.confirm('Remove the current broadcast from the Wix site?')) return;
    try {
      await api.delete('/api/staff-broadcast');
      setTitle(''); setBody(''); setImageUrl(''); setLinks([{ label: '', url: '' }]); setLive(null);
      toast('Broadcast cleared', 'ok');
    } catch {
      toast('Failed to clear broadcast', 'error');
    }
  }

  function copyEmbed() {
    navigator.clipboard.writeText(buildEmbedCode()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const previewLinks = links.filter(l => l.url.trim());
  const hasContent   = title || body || previewLinks.length || (imageUrl && !imgError);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Staff Site</div>
          <div className="page-sub">Publish an announcement to the Answering Legal staff site homepage</div>
        </div>
        {live && (
          <div className="sb-live-badge">
            <span className="sb-live-dot" />
            Live on Wix
          </div>
        )}
      </div>

      <div className="grid-2">

        {/* ── Left: Editor ── */}
        <div className="card">
          <div className="card-title">Announcement</div>

          <label className="sb-label">Title</label>
          <input
            type="text"
            placeholder="e.g. Office closed Monday"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
          />

          <label className="sb-label">Body</label>
          <textarea
            placeholder="Details, context, instructions..."
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
          />

          <label className="sb-label">
            Image URL <span className="sb-label-hint">(optional — paste a direct image link)</span>
          </label>
          <input
            type="url"
            placeholder="https://example.com/photo.jpg"
            value={imageUrl}
            onChange={e => { setImageUrl(e.target.value); setImgError(false); }}
          />
          {imageUrl && !imgError && (
            <div className="sb-img-preview">
              <img
                src={imageUrl}
                alt="preview"
                onError={() => setImgError(true)}
              />
            </div>
          )}
          {imageUrl && imgError && (
            <div className="sb-img-error">Image URL didn't load — check the link</div>
          )}

          <label className="sb-label">
            Links <span className="sb-label-hint">(optional)</span>
          </label>
          <div className="sb-links-list">
            {links.map((l, i) => (
              <div className="sb-link-row" key={i}>
                <input
                  type="text"
                  placeholder="Button label"
                  value={l.label}
                  onChange={e => updateLink(i, 'label', e.target.value)}
                  style={{ flex: '0 0 140px' }}
                />
                <input
                  type="url"
                  placeholder="https://..."
                  value={l.url}
                  onChange={e => updateLink(i, 'url', e.target.value)}
                  style={{ flex: 1 }}
                />
                {links.length > 1 && (
                  <button className="sb-link-remove" onClick={() => removeLink(i)}>×</button>
                )}
              </div>
            ))}
          </div>

          <div className="sb-actions">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save & Publish'}
            </button>
            {live && (
              <button className="btn btn-danger" onClick={clear}>Clear from Site</button>
            )}
          </div>

          {live && (
            <div className="sb-last-update">
              Last published {new Date(live.updatedAt).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                hour12: true, timeZone: 'America/New_York',
              })} EST by {live.updatedBy}
            </div>
          )}
        </div>

        {/* ── Right: Preview + Embed ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          <div className="card">
            <div className="card-title">Preview</div>
            <div className="sb-preview">
              {hasContent ? (
                <div className="sb-preview-inner">
                  {imageUrl && !imgError && (
                    <img
                      src={imageUrl}
                      alt=""
                      className="sb-preview-img"
                      onError={() => setImgError(true)}
                    />
                  )}
                  <div className="sb-preview-body-wrap">
                    <div className="sb-preview-eyebrow">● from ops</div>
                    {title && <div className="sb-preview-title">{title}</div>}
                    {body  && <div className="sb-preview-body">{body}</div>}
                    {previewLinks.length > 0 && (
                      <div className="sb-preview-link-pills">
                        {previewLinks.map((l, i) => (
                          <a key={i} href={l.url} target="_blank" rel="noreferrer" className="sb-preview-pill">
                            {l.label || l.url}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="sb-preview-inner">
                  <div className="sb-preview-rest">
                    <span className="sb-preview-rest-dot" />
                    <div>
                      <div className="sb-preview-rest-lbl">from ops</div>
                      <div className="sb-preview-rest-txt">all quiet — no updates right now</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Wix Embed Code</div>
            <p className="sb-embed-hint">
              In the Wix editor, add an <strong>HTML iFrame</strong> element to your homepage
              and paste this code. It auto-refreshes every 30 seconds.
            </p>
            <pre className="sb-embed-code">{buildEmbedCode()}</pre>
            <button className="btn btn-secondary sb-copy-btn" onClick={copyEmbed}>
              {copied ? '✓ Copied!' : 'Copy Code'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
