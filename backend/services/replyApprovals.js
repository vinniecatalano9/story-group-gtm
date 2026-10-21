// services/replyApprovals.js — LinkedIn replies to Vincent's phone, sent on a tap.
//
// Each new HeyReach reply lands in Reply Bot (@StoryGroupRepliesbot, its own
// chat so Work Bot stays clear) with the draft and one button. The
// button opens a small panel inside Telegram (a Mini App, served by
// routes/approve.js) with Send, Edit and Skip. Nothing goes out unless Vincent
// taps Send there. No timer, no auto-send.
//
// A Mini App button opens a page, and the page talks to this backend directly,
// signed by Telegram, so no process has to poll the bot for button taps.
// Once Vincent sends or skips, the card is deleted: the chat only ever shows
// what is still waiting on him.
//
// Any Story Group HeyReach sender account works (Aaron, McKenna, and the rest);
// the send goes out on whichever account the conversation is on.
//
// Switch: REPLY_PHONE=on|off in .env (off by default). Off stops new cards and
// blocks sends from cards already on the phone.

const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const { escapeHtml, noteForWorkBot } = require('./telegram');
const { TEMPLATES } = require('../lib/autoReplyPolicy');

const TOKEN_FILE = () => process.env.WORKBOT_TELEGRAM_ENV || '/home/worker/.claude/channels/telegram/.env';
const CHAT_ID = () => process.env.FEED_TELEGRAM_CHAT || '1027800577';
const PANEL_URL = () => process.env.REPLY_PANEL_URL || 'https://gtm-api.srv1364275.hstgr.cloud/api/approve/panel';
const isOn = () => String(process.env.REPLY_PHONE || 'off').toLowerCase() === 'on';

