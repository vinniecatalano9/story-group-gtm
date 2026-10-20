// services/autoReplyLabel.js
//
// Classify-only prompt for the auto-reply policy. Claude labels the message
// and writes nothing to the prospect. lib/autoReplyPolicy.js decides what
// happens with the label. Runs on Haiku through the existing claude -p path
// to keep quota use low.

const { claudeJSON } = require('./claude');

const TYPES = {
  plain_no: 'A clear no with nothing to answer: "not interested", "no thanks", "not a fit", "I\'m all set", "not relevant to us".',
  soft_no: 'A no that leaves the door open, with no date and no question: "I\'ll keep you in mind", "not now, but let\'s stay in touch".',
  wants_call: 'They agree to talk or ask for times ("happy to chat", "sure, let\'s connect", "send me some times", "what does next week look like?") and they did NOT name a day or time, did NOT send a link, did NOT give an email or phone, and did NOT ask anything else.',
  picked_time: 'They named a day or time, or accepted one we offered.',
  shared_contact: 'They gave an email or phone number.',
  their_link: 'They sent their own calendar link or point to an assistant to book.',
  timing: 'Not now, later: "reach out in Q1", "after the launch", "next month".',
  interested: 'Positive but no call request and no question: "interesting", "tell me more", "yes".',
  question: 'Any question about the offer, process, fit, who we work with, the partnership, price or terms.',
  send_info: 'Asks for a website, deck, one-pager or info to read.',
  referral: 'Says they are not the right person or points to someone else.',
  ooo: 'An out of office or auto-reply.',
  remove_me: 'Asks us to stop, remove them, or is hostile.',
  pleasantry: 'Thanks for connecting, an emoji, a birthday wish, no intent.',
  pitching_us: 'They pitch their own product or service to us.',
  other: 'Anything else, or unclear.',
};

function buildPrompt({ replyText, ourLastMessage, lane }) {
  const typeLines = Object.entries(TYPES).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `You label one LinkedIn reply to Story Group's outreach. Story Group is a PR firm. ${lane === 'referral'
    ? 'This thread is the referral partner campaign: Aaron Evans (CEO) asked consultants and fractional CMOs to refer clients to us.'
    : 'This is outreach from one of our senders.'}

You only label. Do not write a reply.

OUR LAST MESSAGE (context only):
${String(ourLastMessage || '(none)').slice(0, 1200)}

THEIR REPLY:
${String(replyText || '').slice(0, 2000)}

Pick exactly one type, the most specific:
${typeLines}

Then set these flags from THEIR REPLY only:
- confidence: 0 to 1, how sure you are of the type. Below 0.9 if anything is ambiguous.
- has_question: true if they ask anything.
- mentions_price_or_terms: true if they mention price, cost, budget, fees, retainer, contract, terms, commission, referral fee, payment or percentages.
- mentions_aaron: true only if they show personal familiarity with Aaron beyond a greeting ("great to see you Aaron", "how's the family").
- existing_relationship: true if they already know us, are a client, or met us somewhere.
- gave_email: true if their reply contains an email address.
- named_time: true if they name a day or time.
- ooo_return_date: the return date as YYYY-MM-DD if this is an out of office that gives one, else "".

Return ONLY this JSON, no other text:
{"type":"...","confidence":0.0,"has_question":false,"mentions_price_or_terms":false,"mentions_aaron":false,"existing_relationship":false,"gave_email":false,"named_time":false,"ooo_return_date":""}`;
}

async function labelReply({ replyText, ourLastMessage = '', lane = '' }) {
  try {
    const r = await claudeJSON(buildPrompt({ replyText, ourLastMessage, lane }), {
      model: process.env.AUTO_REPLY_MODEL || 'haiku',
      timeout: 60000,
      maxTokens: 400,
    });
    const type = Object.prototype.hasOwnProperty.call(TYPES, r && r.type) ? r.type : 'other';
    return {
      type,
      confidence: Math.max(0, Math.min(1, Number(r && r.confidence) || 0)),
      has_question: r && r.has_question === true,
      mentions_price_or_terms: r && r.mentions_price_or_terms === true,
      mentions_aaron: r && r.mentions_aaron === true,
      existing_relationship: r && r.existing_relationship === true,
      gave_email: r && r.gave_email === true,
      named_time: r && r.named_time === true,
      ooo_return_date: (r && typeof r.ooo_return_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.ooo_return_date)) ? r.ooo_return_date : '',
    };
  } catch (e) {
    console.warn('[autoReplyLabel] Failed:', e.message);
    // A failed label is a zero-confidence "other": the policy turns it into a draft.
    return { type: 'other', confidence: 0, failed: true, error: e.message };
  }
}

module.exports = { labelReply, TYPES, buildPrompt };
