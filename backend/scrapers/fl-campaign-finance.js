/**
 * Florida Campaign Finance Expenditures Scraper
 * Source: https://dos.elections.myflorida.com/campaign-finance/expenditures/
 *
 * Uses Apify's web scraper (Playwright) to bypass Cloudflare protection,
 * submit the search form, and extract payee data to find political consultants.
 */

const { runActor, getDatasetItems } = require('../services/apify');

// Expenditure purpose keywords that indicate consulting/media/PR firms
const PURPOSE_SEARCHES = [
  'Consulting',
  'Media',
  'Public Relations',
  'Advertising',
  'Strategic',
  'Communications',
];

/**
 * Main scraper function - uses Apify web scraper to submit the FL elections form
 * and parse the results for each purpose keyword.
 */
async function run(config = {}) {
  const {
    purposes = PURPOSE_SEARCHES,
    electionYear = '20260',
    minAmount = 5000,
    limit = 500,
    campaign_tag = 'political-consultants-FL',
  } = config;

  console.log(`[fl-scraper] Starting Florida campaign finance scrape via Apify...`);
  console.log(`[fl-scraper] Searching ${purposes.length} purpose categories, min $${minAmount}`);

  const allResults = [];

  for (const purpose of purposes) {
    console.log(`[fl-scraper] Searching purpose: "${purpose}"...`);
    try {
      const results = await scrapeByPurpose(purpose, { electionYear, limit, minAmount });
      console.log(`[fl-scraper]   Found ${results.length} records for "${purpose}"`);
      allResults.push(...results);
    } catch (err) {
      console.error(`[fl-scraper]   Error for "${purpose}": ${err.message}`);
    }
    // Delay between runs
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
      city: f.city || '',
      state: f.state || 'FL',
    },
  }));

  return {
    total_raw: allResults.length,
    unique_firms: firms.length,
    leads,
    firms,
  };
}

/**
 * Use Apify's web scraper to submit the FL elections form and extract results.
 * The page function runs in a Playwright browser context, bypassing Cloudflare.
 */
async function scrapeByPurpose(purpose, options = {}) {
  const {
    electionYear = '20260',
    limit = 500,
    minAmount = 5000,
  } = options;

  // Build the form URL with query params (the site supports GET as well)
  const formUrl = `https://dos.elections.myflorida.com/cgi-bin/expend.exe`;

  // Use apify/web-scraper which runs Playwright and can handle Cloudflare
  const actorRun = await runActor('apify/web-scraper', {
    startUrls: [{ url: 'https://dos.elections.myflorida.com/campaign-finance/expenditures/' }],
    keepUrlFragments: false,
    linkSelector: '',  // Don't follow any links
    globs: [],
    pseudoUrls: [],
    pageFunction: `async function pageFunction(context) {
      const { page, request, log } = context;

      log.info('Waiting for page to load...');
      await page.waitForSelector('form', { timeout: 30000 });

      // Fill the form
      log.info('Filling form with purpose: ${purpose}');

      // Select election year
      await page.selectOption('select[name="election"]', '${electionYear}');

      // Click the Payee Search radio (search_on=3)
      // The form has radio buttons for search mode
      const payeeRadio = await page.$('input[value="3"][name="search_on"]');
      if (payeeRadio) await payeeRadio.click();

      // Select "List of expenditures" radio
      const listRadios = await page.$$('input[value="2"][name="queryformat"]');
      for (const radio of listRadios) {
        const parent = await radio.evaluateHandle(el => el.closest('form') || el.parentElement);
        await radio.click();
      }

      // Fill purpose field
      await page.fill('input[name="purpose"]', '${purpose}');

      // Fill minimum amount
      await page.fill('input[name="AmtFrom"]', '${minAmount}');

      // Set record limit
      await page.fill('input[name="rowlimit"]', '${limit}');

      // Submit the form
      log.info('Submitting form...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
        page.click('input[name="Submit"]'),
      ]);

      log.info('Parsing results...');

      // Extract all table rows from the results page
      const results = await page.evaluate(() => {
        const rows = [];
        const tables = document.querySelectorAll('table');

        for (const table of tables) {
          const trs = table.querySelectorAll('tr');
          for (const tr of trs) {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
            if (cells.length >= 4) {
              rows.push(cells);
            }
          }
        }
        return rows;
      });

      log.info('Found ' + results.length + ' table rows');

      // Also grab the full page text for debugging
      const pageText = await page.evaluate(() => document.body.innerText);

      return {
        purpose: '${purpose}',
        rows: results,
        pageTextPreview: pageText.substring(0, 2000),
        url: page.url(),
      };
    }`,
    proxyConfiguration: { useApifyProxy: true },
    preNavigationHooks: `[
      async ({ page }, goToOptions) => {
        goToOptions.waitUntil = 'networkidle';
        goToOptions.timeout = 60000;
      }
    ]`,
    maxRequestsPerCrawl: 1,
    maxConcurrency: 1,
  }, { waitSecs: 120 });

  if (!actorRun?.data?.defaultDatasetId) {
    console.error(`[fl-scraper] No dataset returned for purpose="${purpose}"`);
    return [];
  }

  const items = await getDatasetItems(actorRun.data.defaultDatasetId, { limit: 1 });
  if (!items || items.length === 0) return [];

  const result = items[0];
  console.log(`[fl-scraper] Page URL after submit: ${result.url}`);
  console.log(`[fl-scraper] Page text preview: ${(result.pageTextPreview || '').substring(0, 300)}`);

  // Parse the table rows into structured records
  return parseRows(result.rows || [], purpose);
}

