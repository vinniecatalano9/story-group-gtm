// services/replyBotChat.js — Vincent can talk to Reply Bot, and it answers.
//
// Reply Bot only ever posted (reply cards, ad lead cadence cards and notes);
// nothing read what Vincent typed back, so a question there just sat. This
// long-polls the bot (it has no webhook, and the cards' Mini App buttons never
// needed polling) and answers each message with Claude, from what the bot
// posted lately, the cards still waiting and where each ad lead's cadence
// stands. Several messages that arrive together get one answer.
//
// One thing it does on its own: move a cadence step's time ("send Email 1
// today"). That sets send_at.{step} on the lead, the same as a by-hand time,
// and in CADENCE_MODE=approval it only brings the card up sooner: nothing goes
// out until Vincent taps Send. Reply cards stay on their panel.
//
// Only Vincent's chat gets an answer. Switch: REPLY_BOT_CHAT=off stops it.

const fs = require('fs');
const { tg } = require('./replyApprovals');
const { claudeJSON } = require('./claude');
const { noteForWorkBot } = require('./telegram');

const CHAT_ID = () => process.env.FEED_TELEGRAM_CHAT || '1027800577';
const MIRROR = () => process.env.REPLYBOT_LOG || '/srv/replybot/chat.jsonl';
const isOn = () => String(process.env.REPLY_BOT_CHAT || 'on').toLowerCase() !== 'off';
// After a restart, messages older than this get no answer.
const STALE_MS = 12 * 3600e3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toDate = v => (v ? (v.toDate ? v.toDate() : new Date(v)) : null);
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const ct = d => (d && !isNaN(d) ? d.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : '?');

// Vincent's side goes into the same file the bot's posts are mirrored to, so
// Work Bot sees the whole conversation.
function mirrorIn(msg) {
  try {
    fs.appendFileSync(MIRROR(), JSON.stringify({ at: new Date(msg.date * 1000).toISOString(), method: 'received', message_id: msg.message_id, text: msg.text, buttons: [] }) + '\n');
  } catch (e) {
    console.warn('[replyBotChat] mirror failed:', e.message);
  }
}

function recentChat(n = 30) {
  try {
    return fs.readFileSync(MIRROR(), 'utf8').trim().split('\n').slice(-300)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && (x.method === 'deleteMessage' || x.text))
      .slice(-n)
      .map(x => {
        const at = ct(new Date(x.at));
        if (x.method === 'deleteMessage') return `[${at}] BOT deleted #${x.message_id} (card handled)`;
        const who = x.method === 'received' ? 'VINCENT' : x.method === 'editMessageText' ? 'BOT edited' : 'BOT';
        return `[${at}] ${who} #${x.message_id}: ${cut(x.text, 600)}`;
      })
      .join('\n') || '(empty)';
  } catch {
    return '(no chat log)';
  }
}

