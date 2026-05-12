require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { passport, requireAuth, requireRole, listUsers, addUser, removeUser } = require('./auth');

https.globalAgent.setMaxListeners(50);
require('events').EventEmitter.defaultMaxListeners = 50;

const app = express();
const PORT = process.env.PORT || 3001;

let mitelQueueCache = null;
const mitelSseClients = new Set();

// ─── Tutorial helpers ─────────────────────────────────────────────────────────
const TUTORIALS_FILE = path.join(__dirname, 'tutorials.json');
const USERS_FILE     = path.join(__dirname, 'users.json');

function loadTutorials() {
  try { return JSON.parse(fs.readFileSync(TUTORIALS_FILE, 'utf8')); } catch { return {}; }
}
function saveTutorials(t) { fs.writeFileSync(TUTORIALS_FILE, JSON.stringify(t, null, 2)); }

function dismissTutorialForUser(email, id) {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!users[email]) return;
    const d = users[email].dismissedTutorials || [];
    if (!d.includes(id)) { users[email].dismissedTutorials = [...d, id]; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  } catch {}
}
function resetTutorialDismissals(id) {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const email of Object.keys(users)) {
      if (users[email].dismissedTutorials) users[email].dismissedTutorials = users[email].dismissedTutorials.filter(x => x !== id);
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch {}
}

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
  credentials: true,
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Embeddable Widget (allow iframing from any origin) ───────────────────────
app.get('/widget', (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.sendFile(path.join(__dirname, 'public', 'CCOB_Widget.html'));
});

// ─── TV Session Token Store ───────────────────────────────────────────────────
const TV_SESSIONS_FILE = path.join(__dirname, 'tv-sessions.json');

function loadTvSessions() {
  try {
    const raw = fs.readFileSync(TV_SESSIONS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    const map = new Map();
    for (const [t, exp] of Object.entries(obj)) {
      if (exp > now) map.set(t, exp);
    }
    return map;
  } catch { return new Map(); }
}

function saveTvSessions(map) {
  const obj = {};
  for (const [t, exp] of map) obj[t] = exp;
  fs.writeFileSync(TV_SESSIONS_FILE, JSON.stringify(obj));
}

const tvSessions = loadTvSessions();

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tvSessions) if (exp < now) tvSessions.delete(t);
  saveTvSessions(tvSessions);
}, 60 * 60 * 1000);

// ─── Serve React app (production build) ──────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'public', 'app', 'assets')));

// ─── TV Session: Validate Token (no auth required — used by TV display pages) ─
app.get('/api/tv-session/validate', (req, res) => {
  const t = req.query.t;
  const exp = t && tvSessions.get(t);
  res.json({ valid: !!(t && exp && exp > Date.now()) });
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/auth/google', authLimiter, passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', authLimiter,
  passport.authenticate('google', { failureRedirect: '/login?error=unauthorized' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

app.get('/api/me', (req, res) => {
  const isDev = process.env.NODE_ENV !== 'production' && !process.env.GOOGLE_CLIENT_ID;
  if (isDev) {
    return res.json({ authenticated: true, user: { email: 'dev@local', name: 'Dev User', role: 'super_admin' } });
  }
  if (req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  res.json({ authenticated: false });
});

// ─── Slack Config (authenticated) ────────────────────────────────────────────
app.get('/api/slack-config', requireAuth, (req, res) => {
  res.json({
    didsUnavailable: process.env.SLACK_DID_UNAVAILABLE_URL || '',
    didsAvailable:   process.env.SLACK_DID_AVAILABLE_URL   || '',
    savvyActive:     process.env.SLACK_SAVVY_ACTIVE_URL    || '',
    savvyInactive:   process.env.SLACK_SAVVY_INACTIVE_URL  || '',
  });
});

// ─── User Management (super_admin only) ──────────────────────────────────────
app.get('/api/users', requireRole('super_admin'), (req, res) => {
  const users = listUsers();
  res.json({ users: Object.entries(users).map(([email, u]) => ({ email, ...u })) });
});

app.post('/api/users', requireRole('super_admin'), (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name || !role) return res.status(400).json({ error: 'email, name, and role are required' });
  if (!['super_admin', 'call_center_ops', 'tv_display', 'support'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  addUser(email, name, role);
  res.json({ success: true });
});

app.delete('/api/users/:email', requireRole('super_admin'), (req, res) => {
  removeUser(req.params.email);
  res.json({ success: true });
});

// ─── Tutorial Routes ──────────────────────────────────────────────────────────
// Tutorials the current user should see (enabled + role/user match + not dismissed)
app.get('/api/tutorials', requireAuth, (req, res) => {
  const tutorials = loadTutorials();
  const users     = listUsers();
  const dismissed = users[req.user.email]?.dismissedTutorials || [];
  const { role, email } = req.user;
  const visible = Object.values(tutorials).filter(t => {
    if (!t.enabled) return false;
    if (dismissed.includes(t.id)) return false;
    const roles = t.enabledRoles || t.roles || [];
    const ulist = t.enabledUsers || [];
    return roles.includes('all') || roles.includes(role) || ulist.includes(email);
  });
  res.json({ tutorials: visible });
});

// Permanently dismiss a tutorial for the current user
app.post('/api/tutorials/:id/dismiss', requireAuth, (req, res) => {
  dismissTutorialForUser(req.user.email, req.params.id);
  res.json({ success: true });
});

// Admin: list all tutorials with config
app.get('/api/tutorials/admin', requireRole('super_admin'), (req, res) => {
  res.json({ tutorials: Object.values(loadTutorials()) });
});

// Admin: update tutorial config (enabled, enabledRoles, enabledUsers, resetDismissals)
app.patch('/api/tutorials/:id', requireRole('super_admin'), (req, res) => {
  const tutorials = loadTutorials();
  if (!tutorials[req.params.id]) return res.status(404).json({ error: 'Not found' });
  const t = tutorials[req.params.id];
  if (req.body.enabled       !== undefined) t.enabled      = req.body.enabled;
  if (req.body.enabledRoles  !== undefined) t.enabledRoles = req.body.enabledRoles;
  if (req.body.enabledUsers  !== undefined) t.enabledUsers = req.body.enabledUsers;
  saveTutorials(tutorials);
  if (req.body.resetDismissals) resetTutorialDismissals(req.params.id);
  res.json({ success: true, tutorial: t });
});

// ─── Dashboard Routes ─────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.redirect('/'));
app.get('/mobile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));

// ─── TV Session: Generate Token ───────────────────────────────────────────────
app.post('/api/tv-session', requireAuth, (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  tvSessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  saveTvSessions(tvSessions);
  res.json({ token });
});

// ─── TV Display Routes (token validated client-side by React) ─────────────────
app.get('/dialed-in',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));
app.get('/dialed-in-pulse', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'index.html')));

// ─── Status Store (persisted to disk) ────────────────────────────────────────
const STATUS_FILE = path.join(__dirname, 'status-store.json');

// ─── Activity Log ─────────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'activity-log.json');
const LOG_MAX  = 500;

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}
function saveLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries));
}

let activityLog = loadLog();

app.get('/api/activity-log', requireAuth, (req, res) => {
  res.json(activityLog);
});

app.post('/api/activity-log', requireAuth, (req, res) => {
  const { msg, type, user } = req.body;
  if (!msg) return res.status(400).json({ error: 'msg required' });
  const entry = {
    time: new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }),
    user: user || req.user?.name || '',
    userPicture: req.user?.picture || '',
    msg,
    type: type || 'info',
  };
  activityLog = [entry, ...activityLog].slice(0, LOG_MAX);
  saveLog(activityLog);
  res.json({ ok: true });
});

