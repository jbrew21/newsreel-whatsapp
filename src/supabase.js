/**
 * Newsreel WhatsApp — Supabase helpers
 *
 * Tables used:
 *   whatsapp_subscribers — phone numbers + opt-in status
 *   poll_responses       — logged poll/quiz answers per user
 *   daily_polls          — already exists, populated by newsletter pipeline
 */

import { loadEnv } from './env.js';
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// ─── Subscribers ────────────────────────

export async function getActiveSubscribers() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers?active=eq.true&select=*`,
    { headers }
  );
  if (!res.ok) throw new Error(`Subscribers fetch failed: ${await res.text()}`);
  return res.json();
}

export async function addSubscriber(phone, firstName) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers`,
    {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        phone: normalizePhone(phone),
        first_name: firstName || null,
        active: true,
        opted_in_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) throw new Error(`Add subscriber failed: ${await res.text()}`);
  return true;
}

export async function removeSubscriber(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers?phone=eq.${encodePhone(phone)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ active: false }),
    }
  );
  return res.ok;
}

export async function getSubscriberByPhone(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers?phone=eq.${encodePhone(phone)}&limit=1`,
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ─── Daily polls (read from existing table) ─

export async function getTodayPolls(date) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_polls?date=eq.${date}&order=story_idx`,
    { headers }
  );
  if (!res.ok) return [];
  return res.json();
}

// ─── Poll responses ─────────────────────

export async function logPollResponse(phone, date, storyIdx, response) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/poll_responses`,
    {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        phone: normalizePhone(phone),
        date,
        story_idx: storyIdx,
        response,
        platform: 'whatsapp',
        responded_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) console.error('Failed to log response:', await res.text());
  return res.ok;
}

// ─── User takes (rebuttals to perspectives) ──

/**
 * Save a user's text rebuttal to a story perspective.
 * These get surfaced anonymously to other users who voted differently.
 */
export async function saveUserTake(phone, date, storyIdx, text) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_takes`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        phone: normalizePhone(phone),
        date,
        story_idx: storyIdx,
        take_text: text.slice(0, 500), // cap length
        created_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) console.error('Failed to save user take:', await res.text());
  return res.ok;
}

/**
 * Get best user takes from the opposite side for a given story.
 * Used to surface anonymous quotes: "Someone who disagreed said..."
 */
export async function getUserTakes(date, storyIdx, limit = 3) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_takes?date=eq.${date}&story_idx=eq.${storyIdx}&order=created_at.desc&limit=${limit}`,
    { headers }
  );
  if (!res.ok) return [];
  return res.json();
}

// ─── Rebuttal state (tracks "Send my take" flow) ──

/**
 * Mark a user as awaiting a text rebuttal.
 * When their next text message comes in, we capture it as a take.
 */
export async function logAwaitingRebuttal(phone, date, storyIdx) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rebuttal_state`,
    {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        phone: normalizePhone(phone),
        date,
        story_idx: storyIdx,
        created_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) console.error('Failed to log rebuttal state:', await res.text());
  return res.ok;
}

export async function getAwaitingRebuttal(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rebuttal_state?phone=eq.${encodePhone(phone)}&order=created_at.desc&limit=1`,
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;

  // Only valid if created in the last hour (prevent stale state)
  const created = new Date(rows[0].created_at);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return created > hourAgo ? rows[0] : null;
}

export async function clearAwaitingRebuttal(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rebuttal_state?phone=eq.${encodePhone(phone)}`,
    {
      method: 'DELETE',
      headers,
    }
  );
  return res.ok;
}

// ─── Helpers ────────────────────────────

function normalizePhone(phone) {
  // Strip everything except digits, ensure leading +
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') && digits.length === 11
    ? `+${digits}`
    : `+1${digits}`;
}

/** URL-encode phone for Supabase query params (+ must be %2B) */
function encodePhone(phone) {
  return encodeURIComponent(normalizePhone(phone));
}
