const API_BASE = 'https://api.hubapi.com';
const API_KEY = () => process.env.HUBSPOT_API_KEY;

async function apiCall(method, path, body = null) {
  const key = API_KEY();
  if (!key || key === 'REPLACE_ME') {
    console.log('[hubspot] No API key configured, skipping');
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
    console.error(`[hubspot] ${method} ${path} failed (${res.status}): ${text}`);
    return null;
  }
  return res.json();
}

async function findContactByEmail(email) {
  const result = await apiCall('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{
      filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
    }],
    limit: 1,
  });
  return result?.results?.[0] || null;
}

async function createContact(properties) {
  return apiCall('POST', '/crm/v3/objects/contacts', { properties });
}

async function updateContact(contactId, properties) {
  return apiCall('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
}

/**
 * Sync a lead to HubSpot — create or update.
 * Returns { action: 'created'|'updated', contactId }
 */
async function syncLead(lead) {
  const properties = {
    email: lead.email,
    firstname: lead.first_name,
    lastname: lead.last_name,
    company: lead.company_name,
    jobtitle: lead.role_title,
    gtm_source: lead.source || '',
    gtm_campaign_tag: lead.campaign_tag || '',
    gtm_signal_type: lead.signal_type || '',
    gtm_signal_summary: lead.signal_summary || '',
    gtm_signal_strength: lead.signal_strength || '',
    gtm_lead_score: String(lead.score || 0),
    gtm_instantly_campaign: lead.tier || '',
    gtm_status: lead.status || '',
    gtm_enriched_at: lead.enriched_at || '',
  };

  const existing = await findContactByEmail(lead.email);
  if (existing) {
    await updateContact(existing.id, properties);
    return { action: 'updated', contactId: existing.id };
  } else {
    const created = await createContact(properties);
    return { action: 'created', contactId: created?.id };
  }
}

module.exports = { syncLead, findContactByEmail, createContact, updateContact };