function loadStatusStore() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return {
      savvyPhone:   { state: 'UP', didCount: null, message: '', changedBy: '', changedAt: null },
      mitelClassic: { state: 'UP', didCount: null, message: '', changedBy: '', changedAt: null },
      mobileApp:    { state: 'UP', messagesDown: false, message: '', changedBy: '', changedAt: null },
      integrations: { state: 'UP', messagesDown: false, message: '', changedBy: '', changedAt: null },
      didStatus: 'UP',
      systemsMessage: '',
      publicState: 'operational',
      updatedAt: null,
    };
  }
}

function saveStatusStore() {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(statusStore));
}

let statusStore = loadStatusStore();

app.get('/api/status', (req, res) => {
  res.json(statusStore);
});

app.post('/api/status', requireAuth, async (req, res) => {
  const { savvyPhone, mitelClassic, mobileApp, integrations, publicState, didStatus, systemsMessage, updatedAt } = req.body;

  const changedBy = req.user?.name || req.user?.email || 'Unknown';

  function stampChange(obj) {
    if (!obj) return obj;
    return { ...obj, changedBy, changedAt: obj.changedAt || new Date().toISOString() };
  }

  if (savvyPhone)   statusStore.savvyPhone   = { ...statusStore.savvyPhone,   ...stampChange(savvyPhone) };
  if (mitelClassic) statusStore.mitelClassic = { ...statusStore.mitelClassic, ...stampChange(mitelClassic) };
  if (mobileApp)    statusStore.mobileApp    = { ...statusStore.mobileApp,    ...stampChange(mobileApp) };
  if (integrations) statusStore.integrations = { ...statusStore.integrations, ...stampChange(integrations) };
  if (publicState)                statusStore.publicState    = publicState;
  if (didStatus !== undefined)    statusStore.didStatus      = didStatus;
  if (systemsMessage !== undefined) statusStore.systemsMessage = systemsMessage;
  statusStore.updatedAt = updatedAt || new Date().toISOString();
  saveStatusStore();

  res.json({ success: true });
});

// ─── Slack Workflows (persisted) ─────────────────────────────────────────────
const WORKFLOWS_FILE = path.join(__dirname, 'slack-workflows.json');

const BUILTIN_WORKFLOWS = [
  { id: 'builtin_didsUnavailable', name: 'DIDs Unavailable',     scope: 'DID Status',  icon: '🔴', builtin: true, envKey: 'SLACK_DID_UNAVAILABLE_URL' },
  { id: 'builtin_didsAvailable',   name: 'DIDs Available',       scope: 'DID Status',  icon: '🟢', builtin: true, envKey: 'SLACK_DID_AVAILABLE_URL'   },
  { id: 'builtin_savvyActive',     name: 'Savvy Phone Active',   scope: 'Savvy Phone', icon: '✅', builtin: true, envKey: 'SLACK_SAVVY_ACTIVE_URL'    },
  { id: 'builtin_savvyInactive',   name: 'Savvy Phone Inactive', scope: 'Savvy Phone', icon: '⚠️', builtin: true, envKey: 'SLACK_SAVVY_INACTIVE_URL'  },
];

function loadWorkflows() {
  let stored = [];
  try { stored = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')); } catch { stored = []; }
  const storedIds = new Set(stored.map(w => w.id));
  for (const b of BUILTIN_WORKFLOWS) {
    if (!storedIds.has(b.id)) stored.unshift({ ...b, url: process.env[b.envKey] || '', description: '' });
  }
  return stored;
}

function saveWorkflows(wfs) {
  fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(wfs));
}

function auditWorkflow(msg, userName, userPicture) {
  const entry = {
    time: new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }),
    user: userName || '',
    userPicture: userPicture || '',
    msg,
    type: 'info',
  };
  activityLog = [entry, ...activityLog].slice(0, LOG_MAX);
  saveLog(activityLog);
}

app.get('/api/slack/workflows', requireAuth, (req, res) => {
  res.json(loadWorkflows());
});

