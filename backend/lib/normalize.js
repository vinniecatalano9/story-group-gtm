const { v4: uuidv4 } = require('uuid');

const SUFFIXES = /\s*,?\s*(Inc\.?|LLC|Corp\.?|Ltd\.?|Co\.?|LP|LLP|PLC|GmbH|S\.?A\.?|Pty\.?\s*Ltd\.?)$/i;

function cleanCompanyName(name) {
  if (!name) return '';
  return name.replace(SUFFIXES, '').trim();
}

const TITLE_MAP = {
  'ceo': 'CEO',
  'chief executive officer': 'CEO',
  'cfo': 'CFO',
  'chief financial officer': 'CFO',
  'cto': 'CTO',
  'chief technology officer': 'CTO',
  'coo': 'COO',
  'chief operating officer': 'COO',
  'cmo': 'CMO',
  'chief marketing officer': 'CMO',
  'cro': 'CRO',
  'chief revenue officer': 'CRO',
  'vp': 'VP',
  'vice president': 'VP',
};

function normalizeTitle(title) {
  if (!title) return '';
  const lower = title.toLowerCase().trim();
  for (const [key, val] of Object.entries(TITLE_MAP)) {
    if (lower === key || lower.startsWith(key + ' ')) return title.replace(new RegExp(key, 'i'), val);
  }
  return title.trim();
}

function cleanDomain(domain) {
  if (!domain) return '';
  return domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  return email && EMAIL_RE.test(email.trim().toLowerCase());
}

function normalizeLead(raw, source, campaignTag) {
  return {
    lead_id: raw.lead_id || uuidv4(),
    first_name: (raw.first_name || raw.firstName || '').trim(),
    last_name: (raw.last_name || raw.lastName || '').trim(),
    email: (raw.email || '').trim().toLowerCase(),
    company_name: cleanCompanyName(raw.company_name || raw.companyName || raw.company || ''),
    company_domain: cleanDomain(raw.company_domain || raw.domain || raw.website || ''),
    role_title: normalizeTitle(raw.role_title || raw.title || raw.position || ''),
    linkedin_url: (raw.linkedin_url || raw.linkedinUrl || raw.linkedin || '').trim(),
    source: source || raw.source || 'manual',
    campaign_tag: campaignTag || raw.campaign_tag || '',
    status: 'ingested',
    score: null,
    tier: null,
    signal_type: null,
    signal_strength: null,
    signal_summary: null,
    company_description: null,
    detected_industry: null,
    instantly_campaign_id: null,
    hubspot_contact_id: null,
  };
}

module.exports = { normalizeLead, cleanCompanyName, normalizeTitle, cleanDomain, validateEmail };
