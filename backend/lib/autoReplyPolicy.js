// lib/autoReplyPolicy.js
//
// Plain code decides whether an incoming LinkedIn reply could go out on its
// own. Claude only labels the message (services/autoReplyLabel.js); nothing in
// here calls a model. Every gate has to pass for SEND_TEMPLATE. Any miss is a
// DRAFT for a person, and the failed gates are recorded so the shadow week
// shows exactly why.
//
// Built from every HeyReach reply through 2026-10-20 (REPLY_LIBRARY.md and
// VOICE_GUIDE.md in the engine repo, auto-reply/). The template text is
// Vincent's own, word for word, from the referral partner threads he writes
// as Aaron. Only shadow mode exists: this decides, it never sends.

const AARON_ACCOUNT_ID = 207805;

// The referral partner campaign's opener. Aaron's inbox also holds personal,
// client and inbound threads, so only threads that started with this are in
// the referral lane.
const REFERRAL_OPENER = /CEO of Story Group/i;

// Hard blocks that do not trust the label.
const PRICE_OR_TERMS = /\$|\bprice|\bpricing|\bcost|\brates?\b|\bfees?\b|\bbudget|\bretainer|\bcontract|\bterms\b|\binvoice|\bpay\b|\bpaid\b|\bpaying|\bcommission|\bguarant|\bpercent|\bminimum|\brev(enue)? ?share/i;
const KNOWN_RELATIONSHIP = /great (to|meeting) (see|hear from|meet|connect with) you|good to (see|hear from) you|nice (meeting|to meet) you|how'?s the family|as we discussed|met you at|we met|last week at|catch up/i;
// A call request that names any day, time or timing ("next week", "Tuesday
// afternoon", "when I'm back") needs a person: the template would offer the
// wrong week.
const NAMES_TIMING = /\b(today|tomorrow|tonight|next|later|after|before|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|morning|afternoon|evening|am|pm|noon|back|return\w*|travel\w*|ooo|vacation|q[1-4])\b|\d/i;
const MEDIA_OR_DEAL = /\b(journalist|reporter|editor|producer|podcast host|acqui\w*|investor|investment|private equity|family office|lawyer|attorney|legal|cease)\b/i;

const TEMPLATES = {
  close_no: () =>
    "No worries. Best of luck, and please reach out if you're ever looking for something like this in the future.",
  times: ({ day, time1, time2 }) => `Great. Are you free ${day} at ${time1} or ${time2} EST?`,
};

// What each label would get. Anything not listed is always a draft.
const AUTO_TYPES = {
  plain_no:   { action: 'SEND_TEMPLATE', template: 'close_no', tag: 'Not Interested' },
  soft_no:    { action: 'SEND_TEMPLATE', template: 'close_no', tag: 'Not Interested' },
  wants_call: { action: 'SEND_TEMPLATE', template: 'times',    tag: 'Interested' },
  ooo:        { action: 'SKIP_AND_TAG',  template: null,       tag: 'Out of Office' },
  remove_me:  { action: 'SKIP_AND_TAG',  template: null,       tag: 'Not Interested', suppress: true },
};

// Skips send nothing, so they only need the label, the lane and the switch.
const SKIP_GATES = ['mode', 'type_auto', 'type_enabled', 'lane', 'confidence'];

function list(v, fallback) {
  return String(v ?? fallback).split(',').map(s => s.trim()).filter(Boolean);
}

function config(env = process.env) {
  return {
    mode: (env.AUTO_REPLY_MODE || 'off').toLowerCase(), // off | shadow
    types: list(env.AUTO_REPLY_TYPES, Object.keys(AUTO_TYPES).join(',')),
    lanes: list(env.AUTO_REPLY_LANES, 'referral'),
    minConfidence: Number(env.AUTO_REPLY_MIN_CONFIDENCE || 0.9),
    maxChars: Number(env.AUTO_REPLY_MAX_CHARS || 300),
    dailyCap: Number(env.AUTO_REPLY_DAILY_CAP || 10),
  };
}

/**
 * Facts about the thread that code can read without a model.
 * messages: HeyReach GetConversationsV2 messages, oldest first.
 */
