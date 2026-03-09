/**
 * Florida Campaign Finance Expenditures Scraper
 * Source: https://dos.elections.myflorida.com/campaign-finance/expenditures/
 *
 * Uses Apify's Playwright Scraper to bypass Cloudflare protection,
 * submit the search form, and extract payee data to find political consultants.
 */

const { runActor, getDatasetItems } = require('../services/apify');
const { simplifyName } = require('../lib/normalize');

const PARTY_MAP = {
  REP: 'Republican',
  DEM: 'Democrat',
  NPA: 'No Party',
  PTY: 'Party Org',
  PAC: 'PAC',
  PAP: 'Party Committee',
  ECO: 'Electioneering Org',
  CCE: 'Continuous Committee',
  IND: 'Independent',
  LBT: 'Libertarian',
  GRE: 'Green',
};

const PURPOSE_SEARCHES = [
  'Consulting',
  'Media',
  'Public Relations',
  'Advertising',
  'Strategic',
  'Communications',
];

async function run(config = {}) {
  const {
    purposes = PURPOSE_SEARCHES,
    electionYear = '20261103-GEN',
    dateFromDaysAgo = 90,
    minAmount = 5000,
    limit = 500,
    campaign_tag = 'political-consultants-FL',
  } = config;

  // Calculate date range: last N days
  const now = new Date();
  const from = new Date(now.getTime() - dateFromDaysAgo * 86400000);
  const dateFrom = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}/${from.getFullYear()}`;
  const dateTo = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;

  console.log(`[fl-scraper] Starting Florida campaign finance scrape via Apify Playwright...`);
  console.log(`[fl-scraper] Searching ${purposes.length} purpose categories, min $${minAmount}, date range: ${dateFrom} - ${dateTo}`);

  const allResults = [];

  for (const purpose of purposes) {
    console.log(`[fl-scraper] Searching purpose: "${purpose}"...`);
    try {
      const results = await scrapeByPurpose(purpose, { electionYear, dateFrom, dateTo, limit, minAmount });
      console.log(`[fl-scraper]   Found ${results.length} records for "${purpose}"`);
      allResults.push(...results);
    } catch (err) {
      console.error(`[fl-scraper]   Error for "${purpose}": ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[fl-scraper] Total raw records: ${allResults.length}`);
  const firms = dedupePayees(allResults);
  console.log(`[fl-scraper] Unique firms after dedup: ${firms.length}`);

  const leads = firms.map(f => ({
    first_name: '',
    last_name: '',
    email: '',
    company_name: f.company_name,
    company_display: simplifyName(f.company_name, 'company'),
    company_domain: '',
    role_title: '',
    linkedin_url: '',
    source: 'fl-campaign-finance',
    campaign_tag,
    custom_fields: {
      total_campaign_spend: f.total_spend,
      expenditure_count: f.expenditure_count,
      purposes: f.purposes,
      candidates_served: f.candidates_served,
      parties_served: f.parties_served,
      city: f.city || '',
      state: f.state || 'FL',
      // Individual payments with simplified names for email copy
      expenditures: (f.expenditures || []).map(e => ({
        ...e,
        candidate_display: simplifyName(e.candidate, 'candidate'),
      })),
    },
  }));

  return { total_raw: allResults.length, unique_firms: firms.length, leads, firms };
}

async function scrapeByPurpose(purpose, options = {}) {
  const { electionYear = 'All', dateFrom = '', dateTo = '', limit = 500, minAmount = 5000 } = options;

  // Use apify/playwright-scraper — runs Node.js with Playwright page object
  const actorRun = await runActor('apify/playwright-scraper', {
    startUrls: [{ url: 'https://dos.elections.myflorida.com/campaign-finance/expenditures/' }],
    linkSelector: '',
    globs: [],
    pseudoUrls: [],
    keepUrlFragments: false,
    useChrome: true,
    maxRequestsPerCrawl: 1,
    maxConcurrency: 1,
    pageLoadTimeoutSecs: 60,
    pageFunctionTimeoutSecs: 120,
    waitUntil: 'networkidle',
    customData: { purpose, electionYear, dateFrom, dateTo, limit: String(limit), minAmount: String(minAmount) },
    pageFunction: `async function pageFunction(context) {
      const { page, request, log, customData } = context;
      const { purpose, electionYear, dateFrom, dateTo, limit, minAmount } = customData;

      log.info('Page loaded, waiting for form...');
      await page.waitForSelector('input[name="Submit"]', { timeout: 45000 });
      log.info('Form found. Filling fields...');

      // Select election year ("All" to capture all cycles)
      try { await page.selectOption('select[name="election"]', electionYear); } catch(e) { log.warning('Could not set election year: ' + e.message); }

      // search_on=1 (Payee Search) is already selected by default — don't change it

      // Fill date range (mm/dd/yyyy format) for recency filtering
      if (dateFrom) { try { await page.fill('input[name="cdatefrom"]', dateFrom); } catch(e) { log.warning('Could not fill cdatefrom: ' + e.message); } }
      if (dateTo) { try { await page.fill('input[name="cdateto"]', dateTo); } catch(e) { log.warning('Could not fill cdateto: ' + e.message); } }

      // Fill purpose of expenditure (actual field name: cpurpose)
      try { await page.fill('input[name="cpurpose"]', purpose); } catch(e) { log.warning('Could not fill cpurpose: ' + e.message); }

      // Fill min amount (actual field name: cdollar_minimum)
      try { await page.fill('input[name="cdollar_minimum"]', minAmount); } catch(e) { log.warning('Could not fill cdollar_minimum: ' + e.message); }

      // Fill record limit
      try { await page.fill('input[name="rowlimit"]', limit); } catch(e) { log.warning('Could not fill rowlimit: ' + e.message); }

      // Select "Return Results to Your Screen" (queryformat=1) — NOT queryformat=2 which downloads a file
      try { await page.click('input[name="queryformat"][value="1"]'); } catch(e) { log.warning('Could not set queryformat: ' + e.message); }

      // Click Submit
      log.info('Submitting form...');
      const [response] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
        page.click('input[name="Submit"]'),
      ]);

      // Wait for results to load
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      log.info('After submit, URL: ' + currentUrl);

      // Results are in a <pre> tag as fixed-width columns, not HTML tables
      const preText = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        return pre ? pre.innerText : '';
      });

      log.info('Pre text length: ' + preText.length);
      log.info('Pre preview: ' + preText.substring(0, 300));

      return {
        purpose,
        url: currentUrl,
        preText,
      };
    }`,
    proxyConfiguration: { useApifyProxy: true },
  }, { waitSecs: 180 });

  if (!actorRun?.data?.defaultDatasetId) {
    console.error(`[fl-scraper] No dataset for purpose="${purpose}"`);
    return [];
  }

  const items = await getDatasetItems(actorRun.data.defaultDatasetId, { limit: 1 });
  if (!items || items.length === 0) {
    console.error(`[fl-scraper] Empty dataset for purpose="${purpose}"`);
    return [];
  }

  const result = items[0];
  console.log(`[fl-scraper] Result URL: ${result.url}`);
  console.log(`[fl-scraper] Pre text length: ${(result.preText || '').length}`);

  return parsePreText(result.preText || '', purpose);
}

/**
 * Parse fixed-width <pre> text from FL elections results page.
 * Column layout (character positions from the dash separator line):
 *   Candidate/Committee (0-50), Date (51-61), Amount (62-78),
 *   Payee Name (79-118), Address (119-158), City State Zip (159-198),
 *   Purpose (199-218), Type (219+)
 */
function parsePreText(preText, purposeSearch) {
  const lines = preText.split('\n');
  const records = [];

  // Find the dash separator line to determine column positions
  const dashIdx = lines.findIndex(l => /^-{10,}/.test(l.trim()));
  if (dashIdx < 0) return records;

  const dashLine = lines[dashIdx];
  // Parse column boundaries from dash groups
  const cols = [];
  let inDash = false, start = 0;
  for (let i = 0; i <= dashLine.length; i++) {
    const isDash = dashLine[i] === '-';
    if (isDash && !inDash) { start = i; inDash = true; }
    if (!isDash && inDash) { cols.push({ start, end: i }); inDash = false; }
  }

  // Data lines start after the dash line
  for (let i = dashIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length < 10) continue;

    const extract = (colIdx) => {
      if (colIdx >= cols.length) return '';
      return line.substring(cols[colIdx].start, cols[colIdx].end).trim();
    };

    const candidate = extract(0);
    const date = extract(1);
    const amountStr = extract(2);
    const payeeName = extract(3);
    const address = extract(4);
    const cityStateZip = extract(5);
    const purpose = extract(6);

    // Parse amount
    const amountMatch = amountStr.match(/([\d,]+\.\d{2})/);
    if (!amountMatch) continue;
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (amount < 1000) continue;

    if (!payeeName || payeeName.length < 3) continue;

    // Parse city/state from cityStateZip (format: "JACKSONVILLE, FL 32224")
    let city = '', state = 'FL';
    const cszMatch = cityStateZip.match(/^(.+?),\s*([A-Z]{2})\s/);
    if (cszMatch) { city = cszMatch[1].trim(); state = cszMatch[2]; }

    // Parse party/type from candidate name: "Name (REP)", "Name (PAC)", etc.
    const partyMatch = candidate.match(/\(([A-Z]{2,4})\)\s*$/);
    const partyCode = partyMatch ? partyMatch[1] : '';
    const party = PARTY_MAP[partyCode] || partyCode || '';
    const candidateClean = candidate.replace(/\s*\([A-Z]{2,4}\)\s*$/, '').trim();

    records.push({
      payee_name: payeeName,
      payee_address: address,
      amount,
      purpose: purpose || purposeSearch,
      purpose_search: purposeSearch,
      candidate: candidateClean,
      candidate_party: party,
      candidate_type: partyCode,
      date,
      city,
      state,
    });
  }

  return records;
}

function dedupePayees(allResults) {
  const firmMap = new Map();
  for (const r of allResults) {
    if (!r.payee_name) continue;
    const key = r.payee_name.toUpperCase().replace(/[.,\s]+/g, ' ')
      .replace(/\b(INC|LLC|CORP|LTD|CO|GROUP|PARTNERS)\b/g, '').trim();
    if (!key || key.length < 3) continue;
    if (!firmMap.has(key)) {
      firmMap.set(key, {
        company_name: r.payee_name.trim(), address: r.payee_address || '',
        city: r.city || '', state: r.state || 'FL',
        total_spend: r.amount, expenditure_count: 1,
        purposes: new Set([r.purpose || r.purpose_search || '']),
        candidates_served: new Set(r.candidate ? [r.candidate] : []),
        parties_served: new Set(r.candidate_party ? [r.candidate_party] : []),
        // Store individual expenditure details for personalized outreach
        expenditures: [{ candidate: r.candidate, party: r.candidate_party, type: r.candidate_type, amount: r.amount, purpose: r.purpose || r.purpose_search, date: r.date }],
      });
    } else {
      const e = firmMap.get(key);
      e.total_spend += r.amount; e.expenditure_count += 1;
      if (r.purpose || r.purpose_search) e.purposes.add(r.purpose || r.purpose_search);
      if (r.candidate) e.candidates_served.add(r.candidate);
      if (r.candidate_party) e.parties_served.add(r.candidate_party);
      e.expenditures.push({ candidate: r.candidate, party: r.candidate_party, type: r.candidate_type, amount: r.amount, purpose: r.purpose || r.purpose_search, date: r.date });
    }
  }
  return Array.from(firmMap.values())
    .map(f => ({
      company_name: f.company_name, address: f.address,
      city: f.city, state: f.state,
      total_spend: f.total_spend, expenditure_count: f.expenditure_count,
      purposes: Array.from(f.purposes).filter(Boolean).join(', '),
      candidates_served: Array.from(f.candidates_served).filter(Boolean).slice(0, 10).join('; '),
      parties_served: Array.from(f.parties_served).filter(Boolean).join(', '),
      // Top expenditures sorted by amount for email personalization
      expenditures: f.expenditures.sort((a, b) => b.amount - a.amount).slice(0, 10),
    }))
    .sort((a, b) => b.total_spend - a.total_spend);
}

module.exports = { run, PURPOSE_SEARCHES };
