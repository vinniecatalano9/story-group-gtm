const { Router } = require('express');
const { claudeJSON } = require('../services/claude');
const { getLeadByEmail, updateLead, addReply, addLog } = require('../services/db');
const { removeLeads } = require('../services/instantly');
const { syncLead } = require('../services/hubspot');
const { notifyNewReply } = require('../services/slack');

const router = Router();

const CLASSIFY_PROMPT = (email, company, replyText) => `You are a sales reply classifier for Story Group, a PR/media services company.

Classify this email reply and suggest a response macro.

FROM: ${email} (${company || 'Unknown company'})
REPLY TEXT:
${replyText}

Return a JSON object:
{
  "classification": one of "interested", "not_interested", "why_reach_out", "more_info", "cost_question", "question_other", "referral", "re_engage", "ooo", "bounce", "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<1 sentence summary of reply>",
  "suggested_macro": one of "CALL_TIME", "WHY_REACH_OUT", "MORE_INFO", "COST_QUESTION", "RE_ENGAGE", "CASE_STUDY", "POST_BOOKING", "NONE",
  "suggested_action": "<brief action recommendation>",
  "draft_response": "<suggested reply, 50-90 words, professional tone>"
}

Return ONLY the JSON object, no other text.`;

/**
 * POST /api/reply
 * Instantly reply webhook — classify and route.
 */
router.post('/', async (req, res) => {
  try {
    const { email, reply_text, campaign_id, first_name, last_name, company_name } = req.body;

    if (!email || !reply_text) {
      return res.status(400).json({ error: 'email and reply_text required' });
    }

    console.log(`[reply] New reply from ${email}: ${reply_text.substring(0, 80)}...`);

    // Find the lead
    const lead = await getLeadByEmail(email);

    // Classify with Claude
    let classification;
    try {
      classification = await claudeJSON(
        CLASSIFY_PROMPT(email, company_name || lead?.company_name, reply_text),
        { timeout: 120000 }
      );
    } catch (e) {
      console.error('[reply] Classification failed:', e.message);
      classification = {
        classification: 'other',
        sentiment: 'neutral',
        summary: 'Classification failed',
        suggested_macro: 'NONE',
        suggested_action: 'Review manually',
        draft_response: '',
      };
    }

    // Store reply
    const replyId = await addReply({
      lead_id: lead?.id || null,
      email,
      reply_text,
      campaign_id,
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

    // Notify Slack for all non-ooo, non-bounce replies
    if (cls !== 'ooo' && cls !== 'bounce') {
      await notifyNewReply({
        email,
        company: company_name || lead?.company_name,
        classification: cls,
        sentiment: classification.sentiment,
        summary: classification.summary,
        draftResponse: classification.draft_response,
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
