const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const isDev = process.env.NODE_ENV !== 'production';

if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) return done(null, false);

    const users = loadUsers();
    const record = users[email];
    if (!record) return done(null, false, { message: 'unauthorized' });

    const picture = profile.photos?.[0]?.value || '';
    let changed = false;
    if (picture && users[email].picture !== picture) {
      users[email].picture = picture;
      changed = true;
    }
    // Preserve refresh_token — Google only returns it on first consent, so
    // don't overwrite a stored value with an empty one on later logins.
    if (refreshToken) {
      users[email].google_refresh_token = refreshToken;
      changed = true;
    }
    if (changed) saveUsers(users);

    done(null, { email, name: record.name || profile.displayName, role: record.role, additionalRoles: record.additionalRoles || [], picture });
  }));
}

passport.serializeUser((user, done) => done(null, user.email));

passport.deserializeUser((email, done) => {
  const users = loadUsers();
  const record = users[email];
  if (!record) return done(null, false);
  done(null, { email, name: record.name, role: record.role, additionalRoles: record.additionalRoles || [], picture: record.picture || '' });
});

const DEV_USER = { email: 'dev@local', name: 'Dev User', role: 'super_admin', additionalRoles: [] };
const API_KEY_USER = { email: 'api-key@ccops', name: 'API Key', role: 'api', additionalRoles: [] };

// Read-only API key — accepted on GET requests via X-API-Key header.
// Lets the dev team pull data without a Google session. Does NOT satisfy requireRole.
function checkApiKey(req) {
  const expected = process.env.DEV_API_KEY;
  if (!expected || req.method !== 'GET') return false;
  const provided = req.headers['x-api-key'];
  return provided && provided === expected;
}

function requireAuth(req, res, next) {
  if (isDev && !process.env.GOOGLE_CLIENT_ID) {
    req.user = req.user || DEV_USER;
    return next();
  }
  if (checkApiKey(req)) {
    req.user = req.user || API_KEY_USER;
    return next();
  }
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Boolean form of requireAuth — for inline checks (e.g. routes that already
// branch on a TV session token).
function isAuthedOrKey(req) {
  if (isDev && !process.env.GOOGLE_CLIENT_ID) {
    req.user = req.user || DEV_USER;
    return true;
  }
  if (checkApiKey(req)) {
    req.user = req.user || API_KEY_USER;
    return true;
  }
  return req.isAuthenticated();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (isDev && !process.env.GOOGLE_CLIENT_ID) {
      req.user = req.user || DEV_USER;
      return next();
    }
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const userRoles = [req.user?.role, ...(req.user?.additionalRoles || [])];
    if (!roles.some(r => userRoles.includes(r))) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function listUsers() {
  return loadUsers();
}

function addUser(email, name, role, additionalRoles = []) {
  const users = loadUsers();
  users[email.toLowerCase()] = { role, name, additionalRoles, addedAt: new Date().toISOString() };
  saveUsers(users);
}

function removeUser(email) {
  const users = loadUsers();
  delete users[email.toLowerCase()];
  saveUsers(users);
}

module.exports = { passport, requireAuth, requireRole, isAuthedOrKey, listUsers, addUser, removeUser };