function threadFacts({ messages = [], accountId }) {
  const ms = messages.filter(m => (m.body || '').trim());
  const first = ms[0];
  const firstTheirs = ms.findIndex(m => m.sender === 'CORRESPONDENT');
  let theirTurns = 0;
  let prev = null;
  for (const m of ms) {
    if (m.sender === 'CORRESPONDENT' && prev !== 'CORRESPONDENT') theirTurns++;
    prev = m.sender;
  }
  const startedByUs = !!first && first.sender === 'ME';
  let lane = 'inbound';
  if (startedByUs) {
    lane = Number(accountId) === AARON_ACCOUNT_ID && REFERRAL_OPENER.test(first.body || '')
      ? 'referral'
      : 'campaign_other';
  }
  return {
    lane,
    startedByUs,
    theirTurns,
    // Anything we typed after their first message means a person is already in it.
    weReplied: firstTheirs >= 0 && ms.slice(firstTheirs).some(m => m.sender === 'ME'),
    // HeyReach's inbox can lag the webhook. If their message isn't last, the
    // thread we read is stale or already answered.
    lastFromThem: ms.length > 0 && ms[ms.length - 1].sender === 'CORRESPONDENT',
    ourLastMessage: [...ms].reverse().find(m => m.sender === 'ME')?.body || '',
  };
}

/**
 * Decide what would happen to one reply.
 * Returns { action: SEND_TEMPLATE | SKIP_AND_TAG | DRAFT, type, template, tag, suppress, failed, gates }.
 */
function decide({ label, replyText, facts, accountId, cfg = config(), sentToLeadBefore = false, sentTodayForAccount = 0, blocklisted = false }) {
  const gates = [];
  const gate = (name, pass, why) => gates.push({ gate: name, pass: !!pass, why });
  const type = (label && label.type) || 'unknown';
  const rule = AUTO_TYPES[type];
  const text = String(replyText || '');
  const isAaron = Number(accountId) === AARON_ACCOUNT_ID;
  const questions = (text.match(/\?/g) || []).length;

  gate('mode', cfg.mode !== 'off', `mode is ${cfg.mode}`);
  gate('type_auto', !!rule, `labeled ${type}`);
  gate('type_enabled', !!rule && cfg.types.includes(type), `enabled: ${cfg.types.join(',')}`);
  gate('lane', !!facts && cfg.lanes.includes(facts.lane), `lane is ${facts ? facts.lane : 'unknown (thread not read)'}`);
  gate('confidence', Number(label && label.confidence) >= cfg.minConfidence, `confidence ${label && label.confidence}`);
  gate('first_turn', !!facts && facts.theirTurns === 1 && !facts.weReplied && facts.lastFromThem,
    facts ? `their turn ${facts.theirTurns}, we replied ${facts.weReplied}, last from them ${facts.lastFromThem}` : 'thread not read');
  gate('no_price_or_terms', !PRICE_OR_TERMS.test(text) && !(label && label.mentions_price_or_terms), 'price or terms words');
  gate('no_relationship', !(label && (label.mentions_aaron || label.existing_relationship)) &&
    !KNOWN_RELATIONSHIP.test(text) && !(!isAaron && /\baaron\b/i.test(text)), 'knows Aaron or us');
  gate('no_media_or_deal', !MEDIA_OR_DEAL.test(text), 'media, investor, acquisition or legal words');
  gate('not_blocklisted', !blocklisted, 'on the do-not-auto list');
  // "What does next week look like?" is fine for a call request. Anything
  // else with a question needs a person.
  gate('no_question', type === 'wants_call' ? questions <= 1 : questions === 0, `${questions} question mark(s)`);
  gate('short', text.length <= cfg.maxChars, `${text.length} chars`);
  gate('no_timing_named', type !== 'wants_call' || (!NAMES_TIMING.test(text) && !(label && label.named_time) && !(label && label.gave_email)),
    'named a day, time or timing, or gave an email');
  gate('once_per_lead', !sentToLeadBefore, 'already auto-handled in the last 30 days');
  gate('daily_cap', sentTodayForAccount < cfg.dailyCap, `${sentTodayForAccount} today, cap ${cfg.dailyCap}`);

  const required = rule && rule.action === 'SKIP_AND_TAG' ? SKIP_GATES : gates.map(g => g.gate);
  const failed = gates.filter(g => required.includes(g.gate) && !g.pass).map(g => g.gate);
  const action = failed.length || !rule ? 'DRAFT' : rule.action;
  return {
    action,
    type,
    template: action === 'SEND_TEMPLATE' ? rule.template : null,
    tag: rule ? rule.tag : '',
    suppress: action === 'SKIP_AND_TAG' && !!(rule && rule.suppress),
    failed,
    gates,
  };
}

function render(template, vars = {}) {
  const fn = TEMPLATES[template];
  if (!fn) throw new Error(`Unknown auto-reply template "${template}"`);
  return fn(vars);
}

module.exports = { config, threadFacts, decide, render, TEMPLATES, AUTO_TYPES, AARON_ACCOUNT_ID, REFERRAL_OPENER };
