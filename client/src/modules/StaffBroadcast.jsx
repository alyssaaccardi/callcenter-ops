import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import api from '../api';
import './StaffBroadcast.css';

// Public endpoint — no auth, sanitized payload (no updatedBy). The internal
// dashboard still uses /api/staff-broadcast (auth-required) for edit/delete.
const EMBED_URL = 'https://ops.answeringlegal.com/api/widget/staff-broadcast';

function buildEmbedCode() {
  return `<style>
  html,body{margin:0;padding:0;background:#0b1a30;}
  #al-hero *, #al-hero *::before, #al-hero *::after { box-sizing: border-box; margin: 0; padding: 0; }

  #al-hero {
    --blue:#3D7BFF; --gold:#FFC53D; --gold-hi:#FFDE86; --mint:#5FE3B3;
    --lilac:#A78BFF; --text:#EAF0FF; --mist:#9DB2D8;
    position: relative; width: 100%; min-height: 560px;
    padding: clamp(40px,6vh,68px) 0;
    border-radius: 30px; overflow: hidden;
    display: grid; place-items: center;
    font-family: "Helvetica Neue", Arial, system-ui, sans-serif; color: var(--text);
    background: radial-gradient(140% 120% at 50% -10%, #123163 0%, #0A183A 45%, #070F22 100%);
    isolation: isolate;
  }
  #al-hero .blob { position:absolute; z-index:0; border-radius:50%; filter:blur(60px); opacity:.55; pointer-events:none; }
  #al-hero .b1 { width:46%; height:60%; left:-8%; top:-18%; background:var(--blue); animation:al-d1 19s ease-in-out infinite alternate; }
  #al-hero .b2 { width:40%; height:55%; right:-6%; top:8%; background:var(--gold); opacity:.38; animation:al-d2 23s ease-in-out infinite alternate; }
  #al-hero .b3 { width:42%; height:52%; left:18%; bottom:-22%; background:var(--lilac); opacity:.34; animation:al-d3 26s ease-in-out infinite alternate; }
  #al-hero .b4 { width:30%; height:40%; right:14%; bottom:-14%; background:var(--mint); opacity:.30; animation:al-d1 21s ease-in-out infinite alternate-reverse; }
  @keyframes al-d1 { to { transform:translate3d(8%,6%,0) scale(1.15); } }
  @keyframes al-d2 { to { transform:translate3d(-7%,9%,0) scale(1.1); } }
  @keyframes al-d3 { to { transform:translate3d(6%,-8%,0) scale(1.12); } }

  #al-hero .eq {
    position:absolute; left:0; right:0; bottom:0; z-index:1; height:34%;
    display:flex; align-items:flex-end; justify-content:center;
    gap:clamp(4px,1.1vw,9px); padding:0 6%; pointer-events:none;
    -webkit-mask-image:linear-gradient(90deg,transparent,#000 18%,#000 82%,transparent);
    mask-image:linear-gradient(90deg,transparent,#000 18%,#000 82%,transparent);
  }
  #al-hero .eq span {
    flex:1; max-width:22px; border-radius:8px 8px 0 0;
    background:linear-gradient(180deg,var(--gold-hi),var(--gold) 40%,rgba(95,227,179,.35));
    transform-origin:bottom; height:22%; animation:al-eq 1.4s ease-in-out infinite;
  }
  @keyframes al-eq { 0%,100%{height:16%; opacity:.55} 50%{height:86%; opacity:1} }
  #al-hero .eq span:nth-child(1){animation-delay:-.2s} #al-hero .eq span:nth-child(2){animation-delay:-.9s}
  #al-hero .eq span:nth-child(3){animation-delay:-.4s} #al-hero .eq span:nth-child(4){animation-delay:-1.1s}
  #al-hero .eq span:nth-child(5){animation-delay:-.6s} #al-hero .eq span:nth-child(6){animation-delay:-.1s}
  #al-hero .eq span:nth-child(7){animation-delay:-1.3s} #al-hero .eq span:nth-child(8){animation-delay:-.5s}
  #al-hero .eq span:nth-child(9){animation-delay:-1s} #al-hero .eq span:nth-child(10){animation-delay:-.3s}
  #al-hero .eq span:nth-child(11){animation-delay:-.8s} #al-hero .eq span:nth-child(12){animation-delay:-1.2s}
  #al-hero .eq span:nth-child(13){animation-delay:-.2s} #al-hero .eq span:nth-child(14){animation-delay:-.7s}
  #al-hero .eq span:nth-child(15){animation-delay:-1.1s}

  #al-hero .stage { position:relative; z-index:3; text-align:center; padding:0 clamp(24px,5vw,56px); max-width:760px; width:100%; }
  #al-hero .logo-wrap { margin:0 auto 22px; }
  #al-hero #al-logo { max-height:96px; max-width:260px; width:auto; display:block; margin:0 auto; filter:drop-shadow(0 10px 30px rgba(0,0,0,.45)); }

  #al-hero .sticker {
    display:inline-flex; align-items:center; gap:7px; background:var(--mint);
    color:#06331F; font-weight:800; font-size:13px; letter-spacing:.02em;
    padding:8px 15px; border-radius:999px; transform:rotate(-5deg); margin-bottom:18px;
    box-shadow:0 8px 24px rgba(95,227,179,.35); animation:al-wiggle 5s 1s ease-in-out infinite;
  }
  @keyframes al-wiggle { 0%,92%,100%{transform:rotate(-5deg)} 95%{transform:rotate(-9deg)} 98%{transform:rotate(-2deg)} }

  #al-hero .greet { font-weight:700; font-size:clamp(15px,2.4vw,20px); color:var(--mist); text-transform:lowercase; margin-bottom:6px; }
  #al-hero h1 { font-weight:800; font-size:clamp(52px,12vw,118px); line-height:.9; letter-spacing:-.05em; text-transform:lowercase; }
  #al-hero h1 .pop { background:linear-gradient(100deg,var(--gold-hi),var(--gold) 40%,var(--mint)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  #al-hero .tagline { margin-top:20px; color:var(--mist); font-weight:500; font-size:clamp(14px,2vw,18px); }

  #al-hero .al-bc { width:100%; max-width:520px; margin:30px auto 0; }
  #al-hero .al-bc-card {
    background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14);
    border-radius:18px; overflow:hidden; text-align:left;
    -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
    box-shadow:0 18px 40px rgba(0,0,0,.35); animation:al-rise .45s ease both;
  }
  #al-hero .al-bc-img { width:100%; height:auto; max-height:200px; object-fit:cover; display:block; }
  #al-hero .al-bc-in { padding:18px 20px; }
  #al-hero .al-bc-eyebrow { font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--mint); margin-bottom:9px; }
  #al-hero .al-bc-title { font-size:17px; font-weight:800; color:#fff; line-height:1.3; margin-bottom:6px; letter-spacing:-.01em; }
  #al-hero .al-bc-body { font-size:14px; line-height:1.6; color:var(--mist); white-space:pre-wrap; word-wrap:break-word; }
  #al-hero .al-bc-links { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  #al-hero .al-bc-btn {
    display:inline-block; padding:8px 16px; border-radius:999px; text-decoration:none;
    font-size:13px; font-weight:700; line-height:1; color:#06331F;
    background:linear-gradient(100deg,var(--gold-hi),var(--gold)); transition:filter .15s;
  }
  #al-hero .al-bc-btn:hover { filter:brightness(1.06); }
  #al-hero .al-bc-rest { background:rgba(255,255,255,.045); }
  #al-hero .al-bc-rest-in { display:flex; align-items:center; gap:12px; padding:14px 18px; }
  #al-hero .al-bc-dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--mint); box-shadow:0 0 0 4px rgba(95,227,179,.18); animation:al-breath 2.4s ease-in-out infinite; }
  @keyframes al-breath { 0%,100%{opacity:.45} 50%{opacity:1} }
  #al-hero .al-bc-rest-txt { font-size:13px; color:var(--mist); font-weight:500; }
  #al-hero .al-bc-rest-lbl { font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--mint); margin-bottom:2px; }

  @keyframes al-rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }

  @media (prefers-reduced-motion: reduce) {
    #al-hero * { animation:none !important; }
    #al-hero .eq span { height:48%; }
  }
</style>
<div id="al-hero">
  <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div>

  <div class="eq" aria-hidden="true">
    <span></span><span></span><span></span><span></span><span></span>
    <span></span><span></span><span></span><span></span><span></span>
    <span></span><span></span><span></span><span></span><span></span>
  </div>

  <div class="stage">
    <div class="logo-wrap">
      <!-- LOGO: uncomment the line below and paste your logo URL between the quotes -->
      <!-- <img id="al-logo" src="PASTE_LOGO_URL_HERE" alt="Answering Legal"> -->
    </div>
    <span class="sticker">✦ 24/7 crew</span>
    <div class="greet">hey, team</div>
    <h1>always <span class="pop">on.</span></h1>
    <p class="tagline">every call. every shift. we got you.</p>

    <!-- ops manager broadcast renders here -->
    <div id="al-bc" class="al-bc"></div>
  </div>
</div>
<script>
(function(){
  var el = document.getElementById('al-bc');
  if (!el) return;
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function renderResting(){
    el.innerHTML =
      '<div class="al-bc-card al-bc-rest">' +
        '<div class="al-bc-in al-bc-rest-in">' +
          '<span class="al-bc-dot"></span>' +
          '<div>' +
            '<div class="al-bc-rest-lbl">from ops</div>' +
            '<div class="al-bc-rest-txt">all quiet — no updates right now</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }
  function render(d){
    if (!d || d.empty){ renderResting(); return; }
    var s = '<div class="al-bc-card">';
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
    s += '</div></div>';
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
              and paste this code. Size the iFrame around <strong>760&nbsp;×&nbsp;720&nbsp;px</strong>
              so the hero renders without clipping. It auto-refreshes every 30 seconds.
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