/** What's waiting on Vincent and where each ad lead stands, as prompt lines. */
async function snapshot() {
  const { db } = require('./db');
  const cadence = require('./cadence');
  const rows = q => q.get().then(s => s.docs.map(d => d.data())).catch(() => []);
  const [replyCards, snoozed, cadenceCards, leads] = await Promise.all([
    rows(db.collection('reply_approvals').where('status', '==', 'pending')),
    rows(db.collection('reply_approvals').where('status', '==', 'snoozed')),
    cadence.pendingCards().catch(() => []),
    cadence.listLeads().catch(() => []),
  ]);
  const list = (items, fmt) => (items.length ? items.map(fmt).join('\n') : '(none)');
  const recent = Date.now() - 2 * 86400e3;
  const active = leads
    .filter(l => l.running || (toDate(l.updated_at) || 0) > recent)
    .sort((a, b) => (toDate(a.next_due_at) || Infinity) - (toDate(b.next_due_at) || Infinity))
    .slice(0, 40);
  return {
    mode: cadence.MODE(),
    replyCards: list(replyCards, a => `- ${a.full_name}${a.company_name ? ` (${a.company_name})` : ''} to ${a.account_name}, card #${a.tg_message_id}${a.kind === 'close_no' ? ', a no' : ''}: they said "${cut(a.their_text, 300)}" | draft: "${cut(a.draft, 400)}"${a.email_to ? ` | email draft to ${a.email_to} is in his Gmail drafts` : ''}`),
    snoozed: list(snoozed, a => `- ${a.full_name || a.reply_id} comes back ${ct(toDate(a.snooze_until))}`),
    cadenceCards: list(cadenceCards, a => `- ${a.email} ${a.step}, card #${a.tg_message_id || '?'} since ${ct(toDate(a.created_at))}`),
    leads: list(active, l => `- ${cadence.fullName(l)} <${l.email}> track ${l.track || '?'}, state ${l.state || '?'}, ${l.running ? `next ${l.next_step || 'none'} at ${ct(toDate(l.next_due_at))}` : 'not running'}${l.pending_approval ? ', card waiting' : ''}${l.email_hold ? ', email held for his OK' : ''} (tz ${l.tz || '?'})`),
  };
}

async function buildPrompt(msgs) {
  const s = await snapshot();
  const replyTo = msgs.map(m => m.reply_to_message).find(Boolean);
  return `You are Reply Bot (@StoryGroupRepliesbot), the Telegram assistant for Vincent Catalano, VP of Growth at Story Group (a PR agency). This chat gets:
- LinkedIn reply cards: a prospect's reply with a draft. The card's button opens a panel with Send, Edit, Rewrite (by note), Skip and Later. Nothing goes to LinkedIn unless he taps Send there, and the card is deleted after Send or Skip. When a prospect asks for info by email, an email draft is put in his work Gmail drafts (vincent@storygroup.io) for him to send.
- Ad lead cadence cards and notes: paid social leads get Email 1, texts and follow-ups, on weekdays 9:30am to 6pm in the lead's time zone. CADENCE_MODE is ${s.mode}: in approval mode every send is a card and goes out only when he taps Send on it.

Now: ${ct(new Date())}.

What you can do yourself: move a cadence step to a set time ("send Email 1 today", "send it now"), which lifts the weekday window for that step. In approval mode that only brings its card up now; he still taps Send. You can't send, edit or skip reply cards, change copy, or touch Nutshell: tell him what to tap, or to ask Work Bot.

Recent chat, oldest first (# is the Telegram message id):
${recentChat()}

Reply cards waiting:
${s.replyCards}

Snoozed reply cards:
${s.snoozed}

Cadence cards waiting:
${s.cadenceCards}

Ad leads (running, or touched in the last 2 days):
${s.leads}
${replyTo ? `\nHe is replying to bot message #${replyTo.message_id}: "${cut(replyTo.text || replyTo.caption, 800)}"\n` : ''}
Vincent's new message${msgs.length > 1 ? 's' : ''}:
${msgs.map(m => `"${m.text}"`).join('\n')}

Reply with JSON only: {"answer": "...", "actions": [{"type": "send_at", "email": "<lead email from the list>", "step": "<step id, usually the lead's next step>", "at": "now" or an ISO time with offset}]}
Rules for answer: text back like a sharp coworker. One to three short sentences, plain text, no markdown, no dashes (use commas or periods). Use only the facts above; if you don't know, say so. If his message is vague (like "?"), work out from the recent chat what he's waiting on and answer that. Leave actions empty unless he asked to move a send; if it's unclear which lead he means, ask instead of guessing. With actions, the answer says what you're doing in one line; the bot adds the result.`;
}

/** Move one cadence step to a set time (send_at), then re-plan the lead. */
async function moveStep({ email, step, at }) {
  const cadence = require('./cadence');
  const copy = require('../lib/cadenceCopy');
  const lead = await cadence.getLead(String(email || ''));
  if (!lead) throw new Error(`no ad lead ${email}`);
  const name = cadence.fullName(lead);
  if (!lead.running) throw new Error(`${name} isn't in a running cadence`);
  const s = copy.stepById(step);
  if (!s) throw new Error(`no step "${step}"`);
  const done = lead.steps_done && lead.steps_done[step];
  if (done) throw new Error(`${s.label} for ${name} is already ${done.status || 'done'}`);
  const when = !at || at === 'now' ? new Date() : new Date(at);
  if (isNaN(when)) throw new Error(`bad time "${at}"`);
  await cadence.saveLead(lead.email, { [`send_at.${step}`]: when });
  await cadence.refreshNext(lead.email);
  const now = when.getTime() <= Date.now() + 60e3;
  noteForWorkBot(`Reply Bot chat: Vincent moved ${s.label} for ${name} to ${now ? 'now' : ct(when)}.`);
  return { now, line: `${s.label} for ${name} moved to ${now ? 'now' : ct(when)}` };
}

