const https = require('https');

const ULINC_NEW_MSG_URL = () => process.env.ULINC_NEW_MESSAGE_URL;
const ULINC_CUSTOM_MSG_URL = () => process.env.ULINC_CUSTOM_MESSAGE_URL;

/**
 * Poll Ulinc for new LinkedIn messages.
 * Uses https module instead of fetch for PM2 compatibility.
 */
async function pollNewMessages() {
  const url = ULINC_NEW_MSG_URL();
  if (!url) return [];

  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const messages = Array.isArray(data) ? data : (data.messages || data.data || []);
          resolve(messages.filter(m => m.contact_id !== -1 && m.contact_id !== '-1'));
        } catch (e) {
          console.error('[ulinc] Poll parse error:', e.message, body.substring(0, 100));
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.error('[ulinc] Poll error:', e.message, e.code || '');
      resolve([]);
    });
    req.on('timeout', () => {
      console.error('[ulinc] Poll timeout');
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * Send a message back through Ulinc (LinkedIn, email, or SMS).
 */
async function sendMessage(contactId, message, { method = 'linkedin' } = {}) {
  const url = ULINC_CUSTOM_MSG_URL();
  if (!url) throw new Error('ULINC_CUSTOM_MESSAGE_URL not configured');

  const body = { contact_id: contactId, message };
  if (method !== 'linkedin') body.method = method;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ulinc send failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Get full conversation history for a contact.
 * Uses the "Complete conversation" webhook if configured.
 */
async function getConversation(contactId) {
  const url = process.env.ULINC_CONVERSATION_URL;
  if (!url) return null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    console.warn('[ulinc] Conversation fetch failed:', e.message);
    return null;
  }
}

module.exports = { pollNewMessages, sendMessage, getConversation };
