const fireflies = require('../services/fireflies');
const { transcripts } = require('../services/db');
const { storeAndMatch, generateDraftForTranscript } = require('../routes/fireflies');

// Only auto-draft calls this recent — protects the backlog of old
// transcripts from getting stale "great talking today" drafts.
const DRAFT_WINDOW_HOURS = 72;

/**
 * Poll Fireflies for new transcripts (webhook safety net).
 * Stores + matches anything new, then drafts follow-ups for
 * matched calls from the last 72h that don't have one yet.
 */
async function pollFireflies() {
  if (!process.env.FIREFLIES_API_KEY) return { skipped: 'no FIREFLIES_API_KEY' };

  const recent = await fireflies.getRecentTranscripts(10);
  let stored = 0, drafted = 0;

  for (const t of recent) {
    try {
      const doc = await transcripts.doc(t.id).get();
      const isNew = !doc.exists;
      const hasDraft = doc.exists && !!doc.data().followup_draft;

      let matchedContacts = doc.exists ? (doc.data().matched_contacts || []) : [];
      let full = null;

      if (isNew) {
        full = await fireflies.getTranscript(t.id);
        const r = await storeAndMatch(full);
        matchedContacts = r.matchedContacts;
        stored++;
        console.log(`[fireflies-poll] Stored "${full.title}" — ${matchedContacts.length} contact(s) matched`);
      }

      const callAgeHours = t.date ? (Date.now() - new Date(t.date).getTime()) / 36e5 : Infinity;
      if (!hasDraft && matchedContacts.length > 0 && callAgeHours <= DRAFT_WINDOW_HOURS) {
        full = full || await fireflies.getTranscript(t.id);
        const r = await generateDraftForTranscript(full, matchedContacts);
        if (r.followup_draft) drafted++;
      }
    } catch (e) {
      console.error(`[fireflies-poll] Failed on transcript ${t.id} ("${t.title}"):`, e.message);
    }
  }

  if (stored || drafted) console.log(`[fireflies-poll] Done — ${stored} new transcript(s), ${drafted} draft(s)`);
  return { stored, drafted };
}

module.exports = { pollFireflies };
