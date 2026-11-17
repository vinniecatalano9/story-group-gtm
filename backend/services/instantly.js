const API_BASE = 'https://api.instantly.ai/api/v2';
const API_KEY = () => process.env.INSTANTLY_API_KEY;

const CAMPAIGN_MAP = {
  priority: () => process.env.INSTANTLY_CAMPAIGN_PRIORITY,
  standard: () => process.env.INSTANTLY_CAMPAIGN_STANDARD,
  nurture: () => process.env.INSTANTLY_CAMPAIGN_NURTURE,
};

async function apiCall(method, path, body = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const opts = {
        method,
        headers: {
          'Authorization': `Bearer ${API_KEY()}`,
          'Content-Type': 'application/json',
        },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${API_BASE}${path}`, opts);
      if (res.status === 429 && i < retries - 1) {
        console.log(`[instantly] Rate limited, retrying in ${(i + 1) * 5}s...`);
        await new Promise(r => setTimeout(r, (i + 1) * 5000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Instantly ${method} ${path} failed (${res.status}): ${text}`);
      }
      return res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.error(`[instantly] Attempt ${i + 1} failed:`, e.message);
    }
  }
}

async function addLeadsToCampaign(tier, leads) {
  const campaignId = CAMPAIGN_MAP[tier]?.();
  if (!campaignId || campaignId === 'CAMPAIGN_ID_HERE') {
    console.warn(`[instantly] No campaign ID for tier: ${tier}, skipping upload`);
    return null;
  }

  // Batch in groups of 100
  const batchSize = parseInt(process.env.MAX_INSTANTLY_BATCH_SIZE) || 100;
  const results = [];
  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);
    const payload = {
      campaign_id: campaignId,
      leads: batch.map(l => ({
        email: l.email,
        first_name: l.first_name,
        last_name: l.last_name,
        company_name: l.company_name,
        custom_variables: {
          companyName: l.company_name,
          firstName: l.first_name,
          industry: l.detected_industry || '',
          signal: l.signal_summary || '',
          signalType: l.signal_type || '',
          companyDescription: l.company_description || '',
        },
      })),
    };
    const result = await apiCall('POST', '/leads', payload);
    results.push(result);
  }
  return results;
}

async function removeLeads(emails, campaignId = null) {
  const body = { delete_list: emails };
  if (campaignId) body.campaign_id = campaignId;
  return apiCall('DELETE', '/leads', body);
}

async function getESGFlaggedLeads(campaignId) {
  try {
    const res = await apiCall('GET', `/leads?campaign_id=${campaignId}&esg_flagged=true`);
    return res?.leads || [];
  } catch {
    return [];
  }
}

async function getCampaigns() {
  return apiCall('GET', '/campaigns');
}

async function getCampaignLeads(campaignId, { status, limit = 500 } = {}) {
  let path = `/leads?campaign_id=${campaignId}&limit=${limit}`;
  if (status) path += `&status=${status}`;
  return apiCall('GET', path);
}

async function getCampaignAnalytics() {
  return apiCall('GET', '/campaigns/analytics');
}

/**
 * Reply to an email thread via Instantly API v2.
 * @param {string} replyToUuid - The UUID of the email to reply to
 * @param {string} eaccount - The sending email account connected to Instantly
 * @param {string} body - The reply body text
 */
async function replyToEmail(replyToUuid, eaccount, body, subject = 'Re:') {
  return apiCall('POST', '/emails/reply', {
    reply_to_uuid: replyToUuid,
    eaccount,
    subject,
    body: { text: body },
  });
}

// Get all lead labels (interest statuses) defined in Instantly
async function getLeadLabels() {
  try {
    const res = await apiCall('GET', '/lead-labels?limit=100');
    return res?.items || [];
  } catch (e) {
    console.warn('[instantly] getLeadLabels failed:', e.message);
    return [];
  }
}

// Get replied leads (status=3) for a campaign — these are the ones you interact with
async function getRepliedLeads(campaignId, limit = 100) {
  try {
    const res = await apiCall('POST', '/leads/list', { campaign_id: campaignId, status: 3, limit });
    return res?.items || [];
  } catch (e) {
    console.warn(`[instantly] getRepliedLeads failed:`, e.message);
    return [];
  }
}

