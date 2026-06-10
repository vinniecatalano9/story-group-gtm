// scripts/backfill_heyreach_text.js — one-off repair.
//
// Heyreach webhook replies saved before the recent_messages fix have
// reply_text='' even though the message text sits in raw_payload.
// Re-extract the text + tags, then run the reclassifier so each one
// gets a playbook classification and draft.
//
// Run on the VPS:  cd ~/story-group-gtm/backend && set -a && source .env && set +a && node scripts/backfill_heyreach_text.js

const { db } = require('../services/db');
const { reclassifyBacklog } = require('../cron/reclassify');

function extract(raw) {
  const evt = raw?.data || raw?.event || raw?.payload || raw || {};
  const msgs = Array.isArray(evt.recent_messages) ? evt.recent_messages : [];
  const replies = msgs.filter(m => m && m.is_reply && (m.message || '').trim());
  const pick = replies.length ? replies[replies.length - 1] : (msgs[msgs.length - 1] || null);
  const text = pick && (pick.message || '').trim() ? pick.message.trim() : '';
  const lead = evt.lead || {};
  const tags = (Array.isArray(lead.tags) ? lead.tags : [])
    .map(t => (typeof t === 'string' ? t : (t && (t.name || t.tag)) || '')).filter(Boolean);
  return { text, tags };
}

(async () => {
  // No composite index on (source, created_at) — pull recent and filter in code.
  const snap = await db.collection('replies')
    .orderBy('created_at', 'desc').limit(800).get();

  let fixed = 0, skipped = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.source !== 'heyreach') { skipped++; continue; }
    if ((d.reply_text || '').trim().length >= 4) { skipped++; continue; }
    const { text, tags } = extract(d.raw_payload);
    if (!text) { skipped++; continue; }
    const interested = tags.some(t => /interested/i.test(t) && !/not.?interested/i.test(t));
    await doc.ref.update({
      reply_text: text,
      heyreach_tags: tags,
      auto_tag_interested: interested,
      reclassified_at: null, // make the reclassifier pick it up
    });
    fixed++;
    console.log(`[backfill] ${doc.id} ${d.full_name || d.profile_url}: "${text.slice(0, 80)}"`);
  }
  console.log(`[backfill] fixed ${fixed}, skipped ${skipped}. Running reclassifier...`);

  let pass = 1;
  while (true) {
    const r = await reclassifyBacklog({ limit: 25 });
    console.log(`[backfill] reclassify pass ${pass}:`, r);
    if (!r.processed || pass++ >= 10) break;
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
