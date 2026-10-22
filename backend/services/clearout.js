// services/clearout.js — one email at a time through Clearout's instant verify.
// The ad lead cadence never emails an address that hasn't passed this
// (Vincent, 10/22, after a bounce). Bulk list cleaning is routes/cleaner.js.

const API_KEY = () => process.env.CLEAROUT_API_KEY;
const BASE = 'https://api.clearout.io/v2';

const isConfigured = () => !!API_KEY();

// ── Daily usage (Vincent, 10/22) ─────────────────────────────────────────────
// Clearout has no usage API for this unlimited plan (account/credits reads 0),
// so we count our own calls per Central-time day in Firestore clearout_usage:
// cadence checks plus rows in cleaner bulk uploads. Checks made on the website
// aren't counted. Alert once a day past ALERT_AT; never blocks anything.
const ALERT_AT = () => Number(process.env.CLEAROUT_ALERT_AT || 3000);
const dayCT = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

async function recordUsage(n, source) {
  if (!(n > 0)) return;
  try {
    const { db } = require('./db');
    const { FieldValue } = require('firebase-admin').firestore;
    await db.collection('clearout_usage').doc(dayCT()).set({ count: FieldValue.increment(n), [`by.${source}`]: FieldValue.increment(n), updated_at: new Date() }, { merge: true });
  } catch (e) {
    console.warn('[clearout] usage count failed:', e.message);
  }
}

/** Called from the cadence's 10-minute run. Telegram once a day past the line. */
async function checkUsageAlert() {
  const { db } = require('./db');
  const ref = db.collection('clearout_usage').doc(dayCT());
  const u = (await ref.get()).data();
  if (!u || u.count < ALERT_AT() || u.alerted_at) return null;
  const { sendTelegram } = require('./telegram');
  const by = Object.entries(u.by || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  await sendTelegram(`Clearout: ${ALERT_AT().toLocaleString()}+ checks today (${u.count.toLocaleString()} so far${by ? `: ${by}` : ''}). Was this you? Website checks aren't in this count.`);
  await ref.update({ alerted_at: new Date() });
  return u.count;
}

/**
 * Verify one address. Returns { status, sub_status, desc, safe_to_send, at }
 * where status is valid | invalid | catch_all | unknown | ... (Clearout's).
 * Throws on an API failure or no credits (err.credits = true), never guesses.
 */
async function verifyEmail(email) {
  if (!isConfigured()) throw new Error('CLEAROUT_API_KEY is not set on the server');
  const res = await fetch(`${BASE}/email_verify/instant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
    body: JSON.stringify({ email, timeout: 30000 }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'success' || !body.data) {
    const msg = (body.error && (body.error.message || body.error)) || body.message || res.statusText;
    const err = new Error(`Clearout ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.credits = res.status === 402 || /credit/i.test(err.message);
    throw err;
  }
  await recordUsage(1, 'cadence');
  const d = body.data;
  return {
    status: String(d.status || 'unknown').toLowerCase(),
    sub_status: d.sub_status ? d.sub_status.code : null,
    desc: d.sub_status ? d.sub_status.desc : '',
    safe_to_send: d.safe_to_send || '',
    at: new Date(),
  };
}

module.exports = { isConfigured, verifyEmail, recordUsage, checkUsageAlert };
