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

const app = express();
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
app.use('/order', express.static(path.join(__dirname, 'public', 'order')));
app.use('/public-api', publicRoutesFactory(io));
app.get('/health', (req, res) => res.json({ ok: true }));

// Everything below needs the admin login when ADMIN_PASSWORD is set
app.use(adminAuth.requireAdmin);
if (!adminAuth.enabled) {
  console.warn('⚠️  ADMIN_PASSWORD is not set: admin panel and API are open to anyone. Set it before going live.');
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
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

// Root fallback to frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