app.post('/api/slack/workflows', requireAuth, (req, res) => {
  const { name, scope, icon, url, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const wfs = loadWorkflows();
  const wf = {
    id: `custom_${Date.now()}`,
    name: name.trim(),
    scope: (scope || '').trim(),
    icon: icon || '⚡',
    url: (url || '').trim(),
    description: (description || '').trim(),
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  wfs.push(wf);
  saveWorkflows(wfs);
  auditWorkflow(`Added Slack workflow: "${wf.name}"`, req.user?.name, req.user?.picture);
  res.json(wf);
});

app.put('/api/slack/workflows/:id', requireAuth, (req, res) => {
  const wfs = loadWorkflows();
  const idx = wfs.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Workflow not found' });
  const prev = wfs[idx].name;
  const { name, scope, icon, url, description } = req.body;
  wfs[idx] = {
    ...wfs[idx],
    name: (name || wfs[idx].name).trim(),
    scope: scope !== undefined ? scope.trim() : wfs[idx].scope,
    icon: icon || wfs[idx].icon,
    url: url !== undefined ? url.trim() : wfs[idx].url,
    description: description !== undefined ? description.trim() : (wfs[idx].description || ''),
    updatedAt: new Date().toISOString(),
  };
  saveWorkflows(wfs);
  const label = name && name.trim() !== prev ? `"${prev}" → "${name.trim()}"` : `"${prev}"`;
  auditWorkflow(`Updated Slack workflow: ${label}`, req.user?.name, req.user?.picture);
  res.json(wfs[idx]);
});

app.delete('/api/slack/workflows/:id', requireAuth, (req, res) => {
  const wfs = loadWorkflows();
  const target = wfs.find(w => w.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Workflow not found' });
  if (target.builtin) return res.status(403).json({ error: 'Built-in workflows cannot be deleted' });
  saveWorkflows(wfs.filter(w => w.id !== req.params.id));
  auditWorkflow(`Deleted Slack workflow: "${target.name}"`, req.user?.name, req.user?.picture);
  res.json({ ok: true });
});

// ─── Slack Proxy ──────────────────────────────────────────────────────────────
app.post('/api/slack/notify', requireAuth, async (req, res) => {
  const { url, text } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (url.includes('slack.com/shortcuts/')) {
    return res.json({ success: true, openUrl: url });
  }
  try {
    await axios.post(url, { text });
    res.json({ success: true });
  } catch (err) {
    console.error('Slack proxy error:', err.message);
    res.status(500).json({ error: 'Failed to notify Slack', details: err.message });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', requireRole('super_admin'), (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── EZTexting: Get Groups ─────────────────────────────────────────────────────
app.get('/api/eztexting/groups', requireAuth, async (req, res) => {
  try {
    const username = process.env.EZTEXTING_USERNAME;
    const password = process.env.EZTEXTING_PASSWORD;

    if (!username || !password) {
      return res.status(500).json({ error: 'EZTexting credentials not configured' });
    }

    const groups = [];
    let page = 1;
    while (true) {
      const response = await axios.get('https://app.eztexting.com/groups', {
        params: { User: username, Password: password, format: 'json', ResultsPerPage: 100, Page: page },
      });
      const entries = response.data?.Response?.Entries || [];
      if (!entries.length) break;
      groups.push(...entries);
      page++;
    }
    res.json({ groups });
  } catch (err) {
    console.error('EZTexting groups error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch EZTexting groups', details: err.message });
  }
});

// ─── EZTexting: Send SMS ───────────────────────────────────────────────────────
app.post('/api/eztexting/send', requireAuth, async (req, res) => {
  try {
    const { groups, phoneNumber, message } = req.body;

    if ((!groups || !groups.length) && !phoneNumber) {
      return res.status(400).json({ error: 'groups or phoneNumber and message are required' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const username = process.env.EZTEXTING_USERNAME;
    const password = process.env.EZTEXTING_PASSWORD;

    if (!username || !password) {
      return res.status(500).json({ error: 'EZTexting credentials not configured' });
    }

    const form = new URLSearchParams();
    form.append('User', username);
    form.append('Password', password);
    form.append('Message', message);
    form.append('SendingTime', 'now');

    if (groups && groups.length) {
      groups.forEach(g => form.append('Groups[]', g));
    }
    if (phoneNumber) {
      form.append('PhoneNumbers[]', phoneNumber.replace(/\D/g, ''));
    }

    const response = await axios.post(
      'https://app.eztexting.com/sending/messages',
      form,
      {
        params: { format: 'json' },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    res.json({ success: true, result: response.data, sentAt: new Date().toISOString() });
  } catch (err) {
    console.error('EZTexting send error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  }
});

// ─── SMS.to: Send to List (Team B / Belize) ───────────────────────────────────
app.post('/api/smsto/send', requireAuth, async (req, res) => {
  const apiKey = process.env.SMSTO_API_KEY;
  const listId = process.env.SMSTO_LIST_ID;
  const { message } = req.body;

  if (!apiKey) return res.status(500).json({ error: 'SMSTO_API_KEY not set in .env' });
  if (!listId) return res.status(500).json({ error: 'SMSTO_LIST_ID not set in .env' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const response = await axios.post(
      'https://api.sms.to/sms/send',
      { message, list_id: parseInt(listId, 10) },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, result: response.data, sentAt: new Date().toISOString() });
  } catch (err) {
    console.error('SMS.to send error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send via SMS.to', details: err.response?.data || err.message });
  }
});

// ─── Bandwidth: DID Counts ─────────────────────────────────────────────────────
app.get('/api/bandwidth/dids', async (req, res) => {
  try {
    const accountId = process.env.BANDWIDTH_ACCOUNT_ID;
    const clientId = process.env.BANDWIDTH_API_TOKEN;
    const clientSecret = process.env.BANDWIDTH_API_SECRET;
    const savvySiteId = process.env.BANDWIDTH_SAVVY_SITE_ID;
    const savvyPeerId = process.env.BANDWIDTH_SAVVY_PEER_ID;
    const mitelSiteId = process.env.BANDWIDTH_MITEL_SITE_ID;
    const mitelPeerId = process.env.BANDWIDTH_MITEL_PEER_ID;

    if (!accountId || !clientId || !clientSecret) {
      return res.status(500).json({ error: 'Bandwidth credentials not configured' });
    }

    const tokenResponse = await axios.post(
      'https://api.bandwidth.com/api/v1/oauth2/token',
      'grant_type=client_credentials',
      {
        auth: { username: clientId, password: clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    const accessToken = tokenResponse.data.access_token;
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const totalResponse = await axios.get('https://api.bandwidth.com/api/tns', {
      headers: { ...authHeader, Accept: 'application/xml' },
      params: { size: 1 },
    });
    const totalMatch = totalResponse.data.match(/<TelephoneNumberCount>(\d+)<\/TelephoneNumberCount>/);
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;

    async function countPeerTns(siteId, peerId) {
      if (!siteId || !peerId) return 0;
      let count = 0;
      let cursor = null;

      while (true) {
        const params = { size: 500 };
        if (cursor) params.page = cursor;

        const r = await axios.get(
          `https://api.bandwidth.com/api/accounts/${accountId}/sites/${siteId}/sippeers/${peerId}/tns`,
          { headers: authHeader, params, maxRedirects: 5 }
        );
        const xml = r.data;
        count += (xml.match(/<FullNumber>/g) || []).length;

        const nextBlock = xml.match(/<next>(.*?)<\/next>/)?.[1];
        const nextCursor = nextBlock?.match(/page=(\d+)/)?.[1];
        if (!nextCursor || nextCursor === '1') break;
        cursor = nextCursor;
      }
      return count;
    }

    const [savvy, mitel] = await Promise.all([
      countPeerTns(savvySiteId, savvyPeerId),
      countPeerTns(mitelSiteId, mitelPeerId),
    ]);

    res.json({ savvy, mitel, total, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Bandwidth DID error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch Bandwidth DID counts', details: err.message });
  }
});

// ─── Wix: Push Status ─────────────────────────────────────────────────────────
app.post('/api/wix/status', requireRole('super_admin'), async (req, res) => {
  try {
    const { centers } = req.body;

    if (!centers || !Array.isArray(centers)) {
      return res.status(400).json({ error: 'centers array is required' });
    }

    const siteId = process.env.WIX_SITE_ID;
    const apiKey = process.env.WIX_API_KEY;
    const accountId = process.env.WIX_ACCOUNT_ID;
    const collectionName = process.env.WIX_COLLECTION_NAME || 'SystemStatus';

    if (!siteId || !apiKey) {
      return res.status(500).json({ error: 'Wix credentials not configured' });
    }

    const wixHeaders = {
      Authorization: apiKey,
      'wix-site-id': siteId,
      'Content-Type': 'application/json',
      ...(accountId && { 'wix-account-id': accountId }),
    };

    const results = [];

    for (const center of centers) {
      const { name, status, message } = center;

      const queryResponse = await axios.post(
        `https://www.wixapis.com/wix-data/v2/items/query`,
        {
          dataCollectionId: collectionName,
          query: {
            filter: { name: { $eq: name } },
            paging: { limit: 1 },
          },
        },
        { headers: wixHeaders }
      );

      const existingItems = queryResponse.data?.dataItems || [];
      const now = new Date().toISOString();

      if (existingItems.length > 0) {
        const itemId = existingItems[0]._id;
        await axios.patch(
          `https://www.wixapis.com/wix-data/v2/items/${itemId}`,
          {
            dataCollectionId: collectionName,
            dataItem: { data: { name, status, message, updatedAt: now } },
          },
          { headers: wixHeaders }
        );
        results.push({ name, action: 'updated' });
      } else {
        await axios.post(
          `https://www.wixapis.com/wix-data/v2/items`,
          {
            dataCollectionId: collectionName,
            dataItem: { data: { name, status, message, updatedAt: now } },
          },
          { headers: wixHeaders }
        );
        results.push({ name, action: 'created' });
      }
    }

    res.json({ success: true, results, pushedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Wix status push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to push Wix status', details: err.message });
  }
});

// ─── Wix: Get Status ──────────────────────────────────────────────────────────
app.get('/api/wix/status', requireAuth, async (req, res) => {
  try {
    const siteId = process.env.WIX_SITE_ID;
    const apiKey = process.env.WIX_API_KEY;
    const accountId = process.env.WIX_ACCOUNT_ID;
    const collectionName = process.env.WIX_COLLECTION_NAME || 'SystemStatus';

    if (!siteId || !apiKey) {
      return res.status(500).json({ error: 'Wix credentials not configured' });
    }

    const wixHeaders = {
      Authorization: apiKey,
      'wix-site-id': siteId,
      'Content-Type': 'application/json',
      ...(accountId && { 'wix-account-id': accountId }),
    };

    const response = await axios.post(
      `https://www.wixapis.com/wix-data/v2/items/query`,
      {
        dataCollectionId: collectionName,
        query: { paging: { limit: 50 } },
      },
      { headers: wixHeaders }
    );

    const items = (response.data?.dataItems || []).map((item) => item.data);
    res.json({ centers: items });
  } catch (err) {
    console.error('Wix get status error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get Wix status', details: err.message });
  }
});

// ─── Monday.com: Get Agents (cursor-paginated) ───────────────────────────────
app.get('/api/monday/agents', requireAuth, async (req, res) => {
  const apiKey         = process.env.MONDAY_API_KEY;
  const boardId        = process.env.MONDAY_BOARD_ID;
  const statusColumnId = process.env.MONDAY_STATUS_COLUMN_ID    || 'status';
  const ccColumnId     = process.env.MONDAY_CALLCENTER_COLUMN_ID || 'color_mkvtbm60';
  const hereLabel      = process.env.MONDAY_HERE_LABEL           || 'Here';
  const standbyLabel   = process.env.MONDAY_STANDBY_LABEL        || 'On Standby';

  if (!apiKey || !boardId) {
    return res.status(500).json({ error: 'Monday.com credentials not configured' });
  }

  const headers = { Authorization: apiKey, 'Content-Type': 'application/json' };
  const itemFields = `id name updated_at column_values(ids: ["${statusColumnId}", "${ccColumnId}"]) { id text }`;

  try {
    const allItems = [];
    let cursor = null;

    do {
      const query = cursor
        ? `query { next_items_page(limit: 200, cursor: "${cursor}") { cursor items { ${itemFields} } } }`
        : `query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { ${itemFields} } } } }`;

      const response = await axios.post('https://api.monday.com/v2', { query }, { headers });

      const page = cursor
        ? response.data?.data?.next_items_page
        : response.data?.data?.boards?.[0]?.items_page;

      allItems.push(...(page?.items || []));
      cursor = page?.cursor || null;
    } while (cursor);

    const agents = allItems
      .filter(item => {
        const statusCol = item.column_values?.find(c => c.id === statusColumnId);
        const s = statusCol?.text || '';
        return s === hereLabel || s === standbyLabel;
      })
      .map(item => {
        const statusCol = item.column_values?.find(c => c.id === statusColumnId);
        const ccCol     = item.column_values?.find(c => c.id === ccColumnId);
        return {
          id:         item.id,
          name:       item.name,
          status:     statusCol?.text || '',
          callCenter: ccCol?.text     || '',
          lastUpdate: item.updated_at,
        };
      });

    res.json({ agents });
  } catch (err) {
    console.error('Monday agents error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch Monday.com agents', details: err.message });
  }
});

// ─── Monday.com: Move Agent to Standby ────────────────────────────────────────
app.post('/api/monday/agent/:id/standby', requireAuth, async (req, res) => {
  const apiKey = process.env.MONDAY_API_KEY;
  const boardId = process.env.MONDAY_BOARD_ID;
  const statusColumnId = process.env.MONDAY_STATUS_COLUMN_ID;
  const standbyLabel = process.env.MONDAY_STANDBY_LABEL || 'Standby';

  if (!apiKey || !boardId || !statusColumnId) {
    return res.status(500).json({ error: 'Monday.com credentials not configured' });
  }

  const mutation = `mutation {
    change_simple_column_value(
      board_id: ${boardId},
      item_id: ${req.params.id},
      column_id: "${statusColumnId}",
      value: "${standbyLabel}"
    ) { id }
  }`;

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: mutation },
      { headers: { Authorization: apiKey, 'Content-Type': 'application/json' } }
    );

    if (response.data?.errors) {
      throw new Error(response.data.errors[0]?.message || 'Monday.com mutation failed');
    }

    res.json({ success: true, itemId: req.params.id });
  } catch (err) {
    console.error('Monday standby error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to move agent to standby', details: err.message });
  }
});

// ─── Monday.com: Move Agent to Here ──────────────────────────────────────────
app.post('/api/monday/agent/:id/here', requireAuth, async (req, res) => {
  const apiKey         = process.env.MONDAY_API_KEY;
  const boardId        = process.env.MONDAY_BOARD_ID;
  const statusColumnId = process.env.MONDAY_STATUS_COLUMN_ID;
  const hereLabel      = process.env.MONDAY_HERE_LABEL || 'Here';

  if (!apiKey || !boardId || !statusColumnId) {
    return res.status(500).json({ error: 'Monday.com credentials not configured' });
  }

  const mutation = `mutation {
    change_simple_column_value(
      board_id: ${boardId},
      item_id: ${req.params.id},
      column_id: "${statusColumnId}",
      value: "${hereLabel}"
    ) { id }
  }`;

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: mutation },
      { headers: { Authorization: apiKey, 'Content-Type': 'application/json' } }
    );
    if (response.data?.errors) {
      throw new Error(response.data.errors[0]?.message || 'Monday.com mutation failed');
    }
    res.json({ success: true, itemId: req.params.id });
  } catch (err) {
    console.error('Monday here error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to move agent to here', details: err.message });
  }
});

// ─── Monday.com: Support Overdue Tasks ───────────────────────────────────────
app.get('/api/monday/support-tasks', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey  = process.env.MONDAY_API_KEY;
  const boardId = process.env.MONDAY_SUPPORT_TASK_BOARD_ID || '18358060875';
  if (!apiKey) return res.status(500).json({ error: 'Monday.com credentials not configured' });

  const headers = { Authorization: apiKey, 'Content-Type': 'application/json' };
  const itemFields = `id name updated_at column_values(ids: ["color_mkxwxqsx", "status", "date_mkx5zfsz", "dropdown_mkzc9hm", "text_mkx5ca0q", "text_mkx5cpnb", "dropdown_mkxjmeyh", "multiple_person_mkx5smfv"]) { id text value }`;

  try {
    const allItems = [];
    let cursor = null;

    do {
      const query = cursor
        ? `query { next_items_page(limit: 200, cursor: "${cursor}") { cursor items { ${itemFields} } } }`
        : `query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { ${itemFields} } } } }`;

      const response = await axios.post('https://api.monday.com/v2', { query }, { headers });
      if (response.data?.errors) throw new Error(response.data.errors[0]?.message);

      const page = cursor
        ? response.data?.data?.next_items_page
        : response.data?.data?.boards?.[0]?.items_page;

      allItems.push(...(page?.items || []));
      cursor = page?.cursor || null;
    } while (cursor);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const DONE_PHRASES = ['done', 'complete', 'closed', "won't fix", 'cancelled', 'resolved'];

    const mapped = allItems.map(item => {
      const statusCol   = item.column_values?.find(c => c.id === 'color_mkxwxqsx');
      const priorityCol = item.column_values?.find(c => c.id === 'status');
      const dateCol     = item.column_values?.find(c => c.id === 'date_mkx5zfsz');
      const taskTypeCol = item.column_values?.find(c => c.id === 'dropdown_mkzc9hm');
      const accountCol  = item.column_values?.find(c => c.id === 'text_mkx5ca0q');
      const descCol     = item.column_values?.find(c => c.id === 'text_mkx5cpnb');
      const assigneeCol = item.column_values?.find(c => c.id === 'multiple_person_mkx5smfv');

      // Extract time from date column raw value: {"date":"2024-01-15","time":"14:30:00"}
      let dueTime = '';
      try {
        const raw = dateCol?.value ? JSON.parse(dateCol.value) : null;
        if (raw?.time) dueTime = raw.time.slice(0, 5); // "HH:MM"
      } catch { /* ignore */ }

      return {
        id:          item.id,
        name:        item.name,
        status:      statusCol?.text  || '',
        priority:    priorityCol?.text || '',
        dueDate:     dateCol?.text    || '',
        dueTime,
        taskType:    taskTypeCol?.text || '',
        accountName: accountCol?.text  || '',
        description: descCol?.text     || '',
        assignee:    assigneeCol?.text  || '',
        lastUpdate:  item.updated_at,
        link:        `https://answeringlegal-unit.monday.com/boards/${boardId}/pulses/${item.id}`,
      };
    }).filter(task => {
      const statusLow = (task.status || '').toLowerCase();
      return !DONE_PHRASES.some(p => statusLow.includes(p));
    });

    const overdue  = mapped.filter(task => {
      const statusLow = (task.status || '').toLowerCase();
      if (statusLow === 'overdue') return true;
      if (!task.dueDate) return false;
      const due = new Date(task.dueDate); due.setHours(0, 0, 0, 0);
      return !isNaN(due) && due < today;
    });

    const upcoming = mapped.filter(task => {
      if (!task.dueDate) return false;
      const due = new Date(task.dueDate); due.setHours(0, 0, 0, 0);
      return !isNaN(due) && due >= today && due < tomorrow;
    });

    res.json({ tasks: overdue, overdue, upcoming });
  } catch (err) {
    console.error('Monday support tasks error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch support tasks', details: err.message });
  }
});

// ─── Monday.com: Support Task Board Stats ────────────────────────────────────
app.get('/api/monday/support-stats', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey  = process.env.MONDAY_API_KEY;
  const boardId = process.env.MONDAY_SUPPORT_TASK_BOARD_ID || '18358060875';
  if (!apiKey) return res.status(500).json({ error: 'Monday.com credentials not configured' });

  const headers = { Authorization: apiKey, 'Content-Type': 'application/json' };
  const itemFields = `id name updated_at column_values(ids: ["color_mkxwxqsx", "status", "date_mkx5zfsz", "dropdown_mkxjmeyh", "multiple_person_mkx5smfv", "dropdown_mkzc9hm"]) { id text }`;

  try {
    const allItems = [];
    let cursor = null;

    do {
      const query = cursor
        ? `query { next_items_page(limit: 200, cursor: "${cursor}") { cursor items { ${itemFields} } } }`
        : `query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { ${itemFields} } } } }`;

      const response = await axios.post('https://api.monday.com/v2', { query }, { headers });
      if (response.data?.errors) throw new Error(response.data.errors[0]?.message);

      const page = cursor
        ? response.data?.data?.next_items_page
        : response.data?.data?.boards?.[0]?.items_page;

      allItems.push(...(page?.items || []));
      cursor = page?.cursor || null;
    } while (cursor);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const byStatus = {};
    const byPriority = {};
    const bySquad = {};
    const byAssignee = {};
    let overdue = 0, dueToday = 0, dueThisWeek = 0;

    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));

    for (const item of allItems) {
      const statusText   = item.column_values?.find(c => c.id === 'color_mkxwxqsx')?.text || 'Not Set';
      const priorityText = item.column_values?.find(c => c.id === 'status')?.text || 'None';
      const dueDateText  = item.column_values?.find(c => c.id === 'date_mkx5zfsz')?.text || '';
      const squadText    = item.column_values?.find(c => c.id === 'dropdown_mkxjmeyh')?.text || 'Unassigned';
      const assigneeTxt  = item.column_values?.find(c => c.id === 'multiple_person_mkx5smfv')?.text || '';

      byStatus[statusText] = (byStatus[statusText] || 0) + 1;
      byPriority[priorityText] = (byPriority[priorityText] || 0) + 1;
      bySquad[squadText] = (bySquad[squadText] || 0) + 1;
      if (assigneeTxt) {
        for (const name of assigneeTxt.split(',').map(s => s.trim()).filter(Boolean)) {
          byAssignee[name] = (byAssignee[name] || 0) + 1;
        }
      }

      if (dueDateText) {
        const due = new Date(dueDateText);
        if (!isNaN(due)) {
          const dueDay = new Date(due); dueDay.setHours(0,0,0,0);
          if (dueDay < today) overdue++;
          else if (dueDay.getTime() === today.getTime()) dueToday++;
          else if (dueDay <= endOfWeek) dueThisWeek++;
        }
      }
      if ((statusText || '').toLowerCase() === 'overdue') overdue = Math.max(overdue, 1);
    }

    res.json({
      total: allItems.length,
      overdue,
      dueToday,
      dueThisWeek,
      byStatus:   Object.entries(byStatus).sort((a,b) => b[1]-a[1]).map(([label,count]) => ({ label, count })),
      byPriority: Object.entries(byPriority).sort((a,b) => b[1]-a[1]).map(([label,count]) => ({ label, count })),
      bySquad:    Object.entries(bySquad).sort((a,b) => b[1]-a[1]).map(([label,count]) => ({ label, count })),
      byAssignee: Object.entries(byAssignee).sort((a,b) => b[1]-a[1]).slice(0,10).map(([label,count]) => ({ label, count })),
    });
  } catch (err) {
    console.error('Monday support stats error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch support stats', details: err.message });
  }
});

// ─── Zendesk Helpers ─────────────────────────────────────────────────────────
function zdHeaders() {
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;
  if (!email || !token) throw new Error('Zendesk not configured');
  const encoded = Buffer.from(`${email}/token:${token}`).toString('base64');
  return { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' };
}

function zdBase() {
  const sub = process.env.ZENDESK_SUBDOMAIN;
  if (!sub) throw new Error('ZENDESK_SUBDOMAIN not configured');
  return `https://${sub}.zendesk.com/api/v2`;
}

// ─── Zendesk Group IDs ────────────────────────────────────────────────────────
const ZD_SUPPORT_GROUPS   = ['21144265188763', '29126651333275'];
const ZD_ESCALATION_GROUP = '37189086269723';
const ZD_SUPPORT_EXCLUDE_GROUPS = ['29755770910107']; // AL Intake Chat Pro — agents here excluded from support views
const TECH_GROUP_DEFS = [
  { id: '37940070419611', name: 'Tech Team' },
  { id: '21144204914587', name: 'Mobile App Team' },
  { id: '21144716643995', name: 'Integrations Team' },
  { id: '27880413441307', name: 'Legal Video Calls' },
  { id: '40495779771547', name: 'Intake Chat Pro' },
];
const ZD_TECH_GROUPS = TECH_GROUP_DEFS.map(g => g.id);

// Agents excluded from support leaderboard (managers, non-agents, etc.)
const SUPPORT_LB_EXCLUDE = ['chrissy'];

async function zdGroupMembers(base, headers, groupIds) {
  const sets = await Promise.all(groupIds.map(async id => {
    try {
      const r = await axios.get(`${base}/group_memberships.json?group_id=${id}&per_page=100`, { headers });
      return (r.data?.group_memberships || []).map(m => m.user_id);
    } catch { return []; }
  }));
  return [...new Set(sets.flat())];
}

function subtractBusinessHours(date, hours) {
  const result = new Date(date);
  let remaining = hours;
  while (remaining > 0) {
    result.setTime(result.getTime() - 3600000);
    const day = result.getDay(), hr = result.getHours();
    if (day >= 1 && day <= 5 && hr >= 9 && hr < 17) remaining--;
  }
  return result;
}

// ─── Zendesk: Stale Tickets (NEW/OPEN, not touched N+ biz hours) ─────────────
app.get('/api/zendesk/stale-tickets', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const headers = zdHeaders();
    const base    = zdBase();
    const hours   = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
    const cutoff  = subtractBusinessHours(new Date(), hours);
    const sub     = process.env.ZENDESK_SUBDOMAIN;
    const team    = req.query.team || null;

    // Format date for Zendesk search (YYYY-MM-DD HH:MM avoids ISO colon encoding issues)
    const pad = n => String(n).padStart(2, '0');
    const zdDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

    // Build group filter for team-scoped views
    // Support also claims tickets with no group/assignee (unrouted new tickets)
    let groupFilter = '';
    if (team) {
      const groups = team === 'tech' ? ZD_TECH_GROUPS : [...ZD_SUPPORT_GROUPS, ZD_ESCALATION_GROUP];
      groupFilter = ' ' + groups.map(id => `group_id:${id}`).join(' ');
      if (team !== 'tech') groupFilter += ' group_id:none';
    }

    const query = `type:ticket status:new status:open -status:solved -status:closed -status:deleted updated<${zdDate(cutoff)}${groupFilter}`;

    const resp = await axios.get(`${base}/search.json`, {
      headers,
      params: { query, sort_by: 'updated_at', sort_order: 'asc', per_page: 100 },
    });

    const tickets = (resp.data?.results || [])
      .filter(t => t.status === 'new' || t.status === 'open')
      .map(t => ({
        id:        t.id,
        subject:   t.subject,
        status:    t.status,
        updatedAt: t.updated_at,
        link:      `https://${sub}.zendesk.com/agent/tickets/${t.id}`,
      }))
      .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

    res.json({ tickets, hours, cutoff: cutoff.toISOString() });
  } catch (err) {
    if (err.message === 'Zendesk not configured') return res.json({ tickets: [], unconfigured: true });
    console.error('Zendesk stale tickets error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch stale tickets', details: err.message });
  }
});

