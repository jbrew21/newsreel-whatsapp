#!/usr/bin/env node

/**
 * Newsreel WhatsApp — Daily sender
 *
 * Pulls today's top poll from daily_polls (already populated by newsletter),
 * picks the most polarizing story as the lead, and sends it to all active
 * WhatsApp subscribers via template message.
 *
 * Usage:
 *   node src/send.js                     # Send today's poll
 *   node src/send.js 2026-03-17          # Specific date (positional arg)
 *   node src/send.js --dry-run           # Preview without sending
 *   node src/send.js --date 2026-03-17   # Specific date (flag)
 */

import { loadEnv } from './env.js';
loadEnv();

import { getActiveSubscribers, getTodayPolls } from './supabase.js';
import { sendDailyPoll } from './whatsapp.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateFlag = args.indexOf('--date');

// Support positional date arg: node src/send.js 2026-03-17
const positionalDate = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const today = dateFlag >= 0
  ? args[dateFlag + 1]
  : positionalDate || new Date().toISOString().split('T')[0];

/**
 * Pick the most engaging/polarizing poll to lead with.
 * Scoring heuristics:
 *   - story_idx 0 gets a small bonus (editorial intent)
 *   - Questions with strong opinion words score higher
 *   - "Should" questions tend to be more engaging
 *   - Shorter, punchier questions score higher
 */
function pickLeadPoll(polls) {
  if (polls.length === 1) return polls[0];

  const polarizingWords = [
    'should', 'ban', 'deactivate', 'allow', 'force', 'require', 'punish',
    'accused', 'guilty', 'wrong', 'right', 'fair', 'unfair', 'dangerous',
    'racist', 'sexist', 'discrimination', 'freedom', 'censorship', 'war',
    'kill', 'death', 'crime', 'controversial', 'radical', 'extreme',
  ];

  const scored = polls.map(poll => {
    let score = 0;
    const q = (poll.question || '').toLowerCase();

    // Polarizing keyword bonus
    for (const word of polarizingWords) {
      if (q.includes(word)) score += 2;
    }

    // "Should" questions drive engagement
    if (q.startsWith('universities') || q.includes('should')) score += 3;

    // Shorter questions are punchier (sweet spot: 40-100 chars)
    if (q.length >= 40 && q.length <= 100) score += 2;
    if (q.length > 150) score -= 1;

    // Editorial lead bonus (story_idx 0 was chosen by the newsletter pipeline)
    if (poll.story_idx === 0) score += 2;

    return { poll, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].poll;
}

async function main() {
  console.log(`\nNewsreel WhatsApp — ${today}${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // 1. Get today's polls
  const polls = await getTodayPolls(today);
  if (!polls.length) {
    console.log('No polls found for today. Has the newsletter been generated?');
    process.exit(1);
  }

  console.log(`Found ${polls.length} polls for ${today}:`);
  for (const p of polls) {
    console.log(`  [${p.story_idx}] ${p.question}`);
  }

  // Pick the most engaging poll as lead
  const poll = pickLeadPoll(polls);
  console.log(`\nLead poll: "${poll.question}"`);
  console.log(`Story: ${poll.headline}\n`);

  // 2. Get subscribers
  const subscribers = await getActiveSubscribers();
  console.log(`Subscribers: ${subscribers.length}\n`);

  if (!subscribers.length) {
    console.log('No active subscribers. Add some first:');
    console.log('  node src/manage.js add +1234567890 "Jack"');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('[DRY RUN] Would send to:');
    for (const sub of subscribers) {
      console.log(`  ${sub.first_name || sub.phone}`);
    }
    console.log('\nDone (dry run, nothing sent).');
    process.exit(0);
  }

  // 3. Send to each subscriber
  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    const result = await sendDailyPoll(
      sub.phone,
      sub.first_name,
      poll.question,
      poll.story_idx,
      today
    );

    if (result.ok) {
      sent++;
      console.log(`  Sent to ${sub.first_name || sub.phone}`);
    } else {
      failed++;
      console.error(`  Failed: ${sub.phone} — ${JSON.stringify(result.error || {})}`);
    }

    // Rate limit: 80 msgs/sec for WhatsApp Business API, but be conservative
    if (subscribers.length > 10) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`\nDone: ${sent} sent, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
