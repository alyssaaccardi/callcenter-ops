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
const multer = require('multer');
const XLSX   = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

https.globalAgent.setMaxListeners(50);
require('events').EventEmitter.defaultMaxListeners = 50;

const app = express();
const PORT = process.env.PORT || 3001;

let mitelQueueCache = null;
let mitelLastPush   = 0;
const mitelSseClients = new Set();

const auditorJobs = new Map(); // jobId → { status, results, total, done, error }

// Cache for Zendesk incremental public-reply maps (avoids hammering the 10 req/min limit)
// Key is start timestamp so "today" and "this-week" share the same entry on Monday.
const zdPublicReplyCache    = new Map(); // startTs -> { map, expires }
const zdPublicReplyInflight = new Map(); // startTs -> Promise (dedup concurrent fetches)

// Cache for full leaderboard responses — prevents TV display 10s polling from firing
// 36 Zendesk search queries every cycle and exhausting the rate limit.
const zdLeaderboardCache    = new Map(); // `${team}:${period}` -> { data, expires }
const zdLeaderboardInflight = new Map(); // `${team}:${period}` -> Promise

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
      frameSrc:   ["'self'", 'https://al-app-portal.vercel.app'],
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

app.get('/site-widget', (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.sendFile(path.join(__dirname, 'public', 'CCOB_SiteWidget.html'));
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
    return res.json({ authenticated: true, user: { email: 'dev@local', name: 'Dev User', role: 'super_admin', additionalRoles: [] } });
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
    // savvyActive:     process.env.SLACK_SAVVY_ACTIVE_URL    || '',   // RESERVED - SAVVY PHONE
    // savvyInactive:   process.env.SLACK_SAVVY_INACTIVE_URL  || '',   // RESERVED - SAVVY PHONE
  });
});

// ─── User Management (super_admin only) ──────────────────────────────────────
app.get('/api/users', requireRole('super_admin'), (req, res) => {
  const users = listUsers();
  res.json({ users: Object.entries(users).map(([email, u]) => ({ email, ...u })) });
});

const VALID_ROLES = ['super_admin', 'call_center_ops', 'tv_display', 'support', 'tech', 'zendesk_auditor'];
const ADDITIONAL_ROLES = ['zendesk_auditor'];

