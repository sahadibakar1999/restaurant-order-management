// Guest QR ordering page: browse menu or type an order, place it, track it live.
(function () {
  const params = new URLSearchParams(location.search);
  const tableNo = parseInt(params.get('table'), 10) || null;
  const $ = (id) => document.getElementById(id);

  const state = {
    info: null,
    menu: [],
    cart: new Map(), // itemId -> quantity
    activeCategory: null,
    trackTimer: null
  };

  const storageKey = `order-track-table-${tableNo}`;
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(storageKey); } catch { /* private mode */ } }
  };

  const money = (n) => `${state.info ? state.info.currency : '₹'}${Number(n).toLocaleString('en-IN')}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function api(path, options = {}) {
    const res = await fetch(`/public-api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({ success: false, message: 'Network error' }));
    if (!res.ok || !data.success) throw new Error(data.message || 'Something went wrong');
    return data;
  }

  // ---------- Menu ----------

  function categories() {
    return [...new Set(state.menu.map(m => m.category))];
  }

  function renderTabs() {
    const tabs = $('catTabs');
    tabs.innerHTML = categories().map(c =>
      `<button type="button" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
    tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const section = document.querySelector(`[data-section="${CSS.escape(b.dataset.cat)}"]`);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function dishAction(item) {
    if (!item.inStock) return `<span class="muted small">Sold out</span>`;
    const qty = state.cart.get(item.id) || 0;
    if (qty === 0) return `<button class="add-btn" data-add="${item.id}">ADD</button>`;
    return `<div class="stepper"><button data-dec="${item.id}" aria-label="Remove one">−</button><span>${qty}</span><button data-inc="${item.id}" aria-label="Add one">+</button></div>`;
  }

  function renderMenu() {
    const list = $('menuList');
    list.innerHTML = categories().map(cat => `
      <section data-section="${escapeHtml(cat)}">
        <h3>${escapeHtml(cat)}</h3>
        ${state.menu.filter(m => m.category === cat).map(item => `
          <article class="dish ${item.inStock ? '' : 'soldout'}">
            <div>
              <div class="dish-name"><span class="diet ${item.isVeg ? 'veg' : 'nonveg'}" title="${item.isVeg ? 'Veg' : 'Non-veg'}"></span>${escapeHtml(item.name)}${item.popular ? ' <span class="badge">Popular</span>' : ''}${item.isSpicy ? ' 🌶️' : ''}</div>
              ${item.description ? `<p class="dish-desc">${escapeHtml(item.description)}</p>` : ''}
              <p class="dish-price">${money(item.price)}</p>
            </div>
            <div class="dish-action" data-action-for="${item.id}">${dishAction(item)}</div>
          </article>`).join('')}
      </section>`).join('');
  }

  function refreshItem(id) {
    const slot = document.querySelector(`[data-action-for="${CSS.escape(id)}"]`);
    const item = state.menu.find(m => m.id === id);
    if (slot && item) slot.innerHTML = dishAction(item);
  }

  function setQty(id, qty) {
    const item = state.menu.find(m => m.id === id);
    if (!item || !item.inStock) return;
    qty = Math.max(0, Math.min(qty, 20));
    if (qty === 0) state.cart.delete(id); else state.cart.set(id, qty);
    refreshItem(id);
    renderCartBar();
    if (!$('sheet').hidden) renderSheet();
  }

  function onMenuClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.add) setQty(t.dataset.add, 1);
    if (t.dataset.inc) setQty(t.dataset.inc, (state.cart.get(t.dataset.inc) || 0) + 1);
    if (t.dataset.dec) setQty(t.dataset.dec, (state.cart.get(t.dataset.dec) || 0) - 1);
  }

  // ---------- Cart ----------

  function cartTotals() {
    let count = 0, subtotal = 0;
    for (const [id, qty] of state.cart) {
      const item = state.menu.find(m => m.id === id);
      if (!item) continue;
      count += qty;
      subtotal += item.price * qty;
    }
    const tax = Math.round(subtotal * (state.info.taxPercent || 5) / 100);
    return { count, subtotal, tax, total: subtotal + tax };
  }

  function renderCartBar() {
    const { count, subtotal } = cartTotals();
    $('cartBar').hidden = count === 0 || !$('menuView').offsetParent;
    $('cartCount').textContent = `${count} item${count === 1 ? '' : 's'}`;
    $('cartTotal').textContent = `${money(subtotal)} + tax`;
  }

  function renderSheet() {
    const lines = $('cartLines');
    const entries = [...state.cart.entries()];
    if (entries.length === 0) {
      lines.innerHTML = `<li class="empty">Your cart is empty.</li>`;
    } else {
      lines.innerHTML = entries.map(([id, qty]) => {
        const item = state.menu.find(m => m.id === id);
        return `<li>
          <div><div class="line-name">${escapeHtml(item.name)}</div><div class="line-price">${money(item.price)} × ${qty} = ${money(item.price * qty)}</div></div>
          <div class="stepper"><button data-dec="${id}" aria-label="Remove one">−</button><span>${qty}</span><button data-inc="${id}" aria-label="Add one">+</button></div>
        </li>`;
      }).join('');
    }
    const t = cartTotals();
    $('billSubtotal').textContent = money(t.subtotal);
    $('taxLabel').textContent = `Tax (${state.info.taxPercent || 5}%)`;
    $('billTax').textContent = money(t.tax);
    $('billTotal').textContent = money(t.total);
    $('placeOrderBtn').disabled = t.count === 0;
  }

  function openSheet() { renderSheet(); $('sheet').hidden = false; }
  function closeSheet() { $('sheet').hidden = true; }

  // ---------- AI quick order ----------

  async function aiOrder() {
    const input = $('aiInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const btn = $('aiBtn');
    btn.disabled = true;
    btn.textContent = '…';
    const out = $('aiResult');
    try {
      const data = await api('/parse', { method: 'POST', body: { text } });
      const added = [];
      data.items.forEach(i => {
        if (!i.inStock) return;
        setQty(i.itemId, (state.cart.get(i.itemId) || 0) + i.quantity);
        added.push(`${i.quantity}× ${i.name}${i.note ? ` (${i.note})` : ''}`);
      });
      const notes = [data.note, ...data.items.filter(i => i.note).map(i => `${i.name}: ${i.note}`)].filter(Boolean);
      if (notes.length) {
        const existing = $('orderNotes').value.trim();
        $('orderNotes').value = [existing, ...notes].filter(Boolean).join('; ').slice(0, 200);
      }
      const parts = [];
      if (added.length) parts.push(`Added <strong>${added.map(escapeHtml).join(', ')}</strong>.`);
      if (data.ambiguous.length) parts.push(`Which one for “${escapeHtml(data.ambiguous[0].text)}”? ${data.ambiguous[0].options.map(escapeHtml).join(' / ')}`);
      if (data.unmatched.length) parts.push(`Not on the menu: ${data.unmatched.map(u => `“${escapeHtml(u)}”`).join(', ')}.`);
      if (!parts.length) parts.push('Sorry, I couldn’t find those dishes. Try the menu below.');
      out.innerHTML = parts.join(' ');
      out.hidden = false;
      if (added.length) input.value = '';
    } catch (err) {
      out.textContent = err.message;
      out.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  }

  // ---------- Place + track ----------

  async function placeOrder() {
    const btn = $('placeOrderBtn');
    btn.disabled = true;
    btn.textContent = 'Placing order…';
    try {
      const data = await api('/orders', {
        method: 'POST',
        body: {
          tableNo,
          items: [...state.cart.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
          name: $('guestName').value,
          notes: $('orderNotes').value
        }
      });
      if (data.soldOut && data.soldOut.length) toast(`Sold out and removed: ${data.soldOut.join(', ')}`);
      state.cart.clear();
      $('orderNotes').value = '';
      closeSheet();
      store.set({ id: data.order.id, token: data.trackToken });
      showTracking(data.order);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  }

  const HEADLINES = {
    pending: 'Sent to the kitchen',
    cooking: 'Your food is being cooked 🔥',
    ready: 'Ready! Coming to your table 🔔',
    served: 'Enjoy your meal 🍽️',
    completed: 'Thank you for dining with us 🙏',
    cancelled: 'This order was cancelled'
  };
  const STEPS = ['pending', 'cooking', 'ready', 'served'];

  function renderTracking(order) {
    $('trackId').textContent = `#${order.id}`;
    $('trackHeadline').textContent = HEADLINES[order.status] || order.status;
    const idx = order.status === 'completed' ? STEPS.length : STEPS.indexOf(order.status);
    document.querySelectorAll('#timeline li').forEach((li, i) => {
      li.classList.toggle('done', order.status !== 'cancelled' && i <= idx);
      li.classList.toggle('current', order.status !== 'cancelled' && i === idx && idx < STEPS.length - 1);
    });
    $('trackItems').innerHTML = order.items.map(i =>
      `<li><span>${i.quantity}× ${escapeHtml(i.name)}</span><span>${money(i.price * i.quantity)}</span></li>`).join('');
    $('trackTotal').textContent = money(order.total);

    const minutes = state.info.allowCancellationMinutes || 5;
    const ageMin = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
    $('cancelBtn').hidden = !(order.status === 'pending' && ageMin <= minutes);
  }

  function showTracking(order) {
    $('menuView').hidden = true;
    $('trackView').hidden = false;
    $('cartBar').hidden = true;
    renderTracking(order);
    clearInterval(state.trackTimer);
    state.trackTimer = setInterval(pollTracking, 5000);
    window.scrollTo({ top: 0 });
  }

  async function pollTracking() {
    const saved = store.get();
    if (!saved) return;
    try {
      const data = await api(`/orders/${encodeURIComponent(saved.id)}?token=${encodeURIComponent(saved.token)}`);
      renderTracking(data.order);
      if (['completed', 'cancelled'].includes(data.order.status)) clearInterval(state.trackTimer);
    } catch {
      /* keep last known state; try again next tick */
    }
  }

  function showMenu() {
    clearInterval(state.trackTimer);
    $('trackView').hidden = true;
    $('menuView').hidden = false;
    renderMenu();
    renderCartBar();
  }

  async function cancelOrder() {
    const saved = store.get();
    if (!saved) return;
    const btn = $('cancelBtn');
    if (btn.dataset.confirm !== 'yes') {
      btn.dataset.confirm = 'yes';
      btn.textContent = 'Tap again to cancel';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Cancel order'; }, 4000);
      return;
    }
    try {
      const data = await api(`/orders/${encodeURIComponent(saved.id)}/cancel`, { method: 'POST', body: { token: saved.token } });
      renderTracking(data.order);
      toast('Order cancelled');
    } catch (err) {
      toast(err.message);
    }
  }

  async function callWaiter(type) {
    try {
      const data = await api('/waiter', { method: 'POST', body: { tableNo, type } });
      toast(`${data.serviceType}: staff notified 👍`);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- Init ----------

  async function init() {
    if (!tableNo) {
      $('restaurantName').textContent = 'Scan the QR on your table';
      $('menuList').innerHTML = `<p class="empty">This link is missing a table number. Please scan the QR code on your table.</p>`;
      document.querySelector('.ai-box').hidden = true;
      return;
    }
    $('tableChip').textContent = `Table ${tableNo}`;

    try {
      const [info, menu] = await Promise.all([api('/info'), api('/menu')]);
      state.info = info;
      state.menu = menu.menu;
      document.title = `${info.restaurantName} · Table ${tableNo}`;
      $('restaurantName').textContent = info.restaurantName;
      $('tagline').textContent = info.tagline || '';
      renderTabs();
      renderMenu();
      renderCartBar();
    } catch (err) {
      $('menuList').innerHTML = `<p class="empty">Couldn’t load the menu. Please refresh.</p>`;
      return;
    }

    const saved = store.get();
    if (saved) {
      try {
        const data = await api(`/orders/${encodeURIComponent(saved.id)}?token=${encodeURIComponent(saved.token)}`);
        if (!['completed', 'cancelled'].includes(data.order.status)) showTracking(data.order);
        else store.clear();
      } catch { store.clear(); }
    }
  }

  $('menuList').addEventListener('click', onMenuClick);
  $('cartLines').addEventListener('click', onMenuClick);
  $('checkoutBtn').addEventListener('click', openSheet);
  $('closeSheet').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('placeOrderBtn').addEventListener('click', placeOrder);
  $('aiBtn').addEventListener('click', aiOrder);
  $('aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') aiOrder(); });
  $('cancelBtn').addEventListener('click', cancelOrder);
  $('orderMoreBtn').addEventListener('click', showMenu);
  document.querySelectorAll('[data-waiter]').forEach(b => b.addEventListener('click', () => callWaiter(b.dataset.waiter)));

  init();
})();
