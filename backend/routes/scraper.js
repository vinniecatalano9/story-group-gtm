const { Router } = require('express');
const { runScraper } = require('../services/apify');
const { addLog } = require('../services/db');

const router = Router();

/**
 * POST /api/run-scraper
 * Trigger an Apify scraper and pipe results into the ingestion pipeline.
 *
 * Body: {
 *   actor_id: "apify/google-search-scraper",
 *   input: { queries: "CEO fintech", maxPagesPerQuery: 3 },
 *   campaign_tag: "q1-fintech-ceos"
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { actor_id, input, campaign_tag } = req.body;

    if (!actor_id || !input) {
      return res.status(400).json({ error: 'actor_id and input required' });
    }

    console.log(`[scraper] Running ${actor_id} with tag: ${campaign_tag}`);

    const leads = await runScraper(actor_id, input, campaign_tag);

    await addLog('scraper', {
      actor_id,
      campaign_tag,
      leads_found: leads.length,
    });

    // Pipe into ingestion endpoint (internal call)
    if (leads.length > 0) {
      const ingestUrl = `http://localhost:${process.env.PORT || 3001}/api/ingest`;
      const batchSize = 50;
      let totalIngested = 0;

      for (let i = 0; i < leads.length; i += batchSize) {
        const batch = leads.slice(i, i + batchSize);
        const resp = await fetch(ingestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: batch, source: 'apify', campaign_tag }),
        });
        const result = await resp.json();
        totalIngested += result.ingested || 0;
      }

      console.log(`[scraper] ${totalIngested} leads ingested from ${leads.length} found`);
      return res.json({ success: true, found: leads.length, ingested: totalIngested });
    }

    res.json({ success: true, found: 0, ingested: 0 });
  } catch (e) {
    console.error('[scraper] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
