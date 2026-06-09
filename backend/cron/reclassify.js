// cron/reclassify.js — re-run the v3 classifier over unhandled replies.
//
// Upgrades drafts written under the old (v2) macros — and surfaces replies that
// were left 'other' while the Claude token was dead — to the v3 macros (anchored
// pricing + earned-not-paid reframe + Calendly). Bounded per run; each update
// persists immediately, so a partial run still makes progress.

const { db } = require('../services/db');
const { classifyReply } = require('../services/replyClassifier');
const { isMediaOutreach } = require('../lib/mediaFilter');

async function reclassifyBacklog({ limit = 25 } = {}) {
  const snap = await db.collection('replies').orderBy('created_at', 'desc').limit(400).get();
  const candidates = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (d.handled === true) return;
    if (isMediaOutreach({ email: d.email, company: d.company_name })) return;
    const reply = (d.reply_text || '').trim();
    if (reply.length < 4) return; // nothing to classify (empty webhook capture)
    if (d.reclassified_at) return; // already upgraded to v3 — let batches advance
    candidates.push({ id: doc.id, d });
  });

  const batch = candidates.slice(0, limit);
  let updated = 0, failed = 0;
  for (const { id, d } of batch) {
    try {
      const cls = await classifyReply({
        channel: d.source === 'heyreach' ? 'linkedin' : 'email',
        email: d.email || null,
        company: d.company_name || '',
        replyText: d.reply_text || '',
        firstName: d.first_name || (d.full_name || '').split(' ')[0] || '',
        slots: null,
      });
      await db.collection('replies').doc(id).update({
        classification: cls.classification || d.classification || 'other',
        sentiment: cls.sentiment || d.sentiment || 'neutral',
        summary: cls.summary || d.summary || '',
        suggested_macro: cls.suggested_macro || '',
        suggested_action: cls.suggested_action || '',
        draft_response: cls.draft_response || '',
        reclassified_at: new Date(),
      });
      updated++;
    } catch (e) {
      failed++;
      console.error('[reclassify] fail', id, e.message);
    }
  }
  console.log(`[reclassify] updated ${updated}, failed ${failed}, of ${candidates.length} candidates`);
  return { updated, failed, candidates: candidates.length, processed: batch.length };
}

module.exports = { reclassifyBacklog };
