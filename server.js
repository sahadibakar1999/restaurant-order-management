require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const storage = require('./services/storage');
const botEngine = require('./services/botEngine');
const whatsappApi = require('./services/whatsappApi');
const webhookRoutes = require('./routes/webhook');
const apiRoutesFactory = require('./routes/api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Wire Socket.IO into services
botEngine.setSocketIO(io);
whatsappApi.setSocketIO(io);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/whatsapp/webhook', webhookRoutes); // Alias for clean URL
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

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 Restaurant Order Management Server is running!`);
  console.log(`📍 Kitchen & Admin Panel: http://localhost:${PORT}`);
  console.log(`📱 WhatsApp Bot Simulator: http://localhost:${PORT}/#simulator`);
  console.log(`🏷️ Table QR Code Studio: http://localhost:${PORT}/#tables`);
  console.log(`🔗 WhatsApp Cloud Webhook URL: http://localhost:${PORT}/webhook`);
  console.log('====================================================');
});
