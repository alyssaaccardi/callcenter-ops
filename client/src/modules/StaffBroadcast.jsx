import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './StaffBroadcast.css';

// Public endpoint — no auth, sanitized payload (no updatedBy). The internal
// dashboard still uses /api/staff-broadcast (auth-required) for edit/delete.
const EMBED_URL = 'https://ops.answeringlegal.com/api/widget/staff-broadcast';

function buildEmbedCode() {
  return `<div id="al-bc"></div>
<script>
(function(){
  var el=document.getElementById('al-bc');
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function render(d){
    if(!d||d.empty){el.style.display='none';return;}
    el.style.display='block';
    var s='<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);max-width:520px;">';
    if(d.imageUrl) s+='<img src="'+esc(d.imageUrl)+'" style="width:100%;height:auto;display:block;max-height:240px;object-fit:cover;">';
    s+='<div style="padding:20px 22px;">';
    if(d.title) s+='<div style="font-size:18px;font-weight:700;color:#1a1a3e;margin-bottom:8px;line-height:1.3;">'+esc(d.title)+'</div>';
    if(d.body)  s+='<div style="font-size:14px;line-height:1.65;color:#444;margin-bottom:14px;white-space:pre-wrap;">'+esc(d.body)+'</div>';
    if(d.links&&d.links.length){
      s+='<div style="display:flex;flex-wrap:wrap;gap:8px;">';
      d.links.forEach(function(l){
        s+='<a href="'+esc(l.url)+'" target="_blank" style="display:inline-block;padding:7px 18px;background:#1a6fe8;color:#fff;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;line-height:1;">'+esc(l.label||l.url)+'</a>';
      });
      s+='</div>';
    }
    s+='</div></div>';
    el.innerHTML=s;
  }
  function load(){
    var x=new XMLHttpRequest();
    x.open('GET','${EMBED_URL}');
    x.onload=function(){try{render(JSON.parse(x.responseText));}catch(e){}};
    x.send();
  }
  load();setInterval(load,30000);
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
            {!hasContent ? (
              <div className="sb-preview-empty">Nothing to preview yet</div>
            ) : (
              <div className="sb-preview">
                {imageUrl && !imgError && (
                  <img
                    src={imageUrl}
                    alt=""
                    className="sb-preview-img"
                    onError={() => setImgError(true)}
                  />
                )}
                <div className="sb-preview-body-wrap">
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
            )}
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
