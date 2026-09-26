const crypto = require('crypto');
const storage = require('./storage');

// Builds cart lines from { itemId, quantity } using server-side menu prices.
function buildCart(lines) {
  const menu = storage.getMenu();
  const byId = new Map(menu.map(m => [m.id, m]));
  const cart = [];
  const soldOut = [];

  for (const line of lines || []) {
    const item = byId.get(String(line.itemId || line.id));
    const quantity = Math.min(Math.max(parseInt(line.quantity, 10) || 0, 0), 20);
    if (!item || quantity === 0) continue;
    if (!item.inStock) { soldOut.push(item.name); continue; }

    const existing = cart.find(c => c.id === item.id);
    if (existing) {
      existing.quantity = Math.min(existing.quantity + quantity, 20);
    } else {
      cart.push({ id: item.id, name: item.name, price: item.price, quantity, isVeg: item.isVeg });
    }
  }
  return { cart, soldOut };
}

function totals(cart) {
  const settings = storage.getSettings();
  const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const tax = Math.round(subtotal * (settings.taxPercent || 5) / 100);
  return { subtotal, tax, total: subtotal + tax };
}

// Creates the order and notifies the kitchen screen in real time.
function placeOrder({ tableNo, cart, customerPhone, customerName, notes, channel }, io) {
  const { subtotal, tax, total } = totals(cart);
  const order = storage.createOrder({
    tableNo,
    customerPhone,
    customerName,
    items: cart,
    subtotal,
    tax,
    total,
    notes: notes || ''
  });

  // Extra fields for web orders: channel + a private token for tracking links
  const trackToken = crypto.randomBytes(12).toString('hex');
  const orders = storage.getOrders();
  const saved = orders.find(o => o.id === order.id);
  if (saved) {
    saved.channel = channel || 'whatsapp';
    saved.trackToken = trackToken;
    storage.saveOrders(orders);
  }

  if (io) {
    io.emit('new_order', { order: { ...order, channel }, timestamp: new Date().toISOString() });
    io.emit('play_sound', { type: 'new_order', tableNo: order.tableNo, orderId: order.id });
  }
  return { order: { ...order, channel, trackToken }, trackToken };
}

// Public view of an order: nothing personal, only what the guest needs
function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    tableNo: order.tableNo,
    status: order.status,
    items: (order.items || []).map(i => ({ name: i.name, quantity: i.quantity, price: i.price })),
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    notes: order.notes,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

module.exports = { buildCart, totals, placeOrder, publicOrder };
