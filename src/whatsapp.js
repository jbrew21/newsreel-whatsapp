/**
 * Newsreel WhatsApp — Meta Cloud API client
 *
 * Handles sending messages via WhatsApp Business Cloud API.
 * Uses templates for initial outreach (required by Meta),
 * and free-form messages within the 24h reply window.
 */

import { loadEnv } from './env.js';
loadEnv();

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

const authHeaders = {
  'Authorization': `Bearer ${ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

/**
 * Send daily poll as a two-step flow:
 * 1. Template message to initiate conversation (costs ~$0.035)
 * 2. Interactive list with full 5-point Likert scale (free, within 24h window)
 *
 * Template: "daily_nudge" — just opens the conversation
 * List message: full poll with Strongly Agree → Strongly Disagree
 */
export async function sendDailyPoll(phone, firstName, pollStatement, storyIdx, date, headline) {
  // Send template with all 3 params: name, headline context, poll statement
  // Template body: "Hey {{1}}, {{2}} \n\nWhat's your stance?\n\n\"{{3}}\"\n\nStrongly agree...?"
  return sendMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'daily_nudge',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: firstName || 'there' },
            { type: 'text', text: headline || 'here\'s today\'s story.' },
            { type: 'text', text: pollStatement },
          ],
        },
      ],
    },
  });
}

/**
 * Send poll as interactive list message (within 24h window)
 * Full 5-point Likert scale matching the newsletter
 */
export async function sendPollList(phone, pollStatement, storyIdx, date) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: `"${pollStatement}"` },
      action: {
        button: 'Share your take',
        sections: [
          {
            title: 'What do you think?',
            rows: [
              { id: `poll:${date}:${storyIdx}:strongly_agree`, title: 'Strongly Agree' },
              { id: `poll:${date}:${storyIdx}:agree`, title: 'Agree' },
              { id: `poll:${date}:${storyIdx}:neutral`, title: 'Neutral' },
              { id: `poll:${date}:${storyIdx}:disagree`, title: 'Disagree' },
              { id: `poll:${date}:${storyIdx}:strongly_disagree`, title: 'Strongly Disagree' },
            ],
          },
        ],
      },
    },
  });
}

/**
 * Send a free-form text reply (within 24h window, free)
 */
export async function sendTextReply(phone, text) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  });
}

/**
 * Send a message with interactive buttons (within 24h window)
 * Used for follow-up: "Want to see perspectives?" + "Read the full story"
 */
export async function sendFollowUp(phone, bodyText, buttons) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((btn, i) => ({
          type: 'reply',
          reply: { id: btn.id, title: btn.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Send a quiz question (within 24h window, after poll response)
 */
export async function sendQuiz(phone, question, options, date, storyIdx) {
  const optionLetters = ['A', 'B', 'C', 'D'];
  const body = `Quick quiz: ${question}\n\n${options.map((o, i) => `${optionLetters[i]}) ${o}`).join('\n')}`;

  // WhatsApp interactive buttons max 3, but quiz has 4 options.
  // Send as text, user replies with A/B/C/D
  return sendTextReply(phone, body + '\n\nJust reply with A, B, C, or D.');
}

// ─── Internal ───────────────────────────

async function sendMessage(payload) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.log('  [dry-run] Would send to', payload.to);
    console.log('  ', JSON.stringify(payload).slice(0, 200));
    return { ok: true, dry: true };
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`  WhatsApp API error (${res.status}):`, JSON.stringify(data));
    return { ok: false, error: data };
  }

  return { ok: true, messageId: data.messages?.[0]?.id };
}
