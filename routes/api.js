const express = require('express');
const router = express.Router();
const storage = require('../services/storage');
const botEngine = require('../services/botEngine');
const whatsappApi = require('../services/whatsappApi');
const eventLog = require('../services/eventLog');
const QRCode = require('qrcode');
const dailySummary = require('../services/dailySummary');

module.exports = function(io) {
  // --- Orders Endpoints ---

  // Get all orders (with optional filters: status, tableNo, limit)
  router.get('/orders', (req, res) => {
    let orders = storage.getOrders();
    const { status, tableNo } = req.query;

    if (status) {
      const statuses = status.split(',');
      orders = orders.filter(o => statuses.includes(o.status));
    }
    if (tableNo) {
      orders = orders.filter(o => Number(o.tableNo) === Number(tableNo));
    }

    return res.json({ success: true, count: orders.length, orders });
  });

  // Update order status (pending -> cooking -> ready -> served -> completed | cancelled)
  router.post('/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!['pending', 'cooking', 'ready', 'served', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status code' });
    }

    const existing = storage.getOrderById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (!storage.canChangeStatus(existing, status)) {
      return res.status(409).json({ success: false, message: `Order is already ${existing.status} and can't be changed to ${status}.` });
    }
    const updated = storage.updateOrderStatus(id, status, typeof reason === 'string' ? reason.slice(0, 200) : '');

    // Broadcast to kitchen, admin, and simulator
    if (io) {
      io.emit('order_status_updated', {
        order: updated,
        timestamp: new Date().toISOString()
      });

      if (status === 'cancelled') {
        io.emit('play_sound', { type: 'cancellation', orderId: id, tableNo: updated.tableNo });
      } else if (status === 'ready') {
        io.emit('play_sound', { type: 'ready', orderId: id, tableNo: updated.tableNo });
      }
    }

    return res.json({ success: true, order: updated });
  });

  // --- Tables Endpoints ---

  router.get('/tables', (req, res) => {
    const tables = storage.getTables();
    const orders = storage.getOrders();

    // Attach active order details to each table
    const enhanced = tables.map(t => {
      const activeOrder = orders.find(o => 
        Number(o.tableNo) === Number(t.number) && !['completed', 'cancelled'].includes(o.status)
      );
      const session = storage.tableSession(t.number);
      const { session: _raw, ...rest } = t;
      return {
        ...rest,
        activeOrder: activeOrder || null,
        // Who holds the table (never the device token itself)
        occupiedBy: session ? { type: session.type, since: session.startedAt } : null
      };
    });

    return res.json({ success: true, tables: enhanced });
  });

  // Staff frees a table for the next party (guests left without completing)
  router.post('/tables/:number/free', (req, res) => {
    const table = storage.getTable(req.params.number);
    if (!table) return res.status(404).json({ success: false, message: 'Table not found' });
    storage.freeTable(table.number);
    if (io) io.emit('table_freed', { tableNo: table.number });
    return res.json({ success: true });
  });

  // Generate QR Code for a Table (Data URL)
  router.get('/tables/:number/qr', async (req, res) => {
    const tableNo = req.params.number;
    const settings = storage.getSettings();
    const botPhone = (settings.whatsappNumber || '').replace(/\D/g, '');
    
    // The WhatsApp wa.me link with prefilled text
    const waLink = `https://wa.me/${botPhone || '15551234567'}?text=Hi%20Table%20${tableNo}`;
    // Browser ordering page (no WhatsApp needed)
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const webLink = `${baseUrl.replace(/\/$/, '')}/order/?table=${encodeURIComponent(tableNo)}`;

    try {
      const qrOptions = { width: 320, margin: 2, color: { dark: '#111827', light: '#ffffff' } };
      const qrDataUrl = await QRCode.toDataURL(waLink, qrOptions);
      const webQrDataUrl = await QRCode.toDataURL(webLink, qrOptions);

      return res.json({
        success: true,
        tableNo,
        waLink,
        qrDataUrl,
        webLink,
        webQrDataUrl
      });
    } catch (err) {
      console.error('Error generating QR:', err);
      return res.status(500).json({ success: false, message: 'QR generation failed' });
    }
  });

  // --- Menu Endpoints ---

  router.get('/menu', (req, res) => {
    const menu = storage.getMenu();
    return res.json({ success: true, menu });
  });

  router.post('/menu', (req, res) => {
    const menu = storage.getMenu();
    const { name, category, price, isVeg, isSpicy, description } = req.body || {};
    const numericPrice = Number(price);

    if (typeof name !== 'string' || !name.trim() || typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ success: false, message: 'Name and category are required' });
    }
    if (!Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100000) {
      return res.status(400).json({ success: false, message: 'Price must be a number greater than 0' });
    }

    const newItem = {
      id: `item_${Date.now()}`,
      name: name.trim().slice(0, 80),
      category: category.trim().slice(0, 40),
      price: Math.round(numericPrice * 100) / 100,
      isVeg: Boolean(isVeg),
      isSpicy: Boolean(isSpicy),
      description: typeof description === 'string' ? description.trim().slice(0, 300) : '',
      inStock: true,
      popular: false
    };

    menu.push(newItem);
    storage.saveMenu(menu);

    if (io) io.emit('menu_updated', { menu });

    return res.json({ success: true, item: newItem });
  });

  router.patch('/menu/:id/stock', (req, res) => {
    const { id } = req.params;
    const { inStock } = req.body;

    const item = storage.toggleItemStock(id, inStock);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    if (io) io.emit('menu_updated', { menu: storage.getMenu() });

    return res.json({ success: true, item });
  });

  router.delete('/menu/:id', (req, res) => {
    let menu = storage.getMenu();
    const exists = menu.some(i => i.id === req.params.id);
    if (!exists) return res.status(404).json({ success: false, message: 'Item not found' });

    menu = menu.filter(i => i.id !== req.params.id);
    storage.saveMenu(menu);

    if (io) io.emit('menu_updated', { menu });

    return res.json({ success: true, message: 'Item deleted' });
  });

  // --- Simulator Inbound Endpoint ---

  router.post('/simulator/send', async (req, res) => {
    const { userId, text, tableNo, customerName } = req.body;
    if (!userId || !text) {
      return res.status(400).json({ success: false, message: 'userId and text are required' });
    }

    try {
      const messages = await whatsappApi.captureReplies(userId, () => botEngine.handleMessage(userId, text, {
        tableNo: tableNo ? Number(tableNo) : undefined,
        customerName: customerName || 'Simulator Guest'
      }));
      return res.json({ success: true, messages });
    } catch (err) {
      console.error('Simulator error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // --- Live events (polling fallback when WebSockets aren't available) ---

  router.get('/events', (req, res) => {
    return res.json({ success: true, ...eventLog.since(Number(req.query.since) || 0) });
  });

  // --- Analytics & Stats ---

  router.get('/stats', (req, res) => {
    const orders = storage.getOrders();
    // "Today" in the restaurant's timezone, not UTC
    const todayStr = dailySummary.dayKey(new Date());
    const todayOrders = orders.filter(o => o.createdAt && dailySummary.dayKey(new Date(o.createdAt)) === todayStr);
    const activeOrders = orders.filter(o => ['pending', 'cooking', 'ready'].includes(o.status));
    const completedToday = todayOrders.filter(o => o.status === 'completed');
    const cancelledToday = todayOrders.filter(o => o.status === 'cancelled');

    const todayRevenue = completedToday.reduce((sum, o) => sum + (o.total || 0), 0);

    // Calculate average prep time (from pending to ready/served)
    let totalPrepMins = 0;
    let countedOrders = 0;
    completedToday.forEach(o => {
      if (o.history && o.history.length > 1) {
        const start = new Date(o.createdAt).getTime();
        const end = new Date(o.updatedAt).getTime();
        const mins = Math.round((end - start) / 60000);
        if (mins > 0 && mins < 180) {
          totalPrepMins += mins;
          countedOrders++;
        }
      }
    });

    const avgPrepMinutes = countedOrders > 0 ? Math.round(totalPrepMins / countedOrders) : 16;

    // Item popularity count
    const itemCounts = {};
    orders.forEach(o => {
      if (o.status !== 'cancelled' && Array.isArray(o.items)) {
        o.items.forEach(i => {
          itemCounts[i.name] = (itemCounts[i.name] || 0) + (i.quantity || 1);
        });
      }
    });

    const topItems = Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return res.json({
      success: true,
      stats: {
        activeCount: activeOrders.length,
        todayCount: todayOrders.length,
        completedCount: completedToday.length,
        cancelledCount: cancelledToday.length,
        todayRevenue,
        avgPrepMinutes,
        topItems
      }
    });
  });

  // --- Settings ---

  // --- Daily Sales Summary ---

  router.get('/reports/daily', (req, res) => {
    const requested = req.query.date;
    let day;
    if (requested !== undefined) {
      const valid = typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) &&
        !isNaN(new Date(`${requested}T00:00:00Z`)) && new Date(`${requested}T00:00:00Z`).toISOString().slice(0, 10) === requested;
      if (!valid) return res.status(400).json({ success: false, message: 'Date must be a real date in YYYY-MM-DD format' });
      day = requested;
    }
    const summary = dailySummary.buildSummary(day);
    const s = storage.getSettings();
    return res.json({
      success: true,
      summary,
      message: dailySummary.formatMessage(summary),
      schedule: {
        ownerWhatsapp: s.ownerWhatsapp || '',
        dailySummaryTime: s.dailySummaryTime || '23:00',
        dailySummaryEnabled: s.dailySummaryEnabled !== false,
        timezone: s.timezone || 'Asia/Kolkata'
      }
    });
  });

  router.post('/reports/daily/send', async (req, res) => {
    try {
      const { to } = await dailySummary.sendSummary();
      return res.json({ success: true, sentTo: to === 'owner_simulator' ? 'Simulator (no owner number set)' : `+${to}` });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  router.post('/reports/schedule', (req, res) => {
    const { ownerWhatsapp, dailySummaryTime, dailySummaryEnabled } = req.body || {};
    if (dailySummaryTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailySummaryTime)) {
      return res.status(400).json({ success: false, message: 'Time must be HH:MM (24h)' });
    }
    const current = storage.getSettings();
    storage.saveSettings({
      ...current,
      ownerWhatsapp: String(ownerWhatsapp ?? current.ownerWhatsapp ?? '').replace(/[^\d+ ]/g, '').slice(0, 20),
      dailySummaryTime: dailySummaryTime || current.dailySummaryTime || '23:00',
      dailySummaryEnabled: dailySummaryEnabled !== undefined ? Boolean(dailySummaryEnabled) : current.dailySummaryEnabled !== false
    });
    return res.json({ success: true });
  });

  // Never send WhatsApp credentials to the browser
  function publicSettings() {
    const { metaConfig, ...rest } = storage.getSettings();
    return {
      ...rest,
      metaConfig: {
        phoneNumberId: (metaConfig && metaConfig.phoneNumberId) || '',
        wabaId: (metaConfig && metaConfig.wabaId) || '',
        accessTokenSet: Boolean((metaConfig && metaConfig.accessToken) || process.env.WHATSAPP_ACCESS_TOKEN)
      }
    };
  }

  router.get('/settings', (req, res) => {
    return res.json({ success: true, settings: publicSettings() });
  });

  // Only known settings, with sane values
  function validateSettings(body) {
    const out = {};
    const errors = [];
    const str = (key, max) => {
      if (body[key] === undefined) return;
      if (typeof body[key] !== 'string') errors.push(`${key} must be text`);
      else out[key] = body[key].trim().slice(0, max);
    };
    const num = (key, min, max) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (body[key] === '' || !Number.isFinite(n) || n < min || n > max) errors.push(`${key} must be a number between ${min} and ${max}`);
      else out[key] = n;
    };
    str('restaurantName', 60); str('tagline', 120); str('currency', 4);
    str('wifiName', 40); str('wifiPassword', 40); str('whatsappNumber', 20); str('timezone', 40);
    num('taxPercent', 0, 50); num('allowCancellationMinutes', 0, 60);
    return { out, errors };
  }

  router.post('/settings', (req, res) => {
    // WhatsApp credentials are configured through environment variables only
    const { out: changes, errors } = validateSettings(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('; ') });
    const current = storage.getSettings();
    storage.saveSettings({ ...current, ...changes, metaConfig: current.metaConfig });
    return res.json({ success: true, settings: publicSettings() });
  });

  return router;
};
