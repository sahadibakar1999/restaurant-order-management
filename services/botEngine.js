const storage = require('./storage');
const whatsappApi = require('./whatsappApi');
const orderParser = require('./orderParser');
const orderService = require('./orderService');

// In-memory customer sessions
// Key: customerId (phone number or simulator ID)
// Value: { tableNo, state, cart: [ { itemId, name, price, quantity, isVeg } ], activeCategory }
// (kept in Redis on serverless hosting so a chat survives across instances)
const sharedStore = require('./sharedStore');
const localSessions = new Map();
const sessions = sharedStore.enabled ? sharedStore.sessions : localSessions;

class BotEngine {
  constructor(io) {
    this.io = io;
  }

  setSocketIO(io) {
    this.io = io;
  }

  getSession(userId, defaultTableNo = null) {
    if (!sessions.has(userId)) {
      sessions.set(userId, {
        userId,
        tableNo: defaultTableNo || 1,
        state: 'IDLE',
        cart: [],
        activeCategory: null,
        lastInteraction: Date.now()
      });
    }
    const session = sessions.get(userId);
    if (defaultTableNo && session.tableNo !== defaultTableNo) {
      session.tableNo = defaultTableNo;
    }
    session.lastInteraction = Date.now();
    return session;
  }

  resetSession(userId, keepTable = true) {
    const existing = sessions.get(userId);
    const tableNo = keepTable && existing ? existing.tableNo : 1;
    sessions.set(userId, {
      userId,
      tableNo,
      state: 'IDLE',
      cart: [],
      activeCategory: null,
      lastInteraction: Date.now()
    });
    return sessions.get(userId);
  }

