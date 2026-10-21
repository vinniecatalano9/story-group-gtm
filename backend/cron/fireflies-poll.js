const fireflies = require('../services/fireflies');
const { transcripts } = require('../services/db');
const { storeAndMatch, generateDraftForTranscript } = require('../routes/fireflies');

// Only auto-draft calls this recent — protects the backlog of old
// transcripts from getting stale "great talking today" drafts.
const DRAFT_WINDOW_HOURS = 72;

// CALL_RECAP_EMAIL=<address> emails a recap (summary, action items, draft)
// for each new RingCentral phone call. CALL_RECAP_ALL=true does it for every call.
const RECAP_TO = () => process.env.CALL_RECAP_EMAIL;
const isPhoneCall = t => /^RingCentral call\b/.test(t.title || '');

async function sendRecap(id) {
  const { sendMail, isConfigured } = require('../services/mailer');
  if (!isConfigured()) return;
  const t = (await transcripts.doc(id).get()).data() || {};
  const d = t.followup_draft;
  const text = [
    t.title,
    '',
    'WHAT HAPPENED',
    t.overview || '(no summary from Fireflies)',
    '',
    'WHAT YOU NEED TO DO',
    t.action_items || '(no action items)',
    '',
    d ? `FOLLOW-UP DRAFT (to ${d.to}, not sent)\nSubject: ${d.subject}\n\n${d.body}` : 'No follow-up draft: the number did not match a lead with an email.',
    '',
    `Dashboard: https://story-group-gtm.web.app/transcripts`,
    t.transcript_url ? `Full transcript: ${t.transcript_url}` : '',
  ].join('\n');
  await sendMail({ to: RECAP_TO(), subject: `Call recap: ${(t.title || '').replace(/^RingCentral call:\s*/, '')}`, text, fromName: 'Story Group GTM' });
  await transcripts.doc(id).set({ recap_sent_at: new Date().toISOString() }, { merge: true });
}

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
      const alreadySkipped = doc.exists && !!doc.data().followup_skipped;

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
      if (!hasDraft && !alreadySkipped && callAgeHours <= DRAFT_WINDOW_HOURS) {
        full = full || await fireflies.getTranscript(t.id);
        const r = await generateDraftForTranscript(full, matchedContacts);
        if (r.followup_draft) drafted++;
        // Remember internal/no-prospect calls so we don't re-check every 15 min
        if (r.skipped && r.skipped.startsWith('no external')) {
          await transcripts.doc(t.id).set({ followup_skipped: r.skipped }, { merge: true });
        }
      }

      const recapDone = doc.exists && !!doc.data().recap_sent_at;
      if (RECAP_TO() && !recapDone && callAgeHours <= DRAFT_WINDOW_HOURS && (isPhoneCall(t) || process.env.CALL_RECAP_ALL === 'true')) {
        await sendRecap(t.id);
      }
    } catch (e) {
      console.error(`[fireflies-poll] Failed on transcript ${t.id} ("${t.title}"):`, e.message);
    }
  }

  if (stored || drafted) console.log(`[fireflies-poll] Done — ${stored} new transcript(s), ${drafted} draft(s)`);
  return { stored, drafted };
}

module.exports = { pollFireflies };
