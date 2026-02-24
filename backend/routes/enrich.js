const { Router } = require('express');
const { claudeJSON } = require('../services/claude');
const { scrapeWebsite, searchNews } = require('../services/apify');
const { getLeadsByStatus, updateLead, addLog } = require('../services/db');
const { generateEmailPatterns } = require('../lib/email-patterns');
const { scoreLead } = require('../lib/scoring');
const instantly = require('../services/instantly');
const hubspot = require('../services/hubspot');
const slack = require('../services/slack');

const router = Router();

const SIGNAL_DETECTION_PROMPT = (company, websiteText, newsResults) => `You are a B2B sales intelligence analyst for a PR/media services company called Story Group.

Analyze the following company data and detect intent signals that indicate they might need PR, media visibility, or thought leadership services.

COMPANY: ${company}

WEBSITE CONTENT:
${websiteText || 'No website data available'}

RECENT NEWS:
${newsResults || 'No recent news found'}

Return a JSON object with these fields:
{
  "intent_signal_type": one of: "funding_growth", "competitor_pr", "leadership_change", "product_launch", "industry_event", "negative_press", "hiring_comms", "content_gap", "active_ad_spend", "no_signal",
  "intent_signal_summary": "<30 word summary of the signal>",
  "signal_strength": "hot" | "warm" | "cold",
  "company_description": "<1 sentence company description>",
  "detected_industry": "<industry category>"
}

Return ONLY the JSON object, no other text.`;

/**
 * POST /api/enrich
 * Trigger enrichment for ingested leads.
 * Processes up to 10 leads per call.
 */
router.post('/', async (req, res) => {
  try {
    const batchSize = Math.min(parseInt(req.body.batch_size) || 10, 10);
    const leads = await getLeadsByStatus('ingested', batchSize);

    if (!leads.length) {
      return res.json({ success: true, message: 'No leads to enrich', processed: 0 });
    }

    console.log(`[enrich] Processing ${leads.length} leads...`);
    const results = [];

    for (const lead of leads) {
      try {
        // Mark as processing
        await updateLead(lead.id, { status: 'enriching' });

        // Scrape website (if we have a domain)
        let websiteText = null;
        if (lead.company_domain) {
          try {
            websiteText = await scrapeWebsite(lead.company_domain);
          } catch (e) {
            console.warn(`[enrich] Website scrape failed for ${lead.company_domain}:`, e.message);
          }
        }

        // Search news
        let newsText = null;
        if (lead.company_name) {
          try {
            const newsItems = await searchNews(lead.company_name);
            newsText = newsItems.map(n =>
              `${n.title || ''}: ${n.description || n.snippet || ''}`
            ).join('\n');
          } catch (e) {
            console.warn(`[enrich] News search failed for ${lead.company_name}:`, e.message);
          }
        }

        // Claude signal detection
        let signals = {
          intent_signal_type: 'no_signal',
          signal_strength: 'cold',
          intent_signal_summary: '',
          company_description: '',
          detected_industry: '',
        };

        if (websiteText || newsText) {
          try {
            signals = await claudeJSON(
              SIGNAL_DETECTION_PROMPT(lead.company_name, websiteText, newsText),
              { timeout: 180000 }
            );
          } catch (e) {
            console.warn(`[enrich] Claude analysis failed for ${lead.company_name}:`, e.message);
          }
        }

        // Waterfall email enrichment
        let email = lead.email;
        if (!email && lead.first_name && lead.last_name && lead.company_domain) {
          const patterns = generateEmailPatterns(lead.first_name, lead.last_name, lead.company_domain);
          email = patterns[0] || ''; // Use most common pattern as best guess
          console.log(`[enrich] Generated email pattern for ${lead.first_name} ${lead.last_name}: ${email}`);
        }

        // Score the lead
        const enrichedData = {
          email: email || lead.email,
          signal_type: signals.intent_signal_type || 'no_signal',
          signal_strength: signals.signal_strength || 'cold',
          signal_summary: signals.intent_signal_summary || '',
          company_description: signals.company_description || '',
          detected_industry: signals.detected_industry || '',
          enriched_at: new Date().toISOString(),
          status: 'enriched',
        };

        const { score, tier } = scoreLead({ ...lead, ...enrichedData });
        enrichedData.score = score;
        enrichedData.tier = tier;
        enrichedData.status = 'scored';

        await updateLead(lead.id, enrichedData);

        // Push to Instantly
        if (tier !== 'manual_review') {
          try {
            await instantly.addLeadsToCampaign(tier, [{ ...lead, ...enrichedData }]);
            await updateLead(lead.id, { status: 'emailed' });
            enrichedData.status = 'emailed';
          } catch (e) {
            console.warn(`[enrich] Instantly upload failed for ${lead.email}:`, e.message);
          }
        }

        // Sync to HubSpot
        try {
          const hsResult = await hubspot.syncLead({ ...lead, ...enrichedData });
          if (hsResult?.contactId) {
            await updateLead(lead.id, { hubspot_contact_id: hsResult.contactId });
          }
        } catch (e) {
          console.warn(`[enrich] HubSpot sync failed for ${lead.email}:`, e.message);
        }

        results.push({
          lead_id: lead.id,
          email: enrichedData.email,
          signal: signals.intent_signal_type,
          strength: signals.signal_strength,
          score,
          tier,
        });

        console.log(`[enrich] ${lead.email || lead.first_name}: ${signals.intent_signal_type} (${score}pts → ${tier})`);
      } catch (e) {
        console.error(`[enrich] Failed to process lead ${lead.id}:`, e.message);
        await updateLead(lead.id, { status: 'enrichment_failed', error: e.message });
      }
    }

    await addLog('enrichment', { processed: results.length, results });

    res.json({ success: true, processed: results.length, results });
  } catch (e) {
    console.error('[enrich] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