// ─── Zendesk: CSAT Ratings ───────────────────────────────────────────────────
app.get('/api/zendesk/csat', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const headers = zdHeaders();
    const base    = zdBase();
    const sub     = process.env.ZENDESK_SUBDOMAIN;

    // Resolve start time from period param (or legacy days param)
    const period = req.query.period;
    let startTime = null;
    if (period && period !== 'all') {
      const now = new Date();
      let start;
      if      (period === 'today')      { start = new Date(now); start.setUTCHours(0, 0, 0, 0); }
      else if (period === 'yesterday')  { start = new Date(now); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(0, 0, 0, 0); }
      else if (period === '90d')        { start = new Date(now); start.setUTCDate(start.getUTCDate() - 90); }
      else if (period === '180d')       { start = new Date(now); start.setUTCDate(start.getUTCDate() - 180); }
      else if (period === 'this-week')  {
        start = new Date(now);
        const dow = now.getUTCDay();
        start.setUTCDate(now.getUTCDate() - (dow === 0 ? 6 : dow - 1));
        start.setUTCHours(0, 0, 0, 0);
      }
      else if (period === 'last-week')  {
        start = new Date(now);
        const dow = now.getUTCDay();
        start.setUTCDate(now.getUTCDate() - (dow === 0 ? 6 : dow - 1) - 7);
        start.setUTCHours(0, 0, 0, 0);
      }
      else if (period === 'last-month') {
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      }
      if (start) startTime = Math.floor(start.getTime() / 1000);
    } else {
      const days = Math.min(parseInt(req.query.days) || 180, 365);
      const since = new Date();
      since.setDate(since.getDate() - days);
      startTime = Math.floor(since.getTime() / 1000);
    }

    const stParam = startTime ? `&start_time=${startTime}` : '';
    const [goodRes, badRes] = await Promise.all([
      axios.get(`${base}/satisfaction_ratings.json?score=good&sort_order=desc&per_page=100${stParam}`, { headers }),
      axios.get(`${base}/satisfaction_ratings.json?score=bad&sort_order=desc&per_page=100${stParam}`, { headers }),
    ]);

    // Build optional team filter — use group membership for team-scoped filtering
    let teamAgentIds = null;
    const team = req.query.team || null;
    if (team) {
      try {
        const groupIds  = team === 'tech' ? ZD_TECH_GROUPS : [...ZD_SUPPORT_GROUPS, ZD_ESCALATION_GROUP];
        const memberIds = await zdGroupMembers(base, headers, groupIds);
        if (memberIds.length) teamAgentIds = new Set(memberIds);
      } catch { /* non-fatal — fall through to unfiltered */ }
    }

    const byTeam = r => !teamAgentIds || teamAgentIds.has(r.assignee_id);

    const mapRating = (r, score) => ({
      id:        r.id,
      score,
      comment:   r.comment || '',
      createdAt: r.created_at,
      ticketId:  r.ticket_id,
      requester: r.requester?.name || '',
      link:      `https://${sub}.zendesk.com/agent/tickets/${r.ticket_id}`,
    });

    const goodAll = (goodRes.data?.satisfaction_ratings || [])
      .filter(r => byTeam(r) && r.comment && r.comment.trim())
      .map(r => mapRating(r, 'good'));

    const badAll = (badRes.data?.satisfaction_ratings || [])
      .filter(r => byTeam(r))
      .map(r => mapRating(r, 'bad'));

    // Combined, most recent first (capped for list display)
    const ratings = [...goodAll, ...badAll]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 60);

    // Weekly trend — roll back to Monday for each rating's week
    const weeklyMap = {};
    [...goodAll, ...badAll].forEach(r => {
      const d   = new Date(r.createdAt);
      const dow = d.getUTCDay(); // 0=Sun
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      mon.setUTCHours(0, 0, 0, 0);
      const key = mon.toISOString().slice(0, 10);
      if (!weeklyMap[key]) weeklyMap[key] = { week: key, good: 0, bad: 0 };
      if (r.score === 'good') weeklyMap[key].good++;
      else weeklyMap[key].bad++;
    });
    const trend = Object.values(weeklyMap).sort((a, b) => a.week.localeCompare(b.week));

    res.json({ ratings, trend, totalGood: goodAll.length, totalBad: badAll.length });
  } catch (err) {
    if (err.message === 'Zendesk not configured') return res.json({ ratings: [], trend: [], totalGood: 0, totalBad: 0, unconfigured: true });
    console.error('Zendesk CSAT error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch CSAT ratings', details: err.message });
  }
});

