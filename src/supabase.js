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
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers?phone=eq.${normalizePhone(phone)}`,
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
    `${SUPABASE_URL}/rest/v1/whatsapp_subscribers?phone=eq.${normalizePhone(phone)}&limit=1`,
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

// ─── Helpers ────────────────────────────

function normalizePhone(phone) {
  // Strip everything except digits, ensure leading +
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') && digits.length === 11
    ? `+${digits}`
    : `+1${digits}`;
}
