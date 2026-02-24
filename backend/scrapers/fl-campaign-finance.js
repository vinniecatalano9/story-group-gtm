/**
 * Florida Campaign Finance Expenditures Scraper
 * Source: https://dos.elections.myflorida.com/campaign-finance/expenditures/
 *
 * Scrapes payee data from FL Division of Elections to find political consultants,
 * media firms, PR firms, and other campaign service providers.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://dos.elections.myflorida.com/cgi-bin/expend.exe';

// Expenditure purpose keywords that indicate consulting/media/PR firms
const PURPOSE_SEARCHES = [
  'Consulting',
  'Media',
  'Public Relations',
  'Advertising',
  'Strategic',
  'Communications',
  'Digital',
  'Polling',
  'Research',
];

/**
 * Submit the expenditures search form and parse results
 */
async function searchExpendsByPurpose(purpose, options = {}) {
  const {
    electionYear = '20260',  // 2026 Election cycle
    limit = 500,
    minAmount = 5000,       // Only firms getting paid $5K+ are real consultancies
  } = options;

  const formData = new URLSearchParams({
    election: electionYear,
    search_on: '3',          // Payee search mode
    CanNameSrch: '2',        // Not used in payee mode
    office: 'All',
    party: 'All',
    ComNameSrch: '2',
    committee_type: 'All',
    PayNamSrch: '2',         // Payee last name starts with
    PayNamFirst: '',
    PayNamLast: '',
    payession: '',
    PayCity: '',
    PayState: '',
    PayZip: '',
    purpose: purpose,
    AmtFrom: minAmount.toString(),
    AmtTo: '',
    SortOrder: 'DAT',
    SortOrder2: 'CAN',
    queryformat: '2',        // List of expenditures
    rowlimit: limit.toString(),
    Submit: 'Submit',
  });

  try {
    const response = await axios.post(BASE_URL, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; research bot)',
      },
      timeout: 30000,
    });

    return parseResultsHTML(response.data);
  } catch (error) {
    console.error(`[fl-scraper] Error searching purpose="${purpose}":`, error.message);
    return [];
  }
}

/**
 * Parse the HTML results table into structured data
 */
function parseResultsHTML(html) {
  const $ = cheerio.load(html);
  const results = [];

  // The results come back in a table - each row is an expenditure
  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return; // Skip header/empty rows

    const text = cells.map((_, cell) => $(cell).text().trim()).get();

    // FL expenditure tables typically have:
    // Candidate/Committee | Payee Name | Address | Date | Amount | Purpose
    // But format can vary - we detect by looking for dollar amounts
    const amountCell = text.find(t => /^\$[\d,]+/.test(t) || /^[\d,]+\.\d{2}$/.test(t));
    if (!amountCell) return;

    const amount = parseFloat(amountCell.replace(/[$,]/g, ''));
    if (isNaN(amount) || amount < 1000) return;

    // Find the payee info - typically the second significant text cell
    const entry = {
      raw_cells: text,
      amount,
    };

    // Try to extract structured data from cells
    if (text.length >= 6) {
      entry.candidate_or_committee = text[0];
      entry.payee_name = text[1];
      entry.payee_address = text[2];
      entry.date = text[3];
      entry.purpose = text[5] || text[4];
    } else if (text.length >= 4) {
      entry.payee_name = text[0];
      entry.payee_address = text[1];
      entry.date = text[2];
      entry.purpose = text[3];
    }

    if (entry.payee_name && entry.payee_name.length > 2) {
      results.push(entry);
    }
  });

  return results;
}

/**
 * Deduplicate and normalize payees into leads
 */
function dedupePayees(allResults) {
  const firmMap = new Map();

  for (const r of allResults) {
    if (!r.payee_name) continue;

    // Normalize firm name for dedup
    const key = r.payee_name
      .toUpperCase()
      .replace(/[.,\s]+/g, ' ')
      .replace(/\b(INC|LLC|CORP|LTD|CO|GROUP|PARTNERS)\b/g, '')
      .trim();

    if (!key || key.length < 3) continue;

    if (!firmMap.has(key)) {
      firmMap.set(key, {
        company_name: r.payee_name.trim(),
        address: r.payee_address || '',
        total_spend: r.amount,
        expenditure_count: 1,
        purposes: new Set([r.purpose || '']),
        candidates_served: new Set([r.candidate_or_committee || '']),
      });
    } else {
      const existing = firmMap.get(key);
      existing.total_spend += r.amount;
      existing.expenditure_count += 1;
      if (r.purpose) existing.purposes.add(r.purpose);
      if (r.candidate_or_committee) existing.candidates_served.add(r.candidate_or_committee);
    }
  }

  // Convert to lead format, sorted by total spend desc
  return Array.from(firmMap.values())
    .map(f => ({
      company_name: f.company_name,
      address: f.address,
      total_spend: f.total_spend,
      expenditure_count: f.expenditure_count,
      purposes: Array.from(f.purposes).filter(Boolean).join(', '),
      candidates_served: Array.from(f.candidates_served).filter(Boolean).slice(0, 5).join('; '),
      // Parse city/state from address
      ...parseAddress(f.address),
    }))
    .sort((a, b) => b.total_spend - a.total_spend);
}

/**
 * Basic address parser for FL addresses
 */
function parseAddress(addr) {
  if (!addr) return {};
  // Try to extract city, state from address string
  const parts = addr.split(/[,\n]+/).map(s => s.trim());
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1];
    const stateZipMatch = lastPart.match(/([A-Z]{2})\s*(\d{5})?/);
    return {
      city: parts[parts.length - 2] || '',
      state: stateZipMatch ? stateZipMatch[1] : '',
      zip: stateZipMatch ? stateZipMatch[2] || '' : '',
    };
  }
  return {};
}

/**
 * Main scraper function - runs all purpose searches, dedupes, returns leads
 */
async function run(config = {}) {
  const {
    purposes = PURPOSE_SEARCHES,
    electionYear = '20260',
    minAmount = 5000,
    limit = 500,
  } = config;

  console.log(`[fl-scraper] Starting Florida campaign finance scrape...`);
  console.log(`[fl-scraper] Searching ${purposes.length} purpose categories, min $${minAmount}`);

  const allResults = [];

  for (const purpose of purposes) {
    console.log(`[fl-scraper] Searching purpose: "${purpose}"...`);
    const results = await searchExpendsByPurpose(purpose, { electionYear, limit, minAmount });
    console.log(`[fl-scraper]   Found ${results.length} expenditure records`);
    allResults.push(...results);

    // Small delay between requests to be respectful
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[fl-scraper] Total raw records: ${allResults.length}`);

  const firms = dedupePayees(allResults);
  console.log(`[fl-scraper] Unique firms after dedup: ${firms.length}`);

  // Convert to lead format for ingestion
  const leads = firms.map(f => ({
    first_name: '',
    last_name: '',
    email: '',
    company_name: f.company_name,
    company_domain: '',
    role_title: '',
    linkedin_url: '',
    source: 'fl-campaign-finance',
    campaign_tag: config.campaign_tag || 'political-consultants-FL',
    custom_fields: {
      total_campaign_spend: f.total_spend,
      expenditure_count: f.expenditure_count,
      purposes: f.purposes,
      candidates_served: f.candidates_served,
      city: f.city || '',
      state: f.state || 'FL',
    },
  }));

  return {
    total_raw: allResults.length,
    unique_firms: firms.length,
    leads,
    firms, // Include full firm data for reference
  };
}

module.exports = { run, searchExpendsByPurpose, PURPOSE_SEARCHES };
