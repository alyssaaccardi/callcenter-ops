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
const { passport, requireAuth, requireRole, isAuthedOrKey, listUsers, addUser, removeUser } = require('./auth');
const multer = require('multer');
const XLSX   = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const mitelLeaderboard = require('./mitel-leaderboard');

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

// 5MB is well above any current payload (MiCC leaderboard reports + staff broadcast
// posts can comfortably exceed the 100KB default).
app.use(express.json({ limit: '5mb' }));

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

// Internal SMS history — full record incl. recipient phone numbers / sender.
// Wix widget reads sanitized data from /api/widget/sms-history instead.
app.get('/api/sms-history', requireAuth, (req, res) => {
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

// Middleware: accepts a TV session token via ?t= OR delegates to requireAuth
// (which accepts session cookie or X-API-Key on GETs). Used on endpoints that
// must be reachable by both the internal React app and the office TV displays.
function tvOrAuth(req, res, next) {
  const token = req.query.t;
  if (token) {
    const sessions = loadTvSessions();
    if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid or expired token' });
    return next();
  }
  return requireAuth(req, res, next);
}

app.get('/api/status', tvOrAuth, (req, res) => {
  res.json(statusStore);
});

// ─── Public Widget Endpoints (no auth — for the Wix embed) ───────────────────
// Return only the fields the widget renders. Strips employee names, internal
// flags, and unrelated systems' state so a public scrape can't pivot from them.
function setWidgetCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
}

app.get('/api/widget/status', (req, res) => {
  setWidgetCors(res);
  const pick = (s) => s ? { state: s.state, message: s.message || '' } : { state: 'UP', message: '' };
  res.json({
    mitelClassic: pick(statusStore.mitelClassic),
    savvyPhone:   pick(statusStore.savvyPhone),
    updatedAt:    statusStore.updatedAt,
  });
});

app.get('/api/widget/sms-history', (req, res) => {
  setWidgetCors(res);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  // Strip fields that aren't needed publicly (e.g. sender identity, recipient phone numbers)
  const safe = smsHistory.slice(0, limit).map(e => ({
    message: e.message,
    sentAt:  e.sentAt,
    groups:  e.groups || [],
  }));
  res.json(safe);
});

app.get('/api/widget/staff-broadcast', (req, res) => {
  setWidgetCors(res);
  const b = loadBroadcast();
  if (!b) return res.json({ empty: true });
  // Drop `updatedBy` so the broadcast author's name isn't exposed publicly
  res.json({
    title:     b.title     || '',
    body:      b.body      || '',
    imageUrl:  b.imageUrl  || '',
    links:     b.links     || [],
    updatedAt: b.updatedAt || null,
  });
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
app.get('/api/bandwidth/dids', requireAuth, async (req, res) => {
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
          {
            headers: { ...authHeader, Accept: 'application/xml' },
            params,
            maxRedirects: 5,
            responseType: 'text',
            transformResponse: [d => d],
          }
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

// Internal — full record incl. author identity. Wix embed uses /api/widget/staff-broadcast.
app.get('/api/staff-broadcast', requireAuth, (req, res) => {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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

app.get('/api/hubspot/dids', tvOrAuth, async (req, res) => {
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

app.get('/api/monday/account-review', requireAuth, async (req, res) => {

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

app.get('/api/xcally/queue', requireAuth, async (req, res) => {
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
  } else if (!isAuthedOrKey(req)) {
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
  } else if (!isAuthedOrKey(req)) {
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
app.get('/api/mitel/cloudlink/calls', requireAuth, async (req, res) => {
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
  'Non-Payment',
  'Switched to AI Service', 'Went to Competitor', 'Price Too High',
  'Did Not Want to Pay Rate Increase / Overages',
  'Downsizing Practice', 'Hired Staff',
  'IVR / Auto Attendant',
  'Quality', 'Call Forwarding Issue',
  'Closed Practice', 'Retired',
  'Leaving Firm', 'Fired', 'Not Enough Call Volume',
  "Wanted Features/Services We Don't Offer",
  'Wanted Real Time Reporting / Portal',
  'Answering Service Included In Suite',
  'Moved to Shared Office Space',
  'Appointed Judge',
  "Doesn't See Value", 'Unknown / Unspecified',
  'No Cancellation Evidence Found',
];

const auditorUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function auditorDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const NOTE_NOISE_VALUES = new Set([
  '', '(none)', 'none', '(blank)', 'blank', 'no note', 'no notes',
  'unknown', 'unknown or unspecified reason', 'unspecified',
  'no reason given', 'no reason stated', 'no other reason given',
  'no other reason given.', 'no reason given.', 'no response',
  'no response.',
]);

// Normalize spreadsheet column names to known fields. Notes columns are
// concatenated rather than overwritten — many real exports have notes
// split across multiple columns (raw note, Monday note, billing note,
// updated reason, etc.).
function normalizeAuditorRow(raw) {
  const normalized = {};
  const noteFragments = [];
  for (const [key, val] of Object.entries(raw)) {
    const k = String(key).toLowerCase().trim().replace(/[\s_\-()]+/g, '');
    if (['accountname','account','company','firmname','firm','name','client','clientname',
         'business','businessname','customer','customername','lawfirm','practicename'].includes(k))
      normalized.accountName = String(val || '').trim();
    else if (['emaildomain','domain'].includes(k))
      normalized.emailDomain = String(val || '').trim();
    else if (['customeremail','email','contactemail','primaryemail','billingemail','emailaddress'].includes(k))
      normalized.customerEmail = String(val || '').trim();
    else if (['orgname','organizationname','org','organization'].includes(k))
      normalized.orgName = String(val || '').trim();
    else if (k.includes('note') || k.includes('reason') || k.includes('comment') || k.includes('description') || k.includes('details')) {
      const v = String(val || '').trim();
      if (v && !NOTE_NOISE_VALUES.has(v.toLowerCase())) noteFragments.push(v);
    }
  }
  if (noteFragments.length > 0) {
    normalized.notes = [...new Set(noteFragments)].join(' | ');
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

function normalizeMatchText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[&,.()"'\/\\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Score a candidate name/text against a target (accountName). Returns 0..1.
// 1.0 = exact normalized match, 0.95 = phrase substring, else fraction of target
// tokens present in candidate. Short tokens (< 2 chars) are ignored on both sides.
function nameMatchScore(target, candidate) {
  const t = normalizeMatchText(target);
  const c = normalizeMatchText(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1.0;
  if (c.includes(t)) return 0.95;
  const tTokens = new Set(t.split(' ').filter(w => w.length >= 2));
  const cTokens = new Set(c.split(' ').filter(w => w.length >= 2));
  if (tTokens.size === 0 || cTokens.size === 0) return 0;
  let hits = 0;
  for (const w of tTokens) if (cTokens.has(w)) hits++;
  return hits / tTokens.size;
}

async function matchCustomer(row) {
  const base = zdBase();
  const userSet = new Map();
  const nameQuery = row.accountName || row.orgName || '';
  const domain = String(row.emailDomain || '').toLowerCase().trim();

  // Track which users came from which signal so we can weight confidence later
  const emailHits = new Set();
  const domainHits = new Set();

  const searches = [];

  // Signal 1 — exact email match
  if (row.customerEmail) {
    searches.push(
      zdAuditorGet(`${base}/users/search`, { query: `email:${row.customerEmail}` })
        .then(data => { for (const u of (data.users || [])) { userSet.set(u.id, u); emailHits.add(u.id); } })
        .catch(() => {})
    );
  }

  // Signal 2 — domain match (find users whose email ends in @domain)
  if (domain) {
    searches.push(
      zdAuditorGet(`${base}/users/search`, { query: `email:*@${domain}`, per_page: 25 })
        .then(data => {
          for (const u of (data.users || [])) {
            if (u.role !== 'agent' && u.role !== 'admin') { userSet.set(u.id, u); domainHits.add(u.id); }
          }
        })
        .catch(() => {})
    );
  }

  // Signal 3 — name search (broader, per_page bumped; short tokens now preserved)
  if (nameQuery) {
    const clean = nameQuery.replace(/[&,.()"'\/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    // Bug fix: previously filtered w.length > 2 which dropped "EZ" from "EZ Divorce"
    // (leaving the search as just "Divorce" and matching any random Divorce customer).
    // Keep any token of length >= 2 so short-but-critical name components survive.
    const tokens = clean.split(' ').filter(w => w.length >= 2);
    const q = tokens.slice(0, 5).join(' ');
    if (q.length >= 2) {
      searches.push(
        zdAuditorGet(`${base}/users/search`, { query: q, per_page: 25 })
          .then(data => {
            for (const u of (data.users || [])) {
              if (u.role !== 'agent' && u.role !== 'admin') userSet.set(u.id, u);
            }
          })
          .catch(() => {})
      );
    }
  }

  // Signal 4 — direct organization search by name (highest-signal for firm/account names)
  const orgCandidates = new Map(); // orgId -> org
  if (nameQuery) {
    const cleanForOrg = nameQuery.replace(/["]/g, '').trim();
    if (cleanForOrg.length >= 2) {
      searches.push(
        zdAuditorGet(`${base}/search`, { query: `type:organization ${cleanForOrg}`, per_page: 10 })
          .then(data => {
            for (const org of (data.results || [])) {
              if (org && org.id && (org.result_type === 'organization' || org.name)) {
                orgCandidates.set(org.id, org);
              }
            }
          })
          .catch(() => {})
      );
    }
  }

  await Promise.all(searches);

  const users = [...userSet.values()];

  // Fetch org details for every unique organization_id referenced by returned users
  const userOrgIds = [...new Set(users.filter(u => u.organization_id).map(u => u.organization_id))];
  const missingOrgIds = userOrgIds.filter(id => !orgCandidates.has(id));
  const fetched = await Promise.all(
    missingOrgIds.map(id => zdAuditorGet(`${base}/organizations/${id}`)
      .then(d => d.organization)
      .catch(() => null))
  );
  for (const org of fetched) { if (org && org.id) orgCandidates.set(org.id, org); }

  if (users.length === 0 && orgCandidates.size === 0) return null;

  // Build scored candidate list. Each candidate is either an org (preferred) or an orgless user.
  const candidates = [];

  for (const [orgId, org] of orgCandidates) {
    const usersInOrg = users.filter(u => u.organization_id === orgId);
    let score = 0;
    let source = 'orgName';

    // Strongest — exact email match landed in this org
    if (usersInOrg.some(u => emailHits.has(u.id))) { score = 1.0; source = 'email'; }

    // Domain match — user email or org.domain_names
    if (domain) {
      const userDomainMatch = usersInOrg.some(u =>
        domainHits.has(u.id) || String(u.email || '').toLowerCase().endsWith('@' + domain)
      );
      const orgDomainMatch = Array.isArray(org.domain_names) &&
        org.domain_names.some(d => String(d).toLowerCase() === domain);
      if (orgDomainMatch && score < 0.95) { score = 0.95; source = source === 'email' ? source : 'orgDomain'; }
      else if (userDomainMatch && score < 0.9)  { score = 0.9;  source = source === 'email' ? source : 'userDomain'; }
    }

    // Name overlap on the org's own name
    if (nameQuery) {
      const ns = nameMatchScore(nameQuery, org.name);
      if (ns > score) { score = ns; source = 'orgName'; }
    }

    candidates.push({
      user: usersInOrg[0] || null,
      users: usersInOrg,
      org,
      score,
      source,
    });
  }

  // Orgless users (rare, but keep them as fallback candidates)
  for (const u of users) {
    if (u.organization_id) continue;
    let score = 0;
    let source = 'userName';
    if (emailHits.has(u.id)) { score = 1.0; source = 'email'; }
    if (domain && (domainHits.has(u.id) || String(u.email || '').toLowerCase().endsWith('@' + domain))) {
      if (score < 0.9) { score = 0.9; source = source === 'email' ? source : 'userDomain'; }
    }
    if (nameQuery) {
      const ns = nameMatchScore(nameQuery, u.name);
      if (ns > score) { score = ns; source = 'userName'; }
    }
    candidates.push({ user: u, users: [u], org: null, score, source });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;

  // Minimum score gate. When only accountName was provided (no email, no domain),
  // demand a stronger name overlap so we don't hand Gemini tickets from a random
  // customer that happens to share one word with the query.
  const hadStrongSignal = emailHits.size > 0 || domainHits.size > 0;
  const MIN_SCORE = hadStrongSignal ? 0.3 : 0.6;
  if (best.score < MIN_SCORE) {
    console.log(`[auditor:match] rejected best candidate — score ${best.score.toFixed(2)} < ${MIN_SCORE} (source=${best.source})`);
    return null;
  }

  const zdOrgId = best.org?.id || best.user?.organization_id || null;
  const zdOrgName = best.org?.name || best.user?.name || nameQuery;
  const zdUserId = best.user?.id || null;
  const zdUserIds = best.users.filter(u => u).map(u => u.id).slice(0, 5);

  const matchConfidence = best.score >= 0.9 ? 'High' : best.score >= 0.5 ? 'Medium' : 'Low';

  return {
    zdOrgId,
    zdOrgName,
    zdUserId,
    zdUserIds: zdUserIds.length ? zdUserIds : (zdUserId ? [zdUserId] : []),
    matchType: best.source,
    matchConfidence,
    matchScore: Math.round(best.score * 100) / 100,
  };
}

async function fetchTicketComments(ticketId) {
  const base = zdBase();
  try {
    const data = await zdAuditorGet(`${base}/tickets/${ticketId}/comments`);
    return (data.comments || []).map(c => ({ body: c.body, public: c.public }));
  } catch (e) {
    return [];
  }
}

async function fetchTicketById(ticketId) {
  const base = zdBase();
  try {
    const data = await zdAuditorGet(`${base}/tickets/${ticketId}`);
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
  const userIds = match.zdUserIds?.length ? match.zdUserIds.slice(0, 3) : (match.zdUserId ? [match.zdUserId] : []);

  const fetches = [];
  if (match.zdOrgId) {
    fetches.push(
      zdAuditorGet(`${base}/organizations/${match.zdOrgId}/tickets`, {
        sort_by: 'created_at', sort_order: 'desc', per_page: limit,
      }).then(data => { for (const t of (data.tickets || [])) ticketMap.set(t.id, t); }).catch(() => {})
    );
  }
  for (const userId of userIds) {
    fetches.push(
      zdAuditorGet(`${base}/users/${userId}/tickets/requested`, {
        sort_by: 'created_at', sort_order: 'desc', per_page: limit,
      }).then(data => {
        for (const t of (data.tickets || [])) { if (!ticketMap.has(t.id)) ticketMap.set(t.id, t); }
      }).catch(() => {})
    );
  }
  await Promise.all(fetches);

  const sorted = [...ticketMap.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  return Promise.all(sorted.map(async t => {
    const comments = await fetchTicketComments(t.id);
    return { id: t.id, subject: t.subject, created_at: t.created_at, comments, satisfactionRating: t.satisfaction_rating || null };
  }));
}

async function getCancellationKeywordTickets(match) {
  const base = zdBase();
  const keywords = '(cancel OR cancellation OR terminate OR "close account" OR competitor OR refund OR "cancel service")';
  const ticketMap = new Map();
  const userIds = match.zdUserIds?.length ? match.zdUserIds.slice(0, 3) : (match.zdUserId ? [match.zdUserId] : []);

  const searches = [];
  if (match.zdOrgId) {
    searches.push(
      zdAuditorGet(`${base}/search`, {
        query: `${keywords} organization_id:${match.zdOrgId} type:ticket`,
        sort_by: 'created_at', sort_order: 'desc', per_page: 5,
      }).then(data => { for (const t of (data.results || [])) ticketMap.set(t.id, t); }).catch(() => {})
    );
  }

  for (const userId of userIds) {
    searches.push(
      zdAuditorGet(`${base}/search`, {
        query: `${keywords} requester_id:${userId} type:ticket`,
        sort_by: 'created_at', sort_order: 'desc', per_page: 5,
      }).then(data => {
        for (const t of (data.results || [])) { if (!ticketMap.has(t.id)) ticketMap.set(t.id, t); }
      }).catch(() => {})
    );
  }
  await Promise.all(searches);

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
  { name: 'Dialpad AI',    pattern: /dialpad/i },
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

// Cancellation signals — at least one must match for keyword analysis to classify churn
const CANCELLATION_SIGNALS = [
  /cancel(l?ing|l?ed|lation)/i,
  /terminat(e|ing|ed|ion)/i,
  /discontinu(e|ing|ed)/i,
  /closing (the\s+)?(account|service|subscription)/i,
  /shut(ting)?\s+down/i,
  /no longer (need|want|use|require)/i,
  /going (with|to) (another|a\s+(different|new|other))/i,
  /switch(ing|ed)\s+(to|away)/i,
  /moving (to|away|on)/i,
  /leaving (the\s+)?(service|firm|company|practice)/i,
  /want(ed|ing)?\s+to\s+cancel/i,
  /request(ing|ed)?\s+(to\s+)?cancel/i,
  /please\s+(cancel|close|terminate)\s+(my|our|the)\s+account/i,
  /clos(e|ing|ed)\s+(my|our|the)?\s+account/i,
  /end(ing)?\s+(my|our|the)?\s+(service|subscription|account)/i,
  /notice\s+(of\s+)?cancel/i,
  /30[\s-]day\s+(cancel|notice)/i,
  /winding\s+down/i,
  /retir(e|ing|ed)/i,
  /out\s+of\s+business/i,
  /dissolv(e|ing|ed)/i,
  /no\s+longer\s+practicing/i,
  /hired\s+(a\s+)?(receptionist|staff|assistant|employee|secretary)/i,
  /in(-|\s*)house\s+(receptionist|staff|answering)/i,
  /\bfired\b/i, /\blaid\s+off\b/i,
  /non[-\s]?payment/i, /lack\s+of\s+communication/i, /\bnsf\b/i,
  /failed\s+payment/i, /(account|service)\s+closed\s+due\s+to/i,
  /past\s+due/i, /unpaid\s+(invoice|balance)/i, /collections?/i,
  /shared\s+office/i, /co[-\s]?work(ing)?\s+space/i, /wework/i, /regus/i,
];

// ─── Keyword-based cancellation analysis (no external AI needed) ─────────────
const CATEGORY_RULES = [
  { category: 'Non-Payment', patterns: [
    [/non[-\s]?payment/i, 6], [/lack\s+of\s+communication/i, 6],
    [/(account|service)\s+closed\s+due\s+to/i, 6],
    [/closed\s+(account|service)\s+(due\s+to|for)\s+(non[-\s]?payment|lack\s+of)/i, 6],
    [/failed\s+payment/i, 5], [/\bnsf\b/i, 5],
    [/past\s+due/i, 4], [/unpaid\s+(invoice|balance)/i, 5],
    [/(sent|went)\s+to\s+collections?/i, 5],
    [/(card|payment)\s+(declined|failed)/i, 4],
    [/never\s+(paid|responded)/i, 4], [/no\s+response\s+to\s+(billing|invoice)/i, 5],
    [/auto[-\s]?cancel(led|ed)?/i, 4], [/involuntarily\s+(cancel|terminat)/i, 6],
    [/we\s+(cancel(l?ed)?|terminated|closed)\s+(the|their)\s+(account|service)/i, 5],
  ]},
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
    [/competi(tor|tors|ng)/i, 4], [/switch(ing|ed)\s+to\s+(another|a\s+(different|new|other))\s+(answering|service)/i, 4],
    [/going with (another|different|other|a\s+new)\s+(answering\s+)?(service|company|provider)/i, 3],
    [/ruby\b/i, 4], [/patlive/i, 5], [/answer\s*connect/i, 5],
    [/gabbyville/i, 5], [/map\s*communications/i, 5], [/davinci\b/i, 4],
    [/moneypenny/i, 5], [/abby\s*connect/i, 5], [/voicenation/i, 5],
    [/answering\s*365/i, 5], [/\bnexa\b/i, 5],
    [/different answering service/i, 3], [/another answering service/i, 3],
    [/different (service|provider|company) (for|to handle)\s+(our|my|the)?\s*(calls?|answering)/i, 3],
    [/found (a\s+)?cheaper/i, 3],
  ]},
  { category: 'Price Too High', patterns: [
    [/too expensive/i, 4], [/can'?t afford/i, 4], [/overpriced/i, 4],
    [/over\s*budget/i, 3], [/cheaper (option|alternative|service|provider)/i, 4],
    [/price(s)? (too |are )?(high|much)/i, 4],
    [/cost(ing|s)? too much/i, 4], [/cut(ting)?\s+(back\s+)?cost/i, 3],
    [/reduc(e|ing)\s+(our\s+)?cost/i, 3], [/save money/i, 2], [/billing concern/i, 2],
    [/what (i'?m|we'?re) pay(ing)?/i, 3], [/for what (i|we) pay/i, 3],
    [/could (hire|get|find|pay) .{0,40}(\$\d|\d+\s*dollar|\bless\b)/i, 4],
    [/\$\d+\s*(\/|per|a)\s*(hour|hr|month|mo)/i, 3],
    [/not worth (the price|what (i|we) pay)/i, 4],
  ]},
  { category: 'Did Not Want to Pay Rate Increase / Overages', patterns: [
    [/rate\s+increase/i, 5], [/price\s+increase/i, 5],
    [/(don'?t|wont|won'?t|refus(e|ed|ing))\s+to\s+pay\s+(the\s+)?(rate|price)\s+increase/i, 6],
    [/overage(s|\s+fee)?/i, 5], [/over\s+(my|our|the)\s+minutes?/i, 4],
    [/(went|going)\s+over\s+(my|our|the)?\s*minutes?/i, 5],
    [/exceeded?\s+(my|our|the)?\s*(plan|minutes?|allotment)/i, 4],
    [/(charged|billed)\s+(for\s+)?overages?/i, 5],
    [/(reached|hit)\s+(my|our|the)?\s*(allotted|allowed)?\s*minutes?/i, 4],
    [/new\s+(pricing|rate)/i, 3],
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
    [/have (someone|staff) (now|to answer)/i, 3],
  ]},
  { category: 'Quality', patterns: [
    [/miss(ing|ed) calls?/i, 5], [/calls? (went|going) to voicemail/i, 5],
    [/calls? (not\s+)?(being\s+)?answered/i, 5], [/calls? (being\s+)?dropped/i, 4],
    [/no one (answered|picked up)/i, 4], [/unanswered calls?/i, 4],
    [/calls? roll(ing|ed)? (over|to) voicemail/i, 4],
    [/wrong (message|information|number|name|callback)/i, 5],
    [/incorrect (message|information|details?)/i, 5],
    [/bad (intake|message|information)/i, 4],
    [/message(s)? (wrong|incorrect|inaccurate|missing)/i, 4],
    [/intake (error|issue|problem)/i, 4],
    [/information (not\s+)?(captured|recorded|taken) (correctly|properly|right)/i, 4],
    [/unprofessional/i, 5], [/\brude\b/i, 5], [/disrespectful/i, 5],
    [/(bad|poor|terrible|awful) (receptionist|operator|agent|staff)/i, 5],
    [/(hard|difficult) to (understand|hear)/i, 4], [/accent (issue|problem|concern)/i, 4],
    [/quality (issue|problem|concern)/i, 4],
    [/(bad|poor|terrible) (service|quality|experience)/i, 4],
    [/not (satisfied|happy) with (the\s+)?service/i, 3],
    [/dissatisf(ied|action)/i, 4],
  ]},
  { category: 'Call Forwarding Issue', patterns: [
    [/patch(ing|ed)? (calls?|through)/i, 5], [/can'?t (patch|reach|transfer) calls?/i, 5],
    [/(busy|silent) (signal|line)/i, 4], [/ring(ing)? (busy|silent|no answer)/i, 4],
    [/calls? (not\s+)?going through/i, 4], [/calls? (not\s+)?connecting/i, 4],
    [/call (transfer|forwarding|routing) (issue|problem|fail)/i, 5],
    [/forward(ing)?\s+(issue|problem|not working|fail)/i, 5],
    [/calls? (not\s+)?(being\s+)?forward(ed)?/i, 4],
    [/(lines?|phones?) (ringing|are) busy/i, 4],
  ]},
  { category: 'Closed Practice', patterns: [
    [/clos(ing|ed|e) (the\s+)?(practice|firm|office|business)/i, 4],
    [/shut(ting)?\s+(down|the\s+practice)/i, 4],
    [/no longer practicing/i, 4], [/dissolv(ing|ed)\s+(the\s+)?(firm|practice)/i, 4],
    [/going out of business/i, 4], [/winding down/i, 3],
  ]},
  { category: 'Retired', patterns: [
    [/retir(ing|ed|ement|e)/i, 5],
    [/(i'?m|i\s+am|going\s+to)\s+retir/i, 6],
    [/end\s+of\s+(my\s+)?career/i, 4],
    [/stepping\s+down/i, 3],
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
    [/tax season (is\s+)?(over|ended|done|finished)/i, 5],
    [/(slow|quiet|off)\s*(season|period|time)/i, 4],
    [/seasonal(ly)?/i, 3], [/busy season (is\s+)?(over|ended|done|finished)/i, 5],
    [/slow(er)?\s+(this|right) now/i, 3],
    [/not (many|a lot of|much) (calls?|business|volume) (right now|anymore|lately)/i, 3],
  ]},
  { category: "Wanted Features/Services We Don't Offer", patterns: [
    [/feature (request|not available|missing)/i, 4],
    [/doesn'?t (have|offer|support)\s+.{0,30}(need|want|require)/i, 3],
    [/can'?t (integrate|connect|sync)/i, 3],
    [/need(s|ed)?\s+(a\s+)?(feature|integration|capability)/i, 3],
    [/wish (you|it)\s+(had|offer(ed)?|support(ed)?)/i, 3],
    [/(intake|scheduling|crm)\s+(integration|software)/i, 3],
  ]},
  { category: 'Wanted Real Time Reporting / Portal', patterns: [
    [/real[\s-]?time (report|reporting|data|stats?)/i, 5],
    [/portal (access|login|dashboard)/i, 4],
    [/(client|customer|online)\s+portal/i, 4],
    [/reporting (dashboard|tool|feature)/i, 4],
    [/want(ed|s)?\s+(to\s+)?see\s+(real[\s-]?time|live)\s+(data|stats?|calls?)/i, 4],
    [/live (dashboard|reporting|stats?|view)/i, 4],
  ]},
  { category: 'Answering Service Included In Suite', patterns: [
    [/included (in|with) (the\s+)?(suite|package|plan|software|system)/i, 5],
    [/comes? with\s+.{0,30}(answering|receptionist|service)/i, 4],
    [/(software|platform|suite|crm)\s+(includes?|has|comes?\s+with)\s+.{0,20}(answering|receptionist)/i, 5],
    [/bundled?\s+(with|in|into)/i, 3],
    [/already\s+(have|includes?)\s+(answering|receptionist)/i, 4],
  ]},
  { category: 'Moved to Shared Office Space', patterns: [
    [/shared\s+office/i, 5], [/co[-\s]?work(ing)?\s+space/i, 5],
    [/\bwework\b/i, 5], [/\bregus\b/i, 5],
    [/(moved|moving)\s+(to|into)\s+(a\s+)?(shared|co[-\s]?work)/i, 6],
    [/(new\s+)?office\s+(includes|has|comes?\s+with)\s+(receptionist|front\s*desk|answering)/i, 5],
    [/(building|office)\s+(has|provides)\s+(a\s+)?(receptionist|front\s*desk)/i, 5],
    [/executive\s+suite/i, 4],
  ]},
  { category: 'Appointed Judge', patterns: [
    [/appointed\s+(a\s+)?judge/i, 5], [/became\s+(a\s+)?judge/i, 5],
    [/judicial\s+(appointment|position)/i, 5],
    [/elected\s+(to\s+)?(the\s+)?bench/i, 4],
    [/taking\s+(a\s+)?judgeship/i, 5],
  ]},
  { category: "Doesn't See Value", patterns: [
    [/not worth (it|the cost|the price)/i, 4], [/don'?t (see|find)\s+(the\s+)?value/i, 4],
    [/no (longer\s+)?benefit/i, 3], [/doesn'?t (justify|make sense)/i, 3],
    [/\broi\b/i, 3], [/return on investment/i, 3],
    [/not getting (enough\s+)?(return|value|benefit)/i, 4], [/waste of money/i, 4],
  ]},
];

function buildAuditPrompt(customer, ticketData, cutoff) {
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

  const notesContext = customer.notes ? `\nCSV cancellation notes (AUTHORITATIVE — these are recorded by the ops team after closing the account, see rules below): "${customer.notes}"\n` : '';
  const windowNote = cutoff
    ? `\nIMPORTANT: Only tickets from ${cutoff.toISOString().slice(0, 10)} onwards have been provided. The estimated cancellation date MUST be on or after ${cutoff.toISOString().slice(0, 10)} — do NOT extract dates from before this cutoff even if they are mentioned in ticket text.\n`
    : '';
  const categoriesList = AUDITOR_CATEGORIES.map(c => `- ${c}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);

  // Build CSAT summary from ticket data if ratings are present
  const rated = ticketData.filter(t => t.satisfactionRating && t.satisfactionRating.score !== 'unoffered');
  const csatGood = rated.filter(t => t.satisfactionRating.score === 'good').length;
  const csatBad  = rated.filter(t => t.satisfactionRating.score === 'bad').length;
  const lastRated = rated.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const csatContext = rated.length > 0
    ? `\nCUSTOMER SATISFACTION HISTORY (${rated.length} rated tickets): ${csatGood} good / ${csatBad} bad (${Math.round(csatGood / rated.length * 100)}% satisfaction).${lastRated?.satisfactionRating?.comment ? ` Most recent comment: "${lastRated.satisfactionRating.comment}"` : ''}\n`
    : '';

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
- AI answering tools (use "Switched to AI Service"): Smith.ai, Lex, LEX Reception, Goodcall, Rosie, Numa, Answering.AI, Dialpad AI, Convoso
- Human answering services (use "Went to Competitor"): Ruby Receptionist, PATLive, AnswerConnect, MAP Communications, Gabbyville, VoiceNation, Moneypenny, Abby Connect, Alert Communications, Answering365, Nexa, Davinci
- "Lex" / "LEX" is an AI legal receptionist tool — NOT a law firm
- Hiring a virtual assistant (VA) for $X/hour = "Price Too High" (price comparison) OR "Hired Staff" if they actually plan to hire, NOT "Switched to AI Service"

INTEGRATIONS THAT ARE NOT COMPETITORS:
- Clio, MyCase, PracticePanther, Filevine, Litify, Lawmatics = legal practice management software that integrates WITH Answering Legal. Tickets about these are support/setup requests, NOT cancellations.
- "AI intake chatbot" / "intake chatbot" = Answering Legal's own free feature. NOT an outside service.
- Ring Savvy / Answering Legal themselves are NOT competitors.

Customer: ${customer.accountName || customer.orgName || 'Unknown'}${notesContext}${csatContext}${windowNote}

Full ticket conversation(s) — read the ENTIRE thread before deciding:
${transcripts || '(no ticket content available)'}

Choose the single best cancellation reason from these categories:
${categoriesList}

Critical rules:
- CANCELLATION EVIDENCE REQUIRED: Only classify a churn reason when there is explicit evidence that the customer canceled, requested cancellation, was closed, or terminated service. Support tickets, complaints, technical issues, account updates, plan reductions, and resolved issues are NOT churn reasons. If no cancellation evidence exists, return "No Cancellation Evidence Found".
- PLAN REDUCTIONS ARE NOT CHURN: A customer downgrading their plan, reducing minutes, or adjusting their subscription is NOT a cancellation. Do not classify these as any churn category.
- Only return a category from the approved list above. Never invent new categories.
- BE DECISIVE, NOT TIMID. When the customer states any reason at all — even vaguely — pick the closest matching category and mark confidence Low or Medium. Reserve "Unknown / Unspecified" for the cases where the customer/notes truly say nothing about why (just "please cancel my account" with no further context). "Going in a different direction" → Went to Competitor (competitorName=null). "No longer need service" → Doesn't See Value. "Trying something new" → Went to Competitor. The ONLY thing that's worse than Unknown is HALLUCINATING a category that nothing in the notes or tickets supports (e.g. saying "Went to AI" when there is zero AI mention). Don't hallucinate, but don't bail to Unknown just because the reason is vague.

PRIMARY SIGNAL — CSV CANCELLATION NOTES (READ THESE FIRST):
The CSV cancellation notes are written by Answering Legal's ops team AFTER they closed the account. They are the authoritative record of the actual reason. Almost every row has a stated reason in the notes — phrases like "non-payment", "AI", "overages", "hired staff", "retiring", "cost", "downsizing", "switched to different service", "new phone system", "lack of communication", etc.

When the CSV notes contain a clear reason phrase, use it as the primary signal for category selection. The ticket conversation is SUPPORTING context — read it for detail (competitor name, AI company name, quality specifics, dates) but the notes column states the ops team's recorded reason.

Map CSV note phrases to categories like this (case-insensitive):
- "non-payment", "non payment", "lack of communication", "no response", "did not reply", "could not reach", "NSF", "past due", "failed payment", "card declined", "on declines", "sent to collections", "account closed due to non payment", "we closed", "involuntarily terminated", "auto-cancel" → "Non-Payment"
- "AI", "switched to AI", "went to AI" → "Switched to AI Service" (extract specific company from ticket if present: Smith.ai, Lex, Goodcall, Rosie, etc.)
- "switched to different service", "another service", "using another service", "started with another service" → "Went to Competitor" (extract competitor name from ticket if present)
- "hired staff", "has staff", "staff in office", "hired a receptionist", "front desk", "in-house" → "Hired Staff"
- "answering his own calls", "answering their own calls", "wants to be more hands on", "doing it himself", "using his VM", "answering himself" → "Hired Staff" (the customer IS the staff)
- "overages", "doesn't want to pay overages", "going over minutes", "exceeded plan", "rate increase", "price increase" → "Did Not Want to Pay Rate Increase / Overages"
- "too expensive", "cost", "price", "cutting expenses", "cheaper", "can't afford" (when not tied to overages) → "Price Too High"
- "retiring", "retired", "retirement" → "Retired"
- "closed practice", "closed firm", "going out of business", "dissolving", "disbarment", "facing disbarment" → "Closed Practice" (use "Fired" only if explicitly fired/let go from a position)
- "downsizing", "restructuring", "business restructuring", "scaling back" → "Downsizing Practice"
- "low call volume", "not enough calls", "cost vs. call volume", "slow season", "tax season over" → "Not Enough Call Volume"
- "new phone system", "got a new phone", "changed phone service", "switched telephone service", "zoom phone service", "automated phone system", "IVR", "auto attendant", "phone tree", "set up call routing" → "IVR / Auto Attendant"
- "quality", "messages never sent", "lost lead", "ruining business", "agents didn't know", "unhappy with service", "service no longer the quality", "bad service" → "Quality"
- "moved to shared office", "wework", "regus", "shared office space", "coworking" → "Moved to Shared Office Space"
- "answering service included in suite", "bundled with software" → "Answering Service Included In Suite"
- "wanted real time reporting", "wanted portal", "wanted dashboard" → "Wanted Real Time Reporting / Portal"
- "appointed judge", "became a judge", "judicial appointment" → "Appointed Judge"
- "leaving firm", "left firm", "no longer at firm" → "Leaving Firm"
- "fired", "let go", "dismissed" (from a job — distinct from disbarment) → "Fired"
- "doesn't see value", "not worth it", "no ROI" → "Doesn't See Value"
- "no longer needed", "service no longer needed", "no longer using", "no longer wanted services" → "Doesn't See Value" (Low/Medium confidence). The customer decided they didn't need us — that's a value/utility judgment. Only escalate to a more specific category if the ticket shows one (e.g. Hired Staff, IVR, Went to Competitor).
- "no reason given", "no reason stated", "did not give a reason", "did not want to discuss" — first check the FULL ticket for any clue; if the ticket also has nothing, then "Unknown / Unspecified". Don't pick Unknown lazily — read the ticket carefully first.

INVOLUNTARY CANCELLATION OVERRIDE:
"Non-Payment" overrides every other category. Even if the customer's tickets sound happy or mention something else, if the CSV notes show the account was closed for non-payment, lack of communication, no response, or NSF — the reason is "Non-Payment".

USE BOTH NOTES AND TICKETS:
- Use CSV notes to PICK the category.
- Use ticket conversation to extract supporting detail: specific competitor names, AI company names, quality subcategory (Missed Calls / Message Errors / Receptionist Conduct), exact cancellation date, summary content.
- If notes are blank or vague ("no reason given", "see ticket #X"), then the ticket conversation IS your primary source — read it carefully for the customer's own words.

CATEGORY DEFINITIONS:
- "Switched to AI Service" = replaced us with an AI answering/receptionist tool (Smith.ai, Lex, Goodcall, Rosie, etc.). MUST set competitorName to the AI company's name (e.g. "Smith.ai", "Goodcall").
- "Went to Competitor" = switched to another HUMAN answering service (Ruby, PATLive, AnswerConnect, etc.). MUST set competitorName to the competitor's name.
- "Hired Staff" = the customer is now handling calls with in-house humans — either they hired a receptionist / front desk / employee, OR the attorney/owner is answering their own calls themselves. Distinct from IVR (which is an automated system) and from a shared-office receptionist.
- "IVR / Auto Attendant" = customer replaced us with an automated phone system, auto-attendant, phone tree, new phone routing setup, or a phone-service product like Zoom Phone / RingCentral / a virtual PBX. The defining feature is that an automated system or phone-service product now handles calls instead of a human service.
- "Price Too High" = the price of our service was too high for the customer in general (not a specific rate increase event).
- "Did Not Want to Pay Rate Increase / Overages" = customer specifically objects to a rate increase we issued, OR is leaving because of overage charges / going over their plan minutes. Distinct from general "Price Too High" — this is reactive to a specific bill event.
- "Call Forwarding Issue" = the customer's calls were not being forwarded/transferred/patched correctly — a technical problem with call routing or connectivity, NOT the customer choosing a different solution.
- "Wanted Features/Services We Don't Offer" = wanted a specific capability, integration, or service we don't provide.
- "Wanted Real Time Reporting / Portal" = specifically wanted live dashboards, a client portal, or real-time reporting access we don't provide.
- "Answering Service Included In Suite" = customer switched to a software/platform/CRM that bundles answering or receptionist service.
- "Moved to Shared Office Space" = customer moved into a coworking / shared office / executive suite (WeWork, Regus, etc.) and the building/office now provides receptionist coverage. Distinct from "Answering Service Included In Suite" (which is software bundling) — this is a physical office move.
- "Closed Practice" = the firm is permanently shutting down, dissolving, or going out of business. NOT the same as "Retired" — use Retired when the specific reason is the attorney retiring.
- "Retired" = the attorney/principal is personally retiring or ending their career. Use this over "Closed Practice" when retirement is the specific stated reason.
- "Leaving Firm" = the attorney is leaving the firm (joining a different firm, going in-house, etc.) but the firm itself continues.
- "Fired" = the attorney was let go / terminated / dismissed from their position.
- "Doesn't See Value" = service didn't justify the cost in their view — not enough ROI, not useful enough. Distinct from "Not Enough Call Volume" (which is about call traffic, not perceived value).
- "Not Enough Call Volume" = call traffic is too low to warrant the service — not a cost or value complaint, literally not enough calls. Seasonal slowdowns (tax season ended, slow summer) also belong here, not in "Closed Practice".
- "Appointed Judge" = the attorney was appointed/elected to the bench.

OTHER RULES:
- Agent asking to turn off call forwarding = post-cancellation cleanup. NOT a reason.
- "CF already turned off" / "they turned off CF" / "turned service off" / "removed DID" / "made inactive in CTI" = post-cancellation cleanup tasks. These are NOT "Call Forwarding Issue". Call Forwarding Issue means the customer's calls were not reaching us when they were supposed to (technical fault on our side or routing problem). It is rare. Default to other categories when CF is only mentioned in the context of disabling it after cancellation.
- "Went to Competitor" — name when you can: When the customer says they switched / left for someone else but doesn't name a competitor (e.g. "going in a different direction", "another route", "trying something new", "using another service", "started with another service"), still classify as "Went to Competitor" with competitorName=null and Low confidence. When a competitor IS named (Ruby, PATLive, AnswerConnect, MAP, Gabbyville, VoiceNation, Moneypenny, Abby Connect, Alert, Answering365, Nexa, Davinci, or similar), set competitorName and use Medium/High confidence.
- "Switched to AI Service" requires AI mention. Only use this category when the notes/ticket explicitly mention "AI", "AI receptionist", or a named AI tool (Smith.ai, Lex, Goodcall, Rosie, Numa, Answering.AI, Dialpad AI, Convoso, RingCentral AI, etc.). Do NOT pick this just because the customer left — if they just said "another service" with no AI language, use "Went to Competitor" instead.
- PHONE-SYSTEM ≠ CALL FORWARDING ISSUE: "got a new phone system", "switched telephone service", "changed phone service", "bought new phone system", "Zoom Phone", "RingCentral", "set up new phone routing" → "IVR / Auto Attendant" (customer replaced us with their own phone infrastructure). NOT "Call Forwarding Issue".
- "AI" + PHONE PRODUCT = AI WINS: If the notes or ticket mention AI (e.g. "RingCentral AI", "Zoom AI", "using AI with RingCentral", "AI receptionist on Vonage") → "Switched to AI Service", not "IVR / Auto Attendant". The AI capability is the differentiator; the phone product is just where it runs.
- "ANSWERING OWN CALLS" → HIRED STAFF: "answering his own calls", "answering their own calls", "using his VM", "wants to be more hands on", "doing it himself", "handling calls in office" → "Hired Staff". The customer becoming their own receptionist counts as Hired Staff. Do NOT route these to "Doesn't See Value".
- "NO RESPONSE" / "DID NOT REPLY" → NON-PAYMENT: When ops notes say the customer did not respond, could not be reached, did not reply to save attempts, was on declines, or was closed for lack of communication — classify as "Non-Payment" (involuntary). "No response" alone is enough; do not require explicit "non-payment" wording.
- Base your answer on the customer's actual words in [Message] blocks, not agent templates or [Internal note] blocks — EXCEPT CSV notes are always authoritative.
- PRICE RULE: If the customer is leaving for a competitor OR hiring staff/AI primarily because it is cheaper, the root reason is "Price Too High". Only use "Went to Competitor", "Hired Staff", or "Switched to AI Service" when price is NOT the stated driver. Non-Payment still overrides Price Too High.
- SUMMARY RULE: Write a summary specific to THIS customer's actual ticket content. Do NOT copy or paraphrase summaries from other customers. Each summary must reference something specific to this customer's own words or situation.
- QUALITY SUBCATEGORY: When category is "Quality", you must also set qualitySubcategory to the most specific type: "Missed Calls", "Message / Intake Errors", "Receptionist Conduct", or "General Quality". Use exactly one of these strings.

WORKED EXAMPLES (from real prior misclassifications — learn from these):
- Notes: "got new phone system no longer need our services" + ticket mentions turning off CF. → "IVR / Auto Attendant" (phone system replacement), NOT "Call Forwarding Issue".
- Notes: "switched telephone service and cancelled service (CF already turned off)". → "IVR / Auto Attendant". The "(CF already turned off)" is cleanup; the reason is the phone-service switch.
- Notes: "zoom phone service" or "Zoom Phone". → "IVR / Auto Attendant".
- Notes: "No response." (nothing else, ops tried to save). → "Non-Payment" (involuntary close from lack of communication).
- Notes: "Closed account due to non payment". → "Non-Payment", with High confidence.
- Notes: "Closed acct due to non communication". → "Non-Payment".
- Notes: "On declines per Rob close account" / "On Declines... No reply/No Payment". → "Non-Payment".
- Notes: "Voided overage invoice for non payment" + "asked to cancel instead of pay overages". → "Non-Payment" overrides (we closed for non-pay even though overages were the trigger).
- Notes: "answering his own calls" or "answering his own call or using his VM". → "Hired Staff" (customer IS the staff), NOT "Doesn't See Value".
- Notes: "Wants to be more hands on in the office". → "Hired Staff".
- Notes: "they are going in a different direction" or "another route" with no competitor named. → "Went to Competitor" with competitorName=null, Low confidence.
- Notes: "he is trying something new" / "exploring another option" with no further info. → "Went to Competitor" with competitorName=null, Low confidence.
- Notes: "Using another service" / "started with another service" without a name. → "Went to Competitor" with competitorName=null, Low confidence.
- Notes: "business restructuring" or "He restructured". → "Downsizing Practice".
- Notes: "facing disbarment". → "Closed Practice" (career-ending, like retirement but involuntary).
- Notes: "happy/just needed to pause for now" or "wants to cancel and come back at a later time". → "Not Enough Call Volume" if the ticket suggests low usage, otherwise "Unknown / Unspecified".
- Notes: "no reason but was happy". → "Unknown / Unspecified" (truly nothing to go on).
- Notes: "She wished not to discuss, just cancel" / "He did not want to share his reason". → "Unknown / Unspecified" — customer explicitly declined to give a reason.
- Notes: "service no longer needed" / "no longer wanted services" / "no longer needs service" with no other signal. → "Doesn't See Value" (Low confidence) — they decided the service wasn't needed enough to keep.
- Notes: "we were ruining her business" or "agents didn't know who they were answering for" or "messages never sent" or "lost lead". → "Quality" with appropriate subcategory.
- Notes blank but final reason column says "AI" or "Went to AI". → "Switched to AI Service". If ticket mentions specific AI tool, set competitorName.

Respond with ONLY valid JSON, no markdown:
{"category":"<category>","qualitySubcategory":"<Missed Calls|Message / Intake Errors|Receptionist Conduct|General Quality or null>","competitorName":"<company name or null>","confidence":"High|Medium|Low","summary":"<1-2 sentence plain English summary>","reasoning":"<brief note on signals>","relevantTicketIds":[<1-2 ticket IDs from above that most clearly show the reason, e.g. 12345>],"estimatedCancellationDate":"<YYYY-MM-DD or null>"}

estimatedCancellationDate rules: Look for the date the customer said they want to cancel or their service ended — phrases like "effective [date]", "as of [date]", "cancelling on [date]", "end of [month]", "final day [date]", "last day [date]". If only month/year given, use the last day of that month. If no explicit date, use the date of the most relevant cancellation ticket. Return null only if you cannot determine any date.`;
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

  // Normalize all "nothing found" competitor name variants to null
  const UNKNOWN_NAME_VALUES = new Set(['null','unknown','n/a','none','not identified','not specified','not available','unidentified','not mentioned','not stated','not provided','unclear','unspecified','']);
  const rawName = String(parsed.competitorName ?? '').trim();
  const competitorName = rawName && !UNKNOWN_NAME_VALUES.has(rawName.toLowerCase()) ? rawName : null;

  // Use AI-identified ticket IDs if they reference tickets we actually have; fall back to first 3
  const aiIds = Array.isArray(parsed.relevantTicketIds)
    ? parsed.relevantTicketIds.map(Number).filter(id => ticketData.some(t => t.id === id)).slice(0, 3)
    : [];
  const supporting_ticket_ids = aiIds.length > 0 ? aiIds : ticketData.slice(0, 3).map(t => t.id);

  const rawConfidence = ['High','Medium','Low'].includes(parsed.confidence) ? parsed.confidence : 'Low';
  // High confidence on "Unknown" is confusing — cap at Medium
  const confidence = (category === 'Unknown / Unspecified' && rawConfidence === 'High') ? 'Medium' : rawConfidence;

  // Validate date is YYYY-MM-DD format
  const rawDate = String(parsed.estimatedCancellationDate ?? '').trim();
  const estimatedCancellationDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

  const QUALITY_SUBCATS = new Set(['Missed Calls', 'Message / Intake Errors', 'Receptionist Conduct', 'General Quality']);
  const rawSubcat = String(parsed.qualitySubcategory ?? '').trim();
  const qualitySubcategory = (category === 'Quality' && QUALITY_SUBCATS.has(rawSubcat)) ? rawSubcat : (category === 'Quality' ? 'General Quality' : null);

  return {
    category,
    qualitySubcategory,
    competitorName,
    confidence,
    summary: parsed.summary || '',
    reasoning: parsed.reasoning || '',
    supporting_ticket_ids,
    estimatedCancellationDate,
    analysisMethod: 'ai',
  };
}

async function claudeAnalyzeTickets(customer, ticketData, cutoff) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildAuditPrompt(customer, ticketData, cutoff);
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseAuditResponse(msg.content[0]?.text?.trim() || '', ticketData);
}

async function geminiAnalyzeTickets(customer, ticketData, cutoff) {
  const prompt = buildAuditPrompt(customer, ticketData, cutoff);
  const resp = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } } },
    { headers: { 'X-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return parseAuditResponse(raw, ticketData);
}

async function openaiAnalyzeTickets(customer, ticketData, cutoff) {
  const prompt = buildAuditPrompt(customer, ticketData, cutoff);
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0.1, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '{}';
  return parseAuditResponse(raw, ticketData);
}

// Gemini-only with retry on transient errors. No keyword/provider fallback.
async function runAnalysis(customer, tickets, cutoff) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured on the server');
  }
  const delays = [1000, 3000, 8000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return { ...await geminiAnalyzeTickets(customer, tickets, cutoff), analysisMethod: 'ai' };
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const isTransient = status === 429 || (status >= 500 && status < 600) || !status;
      if (!isTransient || attempt === delays.length) break;
      console.warn(`[auditor] Gemini ${status || e.message}, retry ${attempt + 1}/${delays.length} in ${delays[attempt]}ms`);
      await auditorDelay(delays[attempt]);
    }
  }
  const status = lastErr?.response?.status;
  const msg = status === 429
    ? 'Gemini rate limit — retries exhausted. Try again in a minute.'
    : status
      ? `Gemini API error ${status}: ${lastErr?.response?.data?.error?.message || lastErr.message}`
      : `Gemini call failed: ${lastErr.message}`;
  throw new Error(msg);
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

  // If no cancellation signals are present in any ticket text, return early
  const allText = ticketTexts.map(t => t.text).join(' ');
  const hasCancellationSignal = CANCELLATION_SIGNALS.some(p => p.test(allText));
  if (!hasCancellationSignal) {
    return {
      category: 'No Cancellation Evidence Found',
      competitorName: null,
      summary: `No cancellation language found across ${ticketData.length} ticket(s). This may be a support, billing, or account management ticket.`,
      confidence: 'High',
      reasoning: 'No cancellation signals matched.',
      supporting_ticket_ids: ticketData.slice(0, 2).map(t => t.id),
      estimatedCancellationDate: null,
    };
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
  let best = scores[0];
  const second = scores[1];

  // Non-Payment override: if the account was closed for non-payment / lack of communication
  // (typically surfaced via CSV notes), that is the actual reason regardless of what the
  // customer's tickets say. Involuntary cancellation trumps voluntary stated reasons.
  const nonPayScore = scores.find(s => s.category === 'Non-Payment')?.score || 0;
  if (nonPayScore >= 5) {
    best = scores.find(s => s.category === 'Non-Payment');
  } else {
    // Price override: if price signals are strong and the top category is Competitor/AI/HiredStaff,
    // price is the root cause — the competitor/AI was just the vehicle.
    const priceScore = scores.find(s => s.category === 'Price Too High')?.score || 0;
    const PRICE_OVERRIDE_CATEGORIES = new Set(['Went to Competitor', 'Switched to AI Service', 'Hired Staff']);
    if (PRICE_OVERRIDE_CATEGORIES.has(best.category) && priceScore >= 4 && priceScore >= best.score * 0.6) {
      best = scores.find(s => s.category === 'Price Too High');
    }
  }

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

  // Use the most recent matched ticket date as a proxy for cancellation date
  const matchedTickets = best.matchedIds.length
    ? ticketData.filter(t => best.matchedIds.includes(t.id))
    : ticketData.slice(0, 2);
  const latestTicket = matchedTickets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const estimatedCancellationDate = (category === 'No Cancellation Evidence Found') ? null : (latestTicket?.created_at?.slice(0, 10) || null);

  return {
    category,
    competitorName,
    summary,
    confidence,
    reasoning,
    supporting_ticket_ids: best.matchedIds.length ? best.matchedIds : ticketData.slice(0, 2).map(t => t.id),
    estimatedCancellationDate,
  };
}

async function runAuditJob(jobId, rows) {
  const job = auditorJobs.get(jobId);
  if (!job) return;

  const CONCURRENCY = 3;
  const lookbackMs = job.lookbackDays ? job.lookbackDays * 24 * 60 * 60 * 1000 : null;
  const cutoff = lookbackMs ? new Date(Date.now() - lookbackMs) : null;

  async function processRow(rawRow) {
    const row = normalizeAuditorRow(rawRow);
    const explicitTicketIds = parseTicketIdsFromRow(rawRow);
    const baseResult = {
      accountName: row.accountName || '',
      emailDomain: row.emailDomain || '',
      customerEmail: row.customerEmail || '',
      matchedOrg: null, matchConfidence: null, matchType: null,
      category: null, competitorName: null, summary: null,
      confidence: null, reasoning: null,
      estimatedCancellationDate: null, exitDateSource: null,
      supportingTicketIds: [], ticketSubjects: [], ticketDates: [],
      status: 'done', error: null,
      zdSubdomain: process.env.ZENDESK_SUBDOMAIN || '',
      _originalRow: rawRow,
    };

    try {
      const ticketMap = new Map();
      for (const tid of explicitTicketIds) {
        const t = await fetchTicketById(tid);
        if (t) ticketMap.set(t.id, t);
      }

      if (ticketMap.size > 0) {
        baseResult.matchedOrg = row.accountName || row.orgName || 'Unknown';
        baseResult.matchConfidence = 'High';
        baseResult.matchType = 'noteTicketId';
      } else {
        const match = await matchCustomer(row);
        console.log(`[auditor] "${row.accountName || row.orgName || '?'}" → ${match ? `org:${match.zdOrgName}` : 'no_match'}`);

        if (!match) {
          job.results.push({ ...baseResult, status: 'no_match' });
          job.done++;
          return;
        }

        baseResult.matchedOrg = match.zdOrgName;
        baseResult.matchConfidence = match.matchConfidence;
        baseResult.matchType = match.matchType;

        // Phase 1 + Phase 2 in parallel
        const [phase1, phase2] = await Promise.all([
          getRecentSolvedTickets(match, 5),
          getCancellationKeywordTickets(match),
        ]);
        for (const t of [...phase1, ...phase2]) {
          if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
        }

        // Phase 3 — sweep if still thin
        if (ticketMap.size < 3) {
          for (const t of await getRecentSolvedTickets(match, 10)) {
            if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
          }
        }
      }

      let tickets = Array.from(ticketMap.values());
      if (tickets.length === 0) {
        job.results.push({ ...baseResult, category: 'Unknown / Unspecified', summary: 'No tickets found in Zendesk for this customer.', confidence: 'Low', reasoning: 'No ticket data available.', status: 'done' });
        job.done++;
        return;
      }

      // Apply lookback filter — but only when no explicit ticket IDs were given.
      // If the user pointed at specific tickets in the CSV, they want those used
      // regardless of how old they are.
      if (cutoff && explicitTicketIds.length === 0) {
        tickets = tickets.filter(t => t.created_at && new Date(t.created_at) >= cutoff);
        if (tickets.length === 0) {
          job.results.push({ ...baseResult, category: 'Unknown / Unspecified', summary: `No tickets found within the selected time window. Customer may have cancelled outside this period.`, confidence: 'Low', reasoning: 'All tickets predated the lookback window.', status: 'done' });
          job.done++;
          return;
        }
      }

      baseResult.ticketSubjects = tickets.map(t => t.subject || '');
      baseResult.ticketDates = tickets.map(t => t.created_at?.slice(0, 10) || '');

      // CSAT pulse — same logic as single lookup
      const ratedTickets = tickets.filter(t => t.satisfactionRating && t.satisfactionRating.score !== 'unoffered');
      const csatGood = ratedTickets.filter(t => t.satisfactionRating.score === 'good').length;
      const csatBad  = ratedTickets.filter(t => t.satisfactionRating.score === 'bad').length;
      const lastRatedTicket = ratedTickets.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      baseResult.csat = {
        total: ratedTickets.length,
        good: csatGood,
        bad: csatBad,
        pct: ratedTickets.length > 0 ? Math.round((csatGood / ratedTickets.length) * 100) : null,
        lastScore: lastRatedTicket?.satisfactionRating?.score || null,
        lastComment: lastRatedTicket?.satisfactionRating?.comment || null,
        lastDate: lastRatedTicket?.created_at?.slice(0, 10) || null,
      };

      const analysis = await runAnalysis(row, tickets, cutoff);
      baseResult.category = analysis.category;
      baseResult.qualitySubcategory = analysis.qualitySubcategory || null;
      baseResult.competitorName = analysis.competitorName || null;
      baseResult.summary = analysis.summary;
      baseResult.confidence = analysis.confidence;
      baseResult.reasoning = analysis.reasoning;
      baseResult.supportingTicketIds = analysis.supporting_ticket_ids || [];
      baseResult.analysisMethod = analysis.analysisMethod || 'ai';

      // Exit date: use AI-extracted date if available, otherwise fall back to most recent ticket
      const sortedTickets = tickets.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const latestTicket = sortedTickets[0];
      if (analysis.estimatedCancellationDate) {
        // Clamp: if filter active and AI date is before cutoff, use last ticket instead
        const aiDate = new Date(analysis.estimatedCancellationDate + 'T00:00:00');
        if (cutoff && aiDate < cutoff) {
          baseResult.estimatedCancellationDate = latestTicket?.created_at?.slice(0, 10) || null;
          baseResult.exitDateSource = baseResult.estimatedCancellationDate ? 'last_ticket' : null;
        } else {
          baseResult.estimatedCancellationDate = analysis.estimatedCancellationDate;
          baseResult.exitDateSource = 'explicit';
        }
      } else {
        baseResult.estimatedCancellationDate = latestTicket?.created_at?.slice(0, 10) || null;
        baseResult.exitDateSource = baseResult.estimatedCancellationDate ? 'last_ticket' : null;
      }

      job.results.push({ ...baseResult, status: 'done' });
    } catch (err) {
      job.results.push({ ...baseResult, status: 'error', error: err.message });
    }

    job.done++;
  }

  // Process rows in concurrent batches
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(processRow));
  }

  job.status = 'done';
  setTimeout(() => auditorJobs.delete(jobId), 2 * 60 * 60 * 1000);
}

app.get('/api/zendesk-auditor/categories', requireRole('super_admin', 'zendesk_auditor'), (req, res) => {
  res.json({ categories: AUDITOR_CATEGORIES });
});

// Single-customer lookup — same logic as batch, returns directly with CSAT pulse
app.post('/api/zendesk-auditor/lookup', requireRole('super_admin', 'zendesk_auditor'), async (req, res) => {
  // Normalize a domain input like "@ezdivorce.com", "https://www.ezdivorce.com/",
  // "www.EZDivorce.com", or a full email "hi@ezdivorce.com" down to "ezdivorce.com".
  function sanitizeDomain(raw) {
    let d = String(raw || '').trim().toLowerCase();
    if (!d) return '';
    d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^@+/, '');
    if (d.includes('@')) d = d.split('@').pop();     // email → domain
    d = d.split('/')[0].split('?')[0].split(':')[0]; // strip path/query/port
    return d.trim();
  }
  const row = {
    accountName: String(req.body.accountName || '').trim(),
    customerEmail: String(req.body.customerEmail || '').trim(),
    emailDomain: sanitizeDomain(req.body.emailDomain),
    orgName: String(req.body.orgName || '').trim(),
    notes: String(req.body.notes || '').trim(),
  };

  if (!row.accountName && !row.customerEmail && !row.orgName) {
    return res.status(400).json({ error: 'Provide at least an account name or email to search' });
  }

  const baseResult = {
    accountName: row.accountName || row.orgName || '',
    emailDomain: row.emailDomain || (row.customerEmail ? (row.customerEmail.split('@')[1] || '') : ''),
    customerEmail: row.customerEmail || '',
    matchedOrg: null, matchConfidence: null, matchType: null,
    category: null, competitorName: null, summary: null,
    confidence: null, reasoning: null,
    supportingTicketIds: [], ticketSubjects: [], ticketDates: [],
    csat: null, status: 'done', error: null,
    zdSubdomain: process.env.ZENDESK_SUBDOMAIN || '',
  };

  try {
    const explicitTicketIds = parseTicketIdsFromRow(req.body);
    const ticketMap = new Map();
    console.log(`[auditor:lookup] "${row.accountName || row.customerEmail}" — explicitIds: [${explicitTicketIds.join(', ')}]`);

    for (const tid of explicitTicketIds) {
      const t = await fetchTicketById(tid);
      if (t) ticketMap.set(t.id, t);
    }

    if (ticketMap.size > 0) {
      baseResult.matchedOrg = row.accountName || row.orgName || 'Unknown';
      baseResult.matchConfidence = 'High';
      baseResult.matchType = 'noteTicketId';
    } else {
      const match = await matchCustomer(row);
      console.log(`[auditor:lookup] match → ${match ? `org:${match.zdOrgName} userIds:[${match.zdUserIds?.join(',')}]` : 'null'}`);
      if (!match) return res.json({ ...baseResult, status: 'no_match' });

      baseResult.matchedOrg = match.zdOrgName;
      baseResult.matchConfidence = match.matchConfidence;
      baseResult.matchType = match.matchType;

      // Fetch more tickets than batch mode to get better CSAT coverage
      for (const t of await getRecentSolvedTickets(match, 15)) {
        if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
      }
      for (const t of await getCancellationKeywordTickets(match)) {
        if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
      }
      if (ticketMap.size < 3) {
        for (const t of await getRecentSolvedTickets(match, 25)) {
          if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
        }
      }
    }

    let tickets = Array.from(ticketMap.values());
    if (tickets.length === 0) {
      return res.json({ ...baseResult, category: 'Unknown / Unspecified', summary: 'No tickets found in Zendesk for this customer.', confidence: 'Low', reasoning: 'No ticket data available.', status: 'done' });
    }

    // Apply lookback filter — but only when no explicit ticket IDs were given.
    // Explicit IDs in the request mean the caller already chose the tickets.
    const lookbackDays = parseInt(req.body.lookbackDays, 10) || null;
    const lookbackCutoff = lookbackDays ? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000) : null;
    if (lookbackCutoff && explicitTicketIds.length === 0) {
      tickets = tickets.filter(t => t.created_at && new Date(t.created_at) >= lookbackCutoff);
      if (tickets.length === 0) {
        return res.json({ ...baseResult, category: 'Unknown / Unspecified', summary: `No tickets found within the selected time window. This customer may have cancelled outside this period.`, confidence: 'Low', reasoning: 'All tickets predated the lookback window.', status: 'done' });
      }
    }

    baseResult.ticketSubjects = tickets.map(t => t.subject || '');
    baseResult.ticketDates = tickets.map(t => t.created_at?.slice(0, 10) || '');
    baseResult.ticketCount = tickets.length;

    // ── CSAT pulse ──────────────────────────────────────────────────────────────
    const rated = tickets.filter(t => t.satisfactionRating && t.satisfactionRating.score !== 'unoffered');
    const csatGood = rated.filter(t => t.satisfactionRating.score === 'good').length;
    const csatBad  = rated.filter(t => t.satisfactionRating.score === 'bad').length;
    // sorted desc by date, so rated[0] is the most recent rated ticket
    const last = rated.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    baseResult.csat = {
      total: rated.length,
      good: csatGood,
      bad: csatBad,
      pct: rated.length > 0 ? Math.round((csatGood / rated.length) * 100) : null,
      lastScore: last?.satisfactionRating?.score || null,
      lastComment: last?.satisfactionRating?.comment || null,
      lastDate: last?.created_at?.slice(0, 10) || null,
    };

    const analysis = await runAnalysis(row, tickets, lookbackCutoff);
    const sortedLookup = tickets.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const latestLookup = sortedLookup[0];
    let exitDate = analysis.estimatedCancellationDate || null;
    let exitDateSource = exitDate ? 'explicit' : null;
    if (exitDate) {
      // Clamp: if filter active and AI date is before cutoff, use last ticket instead
      if (lookbackCutoff && new Date(exitDate + 'T00:00:00') < lookbackCutoff) {
        exitDate = latestLookup?.created_at?.slice(0, 10) || null;
        exitDateSource = exitDate ? 'last_ticket' : null;
      }
    } else {
      exitDate = latestLookup?.created_at?.slice(0, 10) || null;
      exitDateSource = exitDate ? 'last_ticket' : null;
    }
    return res.json({
      ...baseResult,
      category: analysis.category,
      competitorName: analysis.competitorName || null,
      summary: analysis.summary,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      estimatedCancellationDate: exitDate,
      exitDateSource,
      supportingTicketIds: analysis.supporting_ticket_ids || [],
      analysisMethod: analysis.analysisMethod || 'ai',
      status: 'done',
    });
  } catch (err) {
    console.error(`[auditor:lookup] error: ${err.message}`);
    return res.status(500).json({ ...baseResult, status: 'error', error: err.message });
  }
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

  const lookbackDays = parseInt(req.body.lookbackDays, 10) || null;
  const jobId = Date.now().toString(36);
  auditorJobs.set(jobId, { status: 'running', results: [], total: rows.length, done: 0, error: null, lookbackDays: lookbackDays || null });

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

// ─── Mitel 3300 Leaderboard ──────────────────────────────────────────────────
// Import + browse "Agent Group Performance by Agent" reports exported from MiCC.
const mitelLeaderboardUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// List all imported snapshots (lightweight — no agent rows)
app.get('/api/mitel-leaderboard', requireAuth, (req, res) => {
  res.json({ snapshots: mitelLeaderboard.listSnapshots() });
});

// Aggregate snapshots whose period falls in [from, to] into one per-agent view.
// Dates are ISO yyyy-mm-dd (omit for "all time").
app.get('/api/mitel-leaderboard/aggregate', requireAuth, (req, res) => {
  const { from, to } = req.query;
  res.json(mitelLeaderboard.aggregate({ from, to }));
});

// Per-agent history — every row for one extension across all snapshots.
app.get('/api/mitel-leaderboard/agent/:reportingId', requireAuth, (req, res) => {
  res.json(mitelLeaderboard.agentHistory(req.params.reportingId));
});

// Excluded extensions (admins, supervisors, system accounts) — hidden from rankings.
app.get('/api/mitel-leaderboard/exclusions', requireAuth, (req, res) => {
  res.json({ exclusions: mitelLeaderboard.loadExclusions() });
});

app.post('/api/mitel-leaderboard/exclusions', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const { extension, name, reason } = req.body || {};
  if (!extension) return res.status(400).json({ error: 'extension is required' });
  try {
    const addedBy = req.user?.name || req.user?.email || 'unknown';
    const entry = mitelLeaderboard.addExclusion(extension, { name, reason, addedBy });
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/mitel-leaderboard/exclusions/:extension', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const ok = mitelLeaderboard.removeExclusion(req.params.extension);
  if (!ok) return res.status(404).json({ error: 'Exclusion not found' });
  res.json({ ok: true });
});

// Fetch a single snapshot with full agent rows
app.get('/api/mitel-leaderboard/:id', requireAuth, (req, res) => {
  const snap = mitelLeaderboard.getSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  res.json(snap);
});

// Import a new report — accepts either raw text in the JSON body or a multipart file upload.
// requireRole gates writes: only ops/admin can import or delete.
app.post(
  '/api/mitel-leaderboard/import',
  requireRole('super_admin', 'call_center_ops'),
  mitelLeaderboardUpload.single('file'),
  (req, res) => {
    let raw = '';
    if (req.file)             raw = req.file.buffer.toString('utf8');
    else if (req.body?.text)  raw = String(req.body.text);
    console.log(`[mitel-leaderboard] import: file=${!!req.file} text-len=${req.body?.text?.length || 0} raw-len=${raw.length}`);
    if (!raw.trim()) return res.status(400).json({ error: 'No report content provided' });

    try {
      const parsed = mitelLeaderboard.parseReport(raw);
      const importedBy = req.user?.name || req.user?.email || 'unknown';
      const saved = mitelLeaderboard.saveSnapshot(parsed, importedBy);
      res.json({ ok: true, snapshot: { id: saved.id, periodLine: saved.periodLine, agentCount: saved.agents.length } });
    } catch (err) {
      console.error('Mitel leaderboard import error:', err.message);
      res.status(400).json({ error: 'Failed to parse report', details: err.message });
    }
  }
);

app.delete('/api/mitel-leaderboard/:id', requireRole('super_admin', 'call_center_ops'), (req, res) => {
  const ok = mitelLeaderboard.deleteSnapshot(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Snapshot not found' });
  res.json({ ok: true });
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
