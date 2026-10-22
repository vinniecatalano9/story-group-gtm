// RingCentral REST API, JWT auth (server-only app, acts as Vincent's extension).
// .env: RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT
// Optional: RINGCENTRAL_SERVER (default production; sandbox is
// https://platform.devtest.ringcentral.com)
const CLIENT_ID = () => process.env.RINGCENTRAL_CLIENT_ID;
const CLIENT_SECRET = () => process.env.RINGCENTRAL_CLIENT_SECRET;
const JWT = () => process.env.RINGCENTRAL_JWT;
const SERVER = () => (process.env.RINGCENTRAL_SERVER || 'https://platform.ringcentral.com').replace(/\/$/, '');

let _token = null; // { access_token, expires_at }

function isConfigured() {
  return !!(CLIENT_ID() && CLIENT_SECRET() && JWT());
}

/** Access token, cached until ~1 min before expiry (token calls are rate limited). */
async function getToken() {
  if (_token && Date.now() < _token.expires_at) return _token.access_token;
  const res = await fetch(`${SERVER()}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: JWT(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RingCentral auth ${res.status}: ${data.error_description || data.message || res.statusText}`);
  _token = {
    access_token: data.access_token,
    expires_at: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
  };
  return _token.access_token;
}

async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SERVER()}${path}${qs ? `?${qs}` : ''}`, {
    headers: { 'Authorization': `Bearer ${await getToken()}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RingCentral ${path} ${res.status}: ${data.message || data.errorCode || res.statusText}`);
  return data;
}

/** Who the JWT belongs to. Used by the status endpoint to prove auth works. */
async function whoAmI() {
  const ext = await api('/restapi/v1.0/account/~/extension/~');
  return { id: ext.id, name: ext.name, extensionNumber: ext.extensionNumber, email: ext.contact?.email };
}

/**
 * Calls on Vincent's extension that have a recording, since dateFrom (ISO).
 * Auto call recording must be on in the Admin Portal or nothing comes back.
 */
async function getRecordedCalls(dateFrom) {
  const data = await api('/restapi/v1.0/account/~/extension/~/call-log', {
    withRecording: 'true',
    view: 'Detailed',
    type: 'Voice',
    dateFrom,
    perPage: '100',
  });
  return (data.records || []).filter(r => r.recording?.contentUri);
}

// ── SMS ──────────────────────────────────────────────────────────────────────
// Needs the SMS and Read Messages scopes on the RingCentral app (developer
// console > the app > Settings > Application scopes). Until they're added the
// API answers 403 and these return null with a warning; nothing crashes.

const SMS_FROM = () => process.env.RINGCENTRAL_SMS_FROM; // optional; else the extension's SMS-capable number
let _smsFrom = null;

async function post(path, body) {
  const res = await fetch(`${SERVER()}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`RingCentral ${path} ${res.status}: ${data.message || data.errorCode || res.statusText}`);
    err.status = res.status;
    err.code = data.errorCode;
    throw err;
  }
  return data;
}

const scopeMissing = e => e && (e.status === 403 || /InsufficientPermissions|\b403\b/.test(e.message));

/** "+15125551234" from any US format, or null. Fake 555-5555 style numbers count as none. */
function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10 || /^[01]/.test(ten) || /5555555$/.test(ten) || ten.slice(3, 6) === '555' && ten.slice(6, 8) === '01') return null;
  return `+1${ten}`;
}

/** The registered (10DLC) number texts go out from. */
async function smsFromNumber() {
  if (SMS_FROM()) return toE164(SMS_FROM()) || SMS_FROM();
  if (_smsFrom) return _smsFrom;
  const data = await api('/restapi/v1.0/account/~/extension/~/phone-number', { perPage: '100' });
  const n = (data.records || []).find(r => (r.features || []).includes('SmsSender'));
  if (!n) throw new Error('No SMS-capable number on this extension (set RINGCENTRAL_SMS_FROM)');
  _smsFrom = n.phoneNumber;
  return _smsFrom;
}

/** Send one text. Returns the message record, or null when SMS isn't set up yet. */
async function sendSms(to, text) {
  if (!isConfigured()) { console.warn('[ringcentral] not configured: text not sent'); return null; }
  const num = toE164(to);
  if (!num) throw new Error(`Not a textable number: ${to}`);
  try {
    return await post('/restapi/v1.0/account/~/extension/~/sms', {
      from: { phoneNumber: await smsFromNumber() },
      to: [{ phoneNumber: num }],
      text,
    });
  } catch (e) {
    if (scopeMissing(e)) { console.warn('[ringcentral] SMS scope missing on the app: text not sent.', e.message); return null; }
    throw e;
  }
}

/**
 * Inbound texts since dateFrom (ISO), oldest first: [{ id, from, text, at }].
 * Returns null (not []) when the Read Messages scope is missing, so callers can
 * tell "no texts" from "can't look".
 */
async function getInboundSms(dateFrom) {
  if (!isConfigured()) return null;
  try {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const data = await api('/restapi/v1.0/account/~/extension/~/message-store', {
        messageType: 'SMS', direction: 'Inbound', dateFrom, perPage: '100', page: String(page),
      });
      for (const m of data.records || []) {
        out.push({ id: String(m.id), from: m.from && m.from.phoneNumber, text: m.subject || '', at: m.creationTime });
      }
      if (!data.navigation || !data.navigation.nextPage) break;
    }
    return out.sort((a, b) => new Date(a.at) - new Date(b.at));
  } catch (e) {
    if (scopeMissing(e)) { console.warn('[ringcentral] Read Messages scope missing: inbound texts unreadable.', e.message); return null; }
    throw e;
  }
}

/** Can this app send and read texts yet? For the status endpoint. */
async function smsStatus() {
  if (!isConfigured()) return { configured: false };
  const out = { configured: true };
  try { out.from = await smsFromNumber(); } catch (e) { out.from_error = e.message; }
  try {
    await api('/restapi/v1.0/account/~/extension/~/message-store', { messageType: 'SMS', perPage: '1' });
    out.read_messages = true;
  } catch (e) { out.read_messages = false; out.read_error = e.message; }
  return out;
}

/**
 * Any call with this number since `since` (ISO): finished calls in the call
 * log, or one in progress right now. For the meeting no-show check.
 */
async function hadCallWith(phone, since) {
  const num = toE164(phone);
  if (!num || !isConfigured()) return null;
  const log = await api('/restapi/v1.0/account/~/extension/~/call-log', { phoneNumber: num.replace('+', ''), dateFrom: since, perPage: '20' });
  if ((log.records || []).some(r => (r.duration || 0) > 0)) return true;
  const live = await api('/restapi/v1.0/account/~/extension/~/active-calls', { perPage: '20' }).catch(() => ({ records: [] }));
  return (live.records || []).some(r => [r.from && r.from.phoneNumber, r.to && r.to.phoneNumber].includes(num));
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|stop all|remove me|opt out|optout)\s*[.!]?\s*$/i;
const isStop = text => STOP_WORDS.test(String(text || ''));

module.exports = { isConfigured, getToken, api, whoAmI, getRecordedCalls, sendSms, getInboundSms, smsStatus, toE164, isStop, hadCallWith };
