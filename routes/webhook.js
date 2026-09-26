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
  const verifyToken = (settings.metaConfig && settings.metaConfig.verifyToken) || 
    process.env.WHATSAPP_VERIFY_TOKEN || 
    'RESTAURANT_ORDER_BOT_SECRET_2026';

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
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]
      ) {
        const messageObj = body.entry[0].changes[0].value.messages[0];
        const contact = (body.entry[0].changes[0].value.contacts && body.entry[0].changes[0].value.contacts[0]) || {};
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
