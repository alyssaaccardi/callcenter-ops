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
    if (!record) {
      // Guest access: any @answeringlegal.com email gets a limited session
      // scoped to routes that explicitly opt into it (e.g. /ring-leader).
      // requireAuth / isAuthedOrKey / requireRole all reject role === 'guest'.
      if (email.endsWith('@answeringlegal.com')) {
        return done(null, {
          email,
          name: profile.displayName || email,
          role: 'guest',
          additionalRoles: [],
          picture: profile.photos?.[0]?.value || '',
          isGuest: true,
        });
      }
      return done(null, false, { message: 'unauthorized' });
    }

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

passport.serializeUser((user, done) => {
  if (user.isGuest) {
    // Guests aren't in users.json, so we can't rehydrate from disk. Stash
    // enough on the session to reconstruct the user object as-is.
    return done(null, `guest:${JSON.stringify({ e: user.email, n: user.name, p: user.picture || '' })}`);
  }
  done(null, user.email);
});

passport.deserializeUser((data, done) => {
  if (typeof data === 'string' && data.startsWith('guest:')) {
    try {
      const g = JSON.parse(data.slice(6));
      return done(null, { email: g.e, name: g.n, role: 'guest', additionalRoles: [], picture: g.p || '', isGuest: true });
    } catch { return done(null, false); }
  }
  const email = data;
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
  // Guests are authenticated but should not pass generic app auth — they only
  // get in via requireAnsweringLegalDomain on explicitly opted-in routes.
  if (req.isAuthenticated() && !req.user?.isGuest) return next();
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
  return req.isAuthenticated() && !req.user?.isGuest;
}

// Domain-only gate for pages we open up to any Answering Legal employee.
// Redirects unauthenticated users through Google OAuth (returning to the same
// URL) and 403s any authenticated user whose email isn't @answeringlegal.com.
function requireAnsweringLegalDomain(req, res, next) {
  if (isDev && !process.env.GOOGLE_CLIENT_ID) {
    req.user = req.user || DEV_USER;
    return next();
  }
  if (!req.isAuthenticated()) {
    const rt = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(`/auth/google?returnTo=${rt}`);
  }
  const email = (req.user?.email || '').toLowerCase();
  if (!email.endsWith('@answeringlegal.com')) {
    return res.status(403).send('Access restricted to Answering Legal employees.');
  }
  next();
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

module.exports = { passport, requireAuth, requireRole, isAuthedOrKey, requireAnsweringLegalDomain, listUsers, addUser, removeUser };
