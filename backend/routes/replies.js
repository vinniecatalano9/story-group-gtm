const { Router } = require('express');
const { claudeJSON } = require('../services/claude');
const { classifyReply } = require('../services/replyClassifier');
const { getLeadByEmail, updateLead, addReply, getRepliesByEmail, addLog } = require('../services/db');
const { removeLeads } = require('../services/instantly');
const { syncLead } = require('../services/hubspot');
const { syncReply: syncCoterie } = require('../services/coteriehq');
const { notifyNewReply } = require('../services/slack');
const { getAvailableSlots } = require('../services/calendar');

const router = Router();

// The inline CLASSIFY_PROMPT that lived here was dead code (never called — this
// route uses the shared classifyReply below) and still carried the retired March
// playbook. Removed 2026-08-05. Source of truth: services/replyClassifier.js.

/**
 * POST /api/reply
 * Instantly reply webhook — classify and route.
 */
router.post('/', async (req, res) => {
  try {
    // Instantly webhook v2 fields: lead_email, reply_text, campaign_id, email_id, email_account
    const raw = req.body;
    const email = raw.email || raw.lead_email;
    const reply_text = raw.reply_text;
    const campaign_id = raw.campaign_id;
    const first_name = raw.first_name;
    const last_name = raw.last_name;
    const company_name = raw.company_name;
    const email_uuid = raw.email_uuid || raw.email_id || raw.id || null;
    const eaccount = raw.eaccount || raw.email_account || null;

    console.log(`[reply] Webhook fields: email_id=${raw.email_id}, email_account=${raw.email_account}, lead_email=${raw.lead_email}, keys=${Object.keys(raw).join(',')}`);

    if (!email || !reply_text) {
      return res.status(400).json({ error: 'email and reply_text required' });
    }

    console.log(`[reply] New reply from ${email}: ${reply_text.substring(0, 80)}...`);

    // Find the lead
    const lead = await getLeadByEmail(email);

    // Fetch calendar availability for suggested times
    let slots = null;
    try { slots = await getAvailableSlots(); } catch (e) {
      console.warn('[reply] Calendar fetch failed:', e.message);
    }

    // Classify + draft with Claude using the unified Reply & Follow-Up Playbook
    const classification = await classifyReply({
      channel: 'email',
      email,
      company: company_name || lead?.company_name,
      replyText: reply_text,
      firstName: first_name || lead?.first_name,
      slots,
    });

    // Store reply (include Instantly email UUID + sending account for reply-back)
    const replyId = await addReply({
      lead_id: lead?.id || null,
      email,
      reply_text,
      campaign_id,
      email_uuid: email_uuid || null,
      eaccount: eaccount || null,
      source: 'instantly',
      ...classification,
      handled: false,
    });

    // Route based on classification
    const cls = classification.classification;

    if (cls === 'interested' || cls === 'referral') {
      // High value — notify immediately
      if (lead) await updateLead(lead.id, { status: 'replied', last_reply: cls });
    }
    else if (cls === 'not_interested') {
      // Remove from Instantly
      try { await removeLeads([email]); } catch (e) {
        console.warn('[reply] Failed to remove from Instantly:', e.message);
      }
      if (lead) await updateLead(lead.id, { status: 'dead', last_reply: cls });
    }
    else if (cls === 'bounce') {
      try { await removeLeads([email]); } catch (e) {
        console.warn('[reply] Failed to remove bounced lead:', e.message);
      }
      if (lead) await updateLead(lead.id, { status: 'dead', last_reply: 'bounce' });
    }
    else if (cls === 'ooo') {
      // Keep in campaign, just log
      if (lead) await updateLead(lead.id, { last_reply: 'ooo' });
    }
    else {
      // All others (why_reach_out, more_info, cost_question, etc.)
      if (lead) await updateLead(lead.id, { status: 'replied', last_reply: cls });
    }

    // Sync to HubSpot
    if (lead) {
      try {
        await syncLead({ ...lead, status: lead.status, last_reply: cls });
      } catch (e) {
        console.warn('[reply] HubSpot sync failed:', e.message);
      }
    }

    // Sync to CoterieHQ CRM
    try {
      await syncCoterie({ ...lead, email, status: lead?.status, had_meeting: lead?.had_meeting });
    } catch (e) {
      console.warn('[reply] CoterieHQ sync failed:', e.message);
    }

    // Notify Slack — skip ooo, bounce, and not_interested
    if (cls !== 'ooo' && cls !== 'bounce' && cls !== 'not_interested') {
      // Fetch previous replies for conversation context (skip the one we just stored)
      let pastReplies = [];
      try {
        pastReplies = (await getRepliesByEmail(email, 6))
          .filter(r => r.id !== replyId)
          .slice(0, 5);
      } catch (e) {
        console.warn('[reply] Past replies fetch failed:', e.message);
      }

      await notifyNewReply({
        email,
        company: company_name || lead?.company_name,
        classification: cls,
        sentiment: classification.sentiment,
        summary: classification.summary,
        draftResponse: classification.draft_response,
        pastReplies,
      });
    }

    await addLog('reply', { email, classification: cls, sentiment: classification.sentiment });

    console.log(`[reply] ${email} → ${cls} (${classification.sentiment})`);

    res.json({ success: true, reply_id: replyId, classification });
  } catch (e) {
    console.error('[reply] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