// ─── Zendesk: Leaderboard — all active agents across all groups ───────────────
app.get('/api/zendesk/leaderboard', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const period = req.query.period || 'this-week';
  const team   = req.query.team   || 'support';

  try {
    const headers = zdHeaders();
    const base    = zdBase();

    // Resolve full user records
    const usersRes  = await axios.get(`${base}/users.json?role=agent&per_page=100`, { headers });
    const allAgents = (usersRes.data?.users || []).filter(u => u.active && !u.suspended);

    let users;
    const groupIds = team === 'tech' ? ZD_TECH_GROUPS : [...ZD_SUPPORT_GROUPS, ZD_ESCALATION_GROUP];

    // For tech: fetch per-group membership to build delineated sections
    let techGroupSets = null;
    if (team === 'tech') {
      techGroupSets = await Promise.all(
        TECH_GROUP_DEFS.map(async g => {
          const ids = await zdGroupMembers(base, headers, [g.id]);
          return { name: g.name, memberSet: new Set(ids) };
        })
      );
      const allTechIds = new Set(techGroupSets.flatMap(g => [...g.memberSet]));
      users = allAgents.filter(u => allTechIds.has(u.id));
    } else {
      const memberIds = await zdGroupMembers(base, headers, groupIds);
      if (!memberIds.length) return res.json({ support: [], escalation: [], csatGood: 0, csatBad: 0, zdSubdomain: process.env.ZENDESK_SUBDOMAIN || null });
      const memberSet = new Set(memberIds);
      const excludeIds = await zdGroupMembers(base, headers, ZD_SUPPORT_EXCLUDE_GROUPS);
      const excludeSet = new Set(excludeIds);
      users = allAgents
        .filter(u => memberSet.has(u.id))
        .filter(u => !excludeSet.has(u.id))
        .filter(u => !SUPPORT_LB_EXCLUDE.some(n => u.name.toLowerCase().includes(n)));
    }
    if (!users.length) return res.json({ sections: null, support: [], escalation: [], csatGood: 0, csatBad: 0, zdSubdomain: process.env.ZENDESK_SUBDOMAIN || null });

    // For support leaderboard: track escalation sub-section membership
    let escalationSet = new Set();
    if (team !== 'tech') {
      const escIds = await zdGroupMembers(base, headers, [ZD_ESCALATION_GROUP]);
      escalationSet = new Set(escIds);
    }
    const isEscalation = u => escalationSet.has(u.id);

    // Build date filter string for solved tickets
    const now    = new Date();
    const pad    = n => String(n).padStart(2, '0');
    const zdDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

    let solvedFilter = '';
    let replyFilter  = '';
    let periodStart  = null;
    if (period !== 'all') {
      let start, end;
      if      (period === 'today')     { start = new Date(now); start.setUTCHours(0, 0, 0, 0); }
      else if (period === 'yesterday') { start = new Date(now); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(0, 0, 0, 0); end = new Date(now); end.setUTCHours(0, 0, 0, 0); }
      else if (period === '90d')       { start = new Date(now); start.setUTCDate(start.getUTCDate() - 90); }
      else if (period === '180d')      { start = new Date(now); start.setUTCDate(start.getUTCDate() - 180); }
      else if (period === 'this-week') {
        start = new Date(now);
        const dow = now.getUTCDay();
        start.setUTCDate(now.getUTCDate() - (dow === 0 ? 6 : dow - 1));
        start.setUTCHours(0, 0, 0, 0);
      }
      else if (period === 'last-week') {
        const dow = now.getUTCDay();
        start = new Date(now);
        start.setUTCDate(now.getUTCDate() - (dow === 0 ? 6 : dow - 1) - 7);
        start.setUTCHours(0, 0, 0, 0);
        end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 6);
        end.setUTCHours(23, 59, 0, 0);
      }
      else if (period === 'last-month') {
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 0, 0));
      }
      if (start) {
        periodStart  = start;
        solvedFilter = ` solved>${zdDate(start)}`;
        if (end) solvedFilter += ` solved<${zdDate(end)}`;
        replyFilter  = ` updated>${zdDate(start)}`;
        if (end) replyFilter += ` updated<${zdDate(end)}`;
      }
    }

    const agentStats = await Promise.all(users.map(async u => {
      try {
        const [openRes, repliesRes, touchedRes] = await Promise.all([
          axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket assignee_id:${u.id} status:open status:new` } }),
          axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket commenter:${u.id}${replyFilter}` } }),
          axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket assignee_id:${u.id}${replyFilter}` } }),
        ]);
        return { id: u.id, name: u.name, open: openRes.data?.count || 0, replies: repliesRes.data?.count || 0, touched: touchedRes.data?.count || 0, _u: u };
      } catch {
        return { id: u.id, name: u.name, open: 0, replies: 0, touched: 0, _u: u };
      }
    }));

    const hasActivity = a => a.replies > 0 || a.touched > 0 || a.open > 0;
    const byActivity  = (a, b) => b.replies - a.replies || b.touched - a.touched || a.open - b.open;

    let sections = null;
    let support, escalation;

    if (team === 'tech' && techGroupSets) {
      // Build delineated sections — one per Zendesk group, agents can appear in multiple
      sections = techGroupSets
        .map(g => ({
          name: g.name,
          agents: agentStats
            .filter(a => g.memberSet.has(a.id))
            .sort(byActivity)
            .map(({ _u, ...rest }) => rest),
        }))
        .filter(s => s.agents.length > 0);
      // Flat deduplicated list for summary stats
      const seen = new Set();
      support = agentStats
        .filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; })
        .sort(byActivity)
        .map(({ _u, ...rest }) => rest);
      escalation = [];
    } else {
      support    = agentStats.filter(a => hasActivity(a)).sort(byActivity).map(({ _u, ...rest }) => rest);
      escalation = agentStats.filter(a => isEscalation(a._u) && hasActivity(a)).sort(byActivity).map(({ _u, ...rest }) => rest);
    }

    // Fetch team-scoped CSAT counts via group filter on ticket search
    let csatGood = 0, csatBad = 0;
    try {
      const csatGroups = groupIds.map(id => `group_id:${id}`).join(' ');
      const dateFilter = periodStart ? ` solved>${zdDate(periodStart)}` : '';
      const [cgRes, cbRes] = await Promise.all([
        axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket satisfaction:good ${csatGroups}${dateFilter}` } }),
        axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket satisfaction:bad ${csatGroups}${dateFilter}` } }),
      ]);
      csatGood = cgRes.data?.count || 0;
      csatBad  = cbRes.data?.count || 0;
    } catch { /* non-fatal */ }

    res.json({ sections, agents: [...support, ...escalation], support, escalation, groupName: null, csatGood, csatBad, zdSubdomain: process.env.ZENDESK_SUBDOMAIN || null });
  } catch (err) {
    if (err.message === 'Zendesk not configured') return res.json({ agents: [], unconfigured: true });
    console.error('Zendesk leaderboard error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard', details: err.message });
  }
});

// ─── Zendesk: List all groups (admin debug) ──────────────────────────────────
app.get('/api/zendesk/groups', requireAuth, async (req, res) => {
  try {
    const headers = zdHeaders();
    const base    = zdBase();
    const r = await axios.get(`${base}/groups.json?per_page=100`, { headers });
    const groups  = (r.data?.groups || []).map(g => ({ id: g.id, name: g.name }));
    // Also get member counts for ZD_TECH_GROUPS
    const techCounts = await Promise.all(ZD_TECH_GROUPS.map(async id => {
      try {
        const mr = await axios.get(`${base}/group_memberships.json?group_id=${id}&per_page=100`, { headers });
        return { id, count: mr.data?.group_memberships?.length ?? 0 };
      } catch { return { id, count: 'error' }; }
    }));
    res.json({ groups, techGroupMemberCounts: techCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Zendesk: List all active agents (admin debug) ───────────────────────────
app.get('/api/zendesk/agents', requireAuth, async (req, res) => {
  try {
    const headers = zdHeaders();
    const base    = zdBase();
    const r = await axios.get(`${base}/users.json?role=agent&per_page=100`, { headers });
    const agents = (r.data?.users || [])
      .filter(u => u.active && !u.suspended)
      .map(u => ({ id: u.id, name: u.name, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ agents, count: agents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Zendesk: Queue stats — open/new/pending counts ─────────────────────────
app.get('/api/zendesk/queue-stats', async (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const headers = zdHeaders();
    const base    = zdBase();
    const team    = req.query.team || null;

    // Build group filter for team-scoped views
    // Support also claims tickets with no group/assignee (unrouted new tickets)
    let groupFilter = '';
    if (team) {
      const groups = team === 'tech' ? ZD_TECH_GROUPS : [...ZD_SUPPORT_GROUPS, ZD_ESCALATION_GROUP];
      groupFilter = ' ' + groups.map(id => `group_id:${id}`).join(' ');
      if (team !== 'tech') groupFilter += ' group_id:none';
    }

    const q = (status) => `type:ticket status:${status}${groupFilter}`;
    const [newRes, openRes, pendingRes, onHoldRes] = await Promise.all([
      axios.get(`${base}/search.json`, { headers, params: { query: q('new')     } }),
      axios.get(`${base}/search.json`, { headers, params: { query: q('open')    } }),
      axios.get(`${base}/search.json`, { headers, params: { query: q('pending') } }),
      axios.get(`${base}/search.json`, { headers, params: { query: q('hold')    } }),
    ]);
    res.json({
      new:           newRes.data?.count     || 0,
      open:          openRes.data?.count    || 0,
      pending:       pendingRes.data?.count || 0,
      onHold:        onHoldRes.data?.count  || 0,
      zdGroupFilter: groupFilter.trim()     || null,
      zdSubdomain:   process.env.ZENDESK_SUBDOMAIN || null,
    });
  } catch (err) {
    if (err.message === 'Zendesk not configured') return res.json({ new: 0, open: 0, pending: 0, onHold: 0, unconfigured: true });
    console.error('Zendesk queue-stats error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch queue stats' });
  }
});

// ─── HubSpot: DID Pool Counts ────────────────────────────────────────────────
let hubspotDidCache = null;
let hubspotDidCacheAt = 0;
const HUBSPOT_CACHE_TTL = 60_000;

const HS_STAGE_AVAILABLE     = '249924503';
const HS_STAGE_INSTANT_AL    = '1214659642';
const HS_STAGE_INSTANT_RS    = '1295878407';

app.get('/api/hubspot/dids', async (req, res) => {
  try {
    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!token) return res.status(500).json({ error: 'HUBSPOT_PRIVATE_APP_TOKEN not configured' });

    if (hubspotDidCache && (Date.now() - hubspotDidCacheAt) < HUBSPOT_CACHE_TTL) {
      return res.json(hubspotDidCache);
    }

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    async function countByStage(stageId) {
      const r = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/deals/search',
        {
          filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: stageId }] }],
          limit: 1,
          properties: ['dealstage'],
        },
        { headers }
      );
      return r.data?.total ?? 0;
    }

    const [didPool, instantAL, instantRS] = await Promise.all([
      countByStage(HS_STAGE_AVAILABLE),
      countByStage(HS_STAGE_INSTANT_AL),
      countByStage(HS_STAGE_INSTANT_RS),
    ]);

    const result = {
      didPool,
      instantDidPool: instantAL + instantRS,
      syncedAt: new Date().toISOString(),
    };
    hubspotDidCache   = result;
    hubspotDidCacheAt = Date.now();
    res.json(result);
  } catch (err) {
    console.error('HubSpot DID error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch HubSpot DID counts', details: err.message });
  }
});

// ─── Monday.com: Account Review Board ────────────────────────────────────────
const ACCOUNT_REVIEW_BOARD_ID = '18374393367';

app.get('/api/monday/account-review', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.MONDAY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Monday.com credentials not configured' });

  const headers = { Authorization: apiKey, 'Content-Type': 'application/json' };
  const colIds  = `["date4","dropdown_mkx66k90","status","rating_mkx62jww","rating_mm0ma61q","long_text_mkx82hag","integration_mkxjtjnt","dropdown_mkxjq6br","numeric_mm0j487r","multiple_person_mm0j46sv"]`;
  const itemFields = `id name updated_at column_values(ids: ${colIds}) { id text }`;

  // Fetch the 500 most recently updated items — the board has 17k+ items total and
  // Monday's column filter rules don't work on this board type, so order_by is the
  // only way to get a manageable slice without timing out.
  const gqlQuery = `query {
    boards(ids: [${ACCOUNT_REVIEW_BOARD_ID}]) {
      items_page(limit: 500, query_params: {
        order_by: [{ column_id: "__last_updated__", direction: desc }]
      }) { items { ${itemFields} } }
    }
  }`;

  try {
    const response = await axios.post('https://api.monday.com/v2', { query: gqlQuery }, { headers, timeout: 20000 });

    if (response.data?.errors) throw new Error(response.data.errors[0]?.message);

    const allItems = response.data?.data?.boards?.[0]?.items_page?.items || [];

    const col = (item, id) => item.column_values?.find(c => c.id === id)?.text || '';

    const items = allItems.map(item => {
      const buildRaw     = col(item, 'rating_mkx62jww');
      const usabilityRaw = col(item, 'rating_mm0ma61q');
      const adjustCount  = parseInt(col(item, 'numeric_mm0j487r')) || 0;
      const hubspotRaw   = col(item, 'integration_mkxjtjnt');

      return {
        id:           item.id,
        name:         item.name,
        dateOpened:   col(item, 'date4'),
        openedBy:     col(item, 'dropdown_mkx66k90') || col(item, 'multiple_person_mm0j46sv'),
        status:       col(item, 'status'),
        buildQuality: buildRaw     ? parseInt(buildRaw)     || null : null,
        usability:    usabilityRaw ? parseInt(usabilityRaw) || null : null,
        adjustments:  col(item, 'long_text_mkx82hag'),
        adjustCount,
        dealStage:    col(item, 'dropdown_mkxjq6br'),
        hubspotUrl:   hubspotRaw || '',
        updatedAt:    item.updated_at,
        link:         `https://answeringlegal-unit.monday.com/boards/${ACCOUNT_REVIEW_BOARD_ID}/pulses/${item.id}`,
      };
    });

    res.json({ items });
  } catch (err) {
    console.error('Account review error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch account review data', details: err.message });
  }
});

