const API_BASE = 'https://app.coteriehq.net/api/v1';
const API_KEY = () => process.env.COTERIEHQ_API_KEY;

async function apiCall(method, path, body = null) {
  const key = API_KEY();
  if (!key || key === 'REPLACE_ME') {
    console.log('[coteriehq] No API key configured, skipping');
    return null;
  }
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    console.error(`[coteriehq] ${method} ${path} failed (${res.status}): ${text}`);
    return null;
  }
  return res.json();
}

// ── Contacts ──

async function listContacts(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiCall('GET', `/contacts${qs ? '?' + qs : ''}`);
}

async function getContact(id) {
  return apiCall('GET', `/contacts/${id}`);
}

async function createContact(data) {
  return apiCall('POST', '/contacts', data);
}

async function updateContact(id, data) {
  return apiCall('PATCH', `/contacts/${id}`, data);
}

async function findContactByEmail(email) {
  const result = await listContacts({ email });
  const contacts = result?.data || [];
  return contacts[0] || null;
}

// ── Companies ──

async function createCompany(data) {
  return apiCall('POST', '/companies', data);
}

async function listCompanies(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiCall('GET', `/companies${qs ? '?' + qs : ''}`);
}

// ── Deals ──

async function createDeal(data) {
  return apiCall('POST', '/deals', data);
}

async function updateDeal(id, data) {
  return apiCall('PATCH', `/deals/${id}`, data);
}

async function listDeals(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiCall('GET', `/deals${qs ? '?' + qs : ''}`);
}

/**
 * Sync a lead to CoterieHQ — create or update contact.
 * Maps GTM lead fields to CoterieHQ contact fields.
 */
async function syncLead(lead) {
  const contactData = {
    name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.full_name || lead.email,
    email: lead.email,
    phone: lead.phone || undefined,
    type: 'lead',
  };

  // Try to find existing contact by email
  const existing = await findContactByEmail(lead.email);
  if (existing) {
    const updated = await updateContact(existing.id, contactData);
    console.log(`[coteriehq] Updated contact ${existing.id} for ${lead.email}`);
    return { action: 'updated', contactId: existing.id, data: updated };
  } else {
    const created = await createContact(contactData);
    console.log(`[coteriehq] Created contact for ${lead.email}`);
    return { action: 'created', contactId: created?.data?.id, data: created };
  }
}

/**
 * Sync a reply/meeting to CoterieHQ — update contact + optionally create a deal.
 */
async function syncReply(reply, options = {}) {
  const key = API_KEY();
  if (!key || key === 'REPLACE_ME') return null;

  // First ensure the contact exists
  const syncResult = await syncLead(reply);
  if (!syncResult?.contactId) return syncResult;

  // If they had a meeting or booked, create a deal
  if (options.createDeal && (reply.had_meeting || reply.status === 'booked')) {
    const dealData = {
      name: `${reply.full_name || reply.email} - Story Group`,
      contact_id: syncResult.contactId,
      stage: reply.status === 'booked' ? 'qualified' : 'meeting',
    };
    const deal = await createDeal(dealData);
    console.log(`[coteriehq] Created deal for ${reply.email}`);
    return { ...syncResult, deal };
  }

  return syncResult;
}

module.exports = {
  listContacts,
  getContact,
  createContact,
  updateContact,
  findContactByEmail,
  createCompany,
  listCompanies,
  createDeal,
  updateDeal,
  listDeals,
  syncLead,
  syncReply,
};
