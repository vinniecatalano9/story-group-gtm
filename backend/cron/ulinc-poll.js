const { pollNewMessages } = require('../services/ulinc');
const { claudeJSON } = require('../services/claude');
const { addReply, getRepliesByEmail, addLog, getLeadByEmail, updateLead } = require('../services/db');
const { syncLead } = require('../services/hubspot');
const { notifyNewReply } = require('../services/slack');
const { getAvailableSlots } = require('../services/calendar');

// Track processed message IDs to avoid duplicates across polls
const processedIds = new Set();
const MAX_PROCESSED = 5000; // cap memory usage

const CLASSIFY_PROMPT = (contactName, company, messageText, firstName, slots) => `You are a sales reply assistant for Story Group, a PR/media services company that gets CEOs and founders placed on major media outlets (FOX, CNN, WSJ, Bloomberg, etc.).

Classify this LinkedIn message and generate a draft response following our Reply Playbook.

FROM: ${contactName} (${company || 'Unknown company'}, first name: ${firstName || 'there'})
LINKEDIN MESSAGE:
${messageText}

=== REPLY PLAYBOOK RULES ===

GOLDEN RULE: Every reply has one job — move the conversation toward a booked call. Answer just enough to build trust. Save the full pitch for the meeting.

TONE: Like texting a professional contact. Casual, confident, human. NOT corporate, NOT over-excited. No "OMG" or "comprehensive suite of solutions." Short sentences.

LENGTH: 2-4 sentences max. Be vague ON PURPOSE — give just enough to hook, not enough to satisfy.

SPLIT MESSAGE FORMAT: Break the draft_response into 2-3 short messages separated by "---" on its own line. This mimics natural LinkedIn conversation:
- Message 1: Direct answer or acknowledgment (1-2 sentences)
- Message 2: Proof point or extra detail (1-2 sentences)
- Message 3 (optional): CTA to book a call (1 sentence)

IF THEY ASK MULTIPLE QUESTIONS: Answer only ONE — the one that sounds most impressive. Redirect the rest to a call.

CALENDAR LINK: go.storygroup.io/meetings/vincent-catalano

=== RESPONSE TEMPLATES BY SITUATION ===

INTERESTED / WANT TO TALK (CALL_TIME):
Message 1: "Hey ${firstName || 'there'}, sounds good!"
Message 2: "How does ${slots?.amSlot || 'tomorrow morning'} work? Or ${slots?.pmSlot || 'tomorrow afternoon'}? Send over a good number and I'll get you scheduled."
Message 3: "Or if easier, grab a time here: go.storygroup.io/meetings/vincent-catalano"

COST QUESTION (first time — stay vague):
Message 1: "Hey ${firstName || 'there'}, in terms of costs it really depends… since we're getting you strategic media coverage that puts you directly in front of your target market, we'd want to calculate that investment based on the ROI we'd bring you."
Message 2: "Would you be open to a quick call where we go over those factors so I can give you an exact price?"

COST QUESTION (second time — give ballpark):
Message 1: "Totally understand. Most of our clients invest somewhere between $4K-$22K/month depending on scope — media booking, full PR campaigns, digital, etc."
Message 2: "Happy to put together something specific for you after a quick call. Want to grab 15 minutes this week?"

MORE INFO / WHAT'S THE PROCESS (CASE_STUDY):
Message 1: "Great question — in short, we start by identifying your strongest story angles, then handle outreach to journalists, producers, and podcast hosts on your behalf."
Message 2: "There's a lot more to it depending on your goals though. Want to hop on a quick call so I can walk you through the full picture?"

WHY REACHING OUT (WHY_REACH_OUT):
Message 1: "Hey ${firstName || 'there'}, I was researching ${company || 'your company'} and thought you'd be a great fit for some media opportunities we have."
Message 2: "We work directly with reporters at FOX, CNN, WSJ, and others looking for high-level entrepreneurs to feature. Could help you attract customers, land speaking gigs, and build your personal brand."
Message 3: "Worth a quick chat?"

RE-ENGAGE (cold lead coming back):
Message 1: "Hey ${firstName || 'there'}, just circling back — we've had some new media opportunities come up that I think would be a great fit for ${company || 'your company'}."
Message 2: "Would you be open to a quick 10-minute call to see if it makes sense?"

REFERRAL:
Thank them warmly, ask for the referral's name/email/best way to reach them, mention you'll reference their name when reaching out.

NOT INTERESTED / REMOVE ME:
Do NOT try to convince them. Just classify as not_interested. No draft needed.

=== CASE STUDIES (rotate these as proof points) ===

1. HIGH-PROFILE ENTREPRENEUR: Orchestrated a global media tour — interviews on top-tier business networks, features in major financial publications. Result: millions in earned media value, new inbound interest from institutional investors and strategic partners.

2. NATIONAL NONPROFIT: Landed a feature in a major national outlet, TV appearances, radio interviews. Result: uptick in donor contributions, new corporate partners who cited coverage as first touchpoint, executive director booked for keynote stages at two national conferences.

3. POLITICAL ADVOCACY NONPROFIT: Op-eds in top-tier opinion pages, recurring guest slots on political podcasts, national cable news segments. Result: rapid growth in email list and donor base, policymakers referencing media hits in hearings.

=== OUTPUT FORMAT ===

Return a JSON object:
{
  "classification": one of "interested", "not_interested", "why_reach_out", "more_info", "cost_question", "question_other", "referral", "re_engage", "ooo", "other",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<1 sentence summary>",
  "suggested_macro": one of "CALL_TIME", "WHY_REACH_OUT", "MORE_INFO", "COST_QUESTION", "RE_ENGAGE", "CASE_STUDY", "REFERRAL", "NONE",
  "suggested_action": "<brief action recommendation>",
  "draft_response": "<2-3 short messages separated by --- following the playbook rules above. Personalize with their name and company. Be vague enough they NEED the call.>"
}

Return ONLY the JSON object, no other text.`;

