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

https.globalAgent.setMaxListeners(20);

const app = express();
const PORT = process.env.PORT || 3001;

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
  if (!['super_admin', 'call_center_ops'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  addUser(email, name, role);
  res.json({ success: true });
});

app.delete('/api/users/:email', requireRole('super_admin'), (req, res) => {
  removeUser(req.params.email);
  res.json({ success: true });
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

// ─── React SPA Catch-All ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Call Center Ops Backend running on port ${PORT}`);
  console.log(`   App: http://localhost:${PORT}/`);
});
