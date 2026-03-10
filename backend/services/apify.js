const API_BASE = 'https://api.apify.com/v2';
const TOKEN = () => process.env.APIFY_API_TOKEN;

async function runActor(actorId, input, { waitSecs = 300 } = {}) {
  // Apify API needs ~ instead of / in actor IDs for URL paths
  const encodedId = actorId.replace('/', '~');
  const res = await fetch(
    `${API_BASE}/acts/${encodedId}/runs?waitForFinish=${waitSecs}`,
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
 * Plain Google search (for domain discovery, etc.)
 */
async function searchGoogle(query) {
  const run = await runActor('apify/google-search-scraper', {
    queries: query,
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

/**
 * Waterfall contact enrichment: name + domain → verified email, phone, LinkedIn.
 * Uses ryanclinton/waterfall-contact-enrichment with SMTP deep verification.
 * Accepts array of { firstName, lastName, domain } objects for batch processing.
 */
async function waterfallEnrich(people, { verificationLevel = 'deep' } = {}) {
  if (!people.length) return [];
  const run = await runActor('ryanclinton/waterfall-contact-enrichment', {
    people,
    enrichFromWebsite: true,
    detectPattern: true,
    verificationLevel,
    maxConcurrency: 3,
  }, { waitSecs: 600 });
  console.log(`[waterfall] Run status: ${run?.data?.status}, datasetId: ${run?.data?.defaultDatasetId}`);
  if (!run?.data?.defaultDatasetId) return [];
  const items = await getDatasetItems(run.data.defaultDatasetId, { limit: Math.max(people.length, 10) });
  console.log(`[waterfall] Got ${items.length} items from dataset`);
  if (items.length > 0) console.log(`[waterfall] First item email: ${items[0]?.email}, conf: ${items[0]?.emailConfidence}`);
  return items;
}

module.exports = { scrapeWebsite, searchNews, searchGoogle, waterfallEnrich, runScraper, runActor, getDatasetItems };
