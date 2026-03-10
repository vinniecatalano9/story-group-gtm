const { Router } = require('express');
const { claudeJSON } = require('../services/claude');
const { scrapeWebsite, searchNews, searchGoogle } = require('../services/apify');
const { getLeadsByStatus, updateLead, addLog } = require('../services/db');
const { generateEmailPatterns } = require('../lib/email-patterns');
const { scoreLead } = require('../lib/scoring');
const instantly = require('../services/instantly');
const hubspot = require('../services/hubspot');
const slack = require('../services/slack');

const router = Router();

const CONTACT_FINDER_PROMPT = (company, websiteText) => `You are a B2B sales research assistant. Analyze the following company website content and identify the best person to contact for a sales outreach about PR/media services.

COMPANY: ${company}

WEBSITE CONTENT:
${websiteText}

Find the most senior decision-maker — ideally the founder, CEO, president, managing partner, or principal. If you can find multiple people, pick the one most likely to make buying decisions for PR/media services.

Return a JSON object:
{
  "first_name": "<first name or empty string>",
  "last_name": "<last name or empty string>",
  "role_title": "<their title, e.g. CEO, Founder, President>",
  "email": "<their email address if found on the site, otherwise empty string>",
  "linkedin_url": "<LinkedIn URL if found on the site, otherwise empty string>",
  "confidence": "high" | "medium" | "low",
  "source_note": "<brief note on where you found this info>"
}

IMPORTANT: Look carefully for email addresses on the website — in contact pages, about pages, team bios, footers, etc. The email is the most valuable piece of information.

If you cannot identify anyone, return empty strings for all fields with confidence "low".
Return ONLY the JSON object, no other text.`;

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

        // Step 0: If no domain, try to find one via Google search
        let domain = lead.company_domain;
        if (!domain && lead.company_name) {
          try {
            console.log(`[enrich] No domain for "${lead.company_name}", searching Google...`);
            const searchPages = await searchGoogle(lead.company_name + ' official website');
            // Flatten organic results from search pages
            const searchResults = searchPages.flatMap(p => p.organicResults || []);
            // Also check top-level url/link in case of flat format
            if (!searchResults.length) searchResults.push(...searchPages);
            for (const r of searchResults) {
              const url = r.url || r.link || '';
              if (url) {
                try {
                  const parsed = new URL(url);
                  const host = parsed.hostname.replace(/^www\./, '');
                  // Skip social media, directories, news sites
                  if (!/facebook|linkedin|twitter|yelp|bbb|mapquest|yellowpages|manta|dnb|bloomberg|crunchbase|glassdoor|indeed|google/.test(host)) {
                    domain = host;
                    console.log(`[enrich] Found domain via search: ${domain}`);
                    await updateLead(lead.id, { company_domain: domain });
                    break;
                  }
                } catch (_) {}
              }
            }
          } catch (e) {
            console.warn(`[enrich] Domain search failed for ${lead.company_name}:`, e.message);
          }
        }

        // Scrape website (if we have a domain)
        let websiteText = null;
        if (domain) {
          try {
            websiteText = await scrapeWebsite(domain);
          } catch (e) {
            console.warn(`[enrich] Website scrape failed for ${domain}:`, e.message);
          }
        }

        // Step 1: If no contact person, try to find one from website content
        if (websiteText && !lead.first_name && !lead.last_name) {
          try {
            console.log(`[enrich] Finding contact person for "${lead.company_name}"...`);
            const contact = await claudeJSON(
              CONTACT_FINDER_PROMPT(lead.company_name, websiteText.substring(0, 6000)),
              { timeout: 120000 }
            );
            if (contact.first_name && contact.last_name) {
              console.log(`[enrich] Found contact: ${contact.first_name} ${contact.last_name} (${contact.role_title})${contact.email ? ' email: ' + contact.email : ''}`);
              const contactUpdate = {
                first_name: contact.first_name,
                last_name: contact.last_name,
                role_title: contact.role_title || '',
                linkedin_url: contact.linkedin_url || lead.linkedin_url || '',
              };
              // Use email found on website if available
              if (contact.email && contact.email.includes('@')) {
                contactUpdate.email = contact.email.trim().toLowerCase();
                lead.email = contactUpdate.email;
                console.log(`[enrich] Found email on website: ${lead.email}`);
              }
              await updateLead(lead.id, contactUpdate);
              lead.first_name = contact.first_name;
              lead.last_name = contact.last_name;
              lead.role_title = contact.role_title || '';
              lead.linkedin_url = contact.linkedin_url || lead.linkedin_url || '';
            }
          } catch (e) {
            console.warn(`[enrich] Contact finder failed for ${lead.company_name}:`, e.message);
          }
        }

        // Search news
        let newsText = null;
        if (lead.company_name) {
          try {
            const newsPages = await searchNews(lead.company_name);
            const newsItems = newsPages.flatMap(p => p.organicResults || []);
            if (!newsItems.length) newsItems.push(...newsPages);
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

        // Email: prefer website-scraped email, fallback to pattern generation
        let email = lead.email;
        const emailDomain = domain || lead.company_domain;
        if (!email && lead.first_name && lead.last_name && emailDomain) {
          const patterns = generateEmailPatterns(lead.first_name, lead.last_name, emailDomain);
          email = patterns[0] || '';
          console.log(`[enrich] No email on site, using pattern fallback: ${email}`);
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