app.post('/api/users', requireRole('super_admin'), (req, res) => {
  const { email, name, role, additionalRoles = [] } = req.body;
  if (!email || !name || !role) return res.status(400).json({ error: 'email, name, and role are required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
  const validExtra = additionalRoles.filter(r => ADDITIONAL_ROLES.includes(r));
  addUser(email, name, role, validExtra);
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

// ─── SMS History Store ────────────────────────────────────────────────────────
const SMS_HISTORY_FILE = path.join(__dirname, 'sms-history.json');
const SMS_HISTORY_MAX  = 200;

function loadSmsHistory() {
  try { return JSON.parse(fs.readFileSync(SMS_HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveSmsHistory(entries) {
  fs.writeFileSync(SMS_HISTORY_FILE, JSON.stringify(entries));
}
let smsHistory = loadSmsHistory();

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

// Public SMS history — readable by the Wix site widget with API key
app.get('/api/sms-history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(smsHistory.slice(0, limit));
});

// ─── Canned Responses ─────────────────────────────────────────────────────────
const CANNED_FILE = path.join(__dirname, 'canned-responses.json');

function loadCanned() {
  try { return JSON.parse(fs.readFileSync(CANNED_FILE, 'utf8')); } catch { return []; }
}
function saveCanned(arr) {
  fs.writeFileSync(CANNED_FILE, JSON.stringify(arr, null, 2));
}

app.get('/api/canned-responses', requireAuth, (req, res) => {
  res.json(loadCanned());
});

app.post('/api/canned-responses', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const { label = '', msg = '' } = req.body;
  const arr = loadCanned();
  const entry = { id: Date.now().toString(), label, msg };
  arr.push(entry);
  saveCanned(arr);
  res.json(entry);
});

app.put('/api/canned-responses/:id', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const arr = loadCanned();
  const idx = arr.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const { label, msg } = req.body;
  if (label !== undefined) arr[idx].label = label;
  if (msg !== undefined) arr[idx].msg = msg;
  saveCanned(arr);
  res.json(arr[idx]);
});

app.delete('/api/canned-responses/:id', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const arr = loadCanned();
  const next = arr.filter(c => c.id !== req.params.id);
  if (next.length === arr.length) return res.status(404).json({ error: 'not found' });
  saveCanned(next);
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
    const out = { ...obj, changedBy, changedAt: obj.changedAt || new Date().toISOString() };
    if ('message' in obj) {
      out.messageBy = changedBy;
      out.messageAt = new Date().toISOString();
    }
    return out;
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
  { id: 'builtin_didsUnavailable', name: 'DIDs Unavailable', scope: 'DID Status', icon: '🔴', builtin: true, envKey: 'SLACK_DID_UNAVAILABLE_URL' },
  { id: 'builtin_didsAvailable',   name: 'DIDs Available',   scope: 'DID Status', icon: '🟢', builtin: true, envKey: 'SLACK_DID_AVAILABLE_URL'   },
  // { id: 'builtin_savvyActive',   name: 'Savvy Phone Active',   scope: 'Savvy Phone', icon: '✅', builtin: true, envKey: 'SLACK_SAVVY_ACTIVE_URL'   }, // RESERVED - SAVVY PHONE
  // { id: 'builtin_savvyInactive', name: 'Savvy Phone Inactive', scope: 'Savvy Phone', icon: '⚠️', builtin: true, envKey: 'SLACK_SAVVY_INACTIVE_URL' }, // RESERVED - SAVVY PHONE
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
  const wfs = loadWorkflows();
  if (req.user?.role !== 'super_admin') {
    return res.json(wfs.map(({ url, ...rest }) => rest));
  }
  res.json(wfs);
});

app.post('/api/slack/workflows/:id/fire', requireRole('super_admin', 'call_center_ops'), async (req, res) => {
  const wfs = loadWorkflows();
  const wf  = wfs.find(w => w.id === req.params.id);
  if (!wf)      return res.status(404).json({ error: 'Workflow not found' });
  if (!wf.url)  return res.status(400).json({ error: 'No URL configured for this workflow' });
  if (wf.url.includes('slack.com/shortcuts/')) {
    auditWorkflow(`Fired workflow: "${wf.name}"`, req.user?.name, req.user?.picture);
    return res.json({ success: true, openUrl: wf.url });
  }
  try {
    await axios.post(wf.url, {});
    auditWorkflow(`Fired workflow: "${wf.name}"`, req.user?.name, req.user?.picture);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fire workflow', details: err.message });
  }
});

app.post('/api/slack/workflows', requireRole('super_admin'), (req, res) => {
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

app.put('/api/slack/workflows/:id', requireRole('super_admin'), (req, res) => {
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

app.delete('/api/slack/workflows/:id', requireRole('super_admin'), (req, res) => {
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
    const { groups, groupNames, phoneNumber, message } = req.body;

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

    const sentAt = new Date().toISOString();

    // Record group sends to the SMS history store
    if (groups && groups.length) {
      const names = groupNames && groupNames.length ? groupNames : groups.map(String);
      const entry = {
        sentAt,
        message,
        groups: names,
        sentBy: req.user?.name || req.user?.email || 'Unknown',
      };
      smsHistory = [entry, ...smsHistory].slice(0, SMS_HISTORY_MAX);
      saveSmsHistory(smsHistory);
    }

    res.json({ success: true, result: response.data, sentAt });
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

// ─── Staff Broadcast ─────────────────────────────────────────────────────────
const STAFF_BROADCAST_FILE = path.join(__dirname, 'staff-broadcast.json');

function loadBroadcast() {
  try { return JSON.parse(fs.readFileSync(STAFF_BROADCAST_FILE, 'utf8')); } catch { return null; }
}
function saveBroadcast(data) {
  fs.writeFileSync(STAFF_BROADCAST_FILE, JSON.stringify(data, null, 2));
}

// Public — no auth — Wix embed fetches this (open CORS so Wix domains can fetch it)
app.get('/api/staff-broadcast', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const b = loadBroadcast();
  if (!b) return res.json({ empty: true });
  res.json(b);
});

app.post('/api/staff-broadcast', requireAuth, (req, res) => {
  const { title, body, links, imageUrl } = req.body;
  if (!title && !body) return res.status(400).json({ error: 'title or body required' });
  const data = {
    title:     title    || '',
    body:      body     || '',
    imageUrl:  imageUrl || '',
    links:     Array.isArray(links) ? links.filter(l => l.url) : [],
    updatedAt: new Date().toISOString(),
    updatedBy: req.user?.name || req.user?.email || 'unknown',
  };
  saveBroadcast(data);
  res.json({ ok: true, data });
});

app.delete('/api/staff-broadcast', requireAuth, (req, res) => {
  try { fs.unlinkSync(STAFF_BROADCAST_FILE); } catch {}
  res.json({ ok: true });
});

// ─── Monday.com: Get Agents (cursor-paginated) ───────────────────────────────
app.get('/api/monday/agents', (req, res, next) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }
  requireAuth(req, res, next);
}, async (req, res) => {
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
  const standbyLabel = process.env.MONDAY_STANDBY_LABEL || 'On Standby';

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
  const itemFields = `id name updated_at group { id title } column_values(ids: ["color_mkxwxqsx", "status", "date_mkx5zfsz", "dropdown_mkzc9hm", "text_mkx5ca0q", "text_mkx5cpnb", "dropdown_mkxjmeyh", "multiple_person_mkx5smfv", "multiple_person_mm38yn50", "multiple_person_mkzcjc37"]) { id text value }`;

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
    const todayEST = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const DONE_PHRASES = ['done', 'complete', 'closed', "won't fix", 'cancelled', 'resolved', 'send zendesk'];

    const allMapped = allItems.map(item => {
      const statusCol   = item.column_values?.find(c => c.id === 'color_mkxwxqsx');
      const priorityCol = item.column_values?.find(c => c.id === 'status');
      const dateCol     = item.column_values?.find(c => c.id === 'date_mkx5zfsz');
      const taskTypeCol = item.column_values?.find(c => c.id === 'dropdown_mkzc9hm');
      const accountCol  = item.column_values?.find(c => c.id === 'text_mkx5ca0q');
      const descCol     = item.column_values?.find(c => c.id === 'text_mkx5cpnb');
      const assigneeCol = item.column_values?.find(c => c.id === 'multiple_person_mkx5smfv');
      const workerCol    = item.column_values?.find(c => c.id === 'multiple_person_mm38yn50');
      const solvedByCol  = item.column_values?.find(c => c.id === 'multiple_person_mkzcjc37');

      let dueTime = '';
      try {
        const raw = dateCol?.value ? JSON.parse(dateCol.value) : null;
        if (raw?.time) {
          // dateCol.text is "YYYY-MM-DD HH:MM" in workspace timezone (EST).
          // Use the time portion from text instead of raw.time which is UTC.
          const textParts = (dateCol?.text || '').split(' ');
          dueTime = textParts.length === 2 ? textParts[1] : raw.time.slice(0, 5);
        }
      } catch { /* ignore */ }

      return {
        id:          item.id,
        name:        item.name,
        status:      statusCol?.text  || '',
        groupTitle:  item.group?.title || '',
        priority:    priorityCol?.text || '',
        dueDate:     dateCol?.text    || '',
        dueTime,
        taskType:    taskTypeCol?.text || '',
        accountName: accountCol?.text  || '',
        description: descCol?.text     || '',
        assignee:    assigneeCol?.text  || '',
        worker:      workerCol?.text    || '',
        solvedBy:    solvedByCol?.text  || '',
        lastUpdate:  item.updated_at,
        link:        `https://answeringlegal-unit.monday.com/boards/${boardId}/pulses/${item.id}`,
      };
    });

    const DONE_GROUP_PHRASES = ['closed', 'complet'];
    const EXCLUDED_GROUPS    = ['escalation'];
    function isDone(task) {
      const statusLow = (task.status || '').toLowerCase();
      const groupLow  = (task.groupTitle || '').toLowerCase();
      return DONE_PHRASES.some(p => statusLow.includes(p)) || DONE_GROUP_PHRASES.some(p => groupLow.includes(p));
    }
    function isExcluded(task) {
      const groupLow = (task.groupTitle || '').toLowerCase();
      return EXCLUDED_GROUPS.some(g => groupLow.includes(g));
    }

    const countable = allMapped.filter(task => !isExcluded(task));

    const completedToday = countable.filter(task => {
      if (!isDone(task)) return false;
      if (!task.lastUpdate) return false;
      const updateDate = new Date(task.lastUpdate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return updateDate === todayEST;
    });

    const mapped = countable.filter(task => !isDone(task));

    const overdue  = mapped.filter(task => {
      const statusLow = (task.status || '').toLowerCase();
      if (statusLow === 'overdue') return true;
      if (!task.dueDate) return false;
      const due = new Date(task.dueDate); due.setHours(0, 0, 0, 0);
      return !isNaN(due) && due < today;
    });

    const upcoming = mapped.filter(task => {
      if (!task.dueDate) {
        return (task.status || '').toLowerCase() === 'due';
      }
      const due = new Date(task.dueDate); due.setHours(0, 0, 0, 0);
      return !isNaN(due) && due >= today && due < tomorrow;
    });

    res.json({ tasks: overdue, overdue, upcoming, completedToday });
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
  const itemFields = `id name updated_at group { id title } column_values(ids: ["color_mkxwxqsx", "status", "date_mkx5zfsz", "dropdown_mkxjmeyh", "multiple_person_mkx5smfv", "dropdown_mkzc9hm"]) { id text }`;

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

    const STATS_DONE_PHRASES    = ['done', 'complete', 'closed', "won't fix", 'cancelled', 'resolved', 'send zendesk'];
    const STATS_DONE_GROUPS     = ['closed', 'complet'];
    const STATS_EXCLUDED_GROUPS = ['escalation'];

    const activeItems = allItems.filter(item => {
      const groupLow  = (item.group?.title || '').toLowerCase();
      if (STATS_EXCLUDED_GROUPS.some(g => groupLow.includes(g))) return false;
      if (STATS_DONE_GROUPS.some(g => groupLow.includes(g))) return false;
      const statusLow = (item.column_values?.find(c => c.id === 'color_mkxwxqsx')?.text || '').toLowerCase();
      return !STATS_DONE_PHRASES.some(p => statusLow.includes(p));
    });

    const byStatus = {};
    const byPriority = {};
    const bySquad = {};
    const byAssignee = {};
    let overdue = 0, dueToday = 0, dueThisWeek = 0;

    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));

    for (const item of activeItems) {
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
      total: activeItems.length,
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

    const pad = n => String(n).padStart(2, '0');
    const zdDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00Z`;

    // Build group filter for team-scoped views
    // Support also claims tickets with no group/assignee (unrouted new tickets)
    let groupFilter = '';
    if (team) {
      const groups = team === 'tech' ? ZD_TECH_GROUPS : ZD_SUPPORT_GROUPS;
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
        const groupIds  = team === 'tech' ? ZD_TECH_GROUPS : ZD_SUPPORT_GROUPS;
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

  const period   = req.query.period || 'this-week';
  const team     = req.query.team   || 'support';
  const cacheKey = `${team}:${period}`;

  try {
    // Return cached result if fresh — prevents TV display 10s polling from firing
    // 36+ Zendesk search queries every cycle and exhausting the rate limit.
    const cached = zdLeaderboardCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);
    if (zdLeaderboardInflight.has(cacheKey)) {
      const data = await zdLeaderboardInflight.get(cacheKey);
      return res.json(data);
    }

    const buildPromise = (async () => {
    const headers = zdHeaders();
    const base    = zdBase();

    // Resolve full user records
    const usersRes  = await axios.get(`${base}/users.json?role=agent&per_page=100`, { headers });
    const allAgents = (usersRes.data?.users || []).filter(u => u.active && !u.suspended);

    let users;
    const groupIds = team === 'tech' ? ZD_TECH_GROUPS : ZD_SUPPORT_GROUPS;

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
    const zdDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00Z`;

    // Fetch all public reply data ONCE for the period, then look up per-agent.
    // Cache key = startTs so "today" and "this-week" share an entry when they have the same start.
    // In-flight dedup prevents concurrent requests from hitting the API simultaneously.
    async function getPublicReplyMap(startTs, endTs) {
      const cached = zdPublicReplyCache.get(startTs);
      if (cached && cached.expires > Date.now()) return cached.map;

      // If another request is already fetching this, wait for it
      if (zdPublicReplyInflight.has(startTs)) return zdPublicReplyInflight.get(startTs);

      const fetchPromise = (async () => {
        const agentTickets = new Map(); // agentId -> Set<ticketId>
        let url = `${base}/incremental/ticket_events.json?start_time=${startTs}&include=comment_events`;
        let pages = 0;
        while (url && pages < 100) {
          const res = await axios.get(url, { headers, timeout: 15000 });
          if (res.data?.errors) break;
          const events = res.data?.ticket_events || [];
          for (const ev of events) {
            if (endTs && new Date(ev.created_at) > endTs) continue;
            for (const child of (ev.child_events || [])) {
              if (child.event_type === 'Comment' && child.public === true) {
                const aid = String(child.author_id);
                if (!agentTickets.has(aid)) agentTickets.set(aid, new Set());
                agentTickets.get(aid).add(ev.ticket_id);
              }
            }
          }
          url = res.data.end_of_stream ? null : (res.data.next_page || null);
          pages++;
          if (!events.length) break;
        }
        zdPublicReplyCache.set(startTs, { map: agentTickets, expires: Date.now() + 3 * 60 * 1000 });
        zdPublicReplyInflight.delete(startTs);
        return agentTickets;
      })();

      zdPublicReplyInflight.set(startTs, fetchPromise);
      return fetchPromise;
    }

    let solvedFilter  = '';
    let commentFilter = '';
    let replyFilter   = '';
    let periodStart   = null;
    let periodEnd     = null;
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
        periodStart   = start;
        periodEnd     = end || null;
        solvedFilter  = ` solved>${zdDate(start)}`;
        if (end) solvedFilter  += ` solved<${zdDate(end)}`;
        commentFilter = ` created>${zdDate(start)}`;
        if (end) commentFilter += ` created<${zdDate(end)}`;
        replyFilter   = ` updated>${zdDate(start)}`;
        if (end) replyFilter   += ` updated<${zdDate(end)}`;
      }
    }

    // Fetch public reply map once for all agents (single incremental API call + cache)
    let publicReplyMap = new Map();
    if (periodStart) {
      try {
        publicReplyMap = await getPublicReplyMap(Math.floor(periodStart / 1000), periodEnd);
      } catch (e) { console.error('getPublicReplyMap error:', e.response?.data || e.message); }
    }

    const agentStats = await Promise.all(users.map(async u => {
      try {
        const [openRes, solvedRes] = await Promise.all([
          axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket assignee_id:${u.id} status:open status:new` } }),
          axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket assignee_id:${u.id} status:solved${solvedFilter}` } }),
        ]);
        const replies = periodStart
          ? (publicReplyMap.get(String(u.id))?.size ?? 0)
          : (await axios.get(`${base}/search.json`, { headers, params: { query: `type:ticket commenter:${u.id}` } })).data?.count || 0;
        const solved = solvedRes.data?.count || 0;
        return { id: u.id, name: u.name, email: u.email || null, photoUrl: u.photo?.thumb_url || null, open: openRes.data?.count || 0, replies, solved, touched: solved, _u: u };
      } catch (e) {
        console.error(`Leaderboard agent stats error [${u.name}]:`, e.response?.data || e.message);
        return { id: u.id, name: u.name, email: u.email || null, photoUrl: u.photo?.thumb_url || null, open: 0, replies: 0, solved: 0, touched: 0, _u: u };
      }
    }));

    const hasActivity = a => a.replies > 0 || a.solved > 0 || a.open > 0;
    const byActivity  = (a, b) => b.replies - a.replies || b.solved - a.solved || a.open - b.open;

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
      // For "today" always show all agents in the group — it's a daily view and agents start
      // with 0 replied/solved; filtering by hasActivity would hide everyone until they work a ticket.
      // For all other periods, filter to agents with at least some activity.
      const showAll = period === 'today';
      support    = agentStats.filter(a => !isEscalation(a._u) && (showAll || hasActivity(a))).sort(byActivity).map(({ _u, ...rest }) => rest);
      escalation = agentStats.filter(a =>  isEscalation(a._u) && (showAll || hasActivity(a))).sort(byActivity).map(({ _u, ...rest }) => rest);
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

    const responseData = { sections, agents: [...support, ...escalation], support, escalation, groupName: null, csatGood, csatBad, zdSubdomain: process.env.ZENDESK_SUBDOMAIN || null };
    zdLeaderboardCache.set(cacheKey, { data: responseData, expires: Date.now() + 3 * 60 * 1000 });
    zdLeaderboardInflight.delete(cacheKey);
    return responseData;
    })();

    zdLeaderboardInflight.set(cacheKey, buildPromise);
    const data = await buildPromise;
    res.json(data);
  } catch (err) {
    zdLeaderboardInflight.delete(cacheKey);
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
      const groups = team === 'tech' ? ZD_TECH_GROUPS : ZD_SUPPORT_GROUPS;
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
    const usersQuery = `query { users(kind: non_guests) { id name email photo_thumb } }`;

    const [response, usersRes] = await Promise.all([
      axios.post('https://api.monday.com/v2', { query: gqlQuery }, { headers, timeout: 20000 }),
      axios.post('https://api.monday.com/v2', { query: usersQuery }, { headers, timeout: 10000 }).catch(() => null),
    ]);

    if (response.data?.errors) throw new Error(response.data.errors[0]?.message);

    const allItems = response.data?.data?.boards?.[0]?.items_page?.items || [];
    const mondayUsers = (usersRes?.data?.data?.users || []).map(u => ({
      id:         u.id,
      name:       u.name,
      email:      u.email || null,
      photoThumb: u.photo_thumb || null,
    }));

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

    res.json({ items, mondayUsers });
  } catch (err) {
    console.error('Account review error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch account review data', details: err.message });
  }
});

