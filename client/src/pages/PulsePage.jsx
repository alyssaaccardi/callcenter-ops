import React, { useState, useEffect, useRef } from 'react';
import './PulsePage.css';

const POLL_MS = 15000;

function spawnRainDown() {
  for (let i = 0; i < 22; i++) {
    const img = document.createElement('img');
    img.src = '/down-image.png';
    const size = 60 + Math.random() * 80;
    img.style.cssText = `position:fixed;width:${size}px;height:${size}px;object-fit:contain;left:${Math.random()*100}vw;top:-${size}px;z-index:99999;pointer-events:none;--tx-start:0px;--tx-end:${(Math.random()-.5)*300}px;--rot-start:${(Math.random()-.5)*60}deg;--rot-end:${(Math.random()-.5)*360}deg;animation:pulse-downRain ${3+Math.random()*1.5}s ease-in ${Math.random()*.8}s forwards;`;
    document.body.appendChild(img);
    img.addEventListener('animationend', () => img.remove());
  }
}

function spawnMuscleRain() {
  for (let i = 0; i < 28; i++) {
    const el = document.createElement('div');
    el.textContent = '💪';
    const size = 32 + Math.random() * 52;
    el.style.cssText = `position:fixed;font-size:${size}px;left:${Math.random()*100}vw;bottom:-${size+10}px;z-index:99999;pointer-events:none;--drift:${(Math.random()-.5)*260}px;--rot-start:${(Math.random()-.5)*40}deg;--rot-end:${(Math.random()-.5)*220}deg;animation:pulse-muscleFloat ${2.2+Math.random()*2}s ease-out ${Math.random()*1.2}s forwards;`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}

function SysPanel({ label, isUp, statusWord, alertClass, alertText }) {
  return (
    <div className={`pulse-sys-panel ${isUp ? 'pulse-up' : 'pulse-down'}`}>
      <div className="pulse-panel-accent" />
      <div className="pulse-corner pulse-corner-tl" /><div className="pulse-corner pulse-corner-tr" />
      <div className="pulse-corner pulse-corner-bl" /><div className="pulse-corner pulse-corner-br" />
      <div className="pulse-sys-inner">
        <div className="pulse-sys-name">{label}</div>
        <div className="pulse-orb-row">
          <div className={`pulse-orb ${isUp ? 'pulse-up' : 'pulse-down'}`} />
          <div className={`pulse-status-word ${isUp ? 'pulse-up' : 'pulse-down'}`}>{statusWord}</div>
        </div>
        {alertText && <div className={`pulse-sys-alert ${alertClass}`}>{alertText}</div>}
      </div>
    </div>
  );
}

export default function PulsePage() {
  const token = new URLSearchParams(window.location.search).get('t');

  const [tokenValid, setTokenValid] = useState(null);
  const [status, setStatus]         = useState(null);
  const [hsDids, setHsDids]         = useState(null);
  const [syncInfo, setSyncInfo]     = useState('Checking status...');
  const [time, setTime]             = useState(new Date());

  const prevDidStatus    = useRef(null);
  const prevMobileOk     = useRef(null);
  const prevIntegrOk     = useRef(null);
  const prevSavvyUp      = useRef(null);
  const prevMitelUp      = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!token) { setTokenValid(false); return; }
    fetch(`/api/tv-session/validate?t=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => setTokenValid(!!d.valid))
      .catch(() => setTokenValid(false));
  }, [token]);

  useEffect(() => {
    if (!tokenValid) return;

    async function fetchAll() {
      try {
        const [sRes, hsRes] = await Promise.all([
          fetch('/api/status'),
          fetch('/api/hubspot/dids'),
        ]);
        const s  = sRes.ok  ? await sRes.json()  : null;
        const hs = hsRes.ok ? await hsRes.json() : null;

        if (s) {
          const didUp    = (s.didStatus || 'UP') === 'UP';
          const mobileOk = s.mobileApp?.state !== 'DOWN' && !s.mobileApp?.messagesDown;
          const integrOk = !s.integrations?.messagesDown;
          const savvyUp  = s.savvyPhone?.state !== 'DOWN';
          const mitelUp  = s.mitelClassic?.state !== 'DOWN';

          if (prevDidStatus.current !== null && prevDidStatus.current && !didUp) spawnRainDown();
          if (prevDidStatus.current !== null && !prevDidStatus.current && didUp) spawnMuscleRain();
          if (prevMobileOk.current !== null && prevMobileOk.current && !mobileOk) spawnRainDown();
          if (prevIntegrOk.current !== null && prevIntegrOk.current && !integrOk) spawnRainDown();
          if (prevSavvyUp.current  !== null && prevSavvyUp.current  && !savvyUp)  spawnRainDown();
          if (prevMitelUp.current  !== null && prevMitelUp.current  && !mitelUp)  spawnRainDown();

          prevDidStatus.current = didUp;
          prevMobileOk.current  = mobileOk;
          prevIntegrOk.current  = integrOk;
          prevSavvyUp.current   = savvyUp;
          prevMitelUp.current   = mitelUp;
        }

        setStatus(s);
        setHsDids(hs);
        setSyncInfo(`Live · Last sync: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      } catch (err) {
        setSyncInfo(`Sync error: ${err.message}`);
      }
    }

    fetchAll();
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [tokenValid]);

  if (tokenValid === null) {
    return <div className="pulse-page pulse-loading"><span className="pulse-spinner" /></div>;
  }

  if (!tokenValid) {
    return (
      <div className="pulse-page pulse-denied">
        <div>
          <h2>Access Denied</h2>
          <p>Open this display from the Operations Dashboard.</p>
        </div>
      </div>
    );
  }

  const didUp    = (status?.didStatus || 'UP') === 'UP';
  const mobileUp = status?.mobileApp?.state !== 'DOWN';
  const mobileMsgsOk = !status?.mobileApp?.messagesDown;
  const integrMsgsOk = !status?.integrations?.messagesDown;
  const savvyUp  = status?.savvyPhone?.state !== 'DOWN';
  const mitelUp  = status?.mitelClassic?.state !== 'DOWN';
  const allOp    = savvyUp && mitelUp && mobileUp && mobileMsgsOk && integrMsgsOk && didUp;

  const mobileOk = mobileUp && mobileMsgsOk;
  const mobileStatusWord = mobileOk ? 'Operational' : ((!mobileUp && !mobileMsgsOk) ? 'Down' : 'Degraded');
  const mobileAlertClass = !mobileUp ? 'pulse-alert-app' : 'pulse-alert-messages';
  const mobileAlertText  = !mobileUp ? 'Mobile App is DOWN — messages cannot reach it.'
    : (!mobileMsgsOk ? 'App is up, but messages are NOT routing into it.' : null);

  const integrOk = integrMsgsOk;
  const integrAlertText = !integrMsgsOk ? 'Messages are NOT hitting customer CRMs — their CRM may still be up.' : null;

  const didPool        = hsDids?.didPool        ?? null;
  const instantDidPool = hsDids?.instantDidPool ?? null;

  return (
    <div className="pulse-page">
      <div className="pulse-stripe-top" />
      <div className="pulse-stripe-bottom" />
      <div className="pulse-diag-lines" />

      <div className="pulse-wrapper">
        <div className="pulse-header">
          <div className="pulse-header-left">
            <img className="pulse-header-logo" src="/al-logo.png" alt="AL" />
            <div>
              <div className="pulse-header-brand">Answering Legal</div>
              <div className="pulse-header-sub">Sales / Support Teams</div>
            </div>
          </div>
          <div className="pulse-header-center">
            <div className="pulse-header-title">Dialed In Dash</div>
          </div>
          <div className="pulse-header-right">
            <div className="pulse-clock">{time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}</div>
            <div className="pulse-date">{time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          </div>
        </div>

        <div className="pulse-main-grid">
          {/* DID panel */}
          <div className={`pulse-did-panel${didUp ? '' : ' pulse-down'}`}>
            <div className="pulse-panel-accent" />
            <div className="pulse-corner pulse-corner-tl" /><div className="pulse-corner pulse-corner-tr" />
            <div className="pulse-corner pulse-corner-bl" /><div className="pulse-corner pulse-corner-br" />
            <div className="pulse-panel-inner">
              <div className="pulse-did-hero-label">DID Availability</div>
              <div className={`pulse-did-status-pill ${didUp ? 'pulse-up' : 'pulse-down'}`}>
                <span className="pulse-did-pill-dot" />
                <span>{didUp ? 'DIDs Available' : 'DIDs Unavailable'}</span>
              </div>
              {didUp && (
                <div className="pulse-pool-counts">
                  <div className="pulse-pool-row">
                    <span className="pulse-pool-label">DID Pool</span>
                    <span className={`pulse-pool-count${didPool === 0 ? ' pulse-zero' : ''}`}>{didPool !== null ? didPool : '—'}</span>
                  </div>
                  <div className="pulse-pool-row">
                    <span className="pulse-pool-label">Instant DID Pool</span>
                    <span className={`pulse-pool-count${instantDidPool === 0 ? ' pulse-zero' : ''}`}>{instantDidPool !== null ? instantDidPool : '—'}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Systems col */}
          <div className="pulse-systems-col">
            <SysPanel
              label="📱 Mobile App"
              isUp={mobileOk}
              statusWord={mobileStatusWord}
              alertClass={mobileAlertClass}
              alertText={mobileAlertText}
            />
            <SysPanel
              label="🔗 Integrations"
              isUp={integrOk}
              statusWord={integrOk ? 'Operational' : 'Degraded'}
              alertClass="pulse-alert-messages"
              alertText={integrAlertText}
            />
          </div>
        </div>

        <div className="pulse-footer">
          <div className={`pulse-global-pill ${allOp ? 'pulse-operational' : 'pulse-standby'}`}>
            <span className="pulse-global-dot" />
            <span>{allOp ? 'All Systems Operational' : 'System Degraded'}</span>
          </div>
          <div className="pulse-sync-info">{syncInfo}</div>
        </div>
      </div>
    </div>
  );
}
