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
        <div class="qr-preview-box" id="qrContainer-${table.number}">
          <span style="font-size: 0.8rem; color: #64748b;">Loading QR...</span>
        </div>
        <div class="table-card-actions">
          <button class="btn-qr-action btn-sim-test" data-table="${table.number}">
            📱 Test Simulator
          </button>
          <button class="btn-qr-action btn-print-single" data-table="${table.number}">
            🖨️ Print Card
          </button>
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
      if (data.success && data.qrDataUrl) {
        const box = document.getElementById(`qrContainer-${tableNumber}`);
        if (box) {
          box.innerHTML = `<img src="${data.qrDataUrl}" alt="QR Code Table ${tableNumber}" title="Scan to order via WhatsApp">`;
        }
      }
    } catch (err) {
      console.error(`Failed to fetch QR for table ${tableNumber}:`, err);
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
        <p style="font-size: 13px; color: #78350f; margin-bottom: 16px;">Scan to View Menu & Order on WhatsApp</p>
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
          if (d.success && d.qrDataUrl) {
            const img = document.getElementById(`printImg-${table.number}`);
            if (img) img.src = d.qrDataUrl;
          }
        });
    });
  }
}

window.QRStudio = QRStudio;
