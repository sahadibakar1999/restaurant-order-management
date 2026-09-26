const storage = require('./storage');

class WhatsAppService {
  constructor(io) {
    this.io = io;
  }

  setSocketIO(io) {
    this.io = io;
  }

  /**
   * Send WhatsApp message - either via official Meta Cloud API or via internal Simulator
   */
  // Collects bot replies for one simulator request (used when live sockets are unavailable)
  async captureReplies(userId, fn) {
    this.captures = this.captures || new Map();
    const bucket = [];
    this.captures.set(userId, bucket);
    try {
      await fn();
    } finally {
      this.captures.delete(userId);
    }
    return bucket;
  }

  async sendMessage(to, messagePayload) {
    if (this.captures && this.captures.has(to)) {
      this.captures.get(to).push({ to, message: messagePayload, timestamp: new Date().toISOString() });
    }
    const settings = storage.getSettings();
    const metaConfig = settings.metaConfig || {};
    const token = metaConfig.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = metaConfig.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Broadcast to simulator UI so real-time chat in the browser sees bot responses
    if (this.io) {
      this.io.emit('bot_message', {
        to,
        message: messagePayload,
        timestamp: new Date().toISOString()
      });
    }

    // If Meta Cloud API credentials are set and 'to' looks like an international phone number (digits only, length >= 10)
    const cleanTo = String(to).replace(/\D/g, '');
    if (token && phoneId && cleanTo.length >= 10) {
      try {
        const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
        
        let body;
        if (typeof messagePayload === 'string') {
          body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'text',
            text: { body: messagePayload }
          };
        } else if (messagePayload.type === 'interactive') {
          body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'interactive',
            interactive: messagePayload.interactive
          };
        } else {
          body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'text',
            text: { body: messagePayload.text || JSON.stringify(messagePayload) }
          };
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        if (!res.ok) {
          console.warn('Meta WhatsApp API response error:', data);
        } else {
          console.log('WhatsApp message sent successfully via Cloud API:', data);
        }
      } catch (err) {
        console.error('Failed to dispatch to Meta WhatsApp Cloud API:', err.message);
      }
    }

    return { success: true };
  }

  /**
   * Helper to build interactive buttons for WhatsApp
   */
  buildButtons(bodyText, buttons) {
    // buttons: array of { id, title } (max 3 buttons in WhatsApp interactive button message)
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: {
              id: btn.id,
              title: btn.title.slice(0, 20) // WhatsApp limit is 20 chars
            }
          }))
        }
      }
    };
  }

  /**
   * Helper to build interactive list for WhatsApp
   */
  buildList(bodyText, buttonLabel, title, rows) {
    return {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [
            {
              title: title.slice(0, 24),
              rows: rows.slice(0, 10).map(r => ({
                id: r.id,
                title: r.title.slice(0, 24),
                description: (r.description || '').slice(0, 72)
              }))
            }
          ]
        }
      }
    };
  }
}

module.exports = new WhatsAppService();
