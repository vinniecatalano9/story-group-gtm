// services/autoReply.js
//
// Shadow-mode auto-reply for Story Group LinkedIn replies. For each new reply
// it reads the HeyReach thread, has Claude label the message, lets plain code
// (lib/autoReplyPolicy.js) decide, and records what it WOULD have done. It
// never sends a message and never tags or stops a lead in HeyReach. Going
// live is a separate change that needs Vincent's and Aaron's OK.
//
// Output: one row per reply in Firestore `auto_reply_log`, plus an
// `auto_reply` summary on the reply doc so the LinkedIn Replies card shows it.
// Slack is switched off on purpose (services/slack.js), so nothing posts there.
//
// Env: AUTO_REPLY_MODE=off|shadow (default off), AUTO_REPLY_TYPES,
// AUTO_REPLY_LANES (default referral), AUTO_REPLY_MIN_CONFIDENCE,
// AUTO_REPLY_MAX_CHARS, AUTO_REPLY_DAILY_CAP, AUTO_REPLY_MODEL (default haiku).

const axios = require('axios');
const crypto = require('crypto');
const policy = require('../lib/autoReplyPolicy');
const { labelReply } = require('./autoReplyLabel');
const { findMeetingSlots } = require('./calendar');

const HEYREACH_BASE = 'https://api.heyreach.io/api/public';
const API_KEY = () => process.env.HEYREACH_API_KEY;

function etDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function normUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

function blockKey(profileUrl) {
  return crypto.createHash('sha1').update(normUrl(profileUrl)).digest('hex');
}

/**
 * One conversation, oldest message first. GetConversationsV2 has no
 * fetch-by-id, so search by the lead's name inside the sender's inbox and
 * match the id. Returns null when it can't be found.
 */
async function fetchConversation({ conversationId, name, accountId }) {
  if (!API_KEY() || !conversationId || !name) return null;
  try {
    const filters = { searchString: name };
    if (accountId) filters.linkedInAccountIds = [Number(accountId)];
    const r = await axios.post(`${HEYREACH_BASE}/inbox/GetConversationsV2`,
      { filters, offset: 0, limit: 50 },
      { headers: { 'X-API-KEY': API_KEY(), 'Content-Type': 'application/json' }, timeout: 30000 });
    const convo = (r.data && r.data.items || []).find(c => c.id === conversationId) || null;
    if (convo && Array.isArray(convo.messages)) {
      convo.messages = convo.messages.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }
    return convo;
  } catch (e) {
    console.warn('[autoReply] fetchConversation failed:', e.response && e.response.status, e.message);
    return null;
  }
}

async function priorAutoHandled(db, profileUrl) {
  if (!profileUrl) return false;
  // Single-field query, no composite index needed. Filter in code.
  const snap = await db.collection('auto_reply_log').where('profile_url', '==', profileUrl).limit(50).get();
  const since = Date.now() - 30 * 86400e3;
  return snap.docs.some(d => {
    const x = d.data();
    const at = x.created_at && x.created_at.toMillis ? x.created_at.toMillis() : 0;
    return at >= since && (x.decision === 'SEND_TEMPLATE' || x.decision === 'SKIP_AND_TAG');
  });
}

async function autoHandledToday(db, accountId) {
  const snap = await db.collection('auto_reply_log').where('day', '==', etDay()).limit(500).get();
  return snap.docs.filter(d => {
    const x = d.data();
    return String(x.heyreach_account_id) === String(accountId) && x.decision === 'SEND_TEMPLATE';
  }).length;
}

async function isBlocklisted(db, profileUrl, company) {
  if (profileUrl) {
    const doc = await db.collection('auto_reply_blocklist').doc(blockKey(profileUrl)).get();
    if (doc.exists) return true;
  }
  if (company) {
    const snap = await db.collection('auto_reply_blocklist').where('company_lc', '==', String(company).toLowerCase()).limit(1).get();
    if (!snap.empty) return true;
  }
  return false;
}

/**
 * Evaluate one saved reply. Never throws, never sends.
 * @param ref           Firestore ref of the replies doc
 * @param reply         the replies doc data (full_name, reply_text, profile_url, ...)
 * @param conversation  HeyReach conversation if the caller already has it
 */
async function evaluateReply({ ref, reply, conversation = undefined }) {
  const cfg = policy.config();
  if (cfg.mode === 'off') return null;
  try {
    const { db } = require('./db');
    const accountId = reply.heyreach_account_id;
    const convo = conversation !== undefined
      ? conversation
      : await fetchConversation({ conversationId: reply.heyreach_conversation_id, name: reply.full_name, accountId });
    const facts = convo ? policy.threadFacts({ messages: convo.messages || [], accountId }) : null;

    const label = await labelReply({ replyText: reply.reply_text, ourLastMessage: facts ? facts.ourLastMessage : '', lane: facts ? facts.lane : '' });
    const [sentToLeadBefore, sentTodayForAccount, blocklisted] = await Promise.all([
      priorAutoHandled(db, reply.profile_url).catch(() => false),
      autoHandledToday(db, accountId).catch(() => 0),
      isBlocklisted(db, reply.profile_url, reply.company_name).catch(() => false),
    ]);

    const d = policy.decide({ label, replyText: reply.reply_text, facts, accountId, cfg, sentToLeadBefore, sentTodayForAccount, blocklisted });

    let text = null;
    let slots = null;
    if (d.action === 'SEND_TEMPLATE' && d.template === 'times') {
      slots = await findMeetingSlots().catch(e => ({ day: null, error: e.message }));
      if (slots && slots.day) {
        text = policy.render('times', slots);
      } else {
        d.action = 'DRAFT';
        d.failed.push('no_open_times');
      }
    } else if (d.action === 'SEND_TEMPLATE') {
      text = policy.render(d.template);
    }

    const entry = {
      mode: 'shadow',
      decision: d.action,
      would_send: text,
      type: d.type,
      tag: d.tag,
      suppress: d.suppress,
      failed_gates: d.failed,
      gates: d.gates,
      label,
      lane: facts ? facts.lane : null,
      their_turn: facts ? facts.theirTurns : null,
      slots: slots || null,
      reply_id: ref.id,
      reply_text: String(reply.reply_text || '').slice(0, 1000),
      full_name: reply.full_name || '',
      profile_url: reply.profile_url || '',
      company_name: reply.company_name || '',
      heyreach_account_id: accountId || null,
      heyreach_account_name: reply.heyreach_account_name || '',
      conversation_id: reply.heyreach_conversation_id || null,
      day: etDay(),
      created_at: new Date(),
    };
    await db.collection('auto_reply_log').add(entry);
    await ref.update({
      auto_reply: {
        mode: 'shadow',
        decision: d.action,
        would_send: text,
        type: d.type,
        tag: d.tag,
        failed_gates: d.failed.slice(0, 6),
        at: new Date(),
      },
    });
    console.log(`[autoReply] shadow ${d.action} for ${reply.full_name || ref.id} (${d.type}${d.failed.length ? `; failed ${d.failed.join(',')}` : ''})`);
    return entry;
  } catch (e) {
    console.warn('[autoReply] evaluate failed:', e.message);
    return null;
  }
}

module.exports = { evaluateReply, fetchConversation, blockKey, normUrl };
