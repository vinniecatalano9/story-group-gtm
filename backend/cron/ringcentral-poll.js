const ringcentral = require('../services/ringcentral');
const fireflies = require('../services/fireflies');
const { db, leads } = require('../services/db');

const rcCalls = db.collection('ringcentral_calls');

// Look back this far each run. Calls already handed off are skipped by id.
const LOOKBACK_HOURS = () => Number(process.env.RINGCENTRAL_LOOKBACK_HOURS || 24);
// Skip voicemail-length and dropped calls — not worth a transcript.
const MIN_SECONDS = () => Number(process.env.RINGCENTRAL_MIN_SECONDS || 60);
const MY_EMAIL = () => process.env.SMTP_USER || 'vincent@storygroup.io';

/** Common ways a US number gets stored, so a Firestore `in` query can match it. */
function phoneVariants(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return raw ? [String(raw)] : [];
  const [a, b, c] = [ten.slice(0, 3), ten.slice(3, 6), ten.slice(6)];
  return [...new Set([String(raw), `+1${ten}`, `1${ten}`, ten, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `+1 ${a}-${b}-${c}`, `+1 (${a}) ${b}-${c}`])].slice(0, 10);
}

/** Lead with this phone number, if we have one. Returns { email, name } or null. */
async function matchLeadByPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const snap = await leads.where('phone', 'in', variants).limit(1).get();
  if (snap.empty) return null;
  const l = snap.docs[0].data();
  return {
    email: l.email || null,
    name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.name || null,
    company: l.company || l.company_name || null,
  };
}

/**
 * Poll RingCentral for recorded calls and send each new one to Fireflies.
 * Fireflies transcribes it, then the Fireflies webhook/poll stores it,
 * matches the prospect, and drafts the follow-up like any other call.
 */
async function pollRingCentral() {
  if (!ringcentral.isConfigured()) return { skipped: 'no RINGCENTRAL_CLIENT_ID / SECRET / JWT' };
  if (!process.env.FIREFLIES_API_KEY) return { skipped: 'no FIREFLIES_API_KEY (needed to transcribe)' };

  const dateFrom = new Date(Date.now() - LOOKBACK_HOURS() * 36e5).toISOString();
  const calls = await ringcentral.getRecordedCalls(dateFrom);
  let sent = 0, skipped = 0;

  for (const call of calls) {
    const recId = String(call.recording.id);
    const ref = rcCalls.doc(recId);
    try {
      if ((await ref.get()).exists) continue;

      if ((call.duration || 0) < MIN_SECONDS()) {
        await ref.set({ status: 'skipped_short', duration: call.duration, start_time: call.startTime, created_at: new Date() });
        skipped++;
        continue;
      }

      const other = call.direction === 'Inbound' ? call.from : call.to;
      const otherPhone = other?.phoneNumber || null;
      const match = otherPhone ? await matchLeadByPhone(otherPhone) : null;
      const who = match?.name || other?.name || otherPhone || 'Unknown caller';
      const when = new Date(call.startTime).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });

      // Vincent's email marks it as "my call" so it shows on the Transcripts page;
      // the matched lead's email is what lets the follow-up draft get written.
      const attendees = [{ displayName: 'Vincent Catalano', email: MY_EMAIL() }];
      if (match?.email || otherPhone) {
        attendees.push({
          displayName: who,
          ...(match?.email ? { email: match.email } : {}),
          ...(otherPhone ? { phoneNumber: otherPhone } : {}),
        });
      }

      const title = `RingCentral call: ${who}${match?.company ? ` (${match.company})` : ''} · ${call.direction} · ${when}`;
      const r = await fireflies.uploadAudio({
        url: call.recording.contentUri,
        bearerToken: await ringcentral.getToken(),
        title,
        attendees,
        meetingDate: call.startTime,
        clientReferenceId: `rc_${recId}`,
      });
      if (!r?.success) throw new Error(r?.message || 'Fireflies upload failed');

      await ref.set({
        status: 'sent_to_fireflies',
        title,
        session_id: call.sessionId || null,
        call_id: call.id,
        direction: call.direction,
        duration: call.duration,
        start_time: call.startTime,
        other_phone: otherPhone,
        other_name: other?.name || null,
        matched_email: match?.email || null,
        created_at: new Date(),
      });
      sent++;
      console.log(`[ringcentral-poll] Sent to Fireflies: ${title}${match?.email ? ` → ${match.email}` : ' (no lead match)'}`);
    } catch (e) {
      // Not stored, so the next run retries it.
      console.error(`[ringcentral-poll] Failed on recording ${recId}:`, e.message);
    }
  }

  if (sent || skipped) console.log(`[ringcentral-poll] Done: ${sent} sent to Fireflies, ${skipped} too short`);
  return { calls_with_recordings: calls.length, sent, skipped };
}

module.exports = { pollRingCentral, phoneVariants };
