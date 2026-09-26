// Main Application Orchestrator for Kitchen Display, Menu, and Analytics

// Guest-typed text (names, notes) must never be inserted as raw HTML
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class RestaurantApp {
  constructor() {
    this.socket = null;
    this.orders = [];
    this.currentFilter = 'all';
    this.timerInterval = null;
    this.activeTab = 'kds';

    this.initElements();
    this.initSocket();
    this.bindEvents();
    this.loadInitialData();
    this.startLiveTimers();
  }

  initElements() {
    this.ordersGrid = document.getElementById('ordersGrid');
    this.kdsCountAll = document.getElementById('kdsCountAll');
    this.kdsCountPending = document.getElementById('kdsCountPending');
    this.kdsCountCooking = document.getElementById('kdsCountCooking');
    this.kdsCountReady = document.getElementById('kdsCountReady');
    this.urgentBanner = document.getElementById('urgentBanner');
    this.urgentBannerText = document.getElementById('urgentBannerText');
    this.btnDismissBanner = document.getElementById('btnDismissBanner');
    this.audioToggleBtn = document.getElementById('btnAudioToggle');
  }

  initSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('Connected to Kitchen Display real-time gateway');
    });

    // New Incoming Order
    this.socket.on('new_order', (data) => {
      console.log('New incoming order:', data.order);
      // Prepend to orders
      this.orders.unshift(data.order);
      this.renderOrders();
      this.updateCounts();
      this.showUrgentBanner(`🎉 New Order #${data.order.id} received from Table ${data.order.tableNo}!`);
      if (window.soundFX) window.soundFX.playNewOrderChime();
    });

    // Order Status Update
    this.socket.on('order_status_updated', (data) => {
      const idx = this.orders.findIndex(o => o.id === data.order.id);
      if (idx !== -1) {
        this.orders[idx] = data.order;
      } else {
        this.orders.unshift(data.order);
      }
      this.renderOrders();
      this.updateCounts();
    });

    // Order Cancelled
    this.socket.on('order_cancelled', (data) => {
      const idx = this.orders.findIndex(o => o.id === data.order.id);
      if (idx !== -1) {
        this.orders[idx] = data.order;
      }
      this.renderOrders();
      this.updateCounts();
      this.showUrgentBanner(`🛑 ORDER CANCELLED: Table ${data.tableNo} cancelled Order #${data.order.id}! Stop cooking immediately.`);
      if (window.soundFX) window.soundFX.playCancellationAlert();
    });

    // Waiter Call
    this.socket.on('waiter_call', (data) => {
      this.showUrgentBanner(`🔔 ATTENTION: Table ${data.tableNo} requested ${data.serviceType}!`);
      if (window.soundFX) window.soundFX.playWaiterBell();
    });

    // Audio Play Event
    this.socket.on('play_sound', (data) => {
      if (!window.soundFX) return;
      if (data.type === 'cancellation') window.soundFX.playCancellationAlert();
      else if (data.type === 'new_order') window.soundFX.playNewOrderChime();
      else if (data.type === 'bell') window.soundFX.playWaiterBell();
      else if (data.type === 'ready') window.soundFX.playReadyBell();
    });

    // Bot message for simulator
    this.socket.on('bot_message', (data) => {
      if (window.simulator) {
        window.simulator.handleIncomingBotMessage(data);
      }
    });

    // Menu update
    this.socket.on('menu_updated', () => {
      this.loadMenu();
    });
  }

  bindEvents() {
    // Navigation tabs
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = btn.getAttribute('data-tab');
        if (tab) {
          e.preventDefault();
          this.switchTab(tab);
        }
      });
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.getAttribute('data-filter') || 'all';
        this.renderOrders();
      });
    });

    // Audio Toggle
    if (this.audioToggleBtn) {
      this.audioToggleBtn.addEventListener('click', () => {
        if (window.soundFX) {
          const enabled = window.soundFX.toggle();
          this.audioToggleBtn.classList.toggle('active-audio', enabled);
          this.audioToggleBtn.title = enabled ? 'Sound Alerts: ON' : 'Sound Alerts: OFF';
          if (enabled) window.soundFX.playNewOrderChime();
        }
      });
    }

    // Dismiss banner
    if (this.btnDismissBanner) {
      this.btnDismissBanner.addEventListener('click', () => {
        this.urgentBanner.classList.remove('active');
      });
    }

    // Add Dish Form Submit
    const addDishForm = document.getElementById('formAddDish');
    if (addDishForm) {
      addDishForm.addEventListener('submit', (e) => this.handleCreateDish(e));
    }
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    document.querySelectorAll('.nav-tab-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
    });

    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active');
    });

    const activeSec = document.getElementById(`view-${tabName}`);
    if (activeSec) activeSec.classList.add('active');

    // Tab-specific refreshes
    if (tabName === 'tables' && window.qrStudio) {
      window.qrStudio.loadTables();
    } else if (tabName === 'analytics') {
      this.loadAnalytics();
    } else if (tabName === 'menu') {
      this.loadMenu();
    }
  }

  showUrgentBanner(text) {
    if (!this.urgentBanner || !this.urgentBannerText) return;
    this.urgentBannerText.textContent = text;
    this.urgentBanner.classList.add('active');
  }

  async loadInitialData() {
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();
      if (data.success) {
        this.orders = data.orders;
        this.renderOrders();
        this.updateCounts();
      }
    } catch (err) {
      console.error('Failed to load initial orders:', err);
    }
  }

  updateCounts() {
    const pending = this.orders.filter(o => o.status === 'pending').length;
    const cooking = this.orders.filter(o => o.status === 'cooking').length;
    const ready = this.orders.filter(o => o.status === 'ready').length;
    const activeTotal = pending + cooking + ready;

    if (this.kdsCountAll) this.kdsCountAll.textContent = activeTotal;
    if (this.kdsCountPending) this.kdsCountPending.textContent = pending;
    if (this.kdsCountCooking) this.kdsCountCooking.textContent = cooking;
    if (this.kdsCountReady) this.kdsCountReady.textContent = ready;

    const navBadge = document.getElementById('kdsNavBadge');
    if (navBadge) navBadge.textContent = activeTotal;
  }

  renderOrders() {
    if (!this.ordersGrid) return;
    this.ordersGrid.innerHTML = '';

    let filtered = this.orders;
    if (this.currentFilter === 'active') {
      filtered = this.orders.filter(o => ['pending', 'cooking', 'ready'].includes(o.status));
    } else if (this.currentFilter !== 'all') {
      filtered = this.orders.filter(o => o.status === this.currentFilter);
    }

    if (filtered.length === 0) {
      this.ordersGrid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👨‍🍳</div>
          <h3>No Orders Found</h3>
          <p>Orders placed via WhatsApp will appear here in real time.</p>
        </div>
      `;
      return;
    }

    filtered.forEach(order => {
      const card = this.createOrderCard(order);
      this.ordersGrid.appendChild(card);
    });
  }

  createOrderCard(order) {
    const card = document.createElement('div');
    card.className = `order-card status-${order.status}`;
    card.id = `order-card-${order.id}`;

    const isCancelled = order.status === 'cancelled';
    const isCompleted = order.status === 'completed';

    // Status label
    const statusLabels = {
      pending: '⏳ Pending',
      cooking: '🔥 Cooking',
      ready: '🔔 Ready to Serve',
      served: '🍽️ Served',
      completed: '✅ Completed',
      cancelled: '🛑 Cancelled'
    };

    // Calculate time elapsed
    const createdTime = new Date(order.createdAt).getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdTime) / 1000));
    const mins = Math.floor(elapsedSeconds / 60);
    const secs = elapsedSeconds % 60;
    const timeFormatted = `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;

    let timerClass = 'timer-green';
    if (mins >= 15) timerClass = 'timer-red';
    else if (mins >= 8) timerClass = 'timer-yellow';

    // Cancellation banner
    let cancelAlertHtml = '';
    if (isCancelled) {
      cancelAlertHtml = `
        <div class="cancel-alert-box">
          <span>⚠️ <strong>CANCELLED BY CUSTOMER</strong></span>
          <span style="margin-left: auto;">${escapeHtml(order.cancelReason || 'Customer requested cancel')}</span>
        </div>
      `;
    }

    // Items list HTML with checklist
    const itemsHtml = (order.items || []).map((item, idx) => `
      <li class="order-item-row" id="itemRow-${order.id}-${idx}">
        <div class="item-left">
          <input type="checkbox" class="item-check-checkbox" title="Mark item cooked" ${isCompleted ? 'checked disabled' : ''}>
          <span class="item-qty-badge">${item.quantity}x</span>
          <span class="item-name-text">
            <span class="veg-dot ${item.isVeg ? 'veg' : 'non-veg'}"></span>
            ${item.name}
          </span>
        </div>
        <span class="item-price-text">₹${item.price * item.quantity}</span>
      </li>
    `).join('');

    // Notes
    let notesHtml = '';
    if (order.notes) {
      notesHtml = `<div class="order-notes-box">📝 <strong>Note:</strong> ${escapeHtml(order.notes)}</div>`;
    }

    // Action buttons based on status
    let actionButtonsHtml = '';
    if (order.status === 'pending') {
      actionButtonsHtml = `
        <button class="btn-stage btn-cook" onclick="app.updateStatus('${order.id}', 'cooking')">
          🔥 Start Cooking
        </button>
        <button class="btn-stage btn-cancel-action" onclick="app.updateStatus('${order.id}', 'cancelled')">
          ❌ Cancel
        </button>
      `;
    } else if (order.status === 'cooking') {
      actionButtonsHtml = `
        <button class="btn-stage btn-ready" onclick="app.updateStatus('${order.id}', 'ready')">
          🔔 Mark Ready
        </button>
        <button class="btn-stage btn-serve" onclick="app.updateStatus('${order.id}', 'served')">
          🍽️ Mark Served
        </button>
      `;
    } else if (order.status === 'ready') {
      actionButtonsHtml = `
        <button class="btn-stage btn-serve" onclick="app.updateStatus('${order.id}', 'served')">
          🍽️ Mark Served
        </button>
      `;
    } else if (order.status === 'served') {
      actionButtonsHtml = `
        <button class="btn-stage btn-complete" onclick="app.updateStatus('${order.id}', 'completed')">
          💵 Mark Paid & Free Table
        </button>
      `;
    }

    // Print Receipt button
    actionButtonsHtml += `
      <button class="btn-stage btn-print" onclick="app.showReceiptModal('${order.id}')" title="Print Customer Bill">
        🧾 Bill
      </button>
    `;

    card.innerHTML = `
      ${cancelAlertHtml}
      <div class="order-card-header">
        <div class="table-badge-large highlight-table">
          <div class="table-number-pill">Table ${order.tableNo}</div>
          <div class="order-meta-info">
            <span class="order-id-label">#${order.id}</span>
            <span class="order-guest-name">${escapeHtml(order.customerName || 'Guest')}${order.channel === 'web' ? '<span class="channel-badge web">🌐 Web QR</span>' : '<span class="channel-badge whatsapp">WhatsApp</span>'}</span>
          </div>
        </div>
        <div class="order-timing-status">
          <span class="status-badge ${order.status}">${statusLabels[order.status] || order.status}</span>
          <span class="timer-elapsed ${timerClass}" id="timer-${order.id}" data-time="${order.createdAt}">
            ⏱️ ${timeFormatted}
          </span>
        </div>
      </div>

      <div class="order-items-container">
        <ul class="order-items-list">
          ${itemsHtml}
        </ul>
        ${notesHtml}
      </div>

      <div class="order-card-footer">
        <div class="order-total-preview">
          <span>Grand Total</span>
          <span>₹${order.total}</span>
        </div>
        <div class="order-actions-group">
          ${actionButtonsHtml}
        </div>
      </div>
    `;

    // Item checklist event
    card.querySelectorAll('.item-check-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const row = e.target.closest('.order-item-row');
        if (row) row.classList.toggle('item-done', e.target.checked);
      });
    });

    return card;
  }

  async updateStatus(orderId, newStatus) {
    let reason = '';
    if (newStatus === 'cancelled') {
      reason = prompt('Enter cancellation reason (e.g. Out of stock, customer requested):', 'Kitchen cancelled');
      if (reason === null) return; // user hit cancel
    }

    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, reason })
      });
      const data = await res.json();
      if (data.success) {
        const idx = this.orders.findIndex(o => o.id === orderId);
        if (idx !== -1) {
          this.orders[idx] = data.order;
          this.renderOrders();
          this.updateCounts();
        }
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  startLiveTimers() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      document.querySelectorAll('.timer-elapsed').forEach(elem => {
        const iso = elem.getAttribute('data-time');
        if (!iso) return;
        const created = new Date(iso).getTime();
        const diff = Math.max(0, Math.floor((Date.now() - created) / 1000));
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        elem.innerHTML = `⏱️ ${m}m ${s < 10 ? '0' : ''}${s}s`;

        elem.className = 'timer-elapsed';
        if (m >= 15) elem.classList.add('timer-red');
        else if (m >= 8) elem.classList.add('timer-yellow');
        else elem.classList.add('timer-green');
      });
    }, 1000);
  }

  // --- Menu Management ---
  async loadMenu() {
    const grid = document.getElementById('menuItemsGrid');
    if (!grid) return;

    try {
      const res = await fetch('/api/menu');
      const data = await res.json();
      if (data.success) {
        this.renderMenu(data.menu);
      }
    } catch (err) {
      console.error('Failed to load menu:', err);
    }
  }

  renderMenu(items) {
    const grid = document.getElementById('menuItemsGrid');
    if (!grid) return;
    grid.innerHTML = '';

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = `menu-card ${item.inStock ? '' : 'out-of-stock'}`;
      card.innerHTML = `
        <div class="menu-card-header">
          <div class="menu-card-title">
            <span class="veg-dot ${item.isVeg ? 'veg' : 'non-veg'}"></span>
            ${item.name}
            ${item.isSpicy ? '🌶️' : ''}
          </div>
          <span class="menu-card-price">₹${item.price}</span>
        </div>
        <div class="menu-card-desc">${item.description || 'Delicious freshly prepared dish.'}</div>
        <div class="menu-card-footer">
          <span style="font-size:0.78rem; color:#94a3b8;">${item.category}</span>
          <label class="stock-toggle-label">
            <span style="font-size:0.8rem; color:${item.inStock ? '#34d399' : '#f87171'}">
              ${item.inStock ? 'In Stock' : 'Sold Out'}
            </span>
            <div class="switch">
              <input type="checkbox" ${item.inStock ? 'checked' : ''} onchange="app.toggleStock('${item.id}', this.checked)">
              <span class="slider"></span>
            </div>
          </label>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  async toggleStock(itemId, inStock) {
    try {
      await fetch(`/api/menu/${itemId}/stock`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inStock })
      });
      this.loadMenu();
    } catch (err) {
      console.error('Failed to toggle stock:', err);
    }
  }

  async handleCreateDish(e) {
    e.preventDefault();
    const form = e.target;
    const body = {
      name: form.dishName.value,
      category: form.dishCategory.value,
      price: form.dishPrice.value,
      isVeg: form.dishIsVeg.checked,
      isSpicy: form.dishIsSpicy.checked,
      description: form.dishDesc.value
    };

    try {
      const res = await fetch('/api/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        form.reset();
        this.closeModal('modalAddDish');
        this.loadMenu();
      }
    } catch (err) {
      console.error('Failed to create dish:', err);
    }
  }

  // --- Analytics & Stats ---
  async loadAnalytics() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (data.success) {
        const stats = data.stats;
        document.getElementById('statTodayRevenue').textContent = `₹${stats.todayRevenue.toLocaleString()}`;
        document.getElementById('statTodayOrders').textContent = stats.todayCount;
        document.getElementById('statCompletedOrders').textContent = stats.completedCount;
        document.getElementById('statCancelledOrders').textContent = stats.cancelledCount;
        document.getElementById('statAvgPrep').textContent = `${stats.avgPrepMinutes}m`;

        this.renderHistoryTable();
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
    this.loadDailySummary();
  }

  async loadDailySummary() {
    const preview = document.getElementById('dailySummaryPreview');
    if (!preview) return;
    try {
      const res = await fetch('/api/reports/daily');
      const data = await res.json();
      if (!data.success) return;
      // WhatsApp-style *bold* rendered for the preview; text escaped first
      preview.innerHTML = escapeHtml(data.message).replace(/\*(.*?)\*/g, '<strong>$1</strong>');
      if (!this.summaryFormInit) {
        document.getElementById('ownerWhatsapp').value = data.schedule.ownerWhatsapp;
        document.getElementById('summaryTime').value = data.schedule.dailySummaryTime;
        document.getElementById('summaryEnabled').checked = data.schedule.dailySummaryEnabled;
        this.initDailySummaryForm();
      }
    } catch (err) {
      preview.textContent = 'Could not load the summary.';
    }
  }

  initDailySummaryForm() {
    this.summaryFormInit = true;
    const status = document.getElementById('dailySummaryStatus');
    document.getElementById('dailySummaryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/api/reports/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerWhatsapp: document.getElementById('ownerWhatsapp').value,
          dailySummaryTime: document.getElementById('summaryTime').value,
          dailySummaryEnabled: document.getElementById('summaryEnabled').checked
        })
      });
      const data = await res.json();
      status.textContent = data.success ? '✅ Schedule saved' : `⚠️ ${data.message}`;
    });
    document.getElementById('btnSendSummaryNow').addEventListener('click', async () => {
      status.textContent = 'Sending…';
      const res = await fetch('/api/reports/daily/send', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.success ? `✅ Sent to ${data.sentTo}` : `⚠️ ${data.message}`;
    });
  }

  renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    this.orders.forEach(order => {
      const tr = document.createElement('tr');
      const itemsSummary = (order.items || []).map(i => `${i.quantity}x ${i.name}`).join(', ');
      const timeStr = new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      tr.innerHTML = `
        <td><strong>#${order.id}</strong></td>
        <td><span class="table-number-pill" style="font-size:0.85rem; padding: 2px 8px;">T-${order.tableNo}</span></td>
        <td>${itemsSummary}</td>
        <td><strong>₹${order.total}</strong></td>
        <td><span class="status-badge ${order.status}">${order.status}</span></td>
        <td>${timeStr}</td>
        <td>
          <button class="btn-qr-action" style="padding: 4px 8px; font-size: 0.75rem;" onclick="app.showReceiptModal('${order.id}')">
            🧾 Receipt
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // --- Receipt Modal ---
  showReceiptModal(orderId) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) return;

    const receiptBody = document.getElementById('receiptModalContent');
    const itemsRows = (order.items || []).map(i => `
      <div style="display:flex; justify-content:space-between; margin-bottom: 6px;">
        <span>${i.quantity}x ${i.name}</span>
        <span>₹${i.price * i.quantity}</span>
      </div>
    `).join('');

    receiptBody.innerHTML = `
      <div style="text-align:center; margin-bottom: 16px;">
        <h3 style="font-size: 1.25rem;">👑 ROYAL SPICE BISTRO</h3>
        <p style="font-size: 0.8rem; color: #94a3b8;">Order #${order.id} • Table ${order.tableNo}</p>
        <p style="font-size: 0.75rem; color: #64748b;">${new Date(order.createdAt).toLocaleString()}</p>
      </div>
      <hr style="border:0; border-top: 1px dashed #475569; margin: 12px 0;">
      <div style="font-size: 0.9rem;">
        ${itemsRows}
      </div>
      <hr style="border:0; border-top: 1px dashed #475569; margin: 12px 0;">
      <div style="display:flex; justify-content:space-between; font-size: 0.85rem; margin-bottom: 4px;">
        <span>Subtotal</span>
        <span>₹${order.subtotal}</span>
      </div>
      <div style="display:flex; justify-content:space-between; font-size: 0.85rem; margin-bottom: 8px;">
        <span>GST (5%)</span>
        <span>₹${order.tax}</span>
      </div>
      <div style="display:flex; justify-content:space-between; font-size: 1.1rem; font-weight: 800; color: #f59e0b;">
        <span>Total Paid</span>
        <span>₹${order.total}</span>
      </div>
      <hr style="border:0; border-top: 1px dashed #475569; margin: 14px 0;">
      <p style="text-align:center; font-size: 0.78rem; color: #94a3b8;">Thank you for dining with us! 🙏</p>
    `;

    this.openModal('modalReceipt');
  }

  openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('active');
  }

  closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
  }
}

// Bootstrap once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new RestaurantApp();
  window.simulator = new window.WhatsAppSimulator();
  window.qrStudio = new window.QRStudio();
});
