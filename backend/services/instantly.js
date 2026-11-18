const API_BASE = 'https://api.instantly.ai/api/v2';
const API_KEY = () => process.env.INSTANTLY_API_KEY;
const mxProvider = require('../lib/mxProvider');
const clearout = require('./clearout');

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

// How long a saved Clearout result on the lead doc stays good (same as the ad lead cadence).
const CLEAROUT_RECHECK_DAYS = () => parseFloat(process.env.CLEAROUT_RECHECK_DAYS) || 30;
const CLEAROUT_CONCURRENCY = () => parseInt(process.env.CLEAROUT_GATE_CONCURRENCY) || 3;

function freshEmailCheck(lead) {
  const c = lead && lead.email_check;
  if (!c || !c.status || !c.at) return null;
  const at = typeof c.at.toDate === 'function' ? c.at.toDate() : new Date(c.at);
  if (isNaN(at) || Date.now() - at.getTime() > CLEAROUT_RECHECK_DAYS() * 86400000) return null;
  return c;
}

/**
 * Cold email gate. A lead goes into a cold email campaign only if it passes both checks:
 *
 * 1. Mail provider (Vincent, 2026-11-17): the email domain is hosted on Google or Microsoft.
 *    Everything else (Proofpoint, Mimecast, Barracuda, Sophos, small hosts, no MX, failed
 *    lookup) is LinkedIn only.
 * 2. Clearout (Vincent, 2026-10-22): the address is Clearout "valid". Invalid, catch-all,
 *    unknown, or a Clearout failure (down, no key, out of credits) means no cold email.
 *    Only leads that pass check 1 are sent to Clearout. A result saved on the lead doc
 *    (email_check) in the last 30 days is reused.
 *
 * Returns { allowed, blocked, checked }. Every lead passed in gets email_provider, email_mx,
 * cold_email_blocked and (when Clearout ran) email_check written to its Firestore doc.
 * Fails closed: if a check breaks, the lead is not allowed through.
 */
async function coldEmailGate(leads) {
  const rows = leads.map(lead => ({ lead, ok: false, provider: '', mx: '', reason: '', reason_key: '' }));

  // 1. Mail provider
  let checks = new Map();
  try {
    checks = await mxProvider.checkEmails(leads.map(l => l.email));
  } catch (e) {
    console.warn('[instantly] Mail provider check failed, blocking the whole batch:', e.message);
  }
  for (const row of rows) {
    const key = String(row.lead.email || '').trim().toLowerCase();
    const check = checks.get(key) || { provider: mxProvider.LOOKUP_FAILED, mx: '', ok: false };
    row.provider = check.provider;
    row.mx = check.mx || '';
    row.ok = check.ok;
    if (!check.ok) {
      row.reason_key = check.provider;
      row.reason = `Mail provider is ${check.provider}. Cold email goes to Google or Microsoft only. LinkedIn only.`;
    }
  }

  // 2. Clearout, only for leads that passed the provider check
  const toVerify = rows.filter(r => r.ok);
  let next = 0;
  const worker = async () => {
    while (next < toVerify.length) {
      const row = toVerify[next++];
      let check = freshEmailCheck(row.lead);
      if (!check) {
        try {
          check = await clearout.verifyEmail(String(row.lead.email).trim().toLowerCase(), 'cold_email_gate');
          row.email_check = check;
        } catch (e) {
          row.ok = false;
          row.email_check_error = e.message;
          row.reason_key = 'Clearout check failed';
          row.reason = `Clearout check failed (${e.message}). No cold email until the address is verified.`;
          console.warn(`[instantly] Clearout failed for ${row.lead.email}:`, e.message);
          continue;
        }
      }
      if (check.status !== 'valid') {
        row.ok = false;
        row.reason_key = `Clearout ${check.status}`;
        row.reason = `Clearout says ${check.status}${check.desc ? ` (${check.desc})` : ''}. Cold email goes to valid addresses only.`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLEAROUT_CONCURRENCY(), toVerify.length) }, worker));

  const blocked = rows.filter(r => !r.ok);

  // Mark the Firestore lead docs. A failed write warns and does not change the decision.
  let updateLead = null;
  let addLog = null;
  try {
    ({ updateLead, addLog } = require('./db'));
  } catch (e) {
    console.warn('[instantly] Could not load db to mark the cold email gate result:', e.message);
  }
  if (updateLead) {
    for (const row of rows) {
      const id = row.lead.id || row.lead.lead_id;
      if (!id) continue;
      const data = { email_provider: row.provider, email_mx: row.mx, cold_email_blocked: !row.ok };
      if (row.email_check) {
        data.email_check = row.email_check;
        data.email_check_error = null;
      }
      if (row.email_check_error) data.email_check_error = row.email_check_error;
      if (!row.ok) {
        data.cold_email_blocked_reason = row.reason;
        data.cold_email_blocked_at = new Date().toISOString();
      }
      try {
        await updateLead(id, data);
      } catch (e) {
        console.warn(`[instantly] Could not mark the cold email gate result on lead ${id}:`, e.message);
      }
    }
  }

  const summary = r => ({
    lead_id: r.lead.id || r.lead.lead_id || null,
    email: r.lead.email || '',
    email_provider: r.provider,
    email_mx: r.mx,
    clearout_status: (r.email_check || freshEmailCheck(r.lead) || {}).status || null,
    cold_email_blocked: !r.ok,
    reason: r.reason,
  });

  if (blocked.length) {
    const byReason = {};
    for (const r of blocked) byReason[r.reason_key] = (byReason[r.reason_key] || 0) + 1;
    console.warn(`[instantly] Cold email gate blocked ${blocked.length} of ${leads.length} lead(s): ${JSON.stringify(byReason)}`);
    if (addLog) {
      try {
        await addLog('cold_email_blocked', {
          count: blocked.length,
          checked: leads.length,
          by_reason: byReason,
          leads: blocked.map(summary),
        });
      } catch (e) {
        console.warn('[instantly] Could not log blocked leads:', e.message);
      }
    }
  }

  return {
    allowed: rows.filter(r => r.ok).map(r => r.lead),
    blocked: blocked.map(summary),
    checked: rows.map(summary),
  };
}

/**
 * Add leads to a tier's cold email campaign. Every lead goes through coldEmailGate first.
 * Returns the upload results, or null when nothing was uploaded (no campaign for the tier,
 * or every lead was blocked by the gate). Pass an object as `report` to get the gate's
 * { blocked, checked } lists back.
 */
async function addLeadsToCampaign(tier, leads, report = null) {
  const campaignId = CAMPAIGN_MAP[tier]?.();
  if (!campaignId || campaignId === 'CAMPAIGN_ID_HERE') {
    console.warn(`[instantly] No campaign ID for tier: ${tier}, skipping upload`);
    return null;
  }

  const gate = await coldEmailGate(leads || []);
  if (report) Object.assign(report, { blocked: gate.blocked, checked: gate.checked });
  leads = gate.allowed;
  if (!leads.length) return null;

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
    body: { text: body, html: String(body).split(/\n{2,}/).map(par => `<p>${par.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('') },
  }, 1); // one try only: a retried send could email the prospect twice
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
  addLeadsToCampaign, coldEmailGate, removeLeads, getESGFlaggedLeads,
  getCampaigns, getCampaignLeads, getCampaignAnalytics,
  replyToEmail, getLeadLabels, getRepliedLeads, getAllRepliedLeads,
  getSubsequences, addLeadToSubsequence, updateLeadInterestStatus,
  getSubsequenceEntries,
};
