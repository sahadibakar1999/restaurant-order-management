const crypto = require('crypto');

// HTTP Basic Auth for the admin panel, API and Socket.IO.
// Enabled when ADMIN_PASSWORD is set. Username defaults to "admin".
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isAuthorized(header) {
  if (!PASS) return true;
  if (!header || !header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return safeEqual(user, USER) && safeEqual(rest.join(':'), PASS);
}

function requireAdmin(req, res, next) {
  if (isAuthorized(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Restaurant Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

module.exports = { requireAdmin, isAuthorized, enabled: Boolean(PASS) };
