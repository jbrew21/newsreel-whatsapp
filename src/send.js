#!/usr/bin/env node

/**
 * Newsreel WhatsApp — Daily sender
 *
 * Pulls today's top poll from daily_polls (already populated by newsletter),
 * sends it to all active WhatsApp subscribers via template message.
 *
 * Usage:
 *   node src/send.js              # Send today's poll
 *   node src/send.js --dry-run    # Preview without sending
 *   node src/send.js --date 2026-03-13   # Specific date
 */

import { loadEnv } from './env.js';
loadEnv();

import { getActiveSubscribers, getTodayPolls } from './supabase.js';
import { sendDailyPoll } from './whatsapp.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateFlag = args.indexOf('--date');
const today = dateFlag >= 0
  ? args[dateFlag + 1]
  : new Date().toISOString().split('T')[0];

async function main() {
  console.log(`\nNewsreel WhatsApp — ${today}${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // 1. Get today's polls
  const polls = await getTodayPolls(today);
  if (!polls.length) {
    console.log('No polls found for today. Has the newsletter been generated?');
    process.exit(1);
  }

  // Pick the lead story poll (story_idx 0)
  const poll = polls[0];
  console.log(`Poll: "${poll.question}"`);
  console.log(`Story: ${poll.headline}\n`);

  // 2. Get subscribers
  const subscribers = await getActiveSubscribers();
  console.log(`Subscribers: ${subscribers.length}\n`);

  if (!subscribers.length) {
    console.log('No active subscribers. Add some first:');
    console.log('  node src/manage.js add +1234567890 "Jack"');
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
      console.error(`  Failed: ${sub.phone}`);
    }

    // Rate limit: 80 msgs/sec for WhatsApp Business API, but be conservative
    if (!DRY_RUN && subscribers.length > 10) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`\nDone: ${sent} sent, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