// ─── Xcally Realtime Queue ───────────────────────────────────────────────────
const XCALLY_QUEUE_NAME = 'Answering_Legal';

app.get('/api/xcally/queue', async (req, res) => {
  try {
    const base = process.env.XCALLY_URL;
    const user = process.env.XCALLY_USER;
    const pass = process.env.XCALLY_PASS;
    if (!base || !user || !pass) return res.status(500).json({ error: 'Xcally not configured' });

    const auth = { username: user, password: pass };
    const [queueRes, channelsRes] = await Promise.all([
      axios.get(`${base}/api/realtime/queues`, { auth }),
      axios.get(`${base}/api/rpc/voice/queues/channels`, { auth }),
    ]);

    const queue = (queueRes.data?.rows || []).find(q => q.name === XCALLY_QUEUE_NAME);
    if (!queue) return res.status(404).json({ error: `Queue ${XCALLY_QUEUE_NAME} not found` });

    const activeCallers = (channelsRes.data?.rows || []).filter(
      r => r.queue === XCALLY_QUEUE_NAME && !r.queuecallerexit && !r.queuecallerabandon
    );
    const longestWait = activeCallers.length > 0
      ? Math.max(...activeCallers.map(r => r.holdtime || 0))
      : 0;

    res.json({
      waiting:     queue.waiting,
      longestWait,
      answered:    queue.answered,
      abandoned:   queue.abandoned,
    });
  } catch (err) {
    console.error('Xcally queue error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Xcally queue data' });
  }
});

