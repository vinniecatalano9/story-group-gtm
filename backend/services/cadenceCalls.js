// services/cadenceCalls.js — set an ad lead's outcome from the call transcript.
//
// Vincent (10/22): "you could read the call, right? And then just figure it
// out, because I'll have the transcript." Phone calls go RingCentral recording
// -> Fireflies -> transcripts (cron/ringcentral-poll.js, cron/fireflies-poll.js).
// When a transcript is a call with a tagged ad lead (participant email, or the
// "RingCentral call: <name>" title), Claude reads it and picks Hit once,
// Talked yes, Meeting yes or Not interested. That runs the same effects as the
// button (track switch, sheet J:L, Nutshell note and stage) and sends Vincent
// one Telegram line with the pick and why, so he can override on the page.
// When the call is unclear it sets nothing and asks him instead.

const { db, transcripts } = require('./db');
const { claudeJSON } = require('./claude');
const { transcriptText } = require('./followupDrafter');
const cadence = require('./cadence');

const LOOKBACK_DAYS = 14;
const LABEL = { hit_once: 'Hit once', talked_yes: 'Talked yes', meeting: 'Meeting yes', not_interested: 'Not interested' };
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const toDate = v => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);

function prompt(lead, text, callDate) {
  return `You are reading a sales call transcript between Vincent Catalano (VP of Growth, Story Group, a PR agency) and ${cadence.fullName(lead)}, who filled out a "Become Impossible to Ignore" ad form. Decide the outcome of this call.

Outcomes (pick exactly one):
- "meeting": they agreed to a specific scheduled meeting (date and time set on the call).
- "talked_yes": they want a meeting / next step, but no specific time was locked in.
- "hit_once": a real conversation happened but no clear yes to a next meeting (maybe later, thinking about it, send info).
- "not_interested": they clearly said no, not interested, wrong fit, or asked not to be contacted.
- "unclear": voicemail, no real conversation, wrong person, transcript too short or garbled, or you genuinely can't tell. Do not guess.

The call happened ${callDate ? new Date(callDate).toISOString() : 'recently'}. If the outcome is "meeting", give the meeting start as an ISO 8601 datetime with offset in "meeting_at" (assume Eastern time if they said ET or no zone); if the day or time is not stated clearly, use outcome "talked_yes" instead.

Return only JSON: {"outcome": "...", "meeting_at": "... or null", "reason": "one short sentence quoting or paraphrasing what they said"}

TRANSCRIPT:
${text}`;
}

/** Ad lead this transcript is with: participant email first, then the call title's name. */
function matchLead(t, leads) {
  const emails = (t.participants || []).map(p => String(p).toLowerCase().trim());
  const byEmail = leads.find(l => emails.includes(l.email));
  if (byEmail) return byEmail;
  const title = norm(t.title);
  if (!/^ringcentral call/.test(title)) return null;
  const hits = leads.filter(l => l.first_name && l.last_name && title.includes(norm(cadence.fullName(l))));
  return hits.length === 1 ? hits[0] : null;
}

async function checkCalls() {
  const leads = (await cadence.listLeads()).filter(l => l.tagged_at && l.state !== 'opted_out');
  if (!leads.length) return { checked: 0 };
  const since = new Date(Math.max(Date.now() - LOOKBACK_DAYS * 864e5, Math.min(...leads.map(l => toDate(l.tagged_at).getTime()))));
  const snap = await transcripts.where('date', '>=', since.toISOString()).get();
  const out = { checked: 0, set: 0, asked: 0 };
  for (const doc of snap.docs) {
    const t = doc.data();
    const lead = matchLead(t, leads);
    if (!lead || (lead.calls_read || []).includes(doc.id)) continue;
    if (new Date(t.date) < toDate(lead.tagged_at)) continue;
    out.checked++;
    const ref = db.collection('ad_leads').doc(lead.email);
    const { FieldValue } = require('firebase-admin').firestore;
    try {
      const full = await require('./fireflies').getTranscript(t.fireflies_id || doc.id);
      const text = transcriptText(full || t);
      let r = { outcome: 'unclear', reason: 'No transcript text yet' };
      if (text && text.length > 200) r = await claudeJSON(prompt(lead, text, t.date), { maxTokens: 400, timeout: 180000 });
      await ref.update({ calls_read: FieldValue.arrayUnion(doc.id) });
      const link = t.transcript_url ? `\n${t.transcript_url}` : '';
      if (!LABEL[r.outcome] || (r.outcome === 'meeting' && isNaN(new Date(r.meeting_at)))) {
        await ref.update({ timeline: FieldValue.arrayUnion({ at: new Date(), kind: 'note', text: `Call read, outcome unclear: ${r.reason || ''}` }) });
        await cadence.ping(`📞 Call with <b>${cadence.esc(cadence.fullName(lead))}</b>: I couldn't tell the outcome (${cadence.esc(r.reason || 'unclear')}). Set it on the Ad Leads page: ${cadence.DASHBOARD_URL()}${link}`);
        out.asked++;
        continue;
      }
      await cadence.setOutcome(lead.email, r.outcome, { meeting_at: r.outcome === 'meeting' ? r.meeting_at : undefined, source: 'set from call transcript' });
      await cadence.ping(`📞 Call with <b>${cadence.esc(cadence.fullName(lead))}</b>: set to <b>${LABEL[r.outcome]}</b>${r.outcome === 'meeting' ? ` (${cadence.esc(new Date(r.meeting_at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} ET)` : ''}. ${cadence.esc(r.reason || '')}\nWrong? Change it on the Ad Leads page: ${cadence.DASHBOARD_URL()}${link}`);
      out.set++;
    } catch (e) {
      // Not marked read, so the next run tries again.
      console.warn(`[cadenceCalls] ${lead.email} transcript ${doc.id}:`, e.message);
    }
  }
  return out;
}

module.exports = { checkCalls, matchLead };
