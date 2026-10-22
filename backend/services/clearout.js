// services/clearout.js — one email at a time through Clearout's instant verify.
// The ad lead cadence never emails an address that hasn't passed this
// (Vincent, 10/22, after a bounce). Bulk list cleaning is routes/cleaner.js.

const API_KEY = () => process.env.CLEAROUT_API_KEY;
const BASE = 'https://api.clearout.io/v2';

const isConfigured = () => !!API_KEY();

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
  const d = body.data;
  return {
    status: String(d.status || 'unknown').toLowerCase(),
    sub_status: d.sub_status ? d.sub_status.code : null,
    desc: d.sub_status ? d.sub_status.desc : '',
    safe_to_send: d.safe_to_send || '',
    at: new Date(),
  };
}

module.exports = { isConfigured, verifyEmail };
