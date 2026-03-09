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

/**
 * Simplify display names for outreach copy.
 * Strips legal suffixes, cleans up PAC/committee names, title-cases.
 *
 * "ISAAC COMMUNICATIONS, INC." → "Isaac Communications"
 * "Friends of Wilton Simpson" → "Wilton Simpson's campaign"
 * "Florida Republican Senatorial Campaign Committee" → "FL Republican Senatorial Campaign"
 * "Building On Your Dreams Political Committee" → "Building On Your Dreams PAC"
 */
function simplifyName(name, type = 'company') {
  if (!name) return '';
  let s = name.trim();

  if (type === 'candidate' || type === 'pac') {
    // Strip trailing (REP), (DEM), (PAC) codes if still present
    s = s.replace(/\s*\([A-Z]{2,4}\)\s*$/, '');
    // "Friends of X" → "X's campaign"
    const friendsMatch = s.match(/^Friends\s+of\s+(.+)/i);
    if (friendsMatch) return titleCase(friendsMatch[1].trim()) + "'s campaign";
    // "X for Y" patterns (e.g., "Jared Ramsey for US Senate") → keep as-is but title case
    const forMatch = s.match(/^(.+)\s+for\s+(.+)/i);
    if (forMatch) return titleCase(forMatch[1].trim()) + "'s campaign";
    // Strip "Political Committee", "Political Action Committee", "PC", "PAC" suffix
    s = s.replace(/\s+(Political\s+(Action\s+)?Committee|PC|PAC)\s*$/i, '');
    // Strip "Campaign Committee", "Campaign C" (truncated)
    s = s.replace(/\s+Campaign\s+C(ommittee)?\s*$/i, '');
    return titleCase(s);
  }

  // Company name: strip legal suffixes
  s = s.replace(/\s*,?\s*(Inc\.?|LLC|L\.?L\.?C\.?|Corp\.?|Corporation|Ltd\.?|Co\.?|LP|LLP|PLC|GmbH|S\.?A\.?|Pty\.?\s*Ltd\.?|Group|& Associates|Associates)\s*$/i, '');
  // Strip trailing commas/periods
  s = s.replace(/[.,]+$/, '').trim();
  return titleCase(s);
}

function titleCase(str) {
  if (!str) return '';
  // If already mixed case, leave it alone
  if (str !== str.toUpperCase() && str !== str.toLowerCase()) return str;
  const smalls = new Set(['of', 'the', 'and', 'for', 'in', 'on', 'at', 'to', 'a', 'an', 'by']);
  return str.toLowerCase().split(/\s+/).map((w, i) =>
    i === 0 || !smalls.has(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w
  ).join(' ');
}

module.exports = { normalizeLead, cleanCompanyName, normalizeTitle, cleanDomain, validateEmail, simplifyName, titleCase };
