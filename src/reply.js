/**
 * Newsreel WhatsApp — Reply handler
 *
 * When a user taps a poll button or sends a text reply,
 * this generates a conversational response. The tone should
 * feel like a smart friend, not a bot. Think Boardy-level human.
 */

import { loadEnv } from './env.js';
loadEnv();

import { getTodayPolls, logPollResponse, getSubscriberByPhone } from './supabase.js';
import { sendTextReply, sendFollowUp } from './whatsapp.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_URL = process.env.APP_URL || 'https://newsreel.co';

/**
 * Handle an incoming poll button tap
 * payload format: "poll:2026-03-13:0:agree" or "poll:2026-03-13:0:strongly_agree"
 */
export async function handlePollResponse(phone, payload) {
  const parts = payload.split(':');
  const date = parts[1];
  const storyIdxStr = parts[2];
  const stance = parts.slice(3).join('_'); // handles "strongly_agree" etc
  const storyIdx = parseInt(storyIdxStr, 10);

  // Log the response
  await logPollResponse(phone, date, storyIdx, stance);

  // Get the poll data for context
  const polls = await getTodayPolls(date);
  const poll = polls.find(p => p.story_idx === storyIdx);
  if (!poll) {
    await sendTextReply(phone, "Got it, logged your answer. Something went wrong loading the story though, sorry about that.");
    return;
  }

  // Get subscriber name
  const sub = await getSubscriberByPhone(phone);
  const name = sub?.first_name || '';

  // Generate a conversational reply using Claude
  const reply = await generateReply(name, poll, stance);
  await sendTextReply(phone, reply);

  // Follow up with story link + perspectives prompt
  const storyUrl = `${APP_URL}/story/${date}/${storyIdx}`;
  await sendFollowUp(phone,
    `Here's the full story if you want the details.`,
    [
      { id: `read:${date}:${storyIdx}`, title: 'Read the story' },
      { id: `perspectives:${date}:${storyIdx}`, title: 'See other takes' },
    ]
  );
}

/**
 * Handle a free-text reply (quiz answer, general message)
 */
export async function handleTextReply(phone, text) {
  const cleaned = text.trim().toUpperCase();

  // Check if it's a quiz answer (A, B, C, D)
  if (['A', 'B', 'C', 'D'].includes(cleaned)) {
    // TODO: match against active quiz for this user
    await sendTextReply(phone, `Got it, ${cleaned}. Quiz scoring coming soon.`);
    return;
  }

  // Check for opt-out
  if (['STOP', 'UNSUBSCRIBE', 'QUIT'].includes(cleaned)) {
    const { removeSubscriber } = await import('./supabase.js');
    await removeSubscriber(phone);
    await sendTextReply(phone, "You're unsubscribed. No more messages from us. If you ever want back in, just text START.");
    return;
  }

  // General reply - keep it brief and human
  await sendTextReply(phone, "Hey, I'm not great at open conversation yet, but I hear you. I'll have more for you tomorrow morning.");
}

/**
 * Handle follow-up button taps (read story, see perspectives)
 */
export async function handleFollowUpButton(phone, buttonId) {
  const [action, date, storyIdxStr] = buttonId.split(':');
  const storyIdx = parseInt(storyIdxStr, 10);

  if (action === 'read') {
    const storyUrl = `${APP_URL}/story/${date}/${storyIdx}`;
    await sendTextReply(phone, storyUrl);
  }

  if (action === 'perspectives') {
    const perspUrl = `${APP_URL}/perspectives/${date}/${storyIdx}`;
    await sendTextReply(phone, `${perspUrl}\n\nSee how creators, journalists, and politicians are framing this differently.`);
  }
}

// ─── Claude-powered reply generation ────

async function generateReply(name, poll, stance) {
  if (!ANTHROPIC_API_KEY) {
    return getFallbackReply(name, poll, stance);
  }

  const prompt = `You're Newsreel, texting someone on WhatsApp about today's news. They just responded to a poll.

The poll statement was: "${poll.question}"
About: ${poll.headline}
They ${
  stance === 'strongly_agree' ? 'strongly agreed' :
  stance === 'agree' ? 'agreed' :
  stance === 'disagree' ? 'disagreed' :
  stance === 'strongly_disagree' ? 'strongly disagreed' :
  'were neutral'
}.
Their name: ${name || 'unknown'}

Write a WhatsApp reply (2-3 sentences max). Rules:
- Sound like a real person texting, not a bot or a brand
- Acknowledge their take genuinely, don't just validate them
- Add one interesting angle or fact they might not have considered
- If they agreed, gently surface the strongest counter-argument
- If they disagreed, acknowledge why someone might see it their way
- NEVER use em dashes, emojis, or exclamation marks
- NEVER say "great point" or "interesting take" or anything patronizing
- Don't start with their name
- Keep it under 200 characters if possible
- End with something that makes them think, not a question`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error('Claude API error:', await res.text());
      return getFallbackReply(name, poll, stance);
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (err) {
    console.error('Claude reply failed:', err.message);
    return getFallbackReply(name, poll, stance);
  }
}

function getFallbackReply(name, poll, stance) {
  const takes = {
    agree: poll.ai_take_agree,
    neutral: poll.ai_take_neutral,
    disagree: poll.ai_take_disagree,
  };

  const take = takes[stance] || takes.neutral;
  if (take) {
    return `Logged. Here's another way to look at it: ${take.split('.').slice(0, 2).join('.')}.`;
  }
  return `Logged your take on "${poll.headline.slice(0, 50)}." More on this tomorrow.`;
}