/**
 * Parse raw table rows into structured expenditure records
 */
function parseRows(rows, purpose) {
  const records = [];

  for (const cells of rows) {
    // Skip header rows and very short rows
    if (cells.length < 4) continue;

    // Look for dollar amount in cells
    let amount = 0;
    let amountIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      const match = cells[i].match(/\$?([\d,]+\.\d{2})/);
      if (match) {
        amount = parseFloat(match[1].replace(/,/g, ''));
        amountIdx = i;
        break;
      }
    }

    if (amount < 1000 || amountIdx < 0) continue;

    // Try to extract payee name — it's usually the cell before the address/date
    // FL format varies but typically: Candidate | Date | Payee | Address | Amount | Purpose
    // or: Payee | Address | City | State | Amount | Purpose
    const record = {
      raw_cells: cells,
      amount,
      purpose_search: purpose,
    };

    // Heuristic: find the first non-date, non-amount cell that looks like a name
    for (let i = 0; i < Math.min(amountIdx, 4); i++) {
      const cell = cells[i];
      // Skip dates
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cell)) continue;
      // Skip very short cells
      if (cell.length < 3) continue;
      // Skip if it looks like a state abbreviation alone
      if (/^[A-Z]{2}$/.test(cell)) continue;

      if (!record.payee_name) {
        record.payee_name = cell;
      } else if (!record.payee_address) {
        record.payee_address = cell;
      }
    }

    // Get purpose from cells after amount
    if (amountIdx + 1 < cells.length) {
      record.purpose = cells[amountIdx + 1];
    }

    // Try to get candidate/committee from context
    record.candidate_or_committee = '';
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== record.payee_name && cells[i].length > 5 && !/\$/.test(cells[i]) && !/^\d/.test(cells[i])) {
        if (i !== amountIdx) {
          record.candidate_or_committee = cells[i];
          break;
        }
      }
    }

    if (record.payee_name && record.payee_name.length > 2) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Deduplicate and normalize payees into leads
 */
function dedupePayees(allResults) {
  const firmMap = new Map();

  for (const r of allResults) {
    if (!r.payee_name) continue;

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
        purposes: new Set([r.purpose || r.purpose_search || '']),
        candidates_served: new Set([r.candidate_or_committee || '']),
      });
    } else {
      const existing = firmMap.get(key);
      existing.total_spend += r.amount;
      existing.expenditure_count += 1;
      if (r.purpose || r.purpose_search) existing.purposes.add(r.purpose || r.purpose_search);
      if (r.candidate_or_committee) existing.candidates_served.add(r.candidate_or_committee);
    }
  }

  return Array.from(firmMap.values())
    .map(f => ({
      company_name: f.company_name,
      address: f.address,
      total_spend: f.total_spend,
      expenditure_count: f.expenditure_count,
      purposes: Array.from(f.purposes).filter(Boolean).join(', '),
      candidates_served: Array.from(f.candidates_served).filter(Boolean).slice(0, 5).join('; '),
      ...parseAddress(f.address),
    }))
    .sort((a, b) => b.total_spend - a.total_spend);
}

function parseAddress(addr) {
  if (!addr) return {};
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

module.exports = { run, PURPOSE_SEARCHES };
