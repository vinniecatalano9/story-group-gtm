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
async function offerReply({ ref, reply, shadow = null, force = false }) {
  if (!isOn()) return null;
  try {
    const type = shadow && shadow.type;
    const tag = reply.tag || '';
    const cls = reply.classification || '';
    const isOoo = tag === 'Out of Office' || /^(ooo|out_of_office)$/i.test(cls) || type === 'ooo';
    // Out of office: park it and bring it back the day after they return,
    // with a fresh draft (Vincent, 2026-10-20). No card today.
    if (!force && isOoo) {
      const back = parseReturnDate(reply.reply_text) || addDays(new Date(), 7);
      await snoozeReply({ replyId: ref.id, until: addDays(back, 1), note: 'They were out of office and asked us to reach out once they are back. Follow up now: a short check-in that restates our ask in one line and offers two times.' });
      return null;
    }
    // Nothing to answer: bounces and "remove me".
    if (!force && (/^bounce$/i.test(cls) || type === 'remove_me')) return null;

    // A flat no gets no answer and no card (Vincent, 2026-10-20). A no that
    // leaves the door open ("not now, let's keep in touch") comes through
    // quietly with the close line, one tap.
    const isNo = !force && reply.handled === true && reply.handled_reason === 'closed_hard_no_or_no_budget';
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

// ── Snooze: park a reply until a date, then it comes back as a fresh card ──

const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);

/** "out until 11/9", "back on November 9th", "returning Oct 30" -> a Date, or null. */
function parseReturnDate(text, now = new Date()) {
  const t = String(text || '');
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const year = now.getFullYear();
  const cands = [];
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
    cands.push(new Date(y, +m[1] - 1, +m[2], 12));
  }
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    cands.push(new Date(year, months.indexOf(m[1].toLowerCase()), +m[2], 12));
  }
  // Next year if the date already passed ("back 1/5" in December).
  const fixed = cands.filter(d => !isNaN(d)).map(d => (d < addDays(now, -1) ? new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), 12) : d));
  return fixed.find(d => d > now && d < addDays(now, 150)) || null;
}

/**
 * Park a reply until a date. Its card (if any) leaves the chat, offered times
 * go back in the pool, and it drops off the dashboard's waiting list until then.
 */
async function snoozeReply({ replyId, until, note = '' }) {
  const { db } = require('./db');
  const ref = db.collection('reply_approvals').doc(replyId);
  const doc = await ref.get();
  const a = doc.exists ? doc.data() : null;
  if (a && a.status === 'pending' && a.tg_message_id) {
    await tg('deleteMessage', { chat_id: CHAT_ID(), message_id: a.tg_message_id }).catch(() => {});
  }
  await ref.set({ reply_id: replyId, status: 'snoozed', snooze_until: new Date(until), revive_note: note, snoozed_at: new Date() }, { merge: true });
  await require('./calendar').releaseHolds(replyId);
  await db.collection('replies').doc(replyId).update({ handled: true, handled_reason: 'snoozed', snoozed_until: new Date(until) }).catch(() => {});
  console.log(`[replyPhone] Snoozed ${replyId} until ${new Date(until).toISOString().slice(0, 10)}`);
}

/** Bring back every snoozed reply that is due, each with a fresh draft. Run by cron. */
async function reviveDue() {
  if (!isOn()) return 0;
  const { db } = require('./db');
  const snap = await db.collection('reply_approvals').where('status', '==', 'snoozed').get();
  const now = Date.now();
  let n = 0;
  for (const d of snap.docs) {
    const a = d.data();
    const until = a.snooze_until && a.snooze_until.toDate ? a.snooze_until.toDate() : new Date(a.snooze_until);
    if (!(until.getTime() <= now)) continue;
    try {
      const rref = db.collection('replies').doc(a.reply_id);
      await rref.update({ handled: false, handled_reason: '' });
      const port = process.env.PORT || 3001;
      const rd = await axios.post(`http://127.0.0.1:${port}/api/heyreach/redraft`,
        { reply_id: a.reply_id, feedback: a.revive_note || 'We said we would follow up around now. Write a short, warm check-in that offers two times.' },
        { timeout: 180000, validateStatus: () => true });
      const reply = (await rref.get()).data();
      if (rd.status !== 200) console.warn(`[replyPhone] revive redraft failed for ${a.reply_id}: ${rd.status}`);
      await offerReply({ ref: rref, reply, force: true });
      n++;
    } catch (e) {
      console.warn(`[replyPhone] revive failed for ${a.reply_id}:`, e.message);
    }
  }
  if (n) console.log(`[replyPhone] Brought back ${n} snoozed repl${n === 1 ? 'y' : 'ies'}`);
  return n;
}

module.exports = { snoozeReply, reviveDue, parseReturnDate, offerReply, verifyInitData, markCard, cleanDraft, isOn, tg, buildCard };
