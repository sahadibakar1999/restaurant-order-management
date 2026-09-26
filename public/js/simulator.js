// WhatsApp Customer Experience Simulator

class WhatsAppSimulator {
  constructor() {
    this.phone = '+91 98765 12345';
    this.tableNo = 3;
    this.chatFeed = document.getElementById('waChatFeed');
    this.inputBox = document.getElementById('waInputBox');
    this.sendBtn = document.getElementById('waSendBtn');
    this.tableSelect = document.getElementById('simTableSelect');
    this.typingIndicator = document.getElementById('waTypingIndicator');

    this.init();
  }

  init() {
    if (!this.chatFeed || !this.inputBox) return;

    // Table select change
    if (this.tableSelect) {
      this.tableSelect.addEventListener('change', (e) => {
        this.tableNo = parseInt(e.target.value, 10);
        this.sendUserMessage(`Hi Table ${this.tableNo}`);
      });
    }

    // Input submit
    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.inputBox.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleSend();
    });

    // Quick chip buttons
    document.querySelectorAll('.chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-text');
        if (text) {
          const replaced = text.replace('{table}', this.tableNo);
          this.sendUserMessage(replaced);
        }
      });
    });

    // Auto-start with initial greeting for Table 3
    setTimeout(() => {
      if (this.chatFeed.children.length <= 2) {
        this.sendUserMessage(`Hi Table ${this.tableNo}`);
      }
    }, 600);
  }

  handleSend() {
    const text = this.inputBox.value.trim();
    if (!text) return;
    this.inputBox.value = '';
    this.sendUserMessage(text);
  }

  sendUserMessage(text) {
    // 1. Render outgoing bubble
    this.appendMessage({
      sender: 'user',
      text: text,
      time: this.formatCurrentTime()
    });

    // 2. Show typing indicator
    this.showTyping(true);

    // 3. Post to simulator API
    fetch('/api/simulator/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: this.phone,
        text: text,
        tableNo: this.tableNo,
        customerName: `Guest (Table ${this.tableNo})`
      })
    })
    .catch(err => {
      console.error('Failed to send simulator message:', err);
      this.showTyping(false);
    });
  }

  // Receive message dispatched from Bot via Socket.IO
  handleIncomingBotMessage(data) {
    this.showTyping(false);

    let textContent = '';
    let buttons = [];
    let listRows = [];

    const msg = data.message;
    if (typeof msg === 'string') {
      textContent = msg;
    } else if (msg.type === 'interactive') {
      const interactive = msg.interactive;
      textContent = interactive.body ? interactive.body.text : '';

      if (interactive.type === 'button' && interactive.action && interactive.action.buttons) {
        buttons = interactive.action.buttons.map(b => ({
          id: b.reply.id,
          title: b.reply.title
        }));
      } else if (interactive.type === 'list' && interactive.action && interactive.action.sections) {
        interactive.action.sections.forEach(sec => {
          if (sec.rows) {
            sec.rows.forEach(r => listRows.push({
              id: r.id,
              title: r.title,
              description: r.description
            }));
          }
        });
      }
    } else {
      textContent = msg.text || JSON.stringify(msg);
    }

    this.appendMessage({
      sender: 'bot',
      text: textContent,
      buttons,
      listRows,
      time: this.formatCurrentTime()
    });
  }

  showTyping(show) {
    if (!this.typingIndicator) return;
    if (show) {
      this.typingIndicator.classList.add('active');
    } else {
      this.typingIndicator.classList.remove('active');
    }
    this.scrollToBottom();
  }

  appendMessage({ sender, text, buttons = [], listRows = [], time }) {
    const bubbleGroup = document.createElement('div');
    bubbleGroup.className = `wa-bubble-group ${sender === 'user' ? 'outgoing' : 'incoming'}`;

    const bubble = document.createElement('div');
    bubble.className = 'wa-bubble';

    // Format bold (*text*), italic (_text_), etc.
    // Escape first: messages can contain text typed by real WhatsApp customers
    let formatted = String(text ?? '')
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
      .replace(/_(.*?)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');

    bubble.innerHTML = `<div>${formatted}</div>`;

    // Render interactive buttons if any
    if (buttons.length > 0) {
      const btnContainer = document.createElement('div');
      btnContainer.className = 'wa-interactive-buttons';
      buttons.forEach(btn => {
        const btnElem = document.createElement('button');
        btnElem.className = 'wa-reply-btn';
        btnElem.innerHTML = btn.title;
        btnElem.addEventListener('click', () => {
          this.sendUserMessage(btn.id);
        });
        btnContainer.appendChild(btnElem);
      });
      bubble.appendChild(btnContainer);
    }

    // Render list items if any
    if (listRows.length > 0) {
      const listContainer = document.createElement('div');
      listContainer.className = 'wa-interactive-buttons';
      listRows.forEach(row => {
        const rowElem = document.createElement('button');
        rowElem.className = 'wa-reply-btn';
        rowElem.innerHTML = `<span>${row.title}</span><br><small style="opacity:0.7">${row.description || ''}</small>`;
        rowElem.addEventListener('click', () => {
          this.sendUserMessage(row.id);
        });
        listContainer.appendChild(rowElem);
      });
      bubble.appendChild(listContainer);
    }

    // Timestamp
    const timeElem = document.createElement('div');
    timeElem.className = 'wa-time-stamp';
    timeElem.innerHTML = `${time} ${sender === 'user' ? '<span class="double-tick">✓✓</span>' : ''}`;
    bubble.appendChild(timeElem);

    bubbleGroup.appendChild(bubble);

    // Insert before typing indicator
    if (this.typingIndicator && this.typingIndicator.parentNode === this.chatFeed) {
      this.chatFeed.insertBefore(bubbleGroup, this.typingIndicator);
    } else {
      this.chatFeed.appendChild(bubbleGroup);
    }

    this.scrollToBottom();
  }

  scrollToBottom() {
    if (this.chatFeed) {
      this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
    }
  }

  formatCurrentTime() {
    const now = new Date();
    let hours = now.getHours();
    const mins = now.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${mins} ${ampm}`;
  }
}

window.WhatsAppSimulator = WhatsAppSimulator;