// ─── Xcally Realtime Queue ───────────────────────────────────────────────────
const XCALLY_QUEUE_NAME  = 'Answering_Legal';
const XCALLY_BUFFER_MS   = 4 * 60 * 60 * 1000; // 4 hours — covers 3 completed + boundary
const XCALLY_BUFFER_FILE = path.join(__dirname, 'xcally-buffer.json');
const xcallyHoldBuffer   = []; // { ts, answered, cumulativeWait }

// Persist buffer so server restarts don't lose hours of history
function saveXcallyBuffer() {
  try { fs.writeFileSync(XCALLY_BUFFER_FILE, JSON.stringify(xcallyHoldBuffer)); } catch (_) {}
}
function loadXcallyBuffer() {
  try {
    const data = JSON.parse(fs.readFileSync(XCALLY_BUFFER_FILE, 'utf8'));
    if (Array.isArray(data)) {
      const cutoff = Date.now() - XCALLY_BUFFER_MS;
      xcallyHoldBuffer.push(...data.filter(e => e.ts > cutoff && e.answered != null && e.cumulativeWait != null));
    }
  } catch (_) {}
}
loadXcallyBuffer();
setInterval(saveXcallyBuffer, 60 * 1000);

function xcallyBufferPush(answered, sumHoldTime) {
  if (answered == null || sumHoldTime == null) return;
  const ts   = Date.now();
  const prev = xcallyHoldBuffer[xcallyHoldBuffer.length - 1];
  if (prev && answered < prev.answered) xcallyHoldBuffer.length = 0; // midnight reset
  xcallyHoldBuffer.push({ ts, answered, cumulativeWait: sumHoldTime });
  const cutoff = ts - XCALLY_BUFFER_MS;
  while (xcallyHoldBuffer.length > 1 && xcallyHoldBuffer[0].ts < cutoff) xcallyHoldBuffer.shift();
}

