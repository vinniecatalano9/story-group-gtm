#!/usr/bin/env node
// scripts/gtm-feed.js — CLI for the Telegram GTM feed (see cron/feed.js).
//   node scripts/gtm-feed.js digest|weekly   → facts JSON on stdout
//   node scripts/gtm-feed.js mark <file>     → stamp a sent digest's items as shown
// Run by root cron through /usr/local/bin/gtm-feed on the VPS.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { digestFacts, weeklyFacts, markShown } = require('../cron/feed');

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'digest') process.stdout.write(JSON.stringify(await digestFacts(), null, 1));
  else if (cmd === 'weekly') process.stdout.write(JSON.stringify(await weeklyFacts(), null, 1));
  else if (cmd === 'mark' && arg) console.log(`marked ${await markShown(JSON.parse(fs.readFileSync(arg, 'utf8')))} item(s)`);
  else { console.error('usage: gtm-feed.js digest|weekly|mark <file>'); process.exit(2); }
  process.exit(0);
})().catch(e => { console.error('[gtm-feed]', e.stack || e.message); process.exit(1); });
