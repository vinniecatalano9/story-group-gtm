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
//
// The Nutshell note carries the call itself (Vincent, 10/22): a short summary,
// what they asked for, the agreed next step, and a revisit date if they gave
// one. The revisit date is only written down; no task or check-in is made.
// The sheet shows the call too: Last Touch "10/22 Call, 23 min", "Call" in
// Touches So Far, and one short line appended to Notes (never replacing it),
// once per transcript.

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

Also write the CRM note fields, from what was actually said (never invent anything):
- "one_line": the call in one line, under 15 words, for a spreadsheet note.
- "summary": 2 to 3 plain sentences on what the call covered: their business, what they want, where they stand.
- "asked_for": what the prospect asked Vincent to send or do (info, pricing, a proposal, a follow up call...), or null if they asked for nothing.
- "next_step": the next step both sides agreed on, or null if none was agreed.
- "revisit": if they said to check back later, when, as they said it plus the approximate date (e.g. "in about 3 months, around late January 2027"), else null.
Write like a person typing a CRM note: short, plain words, no dashes of any kind (use commas or periods).

Return only JSON: {"outcome": "...", "meeting_at": "... or null", "reason": "one short sentence quoting or paraphrasing what they said", "one_line": "...", "summary": "...", "asked_for": "... or null", "next_step": "... or null", "revisit": "... or null"}

TRANSCRIPT:
${text}`;
}

const clean = v => (v && !/^(null|none|n\/a)$/i.test(String(v).trim()) ? String(v).trim().replace(/[ \t]+[\u2013\u2014-]+[ \t]+/g, ', ').replace(/[\u2013\u2014]/g, ', ') : '');
const md = (d, tz) => new Date(d).toLocaleDateString('en-US', { timeZone: tz || 'America/Chicago', month: 'numeric', day: 'numeric' });

/** The Nutshell note body from the call read. */
function callNote(r, link = '') {
  return [
    clean(r.summary) && `Call summary: ${clean(r.summary)}`,
    `They asked for: ${clean(r.asked_for) || 'nothing specific'}`,
    `Next step: ${clean(r.next_step) || 'none agreed'}`,
    clean(r.revisit) && `Revisit: ${clean(r.revisit)}`,
    link && `Transcript: ${link}`,
  ].filter(Boolean).join('\n');
}

/** The line appended to the sheet's Notes cell. */
function sheetLine(r, date, tz) {
  const what = clean(r.one_line) || clean(r.reason);
  return `${md(date, tz)} call: ${what.replace(/\.$/, '')}, next: ${(clean(r.next_step) || 'none agreed').replace(/\.$/, '')}`;
}

/** Last Touch, Touches So Far and Notes on the sheet show the call. */
async function markCallOnSheet(lead, t, id, r) {
  const { FieldValue } = require('firebase-admin').firestore;
  const mins = Math.round(Number(t.duration) || 0);
  const label = `${md(t.date, lead.tz)} Call${mins ? `, ${mins} min` : ''}`;
  await db.collection('ad_leads').doc(lead.email).update({
    last_touch_at: new Date(t.date), last_touch_label: label, sheet_dirty: true,
    timeline: FieldValue.arrayUnion({ at: new Date(t.date), kind: 'call', text: label, transcript: id }),
  });
  try {
    await db.collection('postcall_claims').doc(`${id}_sheet`).create({ at: new Date(), email: lead.email });
  } catch {
    return; // Notes line already written for this transcript
  }
  const ok = await require('./adLeadsSheet').appendNote({ email: cadence.realEmail(lead), phone: lead.phone, line: sheetLine(r, t.date, lead.tz) });
  if (ok === null) await db.collection('postcall_claims').doc(`${id}_sheet`).delete().catch(() => {});
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
      if (text && text.length > 200) r = await claudeJSON(prompt(lead, text, t.date), { maxTokens: 900, timeout: 180000 });
      await ref.update({ calls_read: FieldValue.arrayUnion(doc.id) });
      const link = t.transcript_url ? `\n${t.transcript_url}` : '';
      if (!LABEL[r.outcome] || (r.outcome === 'meeting' && isNaN(new Date(r.meeting_at)))) {
        await ref.update({ timeline: FieldValue.arrayUnion({ at: new Date(), kind: 'note', text: `Call read, outcome unclear: ${r.reason || ''}` }) });
        await cadence.ping(`📞 Call with <b>${cadence.esc(cadence.fullName(lead))}</b>: I couldn't tell the outcome (${cadence.esc(r.reason || 'unclear')}). Set it on the Ad Leads page: ${cadence.DASHBOARD_URL()}${link}`);
        out.asked++;
        continue;
      }
      await cadence.setOutcome(lead.email, r.outcome, { meeting_at: r.outcome === 'meeting' ? r.meeting_at : undefined, source: 'set from call transcript', note: callNote(r, t.transcript_url) });
      await cadence.ping(`📞 Call with <b>${cadence.esc(cadence.fullName(lead))}</b>: set to <b>${LABEL[r.outcome]}</b>${r.outcome === 'meeting' ? ` (${cadence.esc(new Date(r.meeting_at).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} ET)` : ''}. ${cadence.esc(r.reason || '')}\nWrong? Change it on the Ad Leads page: ${cadence.DASHBOARD_URL()}${link}`);
      await markCallOnSheet(lead, t, doc.id, r).catch(e => console.warn(`[cadenceCalls] sheet for ${lead.email}:`, e.message));
      out.set++;
    } catch (e) {
      // Not marked read, so the next run tries again.
      console.warn(`[cadenceCalls] ${lead.email} transcript ${doc.id}:`, e.message);
    }
  }
  return out;
}

module.exports = { checkCalls, matchLead, prompt, callNote, sheetLine, markCallOnSheet };