  /**
   * Main incoming message processor
   * @param {string} userId - sender phone number or sim id
   * @param {string} incomingText - text message or button ID
   * @param {object} metadata - optional customerName, tableHint
   */
  async handleMessage(userId, incomingText, metadata = {}) {
    const rawText = (incomingText || '').trim();
    const text = rawText.toLowerCase();

    // Check if message specifies table number e.g. "hi table 5", "hi_table_2", "table 4", "t3"
    let detectedTable = metadata.tableNo;
    const tableMatch = rawText.match(/(?:table|tbl|t)\s*[:_#-]?\s*(\d+)/i);
    if (tableMatch && tableMatch[1]) {
      detectedTable = parseInt(tableMatch[1], 10);
    }

    const session = this.getSession(userId, detectedTable);
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';

    // 1. Initial Greeting / QR scan trigger
    // Whole-word greeting check ("chicken" must not count as "hi")
    const isGreeting = /^(hi|hii+|hello|hey|namaste|start|menu|home)\b/.test(text) ||
      /\b(show|see|view|open)\s+(the\s+)?menu\b/.test(text);
    if (isGreeting || (tableMatch && text.split(/\s+/).length <= 4)) {
      if (detectedTable) {
        if (!storage.getTable(detectedTable)) {
          return whatsappApi.sendMessage(userId, `⚠️ We couldn't find *Table ${detectedTable}*. Please scan the QR code on your table again.`);
        }
        if (this.tableHeldByOther(detectedTable, userId)) {
          return whatsappApi.sendMessage(userId, this.occupiedMessage(detectedTable));
        }
        session.tableNo = detectedTable;
      }
      return this.sendWelcomeMenu(userId, session);
    }

    // 2. Main menu button / keyword triggers
    if (text === 'btn_order' || text.includes('order food') || text === 'order') {
      return this.sendCategories(userId, session);
    }

    if (text === 'btn_status' || text.includes('check order') || text.includes('status') || text.includes('track')) {
      return this.checkOrderStatus(userId, session);
    }

    if (text === 'btn_cancel' || text.includes('cancel order') || text.includes('cancel')) {
      return this.handleCancelOrder(userId, session);
    }

    if (text === 'btn_waiter' || /\b(waiter|bill|cheque|napkins?|tissues?)\b/.test(text) || /^(need |some |more )?water( please)?$/.test(text)) {
      return this.handleCallWaiter(userId, session, rawText);
    }

    if (text === 'btn_view_cart' || text.includes('view cart') || text.includes('cart')) {
      return this.sendCartSummary(userId, session);
    }

    if (text === 'btn_confirm_order' || text.includes('confirm order') || text === 'confirm') {
      return this.confirmOrder(userId, session, metadata);
    }

    if (text === 'btn_clear_cart' || text.includes('clear cart')) {
      session.cart = [];
      await whatsappApi.sendMessage(userId, `🗑️ Your cart for *Table ${session.tableNo}* has been emptied.`);
      return this.sendWelcomeMenu(userId, session);
    }

    // 3. Category selection triggers (e.g., cat_starters, or "1. starters")
    const menu = storage.getMenu();
    const categories = [...new Set(menu.map(m => m.category))];

    const matchedCat = categories.find(c => 
      text === `cat_${c.toLowerCase().replace(/[^a-z0-9]/g, '_')}` ||
      text === c.toLowerCase() ||
      text.includes(c.toLowerCase())
    );

    if (matchedCat) {
      session.activeCategory = matchedCat;
      return this.sendCategoryItems(userId, session, matchedCat);
    }

    // 4. Item selection triggers (e.g. "add_item_1", or "1x item_1", or item code / partial name)
    if (text.startsWith('add_') || text.startsWith('item_')) {
      const itemId = rawText.replace('add_', '');
      const item = menu.find(m => m.id === itemId);
      if (item) {
        return this.addItemToCart(userId, session, item, 1);
      }
    }

    // AI order understanding: "2 butter naan and a mango lassi, less spicy"
    if (rawText.split(/\s+/).length > 1 || orderParser.looksLikeOrder(rawText)) {
      const parsed = await orderParser.parseOrder(rawText, menu);
      if (parsed.items.length) {
        return this.addParsedItems(userId, session, parsed);
      }
      if (parsed.ambiguous.length) {
        const a = parsed.ambiguous[0];
        return whatsappApi.sendMessage(userId,
          `🤔 Which one did you mean for "_${a.text}_"?\n\n` +
          a.options.map((o, i) => `${i + 1}. ${o}`).join('\n') +
          `\n\nReply with the dish name, e.g. "2 ${a.options[0]}".`);
      }
    }

    // Match by item number or dish name
    const foundItem = menu.find(m => 
      m.id.toLowerCase() === text || 
      m.name.toLowerCase() === text ||
      m.name.toLowerCase().includes(text)
    );

    if (foundItem) {
      return this.addItemToCart(userId, session, foundItem, 1);
    }

    // 5. Fallback help
    const helpMsg = `👋 *${settings.restaurantName}*\n\n` +
      `We received: "_${rawText}_"\n\n` +
      `You are at *Table ${session.tableNo}*.\n` +
      `What would you like to do?\n` +
      `1️⃣ Type *Menu* to see dishes\n` +
      `2️⃣ Type *Status* to track your order\n` +
      `3️⃣ Type *Cancel* to cancel order\n` +
      `4️⃣ Type *Waiter* or *Bill* for service`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(helpMsg, [
      { id: 'btn_order', title: '🍽️ Order Food' },
      { id: 'btn_status', title: '📋 Check Order' },
      { id: 'btn_waiter', title: '🙋 Call Waiter' }
    ]));
  }

  // --- Bot Views & Actions ---

  async sendWelcomeMenu(userId, session) {
    const settings = storage.getSettings();
    const tableNo = session.tableNo;
    const activeOrder = storage.getActiveOrderByTable(tableNo);

    let welcomeText = `✨ *Welcome to ${settings.restaurantName}!* ✨\n\n` +
      `📍 Seated at: *Table ${tableNo}*\n` +
      `How may we serve you today?\n\n` +
      `• Select *Order Food* to browse digital menu\n` +
      `• Select *Check Order* to see live kitchen status\n` +
      `• Select *Call Waiter* for instant assistance`;

    if (activeOrder) {
      welcomeText += `\n\n📌 *Active Order #${activeOrder.id}* is currently: *${activeOrder.status.toUpperCase()}*`;
    }

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(welcomeText, [
      { id: 'btn_order', title: '🍽️ Order Food' },
      { id: 'btn_status', title: '📋 Check Order' },
      { id: 'btn_waiter', title: '🙋 Call Waiter' }
    ]));
  }

