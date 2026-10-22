const fireflies = require('../services/fireflies');
const { db, transcripts } = require('../services/db');
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
    d ? `FOLLOW-UP DRAFT (to ${d.to}, not sent${d.gmail_draft ? ', in your Gmail drafts' : ''})${d.ask ? `\nThey asked for: ${d.ask}` : ''}\nSubject: ${d.subject}\n\n${d.body}`
      : `No follow-up draft: ${t.followup_skipped === 'no ask on the call' ? 'they did not ask for anything on the call' : (t.followup_skipped || 'no prospect email on this call')}.`,
    '',
    `Dashboard: https://story-group-gtm.web.app/transcripts`,
    t.transcript_url ? `Full transcript: ${t.transcript_url}` : '',
  ].join('\n');
  await sendMail({ to: RECAP_TO(), subject: `Call recap: ${(t.title || '').replace(/^RingCentral call:?\s*/, '')}`, text, fromName: 'Story Group GTM' });
  await transcripts.doc(id).set({ recap_sent_at: new Date().toISOString() }, { merge: true });
}

// One claim per transcript (postcall_claims/<id>, Firestore create()) before
// any draft or recap: the webhook and the poll both see a new call, and before
// this Ethelyn got two drafts and two recaps from one transcript. A run that
// fails drops its claim so the next poll tries again.
const claims = () => db.collection('postcall_claims');

/**
 * After-call work for one stored transcript: a follow-up draft only if the
 * prospect asked for something (also put in Gmail drafts, never sent), then
 * the recap email for phone calls. Both the webhook and the poll call this.
 */
async function processCall(id, { full = null } = {}) {
  const t = (await transcripts.doc(id).get()).data();
  if (!t) return { skipped: 'not stored yet' };
  const ageHours = t.date ? (Date.now() - new Date(t.date).getTime()) / 36e5 : Infinity;
  if (ageHours > DRAFT_WINDOW_HOURS) return { skipped: 'older than the draft window' };
  const wantDraft = !t.followup_draft && !t.followup_skipped;
  const wantRecap = !!RECAP_TO() && !t.recap_sent_at && (isPhoneCall(t) || process.env.CALL_RECAP_ALL === 'true');
  if (!wantDraft && !wantRecap) return { skipped: 'already done' };

  try {
    await claims().doc(id).create({ status: 'claimed', at: new Date(), title: t.title || null });
  } catch {
    return { skipped: 'claimed by another run' };
  }
  const out = { drafted: false, recapped: false };
  try {
    if (wantDraft) {
      full = full || await fireflies.getTranscript(id);
      const r = await generateDraftForTranscript(full, t.matched_contacts || [], { auto: true });
      if (r.followup_draft) out.drafted = true;
      else if (r.skipped) await transcripts.doc(id).set({ followup_skipped: r.skipped }, { merge: true });
    }
    if (wantRecap) { await sendRecap(id); out.recapped = true; }
    await claims().doc(id).set({ status: 'done', done_at: new Date() }, { merge: true });
  } catch (e) {
    await claims().doc(id).delete().catch(() => {});
    throw e;
  }
  return out;
}

/**
 * Poll Fireflies for new transcripts (webhook safety net).
 * Stores + matches anything new, then runs processCall on each.
 * Never overlaps itself: a slow run (Claude drafting) makes the next tick skip.
 */
let _polling = false;
async function pollFireflies() {
  if (!process.env.FIREFLIES_API_KEY) return { skipped: 'no FIREFLIES_API_KEY' };
  if (_polling) return { skipped: 'previous poll still running' };
  _polling = true;
  let stored = 0, drafted = 0;
  try {
    const recent = await fireflies.getRecentTranscripts(10);
    for (const t of recent) {
      try {
        const doc = await transcripts.doc(t.id).get();
        let full = null;
        if (!doc.exists) {
          full = await fireflies.getTranscript(t.id);
          const r = await storeAndMatch(full);
          stored++;
          console.log(`[fireflies-poll] Stored "${full.title}" — ${r.matchedContacts.length} contact(s) matched`);
        }
        const r = await processCall(t.id, { full });
        if (r.drafted) drafted++;
      } catch (e) {
        console.error(`[fireflies-poll] Failed on transcript ${t.id} ("${t.title}"):`, e.message);
      }
    }
  } finally {
    _polling = false;
  }

  if (stored || drafted) console.log(`[fireflies-poll] Done — ${stored} new transcript(s), ${drafted} draft(s)`);
  return { stored, drafted };
}

module.exports = { pollFireflies, processCall };
