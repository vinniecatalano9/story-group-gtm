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

module.exports = { isConfigured, getToken, api, whoAmI, getRecordedCalls };
