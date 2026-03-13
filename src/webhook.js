#!/usr/bin/env node

/**
 * Newsreel WhatsApp — Webhook server
 *
 * Receives incoming messages and button taps from WhatsApp.
 * Deploy to Render (free tier) or run locally with ngrok for testing.
 *
 * Usage:
 *   node src/webhook.js           # Start server on port 3001
 *   PORT=8080 node src/webhook.js # Custom port
 */

import { loadEnv } from './env.js';
loadEnv();

import express from 'express';
import { handlePollResponse, handleTextReply, handleFollowUpButton } from './reply.js';

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'newsreel_webhook_verify';
const PORT = process.env.PORT || 3001;

// ─── Webhook verification (Meta sends GET to verify) ──

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Incoming messages ──────────────────

app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately (Meta retries on timeout)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return;

    for (const message of value.messages) {
      const phone = message.from;
      console.log(`\nIncoming from ${phone}:`);

      // Button tap (from template quick reply)
      if (message.type === 'button') {
        const payload = message.button?.payload;
        console.log(`  Button: ${payload}`);

        if (payload?.startsWith('poll:')) {
          await handlePollResponse(phone, payload);
        }
        continue;
      }

      // Interactive reply (list selection or button tap)
      if (message.type === 'interactive') {
        // List reply (from poll Likert scale)
        const listId = message.interactive?.list_reply?.id;
        if (listId) {
          console.log(`  List: ${listId}`);
          if (listId.startsWith('poll:')) {
            await handlePollResponse(phone, listId);
          }
          continue;
        }

        // Button reply (from follow-up buttons)
        const buttonId = message.interactive?.button_reply?.id;
        if (buttonId) {
          console.log(`  Button: ${buttonId}`);
          if (buttonId.startsWith('poll:')) {
            await handlePollResponse(phone, buttonId);
          } else {
            await handleFollowUpButton(phone, buttonId);
          }
        }
        continue;
      }

      // Text message
      if (message.type === 'text') {
        const text = message.text?.body;
        console.log(`  Text: "${text}"`);
        await handleTextReply(phone, text);
        continue;
      }

      console.log(`  Unhandled type: ${message.type}`);
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ─── Health check ───────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'newsreel-whatsapp' });
});

// ─── Start ──────────────────────────────

app.listen(PORT, () => {
  console.log(`\nNewsreel WhatsApp webhook listening on port ${PORT}`);
  console.log(`Verify endpoint: GET /webhook`);
  console.log(`Message endpoint: POST /webhook\n`);
});