async function pollMitelQueues() {
  const binId  = process.env.JSONBIN_MITEL_QUEUES_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;
  if (!binId || !apiKey) return;
  try {
    const r = await axios.get(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
      headers: { 'X-Master-Key': apiKey },
      timeout: 5000,
    });
    const data = r.data.record;
    if (!mitelQueueCache || data.updatedAt !== mitelQueueCache.updatedAt) {
      mitelQueueCache = data;
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const client of mitelSseClients) client.write(payload);
    }
  } catch (err) {
    console.error('[mitel] background poll error:', err.message);
  }
}

// Mitel queue stats — returns from in-memory cache (updated every 5s by background poller)
app.get('/api/mitel/queue-stats', (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.JSONBIN_MITEL_QUEUES_BIN_ID || !process.env.JSONBIN_API_KEY) return res.json({ unconfigured: true });
  if (mitelQueueCache) return res.json(mitelQueueCache);
  res.status(503).json({ error: 'Mitel stats not yet available' });
});

// Mitel queue stats — SSE stream (pushes update within ~5s of new poller data)
app.get('/api/mitel/queue-stats/stream', (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).end();
  } else if (!req.isAuthenticated()) {
    return res.status(401).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  if (mitelQueueCache) res.write(`data: ${JSON.stringify(mitelQueueCache)}\n\n`);

  mitelSseClients.add(res);
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); mitelSseClients.delete(res); });
});

// ─── React SPA Catch-All ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
pollMitelQueues();
setInterval(pollMitelQueues, 5000);

app.listen(PORT, () => {
  console.log(`✅ Call Center Ops Backend running on port ${PORT}`);
  console.log(`   App: http://localhost:${PORT}/`);
});
