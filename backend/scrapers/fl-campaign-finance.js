/**
 * Florida Campaign Finance Expenditures Scraper
 * Source: https://dos.elections.myflorida.com/campaign-finance/expenditures/
 *
 * Uses Apify's Playwright Scraper to bypass Cloudflare protection,
 * submit the search form, and extract payee data to find political consultants.
 */

const { runActor, getDatasetItems } = require('../services/apify');

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
    electionYear = '20260',
    minAmount = 5000,
    limit = 500,
    campaign_tag = 'political-consultants-FL',
  } = config;

  console.log(`[fl-scraper] Starting Florida campaign finance scrape via Apify Playwright...`);
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

  return { total_raw: allResults.length, unique_firms: firms.length, leads, firms };
}

async function scrapeByPurpose(purpose, options = {}) {
  const { electionYear = '20260', limit = 500, minAmount = 5000 } = options;

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
    customData: { purpose, electionYear, limit: String(limit), minAmount: String(minAmount) },
    pageFunction: `async function pageFunction(context) {
      const { page, request, log, customData } = context;
      const { purpose, electionYear, limit, minAmount } = customData;

      log.info('Page loaded, waiting for form...');
      await page.waitForSelector('input[name="Submit"]', { timeout: 45000 });
      log.info('Form found. Filling fields...');

      // Select election year
      try { await page.selectOption('select[name="election"]', electionYear); } catch(e) { log.warning('Could not set election year: ' + e.message); }

      // Fill purpose
      try { await page.fill('input[name="purpose"]', purpose); } catch(e) { log.warning('Could not fill purpose: ' + e.message); }

      // Fill min amount
      try { await page.fill('input[name="AmtFrom"]', minAmount); } catch(e) { log.warning('Could not fill AmtFrom: ' + e.message); }

      // Fill record limit
      try { await page.fill('input[name="rowlimit"]', limit); } catch(e) { log.warning('Could not fill rowlimit: ' + e.message); }

      // Select "List of expenditures" (queryformat=2) - there are multiple on the page
      const qfRadios = await page.$$('input[name="queryformat"][value="2"]');
      if (qfRadios.length > 0) {
        await qfRadios[0].click();
        log.info('Selected List of expenditures radio');
      }

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

      // Extract all table data from results page
      const tableData = await page.evaluate(() => {
        const results = [];
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
            if (cells.length >= 3) {
              results.push(cells);
            }
          }
        }
        // Also get page text for debugging
        const bodyText = document.body.innerText.substring(0, 3000);
        return { rows: results, bodyText, tableCount: tables.length };
      });

      log.info('Tables found: ' + tableData.tableCount + ', rows: ' + tableData.rows.length);
      log.info('Body preview: ' + tableData.bodyText.substring(0, 500));

      return {
        purpose,
        url: currentUrl,
        tableCount: tableData.tableCount,
        rowCount: tableData.rows.length,
        rows: tableData.rows,
        bodyPreview: tableData.bodyText.substring(0, 2000),
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
  console.log(`[fl-scraper] Tables: ${result.tableCount}, Rows: ${result.rowCount}`);
  console.log(`[fl-scraper] Body: ${(result.bodyPreview || '').substring(0, 300)}`);

  return parseRows(result.rows || [], purpose);
}

function parseRows(rows, purpose) {
  const records = [];
  for (const cells of rows) {
    if (cells.length < 3) continue;
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

    const record = { raw_cells: cells, amount, purpose_search: purpose };
    for (let i = 0; i < Math.min(amountIdx, 4); i++) {
      const cell = cells[i];
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cell)) continue;
      if (cell.length < 3) continue;
      if (/^[A-Z]{2}$/.test(cell)) continue;
      if (!record.payee_name) record.payee_name = cell;
      else if (!record.payee_address) record.payee_address = cell;
    }
    if (amountIdx + 1 < cells.length) record.purpose = cells[amountIdx + 1];
    if (record.payee_name && record.payee_name.length > 2) records.push(record);
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
        total_spend: r.amount, expenditure_count: 1,
        purposes: new Set([r.purpose || r.purpose_search || '']),
        candidates_served: new Set(),
      });
    } else {
      const e = firmMap.get(key);
      e.total_spend += r.amount; e.expenditure_count += 1;
      if (r.purpose || r.purpose_search) e.purposes.add(r.purpose || r.purpose_search);
    }
  }
  return Array.from(firmMap.values())
    .map(f => ({
      company_name: f.company_name, address: f.address,
      total_spend: f.total_spend, expenditure_count: f.expenditure_count,
      purposes: Array.from(f.purposes).filter(Boolean).join(', '),
      candidates_served: Array.from(f.candidates_served).filter(Boolean).slice(0, 5).join('; '),
    }))
    .sort((a, b) => b.total_spend - a.total_spend);
}

module.exports = { run, PURPOSE_SEARCHES };
