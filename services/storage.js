const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharedStore = require('./sharedStore');

const SEED_DIR = path.join(__dirname, '..', 'data');

// Serverless hosts (Vercel) have a read-only code folder: copy the seed data
// to /tmp on first use. Data then lives as long as the function instance.
function resolveDataDir() {
  if (!process.env.VERCEL) return SEED_DIR;
  const dir = path.join('/tmp', 'restaurant-data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(SEED_DIR)) {
      fs.copyFileSync(path.join(SEED_DIR, file), path.join(dir, file));
    }
  }
  return dir;
}
const DATA_DIR = resolveDataDir();

// Helper to safely read JSON
function readJson(filename, defaultValue = []) {
  if (sharedStore.enabled) return sharedStore.read(filename.replace('.json', ''));
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error(`Error reading ${filename}:`, err);
    return defaultValue;
  }
}

// Helper to safely write JSON
function writeJson(filename, data) {
  if (sharedStore.enabled) return sharedStore.write(filename.replace('.json', ''), data);
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filename}:`, err);
    return false;
  }
}

// Storage methods
const storage = {
  // Menu
  getMenu() {
    return readJson('menu.json', []);
  },
  saveMenu(menu) {
    return writeJson('menu.json', menu);
  },
  getMenuItem(id) {
    const menu = this.getMenu();
    return menu.find(item => item.id === id);
  },
  toggleItemStock(id, inStock) {
    const menu = this.getMenu();
    const item = menu.find(m => m.id === id);
    if (item) {
      item.inStock = typeof inStock === 'boolean' ? inStock : !item.inStock;
      this.saveMenu(menu);
      return item;
    }
    return null;
  },

  // Tables
  getTables() {
    return readJson('tables.json', []);
  },
  saveTables(tables) {
    return writeJson('tables.json', tables);
  },
  getTable(number) {
    const tables = this.getTables();
    return tables.find(t => Number(t.number) === Number(number));
  },
  updateTable(number, updateData) {
    const tables = this.getTables();
    const index = tables.findIndex(t => Number(t.number) === Number(number));
    if (index !== -1) {
      tables[index] = { ...tables[index], ...updateData };
      this.saveTables(tables);
      return tables[index];
    }
    return null;
  },

  // --- Table sessions: one party per table ---
  // A table is claimed by the first guest who orders (web device or WhatsApp
  // number). Others get "table occupied" until staff free it, all orders are
  // completed, or it sits idle with no active order.
  TABLE_IDLE_MS: 45 * 60 * 1000,

  tableSession(number) {
    const table = this.getTable(number);
    if (!table) return null;
    if (!table.session) {
      // An open order without a claim (placed before table locking, or by
      // staff) still means guests are sitting there, unless staff freed it since.
      const active = this.getActiveOrderByTable(number);
      if (active && (!table.freedAt || new Date(active.createdAt) > new Date(table.freedAt))) {
        return { type: 'unclaimed', startedAt: active.createdAt, lastActive: active.updatedAt };
      }
      return null;
    }
    const hasActive = Boolean(this.getActiveOrderByTable(number));
    const idleFor = Date.now() - new Date(table.session.lastActive || table.session.startedAt).getTime();
    if (!hasActive && idleFor > this.TABLE_IDLE_MS) return null; // abandoned
    return table.session;
  },

  // owner: { type: 'web', token } or { type: 'whatsapp', id }
  sessionMatches(session, owner) {
    if (!session || !owner) return false;
    if (session.type !== owner.type) return false;
    if (owner.type === 'web') {
      const a = Buffer.from(String(session.token || ''));
      const b = Buffer.from(String(owner.token || ''));
      return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    return String(session.id) === String(owner.id);
  },

  // Returns { ok, session } or { ok: false } when another party holds the table
  claimTable(number, owner) {
    const current = this.tableSession(number);
    const now = new Date().toISOString();
    if (current && !this.sessionMatches(current, owner)) return { ok: false };
    const session = current
      ? { ...current, lastActive: now }
      : {
          type: owner.type,
          id: owner.type === 'whatsapp' ? String(owner.id) : undefined,
          token: owner.type === 'web' ? crypto.randomBytes(16).toString('hex') : undefined,
          startedAt: now,
          lastActive: now
        };
    this.updateTable(number, { session });
    return { ok: true, session };
  },

  freeTable(number) {
    return this.updateTable(number, { status: 'vacant', currentOrderId: null, session: null, freedAt: new Date().toISOString() });
  },

  // Orders
  getOrders() {
    return readJson('orders.json', []);
  },
  saveOrders(orders) {
    return writeJson('orders.json', orders);
  },
  getOrderById(id) {
    const orders = this.getOrders();
    return orders.find(o => o.id === id);
  },
  getActiveOrderByTable(tableNo) {
    const orders = this.getOrders();
    // Return latest active (not completed or cancelled) order for this table
    return orders
      .filter(o => Number(o.tableNo) === Number(tableNo) && !['completed', 'cancelled'].includes(o.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  },
  createOrder(orderData) {
    const orders = this.getOrders();
    // 8 random base-32 characters: ~1 trillion combinations, checked for clashes anyway
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let id;
    do {
      id = 'ORD-' + Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('');
    } while (orders.some(o => o.id === id));
    const now = new Date().toISOString();
    
    const newOrder = {
      id,
      tableNo: Number(orderData.tableNo),
      customerPhone: orderData.customerPhone || 'Anonymous',
      customerName: orderData.customerName || `Guest (Table ${orderData.tableNo})`,
      status: 'pending', // pending -> cooking -> ready -> served -> completed | cancelled
      items: orderData.items || [],
      subtotal: orderData.subtotal || 0,
      tax: orderData.tax || 0,
      total: orderData.total || 0,
      notes: orderData.notes || '',
      createdAt: now,
      updatedAt: now,
      history: [{ status: 'pending', time: now }]
    };

    orders.unshift(newOrder);
    this.saveOrders(orders);

    // Update table status
    this.updateTable(orderData.tableNo, {
      status: 'occupied',
      currentOrderId: id,
      lastActive: now
    });

    return newOrder;
  },
  // Kitchen removes dishes it can't make (e.g. out of stock). Recalculates the
  // bill; if nothing is left the order is cancelled. Returns { order, removed }.
  removeOrderItems(orderId, indexes, reason) {
    const orders = this.getOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order) return null;
    const drop = new Set(indexes);
    const removed = order.items.filter((_, i) => drop.has(i));
    if (removed.length === 0) return { order, removed };

    const now = new Date().toISOString();
    order.items = order.items.filter((_, i) => !drop.has(i));
    order.removedItems = [...(order.removedItems || []), ...removed.map(i => ({ ...i, reason, time: now }))];
    const settings = this.getSettings();
    order.subtotal = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    order.tax = Math.round(order.subtotal * (settings.taxPercent || 5) / 100);
    order.total = order.subtotal + order.tax;
    order.updatedAt = now;
    order.history = [...(order.history || []), { status: order.status, time: now, reason: `Removed: ${removed.map(i => i.name).join(', ')} (${reason})` }];
    this.saveOrders(orders);

    if (order.items.length === 0) {
      return { order: this.updateOrderStatus(orderId, 'cancelled', `All items unavailable (${reason})`), removed };
    }
    return { order, removed };
  },

  // Which status changes are allowed (kitchen can skip ahead, never go back)
  STATUS_FLOW: {
    pending: ['cooking', 'ready', 'served', 'completed', 'cancelled'],
    cooking: ['ready', 'served', 'completed', 'cancelled'],
    ready: ['served', 'completed', 'cancelled'],
    served: ['completed'],
    completed: [],
    cancelled: []
  },

  canChangeStatus(order, newStatus) {
    return order.status === newStatus || (this.STATUS_FLOW[order.status] || []).includes(newStatus);
  },

  updateOrderStatus(orderId, newStatus, reason = '') {
    const orders = this.getOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order) return null;
    if (order.status === newStatus) return order;

    const now = new Date().toISOString();
    order.status = newStatus;
    order.updatedAt = now;
    if (reason) order.cancelReason = reason;

    if (!order.history) order.history = [];
    order.history.push({ status: newStatus, time: now, reason });

    this.saveOrders(orders);

    // If order is completed or cancelled, check table
    if (['completed', 'cancelled'].includes(newStatus)) {
      const activeRemaining = this.getActiveOrderByTable(order.tableNo);
      if (!activeRemaining) {
        const update = { status: 'vacant', currentOrderId: null };
        // Guests have paid and left: the table is free for the next party
        if (newStatus === 'completed') update.session = null;
        this.updateTable(order.tableNo, update);
      }
    } else {
      this.updateTable(order.tableNo, {
        status: newStatus === 'cooking' ? 'cooking' : newStatus === 'ready' ? 'ready' : 'occupied'
      });
    }

    return order;
  },

  // Settings
  getSettings() {
    return readJson('settings.json', {
      restaurantName: "Royal Spice Bistro",
      currency: "₹",
      taxPercent: 5,
      allowCancellationMinutes: 5
    });
  },
  saveSettings(settings) {
    return writeJson('settings.json', settings);
  }
};

module.exports = storage;
