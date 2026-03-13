#!/usr/bin/env node

/**
 * Newsreel WhatsApp — Subscriber management
 *
 * Quick CLI to add/remove/list WhatsApp subscribers.
 * Start small, add people manually.
 *
 * Usage:
 *   node src/manage.js add +12035551234 "Jack"
 *   node src/manage.js remove +12035551234
 *   node src/manage.js list
 */

import { loadEnv } from './env.js';
loadEnv();

import { addSubscriber, removeSubscriber, getActiveSubscribers } from './supabase.js';

const [action, ...rest] = process.argv.slice(2);

async function main() {
  switch (action) {
    case 'add': {
      const phone = rest[0];
      const name = rest[1] || null;
      if (!phone) {
        console.log('Usage: node src/manage.js add +1234567890 "Name"');
        process.exit(1);
      }
      await addSubscriber(phone, name);
      console.log(`Added ${name || phone}`);
      break;
    }

    case 'remove': {
      const phone = rest[0];
      if (!phone) {
        console.log('Usage: node src/manage.js remove +1234567890');
        process.exit(1);
      }
      await removeSubscriber(phone);
      console.log(`Removed ${phone}`);
      break;
    }

    case 'list': {
      const subs = await getActiveSubscribers();
      if (!subs.length) {
        console.log('No active subscribers.');
        break;
      }
      console.log(`\n${subs.length} active subscriber(s):\n`);
      for (const s of subs) {
        console.log(`  ${s.phone}  ${s.first_name || '(no name)'}  since ${s.opted_in_at?.split('T')[0]}`);
      }
      console.log();
      break;
    }

    default:
      console.log('Newsreel WhatsApp — Subscriber Manager\n');
      console.log('  node src/manage.js add +1234567890 "Name"');
      console.log('  node src/manage.js remove +1234567890');
      console.log('  node src/manage.js list');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
