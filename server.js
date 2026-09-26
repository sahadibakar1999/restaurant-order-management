require('dotenv').config();
const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require('socket.io');

const storage = require('./services/storage');
const botEngine = require('./services/botEngine');
const whatsappApi = require('./services/whatsappApi');
const webhookRoutes = require('./routes/webhook');
const apiRoutesFactory = require('./routes/api');
const publicRoutesFactory = require('./routes/public');
const dailySummary = require('./services/dailySummary');

const fs = require('fs');
const app = express();

// Pages are never cached; their CSS/JS links carry a per-deploy version so
// browsers pick up new files immediately after a deploy.
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || String(Date.now())).slice(0, 12);
const htmlCache = new Map();
function sendVersionedHtml(res, file) {
  if (!htmlCache.has(file)) {
    const html = fs.readFileSync(file, 'utf-8')
      .replace(/((?:src|href)="(?:\/?(?:js|css)\/[^"?]+|order\.(?:js|css)))"/g, `$1?v=${BUILD_ID}"`);
    htmlCache.set(file, html);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(htmlCache.get(file));
}
app.set('trust proxy', 1); // correct client IPs and https links behind Render/other proxies
const server = http.createServer(app);
const adminAuth = require('./middleware/adminAuth');

// Same-origin only (no wildcard CORS); Socket.IO requires admin login when enabled.
const io = new Server(server, {
  allowRequest: (req, callback) => callback(null, adminAuth.isAuthorized(req.headers.authorization))
});

// Every real-time event is also recorded so browsers can poll /api/events
// when WebSockets aren't available (serverless hosting)
const eventLog = require('./services/eventLog');
const socketEmit = io.emit.bind(io);
io.emit = (event, data) => {
  eventLog.record(event, data);
  return socketEmit(event, data);
};

const PORT = process.env.PORT || 3000;

// Wire Socket.IO into services
botEngine.setSocketIO(io);
whatsappApi.setSocketIO(io);

// Middlewares
// Keep the raw body so the WhatsApp webhook signature can be verified
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Serverless: load shared state (Upstash Redis) per request, save before responding
const sharedStore = require('./services/sharedStore');
app.use((req, res, next) => {
  // Static files never touch data; skip the Redis round trip for them
  if (req.method === 'GET' && /\.(js|css|png|svg|ico|map|html)$/.test(req.path)) return next();
  return sharedStore.middleware(req, res, next);
});

// Public: Meta WhatsApp webhook (protected by verify token + signature check)
app.use('/webhook', webhookRoutes);
app.use('/api/whatsapp/webhook', webhookRoutes); // Alias for clean URL

// Public: guest QR ordering page + its API (rate-limited, no admin data)
app.get(['/order', '/order/', '/order/index.html'], (req, res, next) => {
  if (req.path === '/order') return res.redirect(301, `/order/${req.url.slice(6)}`);
  sendVersionedHtml(res, path.join(__dirname, 'public', 'order', 'index.html'));
});
app.use('/order', express.static(path.join(__dirname, 'public', 'order'), { maxAge: '7d', index: false }));
app.use('/public-api', publicRoutesFactory(io));
app.get('/health', (req, res) => res.json({ ok: true }));

// Vercel Cron: nightly owner summary (Vercel sends "Authorization: Bearer <CRON_SECRET>")
app.get('/cron/daily-summary', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ success: false });
  const settings = require('./services/storage').getSettings();
  if (settings.dailySummaryEnabled === false) return res.json({ success: true, skipped: 'disabled' });
  try {
    const { to } = await dailySummary.sendSummary();
    return res.json({ success: true, sentTo: to });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Everything below needs the admin login when ADMIN_PASSWORD is set
app.use(adminAuth.requireAdmin);
if (!adminAuth.enabled) {
  console.warn('⚠️  ADMIN_PASSWORD is not set: admin panel and API are open to anyone. Set it before going live.');
}

// Admin page (versioned asset links) + static assets (private cache, versioned URLs)
app.get(['/', '/index.html'], (req, res) => sendVersionedHtml(res, path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=604800')
}));
// Socket.IO client script (normally served by the socket server; needed on serverless)
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

// Routes
app.use('/api', apiRoutesFactory(io));

// Socket.IO event handler
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    // client disconnected
  });
});

// Unknown API routes: JSON 404 (not the admin page)
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found' }));

// Root fallback to frontend
app.get('*', (req, res) => sendVersionedHtml(res, path.join(__dirname, 'public', 'index.html')));

// Errors (bad JSON, unexpected crashes): JSON, never a stack trace
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid request format.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request too large.' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
});

// On Vercel the app is exported as a function; elsewhere run a normal server
module.exports = app;
if (process.env.VERCEL) return;

dailySummary.startScheduler();

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 Restaurant Order Management Server is running!`);
  console.log(`📍 Kitchen & Admin Panel: http://localhost:${PORT}`);
  console.log(`📱 WhatsApp Bot Simulator: http://localhost:${PORT}/#simulator`);
  console.log(`🏷️ Table QR Code Studio: http://localhost:${PORT}/#tables`);
  console.log(`🍽️ Guest QR ordering page: http://localhost:${PORT}/order/?table=1`);
  console.log(`🔗 WhatsApp Cloud Webhook URL: http://localhost:${PORT}/webhook`);
  console.log('====================================================');
});
