const express = require('express');
const router = express.Router();
const { db, addLog } = require('../services/db');
const { notify } = require('../services/slack');

const scrapers = db.collection('scrapers');
const scraperRuns = db.collection('scraper_runs');

// Registry of available scraper modules
const SCRAPER_MODULES = {
  'fl-campaign-finance': {
    name: 'Florida Campaign Finance',
    description: 'Scrapes FL Division of Elections expenditure records to find political consultants, media firms, and PR agencies.',
    module: '../scrapers/fl-campaign-finance',
    defaultConfig: {
      purposes: ['Consulting', 'Media', 'Public Relations', 'Advertising', 'Strategic', 'Communications'],
      electionYear: '20260',
      minAmount: 5000,
      limit: 500,
    },
  },
  // Add more states/sources here:
  // 'tx-campaign-finance': { ... },
  // 'linkedin-search': { ... },
  // 'apollo-import': { ... },
};

// GET /api/scrapers - List all configured scrapers
router.get('/', async (req, res) => {
  try {
    const snap = await scrapers.orderBy('created_at', 'desc').get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, scrapers: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scrapers/registry - List available scraper types
router.get('/registry', (req, res) => {
  const registry = Object.entries(SCRAPER_MODULES).map(([key, val]) => ({
    type: key,
    name: val.name,
    description: val.description,
    defaultConfig: val.defaultConfig,
  }));
  res.json({ success: true, registry });
});

// POST /api/scrapers - Create a new scraper config
router.post('/', async (req, res) => {
  try {
    const { name, type, campaign_tag, config, schedule } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name and type required' });
    }
    if (!SCRAPER_MODULES[type]) {
      return res.status(400).json({ error: `Unknown scraper type: ${type}. Available: ${Object.keys(SCRAPER_MODULES).join(', ')}` });
    }

    const scraper = {
      name,
      type,
      campaign_tag: campaign_tag || `${type}-leads`,
      config: config || SCRAPER_MODULES[type].defaultConfig,
      schedule: schedule || 'manual',  // 'manual', 'daily', 'weekly'
      status: 'idle',
      last_run: null,
      last_run_leads: 0,
      total_leads: 0,
      run_count: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const ref = await scrapers.add(scraper);
    res.json({ success: true, id: ref.id, scraper: { id: ref.id, ...scraper } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/scrapers/:id - Update scraper config
router.put('/:id', async (req, res) => {
  try {
    const { name, campaign_tag, config, schedule } = req.body;
    const updates = { updated_at: new Date() };
    if (name) updates.name = name;
    if (campaign_tag) updates.campaign_tag = campaign_tag;
    if (config) updates.config = config;
    if (schedule) updates.schedule = schedule;

    await scrapers.doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/scrapers/:id - Delete a scraper
router.delete('/:id', async (req, res) => {
  try {
    await scrapers.doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrapers/:id/run - Run a scraper
router.post('/:id/run', async (req, res) => {
  try {
    const doc = await scrapers.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Scraper not found' });

    const scraper = doc.data();
    const moduleInfo = SCRAPER_MODULES[scraper.type];
    if (!moduleInfo) return res.status(400).json({ error: `Unknown type: ${scraper.type}` });

    // Mark as running
    await scrapers.doc(req.params.id).update({ status: 'running', updated_at: new Date() });

    // Respond immediately - run async
    res.json({ success: true, message: `Scraper "${scraper.name}" started` });

    // Run the scraper in background
    runScraperAsync(req.params.id, scraper, moduleInfo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrapers/run-type/:type - Quick run a scraper type without saving config
router.post('/run-type/:type', async (req, res) => {
  try {
    const moduleInfo = SCRAPER_MODULES[req.params.type];
    if (!moduleInfo) {
      return res.status(400).json({ error: `Unknown type: ${req.params.type}` });
    }

    const config = { ...moduleInfo.defaultConfig, ...req.body };
    const scraperModule = require(moduleInfo.module);

    res.json({ success: true, message: `Running ${moduleInfo.name}... This may take a few minutes.` });

    // Run async
    (async () => {
      try {
        const result = await scraperModule.run(config);
        console.log(`[scrapers] Quick-run ${req.params.type}: ${result.unique_firms} firms found`);

        // Ingest results
        if (result.leads && result.leads.length > 0) {
          const ingested = await ingestScraperLeads(result.leads, config.campaign_tag || `${req.params.type}-leads`);
          console.log(`[scrapers] Ingested ${ingested} leads from quick-run`);

          await notify(`🔍 Quick scraper run complete: *${moduleInfo.name}*\n• ${result.total_raw} raw records\n• ${result.unique_firms} unique firms\n• ${ingested} leads ingested`);
        }
      } catch (err) {
        console.error(`[scrapers] Quick-run error:`, err.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Run scraper async and ingest results
 */
async function runScraperAsync(scraperId, scraperConfig, moduleInfo) {
  const startTime = Date.now();
  try {
    const scraperModule = require(moduleInfo.module);
    const result = await scraperModule.run({
      ...scraperConfig.config,
      campaign_tag: scraperConfig.campaign_tag,
    });

    const ingested = result.leads ? await ingestScraperLeads(result.leads, scraperConfig.campaign_tag) : 0;
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Update scraper status
    await scrapers.doc(scraperId).update({
      status: 'idle',
      last_run: new Date(),
      last_run_leads: ingested,
      last_run_duration: duration,
      total_leads: (scraperConfig.total_leads || 0) + ingested,
      run_count: (scraperConfig.run_count || 0) + 1,
      updated_at: new Date(),
    });

    // Log the run
    await scraperRuns.add({
      scraper_id: scraperId,
      scraper_name: scraperConfig.name,
      type: scraperConfig.type,
      total_raw: result.total_raw || 0,
      unique_firms: result.unique_firms || 0,
      leads_ingested: ingested,
      duration_seconds: duration,
      created_at: new Date(),
    });

    await addLog('scraper_run', {
      scraper_id: scraperId,
      name: scraperConfig.name,
      leads: ingested,
      duration,
    });

    await notify(`🔍 Scraper complete: *${scraperConfig.name}*\n• ${result.total_raw} raw records\n• ${result.unique_firms} unique firms\n• ${ingested} new leads ingested\n• Duration: ${duration}s`);

    console.log(`[scrapers] ${scraperConfig.name} complete: ${ingested} leads in ${duration}s`);
  } catch (error) {
    console.error(`[scrapers] ${scraperConfig.name} error:`, error.message);

    await scrapers.doc(scraperId).update({
      status: 'error',
      last_error: error.message,
      updated_at: new Date(),
    });

    await notify(`❌ Scraper error: *${scraperConfig.name}*\n${error.message}`);
  }
}

/**
 * Ingest scraper leads into the pipeline
 */
async function ingestScraperLeads(leads, campaignTag) {
  const { addLead, getLeadByEmail } = require('../services/db');
  const { v4: uuidv4 } = require('uuid');
  let ingested = 0;

  for (const lead of leads) {
    try {
      // Skip if we already have this company (dedup by company name since we may not have emails)
      if (lead.email) {
        const existing = await getLeadByEmail(lead.email);
        if (existing) continue;
      }

      // For leads without email, check by company name
      if (!lead.email && lead.company_name) {
        const compSnap = await db.collection('leads')
          .where('company_name', '==', lead.company_name)
          .where('source', '==', lead.source)
          .limit(1)
          .get();
        if (!compSnap.empty) continue;
      }

      const leadId = uuidv4();
      await addLead({
        lead_id: leadId,
        first_name: lead.first_name || '',
        last_name: lead.last_name || '',
        email: lead.email || '',
        company_name: lead.company_name || '',
        company_domain: lead.company_domain || '',
        role_title: lead.role_title || '',
        linkedin_url: lead.linkedin_url || '',
        source: lead.source || 'scraper',
        campaign_tag: campaignTag,
        status: 'ingested',
        score: null,
        tier: null,
        signal_type: null,
        signal_strength: null,
        signal_summary: null,
        custom_fields: lead.custom_fields || {},
      });
      ingested++;
    } catch (err) {
      console.error(`[scrapers] Failed to ingest lead ${lead.company_name}:`, err.message);
    }
  }

  return ingested;
}

// GET /api/scrapers/:id/runs - Get run history
router.get('/:id/runs', async (req, res) => {
  try {
    const snap = await scraperRuns
      .where('scraper_id', '==', req.params.id)
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();
    const runs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, runs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
