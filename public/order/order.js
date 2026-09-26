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

  // Small localStorage helpers (private mode / blocked storage just means no memory)
  function keyStore(key) {
    return {
      get() { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
      set(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* unavailable */ } },
      clear() { try { localStorage.removeItem(key); } catch { /* unavailable */ } }
    };
  }
  const store = keyStore(`order-track-table-${tableNo}`);       // last order to track
  const tableTokenStore = keyStore(`table-token-${tableNo}`);   // proof this phone holds the table
  const cartStore = keyStore(`order-cart-table-${tableNo}`);    // cart survives a refresh

  // Invite link from the person holding the table: ?table=3&join=<token>
  const joinToken = params.get('join');
  if (tableNo && joinToken && /^[a-f0-9]{16,64}$/.test(joinToken)) {
    tableTokenStore.set(joinToken);
    params.delete('join');
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
  }

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
    if (!res.ok || !data.success) {
      const error = new Error(data.message || 'Something went wrong');
      error.code = data.code;
      error.status = res.status;
      throw error;
    }
    return data;
  }

  // ---------- Menu ----------

  // Dishes shown right now (Veg only filter)
  function visibleMenu() {
    return state.vegOnly ? state.menu.filter(m => m.isVeg) : state.menu;
  }

  function categories() {
    return [...new Set(visibleMenu().map(m => m.category))];
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
        ${visibleMenu().filter(m => m.category === cat).map(item => `
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
    cartStore.set([...state.cart.entries()]);
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
      if (data.skipped && data.skipped.length) parts.push(`Skipped (sounds like you don't want it): ${data.skipped.map(u => `“${escapeHtml(u)}”`).join(', ')}.`);
      if (data.capped && data.capped.length) parts.push(`Max 20 per dish online: ${data.capped.map(escapeHtml).join(', ')}. Ask a waiter for bigger orders.`);
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
          notes: $('orderNotes').value,
          tableToken: tableTokenStore.get() || ''
        }
      });
      if (data.soldOut && data.soldOut.length) toast(`Sold out and removed: ${data.soldOut.join(', ')}`);
      state.cart.clear();
      cartStore.clear();
      $('orderNotes').value = '';
      closeSheet();
      if (data.tableToken) tableTokenStore.set(data.tableToken);
      store.set({ id: data.order.id, token: data.trackToken });
      showTracking(data.order);
    } catch (err) {
      if (err.code === 'TABLE_OCCUPIED') {
        closeSheet();
        showTableNotice('taken');
      }
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
    state.lastStatus = order.status;
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
    // Kitchen couldn't make some dishes (e.g. out of stock)
    const removed = order.removedItems || [];
    $('trackRemoved').hidden = removed.length === 0;
    $('trackRemoved').innerHTML = removed.length
      ? `😔 Sorry, removed by the kitchen: ${removed.map(i => `${i.quantity}× ${escapeHtml(i.name)} (${escapeHtml(i.reason || 'unavailable')})`).join(', ')}. You won't be charged for ${removed.length > 1 ? 'these' : 'it'}.`
      : '';

    const minutes = state.info.allowCancellationMinutes || 5;
    const ageMin = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
    $('cancelBtn').hidden = !(order.status === 'pending' && ageMin <= minutes);
  }

  function showTracking(order) {
    $('menuView').hidden = true;
    $('trackView').hidden = false;
    $('cartBar').hidden = true;
    renderTracking(order);
    $('inviteCard').hidden = !tableTokenStore.get();
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
    updateMyOrderBar();
  }

  const STATUS_WORDS = { pending: 'sent to kitchen', cooking: 'is cooking', ready: 'is ready', served: 'served' };
  function updateMyOrderBar(order) {
    const saved = store.get();
    const status = order ? order.status : state.lastStatus;
    const show = Boolean(saved) && status && !['completed', 'cancelled'].includes(status);
    $('myOrderBar').hidden = !show;
    if (show) $('myOrderStatus').textContent = STATUS_WORDS[status] || status;
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

  // ---------- Table ownership ----------

  function showTableNotice(kind, message) {
    const notice = $('tableNotice');
    notice.hidden = false;
    notice.classList.toggle('error', kind === 'invalid');
    if (kind === 'taken') {
      $('tableNoticeTitle').textContent = `Table ${tableNo} is already taken`;
      $('tableNoticeText').textContent = 'Another guest is ordering for this table. If you are sitting together, ask them for their "Share table link", or call a waiter.';
      document.body.classList.add('ordering-locked');
      $('cartBar').hidden = true;
    } else {
      $('tableNoticeTitle').textContent = 'Table not found';
      $('tableNoticeText').textContent = message || 'Please scan the QR code on your table again.';
      document.body.classList.add('ordering-locked');
      $('menuServiceRow').hidden = true;
    }
  }

  async function shareTableLink() {
    const token = tableTokenStore.get();
    if (!token) return;
    const link = `${location.origin}/order/?table=${tableNo}&join=${token}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: `Order at Table ${tableNo}`, text: `Join our table order (Table ${tableNo})`, url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      toast('Link copied. Send it to your friends at the table.');
    } catch {
      // Share sheet closed or clipboard blocked: show the link to copy by hand
      const box = $('inviteLink');
      box.hidden = false;
      box.value = link;
      box.select();
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
      $('menuServiceRow').hidden = true;
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
      // Restore a cart from before a refresh (only items still on the menu and in stock)
      (cartStore.get() || []).forEach(([id, qty]) => {
        const item = state.menu.find(m => m.id === id);
        if (item && item.inStock && qty > 0) state.cart.set(id, Math.min(qty, 20));
      });
      renderTabs();
      renderMenu();
      renderCartBar();
    } catch (err) {
      $('menuList').innerHTML = `<p class="empty">Couldn’t load the menu. Please refresh.</p>`;
      return;
    }

    // Is this a real table, and is it free (or already ours)?
    try {
      const check = await api(`/tables/${tableNo}?token=${encodeURIComponent(tableTokenStore.get() || '')}`);
      if (!check.available) showTableNotice('taken');
      $('inviteCard').hidden = !check.yours;
    } catch (err) {
      if (err.status === 404) { showTableNotice('invalid', err.message); return; }
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
  $('inviteBtn').addEventListener('click', shareTableLink);
  $('myOrderBar').addEventListener('click', async () => {
    const saved = store.get();
    if (!saved) return;
    try {
      const data = await api(`/orders/${encodeURIComponent(saved.id)}?token=${encodeURIComponent(saved.token)}`);
      showTracking(data.order);
    } catch (err) { toast(err.message); }
  });
  $('vegOnly').addEventListener('change', (e) => {
    state.vegOnly = e.target.checked;
    renderTabs();
    renderMenu();
  });
  document.querySelectorAll('[data-waiter]').forEach(b => b.addEventListener('click', () => callWaiter(b.dataset.waiter)));

  init();
})();
