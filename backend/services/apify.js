const API_BASE = 'https://api.apify.com/v2';
const TOKEN = () => process.env.APIFY_API_TOKEN;

async function runActor(actorId, input, { waitSecs = 300 } = {}) {
  const res = await fetch(
    `${API_BASE}/acts/${actorId}/runs?waitForFinish=${waitSecs}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) throw new Error(`Apify run failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getDatasetItems(datasetId, { limit = 100 } = {}) {
  const res = await fetch(
    `${API_BASE}/datasets/${datasetId}/items?limit=${limit}`,
    { headers: { 'Authorization': `Bearer ${TOKEN()}` } }
  );
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Scrape a company website for enrichment data.
 * Uses apify/website-content-crawler to get about/services/press pages.
 */
async function scrapeWebsite(domain) {
  const run = await runActor('apify/website-content-crawler', {
    startUrls: [{ url: `https://${domain}` }],
    maxCrawlPages: 5,
    maxCrawlDepth: 2,
    includeUrlGlobs: ['*about*', '*services*', '*case-study*', '*press*', '*team*', '*news*'],
  });
  if (!run?.data?.defaultDatasetId) return null;
  const items = await getDatasetItems(run.data.defaultDatasetId, { limit: 10 });
  return items.map(i => i.text || i.markdown || '').join('\n\n').substring(0, 8000);
}

/**
 * Search Google News for company signals.
 */
async function searchNews(companyName) {
  const run = await runActor('apify/google-search-scraper', {
    queries: `"${companyName}" (funding OR acquisition OR expansion OR launch OR partnership)`,
    maxPagesPerQuery: 1,
    resultsPerPage: 5,
  });
  if (!run?.data?.defaultDatasetId) return [];
  return getDatasetItems(run.data.defaultDatasetId, { limit: 5 });
}

/**
 * Run a custom scraper actor for lead sourcing.
 */
async function runScraper(actorId, input, campaignTag) {
  const run = await runActor(actorId, input);
  if (!run?.data?.defaultDatasetId) return [];
  const items = await getDatasetItems(run.data.defaultDatasetId, { limit: 500 });
  return items.map(item => ({
    first_name: item.firstName || item.first_name || '',
    last_name: item.lastName || item.last_name || '',
    email: item.email || '',
    company_name: item.companyName || item.company_name || item.company || '',
    company_domain: item.website || item.domain || item.company_domain || '',
    role_title: item.title || item.role_title || item.position || '',
    linkedin_url: item.linkedinUrl || item.linkedin_url || item.linkedin || '',
    campaign_tag: campaignTag,
    source: 'apify',
  }));
}

module.exports = { scrapeWebsite, searchNews, runScraper, runActor, getDatasetItems };
