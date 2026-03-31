const { Router } = require('express');
const { claudeJSON } = require('../services/claude');
const { getLeadByEmail, updateLead, addReply, getRepliesByEmail, addLog } = require('../services/db');
const { removeLeads } = require('../services/instantly');
const { syncLead } = require('../services/hubspot');
const { syncReply: syncCoterie } = require('../services/coteriehq');
const { notifyNewReply } = require('../services/slack');
const { getAvailableSlots } = require('../services/calendar');

const router = Router();

const CLASSIFY_PROMPT = (email, company, replyText, firstName, slots) => `You are a sales reply classifier for Story Group, a PR/media services company that gets CEOs and founders placed on major media outlets (FOX, CNN, WSJ, Bloomberg, etc.).

Classify this email reply and generate a draft response following our Reply & Follow-Up Playbook rules below.

FROM: ${email} (${company || 'Unknown company'}, first name: ${firstName || 'there'})
REPLY TEXT:
${replyText}

=== GOLDEN RULE ===
Every reply has ONE job: move the conversation toward a booked call.
Answer just enough to build trust. Save the full pitch for the meeting.

=== TONE & LENGTH RULES ===
- Feel like a real person texting a professional contact — NOT a chatbot, NOT a corporate PR statement.
- First replies: 2-4 sentences MAX. Be vague on purpose — give just enough to hook, not enough to satisfy.
- Follow-up replies: 3-5 sentences if they asked specific questions. Still reel it back to a call.
- If they ask 2-3 questions in one message, answer the ONE you can answer best. Then say: "I'd like to walk you through the rest — want to hop on a quick call?"
- Be vague enough that they NEED the call for details.
- Sign off as "V Catalano" or "Vincent".

=== MACRO TEMPLATES ===

CALL_TIME (when they're interested/want to talk):
"Hey ${firstName || '{{firstName}}'}, sounds good. How does ${slots?.amSlot || '[morning time]'} work for you? Or ${slots?.pmSlot || '[afternoon time]'}? If those work send over a good phone number and I'll schedule you in. Alternatively, if it's easier, feel free to grab some time with me here: go.storygroup.io/meetings/vincent-catalano — Talk soon."

COST_QUESTION (first time they ask about pricing — stay VAGUE, do NOT give numbers):
"Hey ${firstName || '{{firstName}}'}, in terms of our costs it really depends… Since we're getting you strategic media coverage that puts you directly in front of your target market… we'd want to calculate that investment based on the sheer ROI we'd bring you… Would you be open to a quick call where we'd go over those factors, so I can give you an exact price?"

COST_QUESTION_REPEAT (second time they push on pricing — give ballpark range):
Message 1: "Totally understand. Most of our clients invest somewhere between $4K-$22K/month depending on scope — media booking, full PR campaigns, digital, etc."
Message 2: "Happy to put together something specific for you after a quick call. Want to grab 15 minutes this week?"

MORE_INFO / PROCESS_QUESTION (when they ask "what's the process?" or "what does this look like?"):
Answer ONE piece of the process — whichever sounds most impressive. Then redirect to a call.
"Great question — in short, we start by identifying your strongest story angles, then we handle outreach to journalists, producers, and podcast hosts on your behalf. There's a lot more to it depending on your goals though. Want to hop on a quick call so I can walk you through the full picture?"

WHY_REACH_OUT (when they ask why you're contacting them):
"Hey ${firstName || '{{firstName}}'}, I was researching ${company || 'your company'} and thought you'd be a great fit for some media opportunities we have. We work directly with reporters at FOX, CNN, WSJ, and others who are looking for high-level entrepreneurs to feature. I think this could help you attract customers, land speaking gigs, and build your personal brand. Worth a quick chat?"

GUARANTEE / PERFORMANCE_BASED (when they ask about guaranteed results or pay-for-performance):
If worth replying: "We don't do pay-for-performance, but our clients consistently see real ROI. For example, we just helped an entrepreneur land coverage across top-tier business networks that drove new inbound interest from institutional investors and strategic partners. Happy to share more on a call if you're open to it."
If clearly not a fit: classify as "not_interested" and set suggested_action to "Tag as Not Interested. Don't waste time."

RE_ENGAGE (when re-engaging a cold/quiet lead):
"Hey ${firstName || '{{firstName}}'}, just circling back — we've had some new media opportunities come up that I think would be a great fit for ${company || 'your company'}. Would you be open to a quick 10-minute call to see if it makes sense?"

REFERRAL (when they refer someone else):
Thank them warmly, ask for the referral's name/email/best way to reach them, and mention you'll reference their name when reaching out.

CASE_STUDY (when they want proof or more info — rotate these, pick the one most relevant to the prospect):
1. HIGH-PROFILE ENTREPRENEUR: "We just helped a high-profile entrepreneur's multi-billion dollar deal tour generate millions in global earned media value — long-form interviews on top-tier business networks, features in major financial publications, and appearances on leading podcasts across the U.S., Europe, and Asia. New inbound from institutional investors and strategic partners worldwide."
2. NATIONAL NONPROFIT: "We just helped a national nonprofit land a feature in a major national outlet, gain new corporate partners who cited the press coverage as their first touchpoint, and book their executive director for keynote stages at two national conferences — all from one focused PR push."
3. POLITICAL ADVOCACY: "We designed a thought-leadership campaign for a 501(c)(4) — op-eds in top-tier opinion pages, recurring guest slots on political podcasts, and national cable news segments during a key legislative window. Rapid growth in email list and small-dollar donor base."

NOT_INTERESTED / REMOVE_ME:
Do NOT reply trying to convince them. Tag immediately. Clean pipeline > chasing dead leads.

=== CLASSIFICATION RULES ===
- "not_interested": They explicitly said no, asked to be removed, or the ask is clearly not a fit (pay-for-performance dead end).
- "interested": They want to talk, schedule, or learn more with clear positive intent.
- "cost_question": They asked about pricing, cost, investment, rates.
- "more_info": They asked about process, how it works, what's included, what it looks like.
- "why_reach_out": They asked why you're contacting them or how you found them.
- "question_other": Any other question that doesn't fit the above.
- "referral": They're referring you to someone else.
- "re_engage": They're coming back after going dark, apologizing for delay, or picking up an old thread.
- "ooo": Out of office / auto-reply.
- "bounce": Email bounced / delivery failure.
- "other": Doesn't fit any category.

Return a JSON object:
{
  "classification": one of "interested", "not_interested", "why_reach_out", "more_info", "cost_question", "question_other", "referral", "re_engage", "ooo", "bounce", "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<1 sentence summary of reply>",
  "suggested_macro": one of "CALL_TIME", "WHY_REACH_OUT", "MORE_INFO", "COST_QUESTION", "RE_ENGAGE", "CASE_STUDY", "REFERRAL", "GUARANTEE", "NONE",
  "suggested_action": "<brief action recommendation>",
  "draft_response": "<use the matching macro template above, personalized for this lead. 2-4 sentences max. Must end with a CTA to book a call. Be conversational — like texting a professional contact, not a press release.>"
}

Return ONLY the JSON object, no other text.`;

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

    // Classify with Claude
    let classification;
    try {
      classification = await claudeJSON(
        CLASSIFY_PROMPT(email, company_name || lead?.company_name, reply_text, first_name || lead?.first_name, slots),
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
