import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './StaffBroadcast.css';

const EMBED_URL = 'https://ops.answeringlegal.com/api/staff-broadcast';

function buildEmbedCode() {
  return `<div id="al-broadcast"></div>
<script>
(function() {
  var el = document.getElementById('al-broadcast');
  function render(d) {
    if (!d || d.empty) { el.innerHTML = ''; return; }
    var html = '<div style="font-family:sans-serif;line-height:1.5;">';
    if (d.title) html += '<strong style="font-size:1.1em;">' + d.title + '</strong><br>';
    if (d.body)  html += '<span>' + d.body.replace(/\\n/g,'<br>') + '</span>';
    if (d.links && d.links.length) {
      html += '<ul style="margin:8px 0 0;padding-left:18px;">';
      d.links.forEach(function(l) {
        html += '<li><a href="' + l.url + '" target="_blank">' + (l.label || l.url) + '</a></li>';
      });
      html += '</ul>';
    }
    html += '</div>';
    el.innerHTML = html;
  }
  function fetch() {
    var x = new XMLHttpRequest();
    x.open('GET','${EMBED_URL}');
    x.onload = function() { try { render(JSON.parse(x.responseText)); } catch(e) {} };
    x.send();
  }
  fetch();
  setInterval(fetch, 30000);
})();
<\/script>`;
}

export default function StaffBroadcast() {
  const { toast } = useApp();

  const [title, setTitle]   = useState('');
  const [body, setBody]     = useState('');
  const [links, setLinks]   = useState([{ label: '', url: '' }]);
  const [live, setLive]     = useState(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/api/staff-broadcast').then(r => {
      const d = r.data;
      if (d && !d.empty) {
        setTitle(d.title || '');
        setBody(d.body || '');
        setLinks(d.links?.length ? [...d.links, { label: '', url: '' }] : [{ label: '', url: '' }]);
        setLive(d);
      }
    }).catch(() => {});
  }, []);

  function updateLink(i, field, val) {
    setLinks(prev => {
      const next = prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l);
      // auto-add a blank row when last row gets filled
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
      const { data } = await api.post('/api/staff-broadcast', { title, body, links: cleanLinks });
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
      setTitle(''); setBody(''); setLinks([{ label: '', url: '' }]); setLive(null);
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

  return (
    <div className="sb-page">
      <div className="sb-header">
        <div>
          <h1 className="sb-title">Staff Site Broadcast</h1>
          <p className="sb-subtitle">Publish an announcement directly to the Answering Legal staff site homepage.</p>
        </div>
        {live && (
          <div className="sb-live-badge">
            <span className="sb-live-dot" />
            Live on Wix
          </div>
        )}
      </div>

      <div className="sb-layout">
        {/* ── Editor ── */}
        <div className="sb-card sb-editor">
          <div className="sb-card-title">Announcement</div>

          <label className="sb-label">Title</label>
          <input
            className="sb-input"
            placeholder="e.g. Office closed Monday"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
          />

          <label className="sb-label">Body</label>
          <textarea
            className="sb-textarea"
            placeholder="Details, context, instructions..."
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={5}
          />

          <label className="sb-label">Links <span className="sb-label-hint">(optional)</span></label>
          <div className="sb-links-list">
            {links.map((l, i) => (
              <div className="sb-link-row" key={i}>
                <input
                  className="sb-input sb-link-label"
                  placeholder="Label"
                  value={l.label}
                  onChange={e => updateLink(i, 'label', e.target.value)}
                />
                <input
                  className="sb-input sb-link-url"
                  placeholder="https://..."
                  value={l.url}
                  onChange={e => updateLink(i, 'url', e.target.value)}
                />
                {links.length > 1 && (
                  <button className="sb-link-remove" onClick={() => removeLink(i)} title="Remove">×</button>
                )}
              </div>
            ))}
          </div>

          <div className="sb-actions">
            <button className="sb-btn sb-btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save & Publish'}
            </button>
            {live && (
              <button className="sb-btn sb-btn-danger" onClick={clear}>Clear from Site</button>
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

        {/* ── Preview ── */}
        <div className="sb-card sb-preview-card">
          <div className="sb-card-title">Preview</div>
          {!title && !body && !previewLinks.length ? (
            <div className="sb-preview-empty">Nothing to preview yet</div>
          ) : (
            <div className="sb-preview">
              {title && <div className="sb-preview-title">{title}</div>}
              {body  && <div className="sb-preview-body">{body}</div>}
              {previewLinks.length > 0 && (
                <ul className="sb-preview-links">
                  {previewLinks.map((l, i) => (
                    <li key={i}>
                      <a href={l.url} target="_blank" rel="noreferrer">{l.label || l.url}</a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* ── Wix Embed ── */}
        <div className="sb-card sb-embed-card">
          <div className="sb-card-title">Wix Embed Code</div>
          <p className="sb-embed-hint">
            In the Wix editor, add an <strong>HTML iFrame</strong> element to your homepage and paste this code.
            It auto-refreshes every 30 seconds.
          </p>
          <pre className="sb-embed-code">{buildEmbedCode()}</pre>
          <button className="sb-btn sb-btn-copy" onClick={copyEmbed}>
            {copied ? '✓ Copied!' : 'Copy Code'}
          </button>
        </div>
      </div>
    </div>
  );
}