async function answer(msgs) {
  const chat_id = CHAT_ID();
  const typing = () => tg('sendChatAction', { chat_id, action: 'typing' }).catch(() => {});
  typing();
  const beat = setInterval(typing, 4500);
  let text;
  try {
    const prompt = await buildPrompt(msgs);
    msgs.forEach(mirrorIn);
    const res = await claudeJSON(prompt, { model: 'sonnet', timeout: 150000 });
    const lines = [String(res.answer || '').trim()].filter(Boolean);
    const actions = (Array.isArray(res.actions) ? res.actions : []).filter(a => a && a.type === 'send_at').slice(0, 5);
    let cardsNow = false;
    for (const a of actions) {
      try {
        const r = await moveStep(a);
        cardsNow = cardsNow || r.now;
        lines.push(`✅ ${r.line}.`);
      } catch (e) {
        lines.push(`❌ Couldn't move it: ${e.message}.`);
      }
    }
    if (cardsNow) {
      const cadence = require('./cadence');
      lines.push(cadence.MODE() === 'approval' ? 'The card lands here in a minute. Nothing goes out until you tap Send.' : 'It goes out in the next minute.');
      cadence.tick().catch(e => console.warn('[replyBotChat] cadence tick failed:', e.message));
    }
    text = lines.join('\n\n') || 'Got it.';
  } catch (e) {
    console.warn('[replyBotChat] answer failed:', e.message);
    text = `Sorry, I couldn't work that out (${cut(e.message, 150)}). Try again, or ask Work Bot.`;
  } finally {
    clearInterval(beat);
  }
  const last = msgs[msgs.length - 1];
  await tg('sendMessage', {
    chat_id, text: text.slice(0, 4000), disable_web_page_preview: true,
    reply_parameters: { message_id: last.message_id, allow_sending_without_reply: true },
  });
}

async function loop() {
  let offset = 0;
  console.log('[replyBotChat] listening for Vincent in Reply Bot');
  while (isOn()) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    } catch (e) {
      // 409 means a webhook or another poller has the bot: back off longer.
      console.warn('[replyBotChat] getUpdates failed:', e.message);
      await sleep(/\(409\)/.test(e.message) ? 60000 : 10000);
      continue;
    }
    if (!updates.length) continue;
    offset = updates[updates.length - 1].update_id + 1;
    const mine = updates.map(u => u.message)
      .filter(m => m && m.text && String(m.chat?.id) === CHAT_ID() && String(m.from?.id) === CHAT_ID())
      .filter(m => Date.now() - m.date * 1000 < STALE_MS);
    if (mine.length) await answer(mine).catch(e => console.warn('[replyBotChat] reply failed:', e.message));
  }
}

let started = false;
function start() {
  if (started || !isOn() || !process.env.REPLY_BOT_TOKEN) return;
  started = true;
  loop();
}

module.exports = { start, buildPrompt, moveStep };
