const { transcripts, replies } = require('../services/db');
const { getEventsWindow } = require('../services/calendar');
const { claudePrompt } = require('../services/claude');
const { sendMail, isConfigured } = require('../services/mailer');

const NUDGE_AFTER_DAYS = 4;
const RECIPIENTS = () => (process.env.BRIEF_RECIPIENTS || 'vincent@storygroup.io,mmoonan@storygroup.io').split(',').map(s => s.trim());

/**
 * Nudge candidates: follow-ups sent 4+ days ago, not yet reminded.
 * We can't see the prospect's inbox, so this is a REMINDER with a
 * suggested nudge — Vincent decides whether they actually replied.
 */
async function findNudgeCandidates() {
  const snap = await transcripts.where('followup_draft.status', '==', 'sent').limit(100).get();
  const now = Date.now();
  const due = [];
  for (const doc of snap.docs) {
    const t = doc.data();
    const d = t.followup_draft;
    if (t.nudge_reminded_at) continue;
    const ageDays = (now - new Date(d.sent_at).getTime()) / 86400e3;
    if (ageDays >= NUDGE_AFTER_DAYS) due.push({ ref: doc.ref, t, d, ageDays: Math.floor(ageDays) });
  }
  return due;
}

async function draftNudge({ t, d }) {
  const prompt = `Vincent Catalano (Story Group, PR for executives) sent this follow-up ${NUDGE_AFTER_DAYS}+ days ago after a call and got no reply.

CALL: "${t.title}" on ${t.date?.slice(0, 10)}
CALL SUMMARY: ${t.overview || 'n/a'}
ACTION ITEMS: ${t.action_items || 'n/a'}

THE FOLLOW-UP HE SENT:
Subject: ${d.subject}
${d.body}

Write a short nudge email (40-80 words, plain text). Rules:
- Reference something specific from the call, not "just bumping this."
- Add ONE new reason to respond (a deadline they mentioned, a timing factor, something happening in their world).
- One low-effort CTA (a yes/no question or a specific time).
- No guilt, no "I know you're busy," no exclamation marks. Sign off as "Vincent".

Return ONLY valid JSON: {"subject": "...", "body": "..."}
Subject should thread naturally (e.g. "Re: ${d.subject}").`;

  const { claudeJSON } = require('../services/claude');
  return claudeJSON(prompt, { timeout: 120000 });
}

/**
 * Interested-but-never-booked: replies classified interested in the last
 * 14 days whose email never appears on the calendar (7 days back to 14 ahead)
 * and has no meeting recorded.
 */
async function findInterestedNotBooked() {
  const since = new Date(Date.now() - 14 * 86400e3);
  // Grace period: give them a few days to book before flagging
  const graceCutoff = new Date(Date.now() - 3 * 86400e3);
  const snap = await replies
    .where('classification', '==', 'interested')
    .limit(300)
    .get();

  const byEmail = new Map();
  for (const doc of snap.docs) {
    const r = { id: doc.id, ...doc.data() };
    const created = r.created_at?.toDate ? r.created_at.toDate() : new Date(r.created_at);
    if (created < since || created > graceCutoff) continue;
    if (r.had_meeting || r.booked_check_dismissed || !r.email) continue;
    const key = r.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, r);
  }
  const interested = [...byEmail.values()];
  if (!interested.length) return [];

  let bookedEmails = new Set();
  try {
    const events = await getEventsWindow({ daysBack: 7, daysAhead: 14 });
    bookedEmails = new Set(events.flatMap(e => e.attendees));
  } catch (e) {
    console.warn('[reminders] Calendar check failed:', e.message);
  }

  return interested.filter(r => r.email && !bookedEmails.has(r.email.toLowerCase()));
}

async function runReminders({ send = true } = {}) {
  const [nudges, notBooked] = [await findNudgeCandidates(), await findInterestedNotBooked()];
  console.log(`[reminders] ${nudges.length} nudge(s) due, ${notBooked.length} interested-not-booked`);

  if (!nudges.length && !notBooked.length) return { nudges: 0, notBooked: 0, sent: false };

  // Draft a suggested nudge for each due follow-up
  const nudgeBlocks = [];
  for (const n of nudges) {
    let suggestion = null;
    try { suggestion = await draftNudge(n); }
    catch (e) { console.warn(`[reminders] Nudge draft failed for ${n.d.to}:`, e.message); }
    nudgeBlocks.push({ ...n, suggestion });
  }

  const html = `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
  <h2 style="color:#FF2257">GTM Reminders</h2>
  ${nudgeBlocks.length ? `
  <h3>Follow-ups gone quiet (${nudgeBlocks.length})</h3>
  <p style="color:#666;font-size:13px">Sent ${NUDGE_AFTER_DAYS}+ days ago. If they replied, ignore. If not, here's what to send:</p>
  ${nudgeBlocks.map(n => `
  <div style="border:1px solid #e0e0e8;border-radius:8px;padding:16px;margin:12px 0">
    <div style="font-weight:bold">${n.d.to} — "${n.t.title}" (sent ${n.ageDays} days ago)</div>
    ${n.suggestion ? `
    <div style="background:#f7f7fa;border-radius:6px;padding:12px;margin-top:10px;font-size:14px">
      <div style="font-weight:bold;margin-bottom:6px">${n.suggestion.subject}</div>
      <pre style="white-space:pre-wrap;font-family:inherit;margin:0">${String(n.suggestion.body).replace(/</g, '&lt;')}</pre>
    </div>` : '<div style="color:#999;font-size:13px;margin-top:8px">(nudge draft failed — write manually)</div>'}
  </div>`).join('')}` : ''}
  ${notBooked.length ? `
  <h3>Replied "interested" but never booked (${notBooked.length})</h3>
  <p style="color:#666;font-size:13px">No calendar event found for these in the last 7 / next 14 days:</p>
  <ul style="font-size:14px;line-height:1.8">
    ${notBooked.map(r => `<li><b>${r.email}</b>${r.company_name ? ` — ${r.company_name}` : ''}${r.created_at?.toDate ? ` (replied ${r.created_at.toDate().toLocaleDateString()})` : ''}</li>`).join('')}
  </ul>` : ''}
</div>`;

  const result = { nudges: nudgeBlocks.length, notBooked: notBooked.length, sent: false };

  if (send && isConfigured()) {
    await sendMail({
      to: RECIPIENTS(),
      subject: `GTM Reminders: ${nudgeBlocks.length} nudge${nudgeBlocks.length === 1 ? '' : 's'} due, ${notBooked.length} unbooked interested`,
      html,
    });
    result.sent = true;
    // Mark nudges reminded so they only fire once
    for (const n of nudgeBlocks) {
      await n.ref.set({ nudge_reminded_at: new Date().toISOString() }, { merge: true });
    }
  } else {
    result.html = html;
  }

  return result;
}

module.exports = { runReminders };
