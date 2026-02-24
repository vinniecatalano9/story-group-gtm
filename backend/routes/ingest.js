const { Router } = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { normalizeLead, validateEmail } = require('../lib/normalize');
const { addLead, getLeadByEmail, addLog } = require('../services/db');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * POST /api/ingest
 * Accept leads from any source: JSON body, CSV upload, or Apify webhook.
 *
 * JSON body: { leads: [...], source: "manual", campaign_tag: "q1-ceos" }
 * CSV: multipart form with file field "csv"
 * Apify: { items: [...], campaign_tag: "..." }
 */
router.post('/', upload.single('csv'), async (req, res) => {
  try {
    let rawLeads = [];
    let source = req.body.source || 'manual';
    let campaignTag = req.body.campaign_tag || '';

    // CSV upload
    if (req.file) {
      const csvData = req.file.buffer.toString('utf-8');
      rawLeads = parse(csvData, { columns: true, skip_empty_lines: true, trim: true });
      source = 'csv';
    }
    // Apify webhook format
    else if (req.body.items) {
      rawLeads = req.body.items;
      source = 'apify';
      campaignTag = req.body.campaign_tag || campaignTag;
    }
    // Generic JSON
    else if (req.body.leads) {
      rawLeads = req.body.leads;
    }
    // Single lead
    else if (req.body.email) {
      rawLeads = [req.body];
    }

    if (!rawLeads.length) {
      return res.status(400).json({ error: 'No leads provided' });
    }

    // Normalize + dedup
    const results = { ingested: 0, duplicates: 0, invalid: 0 };
    const ingestedLeads = [];

    for (const raw of rawLeads) {
      const lead = normalizeLead(raw, source, campaignTag);

      // Validate email
      if (!validateEmail(lead.email)) {
        // Keep lead but flag it — might get email via waterfall later
        if (!lead.first_name || !lead.company_name) {
          results.invalid++;
          continue;
        }
      }

      // Dedup check
      if (lead.email) {
        const existing = await getLeadByEmail(lead.email);
        if (existing) {
          results.duplicates++;
          continue;
        }
      }

      await addLead(lead);
      ingestedLeads.push(lead);
      results.ingested++;
    }

    await addLog('ingestion', {
      source,
      campaign_tag: campaignTag,
      total_received: rawLeads.length,
      ...results,
    });

    console.log(`[ingest] ${results.ingested} ingested, ${results.duplicates} dupes, ${results.invalid} invalid from ${source}`);

    res.json({
      success: true,
      ...results,
      leads: ingestedLeads.map(l => l.lead_id),
    });
  } catch (e) {
    console.error('[ingest] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