// Get all replied leads across all campaigns
async function getAllRepliedLeads() {
  try {
    const campaignsRes = await getCampaigns();
    const campList = campaignsRes?.items || [];
    const allLeads = [];
    for (const c of campList) {
      const leads = await getRepliedLeads(c.id);
      leads.forEach(l => { l.campaign_name = c.name; });
      allLeads.push(...leads);
    }
    return allLeads;
  } catch (e) {
    console.warn('[instantly] getAllRepliedLeads failed:', e.message);
    return [];
  }
}

// Get subsequence entries (leads enrolled in a subsequence)
async function getSubsequenceEntries(subsequenceId, limit = 100) {
  try {
    const res = await apiCall('GET', `/subsequences/entries?subsequence_id=${subsequenceId}&limit=${limit}`);
    return res?.items || [];
  } catch (e) {
    console.warn('[instantly] getSubsequenceEntries failed:', e.message);
    return [];
  }
}

// Get subsequences for a campaign
async function getSubsequences(campaignId) {
  try {
    const res = await apiCall('GET', `/subsequences?parent_campaign=${campaignId}`);
    return res?.items || [];
  } catch (e) {
    console.warn('[instantly] getSubsequences failed:', e.message);
    return [];
  }
}

// Add a lead to a subsequence
async function addLeadToSubsequence(email, subsequenceId, campaignId) {
  return apiCall('POST', '/subsequences/entries', {
    subsequence_id: subsequenceId,
    lead_email: email,
    campaign_id: campaignId,
  });
}

// Move lead interest status
async function updateLeadInterestStatus(email, interestStatus, campaignId = null) {
  const body = { email, interest_status: interestStatus };
  if (campaignId) body.campaign_id = campaignId;
  return apiCall('PATCH', '/leads', body);
}

// ----- Cross-channel stop helpers (services/crossChannel.js) -----

// Read only. The lead record for one email inside one campaign, or null.
async function findLeadInCampaign(email, campaignId) {
  if (!email || !campaignId) return null;
  const res = await apiCall('POST', '/leads/list', { campaign: campaignId, contacts: [email], limit: 5 });
  const want = String(email).toLowerCase();
  return (res?.items || []).find(l =>
    String(l.email || '').toLowerCase() === want && String(l.campaign || '').toLowerCase() === String(campaignId).toLowerCase()
  ) || null;
}

// The id of the lead list with this exact name; makes it if it does not exist.
let leadListCache = {};
async function findOrCreateLeadList(name) {
  if (leadListCache[name]) return leadListCache[name];
  const found = await apiCall('GET', `/lead-lists?limit=20&search=${encodeURIComponent(name)}`);
  let list = (found?.items || []).find(l => l.name === name);
  if (!list) list = await apiCall('POST', '/lead-lists', { name });
  if (!list?.id) throw new Error(`Instantly lead list "${name}" has no id`);
  leadListCache[name] = list.id;
  return list.id;
}

// Takes ONE lead out of a campaign and puts it in a lead list. The record and
// its history are kept (this is a move, not a delete) and it can be moved back.
// `ids` plus `campaign` picks the lead; `limit: 1` means that even if Instantly
// ever ignored `ids`, one lead is the most this call could move.
async function moveLeadToList(leadId, campaignId, listId) {
  if (!leadId || !campaignId || !listId) throw new Error('moveLeadToList needs a lead id, a campaign id and a list id');
  return apiCall('POST', '/leads/move', { ids: [leadId], campaign: campaignId, to_list_id: listId, limit: 1 });
}

module.exports = {
  findLeadInCampaign, findOrCreateLeadList, moveLeadToList,
  addLeadsToCampaign, removeLeads, getESGFlaggedLeads,
  getCampaigns, getCampaignLeads, getCampaignAnalytics,
  replyToEmail, getLeadLabels, getRepliedLeads, getAllRepliedLeads,
  getSubsequences, addLeadToSubsequence, updateLeadInterestStatus,
  getSubsequenceEntries,
};
