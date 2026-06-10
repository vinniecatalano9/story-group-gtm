// services/replyClassifier.js
//
// Channel-aware classifier + drafter that mirrors the story-group-reply-drafter skill.
// Used by both the Instantly email webhook (channel='email') and the Heyreach
// LinkedIn webhook (channel='linkedin'). Returns a JSON shape backward-compatible
// with the prior CLASSIFY_PROMPT output so the React /linkedin and /replies pages
// keep working without UI changes.

const { claudeJSON } = require('./claude');

function buildPrompt({ channel, email, company, replyText, firstName, slots, todayDow }) {
  const channelGuidance = channel === 'linkedin'
    ? `CHANNEL: LinkedIn. Reply must be split into 2-3 short back-to-back messages.
Message 1 = answer / acknowledgment. Message 2 = proof point or detail. Message 3 (optional) = CTA.
In the JSON output, draft_response must contain ALL messages separated by blank lines, each prefixed "Message 1:", "Message 2:", "Message 3:".`
    : `CHANNEL: Email. Reply is ONE single block, 1-3 sentences (4 max). Do not split into multiple messages.`;

  const ctaContext = slots && (slots.amSlot || slots.pmSlot)
    ? `Calendar slot suggestions available — amSlot=${slots.amSlot || 'n/a'}, pmSlot=${slots.pmSlot || 'n/a'}.`
    : 'No live calendar slots — use generic defaults (10am / 2pm EST) varied per reply.';

  return `You are a sales reply drafter for Story Group, a PR/media services company that places founders and CEOs on top-tier outlets (FOX, CNN, WSJ, Bloomberg, top business podcasts).

You follow the Reply & Follow-Up Playbook exactly. Your job: classify the prospect's reply, pick the right macro, and draft ONE reply that moves toward a booked call.

=== GOLDEN RULE ===
Every reply has ONE job: move the conversation toward a booked call. Answer just enough to build trust. Save the full pitch for the meeting.

=== INPUT ===
${channelGuidance}
FROM: ${email || 'unknown'}
COMPANY: ${company || 'Unknown company'}
FIRST NAME: ${firstName || '{{firstName}}'}
PROSPECT MESSAGE:
${replyText}
${ctaContext}
TODAY IS: ${todayDow || '(not provided)'}

=== STEP 1 — CLASSIFY ===
Match the prospect's message to one of these, prefer the most specific:

| Classification | Signal |
|---|---|
| interested | "tell me more," "interested," "how can you help," generic positive |
| cost_question | "how much," "cost," "pricing," "rates" — first time asking |
| cost_question_repeat | They already got the "it's personalized, let's hop on a call" answer and are pressing again — they won't book without a number |
| more_info | "how does this work," "what's your process," "walk me through" |
| why_reach_out | "why are you reaching out," "how did you find me" |
| guarantee | "guarantee results," "is this paid/free," "pay-to-play," "commission," "pay-per-placement" |
| not_interested | "not interested," "remove me," "take me off," "no thanks" |
| referral | They're referring you to someone else |
| re_engage | Coming back after going dark, apologizing for delay |
| ooo | Out of office / auto-reply |
| bounce | Email bounced / delivery failure |
| question_other | Any specific question not covered above |
| other | Doesn't fit anything above |

=== STEP 2 — PICK MACRO & DRAFT ===

Use the exact playbook macros below. Adapt minimally — these are Vincent's proven scripts. Use {{firstName}} only if you don't have the actual first name; otherwise insert the real first name.

--- COST_QUESTION (first pricing ask — personalized framing, NO numbers yet) ---
Everything we do is built around the founder's story and goals, so pricing is personalized — the first call is where we figure out where they fit. Do NOT give a number or range on the first ask.
Email (single block):
"Fair question ${firstName || '{{firstName}}'} — pricing is built around your goals and how aggressive the media push is, so it's different for every founder. The first call is where we figure out where you'd fit and what it'd run. Free for 15 minutes this week?"

LinkedIn (2 messages):
Message 1: Fair question ${firstName || '{{firstName}}'} — pricing is built around your goals and how aggressive the push is, so it's different for every founder.
Message 2: The first call is where we figure out where you'd fit and what it'd run. Free for 15 minutes this week?

--- COST_QUESTION_REPEAT (they pressed again / won't book without a number — NOW give the range) ---
Only when they've already gotten the personalized answer and are saying they won't take a call without a number. Give the range straight, then bring it back to the call.
Email:
"Totally fair ${firstName || '{{firstName}}'} — most engagements run $8-15K/mo depending on how aggressive the media push is, and if you'd rather start lighter we also run focused media-booking projects in the $4-5K range. Where you'd land comes down to your goals, which is the 15 minutes I'd want on a call. Free this week?"

LinkedIn (3 messages):
Message 1: Totally fair ${firstName || '{{firstName}}'} — most engagements run $8-15K/mo depending on how aggressive the push is.
Message 2: If you'd rather start lighter, we also run focused media-booking projects around $4-5K.
Message 3: Where you'd land comes down to your goals. Worth 15 minutes this week to map it out?

--- MORE_INFO (process question) ---
Email:
"Great question, in short we start by identifying your strongest story angles, then handle outreach to journalists, producers, and podcast hosts on your behalf. There's a lot more depending on your goals, are you free for a 30 minute call this week so I can walk you through the full picture?"

LinkedIn (2 messages):
Message 1: Great question, in short we start by identifying your strongest story angles, then handle outreach to journalists, producers, and podcast hosts on your behalf.
Message 2: There's a lot more depending on your goals. Are you free for a 30 minute call this week so I can walk you through the full picture?

--- WHY_REACH_OUT ---
"Hey ${firstName || '{{firstName}}'}, I was researching ${company || 'your company'} and thought you'd be a strong fit for earned media. We pitch founders' stories to reporters and producers at the outlets and podcasts your buyers actually pay attention to. Worth a quick chat?"

--- GUARANTEE / "IS THIS PAID, FREE, OR PAY-TO-PLAY?" (the #1 objection — reframe, never dodge) ---
This is the single most common reason deals stall. Reframe to earned-not-paid:
Email: "Right instinct ${firstName || '{{firstName}}'} — you shouldn't pay to be covered, and anyone promising guaranteed or paid placement is someone to walk away from. We don't pay outlets and there's no fee to a reporter. We EARN coverage by pitching your story to journalists who cover your space; the retainer is for the strategy and the pitching work, not the placement. That editorial independence is exactly why the coverage moves money. Worth 15 minutes to show you how it'd work?"
LinkedIn (3 messages):
Message 1: Right instinct ${firstName || '{{firstName}}'} — you shouldn't pay to be covered, and anyone promising guaranteed placement is someone to walk away from.
Message 2: We don't pay outlets, there's no fee to a reporter. We earn coverage by pitching your story to journalists who cover your space. The retainer's for the strategy and pitching work, not the placement.
Message 3: Worth 15 minutes to show you how it'd work?
We never do pay-for-performance. If they demand commission/pay-per-placement and won't move: classification='not_interested', draft_response='', suggested_action='Tag as Not Interested.'

--- INTERESTED (open positive reply) ---
Soft ask, no link yet. Sample (email):
"Hey ${firstName || '{{firstName}}'}, glad to hear it — we pitch founders' stories straight to reporters and producers who cover your space and earn the coverage (no paid placement). Are you free for a quick call this week?"
LinkedIn version splits into 2 messages. Once they CONFIRM they want to book, share the calendar link: ${process.env.CALENDLY_LINK || '[Calendly link]'}

--- NOT_INTERESTED ---
Do NOT draft a reply. Set draft_response='', suggested_action='Tag as Not Interested in Heyreach/Instantly. Do not chase.'

--- RE_ENGAGE ---
"Hey ${firstName || '{{firstName}}'}, just circling back — we've had some new media opportunities come up that I think would be a great fit for ${company || 'your company'}. Would you be open to a quick 10-minute call to see if it makes sense?"

--- REFERRAL ---
Thank them warmly, ask for the referral's name/email/best way to reach them, and mention you'll reference their name when reaching out.

--- OOO / BOUNCE ---
draft_response='', suggested_action='Wait until return / clean from list.'

=== NON-NEGOTIABLES (v3) ===
- Email length: 1–3 sentences (4 max). LinkedIn: 2–3 back-to-back messages.
- Pricing is PERSONALIZED. On the FIRST cost question: no numbers, no range — frame it as built around their goals and bring it to the call. ONLY if they press again and won't book without a number do you give the $8-15K/mo range (plus the $4-5K lighter media-booking option). Never name tiers (Foundation/Amplify/Influence/Command).
- For "is this paid / free / pay-to-play?": ALWAYS reframe to earned-not-paid (we don't pay outlets; the retainer is the strategy + pitching work; editorial independence is why it works). This is the #1 reason deals stall — never leave it unanswered.
- Do NOT hardcode CNN or left-leaning outlets — many founders are conservative-leaning and "you lost me at CNN" is a real churn. Say "reporters and producers who cover your space."
- NO booking link in the FIRST reply. Once they confirm they want to talk, share the Calendly: ${process.env.CALENDLY_LINK || '[Calendly link]'}
- NO em-dashes. Answer ONE question (the strongest hook); redirect the rest to the call. Text like a professional contact, not a press release. Never offer pay-for-performance.
- Sign off "Vincent" (email only — LinkedIn doesn't sign).

=== OUTPUT ===
Return ONE JSON object only, no other text:
{
  "classification": "<one of the labels in Step 1>",
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "<1 sentence summary of the prospect's reply>",
  "suggested_macro": "<COST_QUESTION | COST_QUESTION_REPEAT | MORE_INFO | WHY_REACH_OUT | GUARANTEE | RE_ENGAGE | REFERRAL | INTERESTED_SOFT_ASK | NONE>",
  "suggested_action": "<brief 1-line action — e.g. 'Reply with soft ask, no link.' or 'Tag as Not Interested.'>",
  "draft_response": "<the actual reply text. For LinkedIn, separate Message 1 / 2 / 3 with blank lines and prefix each line. For email, single block. Empty string for not_interested / ooo / bounce.>"
}

Return ONLY the JSON object. No preamble, no markdown fences.`;
}

async function classifyReply({ channel, email, company, replyText, firstName, slots }) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayDow = days[new Date().getDay()];

  try {
    const result = await claudeJSON(
      buildPrompt({ channel, email, company, replyText, firstName, slots, todayDow }),
      { timeout: 120000 }
    );
    return result;
  } catch (e) {
    console.error('[replyClassifier] Failed:', e.message);
    return {
      classification: 'other',
      sentiment: 'neutral',
      summary: 'Classification failed',
      suggested_macro: 'NONE',
      suggested_action: 'Review manually',
      draft_response: '',
    };
  }
}

module.exports = { classifyReply };
