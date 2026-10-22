#!/usr/bin/env node
// scripts/replybot-seed.js — one-time: copy the cards already sitting in Reply
// Bot into /srv/replybot/chat.jsonl, so `replybot` sees cards posted before
// the mirror in services/replyApprovals.js existed. Safe to rerun (skips ids already logged).
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { db } = require('../services/db');

const LOG = process.env.REPLYBOT_LOG || '/srv/replybot/chat.jsonl';
const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const iso = v => (v && v.toDate ? v.toDate() : new Date(v || Date.now())).toISOString();

(async () => {
  const seen = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).message_id) : []);
  const lines = [];
  for (const d of (await db.collection('reply_approvals').where('status', '==', 'pending').get()).docs) {
    const a = d.data();
    if (!a.tg_message_id || seen.has(a.tg_message_id)) continue;
    lines.push({ at: iso(a.created_at), method: 'sendMessage', message_id: a.tg_message_id, text: plain(a.tg_text || `${a.full_name}: ${a.their_text}\n\nDraft: ${a.draft}`), buttons: ['Review'] });
  }
  for (const d of (await db.collection('cadence_approvals').where('status', '==', 'pending').get()).docs) {
    const a = d.data();
    if (!a.tg_message_id || seen.has(a.tg_message_id)) continue;
    lines.push({ at: iso(a.created_at), method: 'sendMessage', message_id: a.tg_message_id, text: plain(a.tg_text) || `Ad lead cadence: ${a.step_label} to ${a.name}\n\n${a.text}`, buttons: ['Review and send'] });
  }
  lines.sort((x, y) => x.at.localeCompare(y.at));
  if (lines.length) fs.appendFileSync(LOG, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  console.log(`seeded ${lines.length} card(s)`);
  process.exit(0);
})().catch(e => { console.error('[replybot-seed]', e.message); process.exit(1); });