// Reply Bot's token (REPLY_BOT_TOKEN in .env). Without it, fall back to Work
// Bot's, read the same way services/telegram.js does.
function token() {
  if (process.env.REPLY_BOT_TOKEN) return process.env.REPLY_BOT_TOKEN.trim();
  const m = fs.readFileSync(TOKEN_FILE(), 'utf8').match(/^TELEGRAM_BOT_TOKEN=["']?([0-9]+:[A-Za-z0-9_-]+)/m);
  if (!m) throw new Error('Work Bot token not found');
  return m[1];
}

async function tg(method, body) {
  const r = await axios.post(`https://api.telegram.org/bot${token()}/${method}`, body, { timeout: 30000, validateStatus: () => true });
  if (!r.data?.ok) throw new Error(`Telegram ${method} failed (${r.status}): ${r.data?.description || 'no detail'}`);
  return r.data.result;
}

/** "Message 1: Great.\n\nMessage 2: ..." -> plain blocks split by blank lines. */
function cleanDraft(draft) {
  return String(draft || '')
    .split(/\n{2,}/)
    .map(b => b.replace(/^Message\s*\d+\s*:\s*/i, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** "Their last message: Oct 19, 6:46 PM CT (yesterday)" from the reply's message date. */
function lastMessageLine(when) {
  const d = when ? new Date(when && when._seconds ? when._seconds * 1000 : when) : null;
  if (!d || isNaN(d)) return '';
  const tz = 'America/Chicago';
  const stamp = d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const day = x => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  const days = Math.round((new Date(day(new Date())) - new Date(day(d))) / 86400000);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `🕒 Their last message: ${stamp} CT (${ago})`;
}

/** The card's text and its one button. */
function buildCard({ id, reply, kind, draft }) {
  const isNo = kind === 'close_no';
  const name = reply.full_name || 'Someone';
  const account = reply.heyreach_account_name || 'LinkedIn';
  const their = String(reply.reply_text || '').trim();
  const shown = their.length > 600 ? their.slice(0, 600) + '…' : their;
  const when = lastMessageLine(reply.message_date);
  const text = [
    ...(when ? [when] : []),
    `💬 <b>${escapeHtml(name)}</b>${reply.company_name ? `, ${escapeHtml(reply.company_name)}` : ''}`,
    `<i>to ${escapeHtml(account)} on LinkedIn${isNo ? ' · a no' : ''}</i>`,
    '',
    `“${escapeHtml(shown)}”`,
    '',
    draft ? `<b>Draft:</b>\n${escapeHtml(draft)}` : '<b>No draft yet.</b> Tap below and use Edit to write one.',
  ].join('\n');
  const reply_markup = { inline_keyboard: [[{ text: isNo ? 'Send close line, or skip' : 'Review: Send, Edit, Skip', web_app: { url: `${PANEL_URL()}?id=${encodeURIComponent(id)}` } }]] };
  return { text, reply_markup };
}

/**
 * Verify Telegram Mini App initData and that it came from Vincent.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function verifyInitData(initData, maxAgeSec = 24 * 3600) {
  if (!initData) return { ok: false, error: 'Open this from Telegram.' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'Missing signature.' };
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token()).digest();
  const want = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (want.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(hash))) {
    return { ok: false, error: 'Bad signature.' };
  }
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (!(age < maxAgeSec)) return { ok: false, error: 'This panel expired. Close it and tap the button again.' };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* fall through */ }
  if (!user || String(user.id) !== String(CHAT_ID())) return { ok: false, error: 'Not authorized.' };
  return { ok: true, user };
}

/**
 * Called from the HeyReach webhook after the reply is classified (and after the
 * shadow log). Puts one card on Vincent's phone. Never sends to LinkedIn.
 *
 * @param ref     Firestore ref of the replies doc
 * @param reply   the replies doc data after classification
 * @param shadow  evaluateReply()'s log entry, or null
 */
async function offerReply({ ref, reply, shadow = null }) {
  if (!isOn()) return null;
  try {
    const type = shadow && shadow.type;
    const tag = reply.tag || '';
    const cls = reply.classification || '';
    // Nothing to answer: out of office, bounces, and "remove me".
    if (tag === 'Out of Office' || /^(ooo|out_of_office|bounce)$/i.test(cls) || type === 'ooo' || type === 'remove_me') return null;

    // A flat no gets no answer and no card (Vincent, 2026-10-20). A no that
    // leaves the door open ("not now, let's keep in touch") comes through
    // quietly with the close line, one tap.
    const isNo = reply.handled === true && reply.handled_reason === 'closed_hard_no_or_no_budget';
    if (isNo && type !== 'soft_no') return null;
    const kind = isNo ? 'close_no' : 'draft';
    const draft = isNo ? TEMPLATES.close_no() : cleanDraft(reply.draft_response);

    const { db } = require('./db');
    const name = reply.full_name || 'Someone';
    const account = reply.heyreach_account_name || 'LinkedIn';
    const their = String(reply.reply_text || '').trim();

    const { text, reply_markup } = buildCard({ id: ref.id, reply, kind, draft });

    const msg = await tg('sendMessage', {
      chat_id: CHAT_ID(),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: isNo,
      reply_markup,
    });

    await db.collection('reply_approvals').doc(ref.id).set({
      reply_id: ref.id,
      kind,
      draft,
      their_text: their.slice(0, 2000),
      full_name: name,
      company_name: reply.company_name || '',
      account_name: account,
      heyreach_account_id: reply.heyreach_account_id || null,
      conversation_id: reply.heyreach_conversation_id || null,
      status: 'pending',
      tg_message_id: msg.message_id,
      tg_text: text,
      created_at: new Date(),
    });
    noteForWorkBot(`LinkedIn reply from ${name} (${account}) went to Reply Bot with a ${kind === 'close_no' ? 'close line' : 'draft'} and Send/Edit/Skip.`);
    console.log(`[replyPhone] Card sent for ${name} (${kind})`);
    return msg.message_id;
  } catch (e) {
    console.warn('[replyPhone] offer failed:', e.message);
    return null;
  }
}

/** Delete the card once it's handled; if Telegram won't, show the outcome instead. */
async function markCard(approval, label) {
  if (!approval.tg_message_id) return;
  const gone = await tg('deleteMessage', { chat_id: CHAT_ID(), message_id: approval.tg_message_id }).then(() => true).catch(() => false);
  if (gone) return;
  await tg('editMessageText', {
    chat_id: CHAT_ID(),
    message_id: approval.tg_message_id,
    text: `${approval.tg_text || ''}\n\n${label}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(e => console.warn('[replyPhone] card update failed:', e.message));
}

module.exports = { offerReply, verifyInitData, markCard, cleanDraft, isOn, tg, buildCard };