  async sendCategories(userId, session) {
    const menu = storage.getMenu();
    const categories = [...new Set(menu.map(m => m.category))];

    const listRows = categories.map((cat, idx) => {
      const count = menu.filter(m => m.category === cat && m.inStock).length;
      return {
        id: `cat_${cat.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        title: `${cat}`,
        description: `${count} delicious items available`
      };
    });

    const bodyText = `📖 *Menu Categories (Table ${session.tableNo})*\n\n` +
      `Tap below to select a category and view our chef specials:`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildList(
      bodyText,
      'Select Category',
      'Food Categories',
      listRows
    ));
  }

  async sendCategoryItems(userId, session, category) {
    const menu = storage.getMenu();
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';
    const items = menu.filter(m => m.category === category);

    if (items.length === 0) {
      await whatsappApi.sendMessage(userId, `No items found in *${category}*.`);
      return this.sendCategories(userId, session);
    }

    let message = `🍲 *${category.toUpperCase()} (Table ${session.tableNo})*\n\n`;
    items.forEach((item, index) => {
      const vegTag = item.isVeg ? '🟢 [Veg]' : '🔴 [Non-Veg]';
      const spiceTag = item.isSpicy ? ' 🌶️' : '';
      const stockTag = item.inStock ? '' : ' ⚠️ *OUT OF STOCK*';
      
      message += `*${index + 1}. ${item.name}* ${vegTag}${spiceTag}\n` +
        `   💵 ${curr}${item.price}${stockTag}\n` +
        `   _${item.description}_\n\n`;
    });

    message += `👉 *To order an item*, tap one of the quick buttons below or simply type the name of the dish.`;

    // Take top 3 in-stock items as quick buttons
    const inStockItems = items.filter(i => i.inStock);
    const buttons = inStockItems.slice(0, 2).map(i => ({
      id: `add_${i.id}`,
      title: `+ ${i.name}`.slice(0, 20)
    }));
    buttons.push({ id: 'btn_view_cart', title: '🛒 View Cart' });

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(message, buttons));
  }

  async addItemToCart(userId, session, item, quantity = 1) {
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';

    if (!item.inStock) {
      return whatsappApi.sendMessage(userId, `⚠️ Sorry, *${item.name}* is currently sold out! Please pick another item.`);
    }

    const existingIdx = session.cart.findIndex(i => i.id === item.id);
    if (existingIdx !== -1) {
      session.cart[existingIdx].quantity += quantity;
    } else {
      session.cart.push({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: quantity,
        isVeg: item.isVeg
      });
    }

    const cartCount = session.cart.reduce((sum, i) => sum + i.quantity, 0);
    const cartTotal = session.cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);

    const msg = `✅ Added *${quantity}x ${item.name}* to cart!\n\n` +
      `🛒 *Your Cart:* ${cartCount} items | *${curr}${cartTotal}*\n\n` +
      `Would you like to add more items or confirm your order?`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(msg, [
      { id: 'btn_order', title: '➕ Add More Food' },
      { id: 'btn_view_cart', title: '🛒 Review Cart' },
      { id: 'btn_confirm_order', title: '✅ Place Order' }
    ]));
  }

  async addParsedItems(userId, session, parsed) {
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';
    const { cart, soldOut } = orderService.buildCart(parsed.items);

    for (const line of cart) {
      const existing = session.cart.find(c => c.id === line.id);
      if (existing) existing.quantity = Math.min(existing.quantity + line.quantity, 20);
      else session.cart.push(line);
    }

    const itemNotes = parsed.items
      .filter(i => i.note)
      .map(i => {
        const line = cart.find(c => c.id === i.itemId);
        return line ? `${line.name}: ${i.note}` : null;
      })
      .filter(Boolean);
    const notes = [...itemNotes, parsed.note].filter(Boolean);
    if (notes.length) session.notes = [session.notes, ...notes].filter(Boolean).join('; ');

    const cartTotal = session.cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    let msg = cart.length
      ? `✅ Got it! Added to your cart:\n` + cart.map(c => `• ${c.quantity}x ${c.name} — ${curr}${c.price * c.quantity}`).join('\n')
      : `⚠️ I couldn't add those items.`;
    if (notes.length) msg += `\n📝 Note for kitchen: _${notes.join('; ')}_`;
    if (soldOut.length) msg += `\n\n❌ Sold out right now: ${soldOut.join(', ')}`;
    if (parsed.unmatched.length) msg += `\n\n🤷 Not on our menu: ${parsed.unmatched.map(u => `"${u}"`).join(', ')}`;
    if (parsed.skipped && parsed.skipped.length) msg += `\n\n⏭️ Skipped (sounds like you don't want it): ${parsed.skipped.map(u => `"${u}"`).join(', ')}`;
    if (parsed.capped && parsed.capped.length) msg += `\n\n⚠️ Max 20 per dish: ${parsed.capped.join(', ')}. Please ask a waiter for bigger orders.`;
    msg += `\n\n🛒 *Cart total:* ${curr}${cartTotal}`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(msg, [
      { id: 'btn_confirm_order', title: '✅ Place Order' },
      { id: 'btn_view_cart', title: '🛒 Review Cart' },
      { id: 'btn_order', title: '➕ Add More Food' }
    ]));
  }

  async sendCartSummary(userId, session) {
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';

    if (!session.cart || session.cart.length === 0) {
      return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(
        `🛒 Your cart for *Table ${session.tableNo}* is currently empty.\nBrowse the menu to pick your favourite dishes!`,
        [
          { id: 'btn_order', title: '🍽️ Browse Menu' },
          { id: 'btn_status', title: '📋 Check Status' }
        ]
      ));
    }

    let subtotal = 0;
    let summaryText = `🛒 *Your Order Summary (Table ${session.tableNo})*\n` +
      `━━━━━━━━━━━━━━━━━━━\n`;

    session.cart.forEach((item, idx) => {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;
      const vegDot = item.isVeg ? '🟢' : '🔴';
      summaryText += `${vegDot} ${item.quantity}x *${item.name}*\n   ${curr}${item.price} each = ${curr}${itemTotal}\n`;
    });

    const tax = Math.round(subtotal * (settings.taxPercent || 5) / 100);
    const total = subtotal + tax;

    summaryText += `━━━━━━━━━━━━━━━━━━━\n` +
      `Subtotal: ${curr}${subtotal}\n` +
      `GST (${settings.taxPercent || 5}%): ${curr}${tax}\n` +
      `*Grand Total: ${curr}${total}*\n\n` +
      `Ready to send this order to the kitchen?`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(summaryText, [
      { id: 'btn_confirm_order', title: '✅ Confirm & Send' },
      { id: 'btn_order', title: '➕ Add More' },
      { id: 'btn_clear_cart', title: '🗑️ Clear Cart' }
    ]));
  }

