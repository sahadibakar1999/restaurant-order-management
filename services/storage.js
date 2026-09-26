const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Helper to safely read JSON
function readJson(filename, defaultValue = []) {
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
    const id = `ORD-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 90 + 10)}`;
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
  updateOrderStatus(orderId, newStatus, reason = '') {
    const orders = this.getOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order) return null;

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
        this.updateTable(order.tableNo, {
          status: newStatus === 'completed' ? 'billing' : 'vacant',
          currentOrderId: null
        });
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