// Returns speed-of-answer for each of the last 3 completed EST hours, newest first
function xcallyHourlyStats() {
  if (xcallyHoldBuffer.length < 2) return [];
  const now = new Date();
  // Compute EST offset: diff between UTC and EST wall-clock time
  const parts  = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const gp = t => parseInt(parts.find(p => p.type === t).value);
  const estNowMs    = Date.UTC(gp('year'), gp('month') - 1, gp('day'), gp('hour'), gp('minute'), gp('second'));
  const offsetMs    = now.getTime() - estNowMs; // how far UTC is ahead of EST
  const estHour     = gp('hour');

  const results = [];
  for (let h = 1; h <= 3; h++) {
    // UTC timestamps for this EST hour boundary
    const hourStartMs = Date.UTC(gp('year'), gp('month') - 1, gp('day'), estHour - h,     0, 0) + offsetMs;
    const hourEndMs   = Date.UTC(gp('year'), gp('month') - 1, gp('day'), estHour - h + 1, 0, 0) + offsetMs;

    const startSnap = xcallyHoldBuffer.filter(e => e.ts <= hourStartMs).at(-1);
    const endSnap   = xcallyHoldBuffer.filter(e => e.ts <= hourEndMs).at(-1);

    let avgWait = null;
    if (startSnap && endSnap && endSnap !== startSnap) {
      const dAns  = endSnap.answered       - startSnap.answered;
      const dWait = endSnap.cumulativeWait - startSnap.cumulativeWait;
      avgWait = dAns > 0 ? Math.round(dWait / dAns) : null;
    }

    const label = new Date(hourStartMs).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: true,
    });
    results.push({ label, avgWait });
  }
  return results; // [most recent completed hour, ..., 3 hours ago]
}

async function pollXcallyBuffer() {
  try {
    const base = process.env.XCALLY_URL;
    const user = process.env.XCALLY_USER;
    const pass = process.env.XCALLY_PASS;
    if (!base || !user || !pass) return;
    const auth = { username: user, password: pass };
    const queueRes = await axios.get(`${base}/api/realtime/queues`, { auth });
    const queue = (queueRes.data?.rows || []).find(q => q.name === XCALLY_QUEUE_NAME);
    if (queue) xcallyBufferPush(queue.answered, queue.sumHoldTime ?? null);
  } catch (_) {}
}

pollXcallyBuffer();
setInterval(pollXcallyBuffer, 60 * 1000);

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

    xcallyBufferPush(queue.answered, queue.sumHoldTime ?? null);

    const avgHoldTime = queue.answered > 0 && queue.sumHoldTime != null
      ? Math.round(queue.sumHoldTime / queue.answered) : null;

    res.json({
      waiting:      queue.waiting,
      longestWait,
      answered:     queue.answered,
      abandoned:    queue.abandoned,
      avgHoldTime,
      hourlyStats:  xcallyHourlyStats(),
    });
  } catch (err) {
    console.error('Xcally queue error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Xcally queue data' });
  }
});

// Mitel queue stats — inbound push from office PC poller (replaces JSONBin pull)
app.post('/api/mitel/queue-stats', (req, res) => {
  const secret = process.env.MITEL_POLLER_SECRET;
  if (!secret || req.headers['x-poller-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const data = req.body;
  if (!data || !Array.isArray(data.queues)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  mitelQueueCache = data;
  mitelLastPush   = Date.now();
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of mitelSseClients) client.write(payload);
  res.json({ ok: true });
});

// Watchdog: if no push in 90s, notify SSE clients the poller is offline
setInterval(() => {
  if (mitelQueueCache && Date.now() - mitelLastPush > 90_000) {
    mitelQueueCache = null;
    const offline = `data: ${JSON.stringify({ offline: true })}\n\n`;
    for (const client of mitelSseClients) client.write(offline);
  }
}, 30_000);

// Mitel queue stats — returns from in-memory cache (updated by office PC push)
app.get('/api/mitel/queue-stats', (req, res) => {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
  } else if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.MITEL_POLLER_SECRET) return res.json({ unconfigured: true });
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

  res.write(`data: ${JSON.stringify(mitelQueueCache ?? { offline: true })}\n\n`);

  mitelSseClients.add(res);
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); mitelSseClients.delete(res); });
});

// ─── Mitel CloudLink REST API ─────────────────────────────────────────────────
// Token cache — shared across requests, auto-refreshed
let mitelClToken = null;     // { access_token, refresh_token, expiresAt }
let mitelClFetching = false; // mutex to prevent concurrent auth calls

async function getMitelClToken() {
  const username   = process.env.MITEL_CL_USERNAME;
  const password   = process.env.MITEL_CL_PASSWORD;
  const account_id = process.env.MITEL_CL_ACCOUNT_ID;
  if (!username || !password || !account_id) return null;

  // Still valid (60s buffer)
  if (mitelClToken && mitelClToken.expiresAt > Date.now() + 60_000) return mitelClToken.access_token;

  // Mutex — only one concurrent auth request
  if (mitelClFetching) {
    await new Promise(r => setTimeout(r, 800));
    return mitelClToken?.access_token || null;
  }
  mitelClFetching = true;

  try {
    // Try refresh first if we have a refresh token
    if (mitelClToken?.refresh_token) {
      try {
        const r = await axios.post('https://api.mitel.io/2017-09-01/token', {
          grant_type: 'refresh_token',
          refresh_token: mitelClToken.refresh_token,
        });
        mitelClToken = {
          access_token:  r.data.access_token,
          refresh_token: r.data.refresh_token || mitelClToken.refresh_token,
          expiresAt:     Date.now() + (r.data.expires_in || 3600) * 1000,
        };
        return mitelClToken.access_token;
      } catch { /* fall through to password grant */ }
    }

    const r = await axios.post('https://api.mitel.io/2017-09-01/token', {
      grant_type: 'password',
      username,
      password,
      account_id,
    });
    mitelClToken = {
      access_token:  r.data.access_token,
      refresh_token: r.data.refresh_token || null,
      expiresAt:     Date.now() + (r.data.expires_in || 3600) * 1000,
    };
    return mitelClToken.access_token;
  } catch (err) {
    console.error('Mitel CloudLink auth error:', err.response?.data || err.message);
    return null;
  } finally {
    mitelClFetching = false;
  }
}