async function processUlincMessages() {
  const messages = await pollNewMessages();
  if (!messages.length) return;

  console.log(`[ulinc] Processing ${messages.length} new message(s)`);

  for (const msg of messages) {
    // Build a unique ID from contact + message content hash
    const msgId = `${msg.contact_id}_${Buffer.from(msg.message || '').toString('base64').substring(0, 20)}`;
    if (processedIds.has(msgId)) continue;

    try {
      const contactName = [msg.first_name, msg.last_name].filter(Boolean).join(' ') || 'Unknown';
      const email = msg.email || msg.li_email || null;
      const company = msg.company || msg.company_name || null;
      const firstName = msg.first_name || null;
      const messageText = msg.message || msg.text || '';

      if (!messageText.trim()) {
        console.log(`[ulinc] Skipping empty message from ${contactName}`);
        continue;
      }

      console.log(`[ulinc] New message from ${contactName}: ${messageText.substring(0, 80)}...`);

      // Check if we have this person as a lead
      const lead = email ? await getLeadByEmail(email) : null;

      // Fetch calendar slots
      let slots = null;
      try { slots = await getAvailableSlots(); } catch (e) {
        console.warn('[ulinc] Calendar fetch failed:', e.message);
      }

      // Classify with Claude
      let classification;
      try {
        classification = await claudeJSON(
          CLASSIFY_PROMPT(contactName, company || lead?.company_name, messageText, firstName || lead?.first_name, slots),
          { timeout: 120000 }
        );
      } catch (e) {
        console.error('[ulinc] Classification failed:', e.message);
        classification = {
          classification: 'other',
          sentiment: 'neutral',
          summary: 'Classification failed',
          suggested_macro: 'NONE',
          suggested_action: 'Review manually',
          draft_response: '',
        };
      }

      // Store reply with ulinc source
      const replyId = await addReply({
        lead_id: lead?.id || null,
        email: email || `linkedin:${msg.contact_id}`,
        reply_text: messageText,
        source: 'ulinc',
        ulinc_contact_id: msg.contact_id,
        contact_name: contactName,
        linkedin_url: msg.li_url || msg.linkedin_url || null,
        campaign_id: msg.campaign_id || null,
        method: msg.method || 'linkedin',
        ...classification,
        handled: false,
      });

      const cls = classification.classification;

      // Update lead status if we have one
      if (lead) {
        if (cls === 'interested' || cls === 'referral') {
          await updateLead(lead.id, { status: 'replied', last_reply: cls, last_reply_source: 'ulinc' });
        } else if (cls === 'not_interested') {
          await updateLead(lead.id, { status: 'dead', last_reply: cls, last_reply_source: 'ulinc' });
        } else if (cls !== 'ooo') {
          await updateLead(lead.id, { status: 'replied', last_reply: cls, last_reply_source: 'ulinc' });
        }

        // HubSpot sync
        try {
          await syncLead({ ...lead, status: lead.status, last_reply: cls });
        } catch (e) {
          console.warn('[ulinc] HubSpot sync failed:', e.message);
        }
      }

      // Notify Slack (skip noise)
      if (cls !== 'ooo' && cls !== 'not_interested') {
        const identifier = email || contactName;
        const pastReplies = email
          ? (await getRepliesByEmail(email, 6)).filter(r => r.id !== replyId).slice(0, 5)
          : [];

        await notifyNewReply({
          email: `${contactName} (LinkedIn${email ? ` / ${email}` : ''})`,
          company: company || lead?.company_name,
          classification: cls,
          sentiment: classification.sentiment,
          summary: `[LinkedIn] ${classification.summary}`,
          draftResponse: classification.draft_response,
          pastReplies,
        });
      }

      await addLog('ulinc_reply', {
        contact_id: msg.contact_id,
        name: contactName,
        email,
        classification: cls,
        sentiment: classification.sentiment,
      });

      console.log(`[ulinc] ${contactName} → ${cls} (${classification.sentiment})`);

      // Track as processed
      processedIds.add(msgId);
      if (processedIds.size > MAX_PROCESSED) {
        // Trim oldest entries
        const arr = [...processedIds];
        arr.splice(0, 1000).forEach(id => processedIds.delete(id));
      }
    } catch (e) {
      console.error(`[ulinc] Error processing message from contact ${msg.contact_id}:`, e.message);
    }
  }
}

module.exports = { processUlincMessages, CLASSIFY_PROMPT };
