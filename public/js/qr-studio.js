// Table Management & QR Code Studio

class QRStudio {
  constructor() {
    this.tablesGrid = document.getElementById('tablesLayoutGrid');
    this.printContainer = document.getElementById('tentCardPrintView');
    this.printAllBtn = document.getElementById('btnPrintAllQRs');
    this.tables = [];

    this.init();
  }

  async init() {
    if (!this.tablesGrid) return;

    if (this.printAllBtn) {
      this.printAllBtn.addEventListener('click', () => {
        window.print();
      });
    }

    await this.loadTables();
  }

  async loadTables() {
    try {
      const res = await fetch('/api/tables');
      const data = await res.json();
      if (data.success) {
        this.tables = data.tables;
        this.renderTables();
        this.renderPrintTentCards();
      }
    } catch (err) {
      console.error('Failed to load tables:', err);
    }
  }

  async renderTables() {
    this.tablesGrid.innerHTML = '';

    for (const table of this.tables) {
      const card = document.createElement('div');
      card.className = 'table-studio-card';

      let statusClass = 'status-vacant';
      let statusLabel = 'Vacant';
      if (table.activeOrder) {
        if (table.activeOrder.status === 'cooking') {
          statusClass = 'status-cooking-tab';
          statusLabel = 'Cooking 🔥';
        } else if (table.activeOrder.status === 'ready') {
          statusClass = 'status-occupied';
          statusLabel = 'Ready 🔔';
        } else {
          statusClass = 'status-occupied';
          statusLabel = 'Seated 🍽️';
        }
      }

      card.innerHTML = `
        <span class="table-status-pill ${statusClass}">${statusLabel}</span>
        <div class="table-big-number">Table ${table.number}</div>
        <div class="table-seats-caption">Capacity: ${table.capacity} Persons</div>
        <div class="table-occupant">${table.occupiedBy
          ? `🔒 In use by a ${table.occupiedBy.type === 'web' ? 'web QR' : 'WhatsApp'} guest since ${new Date(table.occupiedBy.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : '🟢 Free for the next guests'}</div>
        <div class="qr-mode-toggle" role="tablist" aria-label="QR type">
          <button class="qr-mode-btn active" data-mode="web" data-table="${table.number}">🌐 Web order</button>
          <button class="qr-mode-btn" data-mode="wa" data-table="${table.number}">💬 WhatsApp</button>
        </div>
        <div class="qr-preview-box" id="qrContainer-${table.number}">
          <span style="font-size: 0.8rem; color: #64748b;">Loading QR...</span>
        </div>
        <a class="qr-open-link" id="qrLink-${table.number}" href="#" target="_blank" rel="noopener">Open guest page ↗</a>
        <div class="table-card-actions">
          <button class="btn-qr-action btn-sim-test" data-table="${table.number}">
            📱 Test Simulator
          </button>
          <button class="btn-qr-action btn-print-single" data-table="${table.number}">
            🖨️ Print Card
          </button>
          ${table.occupiedBy ? `<button class="btn-qr-action btn-free-table" data-table="${table.number}">🔓 Free table</button>` : ''}
        </div>
      `;

      this.tablesGrid.appendChild(card);

      // Fetch and embed the QR
      this.fetchAndEmbedQR(table.number);
    }

    // Attach click events
    this.tablesGrid.querySelectorAll('.btn-sim-test').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tableNum = e.target.getAttribute('data-table');
        if (window.app) {
          window.app.switchTab('simulator');
        }
        if (window.simulator) {
          window.simulator.tableSelect.value = tableNum;
          window.simulator.tableNo = parseInt(tableNum, 10);
          window.simulator.sendUserMessage(`Hi Table ${tableNum}`);
        }
      });
    });

    this.tablesGrid.querySelectorAll('.qr-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tableNum = btn.getAttribute('data-table');
        btn.parentElement.querySelectorAll('.qr-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        this.showQR(tableNum, btn.getAttribute('data-mode'));
      });
    });

    this.tablesGrid.querySelectorAll('.btn-free-table').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tableNum = btn.getAttribute('data-table');
        // Two-step confirm without a blocking dialog
        if (btn.dataset.confirm !== 'yes') {
          btn.dataset.confirm = 'yes';
          btn.textContent = 'Tap again to free';
          setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = '🔓 Free table'; }, 4000);
          return;
        }
        await fetch(`/api/tables/${tableNum}/free`, { method: 'POST' });
        this.loadTables();
      });
    });

    this.tablesGrid.querySelectorAll('.btn-print-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
        window.print();
      });
    });
  }

  async fetchAndEmbedQR(tableNumber) {
    try {
      const res = await fetch(`/api/tables/${tableNumber}/qr`);
      const data = await res.json();
      if (data.success) {
        this.qrCache = this.qrCache || {};
        this.qrCache[tableNumber] = data;
        this.showQR(tableNumber, 'web');
      }
    } catch (err) {
      console.error(`Failed to fetch QR for table ${tableNumber}:`, err);
    }
  }

  showQR(tableNumber, mode) {
    const data = (this.qrCache || {})[tableNumber];
    const box = document.getElementById(`qrContainer-${tableNumber}`);
    const link = document.getElementById(`qrLink-${tableNumber}`);
    if (!data || !box) return;
    const isWeb = mode === 'web';
    const src = isWeb ? data.webQrDataUrl : data.qrDataUrl;
    const title = isWeb ? 'Scan to order from the browser (no app needed)' : 'Scan to order via WhatsApp';
    box.innerHTML = `<img src="${src}" alt="QR Code Table ${tableNumber}" title="${title}">`;
    if (link) {
      link.href = isWeb ? data.webLink : data.waLink;
      link.textContent = isWeb ? 'Open guest page ↗' : 'Open WhatsApp link ↗';
    }
  }

  renderPrintTentCards() {
    if (!this.printContainer) return;
    this.printContainer.innerHTML = '';

    this.tables.forEach(table => {
      const tentCard = document.createElement('div');
      tentCard.className = 'tent-card-item';
      tentCard.innerHTML = `
        <h2 style="font-size: 24px; margin-bottom: 4px; color: #92400e;">👑 ROYAL SPICE BISTRO</h2>
        <p style="font-size: 13px; color: #78350f; margin-bottom: 16px;">Scan to view the menu &amp; order (no app needed)</p>
        <div style="font-size: 32px; font-weight: 900; margin-bottom: 12px; color: #1e293b;">TABLE ${table.number}</div>
        <div style="width: 200px; height: 200px; margin: 0 auto 16px auto; background: #fff; padding: 10px; border: 1px solid #e2e8f0; border-radius: 12px;" id="printQr-${table.number}">
          <img src="" style="width:100%; height:100%;" id="printImg-${table.number}">
        </div>
        <div style="font-size: 14px; font-weight: 600; color: #059669; margin-bottom: 8px;">
          ⚡ Instant Ordering • No Waiting For Waiter
        </div>
        <div style="font-size: 12px; color: #64748b;">
          📶 Guest Wi-Fi: <strong>RoyalSpice_Guest</strong> | Key: <strong>tastyfood123</strong>
        </div>
      `;
      this.printContainer.appendChild(tentCard);

      // Async load QR image into tent card
      fetch(`/api/tables/${table.number}/qr`)
        .then(r => r.json())
        .then(d => {
          if (d.success && d.webQrDataUrl) {
            const img = document.getElementById(`printImg-${table.number}`);
            if (img) img.src = d.webQrDataUrl;
          }
        });
    });
  }
}

window.QRStudio = QRStudio;
