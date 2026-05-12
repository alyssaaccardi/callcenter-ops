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
    if (picture && users[email].picture !== picture) {
      users[email].picture = picture;
      saveUsers(users);
    }

    done(null, { email, name: record.name || profile.displayName, role: record.role, picture });
  }));
}

passport.serializeUser((user, done) => done(null, user.email));

passport.deserializeUser((email, done) => {
  const users = loadUsers();
  const record = users[email];
  if (!record) return done(null, false);
  done(null, { email, name: record.name, role: record.role, picture: record.picture || '' });
});

const DEV_USER = { email: 'dev@local', name: 'Dev User', role: 'super_admin' };

function requireAuth(req, res, next) {
  if (isDev && !process.env.GOOGLE_CLIENT_ID) {
    req.user = req.user || DEV_USER;
    return next();
  }
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (isDev && !process.env.GOOGLE_CLIENT_ID) {
      req.user = req.user || DEV_USER;
      return next();
    }
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function listUsers() {
  return loadUsers();
}

function addUser(email, name, role) {
  const users = loadUsers();
  users[email.toLowerCase()] = { role, name, addedAt: new Date().toISOString() };
  saveUsers(users);
}

function removeUser(email) {
  const users = loadUsers();
  delete users[email.toLowerCase()];
  saveUsers(users);
}

module.exports = { passport, requireAuth, requireRole, listUsers, addUser, removeUser };
