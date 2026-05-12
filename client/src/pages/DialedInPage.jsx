import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import './DialedInPage.css';

const POLL_MS = 15000;

async function renderFanfareWAV() {
  const duration = 3.6;
  const sr = 44100;
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sr), sr);
  function note(freq, t, dur, vol = 0.28) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.setValueAtTime(vol, t + dur - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
  note(523, 0.00, 0.14); note(659, 0.16, 0.14); note(784, 0.32, 0.14);
  note(1047, 0.48, 0.55); note(659, 0.48, 0.55, 0.12);
  note(880, 1.10, 0.13); note(988, 1.25, 0.13);
  note(1047, 1.40, 0.65); note(784, 1.40, 0.65, 0.12); note(659, 1.40, 0.65, 0.08);
  note(1319, 2.10, 0.12, 0.22); note(1047, 2.24, 0.60, 0.30); note(784, 2.24, 0.60, 0.14);
  const buf = await ctx.startRendering();
  const samples = buf.getChannelData(0);
  const wav = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(wav);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

function spawnRainDown() {
  for (let i = 0; i < 22; i++) {
    const img = document.createElement('img');
    img.src = '/down-image.png';
    const size = 60 + Math.random() * 80;
    img.style.cssText = `position:fixed;width:${size}px;height:${size}px;object-fit:contain;left:${Math.random()*100}vw;top:-${size}px;z-index:99999;pointer-events:none;--tx-start:0px;--tx-end:${(Math.random()-.5)*300}px;--rot-start:${(Math.random()-.5)*60}deg;--rot-end:${(Math.random()-.5)*360}deg;animation:tv-downRain ${3+Math.random()*1.5}s ease-in ${Math.random()*.8}s forwards;`;
    document.body.appendChild(img);
    img.addEventListener('animationend', () => img.remove());
  }
}

function spawnPhones() {
  const emojis = ['📞', '☎️', '📞', '📱', '📞'];
  for (let i = 0; i < 20; i++) {
    const el = document.createElement('div');
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    const size = 28 + Math.random() * 44;
    el.style.cssText = `position:fixed;font-size:${size}px;left:${Math.random()*100}vw;bottom:-${size+10}px;z-index:99999;pointer-events:none;--drift:${(Math.random()-.5)*220}px;--rot-start:${(Math.random()-.5)*40}deg;--rot-end:${(Math.random()-.5)*200}deg;animation:tv-upPhoneFloat ${2.4+Math.random()*1.8}s ease-out ${Math.random()*1.5}s forwards;`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}

function classifyByCC(agents) {
  const groups = { savvy: [], mitel: [] };
  for (const a of agents) {
    ((a.callCenter || '').toLowerCase().includes('savvy') ? groups.savvy : groups.mitel).push(a.name);
  }
  return groups;
}

function fmtSeconds(s) {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function CcPanel({ isUp, locationLabel, carrierLabel, name, didCount, didPop, message, changedBy, changedAt, counts, xcally, queueStats }) {
  function fmtAttr() {
    if (!changedBy || !changedAt) return '';
    return `Updated by ${changedBy} at ${new Date(changedAt).toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} EST`;
  }
  const displayDid = didCount !== null && didCount !== undefined ? didCount : '—';
  return (
    <div className={`tv-panel ${isUp ? 'tv-up' : 'tv-down'}`}>
      <div className="tv-panel-accent" />
      <div className="tv-corner tv-corner-tl" /><div className="tv-corner tv-corner-tr" />
      <div className="tv-corner tv-corner-bl" /><div className="tv-corner tv-corner-br" />
      <div className="tv-panel-inner">
        <div className="tv-panel-location">{locationLabel}</div>
        <div className="tv-panel-carrier">{carrierLabel}</div>
        <div className="tv-panel-name">{name}</div>
        <div className="tv-orb-row">
          <div className={`tv-orb ${isUp ? 'tv-up' : 'tv-down'}`} />
          <div className={`tv-status-word ${isUp ? 'tv-up' : 'tv-down'}`}>{isUp ? 'Operational' : 'Down'}</div>
        </div>
        <div className="tv-did-block">
          <div className="tv-did-label">Active DIDs</div>
          <div className={`tv-did-number ${isUp ? 'tv-up' : 'tv-down'}${didPop ? ' tv-pop' : ''}`}>{displayDid}</div>
        </div>
        <div className="tv-panel-message">{message || (isUp ? 'All lines operational' : 'Service disruption in progress')}</div>
        <div className="tv-panel-attribution">{fmtAttr()}</div>
        <div className="tv-agent-stats-block">
          <div className="tv-agent-stats-row">
            <div className="tv-agent-stat">
              <div className="tv-standby-label">Here</div>
              <div className={`tv-here-count${counts.here === 0 ? ' tv-none' : ''}`}>{counts.here}</div>
            </div>
            <div className="tv-agent-stat">
              <div className="tv-standby-label">Standby</div>
              <div className={`tv-standby-count${counts.standby === 0 ? ' tv-none' : ''}`}>{counts.standby}</div>
            </div>
          </div>
          {counts.standbyNames && <div className="tv-standby-names">{counts.standbyNames}</div>}
        </div>
        {xcally != null && !xcally.unconfigured && !xcally.error && (
          <div className="tv-queue-stats">
            <div className="tv-queue-stat">
              <div className="tv-queue-stat-label">Callers Waiting</div>
              <div className={`tv-queue-stat-value${xcally?.waiting > 0 ? ' tv-queue-warn' : ''}`}>
                {xcally?.waiting ?? '—'}
              </div>
            </div>
            <div className="tv-queue-stat-divider" />
            <div className="tv-queue-stat">
              <div className="tv-queue-stat-label">Longest Wait</div>
              <div className="tv-queue-stat-value">{fmtSeconds(xcally?.longestWait)}</div>
            </div>
          </div>
        )}
        {queueStats?.queues?.length > 0 && (
          <div className={`tv-mitel-stats${queueStats.updatedAt && Date.now() - new Date(queueStats.updatedAt).getTime() > 60000 ? ' stale' : ''}`}>
            <div className="tv-mitel-stats-header">
              <span className="tv-mitel-stats-title">Today's Calls</span>
              <span className="tv-mitel-stats-cols">
                <span>Answered</span><span>Longest Wait</span>
              </span>
            </div>
            {queueStats.queues.map(q => (
              <div key={q.id} className="tv-mitel-stats-row">
                <span className="tv-mitel-stats-queue">{q.name}</span>
                <span className="tv-mitel-stats-cols">
                  <span className="tv-mitel-answered">{q.answered.toLocaleString()}</span>
                  <span className="tv-mitel-wait">{q.recentMaxWait != null ? fmtSeconds(q.recentMaxWait) : '—'}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SysChip({ label, isUp, statusWord, alert }) {
  return (
    <div className={`tv-sys-chip ${isUp ? 'tv-up' : 'tv-down'}`}>
      <div className="tv-sys-chip-accent" />
      <div className="tv-sys-chip-name">{label}</div>
      <div className="tv-sys-chip-body">
        <div className="tv-sys-chip-status-row">
          <div className={`tv-sys-chip-orb ${isUp ? 'tv-up' : 'tv-down'}`} />
          <div className={`tv-sys-chip-word ${isUp ? 'tv-up' : 'tv-down'}`}>{statusWord}</div>
        </div>
        {alert && <div className="tv-sys-chip-alert">{alert}</div>}
      </div>
    </div>
  );
}

export default function DialedInPage() {
  const token = new URLSearchParams(window.location.search).get('t');
  const { user } = useAuth();
  const isTvUser = user?.role === 'tv_display';

  const [tokenValid, setTokenValid] = useState(null);
  const [status, setStatus] = useState(null);
  const [dids, setDids] = useState(null);
  const [hsDids, setHsDids] = useState(null);
  const [xcally, setXcally] = useState(null);
  const [mitelStats, setMitelStats] = useState(null);
  const [agents, setAgents] = useState({ savvy: { here: 0, standby: 0, standbyNames: '' }, mitel: { here: 0, standby: 0, standbyNames: '' } });
  const [didPop, setDidPop] = useState({ savvy: false, mitel: false });
  const [syncInfo, setSyncInfo] = useState('Checking status...');
  const [time, setTime] = useState(new Date());
  const [showUpOverlay, setShowUpOverlay] = useState(false);

  const prevStates = useRef({ savvy: null, mitel: null });
  const prevDidCounts = useRef({ savvy: undefined, mitel: undefined });
  const fanfareUrl = useRef(null);
  const upTimer = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    renderFanfareWAV().then(url => { fanfareUrl.current = url; }).catch(() => {});
  }, []);

  useEffect(() => {
    if (isTvUser) { setTokenValid(true); return; }
    if (!token) { setTokenValid(false); return; }
    fetch(`/api/tv-session/validate?t=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => setTokenValid(!!d.valid))
      .catch(() => setTokenValid(false));
  }, [token, isTvUser]);

  useEffect(() => {
    if (!dids) return;
    const pops = {};
    for (const key of ['savvy', 'mitel']) {
      if (prevDidCounts.current[key] !== undefined && prevDidCounts.current[key] !== dids[key]) {
        pops[key] = true;
      }
      prevDidCounts.current[key] = dids[key];
    }
    if (Object.keys(pops).length) {
      setDidPop(p => ({ ...p, ...pops }));
      setTimeout(() => setDidPop({ savvy: false, mitel: false }), 400);
    }
  }, [dids]);

  useEffect(() => {
    if (!tokenValid) return;

    async function fetchStatus() {
      try {
        const [sRes, dRes, hsRes, xcRes] = await Promise.all([fetch('/api/status'), fetch('/api/bandwidth/dids'), fetch('/api/hubspot/dids'), fetch('/api/xcally/queue')]);
        const s  = sRes.ok  ? await sRes.json()  : null;
        const d  = dRes.ok  ? await dRes.json()  : null;
        const hs = hsRes.ok ? await hsRes.json() : null;
        const xc = xcRes.ok ? await xcRes.json() : null;
        if (s) {
          const savvyNow = s.savvyPhone?.state !== 'DOWN';
          const mitelNow = s.mitelClassic?.state !== 'DOWN';
          if (prevStates.current.savvy !== null && prevStates.current.savvy && !savvyNow) spawnRainDown();
          if (prevStates.current.mitel !== null && prevStates.current.mitel && !mitelNow) spawnRainDown();
          prevStates.current.savvy = savvyNow;
          prevStates.current.mitel = mitelNow;
        }
        setStatus(s);
        setDids(d);
        setHsDids(hs);
        setXcally(xc);
        const t = new Date(d?.syncedAt || s?.updatedAt || Date.now()).toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
        setSyncInfo(`Live · Last sync: ${t}`);
      } catch (err) {
        setSyncInfo(`Sync error: ${err.message}`);
      }
    }

    async function fetchAgents() {
      try {
        const res = await fetch('/api/monday/agents');
        if (!res.ok) return;
        const { agents: list } = await res.json();
        const here    = list.filter(a => (a.status || '').toLowerCase().includes('here'));
        const standby = list.filter(a => (a.status || '').toLowerCase().includes('standby'));
        const hg = classifyByCC(here);
        const sg = classifyByCC(standby);
        setAgents({
          savvy: { here: hg.savvy.length, standby: sg.savvy.length, standbyNames: sg.savvy.join(' · ') },
          mitel: { here: hg.mitel.length, standby: sg.mitel.length, standbyNames: sg.mitel.join(' · ') },
        });
      } catch (_) {}
    }

    fetchStatus();
    fetchAgents();
    const id1 = setInterval(fetchStatus, POLL_MS);
    const id2 = setInterval(fetchAgents, POLL_MS);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, [tokenValid]);

  // Mitel queue stats — SSE subscription for near-real-time updates (~5s lag)
  useEffect(() => {
    if (!tokenValid) return;
    const url = token ? `/api/mitel/queue-stats/stream?t=${encodeURIComponent(token)}` : '/api/mitel/queue-stats/stream';
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (e) => {
      try {
        const mq = JSON.parse(e.data);
        if (mq && !mq.unconfigured && !mq.error) setMitelStats(mq);
      } catch (_) {}
    };
    return () => es.close();
  }, [tokenValid]);

  // Expose mkShow/mkDismiss for external callers (e.g. dashboard window reference)
  useEffect(() => {
    window.mkShow = () => {
      setShowUpOverlay(true);
      spawnPhones();
      if (fanfareUrl.current) {
        const audio = new Audio(fanfareUrl.current);
        audio.volume = 0.75;
        audio.play().catch(() => {});
      }
      clearTimeout(upTimer.current);
      upTimer.current = setTimeout(() => setShowUpOverlay(false), 12000);
    };
    window.mkDismiss = () => {
      clearTimeout(upTimer.current);
      setShowUpOverlay(false);
    };
    return () => { delete window.mkShow; delete window.mkDismiss; };
  }, []);

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') { clearTimeout(upTimer.current); setShowUpOverlay(false); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  if (tokenValid === null) {
    return <div className="tv-page tv-loading"><span className="tv-spinner" /></div>;
  }

  if (!tokenValid) {
    return (
      <div className="tv-page tv-denied">
        <div>
          <h2>Access Denied</h2>
          <p>Open this display from the Operations Dashboard.</p>
        </div>
      </div>
    );
  }

  const savvy   = status?.savvyPhone;
  const mitel   = status?.mitelClassic;
  const mobile  = status?.mobileApp;
  const integr  = status?.integrations;
  const savvyUp = savvy?.state !== 'DOWN';
  const mitelUp = mitel?.state !== 'DOWN';
  const mobileUp = mobile?.state !== 'DOWN';
  const mobileMessagesOk = !mobile?.messagesDown;
  const integrMessagesOk = !integr?.messagesDown;
  const didUp   = (status?.didStatus || 'UP') === 'UP';
  const allOp   = savvyUp && mitelUp && mobileUp && mobileMessagesOk && integrMessagesOk && didUp;

  const mobileAlert = !mobileUp ? 'Mobile App is DOWN — messages cannot reach it.'
    : (!mobileMessagesOk ? 'App is up, but messages are NOT routing into it.' : null);
  const integrAlert = !integrMessagesOk ? 'Messages are NOT hitting customer CRMs — their CRM may still be up.' : null;

  return (
    <div className="tv-page">
      <div className="tv-stripe-top" />
      <div className="tv-stripe-bottom" />
      <div className="tv-diag-lines" />

      <div className="tv-wrapper">
        <div className="tv-header">
          <div className="tv-header-left">
            <img className="tv-header-logo" src="/dialedin-logo-dark.png" alt="Answering Legal" />
            <div>
              <div className="tv-header-brand">Answering Legal</div>
              <div className="tv-header-sub">Dialed In Dash</div>
            </div>
          </div>
          <div className="tv-header-center">
            <div className={`tv-did-status-pill ${didUp ? 'tv-up' : 'tv-down'}`}>
              {didUp ? 'DIDs Available' : 'DIDs Unavailable'}
            </div>
          </div>
          <div className="tv-header-right">
            <div className="tv-dual-clock">
              <div className="tv-clock-entry">
                <span className="tv-clock-label">EST</span>
                <span className="tv-clock">{time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })}</span>
              </div>
              <div className="tv-clock-sep" />
              <div className="tv-clock-entry">
                <span className="tv-clock-label">BZ</span>
                <span className="tv-clock">{time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Belize' })}</span>
              </div>
            </div>
            <div className="tv-date">{time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}</div>
          </div>
        </div>

        <div className="tv-panels">
          <CcPanel
            isUp={savvyUp} locationLabel="Stafford Location" carrierLabel="via Bandwidth"
            name="Savvy Phone" didCount={dids?.savvy} didPop={didPop.savvy}
            message={savvy?.message} changedBy={savvy?.changedBy} changedAt={savvy?.changedAt}
            counts={agents.savvy} xcally={xcally}
          />
          <CcPanel
            isUp={mitelUp} locationLabel="Mitel Location" carrierLabel="via Bandwidth"
            name="Mitel Classic" didCount={dids?.mitel} didPop={didPop.mitel}
            message={mitel?.message} changedBy={mitel?.changedBy} changedAt={mitel?.changedAt}
            counts={agents.mitel} queueStats={mitelStats}
          />
        </div>

        <div className="tv-systems-bar">
          <SysChip
            label="📱 Mobile App"
            isUp={mobileUp && mobileMessagesOk}
            statusWord={(mobileUp && mobileMessagesOk) ? 'Messages Routing' : 'Degraded'}
            alert={mobileAlert}
          />
          <SysChip
            label="🔗 Integrations"
            isUp={integrMessagesOk}
            statusWord={integrMessagesOk ? 'Messages Routing' : 'Degraded'}
            alert={integrAlert}
          />
          <div className={`tv-sys-chip ${didUp ? 'tv-up' : 'tv-down'} tv-did-pool-chip`}>
            <div className="tv-sys-chip-accent" />
            <div className="tv-sys-chip-name">Available DIDs</div>
            <div className="tv-sys-chip-body">
              {!didUp ? (
                <div className="tv-did-pool-unavailable">Unavailable</div>
              ) : (
                <div className="tv-did-pool-row">
                  <div className="tv-did-pool-item">
                    <span className="tv-did-pool-label">Pool</span>
                    <span className={`tv-did-pool-count${hsDids?.didPool != null && hsDids.didPool < 20 ? ' tv-zero' : ''}`}>
                      {hsDids?.didPool ?? '—'}
                    </span>
                  </div>
                  <div className="tv-did-pool-divider" />
                  <div className="tv-did-pool-item">
                    <span className="tv-did-pool-label">Instant</span>
                    <span className={`tv-did-pool-count${hsDids?.instantDidPool != null && hsDids.instantDidPool < 20 ? ' tv-zero' : ''}`}>
                      {hsDids?.instantDidPool ?? '—'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="tv-footer">
          <div className={`tv-global-pill ${allOp ? 'tv-operational' : 'tv-standby'}`}>
            <span className="tv-global-dot" />
            <span>{allOp ? 'All Systems Operational' : 'System Degraded'}</span>
          </div>
          <div className="tv-sync-info">{syncInfo}</div>
        </div>
      </div>

      {showUpOverlay && (
        <div className="tv-up-overlay">
          <div className="tv-up-rings-wrap">
            <div className="tv-up-ring" /><div className="tv-up-ring" /><div className="tv-up-ring" />
          </div>
          <div className="tv-up-content">
            <div className="tv-up-icon">📞</div>
            <div className="tv-up-title">ALL LINES UP!</div>
            <div className="tv-up-sub">All Systems Operational</div>
          </div>
          <button className="tv-up-dismiss" onClick={() => { clearTimeout(upTimer.current); setShowUpOverlay(false); }}>
            ESC TO DISMISS
          </button>
        </div>
      )}
    </div>
  );
}