// GET /api/mitel/cloudlink/calls — returns raw call data from all configured endpoints
app.get('/api/mitel/cloudlink/calls', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

  const appId     = process.env.MITEL_CL_APP_ID;
  const endpoints = (process.env.MITEL_CL_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!process.env.MITEL_CL_USERNAME || !appId) return res.json({ unconfigured: true });
  if (endpoints.length === 0) return res.json({ unconfigured: true, reason: 'no endpoints configured' });

  const token = await getMitelClToken();
  if (!token) return res.status(502).json({ error: 'Mitel CloudLink auth failed' });

  const headers = { Authorization: `Bearer ${token}`, 'X-Mitel-App': appId };

  try {
    const results = await Promise.all(
      endpoints.map(async endpointId => {
        try {
          const r = await axios.get(
            `https://media.api.mitel.io/2017-09-01/endpoints/${endpointId}/calls`,
            { headers }
          );
          return { endpointId, calls: r.data };
        } catch (err) {
          return { endpointId, error: err.response?.data || err.message };
        }
      })
    );
    res.json({ results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Mitel CloudLink calls error:', err.message);
    res.status(502).json({ error: 'Failed to fetch CloudLink calls', details: err.message });
  }
});

// ─── Zendesk Auditor ─────────────────────────────────────────────────────────

const AUDITOR_CATEGORIES = [
  'Switched to AI Service', 'Went to Competitor', 'Price is Too High',
  'Downsizing Practice', 'Hired Staff', 'Quality Issues', 'Closed Practice',
  'Leaving Firm', 'Fired', 'Not Enough Call Volume',
  'Wanted Features/Services Not Offered', 'Does Not See Value in Service',
  'Unknown / Unspecified',
];

const auditorUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function auditorDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Normalize spreadsheet column names to known fields
function normalizeAuditorRow(raw) {
  const normalized = {};
  for (const [key, val] of Object.entries(raw)) {
    const k = String(key).toLowerCase().trim().replace(/[\s_-]+/g, '');
    if (['accountname','account','company','firmname','firm','name','client','clientname',
         'business','businessname','customer','customername','lawfirm','practicename'].includes(k))
      normalized.accountName = String(val || '').trim();
    else if (['emaildomain','domain'].includes(k))
      normalized.emailDomain = String(val || '').trim();
    else if (['customeremail','email','contactemail','primaryemail','billingemail','emailaddress'].includes(k))
      normalized.customerEmail = String(val || '').trim();
    else if (['orgname','organizationname','org','organization'].includes(k))
      normalized.orgName = String(val || '').trim();
    else if (['notes','note','reason','cancellationreason','cancellationnote','comments','comment',
              'cancellationdescription','description','details'].includes(k))
      normalized.notes = String(val || '').trim();
  }
  return normalized;
}

// Extract explicit ticket IDs from any cell value
// Catches: "ticket #331182", "#331182", "314123 is ticket number", bare 5-7 digit numbers
function parseTicketIdsFromRow(raw) {
  const ids = new Set();
  for (const val of Object.values(raw)) {
    const text = String(val || '');
    // Match any standalone 5-7 digit number (Zendesk ticket IDs)
    // Years are 4 digits, phone numbers are 10 — this range is safe
    const pattern = /\b(\d{5,7})\b/g;
    let m;
    while ((m = pattern.exec(text)) !== null) ids.add(parseInt(m[1]));
  }
  return [...ids];
}

async function zdAuditorGet(url, params = {}) {
  const headers = zdHeaders();
  const resp = await axios.get(url, { headers, params, timeout: 8000 });
  return resp.data;
}

async function matchCustomer(row) {
  const base = zdBase();

  // Learnings from production data:
  // - Domain wildcard search (email:*@domain.com) returns 0 for ALL domains in this Zendesk instance — skip it
  // - Org search (organizations/search) also returns 0 consistently — skip it
  // - The CSV email often belongs to a secondary contact at the firm; the cancellation ticket
  //   may have been filed by a different person. Searching by BOTH email AND firm name and
  //   collecting all matched users is the only reliable approach.

  const userSet = new Map(); // userId -> user object (deduplicates across both searches)

  // 1. Exact email search
  if (row.customerEmail) {
    try {
      const data = await zdAuditorGet(`${base}/users/search`, { query: `email:${row.customerEmail}` });
      await auditorDelay(80);
      for (const u of (data.users || [])) userSet.set(u.id, u);
    } catch (e) { /* fall through */ }
  }

  // 2. Firm/account name search — catches cases where the CSV email is a secondary contact
  //    but the cancellation ticket was filed by someone else at the same firm.
  //    Strip special chars (&, commas, parens, quotes) that break Zendesk search.
  const nameQuery = row.accountName || row.orgName;
  if (nameQuery) {
    const clean = nameQuery.replace(/[&,.()"'\/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ').filter(w => w.length > 2);
    const q = words.slice(0, 4).join(' ');
    if (q.length >= 3) {
      try {
        const data = await zdAuditorGet(`${base}/users/search`, { query: q, per_page: 10 });
        await auditorDelay(80);
        for (const u of (data.users || [])) {
          if (u.role !== 'agent' && u.role !== 'admin') userSet.set(u.id, u);
        }
      } catch (e) { /* fall through */ }
    }
  }

  if (userSet.size === 0) return null;

  const users = [...userSet.values()];
  const userWithOrg = users.find(u => u.organization_id);
  const zdOrgId = userWithOrg?.organization_id || null;

  let zdOrgName = nameQuery || users[0].name;
  if (zdOrgId) {
    try {
      const orgData = await zdAuditorGet(`${base}/organizations/${zdOrgId}`);
      await auditorDelay(80);
      zdOrgName = orgData.organization?.name || zdOrgName;
    } catch (e) { /* fall through */ }
  }

  return {
    zdOrgId,
    zdOrgName,
    zdUserId: users[0].id,
    zdUserIds: users.map(u => u.id).slice(0, 5),
    matchType: userSet.size > 1 ? 'emailAndName' : 'singleSearch',
    matchConfidence: 'Medium',
  };
}

async function fetchTicketComments(ticketId) {
  const base = zdBase();
  try {
    const data = await zdAuditorGet(`${base}/tickets/${ticketId}/comments`);
    await auditorDelay(80);
    return (data.comments || []).map(c => ({ body: c.body, public: c.public }));
  } catch (e) {
    return [];
  }
}

async function fetchTicketById(ticketId) {
  const base = zdBase();
  try {
    const data = await zdAuditorGet(`${base}/tickets/${ticketId}`);
    await auditorDelay(80);
    const t = data.ticket;
    const comments = await fetchTicketComments(t.id);
    return { id: t.id, subject: t.subject, created_at: t.created_at, status: t.status, comments };
  } catch (e) {
    console.error(`[auditor] fetchTicketById(${ticketId}) failed: ${e.response?.status} ${e.response?.data?.error || e.message}`);
    return null;
  }
}

async function getRecentSolvedTickets(match, limit) {
  const base = zdBase();
  const ticketMap = new Map();

  // Org-level endpoint — fast but often returns 0 for accounts whose tickets are indexed under users
  if (match.zdOrgId) {
    try {
      const data = await zdAuditorGet(`${base}/organizations/${match.zdOrgId}/tickets`, {
        sort_by: 'created_at', sort_order: 'desc', per_page: limit,
      });
      await auditorDelay(80);
      for (const t of (data.tickets || [])) ticketMap.set(t.id, t);
    } catch (e) { /* fall through */ }
  }

  // Always also query per-user — catches cases where org endpoint returns 0 (common for Ring Savvy / older accounts)
  const userIds = match.zdUserIds?.length ? match.zdUserIds.slice(0, 5) : (match.zdUserId ? [match.zdUserId] : []);
  for (const userId of userIds) {
    try {
      const data = await zdAuditorGet(`${base}/users/${userId}/tickets/requested`, {
        sort_by: 'created_at', sort_order: 'desc', per_page: limit,
      });
      await auditorDelay(80);
      for (const t of (data.tickets || [])) { if (!ticketMap.has(t.id)) ticketMap.set(t.id, t); }
    } catch (e) { /* continue */ }
  }

  const sorted = [...ticketMap.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  return Promise.all(sorted.map(async t => {
    const comments = await fetchTicketComments(t.id);
    return { id: t.id, subject: t.subject, created_at: t.created_at, comments };
  }));
}

async function getCancellationKeywordTickets(match) {
  const base = zdBase();
  const keywords = '(cancel OR cancellation OR terminate OR "close account" OR competitor OR refund OR "cancel service")';
  const ticketMap = new Map();

  if (match.zdOrgId) {
    try {
      const data = await zdAuditorGet(`${base}/search`, {
        query: `${keywords} organization_id:${match.zdOrgId} type:ticket`,
        sort_by: 'created_at', sort_order: 'desc', per_page: 5,
      });
      await auditorDelay(80);
      for (const t of (data.results || [])) { if (!ticketMap.has(t.id)) ticketMap.set(t.id, t); }
    } catch (e) { /* fall through */ }
  }

  // Always also search across all user IDs — catches cases where org search misses tickets
  const userIds = match.zdUserIds?.length ? match.zdUserIds.slice(0, 5) : (match.zdUserId ? [match.zdUserId] : []);
  for (const userId of userIds) {
    try {
      const data = await zdAuditorGet(`${base}/search`, {
        query: `${keywords} requester_id:${userId} type:ticket`,
        sort_by: 'created_at', sort_order: 'desc', per_page: 5,
      });
      await auditorDelay(80);
      for (const t of (data.results || [])) { if (!ticketMap.has(t.id)) ticketMap.set(t.id, t); }
    } catch (e) { /* continue */ }
  }

  const tickets = [...ticketMap.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);
  return Promise.all(tickets.map(async t => {
    const comments = await fetchTicketComments(t.id);
    return { id: t.id, subject: t.subject, created_at: t.created_at, comments };
  }));
}

// ─── Known competitor / AI service name lookup ────────────────────────────────
const AI_SERVICE_NAMES = [
  { name: 'Smith.ai',      pattern: /smith\.ai/i },
  { name: 'Lex',           pattern: /\blex\b/i },
  { name: 'Goodcall',      pattern: /goodcall/i },
  { name: 'Answering.AI',  pattern: /answering\.ai/i },
  { name: 'Dialpad',       pattern: /dialpad/i },
  { name: 'Convoso',       pattern: /convoso/i },
  { name: 'Rosie',         pattern: /\brosie\b/i },
  { name: 'Numa',          pattern: /\bnuma\b/i },
];

const HUMAN_COMPETITOR_NAMES = [
  { name: 'Ruby',                  pattern: /\bruby\b/i },
  { name: 'PATLive',               pattern: /patlive/i },
  { name: 'AnswerConnect',         pattern: /answer\s*connect/i },
  { name: 'Gabbyville',            pattern: /gabbyville/i },
  { name: 'MAP Communications',    pattern: /map\s*communications/i },
  { name: 'Davinci',               pattern: /\bdavinci\b/i },
  { name: 'Moneypenny',            pattern: /moneypenny/i },
  { name: 'Abby Connect',          pattern: /abby\s*connect/i },
  { name: 'Alert Communications',  pattern: /alert\s*communications/i },
  { name: 'VoiceNation',           pattern: /voicenation/i },
  { name: 'Answering365',          pattern: /answering\s*365/i },
  { name: 'Nexa',                  pattern: /\bnexa\b/i },
];

// ─── Keyword-based cancellation analysis (no external AI needed) ─────────────
const CATEGORY_RULES = [
  { category: 'Switched to AI Service', patterns: [
    [/smith\.ai/i, 5], [/\blex\b/i, 4], [/goodcall/i, 5],
    [/answering\.ai/i, 5], [/dialpad/i, 4],
    [/convoso/i, 5], [/\brosie\b/i, 5], [/\bnuma\b/i, 5],
    [/\bai\s+(answering|receptionist|service|intake|solution|platform|tool|product|system|bot|chatbot)/i, 5],
    [/(answering|receptionist|intake)\s+ai/i, 4],
    [/went\s+to\s+ai\b/i, 5], [/switched?\s+to\s+(an?\s+)?ai\b/i, 5],
    [/using\s+(an?\s+)?ai\b/i, 4], [/moved?\s+to\s+(an?\s+)?ai\b/i, 5],
    [/trying\s+(an?\s+)?ai\s+(answering|service|receptionist|platform|tool)/i, 4],
    [/artificial intelligence/i, 3], [/ai\s+platform/i, 5],
  ]},
  { category: 'Went to Competitor', patterns: [
    [/competi(tor|tors|ng)/i, 4], [/switch(ing|ed|es)?\s+(to|away|service)/i, 1],
    [/going with (another|different|other|a\s+new)/i, 3],
    [/ruby\b/i, 4], [/patlive/i, 5], [/answer\s*connect/i, 5],
    [/gabbyville/i, 5], [/map\s*communications/i, 5], [/davinci\b/i, 4],
    [/moneypenny/i, 5], [/abby\s*connect/i, 5], [/voicenation/i, 5],
    [/answering\s*365/i, 5], [/\bnexa\b/i, 5],
    [/different (answering\s+)?service/i, 2], [/another (answering\s+)?service/i, 2],
    [/found (a\s+)?cheaper/i, 3],
  ]},
  { category: 'Price is Too High', patterns: [
    [/too expensive/i, 4], [/can'?t afford/i, 4], [/overpriced/i, 4],
    [/over\s*budget/i, 3], [/cheaper (option|alternative|service|provider)/i, 4],
    [/rate increase/i, 3], [/price(s)? (too |are )?(high|much)/i, 4],
    [/cost(ing|s)? too much/i, 4], [/cut(ting)?\s+(back\s+)?cost/i, 3],
    [/reduc(e|ing)\s+(our\s+)?cost/i, 3], [/save money/i, 2], [/billing concern/i, 2],
    [/what (i'?m|we'?re) pay(ing)?/i, 3], [/for what (i|we) pay/i, 3],
    [/could (hire|get|find|pay) .{0,40}(\$\d|\d+\s*dollar|\bless\b)/i, 4],
    [/\$\d+\s*(\/|per|a)\s*(hour|hr|month|mo)/i, 3],
    [/not worth (the price|what (i|we) pay)/i, 4],
  ]},
  { category: 'Downsizing Practice', patterns: [
    [/downsiz(ing|e|ed)/i, 4], [/scaling (back|down)/i, 4],
    [/reducing (staff|size|team|office)/i, 3], [/smaller (practice|firm|office)/i, 3],
    [/cutting back/i, 3], [/shrink(ing)?\s+(the\s+)?(practice|firm)/i, 3],
    [/slow(er|ing)\s+(business|down)/i, 2], [/less (call|client|business) volume/i, 2],
  ]},
  { category: 'Hired Staff', patterns: [
    [/hired (a\s+)?(receptionist|staff|assistant|employee|secretary)/i, 4],
    [/hire(d|ing)\s+(someone|a\s+person|in-?house)/i, 3],
    [/new (receptionist|staff|assistant|employee|hire)/i, 3],
    [/in(-|\s*)house (receptionist|staff|coverage|answering)/i, 4],
    [/front\s*desk (person|staff|coverage)/i, 3],
    [/have (someone|staff) (now|to answer)/i, 3], [/no longer need/i, 2],
  ]},
  { category: 'Quality Issues', patterns: [
    [/quality (issue|problem|concern)/i, 4], [/miss(ing|ed) calls?/i, 4],
    [/wrong (message|information|number)/i, 3], [/incorrect (message|information)/i, 3],
    [/(bad|poor) (service|quality|experience)/i, 4], [/unprofessional/i, 4],
    [/complaint/i, 3], [/not (satisfied|happy) with (the\s+)?service/i, 3],
    [/dissatisf(ied|action)/i, 4], [/terrible service/i, 3],
  ]},
  { category: 'Closed Practice', patterns: [
    [/clos(ing|ed|e) (the\s+)?(practice|firm|office|business)/i, 4],
    [/shut(ting)?\s+(down|the\s+practice)/i, 4], [/retir(ing|ed|ement)/i, 4],
    [/no longer practicing/i, 4], [/dissolv(ing|ed)\s+(the\s+)?(firm|practice)/i, 4],
    [/going out of business/i, 4], [/winding down/i, 3],
  ]},
  { category: 'Leaving Firm', patterns: [
    [/leaving (the\s+)?(firm|company|practice)/i, 4], [/left (the\s+)?(firm|company)/i, 4],
    [/no longer (at|with) (the\s+)?(firm|company)/i, 4],
    [/moving on/i, 3], [/parting ways/i, 3], [/transition(ing)? (out|away)/i, 3],
  ]},
  { category: 'Fired', patterns: [
    [/\bfired\b/i, 4], [/\bterminat(ed|ion)\b/i, 3], [/\blet go\b/i, 3],
    [/\blaid off\b/i, 3], [/\bdismiss(ed|al)\b/i, 3],
  ]},
  { category: 'Not Enough Call Volume', patterns: [
    [/not enough (calls?|volume)/i, 4], [/low (call\s+)?volume/i, 4],
    [/too few calls/i, 4], [/(barely|rarely) (get|receive|have) calls/i, 3],
    [/don'?t (receive|get) enough calls/i, 3],
    [/calls? (have\s+)?(slowed|decreased|dropped)/i, 3],
  ]},
  { category: 'Wanted Features/Services Not Offered', patterns: [
    [/feature (request|not available|missing)/i, 4],
    [/doesn'?t (have|offer|support)\s+.{0,30}(need|want|require)/i, 3],
    [/can'?t (integrate|connect|sync)/i, 3],
    [/need(s|ed)?\s+(a\s+)?(feature|integration|capability)/i, 3],
    [/wish (you|it)\s+(had|offer(ed)?|support(ed)?)/i, 3],
    [/(intake|scheduling|crm)\s+(integration|software)/i, 3],
  ]},
  { category: 'Does Not See Value in Service', patterns: [
    [/not worth (it|the cost|the price)/i, 4], [/don'?t (see|find)\s+(the\s+)?value/i, 4],
    [/no (longer\s+)?benefit/i, 3], [/doesn'?t (justify|make sense)/i, 3],
    [/\broi\b/i, 3], [/return on investment/i, 3],
    [/not getting (enough\s+)?(return|value|benefit)/i, 4], [/waste of money/i, 4],
  ]},
];

function buildAuditPrompt(customer, ticketData) {
  const transcripts = ticketData.map(t => {
    const date = t.created_at ? ` (${t.created_at.slice(0, 10)})` : '';
    const lines = [`Ticket #${t.id}${date} — "${t.subject || '(no subject)'}"`];
    for (const c of (t.comments || [])) {
      const who = c.public === false ? '[Internal note]' : '[Message]';
      const body = (c.body || '').slice(0, 1500).trim();
      if (body) lines.push(`${who}: ${body}`);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const notesContext = customer.notes ? `\nCSV cancellation notes: "${customer.notes}"\n` : '';
  const categoriesList = AUDITOR_CATEGORIES.map(c => `- ${c}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);

  return `You are a cancellation analyst for Answering Legal and Ring Savvy.
Today's date: ${today}

ABOUT THE BUSINESS:
- Answering Legal (answeringlegal.com): 24/7 live answering service for law firms. U.S.-based receptionists answer calls, capture leads, handle client intake, and schedule appointments for attorneys. Rated #1 legal answering service, 2,000+ law firms.
- Ring Savvy (ringsavvy.com): Sister brand — same service for trades/contractors (plumbers, HVAC, roofers, mechanical, electricians, etc.).
- Customers forward their phone lines to us so our receptionists answer calls on their behalf.

ABOUT ZENDESK TICKETS IN THIS SYSTEM:
- The requester on a ticket can be either the customer or an Answering Legal/Ring Savvy agent filing a follow-up.
- [Message] = public reply, visible to both parties — the actual customer conversation.
- [Internal note] = agent-only, not visible to customer — coordination, templates, read receipts. Ignore for determining reason.
- Read ALL messages in every ticket thread. The cancellation reason is almost always in the customer's own words in a [Message], not in the subject line.

COMMON TICKET SUBJECT PATTERNS (do NOT use the subject as the reason — read the body):
- "Account Cancellation Confirmation" = agent template confirming the cancellation. Reason is in the thread.
- "We're Sorry to See You Go" = farewell template sent after cancellation. Not a reason.
- "Cancellation Request - [Firm]" = agent-filed ticket. Customer reason is in the comments.
- "30 Day cancellation request" / "Cancelation notice" = customer giving notice. Reason usually in the body.
- "Termination of Answering Services" = strong customer cancellation notice.
- "Reached Allotted Minutes" = customer hit usage cap — may relate to price or value complaint.
- "Misinformation" / complaint tickets = can escalate to cancellation. Look for cancellation language in thread.
- "Account Update" = generic subject; read body for context.
- "Turn Off Call Forwarding" = post-cancellation cleanup task. NOT a reason.
- "Welcome to [Service] App!" / "New Ticket Created" = onboarding tickets. Not relevant.
- "RE: [Answering Legal] Re: ..." = reply in a thread. Read full body.

KNOWN COMPETITORS AND AI SERVICES:
- AI answering tools (use "Switched to AI Service"): Smith.ai, Lex, LEX Reception, Goodcall, Rosie, Numa, Answering.AI, Dialpad AI, Ruby AI, Convoso
- Human answering services (use "Went to Competitor"): Ruby Receptionist, PATLive, AnswerConnect, MAP Communications, Gabbyville, VoiceNation, Alert Communications
- "Lex" / "LEX" is an AI legal receptionist tool — NOT a law firm
- Hiring a virtual assistant (VA) for $X/hour = "Price is Too High" (price comparison) OR "Hired Staff" if they actually plan to hire, NOT "Switched to AI Service"

INTEGRATIONS THAT ARE NOT COMPETITORS:
- Clio, MyCase, PracticePanther, Filevine, Litify, Lawmatics = legal practice management software that integrates WITH Answering Legal. Tickets about these are support/setup requests, NOT cancellations.
- "AI intake chatbot" / "intake chatbot" = Answering Legal's own free feature. NOT an outside service.
- Ring Savvy / Answering Legal themselves are NOT competitors.

Customer: ${customer.accountName || customer.orgName || 'Unknown'}${notesContext}

Full ticket conversation(s) — read the ENTIRE thread before deciding:
${transcripts || '(no ticket content available)'}

Choose the single best cancellation reason from these categories:
${categoriesList}

Critical rules:
- A ticket about integrating with or setting up our service is NOT a cancellation reason.
- "Switched to AI Service" = replaced us with an AI answering/receptionist tool
- "Went to Competitor" = switched to another HUMAN answering service
- "Hired Staff" = hired a human in-house receptionist or employee — NOT an AI tool
- "Wanted Features/Services Not Offered" = wanted outbound calling, specific integrations, or capabilities we don't have
- "Does Not See Value in Service" = not enough calls to justify cost, or service didn't meet expectations
- Agent asking to turn off call forwarding = post-cancellation cleanup. NOT a reason.
- Base your answer on the customer's actual words in [Message] blocks, not agent templates or [Internal note] blocks.

Respond with ONLY valid JSON, no markdown:
{"category":"<category>","competitorName":"<company name or null>","confidence":"High|Medium|Low","summary":"<1-2 sentence plain English summary>","reasoning":"<brief note on signals>","relevantTicketIds":[<1-2 ticket IDs from above that most clearly show the reason, e.g. 12345>]}`;
}

function parseAuditResponse(raw, ticketData) {
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`AI returned non-JSON: ${raw.slice(0, 120)}`);
  }
  const category = AUDITOR_CATEGORIES.includes(parsed.category) ? parsed.category : 'Unknown / Unspecified';

  // Use AI-identified ticket IDs if they reference tickets we actually have; fall back to first 3
  const aiIds = Array.isArray(parsed.relevantTicketIds)
    ? parsed.relevantTicketIds.map(Number).filter(id => ticketData.some(t => t.id === id)).slice(0, 3)
    : [];
  const supporting_ticket_ids = aiIds.length > 0 ? aiIds : ticketData.slice(0, 3).map(t => t.id);

  return {
    category,
    competitorName: parsed.competitorName || null,
    confidence: ['High','Medium','Low'].includes(parsed.confidence) ? parsed.confidence : 'Low',
    summary: parsed.summary || '',
    reasoning: parsed.reasoning || '',
    supporting_ticket_ids,
    analysisMethod: 'ai',
  };
}

async function claudeAnalyzeTickets(customer, ticketData) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildAuditPrompt(customer, ticketData);
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseAuditResponse(msg.content[0]?.text?.trim() || '', ticketData);
}

async function geminiAnalyzeTickets(customer, ticketData) {
  const prompt = buildAuditPrompt(customer, ticketData);
  const resp = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 500, temperature: 0.1 } },
    { headers: { 'X-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return parseAuditResponse(raw, ticketData);
}

async function openaiAnalyzeTickets(customer, ticketData) {
  const prompt = buildAuditPrompt(customer, ticketData);
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 500, temperature: 0.1, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '{}';
  return parseAuditResponse(raw, ticketData);
}

// Pick whichever AI provider key is configured; fall back to keywords on any error
async function runAnalysis(customer, tickets) {
  const tryAI = async (fn) => {
    try { return await fn(); }
    catch (e) {
      const status = e?.response?.status;
      // Fall back for rate limits, server errors, network failures, JSON parse errors, etc.
      // Only re-throw for auth errors (401/403) which indicate a misconfigured key
      if (status === 401 || status === 403) throw e;
      console.warn(`[auditor] AI error (${status || e.message}), falling back to keywords`);
      return { ...analyzeTickets(customer, tickets), analysisMethod: 'keywords' };
    }
  };
  if (process.env.GEMINI_API_KEY)     return tryAI(() => geminiAnalyzeTickets(customer, tickets));
  if (process.env.ANTHROPIC_API_KEY)  return tryAI(() => claudeAnalyzeTickets(customer, tickets));
  if (process.env.OPENAI_API_KEY)     return tryAI(() => openaiAnalyzeTickets(customer, tickets));
  return { ...analyzeTickets(customer, tickets), analysisMethod: 'keywords' };
}

function analyzeTickets(customer, ticketData) {
  const ticketTexts = ticketData.map(t => {
    const parts = [t.subject || ''];
    for (const c of (t.comments || [])) { if (c.body) parts.push(c.body.slice(0, 800)); }
    return { id: t.id, subject: t.subject, date: t.created_at?.slice(0, 10), text: parts.join(' ') };
  });

  // Include CSV notes in analysis so "went to Lex" from the notes column is scored
  if (customer.notes) {
    ticketTexts.unshift({ id: 'notes', subject: 'Notes', date: null, text: customer.notes });
  }

  const scores = CATEGORY_RULES.map(rule => {
    let score = 0;
    const matchedTerms = [];
    const matchedIds = new Set();
    for (const [pattern, weight] of rule.patterns) {
      for (const t of ticketTexts) {
        if (pattern.test(t.text)) { score += weight; if (t.id !== 'notes') matchedIds.add(t.id); matchedTerms.push(pattern.source.replace(/[\\^$.*+?()[\]{}|]/g, '').slice(0, 20)); }
      }
    }
    return { category: rule.category, score, matchedTerms: [...new Set(matchedTerms)], matchedIds: [...matchedIds] };
  });

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];

  const confidence = best.score === 0 ? 'Low' : best.score >= 8 && best.score >= second.score * 2 ? 'High' : best.score >= 4 ? 'Medium' : 'Low';
  const category  = best.score > 0 ? best.category : 'Unknown / Unspecified';

  // Extract specific competitor / AI company name if applicable
  let competitorName = null;
  if (category === 'Switched to AI Service' || category === 'Went to Competitor') {
    const allText = ticketTexts.map(t => t.text).join(' ');
    const nameList = category === 'Switched to AI Service' ? AI_SERVICE_NAMES : HUMAN_COMPETITOR_NAMES;
    const found = nameList.find(n => n.pattern.test(allText));
    if (found) competitorName = found.name;
  }

  // Extract a supporting sentence
  let snippet = '';
  if (best.score > 0) {
    const rule = CATEGORY_RULES.find(r => r.category === category);
    outer: for (const t of ticketTexts) {
      for (const s of t.text.split(/[.!?\n]+/).filter(s => s.trim().length > 20)) {
        if (rule.patterns.some(([p]) => p.test(s))) { snippet = s.trim().slice(0, 180); break outer; }
      }
    }
  }

  const competitorSuffix = competitorName ? ` (${competitorName})` : '';
  const summary = category === 'Unknown / Unspecified'
    ? `No clear cancellation reason identified from ${ticketData.length} ticket(s). No explicit cancellation context found in recent conversations.`
    : snippet
      ? `Customer's cancellation is consistent with: ${category}${competitorSuffix}. From ticket history: "${snippet}"`
      : `Cancellation reason categorized as "${category}${competitorSuffix}" based on keyword signals across ${ticketData.length} ticket(s).`;

  const reasoning = best.score > 0
    ? `Score ${best.score} for "${category}"${best.matchedTerms.length ? ` (signals: ${best.matchedTerms.slice(0, 3).join(', ')})` : ''}.${second.score > 0 ? ` Runner-up: "${second.category}" (${second.score}).` : ''}`
    : 'No keyword signals matched any category.';

  return {
    category,
    competitorName,
    summary,
    confidence,
    reasoning,
    supporting_ticket_ids: best.matchedIds.length ? best.matchedIds : ticketData.slice(0, 2).map(t => t.id),
  };
}

async function runAuditJob(jobId, rows) {
  const job = auditorJobs.get(jobId);
  if (!job) return;

  for (const rawRow of rows) {
    const row = normalizeAuditorRow(rawRow);
    const explicitTicketIds = parseTicketIdsFromRow(rawRow);
    const baseResult = {
      accountName: row.accountName || '',
      emailDomain: row.emailDomain || '',
      customerEmail: row.customerEmail || '',
      matchedOrg: null,
      matchConfidence: null,
      matchType: null,
      category: null,
      competitorName: null,
      summary: null,
      confidence: null,
      reasoning: null,
      supportingTicketIds: [],
      ticketSubjects: [],
      ticketDates: [],
      status: 'done',
      error: null,
      zdSubdomain: process.env.ZENDESK_SUBDOMAIN || '',
    };

    try {
      // Phase 0 — fetch any ticket IDs explicitly referenced in notes (e.g. "See ticket #331182")
      const ticketMap = new Map();
      console.log(`[auditor] row "${row.accountName || row.orgName || '?'}" — explicitTicketIds: [${explicitTicketIds.join(', ')}]`);
      for (const tid of explicitTicketIds) {
        const t = await fetchTicketById(tid);
        if (t) ticketMap.set(t.id, t);
      }

      // If explicit tickets found, skip expensive customer search — we already have what we need
      if (ticketMap.size > 0) {
        baseResult.matchedOrg = row.accountName || row.orgName || 'Unknown';
        baseResult.matchConfidence = 'High';
        baseResult.matchType = 'noteTicketId';
      } else {
        // Match customer in Zendesk
        const match = await matchCustomer(row);
        console.log(`[auditor] matchCustomer("${row.accountName || row.orgName}") → ${match ? `type:${match.matchType} org:${match.zdOrgName} orgId:${match.zdOrgId} userIds:[${match.zdUserIds?.join(',')}]` : 'null'}`);

        if (!match) {
          job.results.push({ ...baseResult, status: 'no_match' });
          job.done++;
          continue;
        }

        baseResult.matchedOrg = match.zdOrgName;
        baseResult.matchConfidence = match.matchConfidence;
        baseResult.matchType = match.matchType;

        // Phase 1 — recent tickets for this customer
        for (const t of await getRecentSolvedTickets(match, 5)) {
          if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
        }

        // Phase 2 — cancellation keyword search
        for (const t of await getCancellationKeywordTickets(match)) {
          if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
        }

        // Phase 3 — historical sweep if still < 3 tickets
        if (ticketMap.size < 3) {
          for (const t of await getRecentSolvedTickets(match, 10)) {
            if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
          }
        }
      }

      const tickets = Array.from(ticketMap.values());

      if (tickets.length === 0) {
        job.results.push({ ...baseResult, category: 'Unknown / Unspecified', summary: 'No tickets found in Zendesk for this customer.', confidence: 'Low', reasoning: 'No ticket data available.', status: 'done' });
        job.done++;
        continue;
      }

      baseResult.ticketSubjects = tickets.map(t => t.subject || '');
      baseResult.ticketDates = tickets.map(t => t.created_at?.slice(0, 10) || '');

      // Throttle AI calls to stay within free-tier rate limits
      if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY)
        await auditorDelay(22000);  // OpenAI free tier: 3 RPM
      const analysis = await runAnalysis(row, tickets);
      baseResult.category = analysis.category;
      baseResult.competitorName = analysis.competitorName || null;
      baseResult.summary = analysis.summary;
      baseResult.confidence = analysis.confidence;
      baseResult.reasoning = analysis.reasoning;
      baseResult.supportingTicketIds = analysis.supporting_ticket_ids || [];
      baseResult.analysisMethod = analysis.analysisMethod || 'ai';

      job.results.push({ ...baseResult, status: 'done' });
    } catch (err) {
      job.results.push({ ...baseResult, status: 'error', error: err.message });
    }

    job.done++;
  }

  job.status = 'done';
  // Clean up completed job after 2 hours to prevent memory leak
  setTimeout(() => auditorJobs.delete(jobId), 2 * 60 * 60 * 1000);
}

app.get('/api/zendesk-auditor/categories', requireRole('super_admin', 'zendesk_auditor'), (req, res) => {
  res.json({ categories: AUDITOR_CATEGORIES });
});

app.post('/api/zendesk-auditor/run', requireRole('super_admin', 'zendesk_auditor'), auditorUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Failed to parse file: ' + e.message });
  }

  if (!rows || rows.length === 0) return res.status(400).json({ error: 'Spreadsheet is empty or could not be parsed' });

  const jobId = Date.now().toString(36);
  auditorJobs.set(jobId, { status: 'running', results: [], total: rows.length, done: 0, error: null });

  // Fire and forget — results stream via SSE
  runAuditJob(jobId, rows).catch(err => {
    const job = auditorJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.json({ jobId, total: rows.length });
});

app.get('/api/zendesk-auditor/stream/:jobId', requireRole('super_admin', 'zendesk_auditor'), (req, res) => {
  const { jobId } = req.params;
  const job = auditorJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sentCount = 0;

  const interval = setInterval(() => {
    const current = auditorJobs.get(jobId);
    if (!current) { clearInterval(interval); res.end(); return; }

    // Send any new results
    while (sentCount < current.results.length) {
      const result = current.results[sentCount];
      res.write(`data: ${JSON.stringify({ type: 'result', result, done: current.done, total: current.total })}\n\n`);
      sentCount++;
    }

    // Also send progress even if no new result
    res.write(`data: ${JSON.stringify({ type: 'progress', done: current.done, total: current.total, status: current.status })}\n\n`);

    if (current.status === 'done' || current.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'done', done: current.done, total: current.total, status: current.status, error: current.error })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 800);

  req.on('close', () => clearInterval(interval));
});

app.get('/api/zendesk-auditor/results/:jobId', requireRole('super_admin', 'zendesk_auditor'), (req, res) => {
  const { jobId } = req.params;
  const job = auditorJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── React SPA Catch-All ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Call Center Ops Backend running on port ${PORT}`);
  console.log(`   App: http://localhost:${PORT}/`);
});