  // Another party (web device or WhatsApp number) already holds this table
  tableHeldByOther(tableNo, userId) {
    const held = storage.tableSession(tableNo);
    return Boolean(held) && !storage.sessionMatches(held, { type: 'whatsapp', id: userId });
  }

  occupiedMessage(tableNo) {
    return `🚫 *Table ${tableNo} is already taken* by another guest.\n\n` +
      `If you're sitting together, one person can place the order for the table, or call a waiter for help.`;
  }

  async confirmOrder(userId, session, metadata = {}) {
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';

    if (!session.cart || session.cart.length === 0) {
      return whatsappApi.sendMessage(userId, `⚠️ Your cart is empty! Please choose food items first.`);
    }

    // One party per table: the first guest to order claims it
    const claim = storage.claimTable(session.tableNo, { type: 'whatsapp', id: userId });
    if (!claim.ok) {
      return whatsappApi.sendMessage(userId, this.occupiedMessage(session.tableNo));
    }

    const subtotal = session.cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const tax = Math.round(subtotal * (settings.taxPercent || 5) / 100);
    const total = subtotal + tax;

    // Create order in persistent storage
    const newOrder = storage.createOrder({
      tableNo: session.tableNo,
      customerPhone: userId,
      customerName: metadata.customerName || `Guest (Table ${session.tableNo})`,
      items: [...session.cart],
      subtotal,
      tax,
      total,
      notes: [metadata.notes, session.notes].filter(Boolean).join('; ')
    });

    // Clear cart after order creation
    session.cart = [];
    session.notes = '';

    // Broadcast real-time event to Kitchen Display System (KDS) & Admin Panel
    if (this.io) {
      this.io.emit('new_order', {
        order: newOrder,
        timestamp: new Date().toISOString()
      });
      // Sound alert trigger
      this.io.emit('play_sound', {
        type: 'new_order',
        tableNo: newOrder.tableNo,
        orderId: newOrder.id
      });
    }

    const confirmMsg = `🎉 *Order Placed Successfully!* 🎉\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🔖 *Order ID:* #${newOrder.id}\n` +
      `📍 *Table:* ${newOrder.tableNo}\n` +
      `💰 *Total Amount:* ${curr}${newOrder.total}\n` +
      `⏳ *Status:* ⏳ Received & Sent to Kitchen\n` +
      `⏱️ *Estimated Prep Time:* 15-20 mins\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `Our chefs have received your order and started preparing fresh! You can track live status or cancel anytime before cooking starts.`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(confirmMsg, [
      { id: 'btn_status', title: '📋 Live Status' },
      { id: 'btn_cancel', title: '❌ Cancel Order' },
      { id: 'btn_waiter', title: '🙋 Call Waiter' }
    ]));
  }

  async checkOrderStatus(userId, session) {
    const settings = storage.getSettings();
    const curr = settings.currency || '₹';
    const activeOrder = storage.getActiveOrderByTable(session.tableNo);

    if (!activeOrder) {
      return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(
        `ℹ️ No active order found for *Table ${session.tableNo}*.\n` +
        `Would you like to place a new order?`,
        [
          { id: 'btn_order', title: '🍽️ Order Food' },
          { id: 'btn_waiter', title: '🙋 Call Waiter' }
        ]
      ));
    }

    const elapsedMins = Math.floor((Date.now() - new Date(activeOrder.createdAt).getTime()) / 60000);
    
    let statusEmoji = '⏳';
    let statusLabel = 'Received (Waiting for Chef)';
    if (activeOrder.status === 'cooking') {
      statusEmoji = '🔥';
      statusLabel = 'Cooking in Progress';
    } else if (activeOrder.status === 'ready') {
      statusEmoji = '🔔';
      statusLabel = 'Ready to Serve!';
    } else if (activeOrder.status === 'served') {
      statusEmoji = '🍽️';
      statusLabel = 'Served at your table';
    }

    let itemsList = activeOrder.items.map(i => `• ${i.quantity}x ${i.name}`).join('\n');

    const msg = `📋 *Live Order Status (Table ${session.tableNo})*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🔖 *Order ID:* #${activeOrder.id}\n` +
      `${statusEmoji} *Status:* *${statusLabel}*\n` +
      `⏱️ *Time Elapsed:* ${elapsedMins} minute(s) ago\n` +
      `💵 *Total Bill:* ${curr}${activeOrder.total}\n\n` +
      `*Dishes Ordered:*\n${itemsList}\n` +
      `━━━━━━━━━━━━━━━━━━━\n`;

    const buttons = [
      { id: 'btn_order', title: '➕ Order More' },
      { id: 'btn_waiter', title: '🙋 Call Waiter' }
    ];

    if (activeOrder.status === 'pending' || activeOrder.status === 'cooking') {
      buttons.unshift({ id: 'btn_cancel', title: '❌ Cancel Order' });
    }

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(msg, buttons));
  }

  async handleCancelOrder(userId, session) {
    const settings = storage.getSettings();
    const activeOrder = storage.getActiveOrderByTable(session.tableNo);

    if (!activeOrder) {
      return whatsappApi.sendMessage(userId, `⚠️ You do not have any active order to cancel at *Table ${session.tableNo}*.`);
    }

    // Check if cancellation allowed
    // Allowed if status === 'pending' or within allowCancellationMinutes of cooking
    const elapsedMins = Math.floor((Date.now() - new Date(activeOrder.createdAt).getTime()) / 60000);
    const allowLimit = settings.allowCancellationMinutes || 5;

    if (activeOrder.status === 'served') {
      return whatsappApi.sendMessage(userId, `❌ Sorry, Order #${activeOrder.id} has already been served and cannot be cancelled. Please speak with the floor manager for assistance.`);
    }

    if (activeOrder.status === 'ready') {
      return whatsappApi.sendMessage(userId, `❌ Sorry, Order #${activeOrder.id} has already been cooked and is being plated. Please inform the floor manager if you need help.`);
    }

    // Execute cancellation
    const updatedOrder = storage.updateOrderStatus(activeOrder.id, 'cancelled', 'Cancelled by customer via WhatsApp');

    // Notify Kitchen / Admin Display immediately with HIGH-PRIORITY alert
    if (this.io) {
      this.io.emit('order_cancelled', {
        order: updatedOrder,
        tableNo: session.tableNo,
        timestamp: new Date().toISOString()
      });
      this.io.emit('play_sound', {
        type: 'cancellation',
        tableNo: session.tableNo,
        orderId: activeOrder.id
      });
    }

    const cancelMsg = `🛑 *Order Cancelled Successfully*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `Your Order *#${activeOrder.id}* at *Table ${session.tableNo}* has been cancelled.\n` +
      `The kitchen team has been alerted immediately.\n\n` +
      `Would you like to browse the menu again?`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(cancelMsg, [
      { id: 'btn_order', title: '🍽️ View Menu' },
      { id: 'btn_waiter', title: '🙋 Call Waiter' }
    ]));
  }

  async handleCallWaiter(userId, session, rawText) {
    const textLower = rawText.toLowerCase();
    let serviceType = 'General Assistance';
    if (textLower.includes('water')) serviceType = 'Water Refill';
    else if (textLower.includes('bill') || textLower.includes('cheque') || textLower.includes('check')) serviceType = 'Bill / Payment Request';
    else if (textLower.includes('napkin') || textLower.includes('tissue')) serviceType = 'Tissues / Cutlery';

    // Broadcast waiter request to Kitchen & Floor Admin
    if (this.io) {
      this.io.emit('waiter_call', {
        tableNo: session.tableNo,
        serviceType,
        timestamp: new Date().toISOString()
      });
      this.io.emit('play_sound', {
        type: 'bell',
        tableNo: session.tableNo
      });
    }

    const msg = `🔔 *Request Sent to Floor Staff!*\n\n` +
      `A team member has been notified for: *${serviceType}* at *Table ${session.tableNo}*.\n` +
      `Someone will be right with you in just a moment!`;

    return whatsappApi.sendMessage(userId, whatsappApi.buildButtons(msg, [
      { id: 'btn_order', title: '🍽️ Food Menu' },
      { id: 'btn_status', title: '📋 Order Status' }
    ]));
  }
}

module.exports = new BotEngine();
