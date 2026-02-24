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

module.exports = {
  addLeadsToCampaign, removeLeads, getESGFlaggedLeads,
  getCampaigns, getCampaignLeads, getCampaignAnalytics,
};
