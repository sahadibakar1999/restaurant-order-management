const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const botEngine = require('../services/botEngine');
const storage = require('../services/storage');

/**
 * Meta WhatsApp Webhook Verification
 * Meta sends GET request with hub.mode, hub.verify_token, hub.challenge
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const settings = storage.getSettings();
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ||
    (settings.metaConfig && settings.metaConfig.verifyToken);

  if (!verifyToken) {
    console.warn('WhatsApp Webhook Verification Failed: WHATSAPP_VERIFY_TOKEN is not set');
    return res.sendStatus(403);
  }

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('WhatsApp Webhook Verified Successfully!');
      return res.status(200).send(challenge);
    } else {
      console.warn('WhatsApp Webhook Verification Failed: Token mismatch');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

/**
 * Meta WhatsApp Incoming Messages Webhook
 */
// Checks Meta's X-Hub-Signature-256 header when WHATSAPP_APP_SECRET is set
function hasValidSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  if (!hasValidSignature(req)) {
    console.warn('Rejected WhatsApp webhook: invalid signature');
    return res.sendStatus(401);
  }
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value;
      if (value?.messages?.[0]) {
        const messageObj = value.messages[0];
        const contact = (value.contacts && value.contacts[0]) || {};
        const from = messageObj.from; // Customer phone number
        const senderName = contact.profile ? contact.profile.name : `Guest (${from})`;

        let incomingText = '';

        if (messageObj.type === 'text') {
          incomingText = messageObj.text.body;
        } else if (messageObj.type === 'interactive') {
          if (messageObj.interactive.type === 'button_reply') {
            incomingText = messageObj.interactive.button_reply.id;
          } else if (messageObj.interactive.type === 'list_reply') {
            incomingText = messageObj.interactive.list_reply.id;
          }
        } else if (messageObj.type === 'button') {
          incomingText = messageObj.button.payload || messageObj.button.text;
        }

        if (incomingText) {
          console.log(`[WhatsApp Inbound] From: ${from} | Msg: "${incomingText}"`);
          // Dispatch to Bot Engine
          await botEngine.handleMessage(from, incomingText, {
            customerName: senderName
          });
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.sendStatus(404);
  } catch (err) {
    console.error('Error handling WhatsApp webhook:', err);
    return res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
