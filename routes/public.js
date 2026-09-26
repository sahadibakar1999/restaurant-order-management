// Customer-facing endpoints for QR web ordering. No admin login required,
// so everything here is rate-limited and returns only what a guest needs.
const crypto = require('crypto');
const express = require('express');
const storage = require('../services/storage');
const orderService = require('../services/orderService');
const orderParser = require('../services/orderParser');

// Small in-memory rate limiter (per IP, per bucket)
const hits = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      return res.status(429).json({ success: false, message: 'Too many requests, please wait a minute.' });
    }
    next();
  };
}

function validTable(tableNo) {
  const n = parseInt(tableNo, 10);
  return storage.getTables().some(t => Number(t.number) === n) ? n : null;
}

function tokenMatches(order, token) {
  if (!order || !order.trackToken || !token) return false;
  const a = Buffer.from(String(order.trackToken));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function (io) {
  const router = express.Router();

  router.get('/info', (req, res) => {
    const s = storage.getSettings();
    res.json({
      success: true,
      restaurantName: s.restaurantName,
      tagline: s.tagline,
      currency: s.currency || '₹',
      taxPercent: s.taxPercent || 5,
      allowCancellationMinutes: s.allowCancellationMinutes || 5,
      aiEnabled: orderParser.aiEnabled()
    });
  });

  router.get('/menu', (req, res) => {
    const menu = storage.getMenu().map(({ id, name, category, price, isVeg, isSpicy, description, inStock, popular }) =>
      ({ id, name, category, price, isVeg, isSpicy, description, inStock, popular }));
    res.json({ success: true, menu });
  });

  // "2 butter naan and a lassi" -> suggested cart lines (guest confirms before ordering)
  router.post('/parse', rateLimit('parse', 30, 60_000), async (req, res) => {
    const text = String((req.body && req.body.text) || '').slice(0, 500).trim();
    if (!text) return res.status(400).json({ success: false, message: 'Type what you would like to order.' });

    const menu = storage.getMenu();
    const result = await orderParser.parseOrder(text, menu);
    const byId = new Map(menu.map(m => [m.id, m]));
    res.json({
      success: true,
      source: result.source,
      items: result.items.map(i => ({ ...i, name: byId.get(i.itemId).name, price: byId.get(i.itemId).price, inStock: byId.get(i.itemId).inStock })),
      unmatched: result.unmatched,
      ambiguous: result.ambiguous,
      note: result.note
    });
  });

  router.post('/orders', rateLimit('orders', 6, 10 * 60_000), (req, res) => {
    const { tableNo, items, name, notes } = req.body || {};
    const table = validTable(tableNo);
    if (!table) return res.status(400).json({ success: false, message: 'Unknown table. Please scan the QR code on your table again.' });

    const { cart, soldOut } = orderService.buildCart(items);
    if (cart.length === 0) {
      return res.status(400).json({ success: false, message: soldOut.length ? `Sorry, ${soldOut.join(', ')} just sold out.` : 'Your cart is empty.' });
    }

    const guestName = String(name || '').trim().slice(0, 40);
    const { order, trackToken } = orderService.placeOrder({
      tableNo: table,
      cart,
      customerPhone: 'Web QR',
      customerName: guestName ? `${guestName} (Table ${table})` : `Guest (Table ${table})`,
      notes: String(notes || '').slice(0, 200),
      channel: 'web'
    }, io);

    res.json({ success: true, soldOut, order: orderService.publicOrder(order), trackToken });
  });

  router.get('/orders/:id', (req, res) => {
    const order = storage.getOrderById(req.params.id);
    if (!tokenMatches(order, req.query.token)) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order: orderService.publicOrder(order) });
  });

  router.post('/orders/:id/cancel', rateLimit('cancel', 10, 10 * 60_000), (req, res) => {
    const order = storage.getOrderById(req.params.id);
    if (!tokenMatches(order, req.body && req.body.token)) return res.status(404).json({ success: false, message: 'Order not found' });

    const minutes = storage.getSettings().allowCancellationMinutes || 5;
    const ageMin = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
    if (order.status !== 'pending' || ageMin > minutes) {
      return res.status(409).json({ success: false, message: 'The kitchen has already started on this order. Please ask a waiter.' });
    }

    const updated = storage.updateOrderStatus(order.id, 'cancelled', 'Cancelled by guest (web)');
    if (io) {
      io.emit('order_status_updated', { order: updated, timestamp: new Date().toISOString() });
      io.emit('play_sound', { type: 'cancellation', orderId: order.id, tableNo: order.tableNo });
    }
    res.json({ success: true, order: orderService.publicOrder(updated) });
  });

  router.post('/waiter', rateLimit('waiter', 5, 5 * 60_000), (req, res) => {
    const table = validTable(req.body && req.body.tableNo);
    if (!table) return res.status(400).json({ success: false, message: 'Unknown table.' });
    const types = { water: 'Water Refill', bill: 'Bill / Payment Request', help: 'General Assistance' };
    const serviceType = types[req.body.type] || types.help;
    if (io) {
      io.emit('waiter_call', { tableNo: table, serviceType, timestamp: new Date().toISOString() });
      io.emit('play_sound', { type: 'bell', tableNo: table });
    }
    res.json({ success: true, serviceType });
  });

  return router;
};
