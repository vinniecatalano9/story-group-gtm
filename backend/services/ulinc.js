const ULINC_NEW_MSG_URL = () => process.env.ULINC_NEW_MESSAGE_URL;
const ULINC_CUSTOM_MSG_URL = () => process.env.ULINC_CUSTOM_MESSAGE_URL;

/**
 * Poll Ulinc for new LinkedIn messages.
 * Ulinc is poll-based: GET the webhook URL → returns array of new messages since last poll.
 */
async function pollNewMessages() {
  const url = ULINC_NEW_MSG_URL();
  if (!url) return [];

  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error('[ulinc] Poll failed:', res.status, await res.text());
      return [];
    }
    const data = await res.json();
    // Ulinc returns an array of message objects (or wrapped in a key)
    const messages = Array.isArray(data) ? data : (data.messages || data.data || []);
    // Filter out test payloads (contact_id = -1)
    return messages.filter(m => m.contact_id !== -1 && m.contact_id !== '-1');
  } catch (e) {
    console.error('[ulinc] Poll error:', e.message, e.cause?.code || '', e.cause?.message || '');
    return [];
  }
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
